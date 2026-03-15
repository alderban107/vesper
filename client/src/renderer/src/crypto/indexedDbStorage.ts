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
const DB_VERSION = 1

const STORES = {
  identityKeys: 'identity_keys',
  mlsGroups: 'mls_groups',
  localKeyPackages: 'local_key_packages',
  messageCache: 'message_cache'
} as const

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

      if (!db.objectStoreNames.contains(STORES.localKeyPackages)) {
        db.createObjectStore(STORES.localKeyPackages, {
          keyPath: 'id',
          autoIncrement: true
        })
      }

      if (!db.objectStoreNames.contains(STORES.messageCache)) {
        const msgStore = db.createObjectStore(STORES.messageCache, { keyPath: 'id' })
        msgStore.createIndex('channel_id', 'channel_id', { unique: false })
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
    },

    // --- Key Packages ---

    async getLocalKeyPackages() {
      const db = await getDb()
      const all = await req(tx(db, STORES.localKeyPackages, 'readonly').getAll())
      return all
        .filter((pkg: { consumed: number }) => !pkg.consumed)
        .map((pkg: { id: number; key_package_public: Uint8Array; key_package_private: Uint8Array }) => ({
          id: pkg.id,
          key_package_public: pkg.key_package_public,
          key_package_private: pkg.key_package_private
        }))
    },

    async setLocalKeyPackages(
      packages: Array<{ publicData: Uint8Array; privateData: Uint8Array }>
    ) {
      const db = await getDb()
      const transaction = db.transaction(STORES.localKeyPackages, 'readwrite')
      const store = transaction.objectStore(STORES.localKeyPackages)
      for (const pkg of packages) {
        store.add({
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
      const all = await req(tx(db, STORES.localKeyPackages, 'readonly').getAll())
      return all.filter((pkg: { consumed: number }) => !pkg.consumed).length
    },

    // --- Message Cache (stores ciphertext, not plaintext) ---

    async cacheMessage(msg: {
      id: string
      channel_id: string | null
      conversation_id: string | null
      server_id: string | null
      sender_id: string | null
      sender_username: string | null
      ciphertext: Uint8Array | null
      mls_epoch: number | null
      inserted_at: string
    }) {
      const db = await getDb()
      await req(tx(db, STORES.messageCache, 'readwrite').put(msg))
    },

    async getCachedMessages(channelId: string) {
      const db = await getDb()
      const store = tx(db, STORES.messageCache, 'readonly')
      const index = store.index('channel_id')
      const results = await req(index.getAll(channelId))
      return results.sort(
        (a: { inserted_at: string }, b: { inserted_at: string }) =>
          a.inserted_at.localeCompare(b.inserted_at)
      )
    },

    async clearMessageCache(channelId: string) {
      const db = await getDb()
      const store = tx(db, STORES.messageCache, 'readwrite')
      const index = store.index('channel_id')
      const keys = await req(index.getAllKeys(channelId))
      for (const key of keys) {
        store.delete(key)
      }
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
