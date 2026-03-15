import { create } from 'zustand'
import { apiFetch, apiUpload } from '../api/client'
import { useDmStore } from './dmStore'
import type { CustomEmoji } from '../utils/emoji'

const LAST_SERVER_KEY = 'vesper:lastServerId'
const LAST_CHANNEL_KEY = 'vesper:lastChannelId'

function readStoredValue(key: string): string | null {
  if (typeof window === 'undefined') {
    return null
  }

  return localStorage.getItem(key)
}

function writeStoredValue(key: string, value: string | null): void {
  if (typeof window === 'undefined') {
    return
  }

  if (value) {
    localStorage.setItem(key, value)
    return
  }

  localStorage.removeItem(key)
}

export interface Channel {
  id: string
  name: string
  type: string
  category_id?: string | null
  topic: string | null
  position: number
  disappearing_ttl: number | null
  server_id?: string
}

export interface Server {
  id: string
  name: string
  icon_url: string | null
  owner_id: string
  channels: Channel[]
  emojis: CustomEmoji[]
}

export interface Member {
  id: string
  user_id: string
  role: string
  nickname: string | null
  user: {
    id: string
    username: string
    display_name: string | null
    avatar_url: string | null
    status: string
  }
}

export interface ServerRole {
  id: string
  server_id: string
  name: string
  color: string | null
  permissions: number
  position: number
}

export interface ServerBan {
  id: string
  server_id: string
  user_id: string
  reason: string | null
  inserted_at: string
  banned_by_id: string | null
  user?: {
    id: string
    username: string
    display_name: string | null
    avatar_url: string | null
  } | null
  banned_by?: {
    id: string
    username: string
    display_name: string | null
  } | null
}

export interface AuditLogEntry {
  id: string
  server_id?: string
  action: string
  inserted_at: string
  actor_id: string | null
  target_user_id: string | null
  target_id: string | null
  metadata?: Record<string, unknown> | null
  actor?: {
    id: string
    username: string
    display_name: string | null
  } | null
  target_user?: {
    id: string
    username: string
    display_name: string | null
  } | null
}

export interface ChannelPermissionOverride {
  channel_id: string
  target_type: 'role' | 'user'
  target_id: string
  allow_view_channel: boolean
  deny_view_channel: boolean
  allow_send_messages: boolean
  deny_send_messages: boolean
}

export interface PermissionOverrideUpsertInput {
  target_type: 'role' | 'user'
  target_id: string
  allow_view_channel: boolean
  deny_view_channel: boolean
  allow_send_messages: boolean
  deny_send_messages: boolean
}

function sortChannels(channels: Channel[]): Channel[] {
  return [...channels].sort(
    (left, right) => left.position - right.position || left.name.localeCompare(right.name)
  )
}

function getFirstNavigableChannel(server: Server | undefined | null): Channel | null {
  if (!server) {
    return null
  }

  return sortChannels(server.channels).find((channel) => channel.type !== 'category') ?? null
}

async function fetchServerChannels(serverId: string): Promise<Channel[] | null> {
  try {
    const res = await apiFetch(`/api/v1/servers/${serverId}/channels`)
    if (!res.ok) {
      return null
    }

    const data = await res.json()
    return data.channels as Channel[]
  } catch {
    return null
  }
}

function normalizeServer(server: Server): Server {
  return {
    ...server,
    channels: server.channels ?? [],
    emojis: server.emojis ?? []
  }
}

function normalizePermissionOverride(
  channelId: string,
  targetType: 'role' | 'user',
  targetId: string,
  allow: unknown,
  deny: unknown
): ChannelPermissionOverride {
  const allowPermissions = Array.isArray(allow)
    ? allow
      .filter((permission): permission is string => typeof permission === 'string')
      .map((permission) => permission.trim().toLowerCase())
    : []
  const denyPermissions = Array.isArray(deny)
    ? deny
      .filter((permission): permission is string => typeof permission === 'string')
      .map((permission) => permission.trim().toLowerCase())
    : []

  return {
    channel_id: channelId,
    target_type: targetType,
    target_id: targetId,
    allow_view_channel: allowPermissions.includes('view_channel'),
    deny_view_channel: denyPermissions.includes('view_channel'),
    allow_send_messages: allowPermissions.includes('send_messages'),
    deny_send_messages: denyPermissions.includes('send_messages')
  }
}

