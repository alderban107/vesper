/**
 * Renderer-side interface to the local encrypted database.
 * In Electron, calls go through window.cryptoDb (exposed by preload).
 * In the web client, falls back to an IndexedDB adapter scoped to the
 * current user (vesper-crypto-{userId}).
 */
import { createIndexedDbAdapter } from './indexedDbStorage.js'

type AsyncStorageStore = {
  db: CryptoDbApi | null
  userId: string | null
}

type AsyncLocalStorageLike<T> = {
  getStore(): T | undefined
  run<R>(store: T, callback: () => R): R
}

const AsyncLocalStorageCtor = (() => {
  if (typeof process === 'undefined') {
    return null
  }

  const maybeProcess = process as typeof process & {
    getBuiltinModule?: (id: string) => {
      AsyncLocalStorage?: new <T>() => AsyncLocalStorageLike<T>
    } | undefined
  }

  return maybeProcess.getBuiltinModule?.('node:async_hooks')?.AsyncLocalStorage ?? null
})()

export type CryptoStorageAdapter = CryptoDbApi
export type CryptoStorageFactory = (userId: string) => CryptoStorageAdapter
export type CryptoStorageConfig = CryptoStorageAdapter | CryptoStorageFactory

export interface ScopeRepairStateRecord {
  status: string
  failureCount: number
  lastError: string | null
  updatedAt: string | null
}

export type ControlIntentOperation =
  | 'group_info_publish'
  | 'external_commit_broadcast'
  | 'sponsored_transition'
  | 'mls_remove'
  | 'mls_welcome'
  | 'mls_resync_request'
  | 'mls_history_request'
  | 'mls_history_bundle'

export type ControlIntentState = 'pending' | 'accepted' | 'rejected' | 'repair'

export interface ControlIntentRecord {
  version: 1
  operation: ControlIntentOperation
  idempotencyKey: string
  scopeId: string
  membershipGeneration: number
  payloadJson: string
  attempts: number
  state: ControlIntentState
  resultJson: string | null
  createdAt: string
  updatedAt: string
}

export interface ScopeCheckpointRecord {
  groupId: string
  groupState: {
    state: Uint8Array
    epoch: number
  } | null
  lastEventSeq: number
  recentCommitFingerprints: string[]
  recentHistoryBundleFingerprints: string[]
  repairState: ScopeRepairStateRecord | null
  controlIntents: ControlIntentRecord[]
}

export interface WorkspaceSnapshotRecord {
  version: 1
  token: string | null
  serversJson: string
  conversationsJson: string
  unreadCountsJson: string
  updatedAt: string
}

