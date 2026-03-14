# E2EE Implementation Guide

This document describes how Vesper's end-to-end encryption works as currently implemented, how to work with it as a developer, and where the sharp edges are. It is a companion to [REQUIREMENTS-E2EE.md](./REQUIREMENTS-E2EE.md) (what the system must do and why), [REQUIREMENTS-E2EE-AUDIT.md](./REQUIREMENTS-E2EE-AUDIT.md) (which requirements are met and by what code), and [DESIGN.md](../DESIGN.md) (the overall architecture). This document covers what the system actually does right now, in enough detail to modify it without breaking things.

Last updated after the Phase 0–6 E2EE refactor.

---

## 1. Architecture Overview

Vesper's E2EE uses the MLS protocol (RFC 9420) via the `ts-mls` TypeScript library. The design principle is that the server is cryptographically blind — it stores and relays opaque ciphertext but never has access to plaintext content or encryption keys.

The system has four layers:

```
┌──────────────────────────────────────────────────┐
│  Stores (authStore, cryptoStore, messageStore)    │  ← Orchestration
├──────────────────────────────────────────────────┤
│  Crypto (mls, identity, payload, groupLock, …)   │  ← Cryptographic operations
├──────────────────────────────────────────────────┤
│  Storage (storage.ts → db.ts / indexedDbStorage)  │  ← Persistence
├──────────────────────────────────────────────────┤
│  Server (Phoenix channels, REST API)              │  ← Relay + coordination
└──────────────────────────────────────────────────┘
```

Two storage backends exist: an encrypted SQLite database in Electron (the primary path) and an IndexedDB fallback for the web client. The web client has reduced functionality — no FTS5 search, no at-rest encryption guarantees beyond browser-level storage.

---

## 2. Key Material Lifecycle

### 2.1 Registration

When a user registers, the client performs full cryptographic identity genesis:

1. Initialize the MLS cipher suite (`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`).
2. Generate a key package to extract the Ed25519 signature key pair.
3. Encrypt the signature private key with the user's password via Argon2id (t=3, m=64MB, p=4) → AES-256-GCM. This encrypted bundle is stored on the server.
4. Generate a 24-word BIP39 recovery mnemonic (32 random bytes + SHA-256 checksum → indices into the standard 2048-word English wordlist). Encrypt the private key again with a key derived from the recovery mnemonic.
5. Upload both encrypted bundles to the server along with the public identity key.
6. Generate 20 MLS key packages (the `KEY_PACKAGE_TARGET`), upload their public portions to the server's key package directory, and store the private portions locally.

The server stores: encrypted key bundle, encrypted recovery bundle, recovery key hash, public identity key. It cannot decrypt any of these.

### 2.2 Login

1. Authenticate with username + password.
2. Server returns the encrypted key bundle (ciphertext, nonce, salt) and public keys.
3. Client decrypts the bundle with the password to recover the signature private key.
4. Both public keys and the encrypted bundle are stored in the local database. The decrypted signature private key is also stored locally — this is safe because the local database is encrypted at rest (see §3).
5. If key package count on the server is below `KEY_PACKAGE_THRESHOLD` (5), replenish up to `KEY_PACKAGE_TARGET` (20) using the stored signature key pair.

### 2.3 Key Package Replenishment

Key packages are MLS's mechanism for asynchronous group joins — each one is single-use. When the server's supply for a user drops below the threshold, the client generates new ones. Each key package is bound to the user's identity (Ed25519 signing key), which is why replenishment requires the stored signature private key.

The private portion of each key package contains three keys:

| Field | Size | Purpose |
|---|---|---|
| `initPrivateKey` | 32 bytes | HPKE init key for key encapsulation |
| `hpkePrivateKey` | 32 bytes | HPKE private key for decryption |
| `signaturePrivateKey` | Variable | Ed25519 signing key |

These are serialized using a versioned binary format (see §5.2) and stored in the `local_key_packages` table.

### 2.4 Recovery

