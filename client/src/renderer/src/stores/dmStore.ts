import { create } from 'zustand'
import { apiFetch } from '../api/client'

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
  selectedConversationId: null,

  fetchConversations: async () => {
    try {
      const res = await apiFetch('/api/v1/conversations')
      if (res.ok) {
        const data = await res.json()
        set({ conversations: data.conversations })
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
