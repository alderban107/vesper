import {
  ackPendingWelcome,
  fetchGroupInfo,
  fetchKeyPackage,
  fetchMlsEvents,
  fetchPendingWelcomes,
  publishGroupInfo,
  uint8ToBase64
} from '../api/crypto.js'
import type {
  VesperConversation,
  VesperMessage,
  VesperScopeSyncScopeResponse
} from '../api/chat.js'
import {
  addMemberToGroup,
  buildClientCredentialIdentity,
  createMLSGroup,
  decodePayload,
  decryptMessage,
  deserializeGroupState,
  deriveVoiceKey,
  encodePayload,
  encryptMessage,
  exportGroupInfo,
  exportRatchetTree,
  findExactMemberLeafIndex,
  findMemberLeafIndex,
  getDisplayText,
  getGroupLeafIdentities,
  getGroupMemberIdentities,
  groupHasMember,
  initCipherSuite,
  joinViaExternalCommit,
  processCommitMessage,
  processWelcome,
  removeMemberFromGroup,
  serializeGroupState
} from '../crypto/index.js'
import {
  type CryptoStorageRuntime
} from '../crypto/storage.js'
import { cacheSentMessage } from '../crypto/decryptionCache.js'
import { withGroupLock } from '../crypto/groupLock.js'
import type { MessagePayload } from '../crypto/payload.js'
import type { VesperClient } from './index.js'
import { MLSDiagnostics } from './mlsDiagnostics.js'

const JOIN_WAIT_MS = 2_500
const EVICTION_REQUEST_COOLDOWN_MS = 3_000
const MAX_MESSAGES_PER_SCOPE = 200
const DECRYPTION_PLACEHOLDER = '[Encrypted message unavailable]'

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

type GroupState = Awaited<ReturnType<typeof createMLSGroup>>
type ScopeListener = (event: EncryptedScopeWatchEvent) => void | Promise<void>
type PendingGroupInfoPublish = {
  groupInfoData: Uint8Array
  ratchetTreeData: Uint8Array | null
  epoch: number
}
type PendingExternalCommitBroadcast = {
  commitData: string
  commitId: string
}

function scopeTopic(scope: EncryptedScope): string {
  return scope.kind === 'channel' ? `chat:channel:${scope.id}` : `dm:${scope.id}`
}

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

function bytesToHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function uint8ArraysEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === right) {
    return true
  }

  if (!left || !right || left.byteLength !== right.byteLength) {
    return left === right
  }

  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false
    }
  }

  return true
}

function samePendingGroupInfoPublish(
  left: PendingGroupInfoPublish,
  right: PendingGroupInfoPublish
): boolean {
  return (
    left.epoch === right.epoch &&
    uint8ArraysEqual(left.groupInfoData, right.groupInfoData) &&
    uint8ArraysEqual(left.ratchetTreeData, right.ratchetTreeData)
  )
}

function samePendingExternalCommitBroadcast(
  left: PendingExternalCommitBroadcast,
  right: PendingExternalCommitBroadcast
): boolean {
  return left.commitId === right.commitId && left.commitData === right.commitData
}

async function sha256Hex(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  return bytesToHex(new Uint8Array(digest))
}

function sortMessages(messages: ProcessedScopeMessage[]): ProcessedScopeMessage[] {
  return [...messages].sort((left, right) => {
    const timeDelta = parseTimestamp(left.insertedAt) - parseTimestamp(right.insertedAt)
    if (timeDelta !== 0) {
      return timeDelta
    }

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
    if (timeDelta !== 0) {
      return timeDelta
    }

    return left.id.localeCompare(right.id)
  })
}