If a user loses their password, the 24-word recovery mnemonic can decrypt their private key bundle. The server stores a hash of the recovery key for verification. Recovery invalidates all existing sessions and requires setting a new password.

---

## 3. Local Database Encryption

### 3.1 How It Works

The local database (`crypto.db`) uses `better-sqlite3-multiple-ciphers`, a drop-in replacement for `better-sqlite3` that adds SQLCipher-compatible encryption. On first launch:

1. Generate 32 random bytes (the database encryption key).
2. Hex-encode the key (64 characters).
3. Encrypt the hex string using Electron's `safeStorage` API, which delegates to the OS keychain (macOS Keychain, GNOME Keyring, KWallet, etc.).
4. Write the encrypted key to `crypto.db.key` alongside the database.

On subsequent launches, the key file is read and decrypted via `safeStorage`. The hex key is applied immediately after opening the database with `PRAGMA key = "x'<hex>'"`.

### 3.2 Migration from Unencrypted

If an existing unencrypted `crypto.db` is detected (probed by attempting to read `PRAGMA schema_version` without a key), the migration path is:

1. Open the unencrypted database read-only.
2. Read all rows from all user tables into memory.
3. Close it and rename to `crypto.db.bak`.
4. Clean up WAL/SHM files.
5. Create a new encrypted database with the generated key.
6. Re-insert all data.

### 3.3 Graceful Degradation

If `safeStorage.isEncryptionAvailable()` returns false (headless Linux without a keychain, CI environments), the database opens without encryption and a warning is logged. This prevents the application from crashing but means the database is not protected at rest in that environment.

### 3.4 Gotchas

- **The key file and database must stay together.** If `crypto.db.key` is deleted, the database becomes unreadable. There is no recovery path — the user must re-login and re-establish all MLS group memberships.
- **`safeStorage` requires the app to be ready.** The `initDb()` call must happen after Electron's `app.whenReady()`.
- **Schema migrations run at startup.** If you add a table or column, add both the `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE` in `initDb()` and update the `SCHEMA_SQL` constant (used by the migration path).
- **The FTS5 virtual table** is created alongside regular tables. It survives the unencrypted-to-encrypted migration because it's defined in `SCHEMA_SQL`. However, its content is ephemeral — it's populated on-the-fly as messages are decrypted for display, not persisted across sessions in a meaningful way.
- **`better-sqlite3-multiple-ciphers` is a native module.** It must be compiled against Electron's Node version. If the native build ever fails in CI or on a platform, the fallback approach is to revert to plain `better-sqlite3` and encrypt individual BLOB columns with Web Crypto before writing them to the database. This is less comprehensive (metadata columns like timestamps remain unencrypted) but avoids the native dependency. The current approach is preferable — only fall back if forced.
- **The `PRAGMA key` syntax is exact.** The key must be passed as `PRAGMA key = "x'<hex>'"` — the outer double quotes and inner `x'...'` hex literal are both required. Getting this wrong produces a silently empty database (SQLite will open successfully but every table will appear to not exist).

---

## 4. MLS Group Management

### 4.1 Group-Channel Mapping

Each text channel, DM conversation, and voice channel maps to one MLS group. The mapping is by ID — a channel with ID `abc-123` has an MLS group with group ID `abc-123`. Voice channels use separate MLS groups from their text counterparts.

### 4.2 Group Lifecycle

**Creation:** The first user to send a message in a channel creates the MLS group. `createGroup()` consumes a local key package, calls `ts-mls.createGroup()`, and persists the resulting `ClientState`.

**Joining:** When a new user sends `mls_request_join` via WebSocket, an existing group member (typically the one online) calls `handleJoinRequest()`. This fetches the joiner's key package from the server directory, calls `addMemberToGroup()`, and broadcasts the resulting Commit + Welcome messages.

**Welcome processing:** The joining user receives the Welcome message and calls `handleWelcome()`, which produces a `ClientState` for the group.

**Commit processing:** All other group members receive the Commit message and call `handleCommit()` to advance their epoch.

