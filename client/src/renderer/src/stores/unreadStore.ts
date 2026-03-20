import { create } from 'zustand'
import { getRendererClient } from '../sdk/client'

interface UnreadState {
  channelUnreads: Record<string, number>
  dmUnreads: Record<string, number>

  setChannelUnreads: (counts: Record<string, number>) => void
  setDmUnreads: (counts: Record<string, number>) => void
  mergeChannelUnreads: (counts: Record<string, number>) => void
  mergeDmUnreads: (counts: Record<string, number>) => void
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
  mergeChannelUnreads: (counts) =>
    set((s) => ({
      channelUnreads: {
        ...s.channelUnreads,
        ...counts
      }
    })),
  mergeDmUnreads: (counts) =>
    set((s) => ({
      dmUnreads: {
        ...s.dmUnreads,
        ...counts
      }
    })),

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
      await getRendererClient().markChannelRead(channelId, messageId)
    } catch {
      // Best-effort: UI already updated optimistically above
    }
  },

  markDmRead: async (conversationId, messageId) => {
    set((s) => ({
      dmUnreads: { ...s.dmUnreads, [conversationId]: 0 }
    }))
    try {
      await getRendererClient().markConversationRead(conversationId, messageId)
    } catch {
      // Best-effort: UI already updated optimistically above
    }
  },

  fetchUnreadCounts: async () => {
    try {
      const data = await getRendererClient().fetchUnreadCounts()
      set({
        channelUnreads: data.channels || {},
        dmUnreads: data.conversations || {}
      })
    } catch {
      // Best-effort: stale counts are acceptable until next sync
    }
  }
}))
