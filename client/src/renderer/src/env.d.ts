/// <reference types="vite/client" />

interface CryptoDbApi {
  // Identity keys
  getIdentityKeys(userId: string): Promise<{
    public_identity_key: ArrayBuffer
    public_key_exchange: ArrayBuffer
    encrypted_private_keys: ArrayBuffer
    nonce: ArrayBuffer
    salt: ArrayBuffer
    signature_private_key: ArrayBuffer | null
  } | null>
  setIdentityKeys(
    userId: string,
    publicIdentityKey: Uint8Array,
    publicKeyExchange: Uint8Array,
    encryptedPrivateKeys: Uint8Array,
    nonce: Uint8Array,
    salt: Uint8Array,
    signaturePrivateKey?: Uint8Array | null
  ): Promise<void>
  deleteIdentityKeys(userId: string): Promise<void>

  // MLS groups
  getGroupState(groupId: string): Promise<{
    state: ArrayBuffer
    epoch: number
  } | null>
  setGroupState(groupId: string, state: Uint8Array, epoch: number): Promise<void>
  deleteGroupState(groupId: string): Promise<void>

  // Key packages
  getLocalKeyPackages(): Promise<
    Array<{
      id: number
      key_package_public: ArrayBuffer
      key_package_private: ArrayBuffer
    }>
  >
  setLocalKeyPackages(
    packages: Array<{ publicData: Uint8Array; privateData: Uint8Array }>
  ): Promise<void>
  consumeLocalKeyPackage(id: number): Promise<void>
  countLocalKeyPackages(): Promise<number>

  // Message cache (stores ciphertext, not plaintext)
  cacheMessage(msg: {
    id: string
    channel_id: string | null
    conversation_id: string | null
    server_id: string | null
    sender_id: string | null
    sender_username: string | null
    ciphertext: Uint8Array | null
    decrypted_content: string | null
    mls_epoch: number | null
    inserted_at: string
  }): Promise<void>
  getCachedMessageDecryption(messageId: string): Promise<string | null>
  setCachedMessageDecryption(messageId: string, plaintext: string): Promise<void>
  getCachedMessages(channelId: string): Promise<
    Array<{
      id: string
      channel_id: string | null
      conversation_id: string | null
      server_id: string | null
      sender_id: string | null
      sender_username: string | null
      ciphertext: ArrayBuffer | null
      decrypted_content: string | null
      mls_epoch: number | null
      inserted_at: string
    }>
  >
  clearMessageCache(channelId: string): Promise<void>
  getSentMessagePlaintext(ciphertextB64: string): Promise<string | null>
  setSentMessagePlaintext(ciphertextB64: string, plaintext: string): Promise<void>

  // FTS5 full-text search
  searchMessages(
    query: string,
    channelId?: string
  ): Promise<
    Array<{
      message_id: string
      channel_id: string
      conversation_id: string | null
      server_id: string | null
      sender_id: string | null
      sender_username: string | null
      inserted_at: string | null
      preview: string
    }>
  >
  indexDecryptedMessage(
    messageId: string,
    channelId: string,
    content: string
  ): Promise<void>
  removeFromFtsIndex(messageId: string): Promise<void>
}

interface Window {
  cryptoDb: CryptoDbApi
  linkPreview?: {
    fetchMetadata(url: string): Promise<{
      url: string
      title: string | null
      description: string | null
      image_url: string | null
      site_name: string | null
    } | null>
  }
  electron: {
    ipcRenderer: {
      invoke(channel: string, ...args: unknown[]): Promise<unknown>
      send(channel: string, ...args: unknown[]): void
      on(channel: string, listener: (...args: unknown[]) => void): () => void
    }
  }
}
