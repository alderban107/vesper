import { create } from 'zustand'
import { apiFetch } from '../api/client'
import { joinChannel, leaveChannel, pushToChannel } from '../api/socket'
import { useCryptoStore } from './cryptoStore'
import { useAuthStore } from './authStore'
import { useVoiceStore } from './voiceStore'
import { useServerStore } from './serverStore'
import { useDmStore } from './dmStore'
import { usePresenceStore } from './presenceStore'
import { replaceEmojiShortcodes } from '../utils/emoji'
import {
  cacheMessage as cacheMessageToDb,
  loadCachedMessageDecryption,
  searchDecryptedMessages,
  saveCachedMessageDecryption,
  indexDecryptedMessage as indexToFts,
  removeFromFtsIndex
} from '../crypto/storage'
import {
  ackPendingWelcome,
  ackPendingResyncRequest,
  base64ToUint8,
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
const MLS_RESYNC_REQUEST_COOLDOWN_MS = 5000
const recentMlsResyncRequests = new Map<string, number>()
const MLS_RECOVERY_BACKOFF_MS = [150, 500, 1500] as const
const ENCRYPTED_MESSAGE_SYNCING_PLACEHOLDER = 'Encrypted message is syncing...'
const ENCRYPTED_MESSAGE_APPROVAL_PLACEHOLDER = 'Approve this device to read encrypted messages.'
const inFlightScopeRecoveries = new Map<string, Promise<void>>()

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
  pushToChannel(topic, 'mls_request_join', {})
}

interface PendingMlsResyncRequest {
  id?: string
  requester_id: string
  requester_username?: string | null
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
  const userId = useAuthStore.getState().user?.id
  const crypto = useCryptoStore.getState()

  if (!requesterId || requesterId === userId || !crypto.hasGroup(targetId)) {
    return false
  }

  const result = await crypto.handleResyncRequest(targetId, requesterId, requesterUsername)
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
      welcome_data: result.welcomeBytes
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

    const result = await crypto.handleJoinRequest(
      conversationId,
      participant.user_id,
      participant.user.username
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
        welcome_data: result.welcomeBytes
      })
    }
  }

  return useCryptoStore.getState().hasGroup(conversationId)
}

