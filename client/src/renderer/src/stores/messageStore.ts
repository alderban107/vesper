import { create } from 'zustand'
import { apiFetch } from '../api/client'
import { joinChannel, leaveChannel, pushToChannel } from '../api/socket'
import { useCryptoStore } from './cryptoStore'
import { useAuthStore } from './authStore'
import { useVoiceStore } from './voiceStore'
import { useServerStore } from './serverStore'
import { useDmStore } from './dmStore'
import { usePresenceStore } from './presenceStore'
import {
  cacheMessage,
  deleteCachedMessage,
  loadAllCachedMessages,
  loadCachedMessages,
  pruneMessageCache
} from '../crypto/storage'
import { scheduleSearchIndexSync } from '../crypto/searchIndexSync'

/**
 * Own-message plaintext resolution.
 *
 * MLS senders cannot decrypt their own ciphertext (the ratchet advances on
 * encrypt). We solve this with a three-tier lookup that covers every scenario:
 *
 *   1. In-memory Map   — fastest, covers the live send→broadcast loop
 *   2. localStorage     — synchronous, survives page crashes, shared across tabs
 *   3. IndexedDB cache  — survives localStorage clears, used for history reloads
 *
 * Plaintext is written to tiers 1+2 at send time (before the channel push),
 * and to tier 3 after the broadcast is processed with the server-assigned ID.
 */
const SENT_PREFIX = 'vsp:sent:'
const MEMORY_CACHE_MAX = 500
const LOCAL_MESSAGE_CACHE_MAX = 5000
const sentPlaintextCache = new Map<string, string>()

function ctKey(ciphertext: string): string {
  return ciphertext.slice(0, 48)
}

export function cacheSentPlaintext(ciphertext: string, plaintext: string): void {
  const key = ctKey(ciphertext)

  // Tier 1 — in-memory (bounded FIFO)
  if (sentPlaintextCache.size >= MEMORY_CACHE_MAX) {
    const oldest = sentPlaintextCache.keys().next().value
    if (oldest !== undefined) sentPlaintextCache.delete(oldest)
  }
  sentPlaintextCache.set(key, plaintext)

  // Tier 2 — localStorage (survives crashes, shared across tabs)
  try {
    localStorage.setItem(SENT_PREFIX + key, plaintext)
  } catch {
    // Storage full — non-fatal
  }
}

function lookupSentPlaintext(ciphertext: string): string | null {
  const key = ctKey(ciphertext)
  // Tier 1
  const mem = sentPlaintextCache.get(key)
  if (mem !== undefined) return mem
  // Tier 2
  try {
    const stored = localStorage.getItem(SENT_PREFIX + key)
    if (stored !== null) {
      sentPlaintextCache.set(key, stored) // promote to memory
      return stored
    }
  } catch {
    // Private browsing or quota — non-fatal
  }
  return null
}

