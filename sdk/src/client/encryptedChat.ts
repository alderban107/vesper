import {
  ackPendingHistoryBundle,
  ackPendingHistoryRequest,
  ackPendingResyncRequest,
  ackPendingWelcome,
  base64ToUint8,
  fetchGroupInfo,
  fetchPendingHistoryBundles,
  fetchPendingHistoryRequests,
  fetchPendingResyncRequests,
  fetchKeyPackage,
  fetchKeyPackageWithIdentity,
  fetchMlsEvents,
  fetchPendingWelcomes,
  publishExternalCommitGroupInfo,
  publishGroupInfo,
  publishSponsoredTransition,
  uint8ToBase64
} from '../api/crypto.js'
import {
  activateRoomKeyEpoch,
  fetchActiveRoomKeyEpoch,
  fetchCohortWrappingKey,
  fetchRoomKeyEpoch,
  type RoomCryptoTopologyResolution,
  type RoomKeyEpochRecord,
  prepareRoomKeyEpoch,
  publishCohortWrappingKey,
  putRoomKeyEnvelope,
  reportRoomKeyEpochRepair,
  renewRoomKeyEpoch,
  stageRoomKeyEpoch
} from '../api/roomCrypto.js'
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
  decryptRoomApplication,
  deserializeGroupState,
  deriveVoiceKey,
  deriveCohortWrappingKey,
  type CohortWrappingContext,
  type CohortWrappingPublication,
  type DerivedCohortWrappingKey,
  encodePayload,
  encryptMessage,
  encryptRoomApplication,
  exportGroupInfo,
  exportRatchetTree,
  findExactMemberLeafIndex,
  findMemberLeafIndex,
  generateRoomDataKey,
  getDisplayText,
  getGroupLeafIdentities,
  getGroupMemberIdentities,
  groupHasMember,
  initCipherSuite,
  joinViaExternalCommit,
  parseRoomApplicationEnvelope,
  processCommitMessage,
  processWelcome,
  removeMemberFromGroup,
  removeMembersFromGroup,
  serializeGroupState,
  signWithSerializedIdentity,
  type RoomKeyEnvelopeContext,
  unwrapRoomDataKey,
  verifyCohortWrappingPublication,
  wrapRoomDataKey
} from '../crypto/index.js'
import {
  type ControlIntentRecord,
  type CryptoStorageRuntime,
  type ScopeCheckpointRecord
} from '../crypto/storage.js'
import { cacheSentMessage } from '../crypto/decryptionCache.js'
import { withGroupLock } from '../crypto/groupLock.js'
import type { MessagePayload } from '../crypto/payload.js'
import type { VesperClient } from './index.js'
import { applicationHistoryIncludesRoomSeq, normalizeApplicationHistoryAuthorization, type ApplicationHistoryAuthorization } from './historyAuthorization.js'
import {
  messageHistorySigningBytes,
  verifyHistoryBundlePlaintext,
  withMessageHistoryAuthentication,
  type MessageHistoryBinding
} from './messageAuthenticity.js'
import { MLSDiagnostics } from './mlsDiagnostics.js'
import { RoomCryptoState } from './roomCryptoState.js'

const JOIN_WAIT_MS = 2_500
const EVICTION_REQUEST_COOLDOWN_MS = 3_000
const VOICE_JOIN_REQUEST_COOLDOWN_MS = 2_000
const VOICE_RESYNC_REQUEST_COOLDOWN_MS = 3_000
const SEND_CONFIRMATION_WAIT_MS = 2_000
const SEND_RETRY_WAIT_MS = 100
const OUTBOUND_SCOPE_READY_WAIT_MS = 30_000
const OUTBOUND_SCOPE_READY_RETRY_MS = 250
const HISTORY_SYNC_REQUEST_COOLDOWN_MS = 1_000
const HISTORY_BUNDLE_WAIT_MS = 5_000
const HISTORY_BUNDLE_POLL_MS = 200
const MAX_MESSAGES_PER_SCOPE = 200
const MAX_HISTORY_AUTHORIZATION_ROWS = 10_000
const MAX_SCOPE_RECOVERY_PACKAGE_BYTES = 262_144
const SCOPE_RECOVERY_PACKAGE_PUBLISH_QUIET_MS = 2_000
const SCOPE_RECOVERY_PACKAGE_PUBLISH_MAX_DELAY_MS = 30_000
const MAX_PERSISTED_ROOM_KEY_EPOCHS = 8
const SCOPE_RECOVERY_PACKAGE_VERSION = 1
const DECRYPTION_PLACEHOLDER = '[Encrypted message unavailable]'
const SCOPE_NOT_READY = Symbol('scope-not-ready')

export interface EncryptedScope {
  kind: 'channel' | 'dm'
  id: string
  channelId?: string | null
}

interface ScopeRecoveryPackageMessage {
  id: string
  roomSeq: number | null
  channelId: string | null
  conversationId: string | null
  serverId: string | null
  senderId: string | null
  senderUsername: string | null
  parentMessageId: string | null
  threadRootMessageId: string | null
  replyToMessageId: string | null
  isReply: boolean
  ciphertext: string | null
  plaintext: string
  mlsEpoch: number | null
  insertedAt: string
}

interface ScopeRecoveryPackageRoomDataKey {
  roomId: string
  topologyGeneration: number
  epoch: number
  key: string
}

interface ScopeRecoveryPackagePayload {
  version: number
  logicalScopeId: string
  mlsGroupId: string
  ownerId: string
  membershipGeneration: number
  lastEventSeq: number
  generatedAt: string
  messages: ScopeRecoveryPackageMessage[]
  roomDataKeys?: ScopeRecoveryPackageRoomDataKey[]
}

export interface ProcessedScopeMessage {
  id: string
  scopeId: string
  channelId: string | null
  conversationId: string | null
  senderId: string | null
  senderUsername: string | null
  parentMessageId: string | null
  threadRootMessageId: string | null
  replyToMessageId: string | null
  isReply: boolean
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
  olderCursor: string | null
  latestRoomSeq: number
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
  threadRootMessageId?: string | null
  replyToMessageId?: string | null
  isReply?: boolean
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

interface LegacyDecryptionOptions {
  waitForHistoryRecovery?: boolean
  groupId?: string | null
}

interface MembershipEpochRange {
  start: number
  end: number | null
}

type DurableMlsEvent = Awaited<ReturnType<typeof fetchMlsEvents>>[number]

function membershipEpochRangesFromEvents(
  events: DurableMlsEvent[],
  userId: string,
  deviceId: string
): MembershipEpochRange[] {
  const ranges: MembershipEpochRange[] = []
  let openStart: number | null = null
  let sawRelevantEvent = false

  for (const event of events) {
    const generation = event.payload.resulting_generation
    if (generation == null || !Number.isInteger(generation) || generation < 0) {
      continue
    }

    const joinsDevice =
      event.event_type === 'mls_commit' &&
      event.payload.joined_user_id === userId &&
      event.payload.joined_device_id === deviceId
    if (joinsDevice) {
      sawRelevantEvent = true
      if (openStart == null) {
        openStart = generation
      }
      continue
    }

    const removalTargets = [
      {
        userId: event.payload.removed_user_id,
        deviceId: event.payload.removed_device_id
      },
      ...(event.payload.removals ?? []).map((removal) => ({
        userId: removal.removed_user_id,
        deviceId: removal.removed_device_id
      }))
    ]
    const removesDevice =
      event.event_type === 'mls_remove' &&
      removalTargets.some(
        (target) =>
          target.userId === userId &&
          (target.deviceId == null || target.deviceId === deviceId)
      )
    if (!removesDevice) {
      continue
    }

    sawRelevantEvent = true
    const start = openStart ?? 0
    if (generation > start) {
      ranges.push({ start, end: generation })
    }
    openStart = null
  }

  if (openStart != null) {
    ranges.push({ start: openStart, end: null })
  } else if (!sawRelevantEvent) {
    // Initial group creators and continuously-present pre-provenance devices
    // have no join transition. They are eligible from epoch zero only while no
    // durable removal proves a membership boundary.
    ranges.push({ start: 0, end: null })
  }

  return ranges
}

function membershipRangeIncludesEpoch(ranges: MembershipEpochRange[], epoch: number): boolean {
  return ranges.some((range) => epoch >= range.start && (range.end == null || epoch < range.end))
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
  previousTranscriptHash: Uint8Array | null
  baseState: Uint8Array | null
  resultState: Uint8Array | null
  baseEpoch: number | null
}
type PreparedSponsoredTransition = PendingSponsoredTransition & {
  newState: GroupState
}
type GroupInfoIntentPayload = {
  groupInfoData: string
  ratchetTreeData: string | null
  epoch: number
}
type ExternalCommitIntentPayload = PendingExternalCommitBroadcast
type JournaledControlIntentPayload = {
  transport: 'scope' | 'topic'
  scope: EncryptedScope | null
  event: 'mls_remove' | 'mls_welcome' | 'mls_resync_request' | 'mls_history_request' | 'mls_history_bundle'
  eventPayload: Record<string, unknown>
}
type SponsoredTransitionIntentPayload = Omit<
  PendingSponsoredTransition,
  'groupInfoData' | 'ratchetTreeData' | 'previousTranscriptHash' | 'baseState' | 'resultState'
> & {
  groupInfoData: string | null
  ratchetTreeData: string | null
  previousTranscriptHash: string | null
  baseState: string | null
  resultState: string | null
}
type ScopeRepairStatus = 'healthy'
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
  { status: 'applied'; fingerprint: string }
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
  return left.epoch === right.epoch &&
    uint8ArraysEqual(left.groupInfoData, right.groupInfoData) &&
    uint8ArraysEqual(left.ratchetTreeData, right.ratchetTreeData)
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
    uint8ArraysEqual(left.previousTranscriptHash, right.previousTranscriptHash) &&
    uint8ArraysEqual(left.baseState, right.baseState) &&
    uint8ArraysEqual(left.resultState, right.resultState) &&
    left.baseEpoch === right.baseEpoch
  )
}

function createControlIntent(
  operation: ControlIntentRecord['operation'],
  scopeId: string,
  idempotencyKey: string,
  membershipGeneration: number,
  payload: unknown
): ControlIntentRecord {
  const now = new Date().toISOString()
  return {
    version: 1,
    operation,
    idempotencyKey,
    scopeId,
    membershipGeneration,
    payloadJson: JSON.stringify(payload),
    attempts: 0,
    state: 'pending',
    resultJson: null,
    createdAt: now,
    updatedAt: now
  }
}

