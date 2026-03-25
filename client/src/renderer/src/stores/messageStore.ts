import { create } from 'zustand'
import { getStoredValue } from '../utils/localStorage'
import { type EncryptedScopeWatchEvent, type ProcessedScopeMessage } from '@vesper/sdk/client'
import {
  base64ToUint8,
  uint8ToBase64,
  type VesperMessage
} from '@vesper/sdk/api'
import { getLocalDeviceIdentity } from '@vesper/sdk/auth'
import {
  decodePayload,
  encodePayload,
  getCachedDecryption,
  getSentMessage,
  getStoredSentMessage,
  removeCachedDecryption,
  setCachedDecryption
} from '@vesper/sdk/crypto'
import { useAuthStore } from './authStore'
import { useVoiceStore } from './voiceStore'
import { useServerStore } from './serverStore'
import { useDmStore } from './dmStore'
import { queueScopeMutationHint, usePresenceStore } from './presenceStore'
import {
  getRendererClient,
  getRendererEncryptedChat,
  getRendererStorageRuntime
} from '../sdk/client'
import { replaceEmojiShortcodes } from '../utils/emoji'
import { fireAndForget } from '../utils/async'

function pushToChannel(topic: string, event: string, payload: object): void {
  getRendererClient().pushTopicEvent(topic, event, payload)
}

function getStorageRuntime() {
  return getRendererStorageRuntime()
}

const MLS_JOIN_REQUEST_COOLDOWN_MS = 2000
const recentMlsJoinRequests = new Map<string, number>()
const MLS_RECOVERY_BACKOFF_MS = [150, 500, 1500] as const
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
const threadReplyRefreshTokens = new Map<string, number>()
const warmDmScopeTopics = new Set<string>()
const recentNotifiedMessageIds = new Map<string, number>()
const recentMutationSeqsByScope = new Map<string, number[]>()
const inFlightScopeMessageFetches = new Map<string, Promise<void>>()
const inFlightOlderScopeMessageFetches = new Set<string>()
const inFlightNewerScopeMessageFetches = new Set<string>()
const liveScopeWatchDisposers = new Map<string, () => void>()
const liveScopeWatchTokens = new Map<string, symbol>()
const RECENT_NOTIFICATION_TTL_MS = 30_000
const RECENT_MUTATION_SEQ_WINDOW = 256
const MESSAGE_PAGE_SIZE = 50
const MAX_RESIDENT_MESSAGES_PER_SCOPE = 400
const MAX_WARM_SCOPES = 3

// Mapping from DM conversation_id to backing channel_id for unified MLS path.
// Stored on window to survive HMR module reloads.
function getDmChannelMappings(): Map<string, string> {
  const w = window as Record<string, unknown>
  if (!w.__vesperDmChannelMappings) {
    w.__vesperDmChannelMappings = new Map<string, string>()
  }
  return w.__vesperDmChannelMappings as Map<string, string>
}

export function registerDmChannelMapping(conversationId: string, channelId: string): void {
  getDmChannelMappings().set(conversationId, channelId)
}

// Resolve the backing channel_id for a DM conversation.
function resolveDmChannelId(conversationId: string): string | null {
  const cached = getDmChannelMappings().get(conversationId)
  if (cached) return cached

  // Fall back to the SDK client state (populated by sync)
  try {
    const sdkConversation = getRendererClient().getState().conversations.find(
      (c: { id: string; channel_id?: string | null }) => c.id === conversationId
    )
    if (sdkConversation?.channel_id) {
      getDmChannelMappings().set(conversationId, sdkConversation.channel_id)
      return sdkConversation.channel_id
    }
  } catch {
    // SDK not initialized yet
  }

  return null
}

type ScopeKind = 'channel' | 'dm'
type ScopeLifecycleState = 'cold' | 'loading' | 'warm' | 'active' | 'stale'

interface ScopeLifecycleEntry {
  kind: ScopeKind
  state: ScopeLifecycleState
  lastVisitedAt: number
}

interface SyncRecentScopesOptions {
  scopeIds?: string[] | null
}

function releaseLiveScopeWatch(topic: string): void {
  liveScopeWatchTokens.delete(topic)
  liveScopeWatchDisposers.get(topic)?.()
  liveScopeWatchDisposers.delete(topic)
  liveScopeReadyPromises.delete(topic)
}

function beginThreadReplyRefresh(parentMessageId: string): number {
  const nextToken = (threadReplyRefreshTokens.get(parentMessageId) ?? 0) + 1
  threadReplyRefreshTokens.set(parentMessageId, nextToken)
  return nextToken
}

function isCurrentThreadReplyRefresh(parentMessageId: string, token: number): boolean {
  return threadReplyRefreshTokens.get(parentMessageId) === token
}

function canReplacePlaceholderFromHistoryBundle(message: Message): boolean {
  return (
    message.decryptionFailed === true ||
    message.content === ENCRYPTED_MESSAGE_SYNCING_PLACEHOLDER ||
    message.content === ENCRYPTED_MESSAGE_UNAVAILABLE_PLACEHOLDER ||
    message.content === ENCRYPTED_MESSAGE_APPROVAL_PLACEHOLDER
  )
}

function mergeFetchedMessagesWithResidentState(
  fetchedMessages: Message[],
  residentMessages: Message[]
): Message[] {
  if (residentMessages.length === 0) {
    return fetchedMessages
  }

  const residentById = new Map(residentMessages.map((message) => [message.id, message]))

  return fetchedMessages.map((message) => {
    if (!canReplacePlaceholderFromHistoryBundle(message)) {
      return message
    }

    const resident = residentById.get(message.id)
    if (!resident || canReplacePlaceholderFromHistoryBundle(resident)) {
      return message
    }

    return {
      ...message,
      content: resident.content,
      decryptionFailed: resident.decryptionFailed,
      encrypted: resident.encrypted,
      sender: message.sender ?? resident.sender,
      attachments: (message.attachments?.length ?? 0) > 0 ? message.attachments : resident.attachments,
      reactions: (message.reactions?.length ?? 0) > 0 ? message.reactions : resident.reactions
    }
  })
}

function mergeResidentTailMessages(
  fetchedMessages: Message[],
  residentMessages: Message[]
): Message[] {
  if (residentMessages.length === 0) {
    return fetchedMessages
  }

  const fetchedIds = new Set(fetchedMessages.map((message) => message.id))
  const fetchedClientNonces = new Set(
    fetchedMessages
      .map((message) => message.client_nonce)
      .filter((clientNonce): clientNonce is string => Boolean(clientNonce))
  )
  const maxFetchedRoomSeq = getMaxRoomSeq(fetchedMessages)
  const carriedMessages = residentMessages.filter((message) => {
    if (fetchedIds.has(message.id)) {
      return false
    }

    if (message.client_nonce && fetchedClientNonces.has(message.client_nonce)) {
      return false
    }

    if (message.delivery_state === 'sending' || message.delivery_state === 'failed') {
      return true
    }

    return maxFetchedRoomSeq != null && message.room_seq != null && message.room_seq > maxFetchedRoomSeq
  })

  if (carriedMessages.length === 0) {
    return fetchedMessages
  }

  return [...fetchedMessages, ...carriedMessages]
}

function patchResidentMessagesById(
  residentMessages: Message[],
  resolvedMessages: Message[]
): Message[] {
  if (residentMessages.length === 0 || resolvedMessages.length === 0) {
    return residentMessages
  }

  const resolvedById = new Map(resolvedMessages.map((message) => [message.id, message]))
  const resolvedByClientNonce = new Map(
    resolvedMessages
      .map((message) => [message.client_nonce, message] as const)
      .filter(([clientNonce]) => Boolean(clientNonce))
  )
  let changed = false

  const patched = residentMessages.map((message) => {
    const resolved =
      resolvedById.get(message.id) ??
      (message.client_nonce ? resolvedByClientNonce.get(message.client_nonce) : undefined)
    if (!resolved) {
      return message
    }

    changed = true
    const preserveResolvedContent = !message.decryptionFailed && resolved.decryptionFailed
    return {
      ...message,
      ...resolved,
      content: preserveResolvedContent ? message.content : resolved.content,
      sender: resolved.sender ?? message.sender,
      attachments: resolved.attachments ?? message.attachments,
      reactions: resolved.reactions ?? message.reactions,
      encrypted: preserveResolvedContent ? message.encrypted : resolved.encrypted,
      decryptionFailed: preserveResolvedContent
        ? message.decryptionFailed
        : resolved.decryptionFailed,
      delivery_state: resolved.delivery_state ?? message.delivery_state
    }
  })

  return changed ? dedupeMessages(patched) : residentMessages
}

