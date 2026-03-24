import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

interface FileCryptoState {
  nextKeyPackageId: number
  identityKeys: Record<
    string,
    {
      public_identity_key: string | null
      public_key_exchange: string | null
      encrypted_private_keys: string | null
      nonce: string | null
      salt: string | null
      signature_private_key: string | null
    }
  >
  groupStates: Record<string, { state: string | null; epoch: number }>
  groupSyncCursors: Record<string, number>
  scopeMetadata: Record<
    string,
    {
      recent_commit_fingerprints: string[]
      recent_history_bundle_fingerprints: string[]
      repair_status: string | null
      repair_failure_count: number
      repair_last_error: string | null
      repair_updated_at: string | null
    }
  >
  pendingGroupInfoPublishes: Record<
    string,
    {
      group_info_data: string | null
      ratchet_tree_data: string | null
      epoch: number
    }
  >
  pendingExternalCommitBroadcasts: Record<
    string,
    {
      commit_data: string
      commit_id: string
    }
  >
  pendingSponsoredTransitions: Record<
    string,
    {
      recipient_id: string
      recipient_client_id: string | null
      recipient_key_package_ref: string | null
      commit_data: string
      commit_id: string
      remove_commit_data: string | null
      welcome_data: string | null
      group_info_data: string | null
      ratchet_tree_data: string | null
      epoch: number | null
      previous_epoch: number | null
      base_state: string | null
      base_epoch: number | null
    }
  >
  keyPackages: Array<{
    id: number
    key_package_ref: string | null
    key_package_public: string | null
    key_package_private: string | null
  }>
  cachedMessages: Record<string, CachedMessageRecord>
  cachedDecryptions: Record<string, string>
  sentPlaintext: Record<string, string>
  searchIndex: Record<string, IndexedMessageRecord>
}

interface CachedMessageRecord {
  id: string
  room_seq: number | null
  channel_id: string | null
  conversation_id: string | null
  server_id: string | null
  sender_id: string | null
  sender_username: string | null
  parent_message_id: string | null
  ciphertext: string | null
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

function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true })
}

function safeReadJson<T>(filePath: string, fallback: T): T {
  try {
    if (!existsSync(filePath)) {
      return fallback
    }

    const raw = readFileSync(filePath, 'utf8')
    return raw.trim() ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath))
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function bytesToBase64(value: Uint8Array | null | undefined): string | null {
  if (!value) {
    return null
  }

  return Buffer.from(value).toString('base64')
}

function base64ToArrayBuffer(value: string | null | undefined): ArrayBuffer | null {
  if (!value) {
    return null
  }

  const buffer = Buffer.from(value, 'base64')
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
}

function createEmptyCryptoState(): FileCryptoState {
  return {
    nextKeyPackageId: 1,
    identityKeys: {},
    groupStates: {},
    groupSyncCursors: {},
    scopeMetadata: {},
    pendingGroupInfoPublishes: {},
    pendingExternalCommitBroadcasts: {},
    pendingSponsoredTransitions: {},
    keyPackages: [],
    cachedMessages: {},
    cachedDecryptions: {},
    sentPlaintext: {},
    searchIndex: {}
  }
}

export class FileCryptoStorage implements CryptoDbApi {
  private readonly filePath: string
  private state: FileCryptoState

  constructor(filePath: string) {
    this.filePath = filePath
    this.state = safeReadJson<FileCryptoState>(filePath, createEmptyCryptoState())
    this.state.scopeMetadata ??= {}
    this.state.groupSyncCursors ??= {}
    this.state.pendingGroupInfoPublishes ??= {}
    this.state.pendingExternalCommitBroadcasts ??= {}
    this.state.pendingSponsoredTransitions ??= {}
  }

