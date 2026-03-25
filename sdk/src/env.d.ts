interface CryptoDbApi {
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
    pending_group_info_publish: {
      group_info_data: ArrayBuffer
      ratchet_tree_data: ArrayBuffer | null
      epoch: number
    } | null
    pending_external_commit_broadcast: {
      commit_data: string
      commit_id: string
    } | null
    pending_sponsored_transition: {
      recipient_id: string
      recipient_client_id: string | null
      recipient_key_package_ref: string | null
      commit_data: string
      commit_id: string
      remove_commit_data: string | null
      welcome_data: string | null
      group_info_data: ArrayBuffer | null
      ratchet_tree_data: ArrayBuffer | null
      epoch: number | null
      previous_epoch: number | null
      base_state: ArrayBuffer | null
      base_epoch: number | null
    } | null
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
      pending_group_info_publish?: {
        group_info_data: Uint8Array
        ratchet_tree_data: Uint8Array | null
        epoch: number
      } | null
      pending_external_commit_broadcast?: {
        commit_data: string
        commit_id: string
      } | null
      pending_sponsored_transition?: {
        recipient_id: string
        recipient_client_id: string | null
        recipient_key_package_ref: string | null
        commit_data: string
        commit_id: string
        remove_commit_data: string | null
        welcome_data: string | null
        group_info_data: Uint8Array | null
        ratchet_tree_data: Uint8Array | null
        epoch: number | null
        previous_epoch: number | null
        base_state: Uint8Array | null
        base_epoch: number | null
      } | null
    }
  ): Promise<void>
  getPendingGroupInfoPublishes(): Promise<
    Array<{
      group_id: string
      group_info_data: ArrayBuffer
      ratchet_tree_data: ArrayBuffer | null
      epoch: number
    }>
  >
  setPendingGroupInfoPublish(
    groupId: string,
    groupInfoData: Uint8Array,
    ratchetTreeData: Uint8Array | null,
    epoch: number
  ): Promise<void>
  deletePendingGroupInfoPublish(groupId: string): Promise<void>
  getPendingExternalCommitBroadcasts(): Promise<
    Array<{
      group_id: string
      commit_data: string
      commit_id: string
    }>
  >
  getPendingSponsoredTransitions(): Promise<
    Array<{
      group_id: string
      recipient_id: string
      recipient_client_id: string | null
      recipient_key_package_ref: string | null
      commit_data: string
      commit_id: string
      remove_commit_data: string | null
      welcome_data: string | null
      group_info_data: ArrayBuffer | null
      ratchet_tree_data: ArrayBuffer | null
      epoch: number | null
      previous_epoch: number | null
      base_state: ArrayBuffer | null
      base_epoch: number | null
    }>
  >
  setPendingExternalCommitBroadcast(
    groupId: string,
    commitData: string,
    commitId: string
  ): Promise<void>
  deletePendingExternalCommitBroadcast(groupId: string): Promise<void>
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
  cacheMessage(msg: {
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
  VESPER_API_URL?: string
  cryptoDb?: CryptoDbApi
}
