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
const DB_VERSION = 11

const STORES = {
  identityKeys: 'identity_keys',
  recoveryPackageKeys: 'recovery_package_keys',
  workspaceSnapshots: 'workspace_snapshots',
  mlsGroups: 'mls_groups',
  mlsGroupSyncState: 'mls_group_sync_state',
  mlsScopeMetadata: 'mls_scope_metadata',
  mlsPendingGroupInfoPublishes: 'mls_pending_group_info_publishes',
  mlsPendingExternalCommitBroadcasts: 'mls_pending_external_commit_broadcasts',
  mlsPendingSponsoredTransitions: 'mls_pending_sponsored_transitions',
  localKeyPackages: 'local_key_packages',
  messageCache: 'message_cache',
  sentMessageCache: 'sent_message_cache',
  pendingMessageSends: 'pending_message_sends'
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

      if (!db.objectStoreNames.contains(STORES.recoveryPackageKeys)) {
        db.createObjectStore(STORES.recoveryPackageKeys, { keyPath: 'user_id' })
      }

      if (!db.objectStoreNames.contains(STORES.workspaceSnapshots)) {
        db.createObjectStore(STORES.workspaceSnapshots, { keyPath: 'user_id' })
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

      if (!db.objectStoreNames.contains(STORES.pendingMessageSends)) {
        db.createObjectStore(STORES.pendingMessageSends, { keyPath: 'client_nonce' })
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

async function migrateLegacyControlStores(db: IDBDatabase): Promise<IDBDatabase> {
  const transaction = db.transaction(
    [
      STORES.mlsScopeMetadata,
      STORES.mlsPendingGroupInfoPublishes,
      STORES.mlsPendingExternalCommitBroadcasts,
      STORES.mlsPendingSponsoredTransitions
    ],
    'readwrite'
  )
  const metadataStore = transaction.objectStore(STORES.mlsScopeMetadata)
  const groupInfoStore = transaction.objectStore(STORES.mlsPendingGroupInfoPublishes)
  const externalCommitStore = transaction.objectStore(
    STORES.mlsPendingExternalCommitBroadcasts
  )
  const sponsoredStore = transaction.objectStore(STORES.mlsPendingSponsoredTransitions)
  const [groupInfos, externalCommits, sponsoredTransitions] = await Promise.all([
    req<any[]>(groupInfoStore.getAll()),
    req<any[]>(externalCommitStore.getAll()),
    req<any[]>(sponsoredStore.getAll())
  ])

  if (
    groupInfos.length === 0 &&
    externalCommits.length === 0 &&
    sponsoredTransitions.length === 0
  ) {
    await txComplete(transaction)
    return db
  }

  const now = new Date().toISOString()
  const intentsByScope = new Map<string, ControlIntentStorageRecord[]>()
  const append = (scopeId: string, intent: ControlIntentStorageRecord): void => {
    intentsByScope.set(scopeId, [...(intentsByScope.get(scopeId) ?? []), intent])
  }
  const createIntent = (
    operation: string,
    scopeId: string,
    idempotencyKey: string,
    membershipGeneration: number,
    payload: unknown
  ): ControlIntentStorageRecord => ({
    version: 1,
    operation,
    idempotency_key: idempotencyKey,
    scope_id: scopeId,
    membership_generation: membershipGeneration,
    payload_json: JSON.stringify(payload),
    attempts: 0,
    state: 'pending',
    result_json: null,
    created_at: now,
    updated_at: now
  })

  for (const pending of groupInfos) {
    append(
      pending.group_id,
      createIntent(
        'group_info_publish',
        pending.group_id,
        `group-info:${pending.epoch}`,
        pending.epoch,
        {
          groupInfoData: bytesToBase64(new Uint8Array(pending.group_info_data)),
          ratchetTreeData: pending.ratchet_tree_data
            ? bytesToBase64(new Uint8Array(pending.ratchet_tree_data))
            : null,
          epoch: pending.epoch
        }
      )
    )
  }

  for (const pending of externalCommits) {
    append(
      pending.group_id,
      createIntent(
        'external_commit_broadcast',
        pending.group_id,
        pending.commit_id,
        0,
        { commitData: pending.commit_data, commitId: pending.commit_id }
      )
    )
  }

  for (const pending of sponsoredTransitions) {
    append(
      pending.group_id,
      createIntent(
        'sponsored_transition',
        pending.group_id,
        pending.commit_id,
        pending.epoch ?? 0,
        {
          recipientId: pending.recipient_id,
          recipientClientId: pending.recipient_client_id ?? null,
          recipientKeyPackageRef: pending.recipient_key_package_ref ?? null,
          commitData: pending.commit_data,
          commitId: pending.commit_id,
          removeCommitData: pending.remove_commit_data ?? null,
          welcomeData: pending.welcome_data ?? null,
          groupInfoData: pending.group_info_data
            ? bytesToBase64(new Uint8Array(pending.group_info_data))
            : null,
          ratchetTreeData: pending.ratchet_tree_data
            ? bytesToBase64(new Uint8Array(pending.ratchet_tree_data))
            : null,
          epoch: pending.epoch ?? null,
          previousEpoch: pending.previous_epoch ?? null,
          baseState: pending.base_state
            ? bytesToBase64(new Uint8Array(pending.base_state))
            : null,
          baseEpoch: pending.base_epoch ?? null
        }
      )
    )
  }

  for (const [scopeId, intents] of intentsByScope) {
    const existing = await req<any>(metadataStore.get(scopeId))
    await req(
      metadataStore.put({
        group_id: scopeId,
        recent_commit_fingerprints: existing?.recent_commit_fingerprints ?? [],
        recent_history_bundle_fingerprints:
          existing?.recent_history_bundle_fingerprints ?? [],
        repair_status: existing?.repair_status ?? null,
        repair_failure_count: existing?.repair_failure_count ?? 0,
        repair_last_error: existing?.repair_last_error ?? null,
        repair_updated_at: existing?.repair_updated_at ?? null,
        control_intents: [...(existing?.control_intents ?? []), ...intents]
      })
    )
  }

  await Promise.all([
    req(groupInfoStore.clear()),
    req(externalCommitStore.clear()),
    req(sponsoredStore.clear())
  ])
  await txComplete(transaction)
  return db
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
      dbPromise = openDb(userId).then(migrateLegacyControlStores)
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
      const transaction = db.transaction(
        [STORES.identityKeys, STORES.recoveryPackageKeys, STORES.workspaceSnapshots],
        'readwrite'
      )
      transaction.objectStore(STORES.identityKeys).delete(userId)
      transaction.objectStore(STORES.recoveryPackageKeys).delete(userId)
      transaction.objectStore(STORES.workspaceSnapshots).delete(userId)
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
    },

    async getWorkspaceSnapshot(userId: string) {
      const db = await getDb()
      const result = await req(tx(db, STORES.workspaceSnapshots, 'readonly').get(userId))
      if (!result) return null
      return {
        version: result.version,
        token: result.token ?? null,
        servers_json: result.servers_json,
        conversations_json: result.conversations_json,
        unread_counts_json: result.unread_counts_json,
        updated_at: result.updated_at
      }
    },

    async setWorkspaceSnapshot(
      userId: string,
      snapshot: {
        version: number
        token: string | null
        servers_json: string
        conversations_json: string
        unread_counts_json: string
        updated_at: string
      }
    ) {
      const db = await getDb()
      await req(
        tx(db, STORES.workspaceSnapshots, 'readwrite').put({
          user_id: userId,
          ...snapshot
        })
      )
    },

    async getRecoveryPackageKey(userId: string) {
      const db = await getDb()
      const result = await req(tx(db, STORES.recoveryPackageKeys, 'readonly').get(userId))
      return result?.key ?? null
    },

    async setRecoveryPackageKey(userId: string, key: Uint8Array) {
      const db = await getDb()
      await req(
        tx(db, STORES.recoveryPackageKeys, 'readwrite').put({
          user_id: userId,
          key: new Uint8Array(key)
        })
      )
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
        [STORES.mlsGroups, STORES.mlsGroupSyncState, STORES.mlsScopeMetadata],
        'readonly'
      )
      const groupStateStore = transaction.objectStore(STORES.mlsGroups)
      const syncStateStore = transaction.objectStore(STORES.mlsGroupSyncState)
      const metadataStore = transaction.objectStore(STORES.mlsScopeMetadata)

      const [groupState, syncState, metadata] = await Promise.all([
        req(groupStateStore.get(groupId)),
        req(syncStateStore.get(groupId)),
        req(metadataStore.get(groupId))
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
        room_data_keys: Array.isArray(metadata?.room_data_keys)
          ? metadata.room_data_keys
          : [],
        control_intents: Array.isArray(metadata?.control_intents)
          ? metadata.control_intents
          : []
      }
    },

    async getKnownScopeIds() {
      const db = await getDb()
      const transaction = db.transaction(
        [STORES.mlsGroups, STORES.mlsGroupSyncState, STORES.mlsScopeMetadata],
        'readonly'
      )
      const stores = [
        transaction.objectStore(STORES.mlsGroups),
        transaction.objectStore(STORES.mlsGroupSyncState),
        transaction.objectStore(STORES.mlsScopeMetadata)
      ]

      const keys = await Promise.all(stores.map((store) => req(store.getAllKeys())))
      await txComplete(transaction)

      return [...new Set(keys.flat().filter((key): key is string => typeof key === 'string'))].sort()
    },

    async setScopeCheckpoint(groupId: string, checkpoint) {
      const db = await getDb()
      const transaction = db.transaction(
        [STORES.mlsGroups, STORES.mlsGroupSyncState, STORES.mlsScopeMetadata],
        'readwrite'
      )
      const groupStateStore = transaction.objectStore(STORES.mlsGroups)
      const syncStateStore = transaction.objectStore(STORES.mlsGroupSyncState)
      const metadataStore = transaction.objectStore(STORES.mlsScopeMetadata)

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
          repair_updated_at: checkpoint.repair_updated_at ?? null,
          room_data_keys: checkpoint.room_data_keys ?? [],
          control_intents: checkpoint.control_intents ?? []
        })
      )

      await txComplete(transaction)
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
      thread_root_message_id: string | null
      reply_to_message_id: string | null
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
    },

    // --- Pending message send outbox ---

    async getPendingMessageSends() {
      const db = await getDb()
      const results = await req(
        tx(db, STORES.pendingMessageSends, 'readonly').getAll()
      )
      return [...results].sort((left, right) =>
        left.inserted_at.localeCompare(right.inserted_at)
      )
    },

    async setPendingMessageSend(entry: {
      client_nonce: string
      scope_kind: 'channel' | 'dm'
      scope_id: string
      scope_channel_id: string | null
      payload_json: string
      inserted_at: string
    }) {
      const db = await getDb()
      await req(tx(db, STORES.pendingMessageSends, 'readwrite').put(entry))
    },

    async deletePendingMessageSend(clientNonce: string) {
      const db = await getDb()
      await req(tx(db, STORES.pendingMessageSends, 'readwrite').delete(clientNonce))
    }
  }
}
