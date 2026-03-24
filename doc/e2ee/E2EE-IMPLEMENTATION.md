# E2EE Implementation Guide

This document describes how Vesper's end-to-end encryption works as currently implemented, how to work with it as a developer, and where the sharp edges are. Use it together with [PROTOCOL.md](../PROTOCOL.md), [doc/sdk/encryption.md](../sdk/encryption.md), [E2EE-CORRECTNESS-PLAN.md](../E2EE-CORRECTNESS-PLAN.md), and [DESIGN.md](../DESIGN.md). This document covers what the system actually does right now, in enough detail to modify it without breaking things.

Last updated after the OpenMLS migration, durable checkpoint work, and SDK-owned repair move on `fix/mls-e2e-handshake`.

---

## 1. Architecture Overview

Vesper's E2EE uses the MLS protocol (RFC 9420) via OpenMLS packaged as `vesper-openmls-wasm`. The design principle is still that the server is cryptographically blind: it stores and relays opaque ciphertext plus MLS coordination artifacts, but never has access to plaintext content or encryption keys.

The system has four layers:

```
┌──────────────────────────────────────────────────┐
│  UI stores + SDK client runtime                    │  ← Orchestration
├──────────────────────────────────────────────────┤
│  Crypto (OpenMLS WASM, identity, payload, lock)  │  ← Cryptographic operations
├──────────────────────────────────────────────────┤
│  Storage (scope checkpoints + message caches)     │  ← Persistence
├──────────────────────────────────────────────────┤
│  Server (Phoenix channels, REST APIs)             │  ← Relay + coordination
└──────────────────────────────────────────────────┘
```

Two storage backends exist: an encrypted SQLite database in Electron (the primary path) and an IndexedDB fallback for the web client. The SDK now stores per-scope checkpoints that bundle serialized group state, durable replay cursors, and pending control-plane outbox entries so restart and reconnect recovery can resume deterministically.

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

**Creation:** The first user to need encryption in a scope can create the MLS group. `createGroup()` consumes a local key package, initializes a new OpenMLS-backed `GroupState`, and persists it inside the scope checkpoint. A `pendingGroupCreations` Map prevents concurrent calls from creating duplicate groups for the same scope. The consumed key package is also marked consumed on the server so stale packages are not handed out later.

For channels, only the channel owner creates the group (via `ensureChannelGroupReady`). For DMs, deterministic leader election decides: the participant with the lower UUID creates the group.

**Joining (channels):** When a user enters a channel that already has published GroupInfo, the SDK prefers External Commit. The joining client fetches `GET /api/v1/group-info/:scope`, builds an External Commit locally, and the server atomically stores the new GroupInfo plus the durable `mls_commit` event before advertising success. If GroupInfo does not exist yet, the owner-gated bootstrap path still creates the first group and publishes the first epoch.

**Joining (DMs):** DMs still use deterministic leader election when there is no published GroupInfo yet, but late or restarting devices recover through the same SDK-owned External Commit, durable replay, and same-user history-repair machinery used elsewhere. Missed `mls_request_join_all` events are replayed durably so a late DM participant can still converge.

**Welcome processing:** The joining user receives the Welcome message and calls `handleWelcome()`, which tries local key packages until one matches. On success, it produces an OpenMLS-backed `GroupState` for the scope and processes any pending commits that arrived before the Welcome.

**Commit processing:** All other group members receive the Commit message and call `handleCommit()` to advance their epoch.

**State persistence:** After every operation that modifies the scope state, the SDK updates the serialized group state plus the scope checkpoint. The checkpoint includes the durable MLS replay cursor, recent commit fingerprints, repair state, and pending outbox work such as GroupInfo publish, External Commit broadcast, and sponsored transitions.

### 4.3 Ensuring Group Membership

`ensureGroupMembership(scopeId)` is the entry point before any encrypt or decrypt operation. It checks three tiers:

1. In-memory `groupStates` map — fastest path.
2. Local checkpoint storage — restores the persisted group state, replay cursor, and pending outbox entries.
3. Recovery artifacts from the server — pending welcomes, durable MLS replay, pending resync requests, pending history requests, and pending history bundles.

If none of these produce a valid state, the SDK enters repair instead of leaving the scope silently wedged.

### 4.4 Recovery and replay

The current implementation treats replay and repair as SDK-owned lifecycle work:

- `replayDurableEvents()` replays durable MLS commits by server `seq`
- `processPendingRepairArtifacts()` drains resync requests, history requests, and history bundles
- reconnect and restart restore per-scope checkpoints before attempting new work
- same-user repair is scoped and durable instead of being driven by renderer-only code

