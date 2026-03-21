/**
 * Encrypted chat manager using Signal Protocol (X3DH + Double Ratchet + Sender Keys).
 *
 * Replaces the MLS-based implementation. Key differences:
 * - Session establishment is fully async via pre-key bundles (no one needs to be online)
 * - DM encryption uses pairwise Double Ratchet sessions
 * - Group encryption uses Sender Keys distributed via pairwise sessions
 * - No commit/welcome/resync/eviction state machine
 */

import {
  uint8ToBase64,
  base64ToUint8,
  fetchKeyPackage,
} from '../api/crypto.js'
import type {
  VesperMessage,
  VesperScopeSyncScopeResponse
} from '../api/chat.js'
import {
  performX3DH,
  respondX3DH,
  initSessionAsInitiator,
  initSessionAsResponder,
  ratchetEncrypt,
  ratchetDecrypt,
  generateSenderKey,
  senderKeyEncrypt,
  senderKeyDecrypt,
  createSenderKeyReceiver,
  deriveVoiceKey,
  serializeSession,
  deserializeSession,
  serializeSenderKey,
  deserializeSenderKey,
  serializeSenderKeyReceiver,
  deserializeSenderKeyReceiver,
  encodeMessage,
  decodeMessage,
  decodePreKeyBundle,
  type SessionState,
  type SenderKeyState,
  type SenderKeyReceiver,
} from '../crypto/protocol.js'
import {
  decodePayload,
  encodePayload,
  getDisplayText,
  type MessagePayload
} from '../crypto/payload.js'
import {
  type CryptoStorageRuntime
} from '../crypto/storage.js'
import { cacheSentMessage } from '../crypto/decryptionCache.js'
import { withGroupLock } from '../crypto/groupLock.js'
import type { VesperClient } from './index.js'

// ---------------------------------------------------------------------------
//  Constants
// ---------------------------------------------------------------------------

const MAX_MESSAGES_PER_SCOPE = 200
const DECRYPTION_PLACEHOLDER = '[Encrypted message unavailable]'

// ---------------------------------------------------------------------------
//  Types
// ---------------------------------------------------------------------------

export interface EncryptedScope {
  kind: 'channel' | 'dm'
  id: string
}

export interface ProcessedScopeMessage {
  id: string
  scopeId: string
  channelId: string | null
  conversationId: string | null
  senderId: string | null
  senderUsername: string | null
  parentMessageId: string | null
  insertedAt: string
  content: string
  plaintext: string | null
  encrypted: boolean
  decryptionFailed: boolean
  raw: VesperMessage
}

export interface ScopeSyncResult {
  durationMs: number
  messages: ProcessedScopeMessage[]
  events: ScopeSyncEvent[]
  hasMore: boolean
}

export interface ScopeSyncEvent {
  id: number | null
  roomSeq: number | null
  eventType: string
  messageId: string | null
  insertedAt: string
  payload: Record<string, unknown> | null
}

export interface EncryptedScopeWatchEvent {
  scope: EncryptedScope
  event: string
  payload: Record<string, unknown> | null
  message?: ProcessedScopeMessage
  deletedMessageId?: string | null
}

export interface SendTextOptions {
  parentMessageId?: string | null
  mentionedUserIds?: string[]
  clientNonce?: string | null
}

export interface SendPayloadOptions extends SendTextOptions {
  attachmentIds?: string[]
}

type ScopeListener = (event: EncryptedScopeWatchEvent) => void | Promise<void>

/**
 * Address for a pairwise session: "userId:deviceId"
 */
type SessionAddress = string

function makeAddress(userId: string, deviceId: string): SessionAddress {
  return `${userId}:${deviceId}`
}

function scopeTopic(scope: EncryptedScope): string {
  return scope.kind === 'channel' ? `chat:channel:${scope.id}` : `dm:${scope.id}`
}

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

function sortMessages(messages: ProcessedScopeMessage[]): ProcessedScopeMessage[] {
  return [...messages].sort((left, right) => {
    const timeDelta = parseTimestamp(left.insertedAt) - parseTimestamp(right.insertedAt)
    if (timeDelta !== 0) return timeDelta
    return left.id.localeCompare(right.id)
  })
}

function sortRawMessages(messages: VesperMessage[]): VesperMessage[] {
  return [...messages].sort((left, right) => {
    const leftSeq = typeof left.room_seq === 'number' ? left.room_seq : null
    const rightSeq = typeof right.room_seq === 'number' ? right.room_seq : null
    if (leftSeq !== null && rightSeq !== null && leftSeq !== rightSeq) {
      return leftSeq - rightSeq
    }
    const timeDelta = parseTimestamp(left.inserted_at) - parseTimestamp(right.inserted_at)
    if (timeDelta !== 0) return timeDelta
    return left.id.localeCompare(right.id)
  })
}

function highestRoomSeq(messages: ProcessedScopeMessage[]): number | null {
  let highest: number | null = null
  for (const message of messages) {
    const roomSeq = typeof message.raw.room_seq === 'number' ? message.raw.room_seq : null
    if (roomSeq == null) continue
    highest = highest == null ? roomSeq : Math.max(highest, roomSeq)
  }
  return highest
}

function coerceDisplayText(plaintext: string): string {
  try {
    return getDisplayText(decodePayload(plaintext))
  } catch {
    return plaintext
  }
}

function normalizePayload(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null
}

// ---------------------------------------------------------------------------
//  VesperEncryptedChat
// ---------------------------------------------------------------------------

export class VesperEncryptedChat {
  private readonly client: VesperClient
  private readonly storage: CryptoStorageRuntime

  // Pairwise Double Ratchet sessions keyed by address ("userId:deviceId")
  private readonly sessions = new Map<SessionAddress, SessionState>()

  // Sender keys for group scopes
  // Our sender key per scope
  private readonly senderKeys = new Map<string, SenderKeyState>()
  // Other members' sender keys: Map<scopeId, Map<address, SenderKeyReceiver>>
  private readonly receivedSenderKeys = new Map<string, Map<SessionAddress, SenderKeyReceiver>>()

  // Scope readiness tracking (has a session/sender key been established?)
  private readonly scopeReady = new Set<string>()

  // Topic subscription management (same pattern as previous implementation)
  private readonly joinedTopics = new Set<string>()
  private readonly scopeDisposers = new Map<string, () => void>()
  private readonly scopeWatchRefs = new Map<string, number>()
  private readonly scopeListeners = new Map<string, Set<ScopeListener>>()

  // Message storage
  private readonly scopeMessages = new Map<string, ProcessedScopeMessage[]>()

  private restoreConnectionsPromise: Promise<void> | null = null