export async function pushToChannelWithAck(
  topic: string,
  event: string,
  payload: object
): Promise<boolean> {
  return await getRendererClient().pushTopicEventWithAck(topic, event, payload)
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

function hasSeenScopeMutationSeq(scopeId: string, roomSeq: number | null | undefined): boolean {
  if (roomSeq == null) {
    return false
  }

  const seenSeqs = recentMutationSeqsByScope.get(scopeId)
  return seenSeqs?.includes(roomSeq) ?? false
}

function rememberScopeMutationSeq(scopeId: string, roomSeq: number | null | undefined): void {
  if (roomSeq == null) {
    return
  }

  const existing = recentMutationSeqsByScope.get(scopeId) ?? []
  if (existing.includes(roomSeq)) {
    return
  }

  const next = [...existing, roomSeq]
  if (next.length > RECENT_MUTATION_SEQ_WINDOW) {
    next.splice(0, next.length - RECENT_MUTATION_SEQ_WINDOW)
  }

  recentMutationSeqsByScope.set(scopeId, next)
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

    getRendererClient().disconnectTopic(topic)
    warmDmScopeTopics.delete(topic)
  }

  for (const topic of desiredTopics) {
    if (warmDmScopeTopics.has(topic)) {
      continue
    }

    getRendererClient().subscribeTopic(topic, (event, payload) => {
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

interface CachedMessageRecord {
  id: string
  channelId: string | null
  conversationId: string | null
  serverId: string | null
  senderId: string | null
  senderUsername: string | null
  parentMessageId: string | null
  ciphertext: Uint8Array | null
  decryptedContent: string | null
  mlsEpoch: number | null
  insertedAt: string
}

function buildMessageFromCache(record: CachedMessageRecord): Message {
  const hasPlaintext =
    typeof record.decryptedContent === 'string' && record.decryptedContent.length > 0
  const content = hasPlaintext
    ? record.decryptedContent!
    : record.ciphertext
      ? (canUseEncryptedFeatures()
          ? ENCRYPTED_MESSAGE_SYNCING_PLACEHOLDER
          : ENCRYPTED_MESSAGE_APPROVAL_PLACEHOLDER)
      : ''

  return {
    id: record.id,
    room_seq: null,
    content,
    channel_id: record.channelId,
    conversation_id: record.conversationId,
    server_id: record.serverId,
    sender_id: record.senderId,
    sender: record.senderId && record.senderUsername
      ? {
          id: record.senderId,
          username: record.senderUsername,
          display_name: null,
          avatar_url: null
        }
      : null,
    inserted_at: record.insertedAt,
    expires_at: null,
    parent_message_id: record.parentMessageId,
    attachments: [],
    reactions: [],
    encrypted: Boolean(record.ciphertext),
    decryptionFailed: Boolean(record.ciphertext) && !hasPlaintext,
    delivery_state: 'sent'
  }
}

function normalizeMessageSender(
  sender: {
    id?: string | null
    username?: string | null
    display_name?: string | null
    avatar_url?: string | null
  } | null | undefined,
  senderId: string | null,
  senderUsername: string | null
): MessageSender | null {
  const resolvedId = sender?.id ?? senderId
  const resolvedUsername = sender?.username ?? senderUsername
  if (!resolvedId || !resolvedUsername) {
    return null
  }

  return {
    id: resolvedId,
    username: resolvedUsername,
    display_name: sender?.display_name ?? null,
    avatar_url: sender?.avatar_url ?? null
  }
}

async function buildMessageFromSdkProcessed(
  targetId: string,
  processed: ProcessedScopeMessage
): Promise<Message> {
  const raw = processed.raw as ProcessedScopeMessage['raw'] & {
    attachments?: Attachment[]
    reactions?: RawReaction[]
    expires_at?: string | null
    edited_at?: string | null
    client_nonce?: string | null
    server_id?: string | null
  }
  let content = processed.content

  if (!processed.decryptionFailed && processed.plaintext) {
    try {
      const payload = decodePayload(processed.plaintext)
      content = payload.type === 'text'
        ? payload.text
        : JSON.stringify({
            type: payload.type,
            text: payload.text,
            file: payload.file
          })
    } catch {
      content = processed.content
    }
  }

  return {
    id: processed.id,
    room_seq: getRoomSeq(raw.room_seq),
    content: processed.decryptionFailed
      ? (canUseEncryptedFeatures()
          ? ENCRYPTED_MESSAGE_SYNCING_PLACEHOLDER
          : ENCRYPTED_MESSAGE_APPROVAL_PLACEHOLDER)
      : content,
    channel_id: raw.channel_id ?? null,
    conversation_id: raw.conversation_id ?? null,
    server_id: raw.server_id ?? null,
    sender_id: raw.sender_id ?? null,
    sender: normalizeMessageSender(raw.sender, raw.sender_id ?? null, processed.senderUsername),
    inserted_at: raw.inserted_at,
    expires_at: raw.expires_at ?? null,
    parent_message_id: raw.parent_message_id ?? null,
    attachments: raw.attachments ?? [],
    reactions: await resolveReactionGroups(targetId, raw.reactions),
    encrypted: processed.encrypted,
    decryptionFailed: processed.decryptionFailed,
    mls_epoch: (raw.mls_epoch as number | null | undefined) ?? null,
    edited_at: raw.edited_at ?? undefined,
    client_nonce: raw.client_nonce ?? undefined,
    delivery_state: 'sent'
  }
}

async function loadScopeMessagesViaSdk(scope: {
  kind: 'channel' | 'dm'
  id: string
}): Promise<Message[]> {
  const synced = await getRendererEncryptedChat().syncScope(scope, {
    limit: MESSAGE_PAGE_SIZE
  })

  return await Promise.all(
    synced.messages.map((message) => buildMessageFromSdkProcessed(scope.id, message))
  )
}

async function loadScopeMessagesFromCache(scopeId: string): Promise<Message[]> {
  const cachedMessages = await getStorageRuntime().loadCachedMessages(scopeId).catch(() => [])
  if (cachedMessages.length === 0) {
    return []
  }

  return cachedMessages
    .map(buildMessageFromCache)
    .sort(
      (left, right) =>
        new Date(left.inserted_at).getTime() - new Date(right.inserted_at).getTime()
    )
}

function applySdkMessageUpdate(
  targetId: string,
  message: Message,
  set: (fn: (s: MessageState) => Partial<MessageState>) => void
): void {
  set((s) => {
    const mergeMessageUpdate = (current: Message): Message => {
      const preserveResolvedContent = !current.decryptionFailed && message.decryptionFailed
      return {
        ...current,
        ...message,
        content: preserveResolvedContent ? current.content : message.content,
        sender: message.sender ?? current.sender,
        attachments: message.attachments ?? current.attachments,
        reactions: message.reactions ?? current.reactions,
        encrypted: preserveResolvedContent ? current.encrypted : message.encrypted,
        decryptionFailed: preserveResolvedContent
          ? current.decryptionFailed
          : message.decryptionFailed
      }
    }

    const residentMessages = s.messagesByChannel[targetId] ?? []
    const patchedMessages = patchResidentMessagesById(residentMessages, [message])

    if (patchedMessages === residentMessages) {
      return {
        latestRoomSeqByScope: updateLatestRoomSeqByScope(
          s.latestRoomSeqByScope,
          targetId,
          message.room_seq
        ),
        ...patchThreadStateForMessage(s, message.id, mergeMessageUpdate)
      }
    }

    return {
      messagesByChannel: {
        ...s.messagesByChannel,
        [targetId]: patchedMessages
      },
      latestRoomSeqByScope: updateLatestRoomSeqByScope(
        s.latestRoomSeqByScope,
        targetId,
        getMaxRoomSeq(patchedMessages),
        message.room_seq
      ),
      ...patchThreadStateForMessage(s, message.id, mergeMessageUpdate)
    }
  })
}

async function handleSdkScopeEvent(
  scope: EncryptedScopeDescriptor,
  scopeEvent: EncryptedScopeWatchEvent,
  set: (fn: (s: MessageState) => Partial<MessageState>) => void
): Promise<void> {
  const payload = scopeEvent.payload ?? {}

  if (scopeEvent.event === 'new_message' && scopeEvent.message) {
    const processed = await buildMessageFromSdkProcessed(scope.scopeId, scopeEvent.message)
    applyProcessedIncomingMessage(scope.scopeId, processed, payload as unknown as VesperMessage, set)
    maybeShowDesktopNotification(processed)
    return
  }

  if (
    (scopeEvent.event === 'reaction_update' || scopeEvent.event === 'message_edited') &&
    scopeEvent.message
  ) {
    const processed = await buildMessageFromSdkProcessed(scope.scopeId, scopeEvent.message)
    applySdkMessageUpdate(scope.scopeId, processed, set)
    rememberScopeMutationSeq(scope.scopeId, getRoomSeq(payload.room_seq))
    return
  }

  if (scopeEvent.event === 'message_deleted') {
    handleMessageDeleted(scope.scopeId, payload, set)
    rememberScopeMutationSeq(scope.scopeId, getRoomSeq(payload.room_seq))
    return
  }

  if (scopeEvent.event === 'typing_start') {
    set((s) => {
      const current = s.typingUsers[scope.scopeId] || []
      const typing = payload as unknown as TypingUser
      if (current.some((entry) => entry.user_id === typing.user_id)) {
        return s
      }

      return {
        typingUsers: {
          ...s.typingUsers,
          [scope.scopeId]: [...current, typing]
        }
      }
    })
    return
  }

  if (scopeEvent.event === 'typing_stop') {
    set((s) => ({
      typingUsers: {
        ...s.typingUsers,
        [scope.scopeId]: (s.typingUsers[scope.scopeId] || []).filter(
          (entry) => entry.user_id !== (payload as { user_id?: string }).user_id
        )
      }
    }))
    return
  }

  if (scopeEvent.event === 'disappearing_ttl_updated') {
    if (scope.kind === 'channel') {
      useServerStore.getState().updateChannelTtl(
        payload.channel_id as string,
        payload.disappearing_ttl as number | null
      )
    } else {
      useDmStore.getState().updateConversationTtl(
        payload.conversation_id as string,
        payload.disappearing_ttl as number | null
      )
    }
    return
  }

  if (scopeEvent.event === 'message_pinned') {
    handlePinBroadcast(scope.scopeId, payload, set, 'pin')
    rememberScopeMutationSeq(scope.scopeId, getRoomSeq(payload.room_seq))
    return
  }

  if (scopeEvent.event === 'message_unpinned') {
    handlePinBroadcast(scope.scopeId, payload, set, 'unpin')
    rememberScopeMutationSeq(scope.scopeId, getRoomSeq(payload.room_seq))
    return
  }

  if (scopeEvent.event === 'mls_commit') {
    rememberScopeMutationSeq(scope.scopeId, getRoomSeq(payload.room_seq))
    if (scope.kind === 'channel') {
      void useMessageStore.getState().fetchMessages(scope.scopeId)
    } else {
      void useMessageStore.getState().fetchDmMessages(scope.scopeId)
    }
    return
  }

  if (scopeEvent.event === 'mls_welcome') {
    const recipientId = payload.recipient_id as string
    const recipientDeviceId =
      typeof payload.recipient_device_id === 'string' ? payload.recipient_device_id : null
    const currentUserId = useAuthStore.getState().user?.id
    if (
      recipientId === currentUserId &&
      (!recipientDeviceId || recipientDeviceId === getLocalDeviceIdentity().id)
    ) {
      recentWelcomeProcessed.set(scope.scopeId, Date.now())
      // Consume the flag so joinChannelChat's .finally block doesn't also
      // trigger handleWelcomeProcessedForScope, which marks messages as
      // permanently unavailable before the history bundle can arrive.
      getRendererEncryptedChat().consumeWelcomeApplied(scope.scopeId)
      if (scope.kind === 'channel') {
        void useMessageStore.getState().fetchMessages(scope.scopeId)
      } else {
        void useMessageStore.getState().fetchDmMessages(scope.scopeId)
      }
    }
    rememberScopeMutationSeq(scope.scopeId, getRoomSeq(payload.room_seq))
    return
  }

  if (scopeEvent.event === 'mls_history_bundle') {
    if (scope.kind === 'channel') {
      void useMessageStore.getState().fetchMessages(scope.scopeId)
    } else {
      void useMessageStore.getState().fetchDmMessages(scope.scopeId)
    }
    return
  }

  if (scopeEvent.event === 'incoming_call') {
    const userId = useAuthStore.getState().user?.id
    if ((payload.caller_id as string) !== userId) {
      useVoiceStore.getState().setIncomingCall({
        callerId: payload.caller_id as string,
        conversationId: payload.conversation_id as string
      })
    }
    return
  }

  if (scopeEvent.event === 'call_rejected') {
    useVoiceStore.getState().handleDmCallRejected(payload.conversation_id as string)
    return
  }
}

const liveScopeReadyPromises = new Map<string, Promise<void>>()

function startLiveScopeWatch(
  scope: EncryptedScopeDescriptor,
  set: (fn: (s: MessageState) => Partial<MessageState>) => void
): void {
  releaseLiveScopeWatch(scope.topic)
  const token = Symbol(scope.topic)
  liveScopeWatchTokens.set(scope.topic, token)

  const readyPromise = getRendererEncryptedChat()
    .watchScope(
      {
        kind: scope.kind,
        id: scope.scopeId
      },
      async (scopeEvent) => {
        await handleSdkScopeEvent(scope, scopeEvent, set)
      }
    )
    .then((dispose) => {
      if (liveScopeWatchTokens.get(scope.topic) !== token) {
        dispose()
        return
      }

      liveScopeWatchDisposers.set(scope.topic, dispose)
    })
    .catch((err) => {
      console.error(`[SCOPE-WATCH] failed: ${scope.topic}`, err)
      if (liveScopeWatchTokens.get(scope.topic) === token) {
        liveScopeWatchTokens.delete(scope.topic)
      }
    })

  liveScopeReadyPromises.set(scope.topic, readyPromise)
}

/** Wait for the scope's Phoenix channel subscription to be established. */
export function waitForScopeConnected(scopeId: string): Promise<void> {
  const topic = `chat:channel:${scopeId}`
  return liveScopeReadyPromises.get(topic) ?? Promise.resolve()
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
  const notificationsEnabled = getStoredValue('notifications') !== 'disabled'

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

  const notifApi = (window as unknown as Record<string, unknown>).notifications as {
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

function reconciliationScore(message: Message): number {
  let score = 0

  if (!message.id.startsWith('local:')) {
    score += 8
  }
  if (message.room_seq != null) {
    score += 4
  }
  if (message.delivery_state === 'sent') {
    score += 2
  } else if (message.delivery_state === 'sending') {
    score += 1
  }
  if (!message.decryptionFailed) {
    score += 1
  }

  return score
}

function preferReconciledMessage(current: Message, candidate: Message): Message {
  const currentScore = reconciliationScore(current)
  const candidateScore = reconciliationScore(candidate)
  if (candidateScore !== currentScore) {
    return candidateScore > currentScore ? candidate : current
  }

  const currentSeq = current.room_seq ?? -1
  const candidateSeq = candidate.room_seq ?? -1
  if (candidateSeq !== currentSeq) {
    return candidateSeq > currentSeq ? candidate : current
  }

  return candidate.inserted_at >= current.inserted_at ? candidate : current
}

function dedupeMessages(messages: Message[]): Message[] {
  const dedupedById: Message[] = []

  for (const message of messages) {
    const existingIndex = dedupedById.findIndex((entry) => entry.id === message.id)
    if (existingIndex === -1) {
      dedupedById.push(message)
      continue
    }

    dedupedById[existingIndex] = preferReconciledMessage(
      dedupedById[existingIndex],
      message
    )
  }

  const dedupedByClientNonce: Message[] = []

  for (const message of dedupedById) {
    if (!message.client_nonce) {
      dedupedByClientNonce.push(message)
      continue
    }

    const existingIndex = dedupedByClientNonce.findIndex(
      (entry) => entry.client_nonce === message.client_nonce
    )
    if (existingIndex === -1) {
      dedupedByClientNonce.push(message)
      continue
    }

    dedupedByClientNonce[existingIndex] = preferReconciledMessage(
      dedupedByClientNonce[existingIndex],
      message
    )
  }

  return dedupedByClientNonce
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

async function ensureLocalJoinKeyPackagesReady(): Promise<void> {
  if (!useAuthStore.getState().canUseE2EE) {
    return
  }

  await useAuthStore.getState().replenishKeyPackages().catch(() => {})
}

function hasFailedEncryptedMessages(messages: Message[] | undefined): boolean {
  return (messages || []).some((message) => message.encrypted && message.decryptionFailed)
}

async function maybeRequestMlsJoin(targetId: string, topic: string): Promise<void> {
  const encryptedChat = getRendererEncryptedChat()
  if (encryptedChat.hasGroup(targetId)) {
    return
  }

  await ensureLocalJoinKeyPackagesReady()

  const now = Date.now()
  const lastRequestAt = recentMlsJoinRequests.get(topic) ?? 0
  if (now - lastRequestAt < MLS_JOIN_REQUEST_COOLDOWN_MS) {
    return
  }

  recentMlsJoinRequests.set(topic, now)
  await encryptedChat.requestJoin(scopeFromTopic(targetId, topic)).catch(() => {})
}

interface EncryptedScopeDescriptor {
  kind: 'channel' | 'dm'
  targetId: string
  scopeId: string
  topic: string
}

function scopeFromTopic(targetId: string, topic: string): { kind: 'channel' | 'dm'; id: string; channelId?: string | null } {
  if (topic.startsWith('dm:')) {
    const channelId = resolveDmChannelId(targetId)
    return { kind: 'dm', id: targetId, channelId }
  }
  return { kind: 'channel', id: targetId }
}

function sdkScopeFromDescriptor(scope: EncryptedScopeDescriptor): { kind: 'channel' | 'dm'; id: string; channelId?: string | null } {
  return {
    kind: scope.kind,
    id: scope.targetId,
    channelId: scope.channelId
  }
}

async function prepareEncryptedScope(
  scope: EncryptedScopeDescriptor,
  options: {
    lastKnownEpoch?: number | null
    reason?: string
  } = {}
): Promise<boolean> {
  return await getRendererEncryptedChat().prepareScopeForRead(
    sdkScopeFromDescriptor(scope),
    {
      lastKnownEpoch: options.lastKnownEpoch ?? null,
      reason: options.reason ?? null
    }
  ).catch(() => false)
}

async function drainEncryptedScopeRepairArtifacts(
  scope: EncryptedScopeDescriptor,
  force = false
): Promise<void> {
  await getRendererEncryptedChat().drainScopeRepairArtifacts(
    sdkScopeFromDescriptor(scope),
    {
      force
    }
  ).catch(() => {})
}

function scopeForId(scopeId: string): { kind: 'channel' | 'dm'; id: string } {
  return {
    kind: getDmConversation(scopeId) ? 'dm' : 'channel',
    id: scopeId
  }
}

async function fetchUrgentMessagesById(
  messageIds: string[]
): Promise<Map<string, VesperMessage>> {
  const uniqueMessageIds = [...new Set(messageIds.filter((messageId) => messageId.length > 0))]

  if (uniqueMessageIds.length === 0) {
    return new Map()
  }

  try {
    const rawMessages = await getRendererClient().fetchMessagesByIds(uniqueMessageIds)
    const result = new Map<string, VesperMessage>()
    for (const message of rawMessages) {
      if (message.id) result.set(message.id, message)
    }
    return result
  } catch {
    // Fall back to individual fetches below.
  }

  const result = new Map<string, VesperMessage>()
  await Promise.all(
    uniqueMessageIds.map(async (messageId) => {
      try {
        const message = await getRendererClient().fetchMessageRecord(messageId)
        if (message) result.set(messageId, message)
      } catch {
        // Ignore individual fetch failures
      }
    })
  )
  return result
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
      const processed = await processIncomingMessage(targetId, rawMessage)

      applyProcessedIncomingMessage(targetId, processed, rawMessage, useMessageStore.setState)
      maybeShowDesktopNotification(processed)
    } catch {
      // ignore urgent hydration failures
    }
  }
}

function getDmConversation(conversationId: string) {
  return useDmStore
    .getState()
    .conversations.find((conversation) => conversation.id === conversationId) ?? null
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

  const encryptedChat = getRendererEncryptedChat()
  const shouldAvoidResync =
    scope.kind === 'dm' &&
    (!encryptedChat.hasGroup(scope.targetId) || encryptedChat.getMemberCount(scope.targetId) < 2)

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
      if (strategy === 'resync' && encryptedChat.hasGroup(scope.targetId)) {
        await encryptedChat.requestResync(
          sdkScopeFromDescriptor(scope),
          {
            lastKnownEpoch,
            reason: roundReason,
            username: useAuthStore.getState().user?.username ?? null
          }
        ).catch(() => {})
      } else if (strategy === 'history-first' && encryptedChat.hasGroup(scope.targetId)) {
        await encryptedChat.requestHistorySync(
          sdkScopeFromDescriptor(scope),
          {
            force: true
          }
        ).catch(() => {})
      } else {
        await prepareEncryptedScope(scope, {
          lastKnownEpoch,
          reason: roundReason
        }).catch(() => false)
      }

      await drainEncryptedScopeRepairArtifacts(scope, true)
      await refreshEncryptedScope(scope, getState).catch(() => {})

      if (!hasFailedMessagesInScope(scope, getState)) {
        return true
      }

      for (const delayMs of MLS_RECOVERY_BACKOFF_MS) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        if (strategy === 'resync' && encryptedChat.hasGroup(scope.targetId)) {
          await encryptedChat.requestResync(
            sdkScopeFromDescriptor(scope),
            {
              lastKnownEpoch,
              reason: roundReason,
              username: useAuthStore.getState().user?.username ?? null
            }
          ).catch(() => {})
        } else if (strategy === 'history-first' && encryptedChat.hasGroup(scope.targetId)) {
          await encryptedChat.requestHistorySync(
            sdkScopeFromDescriptor(scope),
            {
              force: true
            }
          ).catch(() => {})
        } else {
          await prepareEncryptedScope(scope, {
            lastKnownEpoch,
            reason: roundReason
          }).catch(() => false)
        }
        await drainEncryptedScopeRepairArtifacts(scope, true)
        await refreshEncryptedScope(scope, getState).catch(() => {})

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

    // Last-resort fork recovery: we have a local group but still can't decrypt
    // messages after replaying all durable MLS events AND requesting a resync.
    // The most likely cause is a group fork — both sides at the same epoch but
    // with different ratchet tree states. Reset the local group entirely and
    // rejoin from scratch so we pick up the canonical group from whoever
    // responds to the join request.
    const shouldResetGroup =
      encryptedChat.hasGroup(scope.targetId) && hasFailedMessagesInScope(scope, getState)

    if (shouldResetGroup) {
      await encryptedChat.resetScope(scope.targetId)
    }

    if (shouldResetGroup || !encryptedChat.hasGroup(scope.targetId)) {
      await prepareEncryptedScope(scope, {
        lastKnownEpoch,
        reason: 'post_reset_repair'
      }).catch(() => false)

      // If join/resync failed to re-establish the group, create a fresh one
      // as a last resort. This breaks the deadlock when the other side can't
      // process our join request (e.g. running old code, offline, or the
      // first-member-in-tree restriction blocks them). Other members will
      // rejoin via mls_request_join_all once they see the new group.
      if (!encryptedChat.hasGroup(scope.targetId) && scope.kind === 'channel') {
        await encryptedChat.createScopeGroup({ kind: 'channel', id: scope.targetId })
        if (encryptedChat.hasGroup(scope.targetId)) {
          const topic = `chat:channel:${scope.targetId}`
          pushToChannel(topic, 'mls_request_join_all', {})
        }
      }

      if (encryptedChat.hasGroup(scope.targetId)) {
        await drainEncryptedScopeRepairArtifacts(scope, true)
        await refreshEncryptedScope(scope, getState).catch(() => {})

        if (!hasFailedMessagesInScope(scope, getState)) {
          return
        }
      }
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

  fireAndForget(recoverEncryptedScope(scope, getState, lastKnownEpoch, reason))
}

async function refreshScopeAfterCryptoUpdate(
  scope: EncryptedScopeDescriptor,
  getState: () => MessageState,
  _setState: (fn: (s: MessageState) => Partial<MessageState>) => void,
  afterWelcome = false
): Promise<void> {
  await drainEncryptedScopeRepairArtifacts(scope, true)
  await refreshEncryptedScope(scope, getState).catch(() => {})

  if (hasFailedMessagesInScope(scope, getState)) {
    if (!afterWelcome) {
      fireAndForget(recoverEncryptedScope(scope, getState, null, 'post_crypto_update'))
    }
    // After joining via Welcome, failed messages are from before this device
    // joined the group and can't be decrypted directly (MLS forward secrecy).
    // Don't mark them as permanently unavailable here. The SDK requests and
    // applies same-user history bundles, and the next scope refresh will swap
    // those placeholders out once the bundle lands.
  }
}

export async function handleWelcomeProcessedForScope(
  scope: EncryptedScopeDescriptor
): Promise<void> {
  recentWelcomeProcessed.set(scope.targetId, Date.now())
  await refreshScopeAfterCryptoUpdate(scope, useMessageStore.getState, useMessageStore.setState, true)
}

export async function handleWelcomeProcessedForResolvedScope(scopeId: string): Promise<void> {
  const scope: EncryptedScopeDescriptor = getDmConversation(scopeId)
    ? {
        kind: 'dm',
        targetId: scopeId,
        scopeId,
        topic: `dm:${scopeId}`
      }
    : {
        kind: 'channel',
        targetId: scopeId,
        scopeId,
        topic: `chat:channel:${scopeId}`
      }

  await handleWelcomeProcessedForScope(scope)
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
    if (reaction.emoji && reaction.emoji !== 'encrypted') {
      continue
    }

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
    const decrypted = await getRendererEncryptedChat().decryptOpaqueBatch(
      scopeForId(targetId),
      ciphertextsToDecrypt.map((ciphertext) => ({ ciphertext }))
    )

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
  mls_epoch?: number | null
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
  syncRecentScopes: (sinceToken?: string | null, options?: SyncRecentScopesOptions) => Promise<void>
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
        recentMutationSeqsByScope.delete(existingScopeId)

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

    // Skip if already watching — prevents double-join from React re-renders
    // that would invalidate the first watch's token and cause a reconnect gap.
    if (liveScopeWatchTokens.has(topic)) {
      return
    }

    const scope: EncryptedScopeDescriptor = {
      kind: 'channel',
      targetId: channelId,
      scopeId: channelId,
      topic
    }

    startLiveScopeWatch(scope, set)

    if (canUseEncryptedFeatures()) {
      if (getRendererEncryptedChat().consumeWelcomeApplied(channelId)) {
        fireAndForget(handleWelcomeProcessedForScope(scope))
      }

      prepareEncryptedScope(scope, {
        reason: 'scope_open'
      })
        .catch(() => {
          // Continue without encryption
        })
        .finally(() => {
          if (getRendererEncryptedChat().consumeWelcomeApplied(channelId)) {
            fireAndForget(handleWelcomeProcessedForScope(scope))
          }
          get().fetchMessages(channelId)
        })
    } else {
      void get().fetchMessages(channelId)
    }
  },

  leaveChannelChat: (channelId) => {
    releaseLiveScopeWatch(`chat:channel:${channelId}`)
  },

  fetchMessages: async (channelId) => {
    const existingFetch = inFlightScopeMessageFetches.get(`channel:${channelId}`)
    if (existingFetch) {
      await existingFetch
      return
    }

    const run = (async () => {
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
      const residentMessages = get().messagesByChannel[channelId] ?? []
      const hasResidentMessages = residentMessages.length > 0

      if (!hasResidentMessages) {
        const cachedMessages = await loadScopeMessagesFromCache(channelId)
        if (cachedMessages.length > 0 && isCurrentScopeMessageRefresh(channelId, refreshToken)) {
          const cachedWindow = applyMessageWindow(cachedMessages, 'replace')
          scheduleExpiryTimers(channelId, cachedWindow.messages)
          set((s) => ({
            messagesByChannel: {
              ...s.messagesByChannel,
              [channelId]: cachedWindow.messages
            },
            latestRoomSeqByScope: updateLatestRoomSeqByScope(
              s.latestRoomSeqByScope,
              channelId,
              getMaxRoomSeq(cachedWindow.messages)
            ),
            hasMore: {
              ...s.hasMore,
              [channelId]: s.hasMore[channelId] ?? true
            },
            hasNewer: {
              ...s.hasNewer,
              [channelId]: s.hasNewer[channelId] ?? false
            }
          }))
        }
      }

      if (canUseEncryptedFeatures()) {
        const messages = await loadScopeMessagesViaSdk({
          kind: 'channel',
          id: channelId
        })
        const mergedMessages = mergeFetchedMessagesWithResidentState(
          messages,
          hasResidentMessages
            ? residentMessages
            : (get().messagesByChannel[channelId] ?? [])
        )
        const windowed = applyMessageWindow(mergedMessages, 'replace')

        if (!isCurrentScopeMessageRefresh(channelId, refreshToken)) {
          return
        }

        scheduleExpiryTimers(channelId, windowed.messages)
        set((s) => {
          const finalWindow = applyMessageWindow(
            mergeResidentTailMessages(
              mergeFetchedMessagesWithResidentState(
                windowed.messages,
                s.messagesByChannel[channelId] ?? []
              ),
              s.messagesByChannel[channelId] ?? []
            ),
            'replace'
          )

          return {
            messagesByChannel: {
              ...s.messagesByChannel,
              [channelId]: finalWindow.messages
            },
            latestRoomSeqByScope: updateLatestRoomSeqByScope(
              s.latestRoomSeqByScope,
              channelId,
              getMaxRoomSeq(finalWindow.messages)
            ),
            hasMore: {
              ...s.hasMore,
              [channelId]: messages.length === MESSAGE_PAGE_SIZE || finalWindow.trimmedOlder
            },
            hasNewer: {
              ...s.hasNewer,
              [channelId]: finalWindow.trimmedNewer
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
                  hasFailedEncryptedMessages(finalWindow.messages) ||
                  finalWindow.messages.some(
                    (message) => message.content === ENCRYPTED_MESSAGE_SYNCING_PLACEHOLDER
                  )
                    ? 'stale'
                    : s.activeScopeId === channelId
                      ? 'active'
                      : 'warm',
                lastVisitedAt: s.scopeLifecycleById[channelId]?.lastVisitedAt ?? Date.now()
              }
            }
          }
        })
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
        return
      }

      const rawMessages = [
        ...(await getRendererClient().fetchChannelMessages(channelId, {
          limit: MESSAGE_PAGE_SIZE
        }))
      ].reverse()
      const provisionalWindow = applyMessageWindow(
        rawMessages.map((message) => buildProvisionalMessage(message)),
        'replace'
      )

      if (!hasResidentMessages && isCurrentScopeMessageRefresh(channelId, refreshToken)) {
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
              rawMessages.length === MESSAGE_PAGE_SIZE || provisionalWindow.trimmedOlder
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

      const messages = await processIncomingMessageBatch(channelId, rawMessages)
      const mergedMessages = mergeFetchedMessagesWithResidentState(
        messages,
        hasResidentMessages
          ? residentMessages
          : (get().messagesByChannel[channelId] ?? [])
      )
      const windowed = applyMessageWindow(mergedMessages, 'replace')

      if (!isCurrentScopeMessageRefresh(channelId, refreshToken)) {
        return
      }

      scheduleExpiryTimers(channelId, windowed.messages)
      set((s) => {
        const finalWindow = applyMessageWindow(
          mergeResidentTailMessages(
            mergeFetchedMessagesWithResidentState(
              windowed.messages,
              s.messagesByChannel[channelId] ?? []
            ),
            s.messagesByChannel[channelId] ?? []
          ),
          'replace'
        )

        return {
          messagesByChannel: {
            ...s.messagesByChannel,
            [channelId]: finalWindow.messages
          },
          latestRoomSeqByScope: updateLatestRoomSeqByScope(
            s.latestRoomSeqByScope,
            channelId,
            getMaxRoomSeq(finalWindow.messages)
          ),
          hasMore: {
            ...s.hasMore,
            [channelId]: rawMessages.length === MESSAGE_PAGE_SIZE || finalWindow.trimmedOlder
          },
          hasNewer: {
            ...s.hasNewer,
            [channelId]: finalWindow.trimmedNewer
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
                hasFailedEncryptedMessages(finalWindow.messages) ||
                finalWindow.messages.some(
                  (message) => message.content === ENCRYPTED_MESSAGE_SYNCING_PLACEHOLDER
                )
                  ? 'stale'
                  : s.activeScopeId === channelId
                    ? 'active'
                    : 'warm',
              lastVisitedAt: s.scopeLifecycleById[channelId]?.lastVisitedAt ?? Date.now()
            }
          }
        }
      })
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
    })().finally(() => {
      inFlightScopeMessageFetches.delete(`channel:${channelId}`)
    })

    inFlightScopeMessageFetches.set(`channel:${channelId}`, run)
    await run
  },

  fetchOlderMessages: async (channelId) => {
    if (inFlightOlderScopeMessageFetches.has(`channel:${channelId}`)) {
      return
    }

    const existing = get().messagesByChannel[channelId] || []
    if (existing.length === 0) return

    const oldest = existing[0]
    inFlightOlderScopeMessageFetches.add(`channel:${channelId}`)
    try {
      const rawMessages = [
        ...(await getRendererClient().fetchChannelMessages(channelId, {
          limit: MESSAGE_PAGE_SIZE,
          before: encodeMessageCursor(oldest)
        }))
      ].reverse()
      if (rawMessages.length > 0) {
        const provisionalOlderMessages = rawMessages.map((message) => buildProvisionalMessage(message))
        const mergedWindow = applyMessageWindow(
          [...provisionalOlderMessages, ...(get().messagesByChannel[channelId] ?? existing)],
          'prepend'
        )
        set((s) => ({
          messagesByChannel: {
            ...s.messagesByChannel,
            [channelId]: applyMessageWindow(
              [...provisionalOlderMessages, ...(s.messagesByChannel[channelId] ?? existing)],
              'prepend'
            ).messages
          },
          latestRoomSeqByScope: updateLatestRoomSeqByScope(
            s.latestRoomSeqByScope,
            channelId,
            getMaxRoomSeq(mergedWindow.messages)
          ),
          hasMore: {
            ...s.hasMore,
            [channelId]: rawMessages.length === MESSAGE_PAGE_SIZE
          },
          hasNewer: {
            ...s.hasNewer,
            [channelId]:
              (s.hasNewer[channelId] ?? false) || mergedWindow.trimmedNewer
          }
        }))
        const olderMessages = await processIncomingMessageBatch(channelId, rawMessages)
        set((s) => {
          const residentMessages = s.messagesByChannel[channelId] ?? []
          const patchedMessages = patchResidentMessagesById(residentMessages, olderMessages)

          if (patchedMessages === residentMessages) {
            return {}
          }

          return {
            messagesByChannel: {
              ...s.messagesByChannel,
              [channelId]: patchedMessages
            },
            latestRoomSeqByScope: updateLatestRoomSeqByScope(
              s.latestRoomSeqByScope,
              channelId,
              getMaxRoomSeq(patchedMessages)
            )
          }
        })
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
    } finally {
      inFlightOlderScopeMessageFetches.delete(`channel:${channelId}`)
    }
  },

  fetchNewerMessages: async (channelId) => {
    if (inFlightNewerScopeMessageFetches.has(`channel:${channelId}`)) {
      return
    }

    const existing = get().messagesByChannel[channelId] || []
    if (existing.length === 0) {
      await get().fetchMessages(channelId)
      return
    }

    const newest = existing[existing.length - 1]
    inFlightNewerScopeMessageFetches.add(`channel:${channelId}`)
    try {
      const rawMessages = [
        ...(await getRendererClient().fetchChannelMessages(channelId, {
          limit: MESSAGE_PAGE_SIZE,
          after: encodeMessageCursor(newest)
        }))
      ].reverse()
      if (rawMessages.length > 0) {
        const provisionalNewerMessages = rawMessages.map((message) => buildProvisionalMessage(message))
        const mergedWindow = applyMessageWindow(
          [...(get().messagesByChannel[channelId] ?? existing), ...provisionalNewerMessages],
          'append'
        )
        scheduleExpiryTimers(channelId, mergedWindow.messages)
        set((s) => ({
          messagesByChannel: {
            ...s.messagesByChannel,
            [channelId]: applyMessageWindow(
              [...(s.messagesByChannel[channelId] ?? existing), ...provisionalNewerMessages],
              'append'
            ).messages
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
            [channelId]: rawMessages.length === MESSAGE_PAGE_SIZE
          }
        }))
        const newerMessages = await processIncomingMessageBatch(channelId, rawMessages)
        set((s) => {
          const residentMessages = s.messagesByChannel[channelId] ?? []
          const patchedMessages = patchResidentMessagesById(residentMessages, newerMessages)

          if (patchedMessages === residentMessages) {
            return {}
          }

          scheduleExpiryTimers(channelId, patchedMessages)
          return {
            messagesByChannel: {
              ...s.messagesByChannel,
              [channelId]: patchedMessages
            },
            latestRoomSeqByScope: updateLatestRoomSeqByScope(
              s.latestRoomSeqByScope,
              channelId,
              getMaxRoomSeq(patchedMessages)
            )
          }
        })
      }
    } catch {
      // ignore
    } finally {
      inFlightNewerScopeMessageFetches.delete(`channel:${channelId}`)
    }
  },

  syncRecentScopes: async (sinceToken = null, options) => {
    const state = get()
    const requestedScopeIds =
      options?.scopeIds?.filter((scopeId): scopeId is string => Boolean(scopeId)) ?? null
    const scopeIds = (requestedScopeIds ?? [state.activeScopeId, ...state.recentScopeIds])
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
      const data = await getRendererClient().fetchScopeSync({
        scopes,
        since: sinceToken,
        limit: MESSAGE_PAGE_SIZE
      })
      const nextToken = data.token
      const batches = data.scopes

      if (nextToken) {
        const { persistSyncTokens } = await import('./syncStore')
        persistSyncTokens(nextToken, nextToken)
      }

      for (const batch of batches) {
        const syncEvents = Array.isArray(batch.events) ? batch.events : []
        const processedMessages =
          batch.messages.length > 0
            ? await processIncomingMessageBatch(batch.scope_id, batch.messages)
            : []

        const orderedOps = [
          ...processedMessages.map((message, index) => ({
            kind: 'message' as const,
            roomSeq: getRoomSeq(message.room_seq),
            order: index,
            message,
            rawMessage: batch.messages[index]
          })),
          ...syncEvents.map((syncEvent, index) => ({
            kind: 'event' as const,
            roomSeq: getRoomSeq(syncEvent.room_seq),
            order: processedMessages.length + index,
            syncEvent
          }))
        ].sort((left, right) => {
          if (left.roomSeq == null && right.roomSeq == null) {
            return left.order - right.order
          }

          if (left.roomSeq == null) {
            return 1
          }

          if (right.roomSeq == null) {
            return -1
          }

          if (left.roomSeq === right.roomSeq) {
            return left.order - right.order
          }

          return left.roomSeq - right.roomSeq
        })

        for (const op of orderedOps) {
          if (op.kind === 'message') {
            applyProcessedIncomingMessage(batch.scope_id, op.message, op.rawMessage, set)
            continue
          }

          await applyScopeSyncEvent(batch.scope_id, op.syncEvent, set)
        }

        set((s) => ({
          latestRoomSeqByScope: updateLatestRoomSeqByScope(
            s.latestRoomSeqByScope,
            batch.scope_id,
            getMaxRoomSeq(processedMessages),
            getMaxRoomSeq(syncEvents)
          ),
          hasNewer: {
            ...s.hasNewer,
            [batch.scope_id]: batch.has_more
          }
        }))
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

    const replyingTo = get().replyingTo
    const parentId = parentMessageId ?? replyingTo?.id ?? undefined
    const shouldClearInlineReply = !parentMessageId
    const mentionedUserIds = extractMentionedUserIds(content)
    const activeServer = useServerStore.getState().servers.find(
      (s) => s.id === useServerStore.getState().activeServerId
    )
    const clientNonce = generateClientNonce()
    const resolvedContent = replaceEmojiShortcodes(content, activeServer?.emojis ?? [])
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

    try {
      await getRendererEncryptedChat().sendText(
        {
          kind: 'channel',
          id: channelId
        },
        resolvedContent,
        {
          parentMessageId: parentId,
          mentionedUserIds,
          clientNonce
        }
      )
      updateOptimisticMessageState(channelId, clientNonce, 'sent', set)
      set({
        ...(shouldClearInlineReply ? { replyingTo: null } : {}),
        encryptionError: null
      })
    } catch {
      updateOptimisticMessageState(channelId, clientNonce, 'failed', set)
      set({
        encryptionError: 'Message could not be encrypted. Please try again.'
      })
    }
  },

  sendTypingStart: (channelId) => {
    void waitForScopeConnected(channelId).then(() =>
      getRendererEncryptedChat().sendTyping({ kind: 'channel', id: channelId }, true)
    ).catch(() => {})
  },

  sendTypingStop: (channelId) => {
    void waitForScopeConnected(channelId).then(() =>
      getRendererEncryptedChat().sendTyping({ kind: 'channel', id: channelId }, false)
    ).catch(() => {})
  },

  // --- DM conversation messaging ---

  joinDmChat: (conversationId) => {
    const channelId = resolveDmChannelId(conversationId)

    if (channelId) {
      get().joinChannelChat(channelId)
      return
    }

    // Legacy DM path (no backing channel)
    const topic = `dm:${conversationId}`
    const scope: EncryptedScopeDescriptor = {
      kind: 'dm',
      targetId: conversationId,
      scopeId: conversationId,
      topic
    }

    startLiveScopeWatch(scope, set)

    if (canUseEncryptedFeatures()) {
      if (getRendererEncryptedChat().consumeWelcomeApplied(conversationId)) {
        fireAndForget(handleWelcomeProcessedForScope(scope))
      }

      prepareEncryptedScope(scope, {
        reason: 'scope_open'
      })
        .catch(() => {
          // Continue without encryption
        })
        .finally(() => {
          if (getRendererEncryptedChat().consumeWelcomeApplied(conversationId)) {
            fireAndForget(handleWelcomeProcessedForScope(scope))
          }
          get().fetchDmMessages(conversationId)
        })
    } else {
      void get().fetchDmMessages(conversationId)
    }
  },

  leaveDmChat: (conversationId) => {
    const channelId = resolveDmChannelId(conversationId)
    if (channelId) {
      get().leaveChannelChat(channelId)
      return
    }
    releaseLiveScopeWatch(`dm:${conversationId}`)
  },

  fetchDmMessages: async (conversationId) => {
    // DM-as-channel: fetch via channel messages endpoint
    const channelId = resolveDmChannelId(conversationId)
    if (channelId) {
      await get().fetchMessages(channelId)
      return
    }

    // Legacy DM path
    const existingFetch = inFlightScopeMessageFetches.get(`dm:${conversationId}`)
    if (existingFetch) {
      await existingFetch
      return
    }

    const run = (async () => {
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
      const residentMessages = get().messagesByChannel[conversationId] ?? []
      const hasResidentMessages = residentMessages.length > 0

      if (!hasResidentMessages) {
        const cachedMessages = await loadScopeMessagesFromCache(conversationId)
        if (
          cachedMessages.length > 0 &&
          isCurrentScopeMessageRefresh(conversationId, refreshToken)
        ) {
          const cachedWindow = applyMessageWindow(cachedMessages, 'replace')
          scheduleExpiryTimers(conversationId, cachedWindow.messages)
          set((s) => ({
            messagesByChannel: {
              ...s.messagesByChannel,
              [conversationId]: cachedWindow.messages
            },
            latestRoomSeqByScope: updateLatestRoomSeqByScope(
              s.latestRoomSeqByScope,
              conversationId,
              getMaxRoomSeq(cachedWindow.messages)
            ),
            hasMore: {
              ...s.hasMore,
              [conversationId]: s.hasMore[conversationId] ?? true
            },
            hasNewer: {
              ...s.hasNewer,
              [conversationId]: s.hasNewer[conversationId] ?? false
            }
          }))
        }
      }

      if (canUseEncryptedFeatures()) {
        const messages = await loadScopeMessagesViaSdk({
          kind: 'dm',
          id: conversationId
        })
        const mergedMessages = mergeFetchedMessagesWithResidentState(
          messages,
          hasResidentMessages
            ? residentMessages
            : (get().messagesByChannel[conversationId] ?? [])
        )
        const windowed = applyMessageWindow(mergedMessages, 'replace')

        if (!isCurrentScopeMessageRefresh(conversationId, refreshToken)) {
          return
        }

        scheduleExpiryTimers(conversationId, windowed.messages)
        set((s) => {
          const finalWindow = applyMessageWindow(
            mergeResidentTailMessages(
              mergeFetchedMessagesWithResidentState(
                windowed.messages,
                s.messagesByChannel[conversationId] ?? []
              ),
              s.messagesByChannel[conversationId] ?? []
            ),
            'replace'
          )

          return {
            messagesByChannel: {
              ...s.messagesByChannel,
              [conversationId]: finalWindow.messages
            },
            latestRoomSeqByScope: updateLatestRoomSeqByScope(
              s.latestRoomSeqByScope,
              conversationId,
              getMaxRoomSeq(finalWindow.messages)
            ),
            hasMore: {
              ...s.hasMore,
              [conversationId]:
                messages.length === MESSAGE_PAGE_SIZE || finalWindow.trimmedOlder
            },
            hasNewer: {
              ...s.hasNewer,
              [conversationId]: finalWindow.trimmedNewer
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
                  hasFailedEncryptedMessages(finalWindow.messages) ||
                  finalWindow.messages.some(
                    (message) => message.content === ENCRYPTED_MESSAGE_SYNCING_PLACEHOLDER
                  )
                    ? 'stale'
                    : s.activeScopeId === conversationId
                      ? 'active'
                      : 'warm',
                lastVisitedAt: s.scopeLifecycleById[conversationId]?.lastVisitedAt ?? Date.now()
              }
            }
          }
        })
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
        return
      }

      const rawMessages = [
        ...(await getRendererClient().fetchConversationMessages(conversationId, {
          limit: MESSAGE_PAGE_SIZE
        }))
      ].reverse()
      const provisionalWindow = applyMessageWindow(
        rawMessages.map((message) => buildProvisionalMessage(message)),
        'replace'
      )

      if (!hasResidentMessages && isCurrentScopeMessageRefresh(conversationId, refreshToken)) {
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
              rawMessages.length === MESSAGE_PAGE_SIZE || provisionalWindow.trimmedOlder
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

      const messages = await processIncomingMessageBatch(conversationId, rawMessages)
      const mergedMessages = mergeFetchedMessagesWithResidentState(
        messages,
        hasResidentMessages
          ? residentMessages
          : (get().messagesByChannel[conversationId] ?? [])
      )
      const windowed = applyMessageWindow(mergedMessages, 'replace')

      if (!isCurrentScopeMessageRefresh(conversationId, refreshToken)) {
        return
      }

      scheduleExpiryTimers(conversationId, windowed.messages)
      set((s) => {
        const finalWindow = applyMessageWindow(
          mergeResidentTailMessages(
            mergeFetchedMessagesWithResidentState(
              windowed.messages,
              s.messagesByChannel[conversationId] ?? []
            ),
            s.messagesByChannel[conversationId] ?? []
          ),
          'replace'
        )

        return {
          messagesByChannel: {
            ...s.messagesByChannel,
            [conversationId]: finalWindow.messages
          },
          latestRoomSeqByScope: updateLatestRoomSeqByScope(
            s.latestRoomSeqByScope,
            conversationId,
            getMaxRoomSeq(finalWindow.messages)
          ),
          hasMore: {
            ...s.hasMore,
            [conversationId]:
              rawMessages.length === MESSAGE_PAGE_SIZE || finalWindow.trimmedOlder
          },
          hasNewer: {
            ...s.hasNewer,
            [conversationId]: finalWindow.trimmedNewer
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
                hasFailedEncryptedMessages(finalWindow.messages) ||
                finalWindow.messages.some(
                  (message) => message.content === ENCRYPTED_MESSAGE_SYNCING_PLACEHOLDER
                )
                  ? 'stale'
                  : s.activeScopeId === conversationId
                    ? 'active'
                    : 'warm',
              lastVisitedAt: s.scopeLifecycleById[conversationId]?.lastVisitedAt ?? Date.now()
            }
          }
        }
      })
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
    })().finally(() => {
      inFlightScopeMessageFetches.delete(`dm:${conversationId}`)
    })

    inFlightScopeMessageFetches.set(`dm:${conversationId}`, run)
    await run
  },

  fetchOlderDmMessages: async (conversationId) => {
    const channelId = resolveDmChannelId(conversationId)
    if (channelId) {
      await get().fetchOlderMessages(channelId)
      return
    }

    if (inFlightOlderScopeMessageFetches.has(`dm:${conversationId}`)) {
      return
    }

    const existing = get().messagesByChannel[conversationId] || []
    if (existing.length === 0) return

    const oldest = existing[0]
    inFlightOlderScopeMessageFetches.add(`dm:${conversationId}`)
    try {
      const rawMessages = [
        ...(await getRendererClient().fetchConversationMessages(conversationId, {
          limit: MESSAGE_PAGE_SIZE,
          before: encodeMessageCursor(oldest)
        }))
      ].reverse()
      if (rawMessages.length > 0) {
        const provisionalOlderMessages = rawMessages.map((message) => buildProvisionalMessage(message))
        const mergedWindow = applyMessageWindow(
          [...provisionalOlderMessages, ...(get().messagesByChannel[conversationId] ?? existing)],
          'prepend'
        )
        set((s) => ({
          messagesByChannel: {
            ...s.messagesByChannel,
            [conversationId]: applyMessageWindow(
              [...provisionalOlderMessages, ...(s.messagesByChannel[conversationId] ?? existing)],
              'prepend'
            ).messages
          },
          latestRoomSeqByScope: updateLatestRoomSeqByScope(
            s.latestRoomSeqByScope,
            conversationId,
            getMaxRoomSeq(mergedWindow.messages)
          ),
          hasMore: {
            ...s.hasMore,
            [conversationId]: rawMessages.length === MESSAGE_PAGE_SIZE
          },
          hasNewer: {
            ...s.hasNewer,
            [conversationId]:
              (s.hasNewer[conversationId] ?? false) || mergedWindow.trimmedNewer
          }
        }))
        const olderMessages = await processIncomingMessageBatch(conversationId, rawMessages)
        set((s) => {
          const residentMessages = s.messagesByChannel[conversationId] ?? []
          const patchedMessages = patchResidentMessagesById(residentMessages, olderMessages)

          if (patchedMessages === residentMessages) {
            return {}
          }

          return {
            messagesByChannel: {
              ...s.messagesByChannel,
              [conversationId]: patchedMessages
            },
            latestRoomSeqByScope: updateLatestRoomSeqByScope(
              s.latestRoomSeqByScope,
              conversationId,
              getMaxRoomSeq(patchedMessages)
            )
          }
        })
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
    } finally {
      inFlightOlderScopeMessageFetches.delete(`dm:${conversationId}`)
    }
  },

  fetchNewerDmMessages: async (conversationId) => {
    const channelId = resolveDmChannelId(conversationId)
    if (channelId) {
      await get().fetchNewerMessages(channelId)
      return
    }

    if (inFlightNewerScopeMessageFetches.has(`dm:${conversationId}`)) {
      return
    }

    const existing = get().messagesByChannel[conversationId] || []
    if (existing.length === 0) {
      await get().fetchDmMessages(conversationId)
      return
    }

    const newest = existing[existing.length - 1]
    inFlightNewerScopeMessageFetches.add(`dm:${conversationId}`)
    try {
      const rawMessages = [
        ...(await getRendererClient().fetchConversationMessages(conversationId, {
          limit: MESSAGE_PAGE_SIZE,
          after: encodeMessageCursor(newest)
        }))
      ].reverse()
      if (rawMessages.length > 0) {
        const provisionalNewerMessages = rawMessages.map((message) => buildProvisionalMessage(message))
        const mergedWindow = applyMessageWindow(
          [...(get().messagesByChannel[conversationId] ?? existing), ...provisionalNewerMessages],
          'append'
        )
        scheduleExpiryTimers(conversationId, mergedWindow.messages)
        set((s) => ({
          messagesByChannel: {
            ...s.messagesByChannel,
            [conversationId]: applyMessageWindow(
              [...(s.messagesByChannel[conversationId] ?? existing), ...provisionalNewerMessages],
              'append'
            ).messages
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
            [conversationId]: rawMessages.length === MESSAGE_PAGE_SIZE
          }
        }))
        const newerMessages = await processIncomingMessageBatch(conversationId, rawMessages)
        set((s) => {
          const residentMessages = s.messagesByChannel[conversationId] ?? []
          const patchedMessages = patchResidentMessagesById(residentMessages, newerMessages)

          if (patchedMessages === residentMessages) {
            return {}
          }

          scheduleExpiryTimers(conversationId, patchedMessages)
          return {
            messagesByChannel: {
              ...s.messagesByChannel,
              [conversationId]: patchedMessages
            },
            latestRoomSeqByScope: updateLatestRoomSeqByScope(
              s.latestRoomSeqByScope,
              conversationId,
              getMaxRoomSeq(patchedMessages)
            )
          }
        })
      }
    } catch {
      // ignore
    } finally {
      inFlightNewerScopeMessageFetches.delete(`dm:${conversationId}`)
    }
  },

  sendDmMessage: async (conversationId, content, parentMessageId) => {
    if (!canUseEncryptedFeatures()) {
      set({
        encryptionError: 'Approve this device to send encrypted messages.'
      })
      return
    }

    // DM-as-channel: delegate to channel send path
    const channelId = resolveDmChannelId(conversationId)
    if (channelId) {
      await get().sendMessage(channelId, content, parentMessageId)
      return
    }

    // Legacy DM path
    const replyingTo = get().replyingTo
    const parentId = parentMessageId ?? replyingTo?.id ?? undefined
    const shouldClearInlineReply = !parentMessageId
    const clientNonce = generateClientNonce()
    const optimisticMessage = buildOptimisticMessage({
      targetId: conversationId,
      content,
      parentMessageId: parentId,
      conversationId,
      clientNonce
    })

    upsertOptimisticMessage(conversationId, optimisticMessage, set)
    syncDmConversationActivity(optimisticMessage)

    try {
      await getRendererEncryptedChat().sendText(
        {
          kind: 'dm',
          id: conversationId
        },
        content,
        {
          parentMessageId: parentId,
          clientNonce
        }
      )
      updateOptimisticMessageState(conversationId, clientNonce, 'sent', set)
      set({
        ...(shouldClearInlineReply ? { replyingTo: null } : {}),
        encryptionError: null
      })
    } catch {
      updateOptimisticMessageState(conversationId, clientNonce, 'failed', set)
      set({ encryptionError: 'Conversation encryption is still syncing. Please try again.' })
    }
  },

  sendDmTypingStart: (conversationId) => {
    const channelId = resolveDmChannelId(conversationId)
    if (channelId) {
      void waitForScopeConnected(channelId).then(() =>
        getRendererEncryptedChat().sendTyping({ kind: 'channel', id: channelId }, true)
      ).catch(() => {})
    } else {
      void getRendererEncryptedChat().sendTyping({ kind: 'dm', id: conversationId }, true)
    }
  },

  sendDmTypingStop: (conversationId) => {
    const channelId = resolveDmChannelId(conversationId)
    if (channelId) {
      void waitForScopeConnected(channelId).then(() =>
        getRendererEncryptedChat().sendTyping({ kind: 'channel', id: channelId }, false)
      ).catch(() => {})
    } else {
      void getRendererEncryptedChat().sendTyping({ kind: 'dm', id: conversationId }, false)
    }
  },

  // Threads
  setReplyingTo: (message) => set({ replyingTo: message }),
  openThread: async (message) => {
    const canonicalMessage = await resolveCanonicalThreadMessage(get, message)
    const parentId = canonicalMessage.parent_message_id ?? canonicalMessage.id
    set({
      activeThreadParentId: parentId,
      activeThreadParent: canonicalMessage.parent_message_id ? null : canonicalMessage,
      threadError: null
    })

    // Ensure encryption scope is ready for thread replies.
    // DM threads use the conversation scope; channel threads use the channel scope.
    if (canUseEncryptedFeatures()) {
      const scopeId = canonicalMessage.conversation_id ?? canonicalMessage.channel_id
      const scopeKind = canonicalMessage.conversation_id ? 'dm' : 'channel'
      if (scopeId) {
        const topic = scopeKind === 'dm' ? `dm:${scopeId}` : `chat:channel:${scopeId}`
        prepareEncryptedScope(
          { kind: scopeKind, targetId: scopeId, scopeId, topic },
          { reason: 'thread_open' }
        )
      }
    }

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
    const refreshToken = beginThreadReplyRefresh(parentMessageId)
    set({ threadLoading: true, threadError: null })
    try {
      const data = await getRendererClient().fetchThreadRecords(parentMessageId)
      const parentPayload = data.parent
      if (!parentPayload) {
        if (
          get().activeThreadParentId === parentMessageId &&
          isCurrentThreadReplyRefresh(parentMessageId, refreshToken)
        ) {
          set({ threadLoading: false, threadError: 'Thread could not be loaded.' })
        }
        return
      }

      const targetId = parentPayload.channel_id ?? parentPayload.conversation_id
      if (!targetId) {
        if (
          get().activeThreadParentId === parentMessageId &&
          isCurrentThreadReplyRefresh(parentMessageId, refreshToken)
        ) {
          set({ threadLoading: false, threadError: 'Thread could not be loaded.' })
        }
        return
      }

      const parent = await processIncomingMessage(targetId, parentPayload)
      const replyPayloads = data.messages ?? []
      const replies = await processIncomingMessageBatch(targetId, replyPayloads)

      if (
        get().activeThreadParentId !== parentMessageId ||
        !isCurrentThreadReplyRefresh(parentMessageId, refreshToken)
      ) {
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
      if (
        get().activeThreadParentId === parentMessageId &&
        isCurrentThreadReplyRefresh(parentMessageId, refreshToken)
      ) {
        set({ threadLoading: false, threadError: 'Thread could not be loaded.' })
      }
    }
  },
  sendThreadReply: async (content) => {
    let parent = get().activeThreadParent
    const activeThreadParentId = get().activeThreadParentId
    if (!parent && activeThreadParentId) {
      parent =
        findMessageInStateById(get(), activeThreadParentId) ??
        null

      if (!parent) {
        await get().fetchThreadReplies(activeThreadParentId)
        parent = get().activeThreadParent
      }
    }

    if (!parent) {
      return
    }

    const originalParent = parent
    parent = await resolveCanonicalThreadMessage(get, parent)
    if (parent.id !== originalParent.id) {
      set((s) => rekeyThreadStateForCanonicalMessage(s, originalParent, parent))
    }

    const replyTarget = get().replyingTo
    const canonicalReplyTarget =
      replyTarget != null
        ? await resolveCanonicalThreadMessage(get, replyTarget)
        : null
    const threadParentId = parent.id
    const replyTargetId =
      canonicalReplyTarget &&
      (canonicalReplyTarget.id === threadParentId ||
        canonicalReplyTarget.parent_message_id === threadParentId)
        ? canonicalReplyTarget.id
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

    try {
      await getRendererEncryptedChat().editText(scopeFromTopic(targetId, topic), messageId, newContent)
      set({ editingMessage: null, encryptionError: null })
    } catch {
      set({ encryptionError: 'Edit could not be encrypted. Please try again.' })
    }
  },

  deleteMessage: (_targetId, topic, messageId) => {
    void getRendererEncryptedChat().deleteMessage(
      scopeFromTopic(_targetId, topic),
      messageId
    )
  },

  // Reactions
  addReaction: async (targetId, topic, messageId, emoji) => {
    await getRendererEncryptedChat().addReaction(scopeFromTopic(targetId, topic), messageId, emoji)
    const senderId = useAuthStore.getState().user?.id
    if (senderId) {
      await handleReactionUpdate(
        targetId,
        {
          action: 'add',
          message_id: messageId,
          sender_id: senderId,
          emoji
        },
        set
      )
    }
  },

  removeReaction: async (targetId, topic, messageId, emoji) => {
    await getRendererEncryptedChat().removeReaction(
      scopeFromTopic(targetId, topic),
      messageId,
      emoji
    )
    const senderId = useAuthStore.getState().user?.id
    if (senderId) {
      await handleReactionUpdate(
        targetId,
        {
          action: 'remove',
          message_id: messageId,
          sender_id: senderId,
          emoji
        },
        set
      )
    }
  },

  // Pinning
  pinMessage: (topic, messageId) => {
    const targetId = topic.replace(/^chat:channel:|^dm:/, '')
    void getRendererEncryptedChat().pinMessage(scopeFromTopic(targetId, topic), messageId)
  },

  unpinMessage: (topic, messageId) => {
    const targetId = topic.replace(/^chat:channel:|^dm:/, '')
    void getRendererEncryptedChat().unpinMessage(scopeFromTopic(targetId, topic), messageId)
  },

  fetchPinnedMessages: async (channelId) => {
    try {
      const pinsRaw = await getRendererClient().listChannelPins(channelId)
      const pinMessages = await processIncomingMessageBatch(
        channelId,
        pinsRaw.map((pin) => pin.message)
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
        const rawMessages = (
          await getRendererClient().fetchChannelMessages(channelId, {
            limit: 50,
            before: oldest.inserted_at
          })
        ).reverse()
        const olderMessages = await processIncomingMessageBatch(channelId, rawMessages)
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

    const indexedResults = await getStorageRuntime().searchDecryptedMessages(trimmed)
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
    fireAndForget(getStorageRuntime().removeFromFtsIndex(messageId))
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
    fireAndForget(getStorageRuntime().removeFromFtsIndex(messageId))
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

function upsertThreadReplyState(
  state: MessageState,
  message: Message
): Partial<MessageState> {
  const parentId = message.parent_message_id
  if (!parentId) {
    return {}
  }

  const existingReplies = state.threadRepliesByParent[parentId]
  const shouldTrackThread = state.activeThreadParentId === parentId || Array.isArray(existingReplies)
  if (!shouldTrackThread) {
    return {}
  }

  const replies = existingReplies ?? []
  const nextReplies = [...replies]
  const optimisticIndex =
    message.client_nonce != null
      ? nextReplies.findIndex((reply) => reply.client_nonce === message.client_nonce)
      : -1

  if (optimisticIndex !== -1) {
    nextReplies[optimisticIndex] = {
      ...nextReplies[optimisticIndex],
      ...message
    }
  } else {
    const messageIndex = nextReplies.findIndex((reply) => reply.id === message.id)
    if (messageIndex !== -1) {
      nextReplies[messageIndex] = {
        ...nextReplies[messageIndex],
        ...message
      }
    } else {
      nextReplies.push(message)
    }
  }

  return {
    threadRepliesByParent: {
      ...state.threadRepliesByParent,
      [parentId]: nextReplies
    }
  }
}

function patchThreadReplyStateByClientNonce(
  state: MessageState,
  clientNonce: string,
  updateMessage: (message: Message) => Message
): Partial<MessageState> {
  let changed = false
  const nextRepliesByParent: Record<string, Message[]> = {}

  for (const [parentId, replies] of Object.entries(state.threadRepliesByParent)) {
    const nextReplies = replies.map((reply) => {
      if (reply.client_nonce !== clientNonce) {
        return reply
      }

      changed = true
      return updateMessage(reply)
    })
    nextRepliesByParent[parentId] = nextReplies
  }

  if (!changed) {
    return {}
  }

  return {
    threadRepliesByParent: nextRepliesByParent
  }
}

function findCanonicalMessageByClientNonce(
  state: MessageState,
  scopeId: string,
  clientNonce: string
): Message | null {
  const directMatch = (state.messagesByChannel[scopeId] ?? []).find(
    (message) => message.client_nonce === clientNonce && !message.id.startsWith('local:')
  )
  if (directMatch) {
    return directMatch
  }

  for (const replies of Object.values(state.threadRepliesByParent)) {
    const replyMatch = replies.find(
      (message) => message.client_nonce === clientNonce && !message.id.startsWith('local:')
    )
    if (replyMatch) {
      return replyMatch
    }
  }

  return null
}

async function resolveCanonicalThreadMessage(
  get: () => MessageState,
  message: Message
): Promise<Message> {
  const clientNonce = message.client_nonce
  const scopeId = message.channel_id ?? message.conversation_id
  if (!clientNonce || !scopeId || !message.id.startsWith('local:')) {
    return message
  }

  const existing = findCanonicalMessageByClientNonce(get(), scopeId, clientNonce)
  if (existing) {
    return existing
  }

  if (message.channel_id) {
    await get().fetchMessages(message.channel_id).catch(() => {})
  } else if (message.conversation_id) {
    await get().fetchDmMessages(message.conversation_id).catch(() => {})
  }

  const resolved = findCanonicalMessageByClientNonce(get(), scopeId, clientNonce)
  return resolved ?? message
}

function rekeyThreadStateForCanonicalMessage(
  state: MessageState,
  optimisticMessage: Message,
  canonicalMessage: Message
): Partial<MessageState> {
  if (optimisticMessage.id === canonicalMessage.id) {
    return {}
  }

  const patch: Partial<MessageState> = {}

  if (state.activeThreadParentId === optimisticMessage.id) {
    patch.activeThreadParentId = canonicalMessage.id
  }

  if (state.activeThreadParent?.id === optimisticMessage.id) {
    patch.activeThreadParent = {
      ...state.activeThreadParent,
      ...canonicalMessage,
      delivery_state: 'sent'
    }
  }

  const optimisticReplies = state.threadRepliesByParent[optimisticMessage.id]
  if (optimisticReplies) {
    const nextRepliesByParent = { ...state.threadRepliesByParent }
    const existingReplies = nextRepliesByParent[canonicalMessage.id] ?? []
    nextRepliesByParent[canonicalMessage.id] = [...existingReplies, ...optimisticReplies]
    delete nextRepliesByParent[optimisticMessage.id]
    patch.threadRepliesByParent = nextRepliesByParent
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
): Promise<boolean> {
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
        const decrypted = await getRendererEncryptedChat().decryptOpaque(
          scopeForId(targetId),
          msg.ciphertext,
          (msg.mls_epoch as number | null | undefined) ?? null
        )
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
    return false
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
  return true
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
      },
      ...upsertThreadReplyState(s, message)
    }
  })
}

function updateOptimisticMessageState(
  targetId: string,
  clientNonce: string,
  deliveryState: 'sending' | 'sent' | 'failed',
  set: (fn: (s: MessageState) => Partial<MessageState>) => void
): void {
  set((s) => {
    const updatedMessages = (s.messagesByChannel[targetId] ?? []).map((message) =>
      message.client_nonce === clientNonce
        ? { ...message, delivery_state: deliveryState }
        : message
    )
    const nextWindow = applyMessageWindow(updatedMessages, 'append')

    return {
      messagesByChannel: {
        ...s.messagesByChannel,
        [targetId]: nextWindow.messages
      },
      hasMore: {
        ...s.hasMore,
        [targetId]: (s.hasMore[targetId] ?? false) || nextWindow.trimmedOlder
      },
      ...patchThreadReplyStateByClientNonce(s, clientNonce, (message) => ({
        ...message,
        delivery_state: deliveryState
      }))
    }
  })
}

function findMessageInStateById(state: MessageState, messageId: string): Message | null {
  if (state.activeThreadParent?.id === messageId) {
    return state.activeThreadParent
  }

  for (const messages of Object.values(state.messagesByChannel)) {
    const message = messages.find((entry) => entry.id === messageId)
    if (message) {
      return message
    }
  }

  return null
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
      const optimisticMessage = existing[optimisticIndex]
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
        },
        ...rekeyThreadStateForCanonicalMessage(s, optimisticMessage, {
          ...incoming,
          delivery_state: 'sent'
        }),
        ...upsertThreadReplyState(s, {
          ...incoming,
          delivery_state: 'sent'
        })
      }
    }

    if (existing.some((message) => message.id === incoming.id)) {
      return {
        latestRoomSeqByScope: updateLatestRoomSeqByScope(
          s.latestRoomSeqByScope,
          targetId,
          incoming.room_seq
        ),
        ...upsertThreadReplyState(s, incoming)
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
      },
      ...upsertThreadReplyState(s, incoming)
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
  msg: VesperMessage
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
  const lastKnownEpoch = msg.mls_epoch ?? null

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
    fireAndForget(recoverEncryptedScope(
      {
        kind: message.channel_id ? 'channel' : 'dm',
        targetId,
        scopeId,
        topic
      },
      useMessageStore.getState,
      lastKnownEpoch,
      'decrypt_failed'
    ))
  } else if (topic) {
    void maybeRequestMlsJoin(targetId, topic)
  }
}

function applyProcessedIncomingMessage(
  targetId: string,
  message: Message,
  msg: VesperMessage,
  set: (fn: (s: MessageState) => Partial<MessageState>) => void
): void {
  scheduleIncomingMessageSideEffects(targetId, message)
  maybeRecoverIncomingMessageScope(targetId, message, msg)
  syncChannelActivity(message)
  syncDmConversationActivity(message)
  mergeIncomingMessage(targetId, { ...message, delivery_state: 'sent' }, set)
}


async function processIncomingMessageBatch(
  targetId: string,
  rawMessages: VesperMessage[]
): Promise<Message[]> {
  const resolvedPlaintexts = new Array<string | null | undefined>(rawMessages.length)
  const ciphertextsToDecrypt: string[] = []
  const ciphertextIndexes: number[] = []

  for (const [index, message] of rawMessages.entries()) {
    if (!message.ciphertext) {
      continue
    }

    const messageId = message.id
    const ciphertextB64 = message.ciphertext
    const cachedPlaintext =
      getCachedDecryption(messageId) ??
      (await getStoredSentMessage(getStorageRuntime(), ciphertextB64)) ??
      (await getStorageRuntime().loadCachedMessageDecryption(messageId))

    if (cachedPlaintext !== null) {
      resolvedPlaintexts[index] = cachedPlaintext
      continue
    }

    resolvedPlaintexts[index] = null
    ciphertextsToDecrypt.push(ciphertextB64)
    ciphertextIndexes.push(index)
  }

  if (ciphertextsToDecrypt.length > 0 && useAuthStore.getState().canUseE2EE) {
    const decryptedBatch = await getRendererEncryptedChat().decryptOpaqueBatch(
      scopeForId(targetId),
      ciphertextIndexes.map((messageIndex, batchIndex) => ({
        ciphertext: ciphertextsToDecrypt[batchIndex],
        messageEpoch: rawMessages[messageIndex]?.mls_epoch ?? null
      }))
    )

    decryptedBatch.forEach((plaintext, batchIndex) => {
      const messageIndex = ciphertextIndexes[batchIndex]
      resolvedPlaintexts[messageIndex] = plaintext
    })
  }

  return Promise.all(
    rawMessages.map((message, index) =>
      processIncomingMessage(targetId, message, resolvedPlaintexts[index])
    )
  )
}

/**
 * Process an incoming message — decrypt if encrypted, pass through if plaintext.
 */
async function processIncomingMessage(
  targetId: string,
  msg: VesperMessage,
  resolvedPlaintext?: string | null
): Promise<Message> {
  if (msg.ciphertext) {
    const messageId = msg.id
    const ciphertextB64 = msg.ciphertext
    const senderId = msg.sender_id ?? null
    const mlsEpoch = msg.mls_epoch ?? null
    const plaintext =
      resolvedPlaintext !== undefined
        ? resolvedPlaintext
        : (getCachedDecryption(messageId) ??
            (await getStoredSentMessage(getStorageRuntime(), ciphertextB64)) ??
            (await getStorageRuntime().loadCachedMessageDecryption(messageId)) ??
            (useAuthStore.getState().canUseE2EE
              ? await getRendererEncryptedChat().decryptOpaque(
                  scopeForId(targetId),
                  ciphertextB64,
                  mlsEpoch
                )
              : null))

    if (plaintext) {
      setCachedDecryption(messageId, plaintext)
    }

    try {
      await getStorageRuntime().cacheMessage({
        id: messageId,
        roomSeq: getRoomSeq(msg.room_seq),
        channelId: msg.channel_id ?? null,
        conversationId: msg.conversation_id ?? null,
        serverId: msg.server_id ?? null,
        senderId,
        senderUsername: (msg.sender as MessageSender)?.username ?? null,
        parentMessageId: msg.parent_message_id ?? null,
        ciphertext: base64ToUint8(ciphertextB64),
        decryptedContent: plaintext,
        mlsEpoch,
        insertedAt: msg.inserted_at
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
      fireAndForget(
        getStorageRuntime().indexDecryptedMessage(messageId, targetId, searchableText)
      )
    }

    return {
      id: messageId,
      room_seq: getRoomSeq(msg.room_seq),
      content: displayContent,
      channel_id: msg.channel_id ?? null,
      conversation_id: msg.conversation_id ?? null,
      server_id: msg.server_id ?? null,
      sender_id: senderId,
      sender: (msg.sender as MessageSender) ?? null,
      inserted_at: msg.inserted_at,
      expires_at: msg.expires_at ?? null,
      parent_message_id: msg.parent_message_id ?? null,
      attachments: (msg.attachments as Attachment[] | undefined) ?? [],
      reactions: await resolveReactionGroups(targetId, msg.reactions as RawReaction[] | undefined),
      encrypted: true,
      decryptionFailed: !plaintext,
      mls_epoch: mlsEpoch,
      edited_at: msg.edited_at ?? undefined,
      client_nonce: msg.client_nonce ?? undefined,
      delivery_state: 'sent'
    }
  }

  const plaintextMessage: Message = {
    id: msg.id,
    room_seq: getRoomSeq(msg.room_seq),
    content: msg.content ?? '',
    channel_id: msg.channel_id ?? null,
    conversation_id: msg.conversation_id ?? null,
    server_id: msg.server_id ?? null,
    sender_id: msg.sender_id ?? null,
    sender: (msg.sender as MessageSender) ?? null,
    inserted_at: msg.inserted_at,
    expires_at: msg.expires_at ?? null,
    parent_message_id: msg.parent_message_id ?? null,
    attachments: (msg.attachments as Attachment[] | undefined) ?? [],
    reactions: await resolveReactionGroups(targetId, msg.reactions as RawReaction[] | undefined),
    edited_at: msg.edited_at ?? undefined,
    client_nonce: msg.client_nonce ?? undefined,
    delivery_state: 'sent'
  }

  const plaintextSearchText = getMessageSearchText(plaintextMessage)
  if (plaintextSearchText) {
    fireAndForget(
      getStorageRuntime().indexDecryptedMessage(plaintextMessage.id, targetId, plaintextSearchText)
    )
  }

  try {
    await getStorageRuntime().cacheMessage({
      id: plaintextMessage.id,
      roomSeq: plaintextMessage.room_seq ?? null,
      channelId: plaintextMessage.channel_id,
      conversationId: plaintextMessage.conversation_id,
      serverId: plaintextMessage.server_id ?? null,
      senderId: plaintextMessage.sender_id,
      senderUsername: plaintextMessage.sender?.username ?? null,
      parentMessageId: plaintextMessage.parent_message_id,
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

function buildProvisionalMessage(msg: VesperMessage): Message {
  const isEncrypted = Boolean(msg.ciphertext)

  return {
    id: msg.id,
    room_seq: getRoomSeq(msg.room_seq),
    content: isEncrypted
      ? (canUseEncryptedFeatures()
          ? ENCRYPTED_MESSAGE_SYNCING_PLACEHOLDER
          : ENCRYPTED_MESSAGE_APPROVAL_PLACEHOLDER)
      : (msg.content ?? ''),
    channel_id: msg.channel_id ?? null,
    conversation_id: msg.conversation_id ?? null,
    server_id: msg.server_id ?? null,
    sender_id: msg.sender_id ?? null,
    sender: (msg.sender as MessageSender) ?? null,
    inserted_at: msg.inserted_at,
    expires_at: msg.expires_at ?? null,
    parent_message_id: msg.parent_message_id ?? null,
    attachments: (msg.attachments as Attachment[] | undefined) ?? [],
    reactions: [],
    encrypted: isEncrypted,
    decryptionFailed: false,
    edited_at: msg.edited_at ?? undefined,
    client_nonce: msg.client_nonce ?? undefined,
    delivery_state: 'sent'
  }
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
      (await getStoredSentMessage(getStorageRuntime(), ciphertextB64)) ??
      (await getRendererEncryptedChat().decryptOpaque(
        scopeForId(targetId),
        ciphertextB64,
        (msg.mls_epoch as number | null | undefined) ?? null
      ))

    if (plaintext) {
      setCachedDecryption(messageId, plaintext)
      await getStorageRuntime().saveCachedMessageDecryption(messageId, plaintext).catch(() => {})
      const payload = decodePayload(plaintext)
      if (payload.type === 'text') {
        newContent = payload.text
        fireAndForget(getStorageRuntime().indexDecryptedMessage(messageId, targetId, payload.text))
      } else {
        newContent = JSON.stringify({
          type: payload.type,
          text: payload.text,
          file: payload.file
        })
        const fileSearchText = [payload.text || '', payload.file.name].filter(Boolean).join(' ')
        if (fileSearchText) {
          fireAndForget(
            getStorageRuntime().indexDecryptedMessage(messageId, targetId, fileSearchText)
          )
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
  fireAndForget(getStorageRuntime().removeFromFtsIndex(messageId))

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

async function applyScopeMutationEvent(
  targetId: string,
  eventType: string,
  msg: Record<string, unknown>,
  set: (fn: (s: MessageState) => Partial<MessageState>) => void
): Promise<void> {
  const roomSeq = getRoomSeq(msg.room_seq)
  if (hasSeenScopeMutationSeq(targetId, roomSeq)) {
    return
  }

  if (eventType === 'reaction_update') {
    const applied = await handleReactionUpdate(targetId, msg, set)
    if (applied) {
      rememberScopeMutationSeq(targetId, roomSeq)
    }
    return
  }

  if (eventType === 'message_edited') {
    await handleMessageEdited(targetId, msg, set)
    rememberScopeMutationSeq(targetId, roomSeq)
    return
  }

  if (eventType === 'message_deleted') {
    handleMessageDeleted(targetId, msg, set)
    rememberScopeMutationSeq(targetId, roomSeq)
    return
  }

  if (eventType === 'message_pinned') {
    handlePinBroadcast(targetId, msg, set, 'pin')
    rememberScopeMutationSeq(targetId, roomSeq)
    return
  }

  if (eventType === 'message_unpinned') {
    handlePinBroadcast(targetId, msg, set, 'unpin')
    rememberScopeMutationSeq(targetId, roomSeq)
  }
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
  if (hasSeenScopeMutationSeq(targetId, roomSeq)) {
    return
  }

  const payload =
    roomSeq == null
      ? syncEvent.payload ?? {}
      : { ...(syncEvent.payload ?? {}), room_seq: roomSeq }
  await applyScopeMutationEvent(targetId, syncEvent.event_type, payload, set)
}