export interface CryptoStorageRuntime {
  configure(storage: CryptoStorageConfig | undefined): void
  init(userId: string): void
  reset(): void
  run<T>(userId: string | null | undefined, operation: () => Promise<T>): Promise<T>
  saveIdentity(
    userId: string,
    publicIdentityKey: Uint8Array,
    publicKeyExchange: Uint8Array,
    encryptedPrivateKeys: Uint8Array,
    nonce: Uint8Array,
    salt: Uint8Array,
    signaturePrivateKey?: Uint8Array | null
  ): Promise<void>
  loadIdentity(userId: string): Promise<{
    publicIdentityKey: Uint8Array
    publicKeyExchange: Uint8Array
    encryptedPrivateKeys: Uint8Array
    nonce: Uint8Array
    salt: Uint8Array
    signaturePrivateKey: Uint8Array | null
  } | null>
  deleteIdentity(userId: string): Promise<void>
  loadWorkspaceSnapshot(userId: string): Promise<WorkspaceSnapshotRecord | null>
  saveWorkspaceSnapshot(userId: string, snapshot: WorkspaceSnapshotRecord): Promise<void>
  saveRecoveryPackageKey(userId: string, key: Uint8Array): Promise<void>
  loadRecoveryPackageKey(userId: string): Promise<Uint8Array | null>
  saveGroupState(groupId: string, state: Uint8Array, epoch: number): Promise<void>
  loadGroupState(groupId: string): Promise<{
    state: Uint8Array
    epoch: number
  } | null>
  deleteGroupState(groupId: string): Promise<void>
  loadScopeCheckpoint(groupId: string): Promise<ScopeCheckpointRecord>
  loadKnownScopeIds(): Promise<string[]>
  saveScopeCheckpoint(groupId: string, checkpoint: ScopeCheckpointRecord): Promise<void>
  saveKeyPackages(
    packages: Array<{ publicData: Uint8Array; privateData: Uint8Array }>
  ): Promise<void>
  loadKeyPackages(): Promise<
    Array<{
      id: number
      keyPackageRef: string | null
      publicData: Uint8Array
      privateData: Uint8Array
    }>
  >
  loadKeyPackageByRef(keyPackageRef: string): Promise<{
    id: number
    keyPackageRef: string | null
    publicData: Uint8Array
    privateData: Uint8Array
  } | null>
  consumeKeyPackage(id: number): Promise<void>
  countKeyPackages(): Promise<number>
  cacheMessage(msg: {
    id: string
    roomSeq: number | null
    channelId: string | null
    conversationId: string | null
    serverId: string | null
    senderId: string | null
    senderUsername: string | null
    parentMessageId: string | null
    threadRootMessageId: string | null
    replyToMessageId: string | null
    isReply: boolean
    ciphertext: Uint8Array | null
    decryptedContent: string | null
    mlsEpoch: number | null
    insertedAt: string
  }): Promise<void>
  loadCachedMessageDecryption(messageId: string): Promise<string | null>
  saveCachedMessageDecryption(messageId: string, plaintext: string): Promise<void>
  removeCachedMessage(messageId: string): Promise<void>
  loadSentMessagePlaintext(ciphertextB64: string): Promise<string | null>
  saveSentMessagePlaintext(ciphertextB64: string, plaintext: string): Promise<void>
  loadCachedMessages(channelId: string): Promise<
    Array<{
      id: string
      roomSeq: number | null
      channelId: string | null
      conversationId: string | null
      serverId: string | null
      senderId: string | null
      senderUsername: string | null
      parentMessageId: string | null
      threadRootMessageId: string | null
      replyToMessageId: string | null
      isReply: boolean
      ciphertext: Uint8Array | null
      decryptedContent: string | null
      mlsEpoch: number | null
      insertedAt: string
    }>
  >
  clearCachedMessages(channelId: string): Promise<void>
  indexDecryptedMessage(messageId: string, channelId: string, content: string): Promise<void>
  removeFromFtsIndex(messageId: string): Promise<void>
  searchDecryptedMessages(
    query: string,
    channelId?: string
  ): Promise<
    Array<{
      messageId: string
      channelId: string
      conversationId: string | null
      serverId: string | null
      senderId: string | null
      senderUsername: string | null
      insertedAt: string | null
      preview: string
    }>
  >
  loadPendingMessageSends(): Promise<
    Array<{
      clientNonce: string
      scopeKind: 'channel' | 'dm'
      scopeId: string
      scopeChannelId: string | null
      payloadJson: string
      insertedAt: string
    }>
  >
  savePendingMessageSend(entry: {
    clientNonce: string
    scopeKind: 'channel' | 'dm'
    scopeId: string
    scopeChannelId: string | null
    payloadJson: string
    insertedAt: string
  }): Promise<void>
  deletePendingMessageSend(clientNonce: string): Promise<void>
}

export class DefaultCryptoStorageRuntime implements CryptoStorageRuntime {
  private readonly asyncStorageContext =
    AsyncLocalStorageCtor ? new AsyncLocalStorageCtor<AsyncStorageStore>() : null
  private configuredStorage: CryptoStorageConfig | undefined
  private dbValue: CryptoDbApi | null = null
  private dbUserId: string | null = null

  constructor(storage?: CryptoStorageConfig) {
    this.configuredStorage = storage
  }