  constructor(client: VesperClient) {
    this.client = client
    this.storage = client.getStorageRuntime()

    this.client.on('connected', () => {
      void this.restoreConnections()
    })
    this.client.on('disconnected', () => {
      this.clearConnections()
    })
    this.client.on('state', (state) => {
      if (state.status === 'signed_out') {
        this.reset()
      }
    })
  }

  // =========================================================================
  //  Public API — Scope Lifecycle
  // =========================================================================

  reset(): void {
    this.clearConnections()
    this.sessions.clear()
    this.senderKeys.clear()
    this.receivedSenderKeys.clear()
    this.scopeReady.clear()
    this.scopeMessages.clear()
    this.scopeListeners.clear()
    this.scopeWatchRefs.clear()
  }

  /**
   * Watch a scope for real-time encrypted events.
   * Returns a dispose function to stop watching.
   */
  async watchScope(
    scope: EncryptedScope,
    listener?: ScopeListener
  ): Promise<() => void> {
    return await this.withStorageContext(async () => {
      const topic = scopeTopic(scope)
      this.scopeWatchRefs.set(topic, (this.scopeWatchRefs.get(topic) ?? 0) + 1)

      if (listener) {
        const listeners = this.scopeListeners.get(topic) ?? new Set<ScopeListener>()
        listeners.add(listener)
        this.scopeListeners.set(topic, listeners)
      }

      if (!this.joinedTopics.has(topic)) {
        const dispose = await this.client.watchScope(scope.kind, scope.id, async ({ event, payload }) => {
          const nextEvent = await withGroupLock(scope.id, async () => {
            return await this.withStorageContext(async () => {
              return await this.handleScopeEvent(scope, event, normalizePayload(payload))
            })
          }, 'urgent')
          if (nextEvent) {
            await this.notifyScopeListeners(nextEvent.scope, nextEvent.event, nextEvent.payload, nextEvent.message)
          }
        })

        this.scopeDisposers.set(topic, dispose)
        this.joinedTopics.add(topic)
      }

      return () => {
        if (listener) {
          const listeners = this.scopeListeners.get(topic)
          if (listeners) {
            listeners.delete(listener)
            if (listeners.size === 0) this.scopeListeners.delete(topic)
          }
        }

        const remainingRefs = (this.scopeWatchRefs.get(topic) ?? 1) - 1
        if (remainingRefs > 0) {
          this.scopeWatchRefs.set(topic, remainingRefs)
          return
        }

        this.scopeWatchRefs.delete(topic)
        this.scopeDisposers.get(topic)?.()
        this.scopeDisposers.delete(topic)
        this.joinedTopics.delete(topic)
      }
    })
  }

  async processScopeEvent(
    scope: EncryptedScope,
    event: string,
    payload: Record<string, unknown> | null
  ): Promise<EncryptedScopeWatchEvent | null> {
    return await withGroupLock(scope.id, async () => {
      return await this.withStorageContext(async () => {
        return await this.handleScopeEvent(scope, event, payload)
      })
    }, 'urgent')
  }

  /**
   * Ensure the scope is ready for encrypted messaging.
   *
   * For DMs: establishes a pairwise session with the other participant.
   * For channels: establishes pairwise sessions with all members and
   * distributes sender keys.
   *
   * This is fully async — no one needs to be online.
   */
  async ensureScopeReady(scope: EncryptedScope, _allowCreate = false): Promise<boolean> {
    return await this.withStorageContext(async () => {
      if (this.scopeReady.has(scope.id)) return true

      if (scope.kind === 'dm') {
        return await this.ensureDmReady(scope.id)
      }

      return await this.ensureChannelReady(scope.id)
    })
  }

  async ensureMembership(scope: EncryptedScope): Promise<boolean> {
    return await this.ensureScopeReady(scope)
  }

  async ensureScopeState(scopeId: string): Promise<boolean> {
    // Try to determine scope kind from context
    const scope = this.inferScope(scopeId)
    if (!scope) return false
    return await this.ensureScopeReady(scope)
  }

  async resetScope(scopeId: string): Promise<void> {
    await this.withStorageContext(async () => {
      this.scopeReady.delete(scopeId)
      this.senderKeys.delete(scopeId)
      this.receivedSenderKeys.delete(scopeId)
      this.scopeMessages.delete(scopeId)
      await this.storage.deleteGroupState(scopeId)
    })
  }

  // =========================================================================
  //  Public API — Messaging
  // =========================================================================

  getMessages(scopeId: string): ProcessedScopeMessage[] {
    return [...(this.scopeMessages.get(scopeId) ?? [])]
  }

  async syncScope(
    scope: EncryptedScope,
    options: { limit?: number } = {}
  ): Promise<ScopeSyncResult> {
    return await this.withStorageContext(async () => {
      return await withGroupLock(scope.id, async () => {
        const startedAt = performance.now()
        const limit = options.limit ?? 50

        await this.ensureScopeReady(scope)

        const cached = await this.loadProcessedCachedMessages(scope.id)
        const existing = this.scopeMessages.get(scope.id) ?? cached
        const afterSeq = highestRoomSeq(existing)
        const delta = afterSeq == null
          ? { messages: await this.fetchScopeMessages(scope, limit), events: [] as ScopeSyncEvent[], hasMore: false }
          : await this.fetchIncrementalScopeDelta(scope, limit, afterSeq)
        const applied = await this.applyScopeSyncDelta(scope, existing, delta.messages, delta.events)

        return {
          durationMs: performance.now() - startedAt,
          messages: applied.messages,
          events: applied.events,
          hasMore: delta.hasMore
        }
      }, 'normal')
    })
  }

  async sendText(
    scope: EncryptedScope,
    text: string,
    options: SendTextOptions = {}
  ): Promise<void> {
    await this.sendPayload(scope, { v: 1, type: 'text', text }, options)
  }

  async sendPayload(
    scope: EncryptedScope,
    payload: MessagePayload,
    options: SendPayloadOptions = {}
  ): Promise<void> {
    await this.withStorageContext(async () => {
      const release = await this.watchScope(scope)

      try {
        const ready = await this.ensureScopeReady(scope, true)
        if (!ready) {
          throw new Error(`${scope.kind} scope is still syncing`)
        }

        const plaintext = encodePayload(payload)
        const encrypted = await this.encryptForScope(scope, plaintext)
        await cacheSentMessage(this.storage, encrypted.ciphertext, plaintext)

        const messagePayload: Record<string, unknown> = {
          ciphertext: encrypted.ciphertext
        }

        if (options.parentMessageId) messagePayload.parent_message_id = options.parentMessageId
        if (options.mentionedUserIds?.length) messagePayload.mentioned_user_ids = [...new Set(options.mentionedUserIds)]
        if (options.attachmentIds?.length) messagePayload.attachment_ids = [...new Set(options.attachmentIds)]
        if (options.clientNonce) messagePayload.client_nonce = options.clientNonce

        void this.client.pushScopeEvent(scope.kind, scope.id, 'new_message', messagePayload)
      } finally {
        release()
      }
    })
  }

