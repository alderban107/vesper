const DB_NAME = 'vesper-search-index'
const DB_VERSION = 1
const STORE_NAME = 'keys'

interface SearchIndexKeyRow {
  user_id: string
  key: CryptoKey
  updated_at: string
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'user_id' })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function saveSearchIndexKey(userId: string, key: CryptoKey): Promise<void> {
  try {
    const db = await openDb()
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    await req(
      store.put({
        user_id: userId,
        key,
        updated_at: new Date().toISOString()
      } as SearchIndexKeyRow)
    )
  } catch {
    // Best effort only. Search sync still works for this session.
  }
}

export async function loadSearchIndexKey(userId: string): Promise<CryptoKey | null> {
  try {
    const db = await openDb()
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const row = (await req(store.get(userId))) as SearchIndexKeyRow | undefined
    return row?.key ?? null
  } catch {
    return null
  }
}

export async function deleteSearchIndexKey(userId: string): Promise<void> {
  try {
    const db = await openDb()
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    await req(store.delete(userId))
  } catch {
    // Ignore local cleanup failures.
  }
}