  configure(storage: CryptoStorageConfig | undefined): void {
    this.configuredStorage = storage

    const context = this.asyncStorageContext?.getStore()
    if (context) {
      context.db = null
      context.userId = null
      return
    }

    this.dbValue = null
    this.dbUserId = null
  }

  init(userId: string): void {
    const context = this.asyncStorageContext?.getStore()
    if (context) {
      if (context.db && context.userId === userId) {
        return
      }

      context.db = this.resolveStorage(userId)
      context.userId = userId
      return
    }

    if (this.dbValue && this.dbUserId === userId) {
      return
    }

    this.dbValue = this.resolveStorage(userId)
    this.dbUserId = userId
  }

  reset(): void {
    const context = this.asyncStorageContext?.getStore()
    if (context) {
      context.db = null
      context.userId = null
      return
    }

    this.dbValue = null
    this.dbUserId = null
  }

  async run<T>(userId: string | null | undefined, operation: () => Promise<T>): Promise<T> {
    if (this.asyncStorageContext) {
      return await this.asyncStorageContext.run(
        {
          db: null,
          userId: null
        },
        async () => {
          if (userId) {
            this.init(userId)
          }

          return await operation()
        }
      )
    }

    if (userId) {
      this.init(userId)
    }

    return await operation()
  }

  async saveIdentity(
    userId: string,
    publicIdentityKey: Uint8Array,
    publicKeyExchange: Uint8Array,
    encryptedPrivateKeys: Uint8Array,
    nonce: Uint8Array,
    salt: Uint8Array,
    signaturePrivateKey?: Uint8Array | null
  ): Promise<void> {
    await this.db().setIdentityKeys(
      userId,
      publicIdentityKey,
      publicKeyExchange,
      encryptedPrivateKeys,
      nonce,
      salt,
      signaturePrivateKey ?? null
    )
  }

  async loadIdentity(userId: string): Promise<{
    publicIdentityKey: Uint8Array
    publicKeyExchange: Uint8Array
    encryptedPrivateKeys: Uint8Array
    nonce: Uint8Array
    salt: Uint8Array
    signaturePrivateKey: Uint8Array | null
  } | null> {
    const result = await this.db().getIdentityKeys(userId)
    if (!result) {
      return null
    }

    return {
      publicIdentityKey: new Uint8Array(result.public_identity_key),
      publicKeyExchange: new Uint8Array(result.public_key_exchange),
      encryptedPrivateKeys: new Uint8Array(result.encrypted_private_keys),
      nonce: new Uint8Array(result.nonce),
      salt: new Uint8Array(result.salt),
      signaturePrivateKey: result.signature_private_key
        ? new Uint8Array(result.signature_private_key)
        : null
    }
  }

  async deleteIdentity(userId: string): Promise<void> {
    await this.db().deleteIdentityKeys(userId)
  }

  async loadWorkspaceSnapshot(userId: string): Promise<WorkspaceSnapshotRecord | null> {
    const result = await this.db().getWorkspaceSnapshot(userId)
    if (!result || result.version !== 1) {
      return null
    }

    return {
      version: 1,
      token: result.token,
      serversJson: result.servers_json,
      conversationsJson: result.conversations_json,
      unreadCountsJson: result.unread_counts_json,
      updatedAt: result.updated_at
    }
  }

  async saveWorkspaceSnapshot(userId: string, snapshot: WorkspaceSnapshotRecord): Promise<void> {
    await this.db().setWorkspaceSnapshot(userId, {
      version: snapshot.version,
      token: snapshot.token,
      servers_json: snapshot.serversJson,
      conversations_json: snapshot.conversationsJson,
      unread_counts_json: snapshot.unreadCountsJson,
      updated_at: snapshot.updatedAt
    })
  }

  async saveRecoveryPackageKey(userId: string, key: Uint8Array): Promise<void> {
    await this.db().setRecoveryPackageKey(userId, key)
  }

  async loadRecoveryPackageKey(userId: string): Promise<Uint8Array | null> {
    const result = await this.db().getRecoveryPackageKey(userId)
    return result ? new Uint8Array(result) : null
  }

