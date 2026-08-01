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
    salt BLOB,
    signature_private_key BLOB
  );

  CREATE TABLE IF NOT EXISTS recovery_package_keys (
    user_id TEXT PRIMARY KEY,
    key BLOB NOT NULL
  );

  CREATE TABLE IF NOT EXISTS workspace_snapshots (
    user_id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    token TEXT,
    servers_json TEXT NOT NULL,
    conversations_json TEXT NOT NULL,
    unread_counts_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS mls_groups (
    group_id TEXT PRIMARY KEY,
    state BLOB NOT NULL,
    epoch INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS mls_group_sync_state (
    group_id TEXT PRIMARY KEY,
    last_event_seq INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS mls_scope_metadata (
    group_id TEXT PRIMARY KEY,
    recent_commit_fingerprints TEXT NOT NULL DEFAULT '[]',
    recent_history_bundle_fingerprints TEXT NOT NULL DEFAULT '[]',
    repair_status TEXT,
    repair_failure_count INTEGER NOT NULL DEFAULT 0,
    repair_last_error TEXT,
    repair_updated_at TEXT,
    room_data_keys TEXT NOT NULL DEFAULT '[]',
    control_intents TEXT NOT NULL DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS local_key_packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_package_public BLOB NOT NULL,
    key_package_private BLOB NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS message_cache (
    id TEXT PRIMARY KEY,
    channel_id TEXT,
    conversation_id TEXT,
    server_id TEXT,
    sender_id TEXT,
    sender_username TEXT,
    parent_message_id TEXT,
    is_reply INTEGER NOT NULL DEFAULT 0,
    ciphertext BLOB,
    decrypted_content TEXT,
    mls_epoch INTEGER,
    inserted_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_message_cache_channel ON message_cache(channel_id);
  CREATE INDEX IF NOT EXISTS idx_message_cache_conversation ON message_cache(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_message_cache_inserted_at ON message_cache(inserted_at DESC);

  CREATE TABLE IF NOT EXISTS sent_message_cache (
    ciphertext_b64 TEXT PRIMARY KEY,
    plaintext TEXT NOT NULL,
    inserted_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sent_message_cache_inserted_at ON sent_message_cache(inserted_at DESC);

  CREATE TABLE IF NOT EXISTS pending_message_sends (
    client_nonce TEXT PRIMARY KEY,
    scope_kind TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    scope_channel_id TEXT,
    payload_json TEXT NOT NULL,
    inserted_at TEXT NOT NULL
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
    message_id,
    channel_id,
    content
  );
`

const LEGACY_CONTROL_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS pending_group_info_publishes (
    group_id TEXT PRIMARY KEY,
    group_info_data BLOB NOT NULL,
    ratchet_tree_data BLOB,
    epoch INTEGER NOT NULL,
    inserted_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pending_external_commit_broadcasts (
    group_id TEXT PRIMARY KEY,
    commit_data TEXT NOT NULL,
    commit_id TEXT NOT NULL,
    inserted_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pending_sponsored_transitions (
    group_id TEXT PRIMARY KEY,
    recipient_id TEXT NOT NULL,
    recipient_client_id TEXT,
    recipient_key_package_ref TEXT,
    commit_data TEXT NOT NULL,
    commit_id TEXT NOT NULL,
    remove_commit_data TEXT,
    welcome_data TEXT,
    group_info_data BLOB,
    ratchet_tree_data BLOB,
    epoch INTEGER,
    previous_epoch INTEGER,
    base_state BLOB,
    base_epoch INTEGER,
    inserted_at TEXT NOT NULL
  );
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

interface PendingGroupInfoPublishRow {
  group_id: string
  group_info_data: Buffer
  ratchet_tree_data: Buffer | null
  epoch: number
  inserted_at: string
}

interface PendingExternalCommitBroadcastRow {
  group_id: string
  commit_data: string
  commit_id: string
  inserted_at: string
}

interface PendingSponsoredTransitionRow {
  group_id: string
  recipient_id: string
  recipient_client_id: string | null
  recipient_key_package_ref: string | null
  commit_data: string
  commit_id: string
  remove_commit_data: string | null
  welcome_data: string | null
  group_info_data: Buffer | null
  ratchet_tree_data: Buffer | null
  epoch: number | null
  previous_epoch: number | null
  base_state: Buffer | null
  base_epoch: number | null
  inserted_at: string
}

interface EncryptedRoomDataKeyStorageRecord {
  room_id: string
  topology_generation: number
  epoch: number
  ciphertext: string
  nonce: string
}

interface ScopeCheckpointRow {
  group_id: string
  state: Buffer | null
  epoch: number
  last_event_seq: number
  recent_commit_fingerprints: string[]
  recent_history_bundle_fingerprints: string[]
  repair_status: string | null
  repair_failure_count: number
  repair_last_error: string | null
  repair_updated_at: string | null
  room_data_keys: EncryptedRoomDataKeyStorageRecord[]
  control_intents: ControlIntentStorageRecord[]
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
  if (
    tables.some(({ name }) =>
      name === 'pending_group_info_publishes' ||
      name === 'pending_external_commit_broadcasts' ||
      name === 'pending_sponsored_transitions'
    )
  ) {
    // Preserve legacy rows only long enough for initDb's transactional
    // journal migration to fold them into mls_scope_metadata and drop them.
    newDb.exec(LEGACY_CONTROL_SCHEMA_SQL)
  }

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

  // Add signature_private_key column if missing (Phase 3 migration)
  try {
    const idCols = db.pragma('table_info(identity_keys)') as Array<{ name: string }>
    if (idCols.length > 0 && !idCols.some((c) => c.name === 'signature_private_key')) {
      db.exec('ALTER TABLE identity_keys ADD COLUMN signature_private_key BLOB')
    }
  } catch {
    // Table doesn't exist yet — schema creation will handle it
  }

  db.exec(SCHEMA_SQL)
  ensureMessageCacheColumns()
  ensureColumn(
    'mls_scope_metadata',
    'recent_history_bundle_fingerprints',
    "TEXT NOT NULL DEFAULT '[]'"
  )
  ensureColumn('mls_scope_metadata', 'room_data_keys', "TEXT NOT NULL DEFAULT '[]'")
  ensureColumn('mls_scope_metadata', 'control_intents', "TEXT NOT NULL DEFAULT '[]'")
  migrateLegacyControlIntents()
  ensureMessageCacheIndexes()
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

function ensureColumn(tableName: string, columnName: string, columnType: string): void {
  const row = getDb()
    .prepare(`SELECT name FROM pragma_table_info('${tableName}') WHERE name = ?`)
    .get(columnName) as { name: string } | undefined

  if (!row) {
    getDb().exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`)
  }
}

function safeJsonArray<T>(value: string | null | undefined): T[] {
  if (!value) {
    return []
  }

  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function migrateLegacyControlIntents(): void {
  const database = getDb()
  const legacyTables = [
    'pending_group_info_publishes',
    'pending_external_commit_broadcasts',
    'pending_sponsored_transitions'
  ]
  const existingTables = new Set(
    database
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (?, ?, ?)`
      )
      .all(...legacyTables)
      .map((row) => (row as TableRow).name)
  )

  if (existingTables.size === 0) {
    return
  }

  const groupInfos = existingTables.has('pending_group_info_publishes')
    ? (database.prepare('SELECT * FROM pending_group_info_publishes').all() as PendingGroupInfoPublishRow[])
    : []
  const externalCommits = existingTables.has('pending_external_commit_broadcasts')
    ? (database.prepare('SELECT * FROM pending_external_commit_broadcasts').all() as PendingExternalCommitBroadcastRow[])
    : []
  const sponsoredTransitions = existingTables.has('pending_sponsored_transitions')
    ? (database.prepare('SELECT * FROM pending_sponsored_transitions').all() as PendingSponsoredTransitionRow[])
    : []

  const migrate = database.transaction(() => {
    const now = new Date().toISOString()
    const byScope = new Map<string, ControlIntentStorageRecord[]>()
    const append = (scopeId: string, intent: ControlIntentStorageRecord): void => {
      byScope.set(scopeId, [...(byScope.get(scopeId) ?? []), intent])
    }
    const createIntent = (
      operation: string,
      scopeId: string,
      idempotencyKey: string,
      membershipGeneration: number,
      payload: unknown,
      createdAt: string
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
      created_at: createdAt || now,
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
            groupInfoData: pending.group_info_data.toString('base64'),
            ratchetTreeData: pending.ratchet_tree_data?.toString('base64') ?? null,
            epoch: pending.epoch
          },
          pending.inserted_at
        )
      )
    }

    for (const pending of externalCommits) {
      const epoch =
        (database
          .prepare('SELECT epoch FROM mls_groups WHERE group_id = ?')
          .get(pending.group_id) as { epoch: number } | undefined)?.epoch ?? 0
      append(
        pending.group_id,
        createIntent(
          'external_commit_broadcast',
          pending.group_id,
          pending.commit_id,
          epoch,
          { commitData: pending.commit_data, commitId: pending.commit_id },
          pending.inserted_at
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
            recipientClientId: pending.recipient_client_id,
            recipientKeyPackageRef: pending.recipient_key_package_ref,
            commitData: pending.commit_data,
            commitId: pending.commit_id,
            removeCommitData: pending.remove_commit_data,
            welcomeData: pending.welcome_data,
            groupInfoData: pending.group_info_data?.toString('base64') ?? null,
            ratchetTreeData: pending.ratchet_tree_data?.toString('base64') ?? null,
            epoch: pending.epoch,
            previousEpoch: pending.previous_epoch,
            baseState: pending.base_state?.toString('base64') ?? null,
            baseEpoch: pending.base_epoch
          },
          pending.inserted_at
        )
      )
    }

    const selectMetadata = database.prepare(
      'SELECT control_intents FROM mls_scope_metadata WHERE group_id = ?'
    )
    const upsertMetadata = database.prepare(
      `INSERT INTO mls_scope_metadata (group_id, control_intents)
       VALUES (?, ?)
       ON CONFLICT(group_id) DO UPDATE SET control_intents = excluded.control_intents`
    )

    for (const [scopeId, intents] of byScope) {
      const row = selectMetadata.get(scopeId) as { control_intents: string } | undefined
      const existing = safeJsonArray<ControlIntentStorageRecord>(row?.control_intents)
      const keys = new Set(existing.map((intent) => `${intent.operation}:${intent.idempotency_key}`))
      const merged = [
        ...existing,
        ...intents.filter(
          (intent) => !keys.has(`${intent.operation}:${intent.idempotency_key}`)
        )
      ]
      upsertMetadata.run(scopeId, JSON.stringify(merged))
    }

    for (const table of existingTables) {
      database.exec(`DROP TABLE ${table}`)
    }
  })

  migrate()
}

function ensureMessageCacheColumns(): void {
  ensureColumn('message_cache', 'conversation_id', 'TEXT')
  ensureColumn('message_cache', 'server_id', 'TEXT')
  ensureColumn('message_cache', 'decrypted_content', 'TEXT')
  ensureColumn('message_cache', 'parent_message_id', 'TEXT')
  ensureColumn('message_cache', 'is_reply', 'INTEGER NOT NULL DEFAULT 0')
}

function ensureMessageCacheIndexes(): void {
  getDb().exec('CREATE INDEX IF NOT EXISTS idx_message_cache_conversation ON message_cache(conversation_id)')
  getDb().exec('CREATE INDEX IF NOT EXISTS idx_message_cache_inserted_at ON message_cache(inserted_at DESC)')
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
  signature_private_key: Buffer | null
} | null {
  return getDb()
    .prepare(
      'SELECT public_identity_key, public_key_exchange, encrypted_private_keys, nonce, salt, signature_private_key FROM identity_keys WHERE user_id = ?'
    )
    .get(userId) as ReturnType<typeof getIdentityKeys>
}

export function setIdentityKeys(
  userId: string,
  publicIdentityKey: Buffer,
  publicKeyExchange: Buffer,
  encryptedPrivateKeys: Buffer,
  nonce: Buffer,
  salt: Buffer,
  signaturePrivateKey: Buffer | null = null
): void {
  getDb()
    .prepare(
      'INSERT OR REPLACE INTO identity_keys (user_id, public_identity_key, public_key_exchange, encrypted_private_keys, nonce, salt, signature_private_key) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(userId, publicIdentityKey, publicKeyExchange, encryptedPrivateKeys, nonce, salt, signaturePrivateKey)
}

export function deleteIdentityKeys(userId: string): void {
  const database = getDb()
  database.transaction(() => {
    database.prepare('DELETE FROM identity_keys WHERE user_id = ?').run(userId)
    database.prepare('DELETE FROM recovery_package_keys WHERE user_id = ?').run(userId)
    database.prepare('DELETE FROM workspace_snapshots WHERE user_id = ?').run(userId)
  })()
}

export function getWorkspaceSnapshot(userId: string): {
  version: number
  token: string | null
  servers_json: string
  conversations_json: string
  unread_counts_json: string
  updated_at: string
} | null {
  return getDb()
    .prepare(
      'SELECT version, token, servers_json, conversations_json, unread_counts_json, updated_at FROM workspace_snapshots WHERE user_id = ?'
    )
    .get(userId) as ReturnType<typeof getWorkspaceSnapshot>
}

export function setWorkspaceSnapshot(
  userId: string,
  snapshot: {
    version: number
    token: string | null
    servers_json: string
    conversations_json: string
    unread_counts_json: string
    updated_at: string
  }
): void {
  getDb()
    .prepare(
      `INSERT INTO workspace_snapshots (
         user_id, version, token, servers_json, conversations_json, unread_counts_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         version = excluded.version,
         token = excluded.token,
         servers_json = excluded.servers_json,
         conversations_json = excluded.conversations_json,
         unread_counts_json = excluded.unread_counts_json,
         updated_at = excluded.updated_at`
    )
    .run(
      userId,
      snapshot.version,
      snapshot.token,
      snapshot.servers_json,
      snapshot.conversations_json,
      snapshot.unread_counts_json,
      snapshot.updated_at
    )
}

export function getRecoveryPackageKey(userId: string): Buffer | null {
  const row = getDb()
    .prepare('SELECT key FROM recovery_package_keys WHERE user_id = ?')
    .get(userId) as { key: Buffer } | undefined
  return row?.key ?? null
}

export function setRecoveryPackageKey(userId: string, key: Buffer): void {
  getDb()
    .prepare(
      'INSERT INTO recovery_package_keys (user_id, key) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET key = excluded.key'
    )
    .run(userId, key)
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
  const database = getDb()
  const cleanup = database.transaction((id: string) => {
    database.prepare('DELETE FROM mls_groups WHERE group_id = ?').run(id)
    // Preserve the durable replay cursor. Rejoining with fresh MLS state must
    // not replay an already-consumed removal forever.
    database.prepare('DELETE FROM mls_scope_metadata WHERE group_id = ?').run(id)
  })
  cleanup(groupId)
}

export function getGroupSyncCursor(groupId: string): number {
  const row = getDb()
    .prepare('SELECT last_event_seq FROM mls_group_sync_state WHERE group_id = ?')
    .get(groupId) as { last_event_seq: number } | undefined

  return row?.last_event_seq ?? 0
}

export function setGroupSyncCursor(groupId: string, lastEventSeq: number): void {
  getDb()
    .prepare(
      `INSERT INTO mls_group_sync_state (group_id, last_event_seq)
       VALUES (?, ?)
       ON CONFLICT(group_id) DO UPDATE SET
         last_event_seq = MAX(mls_group_sync_state.last_event_seq, excluded.last_event_seq)`
    )
    .run(groupId, lastEventSeq)
}

export function getScopeCheckpoint(groupId: string): ScopeCheckpointRow {
  const database = getDb()
  const groupState = database
    .prepare('SELECT state, epoch FROM mls_groups WHERE group_id = ?')
    .get(groupId) as { state: Buffer; epoch: number } | undefined
  const syncState = database
    .prepare('SELECT last_event_seq FROM mls_group_sync_state WHERE group_id = ?')
    .get(groupId) as { last_event_seq: number } | undefined
  const metadata = database
    .prepare(
      `SELECT
         recent_commit_fingerprints,
         recent_history_bundle_fingerprints,
         repair_status,
         repair_failure_count,
         repair_last_error,
         repair_updated_at,
         room_data_keys,
         control_intents
       FROM mls_scope_metadata
       WHERE group_id = ?`
    )
    .get(groupId) as
    | {
        recent_commit_fingerprints: string | null
        recent_history_bundle_fingerprints: string | null
        repair_status: string | null
        repair_failure_count: number
        repair_last_error: string | null
        repair_updated_at: string | null
        room_data_keys: string | null
        control_intents: string | null
      }
    | undefined
  let recentCommitFingerprints: string[] = []
  let recentHistoryBundleFingerprints: string[] = []
  if (metadata?.recent_commit_fingerprints) {
    try {
      const parsed = JSON.parse(metadata.recent_commit_fingerprints)
      if (Array.isArray(parsed)) {
        recentCommitFingerprints = parsed.filter(
          (value): value is string => typeof value === 'string'
        )
      }
    } catch {
      recentCommitFingerprints = []
    }
  }

  if (metadata?.recent_history_bundle_fingerprints) {
    try {
      const parsed = JSON.parse(metadata.recent_history_bundle_fingerprints)
      if (Array.isArray(parsed)) {
        recentHistoryBundleFingerprints = parsed.filter(
          (value): value is string => typeof value === 'string'
        )
      }
    } catch {
      recentHistoryBundleFingerprints = []
    }
  }

  return {
    group_id: groupId,
    state: groupState?.state ?? null,
    epoch: groupState?.epoch ?? 0,
    last_event_seq: syncState?.last_event_seq ?? 0,
    recent_commit_fingerprints: recentCommitFingerprints,
    recent_history_bundle_fingerprints: recentHistoryBundleFingerprints,
    repair_status: metadata?.repair_status ?? null,
    repair_failure_count: metadata?.repair_failure_count ?? 0,
    repair_last_error: metadata?.repair_last_error ?? null,
    repair_updated_at: metadata?.repair_updated_at ?? null,
    room_data_keys:
      safeJsonArray<EncryptedRoomDataKeyStorageRecord>(metadata?.room_data_keys),
    control_intents: safeJsonArray<ControlIntentStorageRecord>(metadata?.control_intents)
  }
}

export function getKnownScopeIds(): string[] {
  return getDb()
    .prepare(
      `SELECT group_id FROM mls_groups
       UNION
       SELECT group_id FROM mls_group_sync_state
       UNION
       SELECT group_id FROM mls_scope_metadata
       ORDER BY group_id ASC`
    )
    .all()
    .map((row) => String((row as { group_id: string }).group_id))
}

export function setScopeCheckpoint(
  groupId: string,
  checkpoint: {
    state: Buffer | null
    epoch: number
    last_event_seq: number
    recent_commit_fingerprints?: string[]
    recent_history_bundle_fingerprints?: string[]
    repair_status?: string | null
    repair_failure_count?: number
    repair_last_error?: string | null
    repair_updated_at?: string | null
    room_data_keys?: EncryptedRoomDataKeyStorageRecord[]
    control_intents?: ControlIntentStorageRecord[]
  }
): void {
  const database = getDb()
  const save = database.transaction(
    (
      id: string,
      payload: {
        state: Buffer | null
        epoch: number
        last_event_seq: number
        recent_commit_fingerprints?: string[]
        recent_history_bundle_fingerprints?: string[]
        repair_status?: string | null
        repair_failure_count?: number
        repair_last_error?: string | null
        repair_updated_at?: string | null
        room_data_keys?: EncryptedRoomDataKeyStorageRecord[]
        control_intents?: ControlIntentStorageRecord[]
      }
    ) => {
      if (payload.state) {
        database
          .prepare(
            'INSERT OR REPLACE INTO mls_groups (group_id, state, epoch) VALUES (?, ?, ?)'
          )
          .run(id, payload.state, payload.epoch)
      } else {
        database.prepare('DELETE FROM mls_groups WHERE group_id = ?').run(id)
      }

      database
        .prepare(
          `INSERT INTO mls_group_sync_state (group_id, last_event_seq)
           VALUES (?, ?)
           ON CONFLICT(group_id) DO UPDATE SET
             last_event_seq = MAX(mls_group_sync_state.last_event_seq, excluded.last_event_seq)`
        )
        .run(id, payload.last_event_seq)

      const recentCommitFingerprints = JSON.stringify(
        Array.isArray(payload.recent_commit_fingerprints)
          ? payload.recent_commit_fingerprints
          : []
      )
      const recentHistoryBundleFingerprints = JSON.stringify(
        Array.isArray(payload.recent_history_bundle_fingerprints)
          ? payload.recent_history_bundle_fingerprints
          : []
      )

      database
        .prepare(
          `INSERT INTO mls_scope_metadata (
             group_id,
             recent_commit_fingerprints,
             recent_history_bundle_fingerprints,
             repair_status,
             repair_failure_count,
             repair_last_error,
             repair_updated_at,
             room_data_keys,
             control_intents
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(group_id) DO UPDATE SET
             recent_commit_fingerprints = excluded.recent_commit_fingerprints,
             recent_history_bundle_fingerprints = excluded.recent_history_bundle_fingerprints,
             repair_status = excluded.repair_status,
             repair_failure_count = excluded.repair_failure_count,
             repair_last_error = excluded.repair_last_error,
             repair_updated_at = excluded.repair_updated_at,
             room_data_keys = excluded.room_data_keys,
             control_intents = excluded.control_intents`
        )
        .run(
          id,
          recentCommitFingerprints,
          recentHistoryBundleFingerprints,
          payload.repair_status ?? null,
          payload.repair_failure_count ?? 0,
          payload.repair_last_error ?? null,
          payload.repair_updated_at ?? null,
          JSON.stringify(payload.room_data_keys ?? []),
          JSON.stringify(payload.control_intents ?? [])
        )
    }
  )

  save(groupId, checkpoint)
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
  channel_id: string | null
  conversation_id: string | null
  server_id: string | null
  sender_id: string | null
  sender_username: string | null
  parent_message_id: string | null
  thread_root_message_id: string | null
  reply_to_message_id: string | null
  is_reply: boolean
  ciphertext: Buffer | null
  decrypted_content: string | null
  mls_epoch: number | null
  inserted_at: string
}): void {
  getDb()
    .prepare(
      `INSERT INTO message_cache (
        id,
        channel_id,
        conversation_id,
        server_id,
        sender_id,
        sender_username,
        parent_message_id,
        thread_root_message_id,
        reply_to_message_id,
        is_reply,
        ciphertext,
        decrypted_content,
        mls_epoch,
        inserted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        channel_id = COALESCE(excluded.channel_id, message_cache.channel_id),
        conversation_id = COALESCE(excluded.conversation_id, message_cache.conversation_id),
        server_id = COALESCE(excluded.server_id, message_cache.server_id),
        sender_id = COALESCE(excluded.sender_id, message_cache.sender_id),
        sender_username = COALESCE(excluded.sender_username, message_cache.sender_username),
        parent_message_id = COALESCE(excluded.parent_message_id, message_cache.parent_message_id),
        thread_root_message_id = COALESCE(excluded.thread_root_message_id, message_cache.thread_root_message_id),
        reply_to_message_id = COALESCE(excluded.reply_to_message_id, message_cache.reply_to_message_id),
        is_reply = excluded.is_reply,
        ciphertext = COALESCE(excluded.ciphertext, message_cache.ciphertext),
        decrypted_content = COALESCE(excluded.decrypted_content, message_cache.decrypted_content),
        mls_epoch = COALESCE(excluded.mls_epoch, message_cache.mls_epoch),
        inserted_at = excluded.inserted_at`
    )
    .run(
      msg.id,
      msg.channel_id,
      msg.conversation_id,
      msg.server_id,
      msg.sender_id,
      msg.sender_username,
      msg.parent_message_id,
      msg.thread_root_message_id,
      msg.reply_to_message_id,
      msg.is_reply ? 1 : 0,
      msg.ciphertext,
      msg.decrypted_content,
      msg.mls_epoch,
      msg.inserted_at
    )
}

export function getCachedMessageDecryption(messageId: string): string | null {
  const row = getDb()
    .prepare('SELECT decrypted_content FROM message_cache WHERE id = ?')
    .get(messageId) as { decrypted_content: string | null } | undefined

  return row?.decrypted_content ?? null
}

export function setCachedMessageDecryption(messageId: string, plaintext: string): void {
  getDb()
    .prepare('UPDATE message_cache SET decrypted_content = ? WHERE id = ?')
    .run(plaintext, messageId)
}

export function getSentMessagePlaintext(ciphertextB64: string): string | null {
  const row = getDb()
    .prepare('SELECT plaintext FROM sent_message_cache WHERE ciphertext_b64 = ?')
    .get(ciphertextB64) as { plaintext: string | null } | undefined

  return row?.plaintext ?? null
}

export function setSentMessagePlaintext(ciphertextB64: string, plaintext: string): void {
  getDb()
    .prepare(
      'INSERT OR REPLACE INTO sent_message_cache (ciphertext_b64, plaintext, inserted_at) VALUES (?, ?, ?)'
    )
    .run(ciphertextB64, plaintext, new Date().toISOString())
}

export function getCachedMessages(channelId: string): Array<{
  id: string
  channel_id: string | null
  conversation_id: string | null
  server_id: string | null
  sender_id: string | null
  sender_username: string | null
  parent_message_id: string | null
  thread_root_message_id: string | null
  reply_to_message_id: string | null
  is_reply: number
  ciphertext: Buffer | null
  decrypted_content: string | null
  mls_epoch: number | null
  inserted_at: string
}> {
  return getDb()
    .prepare(
      'SELECT * FROM message_cache WHERE channel_id = ? OR conversation_id = ? ORDER BY inserted_at ASC'
    )
    .all(channelId, channelId) as ReturnType<typeof getCachedMessages>
}

export function clearMessageCache(channelId: string): void {
  getDb()
    .prepare('DELETE FROM message_cache WHERE channel_id = ? OR conversation_id = ?')
    .run(channelId, channelId)
}

// --- Full-Text Search (FTS5) ---
// Populated from the renderer when messages are decrypted, creating a
// client-side searchable index of plaintext content.

export function indexDecryptedMessage(
  messageId: string,
  channelId: string,
  content: string
): void {
  // Upsert: delete any existing entry first to avoid duplicates on re-index
  getDb()
    .prepare('DELETE FROM message_fts WHERE message_id = ?')
    .run(messageId)
  getDb()
    .prepare(
      'INSERT INTO message_fts (message_id, channel_id, content) VALUES (?, ?, ?)'
    )
    .run(messageId, channelId, content)
}

export function removeFromFtsIndex(messageId: string): void {
  getDb()
    .prepare('DELETE FROM message_fts WHERE message_id = ?')
    .run(messageId)
}

export function searchMessages(
  query: string,
  channelId?: string
): Array<{
  message_id: string
  channel_id: string
  conversation_id: string | null
  server_id: string | null
  sender_id: string | null
  sender_username: string | null
  inserted_at: string | null
  preview: string
}> {
  if (!query.trim()) return []

  // Sanitize the query for FTS5: wrap each token in double quotes to avoid
  // syntax errors from special characters, then join with implicit AND.
  const tokens = query
    .trim()
    .split(/\s+/)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
  const ftsQuery = tokens.join(' ')
  const previewExpr = `snippet(message_fts, 2, '[[[', ']]]', ' ... ', 12)`

  if (channelId) {
    return getDb()
      .prepare(
        `
        SELECT
          message_fts.message_id,
          message_fts.channel_id,
          message_cache.conversation_id,
          message_cache.server_id,
          message_cache.sender_id,
          message_cache.sender_username,
          message_cache.inserted_at,
          ${previewExpr} AS preview
        FROM message_fts
        LEFT JOIN message_cache ON message_cache.id = message_fts.message_id
        WHERE message_fts.channel_id = ? AND message_fts MATCH ?
        ORDER BY bm25(message_fts), message_cache.inserted_at DESC
        LIMIT 50
        `
      )
      .all(channelId, ftsQuery) as Array<{
      message_id: string
      channel_id: string
      conversation_id: string | null
      server_id: string | null
      sender_id: string | null
      sender_username: string | null
      inserted_at: string | null
      preview: string
    }>
  }

  return getDb()
    .prepare(
      `
      SELECT
        message_fts.message_id,
        message_fts.channel_id,
        message_cache.conversation_id,
        message_cache.server_id,
        message_cache.sender_id,
        message_cache.sender_username,
        message_cache.inserted_at,
        ${previewExpr} AS preview
      FROM message_fts
      LEFT JOIN message_cache ON message_cache.id = message_fts.message_id
      WHERE message_fts MATCH ?
      ORDER BY bm25(message_fts), message_cache.inserted_at DESC
      LIMIT 50
      `
    )
    .all(ftsQuery) as Array<{
    message_id: string
    channel_id: string
    conversation_id: string | null
    server_id: string | null
    sender_id: string | null
    sender_username: string | null
    inserted_at: string | null
    preview: string
  }>
}

// --- Pending message send outbox ---
// Durable across a crash between "user hit send" and "server acknowledged
// the write". Entries are keyed by client_nonce so a retried send after
// restart is idempotent with the server's (scope, sender, client_nonce)
// unique index — replaying the same nonce can never create a duplicate
// message.

export function getPendingMessageSends(): Array<{
  client_nonce: string
  scope_kind: 'channel' | 'dm'
  scope_id: string
  scope_channel_id: string | null
  payload_json: string
  inserted_at: string
}> {
  return getDb()
    .prepare('SELECT * FROM pending_message_sends ORDER BY inserted_at ASC')
    .all() as ReturnType<typeof getPendingMessageSends>
}

export function setPendingMessageSend(entry: {
  client_nonce: string
  scope_kind: 'channel' | 'dm'
  scope_id: string
  scope_channel_id: string | null
  payload_json: string
  inserted_at: string
}): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO pending_message_sends (
         client_nonce, scope_kind, scope_id, scope_channel_id, payload_json, inserted_at
       ) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      entry.client_nonce,
      entry.scope_kind,
      entry.scope_id,
      entry.scope_channel_id,
      entry.payload_json,
      entry.inserted_at
    )
}

export function deletePendingMessageSend(clientNonce: string): void {
  getDb().prepare('DELETE FROM pending_message_sends WHERE client_nonce = ?').run(clientNonce)
}
