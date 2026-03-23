import { EventEmitter } from 'node:events'

import {
  ackPendingWelcome,
  fetchGroupInfo,
  fetchKeyPackage,
  fetchMlsEvents,
  fetchPendingWelcomes,
  publishGroupInfo,
  uint8ToBase64
} from '../api/crypto.js'
import {
  addMemberToGroup,
  buildClientCredentialIdentity,
  createMLSGroup,
  decodeKeyPackageBytes,
  decodePayload,
  decryptMessage,
  deserializeGroupState,
  encodePayload,
  encryptMessage,
  exportGroupInfo,
  exportRatchetTree,
  getDisplayText,
  getGroupLeafIdentities,
  groupHasMember,
  initCipherSuite,
  joinViaExternalCommit,
  findMemberLeafIndex,
  processCommitMessage,
  processWelcome,
  removeMemberFromGroup,
  serializeGroupState
} from '../crypto/index.js'
import {
  type CryptoStorageRuntime
} from '../storage/index.js'
import type { VesperMessage } from '../api/chat.js'
import type {
  EncryptedScope,
  ProcessedScopeMessage,
  ScopeSyncResult
} from '../client/encryptedChat.js'
import { TestingDeviceHarness } from './deviceHarness.js'

export type { EncryptedScope, ProcessedScopeMessage, ScopeSyncResult }

const JOIN_WAIT_MS = 2_500
const EVICTION_REQUEST_COOLDOWN_MS = 3_000
const MAX_MESSAGES_PER_SCOPE = 200
const DECRYPTION_PLACEHOLDER = '[Encrypted message unavailable]'

export interface ScopeCheckpoint {
  epoch: number
  state: Uint8Array
}

type GroupState = Awaited<ReturnType<typeof createMLSGroup>>

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

function coerceDisplayText(plaintext: string): string {
  try {
    return getDisplayText(decodePayload(plaintext))
  } catch {
    return plaintext
  }
}

export class SdkChatHarness extends EventEmitter {
  readonly device: TestingDeviceHarness
  private readonly storage: CryptoStorageRuntime

  private readonly groupStates = new Map<string, GroupState>()
  private readonly groupStateSnapshots = new Map<
    string,
    { state: Uint8Array; epoch: number }
  >()
  private readonly joinedTopics = new Set<string>()
  private readonly pendingCommits = new Map<string, string[]>()
  private readonly pendingJoinRequests = new Map<string, Promise<void>>()
  private readonly pendingEvictionRequests = new Map<string, Promise<void>>()
  private readonly recentEvictionClaims = new Map<string, number>()
  private readonly evictionLocks = new Map<string, Promise<void>>()
  private readonly scopeMessages = new Map<string, ProcessedScopeMessage[]>()
  private readonly membershipWaiters = new Map<
    string,
    Set<(ready: boolean) => void>
  >()

  constructor(device: TestingDeviceHarness) {
    super()
    this.device = device
    this.storage = device.storageRuntime
  }

  private async withDeviceContext<T>(operation: () => Promise<T>): Promise<T> {
    return await this.device.run(operation)
  }

  async watchScope(scope: EncryptedScope): Promise<void> {
    const topic = scopeTopic(scope)
    if (this.joinedTopics.has(topic)) {
      return
    }

    await this.device.joinTopicWithAck(topic, async (event, payload) => {
      await this.handleScopeEvent(scope, event, payload as Record<string, unknown> | null)
    })

    this.joinedTopics.add(topic)
  }

  disconnect(): void {
    this.device.disconnect()
    this.joinedTopics.clear()
    for (const waiters of this.membershipWaiters.values()) {
      for (const waiter of waiters) {
        waiter(false)
      }
    }
    this.membershipWaiters.clear()
  }

  async ensureScopeReady(scope: EncryptedScope, allowCreate = false): Promise<boolean> {
    return await this.device.run(async () => {
      if (scope.kind === 'channel') {
        return await this.ensureChannelGroupReady(scope.id, allowCreate)
      }

      return await this.ensureDmGroupReady(scope.id, allowCreate)
    })
  }

  async sendText(scope: EncryptedScope, text: string): Promise<void> {
    await this.watchScope(scope)

    const ready = await this.ensureScopeReady(scope, true)
    if (!ready) {
      throw new Error(`${scope.kind} group is still syncing`)
    }

    await this.device.run(async () => {
      await this.syncLatestMessageState(scope)

      const encrypted = await this.encryptForScope(
        scope.id,
        encodePayload({ v: 1, type: 'text', text })
      )
      await this.storage.saveSentMessagePlaintext(encrypted.ciphertext, text)

      const pushed = await this.device.pushToTopicWithAck(scopeTopic(scope), 'new_message', {
        ciphertext: encrypted.ciphertext,
        mls_epoch: encrypted.epoch
      })

      if (!pushed) {
        throw new Error(`Failed to send message to ${scopeTopic(scope)}`)
      }
    })
  }

  async createScopeGroup(scope: EncryptedScope): Promise<void> {
    await this.device.run(async () => {
      await this.createGroup(scope.id)
      const state = this.groupStates.get(scope.id)
      if (state && !await this.publishGroupInfoForScope(scope.id, state)) {
        throw new Error(`Failed to publish GroupInfo for ${scope.id}`)
      }
    })
  }