### 4.5 Concurrency

All state-mutating operations on a group are serialized via a per-group async mutex (`groupLock.ts`). Without this, concurrent encrypt/decrypt/commit operations could read stale state and produce conflicting updates, corrupting the group's key schedule.

The lock is per-channel-ID, so operations on different channels proceed independently. `ensureGroupMembership()` is deliberately *not* locked — it calls `handleWelcome()` internally, which acquires its own lock. Locking `ensureGroupMembership` would deadlock.

### 4.6 Commit failure handling

Commit handling now distinguishes applied, already-applied, buffered, and repair-needed states instead of collapsing everything to a generic boolean failure. Duplicate durable commits can safely advance the replay cursor, while stale or conflicting local state moves the scope into repair.

### 4.7 OpenMLS integration notes

The `sdk/src/crypto/mls.ts` layer now wraps OpenMLS via WASM:

- no `decodeMlsMessage(..., offset)` footgun
- full serialized state round-trips through the SDK storage layer
- full RFC 9420 External Commit support
- audited cryptographic core from OpenMLS, while the Vesper orchestration and storage integration remain product-specific code that still needs normal review

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
    → OpenMLS: AEAD encrypt with current scope state
  → persist updated scope checkpoint
  → base64-encode ciphertext
  → push to WebSocket channel
  → cache ciphertext + epoch to message_cache (never plaintext)
  → cache ciphertext → plaintext mapping in sent-message LRU (for self-decrypt)
```

### 5.4 Decrypt Path

```
WebSocket delivers encrypted message
  → check LRU decryption cache by message ID
  → if miss: check sent-message cache by ciphertext base64
  → if miss: withGroupLock(channelId, ...)
    → decryptMessage(state, ciphertextBytes)
      → OpenMLS: decrypt, authenticate sender, update scope state
    → persist updated scope checkpoint
  → decodePayload(plaintext)
  → getDisplayText(payload)
  → populate LRU cache
  → cache ciphertext + epoch to message_cache
  → index plaintext to FTS5 (fire-and-forget)
  → store in messagesByChannel for display
