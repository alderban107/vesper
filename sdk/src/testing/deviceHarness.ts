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
  type CreateServerChannelInput,
  type VesperChannel,
  type VesperConversation,
  type VesperMessage,
  type VesperScopeSyncResponse,
  type VesperServer
} from '../api/chat.js'
import {
  VesperHttpClient,
  VesperSocketClient,
  createMemorySessionStore,
  type SessionStore
} from '../transport/index.js'
import {
  VesperAuthClient,
  type VesperAuthDevice,
  type VesperAuthSession,
  type VesperUser
} from '../auth/index.js'
import {
  MemoryStorage,
  createCryptoStorageRuntime,
  type CryptoStorageAdapter,
  type CryptoStorageRuntime
} from '../storage/index.js'

export interface TestingDeviceIdentity {
  id: string
  name: string
  platform: string
}

export interface TestingDeviceHarnessOptions {
  deviceId?: string
  deviceName?: string
  devicePlatform?: string
  sessionStore?: SessionStore
  storage?: CryptoStorageAdapter
  storageRuntime?: CryptoStorageRuntime
}

const silentLogger = {
  error: console.error.bind(console),
  log: () => {}
}

const FIRE_AND_FORGET_SCOPE_EVENTS = new Set([
  'typing_start',
  'typing_stop',
  'sender_key_distribution'
])

function createDeviceIdentity(label: string, options: TestingDeviceHarnessOptions): TestingDeviceIdentity {
  return {
    id: options.deviceId ?? `sdk-${label}-${Math.random().toString(36).slice(2, 10)}`,
    name: options.deviceName ?? `SDK ${label}`,
    platform: options.devicePlatform ?? 'node'
  }
}

export class TestingDeviceHarness {
  readonly apiUrl: string
  readonly auth: VesperAuthClient
  readonly deviceIdentity: TestingDeviceIdentity
  readonly httpClient: VesperHttpClient
  readonly sessionStore: SessionStore
  readonly socket: VesperSocketClient
  readonly storage: CryptoStorageAdapter
  readonly storageRuntime: CryptoStorageRuntime

  session: VesperAuthSession | null = null
  constructor(apiUrl: string, label: string, options: TestingDeviceHarnessOptions = {}) {
    this.apiUrl = apiUrl
    this.deviceIdentity = createDeviceIdentity(label, options)
    this.sessionStore = options.sessionStore ?? createMemorySessionStore(apiUrl)
    this.storage = options.storage ?? new MemoryStorage()
    this.storageRuntime = options.storageRuntime ?? createCryptoStorageRuntime(this.storage)
    this.httpClient = new VesperHttpClient({
      fetchImpl: globalThis.fetch.bind(globalThis),
      sessionStore: this.sessionStore
    })

    this.socket = new VesperSocketClient({
      getAccessToken: () => this.httpClient.getAccessToken(),
      getServerUrl: () => this.httpClient.getServerUrl(),
      logger: silentLogger
    })
    this.auth = new VesperAuthClient({
      getDeviceIdentity: () => this.deviceIdentity,
      httpClient: this.httpClient,
      socketClient: this.socket,
      storageRuntime: this.storageRuntime
    })
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    return await this.storageRuntime.run(this.session?.user?.id ?? null, operation)
  }

  async register(username: string, password: string): Promise<VesperAuthSession> {
    const session = await this.run(async () => await this.auth.register(username, password))
    this.session = session
    return session
  }

  async login(username: string, password: string): Promise<VesperAuthSession> {
    const session = await this.run(async () => await this.auth.login(username, password))
    this.session = session
    return session
  }

  async restoreSession(): Promise<VesperAuthSession | null> {
    const session = await this.run(async () => await this.auth.checkAuth())
    this.session = session
    return session
  }

  async logout(): Promise<void> {
    await this.run(async () => {
      await this.auth.logout()
    })
    this.socket.disconnect()
    this.session = null
  }

  async fetchDevices(): Promise<{
    devices: VesperAuthDevice[]
    currentDevice: VesperAuthDevice | null
    canUseE2EE: boolean
  }> {
    const session = this.requireSession()
    const state = await this.run(() =>
      this.auth.fetchDevices({
        devices: session.devices,
        currentDevice: session.currentDevice,
        user: session.user
      })
    )

    this.session = {
      ...session,
      devices: state.devices,
      currentDevice: state.currentDevice,
      canUseE2EE: state.canUseE2EE
    }

    return state
  }

  async approveDevice(deviceId: string): Promise<void> {
    await this.run(() => this.auth.approveDevice(deviceId))
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.run(() => this.auth.revokeDevice(deviceId))
  }

