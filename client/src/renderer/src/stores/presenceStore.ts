import { create } from 'zustand'
import { joinChannel, leaveChannel, pushToChannel } from '@vesper/sdk/transport'
import { useServerStore } from './serverStore'
import type { DmConversation } from './dmStore'
import { getRendererEncryptedChat } from '../sdk/client'

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
let activityListenersAttached = false
let detachActivityListeners: (() => void) | null = null
let presenceSourcesByTopic = new Map<string, Record<string, PresenceStatus>>()
let pendingScopeMutations = new Set<string>()
let scopeMutationRefreshPromise: Promise<void> | null = null
let recentUnreadMessageKeys = new Map<string, number>()

const HEARTBEAT_INTERVAL = 30_000 // 30 seconds
const IDLE_TIMEOUT = 300_000 // 5 minutes
const UNREAD_EVENT_DEDUPE_WINDOW_MS = 15_000

const PRESENCE_PRIORITY: Record<PresenceStatus, number> = {
  online: 4,
  dnd: 3,
  idle: 2,
  offline: 1
}

function normalizePresenceStatus(status: string | undefined): PresenceStatus {
  if (status === 'online' || status === 'idle' || status === 'dnd') {
    return status
  }

  return 'offline'
}

function recomputePresenceStatuses(): Record<string, PresenceStatus> {
  const statuses: Record<string, PresenceStatus> = {}

  for (const source of presenceSourcesByTopic.values()) {
    for (const [userId, status] of Object.entries(source)) {
      const existing = statuses[userId]
      if (!existing || PRESENCE_PRIORITY[status] > PRESENCE_PRIORITY[existing]) {
        statuses[userId] = status
      }
    }
  }

  return statuses
}

function replaceTopicPresence(
  topic: string,
  state: Record<string, { metas: Array<{ status: string }> }>
): void {
  const nextTopicState: Record<string, PresenceStatus> = {}

  for (const [userId, data] of Object.entries(state)) {
    nextTopicState[userId] = normalizePresenceStatus(data.metas[0]?.status)
  }

  if (Object.keys(nextTopicState).length === 0) {
    presenceSourcesByTopic.delete(topic)
    return
  }

  presenceSourcesByTopic.set(topic, nextTopicState)
}

function applyTopicPresenceDiff(
  topic: string,
  diff: {
    joins: Record<string, { metas: Array<{ status: string }> }>
    leaves: Record<string, unknown>
  }
): void {
  const nextTopicState = { ...(presenceSourcesByTopic.get(topic) ?? {}) }

  for (const userId of Object.keys(diff.leaves)) {
    if (!(userId in diff.joins)) {
      delete nextTopicState[userId]
    }
  }

  for (const [userId, data] of Object.entries(diff.joins)) {
    nextTopicState[userId] = normalizePresenceStatus(data.metas[0]?.status)
  }

  if (Object.keys(nextTopicState).length === 0) {
    presenceSourcesByTopic.delete(topic)
    return
  }

  presenceSourcesByTopic.set(topic, nextTopicState)
}

function clearTopicPresence(topic: string): void {
  if (!presenceSourcesByTopic.delete(topic)) {
    return
  }

  usePresenceStore.setState({ statuses: recomputePresenceStatuses() })
}

