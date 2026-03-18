import {
  ackPendingWelcome,
  fetchKeyPackage,
  fetchMlsEvents,
  fetchPendingWelcomes,
  uint8ToBase64
} from '../api/crypto.js'
import type { VesperConversation, VesperMessage } from '../api/chat.js'
import {
  addMemberToGroup,
  buildClientCredentialIdentity,
  createKeyPackageBatch,
  createMLSGroup,
  decodePayload,
  decodeKeyPackageBytes,
  decryptMessage,
  deserializeGroupState,
  deserializePrivatePackage,
  deriveVoiceKey,
  encodePayload,
  encryptMessage,
  findMemberLeafIndex,
  getDisplayText,
  getGroupLeafIdentities,
  getGroupMemberIdentities,
  groupHasMember,
  initCipherSuite,
  processCommitMessage,
  processWelcome,
  removeMemberFromGroup,
  serializeGroupState
} from '../crypto/index.js'
import type { MessagePayload } from '../crypto/payload.js'
import {
  cacheMessage,
  consumeKeyPackage,
  deleteGroupState,
  indexDecryptedMessage,
  loadCachedMessageDecryption,
  loadCachedMessages,
  loadGroupState,
  loadGroupSyncCursor,
  loadKeyPackageByRef,
  loadKeyPackages,
  loadSentMessagePlaintext,
  removeFromFtsIndex,
  saveCachedMessageDecryption,
  saveGroupState,
  saveGroupSyncCursor,
  saveSentMessagePlaintext
} from '../crypto/storage.js'
import type { VesperClient } from './index.js'

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
  private readonly groupStates = new Map<string, GroupState>()
  private readonly joinedTopics = new Set<string>()
  private readonly scopeDisposers = new Map<string, () => void>()
  private readonly scopeWatchRefs = new Map<string, number>()
  private readonly scopeListeners = new Map<string, Set<ScopeListener>>()
  private readonly pendingCommits = new Map<string, string[]>()
  private readonly pendingJoinRequests = new Map<string, Promise<void>>()
  private readonly pendingEvictionRequests = new Map<string, Promise<void>>()
  private readonly recentEvictionClaims = new Map<string, number>()
  private readonly evictionLocks = new Map<string, Promise<void>>()
  private readonly scopeMessages = new Map<string, ProcessedScopeMessage[]>()
  private readonly membershipWaiters = new Map<string, Set<(ready: boolean) => void>>()
  private readonly welcomeAppliedAtByScope = new Map<string, number>()

  constructor(client: VesperClient) {
    this.client = client

    this.client.on('disconnected', () => {
      this.clearConnections()
    })
    this.client.on('state', (state) => {
      if (state.status === 'signed_out') {
        this.reset()
      }
    })
  }

  reset(): void {
    this.clearConnections()
    this.groupStates.clear()
    this.pendingCommits.clear()
    this.pendingJoinRequests.clear()
    this.pendingEvictionRequests.clear()
    this.recentEvictionClaims.clear()
    this.evictionLocks.clear()
    this.scopeMessages.clear()
    this.welcomeAppliedAtByScope.clear()

    for (const waiters of this.membershipWaiters.values()) {
      for (const waiter of waiters) {
        waiter(false)
      }
    }
    this.membershipWaiters.clear()
    this.scopeListeners.clear()
    this.scopeWatchRefs.clear()
  }

  async watchScope(
    scope: EncryptedScope,
    listener?: ScopeListener
  ): Promise<() => void> {
    const topic = scopeTopic(scope)
    this.scopeWatchRefs.set(topic, (this.scopeWatchRefs.get(topic) ?? 0) + 1)

    if (listener) {
      const listeners = this.scopeListeners.get(topic) ?? new Set<ScopeListener>()
      listeners.add(listener)
      this.scopeListeners.set(topic, listeners)
    }

    if (!this.joinedTopics.has(topic)) {
      const dispose = await this.client.watchScope(scope.kind, scope.id, async ({ event, payload }) => {
        const nextEvent = await this.processScopeEvent(scope, event, normalizePayload(payload))
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
  }

  async processScopeEvent(
    scope: EncryptedScope,
    event: string,
    payload: Record<string, unknown> | null
  ): Promise<EncryptedScopeWatchEvent | null> {
    return await this.handleScopeEvent(scope, event, payload)
  }

  getMessages(scopeId: string): ProcessedScopeMessage[] {
    return [...(this.scopeMessages.get(scopeId) ?? [])]
  }

  hasGroup(scopeId: string): boolean {
    return this.groupStates.has(scopeId)
  }

  getMemberCount(scopeId: string): number {
    const state = this.groupStates.get(scopeId)
    if (!state) {
      return 0
    }

    return getGroupLeafIdentities(state).length
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
    const startedAt = performance.now()
    const limit = options.limit ?? 50

    await this.ensureGroupMembership(scope.id)
    await this.replayDurableEvents(scope.id)

    const cached = await this.loadProcessedCachedMessages(scope.id)
    const existing = this.scopeMessages.get(scope.id) ?? cached
    const afterSeq = highestRoomSeq(existing)

    const rawMessages =
      afterSeq == null
        ? await this.fetchScopeMessages(scope, limit)
        : await this.fetchIncrementalScopeMessages(scope, limit, afterSeq)

    const processed =
      rawMessages.length > 0
        ? await this.processScopeMessages(scope, rawMessages, true)
        : []

    const merged = this.mergeScopeMessages(existing, processed).slice(-MAX_MESSAGES_PER_SCOPE)
    this.scopeMessages.set(scope.id, merged)

    return {
      durationMs: performance.now() - startedAt,
      messages: merged
    }
  }

  async ensureScopeReady(scope: EncryptedScope, allowCreate = false): Promise<boolean> {
    if (scope.kind === 'channel') {
      return await this.ensureChannelGroupReady(scope.id, allowCreate)
    }

    return await this.ensureDmGroupReady(scope.id, allowCreate)
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
    const release = await this.watchScope(scope)

    try {
      const ready = await this.ensureScopeReady(scope, true)
      if (!ready) {
        throw new Error(`${scope.kind} group is still syncing`)
      }

      const plaintext = encodePayload(payload)
      const encrypted = await this.encryptForScope(scope.id, plaintext)
      await saveSentMessagePlaintext(encrypted.ciphertext, plaintext)

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

      const pushed = await this.client.pushScopeEvent(
        scope.kind,
        scope.id,
        'new_message',
        messagePayload
      )
      if (!pushed) {
        throw new Error(`Failed to send message to ${scopeTopic(scope)}`)
      }
    } finally {
      release()
    }
  }

  async encryptOpaque(
    scope: EncryptedScope,
    plaintext: string
  ): Promise<{ ciphertext: string; epoch: number }> {
    const ready = await this.ensureGroupMembership(scope.id)
    if (!ready) {
      throw new Error(`${scope.kind} group is still syncing`)
    }

    return await this.encryptForScope(scope.id, plaintext)
  }

  async decryptOpaque(
    scope: EncryptedScope,
    ciphertext: string,
    messageEpoch: number | null = null
  ): Promise<string | null> {
    return await this.decryptForScopeWithRecovery(scope, ciphertext, messageEpoch)
  }

  async decryptOpaqueBatch(
    scope: EncryptedScope,
    items: Array<{ ciphertext: string; messageEpoch?: number | null }>
  ): Promise<Array<string | null>> {
    return await Promise.all(
      items.map((item) =>
        this.decryptForScopeWithRecovery(scope, item.ciphertext, item.messageEpoch ?? null)
      )
    )
  }

  async ensureMembership(scope: EncryptedScope): Promise<boolean> {
    return await this.ensureGroupMembership(scope.id)
  }

  async ensureScopeState(scopeId: string): Promise<boolean> {
    return await this.ensureGroupMembership(scopeId)
  }

  async replayScopeEvents(scopeId: string): Promise<void> {
    await this.replayDurableEvents(scopeId)
  }

  async requestJoin(scope: EncryptedScope): Promise<void> {
    await this.requestMlsJoin(scope)
  }

  async requestJoinAll(scope: EncryptedScope): Promise<void> {
    const pushed = await this.client.pushScopeEvent(scope.kind, scope.id, 'mls_request_join_all', {})
    if (!pushed) {
      throw new Error(`Failed to request join-all for ${scopeTopic(scope)}`)
    }
  }

  async requestResync(
    scope: EncryptedScope,
    options: {
      lastKnownEpoch?: number | null
      reason?: string | null
      username?: string | null
    } = {}
  ): Promise<void> {
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
  }

  async createScopeGroup(scope: EncryptedScope): Promise<boolean> {
    await this.createGroup(scope.id)
    return this.hasGroup(scope.id)
  }

  async createScopeState(scopeId: string): Promise<boolean> {
    await this.createGroup(scopeId)
    return this.hasGroup(scopeId)
  }

  async resetScope(scopeId: string): Promise<void> {
    this.groupStates.delete(scopeId)
    this.welcomeAppliedAtByScope.delete(scopeId)
    await deleteGroupState(scopeId)
  }

  async applyScopeCommit(scopeId: string, commitData: string | null): Promise<boolean> {
    return await this.handleCommit(scopeId, commitData)
  }

  async applyScopeWelcome(
    scopeId: string,
    welcomeData: string | null,
    keyPackageRef: string | null = null
  ): Promise<boolean> {
    return await this.handleWelcome(scopeId, welcomeData, keyPackageRef)
  }

  async handleScopeJoinRequest(
    scopeId: string,
    userId: string,
    deviceId: string | null = null
  ): Promise<{
    commitBytes: string
    welcomeBytes: string | null
    keyPackageRef: string
  } | null> {
    return await this.handleJoinRequest(scopeId, userId, deviceId)
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
    return await this.handleResyncRequest(scopeId, userId, deviceId)
  }

  async deriveScopeVoiceKey(scopeId: string): Promise<Uint8Array | null> {
    const state = this.groupStates.get(scopeId)
    if (!state) {
      return null
    }

    await initCipherSuite()
    return await deriveVoiceKey(state)
  }

  async handleExternalJoinRequest(
    scope: EncryptedScope,
    userId: string,
    deviceId: string | null = null
  ): Promise<{
    commitBytes: string
    welcomeBytes: string | null
    keyPackageRef: string
  } | null> {
    return await this.handleJoinRequest(scope.id, userId, deviceId)
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
    return await this.handleResyncRequest(scope.id, userId, deviceId)
  }

  async handleExternalEvictionRequest(
    scope: EncryptedScope,
    payload: Record<string, unknown> | null
  ): Promise<boolean> {
    return await this.handleEvictionRequestEvent(scope, payload)
  }

  async editText(scope: EncryptedScope, messageId: string, text: string): Promise<void> {
    const ready = await this.ensureScopeReady(scope)
    if (!ready) {
      throw new Error(`${scope.kind} group is still syncing`)
    }

    const encrypted = await this.encryptForScope(
      scope.id,
      encodePayload({ v: 1, type: 'text', text })
    )
    await saveSentMessagePlaintext(encrypted.ciphertext, text)

    const pushed = await this.client.pushScopeEvent(scope.kind, scope.id, 'edit_message', {
      message_id: messageId,
      ciphertext: encrypted.ciphertext,
      mls_epoch: encrypted.epoch
    })
    if (!pushed) {
      throw new Error(`Failed to edit message in ${scopeTopic(scope)}`)
    }
  }

  async deleteMessage(scope: EncryptedScope, messageId: string): Promise<void> {
    const pushed = await this.client.pushScopeEvent(scope.kind, scope.id, 'delete_message', {
      message_id: messageId
    })
    if (!pushed) {
      throw new Error(`Failed to delete message in ${scopeTopic(scope)}`)
    }
  }

  async addReaction(scope: EncryptedScope, messageId: string, emoji: string): Promise<void> {
    await this.pushReaction(scope, 'add_reaction', messageId, emoji)
  }

  async removeReaction(scope: EncryptedScope, messageId: string, emoji: string): Promise<void> {
    await this.pushReaction(scope, 'remove_reaction', messageId, emoji)
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

    if (event === 'mls_request_join_all' && scope.kind === 'channel' && !this.hasGroup(scope.id)) {
      await this.requestMlsJoin(scope)
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
          await this.handleCommit(scope.id, this.getString(payload, 'commit_data'))
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
            await ackPendingWelcome(welcomeId).catch(() => {})
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
      this.groupStates.delete(scope.id)
      this.welcomeAppliedAtByScope.delete(scope.id)
      await deleteGroupState(scope.id)
      return
    }

    if (!isLocalSender) {
      await this.handleCommit(scope.id, this.getString(payload, 'commit_data'))
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

        const removed = await removeMemberFromGroup(state, leafIndex)
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

  private async handleJoinRequestEvent(
    scope: EncryptedScope,
    payload: Record<string, unknown> | null
  ): Promise<void> {
    if (!this.hasGroup(scope.id)) {
      return
    }

    const requesterId = this.getString(payload, 'user_id')
    const requesterDeviceId = this.getString(payload, 'device_id')
    const localUserId = this.client.getAuthSession()?.user.id ?? this.client.getState().user?.id
    const localDeviceId = this.client.deviceIdentity?.id ?? null

    if (!requesterId) {
      return
    }

    if (requesterId === localUserId && requesterDeviceId === localDeviceId) {
      return
    }

    const response = await this.handleJoinRequest(scope.id, requesterId, requesterDeviceId)
    if (!response) {
      return
    }

    await this.client.pushScopeEvent(scope.kind, scope.id, 'mls_commit', {
      commit_data: response.commitBytes
    })

    if (response.welcomeBytes) {
      await this.client.pushScopeEvent(scope.kind, scope.id, 'mls_welcome', {
        recipient_id: requesterId,
        recipient_device_id: requesterDeviceId,
        welcome_data: response.welcomeBytes,
        key_package_ref: response.keyPackageRef
      })
    }
  }

  private async ensureChannelGroupReady(channelId: string, allowCreate = false): Promise<boolean> {
    if (await this.ensureGroupMembership(channelId)) {
      return true
    }

    const scope: EncryptedScope = { kind: 'channel', id: channelId }
    await this.requestMlsJoin(scope)
    if (await this.awaitGroupMembership(channelId, JOIN_WAIT_MS)) {
      return true
    }

    if (!allowCreate) {
      return this.hasGroup(channelId)
    }

    if (await this.channelHasExistingActivity(channelId)) {
      return false
    }

    await this.createGroup(channelId)
    if (!this.hasGroup(channelId)) {
      return false
    }

    await this.client.pushScopeEvent(scope.kind, scope.id, 'mls_request_join_all', {})
    return true
  }

  private async ensureDmGroupReady(conversationId: string, allowForce = false): Promise<boolean> {
    if (await this.ensureGroupMembership(conversationId)) {
      return true
    }

    if (await this.bootstrapDmGroupIfLeader(conversationId)) {
      return true
    }

    const scope: EncryptedScope = { kind: 'dm', id: conversationId }
    await this.requestMlsJoin(scope)
    if (await this.awaitGroupMembership(conversationId, JOIN_WAIT_MS)) {
      return true
    }

    if (!allowForce) {
      return this.hasGroup(conversationId)
    }

    await this.createGroup(conversationId)
    return this.hasGroup(conversationId)
  }

  private async ensureGroupMembership(scopeId: string): Promise<boolean> {
    if (this.hasGroup(scopeId)) {
      await this.processPendingCommits(scopeId)
      return true
    }

    const persisted = await loadGroupState(scopeId)
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

    const welcomes = await fetchPendingWelcomes(scopeId)
    for (const welcome of welcomes) {
      const processed = await this.handleWelcome(
        scopeId,
        uint8ToBase64(welcome.welcome_data),
        welcome.key_package_ref ?? null
      )

      if (processed) {
        await ackPendingWelcome(welcome.id).catch(() => {})
        this.welcomeAppliedAtByScope.set(scopeId, Date.now())
        this.notifyMembershipWaiters(scopeId, true)
        return true
      }
    }

    return false
  }

  private async replayDurableEvents(scopeId: string): Promise<void> {
    const session = this.client.getAuthSession()
    const localDeviceId = this.client.deviceIdentity?.id ?? null
    if (!session || !localDeviceId) {
      return
    }

    const cursor = await loadGroupSyncCursor(scopeId)
    const events = await fetchMlsEvents(scopeId, cursor)
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
        await this.handleCommit(scopeId, event.payload.commit_data)
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
          this.groupStates.delete(scopeId)
          await deleteGroupState(scopeId)
        }
      }

      latestSeq = Math.max(latestSeq, event.seq)
    }

    if (latestSeq > cursor) {
      await saveGroupSyncCursor(scopeId, latestSeq)
    }
  }

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

      const [sentPlaintext, cachedMessagePlaintext] = await Promise.all([
        loadSentMessagePlaintext(ciphertext),
        loadCachedMessageDecryption(rawMessage.id)
      ])
      const cachedPlaintext = sentPlaintext ?? cachedMessagePlaintext
      const decrypted =
        cachedPlaintext ??
        (await this.decryptForScopeWithRecovery(scope, ciphertext, rawMessage.mls_epoch ?? null))

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
      persistenceWork.push(saveCachedMessageDecryption(rawMessage.id, plaintext))
    }

    persistenceWork.push(
      cacheMessage({
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
      persistenceWork.push(indexDecryptedMessage(rawMessage.id, scopeId, content))
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

    await initCipherSuite()
    await this.client.replenishKeyPackages()

    const session = this.requireSession()
    const localDeviceId = this.requireDeviceId()
    const localPackages = await loadKeyPackages()
    let publicPackage: Awaited<ReturnType<typeof createKeyPackageBatch>>[number]['publicPackage']
    let privatePackage: Awaited<ReturnType<typeof createKeyPackageBatch>>[number]['privatePackage']

    if (localPackages.length > 0) {
      const localPackage = localPackages[0]
      await consumeKeyPackage(localPackage.id)
      publicPackage = decodeKeyPackageBytes(new Uint8Array(localPackage.publicData))
      privatePackage = deserializePrivatePackage(new Uint8Array(localPackage.privateData))
    } else {
      const pairs = await createKeyPackageBatch(
        buildClientCredentialIdentity(session.user.id, localDeviceId),
        1
      )
      publicPackage = pairs[0].publicPackage
      privatePackage = pairs[0].privatePackage
    }

    const state = await createMLSGroup(scopeId, publicPackage, privatePackage)
    await this.setGroupState(scopeId, state)
    await this.client.replenishKeyPackages()
  }

  private async handleJoinRequest(
    scopeId: string,
    userId: string,
    deviceId: string | null
  ): Promise<{
    commitBytes: string
    welcomeBytes: string | null
    keyPackageRef: string
  } | null> {
    const state = this.groupStates.get(scopeId)
    if (!state) {
      return null
    }

    await initCipherSuite()
    const keyPackageBytes = await fetchKeyPackage(userId, deviceId ?? undefined)
    if (!keyPackageBytes) {
      return null
    }

    const memberKeyPackage = decodeKeyPackageBytes(keyPackageBytes)
    const credential = memberKeyPackage.leafNode.credential
    const requestedIdentity =
      credential.credentialType === 'basic'
        ? new TextDecoder().decode(credential.identity)
        : null

    if (
      requestedIdentity &&
      (getGroupLeafIdentities(state).includes(requestedIdentity) ||
        groupHasMember(state, requestedIdentity))
    ) {
      return null
    }

    const result = await addMemberToGroup(state, memberKeyPackage)
    await this.setGroupState(scopeId, result.newState)

    return {
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

    await initCipherSuite()
    const orderedPackages = await this.loadOrderedWelcomeKeyPackages(keyPackageRef)
    if (orderedPackages.length === 0) {
      return false
    }

    for (const localPackage of orderedPackages) {
      try {
        const publicPackage = decodeKeyPackageBytes(new Uint8Array(localPackage.publicData))
        const privatePackage = deserializePrivatePackage(new Uint8Array(localPackage.privateData))
        const state = await processWelcome(
          Buffer.from(welcomeData, 'base64'),
          publicPackage,
          privatePackage
        )

        await this.setGroupState(scopeId, state)
        this.welcomeAppliedAtByScope.set(scopeId, Date.now())
        await consumeKeyPackage(localPackage.id)
        await this.processPendingCommits(scopeId)
        await this.client.replenishKeyPackages()
        return true
      } catch {
        continue
      }
    }

    return false
  }

  private async handleCommit(scopeId: string, commitData: string | null): Promise<boolean> {
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
      const nextState = await processCommitMessage(currentState, Buffer.from(commitData, 'base64'))
      await this.setGroupState(scopeId, nextState)
      this.notifyMembershipWaiters(scopeId, true)
      return true
    } catch {
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

      const keyPackageBytes = await fetchKeyPackage(userId, deviceId ?? undefined)
      if (!keyPackageBytes) {
        return null
      }

      const memberKeyPackage = decodeKeyPackageBytes(keyPackageBytes)
      const requestedCredential = memberKeyPackage.leafNode.credential
      const requestedIdentity =
        requestedCredential.credentialType === 'basic'
          ? new TextDecoder().decode(requestedCredential.identity)
          : null

      let workingState = state
      let removeCommitBytes: string | null = null

      const existingLeafIndex =
        requestedIdentity && groupHasMember(workingState, requestedIdentity)
          ? findMemberLeafIndex(workingState, requestedIdentity)
          : null

      if (existingLeafIndex !== null) {
        const removed = await removeMemberFromGroup(workingState, existingLeafIndex)
        workingState = removed.newState
        removeCommitBytes = uint8ToBase64(removed.commitBytes)
      }

      if (requestedIdentity && groupHasMember(workingState, requestedIdentity)) {
        return null
      }

      const added = await addMemberToGroup(workingState, memberKeyPackage)
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

    this.pendingCommits.set(scopeId, [])
    for (const commitData of pending) {
      await this.handleCommit(scopeId, commitData)
    }
  }

  private async encryptForScope(
    scopeId: string,
    plaintext: string
  ): Promise<{ ciphertext: string; epoch: number }> {
    const state = this.groupStates.get(scopeId)
    if (!state) {
      throw new Error(`No local MLS state for ${scopeId}`)
    }

    const encrypted = await encryptMessage(state, plaintext)
    await this.setGroupState(scopeId, encrypted.newState)

    return {
      ciphertext: uint8ToBase64(encrypted.ciphertext),
      epoch: encrypted.epoch
    }
  }

  private async decryptForScope(scopeId: string, ciphertext: string): Promise<string | null> {
    const state = this.groupStates.get(scopeId)
    if (!state) {
      return null
    }

    const decrypted = await decryptMessage(state, Buffer.from(ciphertext, 'base64'))
    if (!decrypted) {
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

  private async fetchIncrementalScopeMessages(
    scope: EncryptedScope,
    limit: number,
    afterSeq: number
  ): Promise<VesperMessage[]> {
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

    return sortRawMessages(syncState.scopes.find((entry) => entry.scope_id === scope.id)?.messages ?? [])
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

  private async setGroupState(scopeId: string, state: GroupState): Promise<void> {
    const serializedState = serializeGroupState(state)
    const epoch = Number(state.groupContext.epoch)
    this.groupStates.set(scopeId, state)
    await saveGroupState(scopeId, serializedState, epoch)
    this.notifyMembershipWaiters(scopeId, true)
  }

  private async loadProcessedCachedMessages(scopeId: string): Promise<ProcessedScopeMessage[]> {
    const cached = await loadCachedMessages(scopeId)

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

    await this.client.syncNow(false).catch(() => {})

    for (const server of this.client.getState().servers) {
      const channel = server.channels.find((entry) => entry.id === channelId)
      if (channel?.last_message_id) {
        return true
      }
    }

    return false
  }

  private async bootstrapDmGroupIfLeader(conversationId: string): Promise<boolean> {
    const session = this.client.getAuthSession()
    let conversation =
      this.client.getState().conversations.find((entry) => entry.id === conversationId) ?? null

    if (!conversation || !session) {
      await this.client.syncNow(false).catch(() => {})
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

    const scope: EncryptedScope = { kind: 'dm', id: conversationId }
    for (const participant of conversation.participants) {
      if (participant.user_id === session.user.id) {
        continue
      }

      const response = await this.handleJoinRequest(conversationId, participant.user_id, null)
      if (!response) {
        continue
      }

      await this.client.pushScopeEvent(scope.kind, scope.id, 'mls_commit', {
        commit_data: response.commitBytes
      })

      if (response.welcomeBytes) {
        await this.client.pushScopeEvent(scope.kind, scope.id, 'mls_welcome', {
          recipient_id: participant.user_id,
          welcome_data: response.welcomeBytes,
          key_package_ref: response.keyPackageRef
        })
      }
    }

    return this.hasGroup(conversationId)
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
      keyPackageRef != null ? await loadKeyPackageByRef(keyPackageRef) : null
    const localPackages = await loadKeyPackages()

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

  private getGroupEpoch(scopeId: string): number | null {
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
        .catch(() => {})
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

    const sentPlaintext = await loadSentMessagePlaintext(ciphertext)
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

    const nextMessage = await this.processIncomingMessage(scope, raw)
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
    await removeFromFtsIndex(messageId).catch(() => {})
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
      const pushed = await this.client.pushScopeEvent(scope.kind, scope.id, event, {
        message_id: messageId,
        ciphertext: encrypted.ciphertext,
        mls_epoch: encrypted.epoch
      })
      if (!pushed) {
        throw new Error(`Failed to update reaction in ${scopeTopic(scope)}`)
      }
      await saveSentMessagePlaintext(encrypted.ciphertext, emoji)
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
    this.scopeWatchRefs.clear()
  }
}

export function createEncryptedChat(client: VesperClient): VesperEncryptedChat {
  return new VesperEncryptedChat(client)
}
