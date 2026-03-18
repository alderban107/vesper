import { apiFetch } from './client.js'
import type { VesperUser } from '../auth/session.js'

export interface VesperMemberPreview {
  id: string
  username: string
  display_name?: string | null
  avatar_url?: string | null
}

export interface VesperChannel {
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
  last_message_sender?: VesperMemberPreview | null
  permission_overrides?: unknown
}

export interface VesperServer {
  id: string
  name: string
  icon_url: string | null
  owner_id: string
  channels: VesperChannel[]
}

export interface VesperConversationParticipant {
  id: string
  user_id: string
  joined_at: string
  user: VesperUser
}

export interface VesperConversationMessagePreview {
  id: string
  content?: string
  ciphertext?: string
  sender_id: string | null
  sender: VesperMemberPreview | null
  inserted_at: string
}

export interface VesperConversation {
  id: string
  type: string
  name: string | null
  disappearing_ttl: number | null
  inserted_at: string
  participants: VesperConversationParticipant[]
  last_message: VesperConversationMessagePreview | null
}

export interface VesperMessage {
  id: string
  room_seq?: number | null
  channel_id?: string | null
  conversation_id?: string | null
  sender_id: string | null
  sender: VesperMemberPreview | null
  parent_message_id?: string | null
  inserted_at: string
  content?: string
  ciphertext?: string
  mls_epoch?: number | null
}

export interface CreateServerChannelInput {
  name: string
  type?: string
  topic?: string | null
  position?: number
  category_id?: string | null
  disappearing_ttl?: number | null
}

export async function getCurrentUser(): Promise<VesperUser> {
  const response = await apiFetch('/api/v1/auth/me')
  if (!response.ok) {
    throw new Error(`Could not load current user: ${response.status}`)
  }

  const data = (await response.json()) as { user?: VesperUser }
  if (!data.user) {
    throw new Error('Could not load current user: missing user payload')
  }

  return data.user
}

export async function listServers(): Promise<VesperServer[]> {
  const response = await apiFetch('/api/v1/servers')
  if (!response.ok) {
    throw new Error(`Could not load servers: ${response.status}`)
  }

  const data = (await response.json()) as { servers?: VesperServer[] }
  return data.servers ?? []
}

export async function listConversations(): Promise<VesperConversation[]> {
  const response = await apiFetch('/api/v1/conversations')
  if (!response.ok) {
    throw new Error(`Could not load conversations: ${response.status}`)
  }

  const data = (await response.json()) as { conversations?: VesperConversation[] }
  return data.conversations ?? []
}

export async function searchUsers(username: string): Promise<VesperUser[]> {
  const response = await apiFetch(
    `/api/v1/users/search?username=${encodeURIComponent(username)}`
  )
  if (!response.ok) {
    throw new Error(`Could not search users: ${response.status}`)
  }

  const data = (await response.json()) as { users?: VesperUser[] }
  return data.users ?? []
}

export async function createConversation(
  participantIds: string[],
  name?: string
): Promise<VesperConversation> {
  const body: {
    participant_ids: string[]
    name?: string
  } = { participant_ids: participantIds }

  if (name) {
    body.name = name
  }

  const response = await apiFetch('/api/v1/conversations', {
    method: 'POST',
    body: JSON.stringify(body)
  })
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error || 'Could not create conversation')
  }

  const data = (await response.json()) as { conversation?: VesperConversation }
  if (!data.conversation) {
    throw new Error('Could not create conversation: missing conversation payload')
  }

  return data.conversation
}

export async function createServer(name: string): Promise<VesperServer> {
  const response = await apiFetch('/api/v1/servers', {
    method: 'POST',
    body: JSON.stringify({ name })
  })
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error || 'Could not create server')
  }

  const data = (await response.json()) as { server?: VesperServer }
  if (!data.server) {
    throw new Error('Could not create server: missing server payload')
  }

  return data.server
}

export async function createServerChannel(
  serverId: string,
  input: CreateServerChannelInput
): Promise<VesperChannel> {
  const response = await apiFetch(`/api/v1/servers/${serverId}/channels`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'text',
      ...input
    })
  })
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as {
      error?: string
      errors?: Record<string, string[]>
    }
    throw new Error(
      data.error ||
        Object.entries(data.errors ?? {})
          .map(([key, value]) => `${key}: ${value.join(', ')}`)
          .join('; ') ||
        'Could not create channel'
    )
  }

  const data = (await response.json()) as { channel?: VesperChannel }
  if (!data.channel) {
    throw new Error('Could not create channel: missing channel payload')
  }

  return data.channel
}

export async function getServerInviteCode(serverId: string): Promise<string> {
  const response = await apiFetch(`/api/v1/servers/${serverId}/invite-code`)
  if (!response.ok) {
    throw new Error(`Could not load invite code: ${response.status}`)
  }

  const data = (await response.json()) as { invite_code?: string }
  if (!data.invite_code) {
    throw new Error('Could not load invite code: missing invite_code payload')
  }

  return data.invite_code
}

export async function joinServerByInvite(inviteCode: string): Promise<VesperServer> {
  const response = await apiFetch('/api/v1/servers/join', {
    method: 'POST',
    body: JSON.stringify({ invite_code: inviteCode })
  })
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error || 'Could not join server')
  }

  const data = (await response.json()) as { server?: VesperServer }
  if (!data.server) {
    throw new Error('Could not join server: missing server payload')
  }

  return data.server
}

export async function leaveServer(serverId: string): Promise<void> {
  const response = await apiFetch(`/api/v1/servers/${serverId}/leave`, {
    method: 'DELETE'
  })

  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error || 'Could not leave server')
  }
}

export async function fetchChannelMessages(
  channelId: string,
  options: {
    limit?: number
    before?: string
    after?: string
    afterSeq?: number
    lean?: boolean
  } = {}
): Promise<VesperMessage[]> {
  const params = new URLSearchParams()
  if (options.limit !== undefined) {
    params.set('limit', String(options.limit))
  }
  if (options.before) {
    params.set('before', options.before)
  }
  if (options.after) {
    params.set('after', options.after)
  }
  if (typeof options.afterSeq === 'number') {
    params.set('after_seq', String(options.afterSeq))
  }
  if (options.lean) {
    params.set('lean', '1')
  }

  const query = params.size > 0 ? `?${params}` : ''
  const response = await apiFetch(`/api/v1/channels/${channelId}/messages${query}`)
  if (!response.ok) {
    throw new Error(`Could not load channel messages: ${response.status}`)
  }

  const data = (await response.json()) as { messages?: VesperMessage[] }
  return data.messages ?? []
}

export async function fetchConversationMessages(
  conversationId: string,
  options: {
    limit?: number
    before?: string
    after?: string
    afterSeq?: number
    lean?: boolean
  } = {}
): Promise<VesperMessage[]> {
  const params = new URLSearchParams()
  if (options.limit !== undefined) {
    params.set('limit', String(options.limit))
  }
  if (options.before) {
    params.set('before', options.before)
  }
  if (options.after) {
    params.set('after', options.after)
  }
  if (typeof options.afterSeq === 'number') {
    params.set('after_seq', String(options.afterSeq))
  }
  if (options.lean) {
    params.set('lean', '1')
  }

  const query = params.size > 0 ? `?${params}` : ''
  const response = await apiFetch(
    `/api/v1/conversations/${conversationId}/messages${query}`
  )
  if (!response.ok) {
    throw new Error(`Could not load conversation messages: ${response.status}`)
  }

  const data = (await response.json()) as { messages?: VesperMessage[] }
  return data.messages ?? []
}
