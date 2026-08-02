import { create } from 'zustand'
import { useDmStore } from './dmStore'
import { useServerStore } from './serverStore'
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
            const clientState = await getRendererClient().syncNow(nextForceFull)

            useServerStore.getState().mergeServers(clientState.servers)
            useDmStore.getState().mergeConversations(clientState.conversations)
            useDmStore.getState().setConversationPageState(clientState.conversationsHasMore)
            useUnreadStore.getState().setChannelUnreads(clientState.unreadCounts.channels)
            useUnreadStore.getState().setDmUnreads(clientState.unreadCounts.conversations)

            persistSyncTokens(
              clientState.syncToken,
              get().urgentToken ?? clientState.syncToken
            )
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
        let cursor = get().urgentToken

        while (true) {
          const data = await getRendererClient().fetchUrgentSyncEvents(cursor)
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

          if (data.cursorExpired) {
            await get().syncNow(true)
            persistSyncTokens(get().token, nextToken)
            break
          }

          if (data.hasMore && (!nextToken || nextToken === cursor)) {
            throw new Error('Urgent sync returned a non-advancing continuation cursor')
          }

          if (events.length > 0) {
            const { processUrgentSyncEvents } = await import('./messageStore')
            await processUrgentSyncEvents(events)
          }

          persistSyncTokens(get().token, nextToken)
          cursor = nextToken

          if (!data.hasMore) {
            break
          }
        }
      } catch {
        // Keep the last locally committed cursor so the next trigger resumes the page drain.
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