  async generateJoinPackage(
    scope: EncryptedScope,
    userId: string,
    deviceId: string | null
  ): Promise<{
    commitBytes: string
    welcomeBytes: string | null
    keyPackageRef: string
  } | null> {
    return await this.device.run(async () => {
      return await this.handleJoinRequest(scope.id, userId, deviceId)
    })
  }

  async applyWelcomePackage(
    scope: EncryptedScope,
    welcomeData: string | null,
    keyPackageRef: string | null
  ): Promise<boolean> {
    return await this.device.run(async () => {
      return await this.handleWelcome(scope.id, welcomeData, keyPackageRef)
    })
  }

  async applyCommitPacket(
    scope: EncryptedScope,
    commitData: string | null
  ): Promise<boolean> {
    return await this.device.run(async () => {
      return await this.handleCommit(scope.id, commitData)
    })
  }

  async captureScopeCheckpoint(scopeId: string): Promise<ScopeCheckpoint | null> {
    return await this.device.run(async () => {
      return this.snapshotGroupState(scopeId)
    })
  }

  async restoreScopeCheckpoint(
    scopeId: string,
    checkpoint: ScopeCheckpoint | null
  ): Promise<void> {
    await this.device.run(async () => {
      if (checkpoint) {
        await this.restoreGroupState(scopeId, checkpoint)
        return
      }

      this.groupStates.delete(scopeId)
      this.groupStateSnapshots.delete(scopeId)
      await this.storage.deleteGroupState(scopeId)
    })
  }

  async syncScope(
    scope: EncryptedScope,
    options: {
      limit?: number
    } = {}
  ): Promise<ScopeSyncResult> {
    const startedAt = performance.now()
    const limit = options.limit ?? 50
    const messages = await this.withDeviceContext(async () => {
      const canUseHotPath = limit === 1 && this.hasGroup(scope.id)
      if (canUseHotPath) {
        const rawMessages = await this.fetchScopeMessages(scope, {
          limit,
          lean: true
        })
        let processed = await this.processScopeMessages(scope, rawMessages, {
          persist: false,
          mutateState: false
        })

        if (this.shouldReplayForScope(scope.id, rawMessages, processed, true)) {
          await this.ensureGroupMembership(scope.id)
          await this.replayDurableEvents(scope)
          processed = await this.processScopeMessages(scope, rawMessages, {
            persist: false,
            mutateState: false
          })
        }

        const sorted = sortMessages(processed).slice(-MAX_MESSAGES_PER_SCOPE)
        this.scopeMessages.set(scope.id, sorted)
        return sorted
      }

      await this.ensureGroupMembership(scope.id)
      await this.replayDurableEvents(scope)

      const cached = await this.loadProcessedCachedMessages(scope.id)
      const existing = this.mergeScopeMessages(
        cached,
        this.scopeMessages.get(scope.id) ?? []
      )
      const resumeAfterSeq = this.resumeAfterRoomSeq(existing)
      const pageSize = Math.max(limit, 80)
      const rawMessages =
        cached.length === 0
          ? await this.fetchScopeMessages(scope, {
              limit: pageSize,
              lean: true
            })
          : resumeAfterSeq !== null
          ? await this.fetchIncrementalScopeMessages(scope, pageSize, 1, resumeAfterSeq)
          : await this.fetchScopeMessages(scope, {
              limit: pageSize,
              lean: true
            })
      const processed =
        rawMessages.length > 0
          ? await this.processScopeMessages(scope, rawMessages, {
              persist: true,
              mutateState: true
            })
          : []

      const sorted = this.mergeScopeMessages(existing, processed).slice(-MAX_MESSAGES_PER_SCOPE)
      this.scopeMessages.set(scope.id, sorted)
      return sorted
    })

    return {
      durationMs: performance.now() - startedAt,
      messages,
      events: [],
      hasMore: false
    }
  }

  async syncScopePaginated(
    scope: EncryptedScope,
    options: {
      maxPages?: number
      pageSize?: number
    } = {}
  ): Promise<ScopeSyncResult> {
    const startedAt = performance.now()
    const pageSize = Math.max(1, options.pageSize ?? 80)
    const maxPages = Math.max(1, options.maxPages ?? 1)

    const messages = await this.device.run(async () => {
      await this.ensureGroupMembership(scope.id)
      await this.replayDurableEvents(scope)

      const cached = await this.loadProcessedCachedMessages(scope.id)
      const resumeAfterSeq = this.resumeAfterRoomSeq(cached)

      const rawMessages =
        resumeAfterSeq !== null
          ? await this.fetchIncrementalScopeMessages(
              scope,
              pageSize,
              maxPages,
              resumeAfterSeq
            )
          : await this.fetchPaginatedScopeMessages(scope, pageSize, maxPages)

      const processed =
        rawMessages.length > 0
          ? await this.processScopeMessages(scope, rawMessages, {
              persist: true,
              mutateState: true
            })
          : []

      const sorted = this.mergeScopeMessages(cached, processed).slice(-MAX_MESSAGES_PER_SCOPE)
      this.scopeMessages.set(scope.id, sorted)
      return sorted
    })

    return {
      durationMs: performance.now() - startedAt,
      messages,
      events: [],
      hasMore: false
    }
  }