**State persistence:** After every operation that modifies `ClientState` (create, join, welcome, commit, encrypt, decrypt), the state is serialized via `encodeGroupState()` and written to the `mls_groups` table.

### 4.3 Ensuring Group Membership

`ensureGroupMembership(channelId)` is the entry point before any encrypt/decrypt operation. It checks three tiers:

1. In-memory `groupStates` map — fastest path.
2. Local database (`mls_groups` table) — deserializes persisted state.
3. Pending welcomes from the server — processes offline-delivered Welcome messages.

If none of these produce a valid state, the user must wait for a group member to process their join request.

### 4.4 Epoch Key Retention

ts-mls manages historical epoch keys internally via `historicalReceiverData` inside `ClientState`. This is configured to retain keys for 64 epochs (the `retainKeysForEpochs` setting, up from the library default of 4). When a message arrives from a past epoch, ts-mls looks up the stored receiver data for that epoch and decrypts without needing the current epoch's state.

The 64-epoch retention window means messages can be decrypted as long as fewer than 64 Commits have advanced the group since the message was sent. For a typical chat with periodic member joins/leaves, this covers hours to days of history. Messages from epochs older than the retention window become permanently undecryptable.

The retention is bounded rather than unlimited because each epoch snapshot adds ~2–5 KB to the serialized state. At 64 epochs, that's roughly 128–320 KB per group — manageable for the SQLite store.

**Why not a separate `epoch_keys` table?** The original design considered extracting minimal epoch key material and storing it in a dedicated table keyed by `(group_id, epoch)`. A spike into the ts-mls source revealed that `processPrivateMessage` requires full `EpochReceiverData` (secret tree, ratchet tree, sender data secret, group context) rather than a single symmetric key — and this data is already stored inside `ClientState.historicalReceiverData`. Extracting and re-injecting it would require manipulating the library's internal structures with no public API support. Using the built-in retention config is simpler, safer, and achieves the same goal. If ts-mls ever exposes an API for standalone epoch decryption, the separate table approach could be revisited.

### 4.5 Concurrency

All state-mutating operations on a group are serialized via a per-group async mutex (`groupLock.ts`). Without this, concurrent encrypt/decrypt/commit operations could read stale state and produce conflicting updates, corrupting the group's key schedule.

The lock is per-channel-ID, so operations on different channels proceed independently. `ensureGroupMembership()` is deliberately *not* locked — it calls `handleWelcome()` internally, which acquires its own lock. Locking `ensureGroupMembership` would deadlock.

### 4.6 Commit Failure Handling

`handleCommit()` retries up to 3 times with exponential backoff (100ms, 500ms, 2s). If all retries fail, the group state is evicted from memory and deleted from the database. The next operation on that channel will trigger `ensureGroupMembership()`, which will attempt to rejoin via pending welcomes or request a fresh join.

---

## 5. Message Encryption

### 5.1 Structured Payload Format

All messages are wrapped in a versioned JSON payload before encryption:

```typescript
// Text message
{ v: 1, type: 'text', text: 'Hello, world!' }

// File message
{ v: 1, type: 'file', text: 'Check this out', file: {
  id: '...', name: 'photo.jpg', content_type: 'image/jpeg',
  size: 12345, key: '<base64 AES key>', iv: '<base64 IV>'
}}
```

The payload is JSON-stringified, then passed to `encryptForChannel()` which MLS-encrypts it. This means file encryption keys travel inside the MLS ciphertext — the server never sees them.

Decoding handles three legacy formats for backward compatibility:
1. **v1 payloads** — parsed normally via the `v` field.
2. **Legacy file envelopes** — JSON objects with `type: 'file'` but no `v` field. Wrapped as v1.
3. **Bare strings** — non-JSON plaintext from before structured payloads. Wrapped as `{ v: 1, type: 'text', text: rawString }`.

### 5.2 Private Key Serialization

Private key packages use a versioned binary format to avoid the fragile fixed-offset slicing of the original implementation:

```
[version: 1 byte][field_count: 1 byte]([length: 2 bytes LE][data: N bytes])...
```

