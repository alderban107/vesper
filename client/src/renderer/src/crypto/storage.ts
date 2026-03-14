/**
 * Renderer-side interface to the local encrypted database.
 * In Electron, calls go through window.cryptoDb (exposed by preload).
 * In the web client, falls back to an IndexedDB adapter scoped to the
 * current user (vesper-crypto-{userId}).
 */
import { createIndexedDbAdapter } from './indexedDbStorage'

let _db: CryptoDbApi | null = null

/**
 * Initialize storage for a specific user.
 * Must be called after login/registration before any crypto operations.
 * In Electron, uses the preload bridge (already user-scoped by the main process).
 * In web, creates a user-namespaced IndexedDB adapter.
 */
export function initStorage(userId: string): void {
  if (window.cryptoDb) {
    // Electron: preload bridge handles user scoping
    _db = window.cryptoDb
  } else {
    // Web: create a user-namespaced IndexedDB adapter
    _db = createIndexedDbAdapter(userId)

    // Clean up the legacy un-namespaced database if it exists.
    // Before this fix, all users shared a single 'vesper-crypto' DB.
    deleteLegacyDb()
  }
}

/**
 * Reset the storage singleton.
 * Called during logout so the next login initializes a fresh adapter
 * for the new user.
 */
export function resetStorage(): void {
  _db = null
}

function db(): CryptoDbApi {
  if (!_db) {
    // Fallback for Electron where initStorage may not have been called
    if (window.cryptoDb) {
      _db = window.cryptoDb
      return _db
    }
    throw new Error(
      'Crypto storage not initialized. Call initStorage(userId) after login.'
    )
  }
  return _db
}

// --- Identity Keys ---

export async function saveIdentity(
  userId: string,
  publicIdentityKey: Uint8Array,
  publicKeyExchange: Uint8Array,
  encryptedPrivateKeys: Uint8Array,
  nonce: Uint8Array,
  salt: Uint8Array,
  signaturePrivateKey?: Uint8Array | null
): Promise<void> {
  await db().setIdentityKeys(
    userId,
    publicIdentityKey,
    publicKeyExchange,
    encryptedPrivateKeys,
    nonce,
    salt,
    signaturePrivateKey ?? null
  )
}

export async function loadIdentity(userId: string): Promise<{
  publicIdentityKey: Uint8Array
  publicKeyExchange: Uint8Array
  encryptedPrivateKeys: Uint8Array
  nonce: Uint8Array
  salt: Uint8Array
  signaturePrivateKey: Uint8Array | null
} | null> {
  const result = await db().getIdentityKeys(userId)
  if (!result) return null

  // IPC returns ArrayBuffer — convert to Uint8Array
  return {
    publicIdentityKey: new Uint8Array(result.public_identity_key),
    publicKeyExchange: new Uint8Array(result.public_key_exchange),
    encryptedPrivateKeys: new Uint8Array(result.encrypted_private_keys),
    nonce: new Uint8Array(result.nonce),
    salt: new Uint8Array(result.salt),
    signaturePrivateKey: result.signature_private_key
      ? new Uint8Array(result.signature_private_key)
      : null
  }
}

export async function deleteIdentity(userId: string): Promise<void> {
  await db().deleteIdentityKeys(userId)
}

// --- MLS Group State ---

export async function saveGroupState(
  groupId: string,
  state: Uint8Array,
  epoch: number
): Promise<void> {
  await db().setGroupState(groupId, state, epoch)
}

export async function loadGroupState(groupId: string): Promise<{
  state: Uint8Array
  epoch: number
} | null> {
  const result = await db().getGroupState(groupId)
  if (!result) return null

  return {
    state: new Uint8Array(result.state),
    epoch: result.epoch
  }
}

export async function deleteGroupState(groupId: string): Promise<void> {
  await db().deleteGroupState(groupId)
}

// --- Key Packages ---

export async function saveKeyPackages(
  packages: Array<{ publicData: Uint8Array; privateData: Uint8Array }>
): Promise<void> {
  await db().setLocalKeyPackages(packages)
}

export async function loadKeyPackages(): Promise<
  Array<{
    id: number
    publicData: Uint8Array
    privateData: Uint8Array
  }>
> {
  const results = await db().getLocalKeyPackages()
  return results.map((r) => ({
    id: r.id,
    publicData: new Uint8Array(r.key_package_public),
    privateData: new Uint8Array(r.key_package_private)
  }))
}

export async function consumeKeyPackage(id: number): Promise<void> {
  await db().consumeLocalKeyPackage(id)
}

export async function countKeyPackages(): Promise<number> {
  return db().countLocalKeyPackages()
}

// --- Message Cache (stores ciphertext, not plaintext) ---

export async function cacheMessage(msg: {
  id: string
  channelId: string
  senderId: string | null
  senderUsername: string | null
  ciphertext: Uint8Array | null
  mlsEpoch: number | null
  insertedAt: string
}): Promise<void> {
  await db().cacheMessage({
    id: msg.id,
    channel_id: msg.channelId,
    sender_id: msg.senderId,
    sender_username: msg.senderUsername,
    ciphertext: msg.ciphertext,
    mls_epoch: msg.mlsEpoch,
    inserted_at: msg.insertedAt
  })
}

export async function loadCachedMessages(channelId: string): Promise<
  Array<{
    id: string
    channelId: string
    senderId: string | null
    senderUsername: string | null
    ciphertext: Uint8Array | null
    mlsEpoch: number | null
    insertedAt: string
  }>
> {
  const results = await db().getCachedMessages(channelId)
  return results.map((r) => ({
    id: r.id,
    channelId: r.channel_id,
    senderId: r.sender_id,
    senderUsername: r.sender_username,
    ciphertext: r.ciphertext ? new Uint8Array(r.ciphertext) : null,
    mlsEpoch: r.mls_epoch,
    insertedAt: r.inserted_at
  }))
}

export async function clearCachedMessages(channelId: string): Promise<void> {
  await db().clearMessageCache(channelId)
}

// --- Full-Text Search (FTS5) ---

export async function indexDecryptedMessage(
  messageId: string,
  channelId: string,
  content: string
): Promise<void> {
  await db().indexDecryptedMessage(messageId, channelId, content)
}

export async function removeFromFtsIndex(messageId: string): Promise<void> {
  await db().removeFromFtsIndex(messageId)
}

export async function searchDecryptedMessages(
  query: string,
  channelId?: string
): Promise<
  Array<{
    messageId: string
    channelId: string
    content: string
  }>
> {
  const results = await db().searchMessages(query, channelId)
  return results.map((r) => ({
    messageId: r.message_id,
    channelId: r.channel_id,
    content: r.content
  }))
}

// --- Legacy database cleanup ---

/**
 * Delete the legacy un-namespaced 'vesper-crypto' IndexedDB database.
 * Before the user-scoping fix, all users shared this single database,
 * which caused key packages and group states to leak across accounts.
 */
function deleteLegacyDb(): void {
  try {
    const req = indexedDB.deleteDatabase('vesper-crypto')
    req.onerror = () => {
      console.warn('Failed to delete legacy vesper-crypto database')
    }
  } catch {
    // Ignore — not critical
  }
}