  async saveGroupState(groupId: string, state: Uint8Array, epoch: number): Promise<void> {
    await this.db().setGroupState(groupId, state, epoch)
  }

  async loadGroupState(groupId: string): Promise<{
    state: Uint8Array
    epoch: number
  } | null> {
    const result = await this.db().getGroupState(groupId)
    if (!result) {
      return null
    }

    return {
      state: new Uint8Array(result.state),
      epoch: result.epoch
    }
  }

  async deleteGroupState(groupId: string): Promise<void> {
    await this.db().deleteGroupState(groupId)
  }

  async loadScopeCheckpoint(groupId: string): Promise<ScopeCheckpointRecord> {
    const result = await this.db().getScopeCheckpoint(groupId)

    return {
      groupId: result.group_id,
      groupState: result.state
        ? {
            state: new Uint8Array(result.state),
            epoch: result.epoch
          }
        : null,
      lastEventSeq: result.last_event_seq,
      recentCommitFingerprints: [...result.recent_commit_fingerprints],
      recentHistoryBundleFingerprints: [...(result.recent_history_bundle_fingerprints ?? [])],
      repairState: result.repair_status
        ? {
            status: result.repair_status,
            failureCount: result.repair_failure_count,
            lastError: result.repair_last_error,
            updatedAt: result.repair_updated_at
          }
        : null,
      controlIntents: (result.control_intents ?? []).map((intent) => ({
        version: 1,
        operation: intent.operation as ControlIntentOperation,
        idempotencyKey: intent.idempotency_key,
        scopeId: intent.scope_id,
        membershipGeneration: intent.membership_generation,
        payloadJson: intent.payload_json,
        attempts: intent.attempts,
        state: intent.state as ControlIntentState,
        resultJson: intent.result_json,
        createdAt: intent.created_at,
        updatedAt: intent.updated_at
      }))
    }
  }

  async loadKnownScopeIds(): Promise<string[]> {
    return await this.db().getKnownScopeIds()
  }

  async saveScopeCheckpoint(groupId: string, checkpoint: ScopeCheckpointRecord): Promise<void> {
    await this.db().setScopeCheckpoint(groupId, {
      state: checkpoint.groupState?.state ?? null,
      epoch: checkpoint.groupState?.epoch ?? 0,
      last_event_seq: checkpoint.lastEventSeq,
      recent_commit_fingerprints: [...checkpoint.recentCommitFingerprints],
      recent_history_bundle_fingerprints: [...checkpoint.recentHistoryBundleFingerprints],
      repair_status: checkpoint.repairState?.status ?? null,
      repair_failure_count: checkpoint.repairState?.failureCount ?? 0,
      repair_last_error: checkpoint.repairState?.lastError ?? null,
      repair_updated_at: checkpoint.repairState?.updatedAt ?? null,
      control_intents: checkpoint.controlIntents.map((intent) => ({
        version: 1,
        operation: intent.operation,
        idempotency_key: intent.idempotencyKey,
        scope_id: intent.scopeId,
        membership_generation: intent.membershipGeneration,
        payload_json: intent.payloadJson,
        attempts: intent.attempts,
        state: intent.state,
        result_json: intent.resultJson,
        created_at: intent.createdAt,
        updated_at: intent.updatedAt
      }))
    })
  }

  async saveKeyPackages(
    packages: Array<{ publicData: Uint8Array; privateData: Uint8Array }>
  ): Promise<void> {
    await this.db().setLocalKeyPackages(packages)
  }

  async loadKeyPackages(): Promise<
    Array<{
      id: number
      keyPackageRef: string | null
      publicData: Uint8Array
      privateData: Uint8Array
    }>
  > {
    const results = await this.db().getLocalKeyPackages()
    return results.map((result) => ({
      id: result.id,
      keyPackageRef: result.key_package_ref ?? null,
      publicData: new Uint8Array(result.key_package_public),
      privateData: new Uint8Array(result.key_package_private)
    }))
  }

