import {
  fetchSearchIndexSnapshot,
  saveSearchIndexSnapshot,
  type SearchIndexSnapshotPayload
} from '../api/searchIndex'
import { base64ToUint8, uint8ToBase64 } from '../api/crypto'
import { derivePasswordKey } from './identity'
import {
  deleteSearchIndexKey,
  loadSearchIndexKey,
  saveSearchIndexKey
} from './searchIndexKeyStore'
import { cacheMessage, loadAllCachedMessages, pruneMessageCache } from './storage'

const SEARCH_INDEX_DEVICE_KEY = 'vesper:searchIndexDeviceId'
const SEARCH_INDEX_MAX_ROWS = 5000
const SEARCH_INDEX_SYNC_DEBOUNCE_MS = 2500
const SEARCH_INDEX_SCHEMA_VERSION = 1

let searchIndexKey: CryptoKey | null = null
let searchIndexUserId: string | null = null
let searchIndexRemoteVersion: number | null = null
let searchIndexSyncTimer: number | null = null
let searchIndexSyncPending = false
let searchIndexSyncInFlight = false

export async function initializeSearchIndexSync(userId: string, password: string): Promise<void> {
  searchIndexKey = await deriveSearchIndexKey(userId, password)
  searchIndexUserId = userId
  searchIndexRemoteVersion = null
  await saveSearchIndexKey(userId, searchIndexKey)
  await pullSearchIndexSnapshot()
  scheduleSearchIndexSync()
}

export async function resumeSearchIndexSync(userId: string): Promise<boolean> {
  const storedKey = await loadSearchIndexKey(userId)
  if (!storedKey) {
    return false
  }

  searchIndexKey = storedKey
  searchIndexUserId = userId
  searchIndexRemoteVersion = null

  await pullSearchIndexSnapshot()
  scheduleSearchIndexSync()
  return true
}

export function clearSearchIndexSyncCredentials(): void {
  searchIndexKey = null
  searchIndexUserId = null
  searchIndexRemoteVersion = null
  searchIndexSyncPending = false
  searchIndexSyncInFlight = false
  if (searchIndexSyncTimer !== null && typeof window !== 'undefined') {
    window.clearTimeout(searchIndexSyncTimer)
  }
  searchIndexSyncTimer = null
}

export async function clearPersistedSearchIndexSyncKey(userId: string): Promise<void> {
  await deleteSearchIndexKey(userId)
}

export function scheduleSearchIndexSync(): void {
  if (!searchIndexKey || !searchIndexUserId || typeof window === 'undefined') {
    return
  }

  searchIndexSyncPending = true
  if (searchIndexSyncTimer !== null) {
    window.clearTimeout(searchIndexSyncTimer)
  }

  searchIndexSyncTimer = window.setTimeout(() => {
    searchIndexSyncTimer = null
    void flushSearchIndexSync()
  }, SEARCH_INDEX_SYNC_DEBOUNCE_MS)
}

export async function flushSearchIndexSync(): Promise<void> {
  if (!searchIndexSyncPending || searchIndexSyncInFlight || !searchIndexKey || !searchIndexUserId) {
    return
  }

  searchIndexSyncPending = false
  searchIndexSyncInFlight = true

  try {
    await pushSearchIndexSnapshot(false)
  } finally {
    searchIndexSyncInFlight = false
  }

  if (searchIndexSyncPending) {
    await flushSearchIndexSync()
  }
}

