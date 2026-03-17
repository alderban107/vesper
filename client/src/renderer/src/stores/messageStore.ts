import { create } from 'zustand'
import { apiFetch } from '../api/client'
import { getLocalDeviceIdentity } from '../auth/deviceIdentity'
import { getChannel, joinChannel, joinChannelWithAck, leaveChannel, pushToChannel } from '../api/socket'
import { useCryptoStore } from './cryptoStore'
import { useAuthStore } from './authStore'
import { useVoiceStore } from './voiceStore'
import { useServerStore } from './serverStore'
import { useDmStore } from './dmStore'
import { queueScopeMutationHint, usePresenceStore } from './presenceStore'
import { replaceEmojiShortcodes } from '../utils/emoji'
import {
  cacheMessage as cacheMessageToDb,
  loadCachedMessages,
  loadCachedMessageDecryption,
  searchDecryptedMessages,
  saveCachedMessageDecryption,
  indexDecryptedMessage as indexToFts,
  removeFromFtsIndex
} from '../crypto/storage'
import {
  ackPendingHistoryBundle,
  ackPendingHistoryRequest,
  ackPendingWelcome,
  ackPendingResyncRequest,
  base64ToUint8,
  uint8ToBase64,
  fetchPendingHistoryBundles,
  fetchPendingHistoryRequests,
  fetchPendingResyncRequests
} from '../api/crypto'
import { encodePayload, decodePayload } from '../crypto/payload'
import {
  cacheSentMessage,
  getCachedDecryption,
  setCachedDecryption,
  removeCachedDecryption,
  getSentMessage,
  getStoredSentMessage
} from '../crypto/decryptionCache'

export function cacheSentPlaintext(ciphertext: string, plaintext: string): void {
  void cacheSentMessage(ciphertext, plaintext)
}

const MLS_JOIN_REQUEST_COOLDOWN_MS = 2000
const recentMlsJoinRequests = new Map<string, number>()
const recentMlsJoinDeviceIds = new Map<string, string>()
const MLS_RESYNC_REQUEST_COOLDOWN_MS = 5000
const recentMlsResyncRequests = new Map<string, number>()
const MLS_RECOVERY_BACKOFF_MS = [150, 500, 1500] as const
const DM_JOIN_WAIT_TIMEOUT_MS = 10_000
const ENCRYPTED_MESSAGE_SYNCING_PLACEHOLDER = 'Encrypted message is syncing...'
const ENCRYPTED_MESSAGE_APPROVAL_PLACEHOLDER = 'Approve this device to read encrypted messages.'
const ENCRYPTED_MESSAGE_UNAVAILABLE_PLACEHOLDER = 'Message unavailable - decryption failed'
const inFlightScopeRecoveries = new Map<string, Promise<void>>()
// After processing a Welcome, suppress recovery for this scope. The Welcome
// handler already marks pre-join messages as unavailable and requests a history
// bundle, so recovery would be destructive (resync resets epoch state).
const recentWelcomeProcessed = new Map<string, number>()
const WELCOME_RECOVERY_SUPPRESSION_MS = 30_000
const scopeMessageRefreshTokens = new Map<string, number>()
const historySyncRetryTimers = new Map<string, number>()
const warmDmScopeTopics = new Set<string>()
const recentNotifiedMessageIds = new Map<string, number>()
const RECENT_NOTIFICATION_TTL_MS = 30_000
const MESSAGE_PAGE_SIZE = 50
const MAX_RESIDENT_MESSAGES_PER_SCOPE = 400
const MAX_WARM_SCOPES = 3

type ScopeKind = 'channel' | 'dm'
type ScopeLifecycleState = 'cold' | 'loading' | 'warm' | 'active' | 'stale'

interface ScopeLifecycleEntry {
  kind: ScopeKind
  state: ScopeLifecycleState
  lastVisitedAt: number
}

function clearHistorySyncRetry(scopeId: string): void {
  const timerId = historySyncRetryTimers.get(scopeId)
  if (timerId !== undefined) {
    window.clearTimeout(timerId)
    historySyncRetryTimers.delete(scopeId)
  }
}

function scopeNeedsHistorySync(scopeId: string): boolean {
  const messages = useMessageStore.getState().messagesByChannel[scopeId] ?? []
  return messages.some(
    (message) =>
      message.decryptionFailed ||
      message.content === ENCRYPTED_MESSAGE_SYNCING_PLACEHOLDER ||
      message.content === ENCRYPTED_MESSAGE_UNAVAILABLE_PLACEHOLDER
  )
}

function canReplacePlaceholderFromHistoryBundle(message: Message): boolean {
  return (
    message.decryptionFailed === true ||
    message.content === ENCRYPTED_MESSAGE_SYNCING_PLACEHOLDER ||
    message.content === ENCRYPTED_MESSAGE_UNAVAILABLE_PLACEHOLDER ||
    message.content === ENCRYPTED_MESSAGE_APPROVAL_PLACEHOLDER
  )
}

function requestHistorySync(
  scopeId: string,
  topic: string,
  attempt = 0,
  force = false
): void {
  const RETRY_DELAYS_MS = [0, 1000, 3000, 7000] as const

  clearHistorySyncRetry(scopeId)

  if (
    !useCryptoStore.getState().hasGroup(scopeId) ||
    (!force && !scopeNeedsHistorySync(scopeId))
  ) {
    return
  }

  void (async () => {
    const pushed = await pushToChannelWithAck(topic, 'mls_history_request', {
      device_id: getLocalDeviceIdentity().id
    })

    void processPendingHistoryBundles(scopeId, scopeId, useMessageStore.setState).catch(() => {})

    if (pushed) {
      return
    }

    const nextDelay = RETRY_DELAYS_MS[attempt + 1]
    if (nextDelay === undefined) {
      return
    }

    const timerId = window.setTimeout(() => {
      requestHistorySync(scopeId, topic, attempt + 1, force)
    }, nextDelay)

    historySyncRetryTimers.set(scopeId, timerId)
  })()
}

async function pushToChannelWithAck(
  topic: string,
  event: string,
  payload: object
): Promise<boolean> {
  const channel = getChannel(topic)
  if (!channel) {
    return false
  }

  return await new Promise<boolean>((resolve) => {
    channel
      .push(event, payload)
      .receive('ok', () => resolve(true))
      .receive('error', () => resolve(false))
      .receive('timeout', () => resolve(false))
  })
}

function beginScopeMessageRefresh(scopeId: string): number {
  const nextToken = (scopeMessageRefreshTokens.get(scopeId) ?? 0) + 1
  scopeMessageRefreshTokens.set(scopeId, nextToken)
  return nextToken
}

function isCurrentScopeMessageRefresh(scopeId: string, token: number): boolean {
  return scopeMessageRefreshTokens.get(scopeId) === token
}

function generateClientNonce(): string {
  return `client-${crypto.randomUUID()}`
}

function syncWarmDmScopeSubscriptions(state: MessageState): void {
  const desiredTopics = new Set(
    [state.activeScopeId, ...state.recentScopeIds]
      .filter((scopeId): scopeId is string => Boolean(scopeId))
      .filter((scopeId, index, all) => all.indexOf(scopeId) === index)
      .filter((scopeId) => state.scopeLifecycleById[scopeId]?.kind === 'dm')
      .map((scopeId) => `scope:dm:${scopeId}`)
  )

  for (const topic of [...warmDmScopeTopics]) {
    if (desiredTopics.has(topic)) {
      continue
    }

    leaveChannel(topic)
    warmDmScopeTopics.delete(topic)
  }

  for (const topic of desiredTopics) {
    if (warmDmScopeTopics.has(topic)) {
      continue
    }

    joinChannel(topic, (event, payload) => {
      if (event === 'scope_mutation') {
        const data = payload as { kind: 'dm'; scope_id: string }
        queueScopeMutationHint(data.kind, data.scope_id)
      }
    })

    warmDmScopeTopics.add(topic)
  }
}

function encodeMessageCursor(message: { id: string; inserted_at: string }): string {
  return `${message.inserted_at}|${message.id}`
}

export interface MessageSender {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
}

export interface Attachment {
  id: string
  filename: string
  content_type: string
  size_bytes: number
  message_id?: string
  encrypted?: boolean
}

export interface FileMessageContent {
  type: 'file'
  text?: string
  file: {
    id: string
    name: string
    content_type: string
    size: number
    key: string
    iv: string
    duration?: number
    thumbnail?: {
      id: string
      key: string
      iv: string
    }
    audio_metadata?: {
      title?: string
      artist?: string
      album?: string
      cover?: {
        id: string
        key: string
        iv: string
      }
    }
  }
}

export interface TextMessageContent {
  type: 'text'
  text: string
}

export type ParsedContent = FileMessageContent | TextMessageContent

export function parseMessageContent(content: string): ParsedContent {
  try {
    const parsed = JSON.parse(content)
    if (parsed && parsed.type === 'file' && parsed.file) {
      return parsed as FileMessageContent
    }
  } catch {
    // Not JSON — plain text
  }
  return { type: 'text', text: content }
}

function extractMentionedUserIds(content: string): string[] {
  const ids: string[] = []
  const regex = /<@([0-9a-f-]{36})>/g
  let match
  while ((match = regex.exec(content)) !== null) {
    ids.push(match[1])
  }
  if (content.includes('<@everyone>')) {
    ids.push('everyone')
  }
  return [...new Set(ids)]
}

function getMessageSearchText(message: Message): string {
  const parsed = parseMessageContent(message.content || '')
  const parsedText = parsed.type === 'text' ? parsed.text : (parsed.text || '')
  const parsedFileName = parsed.type === 'file' ? parsed.file.name : ''
  const attachmentNames = [
    ...(message.attachment_filenames || []),
    ...(message.attachments?.map((attachment) => attachment.filename).filter(Boolean) || [])
  ]

  return [parsedText, parsedFileName, ...attachmentNames].join(' ').trim()
}

function getMessageNotificationBody(message: Message): string {
  if (
    message.decryptionFailed ||
    message.content === ENCRYPTED_MESSAGE_SYNCING_PLACEHOLDER ||
    message.content === ENCRYPTED_MESSAGE_APPROVAL_PLACEHOLDER ||
    message.content === ENCRYPTED_MESSAGE_UNAVAILABLE_PLACEHOLDER
  ) {
    return 'Encrypted message'
  }

  const parsed = parseMessageContent(message.content || '')
  if (parsed.type === 'text') {
    return parsed.text || 'New message'
  }

  return parsed.text || `Sent ${parsed.file.name || 'an attachment'}`
}

function shouldShowDesktopNotification(message: Message): boolean {
  if (typeof document === 'undefined') {
    return false
  }

  const myId = useAuthStore.getState().user?.id
  const myStatus = usePresenceStore.getState().myStatus
  const notificationsEnabled = localStorage.getItem('notifications') !== 'disabled'

  return Boolean(
    notificationsEnabled &&
      myStatus !== 'dnd' &&
      message.sender_id &&
      message.sender_id !== myId &&
      (document.hidden || !document.hasFocus())
  )
}

function shouldNotifyForMessage(messageId: string): boolean {
  const now = Date.now()

  for (const [knownId, timestamp] of recentNotifiedMessageIds.entries()) {
    if (now - timestamp > RECENT_NOTIFICATION_TTL_MS) {
      recentNotifiedMessageIds.delete(knownId)
    }
  }

  const previousTimestamp = recentNotifiedMessageIds.get(messageId)
  if (previousTimestamp && now - previousTimestamp <= RECENT_NOTIFICATION_TTL_MS) {
    return false
  }

  recentNotifiedMessageIds.set(messageId, now)
  return true
}

function maybeShowDesktopNotification(message: Message): void {
  if (!shouldShowDesktopNotification(message) || !shouldNotifyForMessage(message.id)) {
    return
  }

  const notifApi = (window as Record<string, unknown>).notifications as {
    showMessageNotification: (d: {
      title: string
      body: string
      channelId?: string
      conversationId?: string
    }) => void
  } | undefined

  notifApi?.showMessageNotification({
    title: message.sender?.display_name || message.sender?.username || 'New message',
    body: getMessageNotificationBody(message),
    channelId: message.channel_id || undefined,
    conversationId: message.conversation_id || undefined
  })
}

function dedupeMessages(messages: Message[]): Message[] {
  return messages.filter(
    (message, index, all) => all.findIndex((entry) => entry.id === message.id) === index
  )
}

function applyMessageWindow(
  messages: Message[],
  direction: 'replace' | 'prepend' | 'append'
): {
  messages: Message[]
  trimmedOlder: boolean
  trimmedNewer: boolean
} {
  const deduped = dedupeMessages(messages)

  if (deduped.length <= MAX_RESIDENT_MESSAGES_PER_SCOPE) {
    return {
      messages: deduped,
      trimmedOlder: false,
      trimmedNewer: false
    }
  }

  if (direction === 'prepend') {
    return {
      messages: deduped.slice(0, MAX_RESIDENT_MESSAGES_PER_SCOPE),
      trimmedOlder: false,
      trimmedNewer: true
    }
  }

  return {
    messages: deduped.slice(-MAX_RESIDENT_MESSAGES_PER_SCOPE),
    trimmedOlder: true,
    trimmedNewer: false
  }
}

