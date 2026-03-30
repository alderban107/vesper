/**
 * IndexedDB-backed implementation of CryptoDbApi for the web client.
 * Mirrors the SQLite storage used in Electron (see main/db.ts).
 *
 * The database is namespaced per user: `vesper-crypto-{userId}`.
 * This prevents key packages, group states, and cached messages from
 * leaking across user sessions in the same browser.
 *
 * Fixes: https://github.com/vesper-chat/vesper/issues/22
 */

const DB_NAME_PREFIX = 'vesper-crypto'
const DB_VERSION = 8

const STORES = {
  identityKeys: 'identity_keys',
  mlsGroups: 'mls_groups',
  mlsGroupSyncState: 'mls_group_sync_state',
  mlsScopeMetadata: 'mls_scope_metadata',
  mlsPendingGroupInfoPublishes: 'mls_pending_group_info_publishes',
  mlsPendingExternalCommitBroadcasts: 'mls_pending_external_commit_broadcasts',
  mlsPendingSponsoredTransitions: 'mls_pending_sponsored_transitions',
  localKeyPackages: 'local_key_packages',
  messageCache: 'message_cache',
  sentMessageCache: 'sent_message_cache'
} as const

interface LocalKeyPackageRecord {
  id: number
  consumed: number
  key_package_ref?: string | null
  key_package_public: ArrayBuffer
  key_package_private: ArrayBuffer
}

interface CachedMessageStoreRecord {
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
  ciphertext: ArrayBuffer | null
  decrypted_content: string | null
  mls_epoch: number | null
  inserted_at: string
}

function bytesToBase64(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function scopeKeyForRecord(record: {
  channel_id?: string | null
  conversation_id?: string | null
}): string | null {
  if (record.channel_id) {
    return `channel:${record.channel_id}`
  }

  if (record.conversation_id) {
    return `dm:${record.conversation_id}`
  }

  return null
}

function scopeSortKeyForRecord(record: {
  id: string
  inserted_at: string
}): string {
  return `${record.inserted_at}|${record.id}`
}

function getByScopeKey<T>(
  store: IDBObjectStore,
  scopeKey: string
): Promise<T[]> {
  const index = store.index('scope_key_sort')
  return req(
    index.getAll(IDBKeyRange.bound([scopeKey, ''], [scopeKey, '\uffff']))
  )
}

function openDb(userId: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const dbName = `${DB_NAME_PREFIX}-${userId}`
    const req = indexedDB.open(dbName, DB_VERSION)

    req.onupgradeneeded = () => {
      const db = req.result

      if (!db.objectStoreNames.contains(STORES.identityKeys)) {
        db.createObjectStore(STORES.identityKeys, { keyPath: 'user_id' })
      }

      if (!db.objectStoreNames.contains(STORES.mlsGroups)) {
        db.createObjectStore(STORES.mlsGroups, { keyPath: 'group_id' })
      }

      if (!db.objectStoreNames.contains(STORES.mlsGroupSyncState)) {
        db.createObjectStore(STORES.mlsGroupSyncState, { keyPath: 'group_id' })
      }

      if (!db.objectStoreNames.contains(STORES.mlsScopeMetadata)) {
        db.createObjectStore(STORES.mlsScopeMetadata, { keyPath: 'group_id' })
      }

      if (!db.objectStoreNames.contains(STORES.mlsPendingGroupInfoPublishes)) {
        db.createObjectStore(STORES.mlsPendingGroupInfoPublishes, { keyPath: 'group_id' })
      }

      if (!db.objectStoreNames.contains(STORES.mlsPendingExternalCommitBroadcasts)) {
        db.createObjectStore(STORES.mlsPendingExternalCommitBroadcasts, { keyPath: 'group_id' })
      }

      if (!db.objectStoreNames.contains(STORES.mlsPendingSponsoredTransitions)) {
        db.createObjectStore(STORES.mlsPendingSponsoredTransitions, { keyPath: 'group_id' })
      }

      if (!db.objectStoreNames.contains(STORES.localKeyPackages)) {
        const store = db.createObjectStore(STORES.localKeyPackages, {
          keyPath: 'id',
          autoIncrement: true
        })
        store.createIndex('consumed', 'consumed', { unique: false })
        store.createIndex('key_package_ref', 'key_package_ref', { unique: false })
      } else {
        const store = req.transaction!.objectStore(STORES.localKeyPackages)
        if (!store.indexNames.contains('consumed')) {
          store.createIndex('consumed', 'consumed', { unique: false })
        }
        if (!store.indexNames.contains('key_package_ref')) {
          store.createIndex('key_package_ref', 'key_package_ref', { unique: false })
        }
      }

      if (!db.objectStoreNames.contains(STORES.messageCache)) {
        const msgStore = db.createObjectStore(STORES.messageCache, { keyPath: 'id' })
        msgStore.createIndex('channel_id', 'channel_id', { unique: false })
        msgStore.createIndex('conversation_id', 'conversation_id', { unique: false })
        msgStore.createIndex('scope_key_sort', ['scope_key', 'scope_sort'], { unique: false })
      } else {
        const store = req.transaction!.objectStore(STORES.messageCache)
        if (!store.indexNames.contains('channel_id')) {
          store.createIndex('channel_id', 'channel_id', { unique: false })
        }
        if (!store.indexNames.contains('conversation_id')) {
          store.createIndex('conversation_id', 'conversation_id', { unique: false })
        }
        if (!store.indexNames.contains('scope_key_sort')) {
          store.createIndex('scope_key_sort', ['scope_key', 'scope_sort'], {
            unique: false
          })
        }
      }

      if (!db.objectStoreNames.contains(STORES.sentMessageCache)) {
        db.createObjectStore(STORES.sentMessageCache, { keyPath: 'ciphertext_b64' })
      }
    }

    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode
): IDBObjectStore {
  return db.transaction(store, mode).objectStore(store)
}

function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function txComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}

