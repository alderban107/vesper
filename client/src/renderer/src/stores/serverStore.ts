import { create } from 'zustand'
import { useDmStore } from './dmStore'
import type { CustomEmoji } from '../utils/emoji'
import { getRendererClient, getRendererEncryptedChat } from '../sdk/client'
import { getStoredValue as readStoredValue, writeStoredValue } from '../utils/localStorage'
import type {
  VesperServerRole,
  VesperServerMember,
  VesperServerBan,
  VesperAuditLogEntry
} from '@vesper/sdk/api'

const LAST_SERVER_KEY = 'vesper:lastServerId'
const LAST_CHANNEL_KEY = 'vesper:lastChannelId'

async function resetServerGroups(server: Server | undefined): Promise<void> {
  if (!server) {
    return
  }

  const encryptedChat = getRendererEncryptedChat()
  const channelIds = Array.from(new Set(server.channels.map((channel) => channel.id)))

  await Promise.allSettled(
    channelIds.map((channelId) => encryptedChat.resetScope(channelId))
  )
  await Promise.allSettled(
    channelIds.map((channelId) => encryptedChat.resetScope(`voice:channel:${channelId}`))
  )
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
  last_message_id?: string | null
  last_message_inserted_at?: string | null
  last_message_sender?: {
    id: string
    username: string
    display_name?: string | null
    avatar_url?: string | null
  } | null
  permission_overrides?: unknown
}

export interface Server {
  id: string
  name: string
  icon_url: string | null
  owner_id: string
  channels: Channel[]
  emojis: CustomEmoji[]
}

export type Member = VesperServerMember
export type ServerRole = VesperServerRole
export type ServerBan = VesperServerBan
export type AuditLogEntry = VesperAuditLogEntry

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

