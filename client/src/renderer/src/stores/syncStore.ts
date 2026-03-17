import { create } from 'zustand'
import { apiFetch } from '../api/client'
import { useDmStore, type DmConversation } from './dmStore'
import { useServerStore, type Server } from './serverStore'
import { useUnreadStore } from './unreadStore'

const SYNC_TOKEN_KEY = 'vesper:syncToken'
const URGENT_SYNC_TOKEN_KEY = 'vesper:urgentSyncToken'
let currentSyncPromise: Promise<void> | null = null
let currentUrgentSyncPromise: Promise<void> | null = null
let rerunRequested = false
let rerunForceFull = false

function readStoredSyncToken(): string | null {
  if (typeof window === 'undefined') {
    return null
  }

  return localStorage.getItem(SYNC_TOKEN_KEY)
}

function writeStoredSyncToken(token: string | null): void {
  if (typeof window === 'undefined') {
    return
  }

  if (token) {
    localStorage.setItem(SYNC_TOKEN_KEY, token)
    return
  }

  localStorage.removeItem(SYNC_TOKEN_KEY)
}

function readStoredUrgentSyncToken(): string | null {
  if (typeof window === 'undefined') {
    return null
  }

  return localStorage.getItem(URGENT_SYNC_TOKEN_KEY)
}

function writeStoredUrgentSyncToken(token: string | null): void {
  if (typeof window === 'undefined') {
    return
  }

  if (token) {
    localStorage.setItem(URGENT_SYNC_TOKEN_KEY, token)
    return
  }

  localStorage.removeItem(URGENT_SYNC_TOKEN_KEY)
}

export function persistSyncTokens(token: string | null, urgentToken: string | null = token): void {
  writeStoredSyncToken(token)
  writeStoredUrgentSyncToken(urgentToken)
  useSyncStore.setState({
    token,
    urgentToken
  })
}

interface ChannelActivityPatch {
  channel_id: string
  message_id: string | null
  inserted_at: string | null
  sender_id: string | null
  sender?: {
    id: string
    username: string
    display_name?: string | null
    avatar_url?: string | null
  } | null
}

interface ConversationResetPatch {
  conversation_id: string
  last_message: DmConversation['last_message'] | null
}

interface UnreadCountsPatch {
  channels?: Record<string, number>
  conversations?: Record<string, number>
}

interface SyncState {
  token: string | null
  urgentToken: string | null
  syncing: boolean
  syncNow: (forceFull?: boolean) => Promise<void>
  syncUrgentNow: () => Promise<void>
  resetToken: () => void
}

export const useSyncStore = create<SyncState>((set, get) => ({
  token: readStoredSyncToken(),
  urgentToken: readStoredUrgentSyncToken() ?? readStoredSyncToken(),
  syncing: false,

  syncNow: async (forceFull = false) => {
    if (currentSyncPromise) {
      rerunRequested = true
      rerunForceFull = rerunForceFull || forceFull
      await currentSyncPromise
      return
    }

    currentSyncPromise = (async () => {
      let nextForceFull = forceFull
      set({ syncing: true })

      try {
        while (true) {
          try {
            const token = nextForceFull ? null : get().token
            const query = token ? `?since=${encodeURIComponent(token)}` : ''
            const res = await apiFetch(`/api/v1/sync${query}`)
            if (res.ok) {
              const data = await res.json()
              const nextToken = typeof data.token === 'string' ? data.token : null
              const servers = Array.isArray(data.servers) ? (data.servers as Server[]) : []
              const conversations = Array.isArray(data.conversations)
                ? (data.conversations as DmConversation[])
                : []
              const conversationResets = Array.isArray(data.conversation_resets)
                ? (data.conversation_resets as ConversationResetPatch[])
                : []
              const channelActivity = Array.isArray(data.channel_activity)
                ? (data.channel_activity as ChannelActivityPatch[])
                : []
              const unreadCounts =
                typeof data.unread_counts === 'object' && data.unread_counts !== null
                  ? (data.unread_counts as UnreadCountsPatch)
                  : null

              if (servers.length > 0) {
                useServerStore.getState().mergeServers(servers)
              }

              if (conversations.length > 0) {
                useDmStore.getState().mergeConversations(conversations)
              }

              for (const reset of conversationResets) {
                useDmStore.getState().syncConversationLastMessage({
                  conversationId: reset.conversation_id,
                  lastMessage: reset.last_message ?? null
                })
              }

              for (const activity of channelActivity) {
                if (activity.message_id && activity.inserted_at) {
                  useServerStore.getState().applyChannelActivity({
                    channelId: activity.channel_id,
                    messageId: activity.message_id,
                    insertedAt: activity.inserted_at,
                    senderId: activity.sender_id,
                    sender: activity.sender ?? null
                  })
                } else {
                  useServerStore.getState().syncChannelLastMessage({
                    channelId: activity.channel_id,
                    lastMessage: null
                  })
                }
              }

              if (unreadCounts) {
                if (data.full) {
                  useUnreadStore.getState().setChannelUnreads(unreadCounts.channels ?? {})
                  useUnreadStore.getState().setDmUnreads(unreadCounts.conversations ?? {})
                } else {
                  useUnreadStore.getState().mergeChannelUnreads(unreadCounts.channels ?? {})
                  useUnreadStore.getState().mergeDmUnreads(unreadCounts.conversations ?? {})
                }
              }

              persistSyncTokens(nextToken, nextToken)
            }
          } catch {
            // ignore
          }

          if (!rerunRequested) {
            break
          }

          nextForceFull = rerunForceFull
          rerunRequested = false
          rerunForceFull = false
        }
      } finally {
        set({ syncing: false })
        currentSyncPromise = null
      }
    })()

    await currentSyncPromise
  },

  syncUrgentNow: async () => {
    if (currentUrgentSyncPromise) {
      await currentUrgentSyncPromise
      return
    }

    currentUrgentSyncPromise = (async () => {
      try {
        const token = get().urgentToken
        const query = token ? `?since=${encodeURIComponent(token)}` : ''
        const res = await apiFetch(`/api/v1/sync/urgent${query}`)

        if (!res.ok) {
          return
        }

        const data = await res.json()
        const nextToken = typeof data.token === 'string' ? data.token : null
        const events = Array.isArray(data.events)
          ? (data.events as Array<{
              id: number
              scope_kind: 'channel' | 'dm'
              scope_id: string
              event_type: string
              inserted_at: string
              payload?: Record<string, unknown>
            }>)
          : []

        if (events.length > 0) {
          const { processUrgentSyncEvents } = await import('./messageStore')
          await processUrgentSyncEvents(events)
        }

        persistSyncTokens(get().token, nextToken)
      } catch {
        // ignore
      } finally {
        currentUrgentSyncPromise = null
      }
    })()

    await currentUrgentSyncPromise
  },

  resetToken: () => {
    persistSyncTokens(null, null)
  }
}))