  async loadKeyPackageByRef(keyPackageRef: string): Promise<{
    id: number
    keyPackageRef: string | null
    publicData: Uint8Array
    privateData: Uint8Array
  } | null> {
    const result = await this.db().getLocalKeyPackageByRef(keyPackageRef)
    if (!result) {
      return null
    }

    return {
      id: result.id,
      keyPackageRef: result.key_package_ref ?? null,
      publicData: new Uint8Array(result.key_package_public),
      privateData: new Uint8Array(result.key_package_private)
    }
  }

  async consumeKeyPackage(id: number): Promise<void> {
    await this.db().consumeLocalKeyPackage(id)
  }

  async countKeyPackages(): Promise<number> {
    return await this.db().countLocalKeyPackages()
  }

  async cacheMessage(msg: {
    id: string
    roomSeq: number | null
    channelId: string | null
    conversationId: string | null
    serverId: string | null
    senderId: string | null
    senderUsername: string | null
    parentMessageId: string | null
    threadRootMessageId: string | null
    replyToMessageId: string | null
    isReply: boolean
    ciphertext: Uint8Array | null
    decryptedContent: string | null
    mlsEpoch: number | null
    insertedAt: string
  }): Promise<void> {
    await this.db().cacheMessage({
      id: msg.id,
      room_seq: msg.roomSeq,
      channel_id: msg.channelId,
      conversation_id: msg.conversationId,
      server_id: msg.serverId,
      sender_id: msg.senderId,
      sender_username: msg.senderUsername,
      parent_message_id: msg.parentMessageId,
      thread_root_message_id: msg.threadRootMessageId,
      reply_to_message_id: msg.replyToMessageId,
      is_reply: msg.isReply,
      ciphertext: msg.ciphertext,
      decrypted_content: msg.decryptedContent,
      mls_epoch: msg.mlsEpoch,
      inserted_at: msg.insertedAt
    })
  }

  async loadCachedMessageDecryption(messageId: string): Promise<string | null> {
    return await this.db().getCachedMessageDecryption(messageId)
  }

  async saveCachedMessageDecryption(messageId: string, plaintext: string): Promise<void> {
    await this.db().setCachedMessageDecryption(messageId, plaintext)
  }

  async removeCachedMessage(messageId: string): Promise<void> {
    await this.db().deleteCachedMessage(messageId)
  }

  async loadSentMessagePlaintext(ciphertextB64: string): Promise<string | null> {
    return await this.db().getSentMessagePlaintext(ciphertextB64)
  }

  async saveSentMessagePlaintext(ciphertextB64: string, plaintext: string): Promise<void> {
    await this.db().setSentMessagePlaintext(ciphertextB64, plaintext)
  }

  async loadCachedMessages(channelId: string): Promise<
    Array<{
      id: string
      roomSeq: number | null
      channelId: string | null
      conversationId: string | null
      serverId: string | null
      senderId: string | null
      senderUsername: string | null
      parentMessageId: string | null
      threadRootMessageId: string | null
      replyToMessageId: string | null
      isReply: boolean
      ciphertext: Uint8Array | null
      decryptedContent: string | null
      mlsEpoch: number | null
      insertedAt: string
    }>
  > {
    const results = await this.db().getCachedMessages(channelId)
    return results.map((result) => ({
      id: result.id,
      roomSeq: result.room_seq ?? null,
      channelId: result.channel_id,
      conversationId: result.conversation_id,
      serverId: result.server_id,
      senderId: result.sender_id,
      senderUsername: result.sender_username,
      parentMessageId: result.parent_message_id ?? null,
      threadRootMessageId: result.thread_root_message_id ?? null,
      replyToMessageId: result.reply_to_message_id ?? null,
      isReply: Boolean(result.is_reply),
      ciphertext: result.ciphertext ? new Uint8Array(result.ciphertext) : null,
      decryptedContent: result.decrypted_content,
      mlsEpoch: result.mls_epoch,
      insertedAt: result.inserted_at
    }))
  }

