import {
  ackPendingHistoryBundle,
  ackPendingHistoryRequest,
  ackPendingResyncRequest,
  ackPendingWelcome,
  fetchGroupInfo,
  fetchPendingHistoryBundles,
  fetchPendingHistoryRequests,
  fetchPendingResyncRequests,
  fetchKeyPackage,
  fetchMlsEvents,
  fetchPendingWelcomes,
  publishExternalCommitGroupInfo,
  publishGroupInfo,
  publishSponsoredTransition,
  uint8ToBase64
} from '../api/crypto.js'
import type {
  VesperMemberPreview,
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
  type CryptoStorageRuntime,
  type ScopeCheckpointRecord
} from '../crypto/storage.js'
import { cacheSentMessage } from '../crypto/decryptionCache.js'
import { withGroupLock } from '../crypto/groupLock.js'
import type { MessagePayload } from '../crypto/payload.js'
import type { VesperClient } from './index.js'
import { MLSDiagnostics } from './mlsDiagnostics.js'

const JOIN_WAIT_MS = 2_500
const DM_PREPARE_WAIT_MS = 5_000
const DM_PARTICIPANT_JOIN_WAIT_MS = 10_000
const EVICTION_REQUEST_COOLDOWN_MS = 3_000
const VOICE_JOIN_REQUEST_COOLDOWN_MS = 2_000
const VOICE_RESYNC_REQUEST_COOLDOWN_MS = 3_000
const SEND_CONFIRMATION_WAIT_MS = 2_000
const OUTBOUND_SCOPE_READY_WAIT_MS = 30_000
const OUTBOUND_SCOPE_READY_RETRY_MS = 250
const HISTORY_SYNC_REQUEST_COOLDOWN_MS = 1_000
const HISTORY_BUNDLE_WAIT_MS = 5_000
const HISTORY_BUNDLE_POLL_MS = 200
const MAX_MESSAGES_PER_SCOPE = 200
const DECRYPTION_PLACEHOLDER = '[Encrypted message unavailable]'
const SCOPE_NOT_READY = Symbol('scope-not-ready')

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

export interface VoiceScopeRecoveryOptions {
  preferredCreatorId?: string | null
  reason?: string | null
}

export interface ScopePreparationOptions {
  lastKnownEpoch?: number | null
  reason?: string | null
}

export interface ScopeRepairDrainOptions {
  force?: boolean
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
type PendingSponsoredTransition = {
  recipientId: string
  recipientClientId: string | null
  recipientKeyPackageRef: string | null
  commitData: string
  commitId: string
  removeCommitData: string | null
  welcomeData: string | null
  groupInfoData: Uint8Array | null
  ratchetTreeData: Uint8Array | null
  epoch: number | null
  previousEpoch: number | null
  baseState: Uint8Array | null
  baseEpoch: number | null
}
type PreparedSponsoredTransition = PendingSponsoredTransition & {
  newState: GroupState
}
type ScopeRepairStatus =
  | 'healthy'
  | 'replaying'
  | 'waiting_for_welcome'
  | 'waiting_for_same_user_bundle'
  | 'needs_external_commit'
  | 'corrupt_local_state'
  | 'needs_repair'
type ScopeRepairState = {
  status: ScopeRepairStatus
  failureCount: number
  lastError: string | null
  updatedAt: string | null
}
type CommitHandlingResult =
  | { status: 'applied'; fingerprint: string }
  | { status: 'already_applied'; fingerprint: string }
  | { status: 'buffered_waiting_for_state' }
  | { status: 'needs_repair'; error: string | null }

const MAX_RECENT_COMMIT_FINGERPRINTS = 32
const MAX_RECENT_HISTORY_BUNDLE_FINGERPRINTS = 64
const REPAIR_FETCH_COOLDOWN_MS = 1_000

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

function samePendingSponsoredTransition(
  left: PendingSponsoredTransition,
  right: PendingSponsoredTransition
): boolean {
  return (
    left.recipientId === right.recipientId &&
    left.recipientClientId === right.recipientClientId &&
    left.recipientKeyPackageRef === right.recipientKeyPackageRef &&
    left.commitData === right.commitData &&
    left.commitId === right.commitId &&
    left.removeCommitData === right.removeCommitData &&
    left.welcomeData === right.welcomeData &&
    uint8ArraysEqual(left.groupInfoData, right.groupInfoData) &&
    uint8ArraysEqual(left.ratchetTreeData, right.ratchetTreeData) &&
    left.epoch === right.epoch &&
    left.previousEpoch === right.previousEpoch &&
    uint8ArraysEqual(left.baseState, right.baseState) &&
    left.baseEpoch === right.baseEpoch
  )
}

function cloneScopeCheckpointRecord(checkpoint: ScopeCheckpointRecord): ScopeCheckpointRecord {
  return {
    groupId: checkpoint.groupId,
    groupState: checkpoint.groupState
      ? {
          state: new Uint8Array(checkpoint.groupState.state),
          epoch: checkpoint.groupState.epoch
        }
      : null,
    lastEventSeq: checkpoint.lastEventSeq,
    recentCommitFingerprints: [...checkpoint.recentCommitFingerprints],
    recentHistoryBundleFingerprints: [...checkpoint.recentHistoryBundleFingerprints],
    repairState: checkpoint.repairState
      ? {
          status: checkpoint.repairState.status,
          failureCount: checkpoint.repairState.failureCount,
          lastError: checkpoint.repairState.lastError,
          updatedAt: checkpoint.repairState.updatedAt
        }
      : null,
    pendingGroupInfoPublish: checkpoint.pendingGroupInfoPublish
      ? {
          groupInfoData: new Uint8Array(checkpoint.pendingGroupInfoPublish.groupInfoData),
          ratchetTreeData: checkpoint.pendingGroupInfoPublish.ratchetTreeData
            ? new Uint8Array(checkpoint.pendingGroupInfoPublish.ratchetTreeData)
            : null,
          epoch: checkpoint.pendingGroupInfoPublish.epoch
        }
      : null,
    pendingExternalCommitBroadcast: checkpoint.pendingExternalCommitBroadcast
      ? {
          commitData: checkpoint.pendingExternalCommitBroadcast.commitData,
          commitId: checkpoint.pendingExternalCommitBroadcast.commitId
        }
      : null,
    pendingSponsoredTransition: checkpoint.pendingSponsoredTransition
      ? {
          recipientId: checkpoint.pendingSponsoredTransition.recipientId,
          recipientClientId: checkpoint.pendingSponsoredTransition.recipientClientId,
          recipientKeyPackageRef: checkpoint.pendingSponsoredTransition.recipientKeyPackageRef,
          commitData: checkpoint.pendingSponsoredTransition.commitData,
          commitId: checkpoint.pendingSponsoredTransition.commitId,
          removeCommitData: checkpoint.pendingSponsoredTransition.removeCommitData,
          welcomeData: checkpoint.pendingSponsoredTransition.welcomeData,
          groupInfoData: checkpoint.pendingSponsoredTransition.groupInfoData
            ? new Uint8Array(checkpoint.pendingSponsoredTransition.groupInfoData)
            : null,
          ratchetTreeData: checkpoint.pendingSponsoredTransition.ratchetTreeData
            ? new Uint8Array(checkpoint.pendingSponsoredTransition.ratchetTreeData)
            : null,
          epoch: checkpoint.pendingSponsoredTransition.epoch,
          previousEpoch: checkpoint.pendingSponsoredTransition.previousEpoch,
          baseState: checkpoint.pendingSponsoredTransition.baseState
            ? new Uint8Array(checkpoint.pendingSponsoredTransition.baseState)
            : null,
          baseEpoch: checkpoint.pendingSponsoredTransition.baseEpoch
        }
      : null
  }
}

function normalizeScopeRepairState(
  value: ScopeRepairState | null | undefined
): ScopeRepairState | null {
  if (!value) {
    return null
  }

  return {
    status: value.status,
    failureCount: value.failureCount,
    lastError: value.lastError ?? null,
    updatedAt: value.updatedAt ?? null
  }
}

function toScopeRepairState(
  value: { status: string; failureCount: number; lastError: string | null; updatedAt: string | null } | null
): ScopeRepairState | null {
  if (!value) {
    return null
  }

  if (
    value.status !== 'healthy' &&
    value.status !== 'replaying' &&
    value.status !== 'waiting_for_welcome' &&
    value.status !== 'waiting_for_same_user_bundle' &&
    value.status !== 'needs_external_commit' &&
    value.status !== 'corrupt_local_state' &&
    value.status !== 'needs_repair'
  ) {
    return null
  }

  return {
    status: value.status,
    failureCount: value.failureCount,
    lastError: value.lastError,
    updatedAt: value.updatedAt
  }
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

type HistoryBundleItem = {
  id: string
  content: string
  channelId?: string | null
  conversationId?: string | null
  serverId?: string | null
  senderId?: string | null
  sender?: VesperMemberPreview | null
  insertedAt?: string
  expiresAt?: string | null
  parentMessageId?: string | null
}

function normalizeHistoryBundleSender(
  value: unknown
): VesperMemberPreview | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const sender = value as Record<string, unknown>
  const id = typeof sender.id === 'string' ? sender.id : null
  const username = typeof sender.username === 'string' ? sender.username : null
  if (!id || !username) {
    return null
  }

  return {
    id,
    username,
    display_name: typeof sender.display_name === 'string' ? sender.display_name : null,
    avatar_url: typeof sender.avatar_url === 'string' ? sender.avatar_url : null
  }
}

function normalizeHistoryBundleItem(
  value: unknown
): HistoryBundleItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const item = value as Record<string, unknown>
  const id = typeof item.id === 'string' ? item.id : null
  const content = typeof item.content === 'string' ? item.content : null
  if (!id || !content) {
    return null
  }