function getAllByIndex<T>(
  store: IDBObjectStore,
  indexName: string,
  value: IDBValidKey
): Promise<T[]> {
  return req(store.index(indexName).getAll(IDBKeyRange.only(value)))
}

export function createIndexedDbAdapter(userId: string): CryptoDbApi & {
  searchMessages: (query: string) => Promise<
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
} {
  let dbPromise: Promise<IDBDatabase> | null = null

  function getDb(): Promise<IDBDatabase> {
    if (!dbPromise) {
      dbPromise = openDb(userId)
    }
    return dbPromise
  }

  return {
    // --- Identity Keys ---

    async getIdentityKeys(userId: string) {
      const db = await getDb()
      const result = await req(tx(db, STORES.identityKeys, 'readonly').get(userId))
      if (!result) return null
      return {
        public_identity_key: result.public_identity_key,
        public_key_exchange: result.public_key_exchange,
        encrypted_private_keys: result.encrypted_private_keys,
        nonce: result.nonce,
        salt: result.salt,
        signature_private_key: result.signature_private_key ?? null
      }
    },

    async setIdentityKeys(
      userId: string,
      publicIdentityKey: Uint8Array,
      publicKeyExchange: Uint8Array,
      encryptedPrivateKeys: Uint8Array,
      nonce: Uint8Array,
      salt: Uint8Array,
      signaturePrivateKey?: Uint8Array | null
    ) {
      const db = await getDb()
      await req(
        tx(db, STORES.identityKeys, 'readwrite').put({
          user_id: userId,
          public_identity_key: publicIdentityKey,
          public_key_exchange: publicKeyExchange,
          encrypted_private_keys: encryptedPrivateKeys,
          nonce: nonce,
          salt: salt,
          signature_private_key: signaturePrivateKey ?? null
        })
      )
    },

    async deleteIdentityKeys(userId: string) {
      const db = await getDb()
      await req(tx(db, STORES.identityKeys, 'readwrite').delete(userId))
    },

    // --- MLS Groups ---

    async getGroupState(groupId: string) {
      const db = await getDb()
      const result = await req(tx(db, STORES.mlsGroups, 'readonly').get(groupId))
      if (!result) return null
      return {
        state: result.state,
        epoch: result.epoch
      }
    },

    async setGroupState(groupId: string, state: Uint8Array, epoch: number) {
      const db = await getDb()
      await req(
        tx(db, STORES.mlsGroups, 'readwrite').put({
          group_id: groupId,
          state: state,
          epoch: epoch
        })
      )
    },

    async deleteGroupState(groupId: string) {
      const db = await getDb()
      await req(tx(db, STORES.mlsGroups, 'readwrite').delete(groupId))
      // NOTE: intentionally NOT deleting mlsGroupSyncState (cursor).
      // The cursor tracks which durable events have been seen — it must
      // survive group reset to prevent replaying stale mls_remove events
      // that would re-delete the group in an infinite loop.
      await req(tx(db, STORES.mlsScopeMetadata, 'readwrite').delete(groupId))
      await req(tx(db, STORES.mlsPendingGroupInfoPublishes, 'readwrite').delete(groupId))
      await req(tx(db, STORES.mlsPendingExternalCommitBroadcasts, 'readwrite').delete(groupId))
      await req(tx(db, STORES.mlsPendingSponsoredTransitions, 'readwrite').delete(groupId))
    },

    async getGroupSyncCursor(groupId: string) {
      const db = await getDb()
      const result = await req(tx(db, STORES.mlsGroupSyncState, 'readonly').get(groupId))
      return result?.last_event_seq ?? 0
    },

    async setGroupSyncCursor(groupId: string, lastEventSeq: number) {
      const db = await getDb()
      const store = tx(db, STORES.mlsGroupSyncState, 'readwrite')
      const existing = await req(store.get(groupId))
      await req(
        store.put({
          group_id: groupId,
          last_event_seq: Math.max(existing?.last_event_seq ?? 0, lastEventSeq)
        })
      )
    },

    async getScopeCheckpoint(groupId: string) {
      const db = await getDb()
      const transaction = db.transaction(
        [
          STORES.mlsGroups,
          STORES.mlsGroupSyncState,
          STORES.mlsScopeMetadata,
          STORES.mlsPendingGroupInfoPublishes,
          STORES.mlsPendingExternalCommitBroadcasts,
          STORES.mlsPendingSponsoredTransitions
        ],
        'readonly'
      )
      const groupStateStore = transaction.objectStore(STORES.mlsGroups)
      const syncStateStore = transaction.objectStore(STORES.mlsGroupSyncState)
      const metadataStore = transaction.objectStore(STORES.mlsScopeMetadata)
      const groupInfoStore = transaction.objectStore(STORES.mlsPendingGroupInfoPublishes)
      const externalCommitStore = transaction.objectStore(STORES.mlsPendingExternalCommitBroadcasts)
      const sponsoredTransitionStore = transaction.objectStore(
        STORES.mlsPendingSponsoredTransitions
      )

      const [
        groupState,
        syncState,
        metadata,
        pendingGroupInfo,
        pendingExternalCommit,
        pendingSponsoredTransition
      ] =
        await Promise.all([
          req(groupStateStore.get(groupId)),
          req(syncStateStore.get(groupId)),
          req(metadataStore.get(groupId)),
          req(groupInfoStore.get(groupId)),
          req(externalCommitStore.get(groupId)),
          req(sponsoredTransitionStore.get(groupId))
        ])
      await txComplete(transaction)

      return {
        group_id: groupId,
        state: groupState?.state ?? null,
        epoch: groupState?.epoch ?? 0,
        last_event_seq: syncState?.last_event_seq ?? 0,
        recent_commit_fingerprints: Array.isArray(metadata?.recent_commit_fingerprints)
          ? metadata.recent_commit_fingerprints.filter(
              (value: unknown): value is string => typeof value === 'string'
            )
          : [],
        recent_history_bundle_fingerprints: Array.isArray(
          metadata?.recent_history_bundle_fingerprints
        )
          ? metadata.recent_history_bundle_fingerprints.filter(
              (value: unknown): value is string => typeof value === 'string'
            )
          : [],
        repair_status:
          typeof metadata?.repair_status === 'string' ? metadata.repair_status : null,
        repair_failure_count:
          typeof metadata?.repair_failure_count === 'number' ? metadata.repair_failure_count : 0,
        repair_last_error:
          typeof metadata?.repair_last_error === 'string' ? metadata.repair_last_error : null,
        repair_updated_at:
          typeof metadata?.repair_updated_at === 'string' ? metadata.repair_updated_at : null,
        pending_group_info_publish: pendingGroupInfo
          ? {
              group_info_data: pendingGroupInfo.group_info_data,
              ratchet_tree_data: pendingGroupInfo.ratchet_tree_data ?? null,
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
              recipient_client_id: pendingSponsoredTransition.recipient_client_id ?? null,
              recipient_key_package_ref:
                pendingSponsoredTransition.recipient_key_package_ref ?? null,
              commit_data: pendingSponsoredTransition.commit_data,
              commit_id: pendingSponsoredTransition.commit_id,
              remove_commit_data: pendingSponsoredTransition.remove_commit_data ?? null,
              welcome_data: pendingSponsoredTransition.welcome_data ?? null,
              group_info_data: pendingSponsoredTransition.group_info_data ?? null,
              ratchet_tree_data: pendingSponsoredTransition.ratchet_tree_data ?? null,
              epoch: pendingSponsoredTransition.epoch ?? null,
              previous_epoch: pendingSponsoredTransition.previous_epoch ?? null,
              base_state: pendingSponsoredTransition.base_state ?? null,
              base_epoch: pendingSponsoredTransition.base_epoch ?? null
            }
          : null
      }
    },

    async getKnownScopeIds() {
      const db = await getDb()
      const transaction = db.transaction(
        [
          STORES.mlsGroups,
          STORES.mlsGroupSyncState,
          STORES.mlsScopeMetadata,
          STORES.mlsPendingGroupInfoPublishes,
          STORES.mlsPendingExternalCommitBroadcasts,
          STORES.mlsPendingSponsoredTransitions
        ],
        'readonly'
      )
      const stores = [
        transaction.objectStore(STORES.mlsGroups),
        transaction.objectStore(STORES.mlsGroupSyncState),
        transaction.objectStore(STORES.mlsScopeMetadata),
        transaction.objectStore(STORES.mlsPendingGroupInfoPublishes),
        transaction.objectStore(STORES.mlsPendingExternalCommitBroadcasts),
        transaction.objectStore(STORES.mlsPendingSponsoredTransitions)
      ]

      const keys = await Promise.all(stores.map((store) => req(store.getAllKeys())))
      await txComplete(transaction)

      return [...new Set(keys.flat().filter((key): key is string => typeof key === 'string'))].sort()
    },

    async setScopeCheckpoint(groupId: string, checkpoint) {
      const db = await getDb()
      const transaction = db.transaction(
        [
          STORES.mlsGroups,
          STORES.mlsGroupSyncState,
          STORES.mlsScopeMetadata,
          STORES.mlsPendingGroupInfoPublishes,
          STORES.mlsPendingExternalCommitBroadcasts,
          STORES.mlsPendingSponsoredTransitions
        ],
        'readwrite'
      )
      const groupStateStore = transaction.objectStore(STORES.mlsGroups)
      const syncStateStore = transaction.objectStore(STORES.mlsGroupSyncState)
      const metadataStore = transaction.objectStore(STORES.mlsScopeMetadata)
      const groupInfoStore = transaction.objectStore(STORES.mlsPendingGroupInfoPublishes)
      const externalCommitStore = transaction.objectStore(STORES.mlsPendingExternalCommitBroadcasts)
      const sponsoredTransitionStore = transaction.objectStore(
        STORES.mlsPendingSponsoredTransitions
      )

      const existingSyncState = await req(syncStateStore.get(groupId))
      const nextSeq = Math.max(existingSyncState?.last_event_seq ?? 0, checkpoint.last_event_seq)

      if (checkpoint.state) {
        await req(
          groupStateStore.put({
            group_id: groupId,
            state: checkpoint.state,
            epoch: checkpoint.epoch
          })
        )
      } else {
        await req(groupStateStore.delete(groupId))
      }

      await req(
        syncStateStore.put({
          group_id: groupId,
          last_event_seq: nextSeq
        })
      )

      await req(
        metadataStore.put({
          group_id: groupId,
          recent_commit_fingerprints: checkpoint.recent_commit_fingerprints ?? [],
          recent_history_bundle_fingerprints:
            checkpoint.recent_history_bundle_fingerprints ?? [],
          repair_status: checkpoint.repair_status ?? null,
          repair_failure_count: checkpoint.repair_failure_count ?? 0,
          repair_last_error: checkpoint.repair_last_error ?? null,
          repair_updated_at: checkpoint.repair_updated_at ?? null
        })
      )

      if (Object.prototype.hasOwnProperty.call(checkpoint, 'pending_group_info_publish')) {
        if (checkpoint.pending_group_info_publish) {
          await req(
            groupInfoStore.put({
              group_id: groupId,
              group_info_data: checkpoint.pending_group_info_publish.group_info_data,
              ratchet_tree_data: checkpoint.pending_group_info_publish.ratchet_tree_data,
              epoch: checkpoint.pending_group_info_publish.epoch
            })
          )
        } else {
          await req(groupInfoStore.delete(groupId))
        }
      }

      if (
        Object.prototype.hasOwnProperty.call(checkpoint, 'pending_external_commit_broadcast')
      ) {
        if (checkpoint.pending_external_commit_broadcast) {
          await req(
            externalCommitStore.put({
              group_id: groupId,
              commit_data: checkpoint.pending_external_commit_broadcast.commit_data,
              commit_id: checkpoint.pending_external_commit_broadcast.commit_id
            })
          )
        } else {
          await req(externalCommitStore.delete(groupId))
        }
      }

      if (Object.prototype.hasOwnProperty.call(checkpoint, 'pending_sponsored_transition')) {
        if (checkpoint.pending_sponsored_transition) {
          await req(
            sponsoredTransitionStore.put({
              group_id: groupId,
              recipient_id: checkpoint.pending_sponsored_transition.recipient_id,
              recipient_client_id: checkpoint.pending_sponsored_transition.recipient_client_id,
              recipient_key_package_ref:
                checkpoint.pending_sponsored_transition.recipient_key_package_ref,
              commit_data: checkpoint.pending_sponsored_transition.commit_data,
              commit_id: checkpoint.pending_sponsored_transition.commit_id,
              remove_commit_data: checkpoint.pending_sponsored_transition.remove_commit_data,
              welcome_data: checkpoint.pending_sponsored_transition.welcome_data,
              group_info_data: checkpoint.pending_sponsored_transition.group_info_data,
              ratchet_tree_data: checkpoint.pending_sponsored_transition.ratchet_tree_data,
              epoch: checkpoint.pending_sponsored_transition.epoch,
              previous_epoch: checkpoint.pending_sponsored_transition.previous_epoch,
              base_state: checkpoint.pending_sponsored_transition.base_state,
              base_epoch: checkpoint.pending_sponsored_transition.base_epoch
            })
          )
        } else {
          await req(sponsoredTransitionStore.delete(groupId))
        }
      }

      await txComplete(transaction)
    },

    async getPendingGroupInfoPublishes() {
      const db = await getDb()
      return await req(tx(db, STORES.mlsPendingGroupInfoPublishes, 'readonly').getAll())
    },

    async setPendingGroupInfoPublish(
      groupId: string,
      groupInfoData: Uint8Array,
      ratchetTreeData: Uint8Array | null,
      epoch: number
    ) {
      const db = await getDb()
      await req(
        tx(db, STORES.mlsPendingGroupInfoPublishes, 'readwrite').put({
          group_id: groupId,
          group_info_data: groupInfoData,
          ratchet_tree_data: ratchetTreeData,
          epoch: epoch
        })
      )
    },

    async deletePendingGroupInfoPublish(groupId: string) {
      const db = await getDb()
      await req(tx(db, STORES.mlsPendingGroupInfoPublishes, 'readwrite').delete(groupId))
    },

    async getPendingExternalCommitBroadcasts() {
      const db = await getDb()
      return await req(tx(db, STORES.mlsPendingExternalCommitBroadcasts, 'readonly').getAll())
    },

    async getPendingSponsoredTransitions() {
      const db = await getDb()
      return await req(tx(db, STORES.mlsPendingSponsoredTransitions, 'readonly').getAll())
    },

    async setPendingExternalCommitBroadcast(groupId: string, commitData: string, commitId: string) {
      const db = await getDb()
      await req(
        tx(db, STORES.mlsPendingExternalCommitBroadcasts, 'readwrite').put({
          group_id: groupId,
          commit_data: commitData,
          commit_id: commitId
        })
      )
    },

    async deletePendingExternalCommitBroadcast(groupId: string) {
      const db = await getDb()
      await req(tx(db, STORES.mlsPendingExternalCommitBroadcasts, 'readwrite').delete(groupId))
    },

    // --- Key Packages ---

    async getLocalKeyPackages() {
      const db = await getDb()
      const store = tx(db, STORES.localKeyPackages, 'readonly')
      const all = await getAllByIndex<LocalKeyPackageRecord>(store, 'consumed', 0)
      return all.map((pkg) => ({
        id: pkg.id,
        key_package_ref: pkg.key_package_ref ?? null,
        key_package_public: pkg.key_package_public,
        key_package_private: pkg.key_package_private
      }))
    },

    async getLocalKeyPackageByRef(keyPackageRef: string) {
      const db = await getDb()
      const store = tx(db, STORES.localKeyPackages, 'readonly')
      const result = await req<LocalKeyPackageRecord | undefined>(
        store.index('key_package_ref').get(keyPackageRef)
      )
      if (!result || result.consumed !== 0) {
        return null
      }

      return {
        id: result.id,
        key_package_ref: result.key_package_ref ?? null,
        key_package_public: result.key_package_public,
        key_package_private: result.key_package_private
      }
    },

    async setLocalKeyPackages(
      packages: Array<{ publicData: Uint8Array; privateData: Uint8Array }>
    ) {
      const db = await getDb()
      const transaction = db.transaction(STORES.localKeyPackages, 'readwrite')
      const store = transaction.objectStore(STORES.localKeyPackages)
      for (const pkg of packages) {
        store.add({
          key_package_ref: bytesToBase64(pkg.publicData),
          key_package_public: pkg.publicData,
          key_package_private: pkg.privateData,
          consumed: 0
        })
      }
      await txComplete(transaction)
    },

    async consumeLocalKeyPackage(id: number) {
      const db = await getDb()
      const store = tx(db, STORES.localKeyPackages, 'readwrite')
      const existing = await req(store.get(id))
      if (existing) {
        existing.consumed = 1
        await req(store.put(existing))
      }
    },

    async countLocalKeyPackages() {
      const db = await getDb()
      return await req(
        tx(db, STORES.localKeyPackages, 'readonly').index('consumed').count(IDBKeyRange.only(0))
      )
    },

    // --- Message Cache (stores ciphertext, not plaintext) ---

    async cacheMessage(msg: {
      id: string
      room_seq: number | null
      channel_id: string | null
      conversation_id: string | null
      server_id: string | null
      sender_id: string | null
      sender_username: string | null
      parent_message_id: string | null
      is_reply: boolean
      ciphertext: Uint8Array | null
      decrypted_content: string | null
      mls_epoch: number | null
      inserted_at: string
    }) {
      const db = await getDb()
      const store = tx(db, STORES.messageCache, 'readwrite')
      const existing = await req(store.get(msg.id))

      await req(
        store.put({
          ...existing,
          ...msg,
          channel_id: msg.channel_id ?? existing?.channel_id ?? null,
          conversation_id: msg.conversation_id ?? existing?.conversation_id ?? null,
          scope_key:
            scopeKeyForRecord(msg) ?? scopeKeyForRecord(existing ?? {}) ?? null,
          scope_sort: scopeSortKeyForRecord(msg),
          server_id: msg.server_id ?? existing?.server_id ?? null,
          sender_id: msg.sender_id ?? existing?.sender_id ?? null,
          sender_username: msg.sender_username ?? existing?.sender_username ?? null,
          parent_message_id: msg.parent_message_id ?? existing?.parent_message_id ?? null,
          thread_root_message_id:
            msg.thread_root_message_id ?? existing?.thread_root_message_id ?? null,
          reply_to_message_id:
            msg.reply_to_message_id ?? existing?.reply_to_message_id ?? null,
          is_reply: msg.is_reply,
          ciphertext: msg.ciphertext ?? existing?.ciphertext ?? null,
          decrypted_content: msg.decrypted_content ?? existing?.decrypted_content ?? null,
          mls_epoch: msg.mls_epoch ?? existing?.mls_epoch ?? null
        })
      )
    },

    async getCachedMessageDecryption(messageId: string) {
      const db = await getDb()
      const result = await req(tx(db, STORES.messageCache, 'readonly').get(messageId))
      return result?.decrypted_content ?? null
    },

    async setCachedMessageDecryption(messageId: string, plaintext: string) {
      const db = await getDb()
      const store = tx(db, STORES.messageCache, 'readwrite')
      const existing = await req(store.get(messageId))
      if (!existing) {
        return
      }

      existing.decrypted_content = plaintext
      await req(store.put(existing))
    },

    async deleteCachedMessage(messageId: string) {
      const db = await getDb()
      const transaction = db.transaction(STORES.messageCache, 'readwrite')
      transaction.objectStore(STORES.messageCache).delete(messageId)
      await txComplete(transaction)
    },

    async getCachedMessages(scopeId: string) {
      const db = await getDb()
      const store = tx(db, STORES.messageCache, 'readonly')
      const [channelResults, conversationResults] = await Promise.all([
        getByScopeKey<CachedMessageStoreRecord>(store, `channel:${scopeId}`),
        getByScopeKey<CachedMessageStoreRecord>(store, `dm:${scopeId}`)
      ])
      const results = [...channelResults, ...conversationResults]
      const deduped = [
        ...new Map(results.map((message) => [message.id, message])).values()
      ]
      return deduped.sort(
        (a, b) => a.inserted_at.localeCompare(b.inserted_at)
      )
    },

    async clearMessageCache(scopeId: string) {
      const db = await getDb()
      const transaction = db.transaction(STORES.messageCache, 'readwrite')
      const store = transaction.objectStore(STORES.messageCache)
      const [channelResults, conversationResults] = await Promise.all([
        getByScopeKey<CachedMessageStoreRecord>(store, `channel:${scopeId}`),
        getByScopeKey<CachedMessageStoreRecord>(store, `dm:${scopeId}`)
      ])
      const keys = new Set(
        [...channelResults, ...conversationResults].map((message) => message.id)
      )
      for (const key of keys) {
        store.delete(key)
      }
      await txComplete(transaction)
    },

    async getSentMessagePlaintext(ciphertextB64: string) {
      const db = await getDb()
      const result = await req(
        tx(db, STORES.sentMessageCache, 'readonly').get(ciphertextB64)
      )
      return result?.plaintext ?? null
    },

    async setSentMessagePlaintext(ciphertextB64: string, plaintext: string) {
      const db = await getDb()
      await req(
        tx(db, STORES.sentMessageCache, 'readwrite').put({
          ciphertext_b64: ciphertextB64,
          plaintext,
          inserted_at: new Date().toISOString()
        })
      )
    },

    // --- FTS5 Search ---
    // IndexedDB fallback does not support FTS5. These are stubs.
    // Full-text search is only available in the Electron build (SQLite).

    async searchMessages(_query: string, _channelId?: string) {
      return []
    },

    async indexDecryptedMessage(
      _messageId: string,
      _channelId: string,
      _content: string
    ) {
      // no-op in web fallback
    },

    async removeFromFtsIndex(_messageId: string) {
      // no-op in web fallback
    }
  }
}