function normalizePermissionOverrides(
  channelId: string,
  rawOverrides: unknown
): ChannelPermissionOverride[] {
  if (!rawOverrides || typeof rawOverrides !== 'object') {
    return []
  }

  const overrideMap = rawOverrides as Record<string, unknown>
  const roleOverrides = Array.isArray(overrideMap.roles)
    ? (overrideMap.roles as unknown[])
    : []
  const userOverrides = Array.isArray(overrideMap.users)
    ? (overrideMap.users as unknown[])
    : []

  const normalizedRoles = roleOverrides
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null
      }

      const typed = entry as Record<string, unknown>
      const roleId = typed.role_id
      if (typeof roleId !== 'string' || roleId.length === 0) {
        return null
      }

      return normalizePermissionOverride(
        channelId,
        'role',
        roleId,
        typed.allow,
        typed.deny
      )
    })
    .filter((entry): entry is ChannelPermissionOverride => entry !== null)

  const normalizedUsers = userOverrides
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null
      }

      const typed = entry as Record<string, unknown>
      const userId = typed.user_id
      if (typeof userId !== 'string' || userId.length === 0) {
        return null
      }

      return normalizePermissionOverride(
        channelId,
        'user',
        userId,
        typed.allow,
        typed.deny
      )
    })
    .filter((entry): entry is ChannelPermissionOverride => entry !== null)

  return [...normalizedRoles, ...normalizedUsers]
}

function serializePermissionOverrides(overrides: ChannelPermissionOverride[]): {
  roles: Array<{ role_id: string; allow: string[]; deny: string[] }>
  users: Array<{ user_id: string; allow: string[]; deny: string[] }>
} {
  const roles: Array<{ role_id: string; allow: string[]; deny: string[] }> = []
  const users: Array<{ user_id: string; allow: string[]; deny: string[] }> = []

  for (const override of overrides) {
    const allow: string[] = []
    const deny: string[] = []

    if (override.allow_view_channel) allow.push('view_channel')
    if (override.allow_send_messages) allow.push('send_messages')
    if (override.deny_view_channel) deny.push('view_channel')
    if (override.deny_send_messages) deny.push('send_messages')

    if (allow.length === 0 && deny.length === 0) {
      continue
    }

    if (override.target_type === 'role') {
      roles.push({ role_id: override.target_id, allow, deny })
    } else {
      users.push({ user_id: override.target_id, allow, deny })
    }
  }

  return { roles, users }
}

interface ServerState {
  servers: Server[]
  activeServerId: string | null
  activeChannelId: string | null
  members: Member[]
  rolesByServer: Record<string, ServerRole[]>
  bansByServer: Record<string, ServerBan[]>
  auditLogByServer: Record<string, AuditLogEntry[]>
  channelPermissionOverrides: Record<string, ChannelPermissionOverride[]>

  fetchServers: () => Promise<void>
  createServer: (name: string) => Promise<Server | null>
  joinServer: (inviteCode: string) => Promise<Server | null>
  deleteServer: (id: string) => Promise<boolean>
  leaveServer: (serverId: string) => Promise<boolean>
  setActiveServer: (id: string | null) => void
  setActiveChannel: (id: string | null) => void
  createChannel: (
    serverId: string,
    name: string,
    type?: string,
    categoryId?: string | null
  ) => Promise<Channel | null>
  deleteChannel: (serverId: string, channelId: string) => Promise<boolean>
  updateChannel: (
    serverId: string,
    channelId: string,
    attrs: Partial<Pick<Channel, 'name' | 'type' | 'category_id' | 'position' | 'topic' | 'disappearing_ttl'>>
  ) => Promise<Channel | null>
  fetchMembers: (serverId: string) => Promise<void>
  fetchRoles: (serverId: string) => Promise<ServerRole[]>
  fetchBans: (serverId: string) => Promise<ServerBan[]>
  banMember: (serverId: string, userId: string, reason?: string | null) => Promise<boolean>
  unbanMember: (serverId: string, userId: string) => Promise<boolean>
  fetchAuditLog: (serverId: string, limit?: number) => Promise<AuditLogEntry[]>
  fetchChannelPermissionOverrides: (
    serverId: string,
    channelId: string
  ) => Promise<ChannelPermissionOverride[]>
  saveChannelPermissionOverride: (
    serverId: string,
    channelId: string,
    payload: PermissionOverrideUpsertInput
  ) => Promise<ChannelPermissionOverride | null>
  deleteChannelPermissionOverride: (
    serverId: string,
    channelId: string,
    targetType: 'role' | 'user',
    targetId: string
  ) => Promise<boolean>
  kickMember: (serverId: string, userId: string) => Promise<boolean>
  updateServer: (serverId: string, attrs: { name?: string }) => Promise<boolean>
  changeMemberRole: (serverId: string, userId: string, role: string) => Promise<boolean>
  fetchServerEmojis: (serverId: string) => Promise<CustomEmoji[]>
  uploadServerEmoji: (serverId: string, file: File, name?: string) => Promise<CustomEmoji | null>
  deleteServerEmoji: (serverId: string, emojiId: string) => Promise<boolean>