  return {
    id,
    content,
    channelId: typeof item.channelId === 'string' ? item.channelId : null,
    conversationId: typeof item.conversationId === 'string' ? item.conversationId : null,
    serverId: typeof item.serverId === 'string' ? item.serverId : null,
    senderId: typeof item.senderId === 'string' ? item.senderId : null,
    sender: normalizeHistoryBundleSender(item.sender),
    insertedAt: typeof item.insertedAt === 'string' ? item.insertedAt : undefined,
    expiresAt:
      typeof item.expiresAt === 'string' || item.expiresAt === null
        ? (item.expiresAt as string | null)
        : null,
    parentMessageId:
      typeof item.parentMessageId === 'string' || item.parentMessageId === null
        ? (item.parentMessageId as string | null)
        : null
  }
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
  private readonly recentScopeResyncRequests = new Map<string, number>()
  private readonly recentScopeHistoryRequests = new Map<string, number>()
  private readonly recentVoiceJoinRequests = new Map<string, number>()
  private readonly recentVoiceResyncRequests = new Map<string, number>()
  private readonly inFlightScopePreparations = new Map<string, Promise<boolean>>()
  private readonly backgroundChannelMembershipRetries = new Map<string, Promise<void>>()
  private readonly inFlightVoiceRecoveries = new Map<string, Promise<Uint8Array | null>>()
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
  private readonly lastSuccessfulGroupInfoPublishEpochs = new Map<string, number>()
  private readonly pendingExternalCommitBroadcasts = new Map<string, PendingExternalCommitBroadcast>()
  private readonly pendingSponsoredTransitions = new Map<string, PendingSponsoredTransition>()
  private readonly sponsoredTransitionRollbackStates = new Map<string, GroupState>()
  private readonly externalCommitBroadcastRetryAttempts = new Map<string, number>()
  private readonly externalCommitBroadcastRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly sponsoredTransitionRetryAttempts = new Map<string, number>()
  private readonly sponsoredTransitionRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly checkpointPersistChains = new Map<string, Promise<void>>()
  private readonly recentCommitFingerprints = new Map<string, string[]>()
  private readonly recentHistoryBundleFingerprints = new Map<string, string[]>()
  private readonly inFlightHistoryBundleProcesses = new Map<string, Promise<boolean>>()
  private readonly scopeRepairStates = new Map<string, ScopeRepairState>()
  private readonly pendingRepairFetches = new Map<string, Promise<void>>()
  private readonly lastRepairFetchAt = new Map<string, number>()
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
    this.client.on('raw', ({ event, payload }) => {
      if (event === 'mls_history_request_pending' || event === 'mls_history_bundle_pending') {
        void this.handlePendingHistoryUserEvent(normalizePayload(payload))
      }
    })
    this.client.on('state', (state) => {
      if (state.status === 'signed_out') {
        this.reset()
      }
    })
  }

  private async handleConnected(): Promise<void> {
    try {
      await this.loadPendingControlOutbox()
      await this.flushPendingSponsoredTransitions()
      await this.flushPendingGroupInfoPublishes()
      await this.flushPendingExternalCommitBroadcasts()
      await this.restoreConnections()
      await this.processPendingRepairArtifactsForKnownScopes()
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

              if (
                nextEvent.event === 'mls_commit' ||
                nextEvent.event === 'mls_welcome'
              ) {
                await this.processPendingRepairArtifacts(nextEvent.scope, true)
              }
            }
          })

          this.scopeDisposers.set(topic, dispose)
          this.joinedTopics.add(topic)

          if (this.hasGroup(scope.id)) {
            await this.replayDurableEvents(scope.id)
          }
          await this.processPendingRepairArtifacts(scope)
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

  private async handlePendingHistoryUserEvent(
    payload: Record<string, unknown> | null
  ): Promise<void> {
    const scopeId = this.getString(payload, 'scope_id')
    const topic = this.getString(payload, 'topic')
    if (!scopeId || !topic) {
      return
    }

    const scope = this.parseScopeTopic(topic)
    if (!scope) {
      return
    }

    await this.processPendingRepairArtifacts(scope, true)
  }

  private async processPendingRepairArtifactsForKnownScopes(): Promise<void> {
    const scopes = new Map<string, EncryptedScope>()
    const state = this.client.getState()
    const channelIds = new Set(
      state.servers.flatMap((server) => server.channels.map((channel) => channel.id))
    )
    const conversationIds = new Set(state.conversations.map((conversation) => conversation.id))

    for (const [scopeId, kind] of this.scopeKinds.entries()) {
      scopes.set(scopeId, { kind, id: scopeId })
    }

    for (const topic of [...this.scopeWatchRefs.keys(), ...this.scopeListeners.keys()]) {
      const scope = this.parseScopeTopic(topic)
      if (scope) {
        scopes.set(scope.id, scope)
      }
    }

    const persistedScopeIds = await this.storage.loadKnownScopeIds().catch(() => [])
    for (const scopeId of persistedScopeIds) {
      if (scopes.has(scopeId) || scopeId.startsWith('voice:')) {
        continue
      }

      const kind =
        this.scopeKinds.get(scopeId) ??
        (conversationIds.has(scopeId) ? 'dm' : channelIds.has(scopeId) ? 'channel' : null)
      if (!kind) {
        continue
      }

      scopes.set(scopeId, { kind, id: scopeId })
    }

    for (const scope of scopes.values()) {
      await this.processPendingRepairArtifacts(scope)
    }
  }

  private async processPendingRepairArtifacts(
    scope: EncryptedScope,
    force = false
  ): Promise<void> {
    const inflight = this.pendingRepairFetches.get(scope.id)
    if (inflight) {
      await inflight
      return
    }

    const lastFetchAt = this.lastRepairFetchAt.get(scope.id) ?? 0
    if (!force && Date.now() - lastFetchAt < REPAIR_FETCH_COOLDOWN_MS) {
      return
    }

    const run = this.withLockedScopeOperation(scope.id, async () => {
      this.scopeKinds.set(scope.id, scope.kind)
      this.lastRepairFetchAt.set(scope.id, Date.now())

      await this.processPendingResyncRequests(scope)
      await this.processPendingHistoryRequests(scope)
      await this.processPendingHistoryBundles(scope)
    }, 'urgent').finally(() => {
      this.pendingRepairFetches.delete(scope.id)
    })

    this.pendingRepairFetches.set(scope.id, run)
    await run
  }

  reset(): void {
    this.clearConnections()
    this.groupStates.clear()
    this.pendingCommits.clear()
    this.pendingJoinRequests.clear()
    this.pendingEvictionRequests.clear()
    this.recentEvictionClaims.clear()
    this.recentScopeResyncRequests.clear()
    this.recentScopeHistoryRequests.clear()
    this.recentJoinDeviceIds.clear()
    this.evictionLocks.clear()
    this.scopeMessages.clear()
    this.inFlightScopePreparations.clear()
    this.backgroundChannelMembershipRetries.clear()
    this.welcomeAppliedAtByScope.clear()
    this.recentDmJoinProcessed.clear()
    this.yieldedDmScopes.clear()
    this.pendingGroupInfoPublishes.clear()
    this.groupInfoPublishRetryAttempts.clear()
    for (const timer of this.groupInfoPublishRetryTimers.values()) {
      clearTimeout(timer)
    }
    this.groupInfoPublishRetryTimers.clear()
    this.lastSuccessfulGroupInfoPublishEpochs.clear()
    this.pendingExternalCommitBroadcasts.clear()
    this.pendingSponsoredTransitions.clear()
    this.sponsoredTransitionRollbackStates.clear()
    this.externalCommitBroadcastRetryAttempts.clear()
    for (const timer of this.externalCommitBroadcastRetryTimers.values()) {
      clearTimeout(timer)
    }
    this.externalCommitBroadcastRetryTimers.clear()
    this.sponsoredTransitionRetryAttempts.clear()
    for (const timer of this.sponsoredTransitionRetryTimers.values()) {
      clearTimeout(timer)
    }
    this.sponsoredTransitionRetryTimers.clear()
    this.checkpointPersistChains.clear()
    this.recentCommitFingerprints.clear()
    this.recentHistoryBundleFingerprints.clear()
    this.inFlightHistoryBundleProcesses.clear()
    this.scopeRepairStates.clear()
    this.pendingRepairFetches.clear()
    this.lastRepairFetchAt.clear()

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
    listener?: ScopeListener,
    options: {
      skipRepairArtifacts?: boolean
    } = {}
  ): Promise<() => void> {
    const release = await this.acquireScopeWatch(scope, listener)

    try {
      if (!options.skipRepairArtifacts) {
        await this.processPendingRepairArtifacts(scope)
      }
      return release
    } catch (error) {
      release()
      throw error
    }
  }

  private async acquireScopeWatch(
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

    return groupHasMember(state, userId, ...this.resolveKnownUserAliases(userId))
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

  private dmGroupAlreadyConverged(scopeId: string, peerUserId: string): boolean {
    const state = this.groupStates.get(scopeId)
    if (!state) {
      return false
    }

    return groupHasMember(state, peerUserId)
  }

  private resolveKnownUserAliases(userId: string): string[] {
    const aliases = new Set<string>()
    const state = this.client.getState()

    if (state.user?.id === userId && state.user.username) {
      aliases.add(state.user.username)
    }

    for (const conversation of state.conversations) {
      for (const participant of conversation.participants) {
        if (participant.user_id === userId && participant.user?.username) {
          aliases.add(participant.user.username)
        }
      }
    }

    return [...aliases]
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
    return await this.withLockedScopeOperation(scope.id, async () => {
      this.scopeKinds.set(scope.id, scope.kind)

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
    const release = await this.acquireScopeWatch(scope)
    let attemptedPush = false
    let pushed = false
    let pushError: unknown = null

    try {
      try {
        pushed = await this.withReadyScopeOperation(scope, true, async () => {
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

          attemptedPush = true
          const sent = await this.client.pushScopeEvent(scope.kind, scope.id, 'new_message', messagePayload)

          return sent
        })
      } catch (error) {
        pushError = error
      }

      if (pushed) {
        return
      }

      if (
        attemptedPush &&
        options.clientNonce &&
        await this.confirmDeliveredSend(scope, options.clientNonce)
      ) {
        return
      }

      if (pushError) {
        throw pushError
      }

      throw new Error(`Failed to send message in ${scopeTopic(scope)}`)
    } finally {
      release()
    }
  }

  private async confirmDeliveredSend(
    scope: EncryptedScope,
    clientNonce: string
  ): Promise<boolean> {
    if (this.scopeHasClientNonce(scope.id, clientNonce)) {
      return true
    }

    const deadline = Date.now() + SEND_CONFIRMATION_WAIT_MS
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      if (this.scopeHasClientNonce(scope.id, clientNonce)) {
        return true
      }
    }

    try {
      const synced = await this.syncScope(scope, { limit: 50 })
      if (synced.messages.some((message) => message.raw.client_nonce === clientNonce)) {
        return true
      }
    } catch {
      // Preserve the original send failure if recovery sync also fails.
    }

    return this.scopeHasClientNonce(scope.id, clientNonce)
  }

  private scopeHasClientNonce(scopeId: string, clientNonce: string): boolean {
    return (this.scopeMessages.get(scopeId) ?? []).some(
      (message) => message.raw.client_nonce === clientNonce
    )
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
    await this.withLockedScopeOperation(scope.id, async () => {
      this.scopeKinds.set(scope.id, scope.kind)

      if (this.hasGroup(scope.id) && !await this.ensureCurrentGroupInfoPublished(scope.id)) {
        throw new Error(`Failed to publish GroupInfo for ${scopeTopic(scope)}`)
      }

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
      if (
        !await this.pushResyncRequestForScope(scope.id, scope.kind, {
          lastKnownEpoch: options.lastKnownEpoch ?? null,
          reason: options.reason ?? null,
          username: options.username ?? null
        })
      ) {
        throw new Error(`Failed to request resync for ${scopeTopic(scope)}`)
      }
    })
  }

  async requestHistorySync(
    scope: EncryptedScope,
    options: {
      force?: boolean
    } = {}
  ): Promise<void> {
    await this.withLockedScopeOperation(scope.id, async () => {
      this.scopeKinds.set(scope.id, scope.kind)
      await this.requestScopeHistorySync(scope, options.force ?? false)
    })
  }

  async drainScopeRepairArtifacts(
    scope: EncryptedScope,
    options: ScopeRepairDrainOptions = {}
  ): Promise<void> {
    this.scopeKinds.set(scope.id, scope.kind)
    await this.processPendingRepairArtifacts(scope, options.force ?? false)
  }

  async prepareScopeForRead(
    scope: EncryptedScope,
    options: ScopePreparationOptions = {}
  ): Promise<boolean> {
    const existing = this.inFlightScopePreparations.get(scope.id)
    if (existing) {
      return await existing
    }

    const run = this.prepareScopeForReadInternal(scope, options).finally(() => {
      this.inFlightScopePreparations.delete(scope.id)
    })

    this.inFlightScopePreparations.set(scope.id, run)
    return await run
  }

  async createScopeGroup(scope: EncryptedScope): Promise<boolean> {
    return await this.withLockedScopeOperation(scope.id, async () => {
      this.scopeKinds.set(scope.id, scope.kind)
      await this.createGroup(scope.id)
      if (!this.hasGroup(scope.id)) {
        return false
      }
      if (!await this.ensureCurrentGroupInfoPublished(scope.id)) {
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
      this.inFlightScopePreparations.delete(scopeId)
      this.recentScopeResyncRequests.delete(scopeId)
      this.recentScopeHistoryRequests.delete(scopeId)
      this.welcomeAppliedAtByScope.delete(scopeId)
      this.welcomeReceivedScopes.delete(scopeId)
      this.pendingGroupCreations.delete(scopeId)
      this.pendingBootstraps.delete(scopeId)
      this.welcomeInProgress.delete(scopeId)
      this.lastSuccessfulGroupInfoPublishEpochs.delete(scopeId)
      this.recentCommitFingerprints.delete(scopeId)
      this.recentHistoryBundleFingerprints.delete(scopeId)
      for (const key of [...this.inFlightHistoryBundleProcesses.keys()]) {
        if (key.startsWith(`${scopeId}:`)) {
          this.inFlightHistoryBundleProcesses.delete(key)
        }
      }
      this.scopeRepairStates.delete(scopeId)
      this.pendingRepairFetches.delete(scopeId)
      this.lastRepairFetchAt.delete(scopeId)
      this.checkpointPersistChains.delete(scopeId)
      await this.clearPendingGroupInfoPublish(scopeId)
      await this.clearPendingExternalCommitBroadcast(scopeId)
      await this.clearPendingSponsoredTransition(scopeId)
      this.notifyMembershipWaiters(scopeId, false)
      this.membershipWaiters.delete(scopeId)
      await this.storage.deleteGroupState(scopeId)
  }

  async applyScopeCommit(scopeId: string, commitData: string | null): Promise<boolean> {
    return await this.withLockedScopeOperation(scopeId, async () => {
      const result = await this.handleCommit(scopeId, commitData, 'applyScopeCommit')
      return result.status === 'applied' || result.status === 'already_applied'
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
      const draft = await this.prepareJoinRequest(scopeId, userId, deviceId)
      return draft ? this.rawSponsoredTransitionResult(draft) : null
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
      const draft = await this.prepareResyncRequest(scopeId, userId, deviceId)
      return draft ? this.rawSponsoredTransitionResult(draft) : null
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

  async recoverVoiceScopeState(
    scopeId: string,
    options: VoiceScopeRecoveryOptions = {}
  ): Promise<Uint8Array | null> {
    const existing = this.inFlightVoiceRecoveries.get(scopeId)
    if (existing) {
      return await existing
    }

    const run = this.withLockedScopeOperation(scopeId, async () => {
      return await this.recoverVoiceScopeStateLocked(scopeId, options)
    }).finally(() => {
      this.inFlightVoiceRecoveries.delete(scopeId)
    })

    this.inFlightVoiceRecoveries.set(scopeId, run)
    return await run
  }

  async handleVoiceScopeEvent(
    scopeId: string,
    event: string,
    payload: Record<string, unknown> | null,
    options: VoiceScopeRecoveryOptions = {}
  ): Promise<Uint8Array | null> {
    return await this.withLockedScopeOperation(scopeId, async () => {
      return await this.handleVoiceScopeEventLocked(scopeId, event, payload, options)
    }, 'urgent')
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
      const draft = await this.prepareResyncRequest(scope.id, userId, deviceId)
      return draft ? this.rawSponsoredTransitionResult(draft) : null
    })
  }

  async sponsorScopeJoin(
    scopeId: string,
    userId: string,
    deviceId: string | null = null,
    _options: {
      topic?: string | null
    } = {}
  ): Promise<boolean> {
    return await this.withLockedScopeOperation(scopeId, async () => {
      return await this.sponsorScopeJoinLocked(scopeId, userId, deviceId)
    })
  }

  async sponsorScopeResync(
    scopeId: string,
    userId: string,
    deviceId: string | null = null,
    _options: {
      topic?: string | null
    } = {}
  ): Promise<boolean> {
    return await this.withLockedScopeOperation(scopeId, async () => {
      return await this.sponsorScopeResyncLocked(scopeId, userId, deviceId)
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
    const release = await this.acquireScopeWatch(scope)
    try {
      await this.withReadyScopeOperation(scope, false, async () => {
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
    } finally {
      release()
    }
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
    const release = await this.acquireScopeWatch(scope)
    try {
      await this.pushReaction(scope, 'add_reaction', messageId, emoji)
    } finally {
      release()
    }
  }

  async removeReaction(scope: EncryptedScope, messageId: string, emoji: string): Promise<void> {
    const release = await this.acquireScopeWatch(scope)
    try {
      await this.pushReaction(scope, 'remove_reaction', messageId, emoji)
    } finally {
      release()
    }
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

        const currentState = this.groupStates.get(scope.id)

        // Both sides independently created MLS groups for this DM.
        // Use deterministic leader election (lower user ID wins) to break
        // the symmetry — the loser drops their group and External Commits
        // into the leader's group.
        if (localUserId < senderId) {
          // We're the leader — keep our group. Ensure GroupInfo is published
          // so the sender can External Commit in.
          await this.ensureCurrentGroupInfoPublished(scope.id)
          return { scope, event, payload }
        }

        if (
          currentState &&
          groupHasMember(currentState, localUserId) &&
          groupHasMember(currentState, senderId)
        ) {
          this.welcomeReceivedScopes.add(scope.id)
          return { scope, event, payload }
        }

        // We're not the leader — but if we already joined the leader's group
        // via External Commit or Welcome, we're done.
        if (this.welcomeReceivedScopes.has(scope.id)) {
          return { scope, event, payload }
        }

        // After restart we may replay an old join-all without the transient
        // "joined via Welcome/EC" marker. If the current DM group already
        // includes the sender, the request is stale and resetting would tear
        // down a converged group for no reason.
        if (this.dmGroupAlreadyConverged(scope.id, senderId)) {
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

    if (event === 'mls_history_request') {
      const requesterId = this.getString(payload, 'user_id')
      const requesterDeviceId = this.getString(payload, 'device_id')
      const localUserId = this.client.getAuthSession()?.user.id ?? this.client.getState().user?.id
      const localDeviceId = this.client.deviceIdentity?.id ?? null

      if (
        requesterId &&
        requesterDeviceId &&
        localUserId &&
        localDeviceId &&
        !(requesterId === localUserId && requesterDeviceId === localDeviceId) &&
        this.canSendHistoryBundleToRequester(scope.id, requesterId, requesterDeviceId)
      ) {
        await this.sendHistoryBundle(
          scope,
          requesterId,
          requesterDeviceId,
          this.getString(payload, 'id')
        )
      }

      return { scope, event, payload }
    }

    if (event === 'mls_history_bundle') {
      const recipientId = this.getString(payload, 'recipient_id')
      const recipientDeviceId = this.getString(payload, 'recipient_device_id')
      const localUserId = this.client.getAuthSession()?.user.id ?? this.client.getState().user?.id
      const localDeviceId = this.client.deviceIdentity?.id ?? null

      if (
        recipientId === localUserId &&
        recipientDeviceId === localDeviceId
      ) {
        await this.processHistoryBundle(scope, {
          id: this.getString(payload, 'id'),
          ciphertext: this.getString(payload, 'ciphertext') ?? '',
          mlsEpoch: this.getNumber(payload, 'mls_epoch')
        })
      }

      return { scope, event, payload }
    }

    if (event === 'mls_resync_request') {
      await this.processPendingResyncRequests(scope)
      return { scope, event, payload }
    }

    if (event === 'mls_commit') {
      const senderId = this.getString(payload, 'sender_id')
      const senderDeviceId = this.getString(payload, 'sender_device_id')
      const localUserId = this.client.getAuthSession()?.user.id ?? this.client.getState().user?.id
      const localDeviceId = this.client.deviceIdentity?.id ?? null

      if (senderId !== localUserId || senderDeviceId !== localDeviceId) {
        const result = await this.handleCommit(
          scope.id,
          this.getString(payload, 'commit_data'),
          'liveEvent'
        )

        if (result.status === 'applied' || result.status === 'already_applied') {
          await this.processPendingHistoryRequests(scope)
          await this.processPendingHistoryBundles(scope)
        }
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
    const localUserId = this.client.getAuthSession()?.user.id ?? this.client.getState().user?.id

    if (await this.ensureGroupMembership(channelId)) {
      await this.replayDurableEvents(channelId)
      if (!this.hasGroup(channelId)) {
        return false
      }

      if (!allowCreate) {
        return true
      }

      if (!localUserId) {
        return false
      }

      if (!await this.channelRequiresExternalJoin(channelId, localUserId)) {
        return true
      }

      if (this.getGroupEpoch(channelId) !== 0) {
        return true
      }

      if (!await this.ensureCurrentGroupInfoPublished(channelId)) {
        return false
      }

      await this.client.pushScopeEvent('channel', channelId, 'mls_request_join_all', {})
      return await this.awaitChannelJoinCoverage(channelId)
    }

    // ensureGroupMembership already tried External Commit. If it failed,
    // there may be no GroupInfo published yet (no group exists).
    if (!allowCreate) {
      return this.hasGroup(channelId)
    }

    if (await this.channelHasExistingActivity(channelId)) {
      return false
    }

    const ownerUserId = await this.resolveChannelOwnerId(channelId)
    if (!localUserId || ownerUserId == null || localUserId !== ownerUserId) {
      return false
    }

    await this.createGroup(channelId)
    if (!this.hasGroup(channelId)) {
      return false
    }

    if (!await this.ensureCurrentGroupInfoPublished(channelId)) {
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
    return await this.awaitChannelJoinCoverage(channelId)
  }

  private async primeEmptyChannelGroupIfOwner(channelId: string): Promise<boolean> {
    if (this.hasGroup(channelId)) {
      return true
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

    if (!await this.ensureCurrentGroupInfoPublished(channelId)) {
      return false
    }

    await this.client.pushScopeEvent('channel', channelId, 'mls_request_join_all', {})
    return true
  }

  private async awaitChannelJoinCoverage(channelId: string): Promise<boolean> {
    const advanced = await this.awaitEpochAdvance(channelId, 5_000)
    if (advanced || this.getGroupEpoch(channelId) !== 0) {
      return true
    }

    await this.replayDurableEvents(channelId).catch((error) =>
      this.logIgnoredError('replay channel durable events while waiting for join coverage', error)
    )

    return this.getGroupEpoch(channelId) !== 0
  }

  private async ensureDmGroupReady(conversationId: string, allowForce = false): Promise<boolean> {
    if (await this.ensureGroupMembership(conversationId)) {
      await this.replayDurableEvents(conversationId)
      if (!this.hasGroup(conversationId)) {
        return false
      }

      if (!allowForce) {
        return true
      }

      return await this.ensureDmParticipantCoverage(conversationId)
    }

    if (await this.bootstrapDmGroupIfLeader(conversationId)) {
      await this.replayDurableEvents(conversationId)
      return await this.ensureDmParticipantCoverage(conversationId)
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
    return await this.ensureDmParticipantCoverage(conversationId)
  }

  private async prepareScopeForReadInternal(
    scope: EncryptedScope,
    options: ScopePreparationOptions
  ): Promise<boolean> {
    this.scopeKinds.set(scope.id, scope.kind)

    const initiallyReady =
      scope.kind === 'dm'
        ? await this.ensureDmGroupReady(scope.id, false)
        : await this.ensureChannelGroupReady(scope.id, false)
    if (initiallyReady) {
      await this.processPendingRepairArtifacts(scope, true)
      return true
    }

    if (scope.kind === 'channel') {
      await this.primeEmptyChannelGroupIfOwner(scope.id)
      if (await this.ensureChannelGroupReady(scope.id, false)) {
        await this.processPendingRepairArtifacts(scope, true)
        return true
      }
    }

    const waitMs = scope.kind === 'dm' ? DM_PREPARE_WAIT_MS : JOIN_WAIT_MS
    if (await this.pollForScopeMembership(scope, waitMs)) {
      await this.replayDurableEvents(scope.id).catch((error) =>
        this.logIgnoredError('replay scope events during prepare', error)
      )
      await this.processPendingRepairArtifacts(scope, true)
      return this.hasGroup(scope.id)
    }

    if (scope.kind === 'channel' && !this.hasGroup(scope.id)) {
      this.ensureBackgroundChannelMembershipRetry(scope)
    }

    if (!await this.maybeRequestScopeResync(scope, options)) {
      return false
    }

    if (await this.pollForScopeMembership(scope, JOIN_WAIT_MS)) {
      await this.replayDurableEvents(scope.id).catch((error) =>
        this.logIgnoredError('replay scope events after resync prepare', error)
      )
    }

    await this.processPendingRepairArtifacts(scope, true)
    return this.hasGroup(scope.id)
  }

  private ensureBackgroundChannelMembershipRetry(scope: EncryptedScope): void {
    if (scope.kind !== 'channel' || this.hasGroup(scope.id)) {
      return
    }

    const existing = this.backgroundChannelMembershipRetries.get(scope.id)
    if (existing) {
      return
    }

    const run = (async () => {
      const deadline = Date.now() + OUTBOUND_SCOPE_READY_WAIT_MS

      while (Date.now() < deadline) {
        if (await this.ensureMembership(scope).catch(() => false)) {
          await this.replayDurableEvents(scope.id).catch((error) =>
            this.logIgnoredError('replay scope events during background retry', error)
          )
          return
        }

        await new Promise((resolve) => setTimeout(resolve, OUTBOUND_SCOPE_READY_RETRY_MS))
      }
    })().finally(() => {
      this.backgroundChannelMembershipRetries.delete(scope.id)
    })

    this.backgroundChannelMembershipRetries.set(scope.id, run)
  }

  private async pollForScopeMembership(
    scope: EncryptedScope,
    timeoutMs: number
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const ready = await this.ensureMembership(scope).catch(() => false)
      if (ready || this.hasGroup(scope.id)) {
        return true
      }

      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    return this.hasGroup(scope.id)
  }

  private async maybeRequestScopeResync(
    scope: EncryptedScope,
    options: ScopePreparationOptions
  ): Promise<boolean> {
    const localIdentity = this.getLocalSessionIdentity()
    if (!localIdentity) {
      return false
    }

    const now = Date.now()
    const lastRequestAt = this.recentScopeResyncRequests.get(scope.id) ?? 0
    if (now - lastRequestAt < VOICE_RESYNC_REQUEST_COOLDOWN_MS) {
      return true
    }

    const pushed = await this.pushResyncRequestForScope(scope.id, scope.kind, {
      lastKnownEpoch: options.lastKnownEpoch ?? this.getGroupEpoch(scope.id),
      reason: options.reason ?? 'missing_state',
      username: localIdentity.username
    })
    if (pushed) {
      this.recentScopeResyncRequests.set(scope.id, now)
    }

    return pushed
  }

  /** Core private impl: checks in-memory group state, falls back to persisted storage, then tries External Commit, then Welcome. */
  private async ensureGroupMembership(scopeId: string): Promise<boolean> {
    if (this.hasGroup(scopeId)) {
      await this.processPendingCommits(scopeId)
      return true
    }

    const checkpoint = await this.storage.loadScopeCheckpoint(scopeId)
    if (checkpoint.groupState) {
      try {
        const state = deserializeGroupState(new Uint8Array(checkpoint.groupState.state))
        this.groupStates.set(scopeId, state)
        this.diagnostics.updateEpoch(scopeId, checkpoint.groupState.epoch)
        this.recentCommitFingerprints.set(scopeId, [...checkpoint.recentCommitFingerprints])
        this.recentHistoryBundleFingerprints.set(
          scopeId,
          [...checkpoint.recentHistoryBundleFingerprints]
        )
        const repairState = toScopeRepairState(checkpoint.repairState)
        if (repairState) {
          this.scopeRepairStates.set(scopeId, repairState)
        }
        if (checkpoint.pendingGroupInfoPublish) {
          this.pendingGroupInfoPublishes.set(scopeId, {
            groupInfoData: checkpoint.pendingGroupInfoPublish.groupInfoData,
            ratchetTreeData: checkpoint.pendingGroupInfoPublish.ratchetTreeData,
            epoch: checkpoint.pendingGroupInfoPublish.epoch
          })
        } else {
          this.lastSuccessfulGroupInfoPublishEpochs.set(scopeId, checkpoint.groupState.epoch)
        }
        if (checkpoint.pendingExternalCommitBroadcast) {
          this.pendingExternalCommitBroadcasts.set(scopeId, {
            commitData: checkpoint.pendingExternalCommitBroadcast.commitData,
            commitId: checkpoint.pendingExternalCommitBroadcast.commitId
          })
        }
        if (checkpoint.pendingSponsoredTransition) {
          this.pendingSponsoredTransitions.set(scopeId, {
            recipientId: checkpoint.pendingSponsoredTransition.recipientId,
            recipientClientId: checkpoint.pendingSponsoredTransition.recipientClientId,
            recipientKeyPackageRef: checkpoint.pendingSponsoredTransition.recipientKeyPackageRef,
            commitData: checkpoint.pendingSponsoredTransition.commitData,
            commitId: checkpoint.pendingSponsoredTransition.commitId,
            removeCommitData: checkpoint.pendingSponsoredTransition.removeCommitData,
            welcomeData: checkpoint.pendingSponsoredTransition.welcomeData,
            groupInfoData: checkpoint.pendingSponsoredTransition.groupInfoData,
            ratchetTreeData: checkpoint.pendingSponsoredTransition.ratchetTreeData,
            epoch: checkpoint.pendingSponsoredTransition.epoch,
            previousEpoch: checkpoint.pendingSponsoredTransition.previousEpoch,
            baseState: checkpoint.pendingSponsoredTransition.baseState,
            baseEpoch: checkpoint.pendingSponsoredTransition.baseEpoch
          })
        }
        await this.processPendingCommits(scopeId)
        this.notifyMembershipWaiters(scopeId, true)
        return true
      } catch {
        this.groupStates.delete(scopeId)
        this.lastSuccessfulGroupInfoPublishEpochs.delete(scopeId)
        this.recentCommitFingerprints.delete(scopeId)
        this.recentHistoryBundleFingerprints.delete(scopeId)
        this.scopeRepairStates.delete(scopeId)
        this.pendingSponsoredTransitions.delete(scopeId)
        this.sponsoredTransitionRollbackStates.delete(scopeId)
      }
    }

    // Device-targeted Welcomes need priority over External Commit. If we
    // external-commit past a pending Welcome, we can strand earlier messages
    // that were encrypted for the sponsored epoch before this device opened
    // the scope.
    let welcomes: Awaited<ReturnType<typeof fetchPendingWelcomes>> = []
    try {
      welcomes = await fetchPendingWelcomes(scopeId, this.client.getHttpClient())
    } catch {
      // Server unreachable or error; continue to External Commit.
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

    // External Commit (RFC 9420 §12.4) remains the canonical live join path
    // when no device-targeted Welcome is waiting.
    if (await this.tryJoinViaExternalCommit(scopeId)) {
      return true
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

        // Atomically publish the new GroupInfo and durable mls_commit so the
        // server never advertises an epoch that existing members cannot replay.
        const result = await publishExternalCommitGroupInfo(
          scopeId,
          exportGroupInfo(state),
          exportRatchetTree(state),
          newEpoch,
          groupInfo.epoch,
          commitData,
          commitId,
          this.client.getHttpClient()
        )

        if (result === 'conflict') {
          if (attempt < MAX_RETRIES - 1) {
            // Another joiner won this epoch. Jitter and retry with fresh GroupInfo.
            await new Promise(r => setTimeout(r, 50 + Math.floor(Math.random() * 300 * (attempt + 1))))
            continue
          }
          return false
        }

        // The server has durably stored and broadcast the External Commit.
        // Persist locally before returning success so retries never build on
        // an epoch that this client failed to save.
        await this.setGroupState(scopeId, state, { publishGroupInfo: false })
        this.lastSuccessfulGroupInfoPublishEpochs.set(scopeId, newEpoch)
        // Mark as joined so the mls_request_join_all handler won't reset and re-EC.
        this.welcomeReceivedScopes.add(scopeId)
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

      for (const event of events) {
        if (
          event.event_type === 'mls_commit' &&
          typeof event.payload.commit_data === 'string' &&
          !(
            event.sender_id === session.user.id &&
            event.sender_device_id === localDeviceId
          )
        ) {
          const result = await this.handleCommit(scopeId, event.payload.commit_data, 'replayDurable', {
            replaySeq: event.seq
          })
          if (
            result.status !== 'applied' &&
            result.status !== 'already_applied'
          ) {
            // Advance cursor past the failed commit so we don't retry it
            // forever. The commit might be from a forked epoch or a removed
            // member — retrying won't help and blocks all subsequent events.
            await this.storage.saveGroupSyncCursor(scopeId, event.seq)
            continue
          }
        } else {
          await this.storage.saveGroupSyncCursor(scopeId, event.seq)
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
      }

      cursor = Math.max(cursor, events.at(-1)?.seq ?? cursor)

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
      waitForHistoryRecovery?: boolean
    } = {}
  ): Promise<ProcessedScopeMessage> {
    const scopeId = scope.id
    const ciphertext = typeof rawMessage.ciphertext === 'string' ? rawMessage.ciphertext : null
    let content = typeof rawMessage.content === 'string' ? rawMessage.content : ''
    let encrypted = false
    let decryptionFailed = false
    let plaintext: string | null = typeof rawMessage.content === 'string' ? rawMessage.content : null
    const allowCachedMessageDecryption = options.allowCachedMessageDecryption ?? true
    const waitForHistoryRecovery = options.waitForHistoryRecovery ?? true

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
        (await this.decryptForScopeWithRecovery(
          scope,
          ciphertext,
          rawMessage.mls_epoch ?? null,
          rawMessage.id,
          {
            waitForHistoryRecovery
          }
        ))
      const recoveredCachedPlaintext =
        decrypted ??
        (allowCachedMessageDecryption
          ? await this.storage.loadCachedMessageDecryption(rawMessage.id)
          : null)

      if (recoveredCachedPlaintext) {
        plaintext = recoveredCachedPlaintext
        content = coerceDisplayText(recoveredCachedPlaintext)
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

  private async pushResyncRequestForScope(
    scopeId: string,
    kind: EncryptedScope['kind'] | null,
    options: {
      lastKnownEpoch?: number | null
      reason?: string | null
      username?: string | null
    } = {}
  ): Promise<boolean> {
    await this.client.replenishKeyPackages()

    const payload = {
      device_id: this.client.deviceIdentity?.id,
      request_id: crypto.randomUUID(),
      last_known_epoch: options.lastKnownEpoch ?? null,
      reason: options.reason ?? null,
      username: options.username ?? null
    }

    if (scopeId.startsWith('voice:')) {
      return await this.client.pushTopicEventWithAck(scopeId, 'mls_resync_request', payload)
    }

    if (!kind) {
      kind = this.scopeKinds.get(scopeId) ?? null
    }

    if (!kind) {
      return false
    }

    return await this.client.pushScopeEvent(kind, scopeId, 'mls_resync_request', payload)
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

  private rawSponsoredTransitionResult(draft: PreparedSponsoredTransition): {
    removeCommitBytes: string | null
    commitBytes: string
    welcomeBytes: string | null
    keyPackageRef: string
  } {
    return {
      removeCommitBytes: draft.removeCommitData,
      commitBytes: draft.commitData,
      welcomeBytes: draft.welcomeData,
      keyPackageRef: draft.recipientKeyPackageRef ?? ''
    }
  }

  private async prepareJoinRequest(
    scopeId: string,
    userId: string,
    deviceId: string | null
  ): Promise<PreparedSponsoredTransition | null> {
    try {
      await this.replayDurableEvents(scopeId)
      const state = this.groupStates.get(scopeId)
      if (!state) {
        return null
      }

      await initCipherSuite()
      const keyPackageBytes = await fetchKeyPackage(
        userId,
        deviceId ?? undefined,
        this.client.getHttpClient()
      )
      if (!keyPackageBytes) {
        return null
      }

      const requestedIdentity = deviceId
        ? buildClientCredentialIdentity(userId, deviceId)
        : userId

      if (
        requestedIdentity &&
        findExactMemberLeafIndex(state, requestedIdentity) !== null
      ) {
        return null
      }

      const added = await addMemberToGroup(this.cloneGroupState(state), keyPackageBytes)
      const commitData = uint8ToBase64(added.commitBytes)
      const baseEpoch = Number(state.groupContext.epoch)

      return {
        recipientId: userId,
        recipientClientId: deviceId,
        recipientKeyPackageRef: uint8ToBase64(keyPackageBytes),
        commitData,
        commitId: await this.computeMlsCommitId(scopeId, commitData),
        removeCommitData: null,
        welcomeData: added.welcomeBytes ? uint8ToBase64(added.welcomeBytes) : null,
        groupInfoData: exportGroupInfo(added.newState),
        ratchetTreeData: exportRatchetTree(added.newState),
        epoch: Number(added.newState.groupContext.epoch),
        previousEpoch: baseEpoch,
        baseState: serializeGroupState(state),
        baseEpoch,
        newState: added.newState
      }
    } catch {
      return null
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
        this.setScopeRepairState(scopeId, 'healthy', null, { persist: true })
        await this.storage.consumeKeyPackage(localPackage.id)
        await this.processPendingCommits(scopeId)
        await this.processPendingHistoryBundles(this.scopeForId(scopeId))
        await this.requestScopeHistorySync(this.scopeForId(scopeId), true)
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

  private async handleCommit(
    scopeId: string,
    commitData: string | null,
    source = 'unknown',
    options: {
      replaySeq?: number | null
    } = {}
  ): Promise<CommitHandlingResult> {
    if (!commitData) {
      return {
        status: 'needs_repair',
        error: 'missing_commit_data'
      }
    }

    const fingerprint = await sha256Hex(`${scopeId}\ncommit\n${commitData}`)
    const currentState = this.groupStates.get(scopeId)
    if (!currentState) {
      const pending = this.pendingCommits.get(scopeId) ?? []
      if (!pending.includes(commitData)) {
        pending.push(commitData)
      }
      this.pendingCommits.set(scopeId, pending)
      return { status: 'buffered_waiting_for_state' }
    }

    if (this.hasRecentCommitFingerprint(scopeId, fingerprint)) {
      if (typeof options.replaySeq === 'number') {
        await this.persistCommitAppliedState(
          scopeId,
          currentState,
          fingerprint,
          options.replaySeq,
          { publishGroupInfo: false }
        )
      }
      this.diagnostics.recordCommit(scopeId, true)
      return {
        status: 'already_applied',
        fingerprint
      }
    }

    try {
      await initCipherSuite()
      const nextState = await processCommitMessage(
        this.cloneGroupState(currentState),
        Buffer.from(commitData, 'base64')
      )
      await this.persistCommitAppliedState(
        scopeId,
        nextState,
        fingerprint,
        options.replaySeq ?? null
      )
      this.diagnostics.recordCommit(scopeId, true)
      this.notifyMembershipWaiters(scopeId, true)
      this.setScopeRepairState(scopeId, 'healthy', null, { persist: true })
      return {
        status: 'applied',
        fingerprint
      }
    } catch (error) {
      this.diagnostics.recordCommit(scopeId, false)
      const message = error instanceof Error ? error.message : String(error)
      this.setScopeRepairState(scopeId, 'needs_repair', message, {
        incrementFailure: true,
        persist: true
      })
      return {
        status: 'needs_repair',
        error: message
      }
    }
  }

  private async prepareResyncRequest(
    scopeId: string,
    userId: string,
    deviceId: string | null
  ): Promise<PreparedSponsoredTransition | null> {
    try {
      await this.replayDurableEvents(scopeId)
      const state = this.groupStates.get(scopeId)
      if (!state) {
        return null
      }

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
      let removeCommitData: string | null = null

      const existingLeafIndex = findExactMemberLeafIndex(workingState, requestedIdentity)

      if (existingLeafIndex !== null) {
        const removed = await removeMemberFromGroup(workingState, existingLeafIndex)
        workingState = removed.newState
        removeCommitData = uint8ToBase64(removed.commitBytes)
      }

      if (
        requestedIdentity &&
        findExactMemberLeafIndex(workingState, requestedIdentity) !== null
      ) {
        return null
      }

      const added = await addMemberToGroup(workingState, keyPackageBytes)
      const commitData = uint8ToBase64(added.commitBytes)
      const baseEpoch = Number(state.groupContext.epoch)

      return {
        recipientId: userId,
        recipientClientId: deviceId,
        recipientKeyPackageRef: uint8ToBase64(keyPackageBytes),
        commitData,
        commitId: await this.computeMlsCommitId(scopeId, commitData),
        removeCommitData,
        welcomeData: added.welcomeBytes ? uint8ToBase64(added.welcomeBytes) : null,
        groupInfoData: exportGroupInfo(added.newState),
        ratchetTreeData: exportRatchetTree(added.newState),
        epoch: Number(added.newState.groupContext.epoch),
        previousEpoch: baseEpoch,
        baseState: serializeGroupState(state),
        baseEpoch,
        newState: added.newState
      }
    } catch {
      return null
    }
  }

  private async sponsorScopeJoinLocked(
    scopeId: string,
    userId: string,
    deviceId: string | null
  ): Promise<boolean> {
    if (this.pendingSponsoredTransitions.has(scopeId)) {
      await this.flushPendingSponsoredTransition(scopeId, { flushGroupInfoOnSuccess: false })
      if (this.pendingSponsoredTransitions.has(scopeId)) {
        return false
      }
    }

    if (!await this.ensureCurrentGroupInfoPublished(scopeId)) {
      return false
    }

    const draft = await this.prepareJoinRequest(scopeId, userId, deviceId)
    if (!draft) {
      return false
    }

    return await this.commitSponsoredTransition(
      scopeId,
      draft,
      this.groupStates.get(scopeId) ? this.cloneGroupState(this.groupStates.get(scopeId)!) : null
    )
  }

  private async sponsorScopeResyncLocked(
    scopeId: string,
    userId: string,
    deviceId: string | null
  ): Promise<boolean> {
    if (this.pendingSponsoredTransitions.has(scopeId)) {
      await this.flushPendingSponsoredTransition(scopeId, { flushGroupInfoOnSuccess: false })
      if (this.pendingSponsoredTransitions.has(scopeId)) {
        return false
      }
    }

    if (!await this.ensureCurrentGroupInfoPublished(scopeId)) {
      return false
    }

    const draft = await this.prepareResyncRequest(scopeId, userId, deviceId)
    if (!draft) {
      return false
    }

    return await this.commitSponsoredTransition(
      scopeId,
      draft,
      this.groupStates.get(scopeId) ? this.cloneGroupState(this.groupStates.get(scopeId)!) : null
    )
  }

  private scopeForId(scopeId: string): EncryptedScope {
    return {
      kind: this.scopeKinds.get(scopeId) ?? 'channel',
      id: scopeId
    }
  }

  private async requestScopeHistorySync(
    scope: EncryptedScope,
    force = false
  ): Promise<void> {
    if (!this.hasGroup(scope.id)) {
      return
    }

    const localDeviceId = this.client.deviceIdentity?.id ?? null
    if (!localDeviceId) {
      return
    }

    const now = Date.now()
    const lastRequestAt = this.recentScopeHistoryRequests.get(scope.id) ?? 0
    if (!force && now - lastRequestAt < HISTORY_SYNC_REQUEST_COOLDOWN_MS) {
      await this.processPendingHistoryBundles(scope)
      return
    }

    const pushed = await this.client.pushScopeEvent(scope.kind, scope.id, 'mls_history_request', {
      device_id: localDeviceId
    })
    if (!pushed && !force) {
      return
    }

    if (pushed) {
      this.recentScopeHistoryRequests.set(scope.id, now)
    }

    await this.processPendingHistoryBundles(scope)
  }

  private async processPendingResyncRequests(scope: EncryptedScope): Promise<void> {
    if (!this.hasGroup(scope.id)) {
      return
    }

    const localUserId = this.client.getAuthSession()?.user.id ?? this.client.getState().user?.id
    const localDeviceId = this.client.deviceIdentity?.id ?? null
    if (!localUserId || !localDeviceId) {
      return
    }

    let requests: Awaited<ReturnType<typeof fetchPendingResyncRequests>> = []
    try {
      requests = await fetchPendingResyncRequests(scope.id, this.client.getHttpClient())
    } catch {
      return
    }

    for (const request of requests) {
      if (
        request.requester_id === localUserId &&
        request.requester_client_id === localDeviceId
      ) {
        continue
      }

      const requesterAlreadyJoined =
        request.requester_client_id != null &&
        this.hasMemberDevice(scope.id, request.requester_id, request.requester_client_id)

      if (requesterAlreadyJoined) {
        if (this.canSendHistoryBundleToRequester(
          scope.id,
          request.requester_id,
          request.requester_client_id
        )) {
          await this.sendHistoryBundle(
            scope,
            request.requester_id,
            request.requester_client_id
          )
        }

        await ackPendingResyncRequest(
          request.id,
          request.request_id,
          this.client.getHttpClient()
        ).catch((error) => this.logIgnoredError('ack pending resync request', error))
        continue
      }

      const sponsored = await this.sponsorScopeResync(
        scope.id,
        request.requester_id,
        request.requester_client_id ?? null
      )
      if (!sponsored) {
        continue
      }

      if (this.canSendHistoryBundleToRequester(
        scope.id,
        request.requester_id,
        request.requester_client_id
      )) {
        await this.sendHistoryBundle(
          scope,
          request.requester_id,
          request.requester_client_id
        )
      }

      await ackPendingResyncRequest(
        request.id,
        request.request_id,
        this.client.getHttpClient()
      ).catch((error) => this.logIgnoredError('ack pending resync request', error))
    }
  }

  private async processPendingHistoryRequests(scope: EncryptedScope): Promise<void> {
    if (!this.hasGroup(scope.id)) {
      return
    }

    const localUserId = this.client.getAuthSession()?.user.id ?? this.client.getState().user?.id
    const localDeviceId = this.client.deviceIdentity?.id ?? null
    if (!localUserId || !localDeviceId) {
      return
    }

    let requests: Awaited<ReturnType<typeof fetchPendingHistoryRequests>> = []
    try {
      requests = await fetchPendingHistoryRequests(scope.id, this.client.getHttpClient())
    } catch {
      return
    }

    for (const request of requests) {
      if (!request.requester_client_id) {
        continue
      }

      if (
        request.requester_id === localUserId &&
        request.requester_client_id === localDeviceId
      ) {
        continue
      }

      const canSend = this.canSendHistoryBundleToRequester(
        scope.id,
        request.requester_id,
        request.requester_client_id
      )
      if (!canSend) {
        continue
      }

      await this.sendHistoryBundle(
        scope,
        request.requester_id,
        request.requester_client_id,
        request.id
      )
    }
  }

  private async processPendingHistoryBundles(scope: EncryptedScope): Promise<void> {
    const localUserId = this.client.getAuthSession()?.user.id ?? this.client.getState().user?.id
    const localDeviceId = this.client.deviceIdentity?.id ?? null
    if (!localUserId || !localDeviceId) {
      return
    }

    let bundles: Awaited<ReturnType<typeof fetchPendingHistoryBundles>> = []
    try {
      bundles = await fetchPendingHistoryBundles(scope.id, this.client.getHttpClient())
    } catch {
      return
    }

    for (const bundle of bundles) {
      if (
        bundle.recipient_id !== localUserId ||
        bundle.recipient_client_id !== localDeviceId
      ) {
        continue
      }

      await this.processHistoryBundle(scope, {
        id: bundle.id,
        ciphertext: bundle.ciphertext,
        mlsEpoch: bundle.mls_epoch
      })
    }
  }

  private async sendHistoryBundle(
    scope: EncryptedScope,
    recipientId: string,
    recipientDeviceId: string,
    pendingRequestId: string | null = null
  ): Promise<void> {
    const scopeId = scope.id
    const cachedMessages = await this.storage.loadCachedMessages(scopeId).catch(() => [])
    const knownMessages = this.scopeMessages.get(scopeId) ?? []
    const knownMessagesById = new Map(knownMessages.map((message) => [message.id, message]))
    const bundledIds = new Set<string>()
    const items: HistoryBundleItem[] = []

    for (const cachedMessage of [...cachedMessages].sort((left, right) =>
      left.insertedAt.localeCompare(right.insertedAt)
    )) {
      if (bundledIds.has(cachedMessage.id)) {
        continue
      }

      const knownMessage = knownMessagesById.get(cachedMessage.id)
      const content =
        (knownMessage && !knownMessage.decryptionFailed ? knownMessage.plaintext : null) ??
        cachedMessage.decryptedContent ??
        (cachedMessage.ciphertext
          ? await this.storage.loadSentMessagePlaintext(uint8ToBase64(cachedMessage.ciphertext))
          : null) ??
        (cachedMessage.ciphertext
          ? await this.storage.loadCachedMessageDecryption(cachedMessage.id)
          : null)

      if (!content) {
        continue
      }

      items.push({
        id: cachedMessage.id,
        content,
        channelId: cachedMessage.channelId,
        conversationId: cachedMessage.conversationId,
        serverId: cachedMessage.serverId,
        senderId: cachedMessage.senderId,
        sender:
          knownMessage?.raw.sender ??
          (cachedMessage.senderId && cachedMessage.senderUsername
            ? {
                id: cachedMessage.senderId,
                username: cachedMessage.senderUsername,
                display_name: null,
                avatar_url: null
              }
            : null),
        insertedAt: cachedMessage.insertedAt,
        parentMessageId: cachedMessage.parentMessageId
      })
      bundledIds.add(cachedMessage.id)
    }

    for (const message of knownMessages) {
      if (bundledIds.has(message.id) || message.decryptionFailed || !message.plaintext) {
        continue
      }

      items.push({
        id: message.id,
        content: message.plaintext,
        channelId: message.raw.channel_id ?? message.channelId,
        conversationId: message.raw.conversation_id ?? message.conversationId,
        serverId: message.raw.server_id ?? null,
        senderId: message.senderId,
        sender: message.raw.sender ?? null,
        insertedAt: message.insertedAt,
        expiresAt: message.raw.expires_at ?? null,
        parentMessageId: message.parentMessageId
      })
      bundledIds.add(message.id)
    }

    if (items.length === 0) {
      return
    }

    const bundlePayload = encodePayload({
      v: 1,
      type: 'text',
      text: JSON.stringify(items)
    })
    const encrypted = await this.encryptForScope(scopeId, bundlePayload)

    const pushed = await this.client.pushScopeEvent(scope.kind, scope.id, 'mls_history_bundle', {
      ciphertext: encrypted.ciphertext,
      mls_epoch: encrypted.epoch,
      recipient_id: recipientId,
      recipient_device_id: recipientDeviceId
    })
    if (pushed && pendingRequestId) {
      await ackPendingHistoryRequest(pendingRequestId, this.client.getHttpClient()).catch((error) =>
        this.logIgnoredError('ack pending history request', error)
      )
    }
  }

  private canSendHistoryBundleToRequester(
    scopeId: string,
    requesterId: string,
    requesterDeviceId: string | null
  ): requesterDeviceId is string {
    return (
      typeof requesterDeviceId === 'string' &&
      requesterDeviceId.length > 0 &&
      this.hasMemberDevice(scopeId, requesterId, requesterDeviceId)
    )
  }

  private async processHistoryBundle(
    scope: EncryptedScope,
    input: {
      id: string | null
      ciphertext: string
      mlsEpoch: number | null
    }
  ): Promise<void> {
    const fingerprint = await this.computeHistoryBundleFingerprint(scope.id, input.ciphertext)

    if (this.hasRecentHistoryBundleFingerprint(scope.id, fingerprint)) {
      await this.ackHistoryBundleIfNeeded(input.id)
      return
    }

    const processKey = `${scope.id}:${fingerprint}`
    const existingProcess = this.inFlightHistoryBundleProcesses.get(processKey)
    if (existingProcess) {
      if (await existingProcess) {
        await this.ackHistoryBundleIfNeeded(input.id)
      }
      return
    }

    const run = this.processHistoryBundleOnce(scope, input, fingerprint)
    this.inFlightHistoryBundleProcesses.set(processKey, run)

    try {
      if (await run) {
        await this.ackHistoryBundleIfNeeded(input.id)
      }
    } finally {
      if (this.inFlightHistoryBundleProcesses.get(processKey) === run) {
        this.inFlightHistoryBundleProcesses.delete(processKey)
      }
    }
  }

  private async processHistoryBundleOnce(
    scope: EncryptedScope,
    input: {
      id: string | null
      ciphertext: string
      mlsEpoch: number | null
    },
    fingerprint: string
  ): Promise<boolean> {
    const decrypted = await this.decryptHistoryBundle(scope, input.ciphertext, input.mlsEpoch)
    if (!decrypted) {
      return false
    }

    let items: HistoryBundleItem[] = []
    try {
      const payload = decodePayload(decrypted)
      if (payload.type !== 'text' || !payload.text) {
        return false
      }

      const parsed = JSON.parse(payload.text)
      if (!Array.isArray(parsed)) {
        return false
      }

      items = parsed
        .map((value) => normalizeHistoryBundleItem(value))
        .filter((value): value is HistoryBundleItem => value != null)
    } catch {
      return false
    }

    if (items.length === 0) {
      return false
    }

    const existingMessages = this.scopeMessages.get(scope.id) ?? []
    const existingMessagesById = new Map(existingMessages.map((message) => [message.id, message]))
    const cachedMessages = await this.storage.loadCachedMessages(scope.id).catch(() => [])
    const cachedMessagesById = new Map(cachedMessages.map((message) => [message.id, message]))
    const contentById = new Map(items.map((item) => [item.id, item.content]))
    const displayContentById = new Map(
      items.map((item) => [item.id, coerceDisplayText(item.content)] as const)
    )
    const existingIds = new Set(existingMessages.map((message) => message.id))

    const patched = existingMessages.map((message) => {
      const plaintext = contentById.get(message.id)
      const content = displayContentById.get(message.id)
      if (!plaintext || !content) {
        return message
      }

      return {
        ...message,
        content,
        plaintext,
        decryptionFailed: false,
        encrypted: true
      }
    })

    const insertedMessages: ProcessedScopeMessage[] = items
      .filter((item) => !existingIds.has(item.id))
      .map((item) => {
        const insertedAt = item.insertedAt ?? new Date().toISOString()
        const channelId = item.channelId ?? (scope.kind === 'channel' ? scope.id : null)
        const conversationId =
          item.conversationId ?? (scope.kind === 'dm' ? scope.id : null)
        const sender = item.sender ?? null

        return {
          id: item.id,
          scopeId: scope.id,
          channelId,
          conversationId,
          senderId: item.senderId ?? sender?.id ?? null,
          senderUsername: sender?.username ?? null,
          parentMessageId: item.parentMessageId ?? null,
          insertedAt,
          content: coerceDisplayText(item.content),
          plaintext: item.content,
          encrypted: true,
          decryptionFailed: false,
          raw: {
            id: item.id,
            room_seq: null,
            channel_id: channelId,
            conversation_id: conversationId,
            server_id: item.serverId ?? null,
            sender_id: item.senderId ?? sender?.id ?? null,
            sender,
            parent_message_id: item.parentMessageId ?? null,
            inserted_at: insertedAt,
            expires_at: item.expiresAt ?? null,
            attachments: [],
            reactions: [],
            mls_epoch: null
          }
        }
      })

    this.scopeMessages.set(
      scope.id,
      sortMessages([...patched, ...insertedMessages]).slice(-MAX_MESSAGES_PER_SCOPE)
    )

    await Promise.all(
      items.map(async (item) => {
        const existingMessage = existingMessagesById.get(item.id) ?? null
        const cachedMessage = cachedMessagesById.get(item.id) ?? null
        const sender = item.sender ?? existingMessage?.raw.sender ?? null
        const channelId =
          item.channelId ??
          existingMessage?.channelId ??
          cachedMessage?.channelId ??
          (scope.kind === 'channel' ? scope.id : null)
        const conversationId =
          item.conversationId ??
          existingMessage?.conversationId ??
          cachedMessage?.conversationId ??
          (scope.kind === 'dm' ? scope.id : null)
        const ciphertext =
          cachedMessage?.ciphertext ??
          (typeof existingMessage?.raw.ciphertext === 'string'
            ? Buffer.from(existingMessage.raw.ciphertext, 'base64')
            : null)
        const insertedAt =
          item.insertedAt ??
          existingMessage?.insertedAt ??
          cachedMessage?.insertedAt ??
          new Date().toISOString()

        await this.storage.saveCachedMessageDecryption(item.id, item.content).catch(() => {})
        await this.storage.cacheMessage({
          id: item.id,
          roomSeq: cachedMessage?.roomSeq ?? existingMessage?.raw.room_seq ?? null,
          channelId,
          conversationId,
          serverId:
            item.serverId ??
            existingMessage?.raw.server_id ??
            cachedMessage?.serverId ??
            null,
          senderId:
            item.senderId ??
            existingMessage?.senderId ??
            cachedMessage?.senderId ??
            sender?.id ??
            null,
          senderUsername:
            sender?.username ??
            existingMessage?.senderUsername ??
            cachedMessage?.senderUsername ??
            null,
          parentMessageId:
            item.parentMessageId ??
            existingMessage?.parentMessageId ??
            cachedMessage?.parentMessageId ??
            null,
          ciphertext,
          decryptedContent: item.content,
          mlsEpoch: cachedMessage?.mlsEpoch ?? existingMessage?.raw.mls_epoch ?? input.mlsEpoch,
          insertedAt
        }).catch(() => {})
        await this.storage
          .indexDecryptedMessage(item.id, scope.id, coerceDisplayText(item.content))
          .catch(() => {})
      })
    )

    await this.persistHistoryBundleAppliedState(scope.id, fingerprint)
    this.setScopeRepairState(scope.id, 'healthy', null, { persist: true })
    return true
  }

  private async ackHistoryBundleIfNeeded(bundleId: string | null): Promise<void> {
    if (!bundleId) {
      return
    }

    await ackPendingHistoryBundle(bundleId, this.client.getHttpClient()).catch((error) =>
      this.logIgnoredError('ack pending history bundle', error)
    )
  }

  private async decryptHistoryBundle(
    scope: EncryptedScope,
    ciphertext: string,
    mlsEpoch: number | null
  ): Promise<string | null> {
    const decrypted = await this.decryptForScope(scope.id, ciphertext)
    if (decrypted) {
      return decrypted
    }

    const localEpoch = this.getGroupEpoch(scope.id)
    const shouldReplay =
      localEpoch != null &&
      (mlsEpoch == null || !Number.isFinite(mlsEpoch) || mlsEpoch >= localEpoch)

    if (!shouldReplay) {
      return null
    }

    await this.replayDurableEvents(scope.id)
    return await this.decryptForScope(scope.id, ciphertext)
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

      const result = await this.handleCommit(scopeId, commitData, 'pendingCommit')
      if (result.status === 'needs_repair' || result.status === 'buffered_waiting_for_state') {
        blocked = true
        remaining.push(commitData)
      }
    }

    if (remaining.length > 0) {
      this.pendingCommits.set(scopeId, remaining)
    }
  }

  private async commitSponsoredTransition(
    scopeId: string,
    draft: PreparedSponsoredTransition,
    rollbackState: GroupState | null
  ): Promise<boolean> {
    await this.persistSponsoredTransition(scopeId, draft, rollbackState)

    return await this.flushPendingSponsoredTransition(scopeId, {
      flushGroupInfoOnSuccess: false
    })
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
    // NOTE: This function is always called from within withLockedScopeOperation
    // (via withReadyScopeOperation in sendPayload, or via pushReaction).
    // Do NOT add withLockedScopeOperation here — it would deadlock because
    // withGroupLock is a non-reentrant serializing queue.
    if (this.pendingSponsoredTransitions.has(scopeId)) {
      throw new Error(`Membership update for ${scopeId} is still syncing`)
    }

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

  private async decryptForScopeWithRecovery(
    scope: EncryptedScope,
    ciphertext: string,
    messageEpoch: number | null,
    messageId: string | null = null,
    options: {
      waitForHistoryRecovery?: boolean
    } = {}
  ): Promise<string | null> {
    const initialEpoch = this.getGroupEpoch(scope.id)
    const initialPlaintext = await this.decryptForScope(scope.id, ciphertext)
    const waitForHistoryRecovery = options.waitForHistoryRecovery ?? true
    if (initialPlaintext) {
      return initialPlaintext
    }

    if (initialEpoch === null) {
      return null
    }

    const isOlderEpochMessage =
      messageEpoch != null &&
      Number.isFinite(messageEpoch) &&
      messageEpoch < initialEpoch

    if (isOlderEpochMessage) {
      this.setScopeRepairState(scope.id, 'waiting_for_same_user_bundle', 'decrypt_failed', {
        incrementFailure: true,
        persist: true
      })
      await this.requestScopeHistorySync(scope, waitForHistoryRecovery).catch((error) => {
        this.logIgnoredError('request history sync for older-epoch message', error)
      })
      if (!waitForHistoryRecovery) {
        return await this.tryImmediateHistoryBundleRecovery(scope, ciphertext, messageId)
      }
      const olderRecovered = await this.waitForHistoryBundleRecovery(scope, ciphertext, messageId)
      if (!olderRecovered) {
        this.setScopeRepairState(scope.id, 'healthy', 'recovery_timeout', { persist: true })
      }
      return olderRecovered
    }

    const shouldReplay =
      messageEpoch == null ||
      !Number.isFinite(messageEpoch) ||
      messageEpoch >= initialEpoch

    if (!shouldReplay) {
      this.setScopeRepairState(scope.id, 'waiting_for_same_user_bundle', 'decrypt_failed', {
        incrementFailure: true,
        persist: true
      })
      return null
    }

    this.setScopeRepairState(scope.id, 'replaying', null, { persist: true })
    await this.replayDurableEvents(scope.id)
    const replayed = await this.decryptForScope(scope.id, ciphertext)
    if (replayed) {
      this.setScopeRepairState(scope.id, 'healthy', null, { persist: true })
      return replayed
    }

    this.setScopeRepairState(scope.id, 'waiting_for_same_user_bundle', 'decrypt_failed', {
      incrementFailure: true,
      persist: true
    })
    await this.requestScopeHistorySync(scope, waitForHistoryRecovery).catch((error) => {
      this.logIgnoredError('request history sync', error)
    })
    if (!waitForHistoryRecovery) {
      return await this.tryImmediateHistoryBundleRecovery(scope, ciphertext, messageId)
    }
    const recovered = await this.waitForHistoryBundleRecovery(scope, ciphertext, messageId)
    if (recovered) {
      this.setScopeRepairState(scope.id, 'healthy', null, { persist: true })
    } else {
      // Recovery timed out. Clear repair state so the scope isn't permanently
      // stuck in 'waiting_for_same_user_bundle'. Normal operations (send,
      // encrypt) can proceed; the message stays undecrypted but the scope
      // remains functional for new messages.
      this.setScopeRepairState(scope.id, 'healthy', 'recovery_timeout', { persist: true })
    }
    return recovered
  }

  private async tryImmediateHistoryBundleRecovery(
    scope: EncryptedScope,
    ciphertext: string,
    messageId: string | null
  ): Promise<string | null> {
    if (messageId) {
      const cachedPlaintext = await this.storage.loadCachedMessageDecryption(messageId)
      if (cachedPlaintext) {
        this.setScopeRepairState(scope.id, 'healthy', null, { persist: true })
        return cachedPlaintext
      }
    }

    await this.processPendingHistoryBundles(scope)

    if (messageId) {
      const cachedPlaintext = await this.storage.loadCachedMessageDecryption(messageId)
      if (cachedPlaintext) {
        this.setScopeRepairState(scope.id, 'healthy', null, { persist: true })
        return cachedPlaintext
      }
    }

    const recovered = await this.decryptForScope(scope.id, ciphertext)
    if (recovered) {
      this.setScopeRepairState(scope.id, 'healthy', null, { persist: true })
      return recovered
    }

    return null
  }

  private async waitForHistoryBundleRecovery(
    scope: EncryptedScope,
    ciphertext: string,
    messageId: string | null
  ): Promise<string | null> {
    const deadline = Date.now() + HISTORY_BUNDLE_WAIT_MS

    while (Date.now() < deadline) {
      if (messageId) {
        const cachedPlaintext = await this.storage.loadCachedMessageDecryption(messageId)
        if (cachedPlaintext) {
          this.setScopeRepairState(scope.id, 'healthy', null, { persist: true })
          return cachedPlaintext
        }
      }

      await this.processPendingHistoryBundles(scope)
      if (messageId) {
        const cachedPlaintext = await this.storage.loadCachedMessageDecryption(messageId)
        if (cachedPlaintext) {
          this.setScopeRepairState(scope.id, 'healthy', null, { persist: true })
          return cachedPlaintext
        }
      }

      const recovered = await this.decryptForScope(scope.id, ciphertext)
      if (recovered) {
        this.setScopeRepairState(scope.id, 'healthy', null, { persist: true })
        return recovered
      }

      await new Promise((resolve) => setTimeout(resolve, HISTORY_BUNDLE_POLL_MS))
    }

    return null
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
      processed.push(await this.processIncomingMessage(scope, rawMessage, {
        waitForHistoryRecovery: false
      }))
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
        const processed = await this.processIncomingMessage(scope, operation.message, {
          waitForHistoryRecovery: false
        })
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
    await this.persistLocalGroupState(scopeId, state)
    this.finishLocalGroupStateUpdate(scopeId, state, options)
  }

  private async persistLocalGroupState(scopeId: string, state: GroupState): Promise<void> {
    const serializedState = serializeGroupState(state)
    const epoch = Number(state.groupContext.epoch)
    await this.withScopeCheckpointMutation(scopeId, (checkpoint) => {
      checkpoint.groupState = {
        state: serializedState,
        epoch
      }
    })
  }

  private async persistSponsoredTransition(
    scopeId: string,
    draft: PreparedSponsoredTransition,
    rollbackState: GroupState | null
  ): Promise<void> {
    const serializedState = serializeGroupState(draft.newState)
    const epoch = draft.epoch ?? Number(draft.newState.groupContext.epoch)
    const persistedRollbackState =
      draft.baseState ?? (rollbackState ? serializeGroupState(rollbackState) : null)
    const rollbackEpoch =
      draft.baseEpoch ?? (rollbackState ? Number(rollbackState.groupContext.epoch) : null)
    const pendingSponsored = {
      recipientId: draft.recipientId,
      recipientClientId: draft.recipientClientId,
      recipientKeyPackageRef: draft.recipientKeyPackageRef,
      commitData: draft.commitData,
      commitId: draft.commitId,
      removeCommitData: draft.removeCommitData,
      welcomeData: draft.welcomeData,
      groupInfoData: draft.groupInfoData,
      ratchetTreeData: draft.ratchetTreeData,
      epoch,
      previousEpoch: draft.previousEpoch,
      baseState: persistedRollbackState,
      baseEpoch: rollbackEpoch
    } satisfies PendingSponsoredTransition

    await this.withScopeCheckpointMutation(scopeId, (checkpoint) => {
      checkpoint.groupState = {
        state: serializedState,
        epoch
      }
      checkpoint.pendingGroupInfoPublish = null
      checkpoint.pendingSponsoredTransition = pendingSponsored
    })

    this.pendingGroupInfoPublishes.delete(scopeId)
    this.pendingSponsoredTransitions.set(scopeId, pendingSponsored)
    if (rollbackState) {
      this.sponsoredTransitionRollbackStates.set(scopeId, this.cloneGroupState(rollbackState))
    } else {
      this.sponsoredTransitionRollbackStates.delete(scopeId)
    }
    this.resetGroupInfoPublishRetry(scopeId)
    this.finishLocalGroupStateUpdate(scopeId, draft.newState, { publishGroupInfo: false })
  }

  private finishLocalGroupStateUpdate(
    scopeId: string,
    state: GroupState,
    options: {
      publishGroupInfo?: boolean
    } = {}
  ): void {
    const epoch = Number(state.groupContext.epoch)
    this.groupStates.set(scopeId, state)
    this.diagnostics.updateEpoch(scopeId, epoch)
    this.notifyMembershipWaiters(scopeId, true)
    this.notifyEpochWaiters(scopeId, epoch)

    if (options.publishGroupInfo !== false) {
      // Publish GroupInfo for External Commits in the background. Failures are
      // retried so a transient network issue does not leave stale join state
      // on the server.
      void this.publishGroupInfoForScope(scopeId, state)
    }
  }

  private getRecentCommitFingerprints(scopeId: string): string[] {
    return [...(this.recentCommitFingerprints.get(scopeId) ?? [])]
  }

  private rememberCommitFingerprint(scopeId: string, fingerprint: string): string[] {
    const next = [
      fingerprint,
      ...this.getRecentCommitFingerprints(scopeId).filter((value) => value !== fingerprint)
    ].slice(0, MAX_RECENT_COMMIT_FINGERPRINTS)
    this.recentCommitFingerprints.set(scopeId, next)
    return next
  }

  private hasRecentCommitFingerprint(scopeId: string, fingerprint: string): boolean {
    return this.getRecentCommitFingerprints(scopeId).includes(fingerprint)
  }

  private getRecentHistoryBundleFingerprints(scopeId: string): string[] {
    return [...(this.recentHistoryBundleFingerprints.get(scopeId) ?? [])]
  }

  private rememberHistoryBundleFingerprint(scopeId: string, fingerprint: string): string[] {
    const next = [
      fingerprint,
      ...this.getRecentHistoryBundleFingerprints(scopeId).filter((value) => value !== fingerprint)
    ].slice(0, MAX_RECENT_HISTORY_BUNDLE_FINGERPRINTS)
    this.recentHistoryBundleFingerprints.set(scopeId, next)
    return next
  }

  private hasRecentHistoryBundleFingerprint(scopeId: string, fingerprint: string): boolean {
    return this.getRecentHistoryBundleFingerprints(scopeId).includes(fingerprint)
  }

  private currentScopeRepairState(scopeId: string): ScopeRepairState | null {
    return normalizeScopeRepairState(this.scopeRepairStates.get(scopeId) ?? null)
  }

  private setScopeRepairState(
    scopeId: string,
    status: ScopeRepairStatus,
    lastError: string | null = null,
    options: {
      incrementFailure?: boolean
      persist?: boolean
    } = {}
  ): void {
    const previous = this.scopeRepairStates.get(scopeId) ?? {
      status,
      failureCount: 0,
      lastError: null,
      updatedAt: null
    }

    const next: ScopeRepairState = {
      status,
      failureCount: previous.failureCount + (options.incrementFailure ? 1 : 0),
      lastError,
      updatedAt: new Date().toISOString()
    }
    this.scopeRepairStates.set(scopeId, next)

    if (options.persist) {
      void this.persistScopeRepairState(scopeId)
    }
  }

  private async persistScopeRepairState(scopeId: string): Promise<void> {
    await this.withScopeCheckpointMutation(scopeId, (checkpoint) => {
      if (this.getRecentCommitFingerprints(scopeId).length > 0) {
        checkpoint.recentCommitFingerprints = this.getRecentCommitFingerprints(scopeId)
      }

      if (this.getRecentHistoryBundleFingerprints(scopeId).length > 0) {
        checkpoint.recentHistoryBundleFingerprints = this.getRecentHistoryBundleFingerprints(scopeId)
      }

      const repairState = this.currentScopeRepairState(scopeId)
      if (repairState) {
        checkpoint.repairState = repairState
      }
    })
  }

  private async persistHistoryBundleAppliedState(
    scopeId: string,
    fingerprint: string
  ): Promise<void> {
    const recentHistoryBundleFingerprints = this.rememberHistoryBundleFingerprint(
      scopeId,
      fingerprint
    )

    await this.withScopeCheckpointMutation(scopeId, (checkpoint) => {
      checkpoint.recentHistoryBundleFingerprints = recentHistoryBundleFingerprints
      checkpoint.repairState = this.currentScopeRepairState(scopeId) ?? checkpoint.repairState
    })
  }

  private async persistCommitAppliedState(
    scopeId: string,
    state: GroupState,
    fingerprint: string,
    lastEventSeq: number | null,
    options: {
      publishGroupInfo?: boolean
    } = {}
  ): Promise<void> {
    const recentCommitFingerprints = this.rememberCommitFingerprint(scopeId, fingerprint)
    const serializedState = serializeGroupState(state)
    const epoch = Number(state.groupContext.epoch)

    await this.withScopeCheckpointMutation(scopeId, (checkpoint) => {
      checkpoint.groupState = {
        state: serializedState,
        epoch
      }
      checkpoint.recentCommitFingerprints = recentCommitFingerprints
      checkpoint.recentHistoryBundleFingerprints = this.getRecentHistoryBundleFingerprints(scopeId)
      checkpoint.repairState = this.currentScopeRepairState(scopeId) ?? checkpoint.repairState

      if (lastEventSeq != null) {
        checkpoint.lastEventSeq = Math.max(checkpoint.lastEventSeq, lastEventSeq)
      }
    })

    this.finishLocalGroupStateUpdate(scopeId, state, options)
  }

  private async withScopeCheckpointMutation(
    scopeId: string,
    mutate: (checkpoint: ScopeCheckpointRecord) => void | Promise<void>
  ): Promise<void> {
    const previous = this.checkpointPersistChains.get(scopeId) ?? Promise.resolve()
    const operation = previous
      .catch(() => {})
      .then(async () => {
        const checkpoint = cloneScopeCheckpointRecord(
          await this.storage.loadScopeCheckpoint(scopeId)
        )
        await mutate(checkpoint)
        await this.storage.saveScopeCheckpoint(scopeId, checkpoint)
      })
    const barrier = operation.then(() => {}, () => {})
    this.checkpointPersistChains.set(scopeId, barrier)

    try {
      await operation
    } finally {
      if (this.checkpointPersistChains.get(scopeId) === barrier) {
        this.checkpointPersistChains.delete(scopeId)
      }
    }
  }

  private async ensureCurrentGroupInfoPublished(scopeId: string): Promise<boolean> {
    if (this.pendingSponsoredTransitions.has(scopeId)) {
      await this.flushPendingSponsoredTransition(scopeId, { flushGroupInfoOnSuccess: false })
      if (this.pendingSponsoredTransitions.has(scopeId)) {
        return false
      }
    }

    const state = this.groupStates.get(scopeId)
    if (!state) {
      return false
    }

    const epoch = Number(state.groupContext.epoch)
    if (this.lastSuccessfulGroupInfoPublishEpochs.get(scopeId) === epoch) {
      return true
    }

    const pending = this.pendingGroupInfoPublishes.get(scopeId)
    if (pending && pending.epoch === epoch) {
      await this.flushPendingGroupInfoPublish(scopeId)
      if (this.pendingGroupInfoPublishes.get(scopeId)?.epoch === epoch) {
        return false
      }
      return this.lastSuccessfulGroupInfoPublishEpochs.get(scopeId) === epoch
    }

    return await this.publishGroupInfoForScope(scopeId, state)
  }

  /**
   * Publish GroupInfo + ratchet tree to the server so new members
   * can join via External Commit without any online member's help.
   */
  private async publishGroupInfoForScope(scopeId: string, state: GroupState): Promise<boolean> {
    const groupInfoData = exportGroupInfo(state)
    const ratchetTreeData = exportRatchetTree(state)
    const epoch = Number(state.groupContext.epoch)

    if (
      this.lastSuccessfulGroupInfoPublishEpochs.get(scopeId) === epoch &&
      !this.pendingGroupInfoPublishes.has(scopeId)
    ) {
      return true
    }

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
      this.lastSuccessfulGroupInfoPublishEpochs.set(scopeId, epoch)
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
    const [
      pendingGroupInfoPublishes,
      pendingExternalCommitBroadcasts,
      pendingSponsoredTransitions
    ] = await Promise.all([
      this.storage.loadPendingGroupInfoPublishes(),
      this.storage.loadPendingExternalCommitBroadcasts(),
      this.storage.loadPendingSponsoredTransitions()
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

    for (const pending of pendingSponsoredTransitions) {
      this.pendingSponsoredTransitions.set(pending.groupId, {
        recipientId: pending.recipientId,
        recipientClientId: pending.recipientClientId,
        recipientKeyPackageRef: pending.recipientKeyPackageRef,
        commitData: pending.commitData,
        commitId: pending.commitId,
        removeCommitData: pending.removeCommitData,
        welcomeData: pending.welcomeData,
        groupInfoData: pending.groupInfoData,
        ratchetTreeData: pending.ratchetTreeData,
        epoch: pending.epoch,
        previousEpoch: pending.previousEpoch,
        baseState: pending.baseState,
        baseEpoch: pending.baseEpoch
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

    if (this.pendingSponsoredTransitions.has(scopeId)) {
      await this.flushPendingSponsoredTransition(scopeId, { flushGroupInfoOnSuccess: false })
      if (this.pendingSponsoredTransitions.has(scopeId)) {
        return
      }
    }

    try {
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
      this.lastSuccessfulGroupInfoPublishEpochs.set(scopeId, pending.epoch)
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
    const pending = {
      groupInfoData,
      ratchetTreeData,
      epoch
    } satisfies PendingGroupInfoPublish
    this.pendingGroupInfoPublishes.set(scopeId, pending)

    try {
      await this.withScopeCheckpointMutation(scopeId, (checkpoint) => {
        checkpoint.pendingGroupInfoPublish = pending
      })
    } catch (error) {
      const current = this.pendingGroupInfoPublishes.get(scopeId)
      if (current && samePendingGroupInfoPublish(current, pending)) {
        this.pendingGroupInfoPublishes.delete(scopeId)
      }
      throw error
    }
  }

  private resetGroupInfoPublishRetry(scopeId: string): void {
    this.groupInfoPublishRetryAttempts.delete(scopeId)

    const timer = this.groupInfoPublishRetryTimers.get(scopeId)
    if (timer) {
      clearTimeout(timer)
      this.groupInfoPublishRetryTimers.delete(scopeId)
    }
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

    await this.withScopeCheckpointMutation(scopeId, (checkpoint) => {
      if (
        checkpoint.pendingGroupInfoPublish &&
        expected &&
        !samePendingGroupInfoPublish(checkpoint.pendingGroupInfoPublish, expected)
      ) {
        return
      }

      checkpoint.pendingGroupInfoPublish = null
    })

    const latest = this.pendingGroupInfoPublishes.get(scopeId)
    if (latest && expected && !samePendingGroupInfoPublish(latest, expected)) {
      return
    }

    this.pendingGroupInfoPublishes.delete(scopeId)
    this.groupInfoPublishRetryAttempts.delete(scopeId)

    const timer = this.groupInfoPublishRetryTimers.get(scopeId)
    if (timer) {
      clearTimeout(timer)
      this.groupInfoPublishRetryTimers.delete(scopeId)
    }
  }

  private async flushPendingSponsoredTransitions(): Promise<void> {
    for (const scopeId of [...this.pendingSponsoredTransitions.keys()]) {
      await this.flushPendingSponsoredTransition(scopeId, { flushGroupInfoOnSuccess: false })
    }
  }

  private buildSponsoredTransitionGroupInfo(
    scopeId: string,
    pending: PendingSponsoredTransition
  ): PendingGroupInfoPublish & {
    previousEpoch: number
  } | null {
    const pendingGroupInfo = this.pendingGroupInfoPublishes.get(scopeId)
    const currentState = this.groupStates.get(scopeId)
    const groupInfoData =
      pending.groupInfoData ??
      pendingGroupInfo?.groupInfoData ??
      (currentState ? exportGroupInfo(currentState) : null)
    const ratchetTreeData =
      pending.ratchetTreeData ??
      pendingGroupInfo?.ratchetTreeData ??
      (currentState ? exportRatchetTree(currentState) : null)
    const epoch =
      pending.epoch ??
      pendingGroupInfo?.epoch ??
      (currentState ? Number(currentState.groupContext.epoch) : null)

    if (!groupInfoData || epoch == null) {
      return null
    }

    const previousEpoch =
      pending.previousEpoch ?? epoch - (pending.removeCommitData ? 2 : 1)
    if (previousEpoch < 0) {
      return null
    }

    return {
      groupInfoData,
      ratchetTreeData,
      epoch,
      previousEpoch
    }
  }

  private async recoverFromSponsoredTransitionConflict(
    scopeId: string,
    pending: PendingSponsoredTransition
  ): Promise<void> {
    const rollbackState = this.sponsoredTransitionRollbackStates.get(scopeId)
      ? this.cloneGroupState(this.sponsoredTransitionRollbackStates.get(scopeId)!)
      : pending.baseState
        ? deserializeGroupState(new Uint8Array(pending.baseState))
        : null
    await this.clearPendingSponsoredTransition(scopeId, pending)
    await this.clearPendingGroupInfoPublish(scopeId)
    this.lastSuccessfulGroupInfoPublishEpochs.delete(scopeId)

    if (rollbackState) {
      await this.setGroupState(scopeId, rollbackState, { publishGroupInfo: false })
      this.setScopeRepairState(scopeId, 'replaying', 'sponsored_transition_conflict', {
        incrementFailure: true,
        persist: true
      })
      await this.replayDurableEvents(scopeId)
      if (
        pending.baseEpoch != null &&
        this.getGroupEpoch(scopeId) != null &&
        this.getGroupEpoch(scopeId)! > pending.baseEpoch
      ) {
        this.setScopeRepairState(scopeId, 'healthy', null, { persist: true })
      } else {
        this.setScopeRepairState(scopeId, 'needs_repair', 'sponsored_transition_conflict', {
          persist: true
        })
      }
      return
    }

    await this.resetScopeState(scopeId)
    this.setScopeRepairState(scopeId, 'needs_repair', 'sponsored_transition_conflict', {
      incrementFailure: true,
      persist: true
    })

    const session = this.client.getAuthSession()
    if (!session || !this.client.deviceIdentity?.id) {
      return
    }

    await this.pushResyncRequestForScope(scopeId, this.scopeKinds.get(scopeId) ?? null, {
      reason: 'sponsored_transition_conflict',
      username: session.user.username ?? null
    }).catch((error) => {
      this.logIgnoredError('request resync after sponsored transition conflict', error)
      return false
    })
  }

  private async flushPendingSponsoredTransition(
    scopeId: string,
    _options: {
      flushGroupInfoOnSuccess?: boolean
    } = {}
  ): Promise<boolean> {
    const pending = this.pendingSponsoredTransitions.get(scopeId)
    if (!pending) {
      return true
    }

    try {
      const pendingGroupInfo = this.buildSponsoredTransitionGroupInfo(scopeId, pending)
      if (!pendingGroupInfo) {
        this.scheduleSponsoredTransitionRetry(scopeId)
        return false
      }

      const result = await publishSponsoredTransition(
        scopeId,
        {
          ...pending,
          groupInfoData: pendingGroupInfo.groupInfoData,
          ratchetTreeData: pendingGroupInfo.ratchetTreeData,
          epoch: pendingGroupInfo.epoch,
          previousEpoch: pendingGroupInfo.previousEpoch
        },
        this.client.getHttpClient()
      )

      if (result.status === 'conflict') {
        await this.recoverFromSponsoredTransitionConflict(scopeId, pending)
        return false
      }

      await this.clearPendingSponsoredTransition(scopeId, pending)
      await this.clearPendingGroupInfoPublish(scopeId)
      this.lastSuccessfulGroupInfoPublishEpochs.set(scopeId, pendingGroupInfo.epoch)
      return true
    } catch (error) {
      if (!this.sponsoredTransitionRetryTimers.has(scopeId)) {
        this.logIgnoredError('publish sponsored transition', error)
      }
      this.scheduleSponsoredTransitionRetry(scopeId)
      return false
    }
  }

  private scheduleSponsoredTransitionRetry(scopeId: string): void {
    if (
      this.sponsoredTransitionRetryTimers.has(scopeId) ||
      !this.pendingSponsoredTransitions.has(scopeId)
    ) {
      return
    }

    const attempt = (this.sponsoredTransitionRetryAttempts.get(scopeId) ?? 0) + 1
    this.sponsoredTransitionRetryAttempts.set(scopeId, attempt)
    const delayMs = Math.min(30_000, 500 * 2 ** Math.min(attempt - 1, 6))

    const timer = setTimeout(() => {
      this.sponsoredTransitionRetryTimers.delete(scopeId)
      void this.flushPendingSponsoredTransition(scopeId)
    }, delayMs)
    this.unrefRetryTimer(timer)

    this.sponsoredTransitionRetryTimers.set(scopeId, timer)
  }

  private async clearPendingSponsoredTransition(
    scopeId: string,
    expected: PendingSponsoredTransition | null = null
  ): Promise<void> {
    const current = this.pendingSponsoredTransitions.get(scopeId)
    if (!current) {
      return
    }

    if (expected && !samePendingSponsoredTransition(current, expected)) {
      return
    }

    await this.withScopeCheckpointMutation(scopeId, (checkpoint) => {
      if (
        checkpoint.pendingSponsoredTransition &&
        expected &&
        !samePendingSponsoredTransition(checkpoint.pendingSponsoredTransition, expected)
      ) {
        return
      }

      checkpoint.pendingSponsoredTransition = null
      checkpoint.pendingGroupInfoPublish = null
    })

    const latest = this.pendingSponsoredTransitions.get(scopeId)
    if (latest && expected && !samePendingSponsoredTransition(latest, expected)) {
      return
    }

    this.pendingSponsoredTransitions.delete(scopeId)
    this.sponsoredTransitionRollbackStates.delete(scopeId)
    this.pendingGroupInfoPublishes.delete(scopeId)
    this.sponsoredTransitionRetryAttempts.delete(scopeId)
    this.groupInfoPublishRetryAttempts.delete(scopeId)

    const timer = this.sponsoredTransitionRetryTimers.get(scopeId)
    if (timer) {
      clearTimeout(timer)
      this.sponsoredTransitionRetryTimers.delete(scopeId)
    }

    const groupInfoTimer = this.groupInfoPublishRetryTimers.get(scopeId)
    if (groupInfoTimer) {
      clearTimeout(groupInfoTimer)
      this.groupInfoPublishRetryTimers.delete(scopeId)
    }
  }

  private async queueExternalCommitBroadcast(
    scopeId: string,
    commitData: string,
    commitId: string
  ): Promise<void> {
    const pending = {
      commitData,
      commitId
    } satisfies PendingExternalCommitBroadcast
    this.pendingExternalCommitBroadcasts.set(scopeId, pending)

    try {
      await this.withScopeCheckpointMutation(scopeId, (checkpoint) => {
        checkpoint.pendingExternalCommitBroadcast = pending
      })
    } catch (error) {
      const current = this.pendingExternalCommitBroadcasts.get(scopeId)
      if (current && samePendingExternalCommitBroadcast(current, pending)) {
        this.pendingExternalCommitBroadcasts.delete(scopeId)
      }
      throw error
    }
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

    await this.withScopeCheckpointMutation(scopeId, (checkpoint) => {
      if (
        checkpoint.pendingExternalCommitBroadcast &&
        expected &&
        !samePendingExternalCommitBroadcast(checkpoint.pendingExternalCommitBroadcast, expected)
      ) {
        return
      }

      checkpoint.pendingExternalCommitBroadcast = null
    })

    const latest = this.pendingExternalCommitBroadcasts.get(scopeId)
    if (latest && expected && !samePendingExternalCommitBroadcast(latest, expected)) {
      return
    }

    this.pendingExternalCommitBroadcasts.delete(scopeId)
    this.externalCommitBroadcastRetryAttempts.delete(scopeId)

    const timer = this.externalCommitBroadcastRetryTimers.get(scopeId)
    if (timer) {
      clearTimeout(timer)
      this.externalCommitBroadcastRetryTimers.delete(scopeId)
    }
  }

  private async computeMlsCommitId(scopeId: string, commitData: string): Promise<string> {
    return await sha256Hex(`${scopeId}\nmls_commit\n${commitData}`)
  }

  private async computeHistoryBundleFingerprint(
    scopeId: string,
    ciphertext: string
  ): Promise<string> {
    return await sha256Hex(`${scopeId}\nmls_history_bundle\n${ciphertext}`)
  }

  private cloneGroupState(state: GroupState): GroupState {
    return deserializeGroupState(serializeGroupState(state))
  }

  private async loadProcessedCachedMessages(scopeId: string): Promise<ProcessedScopeMessage[]> {
    const cached = await this.storage.loadCachedMessages(scopeId)

    const processed = await Promise.all(
      cached.map(async (message) => {
        const ciphertext = message.ciphertext ? Buffer.from(message.ciphertext).toString('base64') : undefined
        const plaintext =
          message.decryptedContent ?? await this.storage.loadCachedMessageDecryption(message.id)
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
          decryptionFailed: ciphertext ? plaintext == null : false,
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
            content: plaintext ?? undefined,
            ciphertext,
            mls_epoch: message.mlsEpoch
          }
        } satisfies ProcessedScopeMessage
      })
    )

    return processed.sort((left, right) => {
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

  private getLocalSessionIdentity(): {
    userId: string
    username: string | null
    deviceId: string | null
  } | null {
    const session = this.client.getAuthSession()
    const state = this.client.getState()
    const userId = session?.user.id ?? state.user?.id ?? null

    if (!userId) {
      return null
    }

    return {
      userId,
      username: session?.user.username ?? state.user?.username ?? null,
      deviceId: this.client.deviceIdentity?.id ?? null
    }
  }

  private async deriveScopeVoiceKeyLocked(scopeId: string): Promise<Uint8Array | null> {
    const state = this.groupStates.get(scopeId)
    if (!state) {
      return null
    }

    await initCipherSuite()
    return await deriveVoiceKey(state)
  }

  private async maybeRequestVoiceJoinLocked(scopeId: string): Promise<boolean> {
    const localIdentity = this.getLocalSessionIdentity()
    if (!localIdentity?.deviceId) {
      return false
    }

    const now = Date.now()
    const lastRequestAt = this.recentVoiceJoinRequests.get(scopeId) ?? 0
    if (now - lastRequestAt < VOICE_JOIN_REQUEST_COOLDOWN_MS) {
      return true
    }

    this.recentVoiceJoinRequests.set(scopeId, now)
    await this.client.replenishKeyPackages()
    return await this.pushMlsControlEvent(
      scopeId,
      'mls_request_join',
      { device_id: localIdentity.deviceId },
      scopeId
    )
  }

  private async maybeRequestVoiceResyncLocked(
    scopeId: string,
    reason: string | null
  ): Promise<boolean> {
    const localIdentity = this.getLocalSessionIdentity()
    if (!localIdentity) {
      return false
    }

    const now = Date.now()
    const lastRequestAt = this.recentVoiceResyncRequests.get(scopeId) ?? 0
    if (now - lastRequestAt < VOICE_RESYNC_REQUEST_COOLDOWN_MS) {
      return true
    }

    this.recentVoiceResyncRequests.set(scopeId, now)
    return await this.pushResyncRequestForScope(scopeId, null, {
      lastKnownEpoch: this.getGroupEpoch(scopeId),
      reason,
      username: localIdentity.username
    })
  }

  private async processPendingVoiceResyncRequestsLocked(scopeId: string): Promise<void> {
    if (!this.hasGroup(scopeId)) {
      return
    }

    const localIdentity = this.getLocalSessionIdentity()
    if (!localIdentity?.deviceId) {
      return
    }

    let requests: Awaited<ReturnType<typeof fetchPendingResyncRequests>> = []
    try {
      requests = await fetchPendingResyncRequests(scopeId, this.client.getHttpClient())
    } catch {
      return
    }

    for (const request of requests) {
      if (
        request.requester_id === localIdentity.userId &&
        request.requester_client_id === localIdentity.deviceId
      ) {
        continue
      }

      const requesterAlreadyJoined =
        request.requester_client_id != null &&
        this.hasMemberDevice(scopeId, request.requester_id, request.requester_client_id)

      if (requesterAlreadyJoined) {
        await ackPendingResyncRequest(
          request.id,
          request.request_id,
          this.client.getHttpClient()
        ).catch((error) => this.logIgnoredError('ack pending voice resync request', error))
        continue
      }

      const sponsored = await this.sponsorScopeResyncLocked(
        scopeId,
        request.requester_id,
        request.requester_client_id ?? null
      )
      if (!sponsored) {
        continue
      }

      await ackPendingResyncRequest(
        request.id,
        request.request_id,
        this.client.getHttpClient()
      ).catch((error) => this.logIgnoredError('ack pending voice resync request', error))
    }
  }

  private async recoverVoiceScopeStateLocked(
    scopeId: string,
    options: VoiceScopeRecoveryOptions = {}
  ): Promise<Uint8Array | null> {
    const localIdentity = this.getLocalSessionIdentity()
    if (!localIdentity) {
      return null
    }

    const reason = options.reason ?? 'voice_key_missing'
    const preferredCreatorId = options.preferredCreatorId ?? null

    const ensureReady = async (): Promise<void> => {
      await this.ensureGroupMembership(scopeId)
      await this.replayDurableEvents(scopeId).catch((error) =>
        this.logIgnoredError('replay voice durable events', error)
      )

      if (this.hasGroup(scopeId)) {
        return
      }

      const creatorId = preferredCreatorId ?? localIdentity.userId
      if (creatorId === localIdentity.userId) {
        await this.createGroup(scopeId)
        if (!this.hasGroup(scopeId)) {
          return
        }

        if (!await this.ensureCurrentGroupInfoPublished(scopeId)) {
          return
        }

        await this.pushMlsControlEvent(scopeId, 'mls_request_join_all', {}, scopeId)
        return
      }

      await this.maybeRequestVoiceJoinLocked(scopeId)
      await this.maybeRequestVoiceResyncLocked(scopeId, 'missing_state')
    }

    await ensureReady()
    await this.processPendingVoiceResyncRequestsLocked(scopeId)
    let voiceKey = await this.deriveScopeVoiceKeyLocked(scopeId)
    if (voiceKey) {
      return voiceKey
    }

    await this.maybeRequestVoiceResyncLocked(scopeId, reason)
    await this.processPendingVoiceResyncRequestsLocked(scopeId)
    voiceKey = await this.deriveScopeVoiceKeyLocked(scopeId)
    if (voiceKey) {
      return voiceKey
    }

    if (this.hasGroup(scopeId)) {
      await this.resetScopeState(scopeId)
    }

    await ensureReady()
    await this.maybeRequestVoiceResyncLocked(scopeId, 'local_state_reset')
    await this.processPendingVoiceResyncRequestsLocked(scopeId)
    return await this.deriveScopeVoiceKeyLocked(scopeId)
  }

  private async handleVoiceScopeEventLocked(
    scopeId: string,
    event: string,
    payload: Record<string, unknown> | null,
    options: VoiceScopeRecoveryOptions = {}
  ): Promise<Uint8Array | null> {
    const localIdentity = this.getLocalSessionIdentity()

    if (!localIdentity) {
      return null
    }

    if (event === 'mls_request_join_all') {
      if (!this.hasGroup(scopeId)) {
        return await this.recoverVoiceScopeStateLocked(scopeId, {
          ...options,
          reason: 'missing_state'
        })
      }

      return await this.deriveScopeVoiceKeyLocked(scopeId)
    }

    if (event === 'mls_request_join') {
      const userId = this.getString(payload, 'user_id')
      const deviceId = this.getString(payload, 'device_id')

      if (!userId) {
        return await this.deriveScopeVoiceKeyLocked(scopeId)
      }

      if (!this.hasGroup(scopeId)) {
        return await this.recoverVoiceScopeStateLocked(scopeId, {
          ...options,
          reason: 'missing_state'
        })
      }

      await this.sponsorScopeJoinLocked(scopeId, userId, deviceId)
      return await this.deriveScopeVoiceKeyLocked(scopeId)
    }

    if (event === 'mls_resync_request') {
      await this.processPendingVoiceResyncRequestsLocked(scopeId)
      const voiceKey = await this.deriveScopeVoiceKeyLocked(scopeId)
      if (voiceKey) {
        return voiceKey
      }

      return await this.recoverVoiceScopeStateLocked(scopeId, {
        ...options,
        reason: 'voice_key_missing'
      })
    }

    if (event === 'mls_commit') {
      const senderId = this.getString(payload, 'sender_id')
      const senderDeviceId = this.getString(payload, 'sender_device_id')

      if (senderId !== localIdentity.userId || senderDeviceId !== localIdentity.deviceId) {
        await this.handleCommit(scopeId, this.getString(payload, 'commit_data'), 'voiceLiveEvent')
      }

      const voiceKey = await this.deriveScopeVoiceKeyLocked(scopeId)
      if (voiceKey) {
        return voiceKey
      }

      return await this.recoverVoiceScopeStateLocked(scopeId, {
        ...options,
        reason: 'voice_key_missing'
      })
    }

    if (event === 'mls_welcome') {
      const recipientId = this.getString(payload, 'recipient_id')
      const recipientDeviceId = this.getString(payload, 'recipient_device_id')

      if (
        recipientId === localIdentity.userId &&
        (!recipientDeviceId || recipientDeviceId === localIdentity.deviceId)
      ) {
        const processed = await this.handleWelcome(
          scopeId,
          this.getString(payload, 'welcome_data'),
          this.getString(payload, 'key_package_ref')
        )

        if (processed) {
          const welcomeId = this.getString(payload, 'id')
          if (welcomeId) {
            await ackPendingWelcome(welcomeId, this.client.getHttpClient()).catch((error) =>
              this.logIgnoredError('ack voice welcome', error)
            )
          }
        }
      }

      const voiceKey = await this.deriveScopeVoiceKeyLocked(scopeId)
      if (voiceKey) {
        return voiceKey
      }

      return await this.recoverVoiceScopeStateLocked(scopeId, {
        ...options,
        reason: 'voice_key_missing'
      })
    }

    if (event === 'mls_remove') {
      const senderId = this.getString(payload, 'sender_id')
      const senderDeviceId = this.getString(payload, 'sender_device_id')
      const removedUserId = this.getString(payload, 'removed_user_id')
      const removedDeviceId = this.getString(payload, 'removed_device_id')
      const isLocalSender =
        senderId === localIdentity.userId && senderDeviceId === localIdentity.deviceId
      const isLocalTarget =
        removedUserId === localIdentity.userId &&
        (removedDeviceId == null || removedDeviceId === localIdentity.deviceId)

      if (isLocalTarget && !isLocalSender) {
        await this.resetScopeState(scopeId)
        return await this.recoverVoiceScopeStateLocked(scopeId, {
          ...options,
          reason: 'removed_from_group'
        })
      }

      if (!isLocalSender) {
        await this.handleCommit(scopeId, this.getString(payload, 'commit_data'), 'voiceRemoveEvent')
      }

      const voiceKey = await this.deriveScopeVoiceKeyLocked(scopeId)
      if (voiceKey) {
        return voiceKey
      }

      return await this.recoverVoiceScopeStateLocked(scopeId, {
        ...options,
        reason: 'voice_key_missing'
      })
    }

    return await this.deriveScopeVoiceKeyLocked(scopeId)
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
    const conversation = await this.loadConversation(conversationId)

    if (!conversation || !session) {
      return false
    }

    const participantIds = conversation.participants
      .map((participant) => participant.user_id)
      .sort((left, right) => left.localeCompare(right))

    if (participantIds[0] !== session.user.id) {
      return false
    }

    return await this.bootstrapLocalDmGroup(conversationId)
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
    const conversation = await this.loadConversation(conversationId)

    if (!conversation || !session) {
      return false
    }

    return await this.bootstrapLocalDmGroup(conversationId)
  }

  private async loadConversation(conversationId: string): Promise<VesperConversation | null> {
    let conversation =
      this.client.getState().conversations.find((entry) => entry.id === conversationId) ?? null

    if (conversation) {
      return conversation
    }

    await this.client.syncNow(false).catch((e) => this.logIgnoredError('background sync failed', e))
    conversation =
      this.client.getState().conversations.find((entry) => entry.id === conversationId) ?? null
    return conversation
  }

  private getDmParticipantIds(
    conversation: VesperConversation,
    localUserId: string
  ): string[] {
    return [...new Set(
      conversation.participants
        .map((participant) => participant.user_id)
        .filter((userId) => userId && userId !== localUserId)
    )].sort((left, right) => left.localeCompare(right))
  }

  private async bootstrapLocalDmGroup(conversationId: string): Promise<boolean> {
    await this.createGroup(conversationId)
    if (!this.hasGroup(conversationId)) {
      return false
    }

    return await this.ensureCurrentGroupInfoPublished(conversationId)
  }

  private async ensureDmParticipantCoverage(conversationId: string): Promise<boolean> {
    if (!this.hasGroup(conversationId)) {
      return false
    }

    const session = this.client.getAuthSession()
    const conversation = await this.loadConversation(conversationId)
    if (!session || !conversation) {
      return this.hasGroup(conversationId)
    }

    const participantIds = this.getDmParticipantIds(conversation, session.user.id)
    if (participantIds.length === 0) {
      return true
    }

    if (participantIds.every((participantId) => this.isMemberOfGroup(conversationId, participantId))) {
      return true
    }

    const scope = {
      kind: 'dm' as const,
      id: conversationId
    }

    for (const participantId of participantIds) {
      if (this.isMemberOfGroup(conversationId, participantId)) {
        continue
      }

      await this.sponsorScopeJoinLocked(
        conversationId,
        participantId,
        this.getPreferredJoinDeviceId(scope, participantId)
      )
    }

    if (participantIds.every((participantId) => this.isMemberOfGroup(conversationId, participantId))) {
      void this.client.pushScopeEvent('dm', conversationId, 'mls_request_join_all', {})
      return true
    }

    if (!await this.ensureCurrentGroupInfoPublished(conversationId)) {
      return false
    }

    const pushed = await this.client.pushScopeEvent('dm', conversationId, 'mls_request_join_all', {})
    if (!pushed) {
      return false
    }

    const joined = await this.awaitDmParticipantCoverage(conversationId, participantIds)
    if (joined) {
      await this.replayDurableEvents(conversationId).catch((error) =>
        this.logIgnoredError('replay dm durable events during bootstrap', error)
      )
    }

    return participantIds.every((participantId) => this.isMemberOfGroup(conversationId, participantId))
  }

  private async awaitDmParticipantCoverage(
    conversationId: string,
    participantIds: string[],
    timeoutMs = DM_PARTICIPANT_JOIN_WAIT_MS
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      if (participantIds.every((participantId) => this.isMemberOfGroup(conversationId, participantId))) {
        return true
      }

      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        break
      }

      await this.awaitGroupMembership(conversationId, Math.min(remainingMs, 250))
    }

    return participantIds.every((participantId) => this.isMemberOfGroup(conversationId, participantId))
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

    await this.withReadyScopeOperation(scope, false, async () => {
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
    })
  }

  private async withReadyScopeOperation<T>(
    scope: EncryptedScope,
    allowCreate: boolean,
    operation: () => Promise<T>
  ): Promise<T> {
    const deadline = Date.now() + OUTBOUND_SCOPE_READY_WAIT_MS

    while (Date.now() < deadline) {
      if (!await this.ensureScopeReady(scope, allowCreate)) {
        await new Promise((resolve) => setTimeout(resolve, OUTBOUND_SCOPE_READY_RETRY_MS))
        continue
      }

      const result = await this.withLockedScopeOperation(scope.id, async () => {
        if (!await this.ensureScopeReady(scope, allowCreate)) {
          return SCOPE_NOT_READY
        }

        return await operation()
      })

      if (result !== SCOPE_NOT_READY) {
        return result as T
      }

      await new Promise((resolve) => setTimeout(resolve, OUTBOUND_SCOPE_READY_RETRY_MS))
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