async function waitForDmBootstrap(
  conversationId: string,
  timeoutMs = 2000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
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

    const result = await crypto.handleJoinRequest(
      conversationId,
      participant.user_id,
      participant.user.username
    )

    if (!result) continue

    pushToChannel(topic, 'mls_commit', {
      commit_data: result.commitBytes
    })

    if (result.welcomeBytes) {
      pushToChannel(topic, 'mls_welcome', {
        recipient_id: participant.user_id,
        welcome_data: result.welcomeBytes
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
  pushToChannel(topic, 'mls_request_join', {})

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
  maybeRequestMlsResync(
    scope.targetId,
    scope.scopeId,
    scope.topic,
    lastKnownEpoch,
    reason
  )
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

  const key = getScopeRecoveryKey(scope)
  const existing = inFlightScopeRecoveries.get(key)
  if (existing) {
    return existing
  }

  const run = (async () => {
    const crypto = useCryptoStore.getState()

    const tryRecoveryRound = async (roundReason: string): Promise<boolean> => {
      requestEncryptedScopeRecovery(scope, lastKnownEpoch, roundReason)
      await ensureEncryptedScopeMembership(scope).catch(() => {})
      await refreshEncryptedScope(scope, getState).catch(() => {})

      if (!hasFailedMessagesInScope(scope, getState)) {
        return true
      }

      for (const delayMs of MLS_RECOVERY_BACKOFF_MS) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        requestEncryptedScopeRecovery(scope, lastKnownEpoch, roundReason)
        await ensureEncryptedScopeMembership(scope).catch(() => {})
        await refreshEncryptedScope(scope, getState).catch(() => {})

        if (!hasFailedMessagesInScope(scope, getState)) {
          return true
        }
      }

      return false
    }

    if (await tryRecoveryRound(reason)) {
      return
    }

    if (crypto.hasGroup(scope.targetId)) {
      await crypto.resetGroup(scope.targetId).catch(() => {})
    }

    await tryRecoveryRound('local_state_reset')
  })().finally(() => {
    inFlightScopeRecoveries.delete(key)
  })

  inFlightScopeRecoveries.set(key, run)
  return run
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
  getState: () => MessageState
): Promise<void> {
  await refreshEncryptedScope(scope, getState).catch(() => {})

  if (hasFailedMessagesInScope(scope, getState)) {
    void recoverEncryptedScope(scope, getState, null, 'post_crypto_update').catch(() => {})
  }

  await processPendingMlsResyncRequests(scope.targetId, scope.scopeId, scope.topic).catch(() => {})
}

export interface ReactionGroup {
  emoji: string
  senderIds: string[]
}

export interface Message {
  id: string
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
  typingUsers: Record<string, TypingUser[]>
  hasMore: Record<string, boolean>
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
  fetchMessages: (channelId: string) => Promise<void>
  fetchOlderMessages: (channelId: string) => Promise<void>
  sendMessage: (channelId: string, content: string, parentMessageId?: string) => Promise<void>
  sendTypingStart: (channelId: string) => void
  sendTypingStop: (channelId: string) => void

  // DM conversation support
  joinDmChat: (conversationId: string) => void
  leaveDmChat: (conversationId: string) => void
  fetchDmMessages: (conversationId: string) => Promise<void>
  fetchOlderDmMessages: (conversationId: string) => Promise<void>
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
  typingUsers: {},
  hasMore: {},
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
          request_id: msg.request_id as string | undefined,
          last_known_epoch: (msg.last_known_epoch as number | null | undefined) ?? null,
          reason: (msg.reason as string | null | undefined) ?? null
        }).catch(() => {})
      } else if (event === 'mls_commit') {
        const senderId = msg.sender_id as string
        const userId = useAuthStore.getState().user?.id
        if (senderId !== userId) {
          void useCryptoStore
            .getState()
            .handleCommit(channelId, msg.commit_data as string)
            .then(async () => refreshScopeAfterCryptoUpdate(scope, get))
            .catch(() => {})
        }
      } else if (event === 'mls_welcome') {
        const recipientId = msg.recipient_id as string
        const userId = useAuthStore.getState().user?.id
        if (recipientId === userId) {
          const welcomeId = typeof msg.id === 'string' ? msg.id : null
          void useCryptoStore
            .getState()
            .handleWelcome(channelId, msg.welcome_data as string)
            .then(async (processed) => {
              if (processed) {
                if (welcomeId) {
                  await ackPendingWelcome(welcomeId).catch(() => {})
                }
                await refreshScopeAfterCryptoUpdate(scope, get)
              }
            })
            .catch(() => {})
        }
      } else if (event === 'mls_remove') {
        const userId = useAuthStore.getState().user?.id
        const removedId = msg.removed_user_id as string
        if (removedId === userId) {
          useCryptoStore.getState().resetGroup(channelId)
        } else {
          if (msg.commit_data) {
            useCryptoStore.getState().handleCommit(channelId, msg.commit_data as string)
          }
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
        .then(() => {
          if (!useCryptoStore.getState().hasGroup(channelId)) {
            maybeRequestMlsJoin(channelId, topic)
            maybeRequestMlsResync(channelId, channelId, topic, null, 'missing_state')
          }
        })
        .catch(() => {
          // Continue without encryption
        })
        .finally(() => {
          get().fetchMessages(channelId)
          void processPendingMlsResyncRequests(channelId, channelId, topic).catch(() => {})
        })
    } else {
      void get().fetchMessages(channelId)
    }
  },

  leaveChannelChat: (channelId) => {
    leaveChannel(`chat:channel:${channelId}`)
  },

  fetchMessages: async (channelId) => {
    try {
      const res = await apiFetch(`/api/v1/channels/${channelId}/messages?limit=50`)
      if (res.ok) {
        const data = await res.json()
        const rawMessages = (data.messages as Record<string, unknown>[]).reverse()
        const messages = await Promise.all(
          rawMessages.map((m) => processIncomingMessage(channelId, m))
        )
        scheduleExpiryTimers(channelId, messages)
        set((s) => ({
          messagesByChannel: {
            ...s.messagesByChannel,
            [channelId]: messages
          },
          hasMore: {
            ...s.hasMore,
            [channelId]: data.messages.length === 50
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
    }
  },

  fetchOlderMessages: async (channelId) => {
    const existing = get().messagesByChannel[channelId] || []
    if (existing.length === 0) return

    const oldest = existing[0]
    try {
      const res = await apiFetch(
        `/api/v1/channels/${channelId}/messages?limit=50&before=${oldest.inserted_at}`
      )
      if (res.ok) {
        const data = await res.json()
        const rawMessages = (data.messages as Record<string, unknown>[]).reverse()
        const olderMessages = await Promise.all(
          rawMessages.map((m) => processIncomingMessage(channelId, m))
        )
        set((s) => ({
          messagesByChannel: {
            ...s.messagesByChannel,
            [channelId]: [...olderMessages, ...existing]
          },
          hasMore: {
            ...s.hasMore,
            [channelId]: data.messages.length === 50
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
    const resolvedContent = replaceEmojiShortcodes(content, activeServer?.emojis ?? [])
    const payloadStr = encodePayload({ v: 1, type: 'text', text: resolvedContent })
    const topic = `chat:channel:${channelId}`

    if (!crypto.hasGroup(channelId)) {
      const ready = await ensureChannelGroupReady(channelId)
      if (!ready) {
        set({ encryptionError: 'Message could not be encrypted. Please try again.' })
        return
      }
    }

    if (crypto.hasGroup(channelId)) {
      const encrypted = await crypto.encryptForChannel(channelId, payloadStr)
      if (encrypted) {
        cacheSentPlaintext(encrypted.ciphertext, resolvedContent)
        pushToChannel(topic, 'new_message', {
          ciphertext: encrypted.ciphertext,
          mls_epoch: encrypted.epoch,
          ...(parentId && { parent_message_id: parentId }),
          ...(mentionedUserIds.length > 0 && { mentioned_user_ids: mentionedUserIds })
        })
        set({
          ...(shouldClearInlineReply ? { replyingTo: null } : {}),
          encryptionError: null
        })
        return
      }
    }

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
          request_id: msg.request_id as string | undefined,
          last_known_epoch: (msg.last_known_epoch as number | null | undefined) ?? null,
          reason: (msg.reason as string | null | undefined) ?? null
        }).catch(() => {})
      } else if (event === 'mls_commit') {
        const senderId = msg.sender_id as string
        const userId = useAuthStore.getState().user?.id
        if (senderId !== userId) {
          void useCryptoStore
            .getState()
            .handleCommit(conversationId, msg.commit_data as string)
            .then(async () => refreshScopeAfterCryptoUpdate(scope, get))
            .catch(() => {})
        }
      } else if (event === 'mls_welcome') {
        const recipientId = msg.recipient_id as string
        const userId = useAuthStore.getState().user?.id
        if (recipientId === userId) {
          const welcomeId = typeof msg.id === 'string' ? msg.id : null
          void useCryptoStore
            .getState()
            .handleWelcome(conversationId, msg.welcome_data as string)
            .then(async (processed) => {
              if (processed) {
                if (welcomeId) {
                  await ackPendingWelcome(welcomeId).catch(() => {})
                }
                await refreshScopeAfterCryptoUpdate(scope, get)
              }
            })
            .catch(() => {})
        }
      } else if (event === 'mls_remove') {
        const userId = useAuthStore.getState().user?.id
        const removedId = msg.removed_user_id as string
        if (removedId === userId) {
          useCryptoStore.getState().resetGroup(conversationId)
        } else {
          if (msg.commit_data) {
            useCryptoStore.getState().handleCommit(conversationId, msg.commit_data as string)
          }
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
      useCryptoStore
        .getState()
        .ensureGroupMembership(conversationId)
        .then(async () => {
          if (!useCryptoStore.getState().hasGroup(conversationId)) {
            const bootstrapped = await bootstrapDmGroupIfLeader(conversationId, topic)
            if (bootstrapped || useCryptoStore.getState().hasGroup(conversationId)) {
              return
            }

            // Not the leader — try force-bootstrapping as fallback
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
          get().fetchDmMessages(conversationId)
          void processPendingMlsResyncRequests(conversationId, conversationId, topic).catch(() => {})
        })
    } else {
      void get().fetchDmMessages(conversationId)
    }
  },

  leaveDmChat: (conversationId) => {
    leaveChannel(`dm:${conversationId}`)
  },

  fetchDmMessages: async (conversationId) => {
    try {
      const res = await apiFetch(
        `/api/v1/conversations/${conversationId}/messages?limit=50`
      )
      if (res.ok) {
        const data = await res.json()
        const rawMessages = (data.messages as Record<string, unknown>[]).reverse()
        const messages = await Promise.all(
          rawMessages.map((m) => processIncomingMessage(conversationId, m))
        )
        scheduleExpiryTimers(conversationId, messages)
        set((s) => ({
          messagesByChannel: {
            ...s.messagesByChannel,
            [conversationId]: messages
          },
          hasMore: {
            ...s.hasMore,
            [conversationId]: data.messages.length === 50
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
    }
  },

  fetchOlderDmMessages: async (conversationId) => {
    const existing = get().messagesByChannel[conversationId] || []
    if (existing.length === 0) return

    const oldest = existing[0]
    try {
      const res = await apiFetch(
        `/api/v1/conversations/${conversationId}/messages?limit=50&before=${oldest.inserted_at}`
      )
      if (res.ok) {
        const data = await res.json()
        const rawMessages = (data.messages as Record<string, unknown>[]).reverse()
        const olderMessages = await Promise.all(
          rawMessages.map((m) => processIncomingMessage(conversationId, m))
        )
        set((s) => ({
          messagesByChannel: {
            ...s.messagesByChannel,
            [conversationId]: [...olderMessages, ...existing]
          },
          hasMore: {
            ...s.hasMore,
            [conversationId]: data.messages.length === 50
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
    const payloadStr = encodePayload({ v: 1, type: 'text', text: content })

    // Try encrypting with existing group, or create a new one
    const encrypted = crypto.hasGroup(conversationId)
      ? await crypto.encryptForChannel(conversationId, payloadStr)
      : null

    if (encrypted) {
      cacheSentPlaintext(encrypted.ciphertext, content)
      pushToChannel(topic, 'new_message', {
        ciphertext: encrypted.ciphertext,
        mls_epoch: encrypted.epoch,
        ...(parentId && { parent_message_id: parentId })
      })
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
      pushToChannel(topic, 'new_message', {
        ciphertext: freshEncrypted.ciphertext,
        mls_epoch: freshEncrypted.epoch,
        ...(parentId && { parent_message_id: parentId })
      })
      if (shouldClearInlineReply) {
        set({ replyingTo: null })
      }
      set({ encryptionError: null })
      return
    }

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

      const parent = await processIncomingMessage(targetId, parentPayload)
      const replyPayloads = data.messages ?? []
      const replies = await Promise.all(
        replyPayloads.map((entry) => processIncomingMessage(targetId, entry))
      )

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

    const trimmed = content.trim()
    if (!trimmed) {
      return
    }

    if (parent.channel_id) {
      await get().sendMessage(parent.channel_id, trimmed, parent.id)
      return
    }

    if (parent.conversation_id) {
      await get().sendDmMessage(parent.conversation_id, trimmed, parent.id)
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
      const pins = await Promise.all(
        pinsRaw.map(async (pin) => ({
          id: pin.id,
          message: await processIncomingMessage(channelId, pin.message),
          pinned_by_id: pin.pinned_by_id,
          inserted_at: pin.inserted_at
        }))
      )

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
        const olderMessages = await Promise.all(
          rawMessages.map((entry) => processIncomingMessage(channelId, entry))
        )
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
      ...threadPatch
    }
  })

}

/**
 * Handle a new real-time message (from WebSocket broadcast).
 */
async function handleNewMessage(
  targetId: string,
  msg: Record<string, unknown>,
  set: (fn: (s: MessageState) => Partial<MessageState>) => void
): Promise<void> {
  const processed = await processIncomingMessage(targetId, msg)

  if (processed.expires_at) {
    scheduleMessageExpiry(targetId, processed.id, processed.expires_at)
  }

  // Update member entry with fresh sender data so display names stay current
  if (processed.sender_id && processed.sender) {
    useServerStore.getState().updateMemberUser(processed.sender_id, {
      display_name: processed.sender.display_name,
      username: processed.sender.username
    })
  }

  // Desktop notification for messages from others
  const myId = useAuthStore.getState().user?.id
  if (processed.sender_id && processed.sender_id !== myId) {
    const myStatus = usePresenceStore.getState().myStatus
    const notifEnabled = localStorage.getItem('notifications') !== 'disabled'
    if (notifEnabled && myStatus !== 'dnd' && !document.hasFocus()) {
      const notifApi = (window as Record<string, unknown>).notifications as {
        showMessageNotification: (d: {
          title: string; body: string; channelId?: string; conversationId?: string
        }) => void
      } | undefined

      notifApi?.showMessageNotification({
        title: processed.sender?.display_name || processed.sender?.username || 'New message',
        body: processed.encrypted ? 'Encrypted message' : (processed.content || '').slice(0, 100),
        channelId: processed.channel_id || undefined,
        conversationId: processed.conversation_id || undefined
      })
    }
  }

  if (
    useAuthStore.getState().canUseE2EE &&
    processed.encrypted &&
    processed.decryptionFailed &&
    processed.sender_id !== myId
  ) {
    const topic = processed.channel_id
      ? `chat:channel:${processed.channel_id}`
      : processed.conversation_id
        ? `dm:${processed.conversation_id}`
        : null
    const scopeId = processed.channel_id ?? processed.conversation_id ?? null
    const lastKnownEpoch = (msg.mls_epoch as number | null | undefined) ?? null

    if (topic && scopeId) {
      void recoverEncryptedScope(
        {
          kind: processed.channel_id ? 'channel' : 'dm',
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

  set((s) => ({
    messagesByChannel: {
      ...s.messagesByChannel,
      [targetId]: [...(s.messagesByChannel[targetId] || []), processed]
    }
  }))
}

/**
 * Process an incoming message — decrypt if encrypted, pass through if plaintext.
 */
async function processIncomingMessage(
  targetId: string,
  msg: Record<string, unknown>
): Promise<Message> {
  if (msg.ciphertext) {
    const messageId = msg.id as string
    const ciphertextB64 = msg.ciphertext as string
    const senderId = (msg.sender_id as string) || null
    const mlsEpoch = (msg.mls_epoch as number) ?? null
    const canUseE2EE = useAuthStore.getState().canUseE2EE
    const cachedPlaintext =
      getCachedDecryption(messageId) ??
      (await getStoredSentMessage(ciphertextB64)) ??
      (await loadCachedMessageDecryption(messageId))
    const plaintext =
      cachedPlaintext ??
      (canUseE2EE
        ? await useCryptoStore.getState().decryptForChannel(targetId, ciphertextB64)
        : null)

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
      encrypted: true,
      decryptionFailed: !plaintext,
      edited_at: (msg.edited_at as string) || undefined
    }
  }

  const plaintextMessage: Message = {
    id: msg.id as string,
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
    edited_at: (msg.edited_at as string) || undefined
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

// Per-group lock to serialize MLS join requests — concurrent commits cause epoch conflicts
const mlsJoinLocks = new Map<string, Promise<void>>()

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
  const crypto = useCryptoStore.getState()

  if (!crypto.hasGroup(targetId)) return

  // Serialize join requests per group to avoid concurrent epoch commits
  const prev = mlsJoinLocks.get(targetId) ?? Promise.resolve()
  const current = prev.then(async () => {
    const result = await useCryptoStore.getState().handleJoinRequest(targetId, userId, username)

    if (!result) return

    pushToChannel(topic, 'mls_commit', {
      commit_data: result.commitBytes
    })

    if (result.welcomeBytes) {
      pushToChannel(topic, 'mls_welcome', {
        recipient_id: userId,
        welcome_data: result.welcomeBytes
      })
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

  removeCachedDecryption(messageId)
  removeFromFtsIndex(messageId).catch(() => {})

  set((s) => ({
    messagesByChannel: {
      ...s.messagesByChannel,
      [targetId]: (s.messagesByChannel[targetId] || []).filter((m) => m.id !== messageId)
    },
    pinnedByChannel: {
      ...s.pinnedByChannel,
      [targetId]: (s.pinnedByChannel[targetId] || []).filter((pin) => pin.message.id !== messageId)
    },
    ...patchThreadStateForMessage(s, messageId, () => null)
  }))
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

  if (action === 'unpin' && messageId) {
    set((s) => ({
      pinnedByChannel: {
        ...s.pinnedByChannel,
        [channelId]: (s.pinnedByChannel[channelId] || []).filter((pin) => pin.message.id !== messageId)
      }
    }))
  }

  emitPinUpdate(channelId)
}
