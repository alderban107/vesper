import { create } from 'zustand'
import { useDmStore, type DmConversation } from './dmStore'
import { useServerStore, type Server } from './serverStore'
import { useUnreadStore } from './unreadStore'
import { getRendererClient } from '../sdk/client'
import { getStoredValue, writeStoredValue } from '../utils/localStorage'

const SYNC_TOKEN_KEY = 'vesper:syncToken'
const URGENT_SYNC_TOKEN_KEY = 'vesper:urgentSyncToken'
let currentSyncPromise: Promise<void> | null = null
let currentUrgentSyncPromise: Promise<void> | null = null
let rerunRequested = false
let rerunForceFull = false

export function persistSyncTokens(token: string | null, urgentToken: string | null = token): void {
  writeStoredValue(SYNC_TOKEN_KEY, token)
  writeStoredValue(URGENT_SYNC_TOKEN_KEY, urgentToken)
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
  token: getStoredValue(SYNC_TOKEN_KEY),
  urgentToken: getStoredValue(URGENT_SYNC_TOKEN_KEY) ?? getStoredValue(SYNC_TOKEN_KEY),
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
            const data = await getRendererClient().fetchWorkspaceDelta(token)
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
              useServerStore.getState().syncChannelLastMessage({
                channelId: activity.channel_id,
                lastMessage:
                  activity.message_id && activity.inserted_at
                    ? {
                        id: activity.message_id,
                        inserted_at: activity.inserted_at,
                        sender_id: activity.sender_id,
                        sender: activity.sender ?? null
                      }
                    : null
              })
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
        const data = await getRendererClient().fetchUrgentSyncEvents(get().urgentToken)
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
