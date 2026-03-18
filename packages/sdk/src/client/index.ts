import {
  createConversation,
  createServer,
  fetchChannelMessages,
  fetchConversationMessages,
  fetchScopesSync,
  fetchWorkspaceSync,
  getCurrentUser,
  joinServerByInvite,
  leaveServer,
  searchUsers,
  type VesperChannel,
  type VesperChannelActivityPatch,
  type VesperConversation,
  type VesperConversationMessagePreview,
  type VesperConversationResetPatch,
  type VesperMessage,
  type VesperScopeSyncScopeRequest,
  type VesperScopeSyncResponse,
  type VesperServer,
  type VesperUnreadCounts
} from '../api/chat.js'
import {
  configureHttpClient,
  createBrowserSessionStore,
  createMemorySessionStore,
  type SessionStore
} from '../api/client.js'
import {
  connectSocket,
  joinChannelWithAck,
  leaveChannel,
  leaveChannelListener,
  onSocketOpen,
  pushToChannel,
  pushToChannelWithAck
} from '../api/socket.js'
import {
  VesperAuthClient,
  type VesperAuthClientOptions,
  type VesperAuthDevice,
  type VesperAuthSession,
  type VesperUser
} from '../auth/session.js'
import type { LocalDeviceIdentity } from '../auth/deviceIdentity.js'
import {
  configureCryptoStorage,
  resetStorage,
  type CryptoStorageAdapter
} from '../crypto/storage.js'
import { createEncryptedChat, type VesperEncryptedChat } from './encryptedChat.js'

type ClientStatus = 'signed_out' | 'ready'
type ScopeKind = 'channel' | 'dm'
type ScopeWatcher = {
  topic: string
  dispose: () => void
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
  storage?: CryptoStorageAdapter | ((userId: string) => CryptoStorageAdapter)
  heartbeatIntervalMs?: number
  auth?: VesperAuthClientOptions
}