```

### 5.5 Decryption Cache

A 2000-entry LRU cache (`decryptionCache.ts`) prevents re-decrypting messages that have already been shown. The cache is keyed by message ID and holds plaintext strings. It's checked before MLS decryption and populated on success. Entries are evicted on message deletion and updated on message edits.

A separate sent-message cache handles a fundamental MLS constraint: senders cannot always decrypt their own echoed ciphertexts after ratchet advancement. When the server echoes the message back via WebSocket, the sender's local state may already have moved past the needed generation. Other group members decrypt the message normally; only the sender needs the plaintext cache.

The sent-message cache maps `ciphertext_base64 → plaintext`, is populated at encrypt time, and is persisted through the storage runtime. On the receive path, `processIncomingMessage()`, `handleReactionUpdate()`, and `handleMessageEdited()` all check this cache before attempting MLS decryption or repair.

### 5.6 Message Cache (On-Disk)

The `message_cache` table stores message ID, scope metadata, ciphertext, cached plaintext when available, MLS epoch, and timestamps. If direct decrypt fails on older data, the SDK can fall back to same-user history repair instead of relying only on a fixed historical-epoch window.

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
2. Encrypt using the SDK encrypted chat runtime (`sendPayload()` / `sendText()` in
   `sdk/src/client/encryptedChat.ts`).
3. Send the ciphertext + epoch via WebSocket.
4. On the server, relay the ciphertext opaquely — don't parse it.
5. On receive, decrypt via the SDK encrypted chat runtime.
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

- **"Failed to process commit"** — usually a stale local checkpoint, out-of-order replay, or a real divergence. Check whether the scope has already entered repair and whether the durable replay cursor is advancing.
- **"No key package available for user X"** — the target user has exhausted their server-side key package supply. They need to come online so `replenishKeyPackages()` runs.
- **Decryption returns null** — the device is missing the right historical epoch material, same-user history repair has not landed yet, or the local scope state is corrupt. Check pending history bundles, recent commit fingerprints, and the stored checkpoint for that scope.
- **State corruption** — clear the affected scope checkpoint and let the SDK repair path rehydrate from GroupInfo, durable replay, or a same-user history bundle.
- **External Commit loops or repeated GroupInfo publish retries** — inspect the pending outbox fields in the stored scope checkpoint and confirm the server is accepting `PUT /api/v1/group-info/:scope_id` and `POST /api/v1/mls-sponsored-transition/:scope_id`.
- **Sender's messages show as "[Message unavailable]"** — verify the persisted sent-message cache is writing rows for echoed ciphertext and that the scope checkpoint is being saved after encrypt.

### Testing

The Electron-specific code (SQLite, `safeStorage`, IPC) is still different from the web path, but the current verification story is broader than manual smoke checks:
1. SDK integration tests exercise the encrypted chat runtime directly in Node.
2. Playwright E2E covers the web client against the live Phoenix stack.
3. Electron still needs manual coverage for OS keychain and local encrypted SQLite behavior.

### MLS Diagnostics and Epoch Budget Testing

MLS bugs are uniquely difficult to catch with conventional assertions. A message that decrypts correctly today might be the result of an epoch storm that burned through 58 epoch transitions when it should have taken 2. The decryption succeeds — the group eventually converged — but the protocol health is catastrophic. Key packages are exhausted, epoch retention windows are blown, and the next user who joins will find an unrecoverable state.

Traditional E2E tests check outcomes: "did Bob see Alice's message?" They don't check the cost of getting there. The MLS diagnostics system addresses this by tracking protocol-level counters and asserting quantitative budgets.

#### Why epoch count is a performance metric

Every MLS membership change (add, remove, update) advances the group's epoch by 1. A healthy 2-user DM handshake produces epoch 1. A healthy 3-user channel join produces epoch 2. These numbers are deterministic — for a given topology, the minimum epoch count is known.

When the epoch count exceeds the expected minimum, something went wrong in the protocol flow:

- **Epoch storm** — duplicate join requests cause cascading remove+add cycles, each advancing the epoch by 2. We observed epochs reaching 58+ from a bug where channel join request deduplication was scoped to DMs only.
- **Thundering herd** — multiple code paths send join requests concurrently, and the handler processes all of them instead of deduplicating.
- **Welcome replay** — pending welcome polling reprocesses the same welcome multiple times, consuming key packages unnecessarily.

These problems are invisible to a test that only checks "did decryption succeed?" They're caught immediately by a test that checks "is the epoch ≤ 2?"

#### Architecture

**`MLSDiagnostics`** (`sdk/src/client/mlsDiagnostics.ts`) is a lightweight counters class instantiated once per `VesperEncryptedChat` session. It tracks per-scope (per channel or conversation) metrics:

| Counter | What it measures |
|---------|-----------------|
| `epoch` | Current MLS epoch — updated on every `setGroupState` |
| `groupCreations` | How many times `createGroup` completed for this scope |
| `commitsProcessed` | Successful commit processing (epoch advances) |
| `commitsFailed` | Failed commits (wrong epoch, wrong group — expected during welcome processing) |
| `welcomesProcessed` | Successful welcome processing |
| `welcomesFailed` | Failed welcome attempts (no matching key package) |
| `joinRequestsHandled` | Add-member operations processed |
| `keyPackagesConsumed` | Local key packages consumed during group creation |

The counters are always-on. Each operation is an integer increment plus a Map lookup — effectively zero cost at any scale. No string formatting, no I/O, no persistence. Memory is ~56 bytes per scope; a user in 150 scopes uses ~8.4 KB.

Counters are NOT cleared on `resetScope` — the diagnostic value is cumulative. A scope that was created, yielded, reset, and recreated should show the full history of what happened. Counters are only cleared explicitly by tests via `diagnostics.reset()`.

#### How tests use it

The renderer exposes the diagnostics instance on `window.__mlsDiagnostics` during encrypted chat initialization. Playwright tests read it via `page.evaluate()`.

The test helper (`client/e2e/helpers/mls-diagnostics.ts`) provides:

- **`getMlsDiagnostics(page, scopeId)`** — reads the counter snapshot for a scope
- **`assertMlsBudget(diagnostics, budget, label)`** — asserts each counter is within budget. Failure messages are explicit: `MLS budget exceeded for alice DM: epoch = 58, max allowed = 1`
- **`findDiagnosticScopes(page, filter)`** — discovers scope IDs when tests don't know the UUID (filters by which scopes have group creations, welcomes, etc.)

#### Defining budgets

Each test defines its own budget based on the expected protocol topology:

```typescript
// 2-user DM: create at epoch 0, add one member → epoch 1
assertMlsBudget(diag, {
  maxEpoch: 1,
  maxGroupCreations: 1,
  maxJoinRequestsHandled: 1,
  maxKeyPackagesConsumed: 1,
}, 'alice DM epoch budget')