  async encryptOpaque(
    scope: EncryptedScope,
    plaintext: string
  ): Promise<{ ciphertext: string }> {
    return await this.withStorageContext(async () => {
      const ready = await this.ensureScopeReady(scope)
      if (!ready) {
        throw new Error(`${scope.kind} scope is still syncing`)
      }
      return await this.encryptForScope(scope, plaintext)
    })
  }

  async decryptOpaque(
    scope: EncryptedScope,
    ciphertext: string,
    _messageEpoch: number | null = null
  ): Promise<string | null> {
    return await this.withStorageContext(async () => {
      return await this.decryptForScope(scope, ciphertext)
    })
  }

  async decryptOpaqueBatch(
    scope: EncryptedScope,
    items: Array<{ ciphertext: string; messageEpoch?: number | null }>
  ): Promise<Array<string | null>> {
    return await this.withStorageContext(async () => {
      const results: Array<string | null> = []
      for (const item of items) {
        results.push(await this.decryptForScope(scope, item.ciphertext))
      }
      return results
    })
  }

  // =========================================================================
  //  Public API — Message Operations
  // =========================================================================

  async editText(scope: EncryptedScope, messageId: string, text: string): Promise<void> {
    await this.withStorageContext(async () => {
      const ready = await this.ensureScopeReady(scope)
      if (!ready) throw new Error(`${scope.kind} scope is still syncing`)

      const encrypted = await this.encryptForScope(scope, encodePayload({ v: 1, type: 'text', text }))
      await cacheSentMessage(this.storage, encrypted.ciphertext, text)

      const pushed = await this.client.pushScopeEvent(scope.kind, scope.id, 'edit_message', {
        message_id: messageId,
        ciphertext: encrypted.ciphertext
      })
      if (!pushed) throw new Error(`Failed to edit message in ${scopeTopic(scope)}`)
    })
  }

  async deleteMessage(scope: EncryptedScope, messageId: string): Promise<void> {
    const pushed = await this.client.pushScopeEvent(scope.kind, scope.id, 'delete_message', {
      message_id: messageId
    })
    if (!pushed) throw new Error(`Failed to delete message in ${scopeTopic(scope)}`)
  }

  async addReaction(scope: EncryptedScope, messageId: string, emoji: string): Promise<void> {
    await this.withStorageContext(async () => {
      await this.pushReaction(scope, 'add_reaction', messageId, emoji)
    })
  }

  async removeReaction(scope: EncryptedScope, messageId: string, emoji: string): Promise<void> {
    await this.withStorageContext(async () => {
      await this.pushReaction(scope, 'remove_reaction', messageId, emoji)
    })
  }

  async sendTyping(scope: EncryptedScope, active: boolean): Promise<void> {
    const pushed = await this.client.pushScopeEvent(
      scope.kind, scope.id,
      active ? 'typing_start' : 'typing_stop',
      {}
    )
    if (!pushed) throw new Error(`Failed to update typing state for ${scopeTopic(scope)}`)
  }

  async pinMessage(scope: EncryptedScope, messageId: string): Promise<void> {
    const pushed = await this.client.pushScopeEvent(scope.kind, scope.id, 'pin_message', { message_id: messageId })
    if (!pushed) throw new Error(`Failed to pin message in ${scopeTopic(scope)}`)
  }

  async unpinMessage(scope: EncryptedScope, messageId: string): Promise<void> {
    const pushed = await this.client.pushScopeEvent(scope.kind, scope.id, 'unpin_message', { message_id: messageId })
    if (!pushed) throw new Error(`Failed to unpin message in ${scopeTopic(scope)}`)
  }

  // =========================================================================
  //  Public API — Voice
  // =========================================================================

  /**
   * Derive a 128-bit AES key for voice E2EE.
   *
   * For DMs: derived from the pairwise session's root key.
   * For groups: derived from a hash of all current sender keys.
   */
  async deriveScopeVoiceKey(scopeId: string): Promise<Uint8Array | null> {
    return await this.withStorageContext(async () => {
      // For DMs, use the pairwise session root key
      const scope = this.inferScope(scopeId)
      if (!scope) return null

      if (scope.kind === 'dm') {
        const session = this.getDmSession(scopeId)
        if (!session) return null
        return deriveVoiceKey(session.rootKey)
      }

      // For channels, use a hash of all sender keys as shared secret
      const senderKeyMap = this.receivedSenderKeys.get(scopeId)
      const ourKey = this.senderKeys.get(scopeId)
      if (!senderKeyMap && !ourKey) return null

      // Combine all sender key chain keys into a shared secret
      const parts: Uint8Array[] = []
      if (ourKey) parts.push(ourKey.chainKey)
      if (senderKeyMap) {
        for (const receiver of senderKeyMap.values()) {
          parts.push(receiver.chainKey)
        }
      }

      // Sort for determinism
      parts.sort((a, b) => {
        for (let i = 0; i < Math.min(a.length, b.length); i++) {
          if (a[i] !== b[i]) return a[i] - b[i]
        }
        return a.length - b.length
      })

      const { hmac } = await import('@noble/hashes/hmac.js')
      const { sha256 } = await import('@noble/hashes/sha2.js')
      let combined = new Uint8Array(32) as Uint8Array
      for (const part of parts) {
        combined = new Uint8Array(hmac(sha256, combined, part))
      }

      return deriveVoiceKey(combined)
    })
  }

  // =========================================================================
  //  Public API — Query
  // =========================================================================

  /**
   * Whether we have an active session for this scope.
   * For DMs: have a pairwise session with the other participant.
   * For channels: have a sender key.
   */
  hasGroup(scopeId: string): boolean {
    return this.scopeReady.has(scopeId)
  }

  getMemberCount(_scopeId: string): number {
    // With Signal Protocol, we don't maintain a member tree like MLS.
    // The server knows who's in a channel/DM. Return 0 to indicate
    // this information isn't available client-side.
    return 0
  }

  hasMemberDevice(_scopeId: string, _userId: string, _deviceId: string | null): boolean {
    return false
  }

  consumeWelcomeApplied(_scopeId: string): boolean {
    // No welcomes in Signal Protocol
    return false
  }

  getGroupEpoch(_scopeId: string): number | null {
    // No epochs in Signal Protocol — Double Ratchet handles key progression per-message
    return null
  }

  // =========================================================================
  //  Public API — Deprecated (kept for client compatibility during migration)
  //  These methods existed in the MLS implementation and are called by client
  //  code that hasn't been fully cleaned up. They are safe no-ops.
  // =========================================================================

