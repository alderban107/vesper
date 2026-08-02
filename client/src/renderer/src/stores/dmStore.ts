import { create } from 'zustand'
import { getRendererClient } from '../sdk/client'
import { getStoredValue, writeStoredValue } from '../utils/localStorage'
import { registerDmChannelMapping } from './messageStore'

function registerMapping(conversationId: string, channelId: string | null): void {
  if (channelId) {
    registerDmChannelMapping(conversationId, channelId)
  }
}

const LAST_CONVERSATION_KEY = 'vesper:lastConversationId'

function readStoredConversationId(): string | null {
  return getStoredValue(LAST_CONVERSATION_KEY)
}

function writeStoredConversationId(conversationId: string | null): void {
  writeStoredValue(LAST_CONVERSATION_KEY, conversationId)
}

function parseActivityTimestamp(value: string | null | undefined): number {
  if (!value) {
    return 0
  }

  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

interface DmUser {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
  status: string
}

interface DmParticipant {
  id: string
  user_id: string
  joined_at: string
  user: DmUser
}

interface LastMessage {
  id: string
  content?: string
  ciphertext?: string
  sender_id: string | null
  sender: { id: string; username: string } | null
  inserted_at: string
}

interface ConversationActivity {
  conversationId: string
  messageId: string
  content: string | null
  senderId: string | null
  sender: { id: string; username: string } | null
  insertedAt: string
}

interface ConversationLastMessageSync {
  conversationId: string
  lastMessage: LastMessage | null
}

export interface DmConversation {
  id: string
  type: string
  name: string | null
  channel_id: string | null
  disappearing_ttl: number | null
  inserted_at: string
  participants: DmParticipant[]
  last_message: LastMessage | null
}

function getConversationActivityTimestamp(conversation: DmConversation): number {
  return parseActivityTimestamp(conversation.last_message?.inserted_at ?? conversation.inserted_at)
}

function mergeConversation(existing: DmConversation | undefined, incoming: DmConversation): DmConversation {
  if (!existing) {
    return incoming
  }

  if (getConversationActivityTimestamp(existing) > getConversationActivityTimestamp(incoming)) {
    return {
      ...incoming,
      last_message: existing.last_message
    }
  }

  return {
    ...incoming,
    last_message: incoming.last_message ?? existing.last_message
  }
}

interface DmState {
  conversations: DmConversation[]
  selectedConversationId: string | null
  hasMoreConversations: boolean
  loadingMoreConversations: boolean

  fetchConversations: () => Promise<void>
  loadMoreConversations: () => Promise<void>
  mergeConversations: (conversations: DmConversation[]) => void
  setConversationPageState: (hasMore: boolean) => void
  createConversation: (userIds: string[], name?: string) => Promise<DmConversation | null>
  addConversation: (conversation: DmConversation) => void
  applyConversationActivity: (activity: ConversationActivity) => boolean
  syncConversationLastMessage: (payload: ConversationLastMessageSync) => void
  selectConversation: (id: string | null) => void
  searchUsers: (username: string) => Promise<DmUser[]>
  updateConversationTtl: (conversationId: string, ttl: number | null) => void
}

export const useDmStore = create<DmState>((set, get) => ({
  conversations: [],
  selectedConversationId: readStoredConversationId(),
  hasMoreConversations: false,
  loadingMoreConversations: false,

  fetchConversations: async () => {
    try {
      const client = getRendererClient()
      const incomingConversations = await client.listConversations() as DmConversation[]
      const clientState = client.getState()

      set((state) => {
        const mergedById = new Map<string, DmConversation>()

        for (const conversation of state.conversations) {
          mergedById.set(conversation.id, conversation)
        }

        for (const conversation of incomingConversations) {
          mergedById.set(
            conversation.id,
            mergeConversation(mergedById.get(conversation.id), conversation)
          )
        }

        const conversations = [...mergedById.values()].sort(
          (left, right) =>
            getConversationActivityTimestamp(right) - getConversationActivityTimestamp(left)
        )

        const selectedConversationId = state.selectedConversationId
        const restoredConversation = selectedConversationId
          ? mergedById.get(selectedConversationId) ?? null
          : null

        writeStoredConversationId(restoredConversation?.id ?? null)

        return {
          conversations,
          selectedConversationId: restoredConversation?.id ?? null,
          hasMoreConversations: clientState.conversationsHasMore
        }
      })
    } catch {
      // ignore
    }
  },

  loadMoreConversations: async () => {
    const state = get()
    if (state.loadingMoreConversations || !state.hasMoreConversations) {
      return
    }

    set({ loadingMoreConversations: true })
    try {
      const client = getRendererClient()
      const conversations = await client.loadMoreConversations() as DmConversation[]
      const clientState = client.getState()
      get().mergeConversations(conversations)
      set({ hasMoreConversations: clientState.conversationsHasMore })

      const { useUnreadStore } = await import('./unreadStore')
      useUnreadStore.getState().setDmUnreads(clientState.unreadCounts.conversations)
    } catch {
      // Keep the cursor unchanged so a later scroll can retry the same page.
    } finally {
      set({ loadingMoreConversations: false })
    }
  },

  mergeConversations: (incomingConversations) => {
    set((state) => {
      const mergedById = new Map<string, DmConversation>()

      for (const conversation of state.conversations) {
        mergedById.set(conversation.id, conversation)
      }

      for (const conversation of incomingConversations) {
        mergedById.set(
          conversation.id,
          mergeConversation(mergedById.get(conversation.id), conversation)
        )
      }

      const conversations = [...mergedById.values()].sort(
        (left, right) =>
          getConversationActivityTimestamp(right) - getConversationActivityTimestamp(left)
      )

      // Register channel mappings for DM-as-channel MLS routing
      for (const conv of conversations) {
        if (conv.channel_id) {
          registerMapping(conv.id, conv.channel_id)
        }
      }

      const selectedConversationId = state.selectedConversationId
      const restoredConversation = selectedConversationId
        ? mergedById.get(selectedConversationId) ?? null
        : null

      writeStoredConversationId(restoredConversation?.id ?? null)

      return {
        conversations,
        selectedConversationId: restoredConversation?.id ?? null
      }
    })
  },

  setConversationPageState: (hasMore) => {
    set({ hasMoreConversations: hasMore })
  },

  createConversation: async (userIds, name?) => {
    try {
      const conversation =
        await getRendererClient().createConversation(userIds, name) as DmConversation

      // Register channel mapping immediately so sendDmMessage can delegate
      if (conversation.channel_id) {
        registerMapping(conversation.id, conversation.channel_id)
      }

      set((s) => {
        const exists = s.conversations.some((c) => c.id === conversation.id)
        writeStoredConversationId(conversation.id)
        return exists
          ? { selectedConversationId: conversation.id }
          : {
              conversations: [conversation, ...s.conversations],
              selectedConversationId: conversation.id
            }
      })
      return conversation
    } catch {
      // ignore
    }
    return null
  },

  addConversation: (conversation) => {
    if (conversation.channel_id) {
      registerMapping(conversation.id, conversation.channel_id)
    }
    set((s) => {
      const exists = s.conversations.some((c) => c.id === conversation.id)
      return exists ? {} : { conversations: [conversation, ...s.conversations] }
    })
  },

  applyConversationActivity: (activity) => {
    let applied = false

    set((s) => {
      const existingConversation = s.conversations.find(
        (conversation) => conversation.id === activity.conversationId
      )

      if (!existingConversation) {
        return s
      }

      const currentActivityAt = getConversationActivityTimestamp(existingConversation)
      const nextActivityAt = parseActivityTimestamp(activity.insertedAt)
      if (currentActivityAt > nextActivityAt) {
        return s
      }

      applied = true

      const updatedConversation: DmConversation = {
        ...existingConversation,
        last_message: {
          id: activity.messageId,
          ...(activity.content ? { content: activity.content } : {}),
          sender_id: activity.senderId,
          sender: activity.sender,
          inserted_at: activity.insertedAt
        }
      }

      const conversations = s.conversations
        .map((conversation) =>
          conversation.id === activity.conversationId ? updatedConversation : conversation
        )
        .sort(
          (left, right) =>
            getConversationActivityTimestamp(right) - getConversationActivityTimestamp(left)
        )

      return { conversations }
    })

    return applied
  },

  syncConversationLastMessage: ({ conversationId, lastMessage }) => {
    set((s) => ({
      conversations: s.conversations
        .map((conversation) =>
          conversation.id === conversationId
            ? { ...conversation, last_message: lastMessage }
            : conversation
        )
        .sort(
          (left, right) =>
            getConversationActivityTimestamp(right) - getConversationActivityTimestamp(left)
        )
    }))
  },

  selectConversation: (id) => {
    writeStoredConversationId(id)
    set({ selectedConversationId: id })
  },

  updateConversationTtl: (conversationId, ttl) => {
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === conversationId ? { ...c, disappearing_ttl: ttl } : c
      )
    }))
  },

  searchUsers: async (username) => {
    if (username.length < 2) return []
    try {
      return await getRendererClient().searchUsers(username) as DmUser[]
    } catch {
      // ignore
    }
    return []
  }
}))
