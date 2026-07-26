import type {
  EncryptedScope,
  ProcessedScopeMessage,
  ScopeSyncResult,
  VesperEncryptedChat
} from '../client/encryptedChat.js'
import type { RoomCryptoTopologyResolution, RoomKeyEpochRecord } from '../api/roomCrypto.js'
import { TestingDeviceHarness } from './deviceHarness.js'

export type { EncryptedScope, ProcessedScopeMessage, ScopeSyncResult }

const MESSAGE_WAIT_INTERVAL_MS = 100
const MESSAGE_WAIT_TIMEOUT_MS = 8_000

export class SdkChatHarness {
  readonly device: TestingDeviceHarness

  private readonly chat: VesperEncryptedChat
  private readonly scopes = new Map<string, EncryptedScope>()
  private readonly releases = new Map<string, () => void>()

  constructor(device: TestingDeviceHarness) {
    this.device = device
    this.chat = device.client.createEncryptedChat()
  }

  async watchScope(scope: EncryptedScope): Promise<void> {
    await this.device.start()
    this.scopes.set(scope.id, scope)

    if (this.releases.has(scope.id)) {
      return
    }

    const release = await this.chat.watchScope(scope)
    this.releases.set(scope.id, release)
  }

  disconnect(): void {
    for (const release of this.releases.values()) {
      release()
    }
    this.releases.clear()
    this.device.disconnect()
  }

  async ensureScopeReady(scope: EncryptedScope, allowCreate = false): Promise<boolean> {
    await this.device.start()
    this.scopes.set(scope.id, scope)
    return await this.chat.ensureScopeReady(scope, allowCreate)
  }

  async prepareScopeForRead(
    scope: EncryptedScope,
    options: { lastKnownEpoch?: number | null; reason?: string | null } = {}
  ): Promise<boolean> {
    await this.device.start()
    this.scopes.set(scope.id, scope)
    return await this.chat.prepareScopeForRead(scope, options)
  }

  async sendText(scope: EncryptedScope, text: string): Promise<void> {
    await this.device.start()
    this.scopes.set(scope.id, scope)
    await this.chat.sendText(scope, text)
  }

  async createScopeGroup(scope: EncryptedScope): Promise<boolean> {
    await this.device.start()
    this.scopes.set(scope.id, scope)
    return await this.chat.createScopeGroup(scope)
  }

  async syncScope(
    scope: EncryptedScope,
    options: { limit?: number } = {}
  ): Promise<ScopeSyncResult> {
    await this.device.start()
    this.scopes.set(scope.id, scope)
    return await this.chat.syncScope(scope, options)
  }

  async syncScopePaginated(
    scope: EncryptedScope,
    options: { maxPages: number; pageSize: number }
  ): Promise<ScopeSyncResult & { pagesFetched: number }> {
    let result = await this.syncScope(scope, { limit: options.pageSize })
    let pagesFetched = 1

    while (result.hasMore && result.olderCursor && pagesFetched < options.maxPages) {
      result = await this.chat.backfillScope(scope, result.olderCursor, {
        limit: options.pageSize
      })
      pagesFetched += 1
    }

    return { ...result, pagesFetched }
  }

  async prepareCohortTopology(
    topology: RoomCryptoTopologyResolution,
    allowCreate = false
  ): Promise<boolean> {
    await this.device.start()
    return await this.chat.prepareCohortTopology(topology, allowCreate)
  }

  async coordinatePreparedRoomKeyEpoch(
    scope: EncryptedScope,
    topology: RoomCryptoTopologyResolution,
    requestId: string
  ): Promise<RoomKeyEpochRecord> {
    await this.device.start()
    this.scopes.set(scope.id, scope)
    return await this.chat.coordinatePreparedRoomKeyEpoch(scope, topology, requestId)
  }

  async waitForMessage(
    scopeId: string,
    predicate: (message: ProcessedScopeMessage) => boolean,
    timeoutMs = MESSAGE_WAIT_TIMEOUT_MS
  ): Promise<ProcessedScopeMessage> {
    const scope = this.scopes.get(scopeId)
    if (!scope) {
      throw new Error(`Scope ${scopeId} is not being watched by this harness.`)
    }

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const result = await this.syncScope(scope, { limit: 200 })
      const message = result.messages.find(predicate)
      if (message) {
        return message
      }

      await new Promise((resolve) => setTimeout(resolve, MESSAGE_WAIT_INTERVAL_MS))
    }

    throw new Error(`Timed out waiting for a message in ${scope.kind}:${scope.id}`)
  }

  hasGroup(scopeId: string): boolean {
    return this.chat.hasGroup(scopeId)
  }

  getGroupEpoch(scopeId: string): number | null {
    return this.chat.getGroupEpoch(scopeId)
  }
}

export function createChatHarness(device: TestingDeviceHarness): SdkChatHarness {
  return new SdkChatHarness(device)
}