  async getIdentityKeys(userId: string): Promise<{
    public_identity_key: ArrayBuffer
    public_key_exchange: ArrayBuffer
    encrypted_private_keys: ArrayBuffer
    nonce: ArrayBuffer
    salt: ArrayBuffer
    signature_private_key: ArrayBuffer | null
  } | null> {
    const record = this.state.identityKeys[userId]
    if (!record) {
      return null
    }

    const public_identity_key = base64ToArrayBuffer(record.public_identity_key)
    const public_key_exchange = base64ToArrayBuffer(record.public_key_exchange)
    const encrypted_private_keys = base64ToArrayBuffer(record.encrypted_private_keys)
    const nonce = base64ToArrayBuffer(record.nonce)
    const salt = base64ToArrayBuffer(record.salt)
    if (!public_identity_key || !public_key_exchange || !encrypted_private_keys || !nonce || !salt) {
      return null
    }

    return {
      public_identity_key,
      public_key_exchange,
      encrypted_private_keys,
      nonce,
      salt,
      signature_private_key: base64ToArrayBuffer(record.signature_private_key)
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
    this.state.identityKeys[userId] = {
      public_identity_key: bytesToBase64(publicIdentityKey),
      public_key_exchange: bytesToBase64(publicKeyExchange),
      encrypted_private_keys: bytesToBase64(encryptedPrivateKeys),
      nonce: bytesToBase64(nonce),
      salt: bytesToBase64(salt),
      signature_private_key: bytesToBase64(signaturePrivateKey ?? null)
    }
    this.persist()
  }

  async deleteIdentityKeys(userId: string): Promise<void> {
    delete this.state.identityKeys[userId]
    this.persist()
  }

  async getGroupState(groupId: string): Promise<{ state: ArrayBuffer; epoch: number } | null> {
    const record = this.state.groupStates[groupId]
    if (!record) {
      return null
    }

    const state = base64ToArrayBuffer(record.state)
    if (!state) {
      return null
    }

    return { state, epoch: record.epoch }
  }

  async setGroupState(groupId: string, state: Uint8Array, epoch: number): Promise<void> {
    this.state.groupStates[groupId] = {
      state: bytesToBase64(state),
      epoch
    }
    this.persist()
  }

  async deleteGroupState(groupId: string): Promise<void> {
    delete this.state.groupStates[groupId]
    delete this.state.groupSyncCursors[groupId]
    delete this.state.scopeMetadata[groupId]
    delete this.state.pendingGroupInfoPublishes[groupId]
    delete this.state.pendingExternalCommitBroadcasts[groupId]
    delete this.state.pendingSponsoredTransitions[groupId]
    this.persist()
  }

  async getGroupSyncCursor(groupId: string): Promise<number> {
    return this.state.groupSyncCursors[groupId] ?? 0
  }

  async setGroupSyncCursor(groupId: string, lastEventSeq: number): Promise<void> {
    this.state.groupSyncCursors[groupId] = lastEventSeq
    this.persist()
  }

  async getScopeCheckpoint(groupId: string): Promise<{
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
  }> {
    const groupState = this.state.groupStates[groupId]
    const metadata = this.state.scopeMetadata[groupId]
    const pendingGroupInfo = this.state.pendingGroupInfoPublishes[groupId]
    const pendingExternalCommit = this.state.pendingExternalCommitBroadcasts[groupId]
    const pendingSponsoredTransition = this.state.pendingSponsoredTransitions[groupId]

    return {
      group_id: groupId,
      state: base64ToArrayBuffer(groupState?.state),
      epoch: groupState?.epoch ?? 0,
      last_event_seq: this.state.groupSyncCursors[groupId] ?? 0,
      recent_commit_fingerprints: [...(metadata?.recent_commit_fingerprints ?? [])],
      recent_history_bundle_fingerprints: [
        ...(metadata?.recent_history_bundle_fingerprints ?? [])
      ],
      repair_status: metadata?.repair_status ?? null,
      repair_failure_count: metadata?.repair_failure_count ?? 0,
      repair_last_error: metadata?.repair_last_error ?? null,
      repair_updated_at: metadata?.repair_updated_at ?? null,
      pending_group_info_publish: pendingGroupInfo
        ? {
            group_info_data: base64ToArrayBuffer(pendingGroupInfo.group_info_data) as ArrayBuffer,
            ratchet_tree_data: base64ToArrayBuffer(pendingGroupInfo.ratchet_tree_data),
            epoch: pendingGroupInfo.epoch
          }
        : null,
      pending_external_commit_broadcast: pendingExternalCommit
        ? {
            commit_data: pendingExternalCommit.commit_data,
            commit_id: pendingExternalCommit.commit_id
          }
        : null,
      pending_sponsored_transition: pendingSponsoredTransition
        ? {
            recipient_id: pendingSponsoredTransition.recipient_id,
            recipient_client_id: pendingSponsoredTransition.recipient_client_id,
            recipient_key_package_ref: pendingSponsoredTransition.recipient_key_package_ref,
            commit_data: pendingSponsoredTransition.commit_data,
            commit_id: pendingSponsoredTransition.commit_id,
            remove_commit_data: pendingSponsoredTransition.remove_commit_data,
            welcome_data: pendingSponsoredTransition.welcome_data,
            group_info_data: base64ToArrayBuffer(pendingSponsoredTransition.group_info_data),
            ratchet_tree_data: base64ToArrayBuffer(pendingSponsoredTransition.ratchet_tree_data),
            epoch: pendingSponsoredTransition.epoch ?? null,
            previous_epoch: pendingSponsoredTransition.previous_epoch ?? null,
            base_state: base64ToArrayBuffer(pendingSponsoredTransition.base_state),
            base_epoch: pendingSponsoredTransition.base_epoch ?? null
          }
        : null
    }
  }

  async getKnownScopeIds(): Promise<string[]> {
    return [...new Set([
      ...Object.keys(this.state.groupStates),
      ...Object.keys(this.state.groupSyncCursors),
      ...Object.keys(this.state.scopeMetadata),
      ...Object.keys(this.state.pendingGroupInfoPublishes),
      ...Object.keys(this.state.pendingExternalCommitBroadcasts),
      ...Object.keys(this.state.pendingSponsoredTransitions)
    ])].sort()
  }

  async setScopeCheckpoint(
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
  ): Promise<void> {
    if (checkpoint.state) {
      this.state.groupStates[groupId] = {
        state: bytesToBase64(checkpoint.state),
        epoch: checkpoint.epoch
      }
    } else {
      delete this.state.groupStates[groupId]
    }

    this.state.groupSyncCursors[groupId] = Math.max(
      this.state.groupSyncCursors[groupId] ?? 0,
      checkpoint.last_event_seq
    )

    this.state.scopeMetadata[groupId] = {
      recent_commit_fingerprints: [...(checkpoint.recent_commit_fingerprints ?? [])],
      recent_history_bundle_fingerprints: [
        ...(checkpoint.recent_history_bundle_fingerprints ?? [])
      ],
      repair_status: checkpoint.repair_status ?? null,
      repair_failure_count: checkpoint.repair_failure_count ?? 0,
      repair_last_error: checkpoint.repair_last_error ?? null,
      repair_updated_at: checkpoint.repair_updated_at ?? null
    }

    if (Object.prototype.hasOwnProperty.call(checkpoint, 'pending_group_info_publish')) {
      if (checkpoint.pending_group_info_publish) {
        this.state.pendingGroupInfoPublishes[groupId] = {
          group_info_data: bytesToBase64(checkpoint.pending_group_info_publish.group_info_data),
          ratchet_tree_data: bytesToBase64(
            checkpoint.pending_group_info_publish.ratchet_tree_data
          ),
          epoch: checkpoint.pending_group_info_publish.epoch
        }
      } else {
        delete this.state.pendingGroupInfoPublishes[groupId]
      }
    }

    if (
      Object.prototype.hasOwnProperty.call(checkpoint, 'pending_external_commit_broadcast')
    ) {
      if (checkpoint.pending_external_commit_broadcast) {
        this.state.pendingExternalCommitBroadcasts[groupId] = {
          commit_data: checkpoint.pending_external_commit_broadcast.commit_data,
          commit_id: checkpoint.pending_external_commit_broadcast.commit_id
        }
      } else {
        delete this.state.pendingExternalCommitBroadcasts[groupId]
      }
    }

    if (Object.prototype.hasOwnProperty.call(checkpoint, 'pending_sponsored_transition')) {
      if (checkpoint.pending_sponsored_transition) {
        this.state.pendingSponsoredTransitions[groupId] = {
          recipient_id: checkpoint.pending_sponsored_transition.recipient_id,
          recipient_client_id: checkpoint.pending_sponsored_transition.recipient_client_id,
          recipient_key_package_ref:
            checkpoint.pending_sponsored_transition.recipient_key_package_ref,
          commit_data: checkpoint.pending_sponsored_transition.commit_data,
          commit_id: checkpoint.pending_sponsored_transition.commit_id,
          remove_commit_data: checkpoint.pending_sponsored_transition.remove_commit_data,
          welcome_data: checkpoint.pending_sponsored_transition.welcome_data,
          group_info_data: bytesToBase64(checkpoint.pending_sponsored_transition.group_info_data),
          ratchet_tree_data: bytesToBase64(
            checkpoint.pending_sponsored_transition.ratchet_tree_data
          ),
          epoch: checkpoint.pending_sponsored_transition.epoch,
          previous_epoch: checkpoint.pending_sponsored_transition.previous_epoch,
          base_state: bytesToBase64(checkpoint.pending_sponsored_transition.base_state),
          base_epoch: checkpoint.pending_sponsored_transition.base_epoch
        }
      } else {
        delete this.state.pendingSponsoredTransitions[groupId]
      }
    }

    this.persist()
  }

  async getPendingGroupInfoPublishes(): Promise<
    Array<{
      group_id: string
      group_info_data: ArrayBuffer
      ratchet_tree_data: ArrayBuffer | null
      epoch: number
    }>
  > {
    return Object.entries(this.state.pendingGroupInfoPublishes).flatMap(([group_id, record]) => {
      const group_info_data = base64ToArrayBuffer(record.group_info_data)
      if (!group_info_data) {
        return []
      }

      return [{
        group_id,
        group_info_data,
        ratchet_tree_data: base64ToArrayBuffer(record.ratchet_tree_data),
        epoch: record.epoch
      }]
    })
  }

  async setPendingGroupInfoPublish(
    groupId: string,
    groupInfoData: Uint8Array,
    ratchetTreeData: Uint8Array | null,
    epoch: number
  ): Promise<void> {
    this.state.pendingGroupInfoPublishes[groupId] = {
      group_info_data: bytesToBase64(groupInfoData),
      ratchet_tree_data: bytesToBase64(ratchetTreeData),
      epoch
    }
    this.persist()
  }

  async deletePendingGroupInfoPublish(groupId: string): Promise<void> {
    delete this.state.pendingGroupInfoPublishes[groupId]
    this.persist()
  }

  async getPendingExternalCommitBroadcasts(): Promise<
    Array<{
      group_id: string
      commit_data: string
      commit_id: string
    }>
  > {
    return Object.entries(this.state.pendingExternalCommitBroadcasts).map(([group_id, record]) => ({
      group_id,
      commit_data: record.commit_data,
      commit_id: record.commit_id
    }))
  }

  async setPendingExternalCommitBroadcast(
    groupId: string,
    commitData: string,
    commitId: string
  ): Promise<void> {
    this.state.pendingExternalCommitBroadcasts[groupId] = {
      commit_data: commitData,
      commit_id: commitId
    }
    this.persist()
  }

  async deletePendingExternalCommitBroadcast(groupId: string): Promise<void> {
    delete this.state.pendingExternalCommitBroadcasts[groupId]
    this.persist()
  }

  async getPendingSponsoredTransitions(): Promise<
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
  > {
    return Object.entries(this.state.pendingSponsoredTransitions).map(([group_id, record]) => ({
      group_id,
      recipient_id: record.recipient_id,
      recipient_client_id: record.recipient_client_id,
      recipient_key_package_ref: record.recipient_key_package_ref,
      commit_data: record.commit_data,
      commit_id: record.commit_id,
      remove_commit_data: record.remove_commit_data,
      welcome_data: record.welcome_data,
      group_info_data: base64ToArrayBuffer(record.group_info_data),
      ratchet_tree_data: base64ToArrayBuffer(record.ratchet_tree_data),
      epoch: record.epoch ?? null,
      previous_epoch: record.previous_epoch ?? null,
      base_state: base64ToArrayBuffer(record.base_state),
      base_epoch: record.base_epoch ?? null
    }))
  }

  async getLocalKeyPackages(): Promise<
    Array<{
      id: number
      key_package_ref: string | null
      key_package_public: ArrayBuffer
      key_package_private: ArrayBuffer
    }>
  > {
    return this.state.keyPackages.flatMap((record) => {
      const key_package_public = base64ToArrayBuffer(record.key_package_public)
      const key_package_private = base64ToArrayBuffer(record.key_package_private)
      if (!key_package_public || !key_package_private) {
        return []
      }
      return [{ id: record.id, key_package_ref: record.key_package_ref, key_package_public, key_package_private }]
    })
  }

  async getLocalKeyPackageByRef(keyPackageRef: string): Promise<{
    id: number
    key_package_ref: string | null
    key_package_public: ArrayBuffer
    key_package_private: ArrayBuffer
  } | null> {
    const record = this.state.keyPackages.find((entry) => entry.key_package_ref === keyPackageRef)
    if (!record) {
      return null
    }

    const key_package_public = base64ToArrayBuffer(record.key_package_public)
    const key_package_private = base64ToArrayBuffer(record.key_package_private)
    if (!key_package_public || !key_package_private) {
      return null
    }

    return { id: record.id, key_package_ref: record.key_package_ref, key_package_public, key_package_private }
  }

  async setLocalKeyPackages(
    packages: Array<{ publicData: Uint8Array; privateData: Uint8Array }>
  ): Promise<void> {
    for (const entry of packages) {
      this.state.keyPackages.push({
        id: this.state.nextKeyPackageId++,
        key_package_ref: bytesToBase64(entry.publicData),
        key_package_public: bytesToBase64(entry.publicData),
        key_package_private: bytesToBase64(entry.privateData)
      })
    }
    this.persist()
  }

  async consumeLocalKeyPackage(id: number): Promise<void> {
    this.state.keyPackages = this.state.keyPackages.filter((entry) => entry.id !== id)
    this.persist()
  }

  async countLocalKeyPackages(): Promise<number> {
    return this.state.keyPackages.length
  }

  async cacheMessage(msg: {
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
  }): Promise<void> {
    this.state.cachedMessages[msg.id] = {
      ...msg,
      ciphertext: bytesToBase64(msg.ciphertext)
    }
    this.persist()
  }

  async getCachedMessageDecryption(messageId: string): Promise<string | null> {
    return this.state.cachedDecryptions[messageId] ?? null
  }

  async setCachedMessageDecryption(messageId: string, plaintext: string): Promise<void> {
    this.state.cachedDecryptions[messageId] = plaintext
    const existing = this.state.cachedMessages[messageId]
    if (existing) {
      existing.decrypted_content = plaintext
    }
    this.persist()
  }

  async deleteCachedMessage(messageId: string): Promise<void> {
    delete this.state.cachedMessages[messageId]
    delete this.state.cachedDecryptions[messageId]
    delete this.state.searchIndex[messageId]
    this.persist()
  }

  async getCachedMessages(scopeId: string): Promise<Array<{
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
  }>> {
    return Object.values(this.state.cachedMessages)
      .filter((message) => message.channel_id === scopeId || message.conversation_id === scopeId)
      .map((message) => ({
        ...message,
        ciphertext: base64ToArrayBuffer(message.ciphertext)
      }))
  }

  async clearMessageCache(scopeId: string): Promise<void> {
    for (const [messageId, message] of Object.entries(this.state.cachedMessages)) {
      if (message.channel_id === scopeId || message.conversation_id === scopeId) {
        delete this.state.cachedMessages[messageId]
        delete this.state.cachedDecryptions[messageId]
        delete this.state.searchIndex[messageId]
      }
    }
    this.persist()
  }

  async getSentMessagePlaintext(ciphertextB64: string): Promise<string | null> {
    return this.state.sentPlaintext[ciphertextB64] ?? null
  }

  async setSentMessagePlaintext(ciphertextB64: string, plaintext: string): Promise<void> {
    this.state.sentPlaintext[ciphertextB64] = plaintext
    this.persist()
  }

  async searchMessages(query: string, channelId?: string): Promise<Array<{
    message_id: string
    channel_id: string
    conversation_id: string | null
    server_id: string | null
    sender_id: string | null
    sender_username: string | null
    inserted_at: string | null
    preview: string
  }>> {
    const needle = String(query || '').trim().toLowerCase()

    return Object.values(this.state.searchIndex).filter((record) => {
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
    const cachedMessage = this.state.cachedMessages[messageId] ?? null

    this.state.searchIndex[messageId] = {
      message_id: messageId,
      channel_id: channelId,
      conversation_id: cachedMessage?.conversation_id ?? null,
      server_id: cachedMessage?.server_id ?? null,
      sender_id: cachedMessage?.sender_id ?? null,
      sender_username: cachedMessage?.sender_username ?? null,
      inserted_at: cachedMessage?.inserted_at ?? null,
      preview: content
    }
    this.persist()
  }

  async removeFromFtsIndex(messageId: string): Promise<void> {
    delete this.state.searchIndex[messageId]
    this.persist()
  }

  private persist(): void {
    writeJson(this.filePath, this.state)
  }
}