async function flushScopeMutations(): Promise<void> {
  if (scopeMutationRefreshPromise) {
    await scopeMutationRefreshPromise
    return
  }

  scopeMutationRefreshPromise = (async () => {
    try {
      while (pendingScopeMutations.size > 0) {
        const scopeKeys = [...pendingScopeMutations]
        pendingScopeMutations.clear()

        const [
          { useMessageStore },
          { useSyncStore }
        ] = await Promise.all([
          import('./messageStore'),
          import('./syncStore')
        ])

        let previousSyncToken = useSyncStore.getState().token
        if (!previousSyncToken) {
          await useSyncStore.getState().syncNow()
          previousSyncToken = useSyncStore.getState().token
        }

        const messageState = useMessageStore.getState()
        const trackedScopeIds = new Set([
          messageState.activeScopeId,
          ...messageState.recentScopeIds
        ].filter((scopeId): scopeId is string => Boolean(scopeId)))
        const changedTrackedScopeIds = [
          ...new Set(
            scopeKeys
            .map((scopeKey) => scopeKey.split(':', 2)[1] ?? null)
            .filter(
              (scopeId): scopeId is string =>
                Boolean(scopeId) &&
                trackedScopeIds.has(scopeId) &&
                scopeId !== messageState.activeScopeId
            )
          )
        ]

        if (changedTrackedScopeIds.length > 0) {
          await useMessageStore.getState().syncRecentScopes(previousSyncToken, {
            scopeIds: changedTrackedScopeIds
          })
        }
      }
    } finally {
      scopeMutationRefreshPromise = null
    }
  })()

  await scopeMutationRefreshPromise
}

function queueScopeMutation(kind: 'channel' | 'dm', scopeId: string): void {
  pendingScopeMutations.add(`${kind}:${scopeId}`)
  void flushScopeMutations().catch(() => {})
}

export function queueScopeMutationHint(kind: 'channel' | 'dm', scopeId: string): void {
  queueScopeMutation(kind, scopeId)
}

function claimUnreadMessageKey(
  kind: 'channel' | 'dm',
  scopeId: string,
  messageId: string
): boolean {
  const now = Date.now()

  for (const [key, seenAt] of recentUnreadMessageKeys) {
    if (now - seenAt > UNREAD_EVENT_DEDUPE_WINDOW_MS) {
      recentUnreadMessageKeys.delete(key)
    }
  }

  const dedupeKey = `${kind}:${scopeId}:${messageId}`
  if (recentUnreadMessageKeys.has(dedupeKey)) {
    return false
  }

  recentUnreadMessageKeys.set(dedupeKey, now)
  return true
}

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
  if (activityListenersAttached) {
    return
  }

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
  activityListenersAttached = true
  detachActivityListeners = () => {
    window.removeEventListener('mousemove', onActivity)
    window.removeEventListener('keydown', onActivity)
    activityListenersAttached = false
    detachActivityListeners = null
  }
}

function shouldUseUrgentBackgroundSync(): boolean {
  return typeof document !== 'undefined' && (document.hidden || !document.hasFocus())
}

function triggerUrgentBackgroundSync(): void {
  if (!shouldUseUrgentBackgroundSync()) {
    return
  }

  import('./syncStore').then(({ useSyncStore }) => {
    void useSyncStore.getState().syncUrgentNow()
  })
}

