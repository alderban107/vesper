# Vesper E2EE Refactor — Implementation Plan

> This document is the authoritative plan for the current PR branch. A new session
> should be able to pick this up cold, read it alongside `DESIGN.md` and
> `REQUIREMENTS-E2EE.md` in this directory, and execute without re-discovery.
>
> **Status**: Planning complete. Implementation not started.
>
> **Decisions made** (by Neon, recorded here):
> - Epoch key retention: **Option A** (ciphertext + per-epoch keys, never store plaintext)
> - History for new members: **Option A** (no history for new members in v1)
> - Mention IDs: **Keep as documented plaintext metadata** for notification routing
> - Reactions: **Encrypt emoji content**
> - Link previews: **Sender-side generation** (most private)

---

## Table of Contents

- [Current State: What's Broken](#current-state-whats-broken)
- [Design Decisions (Resolved)](#design-decisions-resolved)
- [Phase 0: Foundation](#phase-0-foundation)
- [Phase 1: Epoch Key Retention](#phase-1-epoch-key-retention)
- [Phase 2: Message Payload Format](#phase-2-message-payload-format)
- [Phase 3: BIP39 and Key Management](#phase-3-bip39-and-key-management)
- [Phase 4: Concurrency and Reliability](#phase-4-concurrency-and-reliability)
- [Phase 5: Performance](#phase-5-performance)
- [Phase 6: Protocol Correctness](#phase-6-protocol-correctness)
- [Risk Register](#risk-register)
- [Execution Order](#execution-order)
- [File Map](#file-map)

---

## Current State: What's Broken

### 🔴 CRITICAL — These defeat the purpose of E2EE

**C1. `crypto.db` is unencrypted at rest (R-STORE-1)**

File: `client/src/main/db.ts`

`initDb()` opens a plain SQLite database with no encryption. The `mls_groups` table
stores serialized `ClientState` as raw bytes — this contains the epoch secret from
which all message encryption keys are derived. Anyone with filesystem access can read
every group's key material.

**C2. `message_cache` stores decrypted plaintext (R-STORE-2)**

File: `client/src/main/db.ts`, table `message_cache`

After decryption, message content is written to `message_cache.content` as plain TEXT.
The entire message history sits in cleartext on disk. E2EE is meaningless if the
plaintext is right there.

**C3. Login identity storage is broken**

File: `client/src/renderer/src/stores/authStore.ts`, login flow (~line 153)

```ts
await saveIdentity(
  data.user.id,
  bundle.ciphertext,  // ← should be public identity key
  bundle.ciphertext,  // ← should be public key exchange
  bundle.ciphertext,  // ← should be encrypted private keys
  bundle.nonce,
  bundle.salt
)
```

All three key fields are set to `bundle.ciphertext`. The actual public keys from the
server response aren't stored. The local identity record is garbage after login on a
new device.

### 🟠 HIGH — Security bugs or broken functionality

**H1. No epoch key retention (R-EPOCH-1)**

File: `client/src/renderer/src/crypto/mls.ts`, `decryptMessage()`

`decryptMessage` only works against the current `ClientState`. Once a Commit advances
the epoch, all prior messages become permanently undecryptable. The plaintext cache (C2)
hides this — but fixing C2 exposes the problem.

**H2. Fake BIP39 wordlist (R-KEY-2)**

File: `client/src/renderer/src/crypto/identity.ts`, `generateWordlist()`

Creates 2048 pronounceable strings like `bcfod`, `becos` via consonant/vowel
combinatorics. Not recognizable English words, not BIP39-compatible, hard to transcribe.
The code comments say "For production, we embed the actual BIP39 wordlist" but never does.

**H3. Fragile key package private key serialization**

File: `client/src/renderer/src/stores/cryptoStore.ts`, multiple locations

Private key packages are reconstructed by manual byte slicing:
```ts
privatePackage = {
  initPrivateKey: privateData.slice(0, 32),
  hpkePrivateKey: privateData.slice(32, 64),
  signaturePrivateKey: privateData.slice(64)
}
```
No length validation, no format versioning. If ts-mls changes key sizes, this silently
produces wrong keys.

**H4. Key package replenishment doesn't use stored signature key**

File: `client/src/renderer/src/stores/authStore.ts`, `replenishKeyPackages()`

Calls `createKeyPackageBatch(user.username, toGenerate)` without passing the signature
key pair. New key packages get *random* identity keys that don't match the user's
registered identity. They'll fail MLS authentication when consumed.

**H5. No concurrency protection on group state updates**

File: `client/src/renderer/src/stores/cryptoStore.ts`

Multiple async operations (`handleCommit`, `decryptForChannel`, `encryptForChannel`)
all read and write `groupStates[channelId]` without locking. Concurrent operations
can corrupt state or lose updates.

**H6. Silent commit failures**

File: `client/src/renderer/src/stores/cryptoStore.ts`, `handleCommit()`

Catches all errors and logs them, but doesn't retry or signal the UI. If a commit
fails, the user's group state silently diverges. They can't decrypt future messages
with no indication why.

### 🟡 MEDIUM — Correctness and design issues

**M1. Message payload is a bare string (R-FILE-1)**

File: `client/src/renderer/src/crypto/mls.ts`, `encryptMessage()`

`encryptMessage(state, plaintext: string)` encrypts a string. Messages need structured
data: text content, attachment keys/IVs, file references. Currently `fileEncryption.ts`
generates keys that get JSON-encoded into the message text — fragile and conflates
content with metadata.

**M2. Mention user IDs sent in plaintext (R-NOTIF-1)**

File: `client/src/renderer/src/stores/messageStore.ts`, `sendMessage()`

`mentioned_user_ids` extracted via regex and sent as a plaintext field alongside
ciphertext. The server sees exactly who was mentioned. **Decision: Accept as documented
metadata leak.**

**M3. Reactions are unencrypted (R-REACT-1)**

File: `client/src/renderer/src/stores/messageStore.ts`, `addReaction()`/`removeReaction()`

Emoji sent as plaintext. Server sees every reaction. **Decision: Encrypt in Phase 6.**

**M4. All crypto runs on the renderer main thread (R-PERF-1)**

All MLS operations (`decryptMessage`, `encryptMessage`, `processCommitMessage`) run
synchronously in the renderer. Will block UI for large channels.

**M5. No FTS5 search (R-SEARCH-1)**

File: `client/src/main/db.ts`, `searchMessages()`

Uses `LIKE '%query%'` — no ranking, no tokenization, no performance.

**M6. Key package private data stored unencrypted (R-STORE-3)**

`local_key_packages.key_package_private` stores raw HPKE private keys. Same crypto.db
encryption gap as C1 — fixed when C1 is fixed.

---

## Design Decisions (Resolved)

### Epoch Key Retention: Option A

Store ciphertext locally (never plaintext). Maintain an `epoch_keys` table in
`crypto.db` keyed by `(group_id, epoch)`. Decrypt on display from ciphertext + epoch
key. Delete epoch keys when all messages from that epoch are gone.

This preserves forward secrecy semantics and supports history display.

### History for New Members: No History (v1)

New members joining a channel cannot decrypt messages from before they joined. This is
correct MLS behavior. Communicate clearly in the UI: "Messages from before you joined
aren't available on this device."

Build hooks for Option C (history snapshot on join) later if there's demand.

### Mention IDs: Accepted Metadata Leak

Keep `mentioned_user_ids` as plaintext in the WebSocket payload for notification
routing. Document explicitly as a known metadata disclosure.

### Reactions: Encrypt Emoji Content

Encrypt the emoji string with the current MLS group key. Server only knows "user X
reacted to message Y" but not which emoji. Clients compute aggregate counts locally.

### Link Previews: Sender-Side Generation

Sender's client fetches the URL, renders a preview (title, description, image), and
includes it in the encrypted message payload. Server never learns which URLs are shared.
Receiver-side rendering as fallback. The existing `/link-preview` server endpoint gets
deprecated.

---

## Phase 0: Foundation

**Goal**: Encrypt the local database and fix the identity bug. Everything else builds
on this.

### 0.1 Encrypt `crypto.db`

**What**: Replace `better-sqlite3` with `better-sqlite3-multiple-ciphers` (drop-in
compatible, adds SQLCipher support).

**How**:
1. `npm uninstall better-sqlite3 && npm install better-sqlite3-multiple-ciphers`
2. On first launch: generate a random 256-bit key, encrypt it with Electron
   `safeStorage`, store encrypted key to a file alongside the DB (e.g.,
   `crypto.db.key`)
3. On DB open: read the key file, decrypt with `safeStorage`, open DB with
   `db.pragma("key = 'x''<hex-encoded-key>'")`
4. **Migration**: if an unencrypted `crypto.db` exists (detect by trying to open
   without a key), read all data, create a new encrypted DB, write data, delete old file

**Footguns**:
- `safeStorage` requires OS keychain. On Linux without a keychain service,
  `safeStorage.isEncryptionAvailable()` returns false. **Fallback**: prompt user for a
  local passphrase and derive key with Argon2id. Check `safeStorage.isEncryptionAvailable()`
  at startup and branch accordingly.
- The web client uses IndexedDB, which has no encryption. For the web client, skip
  message caching entirely (memory-only) and document as a known limitation.
- `better-sqlite3-multiple-ciphers` must build for Electron's Node version. **Test this
  build immediately** — if it fails, fallback plan is encrypting individual BLOB columns
  with Web Crypto before writing to plain SQLite.

**Files to modify**:
- `client/package.json` — dependency swap
- `client/src/main/db.ts` — key management, `PRAGMA key`, migration logic
- `client/src/main/index.ts` — safeStorage availability check, key file path

### 0.2 Fix Login Identity Storage

**What**: Use actual public keys from server response, not `bundle.ciphertext`.

**How**:
1. Verify the server's `/auth/login` response includes `public_identity_key` and
   `public_key_exchange` fields. Check `server/lib/vesper_web/controllers/auth_controller.ex`.
2. In `authStore.ts` login flow, replace the broken `saveIdentity` call:
   ```ts
   await saveIdentity(
     data.user.id,
     base64ToUint8(data.public_identity_key),
     base64ToUint8(data.public_key_exchange),
     bundle.ciphertext,
     bundle.nonce,
     bundle.salt
   )
   ```
3. If the server doesn't return these fields on login, add them to the login response.

**Files to modify**:
- `client/src/renderer/src/stores/authStore.ts` — login flow
- Possibly `server/lib/vesper_web/controllers/auth_controller.ex` — login response

### 0.3 Versioned Private Key Serialization

**What**: Replace brittle `slice(0, 32)` byte slicing with a proper serialization format.

**How**:
1. Define serialize/deserialize functions in a new utility (or in `crypto/types.ts`):
   ```ts
   // Format: [version: 1 byte][field_count: 1 byte]
   //         [len1: 2 bytes LE][data1][len2: 2 bytes LE][data2]...
   function serializePrivatePackage(pkg: PrivateKeyPackage): Uint8Array
   function deserializePrivatePackage(data: Uint8Array): PrivateKeyPackage
   ```
2. Replace every `privateData.slice(0, 32)` pattern in `cryptoStore.ts` with
   `deserializePrivatePackage(privateData)`
3. Replace every `new Uint8Array([...initPrivateKey, ...hpkePrivateKey, ...signaturePrivateKey])`
   with `serializePrivatePackage(pkg)`
4. Add length validation — if deserialization produces keys of unexpected length, throw
   rather than silently returning garbage

**Files to modify**:
- `client/src/renderer/src/crypto/types.ts` — new serialize/deserialize functions
- `client/src/renderer/src/stores/cryptoStore.ts` — all `slice()` patterns
- `client/src/renderer/src/stores/authStore.ts` — key package storage in register/login

---

## Phase 1: Epoch Key Retention

**Goal**: Decouple message history from plaintext caching. Messages are stored as
ciphertext and decrypted on demand using retained epoch keys.

### ⚠️ Prerequisite: ts-mls Spike

Before implementing, investigate ts-mls internals to answer:

**Can we decrypt a message using only stored epoch key material, without the full
`ClientState`?**

`processPrivateMessage` in ts-mls takes a full `ClientState`. If there's no way to
decrypt with a subset (e.g., just the epoch secret + encryption secret), we must store
full serialized `ClientState` snapshots per epoch. This is much more expensive in
storage but still viable.

**Investigation steps**:
1. Read ts-mls source: how does `processPrivateMessage` use the state? Which fields
   from `keySchedule` are actually needed?
2. Check if `keySchedule.encryptionSecret` (or `senderDataSecret` + `handshakeSecret`)
   alone is sufficient to derive message decryption keys
3. If not, check `decodeGroupState` / `encodeGroupState` — can we store a minimal state
   snapshot?
4. If full state is required: measure serialized state size for a typical group.
   If < 100KB per epoch, storing per-epoch snapshots is acceptable.

**If epoch-key-only decryption is possible**:

### 1.1 Add `epoch_keys` Table

```sql
CREATE TABLE epoch_keys (
  group_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  key_material BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, epoch)
);
```

**Files to modify**: `client/src/main/db.ts`

### 1.2 Extract Epoch Keys on State Advance

After processing a Commit (in `handleCommit`, `handleWelcome`, `addMemberToGroup`),
before the old state is discarded:

1. Extract the minimum key material from the *outgoing* state
2. Store in `epoch_keys` via the preload bridge
3. Then update to the new state

Add new preload/IPC methods:
- `cryptoDb.setEpochKey(groupId, epoch, keyMaterial)`
- `cryptoDb.getEpochKey(groupId, epoch)`
- `cryptoDb.deleteEpochKey(groupId, epoch)`
- `cryptoDb.deleteEpochKeysForGroup(groupId)`

**Files to modify**:
- `client/src/main/db.ts` — new table, new CRUD functions
- `client/src/preload/index.ts` — expose new IPC methods
- `client/src/renderer/src/crypto/storage.ts` — new storage functions
- `client/src/renderer/src/stores/cryptoStore.ts` — extract keys in handleCommit, etc.

**If full state snapshots are required instead**: Store serialized `ClientState` per
epoch in the same table. The `key_material` column becomes the full state blob. Decrypt
function loads the snapshot, deserializes, decrypts, discards.

### 1.3 Convert Message Cache to Ciphertext

**Schema change**:
```sql
-- Replace message_cache table
CREATE TABLE message_cache (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  sender_id TEXT,
  sender_username TEXT,
  ciphertext BLOB NOT NULL,       -- raw MLS ciphertext (was: content TEXT)
  mls_epoch INTEGER NOT NULL,     -- epoch for key lookup (new)
  inserted_at TEXT NOT NULL
);
CREATE INDEX idx_message_cache_channel ON message_cache(channel_id);
```

**Migration**: Drop and recreate the table. Existing plaintext cache is lost (one-time,
documented in release notes).

**Display flow**:
1. Load ciphertext + epoch from local cache
2. Look up epoch key from `epoch_keys`
3. Decrypt in memory
4. Display
5. Hold decrypted content in an in-memory LRU cache (not persisted)

**Files to modify**:
- `client/src/main/db.ts` — schema change, update `cacheMessage` / `getCachedMessages`
- `client/src/preload/index.ts` — update IPC signatures
- `client/src/renderer/src/crypto/storage.ts` — update cache functions
- `client/src/renderer/src/stores/messageStore.ts` — decrypt-on-display logic
- `client/src/renderer/src/crypto/indexedDbStorage.ts` — matching schema change

### 1.4 Epoch Key Cleanup

When the last message from an epoch is deleted from local cache, delete that epoch's
key:

1. On message deletion (disappearing or manual), check if any other messages in cache
   share the same `(channel_id, mls_epoch)`
2. If count = 0, delete from `epoch_keys`

Implement as a post-delete hook in the cache cleanup logic.

**Files to modify**:
- `client/src/main/db.ts` — add `countMessagesForEpoch()`, cleanup logic
- `client/src/renderer/src/stores/messageStore.ts` — call cleanup after delete

---

## Phase 2: Message Payload Format

**Goal**: Structured encrypted payloads that carry attachments, metadata, and future
extensions.

### 2.1 Define Payload Schema

```typescript
// client/src/renderer/src/crypto/payload.ts (new file)

interface TextPayload {
  v: 1
  type: 'text'
  text: string
}

interface FilePayload {
  v: 1
  type: 'file'
  text?: string  // optional caption
  attachments: Array<{
    id: string           // server attachment ID
    name: string
    content_type: string
    size: number
    key: string          // base64 AES-256-GCM key
    iv: string           // base64 IV
  }>
}

type MessagePayload = TextPayload | FilePayload

function encodePayload(payload: MessagePayload): Uint8Array
function decodePayload(bytes: Uint8Array): MessagePayload
// If decoding fails or no `v` field, return { v: 0, type: 'text', text: rawString }
// for backward compatibility with pre-format messages
```

### 2.2 Update Encrypt/Decrypt Pipeline

- `encryptForChannel` accepts `MessagePayload` (or a convenience overload for plain
  text strings)
- JSON-serialize → UTF-8 encode → MLS encrypt
- `decryptForChannel` returns `MessagePayload`
- MLS decrypt → UTF-8 decode → JSON parse → validate → return typed payload
- **Backward compat**: if JSON parse fails or no `v` field, wrap in
  `{ v: 0, type: 'text', text: rawString }`

### 2.3 Move File Encryption Keys Into Payload

Currently `fileEncryption.ts` generates AES keys that get embedded in a JSON string in
the message `content` field. After this change:

1. Client encrypts file with `encryptFile()` (existing)
2. Client uploads encrypted blob to server (existing)
3. Client constructs a `FilePayload` with the attachment ID + AES key + IV
4. `FilePayload` is MLS-encrypted as the message ciphertext
5. Server never sees file decryption keys

The existing `parseMessageContent()` function in `messageStore.ts` and `FilePreview.tsx`
need updating to work with the new payload format.

**Files to modify**:
- New: `client/src/renderer/src/crypto/payload.ts`
- `client/src/renderer/src/crypto/mls.ts` — update `encryptMessage`/`decryptMessage`
  signatures (or add new functions alongside)
- `client/src/renderer/src/stores/cryptoStore.ts` — update encrypt/decrypt methods
- `client/src/renderer/src/stores/messageStore.ts` — update send/receive/display logic,
  `parseMessageContent()`, `processIncomingMessage()`
- `client/src/renderer/src/components/chat/FilePreview.tsx` — consume new payload format
- `client/src/renderer/src/components/chat/MessageItem.tsx` — render from payload

---

## Phase 3: BIP39 and Key Management

**Goal**: Correct recovery keys, correct key package lifecycle.

### 3.1 Bundle Actual BIP39 Wordlist

1. Download the official BIP39 English wordlist (2048 words)
2. Bundle as a static TypeScript constant:
   ```ts
   // client/src/renderer/src/crypto/bip39-wordlist.ts
   export const BIP39_ENGLISH: readonly string[] = [
     'abandon', 'ability', 'able', /* ... 2048 words ... */
   ] as const
   ```
3. Replace `generateWordlist()` in `identity.ts` with an import of this constant
4. Delete all the consonant/vowel generation code

**Breaking change**: Existing recovery keys become invalid. Users must generate a new
recovery key on next login. The UI should detect this (e.g., a flag in local storage
or a version field in the recovery bundle) and prompt re-generation. Document in release
notes.

**Files to modify**:
- New: `client/src/renderer/src/crypto/bip39-wordlist.ts`
- `client/src/renderer/src/crypto/identity.ts` — replace `getWordlist()` /
  `generateWordlist()`

### 3.2 Fix Key Package Replenishment

**Problem**: `replenishKeyPackages()` generates key packages without the user's
signature key pair, so they have random identities.

**Solution**:
1. On login, after decrypting the key bundle, store the decrypted signature private key
   in the encrypted local DB (it's already encrypted at rest after Phase 0)
2. Add a `getSignatureKeyPair()` function to the storage layer
3. `replenishKeyPackages()` loads the stored key pair and passes it to
   `createKeyPackageBatch()`

**Alternative**: Re-derive from password on each replenishment. Worse UX (might need to
prompt for password) but avoids storing the decrypted private key. The encrypted DB
approach is better since the DB is now encrypted (Phase 0).

**Files to modify**:
- `client/src/main/db.ts` — add `signature_keys` table or column
- `client/src/preload/index.ts` — expose new IPC
- `client/src/renderer/src/crypto/storage.ts` — new storage functions
- `client/src/renderer/src/stores/authStore.ts` — store key on login, load in
  `replenishKeyPackages()`

### 3.3 Key Package Expiration

1. Server: add `expires_at TIMESTAMPTZ` column to `key_packages` table
2. Server: reject expired key packages on fetch (`WHERE expires_at > NOW()`)
3. Client: set expiration based on `defaultLifetime` from ts-mls when generating
4. Server: Oban job to purge expired key packages

**Files to modify**:
- New migration in `server/priv/repo/migrations/`
- `server/lib/vesper/encryption.ex` — expiration filtering
- `server/lib/vesper/encryption/key_package.ex` — schema update
- `server/lib/vesper/workers/purge_key_packages.ex` — purge expired too

---

## Phase 4: Concurrency and Reliability

**Goal**: Group state operations are serialized and resilient.

### 4.1 Per-Group Async Mutex

Create a simple async lock mechanism:

```ts
// client/src/renderer/src/crypto/groupLock.ts (new file)
class GroupLock {
  private locks = new Map<string, Promise<void>>()

  async acquire(groupId: string): Promise<() => void> {
    while (this.locks.has(groupId)) {
      await this.locks.get(groupId)
    }
    let release: () => void
    const promise = new Promise<void>(r => { release = r })
    this.locks.set(groupId, promise)
    return () => {
      this.locks.delete(groupId)
      release!()
    }
  }
}
```

Wrap all state-mutating operations in `cryptoStore.ts` with the lock:
- `encryptForChannel`
- `decryptForChannel`
- `handleCommit`
- `handleWelcome`
- `handleJoinRequest`
- `createGroup`

**Files to modify**:
- New: `client/src/renderer/src/crypto/groupLock.ts`
- `client/src/renderer/src/stores/cryptoStore.ts` — wrap all state mutations

### 4.2 Commit Retry with Backoff

If `handleCommit` fails (epoch mismatch, corrupted state):

1. Log the failure with details
2. Queue the commit for retry (max 3 attempts, exponential backoff: 100ms, 500ms, 2s)
3. If all retries fail: reset the group state and request a fresh Welcome via
   `mls_request_join`
4. Surface the error to the UI (toast notification: "Encryption state resynchronizing")

If a commit *we sent* is rejected (another member committed first):
1. Fetch and process the winning commit
2. Retry our operation (send message, add member, etc.)

**Files to modify**:
- `client/src/renderer/src/stores/cryptoStore.ts` — retry logic in `handleCommit`
- `client/src/renderer/src/stores/messageStore.ts` — handle commit rejection in
  `sendMessage`

### 4.3 Batch Remove Commits (R-MEMBER-1)

Client-side batching window:

1. When a member leave event arrives, don't issue a Remove Commit immediately
2. Start a 100ms timer
3. Collect all additional leave events during the window
4. Issue a single Commit with all Remove proposals batched

Server-side coordination (future, not blocking):
- Server could signal "these N users left" in a single event
- One designated client issues the batched commit

**Files to modify**:
- `client/src/renderer/src/stores/cryptoStore.ts` — new `batchRemove()` with timer
- `client/src/renderer/src/stores/messageStore.ts` — use batched remove on
  `mls_remove` events

---

## Phase 5: Performance

**Goal**: Crypto off the main thread, lazy decryption, proper search.

### 5.1 Crypto Web Worker

Create a dedicated Web Worker for MLS operations:

1. New file: `client/src/renderer/src/crypto/crypto-worker.ts`
2. Move `encryptMessage`, `decryptMessage`, `processCommitMessage` into the worker
3. Communication via `postMessage` with transferable `ArrayBuffer`s
4. The worker holds `ClientState` objects in its own memory

**Footgun**: ts-mls `ClientState` may contain non-transferable objects (closures, class
instances). If so:
- **Fallback**: Keep state in main thread. Serialize the state + ciphertext, send to
  worker for the heavy crypto (AES-GCM, HPKE), return result. The worker does the
  CPU-intensive part without holding state.
- Test `structuredClone(clientState)` to see if it survives.

Pattern follows the existing `e2ee-worker.ts` for voice encryption.

**Files to modify**:
- New: `client/src/renderer/src/crypto/crypto-worker.ts`
- `client/src/renderer/src/stores/cryptoStore.ts` — route operations through worker

### 5.2 Lazy Decryption on Scroll (R-PERF-1)

1. On channel open: load 50 most recent ciphertext blobs from local cache
2. Decrypt only visible messages (integration with virtualized list)
3. As user scrolls up: fetch + decrypt next batch
4. In-memory LRU cache (capacity: ~500 messages per channel) for recently decrypted
   messages

**Files to modify**:
- `client/src/renderer/src/stores/messageStore.ts` — lazy loading logic
- `client/src/renderer/src/components/chat/MessageList.tsx` — virtualized scroll
  integration

### 5.3 FTS5 Search Index (R-SEARCH-1)

1. Add FTS5 virtual table in `crypto.db`:
   ```sql
   CREATE VIRTUAL TABLE message_fts USING fts5(
     id, channel_id, content,
     content='message_cache',
     content_rowid='rowid'
   );
   ```
2. Populate on decrypt: when a message is decrypted for display, insert into FTS5
3. Search queries use FTS5 `MATCH` instead of `LIKE`
4. The FTS5 index is encrypted at rest (inside `crypto.db`, which is encrypted per
   Phase 0)

**Files to modify**:
- `client/src/main/db.ts` — FTS5 table, insert triggers, search function
- `client/src/renderer/src/crypto/indexedDbStorage.ts` — web fallback (keep existing
  `LIKE` filter approach for IndexedDB)

---

## Phase 6: Protocol Correctness

**Goal**: Remaining requirements alignment.

### 6.1 Encrypt Reaction Emoji (R-REACT-1)

1. On `addReaction`: encrypt emoji string with current MLS group key
2. Send `{ message_id, ciphertext, mls_epoch }` instead of `{ message_id, emoji }`
3. Server stores encrypted emoji + epoch
4. On receive: decrypt emoji, compute aggregate counts client-side
5. Server schema already has `ciphertext` and `mls_epoch` columns on `reactions` — use
   them

**Footgun**: Each reaction is a separate encrypt/decrypt. For messages with many
reactions, this adds up. Acceptable for v1 given typical reaction counts (< 20 per
message).

**Files to modify**:
- `client/src/renderer/src/stores/messageStore.ts` — `addReaction`, `removeReaction`,
  `handleReactionUpdate`
- `client/src/renderer/src/stores/cryptoStore.ts` — add `encryptReaction` /
  `decryptReaction` helpers
- Server channel handlers — accept encrypted reactions alongside plaintext (backward
  compat)

### 6.2 Sender-Side Link Previews (R-LINK-1)

1. When a message contains a URL, the sender's client fetches metadata (title,
   description, image)
2. Include preview data in the structured `MessagePayload` (Phase 2):
   ```ts
   interface MessagePayload {
     // ...existing fields...
     previews?: Array<{
       url: string
       title?: string
       description?: string
       image_url?: string
       site_name?: string
     }>
   }
   ```
3. Recipients render previews from the payload without making network requests
4. Add a user setting to disable automatic URL fetching (R-LINK-2)
5. Deprecate the server-side `/link-preview` endpoint (or keep as opt-in fallback)

**Footgun**: Sender's IP is exposed to the URL's host. Acceptable (they visited the
link) but document it.

**Files to modify**:
- `client/src/renderer/src/crypto/payload.ts` — extend payload type
- `client/src/renderer/src/stores/messageStore.ts` — fetch previews before send
- `client/src/renderer/src/components/chat/LinkPreview.tsx` — render from payload
- `client/src/renderer/src/components/chat/MessageInput.tsx` — URL detection + fetch
- `client/src/renderer/src/stores/settingsStore.ts` — preview fetch toggle

### 6.3 Verify MLS Sender Authentication

Audit that `processPrivateMessage` in ts-mls verifies the sender's Ed25519 signature.
If it doesn't, add explicit verification. This is a pre-release security checklist item
but should be confirmed during the refactor.

**Action**: Read ts-mls source code for `processPrivateMessage`. Document finding.

---

## Risk Register

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| ts-mls doesn't support epoch-key-only decryption | Phase 1 scope increases (store full state per epoch) | Medium | Spike before starting Phase 1. If confirmed, store full serialized `ClientState` per epoch — viable if < 100KB per snapshot |
| `better-sqlite3-multiple-ciphers` doesn't build for Electron's Node version | Phase 0 blocked | Low | Test build immediately. Fallback: encrypt BLOB columns individually with Web Crypto |
| `safeStorage` unavailable on headless Linux / CI | Tests break, some Linux users affected | Medium | Check `isEncryptionAvailable()` at startup, fall back to password-derived key |
| BIP39 migration invalidates existing recovery keys | Users can't recover with old keys | Certain | Force re-generation on first login after upgrade. Show clear warning. Document in release notes |
| Web Worker can't hold ts-mls `ClientState` | Phase 5 partially blocked | Medium | Keep state in main thread, offload only symmetric crypto to worker |
| Batch commit coordination needs server-side changes | Phase 4 requires backend work | Low | Start with client-side 100ms batching window; server coordination is future work |
| Concurrent epoch advances during Phase 1 migration | Edge case data corruption | Low | Acquire group lock before any epoch key extraction; handle gracefully if old state already gone |

---

## Execution Order

Phases are ordered by dependency and impact:

1. **Phase 0** — Do first. Everything else depends on encrypted storage and correct
   identity.
2. **Phase 1** — But spike on ts-mls epoch key extraction *before* starting
   implementation. If not feasible, fall back to full-state snapshots.
3. **Phase 3** — BIP39 and key management. Independent of other phases, low risk, high
   correctness impact.
4. **Phase 2** — Structured payload. Unblocks proper file encryption and future features.
5. **Phase 4** — Concurrency and reliability. Important for correctness under real
   multi-user load.
6. **Phase 5** — Performance. Not urgent until real users exist.
7. **Phase 6** — Protocol polish. Important but not blocking.

Within each phase, items are numbered in implementation order.

---

## File Map

Quick reference for which files are touched and when.

### Client — Main Process
| File | Phases |
|------|--------|
| `client/src/main/db.ts` | 0, 1, 5 |
| `client/src/main/index.ts` | 0 |

### Client — Preload
| File | Phases |
|------|--------|
| `client/src/preload/index.ts` | 1, 3 |

### Client — Crypto Layer
| File | Phases |
|------|--------|
| `client/src/renderer/src/crypto/mls.ts` | 2 |
| `client/src/renderer/src/crypto/identity.ts` | 3 |
| `client/src/renderer/src/crypto/storage.ts` | 0, 1, 3 |
| `client/src/renderer/src/crypto/types.ts` | 0 |
| `client/src/renderer/src/crypto/fileEncryption.ts` | 2 |
| `client/src/renderer/src/crypto/indexedDbStorage.ts` | 1, 5 |
| New: `crypto/payload.ts` | 2, 6 |
| New: `crypto/groupLock.ts` | 4 |
| New: `crypto/crypto-worker.ts` | 5 |
| New: `crypto/bip39-wordlist.ts` | 3 |

### Client — Stores
| File | Phases |
|------|--------|
| `client/src/renderer/src/stores/cryptoStore.ts` | 0, 1, 2, 4, 6 |
| `client/src/renderer/src/stores/authStore.ts` | 0, 3 |
| `client/src/renderer/src/stores/messageStore.ts` | 1, 2, 4, 5, 6 |
| `client/src/renderer/src/stores/settingsStore.ts` | 6 |

### Client — Components
| File | Phases |
|------|--------|
| `client/src/renderer/src/components/chat/MessageList.tsx` | 5 |
| `client/src/renderer/src/components/chat/MessageItem.tsx` | 2 |
| `client/src/renderer/src/components/chat/FilePreview.tsx` | 2 |
| `client/src/renderer/src/components/chat/LinkPreview.tsx` | 6 |
| `client/src/renderer/src/components/chat/MessageInput.tsx` | 6 |

### Server
| File | Phases |
|------|--------|
| `server/lib/vesper/encryption.ex` | 3 |
| `server/lib/vesper/encryption/key_package.ex` | 3 |
| `server/lib/vesper/workers/purge_key_packages.ex` | 3 |
| `server/lib/vesper_web/controllers/auth_controller.ex` | 0 |
| New migration | 3 |

### Config / Dependencies
| File | Phases |
|------|--------|
| `client/package.json` | 0 |