  async clearCachedMessages(channelId: string): Promise<void> {
    await this.db().clearMessageCache(channelId)
  }

  async indexDecryptedMessage(
    messageId: string,
    channelId: string,
    content: string
  ): Promise<void> {
    await this.db().indexDecryptedMessage(messageId, channelId, content)
  }

  async removeFromFtsIndex(messageId: string): Promise<void> {
    await this.db().removeFromFtsIndex(messageId)
  }

  async searchDecryptedMessages(
    query: string,
    channelId?: string
  ): Promise<
    Array<{
      messageId: string
      channelId: string
      conversationId: string | null
      serverId: string | null
      senderId: string | null
      senderUsername: string | null
      insertedAt: string | null
      preview: string
    }>
  > {
    const results = await this.db().searchMessages(query, channelId)
    return results.map((result) => ({
      messageId: result.message_id,
      channelId: result.channel_id,
      conversationId: result.conversation_id,
      serverId: result.server_id,
      senderId: result.sender_id,
      senderUsername: result.sender_username,
      insertedAt: result.inserted_at,
      preview: result.preview
    }))
  }

  async loadPendingMessageSends(): Promise<
    Array<{
      clientNonce: string
      scopeKind: 'channel' | 'dm'
      scopeId: string
      scopeChannelId: string | null
      payloadJson: string
      insertedAt: string
    }>
  > {
    const results = await this.db().getPendingMessageSends()
    return results.map((result) => ({
      clientNonce: result.client_nonce,
      scopeKind: result.scope_kind,
      scopeId: result.scope_id,
      scopeChannelId: result.scope_channel_id,
      payloadJson: result.payload_json,
      insertedAt: result.inserted_at
    }))
  }

  async savePendingMessageSend(entry: {
    clientNonce: string
    scopeKind: 'channel' | 'dm'
    scopeId: string
    scopeChannelId: string | null
    payloadJson: string
    insertedAt: string
  }): Promise<void> {
    await this.db().setPendingMessageSend({
      client_nonce: entry.clientNonce,
      scope_kind: entry.scopeKind,
      scope_id: entry.scopeId,
      scope_channel_id: entry.scopeChannelId,
      payload_json: entry.payloadJson,
      inserted_at: entry.insertedAt
    })
  }

  async deletePendingMessageSend(clientNonce: string): Promise<void> {
    await this.db().deletePendingMessageSend(clientNonce)
  }

  private db(): CryptoDbApi {
    const context = this.asyncStorageContext?.getStore()
    const activeDb = context?.db ?? this.dbValue
    if (activeDb) {
      return activeDb
    }

    throw new Error('Crypto storage not initialized. Call init(userId) after login.')
  }

  private resolveStorage(userId: string): CryptoDbApi {
    if (typeof this.configuredStorage === 'function') {
      return this.configuredStorage(userId)
    }

    if (this.configuredStorage) {
      return this.configuredStorage
    }

    if (typeof window !== 'undefined' && window.cryptoDb) {
      return window.cryptoDb
    }

    if (typeof window !== 'undefined') {
      const nextDb = createIndexedDbAdapter(userId)
      deleteLegacyDb()
      return nextDb
    }

    throw new Error(
      'Crypto storage is not configured. Pass a storage runtime or storage adapter before using the SDK outside the browser.'
    )
  }
}

export function createCryptoStorageRuntime(
  storage?: CryptoStorageConfig
): CryptoStorageRuntime {
  return new DefaultCryptoStorageRuntime(storage)
}

/**
 * Delete the legacy un-namespaced 'vesper-crypto' IndexedDB database.
 * Before the user-scoping fix, all users shared this single database,
 * which caused key packages and group states to leak across accounts.
 */
function deleteLegacyDb(): void {
  try {
    const req = indexedDB.deleteDatabase('vesper-crypto')
    req.onerror = () => {
      console.warn('Failed to delete legacy vesper-crypto database')
    }
  } catch {
    // Ignore; this cleanup is best-effort.
  }
}
