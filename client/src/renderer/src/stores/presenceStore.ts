import { create } from 'zustand'
import { joinChannel, leaveChannel, pushToChannel } from '../api/socket'
import { useServerStore } from './serverStore'
import type { DmConversation } from './dmStore'

export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline'

interface PresenceState {
  statuses: Record<string, PresenceStatus>
  myStatus: PresenceStatus
  connected: boolean

  joinPresence: (userId: string) => void
  joinAllServerPresence: (serverIds: string[]) => void
  leaveAllServerPresence: () => void
  setStatus: (status: PresenceStatus) => void
  getStatus: (userId: string) => PresenceStatus
}

let heartbeatInterval: ReturnType<typeof setInterval> | null = null
let idleTimeout: ReturnType<typeof setTimeout> | null = null
let userTopic: string | null = null
let serverPresenceTopics: Set<string> = new Set()

const HEARTBEAT_INTERVAL = 30_000 // 30 seconds
const IDLE_TIMEOUT = 300_000 // 5 minutes

function resetIdleTimer(): void {
  if (idleTimeout) clearTimeout(idleTimeout)
  idleTimeout = setTimeout(() => {
    if (userTopic) {
      const store = usePresenceStore.getState()
      if (store.myStatus === 'online') {
        pushToChannel(userTopic, 'set_status', { status: 'idle' })
        usePresenceStore.setState({ myStatus: 'idle' })
      }
    }
  }, IDLE_TIMEOUT)
}

function setupActivityListeners(): void {
  const onActivity = (): void => {
    const store = usePresenceStore.getState()
    if (store.myStatus === 'idle' && userTopic) {
      pushToChannel(userTopic, 'set_status', { status: 'online' })
      usePresenceStore.setState({ myStatus: 'online' })
    }
    resetIdleTimer()
  }

  window.addEventListener('mousemove', onActivity, { passive: true })
  window.addEventListener('keydown', onActivity, { passive: true })
}

