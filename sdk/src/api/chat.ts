import { getDefaultHttpClient, type VesperHttpClient } from './client.js'
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
  emojis?: VesperCustomEmoji[]
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
  server_id?: string | null
  sender_id: string | null
  sender: VesperMemberPreview | null
  parent_message_id?: string | null
  inserted_at: string
  expires_at?: string | null
  content?: string
  ciphertext?: string
  mls_epoch?: number | null
  attachments?: Array<{
    id: string
    filename: string
    content_type: string
    size_bytes: number
    message_id?: string
    encrypted?: boolean
  }>
  reactions?: Array<{
    id: string
    emoji: string
    sender_id: string
    ciphertext?: string | null
    mls_epoch?: number | null
    inserted_at: string
  }>
  edited_at?: string | null
  client_nonce?: string | null
}

export interface VesperServerRole {
  id: string
  server_id: string
  name: string
  color: string | null
  permissions: number
  position: number
}

export interface VesperServerMember {
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

export interface VesperServerBan {
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

export interface VesperAuditLogEntry {
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

export interface VesperServerInvite {
  id: string
  code: string
  role_id: string | null
  max_uses: number | null
  uses: number
  expires_at: string | null
  creator: { id: string; username: string; display_name: string | null } | null
  inserted_at: string
}

export interface VesperEmojiCreator {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
}

export interface VesperCustomEmoji {
  id: string
  name: string
  url: string
  animated?: boolean
  server_id?: string
  creator?: VesperEmojiCreator | null
}

export interface VesperChannelPin {
  id: string
  message: VesperMessage
  pinned_by_id: string
  inserted_at: string
}

export interface VesperAttachmentUpload {
  attachment?: {
    id?: string
  }
}

export interface VesperChannelActivityPatch {
  channel_id: string
  message_id: string | null
  inserted_at: string | null
  sender_id: string | null
  sender?: VesperMemberPreview | null
}

export interface VesperConversationResetPatch {
  conversation_id: string
  last_message: VesperConversationMessagePreview | null
}

export interface VesperUnreadCounts {
  channels: Record<string, number>
  conversations: Record<string, number>
}

export interface VesperWorkspaceSyncResponse {
  token: string | null
  full: boolean
  servers: VesperServer[]
  conversations: VesperConversation[]
  conversation_resets: VesperConversationResetPatch[]
  channel_activity: VesperChannelActivityPatch[]
  unread_counts: VesperUnreadCounts
}

export interface VesperScopeSyncScopeRequest {
  kind: 'channel' | 'dm'
  id: string
  after?: string
  after_seq?: number
}

export interface VesperScopeSyncScopeResponse {
  scope_id: string
  kind: 'channel' | 'dm'
  has_more: boolean
  messages: VesperMessage[]
  events: Array<{
    id?: number | null
    room_seq?: number | null
    event_type: string
    message_id?: string | null
    inserted_at: string
    payload?: Record<string, unknown> | null
  }>
}

export interface VesperScopeSyncResponse {
  token: string | null
  scopes: VesperScopeSyncScopeResponse[]
}

export interface CreateServerChannelInput {
  name: string
  type?: string
  topic?: string | null
  position?: number
  category_id?: string | null
  disappearing_ttl?: number | null
}

export async function getCurrentUser(
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<VesperUser> {
  const response = await httpClient.apiFetch('/api/v1/auth/me')
  if (!response.ok) {
    throw new Error(`Could not load current user: ${response.status}`)
  }

  const data = (await response.json()) as { user?: VesperUser }
  if (!data.user) {
    throw new Error('Could not load current user: missing user payload')
  }

  return data.user
}

export async function listServers(
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<VesperServer[]> {
  const response = await httpClient.apiFetch('/api/v1/servers')
  if (!response.ok) {
    throw new Error(`Could not load servers: ${response.status}`)
  }

  const data = (await response.json()) as { servers?: VesperServer[] }
  return data.servers ?? []
}

export async function listConversations(
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<VesperConversation[]> {
  const response = await httpClient.apiFetch('/api/v1/conversations')
  if (!response.ok) {
    throw new Error(`Could not load conversations: ${response.status}`)
  }

  const data = (await response.json()) as { conversations?: VesperConversation[] }
  return data.conversations ?? []
}

export async function fetchWorkspaceSync(
  since?: string | null,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<VesperWorkspaceSyncResponse> {
  const query = since ? `?since=${encodeURIComponent(since)}` : ''
  const response = await httpClient.apiFetch(`/api/v1/sync${query}`)
  if (!response.ok) {
    throw new Error(`Could not load workspace sync: ${response.status}`)
  }

  const data = (await response.json()) as Partial<VesperWorkspaceSyncResponse>

  return {
    token: typeof data.token === 'string' ? data.token : null,
    full: Boolean(data.full),
    servers: Array.isArray(data.servers) ? data.servers : [],
    conversations: Array.isArray(data.conversations) ? data.conversations : [],
    conversation_resets: Array.isArray(data.conversation_resets)
      ? data.conversation_resets
      : [],
    channel_activity: Array.isArray(data.channel_activity) ? data.channel_activity : [],
    unread_counts:
      data.unread_counts &&
      typeof data.unread_counts === 'object' &&
      !Array.isArray(data.unread_counts)
        ? {
            channels:
              typeof data.unread_counts.channels === 'object' &&
              data.unread_counts.channels !== null
                ? data.unread_counts.channels
                : {},
            conversations:
              typeof data.unread_counts.conversations === 'object' &&
              data.unread_counts.conversations !== null
                ? data.unread_counts.conversations
                : {}
          }
        : { channels: {}, conversations: {} }
  }
}

export async function fetchScopesSync(input: {
  scopes: VesperScopeSyncScopeRequest[]
  limit?: number
  since?: string | null
}, httpClient: VesperHttpClient = getDefaultHttpClient()): Promise<VesperScopeSyncResponse> {
  const response = await httpClient.apiFetch('/api/v1/sync/scopes', {
    method: 'POST',
    body: JSON.stringify({
      scopes: input.scopes,
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
      ...(input.since ? { since: input.since } : {})
    })
  })

  if (!response.ok) {
    throw new Error(`Could not load scope sync: ${response.status}`)
  }

  const data = (await response.json()) as Partial<VesperScopeSyncResponse>

  return {
    token: typeof data.token === 'string' ? data.token : null,
    scopes: Array.isArray(data.scopes) ? data.scopes : []
  }
}

export async function searchUsers(
  username: string,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<VesperUser[]> {
  const response = await httpClient.apiFetch(
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
  name?: string,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<VesperConversation> {
  const body: {
    participant_ids: string[]
    name?: string
  } = { participant_ids: participantIds }

  if (name) {
    body.name = name
  }

  const response = await httpClient.apiFetch('/api/v1/conversations', {
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

export async function createServer(
  name: string,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<VesperServer> {
  const response = await httpClient.apiFetch('/api/v1/servers', {
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
  input: CreateServerChannelInput,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<VesperChannel> {
  const response = await httpClient.apiFetch(`/api/v1/servers/${serverId}/channels`, {
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

export async function getServerInviteCode(
  serverId: string,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<string> {
  const response = await httpClient.apiFetch(`/api/v1/servers/${serverId}/invite-code`)
  if (!response.ok) {
    throw new Error(`Could not load invite code: ${response.status}`)
  }

  const data = (await response.json()) as { invite_code?: string }
  if (!data.invite_code) {
    throw new Error('Could not load invite code: missing invite_code payload')
  }

  return data.invite_code
}

export async function joinServerByInvite(
  inviteCode: string,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<VesperServer> {
  const response = await httpClient.apiFetch('/api/v1/servers/join', {
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

export async function leaveServer(
  serverId: string,
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<void> {
  const response = await httpClient.apiFetch(`/api/v1/servers/${serverId}/leave`, {
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
  } = {},
  httpClient: VesperHttpClient = getDefaultHttpClient()
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
  const response = await httpClient.apiFetch(`/api/v1/channels/${channelId}/messages${query}`)
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
  } = {},
  httpClient: VesperHttpClient = getDefaultHttpClient()
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
  const response = await httpClient.apiFetch(
    `/api/v1/conversations/${conversationId}/messages${query}`
  )
  if (!response.ok) {
    throw new Error(`Could not load conversation messages: ${response.status}`)
  }

  const data = (await response.json()) as { messages?: VesperMessage[] }
  return data.messages ?? []
}
