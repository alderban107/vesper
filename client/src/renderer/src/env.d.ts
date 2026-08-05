/// <reference types="vite/client" />

interface ControlIntentStorageRecord {
  version: 1
  operation: string
  idempotency_key: string
  scope_id: string
  membership_generation: number
  payload_json: string
  attempts: number
  state: string
  result_json: string | null
  created_at: string
  updated_at: string
}

interface EncryptedRoomDataKeyStorageRecord {
  room_id: string
  topology_generation: number
  epoch: number
  ciphertext: string
  nonce: string
}

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
  getWorkspaceSnapshot(userId: string): Promise<{
    version: number
    token: string | null
    servers_json: string
    conversations_json: string
    unread_counts_json: string
    updated_at: string
  } | null>
  setWorkspaceSnapshot(userId: string, snapshot: {
    version: number
    token: string | null
    servers_json: string
    conversations_json: string
    unread_counts_json: string
    updated_at: string
  }): Promise<void>
  getRecoveryPackageKey(userId: string): Promise<ArrayBuffer | null>
  setRecoveryPackageKey(userId: string, key: Uint8Array): Promise<void>

  // MLS groups
  getGroupState(groupId: string): Promise<{
    state: ArrayBuffer
    epoch: number
  } | null>
  setGroupState(groupId: string, state: Uint8Array, epoch: number): Promise<void>
  deleteGroupState(groupId: string): Promise<void>
  getGroupSyncCursor(groupId: string): Promise<number>
  setGroupSyncCursor(groupId: string, lastEventSeq: number): Promise<void>
  getScopeCheckpoint(groupId: string): Promise<{
    group_id: string
    state: ArrayBuffer | null
    epoch: number
    last_event_seq: number
    recent_commit_fingerprints: string[]
    recent_history_bundle_fingerprints: string[]
    repair_status: string | null
    repair_failure_count: number
    repair_last_error: string | null
    repair_updated_at: string | null
    room_data_keys: EncryptedRoomDataKeyStorageRecord[]
    control_intents: ControlIntentStorageRecord[]
  }>
  getKnownScopeIds(): Promise<string[]>
  setScopeCheckpoint(
    groupId: string,
    checkpoint: {
      state: Uint8Array | null
      epoch: number
      last_event_seq: number
      recent_commit_fingerprints?: string[]
      recent_history_bundle_fingerprints?: string[]
      repair_status?: string | null
      repair_failure_count?: number
      repair_last_error?: string | null
      repair_updated_at?: string | null
      room_data_keys?: EncryptedRoomDataKeyStorageRecord[]
      control_intents?: ControlIntentStorageRecord[]
    }
  ): Promise<void>
  // Key packages
  getLocalKeyPackages(): Promise<
    Array<{
      id: number
      key_package_ref: string | null
      key_package_public: ArrayBuffer
      key_package_private: ArrayBuffer
    }>
  >
  getLocalKeyPackageByRef(keyPackageRef: string): Promise<{
    id: number
    key_package_ref: string | null
    key_package_public: ArrayBuffer
    key_package_private: ArrayBuffer
  } | null>
  setLocalKeyPackages(
    packages: Array<{ publicData: Uint8Array; privateData: Uint8Array }>
  ): Promise<void>
  consumeLocalKeyPackage(id: number): Promise<void>
  countLocalKeyPackages(): Promise<number>

  // Message cache (stores ciphertext, not plaintext)
  cacheMessage(msg: {
    id: string
    room_seq: number | null
    channel_id: string | null
    conversation_id: string | null
    server_id: string | null
    sender_id: string | null
    sender_username: string | null
    parent_message_id: string | null
    thread_root_message_id: string | null
    reply_to_message_id: string | null
    is_reply: boolean
    ciphertext: Uint8Array | null
    decrypted_content: string | null
    mls_epoch: number | null
    inserted_at: string
  }): Promise<void>
  getCachedMessageDecryption(messageId: string): Promise<string | null>
  setCachedMessageDecryption(messageId: string, plaintext: string): Promise<void>
  deleteCachedMessage(messageId: string): Promise<void>
  getCachedMessages(channelId: string): Promise<
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

  // Pending message send outbox — durable across a crash between "user hit
  // send" and "server acknowledged the write". Keyed by client_nonce so a
  // retry after restart is idempotent with the server's nonce unique index.
  // scope_channel_id reconstructs EncryptedScope.channelId for DMs backed by
  // a channel, where the MLS group id differs from the DM's own scope id.
  getPendingMessageSends(): Promise<
    Array<{
      client_nonce: string
      scope_kind: 'channel' | 'dm'
      scope_id: string
      scope_channel_id: string | null
      payload_json: string
      inserted_at: string
    }>
  >
  setPendingMessageSend(entry: {
    client_nonce: string
    scope_kind: 'channel' | 'dm'
    scope_id: string
    scope_channel_id: string | null
    payload_json: string
    inserted_at: string
  }): Promise<void>
  deletePendingMessageSend(clientNonce: string): Promise<void>
}

interface E2eeScopeDiagnosticsSnapshot {
  epoch: number
  groupCreations: number
  commitsProcessed: number
  commitsFailed: number
  welcomesProcessed: number
  welcomesFailed: number
  joinRequestsHandled: number
  keyPackagesConsumed: number
}

interface VesperE2eeTestBridge {
  resolveActiveChannelScopeId(): Promise<string | null>
  hasGroup(scopeId: string): boolean
  getScopeDiagnostics(scopeId: string): E2eeScopeDiagnosticsSnapshot | null
  getCachedMessageTexts(scopeId: string): Promise<string[]>
  prepareScopeForRead(
    scope: { kind: 'channel' | 'dm'; id: string },
    options?: {
      lastKnownEpoch?: number | null
      reason?: string | null
    }
  ): Promise<boolean>
}

interface Window {
  cryptoDb: CryptoDbApi
  authSession?: {
    setRefreshToken(refreshToken: string, serverUrl: string): boolean
    clearRefreshToken(): boolean
    refreshAccessToken(serverUrl: string): Promise<
      | { status: 'ok'; accessToken: string }
      | { status: 'invalid' }
      | { status: 'retryable' }
    >
  }
  __mlsDiagnostics?: {
    forScope(scopeId: string): E2eeScopeDiagnosticsSnapshot | null
    allScopes(): Record<string, E2eeScopeDiagnosticsSnapshot>
  }
  __vesperE2eeTest?: VesperE2eeTestBridge
  linkPreview?: {
    fetchMetadata(url: string): Promise<{
      url: string
      title: string | null
      description: string | null
      image_url: string | null
      site_name: string | null
    } | null>
  }
  attachmentMedia?: {
    register(registration: {
      attachmentId: string
      serverUrl: string
      accessToken: string
      contentType: string
      plaintextSize: number
      encryption: { v: 2; key: string; nonce_prefix: string }
    }): Promise<string>
    release(url: string): Promise<boolean>
    clear(): Promise<void>
  }
  electron: {
    ipcRenderer: {
      invoke(channel: string, ...args: unknown[]): Promise<unknown>
      send(channel: string, ...args: unknown[]): void
      on(channel: string, listener: (...args: unknown[]) => void): () => void
    }
  }
}
}
}