function parseControlIntentPayload<T>(intent: ControlIntentRecord): T {
  return JSON.parse(intent.payloadJson) as T
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
    roomDataKeys: checkpoint.roomDataKeys.map((record) => ({
      ...record,
      ciphertext: new Uint8Array(record.ciphertext),
      nonce: new Uint8Array(record.nonce)
    })),
    controlIntents: checkpoint.controlIntents.map((intent) => ({ ...intent }))
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
  value: { status: string
    failureCount: number
    lastError: string | null
    updatedAt: string | null } | null
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

type RequestHistoryAuthorization = ApplicationHistoryAuthorization & {
  requestId: string
}

type HistoryBundleItem = {
  id: string
  content: string
  mlsEpoch: number
  channelId?: string | null
  conversationId?: string | null
  serverId?: string | null
  senderId?: string | null
  sender?: VesperMemberPreview | null
  insertedAt?: string
  expiresAt?: string | null
  parentMessageId?: string | null
  threadRootMessageId?: string | null
  replyToMessageId?: string | null
  isReply?: boolean
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
  const mlsEpoch =
    typeof item.mlsEpoch === 'number' && Number.isInteger(item.mlsEpoch) && item.mlsEpoch >= 0
      ? item.mlsEpoch
      : null
  if (!id || !content || mlsEpoch == null) {
    return null
  }

  return {
    id,
    content,
    mlsEpoch,
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
        : null,
    threadRootMessageId:
      typeof item.threadRootMessageId === 'string' || item.threadRootMessageId === null
        ? (item.threadRootMessageId as string | null)
        : null,
    replyToMessageId:
      typeof item.replyToMessageId === 'string' || item.replyToMessageId === null
        ? (item.replyToMessageId as string | null)
        : null,
    isReply: typeof item.isReply === 'boolean' ? item.isReply : undefined
  }
}

export class VesperEncryptedChat {
  private readonly client: VesperClient
  private readonly storage: CryptoStorageRuntime
  private readonly groupLockNamespace: string
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
  private readonly scopeHistoryFullyBackfilled = new Set<string>()
  private readonly membershipWaiters = new Map<string, Set<(ready: boolean) => void>>()
  private readonly epochWaiters = new Map<string, Set<(epoch: number) => void>>()
  private readonly welcomeAppliedAtByScope = new Map<string, number>()
  private readonly recentDmJoinProcessed = new Map<string, number>()
  private readonly scopeKinds = new Map<string, 'channel' | 'dm'>()
  private readonly yieldedDmScopes = new Set<string>()
  private readonly initialDmJoinCoverageWaits = new Map<string, Promise<boolean>>()
  private readonly pendingGroupCreations = new Map<string, Promise<void>>()
  private readonly pendingExternalCommits = new Map<string, Promise<boolean>>()
  private readonly scopesWithoutRemoteGroup = new Set<string>()
  private readonly pendingGroupInfoPublishes = new Map<string, PendingGroupInfoPublish>()
  private readonly groupInfoPublishRetryAttempts = new Map<string, number>()
  private readonly groupInfoPublishRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly lastSuccessfulGroupInfoPublishEpochs = new Map<string, number>()
  private readonly pendingExternalCommitBroadcasts = new Map<string, PendingExternalCommitBroadcast>()
  private readonly pendingSponsoredTransitions = new Map<string, PendingSponsoredTransition>()
  private readonly pendingJournaledControlIntents = new Map<string, ControlIntentRecord>()
  private readonly journaledControlRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly sponsoredTransitionRollbackStates = new Map<string, GroupState>()
  private readonly externalCommitBroadcastRetryAttempts = new Map<string, number>()
  private readonly externalCommitBroadcastRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly sponsoredTransitionRetryAttempts = new Map<string, number>()
  private readonly sponsoredTransitionRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly messageSendRetryAttempts = new Map<string, number>()
  private readonly messageSendRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly checkpointPersistChains = new Map<string, Promise<void>>()
  private readonly recentCommitFingerprints = new Map<string, string[]>()
  private readonly recentHistoryBundleFingerprints = new Map<string, string[]>()
  private readonly inFlightHistoryBundleProcesses = new Map<string, Promise<boolean>>()
  private readonly durableReplayProcesses = new Map<string, Promise<void>>()
  private readonly scopeRepairStates = new Map<string, ScopeRepairState>()
  private readonly replayBlockedScopes = new Set<string>()
  private readonly pendingRepairFetches = new Map<string, Promise<void>>()
  private readonly lastRepairFetchAt = new Map<string, number>()
  private readonly recoveryPackagePublishes = new Map<string, Promise<void>>()
  private readonly recoveryPackageRepublishRequested = new Set<string>()
  private readonly recoveryPackageLastRequestedAt = new Map<string, number>()
  private readonly importedRecoveryPackageCursors = new Map<string, number>()
  private readonly importedRecoveryPackageFingerprints = new Map<string, string>()
  private readonly roomCrypto = new RoomCryptoState()
  private readonly diagnostics = new MLSDiagnostics()
  private readonly welcomeInProgress = new Set<string>()
  private readonly welcomeReceivedScopes = new Set<string>()
  private restoreConnectionsPromise: Promise<void> | null = null

  constructor(client: VesperClient) {
    this.client = client
    this.storage = client.getStorageRuntime()
    this.groupLockNamespace = crypto.randomUUID()

    this.client.on('connected', () => {
      void this.handleConnected()
    })
    this.client.on('disconnected', () => {
      this.clearConnections()
      this.pauseJournaledControlRetries()
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
      await this.flushPendingJournaledControlIntents()
      await this.processPendingRepairArtifactsForKnownScopes()
      await this.flushPendingMessageSends()
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
            const nextEvent = await this.processScopeEventWithCorrectLock(
              scope,
              event,
              normalizePayload(payload)
            )
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
    return await withGroupLock(`${this.groupLockNamespace}:${scopeId}`, async () => {
      return await this.withStorageContext(operation)
    }, priority)
  }

  private async withApplicationScopeOperation<T>(
    scope: EncryptedScope,
    operation: () => Promise<T>,
    priority: Parameters<typeof withGroupLock>[2] = 'normal'
  ): Promise<T> {
    return await withGroupLock(
      `${this.groupLockNamespace}:application:${this.resolveRoomId(scope)}`,
      async () => {
        return await this.withStorageContext(operation)
      },
      priority
    )
  }

  private async prepareScopeControlForRead(scope: EncryptedScope): Promise<void> {
    await this.ensureScopeTopology(scope)
    const groupId = this.resolveMlsGroupId(scope)
    await this.withLockedScopeOperation(groupId, async () => {
      this.scopeKinds.set(groupId, scope.channelId ? 'channel' : scope.kind)
      await this.ensureGroupMembership(groupId)
      await this.replayDurableEventsLocked(groupId)
    })
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
    const groupId = this.resolveMlsGroupId(scope)
    const inflight = this.pendingRepairFetches.get(groupId)
    if (inflight) {
      await inflight
      return
    }

    const lastFetchAt = this.lastRepairFetchAt.get(groupId) ?? 0
    if (!force && Date.now() - lastFetchAt < REPAIR_FETCH_COOLDOWN_MS) {
      return
    }

    const run = this.withLockedScopeOperation(groupId, async () => {
      this.scopeKinds.set(groupId, scope.channelId ? 'channel' : scope.kind)
      this.lastRepairFetchAt.set(groupId, Date.now())

      await this.processPendingResyncRequests(scope)
      await this.processPendingHistoryRequests(scope)
      await this.processPendingHistoryBundles(scope)
    }, 'urgent').finally(() => {
      this.pendingRepairFetches.delete(groupId)
    })

    this.pendingRepairFetches.set(groupId, run)
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
    this.scopeHistoryFullyBackfilled.clear()
    this.inFlightScopePreparations.clear()
    this.backgroundChannelMembershipRetries.clear()
    this.scopesWithoutRemoteGroup.clear()
    this.welcomeAppliedAtByScope.clear()
    this.recentDmJoinProcessed.clear()
    this.yieldedDmScopes.clear()
    this.initialDmJoinCoverageWaits.clear()
    this.pendingGroupInfoPublishes.clear()
    this.groupInfoPublishRetryAttempts.clear()
    for (const timer of this.groupInfoPublishRetryTimers.values()) {
      clearTimeout(timer)
    }
    this.groupInfoPublishRetryTimers.clear()
    this.lastSuccessfulGroupInfoPublishEpochs.clear()
    this.pendingExternalCommitBroadcasts.clear()
    this.pendingSponsoredTransitions.clear()
    this.pendingJournaledControlIntents.clear()
    for (const timer of this.journaledControlRetryTimers.values()) {
      clearTimeout(timer)
    }
    this.journaledControlRetryTimers.clear()
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
    this.messageSendRetryAttempts.clear()
    for (const timer of this.messageSendRetryTimers.values()) {
      clearTimeout(timer)
    }
    this.messageSendRetryTimers.clear()
    this.checkpointPersistChains.clear()
    this.recentCommitFingerprints.clear()
    this.recentHistoryBundleFingerprints.clear()
    this.inFlightHistoryBundleProcesses.clear()
    this.durableReplayProcesses.clear()
    this.scopeRepairStates.clear()
    this.replayBlockedScopes.clear()
    this.pendingRepairFetches.clear()
    this.lastRepairFetchAt.clear()
    this.importedRecoveryPackageCursors.clear()
    this.importedRecoveryPackageFingerprints.clear()
    this.roomCrypto.clear()

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
      const topology = await this.ensureScopeTopology(scope)
      // Application events remain room-wide. MLS control events move to the
      // assigned cohort topic once the topology is multi-cohort.
      const watchScope = scope.channelId ? { kind: 'channel' as const, id: scope.channelId } : scope
      const topic = scopeTopic(watchScope)
      const controlTopic =
        topology.mode === 'multi_cohort' ? `crypto:cohort:${topology.groupId}` : null
      const watchedTopics = controlTopic ? [topic, controlTopic] : [topic]

      for (const watchedTopic of watchedTopics) {
        this.scopeWatchRefs.set(
          watchedTopic,
          (this.scopeWatchRefs.get(watchedTopic) ?? 0) + 1
        )
      }

      if (listener) {
        const listeners = this.scopeListeners.get(topic) ?? new Set<ScopeListener>()
        listeners.add(listener)
        this.scopeListeners.set(topic, listeners)
      }

      const handleEvent = async (event: string, payload: unknown): Promise<void> => {
        const nextEvent = await this.processScopeEventWithCorrectLock(
          scope,
          event,
          normalizePayload(payload)
        )
        if (nextEvent) {
          await this.notifyScopeListeners(
            nextEvent.scope,
            nextEvent.event,
            nextEvent.payload,
            nextEvent.message
          )
        }
      }

      if (!this.joinedTopics.has(topic)) {
        this.scopeKinds.set(watchScope.id, watchScope.kind)
        const dispose = await this.client.watchScope(watchScope.kind, watchScope.id, async ({ event, payload }) => {
          if (controlTopic && event.startsWith('mls_')) {
            return
          }
          await handleEvent(event, payload)
        })

        this.scopeDisposers.set(topic, dispose)
        this.joinedTopics.add(topic)
      }

      if (controlTopic && !this.joinedTopics.has(controlTopic)) {
        const dispose = await this.client.subscribeTopicWithAck(controlTopic, handleEvent)
        this.scopeDisposers.set(controlTopic, dispose)
        this.joinedTopics.add(controlTopic)
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

        for (const watchedTopic of watchedTopics) {
          const remainingRefs = (this.scopeWatchRefs.get(watchedTopic) ?? 1) - 1
          if (remainingRefs > 0) {
            this.scopeWatchRefs.set(watchedTopic, remainingRefs)
            continue
          }

          this.scopeWatchRefs.delete(watchedTopic)
          this.scopeDisposers.get(watchedTopic)?.()
          this.scopeDisposers.delete(watchedTopic)
          this.joinedTopics.delete(watchedTopic)
        }
      }
    })
  }

  async processScopeEvent(
    scope: EncryptedScope,
    event: string,
    payload: Record<string, unknown> | null
  ): Promise<EncryptedScopeWatchEvent | null> {
    return await this.processScopeEventWithCorrectLock(scope, event, payload)
  }

  private async processScopeEventWithCorrectLock(
    scope: EncryptedScope,
    event: string,
    payload: Record<string, unknown> | null
  ): Promise<EncryptedScopeWatchEvent | null> {
    const topology = await this.ensureScopeTopology(scope)
    if (!event.startsWith('mls_')) {
      return await this.withApplicationScopeOperation(scope, async () => {
        return await this.handleScopeEvent(scope, event, payload)
      }, 'urgent')
    }

    return await this.withLockedScopeOperation(topology.groupId, async () => {
      return await this.handleScopeEvent(scope, event, payload)
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

    return findExactMemberLeafIndex(state, buildClientCredentialIdentity(userId, deviceId)) !== null
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
    await this.ensureScopeTopology(scope)
    const logicalScopeId = this.resolveRoomId(scope)
    return await this.withApplicationScopeOperation(scope, async () => {
      const startedAt = performance.now()
      const limit = options.limit ?? 50

      // Application replay has its own room lock. MLS readiness and replay use
      // the assigned group lock only while they mutate control state, then
      // release it before message decryption can derive a cohort wrapping key.
      const controlPromise = this.prepareScopeControlForRead(scope)
      const cached = await this.loadProcessedCachedMessages(logicalScopeId)
      const existing = this.scopeMessages.get(logicalScopeId) ?? cached
      // Only treat the cached window as a safe incremental-resume point once a
      // prior *full* fetch proved it already covers this scope's entire
      // history (the server returned fewer messages than requested). Without
      // that proof, a narrow "peek" fetch (e.g. limit: 1 for a notification
      // preview) would cache just the single newest message; trusting its
      // room_seq as an afterSeq cursor for a later, larger request would
      // silently and permanently skip every message between the peek and the
      // true start of that larger window.
      const afterSeq = this.scopeHistoryFullyBackfilled.has(logicalScopeId)
        ? highestRoomSeq(existing)
        : null
      const deltaPromise =
        afterSeq == null
          ? this.fetchInitialScopeWindow(scope, limit)
          : this.fetchIncrementalScopeDelta(scope, limit, afterSeq)

      const [, delta] = await Promise.all([controlPromise, deltaPromise])
      if (afterSeq == null && !delta.hasMore) {
        this.scopeHistoryFullyBackfilled.add(logicalScopeId)
      }
      let applied = await this.applyScopeSyncDelta(scope, existing, delta.messages, delta.events)
      applied = {
        ...applied,
        messages: await this.retryFailedRoomApplicationMessages(scope, applied.messages)
      }

      if (applied.messages.some((message) => message.decryptionFailed && (message.raw.encryption_scheme ?? 'mls') === 'mls')) {
        const groupId = this.resolveMlsGroupId(scope)
        // A history bundle advances the same one-shot MLS receive ratchet as
        // commits and ordinary ciphertext. Keep draft decryption and checkpoint
        // persistence under the group lock; otherwise a bundle started at epoch
        // N can finish after an external commit and overwrite epoch N+1 while
        // retaining its advanced durable-event cursor.
        await this.withLockedScopeOperation(groupId, async () => {
          await this.processPendingHistoryBundles(scope, groupId)
        }, 'urgent')
        const recoveredExisting = await this.loadProcessedCachedMessages(logicalScopeId)
        applied = await this.applyScopeSyncDelta(scope, recoveredExisting, delta.messages, [])
      }

      if (applied.messages.some((message) => message.decryptionFailed)) {
        const priorPackageFingerprint = this.importedRecoveryPackageFingerprints.get(logicalScopeId) ?? null
        await this.importScopeRecoveryPackage(scope)
        const importedPackageFingerprint = this.importedRecoveryPackageFingerprints.get(logicalScopeId) ?? null

        if (importedPackageFingerprint != null && importedPackageFingerprint !== priorPackageFingerprint) {
          const recoveredExisting = await this.loadProcessedCachedMessages(logicalScopeId)
          applied = await this.applyScopeSyncDelta(scope, recoveredExisting, delta.messages, [])
        }
      }

      return {
        durationMs: performance.now() - startedAt,
        messages: applied.messages,
        events: applied.events,
        hasMore: delta.hasMore,
        olderCursor: delta.olderCursor,
        latestRoomSeq: delta.latestRoomSeq
      }
    })
  }

  async backfillScope(
    scope: EncryptedScope,
    before: string,
    options: { limit?: number } = {}
  ): Promise<ScopeSyncResult> {
    await this.ensureScopeTopology(scope)
    const logicalScopeId = this.resolveRoomId(scope)
    return await this.withApplicationScopeOperation(scope, async () => {
      const startedAt = performance.now()
      const limit = options.limit ?? 50
      const syncKind = scope.channelId ? 'channel' : scope.kind
      const syncId = scope.channelId ?? scope.id
      const controlPromise = this.prepareScopeControlForRead(scope)
      const syncPromise = this.client.fetchScopeSync({
        scopes: [{ kind: syncKind, id: syncId, before }],
        limit
      })
      const [syncState] = await Promise.all([syncPromise, controlPromise])
      const entry = syncState.scopes.find((candidate) => candidate.scope_id === syncId) ?? null
      const existing =
        this.scopeMessages.get(logicalScopeId) ?? (await this.loadProcessedCachedMessages(logicalScopeId))
      const applied = await this.applyScopeSyncDelta(
        scope,
        existing,
        sortRawMessages(entry?.messages ?? []),
        this.normalizeSyncEvents(entry)
      )

      if (!(entry?.has_more ?? false)) {
        this.scopeHistoryFullyBackfilled.add(logicalScopeId)
      }

      return {
        durationMs: performance.now() - startedAt,
        messages: applied.messages,
        events: applied.events,
        hasMore: entry?.has_more ?? false,
        olderCursor: entry?.older_cursor ?? null,
        latestRoomSeq: entry?.latest_room_seq ?? highestRoomSeq(applied.messages) ?? 0
      }
    })
  }

  /** Resolve the durable room key. A migrated DM's conversation ID is only a client alias. */
  private resolveRoomId(scope: EncryptedScope): string {
    return this.roomCrypto.roomId(scope)
  }

  private async ensureScopeTopology(
    scope: EncryptedScope
  ): Promise<RoomCryptoTopologyResolution> {
    const cached = this.roomCrypto.topology(scope)
    if (cached) {
      return cached
    }

    const topology = await this.client.fetchRoomCryptoTopology(this.resolveRoomId(scope))
    this.roomCrypto.rememberTopology(scope, topology)
    return topology
  }

  /** Resolve the MLS group key from the durable room topology. */
  private resolveMlsGroupId(scope: EncryptedScope): string {
    return this.roomCrypto.groupId(scope)
  }

  /** Ensures the MLS group for a scope is ready, optionally creating it if missing. Routes to channel or DM-specific logic. */
  async ensureScopeReady(scope: EncryptedScope, allowCreate = false): Promise<boolean> {
    return await this.withStorageContext(async () => {
      await this.ensureScopeTopology(scope)
      const groupId = this.resolveMlsGroupId(scope)
      this.scopeKinds.set(groupId, scope.channelId ? 'channel' : scope.kind)
      return await this.ensureChannelGroupReady(scope, allowCreate)
    })
  }

  /** Caller must already hold the resolved MLS group lock. */
  private async ensureScopeReadyLocked(scope: EncryptedScope): Promise<boolean> {
    await this.ensureScopeTopology(scope)
    const groupId = this.resolveMlsGroupId(scope)
    this.scopeKinds.set(groupId, scope.channelId ? 'channel' : scope.kind)

    if (!(await this.ensureGroupMembership(groupId))) {
      return false
    }

    await this.replayDurableEventsLocked(groupId)
    return this.hasGroup(groupId) && !this.replayBlockedScopes.has(groupId)
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
    // Every send gets an idempotency key, even from callers that didn't
    // supply one (bots, examples). This is what makes a durable retry safe:
    // the server's (scope, sender, client_nonce) unique index guarantees a
    // replayed send can never create a duplicate message.
    const clientNonce = options.clientNonce ?? crypto.randomUUID()
    const resolvedOptions: SendPayloadOptions = { ...options, clientNonce }

    await this.withStorageContext(async () => {
      // Persist the send intent before attempting the network write. If the
      // process crashes between now and a confirmed server ack, this entry
      // survives restart and gets replayed by flushPendingMessageSends() on
      // reconnect — the invariant is "a message the user believes was sent is
      // either delivered or the user is told it failed", never silently lost.
      await this.queuePendingMessageSend(scope, payload, resolvedOptions)

      try {
        await this.performSend(scope, payload, resolvedOptions)
      } catch (error) {
        // We're handing a definitive failure back to a live caller (which will
        // mark the local message failed and surface an error) — local delivery
        // state is source of truth again, so the durable entry is no longer
        // needed. It exists only to survive a crash the caller never sees.
        await this.clearPendingMessageSend(clientNonce)
        throw error
      }

      await this.clearPendingMessageSend(clientNonce)
    })
  }

  /** The actual send attempt, shared by sendPayload's first try and the outbox flush's retries. */
  private async performSend(
    scope: EncryptedScope,
    payload: MessagePayload,
    options: SendPayloadOptions,
    retryAttempt = 0
  ): Promise<void> {
    const release = await this.acquireScopeWatch(scope)
    let attemptedPush = false
    let pushed = false
    let pushError: unknown = null

    try {
      try {
        pushed = await this.withReadyApplicationOperation(scope, true, async () => {
          const clientNonce = options.clientNonce ?? crypto.randomUUID()
          const authenticatedPayload = await this.authenticateMessagePayload(scope, payload, {
            type: 'client_nonce',
            value: clientNonce,
            revision: 0
          })
          const plaintext = encodePayload(authenticatedPayload)
          const encrypted = await this.encryptApplicationForScope(
            scope,
            plaintext,
            'message',
            clientNonce
          )
          await cacheSentMessage(this.storage, encrypted.ciphertext, plaintext)

          const messagePayload: Record<string, unknown> = {
            ciphertext: encrypted.ciphertext,
            mls_epoch: encrypted.epoch,
            encryption_scheme: encrypted.scheme,
            encryption_group_id: encrypted.groupId,
            history_signing_public_key:
              authenticatedPayload.history_auth?.signer_public_key,
            history_revision: 0
          }

          if (options.threadRootMessageId) {
            messagePayload.thread_root_message_id = options.threadRootMessageId
          }

          if (options.replyToMessageId) {
            messagePayload.reply_to_message_id = options.replyToMessageId
          }

          if (options.parentMessageId) {
            messagePayload.parent_message_id = options.parentMessageId
          }

          if (options.isReply) {
            messagePayload.is_reply = true
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
          const sent = await this.pushScopeEventResolved(scope, 'new_message', messagePayload)

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
        options.clientNonce && (await this.confirmDeliveredSend(scope, options.clientNonce))
      ) {
        return
      }

      if (retryAttempt === 0) {
        // A rejected stale-epoch ciphertext is never retried as-is. Confirming
        // the nonce first rules out a dropped acknowledgement; only then do we
        // replay the canonical durable prefix and encrypt a fresh ciphertext.
        const groupId = this.resolveMlsGroupId(scope)
        await this.withLockedScopeOperation(groupId, async () => {
          await this.replayDurableEventsLocked(groupId)
        })
        const roomId = this.resolveRoomId(scope)
        this.roomCrypto.forgetTopology(roomId)
        await this.ensureScopeTopology(scope)
        await new Promise((resolve) => setTimeout(resolve, SEND_RETRY_WAIT_MS))
        return await this.performSend(scope, payload, options, retryAttempt + 1)
      }

      if (pushError) {
        throw pushError
      }

      throw new Error(`Failed to send message in ${scopeTopic(scope)}`)
    } finally {
      release()
    }
  }

  private async authenticateMessagePayload(
    scope: EncryptedScope,
    payload: MessagePayload,
    binding: MessageHistoryBinding
  ): Promise<MessagePayload> {
    const session = this.client.getAuthSession()
    const user = session?.user ?? this.client.getState().user
    if (!user) {
      throw new Error('Cannot authenticate message history without an account session')
    }

    const identity = await this.withStorageContext(async () =>
      await this.storage.loadIdentity(user.id)
    )
    if (!identity?.signaturePrivateKey) {
      throw new Error('Cannot authenticate message history without an unlocked signing key')
    }

    const scopeId = this.resolveRoomId(scope)
    const signature = signWithSerializedIdentity(
      buildClientCredentialIdentity(user.id, this.requireDeviceId()),
      identity.publicIdentityKey,
      identity.signaturePrivateKey,
      messageHistorySigningBytes(scopeId, binding, payload)
    )

    return withMessageHistoryAuthentication(payload, {
      v: 1,
      scope_id: scopeId,
      binding_type: binding.type,
      binding: binding.value,
      revision: binding.revision,
      signer_public_key: uint8ToBase64(identity.publicIdentityKey),
      signature: uint8ToBase64(signature)
    })
  }

  private async queuePendingMessageSend(
    scope: EncryptedScope,
    payload: MessagePayload,
    options: SendPayloadOptions
  ): Promise<void> {
    const clientNonce = options.clientNonce
    if (!clientNonce) {
      return
    }

    // Unlike the control-plane outboxes (GroupInfo/external-commit/sponsored
    // transition), there is no in-memory fallback tier here — a message send
    // has nothing else backing its durability. If this write fails, the
    // caller must see a real failure rather than proceed believing the send
    // is crash-safe when it silently is not.
    await this.storage.savePendingMessageSend({
      clientNonce,
      scopeKind: scope.kind,
      scopeId: scope.id,
      scopeChannelId: scope.channelId ?? null,
      payloadJson: JSON.stringify({ payload, options }),
      insertedAt: new Date().toISOString()
    })
  }

  private async clearPendingMessageSend(clientNonce: string): Promise<void> {
    this.messageSendRetryAttempts.delete(clientNonce)
    const timer = this.messageSendRetryTimers.get(clientNonce)
    if (timer) {
      clearTimeout(timer)
      this.messageSendRetryTimers.delete(clientNonce)
    }

    await this.storage.deletePendingMessageSend(clientNonce).catch((error) =>
      this.logIgnoredError('clear pending message send', error)
    )
  }

  private async flushPendingMessageSends(): Promise<void> {
    let pending: Array<{ clientNonce: string }> = []
    try {
      pending = await this.storage.loadPendingMessageSends()
    } catch (error) {
      this.logIgnoredError('load pending message sends', error)
      return
    }

    for (const entry of pending) {
      await this.flushPendingMessageSend(entry.clientNonce)
    }
  }

  private async flushPendingMessageSend(clientNonce: string): Promise<void> {
    if (this.messageSendRetryTimers.has(clientNonce)) {
      return
    }

    const pending = (await this.storage.loadPendingMessageSends()).find(
      (entry) => entry.clientNonce === clientNonce
    )
    if (!pending) {
      return
    }

    let parsed: { payload: MessagePayload
      options: SendPayloadOptions } | null = null
    try {
      parsed = JSON.parse(pending.payloadJson)
    } catch {
      parsed = null
    }

    if (!parsed) {
      // Corrupt entry — cannot be replayed correctly. Drop it rather than
      // retry a payload we can no longer reconstruct.
      await this.clearPendingMessageSend(clientNonce)
      return
    }

    const scope: EncryptedScope = {
      kind: pending.scopeKind,
      id: pending.scopeId,
      channelId: pending.scopeChannelId ?? undefined
    }

    try {
      await this.performSend(scope, parsed.payload, parsed.options)
      await this.clearPendingMessageSend(clientNonce)
    } catch (error) {
      this.logIgnoredError('flush pending message send', error)
      this.scheduleMessageSendRetry(clientNonce)
    }
  }

  private scheduleMessageSendRetry(clientNonce: string): void {
    if (this.messageSendRetryTimers.has(clientNonce)) {
      return
    }

    const attempt = (this.messageSendRetryAttempts.get(clientNonce) ?? 0) + 1
    this.messageSendRetryAttempts.set(clientNonce, attempt)
    const delayMs = Math.min(30_000, 500 * 2 ** Math.min(attempt - 1, 6))

    const timer = setTimeout(() => {
      this.messageSendRetryTimers.delete(clientNonce)
      void this.flushPendingMessageSend(clientNonce)
    }, delayMs)
    this.unrefRetryTimer(timer)

    this.messageSendRetryTimers.set(clientNonce, timer)
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
    await this.ensureScopeTopology(scope)
    const groupId = this.resolveMlsGroupId(scope)
    return await this.withLockedScopeOperation(groupId, async () => {
      this.scopeKinds.set(groupId, scope.channelId ? 'channel' : scope.kind)
      const ready = await this.ensureGroupMembership(groupId)
      if (!ready) {
        throw new Error(`${scope.kind} group is still syncing`)
      }

      return await this.encryptForScope(groupId, plaintext)
    })
  }

  async decryptOpaque(
    scope: EncryptedScope,
    ciphertext: string,
    messageEpoch: number | null = null
  ): Promise<string | null> {
    const groupId = this.resolveMlsGroupId(scope)
    return await this.withLockedScopeOperation(groupId, async () => {
      this.scopeKinds.set(groupId, scope.channelId ? 'channel' : scope.kind)
      return await this.decryptForScopeWithRecoveryLocked(scope, ciphertext, messageEpoch)
    })
  }

  async decryptOpaqueBatch(
    scope: EncryptedScope,
    items: Array<{ ciphertext: string; messageEpoch?: number | null }>
  ): Promise<Array<string | null>> {
    const groupId = this.resolveMlsGroupId(scope)
    return await this.withLockedScopeOperation(groupId, async () => {
      this.scopeKinds.set(groupId, scope.channelId ? 'channel' : scope.kind)
      const decrypted: Array<string | null> = []

      for (const item of items) {
        decrypted.push(
          await this.decryptForScopeWithRecoveryLocked(scope, item.ciphertext, item.messageEpoch ?? null)
        )
      }

      return decrypted
    })
  }

  /** Public API: loads or restores MLS group membership for a scope from storage or pending welcomes. */
  async ensureMembership(scope: EncryptedScope): Promise<boolean> {
    await this.ensureScopeTopology(scope)
    const groupId = this.resolveMlsGroupId(scope)
    return await this.withLockedScopeOperation(groupId, async () => {
      this.scopeKinds.set(groupId, scope.channelId ? 'channel' : scope.kind)
      return await this.ensureGroupMembership(groupId)
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
      await this.replayDurableEventsLocked(scopeId)
    })
  }

  async requestJoin(scope: EncryptedScope): Promise<void> {
    await this.withStorageContext(async () => {
      await this.requestMlsJoin(scope)
    })
  }

  async requestJoinAll(scope: EncryptedScope): Promise<void> {
    const groupId = this.resolveMlsGroupId(scope)
    await this.withLockedScopeOperation(groupId, async () => {
      this.scopeKinds.set(groupId, scope.channelId ? 'channel' : scope.kind)

      if (this.hasGroup(groupId) && !(await this.ensureCurrentGroupInfoPublished(groupId))) {
        throw new Error(`Failed to publish GroupInfo for ${scopeTopic(scope)}`)
      }

      const pushed = await this.pushScopeEventResolved(scope, 'mls_request_join_all', {})
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
    const groupId = this.resolveMlsGroupId(scope)
    await this.withStorageContext(async () => {
      if (
        !(await this.pushResyncRequestForScope(groupId, scope.channelId ? 'channel' : scope.kind, {
          lastKnownEpoch: options.lastKnownEpoch ?? null,
          reason: options.reason ?? null,
          username: options.username ?? null
        }))
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
    const groupId = this.resolveMlsGroupId(scope)
    await this.withLockedScopeOperation(groupId, async () => {
      this.scopeKinds.set(groupId, scope.channelId ? 'channel' : scope.kind)
      await this.requestScopeHistorySync(scope, options.force ?? false)
    })
  }

  async drainScopeRepairArtifacts(
    scope: EncryptedScope,
    options: ScopeRepairDrainOptions = {}
  ): Promise<void> {
    const groupId = this.resolveMlsGroupId(scope)
    this.scopeKinds.set(groupId, scope.channelId ? 'channel' : scope.kind)
    await this.processPendingRepairArtifacts(scope, options.force ?? false)
  }

  async prepareScopeForRead(
    scope: EncryptedScope,
    options: ScopePreparationOptions = {}
  ): Promise<boolean> {
    const groupId = this.resolveMlsGroupId(scope)
    const existing = this.inFlightScopePreparations.get(groupId)
    if (existing) {
      return await existing
    }

    const run = this.withStorageContext(() =>
      this.prepareScopeForReadInternal(scope, options)
    ).finally(() => {
      this.inFlightScopePreparations.delete(groupId)
    })

    this.inFlightScopePreparations.set(groupId, run)
    return await run
  }

  async createScopeGroup(scope: EncryptedScope): Promise<boolean> {
    await this.ensureScopeTopology(scope)
    const groupId = this.resolveMlsGroupId(scope)
    return await this.withLockedScopeOperation(groupId, async () => {
      this.scopeKinds.set(groupId, scope.channelId ? 'channel' : scope.kind)
      await this.createGroup(groupId)
      if (!this.hasGroup(groupId)) {
        return false
      }
      if (!(await this.ensureCurrentGroupInfoPublished(groupId))) {
        return false
      }
      const localUserId = this.client.getAuthSession()?.user.id ?? this.client.getState().user?.id
      if (!localUserId) {
        return false
      }
      return await this.ensureInitialDmParticipantCoverage(
        scope,
        this.resolveRoomId(scope),
        groupId,
        localUserId
      )
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

  private async resetScopeState(
    scopeId: string,
    options: { consumedEventSeq?: number | null } = {}
  ): Promise<void> {
    // A removal is a durable membership boundary. Persisting the cleared state
    // and its sequence in one checkpoint prevents a later recovery from
    // resurrecting this scope and then applying the same removal against it.
    const consumedEventSeq = options.consumedEventSeq ?? null
    this.groupStates.delete(scopeId)
    this.pendingCommits.delete(scopeId)
    this.scopeMessages.delete(scopeId)
    this.scopeHistoryFullyBackfilled.delete(scopeId)
    this.inFlightScopePreparations.delete(scopeId)
    this.recentScopeResyncRequests.delete(scopeId)
    this.recentScopeHistoryRequests.delete(scopeId)
    this.welcomeAppliedAtByScope.delete(scopeId)
    this.welcomeReceivedScopes.delete(scopeId)
    this.initialDmJoinCoverageWaits.delete(scopeId)
    this.pendingGroupCreations.delete(scopeId)
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
    this.replayBlockedScopes.delete(scopeId)
    this.pendingRepairFetches.delete(scopeId)
    this.lastRepairFetchAt.delete(scopeId)
    this.pendingGroupInfoPublishes.delete(scopeId)
    this.pendingExternalCommitBroadcasts.delete(scopeId)
    this.pendingSponsoredTransitions.delete(scopeId)
    this.sponsoredTransitionRollbackStates.delete(scopeId)
    this.notifyMembershipWaiters(scopeId, false)
    this.membershipWaiters.delete(scopeId)

    await this.withScopeCheckpointMutation(scopeId, (checkpoint) => {
      checkpoint.groupState = null
      checkpoint.lastEventSeq = Math.max(checkpoint.lastEventSeq, consumedEventSeq ?? 0)
      checkpoint.recentCommitFingerprints = []
      checkpoint.recentHistoryBundleFingerprints = []
      checkpoint.repairState = null
      checkpoint.roomDataKeys = []
      checkpoint.controlIntents = []
    })
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

  async deriveScopeCohortWrappingKey(
    scope: EncryptedScope
  ): Promise<DerivedCohortWrappingKey | null> {
    return await this.deriveCohortWrappingKeyForTopology(await this.ensureScopeTopology(scope))
  }

  private async deriveCohortWrappingKeyForTopology(
    topology: RoomCryptoTopologyResolution
  ): Promise<DerivedCohortWrappingKey | null> {
    if (!topology.cohortId) {
      return null
    }

    const groupId = topology.groupId
    await this.replayScopeEvents(groupId)

    return await this.withLockedScopeOperation(groupId, async () => {
      const state = this.groupStates.get(groupId)
      if (!state) {
        return null
      }

      const publishedGroupInfo = await fetchGroupInfo(groupId, this.client.getHttpClient())
      if (!publishedGroupInfo || publishedGroupInfo.epoch !== Number(state.groupContext.epoch)) {
        return null
      }

      return await deriveCohortWrappingKey(
        state,
        this.wrappingContext(topology, state),
        publishedGroupInfo.groupInfoData
      )
    })
  }

  async verifyScopeCohortWrappingPublication(
    scope: EncryptedScope,
    publication: CohortWrappingPublication
  ): Promise<boolean> {
    return await this.verifyCohortWrappingPublicationForTopology(
      await this.ensureScopeTopology(scope),
      publication
    )
  }

  private async verifyCohortWrappingPublicationForTopology(
    topology: RoomCryptoTopologyResolution,
    publication: CohortWrappingPublication
  ): Promise<boolean> {
    if (!topology.cohortId) {
      return false
    }

    return await this.withLockedScopeOperation(topology.groupId, async () => {
      const state = this.groupStates.get(topology.groupId)
      if (!state) {
        return false
      }

      const publishedGroupInfo = await fetchGroupInfo(topology.groupId, this.client.getHttpClient())
      if (!publishedGroupInfo || publishedGroupInfo.epoch !== Number(state.groupContext.epoch)) {
        return false
      }

      if (!publishedGroupInfo.ratchetTreeData) {
        return false
      }

      return await verifyCohortWrappingPublication(
        this.wrappingContext(topology, state),
        publication,
        publishedGroupInfo.groupInfoData,
        publishedGroupInfo.ratchetTreeData
      )
    })
  }

  private wrappingContext(
    topology: RoomCryptoTopologyResolution,
    state: GroupState
  ): CohortWrappingContext {
    return {
      roomId: topology.roomId,
      cohortId: topology.cohortId ?? topology.groupId,
      groupId: topology.groupId,
      topologyGeneration: topology.generation,
      mlsEpoch: Number(state.groupContext.epoch)
    }
  }

  async publishScopeCohortWrappingKey(scope: EncryptedScope): Promise<boolean> {
    const topology = await this.ensureScopeTopology(scope)
    if (!(await this.publishCohortWrappingKeyForTopology(topology))) {
      return false
    }

    const previous = await fetchActiveRoomKeyEpoch(
      this.resolveRoomId(scope),
      this.client.getHttpClient()
    )
    if (!previous || topology.state !== 'active') {
      return true
    }

    await this.coordinateRoomKeyEpoch(
      scope,
      'wrapping_key_rotation',
      `wrapping-key:${topology.roomId}:${topology.generation}:${topology.groupId}:${this.getGroupEpoch(topology.groupId) ?? 0}`
    )
    return true
  }

  async prepareCohortTopology(
    topology: RoomCryptoTopologyResolution,
    allowCreate = false
  ): Promise<boolean> {
    if (topology.mode !== 'multi_cohort' || !topology.cohortId) {
      return false
    }

    const groupId = topology.groupId
    const ready = await this.withLockedScopeOperation(groupId, async () => {
      this.scopeKinds.set(groupId, 'channel')
      if (await this.ensureGroupMembership(groupId)) {
        return true
      }
      if (!allowCreate) {
        return false
      }
      await this.createGroup(groupId)
      return this.hasGroup(groupId)
    })

    if (!ready) {
      return false
    }

    const existing = await fetchCohortWrappingKey(topology.groupId, this.client.getHttpClient())
    if (existing && existing.topologyGeneration === topology.generation) {
      const existingPublication: CohortWrappingPublication = {
        version: 1,
        roomId: topology.roomId,
        cohortId: topology.cohortId,
        groupId: topology.groupId,
        topologyGeneration: existing.topologyGeneration,
        mlsEpoch: existing.mlsEpoch,
        publicKey: existing.publicKey,
        signature: existing.signature,
        signerIdentity: existing.signerIdentity,
        signerPublicKey: existing.signerPublicKey,
        groupInfoDigest: existing.groupInfoDigest
      }
      if (await this.verifyCohortWrappingPublicationForTopology(topology, existingPublication)) {
        return true
      }
    }

    return await this.publishCohortWrappingKeyForTopology(topology)
  }

  private async publishCohortWrappingKeyForTopology(
    topology: RoomCryptoTopologyResolution
  ): Promise<boolean> {
    const derived = await this.deriveCohortWrappingKeyForTopology(topology)
    if (!derived) {
      return false
    }

    const publication = derived.publication
    await publishCohortWrappingKey(
      {
        groupId: topology.groupId,
        topologyGeneration: publication.topologyGeneration,
        mlsEpoch: publication.mlsEpoch,
        publicKey: publication.publicKey,
        signature: publication.signature,
        signerIdentity: publication.signerIdentity,
        signerPublicKey: publication.signerPublicKey,
        groupInfoDigest: publication.groupInfoDigest
      },
      this.client.getHttpClient()
    )
    return true
  }

  async fetchVerifiedScopeCohortWrappingKey(
    scope: EncryptedScope
  ): Promise<CohortWrappingPublication | null> {
    const topology = await this.ensureScopeTopology(scope)
    if (!topology.cohortId) {
      return null
    }

    return await this.fetchVerifiedCohortWrappingKey({
      roomId: topology.roomId,
      cohortId: topology.cohortId,
      groupId: topology.groupId,
      topologyGeneration: topology.generation
    })
  }

  async fetchVerifiedCohortWrappingKey(
    context: Omit<CohortWrappingContext, 'mlsEpoch'>
  ): Promise<CohortWrappingPublication | null> {
    const stored = await fetchCohortWrappingKey(context.groupId, this.client.getHttpClient())
    if (!stored || stored.topologyGeneration !== context.topologyGeneration) {
      return null
    }

    const publishedGroupInfo = await fetchGroupInfo(context.groupId, this.client.getHttpClient())
    if (
      !publishedGroupInfo ||
      !publishedGroupInfo.ratchetTreeData ||
      publishedGroupInfo.epoch !== stored.mlsEpoch
    ) {
      return null
    }

    const publication: CohortWrappingPublication = {
      version: 1,
      ...context,
      mlsEpoch: stored.mlsEpoch,
      publicKey: stored.publicKey,
      signature: stored.signature,
      signerIdentity: stored.signerIdentity,
      signerPublicKey: stored.signerPublicKey,
      groupInfoDigest: stored.groupInfoDigest
    }
    const expected: CohortWrappingContext = {
      ...context,
      mlsEpoch: stored.mlsEpoch
    }

    return (await verifyCohortWrappingPublication(
      expected,
      publication,
      publishedGroupInfo.groupInfoData,
      publishedGroupInfo.ratchetTreeData
    )) ? publication
      : null
  }

  async coordinateRoomKeyEpoch(
    scope: EncryptedScope,
    reason: 'initial'
      | 'membership_change'
      | 'topology_change'
      | 'wrapping_key_rotation'
      | 'repair'
      | 'policy',
    requestId: string = crypto.randomUUID()
  ): Promise<RoomKeyEpochRecord> {
    return await this.coordinateRoomKeyEpochForTopology(
      scope,
      await this.ensureScopeTopology(scope),
      reason,
      requestId,
      false
    )
  }

  async coordinatePreparedRoomKeyEpoch(
    scope: EncryptedScope,
    topology: RoomCryptoTopologyResolution,
    requestId: string = crypto.randomUUID()
  ): Promise<RoomKeyEpochRecord> {
    return await this.coordinateRoomKeyEpochForTopology(
      scope,
      topology,
      'topology_change',
      requestId,
      true
    )
  }

  private async coordinateRoomKeyEpochForTopology(
    scope: EncryptedScope,
    topology: RoomCryptoTopologyResolution,
    reason: 'initial'
      | 'membership_change'
      | 'topology_change'
      | 'wrapping_key_rotation'
      | 'repair'
      | 'policy',
    requestId: string,
    stage: boolean
  ): Promise<RoomKeyEpochRecord> {
    if (topology.mode !== 'multi_cohort' || !topology.cohortId) {
      throw new Error('room-key coordination requires a multi-cohort topology')
    }

    const prepared = await prepareRoomKeyEpoch(
      this.resolveRoomId(scope),
      requestId,
      reason,
      this.client.getHttpClient(),
      stage ? topology.topologyId : undefined
    )
    const material = prepared.material
    const epoch = prepared.epoch

    if (
      epoch.topologyGeneration !== topology.generation ||
      material.topologyGeneration !== topology.generation ||
      material.roomId !== topology.roomId ||
      material.cohorts.length !== epoch.expectedCohortCount
    ) {
      await reportRoomKeyEpochRepair(
        epoch.id,
        'topology_changed_during_coordination',
        this.client.getHttpClient()
      )
      throw new Error('room-key topology changed during coordination')
    }

    const ownCohort = material.cohorts.find((cohort) => cohort.cohortId === topology.cohortId)
    const ownWrapping = await this.deriveCohortWrappingKeyForTopology(topology)
    if (!ownCohort || !ownWrapping) {
      await reportRoomKeyEpochRepair(
        epoch.id,
        'coordinator_cohort_key_unavailable',
        this.client.getHttpClient()
      )
      throw new Error('coordinator cohort wrapping key is unavailable')
    }

    let roomKey: Uint8Array
    const ownEnvelope = epoch.envelopes.find((envelope) => envelope.cohortId === ownCohort.cohortId)
    if (ownEnvelope) {
      roomKey = await unwrapRoomDataKey(
        ownEnvelope,
        ownWrapping.privateKey,
        this.roomKeyEnvelopeContext(epoch, ownCohort, ownEnvelope.wrappingMlsEpoch)
      )
    } else if (epoch.envelopes.length === 0) {
      roomKey = generateRoomDataKey()
    } else {
      await reportRoomKeyEpochRepair(
        epoch.id,
        'coordinator_cannot_recover_prepared_key',
        this.client.getHttpClient()
      )
      throw new Error('coordinator cannot recover the prepared room key')
    }

    let envelopesWritten = 0
    for (const cohort of material.cohorts) {
      if (epoch.envelopes.some((envelope) => envelope.cohortId === cohort.cohortId)) {
        continue
      }

      const verified = await this.fetchVerifiedCohortWrappingKey({
        roomId: material.roomId,
        cohortId: cohort.cohortId,
        groupId: cohort.groupId,
        topologyGeneration: material.topologyGeneration
      })
      if (!verified) {
        await reportRoomKeyEpochRepair(
          epoch.id,
          `unverified_wrapping_key:${cohort.cohortId}`,
          this.client.getHttpClient()
        )
        throw new Error(`could not authenticate cohort wrapping key ${cohort.cohortId}`)
      }

      const envelope = await wrapRoomDataKey(
        roomKey,
        verified.publicKey,
        this.roomKeyEnvelopeContext(epoch, cohort, verified.mlsEpoch)
      )
      await putRoomKeyEnvelope(
        epoch.id,
        cohort.cohortId,
        epoch.fencingToken,
        envelope,
        this.client.getHttpClient()
      )
      envelopesWritten += 1

      if (envelopesWritten % 8 === 0) {
        await renewRoomKeyEpoch(
          epoch.id,
          epoch.fencingToken,
          this.client.getHttpClient()
        )
      }
    }

    const completed = stage
      ? await stageRoomKeyEpoch(epoch.id, epoch.fencingToken, this.client.getHttpClient())
      : await activateRoomKeyEpoch(epoch.id, epoch.fencingToken, this.client.getHttpClient())
    await this.rememberRoomDataKey(scope, completed.topologyGeneration, completed.epoch, roomKey)
    void this.publishScopeRecoveryPackage(scope).catch((error) => {
      this.logIgnoredError('publish room-key recovery package', error)
    })
    return completed
  }

  async loadActiveRoomDataKey(scope: EncryptedScope): Promise<Uint8Array | null> {
    const topology = await this.ensureScopeTopology(scope)
    if (topology.mode !== 'multi_cohort' || !topology.cohortId) {
      return null
    }

    const active = await fetchActiveRoomKeyEpoch(
      this.resolveRoomId(scope),
      this.client.getHttpClient()
    )
    const usableState =
      active?.state === 'active' ||
      (topology.state === 'cutover_appended' && active?.state === 'staged')
    if (!active || !usableState || active.topologyGeneration !== topology.generation) {
      return null
    }

    const cachedKey = this.roomCrypto.dataKey(topology.roomId, active.epoch)
    if (cachedKey) {
      return cachedKey
    }

    const persisted = await this.loadPersistedRoomDataKey(scope, active.epoch, active.topologyGeneration)
    if (persisted) {
      this.roomCrypto.rememberDataKey(topology.roomId, active.epoch, persisted.key)
      return persisted.key
    }

    const ownEnvelope = active.envelopes.find(
      (envelope) => envelope.cohortId === topology.cohortId
    )
    const ownWrapping = await this.deriveScopeCohortWrappingKey(scope)
    if (
      !ownEnvelope ||
      !ownWrapping ||
      ownEnvelope.groupId !== topology.groupId ||
      ownEnvelope.wrappingMlsEpoch !== ownWrapping.publication.mlsEpoch
    ) {
      return null
    }

    try {
      const roomKey = await unwrapRoomDataKey(
        ownEnvelope,
        ownWrapping.privateKey,
        this.roomKeyEnvelopeContext(
          active,
          {
            cohortId: topology.cohortId,
            groupId: topology.groupId
          },
          ownEnvelope.wrappingMlsEpoch
        )
      )
      await this.rememberRoomDataKey(scope, active.topologyGeneration, active.epoch, roomKey)
      return roomKey
    } catch {
      return null
    }
  }

  private async loadRoomDataKeyForEpoch(scope: EncryptedScope, epochNumber: number): Promise<Uint8Array | null> {
    const topology = await this.ensureScopeTopology(scope)
    if (topology.mode !== 'multi_cohort') {
      return null
    }

    const cached = this.roomCrypto.dataKey(topology.roomId, epochNumber)
    if (cached) {
      return cached
    }

    const persisted = await this.loadPersistedRoomDataKey(scope, epochNumber)
    if (persisted) {
      this.roomCrypto.rememberDataKey(topology.roomId, epochNumber, persisted.key)
      return persisted.key
    }

    const retained = await fetchRoomKeyEpoch(this.resolveRoomId(scope), epochNumber, this.client.getHttpClient())
    const ownEnvelope = retained?.envelopes[0]
    if (!retained || !ownEnvelope) {
      return null
    }

    const historicalTopology: RoomCryptoTopologyResolution = {
      ...topology,
      generation: retained.topologyGeneration,
      cohortId: ownEnvelope.cohortId,
      groupId: ownEnvelope.groupId
    }
    const wrapping = await this.deriveCohortWrappingKeyForTopology(historicalTopology)
    if (!wrapping || ownEnvelope.wrappingMlsEpoch !== wrapping.publication.mlsEpoch) {
      return null
    }

    try {
      const roomKey = await unwrapRoomDataKey(
        ownEnvelope,
        wrapping.privateKey,
        this.roomKeyEnvelopeContext(retained, { cohortId: ownEnvelope.cohortId, groupId: ownEnvelope.groupId }, ownEnvelope.wrappingMlsEpoch)
      )
      await this.rememberRoomDataKey(scope, retained.topologyGeneration, retained.epoch, roomKey)
      return roomKey
    } catch {
      return null
    }
  }

  private roomKeyEnvelopeContext(
    epoch: RoomKeyEpochRecord,
    cohort: { cohortId: string; groupId: string },
    wrappingMlsEpoch: number
  ): RoomKeyEnvelopeContext {
    return {
      roomId: epoch.roomId,
      topologyGeneration: epoch.topologyGeneration,
      roomKeyEpoch: epoch.epoch,
      cohortId: cohort.cohortId,
      groupId: cohort.groupId,
      wrappingMlsEpoch
    }
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
    const groupId = this.resolveMlsGroupId(scope)
    return await this.withLockedScopeOperation(groupId, async () => {
      const draft = await this.prepareResyncRequest(groupId, userId, deviceId)
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
    const groupId = this.resolveMlsGroupId(scope)
    return await this.withLockedScopeOperation(groupId, async () => {
      return await this.handleEvictionRequestEvent(scope, payload)
    })
  }

  async editText(scope: EncryptedScope, messageId: string, text: string): Promise<void> {
    const release = await this.acquireScopeWatch(scope)
    try {
      await this.withReadyApplicationOperation(scope, false, async () => {
        const currentMessage = (
          this.scopeMessages.get(scope.id) ??
          this.scopeMessages.get(this.resolveRoomId(scope)) ??
          []
        ).find((message) => message.id === messageId)
        if (!currentMessage) {
          throw new Error(`Cannot edit unloaded message ${messageId}`)
        }
        const currentRevision = currentMessage.raw.history_revision ?? 0
        if (!Number.isSafeInteger(currentRevision) || currentRevision < 0) {
          throw new Error(`Invalid message history revision for ${messageId}`)
        }
        const revision = currentRevision + 1
        const payload = await this.authenticateMessagePayload(
          scope,
          { v: 1, type: 'text', text },
          { type: 'message_id', value: messageId, revision }
        )
        const plaintext = encodePayload(payload)
        const encrypted = await this.encryptApplicationForScope(
          scope,
          plaintext,
          'edit',
          messageId
        )
        await cacheSentMessage(this.storage, encrypted.ciphertext, plaintext)

        const pushed = await this.pushScopeEventResolved(scope, 'edit_message', {
          message_id: messageId,
          ciphertext: encrypted.ciphertext,
          mls_epoch: encrypted.epoch,
          encryption_scheme: encrypted.scheme,
          encryption_group_id: encrypted.groupId,
          history_signing_public_key: payload.history_auth?.signer_public_key,
          history_revision: revision
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
      const pushed = await this.pushScopeEventResolved(scope, 'delete_message', {
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
    const pushed = await this.pushScopeEventResolved(
      scope,
      active ? 'typing_start' : 'typing_stop',
      {}
    )
    if (!pushed) {
      throw new Error(`Failed to update typing state for ${scopeTopic(scope)}`)
    }
  }

  async pinMessage(scope: EncryptedScope, messageId: string): Promise<void> {
    const pushed = await this.pushScopeEventResolved(scope, 'pin_message', {
      message_id: messageId
    })
    if (!pushed) {
      throw new Error(`Failed to pin message in ${scopeTopic(scope)}`)
    }
  }

  async unpinMessage(scope: EncryptedScope, messageId: string): Promise<void> {
    const pushed = await this.pushScopeEventResolved(scope, 'unpin_message', {
      message_id: messageId
    })
    if (!pushed) {
      throw new Error(`Failed to unpin message in ${scopeTopic(scope)}`)
    }
  }

  private async processLiveMessageInRoomOrder(
    scope: EncryptedScope,
    rawMessage: VesperMessage
  ): Promise<ProcessedScopeMessage> {
    const logicalScopeId = this.resolveRoomId(scope)
    const existing =
      this.scopeMessages.get(scope.id) ??
      this.scopeMessages.get(logicalScopeId) ??
      await this.loadProcessedCachedMessages(logicalScopeId)
    const roomSeq = typeof rawMessage.room_seq === 'number' ? rawMessage.room_seq : null
    const highestAppliedSeq = highestRoomSeq(existing)
    const alreadyApplied = existing.find((message) => message.id === rawMessage.id) ?? null

    if (alreadyApplied && roomSeq != null && roomSeq <= (highestAppliedSeq ?? 0)) {
      return alreadyApplied
    }

    // Distributed PubSub preserves delivery but does not guarantee that
    // broadcasts emitted by different application nodes arrive in room order.
    // MLS sender ratchets are one-shot, so processing room_seq N before a
    // missing earlier ciphertext can make that earlier message permanently
    // undecryptable. A gap turns the live event into a wake-up signal: replay
    // the committed room delta, which is sorted by room_seq, before exposing it.
    if (roomSeq != null && roomSeq > (highestAppliedSeq ?? 0) + 1) {
      let replayedMessages = existing
      let replayAfterSeq = highestAppliedSeq ?? 0
      let initialWindow = highestAppliedSeq == null

      while (replayAfterSeq < roomSeq) {
        const delta = initialWindow
          ? await this.fetchInitialScopeWindow(scope, MAX_MESSAGES_PER_SCOPE)
          : await this.fetchIncrementalScopeDelta(
              scope,
              MAX_MESSAGES_PER_SCOPE,
              replayAfterSeq
            )
        initialWindow = false

        const applied = await this.applyScopeSyncDelta(
          scope,
          replayedMessages,
          delta.messages,
          delta.events
        )
        replayedMessages = await this.retryFailedRoomApplicationMessages(
          scope,
          applied.messages
        )
        this.scopeMessages.set(scope.id, replayedMessages)

        const replayed = replayedMessages.find((message) => message.id === rawMessage.id)
        if (replayed) {
          if (replayed.decryptionFailed) {
            throw new Error(
              `Ordered replay could not decrypt room ${logicalScopeId} sequence ${roomSeq}`
            )
          }
          return replayed
        }

        const replayedRoomSeqs = [
          ...delta.messages.map((message) => message.room_seq),
          ...delta.events.map((event) => event.roomSeq)
        ].filter((seq): seq is number => typeof seq === 'number')
        const nextReplayAfterSeq = Math.max(replayAfterSeq, ...replayedRoomSeqs)
        if (nextReplayAfterSeq === replayAfterSeq) {
          break
        }
        replayAfterSeq = nextReplayAfterSeq
        if (!delta.hasMore) {
          break
        }
      }

      // Never consume a one-shot MLS ratchet when durable replay could not
      // establish that every prior room activity has been applied. A later
      // sync/reconnect can retry from committed state; speculative processing
      // here would make the missing ciphertext permanently undecryptable.
      if (replayAfterSeq !== roomSeq - 1) {
        throw new Error(
          `Could not replay room ${logicalScopeId} through sequence ${roomSeq - 1}`
        )
      }
    }

    const message = await this.processIncomingMessage(scope, rawMessage)
    this.upsertScopeMessage(scope.id, message)
    return message
  }

  private async handleScopeEvent(
    scope: EncryptedScope,
    event: string,
    payload: Record<string, unknown> | null
  ): Promise<EncryptedScopeWatchEvent | null> {
    if (event === 'topology_cutover' || event === 'vesper.topology_cutover') {
      const roomId = this.resolveRoomId(scope)
      const announcedGeneration = this.getNumber(payload, 'topology_generation')
      const current = this.roomCrypto.topology(scope)

      if (announcedGeneration == null || current == null || announcedGeneration >= current.generation) {
        const refreshed = await this.client.fetchRoomCryptoTopology(roomId)
        if (announcedGeneration != null && refreshed.generation < announcedGeneration) {
          throw new Error(
            `Topology cutover ${announcedGeneration} is not yet readable for room ${roomId}`
          )
        }
        this.roomCrypto.rememberTopology(scope, refreshed)
      }

      return { scope, event, payload }
    }

    const groupId = this.resolveMlsGroupId(scope)

    // A live MLS event means a remote group exists — clear the "no remote group"
    // flag so retry loops can resume if they were suppressed.
    if (event === 'mls_commit' || event === 'mls_request_join_all' || event === 'mls_welcome') {
      this.scopesWithoutRemoteGroup.delete(groupId)
    }

    if (event === 'new_message') {
      const message = await this.processLiveMessageInRoomOrder(
        scope,
        payload as unknown as VesperMessage
      )
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

      const isDmScope = scope.kind === 'dm' || this.isDmBackedChannel(this.resolveRoomId(scope))
      if (isDmScope && senderId && localUserId) {
        if (this.hasGroup(groupId)) {
          await this.replayDurableEventsLocked(groupId)
        }

        const currentState = this.groupStates.get(groupId)
        if (
          currentState &&
          groupHasMember(currentState, localUserId) &&
          groupHasMember(currentState, senderId)
        ) {
          this.welcomeReceivedScopes.add(groupId)
          return { scope, event, payload }
        }

        const canonical = await fetchGroupInfo(groupId, this.client.getHttpClient())
        if (!canonical) {
          return { scope, event, payload }
        }

        const localIsCanonical = currentState != null &&
          Number(currentState.groupContext.epoch) === canonical.epoch &&
          uint8ArraysEqual(exportGroupInfo(currentState), canonical.groupInfoData) &&
          uint8ArraysEqual(exportRatchetTree(currentState), canonical.ratchetTreeData)

        if (localIsCanonical) {
          await this.ensureCurrentGroupInfoPublished(groupId)
          return { scope, event, payload }
        }

        // The server's first epoch-zero publication is the election result.
        // Any different local group is a fork regardless of user IDs or event
        // arrival order, so discard it and External Commit into server truth.
        this.yieldedDmScopes.add(groupId)
        if (currentState) {
          await this.resetScopeState(groupId)
        }
        if (!(await this.tryJoinViaExternalCommit(groupId))) {
          await new Promise((resolve) => setTimeout(resolve, 500))
          await this.tryJoinViaExternalCommit(groupId)
        }
        return { scope, event, payload }
      }

      // Non-DM scope (channel) — External Commit into the sender's group.
      // Retry once after a short delay if the first attempt fails — the
      // GroupInfo publish may still be in flight when this event arrives.
      if (!(await this.tryJoinViaExternalCommit(groupId))) {
        await new Promise((r) => setTimeout(r, 500))
        await this.tryJoinViaExternalCommit(groupId)
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
      const requesterMembershipGeneration = this.getNumber(payload, 'membership_generation')
      const pendingRequestId = this.getString(payload, 'id')
      const requestAuthorization = normalizeApplicationHistoryAuthorization(payload?.authorization_generation, payload?.authorized_after_room_seq)
      const localUserId = this.client.getAuthSession()?.user.id ?? this.client.getState().user?.id
      const localDeviceId = this.client.deviceIdentity?.id ?? null

      if (
        requesterId &&
        requesterDeviceId &&
        requesterMembershipGeneration != null &&
        pendingRequestId &&
        requestAuthorization &&
        localUserId &&
        localDeviceId &&
        !(requesterId === localUserId && requesterDeviceId === localDeviceId) &&
        this.canSendHistoryBundleToRequester(groupId, requesterId, requesterDeviceId)
      ) {
        await this.sendHistoryBundle(
          scope,
          requesterId,
          requesterDeviceId,
          requesterMembershipGeneration, { ...requestAuthorization, requestId: pendingRequestId })
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
        // Treat the websocket event as a wake-up signal. The stored bundle is
        // consumed only after its authoritative message rows have been fetched.
        await this.processPendingHistoryBundles(scope)
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
        // The server stores commits durably before broadcasting them. Replay
        // that ordered log first so concurrent prepare/sync paths cannot apply
        // the same epoch transition from independent stale drafts.
        await this.replayDurableEventsLocked(groupId)
        const result = await this.handleCommit(
          groupId,
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
          groupId,
          this.getString(payload, 'welcome_data'),
          this.getString(payload, 'key_package_ref'),
          { commitEventSeq: this.getNumber(payload, 'commit_event_seq') }
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
    const groupId = this.resolveMlsGroupId(scope)
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

    // A live remove is only a notification. The durable log is the ordering
    // authority, so replay it before clearing local state or consuming the
    // removal commit. That also records the exact sequence with a local reset.
    await this.replayDurableEventsLocked(groupId)

    if (isLocalTarget && !isLocalSender) {
      // The durable prefix above normally consumed this removal. Keep this
      // fallback for older servers that broadcast before exposing its log row.
      await this.resetScopeState(groupId)
      return
    }

    if (!isLocalSender) {
      await this.handleCommit(groupId, this.getString(payload, 'commit_data'), 'removeEvent')
    }
  }

  private async handleEvictionRequestEvent(
    scope: EncryptedScope,
    payload: Record<string, unknown> | null
  ): Promise<boolean> {
    const groupId = this.resolveMlsGroupId(scope)
    const evictionBatch = Array.isArray(payload?.evictions)
      ? payload.evictions
          .map((entry) => normalizePayload(entry))
          .filter((entry): entry is Record<string, unknown> => entry != null)
      : []
    if (evictionBatch.length > 1) {
      return await this.handleEvictionRequestBatch(scope, evictionBatch)
    }

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
    const fencingToken = this.getNumber(payload, 'fencing_token')
    const membershipGeneration = this.getNumber(payload, 'membership_generation')
    const session = this.client.getAuthSession()
    const localDeviceId = this.client.deviceIdentity?.id ?? null

    if (
      !evictionId ||
      !targetUserId ||
      fencingToken == null ||
      membershipGeneration == null ||
      !session ||
      !localDeviceId
    ) {
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
    const prev = this.evictionLocks.get(groupId) ?? Promise.resolve()
    const current = prev
      .then(async () => {
        const state = this.groupStates.get(groupId)
        if (!state) {
          return
        }

        if (!groupHasMember(state, session.user.id, session.user.username)) {
          return
        }

        if (Number(state.groupContext.epoch) !== membershipGeneration) {
          return
        }

        const claimed = await this.pushScopeEventResolved(scope, 'mls_eviction_claim', {
          id: evictionId,
          fencing_token: fencingToken,
          membership_generation: membershipGeneration
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
          const skipped = await this.pushScopeEventResolved(scope, 'mls_eviction_skip', {
            id: evictionId,
            target_user_id: targetUserId,
            ...(targetDeviceId ? { target_device_id: targetDeviceId } : {}),
            fencing_token: fencingToken,
            membership_generation: membershipGeneration,
            reason: 'leaf_missing'
          })

          if (skipped) {
            this.recentEvictionClaims.set(evictionId, Date.now())
            handled = true
          }

          return
        }

        const previousGeneration = Number(state.groupContext.epoch)
        const predecessor = await this.fetchTransitionPredecessor(groupId, previousGeneration)
        if (!predecessor) {
          return
        }

        const removed = await removeMemberFromGroup(this.cloneGroupState(state), leafIndex)
        const resultingGeneration = Number(removed.newState.groupContext.epoch)
        const eventPayload = {
          epoch: resultingGeneration,
          previous_epoch: previousGeneration,
          group_info_data: uint8ToBase64(exportGroupInfo(removed.newState)),
          ratchet_tree_data: uint8ToBase64(exportRatchetTree(removed.newState)),
          previous_transcript_hash: uint8ToBase64(predecessor.transcriptHash),
          removed_user_id: targetUserId,
          ...(targetDeviceId ? { removed_device_id: targetDeviceId } : {}),
          commit_data: uint8ToBase64(removed.commitBytes),
          eviction_id: evictionId,
          idempotency_key: evictionId,
          fencing_token: fencingToken,
          membership_generation: membershipGeneration,
          resulting_generation: resultingGeneration
        }
        const intent = await this.queueJournaledControlIntent(
          'mls_remove',
          groupId,
          evictionId,
          membershipGeneration,
          {
            transport: 'scope',
            scope,
            event: 'mls_remove',
            eventPayload
          }
        )
        await this.setGroupState(groupId, removed.newState, { publishGroupInfo: false })

        const pushed = await this.dispatchJournaledControlIntent(intent)

        if (pushed) {
          this.recentEvictionClaims.set(evictionId, Date.now())
          handled = true
        }
      })
      .finally(() => {
        this.pendingEvictionRequests.delete(evictionId)
        this.evictionLocks.delete(groupId)
      })

    this.pendingEvictionRequests.set(evictionId, current)
    this.evictionLocks.set(groupId, current)
    await current
    return handled
  }

  private async handleEvictionRequestBatch(
    scope: EncryptedScope,
    requests: Record<string, unknown>[]
  ): Promise<boolean> {
    const groupId = this.resolveMlsGroupId(scope)
    const session = this.client.getAuthSession()
    const localDeviceId = this.client.deviceIdentity?.id ?? null
    if (!session || !localDeviceId) {
      return false
    }

    const parsed = requests.flatMap((request) => {
      const id = this.getString(request, 'id')
      const targetUserId = this.getString(request, 'target_user_id')
      const targetDeviceId = this.getString(request, 'target_device_id')
      const fencingToken = this.getNumber(request, 'fencing_token')
      const membershipGeneration = this.getNumber(request, 'membership_generation')
      if (!id || !targetUserId || fencingToken == null || membershipGeneration == null) {
        return []
      }
      return [{ id, targetUserId, targetDeviceId, fencingToken, membershipGeneration }]
    })
    if (parsed.length === 0) {
      return false
    }

    let handled = false
    const previous = this.evictionLocks.get(groupId) ?? Promise.resolve()
    const operation = previous.then(async () => {
      const state = this.groupStates.get(groupId)
      if (!state || !groupHasMember(state, session.user.id, session.user.username)) {
        return
      }

      const generation = Number(state.groupContext.epoch)
      const candidates: Array<{
        id: string
        targetUserId: string
        targetDeviceId: string | null
        fencingToken: number
        membershipGeneration: number
        leafIndex: number
      }> = []

      for (const request of parsed) {
        if (request.membershipGeneration !== generation) {
          continue
        }
        if (
          request.targetUserId === session.user.id &&
          (request.targetDeviceId == null || request.targetDeviceId === localDeviceId)
        ) {
          continue
        }

        const claimed = await this.pushScopeEventResolved(scope, 'mls_eviction_claim', {
          id: request.id,
          fencing_token: request.fencingToken,
          membership_generation: request.membershipGeneration
        })
        if (!claimed) {
          continue
        }

        const leafIndex = request.targetDeviceId
          ? (() => {
              const identity = buildClientCredentialIdentity(
                request.targetUserId,
                request.targetDeviceId!
              )
              return getGroupLeafIdentities(state).includes(identity)
                ? findMemberLeafIndex(state, identity)
                : null
            })()
          : findMemberLeafIndex(state, request.targetUserId)

        if (leafIndex == null) {
          await this.pushScopeEventResolved(scope, 'mls_eviction_skip', {
            id: request.id,
            target_user_id: request.targetUserId,
            ...(request.targetDeviceId ? { target_device_id: request.targetDeviceId } : {}),
            fencing_token: request.fencingToken,
            membership_generation: request.membershipGeneration,
            reason: 'leaf_missing'
          })
          continue
        }

        candidates.push({ ...request, leafIndex })
      }

      if (candidates.length === 0) {
        return
      }

      const predecessor = await this.fetchTransitionPredecessor(groupId, generation)
      if (!predecessor) {
        return
      }

      const removed = await removeMembersFromGroup(
        this.cloneGroupState(state),
        candidates.map((candidate) => candidate.leafIndex)
      )
      const resultingGeneration = Number(removed.newState.groupContext.epoch)
      const removals = candidates.map((candidate) => ({
        id: candidate.id,
        removed_user_id: candidate.targetUserId,
        ...(candidate.targetDeviceId
          ? { removed_device_id: candidate.targetDeviceId }
          : {}),
        fencing_token: candidate.fencingToken,
        membership_generation: candidate.membershipGeneration
      }))
      const idempotencyKey = await sha256Hex(
          `${groupId}\nmls_remove_batch\n${candidates
            .map((candidate) => candidate.id)
            .sort()
            .join(',')}`
        )
      const first = candidates[0]!
      const eventPayload = {
        epoch: resultingGeneration,
        previous_epoch: generation,
        group_info_data: uint8ToBase64(exportGroupInfo(removed.newState)),
        ratchet_tree_data: uint8ToBase64(exportRatchetTree(removed.newState)),
        previous_transcript_hash: uint8ToBase64(predecessor.transcriptHash),
        removed_user_id: first.targetUserId,
        ...(first.targetDeviceId ? { removed_device_id: first.targetDeviceId } : {}),
        commit_data: uint8ToBase64(removed.commitBytes),
        eviction_id: first.id,
        evictions: removals,
        idempotency_key: idempotencyKey,
        fencing_token: first.fencingToken,
        membership_generation: generation,
        resulting_generation: resultingGeneration
      }
      const intent = await this.queueJournaledControlIntent(
        'mls_remove',
        groupId,
        idempotencyKey,
        generation,
        {
          transport: 'scope',
          scope,
          event: 'mls_remove',
          eventPayload
        }
      )
      await this.setGroupState(groupId, removed.newState, { publishGroupInfo: false })

      if (await this.dispatchJournaledControlIntent(intent)) {
        for (const candidate of candidates) {
          this.recentEvictionClaims.set(candidate.id, Date.now())
        }
        handled = true
      }
    }).finally(() => {
      for (const request of parsed) {
        this.pendingEvictionRequests.delete(request.id)
      }
      this.evictionLocks.delete(groupId)
    })

    for (const request of parsed) {
      this.pendingEvictionRequests.set(request.id, operation)
    }
    this.evictionLocks.set(groupId, operation)
    await operation
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

  private async ensureChannelGroupReady(
    scope: EncryptedScope,
    allowCreate = false
  ): Promise<boolean> {
    const topology = await this.ensureScopeTopology(scope)
    const resourceId = this.resolveRoomId(scope)
    const groupId = this.resolveMlsGroupId(scope)
    const localUserId = this.client.getAuthSession()?.user.id ?? this.client.getState().user?.id

    if (await this.ensureGroupMembership(groupId)) {
      await this.replayDurableEvents(groupId)
      if (!this.hasGroup(groupId) || this.replayBlockedScopes.has(groupId)) {
        return false
      }

      if (!allowCreate) {
        return true
      }

      if (!localUserId) {
        return false
      }

      if (!(await this.scopeRequiresExternalJoin(topology, resourceId, localUserId))) {
        return await this.ensureInitialDmParticipantCoverage(scope, resourceId, groupId, localUserId)
      }

      if (this.getGroupEpoch(groupId) !== 0) {
        return true
      }

      if (!(await this.ensureCurrentGroupInfoPublished(groupId))) {
        return false
      }

      await this.pushScopeEventResolved(scope, 'mls_request_join_all', {})
      return await this.awaitChannelJoinCoverage(groupId)
    }

    // ensureGroupMembership already tried External Commit. If it failed,
    // there may be no GroupInfo published yet (no group exists).
    if (!allowCreate) {
      return this.hasGroup(groupId)
    }

    if (
      topology.mode !== 'multi_cohort' && (await this.channelHasExistingActivity(resourceId))
    ) {
      return false
    }

    const ownerUserId = await this.resolveChannelOwnerId(resourceId)
    // Server channels have one authoritative owner. DM-backed channels elect
    // whichever online participant wins the initial GroupInfo publication.
    if (
      !localUserId ||
      (topology.mode !== 'multi_cohort' && ownerUserId != null && localUserId !== ownerUserId)
    ) {
      return false
    }

    await this.createGroup(groupId)
    if (!this.hasGroup(groupId)) {
      return false
    }

    this.scopesWithoutRemoteGroup.delete(groupId)

    if (!(await this.ensureCurrentGroupInfoPublished(groupId))) {
      return false
    }

    if (!(await this.scopeRequiresExternalJoin(topology, resourceId, localUserId))) {
      return await this.ensureInitialDmParticipantCoverage(scope, resourceId, groupId, localUserId)
    }

    await this.pushScopeEventResolved(scope, 'mls_request_join_all', {})

    // Wait for at least one member to External Commit before returning.
    // Without this, the caller encrypts at epoch 0 (only the creator in the
    // group) and other members can never decrypt those messages. Live channel
    // subscribers respond to mls_request_join_all by External Committing from
    // the published GroupInfo, which advances the epoch via mls_commit.
    // Uses a notification from setGroupState rather than polling.
    //
    // If nobody joins within the timeout, return false so the caller
    // (sendPayload) retries rather than encrypting to an empty group.
    return await this.awaitChannelJoinCoverage(groupId)
  }

  private async primeEmptyChannelGroupIfOwner(scope: EncryptedScope): Promise<boolean> {
    const topology = await this.ensureScopeTopology(scope)
    const resourceId = this.resolveRoomId(scope)
    const groupId = this.resolveMlsGroupId(scope)
    if (this.hasGroup(groupId)) {
      return true
    }

    if (
      topology.mode !== 'multi_cohort' && (await this.channelHasExistingActivity(resourceId))
    ) {
      return false
    }

    const localUserId = this.client.getAuthSession()?.user.id ?? this.client.getState().user?.id
    const ownerUserId = await this.resolveChannelOwnerId(resourceId)
    // Server channels have one authoritative owner. DM-backed channels elect
    // whichever online participant wins the initial GroupInfo publication.
    if (
      !localUserId ||
      (topology.mode !== 'multi_cohort' && ownerUserId != null && localUserId !== ownerUserId)
    ) {
      return false
    }

    await this.createGroup(groupId)
    if (!this.hasGroup(groupId)) {
      return false
    }

    if (!(await this.ensureCurrentGroupInfoPublished(groupId))) {
      return false
    }

    await this.pushScopeEventResolved(scope, 'mls_request_join_all', {})
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

  private async prepareScopeForReadInternal(
    scope: EncryptedScope,
    options: ScopePreparationOptions
  ): Promise<boolean> {
    await this.ensureScopeTopology(scope)
    const groupId = this.resolveMlsGroupId(scope)
    this.scopeKinds.set(groupId, scope.channelId ? 'channel' : scope.kind)

    if (await this.ensureChannelGroupReady(scope, false)) {
      await this.processPendingRepairArtifacts(scope, true)
      return true
    }

    await this.primeEmptyChannelGroupIfOwner(scope)
    if (await this.ensureChannelGroupReady(scope, false)) {
      await this.processPendingRepairArtifacts(scope, true)
      return true
    }

    if (this.replayBlockedScopes.has(groupId)) {
      const requested = await this.maybeRequestScopeResync(scope, {
        lastKnownEpoch: this.getGroupEpoch(groupId),
        reason: options.reason ?? 'durable_replay_diverged'
      })
      if (!requested) {
        return false
      }

      await this.resetScopeState(groupId)
      if (await this.pollForScopeMembership(scope, JOIN_WAIT_MS)) {
        await this.replayDurableEvents(groupId).catch((error) =>
          this.logIgnoredError('replay scope events after state repair', error)
        )
        await this.processPendingRepairArtifacts(scope, true)
        return this.hasGroup(groupId)
      }
    }

    if (await this.pollForScopeMembership(scope, JOIN_WAIT_MS)) {
      await this.replayDurableEvents(groupId).catch((error) =>
        this.logIgnoredError('replay scope events during prepare', error)
      )
      await this.processPendingRepairArtifacts(scope, true)
      return this.hasGroup(groupId)
    }

    if (!this.hasGroup(groupId)) {
      this.ensureBackgroundChannelMembershipRetry(scope)
    }

    if (!(await this.maybeRequestScopeResync(scope, options))) {
      return false
    }

    if (await this.pollForScopeMembership(scope, JOIN_WAIT_MS)) {
      await this.replayDurableEvents(groupId).catch((error) =>
        this.logIgnoredError('replay scope events after resync prepare', error)
      )
    }

    await this.processPendingRepairArtifacts(scope, true)
    return this.hasGroup(groupId)
  }

  private ensureBackgroundChannelMembershipRetry(scope: EncryptedScope): void {
    if (scope.kind !== 'channel' || this.hasGroup(this.resolveMlsGroupId(scope))) {
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

        if (this.scopesWithoutRemoteGroup.has(scope.id)) {
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
    const groupId = this.resolveMlsGroupId(scope)
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const ready = await this.ensureMembership(scope).catch(() => false)
      if (ready || this.hasGroup(groupId)) {
        return true
      }

      // No GroupInfo on the server — stop polling. A live event
      // (mls_commit, mls_request_join_all) will clear this flag.
      if (this.scopesWithoutRemoteGroup.has(groupId)) {
        return false
      }

      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    return this.hasGroup(groupId)
  }

  private async maybeRequestScopeResync(
    scope: EncryptedScope,
    options: ScopePreparationOptions
  ): Promise<boolean> {
    const groupId = this.resolveMlsGroupId(scope)
    const localIdentity = this.getLocalSessionIdentity()
    if (!localIdentity) {
      return false
    }

    const now = Date.now()
    const lastRequestAt = this.recentScopeResyncRequests.get(groupId) ?? 0
    if (now - lastRequestAt < VOICE_RESYNC_REQUEST_COOLDOWN_MS) {
      return true
    }

    const pushed = await this.pushResyncRequestForScope(groupId, scope.channelId ? 'channel' : scope.kind, {
      lastKnownEpoch: options.lastKnownEpoch ?? this.getGroupEpoch(groupId),
      reason: options.reason ?? 'missing_state',
      username: localIdentity.username
    })
    if (pushed) {
      this.recentScopeResyncRequests.set(groupId, now)
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
        const hasPendingGroupInfo = this.restoreControlIntentIndexes(checkpoint)
        if (!hasPendingGroupInfo) {
          this.lastSuccessfulGroupInfoPublishEpochs.set(scopeId, checkpoint.groupState.epoch)
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

  private async fetchTransitionPredecessor(
    scopeId: string,
    expectedEpoch: number
  ): Promise<{ transcriptHash: Uint8Array } | null> {
    const groupInfo = await fetchGroupInfo(scopeId, this.client.getHttpClient())
    if (!groupInfo || groupInfo.epoch !== expectedEpoch) {
      return null
    }

    return { transcriptHash: groupInfo.transcriptHash }
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
          this.scopesWithoutRemoteGroup.add(scopeId)
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
          groupInfo.transcriptHash,
          commitData,
          commitId,
          this.client.getHttpClient()
        )

        if (result.status === 'conflict') {
          if (attempt < MAX_RETRIES - 1) {
            // Another joiner won this epoch. Jitter and retry with fresh GroupInfo.
            await new Promise((r) => setTimeout(r, 50 + Math.floor(Math.random() * 300 * (attempt + 1))))
            continue
          }
          return false
        }

        // The server has durably stored the External Commit and tells us the
        // exact event sequence it assigned. Persist state and that replay
        // cursor in one checkpoint so restart never has to rediscover our own
        // commit and can never observe a joined epoch with a stale cursor.
        await this.persistCommitAppliedState(
          scopeId,
          state,
          commitId,
          result.commitEventSeq,
          { publishGroupInfo: false }
        )
        this.lastSuccessfulGroupInfoPublishEpochs.set(scopeId, newEpoch)
        // Mark as joined so the mls_request_join_all handler won't reset and re-EC.
        this.welcomeReceivedScopes.add(scopeId)
        this.scopesWithoutRemoteGroup.delete(scopeId)
        return true
      } catch (err) {
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, 50 + Math.floor(Math.random() * 300 * (attempt + 1))))
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
      await this.recordControlIntentAttempt(
        scopeId,
        'external_commit_broadcast',
        commitId
      )
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
    const existing = this.durableReplayProcesses.get(scopeId)
    if (existing) {
      await existing
      return
    }

    // Durable replay mutates the same ratchet/checkpoint pair as live commits,
    // sponsored transitions, and decrypt recovery. Coalesce before entering the
    // group queue, then hold that queue for the entire ordered drain.
    const run = this.withLockedScopeOperation(
      scopeId,
      async () => await this.replayDurableEventsLocked(scopeId),
      'urgent'
    ).finally(() => {
      if (this.durableReplayProcesses.get(scopeId) === run) {
        this.durableReplayProcesses.delete(scopeId)
      }
    })
    this.durableReplayProcesses.set(scopeId, run)
    await run
  }

  /** Caller must already hold the scope's group lock. */
  private async replayDurableEventsLocked(scopeId: string): Promise<void> {
    await this.replayDurableEventsOnce(scopeId)
  }

  private async replayDurableEventsOnce(scopeId: string): Promise<void> {
    const session = this.client.getAuthSession()
    const localDeviceId = this.client.deviceIdentity?.id ?? null
    if (!session || !localDeviceId) {
      return
    }

    const pageSize = 200
    let cursor = (await this.storage.loadScopeCheckpoint(scopeId)).lastEventSeq

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
        const isLocalSender =
          event.sender_id === session.user.id && event.sender_device_id === localDeviceId
        const payload = event.payload as Record<string, unknown> | undefined
        const removals = [
          {
            userId: typeof payload?.removed_user_id === 'string' ? payload.removed_user_id : null,
            deviceId: typeof payload?.removed_device_id === 'string' ? payload.removed_device_id : null
          },
          ...((Array.isArray(payload?.removals) ? payload.removals : []).map((removal) => {
            const entry = normalizePayload(removal)
            return {
              userId: typeof entry?.removed_user_id === 'string' ? entry.removed_user_id : null,
              deviceId: typeof entry?.removed_device_id === 'string' ? entry.removed_device_id : null
            }
          }))
        ]
        const removesLocalDevice = event.event_type === 'mls_remove' && removals.some(
          (removal) =>
            removal.userId === session.user.id &&
            (removal.deviceId == null || removal.deviceId === localDeviceId)
        )

        if (removesLocalDevice && !isLocalSender) {
          await this.resetScopeState(scopeId, { consumedEventSeq: event.seq })
          return
        }

        const commitData = typeof payload?.commit_data === 'string' ? payload.commit_data : null
        const localEpoch = this.getGroupEpoch(scopeId)
        const resultingEpoch =
          typeof payload?.resulting_generation === 'number'
            ? payload.resulting_generation
            : null
        const stagedEpoch = this.pendingSponsoredTransitions.get(scopeId)?.epoch ?? null
        const localStatePredatesOwnCommit =
          isLocalSender &&
          ((resultingEpoch != null && (localEpoch == null || localEpoch < resultingEpoch)) ||
            (stagedEpoch != null && (localEpoch == null || localEpoch < stagedEpoch)))
        const mustApplyCommit =
          (event.event_type === 'mls_commit' || event.event_type === 'mls_remove') &&
          (!isLocalSender || localStatePredatesOwnCommit)

        if (mustApplyCommit) {
          const result = await this.handleCommit(scopeId, commitData, 'replayDurable', {
            replaySeq: event.seq
          })
          if (result.status !== 'applied' && result.status !== 'already_applied') {
            if (
              result.status === 'needs_repair' &&
              (await this.isPublishedStatePastReplayCommit(scopeId, result.error))
            ) {
              await this.advanceDurableReplayCursor(scopeId, event.seq)
              this.replayBlockedScopes.delete(scopeId)
              this.setScopeRepairState(scopeId, 'healthy', null, { persist: true })
              continue
            }

            // A failed durable commit cannot otherwise be skipped safely: the
            // local state and cursor would describe different protocol histories.
            // Keep the cursor pinned and move the scope into explicit repair.
            this.replayBlockedScopes.add(scopeId)
            return
          }

          this.replayBlockedScopes.delete(scopeId)
          continue
        }

        // Local commits have already changed local MLS state. Their durable row
        // still has to be consumed, but must not be processed a second time.
        await this.advanceDurableReplayCursor(scopeId, event.seq)
      }

      cursor = Math.max(cursor, events.at(-1)?.seq ?? cursor)

      if (events.length < pageSize) {
        return
      }
    }
  }

  private async isPublishedStatePastReplayCommit(
    scopeId: string,
    error: string | null
  ): Promise<boolean> {
    if (!error || !/(generation is too old|epoch differs)/i.test(error)) {
      return false
    }

    const localEpoch = this.getGroupEpoch(scopeId)
    if (localEpoch == null) {
      return false
    }

    try {
      const groupInfo = await fetchGroupInfo(scopeId, this.client.getHttpClient())
      return groupInfo != null && localEpoch >= groupInfo.epoch
    } catch {
      return false
    }
  }

  private async recoveryPackageKey(
    logicalScopeId: string,
    ownerId: string
  ): Promise<CryptoKey | null> {
    const accountKey = await this.storage.loadRecoveryPackageKey(ownerId).catch(() => null)
    if (!accountKey) {
      return null
    }

    const context = new TextEncoder().encode(
      `vesper.scope-recovery.v1\n${ownerId}\n${logicalScopeId}\n`
    )
    const material = new Uint8Array(context.byteLength + accountKey.byteLength)
    material.set(context)
    material.set(accountKey, context.byteLength)
    const digest = await crypto.subtle.digest('SHA-256', material)
    return await crypto.subtle.importKey(
      'raw',
      digest,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    )
  }

  private roomDataKeyAad(ownerId: string, roomId: string, topologyGeneration: number, epoch: number): Uint8Array {
    return new TextEncoder().encode(`vesper.room-data-key.v1\n${ownerId}\n${roomId}\n${topologyGeneration}\n${epoch}`)
  }

  private async persistRoomDataKey(scope: EncryptedScope, topologyGeneration: number, epoch: number, roomKey: Uint8Array): Promise<void> {
    const roomId = this.resolveRoomId(scope)
    const ownerId = this.client.getAuthSession()?.user.id ?? this.client.getState().user?.id
    if (!ownerId || roomKey.byteLength !== 32) {
      return
    }

    const key = await this.recoveryPackageKey(roomId, ownerId)
    if (!key) {
      return
    }

    const nonce = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: nonce as unknown as BufferSource,
          additionalData: this.roomDataKeyAad(ownerId, roomId, topologyGeneration, epoch) as unknown as BufferSource
        },
        key,
        roomKey as unknown as BufferSource
      )
    )

    await this.withScopeCheckpointMutation(roomId, (checkpoint) => {
      const retained = checkpoint.roomDataKeys
        .filter((record) => !(record.roomId === roomId && record.epoch === epoch))
        .concat({ roomId, topologyGeneration, epoch, ciphertext, nonce })
        .sort((left, right) => right.epoch - left.epoch)
        .slice(0, MAX_PERSISTED_ROOM_KEY_EPOCHS)
      checkpoint.roomDataKeys = retained
    })
  }

  private async loadPersistedRoomDataKey(scope: EncryptedScope, epoch: number, expectedTopologyGeneration?: number): Promise<{ key: Uint8Array; topologyGeneration: number } | null> {
    const roomId = this.resolveRoomId(scope)
    const ownerId = this.client.getAuthSession()?.user.id ?? this.client.getState().user?.id
    if (!ownerId) {
      return null
    }

    const checkpoint = await this.storage.loadScopeCheckpoint(roomId).catch(() => null)
    const record = checkpoint?.roomDataKeys.find(
      (candidate) => candidate.roomId === roomId && candidate.epoch === epoch && (expectedTopologyGeneration == null || candidate.topologyGeneration === expectedTopologyGeneration)
    )
    if (!record) {
      return null
    }

    const key = await this.recoveryPackageKey(roomId, ownerId)
    if (!key) {
      return null
    }

    try {
      const plaintext = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: record.nonce as unknown as BufferSource,
            additionalData: this.roomDataKeyAad(ownerId, roomId, record.topologyGeneration, record.epoch) as unknown as BufferSource
          },
          key,
          record.ciphertext as unknown as BufferSource
        )
      )
      if (plaintext.byteLength !== 32) {
        return null
      }

      return { key: plaintext, topologyGeneration: record.topologyGeneration }
    } catch {
      return null
    }
  }

  private async rememberRoomDataKey(scope: EncryptedScope, topologyGeneration: number, epoch: number, roomKey: Uint8Array): Promise<void> {
    this.roomCrypto.rememberDataKey(this.resolveRoomId(scope), epoch, roomKey)
    await this.persistRoomDataKey(scope, topologyGeneration, epoch, roomKey).catch((error) => {
      this.logIgnoredError('persist room data key', error)
    })
  }

  private async publishScopeRecoveryPackage(scope: EncryptedScope): Promise<void> {
    await this.withStorageContext(async () => {
      const logicalScopeId = this.resolveRoomId(scope)
      const mlsGroupId = this.resolveMlsGroupId(scope)
      const ownerId = this.client.getAuthSession()?.user.id ?? this.client.getState().user?.id
      if (!ownerId || !this.hasGroup(mlsGroupId)) {
        return
      }

      this.recoveryPackageLastRequestedAt.set(logicalScopeId, Date.now())
      const activePublish = this.recoveryPackagePublishes.get(logicalScopeId)
      if (activePublish) {
        this.recoveryPackageRepublishRequested.add(logicalScopeId)
        return
      }

      const publish = (async () => {
        let burstStartedAt = Date.now()

        while (true) {
          const now = Date.now()
          const lastRequestedAt =
            this.recoveryPackageLastRequestedAt.get(logicalScopeId) ?? burstStartedAt
          const quietAt = lastRequestedAt + SCOPE_RECOVERY_PACKAGE_PUBLISH_QUIET_MS
          const forcedAt = burstStartedAt + SCOPE_RECOVERY_PACKAGE_PUBLISH_MAX_DELAY_MS
          const waitMs = Math.max(0, Math.min(quietAt, forcedAt) - now)
          if (waitMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, waitMs))
          }

          const afterWait = Date.now()
          const latestRequestAt =
            this.recoveryPackageLastRequestedAt.get(logicalScopeId) ?? burstStartedAt
          if (
            afterWait < latestRequestAt + SCOPE_RECOVERY_PACKAGE_PUBLISH_QUIET_MS &&
            afterWait < forcedAt
          ) {
            continue
          }

          // The fresh snapshot includes every request received before this
          // point. A request arriving while encryption/upload is in flight
          // starts one trailing burst; continuous traffic is force-flushed at
          // the maximum delay rather than rewriting a large TOAST value every
          // debounce interval.
          this.recoveryPackageRepublishRequested.delete(logicalScopeId)
          await this.writeScopeRecoveryPackage(logicalScopeId, mlsGroupId, ownerId)
          if (!this.recoveryPackageRepublishRequested.has(logicalScopeId)) {
            break
          }
          burstStartedAt = Date.now()
        }
      })()
      this.recoveryPackagePublishes.set(logicalScopeId, publish)

      try {
        await publish
      } finally {
        if (this.recoveryPackagePublishes.get(logicalScopeId) === publish) {
          this.recoveryPackagePublishes.delete(logicalScopeId)
          this.recoveryPackageLastRequestedAt.delete(logicalScopeId)
          this.recoveryPackageRepublishRequested.delete(logicalScopeId)
        }
      }
    })
  }

  private async writeScopeRecoveryPackage(
    logicalScopeId: string,
    mlsGroupId: string,
    ownerId: string
  ): Promise<void> {
    const key = await this.recoveryPackageKey(logicalScopeId, ownerId)
    if (!key) {
      return
    }

    const [checkpoint, roomKeyCheckpoint, cached] = await Promise.all([
      this.storage.loadScopeCheckpoint(mlsGroupId),
      this.storage.loadScopeCheckpoint(logicalScopeId),
      this.storage.loadCachedMessages(logicalScopeId)
    ])
    const messages = cached
      .map((message) => ({
        id: message.id,
        roomSeq: message.roomSeq,
        channelId: message.channelId,
        conversationId: message.conversationId,
        serverId: message.serverId ?? null,
        senderId: message.senderId,
        senderUsername: message.senderUsername,
        parentMessageId: message.parentMessageId,
        threadRootMessageId: message.threadRootMessageId,
        replyToMessageId: message.replyToMessageId,
        isReply: message.isReply,
        ciphertext: message.ciphertext ? uint8ToBase64(message.ciphertext) : null,
        plaintext: message.decryptedContent ?? '',
        mlsEpoch: message.mlsEpoch,
        insertedAt: message.insertedAt
      }))
      .filter((message) => message.plaintext.length > 0)
      .slice(-MAX_MESSAGES_PER_SCOPE)

    const roomDataKeys = (
      await Promise.all(
        roomKeyCheckpoint.roomDataKeys
          .filter((record) => record.roomId === logicalScopeId)
          .map(async (record): Promise<ScopeRecoveryPackageRoomDataKey | null> => {
            try {
              const plaintext = new Uint8Array(
                await crypto.subtle.decrypt(
                  {
                    name: 'AES-GCM',
                    iv: record.nonce as unknown as BufferSource,
                    additionalData: this.roomDataKeyAad(
                      ownerId,
                      record.roomId,
                      record.topologyGeneration,
                      record.epoch
                    ) as unknown as BufferSource
                  },
                  key,
                  record.ciphertext as unknown as BufferSource
                )
              )
              if (plaintext.byteLength !== 32) {
                return null
              }

              return {
                roomId: record.roomId,
                topologyGeneration: record.topologyGeneration,
                epoch: record.epoch,
                key: uint8ToBase64(plaintext)
              }
            } catch {
              return null
            }
          })
      )
    ).filter((record): record is ScopeRecoveryPackageRoomDataKey => record != null)

    if (messages.length === 0 && roomDataKeys.length === 0) {
      return
    }

    const payload: ScopeRecoveryPackagePayload = {
      version: SCOPE_RECOVERY_PACKAGE_VERSION,
      logicalScopeId,
      mlsGroupId,
      ownerId,
      membershipGeneration: checkpoint.groupState?.epoch ?? 0,
      lastEventSeq: checkpoint.lastEventSeq,
      generatedAt: new Date().toISOString(),
      messages,
      roomDataKeys
    }
    const encoded = new TextEncoder().encode(JSON.stringify(payload))
    if (encoded.byteLength > MAX_SCOPE_RECOVERY_PACKAGE_BYTES - 28) {
      return
    }

    const nonce = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: nonce,
          additionalData: new TextEncoder().encode(`${logicalScopeId}\n${ownerId}`)
        },
        key,
        encoded
      )
    )
    if (ciphertext.byteLength + nonce.byteLength > MAX_SCOPE_RECOVERY_PACKAGE_BYTES) {
      return
    }

    const response = await this.client
      .getHttpClient()
      .apiFetch(`/api/v1/scope-recovery-packages/${logicalScopeId}`, {
        method: 'PUT',
        body: JSON.stringify({
          ciphertext: uint8ToBase64(ciphertext),
          nonce: uint8ToBase64(nonce),
          membership_generation: payload.membershipGeneration,
          last_event_seq: payload.lastEventSeq,
          schema_version: payload.version
        })
      })
    if (!response.ok) {
      throw new Error(`Could not publish scope recovery package: status ${response.status}`)
    }
  }

  private async importScopeRecoveryPackage(scope: EncryptedScope): Promise<void> {
    const logicalScopeId = this.resolveRoomId(scope)
    const mlsGroupId = this.resolveMlsGroupId(scope)
    const ownerId = this.client.getAuthSession()?.user.id ?? this.client.getState().user?.id
    if (!ownerId) {
      return
    }

    // An empty cache can accept the package's bounded window. Once local
    // records exist, the package may only fill plaintext for those records;
    // it must not recreate records removed by a later durable mutation.
    const existingCachedMessages = await this.storage.loadCachedMessages(logicalScopeId)
    const existingMessageIds = new Set(existingCachedMessages.map((message) => message.id))
    const mayInsertPackageWindow = existingCachedMessages.length === 0

    const response = await this.client.getHttpClient()
      .apiFetch(`/api/v1/scope-recovery-packages/${logicalScopeId}`)
      .catch(() => null)
    if (!response || response.status === 404 || !response.ok) {
      return
    }

    const result = (await response.json().catch(() => null)) as {
      package?: {
        ciphertext?: string
        nonce?: string
        membership_generation?: number
        last_event_seq?: number
        schema_version?: number
        byte_size?: number
      }
    } | null
    const packageData = result?.package
    const lastEventSeq = packageData?.last_event_seq
    const byteSize = packageData?.byte_size
    if (
      !packageData ||
      packageData.schema_version !== SCOPE_RECOVERY_PACKAGE_VERSION ||
      typeof lastEventSeq !== 'number' ||
      !Number.isInteger(lastEventSeq) ||
      lastEventSeq < 0 ||
      typeof byteSize !== 'number' ||
      !Number.isInteger(byteSize) ||
      byteSize > MAX_SCOPE_RECOVERY_PACKAGE_BYTES ||
      lastEventSeq < (this.importedRecoveryPackageCursors.get(logicalScopeId) ?? -1) ||
      typeof packageData.ciphertext !== 'string' ||
      typeof packageData.nonce !== 'string'
    ) {
      return
    }

    const packageFingerprint = await sha256Hex(`${logicalScopeId}\n${packageData.nonce}\n${packageData.ciphertext}`)
    if (this.importedRecoveryPackageFingerprints.get(logicalScopeId) === packageFingerprint) {
      return
    }

    const key = await this.recoveryPackageKey(logicalScopeId, ownerId)
    if (!key) {
      return
    }

    try {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: base64ToUint8(packageData.nonce) as unknown as BufferSource,
          additionalData: new TextEncoder().encode(
            `${logicalScopeId}\n${ownerId}`
          ) as unknown as BufferSource
        },
        key,
        base64ToUint8(packageData.ciphertext) as unknown as BufferSource
      )
      const payload = JSON.parse(new TextDecoder().decode(plaintext)) as ScopeRecoveryPackagePayload
      if (
        payload.version !== SCOPE_RECOVERY_PACKAGE_VERSION ||
        payload.logicalScopeId !== logicalScopeId ||
        payload.mlsGroupId !== mlsGroupId ||
        payload.ownerId !== ownerId ||
        payload.membershipGeneration !== packageData.membership_generation ||
        payload.lastEventSeq !== packageData.last_event_seq ||
        !Array.isArray(payload.messages) ||
        payload.messages.length > MAX_MESSAGES_PER_SCOPE ||
        (payload.roomDataKeys != null && !Array.isArray(payload.roomDataKeys)) ||
        (payload.roomDataKeys?.length ?? 0) > MAX_PERSISTED_ROOM_KEY_EPOCHS
      ) {
        return
      }

      const recoveredRoomDataKeys = (payload.roomDataKeys ?? []).map((record) => {
        if (
          !record ||
          record.roomId !== logicalScopeId ||
          !Number.isSafeInteger(record.topologyGeneration) ||
          record.topologyGeneration < 0 ||
          !Number.isSafeInteger(record.epoch) ||
          record.epoch < 0 ||
          typeof record.key !== 'string'
        ) {
          throw new Error('invalid recovery package room key')
        }

        const roomKey = base64ToUint8(record.key)
        if (roomKey.byteLength !== 32) {
          throw new Error('invalid recovery package room key length')
        }
        return { ...record, key: roomKey }
      })

      await Promise.all(
        recoveredRoomDataKeys.map(async (record) => {
          await this.rememberRoomDataKey(scope, record.topologyGeneration, record.epoch, record.key)
        })
      )

      await Promise.all(payload.messages.map(async (message) => {
        if (!message || typeof message.id !== 'string' || typeof message.plaintext !== 'string') {
          throw new Error('invalid recovery package message')
        }
        await this.storage.saveCachedMessageDecryption(message.id, message.plaintext)
        if (!mayInsertPackageWindow && !existingMessageIds.has(message.id)) {
          return
        }
        await this.storage.cacheMessage({
          id: message.id,
          roomSeq: message.roomSeq ?? null,
          channelId: message.channelId ?? null,
          conversationId: message.conversationId ?? null,
          serverId: message.serverId ?? null,
          senderId: message.senderId ?? null,
          senderUsername: message.senderUsername ?? null,
          parentMessageId: message.parentMessageId ?? null,
          threadRootMessageId: message.threadRootMessageId ?? null,
          replyToMessageId: message.replyToMessageId ?? null,
          isReply: Boolean(message.isReply),
          ciphertext: message.ciphertext ? base64ToUint8(message.ciphertext) : null,
          decryptedContent: message.plaintext,
          mlsEpoch: message.mlsEpoch ?? null,
          insertedAt: message.insertedAt
        })
      }))
      this.importedRecoveryPackageCursors.set(logicalScopeId, payload.lastEventSeq)
      this.importedRecoveryPackageFingerprints.set(logicalScopeId, packageFingerprint)
    } catch {
      // Invalid, stale, or wrong-key packages are deliberately ignored before persistence.
    }
  }

  private async processIncomingMessage(
    scope: EncryptedScope,
    rawMessage: VesperMessage,
    options: {
      allowCachedMessageDecryption?: boolean
      waitForHistoryRecovery?: boolean
      operation?: 'message' | 'edit'
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
      const roomEnvelope = parseRoomApplicationEnvelope(ciphertext)
      const decrypted =
        cachedPlaintext ??
        (roomEnvelope
          ? await this.decryptApplicationForScope(
              scope,
              ciphertext,
              rawMessage.sender_id ?? null,
              options.operation ?? 'message'
            )
          : await this.decryptForScopeWithRecovery(
              scope,
              ciphertext,
              rawMessage.mls_epoch ?? null,
              rawMessage.id,
              {
                waitForHistoryRecovery,
                groupId: rawMessage.encryption_group_id ?? null
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
        threadRootMessageId: rawMessage.thread_root_message_id ?? null,
        replyToMessageId: rawMessage.reply_to_message_id ?? null,
        isReply: rawMessage.is_reply ?? false,
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
    if (!decryptionFailed && plaintext) {
      void this.publishScopeRecoveryPackage(scope).catch((error) => {
        this.logIgnoredError('publish scope recovery package', error)
      })
    }

    return {
      id: rawMessage.id,
      scopeId,
      channelId: rawMessage.channel_id ?? null,
      conversationId: rawMessage.conversation_id ?? null,
      senderId: rawMessage.sender_id ?? null,
      senderUsername: rawMessage.sender?.username ?? null,
      parentMessageId: rawMessage.parent_message_id ?? null,
      threadRootMessageId: rawMessage.thread_root_message_id ?? null,
      replyToMessageId: rawMessage.reply_to_message_id ?? null,
      isReply: rawMessage.is_reply ?? false,
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

      const pushed = await this.pushScopeEventResolved(scope, 'mls_request_join', {
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

    const requestId = crypto.randomUUID()
    const payload = {
      device_id: this.client.deviceIdentity?.id,
      request_id: requestId,
      idempotency_key: requestId,
      membership_generation: options.lastKnownEpoch ?? this.getGroupEpoch(scopeId),
      last_known_epoch: options.lastKnownEpoch ?? null,
      reason: options.reason ?? null,
      username: options.username ?? null
    }

    if (!scopeId.startsWith('voice:') && !kind) {
      kind = this.scopeKinds.get(scopeId) ?? null
    }

    if (!scopeId.startsWith('voice:') && !kind) {
      return false
    }

    const intent = await this.queueJournaledControlIntent(
      'mls_resync_request',
      scopeId,
      requestId,
      payload.membership_generation ?? 0,
      {
        transport: scopeId.startsWith('voice:') ? 'topic' : 'scope',
        scope: scopeId.startsWith('voice:') ? null : { kind: kind!, id: scopeId },
        event: 'mls_resync_request',
        eventPayload: payload
      }
    )
    return await this.dispatchJournaledControlIntent(intent)
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
    // Without this, two callers can both pass the hasGroup check before
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
    await this.setGroupState(scopeId, state, { publishGroupInfo: false })
    this.diagnostics.recordGroupCreated(scopeId)

    // Initial publication is the cross-device election point. Do it before
    // createGroup returns so a same-epoch conflict can discard the losing
    // local state before any caller treats it as usable.
    await this.publishGroupInfoForScope(scopeId, state)
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
    deviceId: string | null,
    suppliedKeyPackage: Uint8Array | null = null
  ): Promise<PreparedSponsoredTransition | null> {
    try {
      await this.replayDurableEventsLocked(scopeId)
      const state = this.groupStates.get(scopeId)
      if (!state) {
        return null
      }

      await initCipherSuite()
      const keyPackageBytes = suppliedKeyPackage ?? await fetchKeyPackage(
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
      const predecessor = await this.fetchTransitionPredecessor(scopeId, baseEpoch)
      if (!predecessor) {
        return null
      }

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
        previousTranscriptHash: predecessor.transcriptHash,
        baseState: serializeGroupState(state),
        resultState: serializeGroupState(added.newState),
        baseEpoch,
        newState: added.newState
      }
    } catch {
      return null
    }
  }

  private async findWelcomeCommitEvent(
    scopeId: string,
    userId: string,
    deviceId: string,
    expectedEpoch: number,
    hintedSeq: number | null
  ): Promise<{ seq: number; commitData: string } | null> {
    let cursor = (await this.storage.loadScopeCheckpoint(scopeId)).lastEventSeq
    const pageSize = 200

    for (let page = 0; page < 50; page += 1) {
      const events = await fetchMlsEvents(
        scopeId,
        cursor,
        pageSize,
        this.client.getHttpClient()
      )
      if (events.length === 0) {
        return null
      }

      for (const event of events) {
        if (event.event_type !== 'mls_commit' || typeof event.payload.commit_data !== 'string') {
          continue
        }
        if (hintedSeq != null && event.seq !== hintedSeq) {
          continue
        }

        const joinsThisDevice =
          event.payload.joined_user_id === userId &&
          event.payload.joined_device_id === deviceId
        const reachesExpectedEpoch =
          event.payload.resulting_generation == null ||
          event.payload.resulting_generation === expectedEpoch
        if (joinsThisDevice && reachesExpectedEpoch) {
          return { seq: event.seq, commitData: event.payload.commit_data }
        }
      }

      cursor = Math.max(cursor, events.at(-1)?.seq ?? cursor)
      if (events.length < pageSize) {
        return null
      }
    }

    return null
  }

  private async handleWelcome(
    scopeId: string,
    welcomeData: string | null,
    keyPackageRef: string | null,
    options: { commitEventSeq?: number | null } = {}
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

        const durableCommit = await this.findWelcomeCommitEvent(
          scopeId,
          session.user.id,
          localDeviceId,
          Number(state.groupContext.epoch),
          options.commitEventSeq ?? null
        )
        if (!durableCommit) {
          // Keep the Welcome and its key package retryable. A post-commit MLS
          // state without the matching durable commit sequence would make a
          // crash checkpoint internally inconsistent.
          continue
        }

        const fingerprint = await sha256Hex(
          `${scopeId}\ncommit\n${durableCommit.commitData}`
        )
        await this.persistCommitAppliedState(
          scopeId,
          state,
          fingerprint,
          durableCommit.seq,
          { publishGroupInfo: false }
        )
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
        options.replaySeq ?? null,
        { publishGroupInfo: false }
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
      await this.replayDurableEventsLocked(scopeId)
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
      const predecessor = await this.fetchTransitionPredecessor(scopeId, baseEpoch)
      if (!predecessor) {
        return null
      }

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
        previousTranscriptHash: predecessor.transcriptHash,
        baseState: serializeGroupState(state),
        resultState: serializeGroupState(added.newState),
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
    deviceId: string | null,
    suppliedKeyPackage: Uint8Array | null = null
  ): Promise<boolean> {
    if (this.pendingSponsoredTransitions.has(scopeId)) {
      await this.flushPendingSponsoredTransition(scopeId, { flushGroupInfoOnSuccess: false })
      if (this.pendingSponsoredTransitions.has(scopeId)) {
        return false
      }
    }

    if (!(await this.ensureCurrentGroupInfoPublished(scopeId))) {
      return false
    }

    const draft = await this.prepareJoinRequest(
      scopeId,
      userId,
      deviceId,
      suppliedKeyPackage
    )
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

    if (!(await this.ensureCurrentGroupInfoPublished(scopeId))) {
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
    const knownKind = this.scopeKinds.get(scopeId)
    if (knownKind) {
      return { kind: knownKind, id: scopeId }
    }

    // Older direct-message records have no backing channel. Reconstruct them
    // as DM scopes from the durable conversation identity rather than silently
    // routing their repair traffic to a channel topic.
    const conversation = this.client.getState().conversations.find(
      (entry) => entry.id === scopeId || entry.channel_id === scopeId
    )
    if (conversation) {
      return {
        kind: 'dm',
        id: conversation.id,
        channelId: conversation.channel_id ?? undefined
      }
    }

    return { kind: 'channel', id: scopeId }
  }

  private async requestScopeHistorySync(
    scope: EncryptedScope,
    force = false
  ): Promise<void> {
    const groupId = this.resolveMlsGroupId(scope)
    if (!this.hasGroup(groupId)) {
      return
    }

    const localDeviceId = this.client.deviceIdentity?.id ?? null
    if (!localDeviceId) {
      return
    }

    const now = Date.now()
    const lastRequestAt = this.recentScopeHistoryRequests.get(groupId) ?? 0
    if (!force && now - lastRequestAt < HISTORY_SYNC_REQUEST_COOLDOWN_MS) {
      await this.processPendingHistoryBundles(scope)
      return
    }

    const requestId = crypto.randomUUID()
    const membershipGeneration = this.getGroupEpoch(groupId) ?? 0
    const eventPayload = {
      device_id: localDeviceId,
      idempotency_key: requestId,
      membership_generation: membershipGeneration
    }
    const intent = await this.queueJournaledControlIntent(
      'mls_history_request',
      groupId,
      requestId,
      membershipGeneration,
      {
        transport: 'scope',
        scope,
        event: 'mls_history_request',
        eventPayload
      }
    )
    const pushed = await this.dispatchJournaledControlIntent(intent)
    if (!pushed && !force) {
      return
    }

    if (pushed) {
      this.recentScopeHistoryRequests.set(groupId, now)
    }

    await this.processPendingHistoryBundles(scope)
  }

  private async processPendingResyncRequests(scope: EncryptedScope): Promise<void> {
    const groupId = this.resolveMlsGroupId(scope)
    if (!this.hasGroup(groupId)) {
      return
    }

    const localUserId = this.client.getAuthSession()?.user.id ?? this.client.getState().user?.id
    const localDeviceId = this.client.deviceIdentity?.id ?? null
    if (!localUserId || !localDeviceId) {
      return
    }

    let requests: Awaited<ReturnType<typeof fetchPendingResyncRequests>> = []
    try {
      requests = await fetchPendingResyncRequests(groupId, this.client.getHttpClient())
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
        this.hasMemberDevice(groupId, request.requester_id, request.requester_client_id)

      if (requesterAlreadyJoined) {
        if (this.canSendHistoryBundleToRequester(
          groupId,
          request.requester_id,
          request.requester_client_id
        )) {
          await this.sendHistoryBundle(
            scope,
            request.requester_id,
            request.requester_client_id,
            this.getGroupEpoch(groupId) ?? -1
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
        groupId,
        request.requester_id,
        request.requester_client_id ?? null
      )
      if (!sponsored) {
        continue
      }

      if (this.canSendHistoryBundleToRequester(
        groupId,
        request.requester_id,
        request.requester_client_id
      )) {
        await this.sendHistoryBundle(
          scope,
          request.requester_id,
          request.requester_client_id,
          this.getGroupEpoch(groupId) ?? -1
        )
      }

      await ackPendingResyncRequest(
        request.id,
        request.request_id,
        this.client.getHttpClient()
      ).catch((error) => this.logIgnoredError('ack pending resync request', error))
    }
  }

  private async loadMembershipEpochRanges(
    groupId: string,
    userId: string,
    deviceId: string
  ): Promise<MembershipEpochRange[]> {
    const pageSize = 500
    const maxEvents = 10_000
    const events: DurableMlsEvent[] = []
    let cursor = 0

    while (events.length < maxEvents) {
      const page = await fetchMlsEvents(groupId, cursor, pageSize, this.client.getHttpClient())
      events.push(...page)
      if (page.length < pageSize) {
        return membershipEpochRangesFromEvents(events, userId, deviceId)
      }
      cursor = Math.max(cursor, page.at(-1)?.seq ?? cursor)
    }

    throw new Error(`MLS membership history exceeds ${maxEvents} events for ${groupId}`)
  }

  private async processPendingHistoryRequests(scope: EncryptedScope): Promise<void> {
    const groupId = this.resolveMlsGroupId(scope)
    if (!this.hasGroup(groupId)) {
      return
    }

    const localUserId = this.client.getAuthSession()?.user.id ?? this.client.getState().user?.id
    const localDeviceId = this.client.deviceIdentity?.id ?? null
    if (!localUserId || !localDeviceId) {
      return
    }

    let requests: Awaited<ReturnType<typeof fetchPendingHistoryRequests>> = []
    try {
      requests = await fetchPendingHistoryRequests(groupId, this.client.getHttpClient())
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
        groupId,
        request.requester_id,
        request.requester_client_id
      )
      const requestAuthorization = normalizeApplicationHistoryAuthorization(request.authorization_generation, request.authorized_after_room_seq)
      if (!canSend || !requestAuthorization) {
        continue
      }

      await this.sendHistoryBundle(
        scope,
        request.requester_id,
        request.requester_client_id,
        request.membership_generation, { ...requestAuthorization, requestId: request.id })
    }
  }

  private async processPendingHistoryBundles(
    scope: EncryptedScope,
    groupId = this.resolveMlsGroupId(scope)
  ): Promise<void> {
    const localUserId = this.client.getAuthSession()?.user.id ?? this.client.getState().user?.id
    const localDeviceId = this.client.deviceIdentity?.id ?? null
    if (!localUserId || !localDeviceId) {
      return
    }

    let bundles: Awaited<ReturnType<typeof fetchPendingHistoryBundles>> = []
    try {
      bundles = await fetchPendingHistoryBundles(groupId, this.client.getHttpClient())
    } catch {
      return
    }

    if (bundles.length === 0) {
      return
    }

    let authoritativeMessages: VesperMessage[]
    try {
      authoritativeMessages = await this.fetchHistoryBundleAuthorizationWindow(scope)
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

      await this.processHistoryBundle(
        scope,
        {
          id: bundle.id,
          ciphertext: bundle.ciphertext,
          mlsEpoch: bundle.mls_epoch,
          authorizationGeneration: bundle.authorization_generation,
          authorizedAfterRoomSeq: bundle.authorized_after_room_seq
        },
        groupId,
        authoritativeMessages
      )
    }
  }

  private async sendHistoryBundle(
    scope: EncryptedScope,
    recipientId: string,
    recipientDeviceId: string,
    requestMembershipGeneration: number,
    requestAuthorization: RequestHistoryAuthorization | null = null
  ): Promise<void> {
    if (!requestAuthorization) {
      return
    }

    const groupId = this.resolveMlsGroupId(scope)
    const localGeneration = this.getGroupEpoch(groupId)
    if (
      localGeneration == null ||
      requestMembershipGeneration > localGeneration ||
      !this.canSendHistoryBundleToRequester(groupId, recipientId, recipientDeviceId)
    ) {
      return
    }

    let membershipRanges: MembershipEpochRange[]
    try {
      membershipRanges = await this.loadMembershipEpochRanges(
        groupId,
        recipientId,
        recipientDeviceId
      )
    } catch {
      return
    }
    if (!membershipRangeIncludesEpoch(membershipRanges, requestMembershipGeneration)) {
      return
    }

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
      const sourceEpoch = knownMessage?.raw.mls_epoch ?? cachedMessage.mlsEpoch
      if (
        !knownMessage ||
        (knownMessage.raw.encryption_scheme ?? 'mls') !== 'mls' ||
        (knownMessage.raw.encryption_group_id ?? groupId) !== groupId ||
        sourceEpoch == null ||
        !Number.isInteger(sourceEpoch) ||
        sourceEpoch < 0 ||
        (requestAuthorization ? !applicationHistoryIncludesRoomSeq(requestAuthorization, knownMessage.raw.room_seq) : !membershipRangeIncludesEpoch(membershipRanges, sourceEpoch))
      ) {
        continue
      }

      const content =
        (knownMessage && !knownMessage.decryptionFailed ? knownMessage.plaintext : null) ??
        cachedMessage.decryptedContent ??
        (cachedMessage.ciphertext
          ? await this.storage.loadSentMessagePlaintext(uint8ToBase64(cachedMessage.ciphertext))
          : null) ??
        (cachedMessage.ciphertext
          ? await this.storage.loadCachedMessageDecryption(cachedMessage.id)
          : null)

      if (
        !content ||
        !verifyHistoryBundlePlaintext(
          content,
          this.resolveRoomId(scope),
          knownMessage.raw
        )
      ) {
        continue
      }

      items.push({
        id: cachedMessage.id,
        content,
        mlsEpoch: sourceEpoch,
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
        parentMessageId: cachedMessage.parentMessageId,
        threadRootMessageId: cachedMessage.threadRootMessageId,
        replyToMessageId: cachedMessage.replyToMessageId,
        isReply: cachedMessage.isReply
      })
      bundledIds.add(cachedMessage.id)
    }

    for (const message of knownMessages) {
      const sourceEpoch = message.raw.mls_epoch
      if (
        bundledIds.has(message.id) ||
        message.decryptionFailed ||
        !message.plaintext ||
        (message.raw.encryption_scheme ?? 'mls') !== 'mls' ||
        (message.raw.encryption_group_id ?? groupId) !== groupId ||
        sourceEpoch == null ||
        !Number.isInteger(sourceEpoch) ||
        sourceEpoch < 0 ||
        (requestAuthorization ? !applicationHistoryIncludesRoomSeq(requestAuthorization, message.raw.room_seq) : !membershipRangeIncludesEpoch(membershipRanges, sourceEpoch))
      ) {
        continue
      }

      if (
        !verifyHistoryBundlePlaintext(
          message.plaintext,
          this.resolveRoomId(scope),
          message.raw
        )
      ) {
        continue
      }

      items.push({
        id: message.id,
        content: message.plaintext,
        mlsEpoch: sourceEpoch,
        channelId: message.raw.channel_id ?? message.channelId,
        conversationId: message.raw.conversation_id ?? message.conversationId,
        serverId: message.raw.server_id ?? null,
        senderId: message.senderId,
        sender: message.raw.sender ?? null,
        insertedAt: message.insertedAt,
        expiresAt: message.raw.expires_at ?? null,
        parentMessageId: message.parentMessageId,
        threadRootMessageId: message.threadRootMessageId,
        replyToMessageId: message.replyToMessageId,
        isReply: message.isReply
      })
      bundledIds.add(message.id)
    }

    const boundedItems = items.slice(-MAX_MESSAGES_PER_SCOPE)
    if (boundedItems.length === 0) {
      return
    }

    const bundlePayload = encodePayload({
      v: 1,
      type: 'text',
      text: JSON.stringify(boundedItems)
    })
    const encrypted = await this.encryptForScope(groupId, bundlePayload)

    const idempotencyKey = requestAuthorization?.requestId ?? (await this.computeHistoryBundleFingerprint(groupId, encrypted.ciphertext))
    const eventPayload = {
      ciphertext: encrypted.ciphertext,
      mls_epoch: encrypted.epoch,
      recipient_id: recipientId,
      recipient_device_id: recipientDeviceId,
      request_id: requestAuthorization?.requestId ?? null,
      idempotency_key: idempotencyKey,
      membership_generation: requestMembershipGeneration
    }
    const intent = await this.queueJournaledControlIntent(
      'mls_history_bundle',
      groupId,
      idempotencyKey,
      encrypted.epoch,
      {
        transport: 'scope',
        scope,
        event: 'mls_history_bundle',
        eventPayload
      }
    )
    const pushed = await this.dispatchJournaledControlIntent(intent)
    if (pushed && requestAuthorization) {
      await ackPendingHistoryRequest(requestAuthorization.requestId, this.client.getHttpClient()).catch((error) =>
        this.logIgnoredError('ack pending history request', error)
      )
    }
  }

  private canSendHistoryBundleToRequester(
    scopeId: string,
    requesterId: string,
    requesterDeviceId: string | null
  ): requesterDeviceId is string {
    return typeof requesterDeviceId === 'string' &&
      requesterDeviceId.length > 0 &&
      this.hasMemberDevice(scopeId, requesterId, requesterDeviceId)
  }

  private async processHistoryBundle(
    scope: EncryptedScope,
    input: {
      id: string | null
      ciphertext: string
      mlsEpoch: number | null
      authorizationGeneration: string | null
      authorizedAfterRoomSeq: number | null
    },
    groupId = this.resolveMlsGroupId(scope),
    authoritativeMessages: VesperMessage[] = []
  ): Promise<void> {
    const fingerprint = await this.computeHistoryBundleFingerprint(groupId, input.ciphertext)

    if (this.hasRecentHistoryBundleFingerprint(groupId, fingerprint)) {
      await this.ackHistoryBundleIfNeeded(input.id)
      return
    }

    const processKey = `${groupId}:${fingerprint}`
    const existingProcess = this.inFlightHistoryBundleProcesses.get(processKey)
    if (existingProcess) {
      if (await existingProcess) {
        await this.ackHistoryBundleIfNeeded(input.id)
      }
      return
    }

    const run = this.processHistoryBundleOnce(scope, input, fingerprint, groupId, authoritativeMessages)
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
      authorizationGeneration: string | null
      authorizedAfterRoomSeq: number | null
    },
    fingerprint: string,
    groupId: string,
    authoritativeMessages: VesperMessage[]
  ): Promise<boolean> {
    const decrypted = await this.decryptHistoryBundleDraft(
      scope,
      input.ciphertext,
      input.mlsEpoch,
      groupId
    )
    if (!decrypted) {
      return false
    }

    let items: HistoryBundleItem[] = []
    try {
      const payload = decodePayload(decrypted.plaintext)
      if (payload.type !== 'text' || !payload.text) {
        return false
      }

      const parsed: unknown = JSON.parse(payload.text)
      if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_MESSAGES_PER_SCOPE) {
        return false
      }

      const normalized = parsed
        .map((value) => normalizeHistoryBundleItem(value))
      if (normalized.some((value) => value == null)) {
        return false
      }
      items = normalized as HistoryBundleItem[]
    } catch {
      return false
    }

    const applicationAuthorization = normalizeApplicationHistoryAuthorization(
      input.authorizationGeneration,
      input.authorizedAfterRoomSeq
    )
    if (!applicationAuthorization) {
      return false
    }

    const existingMessages = this.scopeMessages.get(scope.id) ?? []
    const existingMessagesById = new Map(existingMessages.map((message) => [message.id, message]))
    const authoritativeMessagesById = new Map<string, VesperMessage>()
    for (const message of existingMessages) {
      authoritativeMessagesById.set(message.id, message.raw)
    }
    for (const message of authoritativeMessages) {
      authoritativeMessagesById.set(message.id, message)
    }

    const cachedMessages = await this.storage.loadCachedMessages(scope.id).catch(() => [])
    const cachedMessagesById = new Map(cachedMessages.map((message) => [message.id, message]))
    const everyItemIsAuthorized = items.every((item) => {
      const authoritativeMessage = authoritativeMessagesById.get(item.id)
      return (
        authoritativeMessage != null &&
        (authoritativeMessage.encryption_scheme ?? 'mls') === 'mls' &&
        (authoritativeMessage.encryption_group_id ?? groupId) === groupId &&
        authoritativeMessage.mls_epoch === item.mlsEpoch &&
        verifyHistoryBundlePlaintext(
          item.content,
          this.resolveRoomId(scope),
          authoritativeMessage
        ) &&
        applicationHistoryIncludesRoomSeq(
          applicationAuthorization,
          authoritativeMessage.room_seq
        )
      )
    })

    // Do not advance the one-shot MLS receive ratchet unless every plaintext
    // entry is bound to an authoritative message row in the recipient's current
    // server window. A later sync can retry the untouched ciphertext.
    if (!everyItemIsAuthorized) {
      return false
    }
    const contentById = new Map(items.map((item) => [item.id, item.content]))
    const displayContentById = new Map(
      items.map((item) => [item.id, coerceDisplayText(item.content)] as const)
    )
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

    this.scopeMessages.set(scope.id, sortMessages(patched).slice(-MAX_MESSAGES_PER_SCOPE))

    await Promise.all(
      items.map(async (item) => {
        const authoritativeMessage = authoritativeMessagesById.get(item.id)!
        const existingMessage = existingMessagesById.get(item.id) ?? null
        const cachedMessage = cachedMessagesById.get(item.id) ?? null
        const sender = authoritativeMessage.sender ?? null
        const channelId = authoritativeMessage.channel_id ??
          cachedMessage?.channelId ??
          (scope.kind === 'channel' ? scope.id : null)
        const conversationId = authoritativeMessage.conversation_id ??
          cachedMessage?.conversationId ??
          (scope.kind === 'dm' ? scope.id : null)
        const ciphertext = typeof authoritativeMessage.ciphertext === 'string'
            ? Buffer.from(authoritativeMessage.ciphertext, 'base64')
            : (cachedMessage?.ciphertext ?? null)

        await this.storage.saveCachedMessageDecryption(item.id, item.content).catch(() => {})
        await this.storage.cacheMessage({
          id: item.id,
          roomSeq: authoritativeMessage.room_seq ?? null,
          channelId,
          conversationId,
          serverId: authoritativeMessage.server_id ??
            cachedMessage?.serverId ??
            null,
          senderId: authoritativeMessage.sender_id ??
            cachedMessage?.senderId ??
            sender?.id ??
            null,
          senderUsername:
            sender?.username ??
            existingMessage?.senderUsername ??
            cachedMessage?.senderUsername ??
            null,
          parentMessageId: authoritativeMessage.parent_message_id ??
            cachedMessage?.parentMessageId ??
            null,
          threadRootMessageId: authoritativeMessage.thread_root_message_id ??
            cachedMessage?.threadRootMessageId ?? null,
          replyToMessageId: authoritativeMessage.reply_to_message_id ??
            cachedMessage?.replyToMessageId ?? null,
          isReply: authoritativeMessage.is_reply ??
            cachedMessage?.isReply ??
            false,
          ciphertext,
          decryptedContent: item.content,
          mlsEpoch: item.mlsEpoch,
          insertedAt: authoritativeMessage.inserted_at
          }).catch(() => {})
        await this.storage
          .indexDecryptedMessage(item.id, scope.id, coerceDisplayText(item.content))
          .catch(() => {})
      })
    )

    this.setScopeRepairState(groupId, 'healthy', null, { persist: false })
    await this.persistHistoryBundleAppliedState(groupId, decrypted.newState, fingerprint)
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

  private async decryptHistoryBundleDraft(
    scope: EncryptedScope,
    ciphertext: string,
    mlsEpoch: number | null,
    groupId = this.resolveMlsGroupId(scope)
  ): Promise<{ plaintext: string; newState: GroupState } | null> {
    const decrypted = await this.decryptForScopeDraft(groupId, ciphertext)
    if (decrypted) {
      return decrypted
    }

    const localEpoch = this.getGroupEpoch(groupId)
    const shouldReplay =
      localEpoch != null &&
      (mlsEpoch == null || !Number.isFinite(mlsEpoch) || mlsEpoch >= localEpoch)

    if (!shouldReplay) {
      return null
    }

    await this.replayDurableEventsLocked(groupId)
    return await this.decryptForScopeDraft(groupId, ciphertext)
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

  /** Push an event to the correct topic for a scope (resolves channelId for DMs). */
  private async pushScopeEventResolved(
    scope: EncryptedScope,
    event: string,
    payload: object
  ): Promise<boolean> {
    if (event.startsWith('mls_')) {
      const topology = await this.ensureScopeTopology(scope)
      if (topology.mode === 'multi_cohort') {
        return await this.client.pushTopicEventWithAck(
          `crypto:cohort:${topology.groupId}`,
          event,
          payload
        )
      }
    }

    const kind = scope.channelId ? 'channel' : scope.kind
    const id = scope.channelId ?? scope.id
    return await this.client.pushScopeEvent(kind, id, event, payload)
  }

  private unrefRetryTimer(timer: ReturnType<typeof setTimeout>): void {
    const maybeTimer = timer as ReturnType<typeof setTimeout> & {
      unref?: () => void
    }

    maybeTimer.unref?.()
  }

  private async encryptApplicationForScope(
    scope: EncryptedScope,
    plaintext: string,
    operation: 'message' | 'edit' | 'reaction' | 'history',
    eventId: string
  ): Promise<{
    ciphertext: string
    epoch: number
    scheme: 'mls' | 'vesper-room-v1'
    groupId: string | null
  }> {
    const topology = await this.ensureScopeTopology(scope)
    if (topology.mode !== 'multi_cohort') {
      const encrypted = await this.encryptForScope(topology.groupId, plaintext)
      return { ...encrypted, scheme: 'mls', groupId: topology.groupId }
    }

    let roomKey = await this.loadActiveRoomDataKey(scope)
    if (!roomKey) {
      const previous = await fetchActiveRoomKeyEpoch(
        this.resolveRoomId(scope),
        this.client.getHttpClient()
      )
      const reason = previous ? 'wrapping_key_rotation' : 'initial'
      const requestId = previous
        ? `wrapping-key:${topology.roomId}:${topology.generation}:${previous.epoch}:${crypto.randomUUID()}`
        : `initial:${topology.roomId}:${topology.generation}`
      const active = await this.coordinateRoomKeyEpoch(scope, reason, requestId)
      roomKey = this.roomCrypto.dataKey(topology.roomId, active.epoch)
    }
    if (!roomKey) {
      throw new Error(`No active room data key for ${topology.roomId}`)
    }

    const activeEpoch = await fetchActiveRoomKeyEpoch(
      this.resolveRoomId(scope),
      this.client.getHttpClient()
    )
    if (!activeEpoch) {
      throw new Error(`No active room-key epoch for ${topology.roomId}`)
    }
    const session = this.requireSession()
    return {
      ciphertext: await encryptRoomApplication(
        roomKey,
        {
          roomId: topology.roomId,
          roomKeyEpoch: activeEpoch.epoch,
          senderUserId: session.user.id,
          senderDeviceId: this.requireDeviceId(),
          operation,
          eventId
        },
        plaintext
      ),
      epoch: activeEpoch.epoch,
      scheme: 'vesper-room-v1',
      groupId: null
    }
  }

  private async decryptApplicationForScope(
    scope: EncryptedScope,
    ciphertext: string,
    senderUserId: string | null,
    operation: 'message' | 'edit' | 'reaction' | 'history'
  ): Promise<string | null> {
    const envelope = parseRoomApplicationEnvelope(ciphertext)
    if (!envelope) {
      return await this.decryptForScopeWithRecovery(scope, ciphertext, null)
    }

    let topology = await this.ensureScopeTopology(scope)
    if (topology.mode !== 'multi_cohort') {
      const roomId = this.resolveRoomId(scope)
      this.roomCrypto.forgetTopology(roomId)
      topology = await this.ensureScopeTopology(scope)
    }
    if (topology.mode !== 'multi_cohort') {
      return null
    }

    const roomKey = await this.loadRoomDataKeyForEpoch(scope, envelope.roomKeyEpoch)
    if (!roomKey) return null

    const decrypted = await decryptRoomApplication(roomKey, ciphertext, {
      roomId: topology.roomId,
      operation,
      senderUserId
    })
    return decrypted?.plaintext ?? null
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
    const decrypted = await this.decryptForScopeDraft(scopeId, ciphertext)
    if (!decrypted) {
      return null
    }

    await this.setGroupState(scopeId, decrypted.newState)
    return decrypted.plaintext
  }

  private async decryptForScopeDraft(scopeId: string, ciphertext: string): Promise<{ plaintext: string; newState: GroupState } | null> {
    const state = this.groupStates.get(scopeId)
    if (!state) {
      return null
    }

    return await decryptMessage(this.cloneGroupState(state), Buffer.from(ciphertext, 'base64'))
  }

  private async decryptForScopeWithRecovery(
    scope: EncryptedScope,
    ciphertext: string,
    messageEpoch: number | null,
    messageId: string | null = null,
    options: LegacyDecryptionOptions = {}
  ): Promise<string | null> {
    const groupId = options.groupId ?? this.resolveMlsGroupId(scope)
    return await this.withLockedScopeOperation(groupId, async () => {
      this.scopeKinds.set(groupId, scope.channelId ? 'channel' : scope.kind)
      return await this.decryptForScopeWithRecoveryLocked(
        scope,
        ciphertext,
        messageEpoch,
        messageId,
        { ...options, groupId }
      )
    })
  }

  private async decryptForScopeWithRecoveryLocked(
    scope: EncryptedScope,
    ciphertext: string,
    messageEpoch: number | null,
    messageId: string | null = null,
    options: LegacyDecryptionOptions = {}
  ): Promise<string | null> {
    const groupId = options.groupId ?? this.resolveMlsGroupId(scope)
    const initialEpoch = this.getGroupEpoch(groupId)
    const initialPlaintext = await this.decryptForScope(groupId, ciphertext)
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
      this.setScopeRepairState(groupId, 'waiting_for_same_user_bundle', 'decrypt_failed', {
        incrementFailure: true,
        persist: true
      })
      await this.requestScopeHistorySync(scope, waitForHistoryRecovery).catch((error) => {
        this.logIgnoredError('request history sync for older-epoch message', error)
      })
      if (!waitForHistoryRecovery) {
        return await this.tryImmediateHistoryBundleRecovery(scope, ciphertext, messageId, groupId)
      }
      const olderRecovered = await this.waitForHistoryBundleRecovery(
        scope,
        ciphertext,
        messageId,
        groupId
      )
      if (!olderRecovered) {
        this.setScopeRepairState(groupId, 'healthy', 'recovery_timeout', { persist: true })
      }
      return olderRecovered
    }

    const shouldReplay =
      messageEpoch == null ||
      !Number.isFinite(messageEpoch) ||
      messageEpoch >= initialEpoch

    if (!shouldReplay) {
      this.setScopeRepairState(groupId, 'waiting_for_same_user_bundle', 'decrypt_failed', {
        incrementFailure: true,
        persist: true
      })
      return null
    }

    this.setScopeRepairState(groupId, 'replaying', null, { persist: true })
    await this.replayDurableEventsLocked(groupId)
    const replayed = await this.decryptForScope(groupId, ciphertext)
    if (replayed) {
      this.setScopeRepairState(groupId, 'healthy', null, { persist: true })
      return replayed
    }

    this.setScopeRepairState(groupId, 'waiting_for_same_user_bundle', 'decrypt_failed', {
      incrementFailure: true,
      persist: true
    })
    await this.requestScopeHistorySync(scope, waitForHistoryRecovery).catch((error) => {
      this.logIgnoredError('request history sync', error)
    })
    if (!waitForHistoryRecovery) {
      return await this.tryImmediateHistoryBundleRecovery(scope, ciphertext, messageId, groupId)
    }
    const recovered = await this.waitForHistoryBundleRecovery(
      scope,
      ciphertext,
      messageId,
      groupId
    )
    if (recovered) {
      this.setScopeRepairState(groupId, 'healthy', null, { persist: true })
    } else {
      // Recovery timed out. Clear repair state so the scope isn't permanently
      // stuck in 'waiting_for_same_user_bundle'. Normal operations (send,
      // encrypt) can proceed; the message stays undecrypted but the scope
      // remains functional for new messages.
      this.setScopeRepairState(groupId, 'healthy', 'recovery_timeout', { persist: true })
    }
    return recovered
  }

  private async tryImmediateHistoryBundleRecovery(
    scope: EncryptedScope,
    ciphertext: string,
    messageId: string | null,
    groupId: string
  ): Promise<string | null> {
    if (messageId) {
      const cachedPlaintext = await this.storage.loadCachedMessageDecryption(messageId)
      if (cachedPlaintext) {
        this.setScopeRepairState(groupId, 'healthy', null, { persist: true })
        return cachedPlaintext
      }
    }

    await this.processPendingHistoryBundles(scope, groupId)

    if (messageId) {
      const cachedPlaintext = await this.storage.loadCachedMessageDecryption(messageId)
      if (cachedPlaintext) {
        this.setScopeRepairState(groupId, 'healthy', null, { persist: true })
        return cachedPlaintext
      }
    }

    const recovered = await this.decryptForScope(groupId, ciphertext)
    if (recovered) {
      this.setScopeRepairState(groupId, 'healthy', null, { persist: true })
      return recovered
    }

    return null
  }

  private async waitForHistoryBundleRecovery(
    scope: EncryptedScope,
    ciphertext: string,
    messageId: string | null,
    groupId: string
  ): Promise<string | null> {
    const deadline = Date.now() + HISTORY_BUNDLE_WAIT_MS

    while (Date.now() < deadline) {
      if (messageId) {
        const cachedPlaintext = await this.storage.loadCachedMessageDecryption(messageId)
        if (cachedPlaintext) {
          this.setScopeRepairState(groupId, 'healthy', null, { persist: true })
          return cachedPlaintext
        }
      }

      await this.processPendingHistoryBundles(scope, groupId)
      if (messageId) {
        const cachedPlaintext = await this.storage.loadCachedMessageDecryption(messageId)
        if (cachedPlaintext) {
          this.setScopeRepairState(groupId, 'healthy', null, { persist: true })
          return cachedPlaintext
        }
      }

      const recovered = await this.decryptForScope(groupId, ciphertext)
      if (recovered) {
        this.setScopeRepairState(groupId, 'healthy', null, { persist: true })
        return recovered
      }

      await new Promise((resolve) => setTimeout(resolve, HISTORY_BUNDLE_POLL_MS))
    }

    return null
  }

  private async fetchHistoryBundleAuthorizationWindow(
    scope: EncryptedScope
  ): Promise<VesperMessage[]> {
    const syncKind = scope.channelId ? 'channel' : scope.kind
    const syncId = scope.channelId ?? scope.id
    const messagesById = new Map<string, VesperMessage>()
    const seenCursors = new Set<string>()
    let page = await this.fetchInitialScopeWindow(scope, MAX_MESSAGES_PER_SCOPE)

    while (true) {
      for (const message of page.messages) {
        messagesById.set(message.id, message)
      }

      if (
        !page.hasMore ||
        !page.olderCursor ||
        messagesById.size >= MAX_HISTORY_AUTHORIZATION_ROWS ||
        seenCursors.has(page.olderCursor)
      ) {
        break
      }

      seenCursors.add(page.olderCursor)
      const syncState = await this.client.fetchScopeSync({
        scopes: [{ kind: syncKind, id: syncId, before: page.olderCursor }],
        limit: MAX_MESSAGES_PER_SCOPE
      })
      const entry = syncState.scopes.find((candidate) => candidate.scope_id === syncId) ?? null
      page = {
        messages: sortRawMessages(entry?.messages ?? []),
        events: [],
        hasMore: entry?.has_more ?? false,
        olderCursor: entry?.older_cursor ?? null,
        latestRoomSeq: entry?.latest_room_seq ?? page.latestRoomSeq
      }
    }

    return sortRawMessages([...messagesById.values()]).slice(
      -MAX_HISTORY_AUTHORIZATION_ROWS
    )
  }

  private async fetchInitialScopeWindow(
    scope: EncryptedScope,
    limit: number
  ): Promise<{
    messages: VesperMessage[]
    events: ScopeSyncEvent[]
    hasMore: boolean
    olderCursor: string | null
    latestRoomSeq: number
  }> {
    const syncKind = scope.channelId ? 'channel' : scope.kind
    const syncId = scope.channelId ?? scope.id
    const syncState = await this.client.fetchScopeSync({
      scopes: [{ kind: syncKind, id: syncId }],
      limit
    })
    const entry = syncState.scopes.find((candidate) => candidate.scope_id === syncId) ?? null

    return {
      messages: sortRawMessages(entry?.messages ?? []),
      events: this.normalizeSyncEvents(entry),
      hasMore: entry?.has_more ?? false,
      olderCursor: entry?.older_cursor ?? null,
      latestRoomSeq: entry?.latest_room_seq ?? 0
    }
  }

  private async fetchIncrementalScopeDelta(
    scope: EncryptedScope,
    limit: number,
    afterSeq: number
  ): Promise<{
    messages: VesperMessage[]
    events: ScopeSyncEvent[]
    hasMore: boolean
    olderCursor: string | null
    latestRoomSeq: number
  }> {
    const syncKind = scope.channelId ? 'channel' : scope.kind
    const syncId = scope.channelId ?? scope.id
    const syncState = await this.client.fetchScopeSync({
      scopes: [
        {
          kind: syncKind,
          id: syncId,
          after_seq: afterSeq
        }
      ],
      limit
    })

    const entry = syncState.scopes.find((candidate) => candidate.scope_id === syncId) ?? null

    return {
      messages: sortRawMessages(entry?.messages ?? []),
      events: this.normalizeSyncEvents(entry),
      hasMore: entry?.has_more ?? false,
      olderCursor: entry?.older_cursor ?? null,
      latestRoomSeq: entry?.latest_room_seq ?? afterSeq
    }
  }

  private async retryFailedRoomApplicationMessages(
    scope: EncryptedScope,
    messages: ProcessedScopeMessage[]
  ): Promise<ProcessedScopeMessage[]> {
    const repaired: ProcessedScopeMessage[] = []

    for (const message of messages) {
      if (
        !message.decryptionFailed ||
        typeof message.raw.ciphertext !== 'string' ||
        !parseRoomApplicationEnvelope(message.raw.ciphertext)
      ) {
        repaired.push(message)
        continue
      }

      repaired.push(
        await this.processIncomingMessage(scope, message.raw, {
          allowCachedMessageDecryption: false,
          waitForHistoryRecovery: false
        })
      )
    }

    const next = sortMessages(repaired).slice(-MAX_MESSAGES_PER_SCOPE)
    this.scopeMessages.set(scope.id, next)
    return next
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
    // The transition is not durable until the server returns its event
    // sequence. Persist the pre-transition state plus an idempotent intent,
    // then replay the durable transition after publication succeeds. Storing
    // draft.newState here would create an impossible checkpoint: epoch N+1
    // paired with a cursor that still names epoch N.
    const baseState = rollbackState ?? this.groupStates.get(scopeId) ?? null
    if (!baseState) {
      throw new Error(`Cannot stage sponsored transition for ${scopeId} without base MLS state`)
    }
    const serializedState = serializeGroupState(baseState)
    const epoch = draft.epoch ?? Number(draft.newState.groupContext.epoch)
    const persistedRollbackState =
      draft.baseState ?? serializeGroupState(baseState)
    const rollbackEpoch =
      draft.baseEpoch ?? Number(baseState.groupContext.epoch)
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
      previousTranscriptHash: draft.previousTranscriptHash,
      baseState: persistedRollbackState,
      resultState: serializeGroupState(draft.newState),
      baseEpoch: rollbackEpoch
    } satisfies PendingSponsoredTransition

    const intent = createControlIntent(
      'sponsored_transition',
      scopeId,
      pendingSponsored.commitId,
      epoch,
      {
        ...pendingSponsored,
        groupInfoData: pendingSponsored.groupInfoData
          ? uint8ToBase64(pendingSponsored.groupInfoData)
          : null,
        ratchetTreeData: pendingSponsored.ratchetTreeData
          ? uint8ToBase64(pendingSponsored.ratchetTreeData)
          : null,
        previousTranscriptHash: pendingSponsored.previousTranscriptHash
          ? uint8ToBase64(pendingSponsored.previousTranscriptHash)
          : null,
        baseState: pendingSponsored.baseState
          ? uint8ToBase64(pendingSponsored.baseState)
          : null,
        resultState: pendingSponsored.resultState
          ? uint8ToBase64(pendingSponsored.resultState)
          : null
      } satisfies SponsoredTransitionIntentPayload
    )

    await this.withScopeCheckpointMutation(scopeId, (checkpoint) => {
      checkpoint.groupState = {
        state: serializedState,
        epoch: rollbackEpoch
      }
      checkpoint.controlIntents = [
        ...checkpoint.controlIntents.filter(
          (current) =>
            current.operation !== 'group_info_publish' &&
            current.operation !== 'sponsored_transition'
        ),
        intent
      ]
    })

    this.pendingGroupInfoPublishes.delete(scopeId)
    this.pendingSponsoredTransitions.set(scopeId, pendingSponsored)
    if (rollbackState) {
      this.sponsoredTransitionRollbackStates.set(scopeId, this.cloneGroupState(rollbackState))
    } else {
      this.sponsoredTransitionRollbackStates.delete(scopeId)
    }
    this.resetGroupInfoPublishRetry(scopeId)
    this.finishLocalGroupStateUpdate(scopeId, baseState, { publishGroupInfo: false })
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
    scopeId: string, state: GroupState, fingerprint: string
  ): Promise<void> {
    const recentHistoryBundleFingerprints = [
      fingerprint,
      ...this.getRecentHistoryBundleFingerprints(scopeId).filter(
        (value) => value !== fingerprint
      )
    ].slice(0, MAX_RECENT_HISTORY_BUNDLE_FINGERPRINTS)
    const serializedState = serializeGroupState(state)
    const epoch = Number(state.groupContext.epoch)

    await this.withScopeCheckpointMutation(scopeId, (checkpoint) => {
      checkpoint.groupState = {
        state: serializedState,
        epoch
      }
      checkpoint.recentHistoryBundleFingerprints = recentHistoryBundleFingerprints
      checkpoint.repairState = this.currentScopeRepairState(scopeId) ?? checkpoint.repairState
    })

    this.recentHistoryBundleFingerprints.set(scopeId, recentHistoryBundleFingerprints)
    this.finishLocalGroupStateUpdate(scopeId, state)
  }

  private async advanceDurableReplayCursor(
    scopeId: string,
    lastEventSeq: number
  ): Promise<void> {
    await this.withScopeCheckpointMutation(scopeId, (checkpoint) => {
      checkpoint.lastEventSeq = Math.max(checkpoint.lastEventSeq, lastEventSeq)
      checkpoint.recentCommitFingerprints = this.getRecentCommitFingerprints(scopeId)
      checkpoint.recentHistoryBundleFingerprints = this.getRecentHistoryBundleFingerprints(scopeId)
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
    if (options.publishGroupInfo === false) {
      // A commit applied from the durable server stream already names the
      // canonical GroupInfo for this epoch. Treat it as published locally so a
      // later membership operation cannot attempt a forbidden non-transition
      // GroupInfo write and fork itself through an unnecessary External Commit.
      this.lastSuccessfulGroupInfoPublishEpochs.set(scopeId, epoch)
    }
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
      await this.recordControlIntentAttempt(
        scopeId,
        'group_info_publish',
        `group-info:${epoch}`
      )
      const result = await publishGroupInfo(
        scopeId,
        groupInfoData,
        ratchetTreeData,
        epoch,
        this.client.getHttpClient()
      )
      if (result === 'conflict') {
        // Another member won the same-epoch initial publication. Keeping this
        // local state would create a permanent fork: reset and let the normal
        // membership path External Commit into the server-elected group.
        await this.resetScopeState(scopeId)
        return await this.tryJoinViaExternalCommit(scopeId)
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

  private restoreControlIntentIndexes(checkpoint: ScopeCheckpointRecord): boolean {
    let hasPendingGroupInfo = false

    for (const intent of checkpoint.controlIntents) {
      if (intent.state !== 'pending') {
        continue
      }

      if (intent.operation === 'group_info_publish') {
        const payload = parseControlIntentPayload<GroupInfoIntentPayload>(intent)
        this.pendingGroupInfoPublishes.set(intent.scopeId, {
          groupInfoData: base64ToUint8(payload.groupInfoData),
          ratchetTreeData: payload.ratchetTreeData
            ? base64ToUint8(payload.ratchetTreeData)
            : null,
          epoch: payload.epoch
        })
        hasPendingGroupInfo = true
        continue
      }

      if (intent.operation === 'external_commit_broadcast') {
        this.pendingExternalCommitBroadcasts.set(
          intent.scopeId,
          parseControlIntentPayload<ExternalCommitIntentPayload>(intent)
        )
        continue
      }

      if (intent.operation === 'sponsored_transition') {
        const payload = parseControlIntentPayload<SponsoredTransitionIntentPayload>(intent)
        this.pendingSponsoredTransitions.set(intent.scopeId, {
          ...payload,
          groupInfoData: payload.groupInfoData ? base64ToUint8(payload.groupInfoData) : null,
          ratchetTreeData: payload.ratchetTreeData
            ? base64ToUint8(payload.ratchetTreeData)
            : null,
          previousTranscriptHash: payload.previousTranscriptHash
            ? base64ToUint8(payload.previousTranscriptHash)
            : null,
          baseState: payload.baseState ? base64ToUint8(payload.baseState) : null,
          resultState: payload.resultState ? base64ToUint8(payload.resultState) : null
        })
        continue
      }

      this.pendingJournaledControlIntents.set(this.controlIntentIndexKey(intent), intent)
    }

    return hasPendingGroupInfo
  }

  private async loadPendingControlOutbox(): Promise<void> {
    const scopeIds = await this.storage.loadKnownScopeIds()
    for (const scopeId of scopeIds) {
      this.restoreControlIntentIndexes(await this.storage.loadScopeCheckpoint(scopeId))
    }
  }

  private async flushPendingGroupInfoPublishes(): Promise<void> {
    for (const scopeId of [...this.pendingGroupInfoPublishes.keys()]) {
      await this.withLockedScopeOperation(scopeId, async () => {
        await this.flushPendingGroupInfoPublish(scopeId)
      })
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
      await this.recordControlIntentAttempt(
        scopeId,
        'group_info_publish',
        `group-info:${pending.epoch}`
      )
      const result = await publishGroupInfo(
        scopeId,
        pending.groupInfoData,
        pending.ratchetTreeData,
        pending.epoch,
        this.client.getHttpClient()
      )
      if (result === 'conflict') {
        // The persisted initial publication lost the same epoch-zero election.
        // Retrying that fork can never succeed, so discard it and rejoin the
        // server-elected group through the normal membership path.
        await this.resetScopeState(scopeId)
        await this.tryJoinViaExternalCommit(scopeId)
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

  private async persistControlIntent(intent: ControlIntentRecord): Promise<void> {
    await this.withScopeCheckpointMutation(intent.scopeId, (checkpoint) => {
      const existing = checkpoint.controlIntents.find(
        (current) =>
          current.operation === intent.operation &&
          current.idempotencyKey === intent.idempotencyKey
      )
      if (existing && existing.payloadJson !== intent.payloadJson) {
        throw new Error(
          `Control intent ${intent.operation}:${intent.idempotencyKey} was reused with a different payload.`
        )
      }

      checkpoint.controlIntents = [
        ...checkpoint.controlIntents.filter(
          (current) =>
            current.operation !== intent.operation ||
            current.idempotencyKey !== intent.idempotencyKey
        ),
        existing ?? intent
      ]
    })
  }

  private async removeControlIntent(
    scopeId: string,
    operation: ControlIntentRecord['operation'],
    idempotencyKey: string
  ): Promise<void> {
    await this.withScopeCheckpointMutation(scopeId, (checkpoint) => {
      checkpoint.controlIntents = checkpoint.controlIntents.filter(
        (intent) =>
          intent.operation !== operation || intent.idempotencyKey !== idempotencyKey
      )
    })
  }

  private async recordControlIntentAttempt(
    scopeId: string,
    operation: ControlIntentRecord['operation'],
    idempotencyKey: string
  ): Promise<void> {
    await this.withScopeCheckpointMutation(scopeId, (checkpoint) => {
      const now = new Date().toISOString()
      checkpoint.controlIntents = checkpoint.controlIntents.map((intent) =>
        intent.operation === operation && intent.idempotencyKey === idempotencyKey
          ? { ...intent, attempts: intent.attempts + 1, updatedAt: now }
          : intent
      )
    })
  }

  private controlIntentIndexKey(intent: Pick<ControlIntentRecord, 'scopeId' | 'operation' | 'idempotencyKey'>): string {
    return `${intent.scopeId}\n${intent.operation}\n${intent.idempotencyKey}`
  }

  private async queueJournaledControlIntent(
    operation: Extract<
      ControlIntentRecord['operation'],
      'mls_remove' | 'mls_welcome' | 'mls_resync_request' | 'mls_history_request' | 'mls_history_bundle'
    >,
    scopeId: string,
    idempotencyKey: string,
    membershipGeneration: number,
    payload: JournaledControlIntentPayload
  ): Promise<ControlIntentRecord> {
    const intent = createControlIntent(
      operation,
      scopeId,
      idempotencyKey,
      membershipGeneration,
      payload
    )
    await this.persistControlIntent(intent)
    this.pendingJournaledControlIntents.set(this.controlIntentIndexKey(intent), intent)
    return intent
  }

  private async dispatchJournaledControlIntent(intent: ControlIntentRecord): Promise<boolean> {
    const key = this.controlIntentIndexKey(intent)
    const payload = parseControlIntentPayload<JournaledControlIntentPayload>(intent)

    await this.recordControlIntentAttempt(
      intent.scopeId,
      intent.operation,
      intent.idempotencyKey
    )
    const attemptedIntent = {
      ...intent,
      attempts: intent.attempts + 1,
      updatedAt: new Date().toISOString()
    }
    this.pendingJournaledControlIntents.set(key, attemptedIntent)

    let pushed = false
    try {
      pushed = payload.transport === 'topic'
        ? await this.client.pushTopicEventWithAck(
            intent.scopeId,
            payload.event,
            payload.eventPayload
          )
        : payload.scope != null && (await this.pushScopeEventResolved(
            payload.scope,
            payload.event,
            payload.eventPayload))
    } catch (error) {
      this.logIgnoredError(`dispatch ${intent.operation}`, error)
    }

    if (!pushed) {
      this.scheduleJournaledControlIntentRetry(attemptedIntent)
      return false
    }

    await this.removeControlIntent(intent.scopeId, intent.operation, intent.idempotencyKey)
    this.pendingJournaledControlIntents.delete(key)
    const timer = this.journaledControlRetryTimers.get(key)
    if (timer) {
      clearTimeout(timer)
      this.journaledControlRetryTimers.delete(key)
    }

    if (intent.operation === 'mls_remove') {
      const state = this.groupStates.get(intent.scopeId)
      if (state) {
        await this.publishGroupInfoForScope(intent.scopeId, state)
      }
    }
    return true
  }

  private scheduleJournaledControlIntentRetry(intent: ControlIntentRecord): void {
    const key = this.controlIntentIndexKey(intent)
    if (this.journaledControlRetryTimers.has(key)) {
      return
    }

    const delayMs = Math.min(30_000, 500 * 2 ** Math.min(intent.attempts, 6))
    const timer = setTimeout(() => {
      this.journaledControlRetryTimers.delete(key)
      if (!this.client.getState().connected) {
        return
      }

      const current = this.pendingJournaledControlIntents.get(key)
      if (current) {
        void this.dispatchJournaledControlIntent(current)
      }
    }, delayMs)
    this.unrefRetryTimer(timer)
    this.journaledControlRetryTimers.set(key, timer)
  }

  private pauseJournaledControlRetries(): void {
    for (const timer of this.journaledControlRetryTimers.values()) {
      clearTimeout(timer)
    }
    this.journaledControlRetryTimers.clear()
  }

  private async flushPendingJournaledControlIntents(): Promise<void> {
    for (const intent of [...this.pendingJournaledControlIntents.values()]) {
      await this.dispatchJournaledControlIntent(intent)
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
    const intent = createControlIntent(
      'group_info_publish',
      scopeId,
      `group-info:${epoch}`,
      epoch,
      {
        groupInfoData: uint8ToBase64(groupInfoData),
        ratchetTreeData: ratchetTreeData ? uint8ToBase64(ratchetTreeData) : null,
        epoch
      } satisfies GroupInfoIntentPayload
    )
    await this.persistControlIntent(intent)
    this.pendingGroupInfoPublishes.set(scopeId, pending)
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
      void this.withLockedScopeOperation(scopeId, async () => {
        await this.flushPendingGroupInfoPublish(scopeId)
      }).catch((error) => this.logIgnoredError('retry group info publish', error))
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

    await this.removeControlIntent(
      scopeId,
      'group_info_publish',
      `group-info:${current.epoch}`
    )

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
      await this.withLockedScopeOperation(scopeId, async () => {
        await this.flushPendingSponsoredTransition(scopeId, {
          flushGroupInfoOnSuccess: false
        })
      })
    }
  }

  private buildSponsoredTransitionGroupInfo(
    scopeId: string,
    pending: PendingSponsoredTransition
  ):
    | (PendingGroupInfoPublish & {
    previousEpoch: number
  })
    | null {
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
    const currentEpoch = this.getGroupEpoch(scopeId)
    if (pending.baseEpoch != null && currentEpoch != null && currentEpoch > pending.baseEpoch) {
      // The winning durable transition may arrive before the losing HTTP
      // response. If it has already advanced this checkpoint, rolling back
      // would strand the client behind a cursor that consumed the winner.
      await this.clearPendingSponsoredTransition(scopeId, pending)
      await this.clearPendingGroupInfoPublish(scopeId)
      this.lastSuccessfulGroupInfoPublishEpochs.set(scopeId, currentEpoch)
      this.setScopeRepairState(scopeId, 'healthy', null, { persist: true })
      return
    }

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
      await this.replayDurableEventsLocked(scopeId)
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

  private async finalizeSponsoredTransition(
    scopeId: string,
    pending: PendingSponsoredTransition,
    targetEpoch: number,
    commitEventSeq: number | null
  ): Promise<boolean> {
    if (!pending.resultState || commitEventSeq == null) {
      return false
    }

    const state = deserializeGroupState(new Uint8Array(pending.resultState))
    if (Number(state.groupContext.epoch) !== targetEpoch) {
      return false
    }

    const fingerprint = await sha256Hex(`${scopeId}\ncommit\n${pending.commitData}`)
    await this.persistCommitAppliedState(
      scopeId,
      state,
      fingerprint,
      commitEventSeq,
      { publishGroupInfo: false }
    )
    await this.clearPendingSponsoredTransition(scopeId, pending)
    await this.clearPendingGroupInfoPublish(scopeId)
    this.lastSuccessfulGroupInfoPublishEpochs.set(scopeId, targetEpoch)
    this.setScopeRepairState(scopeId, 'healthy', null, { persist: true })
    return true
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

      const previousTranscriptHash = pending.previousTranscriptHash ??
        (await this.fetchTransitionPredecessor(scopeId, pendingGroupInfo.previousEpoch))?.transcriptHash ??
        null
      if (!previousTranscriptHash) {
        this.scheduleSponsoredTransitionRetry(scopeId)
        return false
      }

      await this.recordControlIntentAttempt(
        scopeId,
        'sponsored_transition',
        pending.commitId
      )
      const result = await publishSponsoredTransition(
        scopeId,
        {
          ...pending,
          groupInfoData: pendingGroupInfo.groupInfoData,
          ratchetTreeData: pendingGroupInfo.ratchetTreeData,
          epoch: pendingGroupInfo.epoch,
          previousEpoch: pendingGroupInfo.previousEpoch,
          previousTranscriptHash
        },
        this.client.getHttpClient()
      )

      if (result.status === 'conflict') {
        await this.recoverFromSponsoredTransitionConflict(scopeId, pending)
        return false
      }

      if (
        await this.finalizeSponsoredTransition(
          scopeId,
          pending,
          pendingGroupInfo.epoch,
          result.commitEventSeq
        )
      ) {
        return true
      }

      this.scheduleSponsoredTransitionRetry(scopeId)
      return false
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
      void this.withLockedScopeOperation(scopeId, async () => {
        await this.flushPendingSponsoredTransition(scopeId)
      }).catch((error) => this.logIgnoredError('retry sponsored transition', error))
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
      checkpoint.controlIntents = checkpoint.controlIntents.filter(
        (intent) =>
          !(
            intent.operation === 'sponsored_transition' &&
            intent.idempotencyKey === current.commitId
          ) && intent.operation !== 'group_info_publish'
      )
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
    const generation = this.getGroupEpoch(scopeId) ?? 0
    await this.persistControlIntent(
      createControlIntent(
        'external_commit_broadcast',
        scopeId,
        commitId,
        generation,
        pending
      )
    )
    this.pendingExternalCommitBroadcasts.set(scopeId, pending)
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

    if (!(await this.broadcastExternalCommit(scopeId, pending.commitData, pending.commitId))) {
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

    await this.removeControlIntent(
      scopeId,
      'external_commit_broadcast',
      current.commitId
    )

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
          message.decryptedContent ?? (await this.storage.loadCachedMessageDecryption(message.id))
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
          threadRootMessageId: message.threadRootMessageId,
          replyToMessageId: message.replyToMessageId,
          isReply: message.isReply,
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
            thread_root_message_id: message.threadRootMessageId,
            reply_to_message_id: message.replyToMessageId,
            is_reply: message.isReply,
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

  private async scopeRequiresExternalJoin(
    topology: RoomCryptoTopologyResolution,
    channelId: string,
    localUserId: string
  ): Promise<boolean> {
    if (topology.mode === 'multi_cohort') {
      return (topology.cohortMemberCount ?? 1) > 1
    }

    return await this.channelRequiresExternalJoin(channelId, localUserId)
  }

  private async channelRequiresExternalJoin(channelId: string, localUserId: string): Promise<boolean> {
    const serverId = await this.resolveChannelServerId(channelId)
    if (!serverId) {
      // DM channels (no server): the creator encrypts at epoch 0.
      // Other members join via External Commit when they open the DM.
      // No need to wait for them before sending.
      return false
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
      await this.replayDurableEventsLocked(scopeId).catch((error) =>
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

        if (!(await this.ensureCurrentGroupInfoPublished(scopeId))) {
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

  private isDmBackedChannel(channelId: string): boolean {
    return this.client.getState().conversations.some(
      (entry) => entry.channel_id === channelId
    )
  }

  private async ensureInitialDmParticipantCoverage(
    scope: EncryptedScope,
    resourceId: string,
    groupId: string,
    localUserId: string
  ): Promise<boolean> {
    if (!(scope.kind === 'dm' || this.isDmBackedChannel(resourceId))) {
      return true
    }

    const existing = this.initialDmJoinCoverageWaits.get(groupId)
    if (existing) {
      return await existing
    }

    const run = (async () => {
      const conversation = this.client.getState().conversations.find(
        (entry) => entry.channel_id === resourceId || (scope.kind === 'dm' && entry.id === scope.id)
      )
      if (!conversation) {
        return false
      }

      for (const participant of conversation.participants) {
        const participantId = participant.user_id
        if (participantId === localUserId) {
          continue
        }

        const participantAliases = [participantId, participant.user.username]
        const currentState = this.groupStates.get(groupId)
        if (currentState && groupHasMember(currentState, ...participantAliases)) {
          continue
        }

        const keyPackage = await fetchKeyPackageWithIdentity(
          participantId,
          undefined,
          this.client.getHttpClient()
        )
        if (!keyPackage) {
          return false
        }

        const sponsored = await this.sponsorScopeJoinLocked(
          groupId,
          participantId,
          keyPackage.deviceId,
          keyPackage.data
        )
        if (!sponsored) {
          await this.replayDurableEventsLocked(groupId)
        }

        const updatedState = this.groupStates.get(groupId)
        if (!updatedState || !groupHasMember(updatedState, ...participantAliases)) {
          return false
        }
      }

      return true
    })().finally(() => {
      if (this.initialDmJoinCoverageWaits.get(groupId) === run) {
        this.initialDmJoinCoverageWaits.delete(groupId)
      }
    })
    this.initialDmJoinCoverageWaits.set(groupId, run)
    return await run
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

    return parseRoomApplicationEnvelope(ciphertext)
      ? await this.decryptApplicationForScope(
          scope,
          ciphertext,
          this.getString(payload, 'sender_id'),
          'reaction'
        )
      : await this.decryptForScopeWithRecovery(
          scope,
          ciphertext,
          this.getNumber(payload, 'mls_epoch'),
          null,
          { groupId: this.getString(payload, 'encryption_group_id') }
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
    raw.encryption_scheme =
      (this.getString(payload, 'encryption_scheme') as VesperMessage['encryption_scheme']) ??
      raw.encryption_scheme
    raw.encryption_group_id =
      this.getString(payload, 'encryption_group_id') ?? raw.encryption_group_id ?? null
    raw.history_signing_public_key = this.getString(
      payload,
      'history_signing_public_key'
    )
    raw.history_revision =
      this.getNumber(payload, 'history_revision') ?? raw.history_revision ?? 0
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
      allowCachedMessageDecryption: !(ciphertext && existing.raw.ciphertext !== ciphertext),
      operation: 'edit'
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
      const pushed = await this.pushScopeEventResolved(scope, event, {
        message_id: messageId,
        emoji
      })
      if (!pushed) {
        throw new Error(`Failed to update reaction in ${scopeTopic(scope)}`)
      }
      return
    }

    await this.withReadyApplicationOperation(scope, false, async () => {
      const encrypted = await this.encryptApplicationForScope(
        scope,
        emoji,
        'reaction',
        `${messageId}:${event}`
      )
      await cacheSentMessage(this.storage, encrypted.ciphertext, emoji)
      const pushed = await this.pushScopeEventResolved(scope, event, {
        message_id: messageId,
        ciphertext: encrypted.ciphertext,
        mls_epoch: encrypted.epoch,
        encryption_scheme: encrypted.scheme
      })
      if (!pushed) {
        throw new Error(`Failed to update reaction in ${scopeTopic(scope)}`)
      }
    })
  }

  private async withReadyApplicationOperation<T>(
    scope: EncryptedScope,
    allowCreate: boolean,
    operation: () => Promise<T>
  ): Promise<T> {
    const topology = await this.ensureScopeTopology(scope)
    if (topology.mode !== 'multi_cohort') {
      return await this.withReadyScopeOperation(scope, allowCreate, operation)
    }

    const deadline = Date.now() + OUTBOUND_SCOPE_READY_WAIT_MS
    while (Date.now() < deadline) {
      if (await this.ensureScopeReady(scope, allowCreate)) {
        return await operation()
      }
      await new Promise((resolve) => setTimeout(resolve, OUTBOUND_SCOPE_READY_RETRY_MS))
    }

    throw new Error(`${scope.kind} group is still syncing`)
  }

  private async withReadyScopeOperation<T>(
    scope: EncryptedScope,
    allowCreate: boolean,
    operation: () => Promise<T>
  ): Promise<T> {
    const deadline = Date.now() + OUTBOUND_SCOPE_READY_WAIT_MS

    while (Date.now() < deadline) {
      if (!(await this.ensureScopeReady(scope, allowCreate))) {
        await new Promise((resolve) => setTimeout(resolve, OUTBOUND_SCOPE_READY_RETRY_MS))
        continue
      }

      await this.ensureScopeTopology(scope)
      const groupId = this.resolveMlsGroupId(scope)
      const result = await this.withLockedScopeOperation(groupId, async () => {
        if (!(await this.ensureScopeReadyLocked(scope))) {
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