function getRoomSeq(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function getMaxRoomSeq(messages: Array<{ room_seq?: number | null }>): number | null {
  let maxSeq: number | null = null

  for (const message of messages) {
    const roomSeq = getRoomSeq(message.room_seq)
    if (roomSeq == null) {
      continue
    }

    maxSeq = maxSeq == null ? roomSeq : Math.max(maxSeq, roomSeq)
  }

  return maxSeq
}

function mergeScopeRoomSeq(
  existingSeq: number | null | undefined,
  candidateSeq: number | null | undefined
): number | null | undefined {
  if (candidateSeq == null) {
    return existingSeq
  }

  if (existingSeq == null) {
    return candidateSeq
  }

  return Math.max(existingSeq, candidateSeq)
}

function updateLatestRoomSeqByScope(
  latestRoomSeqByScope: Record<string, number>,
  scopeId: string,
  ...candidates: Array<number | null | undefined>
): Record<string, number> {
  let nextSeq: number | null | undefined = latestRoomSeqByScope[scopeId]

  for (const candidate of candidates) {
    nextSeq = mergeScopeRoomSeq(nextSeq, candidate)
  }

  if (nextSeq == null || nextSeq === latestRoomSeqByScope[scopeId]) {
    return latestRoomSeqByScope
  }

  return {
    ...latestRoomSeqByScope,
    [scopeId]: nextSeq
  }
}

function canUseEncryptedFeatures(): boolean {
  return useAuthStore.getState().canUseE2EE
}

function hasFailedEncryptedMessages(messages: Message[] | undefined): boolean {
  return (messages || []).some((message) => message.encrypted && message.decryptionFailed)
}

function maybeRequestMlsJoin(targetId: string, topic: string): void {
  const crypto = useCryptoStore.getState()
  if (crypto.hasGroup(targetId)) {
    return
  }

  const now = Date.now()
  const lastRequestAt = recentMlsJoinRequests.get(topic) ?? 0
  if (now - lastRequestAt < MLS_JOIN_REQUEST_COOLDOWN_MS) {
    return
  }

  recentMlsJoinRequests.set(topic, now)
  pushToChannel(topic, 'mls_request_join', {
    device_id: getLocalDeviceIdentity().id
  })
}

function getMlsJoinDeviceKey(topic: string, userId: string): string {
  return `${topic}:${userId}`
}

function rememberMlsJoinDeviceId(
  topic: string,
  userId: string,
  deviceId?: string | null
): void {
  if (!deviceId) {
    return
  }

  recentMlsJoinDeviceIds.set(getMlsJoinDeviceKey(topic, userId), deviceId)
}

export function getPreferredMlsJoinDeviceId(
  topic: string,
  userId: string
): string | undefined {
  return recentMlsJoinDeviceIds.get(getMlsJoinDeviceKey(topic, userId))
}

interface PendingMlsResyncRequest {
  id?: string
  requester_id: string
  requester_username?: string | null
  requester_client_id?: string | null
  request_id?: string
  last_known_epoch?: number | null
  reason?: string | null
}

interface EncryptedScopeDescriptor {
  kind: 'channel' | 'dm'
  targetId: string
  scopeId: string
  topic: string
}

function maybeRequestMlsResync(
  _targetId: string,
  scopeId: string,
  topic: string,
  lastKnownEpoch: number | null,
  reason: string
): void {
  const user = useAuthStore.getState().user
  if (!user) {
    return
  }

  const now = Date.now()
  const lastRequestAt = recentMlsResyncRequests.get(scopeId) ?? 0
  if (now - lastRequestAt < MLS_RESYNC_REQUEST_COOLDOWN_MS) {
    return
  }

  recentMlsResyncRequests.set(scopeId, now)
  pushToChannel(topic, 'mls_resync_request', {
    device_id: getLocalDeviceIdentity().id,
    request_id: crypto.randomUUID(),
    last_known_epoch: lastKnownEpoch,
    reason,
    username: user.username
  })
}

async function processMlsResyncRequest(
  targetId: string,
  topic: string,
  request: PendingMlsResyncRequest
): Promise<boolean> {
  const requesterId = request.requester_id
  const requesterUsername = request.requester_username ?? undefined
  const requesterDeviceId = request.requester_client_id ?? undefined
  const localUser = useAuthStore.getState().user
  const localDeviceId = getLocalDeviceIdentity().id
  const crypto = useCryptoStore.getState()

  if (!requesterId || !crypto.hasGroup(targetId)) {
    return false
  }

  if (localUser?.id === requesterId && requesterDeviceId === localDeviceId) {
    return false
  }

  const result = await crypto.handleResyncRequest(
    targetId,
    requesterId,
    requesterUsername,
    requesterDeviceId
  )
  if (!result) {
    return false
  }

  if (result.removeCommitBytes) {
    pushToChannel(topic, 'mls_remove', {
      removed_user_id: requesterId,
      commit_data: result.removeCommitBytes
    })
  }

  pushToChannel(topic, 'mls_commit', {
    commit_data: result.commitBytes
  })

  if (result.welcomeBytes) {
    pushToChannel(topic, 'mls_welcome', {
      recipient_id: requesterId,
      recipient_device_id: requesterDeviceId,
      welcome_data: result.welcomeBytes,
      key_package_ref: result.keyPackageRef
    })
  }

  if (request.id) {
    await ackPendingResyncRequest(request.id)
  }

  return true
}

async function processPendingMlsResyncRequests(
  targetId: string,
  scopeId: string,
  topic: string
): Promise<void> {
  const requests = await fetchPendingResyncRequests(scopeId)
  for (const request of requests) {
    await processMlsResyncRequest(targetId, topic, request)
  }
}

async function processPendingHistoryRequests(
  targetId: string,
  scopeId: string,
  topic: string
): Promise<void> {
  const requests = await fetchPendingHistoryRequests(scopeId)
  const currentUserId = useAuthStore.getState().user?.id
  const localDeviceId = getLocalDeviceIdentity().id

  for (const request of requests) {
    if (
      request.requester_id !== currentUserId ||
      !request.requester_client_id ||
      request.requester_client_id === localDeviceId
    ) {
      continue
    }
    await sendHistoryBundle(
      targetId,
      topic,
      request.requester_id,
      request.requester_client_id,
      request.id
    )
  }
}

async function processPendingHistoryBundles(
  targetId: string,
  scopeId: string,
  set: (fn: (s: MessageState) => Partial<MessageState>) => void
): Promise<void> {
  const bundles = await fetchPendingHistoryBundles(scopeId)
  const currentUserId = useAuthStore.getState().user?.id
  const localDeviceId = getLocalDeviceIdentity().id

  for (const bundle of bundles) {
    if (
      bundle.recipient_id !== currentUserId ||
      bundle.recipient_client_id !== localDeviceId
    ) {
      continue
    }

    await processHistoryBundle(
      targetId,
      {
        id: bundle.id,
        ciphertext: bundle.ciphertext,
        mls_epoch: bundle.mls_epoch,
        recipient_id: bundle.recipient_id,
        recipient_device_id: bundle.recipient_client_id,
        sender_id: bundle.sender_id
      },
      set
    )
  }
}

export async function processPendingHistoryScope(
  scopeId: string,
  topic: string
): Promise<void> {
  const hadChannel = Boolean(getChannel(topic))

  if (!hadChannel) {
    await joinChannelWithAck(topic, () => {})
  }

  try {
    await processPendingHistoryRequests(scopeId, scopeId, topic)
    await processPendingHistoryBundles(scopeId, scopeId, useMessageStore.setState)
  } finally {
    if (!hadChannel) {
      leaveChannel(topic)
    }
  }
}

async function fetchUrgentMessagesById(
  messageIds: string[]
): Promise<Map<string, Record<string, unknown>>> {
  const uniqueMessageIds = [...new Set(messageIds.filter((messageId) => messageId.length > 0))]

  if (uniqueMessageIds.length === 0) {
    return new Map()
  }

  try {
    const query = new URLSearchParams()
    query.set('ids', uniqueMessageIds.join(','))

    const response = await apiFetch(`/api/v1/messages?${query.toString()}`)
    if (response.ok) {
      const data = (await response.json()) as {
        messages?: Record<string, unknown>[]
      }
      const rawMessages = Array.isArray(data.messages) ? data.messages : []
      return new Map(
        rawMessages
          .map((message) => {
            const id = typeof message.id === 'string' ? message.id : null
            return id ? ([id, message] as const) : null
          })
          .filter((entry): entry is readonly [string, Record<string, unknown>] => entry !== null)
      )
    }
  } catch {
    // Fall back to individual fetches below.
  }

  const entries = await Promise.all(
    uniqueMessageIds.map(async (messageId) => {
      try {
        const response = await apiFetch(`/api/v1/messages/${messageId}`)
        if (!response.ok) {
          return null
        }

        const data = (await response.json()) as { message?: Record<string, unknown> }
        return data.message ? ([messageId, data.message] as const) : null
      } catch {
        return null
      }
    })
  )

  return new Map(
    entries.filter((entry): entry is readonly [string, Record<string, unknown>] => entry !== null)
  )
}

export async function processUrgentSyncEvents(
  events: Array<{
    id: number
    scope_kind: 'channel' | 'dm'
    scope_id: string
    event_type: string
    inserted_at: string
    payload?: Record<string, unknown>
  }>
): Promise<void> {
  const myId = useAuthStore.getState().user?.id
  const urgentEvents = events
    .filter((event) => event.event_type === 'urgent_message')
    .map((event) => {
      const payload = event.payload ?? {}
      const messageId = typeof payload.message_id === 'string' ? payload.message_id : null
      const senderId = typeof payload.sender_id === 'string' ? payload.sender_id : null

      if (!messageId || (myId && senderId === myId)) {
        return null
      }

      return { event, messageId }
    })
    .filter(
      (
        entry
      ): entry is {
        event: {
          id: number
          scope_kind: 'channel' | 'dm'
          scope_id: string
          event_type: string
          inserted_at: string
          payload?: Record<string, unknown>
        }
        messageId: string
      } => entry !== null
    )

  if (urgentEvents.length === 0) {
    return
  }

  const hydratedMessages = await fetchUrgentMessagesById(
    urgentEvents.map((entry) => entry.messageId)
  )

  for (const { event, messageId } of urgentEvents) {
    const rawMessage = hydratedMessages.get(messageId)
    if (!rawMessage) {
      continue
    }

    try {
      const targetId =
        ((rawMessage.channel_id as string | null) ??
          (rawMessage.conversation_id as string | null) ??
          event.scope_id) || event.scope_id
      const processed = await processIncomingMessage(targetId, rawMessage, undefined, 'urgent')

      applyProcessedIncomingMessage(targetId, processed, rawMessage, useMessageStore.setState)
      maybeShowDesktopNotification(processed)
    } catch {
      // ignore urgent hydration failures
    }
  }
}

async function waitForChannelBootstrap(
  channelId: string,
  initialMemberCount: number
): Promise<void> {
  const deadline = Date.now() + 5000
  let lastCount = initialMemberCount
  let lastChangeTime = Date.now()

  while (Date.now() < deadline) {
    const currentCount = useCryptoStore.getState().getMemberCount(channelId)
    if (currentCount !== lastCount) {
      lastCount = currentCount
      lastChangeTime = Date.now()
    }

    // Wait for at least one join AND 500ms of stability (no new members)
    if (currentCount > initialMemberCount && Date.now() - lastChangeTime > 500) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

function getExpectedChannelMemberCount(channelId: string): number | null {
  const serverStore = useServerStore.getState()
  const activeServer = serverStore.servers.find((server) =>
    server.channels.some((channel) => channel.id === channelId)
  )

  if (!activeServer) {
    return null
  }

  if (serverStore.activeServerId !== activeServer.id) {
    return null
  }

  return serverStore.members.length > 0 ? serverStore.members.length : null
}

async function waitForChannelMembershipReady(
  channelId: string,
  topic: string
): Promise<void> {
  const expectedMemberCount = getExpectedChannelMemberCount(channelId)
  const deadline = Date.now() + 5000
  let lastCount = useCryptoStore.getState().getMemberCount(channelId)
  let lastChangeTime = Date.now()
  let requestedJoinAll = false

  if (
    expectedMemberCount !== null &&
    lastCount > 0 &&
    lastCount < expectedMemberCount
  ) {
    pushToChannel(topic, 'mls_request_join_all', {})
    requestedJoinAll = true
  }

  while (Date.now() < deadline) {
    const currentCount = useCryptoStore.getState().getMemberCount(channelId)
    if (currentCount !== lastCount) {
      lastCount = currentCount
      lastChangeTime = Date.now()
    }

    if (
      expectedMemberCount !== null &&
      currentCount > 0 &&
      currentCount < expectedMemberCount &&
      !requestedJoinAll
    ) {
      pushToChannel(topic, 'mls_request_join_all', {})
      requestedJoinAll = true
    }

    const stableForMs = Date.now() - lastChangeTime
    if (
      expectedMemberCount !== null &&
      currentCount >= expectedMemberCount &&
      stableForMs >= 750
    ) {
      return
    }

    if (expectedMemberCount === null && stableForMs >= 750) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

function getDmConversation(conversationId: string) {
  return useDmStore
    .getState()
    .conversations.find((conversation) => conversation.id === conversationId) ?? null
}

function isDmBootstrapLeader(conversationId: string, userId: string): boolean {
  const conversation = getDmConversation(conversationId)
  if (!conversation) {
    return false
  }

  const participantIds = conversation.participants
    .map((participant) => participant.user_id)
    .sort((left, right) => left.localeCompare(right))

  return participantIds[0] === userId
}

async function bootstrapDmGroupIfLeader(
  conversationId: string,
  topic: string
): Promise<boolean> {
  const crypto = useCryptoStore.getState()
  if (crypto.hasGroup(conversationId)) {
    return true
  }

  const userId = useAuthStore.getState().user?.id
  const conversation = getDmConversation(conversationId)

  if (!userId || !conversation || !isDmBootstrapLeader(conversationId, userId)) {
    return false
  }

  await crypto.createGroup(conversationId)
  if (!useCryptoStore.getState().hasGroup(conversationId)) {
    return false
  }

  for (const participant of conversation.participants) {
    if (participant.user_id === userId) {
      continue
    }

    const preferredDeviceId = getPreferredMlsJoinDeviceId(topic, participant.user_id)
    const result = await crypto.handleJoinRequest(
      conversationId,
      participant.user_id,
      participant.user.username,
      preferredDeviceId
    )

    if (!result) {
      continue
    }

    pushToChannel(topic, 'mls_commit', {
      commit_data: result.commitBytes
    })

    if (result.welcomeBytes) {
      pushToChannel(topic, 'mls_welcome', {
        recipient_id: participant.user_id,
        recipient_device_id: preferredDeviceId,
        welcome_data: result.welcomeBytes,
        key_package_ref: result.keyPackageRef
      })
    }
  }

  return useCryptoStore.getState().hasGroup(conversationId)
}

async function waitForDmBootstrap(
  conversationId: string,
  timeoutMs = DM_JOIN_WAIT_TIMEOUT_MS
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (useCryptoStore.getState().hasGroup(conversationId)) {
      return true
    }

    await useCryptoStore.getState().ensureGroupMembership(conversationId).catch(() => {})

    if (useCryptoStore.getState().hasGroup(conversationId)) {
      return true
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  return useCryptoStore.getState().hasGroup(conversationId)
}

/**
 * Force-create the MLS group for a DM conversation, skipping the leader check.
 * Used as a fallback when the designated leader hasn't bootstrapped the group
 * (e.g. because they haven't opened the conversation yet).
 */
async function forceBootstrapDmGroup(
  conversationId: string,
  topic: string
): Promise<boolean> {
  const crypto = useCryptoStore.getState()
  if (crypto.hasGroup(conversationId)) return true

  const userId = useAuthStore.getState().user?.id
  const conversation = getDmConversation(conversationId)
  if (!userId || !conversation) return false

  await crypto.createGroup(conversationId)
  if (!useCryptoStore.getState().hasGroup(conversationId)) return false

  for (const participant of conversation.participants) {
    if (participant.user_id === userId) continue

    const preferredDeviceId = getPreferredMlsJoinDeviceId(topic, participant.user_id)
    const result = await crypto.handleJoinRequest(
      conversationId,
      participant.user_id,
      participant.user.username,
      preferredDeviceId
    )

    if (!result) continue

    pushToChannel(topic, 'mls_commit', {
      commit_data: result.commitBytes
    })

    if (result.welcomeBytes) {
      pushToChannel(topic, 'mls_welcome', {
        recipient_id: participant.user_id,
        recipient_device_id: preferredDeviceId,
        welcome_data: result.welcomeBytes,
        key_package_ref: result.keyPackageRef
      })
    }
  }

  return useCryptoStore.getState().hasGroup(conversationId)
}

export async function ensureChannelGroupReady(channelId: string): Promise<boolean> {
  const crypto = useCryptoStore.getState()
  if (crypto.hasGroup(channelId)) {
    return true
  }

  // Try to join an existing group first — another member may have already
  // created one. Check local DB, pending welcomes, etc.
  await crypto.ensureGroupMembership(channelId)
  if (useCryptoStore.getState().hasGroup(channelId)) {
    return true
  }

  // Ask to join an existing group (bypass cooldown since we're about to send)
  const topic = `chat:channel:${channelId}`
  recentMlsJoinRequests.delete(topic)
  pushToChannel(topic, 'mls_request_join', {
    device_id: getLocalDeviceIdentity().id
  })

  // Wait for a welcome — if someone has the group, they'll add us
  const joinDeadline = Date.now() + 2000
  while (Date.now() < joinDeadline) {
    if (useCryptoStore.getState().hasGroup(channelId)) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  // Last chance: check server-side pending welcomes — the WebSocket
  // broadcast may have been missed but the server stores welcomes in DB.
  await useCryptoStore.getState().ensureGroupMembership(channelId)
  if (useCryptoStore.getState().hasGroup(channelId)) {
    return true
  }

  // Nobody responded — create the group ourselves
  await crypto.createGroup(channelId)
  if (!useCryptoStore.getState().hasGroup(channelId)) {
    return false
  }

  const initialMemberCount = useCryptoStore.getState().getMemberCount(channelId)
  pushToChannel(topic, 'mls_request_join_all', {})
  await waitForChannelBootstrap(channelId, initialMemberCount)

  return useCryptoStore.getState().hasGroup(channelId)
}

function getScopeRecoveryKey(scope: EncryptedScopeDescriptor): string {
  return `${scope.kind}:${scope.scopeId}`
}

async function refreshEncryptedScope(
  scope: EncryptedScopeDescriptor,
  getState: () => MessageState
): Promise<void> {
  if (scope.kind === 'channel') {
    await getState().fetchMessages(scope.targetId)
    return
  }

  await getState().fetchDmMessages(scope.targetId)
}

function hasFailedMessagesInScope(
  scope: EncryptedScopeDescriptor,
  getState: () => MessageState
): boolean {
  return hasFailedEncryptedMessages(getState().messagesByChannel[scope.targetId])
}

async function ensureEncryptedScopeMembership(
  scope: EncryptedScopeDescriptor
): Promise<void> {
  if (!canUseEncryptedFeatures()) {
    return
  }

  const crypto = useCryptoStore.getState()

  await crypto.ensureGroupMembership(scope.targetId)
  if (crypto.hasGroup(scope.targetId)) {
    return
  }

  if (scope.kind === 'dm') {
    const bootstrapped = await bootstrapDmGroupIfLeader(scope.targetId, scope.topic)
    if (bootstrapped) {
      return
    }

    await waitForDmBootstrap(scope.targetId)
  }
}

function requestEncryptedScopeRecovery(
  scope: EncryptedScopeDescriptor,
  lastKnownEpoch: number | null,
  reason: string
): void {
  if (!canUseEncryptedFeatures()) {
    return
  }

  const crypto = useCryptoStore.getState()

  if (crypto.hasGroup(scope.targetId)) {
    maybeRequestMlsResync(
      scope.targetId,
      scope.scopeId,
      scope.topic,
      lastKnownEpoch,
      reason
    )
    return
  }

  maybeRequestMlsJoin(scope.targetId, scope.topic)
}

async function recoverEncryptedScope(
  scope: EncryptedScopeDescriptor,
  getState: () => MessageState,
  lastKnownEpoch: number | null,
  reason: string
): Promise<void> {
  if (!canUseEncryptedFeatures()) {
    return
  }

  // If a Welcome was recently processed for this scope, skip recovery. The
  // Welcome handler already marks pre-join messages as unavailable and requests
  // a history bundle from existing devices.
  const welcomeAt = recentWelcomeProcessed.get(scope.targetId) ?? 0
  if (Date.now() - welcomeAt < WELCOME_RECOVERY_SUPPRESSION_MS) {
    return
  }

  const crypto = useCryptoStore.getState()
  const shouldAvoidResync =
    scope.kind === 'dm' &&
    (!crypto.hasGroup(scope.targetId) || crypto.getMemberCount(scope.targetId) < 2)

  const key = getScopeRecoveryKey(scope)
  const existing = inFlightScopeRecoveries.get(key)
  if (existing) {
    return existing
  }

  const run = (async () => {
    const tryRecoveryRound = async (
      roundReason: string,
      strategy: 'history-first' | 'resync'
    ): Promise<boolean> => {
      if (strategy === 'resync') {
        requestEncryptedScopeRecovery(scope, lastKnownEpoch, roundReason)
      } else if (useCryptoStore.getState().hasGroup(scope.targetId)) {
        requestHistorySync(scope.scopeId, scope.topic, 0, true)
      } else {
        maybeRequestMlsJoin(scope.targetId, scope.topic)
      }

      await ensureEncryptedScopeMembership(scope).catch(() => {})
      await refreshEncryptedScope(scope, getState).catch(() => {})
      await processPendingHistoryBundles(scope.targetId, scope.scopeId, useMessageStore.setState).catch(
        () => {}
      )

      if (!hasFailedMessagesInScope(scope, getState)) {
        return true
      }

      for (const delayMs of MLS_RECOVERY_BACKOFF_MS) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        if (strategy === 'resync') {
          requestEncryptedScopeRecovery(scope, lastKnownEpoch, roundReason)
        } else if (useCryptoStore.getState().hasGroup(scope.targetId)) {
          requestHistorySync(scope.scopeId, scope.topic, 0, true)
        } else {
          maybeRequestMlsJoin(scope.targetId, scope.topic)
        }
        await ensureEncryptedScopeMembership(scope).catch(() => {})
        await refreshEncryptedScope(scope, getState).catch(() => {})
        await processPendingHistoryBundles(
          scope.targetId,
          scope.scopeId,
          useMessageStore.setState
        ).catch(() => {})

        if (!hasFailedMessagesInScope(scope, getState)) {
          return true
        }
      }

      return false
    }

    if (await tryRecoveryRound(reason, 'history-first')) {
      return
    }

    if (shouldAvoidResync) {
      return
    }

    if (await tryRecoveryRound(`${reason}:resync`, 'resync')) {
      return
    }

    // Recovery exhausted — mark remaining failed messages as permanently unavailable
    // so the UI doesn't keep showing "syncing" forever
    markFailedMessagesUnavailable(scope, getState)
  })().finally(() => {
    inFlightScopeRecoveries.delete(key)
  })

  inFlightScopeRecoveries.set(key, run)
  return run
}

/**
 * After recovery retries are exhausted, replace the "syncing" placeholder with
 * a permanent "unavailable" message so the UI doesn't mislead the user into
 * thinking messages will eventually appear.
 */
function markFailedMessagesUnavailable(
  scope: EncryptedScopeDescriptor,
  getState: () => MessageState
): void {
  const messages = getState().messagesByChannel[scope.targetId]
  if (!messages) return

  const updated = messages.map((msg) => {
    if (
      msg.encrypted &&
      msg.decryptionFailed &&
      (msg.content === ENCRYPTED_MESSAGE_SYNCING_PLACEHOLDER ||
        msg.content === ENCRYPTED_MESSAGE_APPROVAL_PLACEHOLDER)
    ) {
      return { ...msg, content: ENCRYPTED_MESSAGE_UNAVAILABLE_PLACEHOLDER }
    }
    return msg
  })

  if (updated !== messages) {
    useMessageStore.setState((s) => ({
      messagesByChannel: {
        ...s.messagesByChannel,
        [scope.targetId]: updated
      }
    }))
  }
}

function maybeRecoverEncryptedScope(
  scope: EncryptedScopeDescriptor,
  getState: () => MessageState,
  lastKnownEpoch: number | null,
  reason: string
): void {
  if (!canUseEncryptedFeatures()) {
    return
  }

  if (!hasFailedMessagesInScope(scope, getState)) {
    return
  }

  void recoverEncryptedScope(scope, getState, lastKnownEpoch, reason).catch(() => {})
}

async function refreshScopeAfterCryptoUpdate(
  scope: EncryptedScopeDescriptor,
  getState: () => MessageState,
  setState: (fn: (s: MessageState) => Partial<MessageState>) => void,
  afterWelcome = false
): Promise<void> {
  await refreshEncryptedScope(scope, getState).catch(() => {})

  await processPendingHistoryBundles(scope.targetId, scope.scopeId, setState).catch(() => {})

  if (hasFailedMessagesInScope(scope, getState)) {
    if (afterWelcome) {
      // After joining via Welcome, failed messages are from before this device
      // joined the group and can't be decrypted (MLS forward secrecy). Mark
      // them as permanently unavailable instead of triggering recovery which
      // would resync the epoch and break messages that ARE decryptable.
      markFailedMessagesUnavailable(scope, getState)
    } else {
      void recoverEncryptedScope(scope, getState, null, 'post_crypto_update').catch(() => {})
    }
  }

  if (!afterWelcome) {
    await processPendingMlsResyncRequests(scope.targetId, scope.scopeId, scope.topic).catch(() => {})
  }

  if (useCryptoStore.getState().hasGroup(scope.targetId)) {
    await processPendingHistoryRequests(scope.targetId, scope.scopeId, scope.topic).catch(() => {})
  }
}

export interface ReactionGroup {
  emoji: string
  senderIds: string[]
}

interface RawReaction {
  id: string
  emoji: string
  sender_id: string
  ciphertext?: string | null
  mls_epoch?: number | null
  inserted_at: string
}

async function resolveReactionGroups(
  targetId: string,
  reactions?: RawReaction[]
): Promise<ReactionGroup[] | undefined> {
  if (!reactions || reactions.length === 0) return undefined

  const groups = new Map<string, string[]>()
  const decryptedByCiphertext = new Map<string, string | null>()
  const ciphertextsToDecrypt: string[] = []

  for (const reaction of reactions) {
    if (!reaction.ciphertext || typeof reaction.ciphertext !== 'string') {
      continue
    }

    const sentPlaintext = getSentMessage(reaction.ciphertext)
    if (sentPlaintext) {
      decryptedByCiphertext.set(reaction.ciphertext, sentPlaintext)
      continue
    }

    if (!decryptedByCiphertext.has(reaction.ciphertext)) {
      ciphertextsToDecrypt.push(reaction.ciphertext)
      decryptedByCiphertext.set(reaction.ciphertext, null)
    }
  }

  if (ciphertextsToDecrypt.length > 0 && useAuthStore.getState().canUseE2EE) {
    const decrypted = await useCryptoStore
      .getState()
      .decryptBatchForChannel(targetId, ciphertextsToDecrypt, 'normal')

    decrypted.forEach((plaintext, index) => {
      decryptedByCiphertext.set(ciphertextsToDecrypt[index], plaintext)
    })
  }

  for (const reaction of reactions) {
    let key = reaction.emoji

    if (reaction.ciphertext && typeof reaction.ciphertext === 'string') {
      const decrypted = decryptedByCiphertext.get(reaction.ciphertext)
      if (decrypted) {
        key = decrypted
      }
    }

    if (!key || key === 'encrypted') {
      continue
    }

    const existing = groups.get(key)
    if (existing) {
      existing.push(reaction.sender_id)
    } else {
      groups.set(key, [reaction.sender_id])
    }
  }
  return Array.from(groups, ([emoji, senderIds]) => ({ emoji, senderIds }))
}

export interface Message {
  id: string
  room_seq?: number | null
  content: string
  channel_id: string | null
  conversation_id: string | null
  server_id?: string | null
  sender_id: string | null
  sender: MessageSender | null
  inserted_at: string
  expires_at: string | null
  parent_message_id: string | null
  attachments?: Attachment[]
  attachment_filenames?: string[]
  reactions?: ReactionGroup[]
  encrypted?: boolean
  decryptionFailed?: boolean
  edited_at?: string
  client_nonce?: string
  delivery_state?: 'sending' | 'sent' | 'failed'
}

export interface RecallSearchResult {
  id: string
  content: string
  channel_id: string | null
  conversation_id: string | null
  server_id?: string | null
  sender_id: string | null
  sender: MessageSender | null
  inserted_at: string
  attachment_filenames?: string[]
  search_preview?: string
}

export interface PendingMessageJumpTarget {
  requestId: number
  messageId: string
  targetId: string
  channelId: string | null
  conversationId: string | null
  serverId: string | null
}

export interface PinnedMessageEntry {
  id: string
  message: Message
  pinned_by_id: string
  inserted_at: string
}

interface TypingUser {
  user_id: string
  username: string
}

interface MessageState {
  messagesByChannel: Record<string, Message[]>
  latestRoomSeqByScope: Record<string, number>
  loadingByScope: Record<string, boolean>
  loadedByScope: Record<string, boolean>
  activeScopeId: string | null
  recentScopeIds: string[]
  scopeLifecycleById: Record<string, ScopeLifecycleEntry>
  typingUsers: Record<string, TypingUser[]>
  hasMore: Record<string, boolean>
  hasNewer: Record<string, boolean>
  replyingTo: Message | null
  editingMessage: Message | null
  encryptionError: string | null
  activeThreadParentId: string | null
  activeThreadParent: Message | null
  threadRepliesByParent: Record<string, Message[]>
  threadLoading: boolean
  threadError: string | null
  pendingJumpTarget: PendingMessageJumpTarget | null
  focusedMessageId: string | null
  pinnedByChannel: Record<string, PinnedMessageEntry[]>

  joinChannelChat: (channelId: string) => void
  leaveChannelChat: (channelId: string) => void
  activateScope: (scopeId: string, kind: ScopeKind) => void
  fetchMessages: (channelId: string) => Promise<void>
  fetchOlderMessages: (channelId: string) => Promise<void>
  fetchNewerMessages: (channelId: string) => Promise<void>
  sendMessage: (channelId: string, content: string, parentMessageId?: string) => Promise<void>
  sendTypingStart: (channelId: string) => void
  sendTypingStop: (channelId: string) => void

  // DM conversation support
  joinDmChat: (conversationId: string) => void
  leaveDmChat: (conversationId: string) => void
  fetchDmMessages: (conversationId: string) => Promise<void>
  fetchOlderDmMessages: (conversationId: string) => Promise<void>
  fetchNewerDmMessages: (conversationId: string) => Promise<void>
  syncRecentScopes: (sinceToken?: string | null) => Promise<void>
  sendDmMessage: (conversationId: string, content: string, parentMessageId?: string) => Promise<void>
  sendDmTypingStart: (conversationId: string) => void
  sendDmTypingStop: (conversationId: string) => void

  // Threads
  setReplyingTo: (message: Message | null) => void
  openThread: (message: Message) => Promise<void>
  closeThread: () => void
  fetchThreadReplies: (parentMessageId: string) => Promise<void>
  sendThreadReply: (content: string) => Promise<void>

  // Edit / Delete
  setEditingMessage: (message: Message | null) => void
  editMessage: (targetId: string, topic: string, messageId: string, newContent: string) => void
  deleteMessage: (targetId: string, topic: string, messageId: string) => void

  // Reactions
  addReaction: (targetId: string, topic: string, messageId: string, emoji: string) => void
  removeReaction: (targetId: string, topic: string, messageId: string, emoji: string) => void

  // Pinning
  pinMessage: (topic: string, messageId: string) => void
  unpinMessage: (topic: string, messageId: string) => void
  fetchPinnedMessages: (channelId: string) => Promise<PinnedMessageEntry[]>
  jumpToMessage: (channelId: string, messageId: string, insertedAt?: string) => Promise<boolean>
  focusMessage: (messageId: string) => void

  // Search
  searchMessages: (query: string) => Promise<RecallSearchResult[]>
  setPendingJumpTarget: (
    target: Omit<PendingMessageJumpTarget, 'requestId'> | null
  ) => void
  clearPendingJumpTarget: () => void
}

let jumpRequestCounter = 0

export const useMessageStore = create<MessageState>((set, get) => ({
  messagesByChannel: {},
  latestRoomSeqByScope: {},
  loadingByScope: {},
  loadedByScope: {},
  activeScopeId: null,
  recentScopeIds: [],
  scopeLifecycleById: {},
  typingUsers: {},
  hasMore: {},
  hasNewer: {},
  replyingTo: null,
  editingMessage: null,
  encryptionError: null,
  activeThreadParentId: null,
  activeThreadParent: null,
  threadRepliesByParent: {},
  threadLoading: false,
  threadError: null,
  pendingJumpTarget: null,
  focusedMessageId: null,
  pinnedByChannel: {},

  // --- Channel messaging (existing) ---

  activateScope: (scopeId, kind) => {
    const now = Date.now()

    set((s) => {
      const nextRecentScopeIds = [scopeId, ...s.recentScopeIds.filter((id) => id !== scopeId)].slice(
        0,
        MAX_WARM_SCOPES + 1
      )
      const nextScopeLifecycleById = { ...s.scopeLifecycleById }

      for (const [id, lifecycle] of Object.entries(nextScopeLifecycleById)) {
        if (id === scopeId) {
          continue
        }

        nextScopeLifecycleById[id] = {
          ...lifecycle,
          state: nextRecentScopeIds.includes(id) ? 'warm' : 'cold'
        }
      }

      nextScopeLifecycleById[scopeId] = {
        kind,
        state: 'active',
        lastVisitedAt: now
      }

      return {
        activeScopeId: scopeId,
        recentScopeIds: nextRecentScopeIds,
        scopeLifecycleById: nextScopeLifecycleById
      }
    })

    const warmScopeIds = get().recentScopeIds.filter((id) => id !== scopeId).slice(0, MAX_WARM_SCOPES)

    for (const warmScopeId of warmScopeIds) {
      const lifecycle = get().scopeLifecycleById[warmScopeId]
      if (!lifecycle) {
        continue
      }

      const alreadyLoaded = get().loadedByScope[warmScopeId] ?? false
      const alreadyLoading = get().loadingByScope[warmScopeId] ?? false
      const hasMessages = (get().messagesByChannel[warmScopeId] ?? []).length > 0

      if (!alreadyLoaded && !alreadyLoading && !hasMessages) {
        if (lifecycle.kind === 'channel') {
          void get().fetchMessages(warmScopeId)
        } else {
          void get().fetchDmMessages(warmScopeId)
        }
      }
    }

    set((s) => {
      const warmSet = new Set([scopeId, ...warmScopeIds])
      const nextMessagesByChannel = { ...s.messagesByChannel }
      const nextLoadingByScope = { ...s.loadingByScope }
      const nextLoadedByScope = { ...s.loadedByScope }
      const nextTypingUsers = { ...s.typingUsers }
      const nextHasMore = { ...s.hasMore }
      const nextHasNewer = { ...s.hasNewer }
      const nextScopeLifecycleById = { ...s.scopeLifecycleById }
      let changed = false

      for (const existingScopeId of Object.keys(nextMessagesByChannel)) {
        if (warmSet.has(existingScopeId)) {
          continue
        }

        delete nextMessagesByChannel[existingScopeId]
        delete nextLoadingByScope[existingScopeId]
        delete nextLoadedByScope[existingScopeId]
        delete nextTypingUsers[existingScopeId]
        delete nextHasMore[existingScopeId]
        delete nextHasNewer[existingScopeId]

        const lifecycle = nextScopeLifecycleById[existingScopeId]
        if (lifecycle) {
          nextScopeLifecycleById[existingScopeId] = {
            ...lifecycle,
            state: 'cold'
          }
        }

        changed = true
      }

      if (!changed) {
        return s
      }

      return {
        messagesByChannel: nextMessagesByChannel,
        loadingByScope: nextLoadingByScope,
        loadedByScope: nextLoadedByScope,
        typingUsers: nextTypingUsers,
        hasMore: nextHasMore,
        hasNewer: nextHasNewer,
        scopeLifecycleById: nextScopeLifecycleById
      }
    })

    syncWarmDmScopeSubscriptions(get())
  },

  joinChannelChat: (channelId) => {
    const topic = `chat:channel:${channelId}`
    const scope: EncryptedScopeDescriptor = {
      kind: 'channel',
      targetId: channelId,
      scopeId: channelId,
      topic
    }

    joinChannel(topic, (event, payload) => {
      const msg = payload as Record<string, unknown>

      if (event === 'new_message') {
        handleNewMessage(channelId, msg, set)
      } else if (event === 'typing_start') {
        set((s) => {
          const current = s.typingUsers[channelId] || []
          const typing = msg as unknown as TypingUser
          if (current.some((t) => t.user_id === typing.user_id)) return s
          return {
            typingUsers: {
              ...s.typingUsers,
              [channelId]: [...current, typing]
            }
          }
        })
      } else if (event === 'typing_stop') {
        set((s) => ({
          typingUsers: {
            ...s.typingUsers,
            [channelId]: (s.typingUsers[channelId] || []).filter(
              (t) => t.user_id !== (msg as { user_id: string }).user_id
            )
          }
        }))
      } else if (event === 'disappearing_ttl_updated') {
        useServerStore.getState().updateChannelTtl(
          msg.channel_id as string,
          msg.disappearing_ttl as number | null
        )
      } else if (event === 'mls_request_join_all') {
        if (!useCryptoStore.getState().hasGroup(channelId)) {
          // mls_request_join_all is a direct invitation from the group creator.
          // Bypass the cooldown — always respond so the creator can add us.
          // NOTE: Do NOT send mls_resync_request here — the join request is
          // sufficient. A resync would cause the leader to remove-then-re-add us,
          // inflating the epoch and producing stale welcomes.
          recentMlsJoinRequests.delete(topic)
          maybeRequestMlsJoin(channelId, topic)
        }
      } else if (event === 'mls_request_join') {
        handleMlsJoinRequest(channelId, msg, `chat:channel:${channelId}`)
      } else if (event === 'mls_resync_request') {
        void processMlsResyncRequest(channelId, topic, {
          id: msg.id as string | undefined,
          requester_id: msg.user_id as string,
          requester_username: (msg.username as string | undefined) ?? undefined,
          requester_client_id: (msg.device_id as string | undefined) ?? undefined,
          request_id: msg.request_id as string | undefined,
          last_known_epoch: (msg.last_known_epoch as number | null | undefined) ?? null,
          reason: (msg.reason as string | null | undefined) ?? null
        }).catch(() => {})
      } else if (event === 'mls_commit') {
        const senderId = msg.sender_id as string
        const senderDeviceId =
          typeof msg.sender_device_id === 'string' ? msg.sender_device_id : null
        const userId = useAuthStore.getState().user?.id
        const localDeviceId = getLocalDeviceIdentity().id
        if (senderId !== userId || senderDeviceId !== localDeviceId) {
          void useCryptoStore
            .getState()
            .handleCommit(channelId, msg.commit_data as string)
            .then(async () => {
              // Only refresh if we actually have a group after the commit.
              // Without group state (commit stored as pending for later Welcome),
              // refreshing fetches messages we can't decrypt and triggers
              // destructive recovery that interferes with the MLS handshake.
              if (useCryptoStore.getState().hasGroup(channelId)) {
                await refreshScopeAfterCryptoUpdate(scope, get, set, true)
              }
            })
            .catch(() => {})
        }
      } else if (event === 'mls_welcome') {
        const recipientId = msg.recipient_id as string
        const recipientDeviceId =
          typeof msg.recipient_device_id === 'string' ? msg.recipient_device_id : null
        const userId = useAuthStore.getState().user?.id
        if (
          recipientId === userId &&
          (!recipientDeviceId || recipientDeviceId === getLocalDeviceIdentity().id)
        ) {
          const welcomeId = typeof msg.id === 'string' ? msg.id : null
          void useCryptoStore
            .getState()
            .handleWelcome(
              channelId,
              msg.welcome_data as string,
              (msg.key_package_ref as string | undefined) ?? null
            )
            .then(async (processed) => {
              if (processed) {
                recentWelcomeProcessed.set(channelId, Date.now())
                if (welcomeId) {
                  await ackPendingWelcome(welcomeId).catch(() => {})
                }
                await refreshScopeAfterCryptoUpdate(scope, get, set, true)
                if (hasFailedMessagesInScope(scope, get)) {
                  requestHistorySync(channelId, topic, 0, true)
                }
              }
            })
            .catch(() => {})
        }
      } else if (event === 'mls_remove') {
        const userId = useAuthStore.getState().user?.id
        const removedId = msg.removed_user_id as string
        const senderId = msg.sender_id as string
        const senderDeviceId =
          typeof msg.sender_device_id === 'string' ? msg.sender_device_id : null
        const localDeviceId = getLocalDeviceIdentity().id
        const isLocalSender = senderId === userId && senderDeviceId === localDeviceId
        if (removedId === userId && !isLocalSender) {
          useCryptoStore.getState().resetGroup(channelId)
        } else if (!isLocalSender) {
          if (msg.commit_data) {
            useCryptoStore.getState().handleCommit(channelId, msg.commit_data as string)
          }
        }
      } else if (event === 'mls_history_request') {
        const requesterId = msg.user_id as string
        const requesterDeviceId =
          typeof msg.device_id === 'string' ? msg.device_id : null
        const currentUserId = useAuthStore.getState().user?.id
        const localDeviceId = getLocalDeviceIdentity().id
        if (
          requesterId === currentUserId &&
          requesterDeviceId &&
          requesterDeviceId !== localDeviceId
        ) {
          void sendHistoryBundle(
            channelId,
            topic,
            requesterId,
            requesterDeviceId,
            typeof msg.id === 'string' ? msg.id : undefined
          ).catch(() => {})
        }
      } else if (event === 'mls_history_bundle') {
        const recipientId = msg.recipient_id as string
        const recipientDeviceId =
          typeof msg.recipient_device_id === 'string' ? msg.recipient_device_id : null
        const currentUserId = useAuthStore.getState().user?.id
        if (
          recipientId === currentUserId &&
          recipientDeviceId === getLocalDeviceIdentity().id
        ) {
          void processHistoryBundle(channelId, msg, set).catch(() => {})
        }
      } else if (event === 'reaction_update') {
        handleReactionUpdate(channelId, msg, set)
      } else if (event === 'message_pinned') {
        handlePinBroadcast(channelId, msg, set, 'pin')
      } else if (event === 'message_unpinned') {
        handlePinBroadcast(channelId, msg, set, 'unpin')
      } else if (event === 'message_edited') {
        handleMessageEdited(channelId, msg, set)
      } else if (event === 'message_deleted') {
        handleMessageDeleted(channelId, msg, set)
      }
    })

    if (canUseEncryptedFeatures()) {
      useCryptoStore
        .getState()
        .ensureGroupMembership(channelId)
        .then(async () => {
          if (useCryptoStore.getState().hasGroup(channelId)) {
            return
          }

          maybeRequestMlsJoin(channelId, topic)
        })
        .catch(() => {
          // Continue without encryption
        })
        .finally(() => {
          get().fetchMessages(channelId)
          void processPendingMlsResyncRequests(channelId, channelId, topic).catch(() => {})
          void processPendingHistoryRequests(channelId, channelId, topic).catch(() => {})
          void processPendingHistoryBundles(channelId, channelId, set).catch(() => {})
        })
    } else {
      void get().fetchMessages(channelId)
    }
  },

  leaveChannelChat: (channelId) => {
    clearHistorySyncRetry(channelId)
    leaveChannel(`chat:channel:${channelId}`)
  },

  fetchMessages: async (channelId) => {
    const refreshToken = beginScopeMessageRefresh(channelId)
    set((s) => ({
      loadingByScope: {
        ...s.loadingByScope,
        [channelId]: true
      },
      scopeLifecycleById: {
        ...s.scopeLifecycleById,
        [channelId]: {
          kind: s.scopeLifecycleById[channelId]?.kind ?? 'channel',
          state: 'loading',
          lastVisitedAt: s.scopeLifecycleById[channelId]?.lastVisitedAt ?? Date.now()
        }
      }
    }))
    try {
      if (canUseEncryptedFeatures()) {
        await ensureEncryptedScopeMembership({
          kind: 'channel',
          targetId: channelId,
          scopeId: channelId,
          topic: `chat:channel:${channelId}`
        }).catch(() => {})
      }

      const res = await apiFetch(`/api/v1/channels/${channelId}/messages?limit=${MESSAGE_PAGE_SIZE}`)
      if (res.ok) {
        const data = await res.json()
        const rawMessages = (data.messages as Record<string, unknown>[]).reverse()
        const hasResidentMessages = (get().messagesByChannel[channelId] ?? []).length > 0
        const provisionalWindow = applyMessageWindow(
          rawMessages.map((message) => buildProvisionalMessage(message)),
          'replace'
        )

        if (hasResidentMessages && isCurrentScopeMessageRefresh(channelId, refreshToken)) {
          scheduleExpiryTimers(channelId, provisionalWindow.messages)
          set((s) => ({
            messagesByChannel: {
              ...s.messagesByChannel,
              [channelId]: provisionalWindow.messages
            },
            latestRoomSeqByScope: updateLatestRoomSeqByScope(
              s.latestRoomSeqByScope,
              channelId,
              getMaxRoomSeq(provisionalWindow.messages)
            ),
            hasMore: {
              ...s.hasMore,
              [channelId]:
                data.messages.length === MESSAGE_PAGE_SIZE || provisionalWindow.trimmedOlder
            },
            hasNewer: {
              ...s.hasNewer,
              [channelId]: provisionalWindow.trimmedNewer
            },
            loadedByScope: {
              ...s.loadedByScope,
              [channelId]: true
            },
            scopeLifecycleById: {
              ...s.scopeLifecycleById,
              [channelId]: {
                kind: s.scopeLifecycleById[channelId]?.kind ?? 'channel',
                state: s.activeScopeId === channelId ? 'active' : 'warm',
                lastVisitedAt: s.scopeLifecycleById[channelId]?.lastVisitedAt ?? Date.now()
              }
            }
          }))
        }

        const messages = await processIncomingMessageBatch(channelId, rawMessages, 'normal')
        const windowed = applyMessageWindow(messages, 'replace')

        if (!isCurrentScopeMessageRefresh(channelId, refreshToken)) {
          return
        }

        scheduleExpiryTimers(channelId, windowed.messages)
        set((s) => ({
          messagesByChannel: {
            ...s.messagesByChannel,
            [channelId]: windowed.messages
          },
          latestRoomSeqByScope: updateLatestRoomSeqByScope(
            s.latestRoomSeqByScope,
            channelId,
            getMaxRoomSeq(windowed.messages)
          ),
          hasMore: {
            ...s.hasMore,
            [channelId]: data.messages.length === MESSAGE_PAGE_SIZE || windowed.trimmedOlder
          },
          hasNewer: {
            ...s.hasNewer,
            [channelId]: windowed.trimmedNewer
          },
          loadedByScope: {
            ...s.loadedByScope,
            [channelId]: true
          },
          scopeLifecycleById: {
            ...s.scopeLifecycleById,
            [channelId]: {
              kind: s.scopeLifecycleById[channelId]?.kind ?? 'channel',
              state:
                hasFailedEncryptedMessages(windowed.messages) ||
                windowed.messages.some(
                  (message) => message.content === ENCRYPTED_MESSAGE_SYNCING_PLACEHOLDER
                )
                  ? 'stale'
                  : s.activeScopeId === channelId
                    ? 'active'
                    : 'warm',
              lastVisitedAt: s.scopeLifecycleById[channelId]?.lastVisitedAt ?? Date.now()
            }
          }
        }))
        maybeRecoverEncryptedScope(
          {
            kind: 'channel',
            targetId: channelId,
            scopeId: channelId,
            topic: `chat:channel:${channelId}`
          },
          get,
          null,
          'message_fetch'
        )
      }
    } catch {
      // ignore
    } finally {
      set((s) => ({
        loadingByScope: {
          ...s.loadingByScope,
          [channelId]: false
        },
        loadedByScope: {
          ...s.loadedByScope,
          [channelId]: true
        },
        scopeLifecycleById: {
          ...s.scopeLifecycleById,
          [channelId]: {
            kind: s.scopeLifecycleById[channelId]?.kind ?? 'channel',
            state:
              s.scopeLifecycleById[channelId]?.state === 'stale'
                ? 'stale'
                : s.activeScopeId === channelId
                  ? 'active'
                  : 'warm',
            lastVisitedAt: s.scopeLifecycleById[channelId]?.lastVisitedAt ?? Date.now()
          }
        }
      }))
    }
  },

  fetchOlderMessages: async (channelId) => {
    const existing = get().messagesByChannel[channelId] || []
    if (existing.length === 0) return

    const oldest = existing[0]
    try {
      const res = await apiFetch(
        `/api/v1/channels/${channelId}/messages?limit=${MESSAGE_PAGE_SIZE}&before=${encodeURIComponent(encodeMessageCursor(oldest))}`
      )
      if (res.ok) {
        const data = await res.json()
        const rawMessages = (data.messages as Record<string, unknown>[]).reverse()
        const olderMessages = await processIncomingMessageBatch(channelId, rawMessages, 'background')
        const mergedWindow = applyMessageWindow([...olderMessages, ...existing], 'prepend')
        set((s) => ({
          messagesByChannel: {
            ...s.messagesByChannel,
            [channelId]: mergedWindow.messages
          },
          latestRoomSeqByScope: updateLatestRoomSeqByScope(
            s.latestRoomSeqByScope,
            channelId,
            getMaxRoomSeq(mergedWindow.messages)
          ),
          hasMore: {
            ...s.hasMore,
            [channelId]: data.messages.length === MESSAGE_PAGE_SIZE
          },
          hasNewer: {
            ...s.hasNewer,
            [channelId]:
              (s.hasNewer[channelId] ?? false) || mergedWindow.trimmedNewer
          }
        }))
        maybeRecoverEncryptedScope(
          {
            kind: 'channel',
            targetId: channelId,
            scopeId: channelId,
            topic: `chat:channel:${channelId}`
          },
          get,
          null,
          'older_message_fetch'
        )
      }
    } catch {
      // ignore
    }
  },

  fetchNewerMessages: async (channelId) => {
    const existing = get().messagesByChannel[channelId] || []
    if (existing.length === 0) {
      await get().fetchMessages(channelId)
      return
    }

    const newest = existing[existing.length - 1]
    try {
      const res = await apiFetch(
        `/api/v1/channels/${channelId}/messages?limit=${MESSAGE_PAGE_SIZE}&after=${encodeURIComponent(encodeMessageCursor(newest))}`
      )
      if (res.ok) {
        const data = await res.json()
        const rawMessages = (data.messages as Record<string, unknown>[]).reverse()
        const newerMessages = await processIncomingMessageBatch(channelId, rawMessages, 'normal')
        const mergedWindow = applyMessageWindow([...existing, ...newerMessages], 'append')
        scheduleExpiryTimers(channelId, mergedWindow.messages)
        set((s) => ({
          messagesByChannel: {
            ...s.messagesByChannel,
            [channelId]: mergedWindow.messages
          },
          latestRoomSeqByScope: updateLatestRoomSeqByScope(
            s.latestRoomSeqByScope,
            channelId,
            getMaxRoomSeq(mergedWindow.messages)
          ),
          hasMore: {
            ...s.hasMore,
            [channelId]: (s.hasMore[channelId] ?? false) || mergedWindow.trimmedOlder
          },
          hasNewer: {
            ...s.hasNewer,
            [channelId]: data.messages.length === MESSAGE_PAGE_SIZE
          }
        }))
      }
    } catch {
      // ignore
    }
  },

  syncRecentScopes: async (sinceToken = null) => {
    const state = get()
    const scopeIds = [state.activeScopeId, ...state.recentScopeIds]
      .filter((scopeId): scopeId is string => Boolean(scopeId))
      .filter((scopeId, index, all) => all.indexOf(scopeId) === index)

    const scopes = scopeIds.flatMap((scopeId) => {
      const lifecycle = state.scopeLifecycleById[scopeId]
      const hasLoaded = state.loadedByScope[scopeId] ?? false
      const isLoading = state.loadingByScope[scopeId] ?? false
      const messages = state.messagesByChannel[scopeId] ?? []
      const newest = messages[messages.length - 1]
      const afterSeq = state.latestRoomSeqByScope[scopeId]

      if (!lifecycle || !hasLoaded || isLoading || lifecycle.state === 'loading') {
        return []
      }

      if (typeof afterSeq === 'number' && Number.isFinite(afterSeq)) {
        return [
          {
            id: scopeId,
            kind: lifecycle.kind,
            after_seq: afterSeq,
            ...(newest ? { after: encodeMessageCursor(newest) } : {})
          }
        ]
      }

      if (!newest) {
        return []
      }

      return [
        {
          id: scopeId,
          kind: lifecycle.kind,
          after: encodeMessageCursor(newest)
        }
      ]
    })

    if (scopes.length === 0) {
      return
    }

    try {
      const res = await apiFetch('/api/v1/sync/scopes', {
        method: 'POST',
        body: JSON.stringify({
          scopes,
          since: sinceToken,
          limit: MESSAGE_PAGE_SIZE
        })
      })

      if (!res.ok) {
        return
      }

      const data = await res.json()
      const batches = Array.isArray(data.scopes)
        ? (data.scopes as Array<{
            scope_id: string
            kind: ScopeKind
            has_more: boolean
            messages: Record<string, unknown>[]
            events?: Array<{
              id: string
              room_seq?: number | null
              event_type: string
              message_id?: string | null
              inserted_at: string
              payload?: Record<string, unknown>
            }>
          }>)
        : []

      for (const batch of batches) {
        const existing = get().messagesByChannel[batch.scope_id] ?? []
        const syncEvents = Array.isArray(batch.events) ? batch.events : []

        if (batch.messages.length > 0) {
          const rawMessages = [...batch.messages].reverse()
          const newerMessages = await processIncomingMessageBatch(
            batch.scope_id,
            rawMessages,
            'background'
          )
          const mergedWindow = applyMessageWindow([...existing, ...newerMessages], 'append')
          scheduleExpiryTimers(batch.scope_id, mergedWindow.messages)

          set((s) => ({
            messagesByChannel: {
              ...s.messagesByChannel,
              [batch.scope_id]: mergedWindow.messages
            },
            latestRoomSeqByScope: updateLatestRoomSeqByScope(
              s.latestRoomSeqByScope,
              batch.scope_id,
              getMaxRoomSeq(mergedWindow.messages),
              getMaxRoomSeq(syncEvents)
            ),
            hasMore: {
              ...s.hasMore,
              [batch.scope_id]: (s.hasMore[batch.scope_id] ?? false) || mergedWindow.trimmedOlder
            },
            hasNewer: {
              ...s.hasNewer,
              [batch.scope_id]: batch.has_more
            }
          }))
        }

        for (const syncEvent of syncEvents) {
          await applyScopeSyncEvent(batch.scope_id, syncEvent, set)
        }

        if (syncEvents.length > 0) {
          set((s) => ({
            latestRoomSeqByScope: updateLatestRoomSeqByScope(
              s.latestRoomSeqByScope,
              batch.scope_id,
              getMaxRoomSeq(syncEvents)
            )
          }))
        }
      }
    } catch {
      // ignore
    }
  },

  sendMessage: async (channelId, content, parentMessageId) => {
    if (!canUseEncryptedFeatures()) {
      set({
        encryptionError: 'Approve this device to send encrypted messages.'
      })
      return
    }

    const crypto = useCryptoStore.getState()
    const replyingTo = get().replyingTo
    const parentId = parentMessageId ?? replyingTo?.id ?? undefined
    const shouldClearInlineReply = !parentMessageId
    const mentionedUserIds = extractMentionedUserIds(content)
    const activeServer = useServerStore.getState().servers.find(
      (s) => s.id === useServerStore.getState().activeServerId
    )
    const clientNonce = generateClientNonce()
    const resolvedContent = replaceEmojiShortcodes(content, activeServer?.emojis ?? [])
    const payloadStr = encodePayload({ v: 1, type: 'text', text: resolvedContent })
    const topic = `chat:channel:${channelId}`
    const optimisticMessage = buildOptimisticMessage({
      targetId: channelId,
      content: resolvedContent,
      parentMessageId: parentId,
      channelId,
      serverId: activeServer?.id ?? null,
      clientNonce
    })

    upsertOptimisticMessage(channelId, optimisticMessage, set)
    syncChannelActivity(optimisticMessage)

    if (!crypto.hasGroup(channelId)) {
      const ready = await ensureChannelGroupReady(channelId)
      if (!ready) {
        updateOptimisticMessageState(channelId, clientNonce, 'failed', set)
        set({ encryptionError: 'Message could not be encrypted. Please try again.' })
        return
      }
    }

    if (crypto.hasGroup(channelId)) {
      await waitForChannelMembershipReady(channelId, topic)
      const encrypted = await crypto.encryptForChannel(channelId, payloadStr)
      if (encrypted) {
        cacheSentPlaintext(encrypted.ciphertext, resolvedContent)
        const pushed = await pushToChannelWithAck(topic, 'new_message', {
          ciphertext: encrypted.ciphertext,
          mls_epoch: encrypted.epoch,
          client_nonce: clientNonce,
          ...(parentId && { parent_message_id: parentId }),
          ...(mentionedUserIds.length > 0 && { mentioned_user_ids: mentionedUserIds })
        })
        if (!pushed) {
          updateOptimisticMessageState(channelId, clientNonce, 'failed', set)
          set({ encryptionError: 'Message could not be sent. Please try again.' })
          return
        }
        set({
          ...(shouldClearInlineReply ? { replyingTo: null } : {}),
          encryptionError: null
        })
        return
      }
    }

    updateOptimisticMessageState(channelId, clientNonce, 'failed', set)
    set({ encryptionError: 'Message could not be encrypted. Please try again.' })
  },

  sendTypingStart: (channelId) => {
    pushToChannel(`chat:channel:${channelId}`, 'typing_start', {})
  },

  sendTypingStop: (channelId) => {
    pushToChannel(`chat:channel:${channelId}`, 'typing_stop', {})
  },

  // --- DM conversation messaging ---

  joinDmChat: (conversationId) => {
    const topic = `dm:${conversationId}`
    const scope: EncryptedScopeDescriptor = {
      kind: 'dm',
      targetId: conversationId,
      scopeId: conversationId,
      topic
    }

    joinChannel(topic, (event, payload) => {
      const msg = payload as Record<string, unknown>

      if (event === 'new_message') {
        handleNewMessage(conversationId, msg, set)
      } else if (event === 'typing_start') {
        set((s) => {
          const current = s.typingUsers[conversationId] || []
          const typing = msg as unknown as TypingUser
          if (current.some((t) => t.user_id === typing.user_id)) return s
          return {
            typingUsers: {
              ...s.typingUsers,
              [conversationId]: [...current, typing]
            }
          }
        })
      } else if (event === 'typing_stop') {
        set((s) => ({
          typingUsers: {
            ...s.typingUsers,
            [conversationId]: (s.typingUsers[conversationId] || []).filter(
              (t) => t.user_id !== (msg as { user_id: string }).user_id
            )
          }
        }))
      } else if (event === 'disappearing_ttl_updated') {
        useDmStore.getState().updateConversationTtl(
          msg.conversation_id as string,
          msg.disappearing_ttl as number | null
        )
      } else if (event === 'mls_request_join') {
        handleMlsJoinRequest(conversationId, msg, topic)
      } else if (event === 'mls_resync_request') {
        void processMlsResyncRequest(conversationId, topic, {
          id: msg.id as string | undefined,
          requester_id: msg.user_id as string,
          requester_username: (msg.username as string | undefined) ?? undefined,
          requester_client_id: (msg.device_id as string | undefined) ?? undefined,
          request_id: msg.request_id as string | undefined,
          last_known_epoch: (msg.last_known_epoch as number | null | undefined) ?? null,
          reason: (msg.reason as string | null | undefined) ?? null
        }).catch(() => {})
      } else if (event === 'mls_commit') {
        const senderId = msg.sender_id as string
        const senderDeviceId =
          typeof msg.sender_device_id === 'string' ? msg.sender_device_id : null
        const userId = useAuthStore.getState().user?.id
        const localDeviceId = getLocalDeviceIdentity().id
        if (senderId !== userId || senderDeviceId !== localDeviceId) {
          void useCryptoStore
            .getState()
            .handleCommit(conversationId, msg.commit_data as string)
            .then(async () => {
              if (useCryptoStore.getState().hasGroup(conversationId)) {
                await refreshScopeAfterCryptoUpdate(scope, get, set, true)
              }
            })
            .catch(() => {})
        }
      } else if (event === 'mls_welcome') {
        const recipientId = msg.recipient_id as string
        const recipientDeviceId =
          typeof msg.recipient_device_id === 'string' ? msg.recipient_device_id : null
        const userId = useAuthStore.getState().user?.id
        if (
          recipientId === userId &&
          (!recipientDeviceId || recipientDeviceId === getLocalDeviceIdentity().id)
        ) {
          const welcomeId = typeof msg.id === 'string' ? msg.id : null
          void useCryptoStore
            .getState()
            .handleWelcome(
              conversationId,
              msg.welcome_data as string,
              (msg.key_package_ref as string | undefined) ?? null
            )
            .then(async (processed) => {
              if (processed) {
                recentWelcomeProcessed.set(conversationId, Date.now())
                if (welcomeId) {
                  await ackPendingWelcome(welcomeId).catch(() => {})
                }
                await refreshScopeAfterCryptoUpdate(scope, get, set, true)
                // Request message history from other devices of the same user
                // when this device still has failed encrypted messages after
                // joining. Messages sent before this device joined are not
                // decryptable by design and need a same-user history bundle.
                if (hasFailedMessagesInScope(scope, get)) {
                  requestHistorySync(conversationId, topic, 0, true)
                }
              }
            })
            .catch(() => {})
        }
      } else if (event === 'mls_remove') {
        const userId = useAuthStore.getState().user?.id
        const removedId = msg.removed_user_id as string
        const senderId = msg.sender_id as string
        const senderDeviceId =
          typeof msg.sender_device_id === 'string' ? msg.sender_device_id : null
        const localDeviceId = getLocalDeviceIdentity().id
        const isLocalSender = senderId === userId && senderDeviceId === localDeviceId
        // Only reset if someone ELSE removed us. If we sent the remove
        // ourselves (e.g., resync), our state is already updated.
        if (removedId === userId && !isLocalSender) {
          useCryptoStore.getState().resetGroup(conversationId)
        } else if (!isLocalSender) {
          if (msg.commit_data) {
            useCryptoStore.getState().handleCommit(conversationId, msg.commit_data as string)
          }
        }
      } else if (event === 'mls_history_request') {
        // Another device of the same user is requesting message history
        const requesterId = msg.user_id as string
        const requesterDeviceId =
          typeof msg.device_id === 'string' ? msg.device_id : null
        const currentUserId = useAuthStore.getState().user?.id
        const localDeviceId = getLocalDeviceIdentity().id
        if (
          requesterId === currentUserId &&
          requesterDeviceId &&
          requesterDeviceId !== localDeviceId
        ) {
          void sendHistoryBundle(
            conversationId,
            topic,
            requesterId,
            requesterDeviceId,
            typeof msg.id === 'string' ? msg.id : undefined
          ).catch((error) => {
            console.warn(
              '[mls] history bundle failed',
              JSON.stringify({
                conversationId,
                requesterDeviceId,
                error: error instanceof Error ? error.message : String(error)
              })
            )
          })
        }
      } else if (event === 'mls_history_bundle') {
        const recipientId = msg.recipient_id as string
        const recipientDeviceId =
          typeof msg.recipient_device_id === 'string' ? msg.recipient_device_id : null
        const currentUserId = useAuthStore.getState().user?.id
        if (
          recipientId === currentUserId &&
          recipientDeviceId === getLocalDeviceIdentity().id
        ) {
          void processHistoryBundle(conversationId, msg, set).catch(() => {})
        }
      } else if (event === 'reaction_update') {
        handleReactionUpdate(conversationId, msg, set)
      } else if (event === 'incoming_call') {
        const userId = useAuthStore.getState().user?.id
        if ((msg.caller_id as string) !== userId) {
          useVoiceStore.getState().setIncomingCall({
            callerId: msg.caller_id as string,
            conversationId: msg.conversation_id as string
          })
        }
      } else if (event === 'call_rejected') {
        useVoiceStore.getState().handleDmCallRejected(msg.conversation_id as string)
      } else if (event === 'message_edited') {
        handleMessageEdited(conversationId, msg, set)
      } else if (event === 'message_deleted') {
        handleMessageDeleted(conversationId, msg, set)
      }
    })

    if (canUseEncryptedFeatures()) {
      const conversation = getDmConversation(conversationId)
      const isExistingConversation = conversation?.last_message != null

      useCryptoStore
        .getState()
        .ensureGroupMembership(conversationId)
        .then(async () => {
          if (useCryptoStore.getState().hasGroup(conversationId)) {
            return
          }

          if (isExistingConversation) {
            // Existing conversation — request to join the existing group rather
            // than creating a local solo branch that cannot decrypt shared
            // ciphertext and can diverge from the real DM state.
            recentMlsJoinRequests.delete(topic)
            maybeRequestMlsJoin(conversationId, topic)

            // Wait for the other participant to respond with a Welcome
            const joined = await waitForDmBootstrap(conversationId, 2000)
            if (joined) {
              return
            }

            // Re-send the join request after the newly approved device has had
            // a moment to publish key packages instead of forcing a resync.
            recentMlsJoinRequests.delete(topic)
            maybeRequestMlsJoin(conversationId, topic)
            await useCryptoStore.getState().ensureGroupMembership(conversationId).catch(() => {})
          } else {
            // New conversation — create the group immediately
            const bootstrapped = await bootstrapDmGroupIfLeader(conversationId, topic)
            if (bootstrapped || useCryptoStore.getState().hasGroup(conversationId)) {
              return
            }

            const forced = await forceBootstrapDmGroup(conversationId, topic)
            if (forced || useCryptoStore.getState().hasGroup(conversationId)) {
              return
            }

            maybeRequestMlsJoin(conversationId, topic)
            maybeRequestMlsResync(
              conversationId,
              conversationId,
              topic,
              null,
              'missing_state'
            )
          }
        })
        .catch(() => {
          // Continue without encryption
        })
        .finally(() => {
          // Skip re-fetch if Welcome was processed — the Welcome handler
          // already re-fetched and will receive a history bundle.
          const welcomeAt = recentWelcomeProcessed.get(conversationId) ?? 0
          const welcomeProcessedRecently =
            Date.now() - welcomeAt < WELCOME_RECOVERY_SUPPRESSION_MS

          if (!welcomeProcessedRecently) {
            get().fetchDmMessages(conversationId)
            void processPendingMlsResyncRequests(conversationId, conversationId, topic).catch(
              () => {}
            )
          }

          void processPendingHistoryRequests(conversationId, conversationId, topic).catch(() => {})
          void processPendingHistoryBundles(conversationId, conversationId, set).catch(() => {})
        })
    } else {
      void get().fetchDmMessages(conversationId)
    }
  },

  leaveDmChat: (conversationId) => {
    clearHistorySyncRetry(conversationId)
    leaveChannel(`dm:${conversationId}`)
  },

  fetchDmMessages: async (conversationId) => {
    const refreshToken = beginScopeMessageRefresh(conversationId)
    set((s) => ({
      loadingByScope: {
        ...s.loadingByScope,
        [conversationId]: true
      },
      scopeLifecycleById: {
        ...s.scopeLifecycleById,
        [conversationId]: {
          kind: s.scopeLifecycleById[conversationId]?.kind ?? 'dm',
          state: 'loading',
          lastVisitedAt: s.scopeLifecycleById[conversationId]?.lastVisitedAt ?? Date.now()
        }
      }
    }))
    try {
      if (canUseEncryptedFeatures()) {
        await ensureEncryptedScopeMembership({
          kind: 'dm',
          targetId: conversationId,
          scopeId: conversationId,
          topic: `dm:${conversationId}`
        }).catch(() => {})
      }

      const res = await apiFetch(
        `/api/v1/conversations/${conversationId}/messages?limit=${MESSAGE_PAGE_SIZE}`
      )
      if (res.ok) {
        const data = await res.json()
        const rawMessages = (data.messages as Record<string, unknown>[]).reverse()
        const hasResidentMessages = (get().messagesByChannel[conversationId] ?? []).length > 0
        const provisionalWindow = applyMessageWindow(
          rawMessages.map((message) => buildProvisionalMessage(message)),
          'replace'
        )

        if (hasResidentMessages && isCurrentScopeMessageRefresh(conversationId, refreshToken)) {
          scheduleExpiryTimers(conversationId, provisionalWindow.messages)
          set((s) => ({
            messagesByChannel: {
              ...s.messagesByChannel,
              [conversationId]: provisionalWindow.messages
            },
            latestRoomSeqByScope: updateLatestRoomSeqByScope(
              s.latestRoomSeqByScope,
              conversationId,
              getMaxRoomSeq(provisionalWindow.messages)
            ),
            hasMore: {
              ...s.hasMore,
              [conversationId]:
                data.messages.length === MESSAGE_PAGE_SIZE || provisionalWindow.trimmedOlder
            },
            hasNewer: {
              ...s.hasNewer,
              [conversationId]: provisionalWindow.trimmedNewer
            },
            loadedByScope: {
              ...s.loadedByScope,
              [conversationId]: true
            },
            scopeLifecycleById: {
              ...s.scopeLifecycleById,
              [conversationId]: {
                kind: s.scopeLifecycleById[conversationId]?.kind ?? 'dm',
                state: s.activeScopeId === conversationId ? 'active' : 'warm',
                lastVisitedAt: s.scopeLifecycleById[conversationId]?.lastVisitedAt ?? Date.now()
              }
            }
          }))
        }

        const messages = await processIncomingMessageBatch(conversationId, rawMessages, 'normal')
        const windowed = applyMessageWindow(messages, 'replace')

        if (!isCurrentScopeMessageRefresh(conversationId, refreshToken)) {
          return
        }

        scheduleExpiryTimers(conversationId, windowed.messages)
        set((s) => ({
          messagesByChannel: {
            ...s.messagesByChannel,
            [conversationId]: windowed.messages
          },
          latestRoomSeqByScope: updateLatestRoomSeqByScope(
            s.latestRoomSeqByScope,
            conversationId,
            getMaxRoomSeq(windowed.messages)
          ),
          hasMore: {
            ...s.hasMore,
            [conversationId]:
              data.messages.length === MESSAGE_PAGE_SIZE || windowed.trimmedOlder
          },
          hasNewer: {
            ...s.hasNewer,
            [conversationId]: windowed.trimmedNewer
          },
          loadedByScope: {
            ...s.loadedByScope,
            [conversationId]: true
          },
          scopeLifecycleById: {
            ...s.scopeLifecycleById,
            [conversationId]: {
              kind: s.scopeLifecycleById[conversationId]?.kind ?? 'dm',
              state:
                hasFailedEncryptedMessages(windowed.messages) ||
                windowed.messages.some(
                  (message) => message.content === ENCRYPTED_MESSAGE_SYNCING_PLACEHOLDER
                )
                  ? 'stale'
                  : s.activeScopeId === conversationId
                    ? 'active'
                    : 'warm',
              lastVisitedAt: s.scopeLifecycleById[conversationId]?.lastVisitedAt ?? Date.now()
            }
          }
        }))
        maybeRecoverEncryptedScope(
          {
            kind: 'dm',
            targetId: conversationId,
            scopeId: conversationId,
            topic: `dm:${conversationId}`
          },
          get,
          null,
          'message_fetch'
        )
      }
    } catch {
      // ignore
    } finally {
      set((s) => ({
        loadingByScope: {
          ...s.loadingByScope,
          [conversationId]: false
        },
        loadedByScope: {
          ...s.loadedByScope,
          [conversationId]: true
        },
        scopeLifecycleById: {
          ...s.scopeLifecycleById,
          [conversationId]: {
            kind: s.scopeLifecycleById[conversationId]?.kind ?? 'dm',
            state:
              s.scopeLifecycleById[conversationId]?.state === 'stale'
                ? 'stale'
                : s.activeScopeId === conversationId
                  ? 'active'
                  : 'warm',
            lastVisitedAt: s.scopeLifecycleById[conversationId]?.lastVisitedAt ?? Date.now()
          }
        }
      }))
    }
  },

  fetchOlderDmMessages: async (conversationId) => {
    const existing = get().messagesByChannel[conversationId] || []
    if (existing.length === 0) return

    const oldest = existing[0]
    try {
      const res = await apiFetch(
        `/api/v1/conversations/${conversationId}/messages?limit=${MESSAGE_PAGE_SIZE}&before=${encodeURIComponent(encodeMessageCursor(oldest))}`
      )
      if (res.ok) {
        const data = await res.json()
        const rawMessages = (data.messages as Record<string, unknown>[]).reverse()
        const olderMessages = await processIncomingMessageBatch(
          conversationId,
          rawMessages,
          'background'
        )
        const mergedWindow = applyMessageWindow([...olderMessages, ...existing], 'prepend')
        set((s) => ({
          messagesByChannel: {
            ...s.messagesByChannel,
            [conversationId]: mergedWindow.messages
          },
          latestRoomSeqByScope: updateLatestRoomSeqByScope(
            s.latestRoomSeqByScope,
            conversationId,
            getMaxRoomSeq(mergedWindow.messages)
          ),
          hasMore: {
            ...s.hasMore,
            [conversationId]: data.messages.length === MESSAGE_PAGE_SIZE
          },
          hasNewer: {
            ...s.hasNewer,
            [conversationId]:
              (s.hasNewer[conversationId] ?? false) || mergedWindow.trimmedNewer
          }
        }))
        maybeRecoverEncryptedScope(
          {
            kind: 'dm',
            targetId: conversationId,
            scopeId: conversationId,
            topic: `dm:${conversationId}`
          },
          get,
          null,
          'older_message_fetch'
        )
      }
    } catch {
      // ignore
    }
  },

  fetchNewerDmMessages: async (conversationId) => {
    const existing = get().messagesByChannel[conversationId] || []
    if (existing.length === 0) {
      await get().fetchDmMessages(conversationId)
      return
    }

    const newest = existing[existing.length - 1]
    try {
      const res = await apiFetch(
        `/api/v1/conversations/${conversationId}/messages?limit=${MESSAGE_PAGE_SIZE}&after=${encodeURIComponent(encodeMessageCursor(newest))}`
      )
      if (res.ok) {
        const data = await res.json()
        const rawMessages = (data.messages as Record<string, unknown>[]).reverse()
        const newerMessages = await processIncomingMessageBatch(conversationId, rawMessages, 'normal')
        const mergedWindow = applyMessageWindow([...existing, ...newerMessages], 'append')
        scheduleExpiryTimers(conversationId, mergedWindow.messages)
        set((s) => ({
          messagesByChannel: {
            ...s.messagesByChannel,
            [conversationId]: mergedWindow.messages
          },
          latestRoomSeqByScope: updateLatestRoomSeqByScope(
            s.latestRoomSeqByScope,
            conversationId,
            getMaxRoomSeq(mergedWindow.messages)
          ),
          hasMore: {
            ...s.hasMore,
            [conversationId]:
              (s.hasMore[conversationId] ?? false) || mergedWindow.trimmedOlder
          },
          hasNewer: {
            ...s.hasNewer,
            [conversationId]: data.messages.length === MESSAGE_PAGE_SIZE
          }
        }))
      }
    } catch {
      // ignore
    }
  },

  sendDmMessage: async (conversationId, content, parentMessageId) => {
    if (!canUseEncryptedFeatures()) {
      set({
        encryptionError: 'Approve this device to send encrypted messages.'
      })
      return
    }

    const crypto = useCryptoStore.getState()
    const topic = `dm:${conversationId}`
    const replyingTo = get().replyingTo
    const parentId = parentMessageId ?? replyingTo?.id ?? undefined
    const shouldClearInlineReply = !parentMessageId
    const clientNonce = generateClientNonce()
    const payloadStr = encodePayload({ v: 1, type: 'text', text: content })
    const optimisticMessage = buildOptimisticMessage({
      targetId: conversationId,
      content,
      parentMessageId: parentId,
      conversationId,
      clientNonce
    })

    upsertOptimisticMessage(conversationId, optimisticMessage, set)
    syncDmConversationActivity(optimisticMessage)

    // For DMs, wait briefly for the other participant to join the group.
    // When both parties are on new devices, the group creator may have a solo
    // group until the other party processes a Welcome via mls_request_join.
    // Encrypting before they join means they can't decrypt (MLS forward secrecy).
    if (crypto.hasGroup(conversationId) && crypto.getMemberCount(conversationId) < 2) {
      const memberDeadline = Date.now() + 5000
      while (Date.now() < memberDeadline) {
        if (useCryptoStore.getState().getMemberCount(conversationId) >= 2) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }

    // Try encrypting with existing group, or create a new one
    const encrypted = useCryptoStore.getState().hasGroup(conversationId)
      ? await useCryptoStore.getState().encryptForChannel(conversationId, payloadStr)
      : null

    if (encrypted) {
      cacheSentPlaintext(encrypted.ciphertext, content)
      const pushed = await pushToChannelWithAck(topic, 'new_message', {
        ciphertext: encrypted.ciphertext,
        mls_epoch: encrypted.epoch,
        client_nonce: clientNonce,
        ...(parentId && { parent_message_id: parentId })
      })
      if (!pushed) {
        updateOptimisticMessageState(conversationId, clientNonce, 'failed', set)
        set({ encryptionError: 'Message could not be sent. Please try again.' })
        return
      }
      if (shouldClearInlineReply) {
        set({ replyingTo: null })
      }
      return
    }

    // Encryption failed or no group — reset stale state, then let the elected
    // DM bootstrap leader recreate the group to avoid split-brain state.
    if (crypto.hasGroup(conversationId)) {
      await crypto.resetGroup(conversationId)
    }

    const bootstrapped = await bootstrapDmGroupIfLeader(conversationId, topic)
    if (!bootstrapped) {
      maybeRequestMlsJoin(conversationId, topic)
      maybeRequestMlsResync(
        conversationId,
        conversationId,
        topic,
        null,
        'missing_state'
      )
      await waitForDmBootstrap(conversationId)

      // If we're still without a group, force-bootstrap regardless of leader
      // status. The other participant may not have opened the conversation yet
      // so waiting for them to bootstrap would hang indefinitely.
      if (!useCryptoStore.getState().hasGroup(conversationId)) {
        await forceBootstrapDmGroup(conversationId, topic)
      }
    }

    const freshEncrypted = useCryptoStore.getState().hasGroup(conversationId)
      ? await useCryptoStore.getState().encryptForChannel(conversationId, payloadStr)
      : null

    if (freshEncrypted) {
      cacheSentPlaintext(freshEncrypted.ciphertext, content)
      const pushed = await pushToChannelWithAck(topic, 'new_message', {
        ciphertext: freshEncrypted.ciphertext,
        mls_epoch: freshEncrypted.epoch,
        client_nonce: clientNonce,
        ...(parentId && { parent_message_id: parentId })
      })
      if (!pushed) {
        updateOptimisticMessageState(conversationId, clientNonce, 'failed', set)
        set({ encryptionError: 'Message could not be sent. Please try again.' })
        return
      }
      if (shouldClearInlineReply) {
        set({ replyingTo: null })
      }
      set({ encryptionError: null })
      return
    }

    updateOptimisticMessageState(conversationId, clientNonce, 'failed', set)
    set({ encryptionError: 'Conversation encryption is still syncing. Please try again.' })
  },

  sendDmTypingStart: (conversationId) => {
    pushToChannel(`dm:${conversationId}`, 'typing_start', {})
  },

  sendDmTypingStop: (conversationId) => {
    pushToChannel(`dm:${conversationId}`, 'typing_stop', {})
  },

  // Threads
  setReplyingTo: (message) => set({ replyingTo: message }),
  openThread: async (message) => {
    const parentId = message.parent_message_id ?? message.id
    set({
      activeThreadParentId: parentId,
      activeThreadParent: message.parent_message_id ? null : message,
      threadError: null
    })
    await get().fetchThreadReplies(parentId)
  },
  closeThread: () =>
    set({
      activeThreadParentId: null,
      activeThreadParent: null,
      threadError: null,
      threadLoading: false
    }),
  fetchThreadReplies: async (parentMessageId) => {
    set({ threadLoading: true, threadError: null })
    try {
      const res = await apiFetch(`/api/v1/messages/${parentMessageId}/thread?limit=200`)
      if (!res.ok) {
        if (get().activeThreadParentId === parentMessageId) {
          set({ threadLoading: false, threadError: 'Thread could not be loaded.' })
        }
        return
      }

      const data = (await res.json()) as {
        parent?: Record<string, unknown>
        messages?: Record<string, unknown>[]
      }

      const parentPayload = data.parent
      if (!parentPayload) {
        if (get().activeThreadParentId === parentMessageId) {
          set({ threadLoading: false, threadError: 'Thread could not be loaded.' })
        }
        return
      }

      const targetId = (parentPayload.channel_id || parentPayload.conversation_id) as string | undefined
      if (!targetId) {
        if (get().activeThreadParentId === parentMessageId) {
          set({ threadLoading: false, threadError: 'Thread could not be loaded.' })
        }
        return
      }

      const parent = await processIncomingMessage(targetId, parentPayload, undefined, 'normal')
      const replyPayloads = data.messages ?? []
      const replies = await processIncomingMessageBatch(targetId, replyPayloads, 'normal')

      if (get().activeThreadParentId !== parentMessageId) {
        set({ threadLoading: false })
        return
      }

      set((s) => ({
        activeThreadParentId: parent.id,
        activeThreadParent: parent,
        threadRepliesByParent: {
          ...s.threadRepliesByParent,
          [parent.id]: replies
        },
        threadLoading: false,
        threadError: null
      }))

      if (parent.encrypted && parent.decryptionFailed) {
        maybeRecoverEncryptedScope(
          {
            kind: parent.channel_id ? 'channel' : 'dm',
            targetId,
            scopeId: targetId,
            topic: parent.channel_id ? `chat:channel:${targetId}` : `dm:${targetId}`
          },
          get,
          null,
          'thread_fetch'
        )
      } else if (hasFailedEncryptedMessages(replies)) {
        maybeRecoverEncryptedScope(
          {
            kind: parent.channel_id ? 'channel' : 'dm',
            targetId,
            scopeId: targetId,
            topic: parent.channel_id ? `chat:channel:${targetId}` : `dm:${targetId}`
          },
          get,
          null,
          'thread_fetch'
        )
      }
    } catch {
      if (get().activeThreadParentId === parentMessageId) {
        set({ threadLoading: false, threadError: 'Thread could not be loaded.' })
      }
    }
  },
  sendThreadReply: async (content) => {
    const parent = get().activeThreadParent
    if (!parent) {
      return
    }

    const replyTarget = get().replyingTo
    const threadParentId = parent.id
    const replyTargetId =
      replyTarget &&
      (replyTarget.id === threadParentId || replyTarget.parent_message_id === threadParentId)
        ? replyTarget.id
        : threadParentId

    const trimmed = content.trim()
    if (!trimmed) {
      return
    }

    if (parent.channel_id) {
      await get().sendMessage(parent.channel_id, trimmed, replyTargetId)
      return
    }

    if (parent.conversation_id) {
      await get().sendDmMessage(parent.conversation_id, trimmed, replyTargetId)
    }
  },

  // Edit / Delete
  setEditingMessage: (message) => set({ editingMessage: message }),

  editMessage: async (targetId, topic, messageId, newContent) => {
    if (!canUseEncryptedFeatures()) {
      set({ encryptionError: 'Approve this device to edit encrypted messages.' })
      return
    }

    const crypto = useCryptoStore.getState()
    const payloadStr = encodePayload({ v: 1, type: 'text', text: newContent })

    if (crypto.hasGroup(targetId)) {
      const encrypted = await crypto.encryptForChannel(targetId, payloadStr)
      if (encrypted) {
        cacheSentPlaintext(encrypted.ciphertext, newContent)
        pushToChannel(topic, 'edit_message', {
          message_id: messageId,
          ciphertext: encrypted.ciphertext,
          mls_epoch: encrypted.epoch
        })
        set({ editingMessage: null, encryptionError: null })
        return
      }
    }

    set({ encryptionError: 'Edit could not be encrypted. Please try again.' })
  },

  deleteMessage: (_targetId, topic, messageId) => {
    pushToChannel(topic, 'delete_message', {
      message_id: messageId
    })
  },

  // Reactions
  addReaction: async (_targetId, topic, messageId, emoji) => {
    const channelId = topic.replace(/^chat:channel:|^dm:/, '')
    const crypto = useCryptoStore.getState()
    if (crypto.hasGroup(channelId)) {
      const encrypted = await crypto.encryptForChannel(channelId, emoji)
      if (encrypted) {
        pushToChannel(topic, 'add_reaction', {
          message_id: messageId,
          ciphertext: encrypted.ciphertext,
          mls_epoch: encrypted.epoch
        })
        return
      }
    }

    pushToChannel(topic, 'add_reaction', { message_id: messageId, emoji })
  },

  removeReaction: async (_targetId, topic, messageId, emoji) => {
    const channelId = topic.replace(/^chat:channel:|^dm:/, '')
    const crypto = useCryptoStore.getState()
    if (crypto.hasGroup(channelId)) {
      const encrypted = await crypto.encryptForChannel(channelId, emoji)
      if (encrypted) {
        pushToChannel(topic, 'remove_reaction', {
          message_id: messageId,
          ciphertext: encrypted.ciphertext,
          mls_epoch: encrypted.epoch
        })
        return
      }
    }

    pushToChannel(topic, 'remove_reaction', { message_id: messageId, emoji })
  },

  // Pinning
  pinMessage: (topic, messageId) => {
    pushToChannel(topic, 'pin_message', { message_id: messageId })
  },

  unpinMessage: (topic, messageId) => {
    pushToChannel(topic, 'unpin_message', { message_id: messageId })
  },

  fetchPinnedMessages: async (channelId) => {
    try {
      const res = await apiFetch(`/api/v1/channels/${channelId}/pins`)
      if (!res.ok) {
        return []
      }

      const data = (await res.json()) as {
        pins?: Array<{
          id: string
          message: Record<string, unknown>
          pinned_by_id: string
          inserted_at: string
        }>
      }

      const pinsRaw = data.pins ?? []
      const pinMessages = await processIncomingMessageBatch(
        channelId,
        pinsRaw.map((pin) => pin.message),
        'normal'
      )
      const pins = pinsRaw.map((pin, index) => ({
        id: pin.id,
        message: pinMessages[index],
        pinned_by_id: pin.pinned_by_id,
        inserted_at: pin.inserted_at
      }))

      set((s) => ({
        pinnedByChannel: {
          ...s.pinnedByChannel,
          [channelId]: pins
        }
      }))

      return pins
    } catch {
      return []
    }
  },

  jumpToMessage: async (channelId, messageId, insertedAt) => {
    const hasMessage = (): boolean =>
      (get().messagesByChannel[channelId] || []).some((message) => message.id === messageId)

    if ((get().messagesByChannel[channelId] || []).length === 0) {
      await get().fetchMessages(channelId)
    }

    if (hasMessage()) {
      get().focusMessage(messageId)
      return true
    }

    const targetMs = insertedAt ? Date.parse(insertedAt) : Number.NaN
    let previousOldestId: string | null = null
    let safetyCounter = 0

    while ((get().hasMore[channelId] ?? true) && safetyCounter < 40) {
      const current = get().messagesByChannel[channelId] || []
      const oldest = current[0]
      if (!oldest || oldest.id === previousOldestId) {
        break
      }
      previousOldestId = oldest.id

      try {
        const res = await apiFetch(
          `/api/v1/channels/${channelId}/messages?limit=50&before=${encodeURIComponent(oldest.inserted_at)}`
        )

        if (!res.ok) {
          break
        }

        const data = await res.json()
        const rawMessages = (data.messages as Record<string, unknown>[]).reverse()
        const olderMessages = await processIncomingMessageBatch(channelId, rawMessages, 'normal')
        scheduleExpiryTimers(channelId, olderMessages)

        set((s) => {
          const existing = s.messagesByChannel[channelId] || []
          const merged = [...olderMessages, ...existing]
          const deduped = merged.filter(
            (message, index, arr) => arr.findIndex((entry) => entry.id === message.id) === index
          )

          return {
            messagesByChannel: {
              ...s.messagesByChannel,
              [channelId]: deduped
            },
            hasMore: {
              ...s.hasMore,
              [channelId]: rawMessages.length === 50
            }
          }
        })
      } catch {
        break
      }

      if (hasMessage()) {
        get().focusMessage(messageId)
        return true
      }

      const newestStateOldest = get().messagesByChannel[channelId]?.[0]
      if (newestStateOldest && !Number.isNaN(targetMs)) {
        const oldestMs = Date.parse(newestStateOldest.inserted_at)
        if (!Number.isNaN(oldestMs) && oldestMs <= targetMs && !(get().hasMore[channelId] ?? false)) {
          break
        }
      }

      safetyCounter += 1
    }

    if (hasMessage()) {
      get().focusMessage(messageId)
      return true
    }

    return false
  },

  focusMessage: (messageId) => {
    set({ focusedMessageId: messageId })

    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        if (useMessageStore.getState().focusedMessageId === messageId) {
          useMessageStore.setState({ focusedMessageId: null })
        }
      }, 3_500)
    }
  },

  // Search only loaded client-side messages.
  searchMessages: async (query) => {
    const trimmed = query.trim()
    if (trimmed.length < 2) return []

    const needle = trimmed.toLowerCase()
    const seen = new Map<string, RecallSearchResult>()
    const loadedMessages = new Map<string, Message>()

    for (const messages of Object.values(get().messagesByChannel)) {
      for (const message of messages) {
        loadedMessages.set(message.id, message)

        if (!message || seen.has(message.id)) {
          continue
        }

        const haystack = getMessageSearchText(message).toLowerCase()

        if (!haystack.includes(needle)) {
          continue
        }

        seen.set(message.id, {
          id: message.id,
          content: message.content,
          channel_id: message.channel_id,
          conversation_id: message.conversation_id,
          server_id: message.server_id ?? null,
          sender_id: message.sender_id,
          sender: message.sender,
          inserted_at: message.inserted_at,
          attachment_filenames: [
            ...(message.attachment_filenames || []),
            ...(message.attachments?.map((attachment) => attachment.filename).filter(Boolean) || [])
          ],
          search_preview: getMessageSearchText(message)
        })
      }
    }

    const indexedResults = await searchDecryptedMessages(trimmed)
    for (const result of indexedResults) {
      if (seen.has(result.messageId)) {
        continue
      }

      const loaded = loadedMessages.get(result.messageId)
      if (loaded) {
        seen.set(result.messageId, {
          id: loaded.id,
          content: loaded.content,
          channel_id: loaded.channel_id,
          conversation_id: loaded.conversation_id,
          server_id: loaded.server_id ?? null,
          sender_id: loaded.sender_id,
          sender: loaded.sender,
          inserted_at: loaded.inserted_at,
          attachment_filenames: loaded.attachment_filenames,
          search_preview: result.preview.replace(/\[\[\[|\]\]\]/g, '')
        })
        continue
      }

      seen.set(result.messageId, {
        id: result.messageId,
        content: result.preview.replace(/\[\[\[|\]\]\]/g, ''),
        channel_id: result.conversationId ? null : result.channelId,
        conversation_id: result.conversationId ?? null,
        server_id: result.serverId ?? null,
        sender_id: result.senderId ?? null,
        sender: result.senderUsername
          ? {
              id: result.senderId ?? '',
              username: result.senderUsername,
              display_name: null,
              avatar_url: null
            }
          : null,
        inserted_at: result.insertedAt ?? new Date(0).toISOString(),
        attachment_filenames: [],
        search_preview: result.preview.replace(/\[\[\[|\]\]\]/g, '')
      })
    }

    return [...seen.values()]
      .sort(
        (left, right) =>
          new Date(right.inserted_at).getTime() - new Date(left.inserted_at).getTime()
      )
      .slice(0, 50)
  },

  setPendingJumpTarget: (target) => {
    if (!target) {
      set({ pendingJumpTarget: null })
      return
    }

    jumpRequestCounter += 1
    set({
      pendingJumpTarget: {
        ...target,
        requestId: jumpRequestCounter
      }
    })
  },

  clearPendingJumpTarget: () => {
    set({ pendingJumpTarget: null })
  }
}))

// Track expiry timers so we can clean them up
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function clearExpiryTimers(): void {
  for (const timer of expiryTimers.values()) {
    clearTimeout(timer)
  }
  expiryTimers.clear()
}

function scheduleExpiryTimers(targetId: string, messages: Message[]): void {
  for (const msg of messages) {
    if (msg.expires_at) {
      scheduleMessageExpiry(targetId, msg.id, msg.expires_at)
    }
  }
}

function scheduleMessageExpiry(
  targetId: string,
  messageId: string,
  expiresAt: string
): void {
  const expiresMs = new Date(expiresAt).getTime()
  const delay = expiresMs - Date.now()

  if (delay <= 0) {
    // Already expired — remove immediately
    useMessageStore.setState((s) => ({
      messagesByChannel: {
        ...s.messagesByChannel,
        [targetId]: (s.messagesByChannel[targetId] || []).filter((m) => m.id !== messageId)
      }
    }))
    removeCachedDecryption(messageId)
    removeFromFtsIndex(messageId).catch(() => {})
    return
  }

  const timer = setTimeout(() => {
    useMessageStore.setState((s) => ({
      messagesByChannel: {
        ...s.messagesByChannel,
        [targetId]: (s.messagesByChannel[targetId] || []).filter((m) => m.id !== messageId)
      }
    }))
    expiryTimers.delete(messageId)
    removeCachedDecryption(messageId)
    removeFromFtsIndex(messageId).catch(() => {})
  }, delay)

  expiryTimers.set(messageId, timer)
}

function patchThreadStateForMessage(
  state: MessageState,
  messageId: string,
  updateMessage: (message: Message) => Message | null
): Partial<MessageState> {
  let threadsChanged = false
  const nextRepliesByParent: Record<string, Message[]> = {}

  for (const [parentId, replies] of Object.entries(state.threadRepliesByParent)) {
    let changed = false
    const nextReplies: Message[] = []

    for (const reply of replies) {
      if (reply.id === messageId) {
        const updated = updateMessage(reply)
        changed = true
        if (updated) {
          nextReplies.push(updated)
        }
      } else {
        nextReplies.push(reply)
      }
    }

    nextRepliesByParent[parentId] = changed ? nextReplies : replies
    if (changed) {
      threadsChanged = true
    }
  }

  let nextActiveThreadParent = state.activeThreadParent
  let activeParentChanged = false

  if (state.activeThreadParent?.id === messageId) {
    nextActiveThreadParent = updateMessage(state.activeThreadParent)
    activeParentChanged = true
  }

  const patch: Partial<MessageState> = {}
  if (threadsChanged) {
    patch.threadRepliesByParent = nextRepliesByParent
  }
  if (activeParentChanged) {
    patch.activeThreadParent = nextActiveThreadParent
    if (!nextActiveThreadParent && state.activeThreadParentId === messageId) {
      patch.activeThreadParentId = null
    }
  }

  return patch
}

/**
 * Handle a reaction update event.
 */
async function handleReactionUpdate(
  targetId: string,
  msg: Record<string, unknown>,
  set: (fn: (s: MessageState) => Partial<MessageState>) => void
): Promise<void> {
  const action = msg.action as string
  const messageId = msg.message_id as string
  const senderId = msg.sender_id as string
  let emoji = msg.emoji as string | undefined

  if (msg.ciphertext && typeof msg.ciphertext === 'string') {
    try {
      const sentPlaintext = getSentMessage(msg.ciphertext)
      if (sentPlaintext) {
        emoji = sentPlaintext
      } else {
        const decrypted = await useCryptoStore
          .getState()
          .decryptForChannel(targetId, msg.ciphertext)
        if (decrypted) {
          emoji = decrypted
        }
      }
    } catch (error) {
      console.warn('Failed to decrypt reaction emoji:', error)
    }
  }

  if (!emoji) {
    console.warn('Reaction update missing emoji content')
    return
  }

  const roomSeq = getRoomSeq(msg.room_seq)

  set((s) => {
    const messages = s.messagesByChannel[targetId] || []
    const updated = messages.map((m) => {
      if (m.id !== messageId) return m
      const reactions = [...(m.reactions || [])]

      if (action === 'add') {
        const existing = reactions.find((r) => r.emoji === emoji)
        if (existing) {
          if (!existing.senderIds.includes(senderId)) {
            existing.senderIds = [...existing.senderIds, senderId]
          }
        } else {
          reactions.push({ emoji, senderIds: [senderId] })
        }
      } else if (action === 'remove') {
        const idx = reactions.findIndex((r) => r.emoji === emoji)
        if (idx !== -1) {
          reactions[idx] = {
            ...reactions[idx],
            senderIds: reactions[idx].senderIds.filter((id) => id !== senderId)
          }
          if (reactions[idx].senderIds.length === 0) {
            reactions.splice(idx, 1)
          }
        }
      }

      return { ...m, reactions }
    })

    const threadPatch = patchThreadStateForMessage(s, messageId, (message) => {
      const reactions = [...(message.reactions || [])]
      if (action === 'add') {
        const existing = reactions.find((r) => r.emoji === emoji)
        if (existing) {
          if (!existing.senderIds.includes(senderId)) {
            existing.senderIds = [...existing.senderIds, senderId]
          }
        } else {
          reactions.push({ emoji, senderIds: [senderId] })
        }
      } else if (action === 'remove') {
        const idx = reactions.findIndex((r) => r.emoji === emoji)
        if (idx !== -1) {
          reactions[idx] = {
            ...reactions[idx],
            senderIds: reactions[idx].senderIds.filter((id) => id !== senderId)
          }
          if (reactions[idx].senderIds.length === 0) {
            reactions.splice(idx, 1)
          }
        }
      }
      return { ...message, reactions }
    })

    return {
      messagesByChannel: { ...s.messagesByChannel, [targetId]: updated },
      latestRoomSeqByScope: updateLatestRoomSeqByScope(
        s.latestRoomSeqByScope,
        targetId,
        roomSeq
      ),
      ...threadPatch
    }
  })

}

function buildOptimisticMessage(args: {
  targetId: string
  content: string
  parentMessageId?: string
  channelId?: string | null
  conversationId?: string | null
  serverId?: string | null
  clientNonce: string
}): Message {
  const currentUser = useAuthStore.getState().user

  return {
    id: `local:${args.clientNonce}`,
    room_seq: null,
    content: args.content,
    channel_id: args.channelId ?? null,
    conversation_id: args.conversationId ?? null,
    server_id: args.serverId ?? null,
    sender_id: currentUser?.id ?? null,
    sender: currentUser
      ? {
          id: currentUser.id,
          username: currentUser.username,
          display_name: currentUser.display_name,
          avatar_url: currentUser.avatar_url
        }
      : null,
    inserted_at: new Date().toISOString(),
    expires_at: null,
    parent_message_id: args.parentMessageId ?? null,
    attachments: [],
    reactions: [],
    encrypted: true,
    decryptionFailed: false,
    client_nonce: args.clientNonce,
    delivery_state: 'sending'
  }
}

function upsertOptimisticMessage(
  targetId: string,
  message: Message,
  set: (fn: (s: MessageState) => Partial<MessageState>) => void
): void {
  set((s) => {
    const existing = s.messagesByChannel[targetId] ?? []
    const nextWindow = applyMessageWindow([...existing, message], 'append')
    return {
      messagesByChannel: {
        ...s.messagesByChannel,
        [targetId]: nextWindow.messages
      },
      hasMore: {
        ...s.hasMore,
        [targetId]: (s.hasMore[targetId] ?? false) || nextWindow.trimmedOlder
      }
    }
  })
}

function updateOptimisticMessageState(
  targetId: string,
  clientNonce: string,
  deliveryState: 'sending' | 'sent' | 'failed',
  set: (fn: (s: MessageState) => Partial<MessageState>) => void
): void {
  set((s) => ({
    messagesByChannel: {
      ...s.messagesByChannel,
      [targetId]: (s.messagesByChannel[targetId] ?? []).map((message) =>
        message.client_nonce === clientNonce
          ? { ...message, delivery_state: deliveryState }
          : message
      )
    }
  }))
}

function mergeIncomingMessage(
  targetId: string,
  incoming: Message,
  set: (fn: (s: MessageState) => Partial<MessageState>) => void
): void {
  set((s) => {
    const existing = s.messagesByChannel[targetId] ?? []
    const optimisticIndex = incoming.client_nonce
      ? existing.findIndex((message) => message.client_nonce === incoming.client_nonce)
      : -1

    if (optimisticIndex !== -1) {
      const updated = [...existing]
      updated[optimisticIndex] = {
        ...incoming,
        delivery_state: 'sent'
      }
      const nextWindow = applyMessageWindow(updated, 'append')
      return {
        messagesByChannel: {
          ...s.messagesByChannel,
          [targetId]: nextWindow.messages
        },
        latestRoomSeqByScope: updateLatestRoomSeqByScope(
          s.latestRoomSeqByScope,
          targetId,
          getMaxRoomSeq(nextWindow.messages),
          incoming.room_seq
        ),
        hasMore: {
          ...s.hasMore,
          [targetId]: (s.hasMore[targetId] ?? false) || nextWindow.trimmedOlder
        }
      }
    }

    if (existing.some((message) => message.id === incoming.id)) {
      return {
        latestRoomSeqByScope: updateLatestRoomSeqByScope(
          s.latestRoomSeqByScope,
          targetId,
          incoming.room_seq
        )
      }
    }

    const nextWindow = applyMessageWindow([...existing, incoming], 'append')

    return {
      messagesByChannel: {
        ...s.messagesByChannel,
        [targetId]: nextWindow.messages
      },
      latestRoomSeqByScope: updateLatestRoomSeqByScope(
        s.latestRoomSeqByScope,
        targetId,
        getMaxRoomSeq(nextWindow.messages),
        incoming.room_seq
      ),
      hasMore: {
        ...s.hasMore,
        [targetId]: (s.hasMore[targetId] ?? false) || nextWindow.trimmedOlder
      }
    }
  })
}

function syncDmConversationActivity(message: Message): void {
  if (!message.conversation_id) {
    return
  }

  useDmStore.getState().applyConversationActivity({
    conversationId: message.conversation_id,
    messageId: message.id,
    senderId: message.sender_id,
    sender: message.sender
      ? {
          id: message.sender.id,
          username: message.sender.username
        }
      : null,
    insertedAt: message.inserted_at
  })
}

function syncChannelActivity(message: Message): void {
  if (!message.channel_id) {
    return
  }

  useServerStore.getState().applyChannelActivity({
    channelId: message.channel_id,
    messageId: message.id,
    insertedAt: message.inserted_at,
    senderId: message.sender_id,
    sender: message.sender
      ? {
          id: message.sender.id,
          username: message.sender.username,
          display_name: message.sender.display_name,
          avatar_url: message.sender.avatar_url
        }
      : null
  })
}

function scheduleIncomingMessageSideEffects(targetId: string, message: Message): void {
  if (message.expires_at) {
    scheduleMessageExpiry(targetId, message.id, message.expires_at)
  }

  if (message.sender_id && message.sender) {
    useServerStore.getState().updateMemberUser(message.sender_id, {
      display_name: message.sender.display_name,
      username: message.sender.username
    })
  }
}

function maybeRecoverIncomingMessageScope(
  targetId: string,
  message: Message,
  msg: Record<string, unknown>
): void {
  const myId = useAuthStore.getState().user?.id

  if (
    !useAuthStore.getState().canUseE2EE ||
    !message.encrypted ||
    !message.decryptionFailed ||
    message.sender_id === myId
  ) {
    return
  }

  const topic = message.channel_id
    ? `chat:channel:${message.channel_id}`
    : message.conversation_id
      ? `dm:${message.conversation_id}`
      : null
  const scopeId = message.channel_id ?? message.conversation_id ?? null
  const lastKnownEpoch = (msg.mls_epoch as number | null | undefined) ?? null

  if (topic && scopeId) {
    useMessageStore.setState((s) => ({
      scopeLifecycleById: {
        ...s.scopeLifecycleById,
        [scopeId]: {
          kind: message.channel_id ? 'channel' : 'dm',
          state: 'stale',
          lastVisitedAt: s.scopeLifecycleById[scopeId]?.lastVisitedAt ?? Date.now()
        }
      }
    }))
    void recoverEncryptedScope(
      {
        kind: message.channel_id ? 'channel' : 'dm',
        targetId,
        scopeId,
        topic
      },
      useMessageStore.getState,
      lastKnownEpoch,
      'decrypt_failed'
    ).catch(() => {})
  } else if (topic) {
    maybeRequestMlsJoin(targetId, topic)
  }
}

function applyProcessedIncomingMessage(
  targetId: string,
  message: Message,
  msg: Record<string, unknown>,
  set: (fn: (s: MessageState) => Partial<MessageState>) => void
): void {
  scheduleIncomingMessageSideEffects(targetId, message)
  maybeRecoverIncomingMessageScope(targetId, message, msg)
  syncChannelActivity(message)
  syncDmConversationActivity(message)
  mergeIncomingMessage(targetId, { ...message, delivery_state: 'sent' }, set)
}

/**
 * Handle a new real-time message (from WebSocket broadcast).
 */
async function handleNewMessage(
  targetId: string,
  msg: Record<string, unknown>,
  set: (fn: (s: MessageState) => Partial<MessageState>) => void
): Promise<void> {
  const processed = await processIncomingMessage(targetId, msg, undefined, 'urgent')
  applyProcessedIncomingMessage(targetId, processed, msg, set)
  maybeShowDesktopNotification(processed)
}

async function processIncomingMessageBatch(
  targetId: string,
  rawMessages: Record<string, unknown>[],
  decryptPriority: 'urgent' | 'normal' | 'background' = 'background'
): Promise<Message[]> {
  const resolvedPlaintexts = new Array<string | null | undefined>(rawMessages.length)
  const ciphertextsToDecrypt: string[] = []
  const ciphertextIndexes: number[] = []

  for (const [index, message] of rawMessages.entries()) {
    if (!message.ciphertext) {
      continue
    }

    const messageId = message.id as string
    const ciphertextB64 = message.ciphertext as string
    const cachedPlaintext =
      getCachedDecryption(messageId) ??
      (await getStoredSentMessage(ciphertextB64)) ??
      (await loadCachedMessageDecryption(messageId))

    if (cachedPlaintext !== null) {
      resolvedPlaintexts[index] = cachedPlaintext
      continue
    }

    resolvedPlaintexts[index] = null
    ciphertextsToDecrypt.push(ciphertextB64)
    ciphertextIndexes.push(index)
  }

  if (ciphertextsToDecrypt.length > 0 && useAuthStore.getState().canUseE2EE) {
    const decryptedBatch = await useCryptoStore
      .getState()
      .decryptBatchForChannel(targetId, ciphertextsToDecrypt, decryptPriority)

    decryptedBatch.forEach((plaintext, batchIndex) => {
      const messageIndex = ciphertextIndexes[batchIndex]
      resolvedPlaintexts[messageIndex] = plaintext
    })
  }

  return Promise.all(
    rawMessages.map((message, index) =>
      processIncomingMessage(targetId, message, resolvedPlaintexts[index], decryptPriority)
    )
  )
}

/**
 * Process an incoming message — decrypt if encrypted, pass through if plaintext.
 */
async function processIncomingMessage(
  targetId: string,
  msg: Record<string, unknown>,
  resolvedPlaintext?: string | null,
  decryptPriority: 'urgent' | 'normal' | 'background' = 'normal'
): Promise<Message> {
  if (msg.ciphertext) {
    const messageId = msg.id as string
    const ciphertextB64 = msg.ciphertext as string
    const senderId = (msg.sender_id as string) || null
    const mlsEpoch = (msg.mls_epoch as number) ?? null
    const plaintext =
      resolvedPlaintext !== undefined
        ? resolvedPlaintext
        : (getCachedDecryption(messageId) ??
            (await getStoredSentMessage(ciphertextB64)) ??
            (await loadCachedMessageDecryption(messageId)) ??
            (useAuthStore.getState().canUseE2EE
              ? await useCryptoStore
                  .getState()
                  .decryptForChannel(targetId, ciphertextB64, decryptPriority)
              : null))

    if (plaintext) {
      setCachedDecryption(messageId, plaintext)
    }

    try {
      await cacheMessageToDb({
        id: messageId,
        channelId: (msg.channel_id as string) || null,
        conversationId: (msg.conversation_id as string) || null,
        serverId: (msg.server_id as string) || null,
        senderId,
        senderUsername: (msg.sender as MessageSender)?.username ?? null,
        ciphertext: base64ToUint8(ciphertextB64),
        decryptedContent: plaintext,
        mlsEpoch,
        insertedAt: msg.inserted_at as string
      })
    } catch {
      // Keep rendering even if the local ciphertext cache write fails.
    }

    let displayContent = canUseEncryptedFeatures()
      ? ENCRYPTED_MESSAGE_SYNCING_PLACEHOLDER
      : ENCRYPTED_MESSAGE_APPROVAL_PLACEHOLDER
    let searchableText = ''
    if (plaintext) {
      const payload = decodePayload(plaintext)
      if (payload.type === 'text') {
        displayContent = payload.text
        searchableText = payload.text
      } else {
        displayContent = JSON.stringify({
          type: payload.type,
          text: payload.text,
          file: payload.file
        })
        searchableText = [payload.text || '', payload.file.name].filter(Boolean).join(' ')
      }
    }

    if (searchableText) {
      indexToFts(messageId, targetId, searchableText).catch(() => {})
    }

    return {
      id: messageId,
      room_seq: getRoomSeq(msg.room_seq),
      content: displayContent,
      channel_id: (msg.channel_id as string) || null,
      conversation_id: (msg.conversation_id as string) || null,
      server_id: (msg.server_id as string) || null,
      sender_id: senderId,
      sender: (msg.sender as MessageSender) || null,
      inserted_at: msg.inserted_at as string,
      expires_at: (msg.expires_at as string) || null,
      parent_message_id: (msg.parent_message_id as string) || null,
      attachments: (msg.attachments as Attachment[] | undefined) ?? [],
      reactions: await resolveReactionGroups(targetId, msg.reactions as RawReaction[] | undefined),
      encrypted: true,
      decryptionFailed: !plaintext,
      edited_at: (msg.edited_at as string) || undefined,
      client_nonce: (msg.client_nonce as string) || undefined,
      delivery_state: 'sent'
    }
  }

  const plaintextMessage: Message = {
    id: msg.id as string,
    room_seq: getRoomSeq(msg.room_seq),
    content: msg.content as string,
    channel_id: (msg.channel_id as string) || null,
    conversation_id: (msg.conversation_id as string) || null,
    server_id: (msg.server_id as string) || null,
    sender_id: (msg.sender_id as string) || null,
    sender: (msg.sender as MessageSender) || null,
    inserted_at: msg.inserted_at as string,
    expires_at: (msg.expires_at as string) || null,
    parent_message_id: (msg.parent_message_id as string) || null,
    attachments: (msg.attachments as Attachment[] | undefined) ?? [],
    reactions: await resolveReactionGroups(targetId, msg.reactions as RawReaction[] | undefined),
    edited_at: (msg.edited_at as string) || undefined,
    client_nonce: (msg.client_nonce as string) || undefined,
    delivery_state: 'sent'
  }

  const plaintextSearchText = getMessageSearchText(plaintextMessage)
  if (plaintextSearchText) {
    indexToFts(plaintextMessage.id, targetId, plaintextSearchText).catch(() => {})
  }

  try {
    await cacheMessageToDb({
      id: plaintextMessage.id,
      channelId: plaintextMessage.channel_id,
      conversationId: plaintextMessage.conversation_id,
      serverId: plaintextMessage.server_id ?? null,
      senderId: plaintextMessage.sender_id,
      senderUsername: plaintextMessage.sender?.username ?? null,
      ciphertext: null,
      decryptedContent: plaintextMessage.content,
      mlsEpoch: null,
      insertedAt: plaintextMessage.inserted_at
    })
  } catch {
    // Metadata cache failure should not block message rendering.
  }

  return plaintextMessage
}

function buildProvisionalMessage(msg: Record<string, unknown>): Message {
  const isEncrypted = Boolean(msg.ciphertext)

  return {
    id: msg.id as string,
    room_seq: getRoomSeq(msg.room_seq),
    content: isEncrypted
      ? (canUseEncryptedFeatures()
          ? ENCRYPTED_MESSAGE_SYNCING_PLACEHOLDER
          : ENCRYPTED_MESSAGE_APPROVAL_PLACEHOLDER)
      : ((msg.content as string) ?? ''),
    channel_id: (msg.channel_id as string) || null,
    conversation_id: (msg.conversation_id as string) || null,
    server_id: (msg.server_id as string) || null,
    sender_id: (msg.sender_id as string) || null,
    sender: (msg.sender as MessageSender) || null,
    inserted_at: msg.inserted_at as string,
    expires_at: (msg.expires_at as string) || null,
    parent_message_id: (msg.parent_message_id as string) || null,
    attachments: (msg.attachments as Attachment[] | undefined) ?? [],
    reactions: [],
    encrypted: isEncrypted,
    decryptionFailed: false,
    edited_at: (msg.edited_at as string) || undefined,
    client_nonce: (msg.client_nonce as string) || undefined,
    delivery_state: 'sent'
  }
}

// Per-group lock to serialize MLS join requests — concurrent commits cause epoch conflicts
const mlsJoinLocks = new Map<string, Promise<void>>()

/**
 * Send a history bundle to a new device of the same user.
 * Re-encrypts message plaintext at the current epoch so the new device
 * can decrypt messages sent before it joined the MLS group.
 */
async function sendHistoryBundle(
  targetId: string,
  topic: string,
  recipientId: string,
  recipientDeviceId: string,
  pendingRequestId?: string
): Promise<void> {
  const messages = useMessageStore.getState().messagesByChannel[targetId] || []
  const cachedMessages = await loadCachedMessages(targetId).catch(() => [])
  const liveMessagesById = new Map(messages.map((message) => [message.id, message]))
  const items: Array<{
    id: string
    content: string
    channelId: string | null
    conversationId: string | null
    serverId: string | null
    senderId: string | null
    sender: MessageSender | null
    insertedAt: string
    expiresAt: string | null
    parentMessageId: string | null
  }> = []

  const bundledIds = new Set<string>()
  const cachedCandidates = [...cachedMessages].sort((left, right) =>
    left.insertedAt.localeCompare(right.insertedAt)
  )

  for (const cachedMessage of cachedCandidates) {
    if (bundledIds.has(cachedMessage.id)) {
      continue
    }

    const liveMessage = liveMessagesById.get(cachedMessage.id)
    const liveContent = liveMessage?.content

    let content =
      liveContent &&
      liveContent !== ENCRYPTED_MESSAGE_SYNCING_PLACEHOLDER &&
      liveContent !== ENCRYPTED_MESSAGE_UNAVAILABLE_PLACEHOLDER &&
      liveContent !== ENCRYPTED_MESSAGE_APPROVAL_PLACEHOLDER &&
      !liveMessage?.decryptionFailed
        ? liveContent
        : (cachedMessage.decryptedContent ??
            getCachedDecryption(cachedMessage.id) ??
            (cachedMessage.ciphertext
              ? await getStoredSentMessage(uint8ToBase64(cachedMessage.ciphertext))
              : undefined) ??
            (cachedMessage.ciphertext
              ? await loadCachedMessageDecryption(cachedMessage.id)
              : null) ??
            (cachedMessage.ciphertext && useAuthStore.getState().canUseE2EE
              ? await useCryptoStore
                  .getState()
                  .decryptForChannel(targetId, uint8ToBase64(cachedMessage.ciphertext))
              : null))

    if (!content) {
      continue
    }

    if (
      content === ENCRYPTED_MESSAGE_SYNCING_PLACEHOLDER ||
      content === ENCRYPTED_MESSAGE_UNAVAILABLE_PLACEHOLDER ||
      content === ENCRYPTED_MESSAGE_APPROVAL_PLACEHOLDER
    ) {
      continue
    }

    items.push({
      id: cachedMessage.id,
      content,
      channelId: cachedMessage.channelId,
      conversationId: cachedMessage.conversationId,
      serverId: cachedMessage.serverId ?? null,
      senderId: cachedMessage.senderId,
      sender:
        liveMessage?.sender ??
        (cachedMessage.senderId && cachedMessage.senderUsername
          ? {
              id: cachedMessage.senderId,
              username: cachedMessage.senderUsername,
              display_name: null,
              avatar_url: null
            }
          : null),
      insertedAt: cachedMessage.insertedAt,
      expiresAt: liveMessage?.expires_at ?? null,
      parentMessageId: liveMessage?.parent_message_id ?? null
    })
    bundledIds.add(cachedMessage.id)
  }

  for (const msg of messages) {
    if (bundledIds.has(msg.id)) continue
    if (!msg.content || msg.decryptionFailed) continue
    if (msg.content === ENCRYPTED_MESSAGE_SYNCING_PLACEHOLDER) continue
    if (msg.content === ENCRYPTED_MESSAGE_UNAVAILABLE_PLACEHOLDER) continue
    if (msg.content === ENCRYPTED_MESSAGE_APPROVAL_PLACEHOLDER) continue
    items.push({
      id: msg.id,
      content: msg.content,
      channelId: msg.channel_id,
      conversationId: msg.conversation_id,
      serverId: msg.server_id ?? null,
      senderId: msg.sender_id,
      sender: msg.sender ?? null,
      insertedAt: msg.inserted_at,
      expiresAt: msg.expires_at,
      parentMessageId: msg.parent_message_id
    })
    bundledIds.add(msg.id)
  }

  if (items.length === 0) return

  const bundlePayload = encodePayload({
    v: 1,
    type: 'text',
    text: JSON.stringify(items)
  })

  const crypto = useCryptoStore.getState()
  const encrypted = await crypto.encryptForChannel(targetId, bundlePayload)
  if (!encrypted) return

  const pushed = await pushToChannelWithAck(topic, 'mls_history_bundle', {
    ciphertext: encrypted.ciphertext,
    mls_epoch: encrypted.epoch,
    recipient_id: recipientId,
    recipient_device_id: recipientDeviceId
  })

  if (pushed && pendingRequestId) {
    await ackPendingHistoryRequest(pendingRequestId).catch(() => {})
  }
}

/**
 * Process a history bundle from another device of the same user.
 * Decrypts the bundle and replaces "unavailable" messages with actual content.
 */
async function processHistoryBundle(
  targetId: string,
  msg: Record<string, unknown>,
  set: (fn: (s: MessageState) => Partial<MessageState>) => void
): Promise<void> {
  const crypto = useCryptoStore.getState()
  const decrypted = await crypto.decryptForChannel(targetId, msg.ciphertext as string)
  if (!decrypted) return

  const payload = decodePayload(decrypted)
  if (payload.type !== 'text' || !payload.text) return

  let items: Array<{
    id: string
    content: string
    channelId?: string | null
    conversationId?: string | null
    serverId?: string | null
    senderId?: string | null
    sender?: MessageSender | null
    insertedAt?: string
    expiresAt?: string | null
    parentMessageId?: string | null
  }>
  try {
    items = JSON.parse(payload.text)
  } catch {
    return
  }

  if (!Array.isArray(items) || items.length === 0) return

  clearHistorySyncRetry(targetId)

  const contentMap = new Map<string, string>()
  const missingMessages = new Map<string, Message>()
  for (const item of items) {
    if (item.id && item.content) {
      contentMap.set(item.id, item.content)
      setCachedDecryption(item.id, item.content)
      void saveCachedMessageDecryption(item.id, item.content).catch(() => {})
      void indexToFts(item.id, targetId, item.content).catch(() => {})
      missingMessages.set(item.id, {
        id: item.id,
        content: item.content,
        channel_id: item.channelId ?? null,
        conversation_id: item.conversationId ?? null,
        server_id: item.serverId ?? null,
        sender_id: item.senderId ?? null,
        sender: item.sender ?? null,
        inserted_at: item.insertedAt ?? new Date().toISOString(),
        expires_at: item.expiresAt ?? null,
        parent_message_id: item.parentMessageId ?? null,
        attachments: [],
        reactions: [],
        encrypted: true,
        decryptionFailed: false
      })
    }
  }

  set((s) => {
    const existingMessages = s.messagesByChannel[targetId] ?? []
    const existingIds = new Set(existingMessages.map((message) => message.id))

    const updated = existingMessages.map((m) => {
      const content = contentMap.get(m.id)
      if (!content) return m
      if (!canReplacePlaceholderFromHistoryBundle(m)) return m
      return { ...m, content, decryptionFailed: false, encrypted: true }
    })

    for (const [messageId, bundledMessage] of missingMessages.entries()) {
      if (!existingIds.has(messageId)) {
        updated.push(bundledMessage)
      }
    }

    updated.sort((a, b) => a.inserted_at.localeCompare(b.inserted_at))
    const windowed = applyMessageWindow(updated, 'append')

      return {
        messagesByChannel: { ...s.messagesByChannel, [targetId]: windowed.messages },
        latestRoomSeqByScope: updateLatestRoomSeqByScope(
          s.latestRoomSeqByScope,
          targetId,
          getMaxRoomSeq(windowed.messages)
        ),
        hasMore: {
          ...s.hasMore,
          [targetId]: (s.hasMore[targetId] ?? false) || windowed.trimmedOlder
      },
      hasNewer: {
        ...s.hasNewer,
        [targetId]: (s.hasNewer[targetId] ?? false) || windowed.trimmedNewer
      }
    }
  })

  for (const bundledMessage of missingMessages.values()) {
    syncChannelActivity(bundledMessage)
    syncDmConversationActivity(bundledMessage)
  }

  const bundleId = typeof msg.id === 'string' ? msg.id : null
  if (bundleId) {
    await ackPendingHistoryBundle(bundleId).catch(() => {})
  }
}

/**
 * Handle an MLS join request from another user.
 */
async function handleMlsJoinRequest(
  targetId: string,
  msg: Record<string, unknown>,
  topic: string
): Promise<void> {
  const userId = msg.user_id as string
  const username = (msg.username as string | undefined) ?? undefined
  const deviceId = (msg.device_id as string | undefined) ?? undefined
  const localUserId = useAuthStore.getState().user?.id
  rememberMlsJoinDeviceId(topic, userId, deviceId)
  const crypto = useCryptoStore.getState()

  if (!crypto.hasGroup(targetId)) return

  // Serialize join requests per group to avoid concurrent epoch commits
  const prev = mlsJoinLocks.get(targetId) ?? Promise.resolve()
  const current = prev.then(async () => {
    const crypto = useCryptoStore.getState()
    const result = await crypto.handleJoinRequest(targetId, userId, username, deviceId)

    if (result) {
      pushToChannel(topic, 'mls_commit', { commit_data: result.commitBytes })
      if (result.welcomeBytes) {
        pushToChannel(topic, 'mls_welcome', {
          recipient_id: userId,
          recipient_device_id: deviceId,
          welcome_data: result.welcomeBytes,
          key_package_ref: result.keyPackageRef
        })

        if (deviceId && localUserId === userId) {
          void sendHistoryBundle(targetId, topic, userId, deviceId).catch(() => {})
        }
      }
    }
  }).catch(() => {})
  mlsJoinLocks.set(targetId, current)
  await current
}

/**
 * Handle a message_edited event — decrypt if encrypted, update local state.
 */
async function handleMessageEdited(
  targetId: string,
  msg: Record<string, unknown>,
  set: (fn: (s: MessageState) => Partial<MessageState>) => void
): Promise<void> {
  const messageId = msg.message_id as string
  const editedAt = msg.edited_at as string
  const roomSeq = getRoomSeq(msg.room_seq)

  let newContent: string | undefined
  if (msg.ciphertext) {
    const ciphertextB64 = msg.ciphertext as string
    const plaintext =
      (await getStoredSentMessage(ciphertextB64)) ??
      (await useCryptoStore.getState().decryptForChannel(targetId, ciphertextB64))

    if (plaintext) {
      setCachedDecryption(messageId, plaintext)
      await saveCachedMessageDecryption(messageId, plaintext).catch(() => {})
      const payload = decodePayload(plaintext)
      if (payload.type === 'text') {
        newContent = payload.text
        indexToFts(messageId, targetId, payload.text).catch(() => {})
      } else {
        newContent = JSON.stringify({
          type: payload.type,
          text: payload.text,
          file: payload.file
        })
        const fileSearchText = [payload.text || '', payload.file.name].filter(Boolean).join(' ')
        if (fileSearchText) {
          indexToFts(messageId, targetId, fileSearchText).catch(() => {})
        }
      }
    } else {
      newContent = canUseEncryptedFeatures()
        ? ENCRYPTED_MESSAGE_SYNCING_PLACEHOLDER
        : ENCRYPTED_MESSAGE_APPROVAL_PLACEHOLDER
      if (canUseEncryptedFeatures()) {
        maybeRecoverEncryptedScope(
          {
            kind: typeof msg.channel_id === 'string' ? 'channel' : 'dm',
            targetId,
            scopeId: targetId,
            topic:
              typeof msg.channel_id === 'string'
                ? `chat:channel:${targetId}`
                : `dm:${targetId}`
          },
          useMessageStore.getState,
          (msg.mls_epoch as number | null | undefined) ?? null,
          'edited_message_decrypt_failed'
        )
      }
    }
  } else if (msg.content) {
    newContent = msg.content as string
  }

  set((s) => {
    const messages = s.messagesByChannel[targetId] || []
    const updated = messages.map((m) => {
      if (m.id !== messageId) return m
      return {
        ...m,
        ...(newContent !== undefined ? { content: newContent } : {}),
        edited_at: editedAt
      }
    })
    const threadPatch = patchThreadStateForMessage(s, messageId, (message) => ({
      ...message,
      ...(newContent !== undefined ? { content: newContent } : {}),
      edited_at: editedAt
    }))
    return {
      messagesByChannel: { ...s.messagesByChannel, [targetId]: updated },
      latestRoomSeqByScope: updateLatestRoomSeqByScope(
        s.latestRoomSeqByScope,
        targetId,
        roomSeq
      ),
      ...threadPatch
    }
  })
}

/**
 * Handle a message_deleted event — remove message from local state.
 */
function handleMessageDeleted(
  targetId: string,
  msg: Record<string, unknown>,
  set: (fn: (s: MessageState) => Partial<MessageState>) => void
): void {
  const messageId = msg.message_id as string
  const roomSeq = getRoomSeq(msg.room_seq)
  const latestMessage = Object.prototype.hasOwnProperty.call(msg, 'latest_message')
    ? (msg.latest_message as
        | {
            id: string
            inserted_at: string
            sender_id: string | null
            sender?: {
              id: string
              username: string
              display_name?: string | null
              avatar_url?: string | null
            } | null
            ciphertext?: string
            content?: string
          }
        | null)
    : undefined

  removeCachedDecryption(messageId)
  removeFromFtsIndex(messageId).catch(() => {})

  set((s) => ({
    messagesByChannel: {
      ...s.messagesByChannel,
      [targetId]: (s.messagesByChannel[targetId] || []).filter((m) => m.id !== messageId)
    },
    latestRoomSeqByScope: updateLatestRoomSeqByScope(
      s.latestRoomSeqByScope,
      targetId,
      roomSeq
    ),
    pinnedByChannel: {
      ...s.pinnedByChannel,
      [targetId]: (s.pinnedByChannel[targetId] || []).filter((pin) => pin.message.id !== messageId)
    },
    ...patchThreadStateForMessage(s, messageId, () => null)
  }))

  if (typeof msg.conversation_id === 'string' && latestMessage !== undefined) {
    useDmStore.getState().syncConversationLastMessage({
      conversationId: msg.conversation_id,
      lastMessage: latestMessage
        ? {
            id: latestMessage.id,
            content: latestMessage.content,
            ciphertext: latestMessage.ciphertext,
            sender_id: latestMessage.sender_id,
            sender: latestMessage.sender
              ? {
                  id: latestMessage.sender.id,
                  username: latestMessage.sender.username
                }
              : null,
            inserted_at: latestMessage.inserted_at
          }
        : null
    })
  }

  if (typeof msg.channel_id === 'string' && latestMessage !== undefined) {
    useServerStore.getState().syncChannelLastMessage({
      channelId: msg.channel_id,
      lastMessage: latestMessage
        ? {
            id: latestMessage.id,
            inserted_at: latestMessage.inserted_at,
            sender_id: latestMessage.sender_id,
            sender: latestMessage.sender ?? null
          }
        : null
    })
  }
}

function emitPinUpdate(channelId: string): void {
  if (typeof window === 'undefined') {
    return
  }

  window.dispatchEvent(new CustomEvent('pin-update', { detail: { channelId } }))
}

function handlePinBroadcast(
  channelId: string,
  msg: Record<string, unknown>,
  set: (fn: (s: MessageState) => Partial<MessageState>) => void,
  action: 'pin' | 'unpin'
): void {
  const messageId = msg.message_id as string | undefined
  const roomSeq = getRoomSeq(msg.room_seq)

  if (action === 'unpin' && messageId) {
    set((s) => ({
      latestRoomSeqByScope: updateLatestRoomSeqByScope(
        s.latestRoomSeqByScope,
        channelId,
        roomSeq
      ),
      pinnedByChannel: {
        ...s.pinnedByChannel,
        [channelId]: (s.pinnedByChannel[channelId] || []).filter((pin) => pin.message.id !== messageId)
      }
    }))
  } else if (roomSeq != null) {
    set((s) => ({
      latestRoomSeqByScope: updateLatestRoomSeqByScope(
        s.latestRoomSeqByScope,
        channelId,
        roomSeq
      )
    }))
  }

  emitPinUpdate(channelId)
}

async function applyScopeSyncEvent(
  targetId: string,
  syncEvent: {
    room_seq?: number | null
    event_type: string
    payload?: Record<string, unknown>
  },
  set: (fn: (s: MessageState) => Partial<MessageState>) => void
): Promise<void> {
  const roomSeq = getRoomSeq(syncEvent.room_seq)
  const payload =
    roomSeq == null
      ? syncEvent.payload ?? {}
      : { ...(syncEvent.payload ?? {}), room_seq: roomSeq }

  if (roomSeq != null) {
    set((s) => ({
      latestRoomSeqByScope: updateLatestRoomSeqByScope(
        s.latestRoomSeqByScope,
        targetId,
        roomSeq
      )
    }))
  }

  if (syncEvent.event_type === 'reaction_update') {
    await handleReactionUpdate(targetId, payload, set)
    return
  }

  if (syncEvent.event_type === 'message_edited') {
    await handleMessageEdited(targetId, payload, set)
    return
  }

  if (syncEvent.event_type === 'message_deleted') {
    handleMessageDeleted(targetId, payload, set)
    return
  }

  if (syncEvent.event_type === 'message_pinned') {
    handlePinBroadcast(targetId, payload, set, 'pin')
    return
  }

  if (syncEvent.event_type === 'message_unpinned') {
    handlePinBroadcast(targetId, payload, set, 'unpin')
  }
}