  async unlockTrustedDevice(password: string): Promise<VesperAuthSession> {
    const session = this.requireSession()
    const unlocked = await this.run(async () => {
      return await this.auth.unlockTrustedDevice(
        session.user,
        session.currentDevice,
        password
      )
    })

    this.session = {
      ...session,
      currentDevice: unlocked.currentDevice,
      canUseE2EE: unlocked.canUseE2EE,
      devices: session.devices
    }

    return this.session
  }

  async replenishKeyPackages(): Promise<void> {
    const session = this.requireSession()
    await this.run(() =>
      this.auth.replenishKeyPackages(session.user, session.canUseE2EE)
    )
  }

  async getCurrentUser(): Promise<VesperUser> {
    return await this.run(() => getCurrentUser(this.httpClient))
  }

  async listServers(): Promise<VesperServer[]> {
    return await this.run(() => listServers(this.httpClient))
  }

  async listConversations(): Promise<VesperConversation[]> {
    return await this.run(() => listConversations(this.httpClient))
  }

  async createServer(name: string): Promise<VesperServer> {
    return await this.run(() => createServer(name, this.httpClient))
  }

  async createServerChannel(
    serverId: string,
    input: CreateServerChannelInput
  ): Promise<VesperChannel> {
    return await this.run(() => createServerChannel(serverId, input, this.httpClient))
  }

  async getServerInviteCode(serverId: string): Promise<string> {
    return await this.run(() => getServerInviteCode(serverId, this.httpClient))
  }

  async joinServerByInvite(inviteCode: string): Promise<VesperServer> {
    return await this.run(() => joinServerByInvite(inviteCode, this.httpClient))
  }

  async leaveServer(serverId: string): Promise<void> {
    await this.run(() => leaveServer(serverId, this.httpClient))
  }

  async createConversation(
    participantIds: string[],
    name?: string
  ): Promise<VesperConversation> {
    return await this.run(() => createConversation(participantIds, name, this.httpClient))
  }

  async fetchChannelMessages(
    channelId: string,
    options: {
      limit?: number
      before?: string
      after?: string
      afterSeq?: number
      lean?: boolean
    } = {}
  ): Promise<VesperMessage[]> {
    return await this.run(() => fetchChannelMessages(channelId, options, this.httpClient))
  }

  async fetchConversationMessages(
    conversationId: string,
    options: {
      limit?: number
      before?: string
      after?: string
      afterSeq?: number
      lean?: boolean
    } = {}
  ): Promise<VesperMessage[]> {
    return await this.run(() => fetchConversationMessages(conversationId, options, this.httpClient))
  }

  async fetchWorkspaceSync(since?: string | null) {
    return await this.run(() => fetchWorkspaceSync(since, this.httpClient))
  }

  async fetchScopesSync(input: {
    scopes: Array<{
      kind: 'channel' | 'dm'
      id: string
      after?: string
      after_seq?: number
    }>
    limit?: number
    since?: string | null
  }): Promise<VesperScopeSyncResponse> {
    return await this.run(() => fetchScopesSync(input, this.httpClient))
  }

  async joinTopicWithAck(
    topic: string,
    onMessage: (event: string, payload: unknown) => Promise<void> | void
  ): Promise<void> {
    this.socket.connect()
    await this.socket.joinChannelWithAck(topic, (event, payload) => {
      void this.run(async () => {
        await onMessage(event, payload)
      })
    })
  }

  pushToTopic(topic: string, event: string, payload: object): void {
    this.socket.pushToChannel(topic, event, payload)
  }

  async pushToTopicWithAck(topic: string, event: string, payload: object): Promise<boolean> {
    const channel = this.socket.getChannel(topic)
    if (!channel) {
      return false
    }

    if (FIRE_AND_FORGET_SCOPE_EVENTS.has(event)) {
      channel.push(event, payload)
      return true
    }

    return await new Promise<boolean>((resolve) => {
      channel
        .push(event, payload)
        .receive('ok', () => resolve(true))
        .receive('error', () => resolve(false))
        .receive('timeout', () => resolve(false))
    })
  }

  leaveTopic(topic: string): void {
    this.socket.leaveChannel(topic)
  }

  disconnect(): void {
    this.socket.disconnect()
  }

  requireSession(): VesperAuthSession {
    if (!this.session) {
      throw new Error('No active session for this device harness.')
    }

    return this.session
  }
}

export function createDeviceHarness(
  apiUrl: string,
  label: string,
  options: TestingDeviceHarnessOptions = {}
): TestingDeviceHarness {
  return new TestingDeviceHarness(apiUrl, label, options)
}