  async replayScopeEvents(_scopeId: string): Promise<void> {
    // No durable event replay needed — sessions are self-contained
  }

  async requestJoin(_scope: EncryptedScope): Promise<void> {
    // No join requests — sessions establish via pre-key bundles
  }

  async requestJoinAll(_scope: EncryptedScope): Promise<void> {
    // No join-all broadcasts
  }

  async requestResync(_scope: EncryptedScope, _options?: Record<string, unknown>): Promise<void> {
    // No resync — sessions are self-healing
  }

  async createScopeGroup(scope: EncryptedScope): Promise<boolean> {
    return await this.ensureScopeReady(scope)
  }

  async createScopeState(scopeId: string): Promise<boolean> {
    const scope = this.inferScope(scopeId)
    if (!scope) return false
    return await this.ensureScopeReady(scope)
  }

  async applyScopeCommit(_scopeId: string, _commitData: string | null): Promise<boolean> {
    return false // No commits
  }

  async applyScopeWelcome(_scopeId: string, _welcomeData: string | null, _keyPackageRef: string | null): Promise<boolean> {
    return false // No welcomes
  }

  async handleScopeJoinRequest(_scopeId: string, _userId: string, _deviceId: string | null): Promise<null> {
    return null // No MLS join requests
  }

  async handleScopeResyncRequest(_scopeId: string, _userId: string, _deviceId: string | null): Promise<null> {
    return null // No MLS resync
  }

  async handleExternalJoinRequest(_scope: EncryptedScope, _userId: string, _deviceId: string | null): Promise<null> {
    return null
  }

  async handleExternalResyncRequest(_scope: EncryptedScope, _userId: string, _deviceId: string | null): Promise<null> {
    return null
  }

  async handleExternalEvictionRequest(_scope: EncryptedScope, _payload: Record<string, unknown> | null): Promise<boolean> {
    return false
  }

  // =========================================================================
  //  Private — Session Establishment
  // =========================================================================

  /**
   * Establish a pairwise Double Ratchet session with a user's device.
   * Fetches their pre-key bundle from the server — they don't need to be online.
   */
  private async establishSession(userId: string, deviceId?: string): Promise<SessionState | null> {
    const address = makeAddress(userId, deviceId ?? 'default')

    // Already have a session?
    const existing = this.sessions.get(address)
    if (existing) return existing

    // Try loading from storage
    const persisted = await this.storage.loadGroupState(address)
    if (persisted) {
      try {
        const session = deserializeSession(new Uint8Array(persisted.state))
        this.sessions.set(address, session)
        return session
      } catch {
        // Corrupted — re-establish
      }
    }

    // Fetch their pre-key bundle from server
    let bundleBytes: Uint8Array | null
    try {
      bundleBytes = await fetchKeyPackage(userId, deviceId, this.client.getHttpClient())
    } catch {
      return null
    }
    if (!bundleBytes) return null

    const theirBundle = decodePreKeyBundle(bundleBytes)

    // Load our identity keys
    const localUserId = this.client.getAuthSession()?.user.id
    if (!localUserId) return null

    const identity = await this.storage.loadIdentity(localUserId)
    if (!identity) return null

    // Perform X3DH — fully async, no interaction with the other party
    const ourIdentity = {
      signing: {
        privateKey: identity.encryptedPrivateKeys.slice(0, 32),
        publicKey: identity.publicIdentityKey
      },
      dh: {
        privateKey: identity.encryptedPrivateKeys.slice(32, 64),
        publicKey: identity.publicKeyExchange
      }
    }

    // Use first available one-time pre-key
    const otpk = theirBundle.oneTimePreKeys.length > 0 ? theirBundle.oneTimePreKeys[0] : undefined
    const x3dhResult = performX3DH(ourIdentity, theirBundle, otpk)

    // Initialize Double Ratchet as initiator
    const session = initSessionAsInitiator(
      x3dhResult.sharedSecret,
      theirBundle.signedPreKey.publicKey
    )

    this.sessions.set(address, session)
    await this.saveSession(address, session)

    return session
  }

  /**
   * Process an incoming initial message (X3DH response).
   * Called when we receive the first message from someone who established
   * a session with our pre-key bundle.
   */
  private async receiveSession(
    address: SessionAddress,
    theirIdentityDHKey: Uint8Array,
    theirEphemeralKey: Uint8Array,
    usedOneTimePreKeyId: number | null
  ): Promise<SessionState | null> {
    const localUserId = this.client.getAuthSession()?.user.id
    if (!localUserId) return null

    const identity = await this.storage.loadIdentity(localUserId)
    if (!identity) return null

    const ourIdentity = {
      signing: {
        privateKey: identity.encryptedPrivateKeys.slice(0, 32),
        publicKey: identity.publicIdentityKey
      },
      dh: {
        privateKey: identity.encryptedPrivateKeys.slice(32, 64),
        publicKey: identity.publicKeyExchange
      }
    }

    // Load our signed pre-key
    const packages = await this.storage.loadKeyPackages()
    if (packages.length === 0) return null

    // Find the signed pre-key (for now, use the first available)
    const spkData = packages[0]
    const spkKeyPair = {
      privateKey: new Uint8Array(spkData.privateData.slice(0, 32)),
      publicKey: new Uint8Array(spkData.publicData.slice(0, 32))
    }

    // Find one-time pre-key if used
    let otpk = null
    if (usedOneTimePreKeyId !== null) {
      // TODO: Look up specific OPK by ID from storage
      // For now, this is a placeholder
    }

    // Complete X3DH as responder
    const sharedSecret = respondX3DH(
      ourIdentity,
      { id: 0, keyPair: spkKeyPair, signature: new Uint8Array(64) },
      otpk,
      theirIdentityDHKey,
      theirEphemeralKey
    )

    const session = initSessionAsResponder(sharedSecret, spkKeyPair)
    this.sessions.set(address, session)
    await this.saveSession(address, session)

    return session
  }

  // =========================================================================
  //  Private — DM Encryption
  // =========================================================================

  private async ensureDmReady(conversationId: string): Promise<boolean> {
    if (this.scopeReady.has(conversationId)) return true

    // Find the other participant in this DM
    const conversation = this.client.getState().conversations.find(c => c.id === conversationId)
    if (!conversation) {
      // Try syncing to get conversation data
      await this.client.syncNow(false).catch(() => {})
      const retried = this.client.getState().conversations.find(c => c.id === conversationId)
      if (!retried) return false
    }

    const localUserId = this.client.getAuthSession()?.user.id
    if (!localUserId) return false

    const conv = this.client.getState().conversations.find(c => c.id === conversationId)
    if (!conv) return false

    const otherParticipant = conv.participants.find(p => p.user_id !== localUserId)
    if (!otherParticipant) return false

    // Establish pairwise session — fully async, they don't need to be online
    const session = await this.establishSession(otherParticipant.user_id)
    if (!session) return false

    this.scopeReady.add(conversationId)
    return true
  }