function parseActivityTimestamp(value: string | null | undefined): number {
  if (!value) {
    return 0
  }

  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

function mergeChannelActivity(existing: Channel | undefined, incoming: Channel): Channel {
  const existingActivityAt = parseActivityTimestamp(existing?.last_message_inserted_at)
  const incomingActivityAt = parseActivityTimestamp(incoming.last_message_inserted_at)

  if (existing && existingActivityAt > incomingActivityAt) {
    return {
      ...incoming,
      last_message_id: existing.last_message_id ?? incoming.last_message_id ?? null,
      last_message_inserted_at:
        existing.last_message_inserted_at ?? incoming.last_message_inserted_at ?? null,
      last_message_sender: existing.last_message_sender ?? incoming.last_message_sender ?? null
    }
  }

  return {
    ...incoming,
    last_message_id: incoming.last_message_id ?? existing?.last_message_id ?? null,
    last_message_inserted_at:
      incoming.last_message_inserted_at ?? existing?.last_message_inserted_at ?? null,
    last_message_sender: incoming.last_message_sender ?? existing?.last_message_sender ?? null
  }
}

function mergeServerChannels(existingChannels: Channel[], incomingChannels: Channel[]): Channel[] {
  const existingById = new Map(existingChannels.map((channel) => [channel.id, channel]))
  return sortChannels(
    incomingChannels.map((channel) => mergeChannelActivity(existingById.get(channel.id), channel))
  )
}

function upsertServerChannel(existingChannels: Channel[], channel: Channel): Channel[] {
  const existingById = new Map(existingChannels.map((entry) => [entry.id, entry]))
  existingById.set(channel.id, mergeChannelActivity(existingById.get(channel.id), channel))
  return sortChannels([...existingById.values()])
}

function removeServerChannel(existingChannels: Channel[], channelId: string): Channel[] {
  return existingChannels.filter((channel) => channel.id !== channelId)
}

function getFirstNavigableChannel(server: Server | undefined | null): Channel | null {
  if (!server) {
    return null
  }

  return sortChannels(server.channels).find((channel) => channel.type !== 'category') ?? null
}

async function fetchServerChannels(serverId: string): Promise<Channel[] | null> {
  try {
    return await getRendererClient().fetchServerChannels(serverId) as Channel[]
  } catch {
    return null
  }
}

function resolveEmojiUrls(emojis: CustomEmoji[]): CustomEmoji[] {
  if (emojis.length === 0) return emojis
  try {
    const client = getRendererClient()
    return emojis.map((emoji) =>
      emoji.url.startsWith('/')
        ? { ...emoji, url: client.resolveUrl(emoji.url) }
        : emoji
    )
  } catch {
    return emojis
  }
}

function normalizeServer(server: Server, existing?: Server): Server {
  return {
    ...server,
    channels: mergeServerChannels(existing?.channels ?? [], server.channels ?? []),
    emojis: resolveEmojiUrls(server.emojis ?? [])
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
  mergeServers: (servers: Server[]) => void
  createServer: (name: string) => Promise<Server | null>
  joinServer: (inviteCode: string) => Promise<Server | null>
  deleteServer: (id: string) => Promise<boolean>
  leaveServer: (serverId: string) => Promise<boolean>
  removeServerLocally: (serverId: string) => void
  setActiveServer: (id: string | null) => void
  setActiveChannel: (id: string | null) => void
  createChannel: (
    serverId: string,
    name: string,
    type?: string,
    categoryId?: string | null
  ) => Promise<Channel | null>
  refreshServerChannels: (serverId: string) => Promise<void>
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
  uploadServerIcon: (serverId: string, file: File) => Promise<boolean>
  fetchServerEmojis: (serverId: string) => Promise<CustomEmoji[]>
  uploadServerEmoji: (serverId: string, file: File, name?: string) => Promise<CustomEmoji | null>
  renameServerEmoji: (serverId: string, emojiId: string, name: string) => Promise<CustomEmoji | null>
  deleteServerEmoji: (serverId: string, emojiId: string) => Promise<boolean>

  updateChannelTtl: (channelId: string, ttl: number | null) => void
  applyChannelActivity: (activity: {
    channelId: string
    messageId: string
    insertedAt: string
    senderId: string | null
    sender?: {
      id: string
      username: string
      display_name?: string | null
      avatar_url?: string | null
    } | null
  }) => boolean
  syncChannelLastMessage: (payload: {
    channelId: string
    lastMessage: {
      id: string
      inserted_at: string
      sender_id: string | null
      sender?: {
        id: string
        username: string
        display_name?: string | null
        avatar_url?: string | null
      } | null
    } | null
  }) => void
  applyChannelMutation: (payload: {
    serverId: string
    action: 'created' | 'updated' | 'deleted'
    channel?: Channel | null
    channelId?: string | null
  }) => boolean
  updateMemberUser: (
    userId: string,
    userData: { display_name: string | null; username: string; avatar_url?: string | null }
  ) => void

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
      const existingById = new Map(get().servers.map((server) => [server.id, server]))
      const servers = (await getRendererClient().listServers() as Server[]).map((server) =>
        normalizeServer(server, existingById.get(server.id))
      )
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
    } catch {
      // ignore
    }
  },

  mergeServers: (incomingServers) => {
    set((state) => {
      const mergedById = new Map(state.servers.map((server) => [server.id, server]))

      for (const server of incomingServers) {
        const existing = mergedById.get(server.id)
        mergedById.set(server.id, normalizeServer(server, existing))
      }

      const orderedExistingIds = state.servers.map((server) => server.id)
      const orderedServers = [
        ...orderedExistingIds
          .map((serverId) => mergedById.get(serverId))
          .filter((server): server is Server => Boolean(server)),
        ...incomingServers
          .filter((server) => !orderedExistingIds.includes(server.id))
          .map((server) => normalizeServer(server, mergedById.get(server.id)))
      ]

      const currentServerId = state.activeServerId
      const currentChannelId = state.activeChannelId
      const restoredServer = orderedServers.find((server) => server.id === currentServerId) ?? null
      const restoredChannel =
        restoredServer?.channels.find((channel) => channel.id === currentChannelId) ?? null
      const fallbackChannel =
        restoredServer && !restoredChannel ? getFirstNavigableChannel(restoredServer) : null

      writeStoredValue(LAST_SERVER_KEY, restoredServer?.id ?? null)
      writeStoredValue(LAST_CHANNEL_KEY, restoredChannel?.id ?? fallbackChannel?.id ?? null)

      return {
        servers: orderedServers,
        activeServerId: restoredServer?.id ?? null,
        activeChannelId: restoredChannel?.id ?? fallbackChannel?.id ?? null
      }
    })
  },

  createServer: async (name) => {
    try {
      const server = normalizeServer(await getRendererClient().createServer(name) as Server)
      set((s) => ({ servers: [...s.servers, server] }))
      return server
    } catch {
      // ignore
    }
    return null
  },

  joinServer: async (inviteCode) => {
    try {
      const server = normalizeServer(
        await getRendererClient().joinServerByInvite(inviteCode) as Server
      )
      set((s) => {
        const exists = s.servers.some((srv) => srv.id === server.id)
        return exists ? s : { servers: [...s.servers, server] }
      })
      return server
    } catch {
      // ignore
    }
    return null
  },

  deleteServer: async (id) => {
    try {
      await getRendererClient().deleteServer(id)
      await resetServerGroups(get().servers.find((server) => server.id === id))
      get().removeServerLocally(id)
      return true
    } catch {
      // ignore
    }
    return false
  },

  leaveServer: async (serverId) => {
    try {
      await getRendererClient().leaveServer(serverId)
      await resetServerGroups(get().servers.find((server) => server.id === serverId))
      get().removeServerLocally(serverId)
      return true
    } catch {
      // ignore
    }
    return false
  },

  removeServerLocally: (serverId) => {
    set((state) => {
      const removedServer = state.servers.find((server) => server.id === serverId)
      const removedChannelIds = new Set((removedServer?.channels ?? []).map((channel) => channel.id))
      const activeServerRemoved = state.activeServerId === serverId
      const { [serverId]: _roles, ...rolesByServer } = state.rolesByServer
      const { [serverId]: _bans, ...bansByServer } = state.bansByServer
      const { [serverId]: _audit, ...auditLogByServer } = state.auditLogByServer

      return {
        servers: state.servers.filter((server) => server.id !== serverId),
        activeServerId: activeServerRemoved ? null : state.activeServerId,
        activeChannelId: activeServerRemoved ? null : state.activeChannelId,
        members: activeServerRemoved ? [] : state.members,
        rolesByServer,
        bansByServer,
        auditLogByServer,
        channelPermissionOverrides: Object.fromEntries(
          Object.entries(state.channelPermissionOverrides).filter(
            ([channelId]) => !removedChannelIds.has(channelId)
          )
        )
      }
    })

    if (get().activeServerId === null) {
      writeStoredValue(LAST_SERVER_KEY, null)
      writeStoredValue(LAST_CHANNEL_KEY, null)
    }
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
      if ((server?.channels.length ?? 0) === 0) {
        void get().refreshServerChannels(id)
      }
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
      const channel = await getRendererClient().createServerChannel(serverId, {
        name,
        type,
        category_id: categoryId
      }) as Channel
      get().applyChannelMutation({
        serverId,
        action: 'created',
        channel
      })
      return channel
    } catch {
      // ignore
    }
    return null
  },

  refreshServerChannels: async (serverId) => {
    const fetchedChannels = await fetchServerChannels(serverId)
    if (!fetchedChannels) {
      return
    }

    set((s) => {
      const currentServer = s.servers.find((srv) => srv.id === serverId)
      const channels = mergeServerChannels(currentServer?.channels ?? [], fetchedChannels)
      const nextServers = s.servers.map((srv) =>
        srv.id === serverId
          ? { ...srv, channels }
          : srv
      )

      const activeServer = nextServers.find((srv) => srv.id === s.activeServerId)
      const activeChannelStillVisible = activeServer?.channels.some(
        (channel) => channel.id === s.activeChannelId
      ) ?? false
      const nextActiveChannelId =
        s.activeServerId === serverId && !activeChannelStillVisible
          ? getFirstNavigableChannel(activeServer)?.id ?? null
          : s.activeChannelId

      if (s.activeServerId === serverId) {
        writeStoredValue(LAST_CHANNEL_KEY, nextActiveChannelId)
      }

      return {
        servers: nextServers,
        activeChannelId: nextActiveChannelId
      }
    })
  },

  updateChannel: async (serverId, channelId, attrs) => {
    try {
      const channel = await getRendererClient().updateServerChannel(serverId, channelId, attrs)
      get().applyChannelMutation({
        serverId,
        action: 'updated',
        channel
      })
      return channel
    } catch {
      // ignore
    }
    return null
  },

  deleteChannel: async (serverId, channelId) => {
    try {
      await getRendererClient().deleteServerChannel(serverId, channelId)
      get().applyChannelMutation({
        serverId,
        action: 'deleted',
        channelId
      })
      return true
    } catch {
      // ignore
    }
    return false
  },

  fetchMembers: async (serverId) => {
    try {
      set({ members: await getRendererClient().fetchServerMembers(serverId) })
    } catch {
      // ignore
    }
  },

  fetchRoles: async (serverId) => {
    try {
      const roles = await getRendererClient().listServerRoles(serverId)
      set((s) => ({
        rolesByServer: {
          ...s.rolesByServer,
          [serverId]: roles
        }
      }))
      return roles
    } catch {
      // ignore
    }

    return []
  },

  fetchBans: async (serverId) => {
    try {
      const bans = await getRendererClient().fetchServerBans(serverId)
      set((s) => ({
        bansByServer: {
          ...s.bansByServer,
          [serverId]: bans
        }
      }))
      return bans
    } catch {
      // ignore
    }

    return []
  },

  banMember: async (serverId, userId, reason) => {
    try {
      await getRendererClient().banServerMember(serverId, userId, reason)
      set((s) => ({
        members: s.members.filter((member) => member.user_id !== userId)
      }))
      await get().fetchBans(serverId)
      return true
    } catch {
      // ignore
    }

    return false
  },

  unbanMember: async (serverId, userId) => {
    try {
      await getRendererClient().unbanServerMember(serverId, userId)
      set((s) => ({
        bansByServer: {
          ...s.bansByServer,
          [serverId]: (s.bansByServer[serverId] ?? []).filter((ban) => ban.user_id !== userId)
        }
      }))
      return true
    } catch {
      // ignore
    }

    return false
  },

  fetchAuditLog: async (serverId, limit = 100) => {
    try {
      const entries = await getRendererClient().fetchServerAuditLog(serverId, limit)
      set((s) => ({
        auditLogByServer: {
          ...s.auditLogByServer,
          [serverId]: entries
        }
      }))
      return entries
    } catch {
      // ignore
    }

    return []
  },

  fetchChannelPermissionOverrides: async (serverId, channelId) => {
    try {
      const channelData = await getRendererClient().fetchServerChannel(serverId, channelId)
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

      const channelData = await getRendererClient().updateServerChannel(
        serverId,
        channelId,
        {
          permission_overrides: serializePermissionOverrides(next)
        }
      )
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

      const channelData = await getRendererClient().updateServerChannel(
        serverId,
        channelId,
        {
          permission_overrides: serializePermissionOverrides(next)
        }
      )
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
    } catch {
      // ignore
    }

    return false
  },

  kickMember: async (serverId, userId) => {
    try {
      await getRendererClient().kickServerMember(serverId, userId)
      set((s) => ({
        members: s.members.filter((m) => m.user_id !== userId)
      }))
      return true
    } catch {
      // ignore
    }
    return false
  },

  updateServer: async (serverId, attrs) => {
    try {
      const updated = normalizeServer(
        await getRendererClient().updateServerDetails(serverId, attrs) as Server
      )
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
    } catch {
      // ignore
    }
    return false
  },

  changeMemberRole: async (serverId, userId, role) => {
    try {
      await getRendererClient().updateServerMemberRole(serverId, userId, role)
      set((s) => ({
        members: s.members.map((m) =>
          m.user_id === userId ? { ...m, role } : m
        )
      }))
      return true
    } catch {
      // ignore
    }
    return false
  },

  uploadServerIcon: async (serverId, file) => {
    try {
      const formData = new FormData()
      formData.append('file', file)

      const updated = await getRendererClient().uploadServerIcon(serverId, formData) as Server
      set((s) => ({
        servers: s.servers.map((srv) =>
          srv.id === serverId
            ? {
                ...normalizeServer(updated, srv),
                channels: srv.channels.length > 0 ? srv.channels : updated.channels ?? []
              }
            : srv
        )
      }))
      return true
    } catch {
      // ignore
    }
    return false
  },

  fetchServerEmojis: async (serverId) => {
    try {
      const emojis = await getRendererClient().fetchServerEmojis(serverId)
      set((s) => ({
        servers: s.servers.map((srv) =>
          srv.id === serverId ? { ...srv, emojis } : srv
        )
      }))
      return emojis
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

      const emoji = await getRendererClient().uploadServerEmoji(serverId, formData)
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
    } catch {
      // ignore
    }

    return null
  },

  renameServerEmoji: async (serverId, emojiId, name) => {
    try {
      const emoji = await getRendererClient().renameServerEmoji(serverId, emojiId, name)
      set((s) => ({
        servers: s.servers.map((srv) =>
          srv.id === serverId
            ? {
                ...srv,
                emojis: srv.emojis.map((e) => (e.id === emojiId ? { ...e, name: emoji.name } : e))
              }
            : srv
        )
      }))
      return emoji
    } catch {
      // ignore
    }
    return null
  },

  deleteServerEmoji: async (serverId, emojiId) => {
    try {
      await getRendererClient().deleteServerEmoji(serverId, emojiId)
      set((s) => ({
        servers: s.servers.map((srv) =>
          srv.id === serverId
            ? { ...srv, emojis: srv.emojis.filter((emoji) => emoji.id !== emojiId) }
            : srv
        )
      }))
      return true
    } catch {
      // ignore
    }

    return false
  },

  updateMemberUser: (userId, userData) => {
    set((s) => ({
      members: s.members.map((m) =>
        m.user_id === userId
          ? {
              ...m,
              user: {
                ...m.user,
                display_name: userData.display_name,
                username: userData.username,
                avatar_url:
                  userData.avatar_url === undefined ? m.user.avatar_url : userData.avatar_url
              }
            }
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

  applyChannelActivity: (activity) => {
    let applied = false

    set((s) => ({
      servers: s.servers.map((srv) => ({
        ...srv,
        channels: srv.channels.map((channel) => {
          if (channel.id !== activity.channelId) {
            return channel
          }

          const currentActivityAt = parseActivityTimestamp(channel.last_message_inserted_at)
          const nextActivityAt = parseActivityTimestamp(activity.insertedAt)
          if (currentActivityAt > nextActivityAt) {
            return channel
          }

          applied = true
          return {
            ...channel,
            last_message_id: activity.messageId,
            last_message_inserted_at: activity.insertedAt,
            last_message_sender:
              activity.sender ??
              (activity.senderId
                ? {
                    id: activity.senderId,
                    username: 'Unknown'
                  }
                : null)
          }
        })
      }))
    }))

    return applied
  },

  syncChannelLastMessage: ({ channelId, lastMessage }) => {
    set((s) => ({
      servers: s.servers.map((srv) => ({
        ...srv,
        channels: srv.channels.map((channel) =>
          channel.id === channelId
            ? {
                ...channel,
                last_message_id: lastMessage?.id ?? null,
                last_message_inserted_at: lastMessage?.inserted_at ?? null,
                last_message_sender:
                  lastMessage?.sender ??
                  (lastMessage?.sender_id
                    ? {
                        id: lastMessage.sender_id,
                        username: 'Unknown'
                      }
                    : null)
              }
            : channel
        )
      }))
    }))
  },

  applyChannelMutation: ({ serverId, action, channel, channelId }) => {
    let applied = false

    set((s) => {
      const payloadChannel = channel
        ? (() => {
            const {
              permission_overrides: _permissionOverrides,
              ...nextChannel
            } = channel as Channel & { permission_overrides?: unknown }
            return nextChannel
          })()
        : null
      const nextServers = s.servers.map((srv) => {
        if (srv.id !== serverId) {
          return srv
        }

        applied = true

        if (action === 'deleted') {
          return {
            ...srv,
            channels: removeServerChannel(srv.channels, channelId ?? '')
          }
        }

        if (!payloadChannel) {
          return srv
        }

        return {
          ...srv,
          channels: upsertServerChannel(srv.channels, payloadChannel)
        }
      })

      if (!applied) {
        return s
      }

      const activeServer = nextServers.find((srv) => srv.id === s.activeServerId)
      const activeChannelStillVisible = activeServer?.channels.some(
        (entry) => entry.id === s.activeChannelId
      ) ?? false
      const nextActiveChannelId =
        s.activeServerId === serverId && !activeChannelStillVisible
          ? getFirstNavigableChannel(activeServer)?.id ?? null
          : s.activeChannelId

      if (s.activeServerId === serverId && nextActiveChannelId !== s.activeChannelId) {
        writeStoredValue(LAST_CHANNEL_KEY, nextActiveChannelId)
      }

      const nextChannelPermissionOverrides = { ...s.channelPermissionOverrides }

      if (action === 'deleted' && channelId) {
        delete nextChannelPermissionOverrides[channelId]
      } else if (channel && Object.prototype.hasOwnProperty.call(channel, 'permission_overrides')) {
        nextChannelPermissionOverrides[channel.id] = normalizePermissionOverrides(
          channel.id,
          channel.permission_overrides
        )
      }

      return {
        servers: nextServers,
        activeChannelId: nextActiveChannelId,
        channelPermissionOverrides: nextChannelPermissionOverrides
      }
    })

    return applied
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
