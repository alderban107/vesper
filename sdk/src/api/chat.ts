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
  channels_loaded?: boolean
  emojis?: VesperCustomEmoji[]
  emojis_loaded?: boolean
}

type VesperServerWire = Omit<VesperServer, 'channels' | 'emojis'> & {
  channels?: VesperChannel[]
  emojis?: VesperCustomEmoji[]
}

function hydrateServers(servers: VesperServerWire[] | undefined): VesperServer[] {
  if (!Array.isArray(servers)) return []

  return servers.map((server) => ({
    ...server,
    channels: Array.isArray(server.channels) ? server.channels : [],
    channels_loaded: server.channels_loaded === true,
    emojis: Array.isArray(server.emojis) ? server.emojis : [],
    emojis_loaded: server.emojis_loaded === true
  }))
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
  channel_id?: string | null
  disappearing_ttl: number | null
  inserted_at: string
  participants: VesperConversationParticipant[]
  last_message: VesperConversationMessagePreview | null
}

type VesperConversationWire = Omit<VesperConversation, 'participants' | 'last_message'> & {
  participants: Array<Omit<VesperConversationParticipant, 'user'> & { user?: VesperUser | null }>
  last_message:
    | (Omit<VesperConversationMessagePreview, 'sender'> & {
        sender?: VesperMemberPreview | null
      })
    | null
}

function hydrateConversations(
  conversations: VesperConversationWire[] | undefined,
  users: VesperUser[] | Record<string, VesperUser> | undefined
): VesperConversation[] {
  if (!Array.isArray(conversations)) return []

  const usersById = Array.isArray(users)
    ? Object.fromEntries(users.map((user) => [user.id, user]))
    : users

  return conversations.map((conversation) => ({
    ...conversation,
    participants: conversation.participants.map((participant) => {
      const user = participant.user ?? usersById?.[participant.user_id]
      if (!user) {
        throw new Error(`Conversation participant ${participant.user_id} is missing user data`)
      }
      return { ...participant, user }
    }),
    last_message: conversation.last_message
      ? {
          ...conversation.last_message,
          sender:
            conversation.last_message.sender ??
            (conversation.last_message.sender_id
              ? usersById?.[conversation.last_message.sender_id] ?? null
              : null)
        }
      : null
  }))
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
  thread_root_message_id?: string | null
  reply_to_message_id?: string | null
  is_reply?: boolean
  inserted_at: string
  expires_at?: string | null
  content?: string
  ciphertext?: string
  mls_epoch?: number | null
  encryption_scheme?: 'mls' | 'vesper-room-v1'
  encryption_group_id?: string | null
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
    encryption_scheme?: 'mls' | 'vesper-room-v1'
    encryption_group_id?: string | null
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

export interface VesperSavedMessage {
  id: string
  message_id: string
  channel_id: string | null
  note: string | null
  saved_at: string
  message: VesperMessage
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
  has_more: boolean
  servers: VesperServer[]
  conversations: VesperConversation[]
  conversations_has_more: boolean
  conversations_next_cursor: string | null
  conversation_resets: VesperConversationResetPatch[]
  channel_activity: VesperChannelActivityPatch[]
  unread_counts: VesperUnreadCounts
}

export interface VesperScopeSyncScopeRequest {
  kind: 'channel' | 'dm'
  id: string
  after?: string
  before?: string
  after_seq?: number
}

export interface VesperScopeSyncScopeResponse {
  scope_id: string
  kind: 'channel' | 'dm'
  has_more: boolean
  older_cursor: string | null
  latest_room_seq: number
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

export interface VesperConversationPage {
  conversations: VesperConversation[]
  unreadCounts: Record<string, number>
  hasMore: boolean
  nextCursor: string | null
}

export async function listConversationsPage(
  options: { before?: string | null; limit?: number } = {},
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<VesperConversationPage> {
  const query = new URLSearchParams()
  query.set('limit', String(Math.min(Math.max(options.limit ?? 100, 1), 250)))
  if (options.before) {
    query.set('before', options.before)
  }

  const response = await httpClient.apiFetch(`/api/v1/conversations?${query.toString()}`)
  if (!response.ok) {
    throw new Error(`Could not load conversations: ${response.status}`)
  }

  const data = (await response.json()) as {
    conversations?: VesperConversationWire[]
    users?: VesperUser[] | Record<string, VesperUser>
    unread_counts?: Record<string, number>
    has_more?: boolean
    next_cursor?: string | null
  }

  return {
    conversations: hydrateConversations(data.conversations, data.users),
    unreadCounts:
      data.unread_counts && typeof data.unread_counts === 'object'
        ? data.unread_counts
        : {},
    hasMore: data.has_more === true,
    nextCursor: typeof data.next_cursor === 'string' ? data.next_cursor : null
  }
}

export async function listConversations(
  httpClient: VesperHttpClient = getDefaultHttpClient()
): Promise<VesperConversation[]> {
  return (await listConversationsPage({}, httpClient)).conversations
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

  const data = (await response.json()) as Omit<
    Partial<VesperWorkspaceSyncResponse>,
    'servers' | 'conversations'
  > & {
    servers?: VesperServerWire[]
    conversations?: VesperConversationWire[]
    users?: VesperUser[] | Record<string, VesperUser>
  }

  return {
    token: typeof data.token === 'string' ? data.token : null,
    full: Boolean(data.full),
    has_more: data.has_more === true,
    servers: hydrateServers(data.servers),
    conversations: hydrateConversations(data.conversations, data.users),
    conversations_has_more: data.conversations_has_more === true,
    conversations_next_cursor:
      typeof data.conversations_next_cursor === 'string'
        ? data.conversations_next_cursor
        : null,
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