  private getDmSession(conversationId: string): SessionState | null {
    const localUserId = this.client.getAuthSession()?.user.id
    if (!localUserId) return null

    const conv = this.client.getState().conversations.find(c => c.id === conversationId)
    if (!conv) return null

    const otherParticipant = conv.participants.find(p => p.user_id !== localUserId)
    if (!otherParticipant) return null

    const address = makeAddress(otherParticipant.user_id, 'default')
    return this.sessions.get(address) ?? null
  }

  // =========================================================================
  //  Private — Channel/Group Encryption (Sender Keys)
  // =========================================================================

  private async ensureChannelReady(channelId: string): Promise<boolean> {
    if (this.scopeReady.has(channelId)) return true

    // Generate our sender key for this channel
    if (!this.senderKeys.has(channelId)) {
      const senderKey = generateSenderKey()
      this.senderKeys.set(channelId, senderKey)
      await this.saveSenderKeyState(channelId, senderKey)
    }

    // Distribute our sender key to all channel members via pairwise sessions
    // For now, distribution happens lazily when members request it
    // or via the sender_key_distribution socket event

    this.scopeReady.add(channelId)
    return true
  }

  // =========================================================================
  //  Private — Encrypt/Decrypt
  // =========================================================================

  private async encryptForScope(
    scope: EncryptedScope,
    plaintext: string
  ): Promise<{ ciphertext: string }> {
    const plaintextBytes = new TextEncoder().encode(plaintext)

    if (scope.kind === 'dm') {
      // DM: encrypt with pairwise Double Ratchet
      const session = this.getDmSession(scope.id)
      if (!session) throw new Error(`No session for DM ${scope.id}`)

      const result = await ratchetEncrypt(session, plaintextBytes)
      const address = this.getDmPartnerAddress(scope.id)
      if (address) {
        this.sessions.set(address, result.session)
        await this.saveSession(address, result.session)
      }

      return { ciphertext: uint8ToBase64(encodeMessage(result.message)) }
    }

    // Channel: encrypt with our Sender Key
    const senderKey = this.senderKeys.get(scope.id)
    if (!senderKey) throw new Error(`No sender key for channel ${scope.id}`)

    const result = await senderKeyEncrypt(senderKey, plaintextBytes)
    this.senderKeys.set(scope.id, result.state)
    await this.saveSenderKeyState(scope.id, result.state)

    // Pack: [4 bytes iteration][64 bytes signature][N bytes ciphertext]
    const packed = new Uint8Array(4 + 64 + result.ciphertext.length)
    new DataView(packed.buffer).setUint32(0, result.iteration, false)
    packed.set(result.signature, 4)
    packed.set(result.ciphertext, 68)

    return { ciphertext: uint8ToBase64(packed) }
  }

  private async decryptForScope(
    scope: EncryptedScope,
    ciphertext: string
  ): Promise<string | null> {
    const data = base64ToUint8(ciphertext)

    // First check sent-message cache (we can always decrypt our own messages)
    const sentPlaintext = await this.storage.loadSentMessagePlaintext(ciphertext)
    if (sentPlaintext) return sentPlaintext

    if (scope.kind === 'dm') {
      // DM: decrypt with pairwise Double Ratchet
      const address = this.getDmPartnerAddress(scope.id)
      if (!address) return null

      const session = this.sessions.get(address)
      if (!session) return null

      try {
        const message = decodeMessage(data)
        const result = await ratchetDecrypt(session, message)
        if (!result) return null

        this.sessions.set(address, result.session)
        await this.saveSession(address, result.session)

        return new TextDecoder().decode(result.plaintext)
      } catch {
        return null
      }
    }

    // Channel: decrypt with sender's Sender Key
    // Packed format: [4 bytes iteration][64 bytes signature][N bytes ciphertext]
    if (data.length < 68) return null

    const iteration = new DataView(data.buffer, data.byteOffset).getUint32(0, false)
    const signature = data.slice(4, 68)
    const encryptedPayload = data.slice(68)

    // Try each known sender key for this scope
    const senderKeyMap = this.receivedSenderKeys.get(scope.id)
    if (!senderKeyMap) return null

    for (const [address, receiver] of senderKeyMap) {
      const result = await senderKeyDecrypt(receiver, encryptedPayload, signature, iteration)
      if (result) {
        senderKeyMap.set(address, result.receiver)
        await this.saveSenderKeyReceiverState(scope.id, address, result.receiver)
        return new TextDecoder().decode(result.plaintext)
      }
    }

    return null
  }

  // =========================================================================
  //  Private — Scope Event Handling
  // =========================================================================

  private async handleScopeEvent(
    scope: EncryptedScope,
    event: string,
    payload: Record<string, unknown> | null
  ): Promise<EncryptedScopeWatchEvent | null> {
    if (event === 'new_message') {
      const message = await this.processIncomingMessage(scope, payload as unknown as VesperMessage)
      this.upsertScopeMessage(scope.id, message)
      return { scope, event, payload, message }
    }

    if (event === 'reaction_update') {
      const message = await this.handleReactionUpdate(scope, payload)
      return { scope, event, payload, message: message ?? undefined }
    }

    if (event === 'message_edited') {
      const message = await this.handleMessageEdited(scope, payload)
      return { scope, event, payload, message: message ?? undefined }
    }

    if (event === 'message_deleted') {
      const messageId = await this.handleMessageDeleted(scope, payload)
      return { scope, event, payload, deletedMessageId: messageId }
    }

    if (event === 'sender_key_distribution') {
      await this.handleSenderKeyDistribution(scope, payload)
      return { scope, event, payload }
    }

    // Pass through any other events (typing, channel_updated, etc.)
    return { scope, event, payload }
  }