// 3-user channel: create at epoch 0, add Bob → 1, add Charlie → 2
assertMlsBudget(diag, {
  maxEpoch: 2,
  maxGroupCreations: 1,
  maxJoinRequestsHandled: 2,
}, 'alice channel epoch budget')
```

Budgets are hardcoded per test, not derived from a formula. Each test knows its topology and the minimum epoch count for that topology. The budget should be tight for the critical counters (epoch, join requests handled, group creations) and loose for counters with harmless noise (welcome retries from polling loops).

#### Adding budget assertions to new tests

1. After the MLS handshake converges (messages visible on all clients), find the scope ID — either by knowing it or using `findDiagnosticScopes`.
2. Read diagnostics from each user's page via `getMlsDiagnostics`.
3. Call `assertMlsBudget` with a budget that reflects the expected minimum for the test's topology.
4. Epoch count = number of add/remove operations. For N users joining a fresh group, the minimum epoch is N-1.

If a budget assertion fails, it means the protocol flow has regressed — likely a deduplication guard was removed, a code path is sending duplicate join requests, or a race condition is creating duplicate groups.

---

## 12. Known Limitations and Future Work

| Area | Current State | Target | Notes |
|---|---|---|---|
| Historical message recovery | Uses persisted group state, durable replay, and same-user history repair | Add explicit checkpoint snapshots for very large scopes | Current recovery is correctness-first for small and medium scopes; very large rooms still need a different topology |
| Self-decrypt after reload | Sent-message plaintext cache is persisted and checked before repair | Keep cache bounded and scoped | MLS still consumes sender ratchet state on encrypt; the cache is the local workaround |
| Search | FTS5 infrastructure wired, UI not connected | Full search UI with results navigation | Index is populated on decrypt — only viewed messages are searchable |
| Large files | Single-shot AES-256-GCM | Chunked encryption (256 KB chunks) for streaming decrypt | Each chunk independently authenticated with chunk index in AAD to prevent reordering |
| Crypto thread | Runs on renderer main thread | Web Worker for symmetric crypto offload | Full `ClientState` likely won't survive `structuredClone`. Recommended fallback: keep MLS state in main thread, offload only AES-GCM encrypt/decrypt to Worker |
| Link previews | Receiver-side fetch with user opt-out, no server proxy | Sender-side generation with user opt-out | Current app keeps preview requests off the Vesper server; long-term target is encrypted sender-side preview data in the message payload |
| Multi-device | Each device must independently join every MLS group | Shared identity with key sync | No "rejoin all channels" flow exists — each channel rejoins lazily on first visit |
| Key package expiry | No server-side expiration | `expires_at` column + Oban purge job + server rejection of expired packages | |
| Batch removes | Each member leave = separate Commit | Batch Commit with 100ms collection window | Design: start a timer on first leave event, collect additional leaves, issue single batched Remove Commit when timer fires |
| History for new members | History bundle mechanism re-encrypts recent messages at current epoch for new joiners | Streaming history for large channels | Works for DMs and channels via `mls_history_request` / `mls_history_bundle` exchange after welcome processing |
| Group creator race | `pendingGroupCreations` Map prevents concurrent creation within one client; DM leader election (lower UUID wins) prevents cross-client dual creation | Server-side first-wins arbitration for edge cases | DM convergence solved. Channel groups are owner-gated. Remaining edge case: two owners (unlikely) creating groups simultaneously |

---

## 13. Security Considerations

### Verified Properties

- **Server blindness**: The server stores only ciphertext. Key material never leaves the client unencrypted (except public keys, by definition).
- **Forward secrecy**: MLS provides forward secrecy through key ratcheting. Compromising a device doesn't reveal past messages (assuming epoch keys have been evicted).
- **Sender authentication**: Every decrypted message is authenticated by OpenMLS against the sender credential embedded in the group state.
- **At-rest encryption**: The local database is encrypted with a key that only the OS keychain can decrypt.

### Unverified / Unaudited

- **Vesper's OpenMLS integration**: The OpenMLS core is audited, but the Vesper-specific orchestration, storage, and recovery flows have not had a separate full-system security audit yet.
- **Side-channel resistance**: The MLS core now runs inside WASM, but JavaScript orchestration, persistence, and surrounding file/key handling still need normal side-channel caution.
- **Memory safety**: Key material in JavaScript cannot be reliably zeroed. The runtime may copy, move, or retain key bytes in memory unpredictably. The `signature_private_key` column in the local database is the most sensitive long-lived secret.

### Accepted Metadata Leaks

- **Mentioned user IDs** are sent in plaintext alongside the encrypted message, for server-side notification routing.
- **File existence and size** are visible to the server (it stores the encrypted blobs).
- **Timing and frequency** of messages are visible to the server.
- **Channel membership** is server-managed and fully visible.