export const usePresenceStore = create<PresenceState>((set, get) => ({
  statuses: {},
  myStatus: 'online',
  connected: false,

  joinPresence: (userId) => {
    const topic = `user:${userId}`
    userTopic = topic

    joinChannel(topic, (event, payload) => {
      if (event === 'presence_state') {
        const state = payload as Record<string, { metas: Array<{ status: string }> }>
        const statuses: Record<string, PresenceStatus> = {}
        for (const [uid, data] of Object.entries(state)) {
          statuses[uid] = (data.metas[0]?.status || 'offline') as PresenceStatus
        }
        set((s) => ({ statuses: { ...s.statuses, ...statuses }, connected: true }))
      } else if (event === 'presence_diff') {
        const diff = payload as {
          joins: Record<string, { metas: Array<{ status: string }> }>
          leaves: Record<string, unknown>
        }

        set((s) => {
          const newStatuses = { ...s.statuses }
          // Process leaves first, but skip users who are also in joins
          // (Phoenix sends both for metadata updates — join has the new state)
          for (const uid of Object.keys(diff.leaves)) {
            if (!(uid in diff.joins)) {
              newStatuses[uid] = 'offline'
            }
          }
          for (const [uid, data] of Object.entries(diff.joins)) {
            newStatuses[uid] = (data.metas[0]?.status || 'online') as PresenceStatus
          }
          return { statuses: newStatuses }
        })
      } else if (event === 'new_conversation') {
        import('./dmStore').then(({ useDmStore }) => {
          const data = payload as { conversation: DmConversation }
          useDmStore.getState().addConversation(data.conversation)
        })
      } else if (event === 'dm_message') {
        // A DM was sent to us — refresh conversation list so it appears
        import('./dmStore').then(({ useDmStore }) => {
          useDmStore.getState().fetchConversations()
        })
      } else if (event === 'unread_update') {
        const data = payload as { channel_id: string; message_id: string }
        Promise.all([
          import('./serverStore'),
          import('./unreadStore')
        ]).then(([{ useServerStore }, { useUnreadStore }]) => {
          if (useServerStore.getState().activeChannelId !== data.channel_id) {
            useUnreadStore.getState().incrementChannel(data.channel_id)
          }
        })
      } else if (event === 'mention') {
        const data = payload as { channel_id: string; sender_id: string }
        if (Notification.permission === 'granted') {
          new Notification('Vesper', { body: 'You were mentioned in a channel' })
        }
      } else if (event === 'dm_unread_update') {
        const data = payload as { conversation_id: string; message_id: string }
        Promise.all([
          import('./dmStore'),
          import('./unreadStore')
        ]).then(([{ useDmStore }, { useUnreadStore }]) => {
          if (useDmStore.getState().selectedConversationId !== data.conversation_id) {
            useUnreadStore.getState().incrementDm(data.conversation_id)
          }
        })
      } else if (event === 'device_approval_requested' || event === 'device_updated') {
        import('./authStore').then(({ useAuthStore }) => {
          const data = payload as {
            device?: {
              id: string
              client_id: string
              name: string
              platform: string | null
              trust_state: 'pending' | 'trusted' | 'revoked'
              approval_method: string | null
              trusted_at: string | null
              revoked_at: string | null
              last_seen_at: string | null
              inserted_at: string
            }
          }

          if (data.device) {
            void useAuthStore.getState().handleDeviceEvent(data.device)
          }
        })
      }
    })

    // Start heartbeat
    if (heartbeatInterval) clearInterval(heartbeatInterval)
    heartbeatInterval = setInterval(() => {
      pushToChannel(topic, 'heartbeat', {})
    }, HEARTBEAT_INTERVAL)

    // Start idle detection
    setupActivityListeners()
    resetIdleTimer()
  },

  joinAllServerPresence: (serverIds) => {
    // Determine which to join and which to leave
    const newTopics = new Set(serverIds.map((id) => `presence:server:${id}`))

    // Leave servers we're no longer in
    for (const topic of serverPresenceTopics) {
      if (!newTopics.has(topic)) {
        leaveChannel(topic)
      }
    }

    // Join new servers we haven't joined yet
    for (const topic of newTopics) {
      if (serverPresenceTopics.has(topic)) continue
      const serverId = topic.replace('presence:server:', '')

      joinChannel(topic, (event, payload) => {
        if (event === 'presence_state') {
          const state = payload as Record<string, { metas: Array<{ status: string }> }>
          const statuses: Record<string, PresenceStatus> = {}
          for (const [uid, data] of Object.entries(state)) {
            statuses[uid] = (data.metas[0]?.status || 'offline') as PresenceStatus
          }
          set((s) => ({ statuses: { ...s.statuses, ...statuses } }))
        } else if (event === 'presence_diff') {
          const diff = payload as {
            joins: Record<string, { metas: Array<{ status: string }> }>
            leaves: Record<string, unknown>
          }

          set((s) => {
            const newStatuses = { ...s.statuses }
            for (const uid of Object.keys(diff.leaves)) {
              if (!(uid in diff.joins)) {
                newStatuses[uid] = 'offline'
              }
            }
            for (const [uid, data] of Object.entries(diff.joins)) {
              newStatuses[uid] = (data.metas[0]?.status || 'online') as PresenceStatus
            }
            return { statuses: newStatuses }
          })
        } else if (event === 'emoji_created') {
          const emoji = payload as { id: string; name: string; url: string; animated: boolean; server_id: string }
          useServerStore.setState((s) => ({
            servers: s.servers.map((srv) =>
              srv.id === serverId
                ? { ...srv, emojis: [...srv.emojis.filter((e) => e.id !== emoji.id), emoji].sort((a, b) => a.name.localeCompare(b.name)) }
                : srv
            )
          }))
        } else if (event === 'emoji_deleted') {
          const { id } = payload as { id: string }
          useServerStore.setState((s) => ({
            servers: s.servers.map((srv) =>
              srv.id === serverId
                ? { ...srv, emojis: srv.emojis.filter((e) => e.id !== id) }
                : srv
            )
          }))
        }
      })
    }

    serverPresenceTopics = newTopics
  },

  leaveAllServerPresence: () => {
    for (const topic of serverPresenceTopics) {
      leaveChannel(topic)
    }
    serverPresenceTopics.clear()
  },

  setStatus: (status) => {
    if (userTopic && status !== 'offline') {
      pushToChannel(userTopic, 'set_status', { status })
    }
    set({ myStatus: status })
  },

  getStatus: (userId) => {
    return get().statuses[userId] || 'offline'
  }
}))

/**
 * Clean up module-level presence timers and channel references.
 * Called during logout to stop heartbeats and idle detection.
 */
export function cleanupPresenceTimers(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval)
    heartbeatInterval = null
  }
  if (idleTimeout) {
    clearTimeout(idleTimeout)
    idleTimeout = null
  }
  if (userTopic) {
    leaveChannel(userTopic)
    userTopic = null
  }
}
