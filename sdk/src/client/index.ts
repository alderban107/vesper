import {
  ackPendingHistoryBundle,
  ackPendingHistoryRequest,
  ackPendingResyncRequest,
  ackPendingWelcome,
  fetchPendingHistoryBundles,
  fetchPendingHistoryRequests,
  fetchPendingResyncRequests,
  fetchPendingWelcomes
} from '../api/crypto.js'
import {
  createConversation,
  createServer,
  createServerChannel,
  fetchChannelMessages,
  fetchConversationMessages,
  fetchScopesSync,
  fetchWorkspaceSync,
  getCurrentUser,
  getServerInviteCode,
  joinServerByInvite,
  leaveServer,
  listConversations,
  listServers,
  searchUsers,
  type CreateServerChannelInput,
  type VesperAttachmentUpload,
  type VesperAuditLogEntry,
  type VesperChannel,
  type VesperChannelActivityPatch,
  type VesperChannelPin,
  type VesperConversation,
  type VesperConversationMessagePreview,
  type VesperConversationResetPatch,
  type VesperCustomEmoji,
  type VesperEmojiCreator,
  type VesperMessage,
  type VesperScopeSyncScopeRequest,
  type VesperScopeSyncResponse,
  type VesperServer,
  type VesperServerBan,
  type VesperServerInvite,
  type VesperServerMember,
  type VesperServerRole,
  type VesperWorkspaceSyncResponse,
  type VesperUnreadCounts
} from '../api/chat.js'
import {
  VesperHttpClient,
  type SessionStore
} from '../api/client.js'
import { VesperSocketClient } from '../api/socket.js'
import { getVoiceRtcConfig, type VoiceRtcConfig } from '../api/voiceConfig.js'
import {
  VesperAuthClient,
  type VesperAuthClientOptions,
  type VesperAuthDevice,
  type VesperAuthSession,
  type VesperUser
} from '../auth/session.js'
import type { LocalDeviceIdentity } from '../auth/deviceIdentity.js'
import {
  createCryptoStorageRuntime,
  type CryptoStorageConfig,
  type CryptoStorageRuntime
} from '../crypto/storage.js'
import { createVesperTransport } from '../transport/context.js'
import { createEncryptedChat, type VesperEncryptedChat } from './encryptedChat.js'

type ClientStatus = 'signed_out' | 'ready'
type ScopeKind = 'channel' | 'dm'
type ScopeWatcher = {
  topic: string
  listeners: Set<Listener<VesperClientScopeEvent>>
  disposeChannel: () => void
}

export interface VesperClientState {
  status: ClientStatus
  started: boolean
  connected: boolean
  user: VesperUser | null
  currentDevice: VesperAuthDevice | null
  devices: VesperAuthDevice[]
  canUseE2EE: boolean
  servers: VesperServer[]
  conversations: VesperConversation[]
  unreadCounts: VesperUnreadCounts
  syncToken: string | null
}

export interface VesperClientRawEvent {
  event: string
  payload: unknown
}

export interface VesperClientDeviceEvent {
  device: VesperAuthDevice
  currentDevice: VesperAuthDevice | null
  devices: VesperAuthDevice[]
  canUseE2EE: boolean
}

export interface VesperClientScopeEvent {
  topic: string
  event: string
  payload: unknown
}

export interface VesperClientEvents {
  state: VesperClientState
  ready: VesperClientState
  connected: VesperClientState
  'connection.lost': VesperClientState
  'connection.error': Error
  disconnected: VesperClientState
  'workspace.updated': VesperClientState
  'servers.updated': VesperServer[]
  'conversations.updated': VesperConversation[]
  'devices.updated': VesperClientDeviceEvent
  raw: VesperClientRawEvent
  'scope.event': VesperClientScopeEvent
  error: Error
}

export interface VesperClientOptions {
  baseUrl?: string
  fetchImpl?: typeof fetch
  sessionStore?: SessionStore
  storage?: CryptoStorageConfig
  storageRuntime?: CryptoStorageRuntime
  heartbeatIntervalMs?: number
  auth?: VesperAuthClientOptions
}

type Listener<T> = (payload: T) => void
type TopicListener = (event: string, payload: unknown) => void

class TypedEmitter<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<Listener<unknown>>>()

  on<EventName extends keyof Events>(
    event: EventName,
    listener: Listener<Events[EventName]>
  ): () => void {
    const current = this.listeners.get(event) ?? new Set<Listener<unknown>>()
    current.add(listener as Listener<unknown>)
    this.listeners.set(event, current)

    return () => {
      current.delete(listener as Listener<unknown>)
      if (current.size === 0) {
        this.listeners.delete(event)
      }
    }
  }

  emit<EventName extends keyof Events>(event: EventName, payload: Events[EventName]): void {
    const listeners = this.listeners.get(event)
    if (!listeners) {
      return
    }

    for (const listener of listeners) {
      try {
        ;(listener as Listener<Events[EventName]>)(payload)
      } catch (error) {
        if (event !== 'error') {
          this.emit('error' as EventName, error as Events[EventName])
        }
      }
    }
  }

  listenerCount<EventName extends keyof Events>(event: EventName): number {
    return this.listeners.get(event)?.size ?? 0
  }
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000
const UNREAD_EVENT_DEDUPE_WINDOW_MS = 15_000
const FIRE_AND_FORGET_SCOPE_EVENTS = new Set([
  'typing_start',
  'typing_stop',
  'new_message',
  'mls_request_join',
  'mls_request_join_all',
  'mls_resync_request',
  'mls_commit',
  'mls_remove',
  'mls_welcome',
  'mls_history_request',
  'mls_history_bundle'
])

function defaultState(): VesperClientState {
  return {
    status: 'signed_out',
    started: false,
    connected: false,
    user: null,
    currentDevice: null,
    devices: [],
    canUseE2EE: false,
    servers: [],
    conversations: [],
    unreadCounts: {
      channels: {},
      conversations: {}
    },
    syncToken: null
  }
}

