import Database from 'better-sqlite3-multiple-ciphers'
import { app, safeStorage } from 'electron'
import { randomBytes } from 'crypto'
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs'
import { join } from 'path'

let db: Database.Database | null = null

// ---------------------------------------------------------------------------
// Encryption key management
// ---------------------------------------------------------------------------

const DB_FILENAME = 'crypto.db'
const KEY_FILENAME = 'crypto.db.key'
const KEY_LENGTH = 32 // 256-bit

/**
 * Retrieve or generate the hex-encoded encryption key for crypto.db.
 *
 * The raw key is 32 random bytes. It is encrypted at rest using Electron's
 * safeStorage API (OS keychain) and written to `crypto.db.key` beside the DB.
 *
 * Returns the hex string, or `null` if safeStorage is unavailable (graceful
 * degradation — the DB will be opened without encryption in that case).
 */
function getOrCreateEncryptionKey(userDataPath: string): string | null {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn(
      '[vesper/db] safeStorage is not available on this system. ' +
        'crypto.db will NOT be encrypted at rest. ' +
        'This is expected on headless Linux without a keychain.'
    )
    return null
  }

  const keyPath = join(userDataPath, KEY_FILENAME)

  if (existsSync(keyPath)) {
    // Decrypt existing key
    const encrypted = readFileSync(keyPath)
    const raw = safeStorage.decryptString(encrypted)
    return raw
  }

  // First run — generate a fresh key
  const rawKey = randomBytes(KEY_LENGTH).toString('hex')
  const encrypted = safeStorage.encryptString(rawKey)
  writeFileSync(keyPath, encrypted)
  return rawKey
}

/**
 * Apply the encryption key to an open database handle. Must be called
 * immediately after `new Database(...)` before any other operations.
 */
function applyKey(database: Database.Database, hexKey: string): void {
  database.pragma(`key = "x'${hexKey}'"`)
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
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
    ciphertext BLOB,
    mls_epoch INTEGER,
    inserted_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_message_cache_channel ON message_cache(channel_id);
`

// ---------------------------------------------------------------------------
// Migration: unencrypted → encrypted
// ---------------------------------------------------------------------------

/**
 * Detect whether an existing database is unencrypted by trying to open it
 * without a key and reading `PRAGMA schema_version`. If that succeeds, the
 * DB is plaintext and needs migration.
 */
function isUnencryptedDb(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false

  try {
    const probe = new Database(dbPath, { readonly: true })
    try {
      // If this returns a number, the DB is readable without a key
      probe.pragma('schema_version')
      probe.close()
      return true
    } catch {
      probe.close()
      return false
    }
  } catch {
    return false
  }
}

interface TableRow {
  name: string
}

/**
 * Migrate an existing unencrypted crypto.db to an encrypted one.
 *
 * Strategy: open unencrypted → dump all rows → close → rename to .bak →
 * create new encrypted DB → re-insert everything.
 */
function migrateToEncrypted(dbPath: string, hexKey: string): void {
  console.log('[vesper/db] Migrating unencrypted crypto.db to encrypted format…')

  const backupPath = dbPath + '.bak'

  // 1. Open unencrypted and read all user tables
  const oldDb = new Database(dbPath, { readonly: true })
  const tables = oldDb
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    )
    .all() as TableRow[]

  const tableData: Record<string, unknown[]> = {}
  for (const { name } of tables) {
    tableData[name] = oldDb.prepare(`SELECT * FROM "${name}"`).all()
  }
  oldDb.close()

  // 2. Move old DB aside
  renameSync(dbPath, backupPath)
  // Also remove WAL/SHM if present
  for (const suffix of ['-wal', '-shm']) {
    const p = dbPath + suffix
    if (existsSync(p)) unlinkSync(p)
  }

  // 3. Create new encrypted DB
  const newDb = new Database(dbPath)
  applyKey(newDb, hexKey)
  newDb.pragma('journal_mode = WAL')
  newDb.exec(SCHEMA_SQL)

  // 4. Re-insert data
  for (const { name } of tables) {
    const rows = tableData[name]
    if (!rows || rows.length === 0) continue

    const columns = Object.keys(rows[0] as Record<string, unknown>)
    const placeholders = columns.map(() => '?').join(', ')
    const colList = columns.map((c) => `"${c}"`).join(', ')
    const insert = newDb.prepare(
      `INSERT OR REPLACE INTO "${name}" (${colList}) VALUES (${placeholders})`
    )

    const insertAll = newDb.transaction((data: unknown[]) => {
      for (const row of data) {
        const vals = columns.map((c) => (row as Record<string, unknown>)[c])
        insert.run(...vals)
      }
    })
    insertAll(rows)
  }

  newDb.close()
  console.log(
    `[vesper/db] Migration complete. Old DB backed up to ${backupPath}`
  )
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initDb(): void {
  const userDataPath = app.getPath('userData')
  const dbPath = join(userDataPath, DB_FILENAME)
  const hexKey = getOrCreateEncryptionKey(userDataPath)

  // Handle migration from unencrypted → encrypted
  if (hexKey && existsSync(dbPath) && isUnencryptedDb(dbPath)) {
    migrateToEncrypted(dbPath, hexKey)
  }

  db = new Database(dbPath)

  if (hexKey) {
    applyKey(db, hexKey)
  }

  db.pragma('journal_mode = WAL')

  // Migrate message_cache from plaintext (content TEXT) to ciphertext (ciphertext BLOB + mls_epoch INTEGER).
  // One-time loss of cached messages is acceptable.
  try {
    const cols = db.pragma('table_info(message_cache)') as Array<{ name: string }>
    if (cols.length > 0 && cols.some((c) => c.name === 'content') && !cols.some((c) => c.name === 'ciphertext')) {
      db.exec('DROP TABLE IF EXISTS message_cache')
      db.exec('DROP INDEX IF EXISTS idx_message_cache_channel')
    }
  } catch {
    // Table doesn't exist yet — schema creation will handle it
  }

  db.exec(SCHEMA_SQL)
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
  ciphertext: Buffer | null
  mls_epoch: number | null
  inserted_at: string
}): void {
  getDb()
    .prepare(
      'INSERT OR REPLACE INTO message_cache (id, channel_id, sender_id, sender_username, ciphertext, mls_epoch, inserted_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(msg.id, msg.channel_id, msg.sender_id, msg.sender_username, msg.ciphertext, msg.mls_epoch, msg.inserted_at)
}

export function getCachedMessages(channelId: string): Array<{
  id: string
  channel_id: string
  sender_id: string | null
  sender_username: string | null
  ciphertext: Buffer | null
  mls_epoch: number | null
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
// Plaintext search is no longer possible with encrypted message cache.
// Will be reimplemented with FTS5 in Phase 5 of the E2EE refactor.

export function searchMessages(_query: string): Array<{
  id: string
  channel_id: string
  sender_id: string | null
  sender_username: string | null
  ciphertext: Buffer | null
  mls_epoch: number | null
  inserted_at: string
}> {
  return []
}
