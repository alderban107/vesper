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
  saveGroupState(groupId: string, state: Uint8Array, epoch: number): Promise<void>
  loadGroupState(groupId: string): Promise<{
    state: Uint8Array
    epoch: number
  } | null>
  deleteGroupState(groupId: string): Promise<void>
  loadGroupSyncCursor(groupId: string): Promise<number>
  saveGroupSyncCursor(groupId: string, lastEventSeq: number): Promise<void>
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

  async loadGroupSyncCursor(groupId: string): Promise<number> {
    return await this.db().getGroupSyncCursor(groupId)
  }

  async saveGroupSyncCursor(groupId: string, lastEventSeq: number): Promise<void> {
    await this.db().setGroupSyncCursor(groupId, lastEventSeq)
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
