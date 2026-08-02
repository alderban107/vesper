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
import { createVesperClient, type VesperClient } from '../client/index.js'
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
  fetchImpl?: typeof fetch
}

const FIRE_AND_FORGET_SCOPE_EVENTS = new Set([
  'typing_start',
  'typing_stop',
  'mls_request_join',
  'mls_request_join_all',
  'mls_eviction_claim',
  'mls_eviction_skip'
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
  readonly client: VesperClient
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
    this.client = createVesperClient({
      baseUrl: apiUrl,
      fetchImpl: options.fetchImpl,
      sessionStore: this.sessionStore,
      storageRuntime: this.storageRuntime,
      auth: {
        getDeviceIdentity: () => this.deviceIdentity
      }
    })
    this.httpClient = this.client.getHttpClient()
    this.socket = this.client.getSocketClient()
    this.auth = this.client.getAuthClient()
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    return await this.storageRuntime.run(this.session?.user?.id ?? null, operation)
  }

  async register(username: string, password: string): Promise<VesperAuthSession> {
    const session = await this.client.register(username, password)
    this.session = session
    return session
  }

  async login(username: string, password: string): Promise<VesperAuthSession> {
    const session = await this.client.login(username, password)
    this.session = session
    return session
  }

  async restoreSession(): Promise<VesperAuthSession | null> {
    const session = await this.client.restoreSession()
    this.session = session
    return session
  }

  async start(): Promise<void> {
    if (!this.client.getState().started) {
      await this.client.start(false)
    }
  }

  async logout(): Promise<void> {
    await this.client.logout()
    this.session = null
  }

  async fetchDevices(): Promise<{
    devices: VesperAuthDevice[]
    currentDevice: VesperAuthDevice | null
    canUseE2EE: boolean
  }> {
    const state = await this.client.fetchDevices()
    const session = this.client.getAuthSession()
    if (session) {
      this.session = session
    }

    return {
      devices: state.devices,
      currentDevice: state.currentDevice,
      canUseE2EE: state.canUseE2EE
    }
  }

  async approveDevice(deviceId: string): Promise<void> {
    await this.client.approveDevice(deviceId)
    this.session = this.client.getAuthSession()
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.client.revokeDevice(deviceId)
    this.session = this.client.getAuthSession()
  }

  async unlockTrustedDevice(password: string): Promise<VesperAuthSession> {
    await this.client.unlockTrustedDevice(password)
    const session = this.client.getAuthSession()
    if (!session) {
      throw new Error('Trusted device unlock did not produce an authenticated session.')
    }

    this.session = session
    return session
  }

  async replenishKeyPackages(): Promise<void> {
    await this.client.replenishKeyPackages()
  }

  async getCurrentUser(): Promise<VesperUser> {
    return await this.client.fetchCurrentUser()
  }

  async listServers(): Promise<VesperServer[]> {
    return await this.client.listServers()
  }

  async listConversations(): Promise<VesperConversation[]> {
    return await this.client.listConversations()
  }

  async createServer(name: string): Promise<VesperServer> {
    return await this.client.createServer(name)
  }

  async createServerChannel(
    serverId: string,
    input: CreateServerChannelInput
  ): Promise<VesperChannel> {
    return await this.client.createServerChannel(serverId, input)
  }

  async getServerInviteCode(serverId: string): Promise<string> {
    return await this.client.fetchServerInviteCode(serverId)
  }

  async joinServerByInvite(inviteCode: string): Promise<VesperServer> {
    return await this.client.joinServerByInvite(inviteCode)
  }

  async leaveServer(serverId: string): Promise<void> {
    await this.client.leaveServer(serverId)
  }

  async createConversation(
    participantIds: string[],
    name?: string
  ): Promise<VesperConversation> {
    return await this.client.createConversation(participantIds, name)
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
    return await this.client.fetchChannelMessages(channelId, options)
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
    return await this.client.fetchConversationMessages(conversationId, options)
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
    this.client.stop()
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