  updateChannelTtl: (channelId: string, ttl: number | null) => void
  updateMemberUser: (userId: string, userData: { display_name: string | null; username: string }) => void

  getActiveServer: () => Server | undefined
  getActiveChannel: () => Channel | undefined
}

export const useServerStore = create<ServerState>((set, get) => ({
  servers: [],
  activeServerId: readStoredValue(LAST_SERVER_KEY),
  activeChannelId: readStoredValue(LAST_CHANNEL_KEY),
  members: [],
  rolesByServer: {},
  bansByServer: {},
  auditLogByServer: {},
  channelPermissionOverrides: {},

  fetchServers: async () => {
    try {
      const res = await apiFetch('/api/v1/servers')
      if (res.ok) {
        const data = await res.json()
        const servers = (data.servers as Server[]).map(normalizeServer)
        const currentServerId = get().activeServerId
        const currentChannelId = get().activeChannelId
        const restoredServer = servers.find((server) => server.id === currentServerId) ?? null
        const restoredChannel = restoredServer?.channels.find((channel) => channel.id === currentChannelId) ?? null
        const fallbackChannel = getFirstNavigableChannel(restoredServer)

        set({
          servers,
          activeServerId: restoredServer?.id ?? null,
          activeChannelId: restoredChannel?.id ?? fallbackChannel?.id ?? null
        })

        writeStoredValue(LAST_SERVER_KEY, restoredServer?.id ?? null)
        writeStoredValue(
          LAST_CHANNEL_KEY,
          restoredChannel?.id ?? fallbackChannel?.id ?? null
        )

        if (restoredServer) {
          void get().fetchMembers(restoredServer.id)
        }
      }
    } catch {
      // ignore
    }
  },

  createServer: async (name) => {
    try {
      const res = await apiFetch('/api/v1/servers', {
        method: 'POST',
        body: JSON.stringify({ name })
      })
      if (res.ok) {
        const data = await res.json()
        const server = normalizeServer(data.server as Server)
        set((s) => ({ servers: [...s.servers, server] }))
        return server
      }
    } catch {
      // ignore
    }
    return null
  },

  joinServer: async (inviteCode) => {
    try {
      const res = await apiFetch('/api/v1/servers/join', {
        method: 'POST',
        body: JSON.stringify({ invite_code: inviteCode })
      })
      if (res.ok) {
        const data = await res.json()
        const server = normalizeServer(data.server as Server)
        // Add if not already in list
        set((s) => {
          const exists = s.servers.some((srv) => srv.id === server.id)
          return exists ? s : { servers: [...s.servers, server] }
        })
        return server
      }
    } catch {
      // ignore
    }
    return null
  },

  deleteServer: async (id) => {
    try {
      const res = await apiFetch(`/api/v1/servers/${id}`, { method: 'DELETE' })
      if (res.ok) {
        set((s) => ({
          servers: s.servers.filter((srv) => srv.id !== id),
          activeServerId: s.activeServerId === id ? null : s.activeServerId,
          activeChannelId: s.activeServerId === id ? null : s.activeChannelId
        }))
        if (get().activeServerId === null) {
          writeStoredValue(LAST_SERVER_KEY, null)
          writeStoredValue(LAST_CHANNEL_KEY, null)
        }
        return true
      }
    } catch {
      // ignore
    }
    return false
  },

  leaveServer: async (serverId) => {
    try {
      const res = await apiFetch(`/api/v1/servers/${serverId}/leave`, { method: 'DELETE' })
      if (res.ok) {
        set((s) => ({
          servers: s.servers.filter((srv) => srv.id !== serverId),
          activeServerId: s.activeServerId === serverId ? null : s.activeServerId,
          activeChannelId: s.activeServerId === serverId ? null : s.activeChannelId
        }))
        if (get().activeServerId === null) {
          writeStoredValue(LAST_SERVER_KEY, null)
          writeStoredValue(LAST_CHANNEL_KEY, null)
        }
        return true
      }
    } catch {
      // ignore
    }
    return false
  },

  setActiveServer: (id) => {
    const server = get().servers.find((s) => s.id === id)
    const firstChannel = getFirstNavigableChannel(server)
    if (id) {
      useDmStore.getState().selectConversation(null)
    }
    writeStoredValue(LAST_SERVER_KEY, id)
    writeStoredValue(LAST_CHANNEL_KEY, firstChannel?.id ?? null)
    set({
      activeServerId: id,
      activeChannelId: firstChannel?.id || null,
      members: []
    })
    if (id) {
      get().fetchMembers(id)
    }
  },

  setActiveChannel: (id) => {
    if (id) {
      useDmStore.getState().selectConversation(null)
    }
    writeStoredValue(LAST_CHANNEL_KEY, id)
    set({ activeChannelId: id })
  },

  createChannel: async (serverId, name, type = 'text', categoryId = null) => {
    try {
      const res = await apiFetch(`/api/v1/servers/${serverId}/channels`, {
        method: 'POST',
        body: JSON.stringify({ name, type, category_id: categoryId })
      })
      if (res.ok) {
        const data = await res.json()
        const channels = (await fetchServerChannels(serverId)) ?? [data.channel]
        set((s) => ({
          servers: s.servers.map((srv) =>
            srv.id === serverId
              ? { ...srv, channels }
              : srv
          )
        }))
        return data.channel
      }
    } catch {
      // ignore
    }
    return null
  },

  updateChannel: async (serverId, channelId, attrs) => {
    try {
      const res = await apiFetch(`/api/v1/servers/${serverId}/channels/${channelId}`, {
        method: 'PUT',
        body: JSON.stringify(attrs)
      })
      if (res.ok) {
        const data = await res.json()
        const channels = await fetchServerChannels(serverId)
        set((s) => ({
          servers: s.servers.map((srv) =>
            srv.id === serverId
              ? {
                  ...srv,
                  channels: channels ?? srv.channels.map((channel) =>
                    channel.id === channelId ? data.channel : channel
                  )
                }
              : srv
          )
        }))
        return data.channel
      }
    } catch {
      // ignore
    }
    return null
  },

  deleteChannel: async (serverId, channelId) => {
    try {
      const res = await apiFetch(`/api/v1/servers/${serverId}/channels/${channelId}`, {
        method: 'DELETE'
      })
      if (res.ok) {
        const channels = await fetchServerChannels(serverId)
        set((s) => ({
          servers: s.servers.map((srv) =>
            srv.id === serverId
              ? { ...srv, channels: channels ?? srv.channels.filter((c) => c.id !== channelId) }
              : srv
          ),
          activeChannelId:
            s.activeChannelId === channelId
              ? getFirstNavigableChannel(
                  s.servers
                    .map((srv) =>
                      srv.id === serverId
                        ? {
                            ...srv,
                            channels: channels ?? srv.channels.filter((c) => c.id !== channelId)
                          }
                        : srv
                    )
                    .find((srv) => srv.id === serverId)
                )?.id ?? null
              : s.activeChannelId
        }))
        writeStoredValue(LAST_CHANNEL_KEY, get().activeChannelId)
        return true
      }
    } catch {
      // ignore
    }
    return false
  },

  fetchMembers: async (serverId) => {
    try {
      const res = await apiFetch(`/api/v1/servers/${serverId}/members`)
      if (res.ok) {
        const data = await res.json()
        set({ members: data.members })
      }
    } catch {
      // ignore
    }
  },

  fetchRoles: async (serverId) => {
    try {
      const res = await apiFetch(`/api/v1/servers/${serverId}/roles`)
      if (res.ok) {
        const data = await res.json()
        const roles = (data.roles as ServerRole[]) ?? []
        set((s) => ({
          rolesByServer: {
            ...s.rolesByServer,
            [serverId]: roles
          }
        }))
        return roles
      }
    } catch {
      // ignore
    }

    return []
  },

  fetchBans: async (serverId) => {
    try {
      const res = await apiFetch(`/api/v1/servers/${serverId}/bans`)
      if (res.ok) {
        const data = await res.json()
        const bans = (data.bans as ServerBan[]) ?? []
        set((s) => ({
          bansByServer: {
            ...s.bansByServer,
            [serverId]: bans
          }
        }))
        return bans
      }
    } catch {
      // ignore
    }

    return []
  },

  banMember: async (serverId, userId, reason) => {
    try {
      const res = await apiFetch(`/api/v1/servers/${serverId}/members/${userId}/ban`, {
        method: 'POST',
        body: JSON.stringify({
          ...(reason?.trim() ? { reason: reason.trim() } : {})
        })
      })
      if (res.ok) {
        set((s) => ({
          members: s.members.filter((member) => member.user_id !== userId)
        }))
        await get().fetchBans(serverId)
        return true
      }
    } catch {
      // ignore
    }

    return false
  },

  unbanMember: async (serverId, userId) => {
    try {
      const res = await apiFetch(`/api/v1/servers/${serverId}/members/${userId}/ban`, {
        method: 'DELETE'
      })
      if (res.ok) {
        set((s) => ({
          bansByServer: {
            ...s.bansByServer,
            [serverId]: (s.bansByServer[serverId] ?? []).filter((ban) => ban.user_id !== userId)
          }
        }))
        return true
      }
    } catch {
      // ignore
    }

    return false
  },

  fetchAuditLog: async (serverId, limit = 100) => {
    try {
      const res = await apiFetch(`/api/v1/servers/${serverId}/audit-logs?limit=${limit}`)
      if (res.ok) {
        const data = await res.json()
        const entries = (data.audit_logs as AuditLogEntry[]) ?? []
        set((s) => ({
          auditLogByServer: {
            ...s.auditLogByServer,
            [serverId]: entries
          }
        }))
        return entries
      }
    } catch {
      // ignore
    }

    return []
  },

  fetchChannelPermissionOverrides: async (serverId, channelId) => {
    try {
      const res = await apiFetch(`/api/v1/servers/${serverId}/channels/${channelId}`)
      if (res.ok) {
        const data = await res.json()
        const channelData = (data.channel as Record<string, unknown> | undefined) ?? {}
        const overrides = normalizePermissionOverrides(
          channelId,
          channelData.permission_overrides
        )
        set((s) => ({
          channelPermissionOverrides: {
            ...s.channelPermissionOverrides,
            [channelId]: overrides
          }
        }))
        return overrides
      }
    } catch {
      // ignore
    }

    return []
  },

  saveChannelPermissionOverride: async (serverId, channelId, payload) => {
    try {
      const existingOverrides = get().channelPermissionOverrides[channelId]
      const current = existingOverrides ?? (await get().fetchChannelPermissionOverrides(serverId, channelId))

      const next = [
        ...current.filter((entry) =>
          !(entry.target_type === payload.target_type && entry.target_id === payload.target_id)
        ),
        {
          channel_id: channelId,
          target_type: payload.target_type,
          target_id: payload.target_id,
          allow_view_channel: payload.allow_view_channel,
          deny_view_channel: payload.deny_view_channel,
          allow_send_messages: payload.allow_send_messages,
          deny_send_messages: payload.deny_send_messages
        }
      ]

      const res = await apiFetch(`/api/v1/servers/${serverId}/channels/${channelId}`, {
        method: 'PUT',
        body: JSON.stringify({
          permission_overrides: serializePermissionOverrides(next)
        })
      })
      if (res.ok) {
        const data = await res.json()
        const channelData = (data.channel as Record<string, unknown> | undefined) ?? {}
        const normalized = normalizePermissionOverrides(
          channelId,
          channelData.permission_overrides
        )

        const override = normalized.find((entry) =>
          entry.target_type === payload.target_type && entry.target_id === payload.target_id
        ) ?? null

        set((s) => {
          return {
            channelPermissionOverrides: {
              ...s.channelPermissionOverrides,
              [channelId]: normalized
            }
          }
        })
        return override
      }
    } catch {
      // ignore
    }

    return null
  },

  deleteChannelPermissionOverride: async (serverId, channelId, targetType, targetId) => {
    try {
      const existingOverrides = get().channelPermissionOverrides[channelId]
      const current = existingOverrides ?? (await get().fetchChannelPermissionOverrides(serverId, channelId))
      const next = current.filter((entry) =>
        !(entry.target_type === targetType && entry.target_id === targetId)
      )

      const res = await apiFetch(`/api/v1/servers/${serverId}/channels/${channelId}`, {
        method: 'PUT',
        body: JSON.stringify({
          permission_overrides: serializePermissionOverrides(next)
        })
      })
      if (res.ok) {
        const data = await res.json()
        const channelData = (data.channel as Record<string, unknown> | undefined) ?? {}
        const normalized = normalizePermissionOverrides(
          channelId,
          channelData.permission_overrides
        )
        set((s) => ({
          channelPermissionOverrides: {
            ...s.channelPermissionOverrides,
            [channelId]: normalized
          }
        }))
        return true
      }
    } catch {
      // ignore
    }

    return false
  },

  kickMember: async (serverId, userId) => {
    try {
      const res = await apiFetch(`/api/v1/servers/${serverId}/members/${userId}`, {
        method: 'DELETE'
      })
      if (res.ok) {
        set((s) => ({
          members: s.members.filter((m) => m.user_id !== userId)
        }))
        return true
      }
    } catch {
      // ignore
    }
    return false
  },

  updateServer: async (serverId, attrs) => {
    try {
      const res = await apiFetch(`/api/v1/servers/${serverId}`, {
        method: 'PUT',
        body: JSON.stringify({ server: attrs })
      })
      if (res.ok) {
        const data = await res.json()
        const updated = normalizeServer(data.server as Server)
        set((s) => ({
          servers: s.servers.map((srv) =>
            srv.id === serverId
              ? {
                  ...updated,
                  channels: updated.channels.length > 0 ? updated.channels : srv.channels,
                  emojis: updated.emojis
                }
              : srv
          )
        }))
        return true
      }
    } catch {
      // ignore
    }
    return false
  },

  changeMemberRole: async (serverId, userId, role) => {
    try {
      const res = await apiFetch(`/api/v1/servers/${serverId}/members/${userId}/roles`, {
        method: 'PUT',
        body: JSON.stringify({ role })
      })
      if (res.ok) {
        set((s) => ({
          members: s.members.map((m) =>
            m.user_id === userId ? { ...m, role } : m
          )
        }))
        return true
      }
    } catch {
      // ignore
    }
    return false
  },

  fetchServerEmojis: async (serverId) => {
    try {
      const res = await apiFetch(`/api/v1/servers/${serverId}/emojis`)
      if (res.ok) {
        const data = await res.json()
        const emojis = (data.emojis as CustomEmoji[]) ?? []
        set((s) => ({
          servers: s.servers.map((srv) =>
            srv.id === serverId ? { ...srv, emojis } : srv
          )
        }))
        return emojis
      }
    } catch {
      // ignore
    }

    return []
  },

  uploadServerEmoji: async (serverId, file, name) => {
    try {
      const formData = new FormData()
      formData.append('file', file)
      if (name?.trim()) {
        formData.append('name', name.trim())
      }

      const res = await apiUpload(`/api/v1/servers/${serverId}/emojis`, formData)
      if (res.ok) {
        const data = await res.json()
        const emoji = data.emoji as CustomEmoji
        set((s) => ({
          servers: s.servers.map((srv) =>
            srv.id === serverId
              ? {
                  ...srv,
                  emojis: [...srv.emojis.filter((item) => item.id !== emoji.id), emoji].sort(
                    (left, right) => left.name.localeCompare(right.name)
                  )
                }
              : srv
          )
        }))
        return emoji
      }
    } catch {
      // ignore
    }

    return null
  },

  deleteServerEmoji: async (serverId, emojiId) => {
    try {
      const res = await apiFetch(`/api/v1/servers/${serverId}/emojis/${emojiId}`, {
        method: 'DELETE'
      })
      if (res.ok) {
        set((s) => ({
          servers: s.servers.map((srv) =>
            srv.id === serverId
              ? { ...srv, emojis: srv.emojis.filter((emoji) => emoji.id !== emojiId) }
              : srv
          )
        }))
        return true
      }
    } catch {
      // ignore
    }

    return false
  },

  updateMemberUser: (userId, userData) => {
    set((s) => ({
      members: s.members.map((m) =>
        m.user_id === userId
          ? { ...m, user: { ...m.user, display_name: userData.display_name, username: userData.username } }
          : m
      )
    }))
  },

  updateChannelTtl: (channelId, ttl) => {
    set((s) => ({
      servers: s.servers.map((srv) => ({
        ...srv,
        channels: srv.channels.map((c) =>
          c.id === channelId ? { ...c, disappearing_ttl: ttl } : c
        )
      }))
    }))
  },

  getActiveServer: () => {
    const { servers, activeServerId } = get()
    return servers.find((s) => s.id === activeServerId)
  },

  getActiveChannel: () => {
    const server = get().getActiveServer()
    const { activeChannelId } = get()
    return server?.channels.find((c) => c.id === activeChannelId)
  }
}))