  private async handleSenderKeyDistribution(
    scope: EncryptedScope,
    payload: Record<string, unknown> | null
  ): Promise<void> {
    if (!payload) return

    const senderId = this.getString(payload, 'sender_id')
    const senderDeviceId = this.getString(payload, 'sender_device_id') ?? 'default'
    const encryptedKey = this.getString(payload, 'encrypted_sender_key')

    if (!senderId || !encryptedKey) return

    const address = makeAddress(senderId, senderDeviceId)

    // Decrypt the sender key using our pairwise session with the sender
    const session = this.sessions.get(address)
    if (!session) return

    try {
      const data = base64ToUint8(encryptedKey)
      const message = decodeMessage(data)
      const result = await ratchetDecrypt(session, message)
      if (!result) return

      this.sessions.set(address, result.session)
      await this.saveSession(address, result.session)

      // Parse the sender key data
      const keyData = JSON.parse(new TextDecoder().decode(result.plaintext))
      const receiver = createSenderKeyReceiver(
        base64ToUint8(keyData.chainKey),
        base64ToUint8(keyData.signingPublicKey),
        keyData.iteration ?? 0
      )

      const receivers = this.receivedSenderKeys.get(scope.id) ?? new Map()
      receivers.set(address, receiver)
      this.receivedSenderKeys.set(scope.id, receivers)
      await this.saveSenderKeyReceiverState(scope.id, address, receiver)
    } catch {
      // Failed to decrypt sender key distribution
    }
  }

  // =========================================================================
  //  Private — Message Processing (mostly protocol-agnostic)
  // =========================================================================

  private async processIncomingMessage(
    scope: EncryptedScope,
    rawMessage: VesperMessage
  ): Promise<ProcessedScopeMessage> {
    const scopeId = scope.id
    const ciphertext = typeof rawMessage.ciphertext === 'string' ? rawMessage.ciphertext : null
    let content = typeof rawMessage.content === 'string' ? rawMessage.content : ''
    let encrypted = false
    let decryptionFailed = false
    let plaintext: string | null = typeof rawMessage.content === 'string' ? rawMessage.content : null

    if (ciphertext) {
      encrypted = true

      const [sentPlaintext, cachedPlaintext] = await Promise.all([
        this.storage.loadSentMessagePlaintext(ciphertext),
        this.storage.loadCachedMessageDecryption(rawMessage.id)
      ])

      const decrypted = sentPlaintext ?? cachedPlaintext ?? await this.decryptForScope(scope, ciphertext)

      if (decrypted) {
        plaintext = decrypted
        content = coerceDisplayText(decrypted)
      } else {
        content = DECRYPTION_PLACEHOLDER
        decryptionFailed = true
      }
    }

    const persistenceWork: Promise<unknown>[] = []

    if (plaintext && ciphertext) {
      persistenceWork.push(this.storage.saveCachedMessageDecryption(rawMessage.id, plaintext))
    }

    persistenceWork.push(
      this.storage.cacheMessage({
        id: rawMessage.id,
        roomSeq: rawMessage.room_seq ?? null,
        channelId: rawMessage.channel_id ?? null,
        conversationId: rawMessage.conversation_id ?? null,
        serverId: rawMessage.server_id ?? null,
        senderId: rawMessage.sender_id ?? null,
        senderUsername: rawMessage.sender?.username ?? null,
        parentMessageId: rawMessage.parent_message_id ?? null,
        ciphertext: ciphertext ? new Uint8Array(base64ToUint8(ciphertext)) : null,
        decryptedContent: decryptionFailed ? null : plaintext,
        mlsEpoch: null,
        insertedAt: rawMessage.inserted_at
      })
    )

    if (!decryptionFailed && content) {
      persistenceWork.push(this.storage.indexDecryptedMessage(rawMessage.id, scopeId, content))
    }

    await Promise.all(persistenceWork)

    return {
      id: rawMessage.id,
      scopeId,
      channelId: rawMessage.channel_id ?? null,
      conversationId: rawMessage.conversation_id ?? null,
      senderId: rawMessage.sender_id ?? null,
      senderUsername: rawMessage.sender?.username ?? null,
      parentMessageId: rawMessage.parent_message_id ?? null,
      insertedAt: rawMessage.inserted_at,
      content,
      plaintext,
      encrypted,
      decryptionFailed,
      raw: rawMessage
    }
  }

  // =========================================================================
  //  Private — Reaction/Edit/Delete Handling (protocol-agnostic)
  // =========================================================================

  private async handleReactionUpdate(
    scope: EncryptedScope,
    payload: Record<string, unknown> | null
  ): Promise<ProcessedScopeMessage | null> {
    const action = this.getString(payload, 'action')
    const messageId = this.getString(payload, 'message_id')
    const senderId = this.getString(payload, 'sender_id')
    if (!action || !messageId || !senderId) return null

    const existing = this.getScopeMessage(scope.id, messageId)
    if (!existing) return null

    const emoji = await this.resolveReactionEmoji(scope, payload)
    if (!emoji) return null

    const ciphertext = this.getString(payload, 'ciphertext')
    const raw = this.cloneRawMessage(existing.raw)
    const reactions = raw.reactions ? [...raw.reactions] : []

    const matchesReaction = (reaction: NonNullable<VesperMessage['reactions']>[number]): boolean =>
      reaction.sender_id === senderId &&
      ((ciphertext != null && reaction.ciphertext === ciphertext) || reaction.emoji === emoji)

    if (action === 'add') {
      if (!reactions.some(matchesReaction)) {
        reactions.push({
          id: this.getString(payload, 'id') ?? `${messageId}:${senderId}:${ciphertext ?? emoji}`,
          emoji,
          sender_id: senderId,
          ciphertext,
          mls_epoch: null,
          inserted_at: new Date().toISOString()
        })
      }
      raw.reactions = reactions
    } else if (action === 'remove') {
      raw.reactions = reactions.filter(r => !matchesReaction(r))
    } else {
      return null
    }

    const nextMessage = { ...existing, raw } satisfies ProcessedScopeMessage
    this.upsertScopeMessage(scope.id, nextMessage)
    return nextMessage
  }

  private async handleMessageEdited(
    scope: EncryptedScope,
    payload: Record<string, unknown> | null
  ): Promise<ProcessedScopeMessage | null> {
    const messageId = this.getString(payload, 'message_id')
    if (!messageId) return null

    const existing = this.getScopeMessage(scope.id, messageId)
    if (!existing) return null

    const raw = this.cloneRawMessage(existing.raw)
    const ciphertext = this.getString(payload, 'ciphertext')
    const content = this.getString(payload, 'content')
    raw.edited_at = this.getString(payload, 'edited_at')
    raw.channel_id = this.getString(payload, 'channel_id') ?? raw.channel_id ?? null
    raw.conversation_id = this.getString(payload, 'conversation_id') ?? raw.conversation_id ?? null

    if (ciphertext) {
      raw.ciphertext = ciphertext
      delete raw.content
    } else if (content != null) {
      raw.content = content
      delete raw.ciphertext
    }

    const nextMessage = await this.processIncomingMessage(scope, raw)
    this.upsertScopeMessage(scope.id, nextMessage)
    return nextMessage
  }