Version 1 has 3 fields: `initPrivateKey`, `hpkePrivateKey`, `signaturePrivateKey`. Deserialization auto-detects legacy format (raw concatenated bytes where byte 0 ≠ 1) and falls back to the old `slice(0,32) / slice(32,64) / slice(64)` pattern.

### 5.3 Encrypt Path

```
User types message
  → encodePayload({ v: 1, type: 'text', text: content })
  → withGroupLock(channelId, ...)
  → encryptMessage(state, payloadString)
    → ts-mls: AEAD encrypt with current epoch key, ratchet state
  → persist new state to mls_groups table
  → base64-encode ciphertext
  → push to WebSocket channel
  → cache ciphertext + epoch to message_cache (never plaintext)
```

### 5.4 Decrypt Path

```
WebSocket delivers encrypted message
  → check LRU decryption cache by message ID
  → if miss: withGroupLock(channelId, ...)
    → decryptMessage(state, ciphertextBytes)
      → ts-mls: look up epoch key, AEAD decrypt, verify Ed25519 signature
    → persist new state
  → decodePayload(plaintext)
  → getDisplayText(payload)
  → populate LRU cache
  → cache ciphertext + epoch to message_cache
  → index plaintext to FTS5 (fire-and-forget)
  → store in messagesByChannel for display
```

### 5.5 Decryption Cache

A 2000-entry LRU cache (`decryptionCache.ts`) prevents re-decrypting messages that have already been shown. The cache is keyed by message ID and holds plaintext strings. It's checked before MLS decryption and populated on success. Entries are evicted on message deletion and updated on message edits.

### 5.6 Message Cache (On-Disk)

The `message_cache` table stores: message ID, channel ID, sender metadata, ciphertext (BLOB), MLS epoch (INTEGER), and timestamp. Plaintext is never written to disk. When loading cached messages, the client must decrypt each one using the channel's current MLS state — if the epoch key has been evicted (older than 64 epochs), the message is unrecoverable from cache.

---

## 6. Encrypted Reactions

Reaction emoji content is encrypted with the channel's MLS group key before sending. The flow:

1. Client encrypts the emoji string via `encryptForChannel()`.
2. Sends `{ message_id, ciphertext, mls_epoch }` to the server.
3. Server stores the reaction with the emoji field set to the sentinel string `"encrypted"` and the ciphertext in a separate column.
4. Server broadcasts the reaction update with the ciphertext.
5. Receiving clients decrypt the ciphertext to recover the emoji.

The server's unique constraint `[:message_id, :sender_id, :emoji]` means a user can have at most one encrypted reaction per message (since all encrypted reactions share the sentinel emoji value). This matches Signal and WhatsApp behavior.

