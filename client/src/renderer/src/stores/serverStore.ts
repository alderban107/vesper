import { create } from 'zustand'
import { apiFetch } from '../api/client'

export interface Channel {
  id: string
  name: string
  type: string
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

interface ServerState {
  servers: Server[]
  activeServerId: string | null
  activeChannelId: string | null
  members: Member[]

  fetchServers: () => Promise<void>
  createServer: (name: string) => Promise<Server | null>
  joinServer: (inviteCode: string) => Promise<Server | null>
  deleteServer: (id: string) => Promise<boolean>
  leaveServer: (serverId: string) => Promise<boolean>
  setActiveServer: (id: string | null) => void
  setActiveChannel: (id: string | null) => void
  createChannel: (serverId: string, name: string, type?: string) => Promise<Channel | null>
  deleteChannel: (serverId: string, channelId: string) => Promise<boolean>
  fetchMembers: (serverId: string) => Promise<void>
  kickMember: (serverId: string, userId: string) => Promise<boolean>
  updateServer: (serverId: string, attrs: { name?: string }) => Promise<boolean>
  changeMemberRole: (serverId: string, userId: string, role: string) => Promise<boolean>

  updateChannelTtl: (channelId: string, ttl: number | null) => void
  updateMemberUser: (userId: string, userData: { display_name: string | null; username: string }) => void

  getActiveServer: () => Server | undefined
  getActiveChannel: () => Channel | undefined
}

export const useServerStore = create<ServerState>((set, get) => ({
  servers: [],
  activeServerId: null,
  activeChannelId: null,
  members: [],

  fetchServers: async () => {
    try {
      const res = await apiFetch('/api/v1/servers')
      if (res.ok) {
        const data = await res.json()
        set({ servers: data.servers })
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
        set((s) => ({ servers: [...s.servers, data.server] }))
        return data.server
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
        // Add if not already in list
        set((s) => {
          const exists = s.servers.some((srv) => srv.id === data.server.id)
          return exists ? s : { servers: [...s.servers, data.server] }
        })
        return data.server
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
        return true
      }
    } catch {
      // ignore
    }
    return false
  },

  setActiveServer: (id) => {
    const server = get().servers.find((s) => s.id === id)
    const firstChannel = server?.channels[0]
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
    set({ activeChannelId: id })
  },

  createChannel: async (serverId, name, type = 'text') => {
    try {
      const res = await apiFetch(`/api/v1/servers/${serverId}/channels`, {
        method: 'POST',
        body: JSON.stringify({ name, type })
      })
      if (res.ok) {
        const data = await res.json()
        set((s) => ({
          servers: s.servers.map((srv) =>
            srv.id === serverId
              ? { ...srv, channels: [...srv.channels, data.channel] }
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
        set((s) => ({
          servers: s.servers.map((srv) =>
            srv.id === serverId
              ? { ...srv, channels: srv.channels.filter((c) => c.id !== channelId) }
              : srv
          ),
          activeChannelId: s.activeChannelId === channelId ? null : s.activeChannelId
        }))
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
        set((s) => ({
          servers: s.servers.map((srv) =>
            srv.id === serverId
              ? { ...data.server, channels: srv.channels }
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