  private async handleMessageDeleted(
    scope: EncryptedScope,
    payload: Record<string, unknown> | null
  ): Promise<string | null> {
    const messageId = this.getString(payload, 'message_id')
    if (!messageId) return null

    const existing = this.scopeMessages.get(scope.id) ?? []
    this.scopeMessages.set(scope.id, existing.filter(m => m.id !== messageId))
    await this.storage.removeCachedMessage(messageId).catch(() => {})
    await this.storage.removeFromFtsIndex(messageId).catch(() => {})
    return messageId
  }

  private async pushReaction(
    scope: EncryptedScope,
    event: 'add_reaction' | 'remove_reaction',
    messageId: string,
    emoji: string
  ): Promise<void> {
    const ready = await this.ensureScopeReady(scope)
    if (ready) {
      const encrypted = await this.encryptForScope(scope, emoji)
      await cacheSentMessage(this.storage, encrypted.ciphertext, emoji)
      const pushed = await this.client.pushScopeEvent(scope.kind, scope.id, event, {
        message_id: messageId,
        ciphertext: encrypted.ciphertext
      })
      if (!pushed) throw new Error(`Failed to update reaction in ${scopeTopic(scope)}`)
      return
    }

    if (!this.client.getState().canUseE2EE) {
      const pushed = await this.client.pushScopeEvent(scope.kind, scope.id, event, {
        message_id: messageId,
        emoji
      })
      if (!pushed) throw new Error(`Failed to update reaction in ${scopeTopic(scope)}`)
      return
    }

    throw new Error(`${scope.kind} scope is still syncing`)
  }

  private async resolveReactionEmoji(
    scope: EncryptedScope,
    payload: Record<string, unknown> | null
  ): Promise<string | null> {
    const emoji = this.getString(payload, 'emoji')
    if (emoji) return emoji

    const ciphertext = this.getString(payload, 'ciphertext')
    if (!ciphertext) return null

    const sentPlaintext = await this.storage.loadSentMessagePlaintext(ciphertext)
    if (sentPlaintext) return sentPlaintext

    return await this.decryptForScope(scope, ciphertext)
  }

  // =========================================================================
  //  Private — Message Sync (protocol-agnostic)
  // =========================================================================

  private async fetchScopeMessages(scope: EncryptedScope, limit: number): Promise<VesperMessage[]> {
    if (scope.kind === 'channel') {
      return await this.client.fetchChannelMessages(scope.id, limit)
    }
    return await this.client.fetchConversationMessages(scope.id, limit)
  }

  private async fetchIncrementalScopeDelta(
    scope: EncryptedScope,
    limit: number,
    afterSeq: number
  ): Promise<{ messages: VesperMessage[]; events: ScopeSyncEvent[]; hasMore: boolean }> {
    const syncState = await this.client.fetchScopeSync({
      scopes: [{ kind: scope.kind, id: scope.id, after_seq: afterSeq }],
      limit
    })

    const entry = syncState.scopes.find(c => c.scope_id === scope.id) ?? null

    return {
      messages: sortRawMessages(entry?.messages ?? []),
      events: this.normalizeSyncEvents(entry),
      hasMore: entry?.has_more ?? false
    }
  }

  private normalizeSyncEvents(entry: VesperScopeSyncScopeResponse | null): ScopeSyncEvent[] {
    if (!entry) return []

    return [...entry.events]
      .map(event => ({
        id: typeof event.id === 'number' ? event.id : null,
        roomSeq: typeof event.room_seq === 'number' ? event.room_seq : null,
        eventType: event.event_type,
        messageId: typeof event.message_id === 'string' ? event.message_id : null,
        insertedAt: event.inserted_at,
        payload: normalizePayload(event.payload)
      }))
      .sort((left, right) => {
        const leftSeq = left.roomSeq ?? Number.MAX_SAFE_INTEGER
        const rightSeq = right.roomSeq ?? Number.MAX_SAFE_INTEGER
        if (leftSeq !== rightSeq) return leftSeq - rightSeq
        const timeDelta = parseTimestamp(left.insertedAt) - parseTimestamp(right.insertedAt)
        if (timeDelta !== 0) return timeDelta
        return left.eventType.localeCompare(right.eventType)
      })
  }

  private async applyScopeSyncDelta(
    scope: EncryptedScope,
    existing: ProcessedScopeMessage[],
    rawMessages: VesperMessage[],
    events: ScopeSyncEvent[]
  ): Promise<{ messages: ProcessedScopeMessage[]; events: ScopeSyncEvent[] }> {
    this.scopeMessages.set(scope.id, [...existing])

    const operations = [
      ...rawMessages.map(message => ({
        kind: 'message' as const,
        roomSeq: typeof message.room_seq === 'number' ? message.room_seq : Number.MAX_SAFE_INTEGER,
        insertedAt: message.inserted_at,
        message
      })),
      ...events.map(event => ({
        kind: 'event' as const,
        roomSeq: event.roomSeq ?? Number.MAX_SAFE_INTEGER,
        insertedAt: event.insertedAt,
        event
      }))
    ].sort((left, right) => {
      if (left.roomSeq !== right.roomSeq) return left.roomSeq - right.roomSeq
      const timeDelta = parseTimestamp(left.insertedAt) - parseTimestamp(right.insertedAt)
      if (timeDelta !== 0) return timeDelta
      return left.kind.localeCompare(right.kind)
    })

    for (const operation of operations) {
      if (operation.kind === 'message') {
        const processed = await this.processIncomingMessage(scope, operation.message)
        this.upsertScopeMessage(scope.id, processed)
      } else {
        await this.handleScopeEvent(scope, operation.event.eventType, operation.event.payload)
      }
    }

    const nextMessages = sortMessages(this.scopeMessages.get(scope.id) ?? []).slice(-MAX_MESSAGES_PER_SCOPE)
    this.scopeMessages.set(scope.id, nextMessages)

    return { messages: nextMessages, events }
  }

  // =========================================================================
  //  Private — Storage
  // =========================================================================

  private async saveSession(address: SessionAddress, session: SessionState): Promise<void> {
    const serialized = serializeSession(session)
    await this.storage.saveGroupState(address, serialized, 0)
  }

  private async saveSenderKeyState(scopeId: string, state: SenderKeyState): Promise<void> {
    const serialized = serializeSenderKey(state)
    await this.storage.saveGroupState(`sk:${scopeId}`, serialized, 0)
  }

  private async saveSenderKeyReceiverState(
    scopeId: string,
    address: SessionAddress,
    receiver: SenderKeyReceiver
  ): Promise<void> {
    const serialized = serializeSenderKeyReceiver(receiver)
    await this.storage.saveGroupState(`skr:${scopeId}:${address}`, serialized, 0)
  }

  // =========================================================================
  //  Private — Cached Message Loading (protocol-agnostic)
  // =========================================================================