  getMessages(scopeId: string): ProcessedScopeMessage[] {
    return [...(this.scopeMessages.get(scopeId) ?? [])]
  }

  async waitForMessage(
    scopeId: string,
    predicate: (message: ProcessedScopeMessage) => boolean,
    timeoutMs = 5_000
  ): Promise<ProcessedScopeMessage> {
    const existing = this.getMessages(scopeId).find(predicate)
    if (existing) {
      return existing
    }

    return await new Promise<ProcessedScopeMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off('message', onMessage)
        reject(new Error(`Timed out waiting for a message in ${scopeId}`))
      }, timeoutMs)

      const onMessage = (entry: { scope: EncryptedScope; message: ProcessedScopeMessage }) => {
        if (entry.scope.id !== scopeId) {
          return
        }
        if (!predicate(entry.message)) {
          return
        }

        clearTimeout(timeout)
        this.off('message', onMessage)
        resolve(entry.message)
      }

      this.on('message', onMessage)
    })
  }

  async handleScopeEvent(
    scope: EncryptedScope,
    event: string,
    payload: Record<string, unknown> | null
  ): Promise<void> {
    await this.withDeviceContext(async () => {
      if (event === 'new_message') {
        const message = await this.processIncomingMessage(scope, payload as unknown as VesperMessage)
        this.upsertScopeMessage(scope.id, message)
        this.emit('message', { scope, message })
        return
      }

      if (event === 'mls_request_join_all' && scope.kind === 'channel' && !this.hasGroup(scope.id)) {
        await this.requestMlsJoin(scope)
        return
      }

      if (event === 'mls_request_join') {
        await this.handleJoinRequestEvent(scope, payload)
        return
      }

      if (event === 'mls_commit') {
        const senderId = typeof payload?.sender_id === 'string' ? payload.sender_id : null
        const senderDeviceId =
          typeof payload?.sender_device_id === 'string' ? payload.sender_device_id : null

        if (
          senderId !== this.device.session?.user.id ||
          senderDeviceId !== this.device.deviceIdentity.id
        ) {
          await this.handleCommit(scope.id, this.getString(payload, 'commit_data'))
        }
        return
      }

      if (event === 'mls_remove') {
        const senderId = this.getString(payload, 'sender_id')
        const senderDeviceId = this.getString(payload, 'sender_device_id')
        const removedUserId = this.getString(payload, 'removed_user_id')
        const removedDeviceId = this.getString(payload, 'removed_device_id')
        const localUserId = this.device.session?.user.id
        const localDeviceId = this.device.deviceIdentity.id
        const isLocalSender = senderId === localUserId && senderDeviceId === localDeviceId
        const isLocalTarget =
          removedUserId === localUserId &&
          (removedDeviceId == null || removedDeviceId === localDeviceId)

        if (isLocalTarget && !isLocalSender) {
          this.groupStates.delete(scope.id)
          this.groupStateSnapshots.delete(scope.id)
          return
        }

        if (!isLocalSender) {
          await this.handleCommit(scope.id, this.getString(payload, 'commit_data'))
        }
        return
      }

      if (event === 'mls_eviction_request') {
        await this.handleEvictionRequestEvent(scope, payload)
        return
      }

      if (event === 'mls_welcome') {
        const recipientId = this.getString(payload, 'recipient_id')
        const recipientDeviceId = this.getString(payload, 'recipient_device_id')
        if (
          recipientId === this.device.session?.user.id &&
          (!recipientDeviceId || recipientDeviceId === this.device.deviceIdentity.id)
        ) {
          const processed = await this.handleWelcome(
            scope.id,
            this.getString(payload, 'welcome_data'),
            this.getString(payload, 'key_package_ref')
          )

          if (processed) {
            const welcomeId = this.getString(payload, 'id')
            if (welcomeId) {
              await ackPendingWelcome(welcomeId, this.device.httpClient).catch(() => {})
            }
          }
        }
      }
    })
  }

  async handleEvictionRequestEvent(
    scope: EncryptedScope,
    payload: Record<string, unknown> | null
  ): Promise<void> {
    await this.withDeviceContext(async () => {
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

      if (!evictionId || !targetUserId) {
        return
      }

      const session = this.device.session
      const localDeviceId = this.device.deviceIdentity.id
      const isLocalTarget =
        session?.user.id === targetUserId &&
        (targetDeviceId == null || targetDeviceId === localDeviceId)
      if (isLocalTarget) {
        return
      }

      const existing = this.pendingEvictionRequests.get(evictionId)
      if (existing) {
        await existing
        return
      }

      const recentAt = this.recentEvictionClaims.get(evictionId) ?? 0
      if (Date.now() - recentAt < EVICTION_REQUEST_COOLDOWN_MS) {
        return
      }

      const prev = this.evictionLocks.get(scope.id) ?? Promise.resolve()
      const current = prev
        .then(async () => {
          if (!this.hasGroup(scope.id)) {
            return
          }

          const currentSession = this.device.session
          if (!currentSession) {
            return
          }

          const state = this.groupStates.get(scope.id)
          if (!state) {
            return
          }

          if (!groupHasMember(state, currentSession.user.id, currentSession.user.username)) {
            return
          }

          const claimed = await this.device.pushToTopicWithAck(scopeTopic(scope), 'mls_eviction_claim', {
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
            const skipped = await this.device.pushToTopicWithAck(scopeTopic(scope), 'mls_eviction_skip', {
              id: evictionId,
              target_user_id: targetUserId,
              ...(targetDeviceId ? { target_device_id: targetDeviceId } : {}),
              reason: 'leaf_missing'
            })

            if (skipped) {
              this.recentEvictionClaims.set(evictionId, Date.now())
            }

            return
          }

          const removed = await removeMemberFromGroup(
            this.cloneGroupState(state),
            leafIndex
          )
          await this.setGroupState(scope.id, removed.newState)

          const pushed = await this.device.pushToTopicWithAck(scopeTopic(scope), 'mls_remove', {
            removed_user_id: targetUserId,
            ...(targetDeviceId ? { removed_device_id: targetDeviceId } : {}),
            commit_data: uint8ToBase64(removed.commitBytes),
            eviction_id: evictionId
          })

          if (pushed) {
            this.recentEvictionClaims.set(evictionId, Date.now())
          }
        })
        .finally(() => {
          this.pendingEvictionRequests.delete(evictionId)
          this.evictionLocks.delete(scope.id)
        })

      this.pendingEvictionRequests.set(evictionId, current)
      this.evictionLocks.set(scope.id, current)
      await current
    })
  }

  async handleJoinRequestEvent(
    scope: EncryptedScope,
    payload: Record<string, unknown> | null
  ): Promise<void> {
    await this.withDeviceContext(async () => {
      if (!this.hasGroup(scope.id)) {
        return
      }

      const requesterId = this.getString(payload, 'user_id')
      const requesterDeviceId = this.getString(payload, 'device_id')

      if (!requesterId) {
        return
      }

      if (
        requesterId === this.device.session?.user.id &&
        requesterDeviceId === this.device.deviceIdentity.id
      ) {
        return
      }

      const response = await this.handleJoinRequest(scope.id, requesterId, requesterDeviceId)
      if (!response) {
        return
      }

      await this.device.pushToTopicWithAck(scopeTopic(scope), 'mls_commit', {
        commit_data: response.commitBytes
      })

      if (response.welcomeBytes) {
        await this.device.pushToTopicWithAck(scopeTopic(scope), 'mls_welcome', {
          recipient_id: requesterId,
          recipient_device_id: requesterDeviceId,
          welcome_data: response.welcomeBytes,
          key_package_ref: response.keyPackageRef
        })
      }
    })
  }

  async ensureChannelGroupReady(channelId: string, allowCreate = false): Promise<boolean> {
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

    await this.device.pushToTopicWithAck(scopeTopic(scope), 'mls_request_join_all', {})
    return true
  }

  async ensureDmGroupReady(conversationId: string, allowForce = false): Promise<boolean> {
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

  async ensureGroupMembership(scopeId: string): Promise<boolean> {
    if (this.hasGroup(scopeId)) {
      await this.processPendingCommits(scopeId)
      return true
    }

    const persisted = await this.storage.loadGroupState(scopeId)
    if (persisted) {
      try {
        const state = deserializeGroupState(new Uint8Array(persisted.state))
        this.groupStates.set(scopeId, state)
        this.groupStateSnapshots.set(scopeId, {
          state: new Uint8Array(persisted.state),
          epoch: persisted.epoch
        })
        await this.processPendingCommits(scopeId)
        this.notifyMembershipWaiters(scopeId, true)
        return true
      } catch {
        this.groupStates.delete(scopeId)
        this.groupStateSnapshots.delete(scopeId)
      }
    }

    let welcomes: Awaited<ReturnType<typeof fetchPendingWelcomes>> = []
    try {
      welcomes = await fetchPendingWelcomes(scopeId, this.device.httpClient)
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
        await ackPendingWelcome(welcome.id, this.device.httpClient).catch(() => {})
        this.notifyMembershipWaiters(scopeId, true)
        return true
      }
    }

    // Try External Commit as fallback — no online member needed
    if (await this.tryJoinViaExternalCommit(scopeId)) {
      return true
    }

    return false
  }

  private async tryJoinViaExternalCommit(scopeId: string): Promise<boolean> {
    try {
      await initCipherSuite()

      const groupInfo = await fetchGroupInfo(scopeId, this.device.httpClient)
      if (!groupInfo) return false

      const session = this.device.requireSession()
      const identityName = buildClientCredentialIdentity(
        session.user.id,
        this.device.deviceIdentity.id
      )

      const { state, commitBytes } = await joinViaExternalCommit(
        groupInfo.groupInfoData,
        groupInfo.ratchetTreeData,
        identityName
      )

      await this.setGroupState(scopeId, state)
      this.notifyMembershipWaiters(scopeId, true)
      return true
    } catch {
      return false
    }
  }

  async replayDurableEvents(scope: EncryptedScope): Promise<void> {
    const session = this.device.requireSession()
    const pageSize = 200
    let cursor = await this.storage.loadGroupSyncCursor(scope.id)

    while (true) {
      let events: Awaited<ReturnType<typeof fetchMlsEvents>> = []
      try {
        events = await fetchMlsEvents(scope.id, cursor, pageSize, this.device.httpClient)
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
            event.sender_device_id === this.device.deviceIdentity.id
          )
        ) {
          const applied = await this.handleCommit(scope.id, event.payload.commit_data)
          if (!applied) {
            if (latestSeq > cursor) {
              await this.storage.saveGroupSyncCursor(scope.id, latestSeq)
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
            (removedDeviceId == null || removedDeviceId === this.device.deviceIdentity.id)

          if (isLocalTarget) {
            this.groupStates.delete(scope.id)
            this.groupStateSnapshots.delete(scope.id)
            return
          }
        }

        latestSeq = Math.max(latestSeq, event.seq)
      }

      if (latestSeq > cursor) {
        await this.storage.saveGroupSyncCursor(scope.id, latestSeq)
        cursor = latestSeq
      }

      if (events.length < pageSize) {
        return
      }
    }
  }

  async processIncomingMessage(
    scope: EncryptedScope,
    rawMessage: VesperMessage,
    options: {
      persist?: boolean
    } = {}
  ): Promise<ProcessedScopeMessage> {
    const scopeId = scope.id
    const ciphertext = typeof rawMessage.ciphertext === 'string' ? rawMessage.ciphertext : null
    let content = typeof rawMessage.content === 'string' ? rawMessage.content : ''
    let encrypted = false
    let decryptionFailed = false
    let decryptedPlaintext: string | null = null
    const persist = options.persist ?? true

    if (ciphertext) {
      encrypted = true

      const [sentPlaintext, cachedMessagePlaintext] = await Promise.all([
        this.storage.loadSentMessagePlaintext(ciphertext),
        this.storage.loadCachedMessageDecryption(rawMessage.id)
      ])
      const cachedPlaintext = sentPlaintext ?? cachedMessagePlaintext
      const plaintext =
        cachedPlaintext ??
        (await this.decryptForScopeWithRecovery(scope, ciphertext, rawMessage.mls_epoch ?? null))

      if (plaintext) {
        decryptedPlaintext = plaintext
        content = coerceDisplayText(plaintext)
      } else {
        content = DECRYPTION_PLACEHOLDER
        decryptionFailed = true
      }
    }

    const persistenceWork = []

    if (decryptedPlaintext) {
      persistenceWork.push(
        this.storage.saveCachedMessageDecryption(rawMessage.id, decryptedPlaintext)
      )
    }

    if (persist) {
      persistenceWork.push(
        this.storage.cacheMessage({
          id: rawMessage.id,
          roomSeq: rawMessage.room_seq ?? null,
          channelId: rawMessage.channel_id ?? null,
          conversationId: rawMessage.conversation_id ?? null,
          serverId: null,
          senderId: rawMessage.sender_id ?? null,
          senderUsername: rawMessage.sender?.username ?? null,
          parentMessageId: rawMessage.parent_message_id ?? null,
          ciphertext: ciphertext ? Buffer.from(ciphertext, 'base64') : null,
          decryptedContent: decryptionFailed ? null : decryptedPlaintext,
          mlsEpoch: rawMessage.mls_epoch ?? null,
          insertedAt: rawMessage.inserted_at
        })
      )

      if (!decryptionFailed && content) {
        persistenceWork.push(this.storage.indexDecryptedMessage(rawMessage.id, scopeId, content))
      }
    }

    if (persistenceWork.length > 0) {
      await Promise.all(persistenceWork)
    }

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
      plaintext: decryptedPlaintext ?? null,
      encrypted,
      decryptionFailed,
      raw: rawMessage
    }
  }

  async requestMlsJoin(scope: EncryptedScope): Promise<void> {
    const topic = scopeTopic(scope)
    const existingRequest = this.pendingJoinRequests.get(topic)
    if (existingRequest) {
      await existingRequest
      return
    }

    const request = (async () => {
      await this.device.replenishKeyPackages()

      const pushed = await this.device.pushToTopicWithAck(topic, 'mls_request_join', {
        device_id: this.device.deviceIdentity.id
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

  async createGroup(scopeId: string): Promise<void> {
    if (this.hasGroup(scopeId)) {
      return
    }

    await initCipherSuite()
    await this.device.replenishKeyPackages()

    const session = this.device.requireSession()
    const identityName = buildClientCredentialIdentity(session.user.id, this.device.deviceIdentity.id)
    const localPackages = await this.storage.loadKeyPackages()

    if (localPackages.length > 0) {
      const localPackage = localPackages[0]
      await this.storage.consumeKeyPackage(localPackage.id)
    }

    const state = await createMLSGroup(scopeId, identityName)
    await this.setGroupState(scopeId, state)
    await this.device.replenishKeyPackages()
  }

  async handleJoinRequest(
    scopeId: string,
    userId: string,
    deviceId: string | null
  ): Promise<{
    commitBytes: string
    welcomeBytes: string | null
    keyPackageRef: string
  } | null> {
    if (!this.hasGroup(scopeId)) {
      return null
    }

    await initCipherSuite()
    let keyPackageBytes: Uint8Array | null
    try {
      keyPackageBytes = await fetchKeyPackage(
        userId,
        deviceId ?? undefined,
        this.device.httpClient
      )
    } catch {
      return null
    }
    if (!keyPackageBytes) {
      return null
    }

    const state = this.groupStates.get(scopeId)
    if (!state) {
      return null
    }

    const memberKeyPackage = decodeKeyPackageBytes(keyPackageBytes)

    // Infer identity from userId/deviceId rather than parsing the opaque key package
    const requestedIdentity = deviceId
      ? buildClientCredentialIdentity(userId, deviceId)
      : userId

    if (
      requestedIdentity &&
      (getGroupLeafIdentities(state).includes(requestedIdentity) ||
        groupHasMember(state, requestedIdentity))
    ) {
      return null
    }

    const result = await addMemberToGroup(
      this.cloneGroupState(state),
      keyPackageBytes
    )
    await this.setGroupState(scopeId, result.newState)

    return {
      commitBytes: uint8ToBase64(result.commitBytes),
      welcomeBytes: result.welcomeBytes ? uint8ToBase64(result.welcomeBytes) : null,
      keyPackageRef: uint8ToBase64(keyPackageBytes)
    }
  }

  async handleWelcome(
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
        const session = this.device.requireSession()
        const identityName = buildClientCredentialIdentity(session.user.id, this.device.deviceIdentity.id)
        const state = await processWelcome(
          Buffer.from(welcomeData, 'base64'),
          identityName,
          new Uint8Array(localPackage.privateData)
        )

        await this.setGroupState(scopeId, state)
        await this.storage.consumeKeyPackage(localPackage.id)
        await this.processPendingCommits(scopeId)
        await this.device.replenishKeyPackages()
        return true
      } catch {
        continue
      }
    }

    return false
  }

  async handleCommit(scopeId: string, commitData: string | null): Promise<boolean> {
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
      this.notifyMembershipWaiters(scopeId, true)
      return true
    } catch {
      return false
    }
  }

  async processPendingCommits(scopeId: string): Promise<void> {
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

      const applied = await this.handleCommit(scopeId, commitData)
      if (!applied) {
        blocked = true
        remaining.push(commitData)
      }
    }

    if (remaining.length > 0) {
      this.pendingCommits.set(scopeId, remaining)
    }
  }

  async encryptForScope(
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

  async decryptForScope(scopeId: string, ciphertext: string): Promise<string | null> {
    const state = this.groupStates.get(scopeId)
    if (!state) {
      return null
    }

    const decrypted = await decryptMessage(
      this.cloneGroupState(state),
      Buffer.from(ciphertext, 'base64')
    )
    if (!decrypted) {
      return null
    }

    await this.setGroupState(scopeId, decrypted.newState)
    return decrypted.plaintext
  }

  async decryptForScopeWithRecovery(
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

    await this.replayDurableEvents(scope)
    return await this.decryptForScope(scope.id, ciphertext)
  }

  hasGroup(scopeId: string): boolean {
    return this.groupStates.has(scopeId)
  }

  private async fetchScopeMessages(
    scope: EncryptedScope,
    options: {
      after?: string
      afterSeq?: number
      before?: string
      limit: number
      lean?: boolean
    }
  ): Promise<VesperMessage[]> {
    if (scope.kind === 'channel') {
      return await this.device.fetchChannelMessages(scope.id, options)
    }

    return await this.device.fetchConversationMessages(scope.id, options)
  }

  private async processScopeMessages(
    scope: EncryptedScope,
    rawMessages: VesperMessage[],
    options: {
      persist?: boolean
      mutateState?: boolean
    } = {}
  ): Promise<ProcessedScopeMessage[]> {
    if (options.mutateState === false) {
      return await this.processPreviewMessages(scope, rawMessages, options.persist ?? true)
    }

    const processed: ProcessedScopeMessage[] = []
    for (const rawMessage of sortRawMessages(rawMessages)) {
      processed.push(await this.processIncomingMessage(scope, rawMessage, options))
    }

    return processed
  }

  private async fetchPaginatedScopeMessages(
    scope: EncryptedScope,
    pageSize: number,
    maxPages: number
  ): Promise<VesperMessage[]> {
    const dedupedMessages = new Map<string, VesperMessage>()
    let before: string | undefined

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const page = await this.fetchScopeMessages(scope, {
        before,
        limit: pageSize,
        lean: true
      })
      if (page.length === 0) {
        break
      }

      for (const message of page) {
        dedupedMessages.set(message.id, message)
      }

      if (page.length < pageSize) {
        break
      }

      const oldestMessage = sortRawMessages(page)[0] ?? null
      before = oldestMessage ? `${oldestMessage.inserted_at}|${oldestMessage.id}` : undefined
      if (!before) {
        break
      }
    }

    return sortRawMessages([...dedupedMessages.values()])
  }

  private async fetchIncrementalScopeMessages(
    scope: EncryptedScope,
    pageSize: number,
    maxPages: number,
    afterSeq: number
  ): Promise<VesperMessage[]> {
    const dedupedMessages = new Map<string, VesperMessage>()
    let cursor = afterSeq

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const page = await this.fetchScopeMessages(scope, {
        afterSeq: cursor,
        limit: pageSize,
        lean: true
      })
      if (page.length === 0) {
        break
      }

      const sortedPage = sortRawMessages(page)
      for (const message of sortedPage) {
        dedupedMessages.set(message.id, message)
      }

      const newestSeq = sortedPage.at(-1)?.room_seq
      if (typeof newestSeq === 'number') {
        cursor = newestSeq
      }

      if (page.length < pageSize) {
        break
      }
    }

    return sortRawMessages([...dedupedMessages.values()])
  }

  private async syncLatestMessageState(scope: EncryptedScope): Promise<void> {
    const latestRaw = (
      await this.fetchScopeMessages(scope, {
        limit: 1,
        lean: true
      })
    ).at(-1)
    if (!latestRaw) {
      return
    }

    const latestKnownId = this.scopeMessages.get(scope.id)?.at(-1)?.id ?? null
    if (latestKnownId === latestRaw.id) {
      return
    }

    const [processed] = await this.processScopeMessages(scope, [latestRaw], {
      persist: false,
      mutateState: true
    })
    if (processed) {
      this.upsertScopeMessage(scope.id, processed)
    }
  }

  private async setGroupState(scopeId: string, state: GroupState): Promise<void> {
    const serializedState = serializeGroupState(state)
    const epoch = Number(state.groupContext.epoch)
    this.groupStates.set(scopeId, state)
    this.groupStateSnapshots.set(scopeId, {
      state: serializedState,
      epoch
    })
    await this.storage.saveGroupState(
      scopeId,
      serializedState,
      epoch
    )
    this.notifyMembershipWaiters(scopeId, true)

    void this.publishGroupInfoForScope(scopeId, state)
  }

  private async publishGroupInfoForScope(scopeId: string, state: GroupState): Promise<boolean> {
    try {
      const groupInfoData = exportGroupInfo(state)
      const ratchetTreeData = exportRatchetTree(state)
      const epoch = Number(state.groupContext.epoch)
      await publishGroupInfo(scopeId, groupInfoData, ratchetTreeData, epoch, this.device.httpClient)
      return true
    } catch {
      return false
    }
  }

  private cloneGroupState(state: GroupState): GroupState {
    return deserializeGroupState(serializeGroupState(state))
  }

  private snapshotGroupState(scopeId: string): { state: Uint8Array; epoch: number } | null {
    const snapshot = this.groupStateSnapshots.get(scopeId)
    if (snapshot) {
      return {
        state: new Uint8Array(snapshot.state),
        epoch: snapshot.epoch
      }
    }

    const state = this.groupStates.get(scopeId)
    if (!state) {
      return null
    }

    const serializedState = serializeGroupState(state)
    const nextSnapshot = {
      state: serializedState,
      epoch: Number(state.groupContext.epoch)
    }
    this.groupStateSnapshots.set(scopeId, nextSnapshot)

    return {
      state: new Uint8Array(serializedState),
      epoch: nextSnapshot.epoch
    }
  }

  private async restoreGroupState(
    scopeId: string,
    snapshot: { state: Uint8Array; epoch: number }
  ): Promise<void> {
    const restored = deserializeGroupState(new Uint8Array(snapshot.state))
    this.groupStates.set(scopeId, restored)
    this.groupStateSnapshots.set(scopeId, {
      state: new Uint8Array(snapshot.state),
      epoch: snapshot.epoch
    })
    await this.storage.saveGroupState(scopeId, snapshot.state, snapshot.epoch)
  }

  private async processPreviewMessages(
    scope: EncryptedScope,
    rawMessages: VesperMessage[],
    persist: boolean
  ): Promise<ProcessedScopeMessage[]> {
    const snapshot = this.snapshotGroupState(scope.id)
    if (!snapshot) {
      return []
    }

    let workingState = deserializeGroupState(new Uint8Array(snapshot.state))
    const processed: ProcessedScopeMessage[] = []

    for (const rawMessage of sortRawMessages(rawMessages)) {
      const result = await this.processPreviewMessage(scope, rawMessage, workingState, persist)
      processed.push(result.message)
      if (result.nextState) {
        workingState = result.nextState
      }
    }

    return processed
  }

  private async loadProcessedCachedMessages(scopeId: string): Promise<ProcessedScopeMessage[]> {
    const cached = await this.storage.loadCachedMessages(scopeId)

    return cached
      .map((message) => {
        const ciphertext = message.ciphertext ? Buffer.from(message.ciphertext).toString('base64') : undefined
        const content =
          (message.decryptedContent != null
            ? coerceDisplayText(message.decryptedContent)
            : null) ??
          (ciphertext ? DECRYPTION_PLACEHOLDER : '')

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
          plaintext: message.decryptedContent ?? null,
          encrypted: Boolean(ciphertext),
          decryptionFailed: ciphertext ? message.decryptedContent == null : false,
          raw: {
            id: message.id,
            room_seq: message.roomSeq,
            channel_id: message.channelId,
            conversation_id: message.conversationId,
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
        const leftSeq =
          typeof left.raw.room_seq === 'number' ? left.raw.room_seq : null
        const rightSeq =
          typeof right.raw.room_seq === 'number' ? right.raw.room_seq : null

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

  private resumeAfterRoomSeq(messages: ProcessedScopeMessage[]): number | null {
    let latestSuccessful: number | null = null
    let earliestFailed: number | null = null

    for (const message of messages) {
      if (typeof message.raw.room_seq !== 'number') {
        continue
      }

      if (message.decryptionFailed) {
        earliestFailed =
          earliestFailed === null
            ? message.raw.room_seq
            : Math.min(earliestFailed, message.raw.room_seq)
        continue
      }

      latestSuccessful =
        latestSuccessful === null
          ? message.raw.room_seq
          : Math.max(latestSuccessful, message.raw.room_seq)
    }

    if (earliestFailed !== null) {
      const retryAfter = earliestFailed - 1
      return retryAfter > 0 ? retryAfter : null
    }

    return latestSuccessful
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

  private async processPreviewMessage(
    scope: EncryptedScope,
    rawMessage: VesperMessage,
    state: GroupState,
    persist: boolean
  ): Promise<{ message: ProcessedScopeMessage; nextState: GroupState | null }> {
    const scopeId = scope.id
    const ciphertext = typeof rawMessage.ciphertext === 'string' ? rawMessage.ciphertext : null
    let content = typeof rawMessage.content === 'string' ? rawMessage.content : ''
    let encrypted = false
    let decryptionFailed = false
    let decryptedPlaintext: string | null = null
    let nextState: GroupState | null = null

    if (ciphertext) {
      encrypted = true

      const [sentPlaintext, cachedMessagePlaintext] = await Promise.all([
        this.storage.loadSentMessagePlaintext(ciphertext),
        this.storage.loadCachedMessageDecryption(rawMessage.id)
      ])
      const cachedPlaintext = sentPlaintext ?? cachedMessagePlaintext

      if (cachedPlaintext) {
        decryptedPlaintext = cachedPlaintext
        content = coerceDisplayText(cachedPlaintext)
      } else {
        const decrypted = await decryptMessage(state, Buffer.from(ciphertext, 'base64'))
        if (decrypted) {
          decryptedPlaintext = decrypted.plaintext
          content = coerceDisplayText(decrypted.plaintext)
          nextState = decrypted.newState
        } else {
          content = DECRYPTION_PLACEHOLDER
          decryptionFailed = true
        }
      }
    }

    if (persist && decryptedPlaintext) {
      await this.storage.saveCachedMessageDecryption(rawMessage.id, decryptedPlaintext)
    }

    if (persist) {
      const persistenceWork = [
        this.storage.cacheMessage({
          id: rawMessage.id,
          roomSeq: rawMessage.room_seq ?? null,
          channelId: rawMessage.channel_id ?? null,
          conversationId: rawMessage.conversation_id ?? null,
          serverId: null,
          senderId: rawMessage.sender_id ?? null,
          senderUsername: rawMessage.sender?.username ?? null,
          parentMessageId: rawMessage.parent_message_id ?? null,
          ciphertext: ciphertext ? Buffer.from(ciphertext, 'base64') : null,
          decryptedContent: decryptionFailed ? null : decryptedPlaintext,
          mlsEpoch: rawMessage.mls_epoch ?? null,
          insertedAt: rawMessage.inserted_at
        })
      ]

      if (!decryptionFailed && content) {
        persistenceWork.push(this.storage.indexDecryptedMessage(rawMessage.id, scopeId, content))
      }

      await Promise.all(persistenceWork)
    }

    return {
      nextState,
      message: {
        id: rawMessage.id,
        scopeId,
        channelId: rawMessage.channel_id ?? null,
        conversationId: rawMessage.conversation_id ?? null,
        senderId: rawMessage.sender_id ?? null,
        senderUsername: rawMessage.sender?.username ?? null,
        parentMessageId: rawMessage.parent_message_id ?? null,
        insertedAt: rawMessage.inserted_at,
        content,
        plaintext: decryptedPlaintext ?? null,
        encrypted,
        decryptionFailed,
        raw: rawMessage
      }
    }
  }

  private async channelHasExistingActivity(channelId: string): Promise<boolean> {
    const cachedMessages = this.scopeMessages.get(channelId) ?? []
    if (cachedMessages.length > 0) {
      return true
    }

    const syncState = await this.device.fetchWorkspaceSync().catch(() => null)
    const channelActivity = syncState?.channel_activity ?? []

    for (const activity of channelActivity) {
      if (activity.channel_id === channelId && activity.message_id) {
        return true
      }
    }

    return false
  }

  private async bootstrapDmGroupIfLeader(conversationId: string): Promise<boolean> {
    const session = this.device.session
    const conversations = await this.device.listConversations()
    const conversation =
      conversations.find((entry) => entry.id === conversationId) ?? null

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

      await this.device.pushToTopicWithAck(scopeTopic(scope), 'mls_commit', {
        commit_data: response.commitBytes
      })

      if (response.welcomeBytes) {
        await this.device.pushToTopicWithAck(scopeTopic(scope), 'mls_welcome', {
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

  private shouldReplayForScope(
    scopeId: string,
    rawMessages: VesperMessage[],
    processedMessages: ProcessedScopeMessage[],
    usedHotPath: boolean
  ): boolean {
    if (!usedHotPath) {
      return false
    }

    if (processedMessages.some((message) => message.decryptionFailed)) {
      return true
    }

    const currentEpoch = this.getGroupEpoch(scopeId)
    if (currentEpoch === null) {
      return true
    }

    return rawMessages.some(
      (message) =>
        typeof message.mls_epoch === 'number' &&
        Number.isFinite(message.mls_epoch) &&
        message.mls_epoch > currentEpoch
    )
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
}

export function createChatHarness(device: TestingDeviceHarness): SdkChatHarness {
  return new SdkChatHarness(device)
}
