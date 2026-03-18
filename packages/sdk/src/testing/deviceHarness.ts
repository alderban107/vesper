import { AsyncLocalStorage } from 'node:async_hooks'

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
  VesperSocketClient,
  configureHttpClient,
  createMemorySessionStore,
  disconnectSocket,
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
  configureCryptoStorage,
  type CryptoStorageAdapter
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
}

let sdkContextQueue: Promise<void> = Promise.resolve()
const sdkOperationContext = new AsyncLocalStorage<symbol>()
const silentLogger = {
  error: console.error.bind(console),
  log: () => {}
}

function createDeviceIdentity(label: string, options: TestingDeviceHarnessOptions): TestingDeviceIdentity {
  return {
    id: options.deviceId ?? `sdk-${label}-${Math.random().toString(36).slice(2, 10)}`,
    name: options.deviceName ?? `SDK ${label}`,
    platform: options.devicePlatform ?? 'node'
  }
}

async function withSdkContext<T>(
  ownerToken: symbol,
  sessionStore: SessionStore,
  storage: CryptoStorageAdapter,
  operation: () => Promise<T>
): Promise<T> {
  if (sdkOperationContext.getStore() === ownerToken) {
    return await operation()
  }

  let releaseQueue: (() => void) | null = null
  const priorQueue = sdkContextQueue
  sdkContextQueue = new Promise<void>((resolve) => {
    releaseQueue = resolve
  })

  await priorQueue

  configureHttpClient({
    fetchImpl: globalThis.fetch.bind(globalThis),
    sessionStore
  })
  configureCryptoStorage(storage)

  try {
    return await sdkOperationContext.run(ownerToken, operation)
  } finally {
    if (releaseQueue) {
      releaseQueue()
    }
  }
}

export class TestingDeviceHarness {
  readonly apiUrl: string
  readonly auth: VesperAuthClient
  readonly deviceIdentity: TestingDeviceIdentity
  readonly sessionStore: SessionStore
  readonly socket: VesperSocketClient
  readonly storage: CryptoStorageAdapter

  session: VesperAuthSession | null = null

  private readonly ownerToken = Symbol('sdk-testing-device')

  constructor(apiUrl: string, label: string, options: TestingDeviceHarnessOptions = {}) {
    this.apiUrl = apiUrl
    this.deviceIdentity = createDeviceIdentity(label, options)
    this.sessionStore = options.sessionStore ?? createMemorySessionStore(apiUrl)
    this.storage = options.storage ?? new MemoryStorage()

    this.auth = new VesperAuthClient({
      getDeviceIdentity: () => this.deviceIdentity
    })
    this.socket = new VesperSocketClient({
      getAccessToken: () => this.sessionStore.getAccessToken(),
      getServerUrl: () => this.sessionStore.getServerUrl(),
      logger: silentLogger
    })
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    return await withSdkContext(
      this.ownerToken,
      this.sessionStore,
      this.storage,
      operation
    )
  }

  async register(username: string, password: string): Promise<VesperAuthSession> {
    const session = await this.run(async () => {
      const nextSession = await this.auth.register(username, password)
      disconnectSocket()
      return nextSession
    })
    this.session = session
    return session
  }

  async login(username: string, password: string): Promise<VesperAuthSession> {
    const session = await this.run(async () => {
      const nextSession = await this.auth.login(username, password)
      disconnectSocket()
      return nextSession
    })
    this.session = session
    return session
  }

  async restoreSession(): Promise<VesperAuthSession | null> {
    const session = await this.run(async () => {
      const nextSession = await this.auth.checkAuth()
      disconnectSocket()
      return nextSession
    })
    this.session = session
    return session
  }

  async logout(): Promise<void> {
    await this.run(async () => {
      await this.auth.logout()
      disconnectSocket()
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
      const nextSession = await this.auth.unlockTrustedDevice(
        session.user,
        session.currentDevice,
        password
      )
      disconnectSocket()
      return nextSession
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
    return await this.run(() => getCurrentUser())
  }

  async listServers(): Promise<VesperServer[]> {
    return await this.run(() => listServers())
  }

  async listConversations(): Promise<VesperConversation[]> {
    return await this.run(() => listConversations())
  }

  async createServer(name: string): Promise<VesperServer> {
    return await this.run(() => createServer(name))
  }

  async createServerChannel(
    serverId: string,
    input: CreateServerChannelInput
  ): Promise<VesperChannel> {
    return await this.run(() => createServerChannel(serverId, input))
  }

  async getServerInviteCode(serverId: string): Promise<string> {
    return await this.run(() => getServerInviteCode(serverId))
  }

  async joinServerByInvite(inviteCode: string): Promise<VesperServer> {
    return await this.run(() => joinServerByInvite(inviteCode))
  }

  async leaveServer(serverId: string): Promise<void> {
    await this.run(() => leaveServer(serverId))
  }

  async createConversation(
    participantIds: string[],
    name?: string
  ): Promise<VesperConversation> {
    return await this.run(() => createConversation(participantIds, name))
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
    return await this.run(() => fetchChannelMessages(channelId, options))
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
    return await this.run(() => fetchConversationMessages(conversationId, options))
  }

  async fetchWorkspaceSync(since?: string | null) {
    return await this.run(() => fetchWorkspaceSync(since))
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
    return await this.run(() => fetchScopesSync(input))
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