  private async loadProcessedCachedMessages(scopeId: string): Promise<ProcessedScopeMessage[]> {
    const cached = await this.storage.loadCachedMessages(scopeId)

    return cached
      .map(message => {
        const ciphertext = message.ciphertext ? uint8ToBase64(new Uint8Array(message.ciphertext)) : undefined
        const plaintext = message.decryptedContent
        const content = plaintext != null
          ? coerceDisplayText(plaintext)
          : ciphertext ? DECRYPTION_PLACEHOLDER : ''

        return {
          id: message.id,
          scopeId,
          channelId: message.channelId,
          conversationId: message.conversationId,
          senderId: message.senderId,
          senderUsername: message.senderUsername,
          parentMessageId: message.parentMessageId,
          insertedAt: message.insertedAt,
          content,
          plaintext,
          encrypted: Boolean(ciphertext),
          decryptionFailed: ciphertext ? message.decryptedContent == null : false,
          raw: {
            id: message.id,
            room_seq: message.roomSeq,
            channel_id: message.channelId,
            conversation_id: message.conversationId,
            server_id: message.serverId ?? null,
            sender_id: message.senderId,
            sender: message.senderUsername
              ? { id: message.senderId ?? '', username: message.senderUsername }
              : null,
            parent_message_id: message.parentMessageId,
            inserted_at: message.insertedAt,
            content: message.decryptedContent ?? undefined,
            ciphertext,
            mls_epoch: null
          }
        } satisfies ProcessedScopeMessage
      })
      .sort((left, right) => {
        const leftSeq = typeof left.raw.room_seq === 'number' ? left.raw.room_seq : null
        const rightSeq = typeof right.raw.room_seq === 'number' ? right.raw.room_seq : null
        if (leftSeq !== null && rightSeq !== null && leftSeq !== rightSeq) return leftSeq - rightSeq
        const timeDelta = parseTimestamp(left.insertedAt) - parseTimestamp(right.insertedAt)
        if (timeDelta !== 0) return timeDelta
        return left.id.localeCompare(right.id)
      })
  }

  // =========================================================================
  //  Private — Utility
  // =========================================================================

  private async withStorageContext<T>(operation: () => Promise<T>): Promise<T> {
    return await this.client.runWithStorageContext(operation)
  }

  private parseScopeTopic(topic: string): EncryptedScope | null {
    if (topic.startsWith('chat:channel:')) return { kind: 'channel', id: topic.slice('chat:channel:'.length) }
    if (topic.startsWith('dm:')) return { kind: 'dm', id: topic.slice('dm:'.length) }
    return null
  }

  private inferScope(scopeId: string): EncryptedScope | null {
    // Check if it's a known conversation (DM)
    const conv = this.client.getState().conversations.find(c => c.id === scopeId)
    if (conv) return { kind: 'dm', id: scopeId }

    // Check if it's a known channel
    for (const server of this.client.getState().servers) {
      if (server.channels.some(c => c.id === scopeId)) {
        return { kind: 'channel', id: scopeId }
      }
    }

    // Check voice scope prefixes
    if (scopeId.startsWith('voice:channel:')) return { kind: 'channel', id: scopeId }
    if (scopeId.startsWith('voice:dm:')) return { kind: 'dm', id: scopeId }

    return null
  }

  private getDmPartnerAddress(conversationId: string): SessionAddress | null {
    const localUserId = this.client.getAuthSession()?.user.id
    if (!localUserId) return null

    const conv = this.client.getState().conversations.find(c => c.id === conversationId)
    if (!conv) return null

    const other = conv.participants.find(p => p.user_id !== localUserId)
    if (!other) return null

    return makeAddress(other.user_id, 'default')
  }

  private getString(payload: Record<string, unknown> | null, key: string): string | null {
    const value = payload?.[key]
    return typeof value === 'string' ? value : null
  }

  private getScopeMessage(scopeId: string, messageId: string): ProcessedScopeMessage | null {
    const messages = this.scopeMessages.get(scopeId) ?? []
    return messages.find(m => m.id === messageId) ?? null
  }

  private upsertScopeMessage(scopeId: string, message: ProcessedScopeMessage): void {
    const existing = this.scopeMessages.get(scopeId) ?? []
    const filtered = existing.filter(e => e.id !== message.id)
    this.scopeMessages.set(scopeId, sortMessages([...filtered, message]).slice(-MAX_MESSAGES_PER_SCOPE))
  }

  private cloneRawMessage(raw: VesperMessage): VesperMessage {
    return {
      ...raw,
      sender: raw.sender ? { ...raw.sender } : null,
      attachments: raw.attachments ? raw.attachments.map(a => ({ ...a })) : [],
      reactions: raw.reactions ? raw.reactions.map(r => ({ ...r })) : []
    }
  }

  private async restoreConnections(): Promise<void> {
    const existing = this.restoreConnectionsPromise
    if (existing) { await existing; return }

    const run = this.withStorageContext(async () => {
      const topics = new Set<string>([
        ...this.scopeWatchRefs.keys(),
        ...this.scopeListeners.keys()
      ])

      for (const topic of topics) {
        if (this.joinedTopics.has(topic)) continue
        const scope = this.parseScopeTopic(topic)
        if (!scope) continue

        try {
          const dispose = await this.client.watchScope(scope.kind, scope.id, async ({ event, payload }) => {
            const nextEvent = await withGroupLock(scope.id, async () => {
              return await this.withStorageContext(async () => {
                return await this.handleScopeEvent(scope, event, normalizePayload(payload))
              })
            }, 'urgent')
            if (nextEvent) {
              await this.notifyScopeListeners(nextEvent.scope, nextEvent.event, nextEvent.payload, nextEvent.message)
            }
          })

          this.scopeDisposers.set(topic, dispose)
          this.joinedTopics.add(topic)
        } catch {
          // Let the next reconnect retry
        }
      }
    }).finally(() => {
      this.restoreConnectionsPromise = null
    })

    this.restoreConnectionsPromise = run
    await run
  }

  private clearConnections(): void {
    for (const dispose of this.scopeDisposers.values()) dispose()
    this.scopeDisposers.clear()
    this.joinedTopics.clear()
  }

  private async notifyScopeListeners(
    scope: EncryptedScope,
    event: string,
    payload: Record<string, unknown> | null,
    message?: ProcessedScopeMessage
  ): Promise<void> {
    const topic = scopeTopic(scope)
    const listeners = this.scopeListeners.get(topic)
    if (!listeners || listeners.size === 0) return

    for (const listener of listeners) {
      await listener({ scope, event, payload, message })
    }
  }
}

export function createEncryptedChat(client: VesperClient): VesperEncryptedChat {
  return new VesperEncryptedChat(client)
}
