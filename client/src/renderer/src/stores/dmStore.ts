import { create } from 'zustand'
import { apiFetch } from '../api/client'

const LAST_CONVERSATION_KEY = 'vesper:lastConversationId'

function readStoredConversationId(): string | null {
  if (typeof window === 'undefined') {
    return null
  }

  return localStorage.getItem(LAST_CONVERSATION_KEY)
}

function writeStoredConversationId(conversationId: string | null): void {
  if (typeof window === 'undefined') {
    return
  }

  if (conversationId) {
    localStorage.setItem(LAST_CONVERSATION_KEY, conversationId)
    return
  }

  localStorage.removeItem(LAST_CONVERSATION_KEY)
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

export interface DmConversation {
  id: string
  type: string
  name: string | null
  disappearing_ttl: number | null
  inserted_at: string
  participants: DmParticipant[]
  last_message: LastMessage | null
}

interface DmState {
  conversations: DmConversation[]
  selectedConversationId: string | null

  fetchConversations: () => Promise<void>
  createConversation: (userIds: string[], name?: string) => Promise<DmConversation | null>
  addConversation: (conversation: DmConversation) => void
  selectConversation: (id: string | null) => void
  searchUsers: (username: string) => Promise<DmUser[]>
  updateConversationTtl: (conversationId: string, ttl: number | null) => void
}

export const useDmStore = create<DmState>((set, get) => ({
  conversations: [],
  selectedConversationId: readStoredConversationId(),

  fetchConversations: async () => {
    try {
      const res = await apiFetch('/api/v1/conversations')
      if (res.ok) {
        const data = await res.json()
        const conversations = data.conversations as DmConversation[]
        const selectedConversationId = get().selectedConversationId
        const restoredConversation = conversations.find((conversation) => conversation.id === selectedConversationId)

        set({
          conversations,
          selectedConversationId: restoredConversation?.id ?? null
        })

        writeStoredConversationId(restoredConversation?.id ?? null)
      }
    } catch {
      // ignore
    }
  },

  createConversation: async (userIds, name?) => {
    try {
      const body: Record<string, unknown> = { participant_ids: userIds }
      if (name) body.name = name

      const res = await apiFetch('/api/v1/conversations', {
        method: 'POST',
        body: JSON.stringify(body)
      })
      if (res.ok) {
        const data = await res.json()
        const conversation = data.conversation as DmConversation
        // Add to list if not already present
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
      }
    } catch {
      // ignore
    }
    return null
  },

  addConversation: (conversation) => {
    set((s) => {
      const exists = s.conversations.some((c) => c.id === conversation.id)
      return exists ? {} : { conversations: [conversation, ...s.conversations] }
    })
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
      const res = await apiFetch(`/api/v1/users/search?username=${encodeURIComponent(username)}`)
      if (res.ok) {
        const data = await res.json()
        return data.users || []
      }
    } catch {
      // ignore
    }
    return []
  }
}))
