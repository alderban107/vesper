interface CachedMessageRecord {
  id: string
  room_seq: number | null
  channel_id: string | null
  conversation_id: string | null
  server_id: string | null
  sender_id: string | null
  sender_username: string | null
  parent_message_id: string | null
  ciphertext: Uint8Array | null
  decrypted_content: string | null
  mls_epoch: number | null
  inserted_at: string
}

interface IndexedMessageRecord {
  message_id: string
  channel_id: string
  conversation_id: string | null
  server_id: string | null
  sender_id: string | null
  sender_username: string | null
  inserted_at: string | null
  preview: string
}

function bytesToBase64(value: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value).toString('base64')
  }

  let binary = ''
  for (const byte of value) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function cloneArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength
  ) as ArrayBuffer
}

export class MemoryStorage implements CryptoDbApi {
  private readonly identityKeys = new Map<
    string,
    {
      public_identity_key: Uint8Array
      public_key_exchange: Uint8Array
      encrypted_private_keys: Uint8Array
      nonce: Uint8Array
      salt: Uint8Array
      signature_private_key: Uint8Array | null
    }
  >()

  private readonly groupStates = new Map<string, { state: Uint8Array; epoch: number }>()
  private readonly groupSyncCursors = new Map<string, number>()
  private readonly keyPackages = new Map<
    number,
    {
      key_package_ref: string | null
      key_package_public: Uint8Array
      key_package_private: Uint8Array
    }
  >()
  private readonly keyPackageIdsByRef = new Map<string, number>()
  private readonly cachedMessages = new Map<string, CachedMessageRecord>()
  private readonly cachedMessageIdsByScope = new Map<string, Set<string>>()
  private readonly cachedDecryptions = new Map<string, string>()
  private readonly sentPlaintext = new Map<string, string>()
  private readonly searchIndex = new Map<string, IndexedMessageRecord>()
  private nextKeyPackageId = 1

  async getIdentityKeys(userId: string): Promise<{
    public_identity_key: ArrayBuffer
    public_key_exchange: ArrayBuffer
    encrypted_private_keys: ArrayBuffer
    nonce: ArrayBuffer
    salt: ArrayBuffer
    signature_private_key: ArrayBuffer | null
  } | null> {
    const record = this.identityKeys.get(userId)
    if (!record) {
      return null
    }

    return {
      public_identity_key: cloneArrayBuffer(record.public_identity_key),
      public_key_exchange: cloneArrayBuffer(record.public_key_exchange),
      encrypted_private_keys: cloneArrayBuffer(record.encrypted_private_keys),
      nonce: cloneArrayBuffer(record.nonce),
      salt: cloneArrayBuffer(record.salt),
      signature_private_key: record.signature_private_key
        ? cloneArrayBuffer(record.signature_private_key)
        : null
    }
  }

  async setIdentityKeys(
    userId: string,
    publicIdentityKey: Uint8Array,
    publicKeyExchange: Uint8Array,
    encryptedPrivateKeys: Uint8Array,
    nonce: Uint8Array,
    salt: Uint8Array,
    signaturePrivateKey?: Uint8Array | null
  ): Promise<void> {
    this.identityKeys.set(userId, {
      public_identity_key: new Uint8Array(publicIdentityKey),
      public_key_exchange: new Uint8Array(publicKeyExchange),
      encrypted_private_keys: new Uint8Array(encryptedPrivateKeys),
      nonce: new Uint8Array(nonce),
      salt: new Uint8Array(salt),
      signature_private_key: signaturePrivateKey ? new Uint8Array(signaturePrivateKey) : null
    })
  }

  async deleteIdentityKeys(userId: string): Promise<void> {
    this.identityKeys.delete(userId)
  }

  async getGroupState(groupId: string): Promise<{ state: ArrayBuffer; epoch: number } | null> {
    const record = this.groupStates.get(groupId)
    if (!record) {
      return null
    }

    return {
      state: cloneArrayBuffer(record.state),
      epoch: record.epoch
    }
  }

  async setGroupState(groupId: string, state: Uint8Array, epoch: number): Promise<void> {
    this.groupStates.set(groupId, { state: new Uint8Array(state), epoch })
  }

  async deleteGroupState(groupId: string): Promise<void> {
    this.groupStates.delete(groupId)
  }

  async getGroupSyncCursor(groupId: string): Promise<number> {
    return this.groupSyncCursors.get(groupId) ?? 0
  }

  async setGroupSyncCursor(groupId: string, lastEventSeq: number): Promise<void> {
    this.groupSyncCursors.set(groupId, lastEventSeq)
  }

  async getLocalKeyPackages(): Promise<
    Array<{
      id: number
      key_package_ref: string | null
      key_package_public: ArrayBuffer
      key_package_private: ArrayBuffer
    }>
  > {
    return [...this.keyPackages.entries()].map(([id, record]) => ({
      id,
      key_package_ref: record.key_package_ref,
      key_package_public: cloneArrayBuffer(record.key_package_public),
      key_package_private: cloneArrayBuffer(record.key_package_private)
    }))
  }

  async getLocalKeyPackageByRef(keyPackageRef: string): Promise<{
    id: number
    key_package_ref: string | null
    key_package_public: ArrayBuffer
    key_package_private: ArrayBuffer
  } | null> {
    const id = this.keyPackageIdsByRef.get(keyPackageRef)
    if (id == null) {
      return null
    }

    const record = this.keyPackages.get(id)
    if (!record) {
      return null
    }

    return {
      id,
      key_package_ref: record.key_package_ref,
      key_package_public: cloneArrayBuffer(record.key_package_public),
      key_package_private: cloneArrayBuffer(record.key_package_private)
    }
  }

