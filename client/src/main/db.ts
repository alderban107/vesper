import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'

let db: Database.Database | null = null

export function initDb(): void {
  const dbPath = join(app.getPath('userData'), 'crypto.db')
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS identity_keys (
      user_id TEXT PRIMARY KEY,
      public_identity_key BLOB,
      public_key_exchange BLOB,
      encrypted_private_keys BLOB,
      nonce BLOB,
      salt BLOB
    );

    CREATE TABLE IF NOT EXISTS mls_groups (
      group_id TEXT PRIMARY KEY,
      state BLOB NOT NULL,
      epoch INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS local_key_packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_package_public BLOB NOT NULL,
      key_package_private BLOB NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS message_cache (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      sender_id TEXT,
      sender_username TEXT,
      content TEXT,
      inserted_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_message_cache_channel ON message_cache(channel_id);
  `)
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}

function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized')
  return db
}

// --- Identity Keys ---

export function getIdentityKeys(
  userId: string
): {
  public_identity_key: Buffer
  public_key_exchange: Buffer
  encrypted_private_keys: Buffer
  nonce: Buffer
  salt: Buffer
} | null {
  return getDb()
    .prepare(
      'SELECT public_identity_key, public_key_exchange, encrypted_private_keys, nonce, salt FROM identity_keys WHERE user_id = ?'
    )
    .get(userId) as ReturnType<typeof getIdentityKeys>
}

export function setIdentityKeys(
  userId: string,
  publicIdentityKey: Buffer,
  publicKeyExchange: Buffer,
  encryptedPrivateKeys: Buffer,
  nonce: Buffer,
  salt: Buffer
): void {
  getDb()
    .prepare(
      'INSERT OR REPLACE INTO identity_keys (user_id, public_identity_key, public_key_exchange, encrypted_private_keys, nonce, salt) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(userId, publicIdentityKey, publicKeyExchange, encryptedPrivateKeys, nonce, salt)
}

export function deleteIdentityKeys(userId: string): void {
  getDb().prepare('DELETE FROM identity_keys WHERE user_id = ?').run(userId)
}

// --- MLS Groups ---

export function getGroupState(
  groupId: string
): { state: Buffer; epoch: number } | null {
  return getDb()
    .prepare('SELECT state, epoch FROM mls_groups WHERE group_id = ?')
    .get(groupId) as ReturnType<typeof getGroupState>
}

export function setGroupState(groupId: string, state: Buffer, epoch: number): void {
  getDb()
    .prepare(
      'INSERT OR REPLACE INTO mls_groups (group_id, state, epoch) VALUES (?, ?, ?)'
    )
    .run(groupId, state, epoch)
}

export function deleteGroupState(groupId: string): void {
  getDb().prepare('DELETE FROM mls_groups WHERE group_id = ?').run(groupId)
}

// --- Local Key Packages ---

export function getLocalKeyPackages(): Array<{
  id: number
  key_package_public: Buffer
  key_package_private: Buffer
}> {
  return getDb()
    .prepare(
      'SELECT id, key_package_public, key_package_private FROM local_key_packages WHERE consumed = 0'
    )
    .all() as ReturnType<typeof getLocalKeyPackages>
}

export function setLocalKeyPackages(
  packages: Array<{ publicData: Buffer; privateData: Buffer }>
): void {
  const insert = getDb().prepare(
    'INSERT INTO local_key_packages (key_package_public, key_package_private) VALUES (?, ?)'
  )
  const insertMany = getDb().transaction(
    (pkgs: typeof packages) => {
      for (const pkg of pkgs) {
        insert.run(pkg.publicData, pkg.privateData)
      }
    }
  )
  insertMany(packages)
}

export function consumeLocalKeyPackage(id: number): void {
  getDb()
    .prepare('UPDATE local_key_packages SET consumed = 1 WHERE id = ?')
    .run(id)
}

export function countLocalKeyPackages(): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) as count FROM local_key_packages WHERE consumed = 0')
    .get() as { count: number }
  return row.count
}

// --- Message Cache ---

export function cacheMessage(msg: {
  id: string
  channel_id: string
  sender_id: string | null
  sender_username: string | null
  content: string | null
  inserted_at: string
}): void {
  getDb()
    .prepare(
      'INSERT OR REPLACE INTO message_cache (id, channel_id, sender_id, sender_username, content, inserted_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(msg.id, msg.channel_id, msg.sender_id, msg.sender_username, msg.content, msg.inserted_at)
}

export function getCachedMessages(channelId: string): Array<{
  id: string
  channel_id: string
  sender_id: string | null
  sender_username: string | null
  content: string | null
  inserted_at: string
}> {
  return getDb()
    .prepare(
      'SELECT * FROM message_cache WHERE channel_id = ? ORDER BY inserted_at ASC'
    )
    .all(channelId) as ReturnType<typeof getCachedMessages>
}

export function clearMessageCache(channelId: string): void {
  getDb().prepare('DELETE FROM message_cache WHERE channel_id = ?').run(channelId)
}

// --- Message Search ---

export function searchMessages(query: string): Array<{
  id: string
  channel_id: string
  sender_id: string | null
  sender_username: string | null
  content: string | null
  inserted_at: string
}> {
  return getDb()
    .prepare(
      'SELECT * FROM message_cache WHERE content LIKE ? ORDER BY inserted_at DESC LIMIT 50'
    )
    .all(`%${query}%`) as ReturnType<typeof searchMessages>
}
