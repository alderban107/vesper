import { create } from 'zustand'
import { apiFetch } from '../api/client'
import { joinChannel, leaveChannel, pushToChannel } from '../api/socket'
import { useCryptoStore } from './cryptoStore'
import { useAuthStore } from './authStore'
import { useVoiceStore } from './voiceStore'
import { useServerStore } from './serverStore'
import { useDmStore } from './dmStore'
import { usePresenceStore } from './presenceStore'
import { cacheMessage as cacheMessageToDb, loadCachedMessages } from '../crypto/storage'
import { base64ToUint8 } from '../api/crypto'

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
  sender_id: string | null
  sender: MessageSender | null
  inserted_at: string
  expires_at: string | null
  parent_message_id: string | null
  attachments?: Attachment[]
  reactions?: ReactionGroup[]
  encrypted?: boolean
  decryptionFailed?: boolean
  edited_at?: string
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

  joinChannelChat: (channelId: string) => void
  leaveChannelChat: (channelId: string) => void
  fetchMessages: (channelId: string) => Promise<void>
  fetchOlderMessages: (channelId: string) => Promise<void>
  sendMessage: (channelId: string, content: string) => void
  sendTypingStart: (channelId: string) => void
  sendTypingStop: (channelId: string) => void

  // DM conversation support
  joinDmChat: (conversationId: string) => void
  leaveDmChat: (conversationId: string) => void
  fetchDmMessages: (conversationId: string) => Promise<void>
  fetchOlderDmMessages: (conversationId: string) => Promise<void>
  sendDmMessage: (conversationId: string, content: string) => void
  sendDmTypingStart: (conversationId: string) => void
  sendDmTypingStop: (conversationId: string) => void

  // Threads
  setReplyingTo: (message: Message | null) => void

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

  // Search
  searchMessages: (query: string) => Promise<Message[]>
}

export const useMessageStore = create<MessageState>((set, get) => ({
  messagesByChannel: {},
  typingUsers: {},
  hasMore: {},
  replyingTo: null,
  editingMessage: null,
  encryptionError: null,

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

  sendMessage: async (channelId, content) => {
    const crypto = useCryptoStore.getState()
    const replyingTo = get().replyingTo
    const parentId = replyingTo?.id || undefined
    const mentionedUserIds = extractMentionedUserIds(content)

    if (crypto.hasGroup(channelId)) {
      const encrypted = await crypto.encryptForChannel(channelId, content)
      if (encrypted) {
        pushToChannel(`chat:channel:${channelId}`, 'new_message', {
          ciphertext: encrypted.ciphertext,
          mls_epoch: encrypted.epoch,
          ...(parentId && { parent_message_id: parentId }),
          ...(mentionedUserIds.length > 0 && { mentioned_user_ids: mentionedUserIds })
        })
        set({ replyingTo: null, encryptionError: null })
        return
      }
    } else {
      await crypto.createGroup(channelId)
      if (crypto.hasGroup(channelId)) {
        const encrypted = await crypto.encryptForChannel(channelId, content)
        if (encrypted) {
          pushToChannel(`chat:channel:${channelId}`, 'new_message', {
            ciphertext: encrypted.ciphertext,
            mls_epoch: encrypted.epoch,
            ...(parentId && { parent_message_id: parentId }),
            ...(mentionedUserIds.length > 0 && { mentioned_user_ids: mentionedUserIds })
          })
          set({ replyingTo: null, encryptionError: null })
          return
        }
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

  sendDmMessage: async (conversationId, content) => {
    const crypto = useCryptoStore.getState()
    const topic = `dm:${conversationId}`
    const replyingTo = get().replyingTo
    const parentId = replyingTo?.id || undefined

    // Try encrypting with existing group, or create a new one
    const encrypted = crypto.hasGroup(conversationId)
      ? await crypto.encryptForChannel(conversationId, content)
      : null

    if (encrypted) {
      pushToChannel(topic, 'new_message', {
        ciphertext: encrypted.ciphertext,
        mls_epoch: encrypted.epoch,
        ...(parentId && { parent_message_id: parentId })
      })
      set({ replyingTo: null })
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
        pushToChannel(topic, 'new_message', {
          ciphertext: freshEncrypted.ciphertext,
          mls_epoch: freshEncrypted.epoch,
          ...(parentId && { parent_message_id: parentId })
        })
        set({ replyingTo: null })
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

  // Edit / Delete
  setEditingMessage: (message) => set({ editingMessage: message }),

  editMessage: async (targetId, topic, messageId, newContent) => {
    const crypto = useCryptoStore.getState()

    if (crypto.hasGroup(targetId)) {
      const encrypted = await crypto.encryptForChannel(targetId, newContent)
      if (encrypted) {
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

  // Search — disabled while message cache stores ciphertext.
  // Will be reimplemented with FTS5 in Phase 5 of the E2EE refactor.
  searchMessages: async (_query) => {
    return []
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
  }, delay)

  expiryTimers.set(messageId, timer)
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

    return {
      messagesByChannel: { ...s.messagesByChannel, [targetId]: updated }
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

  set((s) => ({
    messagesByChannel: {
      ...s.messagesByChannel,
      [targetId]: [...(s.messagesByChannel[targetId] || []), processed]
    }
  }))
}

/**
 * Process an incoming message — decrypt if encrypted, pass through if plaintext.
 * Encrypted messages are cached as ciphertext in the local database so they can
 * be decrypted on demand later without storing plaintext on disk.
 */
async function processIncomingMessage(
  targetId: string,
  msg: Record<string, unknown>
): Promise<Message> {
  if (msg.ciphertext) {
    const ciphertextB64 = msg.ciphertext as string
    const mlsEpoch = (msg.mls_epoch as number) ?? null

    const plaintext = await useCryptoStore
      .getState()
      .decryptForChannel(targetId, ciphertextB64)

    // Cache the ciphertext (not plaintext) to the local DB
    try {
      const ciphertextBytes = base64ToUint8(ciphertextB64)
      await cacheMessageToDb({
        id: msg.id as string,
        channelId: targetId,
        senderId: (msg.sender_id as string) || null,
        senderUsername: (msg.sender as MessageSender)?.username || null,
        ciphertext: ciphertextBytes,
        mlsEpoch: mlsEpoch,
        insertedAt: msg.inserted_at as string
      })
    } catch {
      // Cache failure is non-fatal — message is still displayed from memory
    }

    return {
      id: msg.id as string,
      content: plaintext || '[Message unavailable - decryption failed]',
      channel_id: (msg.channel_id as string) || null,
      conversation_id: (msg.conversation_id as string) || null,
      sender_id: (msg.sender_id as string) || null,
      sender: (msg.sender as MessageSender) || null,
      inserted_at: msg.inserted_at as string,
      expires_at: (msg.expires_at as string) || null,
      parent_message_id: (msg.parent_message_id as string) || null,
      encrypted: true,
      decryptionFailed: !plaintext,
      edited_at: (msg.edited_at as string) || undefined
    }
  }

  return {
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
    const plaintext = await useCryptoStore
      .getState()
      .decryptForChannel(targetId, msg.ciphertext as string)
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
    return {
      messagesByChannel: { ...s.messagesByChannel, [targetId]: updated }
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
    }
  }))
}