For reaction removal, the server cannot match on emoji content (it's encrypted). Instead, `remove_encrypted_reaction` deletes the most recent reaction from that sender on that message.

**Gotcha:** Each reaction encrypt/decrypt advances the MLS epoch (the key schedule ratchets on every operation). In a busy channel with frequent reactions, this burns through epoch key retention faster.

Plaintext fallback exists for when no MLS group is established — the emoji is sent unencrypted. This should only occur during the brief window before a group is created.

---

## 7. File Encryption

Files are encrypted client-side before upload using AES-256-GCM with a random per-file key and IV (`fileEncryption.ts`). The encrypted file is uploaded to the server, which stores it without the ability to decrypt. The AES key and IV are embedded in the `FilePayload` that gets MLS-encrypted with the message, so the decryption material travels inside the E2EE envelope.

Current limitations:
- Single-shot encryption only — no chunked encryption for large files. Files over ~50 MB may cause memory pressure.
- The file URL is visible to the server (it hosts the encrypted blob). The server knows that a file was shared but cannot read its contents.

---

## 8. Search

Full-text search uses SQLite's FTS5 extension, operating inside the encrypted `crypto.db`. The FTS5 virtual table `message_fts` is populated when messages are decrypted for display — each successful decryption fire-and-forgets an index write with the plaintext content and message metadata.

The search index is:
- **Ephemeral** — it's rebuilt from decrypted messages, not persisted independently. If the database is recreated, the index starts empty and rebuilds as messages are viewed.
- **Electron-only** — the web client's IndexedDB fallback has no-op stubs for FTS operations.
- **Scoped to viewed messages** — only messages that have been decrypted (i.e., the user has scrolled past them) are indexed. Unviewed messages in channels the user hasn't opened won't appear in search results.

The `searchMessages()` function in `messageStore` currently returns empty results — the FTS5 infrastructure is wired but the UI integration is pending.

---

## 9. Dual Storage Backends

### Electron (Primary)

Uses SQLite via `better-sqlite3-multiple-ciphers`. The database is encrypted at rest with a `safeStorage`-protected key. All five tables (identity_keys, mls_groups, local_key_packages, message_cache, message_fts) are available.

IPC path: renderer → `window.cryptoDb` (preload) → `ipcRenderer.invoke` → main process → `db.ts` functions.

### Web Client (Fallback)

Uses IndexedDB via `indexedDbStorage.ts`. Four object stores mirror the SQLite tables (minus FTS5). No at-rest encryption beyond browser-level storage. FTS5 operations are no-ops.

The storage abstraction in `storage.ts` auto-detects the environment: if `window.cryptoDb` exists (Electron preload injected it), use that. Otherwise, fall back to IndexedDB.

---

## 10. Server's Role

The server is a relay and coordination point. It never processes MLS state or accesses plaintext.

**What the server does:**
- Stores and serves encrypted key bundles (login/registration).
- Maintains the key package directory (CRUD for public key packages).
- Relays MLS protocol messages (Commit, Welcome, join requests) via WebSocket.
- Stores pending Welcome messages for offline delivery.
- Stores ciphertext messages and reactions in PostgreSQL.
- Manages channel membership, permissions, and presence.

**What the server knows (metadata):**
- Who is in which channel.
- When messages are sent (timestamps).
- How large messages are (ciphertext size).
- Who reacted to which message (but not which emoji, for encrypted reactions).
- Mentioned user IDs (sent in plaintext for notification routing — documented as an accepted metadata leak).

**What the server cannot know:**
- Message content.
- Reaction emoji.
- File contents (encrypted before upload).
- MLS epoch secrets or encryption keys.

---

## 11. Working with this Code

### Adding a New Encrypted Feature

If you're adding a feature that involves encrypted content (e.g., encrypted typing indicators, encrypted read receipts):

1. Define the payload type in `payload.ts` or create a new type.
2. Encrypt using `encryptForChannel()` in `cryptoStore`.
3. Send the ciphertext + epoch via WebSocket.
4. On the server, relay the ciphertext opaquely — don't parse it.
5. On receive, decrypt via `decryptForChannel()`.
6. Remember: every encrypt/decrypt ratchets the MLS state. High-frequency encrypted operations burn through epoch retention faster.

### Modifying the Database Schema

1. Update the `SCHEMA_SQL` constant in `db.ts` with the new table/column.
2. Add an `ALTER TABLE` migration check in `initDb()` for existing databases.
3. Update `getDb()` query functions.
4. Update the IPC handler in `main/index.ts`.
5. Update the preload bridge in `preload/index.ts`.
6. Update the `CryptoDbApi` interface in `env.d.ts`.
7. Update the storage abstraction in `storage.ts`.
8. Update the IndexedDB fallback in `indexedDbStorage.ts`.

That's seven files for a schema change. The layers exist for security (renderer process cannot access the filesystem directly) but the cost is real.

### Debugging MLS Issues

- **"Failed to process commit"** — usually an epoch mismatch. The client received a Commit for an epoch it's not at. After 3 retries, the group state is evicted and will rejoin.
- **"No key package available for user X"** — the target user has exhausted their server-side key package supply. They need to come online so `replenishKeyPackages()` runs.
- **Decryption returns null** — either the epoch key has been evicted (>64 epochs ago) or the state is corrupted. Check the mls_groups table for the group's current epoch.
- **State corruption** — if MLS state gets into a bad state, `resetGroup(channelId)` evicts it. The next operation will trigger a rejoin. This is the nuclear option.

### Testing

The Electron-specific code (SQLite, safeStorage, IPC) is not covered by the Playwright E2E tests, which test the web client. For crypto correctness, the primary verification path is:
1. Docker build (catches TypeScript compilation errors).
2. Manual testing with two Electron clients.
3. Checking that the server health endpoint responds after migration.

---

## 12. Known Limitations and Future Work

| Area | Current State | Target | Notes |
|---|---|---|---|
| Epoch key lifecycle | Bounded retention (64 epochs) via ts-mls config | Tie epoch key deletion to message lifecycle (delete key when last message from that epoch is gone) | Requires hooking into disappearing message expiry to check if any messages remain for an epoch |
| Search | FTS5 infrastructure wired, UI not connected | Full search UI with results navigation | Index is populated on decrypt — only viewed messages are searchable |
| Large files | Single-shot AES-256-GCM | Chunked encryption (256 KB chunks) for streaming decrypt | Each chunk independently authenticated with chunk index in AAD to prevent reordering |
| Crypto thread | Runs on renderer main thread | Web Worker for symmetric crypto offload | Full `ClientState` likely won't survive `structuredClone`. Recommended fallback: keep MLS state in main thread, offload only AES-GCM encrypt/decrypt to Worker |
| Link previews | Server-side fetching (metadata leak) | Sender-side generation with user opt-out | Sender fetches URL metadata, includes in `MessagePayload.previews`, recipients render without network requests |
| Multi-device | Each device must independently join every MLS group | Shared identity with key sync | No "rejoin all channels" flow exists — each channel rejoins lazily on first visit |
| Key package expiry | No server-side expiration | `expires_at` column + Oban purge job + server rejection of expired packages | |
| Batch removes | Each member leave = separate Commit | Batch Commit with 100ms collection window | Design: start a timer on first leave event, collect additional leaves, issue single batched Remove Commit when timer fires |
| History for new members | No history on join | Encrypted history snapshot (post-v1) | Option C from requirements: adder creates re-encrypted history bundle under Welcome's group secret |
| Group creator race | `groupSetupInProgress` flag prevents double-creation within one client | Server-side first-wins arbitration | Two clients may both create a group simultaneously; server should accept first Commit and reject second |

---

## 13. Security Considerations

### Verified Properties

- **Server blindness**: The server stores only ciphertext. Key material never leaves the client unencrypted (except public keys, by definition).
- **Forward secrecy**: MLS provides forward secrecy through key ratcheting. Compromising a device doesn't reveal past messages (assuming epoch keys have been evicted).
- **Sender authentication**: Every decrypted message is verified against the sender's Ed25519 public key via `verifyFramedContentSignature` in ts-mls. Invalid signatures throw `CryptoVerificationError`.
- **At-rest encryption**: The local database is encrypted with a key that only the OS keychain can decrypt.

### Unverified / Unaudited

- **ts-mls itself**: The library has not undergone a formal security audit. This is a hard gate for production deployment (see pre-release checklist in REQUIREMENTS-E2EE.md).
- **Side-channel resistance**: JavaScript/TypeScript crypto is inherently vulnerable to timing attacks. The `noble` libraries used for low-level primitives are designed to be constant-time, but the MLS state machine in ts-mls has not been analyzed for side channels.
- **Memory safety**: Key material in JavaScript cannot be reliably zeroed. The runtime may copy, move, or retain key bytes in memory unpredictably. The `signature_private_key` column in the local database is the most sensitive long-lived secret.

### Accepted Metadata Leaks

- **Mentioned user IDs** are sent in plaintext alongside the encrypted message, for server-side notification routing.
- **File existence and size** are visible to the server (it stores the encrypted blobs).
- **Timing and frequency** of messages are visible to the server.
- **Channel membership** is server-managed and fully visible.