function parseActivityTimestamp(value: string | null | undefined): number {
  if (!value) {
    return 0
  }

  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

function toError(value: unknown, fallback: string): Error {
  if (value instanceof Error) {
    return value
  }

  if (typeof value === 'string' && value.length > 0) {
    return new Error(value)
  }

  return new Error(fallback)
}

function getConversationActivityTimestamp(conversation: VesperConversation): number {
  return parseActivityTimestamp(conversation.last_message?.inserted_at ?? conversation.inserted_at)
}

function mergeConversation(
  existing: VesperConversation | undefined,
  incoming: VesperConversation
): VesperConversation {
  if (!existing) {
    return incoming
  }

  if (getConversationActivityTimestamp(existing) > getConversationActivityTimestamp(incoming)) {
    return {
      ...incoming,
      last_message: existing.last_message
    }
  }

  return {
    ...incoming,
    last_message: incoming.last_message ?? existing.last_message
  }
}

function mergeConversations(
  existing: VesperConversation[],
  incoming: VesperConversation[]
): VesperConversation[] {
  const merged = new Map<string, VesperConversation>()

  for (const conversation of existing) {
    merged.set(conversation.id, conversation)
  }

  for (const conversation of incoming) {
    merged.set(conversation.id, mergeConversation(merged.get(conversation.id), conversation))
  }

  return [...merged.values()].sort(
    (left, right) => getConversationActivityTimestamp(right) - getConversationActivityTimestamp(left)
  )
}

function sortServerChannels(channels: VesperChannel[]): VesperChannel[] {
  return [...channels].sort(
    (left, right) => left.position - right.position || left.name.localeCompare(right.name)
  )
}

function mergeServerChannel(
  existing: VesperChannel | undefined,
  incoming: VesperChannel
): VesperChannel {
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

function mergeServerChannels(
  existingChannels: VesperChannel[],
  incomingChannels: VesperChannel[]
): VesperChannel[] {
  const existingById = new Map(existingChannels.map((channel) => [channel.id, channel]))
  return sortServerChannels(
    incomingChannels.map((channel) => mergeServerChannel(existingById.get(channel.id), channel))
  )
}

function replaceServerInServers(
  servers: VesperServer[],
  incomingServer: VesperServer
): VesperServer[] {
  const current = servers.find((server) => server.id === incomingServer.id)

  if (!current) {
    return mergeServers(servers, [incomingServer])
  }

  return servers.map((server) =>
    server.id === incomingServer.id
      ? {
          ...current,
          ...incomingServer,
          channels: mergeServerChannels(current.channels, incomingServer.channels)
        }
      : server
  )
}

function replaceServerChannels(
  servers: VesperServer[],
  serverId: string,
  channels: VesperChannel[]
): VesperServer[] {
  return servers.map((server) =>
    server.id === serverId
      ? {
          ...server,
          channels: mergeServerChannels(server.channels, channels)
        }
      : server
  )
}

function upsertServerChannel(
  servers: VesperServer[],
  serverId: string,
  incomingChannel: VesperChannel
): VesperServer[] {
  return servers.map((server) => {
    if (server.id !== serverId) {
      return server
    }

    const byId = new Map(server.channels.map((channel) => [channel.id, channel]))
    byId.set(
      incomingChannel.id,
      mergeServerChannel(byId.get(incomingChannel.id), incomingChannel)
    )

    return {
      ...server,
      channels: sortServerChannels([...byId.values()])
    }
  })
}

function removeServerChannel(
  servers: VesperServer[],
  serverId: string,
  channelId: string
): VesperServer[] {
  return servers.map((server) =>
    server.id === serverId
      ? {
          ...server,
          channels: server.channels.filter((channel) => channel.id !== channelId)
        }
      : server
  )
}

function initializeChannelUnreadCounts(
  unreadCounts: Record<string, number>,
  channels: VesperChannel[]
): Record<string, number> {
  const next = { ...unreadCounts }

  for (const channel of channels) {
    next[channel.id] = next[channel.id] ?? 0
  }

  return next
}

function mergeServers(existing: VesperServer[], incoming: VesperServer[]): VesperServer[] {
  const merged = new Map(existing.map((server) => [server.id, server]))

  for (const server of incoming) {
    const current = merged.get(server.id)
    if (!current) {
      merged.set(server.id, server)
      continue
    }

    merged.set(server.id, {
      ...current,
      ...server,
      channels: mergeServerChannels(current.channels, server.channels)
    })
  }

  return [...merged.values()]
}

function applyChannelActivityToServers(
  servers: VesperServer[],
  activity: VesperChannelActivityPatch
): VesperServer[] {
  return servers.map((server) => ({
    ...server,
    channels: server.channels.map((channel) => {
      if (channel.id !== activity.channel_id) {
        return channel
      }

      return {
        ...channel,
        last_message_id: activity.message_id,
        last_message_inserted_at: activity.inserted_at,
        last_message_sender: activity.sender ?? null
      } satisfies VesperChannel
    })
  }))
}

function applyConversationReset(
  conversations: VesperConversation[],
  reset: VesperConversationResetPatch
): VesperConversation[] {
  return conversations
    .map((conversation) =>
      conversation.id === reset.conversation_id
        ? {
            ...conversation,
            last_message: reset.last_message
          }
        : conversation
    )
    .sort(
      (left, right) => getConversationActivityTimestamp(right) - getConversationActivityTimestamp(left)
    )
}

function applyConversationActivity(
  conversations: VesperConversation[],
  activity: {
    conversation_id: string
    message_id: string
    sender_id: string | null
    sender?: {
      id: string
      username: string
      display_name?: string | null
      avatar_url?: string | null
    } | null
    inserted_at: string
  }
): VesperConversation[] {
  return mergeConversations(
    conversations,
    conversations
      .filter((conversation) => conversation.id === activity.conversation_id)
      .map((conversation) => ({
        ...conversation,
        last_message: {
          id: activity.message_id,
          sender_id: activity.sender_id,
          sender: activity.sender ?? null,
          inserted_at: activity.inserted_at
        } satisfies VesperConversationMessagePreview
      }))
  )
}

function removeServer(
  servers: VesperServer[],
  unreadCounts: VesperUnreadCounts,
  serverId: string
): {
  servers: VesperServer[]
  unreadCounts: VesperUnreadCounts
} {
  const removed = servers.find((server) => server.id === serverId)
  if (!removed) {
    return { servers, unreadCounts }
  }

  const nextChannelUnreads = { ...unreadCounts.channels }
  for (const channel of removed.channels) {
    delete nextChannelUnreads[channel.id]
  }

  return {
    servers: servers.filter((server) => server.id !== serverId),
    unreadCounts: {
      channels: nextChannelUnreads,
      conversations: unreadCounts.conversations
    }
  }
}

export class VesperClient {
  private readonly emitter = new TypedEmitter<VesperClientEvents>()
  private readonly auth: VesperAuthClient
  private readonly httpClient: VesperHttpClient
  private readonly socketClient: VesperSocketClient
  private readonly heartbeatIntervalMs: number
  private readonly storageRuntime: CryptoStorageRuntime
  private readonly scopeWatchers = new Map<string, ScopeWatcher>()
  private readonly pendingScopeWatchers = new Map<string, Promise<ScopeWatcher>>()
  private readonly recentUnreadMessageKeys = new Map<string, number>()
  private readonly resolveDeviceIdentity: (() => LocalDeviceIdentity) | null

  private authSession: VesperAuthSession | null = null
  private encryptedChat: VesperEncryptedChat | null = null
  private state: VesperClientState = defaultState()
  private userTopic: string | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private unsubscribeSocketOpen: (() => void) | null = null
  private unsubscribeSocketClose: (() => void) | null = null
  private unsubscribeSocketError: (() => void) | null = null
  private seenSocketOpen = false

  constructor(options: VesperClientOptions = {}) {
    const storageRuntime =
      options.auth?.storageRuntime ??
      options.storageRuntime ??
      createCryptoStorageRuntime(options.auth?.storage ?? options.storage)

    const transport = createVesperTransport({
      baseUrl: options.baseUrl,
      fetchImpl: options.fetchImpl,
      sessionStore: options.sessionStore
    })

    this.httpClient = transport.httpClient
    this.socketClient = transport.socketClient
    this.storageRuntime = storageRuntime
    this.resolveDeviceIdentity = options.auth?.getDeviceIdentity ?? null
    this.auth = new VesperAuthClient({
      ...options.auth,
      storageRuntime,
      transport: {
        httpClient: this.httpClient,
        socketClient: this.socketClient
      },
      httpClient: this.httpClient,
      socketClient: this.socketClient
    })
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
  }

  get deviceIdentity(): LocalDeviceIdentity | null {
    return this.resolveDeviceIdentity ? this.resolveDeviceIdentity() : null
  }

  /** @internal */
  getAuthSession(): VesperAuthSession | null {
    return this.authSession
  }

  /** @internal */
  getHttpClient(): VesperHttpClient {
    return this.httpClient
  }

  /** @internal */
  getSessionStore(): SessionStore {
    return this.httpClient.getSessionStore()
  }

  /** @internal */
  getSocketClient(): VesperSocketClient {
    return this.socketClient
  }

  /** @internal */
  getAuthClient(): VesperAuthClient {
    return this.auth
  }

  /** @internal */
  getStorageRuntime(): CryptoStorageRuntime {
    return this.storageRuntime
  }

  getServerUrl(): string {
    return this.httpClient.getServerUrl()
  }

  async apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
    return await this.httpClient.apiFetch(path, options)
  }

  async apiUpload(path: string, formData: FormData): Promise<Response> {
    return await this.httpClient.apiUpload(path, formData)
  }

  resolveUrl(path: string): string {
    const baseUrl = this.httpClient.getServerUrl().replace(/\/+$/, '')
    const normalizedPath = path.startsWith('/') ? path : `/${path}`
    return `${baseUrl}${normalizedPath}`
  }

  private resolveEmojiUrls(emojis: VesperCustomEmoji[]): VesperCustomEmoji[] {
    return emojis.map((e) => ({
      ...e,
      url: e.url.startsWith('/') ? this.resolveUrl(e.url) : e.url
    }))
  }

  async runWithStorageContext<T>(operation: () => Promise<T>): Promise<T> {
    return await this.storageRuntime.run(
      this.authSession?.user.id ?? this.state.user?.id ?? null,
      operation
    )
  }

  async fetchJson<T>(path: string, options: RequestInit = {}, fallbackMessage?: string): Promise<T> {
    const response = await this.httpClient.apiFetch(path, options)
    await this.assertResponseOk(
      response,
      fallbackMessage ?? `Request to ${path} failed with status ${response.status}`
    )
    return (await response.json()) as T
  }

  async uploadJson<T>(path: string, formData: FormData, fallbackMessage?: string): Promise<T> {
    const response = await this.httpClient.apiUpload(path, formData)
    await this.assertResponseOk(
      response,
      fallbackMessage ?? `Upload to ${path} failed with status ${response.status}`
    )
    return (await response.json()) as T
  }

  createEncryptedChat(): VesperEncryptedChat {
    if (!this.encryptedChat) {
      this.encryptedChat = createEncryptedChat(this)
    }

    return this.encryptedChat
  }

  getState(): VesperClientState {
    return {
      ...this.state,
      devices: [...this.state.devices],
      servers: [...this.state.servers],
      conversations: [...this.state.conversations],
      unreadCounts: {
        channels: { ...this.state.unreadCounts.channels },
        conversations: { ...this.state.unreadCounts.conversations }
      }
    }
  }

  subscribe(listener: Listener<VesperClientState>): () => void {
    return this.on('state', listener)
  }

  on<EventName extends keyof VesperClientEvents>(
    event: EventName,
    listener: Listener<VesperClientEvents[EventName]>
  ): () => void {
    return this.emitter.on(event, listener)
  }

  listenerCount<EventName extends keyof VesperClientEvents>(event: EventName): number {
    return this.emitter.listenerCount(event)
  }

  async register(username: string, password: string): Promise<VesperAuthSession> {
    const session = await this.auth.register(username, password)
    await this.applySession(session)
    return session
  }

  async login(username: string, password: string): Promise<VesperAuthSession> {
    const session = await this.auth.login(username, password)
    await this.applySession(session)
    return session
  }

  async restoreSession(): Promise<VesperAuthSession | null> {
    const session = await this.auth.checkAuth()
    if (!session) {
      this.authSession = null
      this.replaceState(defaultState())
      return null
    }

    await this.applySession(session)
    return session
  }

  async recoverAccount(mnemonic: string, newPassword: string): Promise<VesperAuthSession> {
    const session = await this.auth.recoverAccount(mnemonic, newPassword)
    await this.applySession(session)
    return session
  }

  async verifyRecoveryKey(mnemonic: string): Promise<void> {
    await this.auth.verifyRecoveryKey(mnemonic)
  }

  async start(forceFull = true): Promise<VesperClientState | null> {
    const session =
      this.authSession ??
      (this.state.user
        ? {
            user: this.state.user,
            currentDevice: this.state.currentDevice,
            devices: this.state.devices,
            canUseE2EE: this.state.canUseE2EE,
            recoveryMnemonic: null
          }
        : await this.restoreSession())

    if (!session?.user) {
      return null
    }

    if (!this.unsubscribeSocketOpen) {
      this.unsubscribeSocketOpen = this.socketClient.onSocketOpen(() => {
        if (!this.seenSocketOpen) {
          this.seenSocketOpen = true
          this.setState({ connected: true })
          this.emitter.emit('connected', this.getState())
          return
        }

        void this.handleSocketReconnect().catch((error) => {
          this.emitError(error)
        })
      })
    }

    if (!this.unsubscribeSocketClose) {
      this.unsubscribeSocketClose = this.socketClient.onSocketClose((event) => {
        if (!this.state.connected) {
          return
        }

        this.setState({ connected: false })
        this.emitter.emit('connection.lost', this.getState())
      })
    }

    if (!this.unsubscribeSocketError) {
      this.unsubscribeSocketError = this.socketClient.onSocketError((error) => {
        const nextError = toError(error, 'Vesper socket transport failed.')

        if (this.state.connected) {
          this.setState({ connected: false })
          this.emitter.emit('connection.lost', this.getState())
        }

        this.emitter.emit('connection.error', nextError)
        this.emitError(nextError)
      })
    }

    this.seenSocketOpen = false
    this.socketClient.connect()
    await this.connectUserFeed(session.user.id)
    await this.syncNow(forceFull)
    this.setState({ started: true })
    this.emitter.emit('ready', this.getState())
    return this.getState()
  }

  stop(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }

    if (this.userTopic) {
      this.socketClient.leaveChannel(this.userTopic)
      this.userTopic = null
    }

    for (const watcher of this.scopeWatchers.values()) {
      watcher.disposeChannel()
    }
    this.scopeWatchers.clear()
    this.pendingScopeWatchers.clear()
    this.socketClient.disconnect()

    this.unsubscribeSocketOpen?.()
    this.unsubscribeSocketOpen = null
    this.unsubscribeSocketClose?.()
    this.unsubscribeSocketClose = null
    this.unsubscribeSocketError?.()
    this.unsubscribeSocketError = null
    this.seenSocketOpen = false
    this.setState({
      started: false,
      connected: false
    })
    this.emitter.emit('disconnected', this.getState())
  }

  async logout(): Promise<void> {
    this.stop()
    await this.auth.logout()
    await this.runWithStorageContext(async () => {
      this.storageRuntime.reset()
    })
    this.authSession = null
    this.replaceState(defaultState())
  }

  async syncNow(forceFull = false): Promise<VesperClientState> {
    const since = forceFull ? null : this.state.syncToken
    const syncState = await fetchWorkspaceSync(since, this.httpClient)

    this.setState({
      status: this.state.user ? 'ready' : 'signed_out',
      servers: mergeServers(
        forceFull ? [] : this.state.servers,
        syncState.servers
      ),
      conversations: mergeConversations(
        forceFull ? [] : this.state.conversations,
        syncState.conversations
      ),
      unreadCounts: syncState.full || forceFull
        ? syncState.unread_counts
        : {
            channels: {
              ...this.state.unreadCounts.channels,
              ...syncState.unread_counts.channels
            },
            conversations: {
              ...this.state.unreadCounts.conversations,
              ...syncState.unread_counts.conversations
            }
          },
      syncToken: syncState.token ?? this.state.syncToken
    })

    for (const activity of syncState.channel_activity) {
      this.applyChannelActivity(activity)
    }

    for (const reset of syncState.conversation_resets) {
      this.applyConversationReset(reset)
    }

    this.emitter.emit('workspace.updated', this.getState())
    return this.getState()
  }

  async fetchDevices(): Promise<VesperClientState> {
    if (!this.state.user) {
      return this.getState()
    }

    const devices = await this.auth.fetchDevices({
      devices: this.state.devices,
      currentDevice: this.state.currentDevice,
      user: this.state.user
    })

    this.setState({
      devices: devices.devices,
      currentDevice: devices.currentDevice,
      canUseE2EE: devices.canUseE2EE
    })

    if (this.state.currentDevice) {
      this.emitter.emit('devices.updated', {
        device: this.state.currentDevice,
        currentDevice: this.state.currentDevice,
        devices: this.state.devices,
        canUseE2EE: this.state.canUseE2EE
      })
    }

    return this.getState()
  }

  async approveDevice(deviceId: string): Promise<void> {
    await this.auth.approveDevice(deviceId)
    await this.fetchDevices()
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.auth.revokeDevice(deviceId)
    await this.fetchDevices()
  }

  async approveCurrentDeviceWithRecovery(mnemonic: string): Promise<VesperClientState> {
    const session = await this.auth.approveCurrentDeviceWithRecovery(mnemonic)
    await this.applySession(session)
    return this.getState()
  }

  async unlockTrustedDevice(password: string): Promise<VesperClientState> {
    if (!this.state.user) {
      throw new Error('No signed-in user.')
    }

    const session = await this.auth.unlockTrustedDevice(
      this.state.user,
      this.state.currentDevice,
      password
    )
    await this.applySession(session)
    return this.getState()
  }

  async updateProfile(attrs: {
    display_name?: string | null
    avatar_url?: string
    banner_url?: string
    status?: string
  }): Promise<VesperUser> {
    const user = await this.auth.updateProfile(attrs)
    this.setState({ user })
    return user
  }

  async uploadAvatar(file: File): Promise<VesperUser> {
    const user = await this.auth.uploadAvatar(file)
    this.setState({ user })
    return user
  }

  async uploadBanner(file: File): Promise<VesperUser> {
    const user = await this.auth.uploadBanner(file)
    this.setState({ user })
    return user
  }

  async searchUsers(username: string): Promise<VesperUser[]> {
    return await searchUsers(username, this.httpClient)
  }

  async listServers(): Promise<VesperServer[]> {
    const servers = await listServers(this.httpClient)
    for (const server of servers) {
      const raw = server as Record<string, unknown>
      if (Array.isArray(raw.emojis)) {
        raw.emojis = this.resolveEmojiUrls(raw.emojis as VesperCustomEmoji[])
      }
    }
    this.setState({
      servers: mergeServers(this.state.servers, servers)
    })
    this.emitter.emit('servers.updated', [...this.state.servers])
    return servers
  }

  async listConversations(): Promise<VesperConversation[]> {
    const conversations = await listConversations(this.httpClient)
    this.setState({
      conversations: mergeConversations(this.state.conversations, conversations)
    })
    this.emitter.emit('conversations.updated', [...this.state.conversations])
    return conversations
  }

  async replenishKeyPackages(): Promise<void> {
    await this.auth.replenishKeyPackages(this.state.user, this.state.canUseE2EE)
  }

  async createConversation(participantIds: string[], name?: string): Promise<VesperConversation> {
    const conversation = await createConversation(participantIds, name, this.httpClient)
    this.setState({
      conversations: mergeConversations(this.state.conversations, [conversation]),
      unreadCounts: {
        channels: this.state.unreadCounts.channels,
        conversations: {
          ...this.state.unreadCounts.conversations,
          [conversation.id]: this.state.unreadCounts.conversations[conversation.id] ?? 0
        }
      }
    })
    this.emitter.emit('conversations.updated', [...this.state.conversations])
    return conversation
  }

  async createServer(name: string): Promise<VesperServer> {
    const server = await createServer(name, this.httpClient)
    this.setState({
      servers: mergeServers(this.state.servers, [server]),
      unreadCounts: {
        channels: initializeChannelUnreadCounts(this.state.unreadCounts.channels, server.channels),
        conversations: this.state.unreadCounts.conversations
      }
    })
    this.emitter.emit('servers.updated', [...this.state.servers])
    return server
  }

  async joinServerByInvite(inviteCode: string): Promise<VesperServer> {
    const server = await joinServerByInvite(inviteCode, this.httpClient)
    this.setState({
      servers: mergeServers(this.state.servers, [server]),
      unreadCounts: {
        channels: initializeChannelUnreadCounts(this.state.unreadCounts.channels, server.channels),
        conversations: this.state.unreadCounts.conversations
      }
    })
    this.emitter.emit('servers.updated', [...this.state.servers])
    return server
  }

  async leaveServer(serverId: string): Promise<void> {
    await leaveServer(serverId, this.httpClient)
    await this.resetServerScopes(serverId)
    const next = removeServer(this.state.servers, this.state.unreadCounts, serverId)
    this.setState(next)
    this.emitter.emit('servers.updated', [...this.state.servers])
  }

  async deleteServer(serverId: string): Promise<void> {
    const response = await this.httpClient.apiFetch(`/api/v1/servers/${serverId}`, {
      method: 'DELETE'
    })
    await this.assertResponseOk(response, 'Could not delete server')
    await this.resetServerScopes(serverId)
    const next = removeServer(this.state.servers, this.state.unreadCounts, serverId)
    this.setState(next)
    this.emitter.emit('servers.updated', [...this.state.servers])
  }

  async fetchServerChannels(serverId: string): Promise<VesperChannel[]> {
    const data = await this.fetchJson<{ channels?: VesperChannel[] }>(
      `/api/v1/servers/${serverId}/channels`,
      {},
      'Could not load server channels'
    )
    const channels = data.channels ?? []

    this.setState({
      servers: replaceServerChannels(this.state.servers, serverId, channels)
    })
    this.emitter.emit('servers.updated', [...this.state.servers])

    return channels
  }

  async createServerChannel(
    serverId: string,
    input: CreateServerChannelInput
  ): Promise<VesperChannel> {
    const channel = await createServerChannel(serverId, input, this.httpClient)

    this.setState({
      servers: upsertServerChannel(this.state.servers, serverId, channel),
      unreadCounts: {
        channels: {
          ...this.state.unreadCounts.channels,
          [channel.id]: this.state.unreadCounts.channels[channel.id] ?? 0
        },
        conversations: this.state.unreadCounts.conversations
      }
    })
    this.emitter.emit('servers.updated', [...this.state.servers])

    return channel
  }

  async updateServerChannel(
    serverId: string,
    channelId: string,
    attrs: Record<string, unknown>
  ): Promise<VesperChannel> {
    const data = await this.fetchJson<{ channel?: VesperChannel }>(
      `/api/v1/servers/${serverId}/channels/${channelId}`,
      {
        method: 'PUT',
        body: JSON.stringify(attrs)
      },
      'Could not update channel'
    )

    if (!data.channel) {
      throw new Error('Could not update channel: missing channel payload')
    }

    this.setState({
      servers: upsertServerChannel(this.state.servers, serverId, data.channel)
    })
    this.emitter.emit('servers.updated', [...this.state.servers])

    return data.channel
  }

  async deleteServerChannel(serverId: string, channelId: string): Promise<void> {
    const response = await this.httpClient.apiFetch(`/api/v1/servers/${serverId}/channels/${channelId}`, {
      method: 'DELETE'
    })
    await this.assertResponseOk(response, 'Could not delete channel')

    await this.resetChannelScopes([channelId])

    const nextChannelUnreads = { ...this.state.unreadCounts.channels }
    delete nextChannelUnreads[channelId]

    this.setState({
      servers: removeServerChannel(this.state.servers, serverId, channelId),
      unreadCounts: {
        channels: nextChannelUnreads,
        conversations: this.state.unreadCounts.conversations
      }
    })
    this.emitter.emit('servers.updated', [...this.state.servers])
  }

  async fetchServerChannel(serverId: string, channelId: string): Promise<VesperChannel> {
    const data = await this.fetchJson<{ channel?: VesperChannel }>(
      `/api/v1/servers/${serverId}/channels/${channelId}`,
      {},
      'Could not load channel'
    )

    if (!data.channel) {
      throw new Error('Could not load channel: missing channel payload')
    }

    this.setState({
      servers: upsertServerChannel(this.state.servers, serverId, data.channel)
    })
    this.emitter.emit('servers.updated', [...this.state.servers])

    return data.channel
  }

  async fetchServerMembers(serverId: string): Promise<VesperServerMember[]> {
    const data = await this.fetchJson<{ members?: VesperServerMember[] }>(
      `/api/v1/servers/${serverId}/members`,
      {},
      'Could not load server members'
    )
    return data.members ?? []
  }

  async fetchServerInviteCode(serverId: string): Promise<string> {
    return await getServerInviteCode(serverId, this.httpClient)
  }

  async listServerInvites(serverId: string): Promise<VesperServerInvite[]> {
    const data = await this.fetchJson<{ invites?: VesperServerInvite[] }>(
      `/api/v1/servers/${serverId}/invites`,
      {},
      'Could not load invites'
    )
    return data.invites ?? []
  }

  async createServerInvite(
    serverId: string,
    input: {
      expires_in_seconds?: number
      max_uses?: number
      role_id?: string
    }
  ): Promise<VesperServerInvite> {
    const data = await this.fetchJson<{ invite?: VesperServerInvite }>(
      `/api/v1/servers/${serverId}/invites`,
      {
        method: 'POST',
        body: JSON.stringify(input)
      },
      'Could not create invite'
    )

    if (!data.invite) {
      throw new Error('Could not create invite: missing invite payload')
    }

    return data.invite
  }

  async deleteServerInvite(serverId: string, inviteId: string): Promise<void> {
    const response = await this.httpClient.apiFetch(`/api/v1/servers/${serverId}/invites/${inviteId}`, {
      method: 'DELETE'
    })
    await this.assertResponseOk(response, 'Could not delete invite')
  }

  async listServerRoles(serverId: string): Promise<VesperServerRole[]> {
    const data = await this.fetchJson<{ roles?: VesperServerRole[] }>(
      `/api/v1/servers/${serverId}/roles`,
      {},
      'Could not load server roles'
    )
    return data.roles ?? []
  }

  async createServerRole(
    serverId: string,
    input: {
      name: string
      permissions: number
      color: string | null
    }
  ): Promise<VesperServerRole> {
    const data = await this.fetchJson<{ role?: VesperServerRole }>(
      `/api/v1/servers/${serverId}/roles`,
      {
        method: 'POST',
        body: JSON.stringify(input)
      },
      'Could not create role'
    )

    if (!data.role) {
      throw new Error('Could not create role: missing role payload')
    }

    return data.role
  }

  async updateServerRole(
    serverId: string,
    roleId: string,
    input: {
      name: string
      permissions: number
      color: string | null
    }
  ): Promise<VesperServerRole> {
    const data = await this.fetchJson<{ role?: VesperServerRole }>(
      `/api/v1/servers/${serverId}/roles/${roleId}`,
      {
        method: 'PUT',
        body: JSON.stringify(input)
      },
      'Could not update role'
    )

    if (!data.role) {
      throw new Error('Could not update role: missing role payload')
    }

    return data.role
  }

  async deleteServerRole(serverId: string, roleId: string): Promise<void> {
    const response = await this.httpClient.apiFetch(`/api/v1/servers/${serverId}/roles/${roleId}`, {
      method: 'DELETE'
    })
    await this.assertResponseOk(response, 'Could not delete role')
  }

  async fetchServerBans(serverId: string): Promise<VesperServerBan[]> {
    const data = await this.fetchJson<{ bans?: VesperServerBan[] }>(
      `/api/v1/servers/${serverId}/bans`,
      {},
      'Could not load server bans'
    )
    return data.bans ?? []
  }

  async banServerMember(serverId: string, userId: string, reason?: string): Promise<void> {
    const response = await this.httpClient.apiFetch(`/api/v1/servers/${serverId}/members/${userId}/ban`, {
      method: 'POST',
      body: JSON.stringify({
        ...(reason?.trim() ? { reason: reason.trim() } : {})
      })
    })
    await this.assertResponseOk(response, 'Could not ban member')
  }

  async unbanServerMember(serverId: string, userId: string): Promise<void> {
    const response = await this.httpClient.apiFetch(`/api/v1/servers/${serverId}/members/${userId}/ban`, {
      method: 'DELETE'
    })
    await this.assertResponseOk(response, 'Could not unban member')
  }

  async fetchServerAuditLog(serverId: string, limit = 100): Promise<VesperAuditLogEntry[]> {
    const data = await this.fetchJson<{ audit_logs?: VesperAuditLogEntry[] }>(
      `/api/v1/servers/${serverId}/audit-logs?limit=${limit}`,
      {},
      'Could not load audit log'
    )
    return data.audit_logs ?? []
  }

  async kickServerMember(serverId: string, userId: string): Promise<void> {
    const response = await this.httpClient.apiFetch(`/api/v1/servers/${serverId}/members/${userId}`, {
      method: 'DELETE'
    })
    await this.assertResponseOk(response, 'Could not remove member')
  }

  async updateServerDetails(
    serverId: string,
    attrs: Record<string, unknown>
  ): Promise<VesperServer> {
    const data = await this.fetchJson<{ server?: VesperServer }>(
      `/api/v1/servers/${serverId}`,
      {
        method: 'PUT',
        body: JSON.stringify({ server: attrs })
      },
      'Could not update server'
    )

    if (!data.server) {
      throw new Error('Could not update server: missing server payload')
    }

    this.setState({
      servers: replaceServerInServers(this.state.servers, data.server)
    })
    this.emitter.emit('servers.updated', [...this.state.servers])

    return data.server
  }

  async updateServerMemberRole(serverId: string, userId: string, role: string): Promise<void> {
    const response = await this.httpClient.apiFetch(`/api/v1/servers/${serverId}/members/${userId}/roles`, {
      method: 'PUT',
      body: JSON.stringify({ role })
    })
    await this.assertResponseOk(response, 'Could not update member role')
  }

  async fetchServerEmojis(serverId: string): Promise<VesperCustomEmoji[]> {
    const data = await this.fetchJson<{ emojis?: VesperCustomEmoji[] }>(
      `/api/v1/servers/${serverId}/emojis`,
      {},
      'Could not load server emojis'
    )
    return this.resolveEmojiUrls(data.emojis ?? [])
  }

  async uploadServerEmoji(serverId: string, formData: FormData): Promise<VesperCustomEmoji> {
    const data = await this.uploadJson<{ emoji?: VesperCustomEmoji }>(
      `/api/v1/servers/${serverId}/emojis`,
      formData,
      'Could not upload emoji'
    )

    if (!data.emoji) {
      throw new Error('Could not upload emoji: missing emoji payload')
    }

    const [resolved] = this.resolveEmojiUrls([data.emoji])
    return resolved
  }

  async uploadServerIcon(serverId: string, formData: FormData): Promise<VesperServer> {
    const data = await this.uploadJson<{ server?: VesperServer }>(
      `/api/v1/servers/${serverId}/icon`,
      formData,
      'Could not upload server icon'
    )

    if (!data.server) {
      throw new Error('Could not upload server icon: missing server payload')
    }

    this.setState({
      servers: replaceServerInServers(this.state.servers, data.server)
    })
    this.emitter.emit('servers.updated', [...this.state.servers])

    return data.server
  }

  async renameServerEmoji(serverId: string, emojiId: string, name: string): Promise<VesperCustomEmoji> {
    const data = await this.fetchJson<{ emoji?: VesperCustomEmoji }>(
      `/api/v1/servers/${serverId}/emojis/${emojiId}`,
      { method: 'PATCH', body: JSON.stringify({ name }) },
      'Could not rename emoji'
    )

    if (!data.emoji) {
      throw new Error('Could not rename emoji: missing emoji payload')
    }

    const [resolved] = this.resolveEmojiUrls([data.emoji])
    return resolved
  }

  async deleteServerEmoji(serverId: string, emojiId: string): Promise<void> {
    const response = await this.httpClient.apiFetch(`/api/v1/servers/${serverId}/emojis/${emojiId}`, {
      method: 'DELETE'
    })
    await this.assertResponseOk(response, 'Could not delete emoji')
  }

  async listChannelPins(channelId: string): Promise<VesperChannelPin[]> {
    const data = await this.fetchJson<{ pins?: VesperChannelPin[] }>(
      `/api/v1/channels/${channelId}/pins`,
      {},
      'Could not load pinned messages'
    )
    return data.pins ?? []
  }

  async markChannelRead(channelId: string, messageId: string): Promise<void> {
    const response = await this.httpClient.apiFetch(`/api/v1/channels/${channelId}/read`, {
      method: 'PUT',
      body: JSON.stringify({ message_id: messageId })
    })
    await this.assertResponseOk(response, 'Could not mark channel as read')
    this.clearUnreadCount('channel', channelId)
  }

  async markConversationRead(conversationId: string, messageId: string): Promise<void> {
    const response = await this.httpClient.apiFetch(`/api/v1/conversations/${conversationId}/read`, {
      method: 'PUT',
      body: JSON.stringify({ message_id: messageId })
    })
    await this.assertResponseOk(response, 'Could not mark conversation as read')
    this.clearUnreadCount('dm', conversationId)
  }

  async fetchUnreadCounts(): Promise<VesperUnreadCounts> {
    const data = await this.fetchJson<Partial<VesperUnreadCounts>>(
      '/api/v1/unread',
      {},
      'Could not load unread counts'
    )

    return {
      channels:
        data.channels && typeof data.channels === 'object' ? data.channels : {},
      conversations:
        data.conversations && typeof data.conversations === 'object'
          ? data.conversations
          : {}
    }
  }

  async fetchWorkspaceDelta(since?: string | null): Promise<VesperWorkspaceSyncResponse> {
    return await fetchWorkspaceSync(since, this.httpClient)
  }

  async fetchUrgentSyncEvents(since?: string | null): Promise<{
    token: string | null
    events: Array<{
      id: number
      scope_kind: 'channel' | 'dm'
      scope_id: string
      event_type: string
      inserted_at: string
      payload?: Record<string, unknown>
    }>
  }> {
    const query = since ? `?since=${encodeURIComponent(since)}` : ''
    const data = await this.fetchJson<{
      token?: string | null
      events?: Array<{
        id: number
        scope_kind: 'channel' | 'dm'
        scope_id: string
        event_type: string
        inserted_at: string
        payload?: Record<string, unknown>
      }>
    }>(`/api/v1/sync/urgent${query}`, {}, 'Could not load urgent sync events')

    return {
      token: typeof data.token === 'string' ? data.token : null,
      events: Array.isArray(data.events) ? data.events : []
    }
  }

  async fetchMessagesByIds(messageIds: string[]): Promise<VesperMessage[]> {
    const query = new URLSearchParams()
    query.set('ids', messageIds.join(','))
    const data = await this.fetchJson<{ messages?: VesperMessage[] }>(
      `/api/v1/messages?${query.toString()}`,
      {},
      'Could not load messages'
    )
    return data.messages ?? []
  }

  async fetchMessageRecord(messageId: string): Promise<VesperMessage | null> {
    const data = await this.fetchJson<{ message?: VesperMessage }>(
      `/api/v1/messages/${messageId}`,
      {},
      'Could not load message'
    )
    return data.message ?? null
  }

  async fetchThreadRecords(parentMessageId: string, limit = 200): Promise<{
    parent: VesperMessage | null
    messages: VesperMessage[]
  }> {
    const data = await this.fetchJson<{
      parent?: VesperMessage
      messages?: VesperMessage[]
    }>(`/api/v1/messages/${parentMessageId}/thread?limit=${limit}`, {}, 'Could not load thread')

    return {
      parent: data.parent ?? null,
      messages: data.messages ?? []
    }
  }

  async fetchAttachmentBytes(attachmentId: string): Promise<ArrayBuffer> {
    const response = await this.httpClient.apiFetch(`/api/v1/attachments/${attachmentId}`)
    await this.assertResponseOk(response, `Could not load attachment: status ${response.status}`)
    return await response.arrayBuffer()
  }

  async uploadAttachment(formData: FormData): Promise<VesperAttachmentUpload> {
    return await this.uploadJson<VesperAttachmentUpload>('/api/v1/attachments', formData, 'Could not upload attachment')
  }

  async fetchCurrentUser(): Promise<VesperUser> {
    const user = await getCurrentUser(this.httpClient)
    this.setState({ user, status: 'ready' })
    return user
  }

  async fetchChannelMessages(
    channelId: string,
    optionsOrLimit?: number | { limit?: number; before?: string; after?: string; afterSeq?: number; lean?: boolean },
    before?: string
  ): Promise<VesperMessage[]> {
    if (typeof optionsOrLimit === 'number' || optionsOrLimit == null) {
      return await fetchChannelMessages(channelId, {
        limit: optionsOrLimit,
        before
      }, this.httpClient)
    }

    return await fetchChannelMessages(channelId, optionsOrLimit, this.httpClient)
  }

  async fetchConversationMessages(
    conversationId: string,
    optionsOrLimit?: number | { limit?: number; before?: string; after?: string; afterSeq?: number; lean?: boolean },
    before?: string
  ): Promise<VesperMessage[]> {
    if (typeof optionsOrLimit === 'number' || optionsOrLimit == null) {
      return await fetchConversationMessages(conversationId, {
        limit: optionsOrLimit,
        before
      }, this.httpClient)
    }

    return await fetchConversationMessages(conversationId, optionsOrLimit, this.httpClient)
  }

  async fetchScopeSync(input: {
    scopes: VesperScopeSyncScopeRequest[]
    limit?: number
    since?: string | null
  }): Promise<VesperScopeSyncResponse> {
    return await fetchScopesSync(input, this.httpClient)
  }

  subscribeTopic(topic: string, listener: TopicListener): () => void {
    const { wrapped, dispose } = this.prepareTopicSubscription(topic, listener)
    this.socketClient.joinChannel(topic, wrapped)
    return dispose
  }

  async subscribeTopicWithAck(topic: string, listener: TopicListener): Promise<() => void> {
    const { wrapped, dispose } = this.prepareTopicSubscription(topic, listener)
    await this.socketClient.joinChannelWithAck(topic, wrapped)
    return dispose
  }

  subscribeVoiceTopic(topic: string, listener: TopicListener): () => void {
    const { wrapped, dispose } = this.prepareTopicSubscription(topic, listener)
    this.socketClient.joinVoiceChannel(topic, wrapped)
    return dispose
  }

  private prepareTopicSubscription(
    topic: string,
    listener: TopicListener
  ): { wrapped: TopicListener; dispose: () => void } {
    this.socketClient.connect()

    const wrapped = (event: string, payload: unknown): void => {
      try {
        listener(event, payload)
      } catch (error) {
        this.emitError(error)
      }

      this.emitter.emit('scope.event', {
        topic,
        event,
        payload
      })
    }

    const dispose = (): void => {
      this.socketClient.leaveChannelListener(topic, wrapped)
    }

    return { wrapped, dispose }
  }

  disconnectTopic(topic: string): void {
    this.socketClient.leaveChannel(topic)
  }

  hasTopicSubscription(topic: string): boolean {
    return Boolean(this.socketClient.getChannel(topic))
  }

  pushTopicEvent(topic: string, event: string, payload: object): void {
    this.socketClient.connect()
    this.socketClient.pushToChannel(topic, event, payload)
  }

  async pushTopicEventWithAck(topic: string, event: string, payload: object): Promise<boolean> {
    this.socketClient.connect()
    return await this.socketClient.pushToChannelWithAck(topic, event, payload)
  }

  async fetchPendingWelcomes(scopeId: string): Promise<
    Array<{
      id: string
      welcome_data: Uint8Array
      key_package_ref?: string | null
      sender_id: string
    }>
  > {
    return await fetchPendingWelcomes(scopeId, this.httpClient)
  }

  async ackPendingWelcome(welcomeId: string): Promise<void> {
    await ackPendingWelcome(welcomeId, this.httpClient)
  }

  async fetchPendingResyncRequests(scopeId: string): Promise<
    Array<{
      id: string
      requester_id: string
      requester_username: string | null
      requester_client_id: string | null
      request_id: string
      last_known_epoch: number | null
      reason: string | null
    }>
  > {
    return await fetchPendingResyncRequests(scopeId, this.httpClient)
  }

  async ackPendingResyncRequest(requestId: string): Promise<void> {
    await ackPendingResyncRequest(requestId, this.httpClient)
  }

  async fetchPendingHistoryRequests(scopeId: string): Promise<
    Array<{
      id: string
      requester_id: string
      requester_username: string | null
      requester_client_id: string | null
    }>
  > {
    return await fetchPendingHistoryRequests(scopeId, this.httpClient)
  }

  async ackPendingHistoryRequest(requestId: string): Promise<void> {
    await ackPendingHistoryRequest(requestId, this.httpClient)
  }

  async fetchPendingHistoryBundles(scopeId: string): Promise<
    Array<{
      id: string
      ciphertext: string
      mls_epoch: number
      recipient_id: string
      recipient_client_id: string | null
      sender_id: string
    }>
  > {
    return await fetchPendingHistoryBundles(scopeId, this.httpClient)
  }

  async ackPendingHistoryBundle(bundleId: string): Promise<void> {
    await ackPendingHistoryBundle(bundleId, this.httpClient)
  }

  async fetchVoiceRtcConfig(forceRefresh = false): Promise<VoiceRtcConfig> {
    return await getVoiceRtcConfig(forceRefresh, this.httpClient)
  }

  async watchScope(
    kind: ScopeKind,
    scopeId: string,
    listener: Listener<VesperClientScopeEvent>
  ): Promise<() => void> {
    const watcherKey = this.getScopeWatcherKey(kind, scopeId)
    const watcher = await this.ensureScopeWatcher(kind, scopeId)
    watcher.listeners.add(listener)

    const dispose = (): void => {
      const current = this.scopeWatchers.get(watcherKey)
      if (!current) {
        return
      }

      current.listeners.delete(listener)
      if (current.listeners.size > 0) {
        return
      }

      current.disposeChannel()
      this.scopeWatchers.delete(watcherKey)
    }

    return dispose
  }

  async pushScopeEvent(
    kind: ScopeKind,
    scopeId: string,
    event: string,
    payload: object
  ): Promise<boolean> {
    const fireAndForget = FIRE_AND_FORGET_SCOPE_EVENTS.has(event)
    const watcherKey = this.getScopeWatcherKey(kind, scopeId)
    const existing = this.scopeWatchers.get(watcherKey)
    if (existing) {
      if (fireAndForget) {
        this.socketClient.pushToChannel(existing.topic, event, payload)
        return true
      }

      const pushed = await this.socketClient.pushToChannelWithAck(existing.topic, event, payload)
      if (pushed) {
        return true
      }

      existing.disposeChannel()
      this.scopeWatchers.delete(watcherKey)
      const recovered = await this.ensureScopeWatcher(kind, scopeId)
      return await this.socketClient.pushToChannelWithAck(recovered.topic, event, payload)
    }

    const topic = this.getScopeTopic(kind, scopeId)
    const noopListener = () => {}

    this.socketClient.connect()
    await this.socketClient.joinChannelWithAck(topic, noopListener)

    try {
      if (fireAndForget) {
        this.socketClient.pushToChannel(topic, event, payload)
        return true
      }

      return await this.socketClient.pushToChannelWithAck(topic, event, payload)
    } finally {
      this.socketClient.leaveChannelListener(topic, noopListener)
    }
  }

  private getScopeWatcherKey(kind: ScopeKind, scopeId: string): string {
    return `${kind}:${scopeId}`
  }

  private async assertResponseOk(response: Response, fallbackMessage: string): Promise<void> {
    if (response.ok) {
      return
    }

    const payload = await response.clone().json().catch(() => null) as
      | { error?: string; errors?: Record<string, string[]> }
      | null

    const details = [
      payload?.error,
      ...Object.entries(payload?.errors ?? {}).flatMap(([field, messages]) =>
        messages.map((message) => `${field}: ${message}`)
      )
    ].find((value): value is string => typeof value === 'string' && value.length > 0)

    throw new Error(details ?? fallbackMessage)
  }

  private getScopeTopic(kind: ScopeKind, scopeId: string): string {
    return kind === 'channel' ? `chat:channel:${scopeId}` : `dm:${scopeId}`
  }

  private async handleSocketReconnect(): Promise<void> {
    const userId = this.authSession?.user.id ?? this.state.user?.id ?? null

    if (userId) {
      await this.connectUserFeed(userId)
    }

    await this.restoreScopeWatchers()
    this.setState({ connected: true })
    this.emitter.emit('connected', this.getState())
    await this.syncNow(false)
  }

  private async ensureScopeWatcher(kind: ScopeKind, scopeId: string): Promise<ScopeWatcher> {
    const watcherKey = this.getScopeWatcherKey(kind, scopeId)
    const existing = this.scopeWatchers.get(watcherKey)
    if (existing && this.socketClient.hasUsableChannel(existing.topic)) {
      return existing
    }

    if (existing) {
      existing.disposeChannel()
      this.scopeWatchers.delete(watcherKey)
    }

    const pending = this.pendingScopeWatchers.get(watcherKey)
    if (pending) {
      return await pending
    }

    const join = (async () => {
      const watcher = await this.createScopeWatcher(kind, scopeId)
      this.scopeWatchers.set(watcherKey, watcher)
      return watcher
    })()

    this.pendingScopeWatchers.set(watcherKey, join)

    try {
      return await join
    } finally {
      this.pendingScopeWatchers.delete(watcherKey)
    }
  }

  private async createScopeWatcher(
    kind: ScopeKind,
    scopeId: string,
    existingListeners?: Set<Listener<VesperClientScopeEvent>>
  ): Promise<ScopeWatcher> {
    const topic = this.getScopeTopic(kind, scopeId)
    const listeners = existingListeners ?? new Set<Listener<VesperClientScopeEvent>>()

    this.socketClient.connect()

    const onMessage = (event: string, payload: unknown) => {
      const nextEvent = {
        topic,
        event,
        payload
      }

      for (const scopeListener of listeners) {
        void Promise.resolve(scopeListener(nextEvent)).catch((error) => {
          this.emitError(error)
        })
      }

      this.emitter.emit('scope.event', nextEvent)
    }

    await this.socketClient.joinChannelWithAck(topic, onMessage)

    return {
      topic,
      listeners,
      disposeChannel: () => {
        this.socketClient.leaveChannelListener(topic, onMessage)
      }
    }
  }

  private async restoreScopeWatchers(): Promise<void> {
    const watchers = [...this.scopeWatchers.entries()]

    for (const [watcherKey, watcher] of watchers) {
      if (this.socketClient.hasUsableChannel(watcher.topic)) {
        continue
      }

      watcher.disposeChannel()
      this.scopeWatchers.delete(watcherKey)

      if (watcher.listeners.size === 0) {
        continue
      }

      const separatorIndex = watcherKey.indexOf(':')
      if (separatorIndex === -1) {
        continue
      }

      const kind = watcherKey.slice(0, separatorIndex) as ScopeKind
      const scopeId = watcherKey.slice(separatorIndex + 1)
      const recreated = await this.createScopeWatcher(kind, scopeId, watcher.listeners)
      this.scopeWatchers.set(watcherKey, recreated)
    }
  }

  private async applySession(session: VesperAuthSession): Promise<void> {
    this.authSession = session
    this.setState({
      status: 'ready',
      user: session.user,
      currentDevice: session.currentDevice,
      devices: session.devices,
      canUseE2EE: session.canUseE2EE
    })

    await this.fetchDevices()

    if (session.canUseE2EE) {
      await this.auth.replenishKeyPackages(session.user, true)
    }
  }

  private async connectUserFeed(userId: string): Promise<void> {
    const topic = `user:${userId}`
    if (this.userTopic === topic && this.socketClient.hasUsableChannel(topic)) {
      return
    }

    if (this.userTopic) {
      this.socketClient.leaveChannel(this.userTopic)
    }

    await this.socketClient.joinChannelWithAck(topic, (event, payload) => {
      void this.handleUserEvent(event, payload).catch((error) => {
        this.emitError(error)
      })
    })

    this.userTopic = topic
    this.setState({ connected: true })

    if (this.heartbeat) {
      clearInterval(this.heartbeat)
    }

    this.heartbeat = setInterval(() => {
      if (this.userTopic) {
        this.socketClient.pushToChannel(this.userTopic, 'heartbeat', {})
      }
    }, this.heartbeatIntervalMs)
  }

  private async handleUserEvent(event: string, payload: unknown): Promise<void> {
    this.emitter.emit('raw', { event, payload })

    if (event === 'new_conversation') {
      const data = payload as { conversation?: VesperConversation }
      if (data.conversation) {
        this.setState({
          conversations: mergeConversations(this.state.conversations, [data.conversation])
        })
        this.emitter.emit('conversations.updated', [...this.state.conversations])
      }
      return
    }

    if (event === 'scope_summary_updated') {
      this.applyScopeSummaryUpdate(payload)
      return
    }

    if (event === 'server_membership_revoked') {
      const data = payload as { server_id?: string }
      if (typeof data.server_id === 'string') {
        await this.resetServerScopes(data.server_id)
        const next = removeServer(this.state.servers, this.state.unreadCounts, data.server_id)
        this.setState(next)
        this.emitter.emit('servers.updated', [...this.state.servers])
      }
      return
    }

    if (event === 'unread_update') {
      const data = payload as {
        channel_id: string
        message_id: string
        inserted_at?: string
        sender_id: string | null
        sender?: VesperChannelActivityPatch['sender']
      }

      if (data.inserted_at) {
        this.applyChannelActivity({
          channel_id: data.channel_id,
          message_id: data.message_id,
          inserted_at: data.inserted_at,
          sender_id: data.sender_id,
          sender: data.sender ?? null
        })
      }

      if (this.claimUnreadMessageKey('channel', data.channel_id, data.message_id)) {
        this.setState({
          unreadCounts: {
            channels: {
              ...this.state.unreadCounts.channels,
              [data.channel_id]: (this.state.unreadCounts.channels[data.channel_id] ?? 0) + 1
            },
            conversations: this.state.unreadCounts.conversations
          }
        })
      }
      return
    }

    if (event === 'dm_message') {
      const data = payload as {
        conversation_id: string
        message_id: string
        sender_id: string | null
        sender?: {
          id: string
          username: string
          display_name?: string | null
          avatar_url?: string | null
        } | null
        inserted_at: string
      }

      this.setState({
        conversations: applyConversationActivity(this.state.conversations, {
          conversation_id: data.conversation_id,
          message_id: data.message_id,
          sender_id: data.sender_id,
          sender: data.sender ?? null,
          inserted_at: data.inserted_at
        })
      })
      this.emitter.emit('conversations.updated', [...this.state.conversations])
      return
    }

    if (event === 'dm_unread_update') {
      const data = payload as {
        conversation_id: string
        message_id: string
      }

      if (this.claimUnreadMessageKey('dm', data.conversation_id, data.message_id)) {
        this.setState({
          unreadCounts: {
            channels: this.state.unreadCounts.channels,
            conversations: {
              ...this.state.unreadCounts.conversations,
              [data.conversation_id]:
                (this.state.unreadCounts.conversations[data.conversation_id] ?? 0) + 1
            }
          }
        })
      }
      return
    }

    if (event === 'device_approval_requested' || event === 'device_updated') {
      const data = payload as { device?: VesperAuthDevice }
      if (data.device) {
        this.applyDeviceUpdate(data.device)
      }
      return
    }
  }

  private applyDeviceUpdate(device: VesperAuthDevice): void {
    const devices = mergeDevices(this.state.devices, device)
    const currentDevice =
      this.state.currentDevice?.id === device.id ? device : this.state.currentDevice
    const canUseE2EE =
      currentDevice?.trust_state === 'trusted' ? this.state.canUseE2EE : false

    this.setState({
      devices,
      currentDevice,
      canUseE2EE
    })

    this.emitter.emit('devices.updated', {
      device,
      currentDevice: this.state.currentDevice,
      devices: [...this.state.devices],
      canUseE2EE: this.state.canUseE2EE
    })
  }

  private applyScopeSummaryUpdate(payload: unknown): void {
    if (!payload || typeof payload !== 'object') {
      return
    }

    const data = payload as {
      kind?: ScopeKind
      channel_activity?: VesperChannelActivityPatch | null
      conversation_reset?: VesperConversationResetPatch | null
    }

    if (data.kind === 'channel' && data.channel_activity) {
      this.applyChannelActivity(data.channel_activity)
      return
    }

    if (data.kind === 'dm' && data.conversation_reset) {
      this.applyConversationReset(data.conversation_reset)
    }
  }

  private applyChannelActivity(activity: VesperChannelActivityPatch): void {
    this.setState({
      servers: applyChannelActivityToServers(this.state.servers, activity)
    })
    this.emitter.emit('servers.updated', [...this.state.servers])
  }

  private applyConversationReset(reset: VesperConversationResetPatch): void {
    this.setState({
      conversations: applyConversationReset(this.state.conversations, reset)
    })
    this.emitter.emit('conversations.updated', [...this.state.conversations])
  }

  private clearUnreadCount(kind: ScopeKind, scopeId: string): void {
    if (kind === 'channel') {
      this.setState({
        unreadCounts: {
          channels: {
            ...this.state.unreadCounts.channels,
            [scopeId]: 0
          },
          conversations: this.state.unreadCounts.conversations
        }
      })
      return
    }

    this.setState({
      unreadCounts: {
        channels: this.state.unreadCounts.channels,
        conversations: {
          ...this.state.unreadCounts.conversations,
          [scopeId]: 0
        }
      }
    })
  }

  private async resetServerScopes(serverId: string): Promise<void> {
    const server = this.state.servers.find((candidate) => candidate.id === serverId)
    if (!server) {
      return
    }

    await this.resetChannelScopes(server.channels.map((channel) => channel.id))
  }

  private async resetChannelScopes(channelIds: string[]): Promise<void> {
    if (channelIds.length === 0) {
      return
    }

    const encryptedChat = this.createEncryptedChat()
    const uniqueChannelIds = [...new Set(channelIds)]

    await Promise.allSettled(
      uniqueChannelIds.flatMap((channelId) => [
        encryptedChat.resetScope(channelId),
        encryptedChat.resetScope(`voice:channel:${channelId}`)
      ])
    )
  }

  private claimUnreadMessageKey(kind: ScopeKind, scopeId: string, messageId: string): boolean {
    const now = Date.now()

    for (const [key, seenAt] of this.recentUnreadMessageKeys) {
      if (now - seenAt > UNREAD_EVENT_DEDUPE_WINDOW_MS) {
        this.recentUnreadMessageKeys.delete(key)
      }
    }

    const dedupeKey = `${kind}:${scopeId}:${messageId}`
    if (this.recentUnreadMessageKeys.has(dedupeKey)) {
      return false
    }

    this.recentUnreadMessageKeys.set(dedupeKey, now)
    return true
  }

  /** @internal */
  emitError(error: unknown): void {
    this.emitter.emit(
      'error',
      error instanceof Error ? error : new Error('Unknown Vesper client error')
    )
  }

  private setState(patch: Partial<VesperClientState>): void {
    this.state = {
      ...this.state,
      ...patch
    }
    this.emitter.emit('state', this.getState())
  }

  private replaceState(nextState: VesperClientState): void {
    this.state = nextState
    this.emitter.emit('state', this.getState())
  }
}

function mergeDevices(
  devices: VesperAuthDevice[],
  device: VesperAuthDevice
): VesperAuthDevice[] {
  const byId = new Map(devices.map((entry) => [entry.id, entry]))
  byId.set(device.id, device)
  return [...byId.values()]
}

export function createVesperClient(options: VesperClientOptions = {}): VesperClient {
  return new VesperClient(options)
}

export * from './encryptedChat.js'
export { MLSDiagnostics, type ScopeDiagnostics } from './mlsDiagnostics.js'

export type {
  VesperAuthDevice,
  VesperAuthSession,
  VesperConversation,
  VesperCustomEmoji,
  VesperEmojiCreator,
  VesperMessage,
  VesperScopeSyncScopeRequest,
  VesperScopeSyncResponse,
  VesperServer,
  VesperUser
}