type Listener<T> = (payload: T) => void

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
      ;(listener as Listener<Events[EventName]>)(payload)
    }
  }
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000
const UNREAD_EVENT_DEDUPE_WINDOW_MS = 15_000

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
      channels: server.channels
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
  return mergeConversations(
    conversations,
    conversations
      .filter((conversation) => conversation.id === reset.conversation_id)
      .map((conversation) => ({
        ...conversation,
        last_message: reset.last_message
      }))
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
  private readonly heartbeatIntervalMs: number
  private readonly scopeWatchers = new Map<string, ScopeWatcher>()
  private readonly recentUnreadMessageKeys = new Map<string, number>()
  private readonly resolveDeviceIdentity: (() => LocalDeviceIdentity) | null

  private authSession: VesperAuthSession | null = null
  private state: VesperClientState = defaultState()
  private userTopic: string | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private unsubscribeSocketOpen: (() => void) | null = null
  private seenSocketOpen = false

  constructor(options: VesperClientOptions = {}) {
    const sessionStore =
      options.sessionStore ??
      (typeof window === 'undefined'
        ? createMemorySessionStore(requireBaseUrl(options.baseUrl))
        : createBrowserSessionStore(options.baseUrl ?? null))

    configureHttpClient({
      fetchImpl: options.fetchImpl,
      sessionStore
    })

    if (options.storage) {
      configureCryptoStorage(options.storage)
    }

    this.resolveDeviceIdentity = options.auth?.getDeviceIdentity ?? null
    this.auth = new VesperAuthClient(options.auth)
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
  }

  get deviceIdentity(): LocalDeviceIdentity | null {
    return this.resolveDeviceIdentity ? this.resolveDeviceIdentity() : null
  }

  getAuthSession(): VesperAuthSession | null {
    return this.authSession
  }

  createEncryptedChat(): VesperEncryptedChat {
    return createEncryptedChat(this)
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
      this.unsubscribeSocketOpen = onSocketOpen(() => {
        this.setState({ connected: true })
        this.emitter.emit('connected', this.getState())

        if (!this.seenSocketOpen) {
          this.seenSocketOpen = true
          return
        }

        void this.syncNow(false).catch((error) => {
          this.emitError(error)
        })
      })
    }

    connectSocket()
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
      leaveChannel(this.userTopic)
      this.userTopic = null
    }

    for (const watcher of this.scopeWatchers.values()) {
      watcher.dispose()
    }
    this.scopeWatchers.clear()

    this.unsubscribeSocketOpen?.()
    this.unsubscribeSocketOpen = null
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
    resetStorage()
    this.authSession = null
    this.replaceState(defaultState())
  }

  async syncNow(forceFull = false): Promise<VesperClientState> {
    const since = forceFull ? null : this.state.syncToken
    const syncState = await fetchWorkspaceSync(since)

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
    return await searchUsers(username)
  }

  async replenishKeyPackages(): Promise<void> {
    await this.auth.replenishKeyPackages(this.state.user, this.state.canUseE2EE)
  }

  async createConversation(participantIds: string[], name?: string): Promise<VesperConversation> {
    const conversation = await createConversation(participantIds, name)
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
    const server = await createServer(name)
    this.setState({
      servers: mergeServers(this.state.servers, [server])
    })
    this.emitter.emit('servers.updated', [...this.state.servers])
    return server
  }

  async joinServerByInvite(inviteCode: string): Promise<VesperServer> {
    const server = await joinServerByInvite(inviteCode)
    this.setState({
      servers: mergeServers(this.state.servers, [server])
    })
    this.emitter.emit('servers.updated', [...this.state.servers])
    return server
  }

  async leaveServer(serverId: string): Promise<void> {
    await leaveServer(serverId)
    const next = removeServer(this.state.servers, this.state.unreadCounts, serverId)
    this.setState(next)
    this.emitter.emit('servers.updated', [...this.state.servers])
  }

  async fetchCurrentUser(): Promise<VesperUser> {
    const user = await getCurrentUser()
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
      })
    }

    return await fetchChannelMessages(channelId, optionsOrLimit)
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
      })
    }

    return await fetchConversationMessages(conversationId, optionsOrLimit)
  }

  async fetchScopeSync(input: {
    scopes: VesperScopeSyncScopeRequest[]
    limit?: number
    since?: string | null
  }): Promise<VesperScopeSyncResponse> {
    return await fetchScopesSync(input)
  }

  async watchScope(
    kind: ScopeKind,
    scopeId: string,
    listener: Listener<VesperClientScopeEvent>
  ): Promise<() => void> {
    const topic = kind === 'channel' ? `chat:channel:${scopeId}` : `dm:${scopeId}`
    const watcherKey = `${kind}:${scopeId}`

    this.scopeWatchers.get(watcherKey)?.dispose()

    connectSocket()
    const onMessage = (event: string, payload: unknown) => {
      const nextEvent = {
        topic,
        event,
        payload
      }

      void Promise.resolve(listener(nextEvent)).catch((error) => {
        this.emitError(error)
      })
      this.emitter.emit('scope.event', nextEvent)
    }

    await joinChannelWithAck(topic, onMessage)

    const dispose = () => {
      leaveChannelListener(topic, onMessage)
      this.scopeWatchers.delete(watcherKey)
    }

    this.scopeWatchers.set(watcherKey, {
      topic,
      dispose
    })

    return dispose
  }

  async pushScopeEvent(
    kind: ScopeKind,
    scopeId: string,
    event: string,
    payload: object
  ): Promise<boolean> {
    const topic = kind === 'channel' ? `chat:channel:${scopeId}` : `dm:${scopeId}`
    connectSocket()
    return await pushToChannelWithAck(topic, event, payload)
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
    if (this.userTopic === topic) {
      return
    }

    if (this.userTopic) {
      leaveChannel(this.userTopic)
    }

    await joinChannelWithAck(topic, (event, payload) => {
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
        pushToChannel(this.userTopic, 'heartbeat', {})
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

  private emitError(error: unknown): void {
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

function requireBaseUrl(baseUrl: string | undefined): string {
  if (typeof baseUrl === 'string' && baseUrl.trim()) {
    return baseUrl
  }

  throw new Error('VesperClient requires a baseUrl outside the browser.')
}

export function createVesperClient(options: VesperClientOptions = {}): VesperClient {
  return new VesperClient(options)
}

export * from './encryptedChat.js'

export type {
  VesperAuthDevice,
  VesperAuthSession,
  VesperConversation,
  VesperMessage,
  VesperScopeSyncScopeRequest,
  VesperScopeSyncResponse,
  VesperServer,
  VesperUser
}