function applyScopeSummaryUpdate(payload: unknown): void {
  if (!payload || typeof payload !== 'object') {
    return
  }

  const data = payload as {
    kind?: 'channel' | 'dm'
    channel_activity?: {
      channel_id?: string
      message_id?: string | null
      inserted_at?: string | null
      sender_id?: string | null
      sender?: {
        id: string
        username: string
        display_name?: string | null
        avatar_url?: string | null
      } | null
    } | null
    conversation_reset?: {
      conversation_id?: string
      last_message?: DmConversation['last_message'] | null
    } | null
  }

  if (data.kind === 'channel' && data.channel_activity?.channel_id) {
    const activity = data.channel_activity

    if (activity.message_id && activity.inserted_at) {
      useServerStore.getState().applyChannelActivity({
        channelId: activity.channel_id,
        messageId: activity.message_id,
        insertedAt: activity.inserted_at,
        senderId: activity.sender_id ?? null,
        sender: activity.sender ?? null
      })
    } else {
      useServerStore.getState().syncChannelLastMessage({
        channelId: activity.channel_id,
        lastMessage: null
      })
    }

    return
  }

  if (data.kind === 'dm' && data.conversation_reset?.conversation_id) {
    import('./dmStore').then(({ useDmStore }) => {
      useDmStore.getState().syncConversationLastMessage({
        conversationId: data.conversation_reset?.conversation_id ?? '',
        lastMessage: data.conversation_reset?.last_message ?? null
      })
    })
  }
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
        replaceTopicPresence(topic, state)
        set({ statuses: recomputePresenceStatuses(), connected: true })
      } else if (event === 'presence_diff') {
        const diff = payload as {
          joins: Record<string, { metas: Array<{ status: string }> }>
          leaves: Record<string, unknown>
        }
        applyTopicPresenceDiff(topic, diff)
        set({ statuses: recomputePresenceStatuses() })
      } else if (event === 'new_conversation') {
        import('./dmStore').then(({ useDmStore }) => {
          const data = payload as { conversation: DmConversation }
          useDmStore.getState().addConversation(data.conversation)
        })
      } else if (event === 'scope_summary_updated') {
        applyScopeSummaryUpdate(payload)
      } else if (event === 'server_membership_revoked') {
        import('./serverStore').then(({ useServerStore }) => {
          const data = payload as {
            server_id?: string
            channel_ids?: string[]
          }

          const serverId = typeof data.server_id === 'string' ? data.server_id : null
          const channelIds = Array.isArray(data.channel_ids)
            ? data.channel_ids.filter((channelId): channelId is string => typeof channelId === 'string')
            : []

          for (const channelId of channelIds) {
            void getRendererEncryptedChat().resetScope(channelId).catch(() => {})
            void getRendererEncryptedChat().resetScope(`voice:channel:${channelId}`).catch(() => {})
          }

          if (serverId) {
            useServerStore.getState().removeServerLocally(serverId)
          }
        })
      } else if (event === 'dm_message') {
        Promise.all([
          import('./dmStore'),
          import('./unreadStore')
        ]).then(([{ useDmStore }, { useUnreadStore }]) => {
          const data = payload as {
            conversation_id: string
            message_id: string
            sender_id: string | null
            sender?: { id: string; username: string } | null
            inserted_at: string
          }

          const applied = useDmStore.getState().applyConversationActivity({
            conversationId: data.conversation_id,
            messageId: data.message_id,
            senderId: data.sender_id,
            sender: data.sender ?? null,
            insertedAt: data.inserted_at
          })

          if (!applied) {
            void useDmStore.getState().fetchConversations()
          }

          if (
            useDmStore.getState().selectedConversationId !== data.conversation_id &&
            claimUnreadMessageKey('dm', data.conversation_id, data.message_id)
          ) {
            useUnreadStore.getState().incrementDm(data.conversation_id)
          }
        })
      } else if (event === 'dm_typing_start') {
        import('./messageStore').then(({ useMessageStore }) => {
          const data = payload as {
            conversation_id: string
            payload?: {
              user_id?: string
              username?: string
            }
          }

          const conversationId = data.conversation_id
          const typingUser = data.payload
          if (!conversationId || !typingUser?.user_id) {
            return
          }

          useMessageStore.setState((state) => {
            const current = state.typingUsers[conversationId] || []
            if (current.some((entry) => entry.user_id === typingUser.user_id)) {
              return state
            }

            return {
              typingUsers: {
                ...state.typingUsers,
                [conversationId]: [
                  ...current,
                  {
                    user_id: typingUser.user_id,
                    username: typingUser.username ?? 'Someone'
                  }
                ]
              }
            }
          })
        })
      } else if (event === 'dm_typing_stop') {
        import('./messageStore').then(({ useMessageStore }) => {
          const data = payload as {
            conversation_id: string
            payload?: {
              user_id?: string
            }
          }

          const conversationId = data.conversation_id
          const userId = data.payload?.user_id
          if (!conversationId || !userId) {
            return
          }

          useMessageStore.setState((state) => ({
            typingUsers: {
              ...state.typingUsers,
              [conversationId]: (state.typingUsers[conversationId] || []).filter(
                (entry) => entry.user_id !== userId
              )
            }
          }))
        })
      } else if (
        event === 'mls_history_request_pending' ||
        event === 'mls_history_bundle_pending'
      ) {
        import('./messageStore').then(({ processPendingHistoryScope }) => {
          const data = payload as {
            scope_id: string
            topic: string
          }

          void processPendingHistoryScope(data.scope_id, data.topic).catch(() => {})
        })
      } else if (event === 'unread_update') {
        const data = payload as {
          channel_id: string
          message_id: string
          inserted_at?: string
          sender_id: string | null
          sender?: {
            id: string
            username: string
            display_name?: string | null
            avatar_url?: string | null
          } | null
        }
        Promise.all([
          import('./serverStore'),
          import('./unreadStore')
        ]).then(([{ useServerStore }, { useUnreadStore }]) => {
          if (data.inserted_at) {
            useServerStore.getState().applyChannelActivity({
              channelId: data.channel_id,
              messageId: data.message_id,
              insertedAt: data.inserted_at,
              senderId: data.sender_id,
              sender: data.sender ?? null
            })
          }
          if (useServerStore.getState().activeChannelId !== data.channel_id) {
            useUnreadStore.getState().incrementChannel(data.channel_id)
          }
        })
      } else if (event === 'mention') {
        triggerUrgentBackgroundSync()
      } else if (event === 'dm_unread_update') {
        const data = payload as { conversation_id: string; message_id: string }
        Promise.all([
          import('./dmStore'),
          import('./unreadStore')
        ]).then(([{ useDmStore }, { useUnreadStore }]) => {
          if (
            useDmStore.getState().selectedConversationId !== data.conversation_id &&
            claimUnreadMessageKey('dm', data.conversation_id, data.message_id)
          ) {
            useUnreadStore.getState().incrementDm(data.conversation_id)
          }
        })
      } else if (event === 'scope_mutation') {
        const data = payload as { kind: 'channel' | 'dm'; scope_id: string }
        queueScopeMutation(data.kind, data.scope_id)
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
        clearTopicPresence(topic)
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
          replaceTopicPresence(topic, state)
          set({ statuses: recomputePresenceStatuses() })
        } else if (event === 'presence_diff') {
          const diff = payload as {
            joins: Record<string, { metas: Array<{ status: string }> }>
            leaves: Record<string, unknown>
          }
          applyTopicPresenceDiff(topic, diff)
          set({ statuses: recomputePresenceStatuses() })
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
        } else if (
          event === 'channel_created' ||
          event === 'channel_updated' ||
          event === 'channel_deleted' ||
          event === 'channels_updated'
        ) {
          const data = payload as {
            action?: 'created' | 'updated' | 'deleted'
            channel?: import('./serverStore').Channel | null
            channel_id?: string | null
          }
          const action =
            data.action ??
            (event === 'channel_created'
              ? 'created'
              : event === 'channel_updated'
                ? 'updated'
                : event === 'channel_deleted'
                  ? 'deleted'
                  : null)

          const applied =
            action != null &&
            useServerStore.getState().applyChannelMutation({
              serverId,
              action,
              channel: data.channel ?? null,
              channelId: data.channel_id ?? null
            })

          if (!applied) {
            void useServerStore.getState().refreshServerChannels(serverId)
          }
        } else if (event === 'scope_mutation') {
          const data = payload as { kind: 'channel' | 'dm'; scope_id: string }
          queueScopeMutation(data.kind, data.scope_id)
        }
      })
    }

    serverPresenceTopics = newTopics
  },

  leaveAllServerPresence: () => {
    for (const topic of serverPresenceTopics) {
      clearTopicPresence(topic)
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
    clearTopicPresence(userTopic)
    leaveChannel(userTopic)
    userTopic = null
  }
  detachActivityListeners?.()
  for (const topic of serverPresenceTopics) {
    clearTopicPresence(topic)
    leaveChannel(topic)
  }
  serverPresenceTopics.clear()
  presenceSourcesByTopic.clear()
}