function cleanupSentEntry(ciphertext: string): void {
  const key = ctKey(ciphertext)
  sentPlaintextCache.delete(key)
  try { localStorage.removeItem(SENT_PREFIX + key) } catch { /* */ }
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
  searchMessages: (query: string) => Promise<Message[]>
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
      } else if (event === 'mls_request_join') {
        handleMlsJoinRequest(channelId, msg, `chat:channel:${channelId}`)
      } else if (event === 'mls_commit') {
        const senderId = msg.sender_id as string
        const userId = useAuthStore.getState().user?.id
        if (senderId !== userId) {
          useCryptoStore.getState().handleCommit(channelId, msg.commit_data as string)
        }
      } else if (event === 'mls_welcome') {
        const recipientId = msg.recipient_id as string
        const userId = useAuthStore.getState().user?.id
        if (recipientId === userId) {
          useCryptoStore.getState().handleWelcome(channelId, msg.welcome_data as string)
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

    useCryptoStore
      .getState()
      .ensureGroupMembership(channelId)
      .then(() => {
        if (!useCryptoStore.getState().hasGroup(channelId)) {
          pushToChannel(topic, 'mls_request_join', {})
        }
      })
      .catch(() => {
        // Continue without encryption
      })

    get().fetchMessages(channelId)
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
      }
    } catch {
      // ignore
    }
  },

  sendMessage: async (channelId, content, parentMessageId) => {
    const crypto = useCryptoStore.getState()
    const replyingTo = get().replyingTo
    const parentId = parentMessageId ?? replyingTo?.id ?? undefined
    const shouldClearInlineReply = !parentMessageId
    const mentionedUserIds = extractMentionedUserIds(content)

    if (!crypto.hasGroup(channelId)) {
      await crypto.createGroup(channelId)
    }

    if (crypto.hasGroup(channelId)) {
      const encrypted = await crypto.encryptForChannel(channelId, content)
      if (encrypted) {
        cacheSentPlaintext(encrypted.ciphertext, content)
        pushToChannel(`chat:channel:${channelId}`, 'new_message', {
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
      } else if (event === 'mls_commit') {
        const senderId = msg.sender_id as string
        const userId = useAuthStore.getState().user?.id
        if (senderId !== userId) {
          useCryptoStore.getState().handleCommit(conversationId, msg.commit_data as string)
        }
      } else if (event === 'mls_welcome') {
        const recipientId = msg.recipient_id as string
        const userId = useAuthStore.getState().user?.id
        if (recipientId === userId) {
          useCryptoStore.getState().handleWelcome(conversationId, msg.welcome_data as string)
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

    useCryptoStore
      .getState()
      .ensureGroupMembership(conversationId)
      .then(() => {
        if (!useCryptoStore.getState().hasGroup(conversationId)) {
          pushToChannel(topic, 'mls_request_join', {})
        }
      })
      .catch(() => {
        // Continue without encryption
      })

    get().fetchDmMessages(conversationId)
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
      }
    } catch {
      // ignore
    }
  },

  sendDmMessage: async (conversationId, content, parentMessageId) => {
    const crypto = useCryptoStore.getState()
    const topic = `dm:${conversationId}`
    const replyingTo = get().replyingTo
    const parentId = parentMessageId ?? replyingTo?.id ?? undefined
    const shouldClearInlineReply = !parentMessageId

    // Try encrypting with existing group, or create a new one
    const encrypted = crypto.hasGroup(conversationId)
      ? await crypto.encryptForChannel(conversationId, content)
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

    // Encryption failed or no group — reset stale state and create fresh group with all members
    if (crypto.hasGroup(conversationId)) {
      crypto.resetGroup(conversationId)
    }

    await crypto.createGroup(conversationId)
    if (crypto.hasGroup(conversationId)) {
      const conversation = useDmStore
        .getState()
        .conversations.find((c) => c.id === conversationId)
      const myId = useAuthStore.getState().user?.id
      if (conversation && myId) {
        for (const participant of conversation.participants) {
          if (participant.user_id === myId) continue
          const result = (await crypto.handleJoinRequest(
            conversationId,
            participant.user_id
          )) as unknown as {
            commitBytes: string
            welcomeBytes: string | null
          } | void
          if (result) {
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
        }
      }

      const freshEncrypted = await crypto.encryptForChannel(conversationId, content)
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
        return
      }
    }

    set({ encryptionError: 'Message could not be encrypted. Please try again.' })
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
    const crypto = useCryptoStore.getState()

    if (crypto.hasGroup(targetId)) {
      const encrypted = await crypto.encryptForChannel(targetId, newContent)
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
  addReaction: (_targetId, topic, messageId, emoji) => {
    pushToChannel(topic, 'add_reaction', { message_id: messageId, emoji })
  },

  removeReaction: (_targetId, topic, messageId, emoji) => {
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

  // Search (client-side only to preserve E2EE guarantees)
  searchMessages: async (query) => {
    const trimmed = query.trim()
    if (trimmed.length < 2) return []

    const needle = trimmed.toLowerCase()
    const seen = new Map<string, Message>()

    for (const messages of Object.values(get().messagesByChannel)) {
      for (const message of messages) {
        if (!message || seen.has(message.id)) {
          continue
        }

        const parsed = parseMessageContent(message.content || '')
        const parsedText = parsed.type === 'text' ? parsed.text : (parsed.text || '')
        const parsedFileName = parsed.type === 'file' ? parsed.file.name : ''
        const attachmentNames = [
          ...(message.attachment_filenames || []),
          ...(message.attachments?.map((attachment) => attachment.filename).filter(Boolean) || [])
        ]
        const haystack = [parsedText, parsedFileName, ...attachmentNames]
          .join(' ')
          .toLowerCase()

        if (!haystack.includes(needle)) {
          continue
        }

        seen.set(message.id, {
          ...message,
          attachment_filenames: attachmentNames
        })
      }
    }

    const cachedRows = await loadAllCachedMessages()
    for (const row of cachedRows) {
      if (!row.content || seen.has(row.id)) {
        continue
      }

      const haystack = [row.content, ...row.attachmentFilenames].join(' ').toLowerCase()
      if (!haystack.includes(needle)) {
        continue
      }

      seen.set(row.id, {
        id: row.id,
        content: row.content,
        channel_id: row.channelId,
        conversation_id: row.conversationId,
        server_id: row.serverId,
        sender_id: row.senderId,
        sender: row.senderUsername
          ? { id: row.senderId ?? '', username: row.senderUsername, display_name: null, avatar_url: null }
          : null,
        inserted_at: row.insertedAt,
        expires_at: null,
        parent_message_id: null,
        attachment_filenames: row.attachmentFilenames
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
    deleteCachedMessage(messageId).catch(() => {})
    scheduleSearchIndexSync()
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
    deleteCachedMessage(messageId).catch(() => {})
    scheduleSearchIndexSync()
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
function handleReactionUpdate(
  targetId: string,
  msg: Record<string, unknown>,
  set: (fn: (s: MessageState) => Partial<MessageState>) => void
): void {
  const action = msg.action as string
  const messageId = msg.message_id as string
  const emoji = msg.emoji as string
  const senderId = msg.sender_id as string

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

  if (newContent !== undefined) {
    const updatedMessage = useMessageStore
      .getState()
      .messagesByChannel[targetId]
      ?.find((message) => message.id === messageId)

    if (updatedMessage && !updatedMessage.expires_at) {
      cacheMessage({
        id: updatedMessage.id,
        channelId: targetId,
        conversationId: updatedMessage.conversation_id,
        serverId: updatedMessage.server_id ?? null,
        senderId: updatedMessage.sender_id,
        senderUsername: updatedMessage.sender?.username ?? null,
        content: updatedMessage.content,
        attachmentFilenames:
          updatedMessage.attachment_filenames ??
          updatedMessage.attachments?.map((attachment) => attachment.filename).filter(Boolean) ??
          [],
        insertedAt: updatedMessage.inserted_at
      }).catch(() => {})
      scheduleSearchIndexSync()
    }
  }
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
    const ct = msg.ciphertext as string
    const msgId = msg.id as string
    const senderId = (msg.sender_id as string) || null
    const myId = useAuthStore.getState().user?.id
    const isOwn = senderId !== null && senderId === myId

    let plaintext: string | null = null

    if (isOwn) {
      // Own messages: never attempt MLS decrypt (ratchet has advanced).
      // Resolve from sent-plaintext cache (memory → localStorage → IndexedDB).
      plaintext = lookupSentPlaintext(ct)
      if (!plaintext) {
        const cached = await loadCachedMessages(targetId)
        const hit = cached.find((m) => m.id === msgId)
        if (hit?.content) plaintext = hit.content
      }
    } else {
      // Other members' messages: MLS decrypt, fall back to IndexedDB cache.
      plaintext = await useCryptoStore.getState().decryptForChannel(targetId, ct)
      if (!plaintext) {
        const cached = await loadCachedMessages(targetId)
        const hit = cached.find((m) => m.id === msgId)
        if (hit?.content) plaintext = hit.content
      }
    }

    // Persist decrypted content to IndexedDB (tier 3) for history reloads,
    // then clean up the ephemeral tiers 1+2.
    if (plaintext && !msg.expires_at) {
      const parsedContent = parseMessageContent(plaintext)
      const attachmentFilenames = parsedContent.type === 'file'
        ? [parsedContent.file.name]
        : []

      cacheMessage({
        id: msgId,
        channelId: targetId,
        conversationId: (msg.conversation_id as string) || null,
        serverId: (msg.server_id as string) || null,
        senderId,
        senderUsername: (msg.sender as MessageSender)?.username || null,
        content: plaintext,
        attachmentFilenames,
        insertedAt: msg.inserted_at as string
      }).catch(() => {})
      pruneMessageCache(LOCAL_MESSAGE_CACHE_MAX).catch(() => {})
      scheduleSearchIndexSync()
      if (isOwn) cleanupSentEntry(ct)
    }

    return {
      id: msgId,
      content: plaintext || 'Message unavailable',
      channel_id: (msg.channel_id as string) || null,
      conversation_id: (msg.conversation_id as string) || null,
      sender_id: senderId,
      sender: (msg.sender as MessageSender) || null,
      inserted_at: msg.inserted_at as string,
      expires_at: (msg.expires_at as string) || null,
      parent_message_id: (msg.parent_message_id as string) || null,
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
    sender_id: (msg.sender_id as string) || null,
    sender: (msg.sender as MessageSender) || null,
    inserted_at: msg.inserted_at as string,
    expires_at: (msg.expires_at as string) || null,
    parent_message_id: (msg.parent_message_id as string) || null,
    edited_at: (msg.edited_at as string) || undefined
  }

  if (!plaintextMessage.expires_at) {
    const attachmentFilenames = ((msg.attachments as Array<{ filename?: string }> | undefined) ?? [])
      .map((attachment) => attachment.filename)
      .filter((filename): filename is string => typeof filename === 'string')

    cacheMessage({
      id: plaintextMessage.id,
      channelId: targetId,
      conversationId: plaintextMessage.conversation_id,
      serverId: plaintextMessage.server_id ?? null,
      senderId: plaintextMessage.sender_id,
      senderUsername: plaintextMessage.sender?.username ?? null,
      content: plaintextMessage.content,
      attachmentFilenames,
      insertedAt: plaintextMessage.inserted_at
    }).catch(() => {})
    pruneMessageCache(LOCAL_MESSAGE_CACHE_MAX).catch(() => {})
    scheduleSearchIndexSync()
  }

  return plaintextMessage
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
  const crypto = useCryptoStore.getState()

  if (!crypto.hasGroup(targetId)) return

  const result = (await crypto.handleJoinRequest(targetId, userId)) as unknown as {
    commitBytes: string
    welcomeBytes: string | null
  } | void

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
    const ct = msg.ciphertext as string
    const myId = useAuthStore.getState().user?.id

    // Edit broadcast doesn't include sender_id — look up the original message
    const existing = useMessageStore.getState().messagesByChannel[targetId]
    const original = existing?.find((m) => m.id === messageId)
    const isOwn = original?.sender_id === myId

    let plaintext: string | null = null
    if (isOwn) {
      plaintext = lookupSentPlaintext(ct)
    } else {
      plaintext = await useCryptoStore.getState().decryptForChannel(targetId, ct)
    }
    if (plaintext && isOwn) cleanupSentEntry(ct)
    newContent = plaintext || 'Message unavailable'
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

  deleteCachedMessage(messageId).catch(() => {})
  scheduleSearchIndexSync()
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