function highestRoomSeq(messages: ProcessedScopeMessage[]): number | null {
  let highest: number | null = null

  for (const message of messages) {
    const roomSeq = typeof message.raw.room_seq === 'number' ? message.raw.room_seq : null
    if (roomSeq == null) {
      continue
    }

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

export class VesperEncryptedChat {
  private readonly client: VesperClient
  private readonly storage: CryptoStorageRuntime
  private readonly groupStates = new Map<string, GroupState>()
  private readonly joinedTopics = new Set<string>()
  private readonly scopeDisposers = new Map<string, () => void>()
  private readonly scopeWatchRefs = new Map<string, number>()
  private readonly scopeListeners = new Map<string, Set<ScopeListener>>()
  private readonly pendingCommits = new Map<string, string[]>()
  private readonly pendingJoinRequests = new Map<string, Promise<void>>()
  private readonly pendingEvictionRequests = new Map<string, Promise<void>>()
  private readonly recentEvictionClaims = new Map<string, number>()
  private readonly recentJoinDeviceIds = new Map<string, string>()
  private readonly evictionLocks = new Map<string, Promise<void>>()
  private readonly scopeMessages = new Map<string, ProcessedScopeMessage[]>()
  private readonly membershipWaiters = new Map<string, Set<(ready: boolean) => void>>()
  private readonly epochWaiters = new Map<string, Set<(epoch: number) => void>>()
  private readonly welcomeAppliedAtByScope = new Map<string, number>()
  private readonly recentDmJoinProcessed = new Map<string, number>()
  private readonly scopeKinds = new Map<string, 'channel' | 'dm'>()
  private readonly yieldedDmScopes = new Set<string>()
  private readonly pendingGroupCreations = new Map<string, Promise<void>>()
  private readonly pendingExternalCommits = new Map<string, Promise<boolean>>()
  private readonly pendingBootstraps = new Map<string, Promise<boolean>>()
  private readonly pendingGroupInfoPublishes = new Map<string, PendingGroupInfoPublish>()
  private readonly groupInfoPublishRetryAttempts = new Map<string, number>()
  private readonly groupInfoPublishRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly pendingExternalCommitBroadcasts = new Map<string, PendingExternalCommitBroadcast>()
  private readonly externalCommitBroadcastRetryAttempts = new Map<string, number>()
  private readonly externalCommitBroadcastRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly diagnostics = new MLSDiagnostics()
  private readonly welcomeInProgress = new Set<string>()
  private readonly welcomeReceivedScopes = new Set<string>()
  private restoreConnectionsPromise: Promise<void> | null = null

  constructor(client: VesperClient) {
    this.client = client
    this.storage = client.getStorageRuntime()

    this.client.on('connected', () => {
      void this.handleConnected()
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

  private async handleConnected(): Promise<void> {
    try {
      await this.restoreConnections()
      await this.loadPendingControlOutbox()
      await this.flushPendingGroupInfoPublishes()
      await this.flushPendingExternalCommitBroadcasts()
    } catch (error) {
      this.logIgnoredError('restore connections', error)
    }
  }

  private parseScopeTopic(topic: string): EncryptedScope | null {
    if (topic.startsWith('chat:channel:')) {
      return {
        kind: 'channel',
        id: topic.slice('chat:channel:'.length)
      }
    }

    if (topic.startsWith('dm:')) {
      return {
        kind: 'dm',
        id: topic.slice('dm:'.length)
      }
    }

    return null
  }

  private async restoreConnections(): Promise<void> {
    const existing = this.restoreConnectionsPromise
    if (existing) {
      await existing
      return
    }

    const run = this.withStorageContext(async () => {
      const topics = new Set<string>([
        ...this.scopeWatchRefs.keys(),
        ...this.scopeListeners.keys()
      ])

      for (const topic of topics) {
        if (this.joinedTopics.has(topic)) {
          continue
        }

        const scope = this.parseScopeTopic(topic)
        if (!scope) {
          continue
        }

        try {
          this.scopeKinds.set(scope.id, scope.kind)
          const dispose = await this.client.watchScope(scope.kind, scope.id, async ({ event, payload }) => {
            const nextEvent = await withGroupLock(scope.id, async () => {
              return await this.withStorageContext(async () => {
                return await this.handleScopeEvent(scope, event, normalizePayload(payload))
              })
            }, 'urgent')
            if (nextEvent) {
              await this.notifyScopeListeners(
                nextEvent.scope,
                nextEvent.event,
                nextEvent.payload,
                nextEvent.message
              )
            }
          })

          this.scopeDisposers.set(topic, dispose)
          this.joinedTopics.add(topic)

          if (this.hasGroup(scope.id)) {
            await this.replayDurableEvents(scope.id)
          }
        } catch {
          // Let the next reconnect retry restoring this scope.
        }
      }
    }).finally(() => {
      this.restoreConnectionsPromise = null
    })

    this.restoreConnectionsPromise = run
    await run
  }

  private async withStorageContext<T>(operation: () => Promise<T>): Promise<T> {
    return await this.client.runWithStorageContext(operation)
  }

  private async withLockedScopeOperation<T>(
    scopeId: string,
    operation: () => Promise<T>,
    priority: Parameters<typeof withGroupLock>[2] = 'normal'
  ): Promise<T> {
    return await withGroupLock(scopeId, async () => {
      return await this.withStorageContext(operation)
    }, priority)
  }

  reset(): void {
    this.clearConnections()
    this.groupStates.clear()
    this.pendingCommits.clear()
    this.pendingJoinRequests.clear()
    this.pendingEvictionRequests.clear()
    this.recentEvictionClaims.clear()
    this.recentJoinDeviceIds.clear()
    this.evictionLocks.clear()
    this.scopeMessages.clear()
    this.welcomeAppliedAtByScope.clear()
    this.recentDmJoinProcessed.clear()
    this.yieldedDmScopes.clear()
    this.pendingGroupInfoPublishes.clear()
    this.groupInfoPublishRetryAttempts.clear()
    for (const timer of this.groupInfoPublishRetryTimers.values()) {
      clearTimeout(timer)
    }
    this.groupInfoPublishRetryTimers.clear()
    this.pendingExternalCommitBroadcasts.clear()
    this.externalCommitBroadcastRetryAttempts.clear()
    for (const timer of this.externalCommitBroadcastRetryTimers.values()) {
      clearTimeout(timer)
    }
    this.externalCommitBroadcastRetryTimers.clear()

    for (const waiters of this.membershipWaiters.values()) {
      for (const waiter of waiters) {
        waiter(false)
      }
    }
    this.membershipWaiters.clear()
    this.epochWaiters.clear()
    this.scopeListeners.clear()
    this.scopeWatchRefs.clear()
  }

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
        this.scopeKinds.set(scope.id, scope.kind)
        const dispose = await this.client.watchScope(scope.kind, scope.id, async ({ event, payload }) => {
          const nextEvent = await withGroupLock(scope.id, async () => {
            return await this.withStorageContext(async () => {
              return await this.handleScopeEvent(scope, event, normalizePayload(payload))
            })
          }, 'urgent')
          if (nextEvent) {
            await this.notifyScopeListeners(
              nextEvent.scope,
              nextEvent.event,
              nextEvent.payload,
              nextEvent.message
            )
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
            if (listeners.size === 0) {
              this.scopeListeners.delete(topic)
            }
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

  getMessages(scopeId: string): ProcessedScopeMessage[] {
    return [...(this.scopeMessages.get(scopeId) ?? [])]
  }

  hasGroup(scopeId: string): boolean {
    return this.groupStates.has(scopeId)
  }

  isMemberOfGroup(scopeId: string, userId: string): boolean {
    const state = this.groupStates.get(scopeId)
    if (!state) {
      return false
    }
    return groupHasMember(state, userId)
  }

  getDiagnostics(): MLSDiagnostics {
    return this.diagnostics
  }

  getMemberCount(scopeId: string): number {
    const state = this.groupStates.get(scopeId)
    if (!state) {
      return 0
    }

    return getGroupLeafIdentities(state).length
  }

  hasMemberDevice(scopeId: string, userId: string, deviceId: string | null): boolean {
    if (!deviceId) {
      return false
    }

    const state = this.groupStates.get(scopeId)
    if (!state) {
      return false
    }

    return (
      findExactMemberLeafIndex(state, buildClientCredentialIdentity(userId, deviceId)) !== null
    )
  }

  consumeWelcomeApplied(scopeId: string): boolean {
    const appliedAt = this.welcomeAppliedAtByScope.get(scopeId)
    if (appliedAt == null) {
      return false
    }

    this.welcomeAppliedAtByScope.delete(scopeId)
    return true
  }

  async syncScope(
    scope: EncryptedScope,
    options: {
      limit?: number
    } = {}
  ): Promise<ScopeSyncResult> {
    return await this.withStorageContext(async () => {
      this.scopeKinds.set(scope.id, scope.kind)

      return await withGroupLock(scope.id, async () => {
        const startedAt = performance.now()
        const limit = options.limit ?? 50

        await this.ensureGroupMembership(scope.id)
        await this.replayDurableEvents(scope.id)

        const hasGroup = this.hasGroup(scope.id)
        const epoch = this.getGroupEpoch(scope.id)

        const cached = await this.loadProcessedCachedMessages(scope.id)
        const existing = this.scopeMessages.get(scope.id) ?? cached
        const afterSeq = highestRoomSeq(existing)
        const delta =
          afterSeq == null
            ? {
                messages: await this.fetchScopeMessages(scope, limit),
                events: [] as ScopeSyncEvent[],
                hasMore: false
              }
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

  /** Ensures the MLS group for a scope is ready, optionally creating it if missing. Routes to channel or DM-specific logic. */
  async ensureScopeReady(scope: EncryptedScope, allowCreate = false): Promise<boolean> {
    return await this.withStorageContext(async () => {
      this.scopeKinds.set(scope.id, scope.kind)

      if (scope.kind === 'channel') {
        return await this.ensureChannelGroupReady(scope.id, allowCreate)
      }

      return await this.ensureDmGroupReady(scope.id, allowCreate)
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
    await this.withLockedScopeOperation(scope.id, async () => {
      const release = await this.watchScope(scope)

      try {
        const ready = await this.ensureScopeReady(scope, true)
        if (!ready) {
          throw new Error(`${scope.kind} group is still syncing`)
        }

        const plaintext = encodePayload(payload)
        const encrypted = await this.encryptForScope(scope.id, plaintext)
        await cacheSentMessage(this.storage, encrypted.ciphertext, plaintext)

        const messagePayload: Record<string, unknown> = {
          ciphertext: encrypted.ciphertext,
          mls_epoch: encrypted.epoch
        }

        if (options.parentMessageId) {
          messagePayload.parent_message_id = options.parentMessageId
        }

        if (options.mentionedUserIds && options.mentionedUserIds.length > 0) {
          messagePayload.mentioned_user_ids = [...new Set(options.mentionedUserIds)]
        }

        if (options.attachmentIds && options.attachmentIds.length > 0) {
          messagePayload.attachment_ids = [...new Set(options.attachmentIds)]
        }

        if (options.clientNonce) {
          messagePayload.client_nonce = options.clientNonce
        }

        void this.client.pushScopeEvent(scope.kind, scope.id, 'new_message', messagePayload)
      } finally {
        release()
      }
    })
  }

  async encryptOpaque(
    scope: EncryptedScope,
    plaintext: string
  ): Promise<{ ciphertext: string; epoch: number }> {
    return await this.withLockedScopeOperation(scope.id, async () => {
      this.scopeKinds.set(scope.id, scope.kind)
      const ready = await this.ensureGroupMembership(scope.id)
      if (!ready) {
        throw new Error(`${scope.kind} group is still syncing`)
      }

      return await this.encryptForScope(scope.id, plaintext)
    })
  }

  async decryptOpaque(
    scope: EncryptedScope,
    ciphertext: string,
    messageEpoch: number | null = null
  ): Promise<string | null> {
    return await this.withLockedScopeOperation(scope.id, async () => {
      this.scopeKinds.set(scope.id, scope.kind)
      return await this.decryptForScopeWithRecovery(scope, ciphertext, messageEpoch)
    })
  }

  async decryptOpaqueBatch(
    scope: EncryptedScope,
    items: Array<{ ciphertext: string; messageEpoch?: number | null }>
  ): Promise<Array<string | null>> {
    return await this.withLockedScopeOperation(scope.id, async () => {
      this.scopeKinds.set(scope.id, scope.kind)
      const decrypted: Array<string | null> = []

      for (const item of items) {
        decrypted.push(
          await this.decryptForScopeWithRecovery(scope, item.ciphertext, item.messageEpoch ?? null)
        )
      }

      return decrypted
    })
  }

  /** Public API: loads or restores MLS group membership for a scope from storage or pending welcomes. */
  async ensureMembership(scope: EncryptedScope): Promise<boolean> {
    return await this.withLockedScopeOperation(scope.id, async () => {
      this.scopeKinds.set(scope.id, scope.kind)
      return await this.ensureGroupMembership(scope.id)
    })
  }

  /** Convenience wrapper: ensures MLS group state is loaded for a raw scope ID. Equivalent to ensureMembership with a pre-resolved scope. */
  async ensureScopeState(scopeId: string): Promise<boolean> {
    return await this.withLockedScopeOperation(scopeId, async () => {
      return await this.ensureGroupMembership(scopeId)
    })
  }

  async replayScopeEvents(scopeId: string): Promise<void> {
    await this.withLockedScopeOperation(scopeId, async () => {
      await this.replayDurableEvents(scopeId)
    })
  }

  async requestJoin(scope: EncryptedScope): Promise<void> {
    await this.withStorageContext(async () => {
      await this.requestMlsJoin(scope)
    })
  }

  async requestJoinAll(scope: EncryptedScope): Promise<void> {
    await this.withStorageContext(async () => {
      const pushed = await this.client.pushScopeEvent(scope.kind, scope.id, 'mls_request_join_all', {})
      if (!pushed) {
        throw new Error(`Failed to request join-all for ${scopeTopic(scope)}`)
      }
    })
  }

  async requestResync(
    scope: EncryptedScope,
    options: {
      lastKnownEpoch?: number | null
      reason?: string | null
      username?: string | null
    } = {}
  ): Promise<void> {
    await this.withStorageContext(async () => {
      await this.client.replenishKeyPackages()

      const pushed = await this.client.pushScopeEvent(scope.kind, scope.id, 'mls_resync_request', {
        device_id: this.client.deviceIdentity?.id,
        request_id: crypto.randomUUID(),
        last_known_epoch: options.lastKnownEpoch ?? null,
        reason: options.reason ?? null,
        username: options.username ?? null
      })
      if (!pushed) {
        throw new Error(`Failed to request resync for ${scopeTopic(scope)}`)
      }
    })
  }

  async createScopeGroup(scope: EncryptedScope): Promise<boolean> {
    return await this.withLockedScopeOperation(scope.id, async () => {
      this.scopeKinds.set(scope.id, scope.kind)
      await this.createGroup(scope.id)
      if (!this.hasGroup(scope.id)) {
        return false
      }
      // Ensure GroupInfo is published before returning so callers that
      // broadcast mls_request_join_all won't race with the HTTP POST.
      const state = this.groupStates.get(scope.id)
      if (state && !await this.publishGroupInfoForScope(scope.id, state)) {
        return false
      }
      return true
    })
  }

  async createScopeState(scopeId: string): Promise<boolean> {
    return await this.withLockedScopeOperation(scopeId, async () => {
      await this.createGroup(scopeId)
      return this.hasGroup(scopeId)
    })
  }

  async resetScope(scopeId: string): Promise<void> {
    await this.withLockedScopeOperation(scopeId, async () => {
      await this.resetScopeState(scopeId)
    })
  }

  private async resetScopeState(scopeId: string): Promise<void> {
      this.groupStates.delete(scopeId)
      this.pendingCommits.delete(scopeId)
      this.scopeMessages.delete(scopeId)
      this.welcomeAppliedAtByScope.delete(scopeId)
      this.welcomeReceivedScopes.delete(scopeId)
      this.pendingGroupCreations.delete(scopeId)
      this.pendingBootstraps.delete(scopeId)
      this.welcomeInProgress.delete(scopeId)
      await this.clearPendingGroupInfoPublish(scopeId)
      await this.clearPendingExternalCommitBroadcast(scopeId)
      this.notifyMembershipWaiters(scopeId, false)
      this.membershipWaiters.delete(scopeId)
      await this.storage.deleteGroupState(scopeId)
  }

  async applyScopeCommit(scopeId: string, commitData: string | null): Promise<boolean> {
    return await this.withLockedScopeOperation(scopeId, async () => {
      return await this.handleCommit(scopeId, commitData, 'applyScopeCommit')
    })
  }

  async applyScopeWelcome(
    scopeId: string,
    welcomeData: string | null,
    keyPackageRef: string | null = null
  ): Promise<boolean> {
    return await this.withLockedScopeOperation(scopeId, async () => {
      return await this.handleWelcome(scopeId, welcomeData, keyPackageRef)
    })
  }

  async handleScopeJoinRequest(
    scopeId: string,
    userId: string,
    deviceId: string | null = null
  ): Promise<{
    removeCommitBytes: string | null
    commitBytes: string
    welcomeBytes: string | null
    keyPackageRef: string
  } | null> {
    return await this.withLockedScopeOperation(scopeId, async () => {
      return await this.handleJoinRequest(scopeId, userId, deviceId)
    })
  }

  async handleScopeResyncRequest(
    scopeId: string,
    userId: string,
    deviceId: string | null = null
  ): Promise<{
    removeCommitBytes: string | null
    commitBytes: string
    welcomeBytes: string | null
    keyPackageRef: string
  } | null> {
    return await this.withLockedScopeOperation(scopeId, async () => {
      return await this.handleResyncRequest(scopeId, userId, deviceId)
    })
  }

  async deriveScopeVoiceKey(scopeId: string): Promise<Uint8Array | null> {
    return await this.withStorageContext(async () => {
      const state = this.groupStates.get(scopeId)
      if (!state) {
        return null
      }

      await initCipherSuite()
      return await deriveVoiceKey(state)
    })
  }

  async handleExternalResyncRequest(
    scope: EncryptedScope,
    userId: string,
    deviceId: string | null = null
  ): Promise<{
    removeCommitBytes: string | null
    commitBytes: string
    welcomeBytes: string | null
    keyPackageRef: string
  } | null> {
    return await this.withLockedScopeOperation(scope.id, async () => {
      return await this.handleResyncRequest(scope.id, userId, deviceId)
    })
  }

  async sponsorScopeJoin(
    scopeId: string,
    userId: string,
    deviceId: string | null = null,
    options: {
      topic?: string | null
    } = {}
  ): Promise<boolean> {
    return await this.withLockedScopeOperation(scopeId, async () => {
      const result = await this.handleJoinRequest(scopeId, userId, deviceId)
      if (!result) {
        return false
      }

      return await this.deliverSponsoredTransition(scopeId, userId, deviceId, result, options.topic ?? null)
    })
  }

  async sponsorScopeResync(
    scopeId: string,
    userId: string,
    deviceId: string | null = null,
    options: {
      topic?: string | null
    } = {}
  ): Promise<boolean> {
    return await this.withLockedScopeOperation(scopeId, async () => {
      const result = await this.handleResyncRequest(scopeId, userId, deviceId)
      if (!result) {
        return false
      }

      return await this.deliverSponsoredTransition(scopeId, userId, deviceId, result, options.topic ?? null)
    })
  }

  async handleExternalEvictionRequest(
    scope: EncryptedScope,
    payload: Record<string, unknown> | null
  ): Promise<boolean> {
    return await this.withLockedScopeOperation(scope.id, async () => {
      return await this.handleEvictionRequestEvent(scope, payload)
    })
  }

  async editText(scope: EncryptedScope, messageId: string, text: string): Promise<void> {
    await this.withLockedScopeOperation(scope.id, async () => {
      const ready = await this.ensureScopeReady(scope)
      if (!ready) {
        throw new Error(`${scope.kind} group is still syncing`)
      }

      const encrypted = await this.encryptForScope(
        scope.id,
        encodePayload({ v: 1, type: 'text', text })
      )
      await cacheSentMessage(this.storage, encrypted.ciphertext, text)

      const pushed = await this.client.pushScopeEvent(scope.kind, scope.id, 'edit_message', {
        message_id: messageId,
        ciphertext: encrypted.ciphertext,
        mls_epoch: encrypted.epoch
      })
      if (!pushed) {
        throw new Error(`Failed to edit message in ${scopeTopic(scope)}`)
      }
    })
  }

  async deleteMessage(scope: EncryptedScope, messageId: string): Promise<void> {
    await this.withStorageContext(async () => {
      const pushed = await this.client.pushScopeEvent(scope.kind, scope.id, 'delete_message', {
        message_id: messageId
      })
      if (!pushed) {
        throw new Error(`Failed to delete message in ${scopeTopic(scope)}`)
      }
    })
  }

  async addReaction(scope: EncryptedScope, messageId: string, emoji: string): Promise<void> {
    await this.withLockedScopeOperation(scope.id, async () => {
      await this.pushReaction(scope, 'add_reaction', messageId, emoji)
    })
  }

  async removeReaction(scope: EncryptedScope, messageId: string, emoji: string): Promise<void> {
    await this.withLockedScopeOperation(scope.id, async () => {
      await this.pushReaction(scope, 'remove_reaction', messageId, emoji)
    })
  }

  async sendTyping(scope: EncryptedScope, active: boolean): Promise<void> {
    const pushed = await this.client.pushScopeEvent(
      scope.kind,
      scope.id,
      active ? 'typing_start' : 'typing_stop',
      {}
    )
    if (!pushed) {
      throw new Error(`Failed to update typing state for ${scopeTopic(scope)}`)
    }
  }

  async pinMessage(scope: EncryptedScope, messageId: string): Promise<void> {
    const pushed = await this.client.pushScopeEvent(scope.kind, scope.id, 'pin_message', {
      message_id: messageId
    })
    if (!pushed) {
      throw new Error(`Failed to pin message in ${scopeTopic(scope)}`)
    }
  }

  async unpinMessage(scope: EncryptedScope, messageId: string): Promise<void> {
    const pushed = await this.client.pushScopeEvent(scope.kind, scope.id, 'unpin_message', {
      message_id: messageId
    })
    if (!pushed) {
      throw new Error(`Failed to unpin message in ${scopeTopic(scope)}`)
    }
  }

  private async handleScopeEvent(
    scope: EncryptedScope,
    event: string,
    payload: Record<string, unknown> | null
  ): Promise<EncryptedScopeWatchEvent | null> {
    if (event === 'new_message') {
      const message = await this.processIncomingMessage(scope, payload as unknown as VesperMessage)
      this.upsertScopeMessage(scope.id, message)
      return {
        scope,
        event,
        payload,
        message
      }
    }

    if (event === 'reaction_update') {
      const message = await this.handleReactionUpdate(scope, payload)
      return {
        scope,
        event,
        payload,
        message: message ?? undefined
      }
    }

    if (event === 'message_edited') {
      const message = await this.handleMessageEdited(scope, payload)
      return {
        scope,
        event,
        payload,
        message: message ?? undefined
      }
    }

    if (event === 'message_deleted') {
      const messageId = await this.handleMessageDeleted(scope, payload)
      return {
        scope,
        event,
        payload,
        deletedMessageId: messageId
      }
    }

    if (event === 'mls_request_join_all') {
      const senderId = this.getString(payload, 'user_id')
      const localUserId = this.client.getAuthSession()?.user.id ?? this.client.getState().user?.id

      if (scope.kind === 'dm' && senderId && localUserId) {
        if (!this.hasGroup(scope.id)) {
          // No group yet — the messageStore will create one and send its own
          // requestJoinAll. Leader election happens once both sides have groups.
          return { scope, event, payload }
        }

        // Both sides independently created MLS groups for this DM.
        // Use deterministic leader election (lower user ID wins) to break
        // the symmetry — the loser drops their group and External Commits
        // into the leader's group.
        if (localUserId < senderId) {
          // We're the leader — keep our group. Ensure GroupInfo is published
          // so the sender can External Commit in.
          const state = this.groupStates.get(scope.id)
          if (state) {
            await this.publishGroupInfoForScope(scope.id, state)
          }
          return { scope, event, payload }
        }

        // We're not the leader — but if we already joined the leader's group
        // via External Commit or Welcome, we're done.
        if (this.welcomeReceivedScopes.has(scope.id)) {
          return { scope, event, payload }
        }

        // We independently created this group — drop it and External Commit
        // into the leader's group. Mark as yielded so concurrent code paths
        // (e.g. forceBootstrapDmGroup) don't immediately recreate it.
        this.yieldedDmScopes.add(scope.id)
        await this.resetScopeState(scope.id)
        await this.tryJoinViaExternalCommit(scope.id)
        return { scope, event, payload }
      }

      // Non-DM scope (channel) — External Commit into the sender's group.
      // Retry once after a short delay if the first attempt fails — the
      // GroupInfo publish may still be in flight when this event arrives.
      if (!await this.tryJoinViaExternalCommit(scope.id)) {
        await new Promise(r => setTimeout(r, 500))
        await this.tryJoinViaExternalCommit(scope.id)
      }
      return { scope, event, payload }
    }

    if (event === 'mls_request_join') {
      await this.handleJoinRequestEvent(scope, payload)
      return { scope, event, payload }
    }

    if (event === 'mls_commit') {
      const senderId = this.getString(payload, 'sender_id')
      const senderDeviceId = this.getString(payload, 'sender_device_id')
      const localUserId = this.client.getAuthSession()?.user.id ?? this.client.getState().user?.id
      const localDeviceId = this.client.deviceIdentity?.id ?? null

        if (senderId !== localUserId || senderDeviceId !== localDeviceId) {
          await this.handleCommit(scope.id, this.getString(payload, 'commit_data'), 'liveEvent')
        }

      return { scope, event, payload }
    }

    if (event === 'mls_remove') {
      await this.handleRemoveEvent(scope, payload)
      return { scope, event, payload }
    }

    if (event === 'mls_eviction_request') {
      await this.handleEvictionRequestEvent(scope, payload)
      return { scope, event, payload }
    }

    if (event === 'mls_welcome') {
      const recipientId = this.getString(payload, 'recipient_id')
      const recipientDeviceId = this.getString(payload, 'recipient_device_id')
      const localUserId = this.client.getAuthSession()?.user.id ?? this.client.getState().user?.id
      const localDeviceId = this.client.deviceIdentity?.id ?? null

      if (
        recipientId === localUserId &&
        (!recipientDeviceId || recipientDeviceId === localDeviceId)
      ) {
        const processed = await this.handleWelcome(
          scope.id,
          this.getString(payload, 'welcome_data'),
          this.getString(payload, 'key_package_ref')
        )

        if (processed) {
          const welcomeId = this.getString(payload, 'id')
          if (welcomeId) {
            await ackPendingWelcome(welcomeId, this.client.getHttpClient()).catch((e) => this.logIgnoredError('ack welcome', e))
          }
        }
      }

      return { scope, event, payload }
    }

    return { scope, event, payload }
  }

  private async handleRemoveEvent(
    scope: EncryptedScope,
    payload: Record<string, unknown> | null
  ): Promise<void> {
    const senderId = this.getString(payload, 'sender_id')
    const senderDeviceId = this.getString(payload, 'sender_device_id')
    const removedUserId = this.getString(payload, 'removed_user_id')
    const removedDeviceId = this.getString(payload, 'removed_device_id')
    const localUserId = this.client.getAuthSession()?.user.id ?? this.client.getState().user?.id
    const localDeviceId = this.client.deviceIdentity?.id ?? null
    const isLocalSender = senderId === localUserId && senderDeviceId === localDeviceId
    const isLocalTarget =
      removedUserId === localUserId &&
      (removedDeviceId == null || removedDeviceId === localDeviceId)

    if (isLocalTarget && !isLocalSender) {
      await this.resetScopeState(scope.id)
      return
    }

    if (!isLocalSender) {
      await this.handleCommit(scope.id, this.getString(payload, 'commit_data'), 'removeEvent')
    }
  }

  private async handleEvictionRequestEvent(
    scope: EncryptedScope,
    payload: Record<string, unknown> | null
  ): Promise<boolean> {
    const evictionId =
      this.getString(payload, 'eviction_id') ??
      this.getString(payload, 'request_id') ??
      this.getString(payload, 'id')
    const targetUserId =
      this.getString(payload, 'target_user_id') ??
      this.getString(payload, 'removed_user_id') ??
      this.getString(payload, 'user_id')
    const targetDeviceId =
      this.getString(payload, 'target_device_id') ??
      this.getString(payload, 'removed_device_id') ??
      this.getString(payload, 'device_id')
    const session = this.client.getAuthSession()
    const localDeviceId = this.client.deviceIdentity?.id ?? null

    if (!evictionId || !targetUserId || !session || !localDeviceId) {
      return false
    }

    const isLocalTarget =
      session.user.id === targetUserId &&
      (targetDeviceId == null || targetDeviceId === localDeviceId)
    if (isLocalTarget) {
      return false
    }

    const existing = this.pendingEvictionRequests.get(evictionId)
    if (existing) {
      await existing
      return this.recentEvictionClaims.has(evictionId)
    }

    const recentAt = this.recentEvictionClaims.get(evictionId) ?? 0
    if (Date.now() - recentAt < EVICTION_REQUEST_COOLDOWN_MS) {
      return false
    }

    let handled = false
    const prev = this.evictionLocks.get(scope.id) ?? Promise.resolve()
    const current = prev
      .then(async () => {
        const state = this.groupStates.get(scope.id)
        if (!state) {
          return
        }

        if (!groupHasMember(state, session.user.id, session.user.username)) {
          return
        }

        const claimed = await this.client.pushScopeEvent(scope.kind, scope.id, 'mls_eviction_claim', {
          id: evictionId
        })
        if (!claimed) {
          return
        }

        const leafIndex =
          targetDeviceId != null
            ? (() => {
                const targetIdentity = buildClientCredentialIdentity(targetUserId, targetDeviceId)
                return getGroupLeafIdentities(state).includes(targetIdentity)
                  ? findMemberLeafIndex(state, targetIdentity)
                  : null
              })()
            : findMemberLeafIndex(state, targetUserId)

        if (leafIndex == null) {
          const skipped = await this.client.pushScopeEvent(scope.kind, scope.id, 'mls_eviction_skip', {
            id: evictionId,
            target_user_id: targetUserId,
            ...(targetDeviceId ? { target_device_id: targetDeviceId } : {}),
            reason: 'leaf_missing'
          })

          if (skipped) {
            this.recentEvictionClaims.set(evictionId, Date.now())
            handled = true
          }

          return
        }

        const removed = await removeMemberFromGroup(this.cloneGroupState(state), leafIndex)
        await this.setGroupState(scope.id, removed.newState)

        const pushed = await this.client.pushScopeEvent(scope.kind, scope.id, 'mls_remove', {
          removed_user_id: targetUserId,
          ...(targetDeviceId ? { removed_device_id: targetDeviceId } : {}),
          commit_data: uint8ToBase64(removed.commitBytes),
          eviction_id: evictionId
        })

        if (pushed) {
          this.recentEvictionClaims.set(evictionId, Date.now())
          handled = true
        }
      })
      .finally(() => {
        this.pendingEvictionRequests.delete(evictionId)
        this.evictionLocks.delete(scope.id)
      })

    this.pendingEvictionRequests.set(evictionId, current)
    this.evictionLocks.set(scope.id, current)
    await current
    return handled
  }

  /**
   * Handle an incoming mls_request_join event. With External Commit as the
   * canonical join path, existing members no longer generate Welcomes —
   * joiners self-join via published GroupInfo. We only track the device ID
   * for presence awareness.
   */
  private async handleJoinRequestEvent(
    scope: EncryptedScope,
    payload: Record<string, unknown> | null
  ): Promise<void> {
    const requesterId = this.getString(payload, 'user_id')
    const requesterDeviceId = this.getString(payload, 'device_id')
    if (requesterId) {
      this.rememberJoinDeviceId(scope, requesterId, requesterDeviceId)
    }
  }

  private async ensureChannelGroupReady(channelId: string, allowCreate = false): Promise<boolean> {
    if (await this.ensureGroupMembership(channelId)) {
      await this.replayDurableEvents(channelId)
      return this.hasGroup(channelId)
    }

    // ensureGroupMembership already tried External Commit. If it failed,
    // there may be no GroupInfo published yet (no group exists).
    if (!allowCreate) {
      return this.hasGroup(channelId)
    }

    if (await this.channelHasExistingActivity(channelId)) {
      return false
    }

    const localUserId = this.client.getAuthSession()?.user.id ?? this.client.getState().user?.id
    const ownerUserId = await this.resolveChannelOwnerId(channelId)
    if (!localUserId || ownerUserId == null || localUserId !== ownerUserId) {
      return false
    }

    await this.createGroup(channelId)
    if (!this.hasGroup(channelId)) {
      return false
    }

    // setGroupState (called by createGroup) publishes GroupInfo as
    // fire-and-forget. We must await it explicitly here so the GroupInfo is
    // available on the server BEFORE we broadcast mls_request_join_all —
    // otherwise recipients try to External Commit and find no GroupInfo.
    const freshState = this.groupStates.get(channelId)
    if (freshState && !await this.publishGroupInfoForScope(channelId, freshState)) {
      return false
    }

    if (!await this.channelRequiresExternalJoin(channelId, localUserId)) {
      return true
    }

    await this.client.pushScopeEvent('channel', channelId, 'mls_request_join_all', {})

    // Wait for at least one member to External Commit before returning.
    // Without this, the caller encrypts at epoch 0 (only the creator in the
    // group) and other members can never decrypt those messages. Live channel
    // subscribers respond to mls_request_join_all by External Committing from
    // the published GroupInfo, which advances the epoch via mls_commit.
    // Uses a notification from setGroupState rather than polling.
    //
    // If nobody joins within the timeout, return false so the caller
    // (sendPayload) retries rather than encrypting to an empty group.
    const advanced = await this.awaitEpochAdvance(channelId, 5_000)
    return advanced || this.getGroupEpoch(channelId) !== 0
  }

  private async ensureDmGroupReady(conversationId: string, allowForce = false): Promise<boolean> {
    if (await this.ensureGroupMembership(conversationId)) {
      await this.replayDurableEvents(conversationId)
      return this.hasGroup(conversationId)
    }

    if (await this.bootstrapDmGroupIfLeader(conversationId)) {
      await this.replayDurableEvents(conversationId)
      return this.hasGroup(conversationId)
    }

    // ensureGroupMembership already tried External Commit. If it failed
    // and we can't bootstrap, the other participant may be offline.
    if (!allowForce) {
      return this.hasGroup(conversationId)
    }

    // Force-create: bootstrap the group with ALL participants (not just a solo
    // group).  `bootstrapDmGroupIfLeader` gates on leader election, but when we
    // reach here the leader isn't online and nobody responded to our join
    // request.  Creating a solo group would encrypt at epoch 0 with only the
    // local user — the remote participant could never decrypt those messages.
    await this.bootstrapDmGroup(conversationId)
    return this.hasGroup(conversationId)
  }

  /** Core private impl: checks in-memory group state, falls back to persisted storage, then tries External Commit, then Welcome. */
  private async ensureGroupMembership(scopeId: string): Promise<boolean> {
    if (this.hasGroup(scopeId)) {
      await this.processPendingCommits(scopeId)
      return true
    }

    const persisted = await this.storage.loadGroupState(scopeId)
    if (persisted) {
      try {
        const state = deserializeGroupState(new Uint8Array(persisted.state))
        this.groupStates.set(scopeId, state)
        await this.processPendingCommits(scopeId)
        this.notifyMembershipWaiters(scopeId, true)
        return true
      } catch {
        this.groupStates.delete(scopeId)
      }
    }

    // External Commit (RFC 9420 §12.4) — canonical live join path.
    // Uses CAS on GroupInfo publish to serialize concurrent joiners.
    if (await this.tryJoinViaExternalCommit(scopeId)) {
      return true
    }

    // Fall back to Welcome-based join (offline scenarios, backward compat)
    let welcomes: Awaited<ReturnType<typeof fetchPendingWelcomes>> = []
    try {
      welcomes = await fetchPendingWelcomes(scopeId, this.client.getHttpClient())
    } catch {
      // Server unreachable or error; treat as no pending welcomes.
    }

    for (const welcome of welcomes) {
      const processed = await this.handleWelcome(
        scopeId,
        uint8ToBase64(welcome.welcome_data),
        welcome.key_package_ref ?? null
      )

      if (processed) {
        await ackPendingWelcome(welcome.id, this.client.getHttpClient()).catch((e) => this.logIgnoredError('ack welcome', e))
        this.welcomeAppliedAtByScope.set(scopeId, Date.now())
        this.welcomeReceivedScopes.add(scopeId)
        this.notifyMembershipWaiters(scopeId, true)
        return true
      }
    }

    return false
  }

  /**
   * Try to join a group via External Commit using published GroupInfo.
   * This is the canonical live join path (RFC 9420 §12.4).
   *
   * Uses compare-and-swap on the server's GroupInfo publish to serialize
   * concurrent joiners: only one External Commit per epoch transition
   * succeeds. Losers retry with fresh GroupInfo.
   */
  private async tryJoinViaExternalCommit(scopeId: string): Promise<boolean> {
    // Already in this group — skip.
    if (this.hasGroup(scopeId)) {
      return true
    }

    // Serialize concurrent EC attempts for the same scope. Without this,
    // two callers (e.g. ensureMembership and mls_request_join_all handler)
    // can both CAS-publish successfully on consecutive epochs, inflating
    // the epoch count.
    const inflight = this.pendingExternalCommits.get(scopeId)
    if (inflight) {
      return await inflight
    }

    const promise = this.doExternalCommit(scopeId)
    this.pendingExternalCommits.set(scopeId, promise)
    try {
      return await promise
    } finally {
      this.pendingExternalCommits.delete(scopeId)
    }
  }

  private async doExternalCommit(scopeId: string): Promise<boolean> {
    const MAX_RETRIES = 5

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      // Another code path may have joined while we were retrying.
      if (this.hasGroup(scopeId)) {
        return true
      }

      try {
        await initCipherSuite()

        const groupInfo = await fetchGroupInfo(scopeId, this.client.getHttpClient())
        if (!groupInfo) {
          return false // No GroupInfo published yet
        }

        const session = this.requireSession()
        const localDeviceId = this.requireDeviceId()
        const identityName = buildClientCredentialIdentity(session.user.id, localDeviceId)

        const { state, commitBytes } = await joinViaExternalCommit(
          groupInfo.groupInfoData,
          groupInfo.ratchetTreeData,
          identityName
        )

        const commitData = uint8ToBase64(commitBytes)
        const commitId = await this.computeMlsCommitId(scopeId, commitData)
        const newEpoch = Number(state.groupContext.epoch)

        // CAS publish: claim this epoch transition. Only succeeds if the
        // server's stored epoch still matches the one we built on.
        const result = await publishGroupInfo(
          scopeId,
          exportGroupInfo(state),
          exportRatchetTree(state),
          newEpoch,
          this.client.getHttpClient(),
          groupInfo.epoch // previousEpoch — the epoch we External Committed from
        )

        if (result === 'conflict') {
          if (attempt < MAX_RETRIES - 1) {
            // Another joiner won this epoch. Jitter and retry with fresh GroupInfo.
            await new Promise(r => setTimeout(r, 50 + Math.floor(Math.random() * 300 * (attempt + 1))))
            continue
          }
          return false
        }

        // CAS succeeded — persist the new epoch locally before advertising it
        // to peers so retries never build on an epoch that no client has saved.
        await this.setGroupState(scopeId, state, { publishGroupInfo: false })
        // Mark as joined so the mls_request_join_all handler won't reset and re-EC.
        this.welcomeReceivedScopes.add(scopeId)

        try {
          await this.queueExternalCommitBroadcast(scopeId, commitData, commitId)
        } catch (error) {
          this.logIgnoredError('queue external commit broadcast', error)
        }

        if (!await this.broadcastExternalCommit(scopeId, commitData, commitId)) {
          this.scheduleExternalCommitBroadcastRetry(scopeId)
        }
        return true
      } catch (err) {
        if (attempt < MAX_RETRIES - 1) {
          await new Promise(r => setTimeout(r, 50 + Math.floor(Math.random() * 300 * (attempt + 1))))
          continue
        }
        return false
      }
    }
    return false
  }

  /**
   * Broadcast an external commit to the group via the scope event system.
   */
  private async broadcastExternalCommit(
    scopeId: string,
    commitData: string,
    commitId: string
  ): Promise<boolean> {
    const pending = {
      commitData,
      commitId
    } satisfies PendingExternalCommitBroadcast

    try {
      const pushed = await this.pushMlsControlEvent(scopeId, 'mls_commit', {
        commit_data: commitData,
        idempotency_key: commitId,
        commit_id: commitId
      })
      if (!pushed) {
        return false
      }

      await this.clearPendingExternalCommitBroadcast(scopeId, pending)
      return true
    } catch (error) {
      if (!this.externalCommitBroadcastRetryTimers.has(scopeId)) {
        this.logIgnoredError('broadcast external commit', error)
      }
      return false
    }
  }

  private async replayDurableEvents(scopeId: string): Promise<void> {
    const session = this.client.getAuthSession()
    const localDeviceId = this.client.deviceIdentity?.id ?? null
    if (!session || !localDeviceId) {
      return
    }

    const pageSize = 200
    let cursor = await this.storage.loadGroupSyncCursor(scopeId)

    while (true) {
      let events: Awaited<ReturnType<typeof fetchMlsEvents>> = []
      try {
        events = await fetchMlsEvents(scopeId, cursor, pageSize, this.client.getHttpClient())
      } catch {
        return
      }

      if (events.length === 0) {
        return
      }

      let latestSeq = cursor

      for (const event of events) {
        if (
          event.event_type === 'mls_commit' &&
          typeof event.payload.commit_data === 'string' &&
          !(
            event.sender_id === session.user.id &&
            event.sender_device_id === localDeviceId
          )
        ) {
          const applied = await this.handleCommit(scopeId, event.payload.commit_data, 'replayDurable')
          if (!applied) {
            if (latestSeq > cursor) {
              await this.storage.saveGroupSyncCursor(scopeId, latestSeq)
            }
            return
          }
        }

        if (event.event_type === 'mls_remove') {
          const payload = event.payload as Record<string, unknown> | undefined
          const removedUserId =
            typeof payload?.removed_user_id === 'string' ? payload.removed_user_id : null
          const removedDeviceId =
            typeof payload?.removed_device_id === 'string' ? payload.removed_device_id : null
          const isLocalTarget =
            removedUserId === session.user.id &&
            (removedDeviceId == null || removedDeviceId === localDeviceId)

          if (isLocalTarget) {
            await this.resetScopeState(scopeId)
            return
          }
        }

        latestSeq = Math.max(latestSeq, event.seq)
      }

      if (latestSeq > cursor) {
        await this.storage.saveGroupSyncCursor(scopeId, latestSeq)
        cursor = latestSeq
      }

      if (events.length < pageSize) {
        return
      }
    }
  }

  private async processIncomingMessage(
    scope: EncryptedScope,
    rawMessage: VesperMessage,
    options: {
      allowCachedMessageDecryption?: boolean
    } = {}
  ): Promise<ProcessedScopeMessage> {
    const scopeId = scope.id
    const ciphertext = typeof rawMessage.ciphertext === 'string' ? rawMessage.ciphertext : null
    let content = typeof rawMessage.content === 'string' ? rawMessage.content : ''
    let encrypted = false
    let decryptionFailed = false
    let plaintext: string | null = typeof rawMessage.content === 'string' ? rawMessage.content : null
    const allowCachedMessageDecryption = options.allowCachedMessageDecryption ?? true

    if (ciphertext) {
      encrypted = true

      const [sentPlaintext, cachedMessagePlaintext] = await Promise.all([
        this.storage.loadSentMessagePlaintext(ciphertext),
        allowCachedMessageDecryption
          ? this.storage.loadCachedMessageDecryption(rawMessage.id)
          : Promise.resolve(null)
      ])
      const cachedPlaintext = sentPlaintext ?? cachedMessagePlaintext
      const decrypted =
        cachedPlaintext ??
        (await this.decryptForScopeWithRecovery(scope, ciphertext, rawMessage.mls_epoch ?? null))

      if (decrypted) {
        plaintext = decrypted
        content = coerceDisplayText(decrypted)
      } else {
        console.warn(`[E2EE] processIncomingMessage: DECRYPT FAILED msgId=${rawMessage.id} msgEpoch=${rawMessage.mls_epoch} scope=${scopeId} hasSent=${!!sentPlaintext} hasCached=${!!cachedMessagePlaintext}`)
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
        ciphertext: ciphertext ? Buffer.from(ciphertext, 'base64') : null,
        decryptedContent: decryptionFailed ? null : plaintext,
        mlsEpoch: rawMessage.mls_epoch ?? null,
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

  private async requestMlsJoin(scope: EncryptedScope): Promise<void> {
    const topic = scopeTopic(scope)
    const existingRequest = this.pendingJoinRequests.get(topic)
    if (existingRequest) {
      await existingRequest
      return
    }

    const request = (async () => {
      await this.client.replenishKeyPackages()

      const pushed = await this.client.pushScopeEvent(scope.kind, scope.id, 'mls_request_join', {
        device_id: this.client.deviceIdentity?.id
      })

      if (!pushed) {
        throw new Error(`Failed to request MLS join for ${topic}`)
      }
    })()

    this.pendingJoinRequests.set(topic, request)

    try {
      await request
    } finally {
      this.pendingJoinRequests.delete(topic)
    }
  }

  private async createGroup(scopeId: string): Promise<void> {
    if (this.hasGroup(scopeId)) {
      return
    }

    // If this DM scope was recently yielded via leader election, don't
    // recreate — we're waiting for the leader's Welcome to arrive.
    if (this.yieldedDmScopes.has(scopeId)) {
      return
    }

    // Guard against concurrent createGroup calls for the same scope.
    // Without this, two callers (e.g. ensureDmGroupReady and
    // forceBootstrapDmGroup) can both pass the hasGroup check before
    // either finishes, each consuming a key package and overwriting
    // the other's group state. The second caller awaits the first
    // call's completion instead of creating a duplicate group.
    const inflight = this.pendingGroupCreations.get(scopeId)
    if (inflight) {
      await inflight.catch(() => {})
      return
    }

    const promise = this.doCreateGroup(scopeId)
    this.pendingGroupCreations.set(scopeId, promise)
    try {
      await promise
    } finally {
      this.pendingGroupCreations.delete(scopeId)
    }
  }

  private async doCreateGroup(scopeId: string): Promise<void> {
    await initCipherSuite()
    await this.client.replenishKeyPackages()

    const session = this.requireSession()
    const localDeviceId = this.requireDeviceId()
    const identityName = buildClientCredentialIdentity(session.user.id, localDeviceId)

    const state = await createMLSGroup(scopeId, identityName)
    await this.setGroupState(scopeId, state)
    this.diagnostics.recordGroupCreated(scopeId)
    await this.client.replenishKeyPackages()
  }

  private async handleJoinRequest(
    scopeId: string,
    userId: string,
    deviceId: string | null
  ): Promise<{
    removeCommitBytes: string | null
    commitBytes: string
    welcomeBytes: string | null
    keyPackageRef: string
  } | null> {
    const state = this.groupStates.get(scopeId)
    if (!state) {
      return null
    }

    await initCipherSuite()
    let keyPackageBytes: Uint8Array | null
    try {
      keyPackageBytes = await fetchKeyPackage(
        userId,
        deviceId ?? undefined,
        this.client.getHttpClient()
      )
    } catch {
      return null
    }
    if (!keyPackageBytes) {
      return null
    }

    // With OpenMLS, key packages are opaque WASM objects. We infer the requested
    // identity from the userId/deviceId parameters rather than parsing the credential.
    const requestedIdentity = deviceId
      ? buildClientCredentialIdentity(userId, deviceId)
      : userId

    let workingState = this.cloneGroupState(state)
    let removeCommitBytes: string | null = null

    // If the requester is already a member, they probably reset their local
    // MLS state and are trying to rejoin. Remove the stale leaf first so the
    // add below succeeds (same approach as handleResyncRequest).
    if (requestedIdentity) {
      const existingLeafIndex = findExactMemberLeafIndex(workingState, requestedIdentity)
      if (existingLeafIndex !== null) {
        const removed = await removeMemberFromGroup(workingState, existingLeafIndex)
        workingState = removed.newState
        removeCommitBytes = uint8ToBase64(removed.commitBytes)
      }
    }

    if (
      requestedIdentity &&
      findExactMemberLeafIndex(workingState, requestedIdentity) !== null
    ) {
      return null
    }

    const beforeEpoch = this.getGroupEpoch(scopeId)
    const result = await addMemberToGroup(workingState, keyPackageBytes)
    await this.setGroupState(scopeId, result.newState)
    const afterEpoch = this.getGroupEpoch(scopeId)

    return {
      removeCommitBytes,
      commitBytes: uint8ToBase64(result.commitBytes),
      welcomeBytes: result.welcomeBytes ? uint8ToBase64(result.welcomeBytes) : null,
      keyPackageRef: uint8ToBase64(keyPackageBytes)
    }
  }

  private async handleWelcome(
    scopeId: string,
    welcomeData: string | null,
    keyPackageRef: string | null
  ): Promise<boolean> {
    if (!welcomeData) {
      return false
    }

    // If we already have a valid group for this scope, skip the welcome.
    // The same welcome arrives via two parallel paths (live WebSocket
    // broadcast AND server-side pending_welcomes table), and without this
    // guard both paths process it successfully, each consuming a key
    // package unnecessarily. The only case where we'd want to process a
    // welcome with an existing group is after resetScope, which clears
    // the group state — so hasGroup returns false and the guard doesn't fire.
    if (this.hasGroup(scopeId)) {
      return false
    }

    // Prevent concurrent welcome processing for the same scope. Multiple
    // async paths (WebSocket handler, ensureMembership polling, pending
    // welcome fetch) can all enter handleWelcome before any completes —
    // the hasGroup check above passes for all of them because none has
    // called setGroupState yet. This synchronous flag blocks the second
    // caller before the first await.
    if (this.welcomeInProgress.has(scopeId)) {
      return false
    }
    this.welcomeInProgress.add(scopeId)

    try {
    await initCipherSuite()
    const orderedPackages = await this.loadOrderedWelcomeKeyPackages(keyPackageRef)
    if (orderedPackages.length === 0) {
      return false
    }

    for (const localPackage of orderedPackages) {
      try {
        const session = this.requireSession()
        const localDeviceId = this.requireDeviceId()
        const identityName = buildClientCredentialIdentity(session.user.id, localDeviceId)
        const state = await processWelcome(
          Buffer.from(welcomeData, 'base64'),
          identityName,
          new Uint8Array(localPackage.privateData)
        )

        await this.setGroupState(scopeId, state)
        this.yieldedDmScopes.delete(scopeId)
        this.welcomeAppliedAtByScope.set(scopeId, Date.now())
        this.welcomeReceivedScopes.add(scopeId)
        await this.storage.consumeKeyPackage(localPackage.id)
        await this.processPendingCommits(scopeId)
        await this.client.replenishKeyPackages()
        this.diagnostics.recordWelcome(scopeId, true)
        return true
      } catch {
        continue
      }
    }

    this.diagnostics.recordWelcome(scopeId, false)
    return false
    } finally {
      this.welcomeInProgress.delete(scopeId)
    }
    return false
  }

  private async handleCommit(scopeId: string, commitData: string | null, source = 'unknown'): Promise<boolean> {
    if (!commitData) {
      return false
    }

    const currentState = this.groupStates.get(scopeId)
    if (!currentState) {
      const pending = this.pendingCommits.get(scopeId) ?? []
      pending.push(commitData)
      this.pendingCommits.set(scopeId, pending)
      return false
    }

    try {
      await initCipherSuite()
      const nextState = await processCommitMessage(
        this.cloneGroupState(currentState),
        Buffer.from(commitData, 'base64')
      )
      await this.setGroupState(scopeId, nextState)
      this.diagnostics.recordCommit(scopeId, true)
      this.notifyMembershipWaiters(scopeId, true)
      return true
    } catch (err) {
      this.diagnostics.recordCommit(scopeId, false)
      return false
    }
  }

  private async handleResyncRequest(
    scopeId: string,
    userId: string,
    deviceId: string | null
  ): Promise<{
    removeCommitBytes: string | null
    commitBytes: string
    welcomeBytes: string | null
    keyPackageRef: string
  } | null> {
    const state = this.groupStates.get(scopeId)
    if (!state) {
      return null
    }

    try {
      await initCipherSuite()
      const session = this.requireSession()
      const memberIdentities = getGroupMemberIdentities(state)
      const isSameUser = userId === session.user.id

      if (
        !memberIdentities.some(
          (identity) => identity === session.user.id || identity === session.user.username
        ) ||
        (!isSameUser &&
          memberIdentities[0] !== session.user.id &&
          memberIdentities[0] !== session.user.username)
      ) {
        return null
      }

      const keyPackageBytes = await fetchKeyPackage(
        userId,
        deviceId ?? undefined,
        this.client.getHttpClient()
      )
      if (!keyPackageBytes) {
        return null
      }

      // Infer identity from userId/deviceId rather than parsing the opaque key package
      const requestedIdentity = deviceId
        ? buildClientCredentialIdentity(userId, deviceId)
        : userId

      let workingState = this.cloneGroupState(state)
      let removeCommitBytes: string | null = null

      const existingLeafIndex = findExactMemberLeafIndex(workingState, requestedIdentity)

      if (existingLeafIndex !== null) {
        const removed = await removeMemberFromGroup(workingState, existingLeafIndex)
        workingState = removed.newState
        removeCommitBytes = uint8ToBase64(removed.commitBytes)
      }

      if (
        requestedIdentity &&
        findExactMemberLeafIndex(workingState, requestedIdentity) !== null
      ) {
        return null
      }

      const added = await addMemberToGroup(workingState, keyPackageBytes)
      await this.setGroupState(scopeId, added.newState)

      return {
        removeCommitBytes,
        commitBytes: uint8ToBase64(added.commitBytes),
        welcomeBytes: added.welcomeBytes ? uint8ToBase64(added.welcomeBytes) : null,
        keyPackageRef: uint8ToBase64(keyPackageBytes)
      }
    } catch {
      return null
    }
  }

  private async processPendingCommits(scopeId: string): Promise<void> {
    if (!this.hasGroup(scopeId)) {
      return
    }

    const pending = this.pendingCommits.get(scopeId) ?? []
    if (pending.length === 0) {
      return
    }

    const remaining: string[] = []
    let blocked = false
    this.pendingCommits.delete(scopeId)

    for (const commitData of pending) {
      if (blocked) {
        remaining.push(commitData)
        continue
      }

      const applied = await this.handleCommit(scopeId, commitData, 'pendingCommit')
      if (!applied) {
        blocked = true
        remaining.push(commitData)
      }
    }

    if (remaining.length > 0) {
      this.pendingCommits.set(scopeId, remaining)
    }
  }

  private async deliverSponsoredTransition(
    scopeId: string,
    userId: string,
    deviceId: string | null,
    result: {
      removeCommitBytes: string | null
      commitBytes: string
      welcomeBytes: string | null
      keyPackageRef: string
    },
    topic: string | null
  ): Promise<boolean> {
    if (result.removeCommitBytes) {
      const removed = await this.pushMlsControlEvent(scopeId, 'mls_remove', {
        removed_user_id: userId,
        removed_device_id: deviceId,
        commit_data: result.removeCommitBytes
      }, topic)
      if (!removed) {
        return false
      }
    }

    const committed = await this.pushMlsControlEvent(scopeId, 'mls_commit', {
      commit_data: result.commitBytes
    }, topic)
    if (!committed) {
      return false
    }

    if (!result.welcomeBytes) {
      return true
    }

    return await this.pushMlsControlEvent(scopeId, 'mls_welcome', {
      recipient_id: userId,
      recipient_device_id: deviceId,
      welcome_data: result.welcomeBytes,
      key_package_ref: result.keyPackageRef
    }, topic)
  }

  private async pushMlsControlEvent(
    scopeId: string,
    event: string,
    payload: object,
    topic: string | null = null
  ): Promise<boolean> {
    if (topic) {
      return await this.client.pushTopicEventWithAck(topic, event, payload)
    }

    const kind = this.scopeKinds.get(scopeId)
    if (kind) {
      return await this.client.pushScopeEvent(kind, scopeId, event, payload)
    }

    if (scopeId.startsWith('voice:')) {
      return await this.client.pushTopicEventWithAck(scopeId, event, payload)
    }

    return false
  }

  private unrefRetryTimer(timer: ReturnType<typeof setTimeout>): void {
    const maybeTimer = timer as ReturnType<typeof setTimeout> & {
      unref?: () => void
    }

    maybeTimer.unref?.()
  }

  private async encryptForScope(
    scopeId: string,
    plaintext: string
  ): Promise<{ ciphertext: string; epoch: number }> {
    const state = this.groupStates.get(scopeId)
    if (!state) {
      throw new Error(`No local MLS state for ${scopeId}`)
    }

    const encrypted = await encryptMessage(this.cloneGroupState(state), plaintext)
    await this.setGroupState(scopeId, encrypted.newState)
    return {
      ciphertext: uint8ToBase64(encrypted.ciphertext),
      epoch: encrypted.epoch
    }
  }

  private async decryptForScope(scopeId: string, ciphertext: string): Promise<string | null> {
    const state = this.groupStates.get(scopeId)
    if (!state) {
      console.warn(`[E2EE] decryptForScope: no group state for ${scopeId}`)
      return null
    }

    const epoch = this.getGroupEpoch(scopeId)

    const decrypted = await decryptMessage(
      this.cloneGroupState(state),
      Buffer.from(ciphertext, 'base64')
    )
    if (!decrypted) {
      console.warn(`[E2EE] decryptForScope: decryption returned null for ${scopeId} at epoch=${epoch}`)
      return null
    }

    await this.setGroupState(scopeId, decrypted.newState)
    return decrypted.plaintext
  }

  private async decryptForScopeWithRecovery(
    scope: EncryptedScope,
    ciphertext: string,
    messageEpoch: number | null
  ): Promise<string | null> {
    const initialEpoch = this.getGroupEpoch(scope.id)
    const initialPlaintext = await this.decryptForScope(scope.id, ciphertext)
    if (initialPlaintext) {
      return initialPlaintext
    }

    if (initialEpoch === null) {
      return null
    }

    const shouldReplay =
      messageEpoch == null ||
      !Number.isFinite(messageEpoch) ||
      messageEpoch >= initialEpoch

    if (!shouldReplay) {
      return null
    }

    await this.replayDurableEvents(scope.id)
    return await this.decryptForScope(scope.id, ciphertext)
  }

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
  ): Promise<{
    messages: VesperMessage[]
    events: ScopeSyncEvent[]
    hasMore: boolean
  }> {
    const syncState = await this.client.fetchScopeSync({
      scopes: [
        {
          kind: scope.kind,
          id: scope.id,
          after_seq: afterSeq
        }
      ],
      limit
    })

    const entry = syncState.scopes.find((candidate) => candidate.scope_id === scope.id) ?? null

    return {
      messages: sortRawMessages(entry?.messages ?? []),
      events: this.normalizeSyncEvents(entry),
      hasMore: entry?.has_more ?? false
    }
  }

  private async processScopeMessages(
    scope: EncryptedScope,
    rawMessages: VesperMessage[],
    persist: boolean
  ): Promise<ProcessedScopeMessage[]> {
    const processed: ProcessedScopeMessage[] = []
    for (const rawMessage of sortRawMessages(rawMessages)) {
      processed.push(await this.processIncomingMessage(scope, rawMessage))
    }

    if (!persist) {
      return processed
    }

    return processed
  }

  private normalizeSyncEvents(entry: VesperScopeSyncScopeResponse | null): ScopeSyncEvent[] {
    if (!entry) {
      return []
    }

    return [...entry.events]
      .map((event) => ({
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

        if (leftSeq !== rightSeq) {
          return leftSeq - rightSeq
        }

        const timeDelta = parseTimestamp(left.insertedAt) - parseTimestamp(right.insertedAt)
        if (timeDelta !== 0) {
          return timeDelta
        }

        return left.eventType.localeCompare(right.eventType)
      })
  }

  private async applyScopeSyncDelta(
    scope: EncryptedScope,
    existing: ProcessedScopeMessage[],
    rawMessages: VesperMessage[],
    events: ScopeSyncEvent[]
  ): Promise<{
    messages: ProcessedScopeMessage[]
    events: ScopeSyncEvent[]
  }> {
    this.scopeMessages.set(scope.id, [...existing])

    const operations = [
      ...rawMessages.map((message) => ({
        kind: 'message' as const,
        roomSeq: typeof message.room_seq === 'number' ? message.room_seq : Number.MAX_SAFE_INTEGER,
        insertedAt: message.inserted_at,
        message
      })),
      ...events.map((event) => ({
        kind: 'event' as const,
        roomSeq: event.roomSeq ?? Number.MAX_SAFE_INTEGER,
        insertedAt: event.insertedAt,
        event
      }))
    ].sort((left, right) => {
      if (left.roomSeq !== right.roomSeq) {
        return left.roomSeq - right.roomSeq
      }

      const timeDelta = parseTimestamp(left.insertedAt) - parseTimestamp(right.insertedAt)
      if (timeDelta !== 0) {
        return timeDelta
      }

      return left.kind.localeCompare(right.kind)
    })

    for (const operation of operations) {
      if (operation.kind === 'message') {
        const processed = await this.processIncomingMessage(scope, operation.message)
        this.upsertScopeMessage(scope.id, processed)
        continue
      }

      await this.handleScopeEvent(scope, operation.event.eventType, operation.event.payload)
    }

    const nextMessages = sortMessages(this.scopeMessages.get(scope.id) ?? []).slice(
      -MAX_MESSAGES_PER_SCOPE
    )
    this.scopeMessages.set(scope.id, nextMessages)

    return {
      messages: nextMessages,
      events
    }
  }

  private async setGroupState(
    scopeId: string,
    state: GroupState,
    options: {
      publishGroupInfo?: boolean
    } = {}
  ): Promise<void> {
    const serializedState = serializeGroupState(state)
    const epoch = Number(state.groupContext.epoch)
    this.groupStates.set(scopeId, state)
    this.diagnostics.updateEpoch(scopeId, epoch)
    await this.storage.saveGroupState(scopeId, serializedState, epoch)
    this.notifyMembershipWaiters(scopeId, true)
    this.notifyEpochWaiters(scopeId, epoch)

    if (options.publishGroupInfo !== false) {
      // Publish GroupInfo for External Commits in the background. Failures are
      // retried so a transient network issue does not leave stale join state
      // on the server.
      void this.publishGroupInfoForScope(scopeId, state)
    }
  }

  /**
   * Publish GroupInfo + ratchet tree to the server so new members
   * can join via External Commit without any online member's help.
   */
  private async publishGroupInfoForScope(scopeId: string, state: GroupState): Promise<boolean> {
    const groupInfoData = exportGroupInfo(state)
    const ratchetTreeData = exportRatchetTree(state)
    const epoch = Number(state.groupContext.epoch)
    const pending = {
      groupInfoData,
      ratchetTreeData,
      epoch
    } satisfies PendingGroupInfoPublish

    try {
      await this.queuePendingGroupInfoPublish(scopeId, groupInfoData, ratchetTreeData, epoch)
      const result = await publishGroupInfo(
        scopeId,
        groupInfoData,
        ratchetTreeData,
        epoch,
        this.client.getHttpClient()
      )
      if (result !== 'ok') {
        this.scheduleGroupInfoPublishRetry(scopeId)
        return false
      }

      await this.clearPendingGroupInfoPublish(scopeId, pending)
      return true
    } catch (error) {
      const shouldReport = !this.groupInfoPublishRetryTimers.has(scopeId)
      this.scheduleGroupInfoPublishRetry(scopeId)
      if (shouldReport) {
        this.logIgnoredError('publish group info', error)
      }
      return false
    }
  }

  private async loadPendingControlOutbox(): Promise<void> {
    const [pendingGroupInfoPublishes, pendingExternalCommitBroadcasts] = await Promise.all([
      this.storage.loadPendingGroupInfoPublishes(),
      this.storage.loadPendingExternalCommitBroadcasts()
    ])

    for (const pending of pendingGroupInfoPublishes) {
      this.pendingGroupInfoPublishes.set(pending.groupId, {
        groupInfoData: pending.groupInfoData,
        ratchetTreeData: pending.ratchetTreeData,
        epoch: pending.epoch
      })
    }

    for (const pending of pendingExternalCommitBroadcasts) {
      this.pendingExternalCommitBroadcasts.set(pending.groupId, {
        commitData: pending.commitData,
        commitId: pending.commitId
      })
    }
  }

  private async flushPendingGroupInfoPublishes(): Promise<void> {
    for (const scopeId of [...this.pendingGroupInfoPublishes.keys()]) {
      await this.flushPendingGroupInfoPublish(scopeId)
    }
  }

  private async flushPendingGroupInfoPublish(scopeId: string): Promise<void> {
    const pending = this.pendingGroupInfoPublishes.get(scopeId)
    if (!pending) {
      return
    }

    try {
      try {
        await this.storage.savePendingGroupInfoPublish(
          scopeId,
          pending.groupInfoData,
          pending.ratchetTreeData,
          pending.epoch
        )
      } catch (error) {
        if (!this.groupInfoPublishRetryTimers.has(scopeId)) {
          this.logIgnoredError('persist group info publish', error)
        }
      }

      const result = await publishGroupInfo(
        scopeId,
        pending.groupInfoData,
        pending.ratchetTreeData,
        pending.epoch,
        this.client.getHttpClient()
      )
      if (result !== 'ok') {
        this.scheduleGroupInfoPublishRetry(scopeId)
        return
      }

      await this.clearPendingGroupInfoPublish(scopeId, pending)
    } catch (error) {
      if (!this.groupInfoPublishRetryTimers.has(scopeId)) {
        this.logIgnoredError('flush group info publish', error)
      }
      this.scheduleGroupInfoPublishRetry(scopeId)
    }
  }

  private async queuePendingGroupInfoPublish(
    scopeId: string,
    groupInfoData: Uint8Array,
    ratchetTreeData: Uint8Array | null,
    epoch: number
  ): Promise<void> {
    this.pendingGroupInfoPublishes.set(scopeId, {
      groupInfoData,
      ratchetTreeData,
      epoch
    })
    await this.storage.savePendingGroupInfoPublish(scopeId, groupInfoData, ratchetTreeData, epoch)
  }

  private scheduleGroupInfoPublishRetry(scopeId: string): void {
    if (this.groupInfoPublishRetryTimers.has(scopeId) || !this.pendingGroupInfoPublishes.has(scopeId)) {
      return
    }

    const attempt = (this.groupInfoPublishRetryAttempts.get(scopeId) ?? 0) + 1
    this.groupInfoPublishRetryAttempts.set(scopeId, attempt)
    const delayMs = Math.min(30_000, 500 * 2 ** Math.min(attempt - 1, 6))

    const timer = setTimeout(() => {
      this.groupInfoPublishRetryTimers.delete(scopeId)
      void this.flushPendingGroupInfoPublish(scopeId)
    }, delayMs)
    this.unrefRetryTimer(timer)

    this.groupInfoPublishRetryTimers.set(scopeId, timer)
  }

  private async clearPendingGroupInfoPublish(
    scopeId: string,
    expected: PendingGroupInfoPublish | null = null
  ): Promise<void> {
    const current = this.pendingGroupInfoPublishes.get(scopeId)
    if (!current) {
      return
    }

    if (expected && !samePendingGroupInfoPublish(current, expected)) {
      return
    }

    this.pendingGroupInfoPublishes.delete(scopeId)
    this.groupInfoPublishRetryAttempts.delete(scopeId)

    const timer = this.groupInfoPublishRetryTimers.get(scopeId)
    if (timer) {
      clearTimeout(timer)
      this.groupInfoPublishRetryTimers.delete(scopeId)
    }

    await this.storage.deletePendingGroupInfoPublish(scopeId)
  }

  private async queueExternalCommitBroadcast(
    scopeId: string,
    commitData: string,
    commitId: string
  ): Promise<void> {
    this.pendingExternalCommitBroadcasts.set(scopeId, {
      commitData,
      commitId
    })
    await this.storage.savePendingExternalCommitBroadcast(scopeId, commitData, commitId)
  }

  private async flushPendingExternalCommitBroadcasts(): Promise<void> {
    for (const scopeId of [...this.pendingExternalCommitBroadcasts.keys()]) {
      await this.flushPendingExternalCommitBroadcast(scopeId)
    }
  }

  private async flushPendingExternalCommitBroadcast(scopeId: string): Promise<void> {
    const pending = this.pendingExternalCommitBroadcasts.get(scopeId)
    if (!pending) {
      await this.clearPendingExternalCommitBroadcast(scopeId)
      return
    }

    try {
      await this.storage.savePendingExternalCommitBroadcast(scopeId, pending.commitData, pending.commitId)
    } catch (error) {
      if (!this.externalCommitBroadcastRetryTimers.has(scopeId)) {
        this.logIgnoredError('persist external commit broadcast', error)
      }
    }

    if (!await this.broadcastExternalCommit(scopeId, pending.commitData, pending.commitId)) {
      this.scheduleExternalCommitBroadcastRetry(scopeId)
    }
  }

  private scheduleExternalCommitBroadcastRetry(scopeId: string): void {
    if (
      this.externalCommitBroadcastRetryTimers.has(scopeId) ||
      !this.pendingExternalCommitBroadcasts.has(scopeId)
    ) {
      return
    }

    const attempt = (this.externalCommitBroadcastRetryAttempts.get(scopeId) ?? 0) + 1
    this.externalCommitBroadcastRetryAttempts.set(scopeId, attempt)
    const delayMs = Math.min(30_000, 500 * 2 ** Math.min(attempt - 1, 6))

    const timer = setTimeout(() => {
      this.externalCommitBroadcastRetryTimers.delete(scopeId)
      void this.flushPendingExternalCommitBroadcast(scopeId)
    }, delayMs)
    this.unrefRetryTimer(timer)

    this.externalCommitBroadcastRetryTimers.set(scopeId, timer)
  }

  private async clearPendingExternalCommitBroadcast(
    scopeId: string,
    expected: PendingExternalCommitBroadcast | null = null
  ): Promise<void> {
    const current = this.pendingExternalCommitBroadcasts.get(scopeId)
    if (!current) {
      return
    }

    if (expected && !samePendingExternalCommitBroadcast(current, expected)) {
      return
    }

    this.pendingExternalCommitBroadcasts.delete(scopeId)
    this.externalCommitBroadcastRetryAttempts.delete(scopeId)

    const timer = this.externalCommitBroadcastRetryTimers.get(scopeId)
    if (timer) {
      clearTimeout(timer)
      this.externalCommitBroadcastRetryTimers.delete(scopeId)
    }

    await this.storage.deletePendingExternalCommitBroadcast(scopeId)
  }

  private async computeMlsCommitId(scopeId: string, commitData: string): Promise<string> {
    return await sha256Hex(`${scopeId}\nmls_commit\n${commitData}`)
  }

  private cloneGroupState(state: GroupState): GroupState {
    return deserializeGroupState(serializeGroupState(state))
  }

  private async loadProcessedCachedMessages(scopeId: string): Promise<ProcessedScopeMessage[]> {
    const cached = await this.storage.loadCachedMessages(scopeId)

    return cached
      .map((message) => {
        const ciphertext = message.ciphertext ? Buffer.from(message.ciphertext).toString('base64') : undefined
        const plaintext = message.decryptedContent
        const content =
          plaintext != null
            ? coerceDisplayText(plaintext)
            : ciphertext
              ? DECRYPTION_PLACEHOLDER
              : ''

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
              ? {
                  id: message.senderId ?? '',
                  username: message.senderUsername
                }
              : null,
            parent_message_id: message.parentMessageId,
            inserted_at: message.insertedAt,
            content: message.decryptedContent ?? undefined,
            ciphertext,
            mls_epoch: message.mlsEpoch
          }
        } satisfies ProcessedScopeMessage
      })
      .sort((left, right) => {
        const leftSeq = typeof left.raw.room_seq === 'number' ? left.raw.room_seq : null
        const rightSeq = typeof right.raw.room_seq === 'number' ? right.raw.room_seq : null

        if (leftSeq !== null && rightSeq !== null && leftSeq !== rightSeq) {
          return leftSeq - rightSeq
        }

        const timeDelta = parseTimestamp(left.insertedAt) - parseTimestamp(right.insertedAt)
        if (timeDelta !== 0) {
          return timeDelta
        }

        return left.id.localeCompare(right.id)
      })
  }

  private mergeScopeMessages(
    cached: ProcessedScopeMessage[],
    incoming: ProcessedScopeMessage[]
  ): ProcessedScopeMessage[] {
    const merged = new Map<string, ProcessedScopeMessage>()

    for (const message of cached) {
      merged.set(message.id, message)
    }

    for (const message of incoming) {
      merged.set(message.id, message)
    }

    return sortMessages([...merged.values()])
  }

  private async channelHasExistingActivity(channelId: string): Promise<boolean> {
    const currentState = this.client.getState()

    for (const server of currentState.servers) {
      const channel = server.channels.find((entry) => entry.id === channelId)
      if (channel?.last_message_id) {
        return true
      }
    }

    await this.client.syncNow(false).catch((e) => this.logIgnoredError('background sync failed', e))

    for (const server of this.client.getState().servers) {
      const channel = server.channels.find((entry) => entry.id === channelId)
      if (channel?.last_message_id) {
        return true
      }
    }

    return false
  }

  private findChannelServerId(channelId: string): string | null {
    for (const server of this.client.getState().servers) {
      const channel = server.channels.find((entry) => entry.id === channelId)
      if (channel) {
        return channel.server_id ?? server.id
      }
    }

    return null
  }

  private async resolveChannelServerId(channelId: string): Promise<string | null> {
    const serverId = this.findChannelServerId(channelId)
    if (serverId) {
      return serverId
    }

    await this.client.syncNow(false).catch((e) => this.logIgnoredError('background sync failed', e))
    return this.findChannelServerId(channelId)
  }

  private async channelRequiresExternalJoin(channelId: string, localUserId: string): Promise<boolean> {
    const serverId = await this.resolveChannelServerId(channelId)
    if (!serverId) {
      return true
    }

    try {
      const members = await this.client.fetchServerMembers(serverId)
      if (members.some((member) => member.user_id !== localUserId)) {
        return true
      }
    } catch (error) {
      this.logIgnoredError('fetch server members', error)
      return true
    }

    const localDeviceId = this.client.deviceIdentity?.id ?? null
    return this.client.getState().devices.some((device) => {
      return device.trust_state === 'trusted' && device.client_id !== localDeviceId
    })
  }

  private findChannelOwnerId(channelId: string): string | null {
    for (const server of this.client.getState().servers) {
      if (server.channels.some((channel) => channel.id === channelId)) {
        return server.owner_id ?? null
      }
    }

    return null
  }

  private async resolveChannelOwnerId(channelId: string): Promise<string | null> {
    const ownerUserId = this.findChannelOwnerId(channelId)
    if (ownerUserId) {
      return ownerUserId
    }

    await this.client.syncNow(false).catch((e) => this.logIgnoredError('background sync failed', e))
    return this.findChannelOwnerId(channelId)
  }

  private async isChannelOwner(channelId: string, userId: string | null | undefined): Promise<boolean> {
    if (!userId) {
      return false
    }

    const ownerUserId = await this.resolveChannelOwnerId(channelId)
    return ownerUserId != null && ownerUserId === userId
  }

  private rememberJoinDeviceId(
    scope: EncryptedScope,
    userId: string,
    deviceId: string | null
  ): void {
    if (!deviceId) {
      return
    }

    this.recentJoinDeviceIds.set(`${scopeTopic(scope)}:${userId}`, deviceId)
  }

  private getPreferredJoinDeviceId(scope: EncryptedScope, userId: string): string | null {
    return this.recentJoinDeviceIds.get(`${scopeTopic(scope)}:${userId}`) ?? null
  }

  private async bootstrapDmGroupIfLeader(conversationId: string): Promise<boolean> {
    // Prevent concurrent bootstraps — the messageStore and SDK can both
    // attempt to bootstrap the same DM simultaneously, causing a
    // remove+re-add cycle that burns through epochs.
    const inflight = this.pendingBootstraps.get(conversationId)
    if (inflight) {
      return await inflight
    }

    const promise = this.doBootstrapDmGroupIfLeader(conversationId)
    this.pendingBootstraps.set(conversationId, promise)
    try {
      return await promise
    } finally {
      this.pendingBootstraps.delete(conversationId)
    }
  }

  private async doBootstrapDmGroupIfLeader(conversationId: string): Promise<boolean> {
    const session = this.client.getAuthSession()
    let conversation =
      this.client.getState().conversations.find((entry) => entry.id === conversationId) ?? null

    if (!conversation || !session) {
      await this.client.syncNow(false).catch((e) => this.logIgnoredError('background sync failed', e))
      conversation =
        this.client.getState().conversations.find((entry) => entry.id === conversationId) ?? null
    }

    if (!conversation || !session) {
      return false
    }

    const participantIds = conversation.participants
      .map((participant) => participant.user_id)
      .sort((left, right) => left.localeCompare(right))

    if (participantIds[0] !== session.user.id) {
      return false
    }

    await this.createGroup(conversationId)
    if (!this.hasGroup(conversationId)) {
      return false
    }

    // Await GroupInfo publish so the non-leader can External Commit immediately.
    const freshState = this.groupStates.get(conversationId)
    if (freshState && !await this.publishGroupInfoForScope(conversationId, freshState)) {
      return false
    }

    // The other participant will self-join via External Commit.
    return true
  }

  /** Like bootstrapDmGroupIfLeader but skips the leader check — used as the
   *  last-resort path when the leader isn't online. */
  private async bootstrapDmGroup(conversationId: string): Promise<boolean> {
    // Same inflight guard as bootstrapDmGroupIfLeader
    const inflight = this.pendingBootstraps.get(conversationId)
    if (inflight) {
      return await inflight
    }

    if (this.hasGroup(conversationId)) {
      return true
    }

    const promise = this.doBootstrapDmGroup(conversationId)
    this.pendingBootstraps.set(conversationId, promise)
    try {
      return await promise
    } finally {
      this.pendingBootstraps.delete(conversationId)
    }
  }

  private async doBootstrapDmGroup(conversationId: string): Promise<boolean> {
    const session = this.client.getAuthSession()
    let conversation =
      this.client.getState().conversations.find((entry) => entry.id === conversationId) ?? null

    if (!conversation || !session) {
      await this.client.syncNow(false).catch((e) => this.logIgnoredError('background sync failed', e))
      conversation =
        this.client.getState().conversations.find((entry) => entry.id === conversationId) ?? null
    }

    if (!conversation || !session) {
      return false
    }

    await this.createGroup(conversationId)
    if (!this.hasGroup(conversationId)) {
      return false
    }

    // Await GroupInfo publish so the other participant can External Commit immediately.
    const freshState = this.groupStates.get(conversationId)
    if (freshState && !await this.publishGroupInfoForScope(conversationId, freshState)) {
      return false
    }

    // The other participant will self-join via External Commit.
    return true
  }

  private async loadOrderedWelcomeKeyPackages(
    keyPackageRef: string | null
  ): Promise<
    Array<{
      id: number
      publicData: Uint8Array
      privateData: Uint8Array
      keyPackageRef?: string | null
    }>
  > {
    const directMatch =
      keyPackageRef != null ? await this.storage.loadKeyPackageByRef(keyPackageRef) : null
    const localPackages = await this.storage.loadKeyPackages()

    if (!keyPackageRef || localPackages.length === 0) {
      return localPackages
    }

    if (directMatch) {
      const remaining = localPackages.filter((localPackage) => localPackage.id !== directMatch.id)
      return [directMatch, ...remaining]
    }

    const matching: typeof localPackages = []
    const remaining: typeof localPackages = []

    for (const localPackage of localPackages) {
      if (localPackage.keyPackageRef === keyPackageRef) {
        matching.push(localPackage)
      } else {
        remaining.push(localPackage)
      }
    }

    return [...matching, ...remaining]
  }

  private upsertScopeMessage(scopeId: string, message: ProcessedScopeMessage): void {
    const existing = this.scopeMessages.get(scopeId) ?? []
    const filtered = existing.filter((entry) => entry.id !== message.id)
    this.scopeMessages.set(
      scopeId,
      sortMessages([...filtered, message]).slice(-MAX_MESSAGES_PER_SCOPE)
    )
  }

  private getString(payload: Record<string, unknown> | null, key: string): string | null {
    const value = payload?.[key]
    return typeof value === 'string' ? value : null
  }

  private logIgnoredError(context: string, error: unknown): void {
    if (this.client.listenerCount('error') > 0) {
      const wrapped =
        error instanceof Error
          ? new Error(`${context}: ${error.message}`, { cause: error })
          : new Error(`${context}: ${String(error)}`)
      this.client.emitError(wrapped)
    }
  }

  getGroupEpoch(scopeId: string): number | null {
    const state = this.groupStates.get(scopeId)
    if (!state) {
      return null
    }

    return Number(state.groupContext.epoch)
  }

  private async awaitGroupMembership(scopeId: string, timeoutMs: number): Promise<boolean> {
    if (await this.ensureGroupMembership(scopeId)) {
      return true
    }

    return await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        this.removeMembershipWaiter(scopeId, onMembership)
        resolve(false)
      }, timeoutMs)

      const onMembership = (ready: boolean) => {
        if (!ready) {
          return
        }

        clearTimeout(timeout)
        this.removeMembershipWaiter(scopeId, onMembership)
        resolve(true)
      }

      const waiters = this.membershipWaiters.get(scopeId) ?? new Set()
      waiters.add(onMembership)
      this.membershipWaiters.set(scopeId, waiters)

      void this.ensureGroupMembership(scopeId)
        .then((ready) => {
          if (ready) {
            onMembership(true)
          }
        })
        .catch((e) => this.logIgnoredError('ensure group membership', e))
    })
  }

  private notifyMembershipWaiters(scopeId: string, ready: boolean): void {
    const waiters = this.membershipWaiters.get(scopeId)
    if (!waiters || waiters.size === 0) {
      return
    }

    for (const waiter of [...waiters]) {
      waiter(ready)
    }
  }

  private removeMembershipWaiter(
    scopeId: string,
    waiter: (ready: boolean) => void
  ): void {
    const waiters = this.membershipWaiters.get(scopeId)
    if (!waiters) {
      return
    }

    waiters.delete(waiter)
    if (waiters.size === 0) {
      this.membershipWaiters.delete(scopeId)
    }
  }

  private notifyEpochWaiters(scopeId: string, epoch: number): void {
    const waiters = this.epochWaiters.get(scopeId)
    if (!waiters || waiters.size === 0) {
      return
    }

    for (const waiter of [...waiters]) {
      waiter(epoch)
    }
  }

  private awaitEpochAdvance(scopeId: string, timeoutMs: number): Promise<boolean> {
    const currentEpoch = this.getGroupEpoch(scopeId)
    if (currentEpoch !== null && currentEpoch > 0) {
      return Promise.resolve(true)
    }

    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        const waiters = this.epochWaiters.get(scopeId)
        if (waiters) {
          waiters.delete(onEpoch)
          if (waiters.size === 0) {
            this.epochWaiters.delete(scopeId)
          }
        }
        resolve(false)
      }, timeoutMs)

      const onEpoch = (epoch: number) => {
        if (epoch > 0) {
          clearTimeout(timeout)
          const waiters = this.epochWaiters.get(scopeId)
          if (waiters) {
            waiters.delete(onEpoch)
            if (waiters.size === 0) {
              this.epochWaiters.delete(scopeId)
            }
          }
          resolve(true)
        }
      }

      const waiters = this.epochWaiters.get(scopeId) ?? new Set()
      waiters.add(onEpoch)
      this.epochWaiters.set(scopeId, waiters)
    })
  }

  private async notifyScopeListeners(
    scope: EncryptedScope,
    event: string,
    payload: Record<string, unknown> | null,
    message?: ProcessedScopeMessage
  ): Promise<void> {
    const topic = scopeTopic(scope)
    const listeners = this.scopeListeners.get(topic)
    if (!listeners || listeners.size === 0) {
      return
    }

    for (const listener of listeners) {
      await listener({ scope, event, payload, message })
    }
  }

  private requireSession(): NonNullable<ReturnType<VesperClient['getAuthSession']>> {
    const session = this.client.getAuthSession()
    if (!session) {
      throw new Error('No active Vesper session.')
    }

    return session
  }

  private requireDeviceId(): string {
    const deviceId = this.client.deviceIdentity?.id
    if (!deviceId) {
      throw new Error('No local device identity is configured.')
    }

    return deviceId
  }

  private getScopeMessage(scopeId: string, messageId: string): ProcessedScopeMessage | null {
    const messages = this.scopeMessages.get(scopeId) ?? []
    return messages.find((message) => message.id === messageId) ?? null
  }

  private getNumber(payload: Record<string, unknown> | null, key: string): number | null {
    const value = payload?.[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }

  private cloneRawMessage(raw: VesperMessage): VesperMessage {
    return {
      ...raw,
      sender: raw.sender ? { ...raw.sender } : null,
      attachments: raw.attachments ? raw.attachments.map((attachment) => ({ ...attachment })) : [],
      reactions: raw.reactions ? raw.reactions.map((reaction) => ({ ...reaction })) : []
    }
  }

  private async resolveReactionEmoji(
    scope: EncryptedScope,
    payload: Record<string, unknown> | null
  ): Promise<string | null> {
    const emoji = this.getString(payload, 'emoji')
    if (emoji) {
      return emoji
    }

    const ciphertext = this.getString(payload, 'ciphertext')
    if (!ciphertext) {
      return null
    }

    const sentPlaintext = await this.storage.loadSentMessagePlaintext(ciphertext)
    if (sentPlaintext) {
      return sentPlaintext
    }

    return await this.decryptForScopeWithRecovery(
      scope,
      ciphertext,
      this.getNumber(payload, 'mls_epoch')
    )
  }

  private async handleReactionUpdate(
    scope: EncryptedScope,
    payload: Record<string, unknown> | null
  ): Promise<ProcessedScopeMessage | null> {
    const action = this.getString(payload, 'action')
    const messageId = this.getString(payload, 'message_id')
    const senderId = this.getString(payload, 'sender_id')
    if (!action || !messageId || !senderId) {
      return null
    }

    const existing = this.getScopeMessage(scope.id, messageId)
    if (!existing) {
      return null
    }

    const emoji = await this.resolveReactionEmoji(scope, payload)
    if (!emoji) {
      return null
    }

    const ciphertext = this.getString(payload, 'ciphertext')
    const raw = this.cloneRawMessage(existing.raw)
    const reactions = raw.reactions ? [...raw.reactions] : []
    const matchesReaction = (reaction: NonNullable<VesperMessage['reactions']>[number]): boolean =>
      reaction.sender_id === senderId &&
      ((ciphertext != null && reaction.ciphertext === ciphertext) || reaction.emoji === emoji)

    if (action === 'add') {
      if (!reactions.some(matchesReaction)) {
        reactions.push({
          id:
            this.getString(payload, 'id') ??
            `${messageId}:${senderId}:${ciphertext ?? emoji}`,
          emoji,
          sender_id: senderId,
          ciphertext,
          mls_epoch: this.getNumber(payload, 'mls_epoch'),
          inserted_at: new Date().toISOString()
        })
      }
    } else if (action === 'remove') {
      raw.reactions = reactions.filter((reaction) => !matchesReaction(reaction))
    } else {
      return null
    }

    if (action === 'add') {
      raw.reactions = reactions
    }

    const nextMessage = {
      ...existing,
      raw
    } satisfies ProcessedScopeMessage
    this.upsertScopeMessage(scope.id, nextMessage)
    return nextMessage
  }

  private async handleMessageEdited(
    scope: EncryptedScope,
    payload: Record<string, unknown> | null
  ): Promise<ProcessedScopeMessage | null> {
    const messageId = this.getString(payload, 'message_id')
    if (!messageId) {
      return null
    }

    const existing = this.getScopeMessage(scope.id, messageId)
    if (!existing) {
      return null
    }

    const raw = this.cloneRawMessage(existing.raw)
    const ciphertext = this.getString(payload, 'ciphertext')
    const content = this.getString(payload, 'content')
    raw.edited_at = this.getString(payload, 'edited_at')
    raw.mls_epoch = this.getNumber(payload, 'mls_epoch') ?? raw.mls_epoch ?? null
    raw.channel_id = this.getString(payload, 'channel_id') ?? raw.channel_id ?? null
    raw.conversation_id =
      this.getString(payload, 'conversation_id') ?? raw.conversation_id ?? null

    if (ciphertext) {
      raw.ciphertext = ciphertext
      delete raw.content
    } else if (content != null) {
      raw.content = content
      delete raw.ciphertext
    }

    const nextMessage = await this.processIncomingMessage(scope, raw, {
      allowCachedMessageDecryption: !(ciphertext && existing.raw.ciphertext !== ciphertext)
    })
    this.upsertScopeMessage(scope.id, nextMessage)
    return nextMessage
  }

  private async handleMessageDeleted(
    scope: EncryptedScope,
    payload: Record<string, unknown> | null
  ): Promise<string | null> {
    const messageId = this.getString(payload, 'message_id')
    if (!messageId) {
      return null
    }

    const existing = this.scopeMessages.get(scope.id) ?? []
    this.scopeMessages.set(
      scope.id,
      existing.filter((message) => message.id !== messageId)
    )
    await this.storage.removeCachedMessage(messageId).catch((e) => this.logIgnoredError('remove cached message', e))
    await this.storage.removeFromFtsIndex(messageId).catch((e) => this.logIgnoredError('remove FTS index', e))
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
      const encrypted = await this.encryptForScope(scope.id, emoji)
      await cacheSentMessage(this.storage, encrypted.ciphertext, emoji)
      const pushed = await this.client.pushScopeEvent(scope.kind, scope.id, event, {
        message_id: messageId,
        ciphertext: encrypted.ciphertext,
        mls_epoch: encrypted.epoch
      })
      if (!pushed) {
        throw new Error(`Failed to update reaction in ${scopeTopic(scope)}`)
      }
      return
    }

    if (!this.client.getState().canUseE2EE) {
      const pushed = await this.client.pushScopeEvent(scope.kind, scope.id, event, {
        message_id: messageId,
        emoji
      })
      if (!pushed) {
        throw new Error(`Failed to update reaction in ${scopeTopic(scope)}`)
      }
      return
    }

    throw new Error(`${scope.kind} group is still syncing`)
  }

  private clearConnections(): void {
    for (const dispose of this.scopeDisposers.values()) {
      dispose()
    }
    this.scopeDisposers.clear()
    this.joinedTopics.clear()
  }
}

export function createEncryptedChat(client: VesperClient): VesperEncryptedChat {
  return new VesperEncryptedChat(client)
}
