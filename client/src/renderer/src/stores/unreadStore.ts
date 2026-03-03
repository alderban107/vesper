import { create } from 'zustand'
import { apiFetch } from '../api/client'

interface UnreadState {
  channelUnreads: Record<string, number>
  dmUnreads: Record<string, number>

  setChannelUnreads: (counts: Record<string, number>) => void
  setDmUnreads: (counts: Record<string, number>) => void
  incrementChannel: (channelId: string) => void
  incrementDm: (conversationId: string) => void
  clearChannel: (channelId: string) => void
  clearDm: (conversationId: string) => void
  markChannelRead: (channelId: string, messageId: string) => Promise<void>
  markDmRead: (conversationId: string, messageId: string) => Promise<void>
  fetchUnreadCounts: () => Promise<void>
}

export const useUnreadStore = create<UnreadState>((set) => ({
  channelUnreads: {},
  dmUnreads: {},

  setChannelUnreads: (counts) => set({ channelUnreads: counts }),
  setDmUnreads: (counts) => set({ dmUnreads: counts }),

  incrementChannel: (channelId) =>
    set((s) => ({
      channelUnreads: {
        ...s.channelUnreads,
        [channelId]: (s.channelUnreads[channelId] || 0) + 1
      }
    })),

  incrementDm: (conversationId) =>
    set((s) => ({
      dmUnreads: {
        ...s.dmUnreads,
        [conversationId]: (s.dmUnreads[conversationId] || 0) + 1
      }
    })),

  clearChannel: (channelId) =>
    set((s) => ({
      channelUnreads: { ...s.channelUnreads, [channelId]: 0 }
    })),

  clearDm: (conversationId) =>
    set((s) => ({
      dmUnreads: { ...s.dmUnreads, [conversationId]: 0 }
    })),

  markChannelRead: async (channelId, messageId) => {
    set((s) => ({
      channelUnreads: { ...s.channelUnreads, [channelId]: 0 }
    }))
    try {
      await apiFetch(`/api/v1/channels/${channelId}/read`, {
        method: 'PUT',
        body: JSON.stringify({ message_id: messageId })
      })
    } catch {
      // ignore
    }
  },

  markDmRead: async (conversationId, messageId) => {
    set((s) => ({
      dmUnreads: { ...s.dmUnreads, [conversationId]: 0 }
    }))
    try {
      await apiFetch(`/api/v1/conversations/${conversationId}/read`, {
        method: 'PUT',
        body: JSON.stringify({ message_id: messageId })
      })
    } catch {
      // ignore
    }
  },

  fetchUnreadCounts: async () => {
    try {
      const res = await apiFetch('/api/v1/unread')
      if (res.ok) {
        const data = await res.json()
        set({
          channelUnreads: data.channels || {},
          dmUnreads: data.conversations || {}
        })
      }
    } catch {
      // ignore
    }
  }
}))