  async setLocalKeyPackages(
    packages: Array<{ publicData: Uint8Array; privateData: Uint8Array }>
  ): Promise<void> {
    for (const pkg of packages) {
      const id = this.nextKeyPackageId++
      const keyPackageRef = bytesToBase64(pkg.publicData)

      this.keyPackages.set(id, {
        key_package_ref: keyPackageRef,
        key_package_public: new Uint8Array(pkg.publicData),
        key_package_private: new Uint8Array(pkg.privateData)
      })
      this.keyPackageIdsByRef.set(keyPackageRef, id)
    }
  }

  async consumeLocalKeyPackage(id: number): Promise<void> {
    const record = this.keyPackages.get(id)
    if (record?.key_package_ref) {
      this.keyPackageIdsByRef.delete(record.key_package_ref)
    }
    this.keyPackages.delete(id)
  }

  async countLocalKeyPackages(): Promise<number> {
    return this.keyPackages.size
  }

  async cacheMessage(msg: CachedMessageRecord): Promise<void> {
    const existing = this.cachedMessages.get(msg.id)
    if (existing) {
      this.unindexCachedMessage(existing)
    }

    this.cachedMessages.set(msg.id, {
      ...msg,
      ciphertext: msg.ciphertext ? new Uint8Array(msg.ciphertext) : null
    })
    this.indexCachedMessage(msg)
  }

  async getCachedMessageDecryption(messageId: string): Promise<string | null> {
    return this.cachedDecryptions.get(messageId) ?? null
  }

  async setCachedMessageDecryption(messageId: string, plaintext: string): Promise<void> {
    this.cachedDecryptions.set(messageId, plaintext)
  }

  async getCachedMessages(channelId: string): Promise<
    Array<{
      id: string
      room_seq: number | null
      channel_id: string | null
      conversation_id: string | null
      server_id: string | null
      sender_id: string | null
      sender_username: string | null
      parent_message_id: string | null
      ciphertext: ArrayBuffer | null
      decrypted_content: string | null
      mls_epoch: number | null
      inserted_at: string
    }>
  > {
    const messageIds = this.cachedMessageIdsByScope.get(channelId)
    if (!messageIds || messageIds.size === 0) {
      return []
    }

    return [...messageIds]
      .map((messageId) => this.cachedMessages.get(messageId) ?? null)
      .filter((message): message is CachedMessageRecord => Boolean(message))
      .sort((left, right) => {
        const timeDelta = left.inserted_at.localeCompare(right.inserted_at)
        if (timeDelta !== 0) {
          return timeDelta
        }

        return left.id.localeCompare(right.id)
      })
      .map((message) => ({
        ...message,
        ciphertext: message.ciphertext ? cloneArrayBuffer(message.ciphertext) : null
      }))
  }

  async clearMessageCache(channelId: string): Promise<void> {
    const messageIds = this.cachedMessageIdsByScope.get(channelId)
    if (!messageIds) {
      return
    }

    for (const messageId of [...messageIds]) {
      const record = this.cachedMessages.get(messageId)
      if (!record) {
        continue
      }

      this.unindexCachedMessage(record)
      this.cachedMessages.delete(messageId)
    }
  }

  async getSentMessagePlaintext(ciphertextB64: string): Promise<string | null> {
    return this.sentPlaintext.get(ciphertextB64) ?? null
  }

  async setSentMessagePlaintext(ciphertextB64: string, plaintext: string): Promise<void> {
    this.sentPlaintext.set(ciphertextB64, plaintext)
  }

  async searchMessages(
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
  > {
    const needle = query.trim().toLowerCase()

    return [...this.searchIndex.values()].filter((record) => {
      if (channelId && record.channel_id !== channelId) {
        return false
      }

      return record.preview.toLowerCase().includes(needle)
    })
  }

  async indexDecryptedMessage(
    messageId: string,
    channelId: string,
    content: string
  ): Promise<void> {
    const cachedMessage = this.cachedMessages.get(messageId)
    this.searchIndex.set(messageId, {
      message_id: messageId,
      channel_id: channelId,
      conversation_id: cachedMessage?.conversation_id ?? null,
      server_id: cachedMessage?.server_id ?? null,
      sender_id: cachedMessage?.sender_id ?? null,
      sender_username: cachedMessage?.sender_username ?? null,
      inserted_at: cachedMessage?.inserted_at ?? null,
      preview: content
    })
  }

  async removeFromFtsIndex(messageId: string): Promise<void> {
    this.searchIndex.delete(messageId)
  }

  private indexCachedMessage(message: CachedMessageRecord): void {
    for (const scopeId of this.getScopeIdsForMessage(message)) {
      const messageIds = this.cachedMessageIdsByScope.get(scopeId) ?? new Set<string>()
      messageIds.add(message.id)
      this.cachedMessageIdsByScope.set(scopeId, messageIds)
    }
  }

  private unindexCachedMessage(message: CachedMessageRecord): void {
    for (const scopeId of this.getScopeIdsForMessage(message)) {
      const messageIds = this.cachedMessageIdsByScope.get(scopeId)
      if (!messageIds) {
        continue
      }

      messageIds.delete(message.id)
      if (messageIds.size === 0) {
        this.cachedMessageIdsByScope.delete(scopeId)
      }
    }
  }

  private getScopeIdsForMessage(message: CachedMessageRecord): string[] {
    const scopeIds: string[] = []

    if (message.channel_id) {
      scopeIds.push(message.channel_id)
    }

    if (message.conversation_id) {
      scopeIds.push(message.conversation_id)
    }

    return scopeIds
  }
}