async function pullSearchIndexSnapshot(): Promise<void> {
  if (!searchIndexKey || !searchIndexUserId) {
    return
  }

  const remote = await fetchSearchIndexSnapshot()
  if (!remote) {
    return
  }

  const snapshot = await decryptSearchIndexSnapshot(remote.ciphertext, remote.nonce)
  if (!snapshot || !Array.isArray(snapshot.messages)) {
    return
  }

  searchIndexRemoteVersion = remote.version

  const localRows = await loadAllCachedMessages()
  const localById = new Map(localRows.map((row) => [row.id, row]))

  for (const row of snapshot.messages) {
    if (!row || typeof row !== 'object') {
      continue
    }

    const existing = localById.get(row.id)
    if (existing && existing.content === row.content) {
      continue
    }

    await cacheMessage({
      id: row.id,
      channelId: row.channel_id,
      conversationId: row.conversation_id,
      serverId: row.server_id,
      senderId: row.sender_id,
      senderUsername: row.sender_username,
      content: row.content,
      attachmentFilenames: row.attachment_filenames ?? [],
      insertedAt: row.inserted_at
    })
  }

  await pruneMessageCache(SEARCH_INDEX_MAX_ROWS)
}

async function pushSearchIndexSnapshot(retriedAfterConflict: boolean): Promise<void> {
  if (!searchIndexKey || !searchIndexUserId) {
    return
  }

  await pruneMessageCache(SEARCH_INDEX_MAX_ROWS)
  const rows = (await loadAllCachedMessages()).slice(0, SEARCH_INDEX_MAX_ROWS)

  const payload: SearchIndexSnapshotPayload = {
    version: SEARCH_INDEX_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    messages: rows.map((row) => ({
      id: row.id,
      channel_id: row.channelId,
      conversation_id: row.conversationId,
      server_id: row.serverId,
      sender_id: row.senderId,
      sender_username: row.senderUsername,
      content: row.content,
      attachment_filenames: row.attachmentFilenames,
      inserted_at: row.insertedAt
    }))
  }

  const encrypted = await encryptSearchIndexSnapshot(payload)

  const result = await saveSearchIndexSnapshot({
    deviceId: getSearchIndexDeviceId(),
    ciphertext: encrypted.ciphertext,
    nonce: encrypted.nonce,
    expectedVersion: searchIndexRemoteVersion ?? undefined
  })

  if (result.ok) {
    searchIndexRemoteVersion = result.snapshot.version
    return
  }

  if (result.conflict && !retriedAfterConflict) {
    await pullSearchIndexSnapshot()
    await pushSearchIndexSnapshot(true)
    return
  }
}

async function deriveSearchIndexKey(userId: string, password: string): Promise<CryptoKey> {
  const seed = new TextEncoder().encode(`vesper-search-index-v1:${userId}`)
  const digest = await crypto.subtle.digest('SHA-256', seed)
  return derivePasswordKey(password, new Uint8Array(digest))
}

async function encryptSearchIndexSnapshot(snapshot: SearchIndexSnapshotPayload): Promise<{
  ciphertext: string
  nonce: string
}> {
  if (!searchIndexKey) {
    throw new Error('search index key not initialized')
  }

  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(JSON.stringify(snapshot))

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    searchIndexKey,
    plaintext
  )

  return {
    ciphertext: uint8ToBase64(new Uint8Array(encrypted)),
    nonce: uint8ToBase64(nonce)
  }
}

async function decryptSearchIndexSnapshot(
  ciphertextB64: string,
  nonceB64: string
): Promise<SearchIndexSnapshotPayload | null> {
  if (!searchIndexKey) {
    return null
  }

  try {
    const nonce = base64ToUint8(nonceB64)
    const ciphertext = base64ToUint8(ciphertextB64)

    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce },
      searchIndexKey,
      ciphertext
    )

    const decoded = new TextDecoder().decode(plaintext)
    return JSON.parse(decoded) as SearchIndexSnapshotPayload
  } catch {
    return null
  }
}

function getSearchIndexDeviceId(): string {
  if (typeof window === 'undefined') {
    return 'server'
  }

  const existing = localStorage.getItem(SEARCH_INDEX_DEVICE_KEY)
  if (existing) {
    return existing
  }

  const generated =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  localStorage.setItem(SEARCH_INDEX_DEVICE_KEY, generated)
  return generated
}
