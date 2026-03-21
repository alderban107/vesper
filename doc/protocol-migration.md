# Protocol Migration: MLS → Signal Protocol

## Motivation

MLS (Messaging Layer Security) requires an existing group member to be **online** to process a new member's join. The server can't do it — only a client holding the group's ratchet tree can create the commit and welcome messages needed to admit a new member. For a small self-hosted messaging app where users aren't always online simultaneously, this is a fundamental UX failure: opening a conversation with someone who's offline simply doesn't work until they come back.

Signal Protocol eliminates this problem entirely. Session establishment is **fully asynchronous** — users upload pre-key bundles to the server ahead of time, and anyone can establish an encrypted session by fetching that bundle. No one needs to be online for anyone else.

This document covers a complete replacement of Vesper's MLS-based E2EE with Signal Protocol (X3DH + Double Ratchet for pairwise sessions, Sender Keys for group efficiency).

---

## Protocol Overview

### Signal Protocol Components

**X3DH (Extended Triple Diffie-Hellman)** — Asynchronous key agreement
- Each device registers: identity key (long-term), signed pre-key (medium-term), one-time pre-keys (consumable)
- To start a session, fetch the other user's bundle from the server and perform 3-4 DH operations locally
- No interaction with the other party required — the server is just a key directory

**Double Ratchet** — Per-session message encryption
- Combines a DH ratchet (new key exchange per message round-trip) with a symmetric ratchet (chain keys for sequential messages)
- Forward secrecy: past messages stay secure if current keys are compromised
- Post-compromise security: future messages become secure again after key rotation
- Each pairwise session is independent — compromising one doesn't affect others

**Sender Keys** — Efficient group messaging
- Each group member generates a sender key (symmetric chain key + signing key)
- Distributes it to all other members via their pairwise Double Ratchet sessions
- Group messages encrypted once with the sender key (O(1) for sender, not O(N))
- New members receive existing sender keys via pairwise sessions — async, no one needs to be online
- When a member leaves, everyone rotates their sender key and redistributes

### What Changes

| Concept | MLS (current) | Signal Protocol (target) |
|---------|---------------|--------------------------|
| Session setup | Commit + Welcome (requires online member) | X3DH with pre-key bundle (fully async) |
| Group state | Shared ratchet tree | Pairwise sessions + Sender Keys |
| Server role | Relay MLS commits/welcomes, store pending joins | Store pre-key bundles, relay encrypted payloads |
| Key rotation | Epoch-based (commit advances tree) | Per-message ratchet (DH + chain) |
| Member add | Online member creates commit + welcome | Fetch pre-key bundle, establish session, distribute sender key |
| Member remove | Online member creates remove commit | Rotate sender keys, distribute via pairwise sessions |
| Voice keys | MLS exporter secret | Derived from group shared secret or pairwise session |
| Forward secrecy | Per-epoch | Per-message |
| State complexity | ~2,600 lines of orchestration | Simpler: per-session state, no group consensus needed |

---

## Scope of Changes

### Files to Rewrite

#### SDK (`sdk/src/`)

| File | Lines | Change |
|------|-------|--------|
| `crypto/mls.ts` | 599 | **Replace entirely** → `crypto/signal.ts`. X3DH, Double Ratchet, Sender Keys. Same export shape (init, create session, encrypt, decrypt, derive voice key). |
| `client/encryptedChat.ts` | 2,606 | **Replace entirely** → Signal session manager. No commit/welcome/resync/eviction state machine. Session setup = fetch pre-key bundle + X3DH. Group setup = pairwise sessions + sender key distribution. |
| `crypto/types.ts` | 53 | **Rewrite** — Replace `ts-mls` type imports with Signal session types. Keep `IdentityKeys`, `EncryptedKeyBundle`, `RecoveryKeyData`. |
| `crypto/keySerialization.ts` | 122 | **Rewrite** — Serialize Signal session state instead of MLS PrivateKeyPackage. |
| `crypto/mls.typecheck.ts` | 24 | **Delete**. |
| `api/crypto.ts` | 316 | **Rewrite** — Replace pending welcome/resync/history/MLS event endpoints with pre-key bundle CRUD. Key package upload stays similar. |
| `api/socket.ts` | ~44 | **Simplify** — Remove MLS-specific events. Add sender key distribution events. |
| `testing/chatHarness.ts` | 1,819 | **Rewrite** — Test pairwise session establishment + sender key groups instead of MLS group lifecycle. |
| `testing/deviceHarness.ts` | 352 | **Update** — Remove MLS event types from socket mock. |

#### SDK Files That Survive (minor changes)

| File | Lines | Change |
|------|-------|--------|
| `crypto/identity.ts` | 263 | **Keep** — Argon2id KDF, AES-256-GCM, BIP39 recovery. Protocol-agnostic. |
| `crypto/fileEncryption.ts` | 76 | **Keep** — AES-256-GCM for attachments. No MLS dependency. |
| `crypto/payload.ts` | 88 | **Keep** — Message envelope format. Protocol-agnostic. |
| `crypto/decryptionCache.ts` | 109 | **Keep** — LRU cache pattern works with any protocol. Update comment about "MLS senders can't decrypt their own messages" — check if this limitation exists with Signal too (it doesn't; Signal senders can decrypt their own messages). |
| `crypto/groupLock.ts` | 96 | **Keep** — Mutex pattern still useful for session state mutations. |
| `crypto/storage.ts` | 535 | **Update** — Replace group state interface (MLS blob → Signal session store). Keep message cache, FTS, sent-message cache. |
| `crypto/indexedDbStorage.ts` | 504 | **Update** — Replace `mls_groups`/`mls_group_sync_state` stores with Signal session stores. |
| `auth/session.ts` | 816 | **Update** — Replace `createKeyPackageBatch` with pre-key bundle generation. Credential identity format stays similar. |
| `client/index.ts` | 2,262 | **Update** — `createEncryptedChat()` factory stays, internals change. Remove MLS event list from socket config. |
| `storage/file.ts` | ~340 | **Update** — Replace MLS group methods with Signal session methods. |
| `storage/memory.ts` | ~270 | **Update** — Same as file.ts. |

#### Server (`server/`)

| File | Change |
|------|--------|
| `lib/vesper/encryption.ex` | **Major rewrite** — Strip MLS event/welcome/resync/history/eviction functions. Keep key package directory (becomes pre-key bundle directory). Add sender key storage if server-assisted distribution is needed. |
| `lib/vesper_web/channels/dm_channel.ex` | **Simplify** — Remove all `mls_*` socket event handlers (~350 lines of handlers). Messages just relay ciphertext. Add sender key distribution events if needed. |
| `lib/vesper_web/channels/chat_channel.ex` | **Simplify** — Same as dm_channel. |
| `lib/vesper_web/channels/voice_channel.ex` | **Simplify** — Remove `mls_*` handlers. Voice key exchange stays (server is dumb relay). |
| `lib/vesper/encryption/pending_welcome.ex` | **Delete**. |
| `lib/vesper/encryption/mls_event.ex` | **Delete**. |
| `lib/vesper/encryption/pending_resync_request.ex` | **Delete**. |
| `lib/vesper/encryption/pending_history_request.ex` | **Delete**. |
| `lib/vesper/encryption/pending_history_bundle.ex` | **Delete**. |
| `lib/vesper/encryption/pending_crypto_eviction.ex` | **Delete**. |
| `lib/vesper_web/controllers/mls_event_controller.ex` | **Delete**. |
| `lib/vesper_web/controllers/pending_welcome_controller.ex` | **Delete**. |
| `lib/vesper_web/controllers/pending_resync_request_controller.ex` | **Delete**. |
| `lib/vesper_web/controllers/pending_history_request_controller.ex` | **Delete**. |
| `lib/vesper_web/controllers/pending_history_bundle_controller.ex` | **Delete**. |
| `lib/vesper_web/controllers/key_package_controller.ex` | **Rename/update** → `pre_key_controller.ex`. Similar shape: upload bundles, fetch-and-consume. |
| `lib/vesper/workers/process_pending_crypto_evictions.ex` | **Delete**. |
| `lib/vesper/workers/purge_welcomes.ex` | **Delete**. |
| `lib/vesper/workers/purge_key_packages.ex` | **Keep** — Pre-key bundles also need periodic cleanup. |
| `lib/vesper_web/router.ex` | **Update** — Remove MLS-specific routes. |
| `lib/vesper/chat/message.ex` | **Update** — Rename `mls_epoch` or remove (Signal doesn't use epochs the same way). |
| `lib/vesper/chat/reaction.ex` | **Update** — Same as message.ex. |
| New migration | **Create** — Drop MLS tables, rename/restructure pre-key storage. |

#### Electron Client (`client/`)

| File | Change |
|------|--------|
| `src/main/db.ts` | **Update** — Replace `mls_groups`/`mls_group_sync_state` tables with Signal session storage. Keep `local_key_packages` (becomes local pre-key storage). Remove `mls_epoch` from message cache. |
| `src/main/index.ts` | **Update** — Rename IPC handlers (`getGroupState` → `getSessionState`, etc.). |
| `src/preload/index.ts` | **Update** — Match IPC handler renames. |
| `src/renderer/src/stores/messageStore.ts` (5,833 lines) | **Major simplification** — Remove all MLS join/resync/eviction cooldown tracking, recovery backoff state machine, commit/welcome processing. Session establishment becomes: fetch pre-key bundle → X3DH → done. |
| `src/renderer/src/stores/voiceStore.ts` (1,700 lines) | **Update** — Replace MLS voice group bootstrap with Signal-based voice key derivation. Remove `maybeRequestVoiceMlsJoin`, `maybeRequestVoiceMlsResync`, `processVoiceMlsResyncRequest`, `ensureVoiceGroupReady`, `recoverVoiceMlsState`. |
| `src/renderer/src/stores/authStore.ts` | **Minor** — `replenishKeyPackages` → `replenishPreKeys`. `canUseE2EE` logic stays. |
| `src/renderer/src/stores/presenceStore.ts` | **Minor** — Update event name checks. |
| `src/renderer/src/sdk/client.ts` | **Minor** — `getRendererEncryptedChat()` stays, internal type changes. |
| `src/renderer/src/voice/encryption.ts` | **Keep** — Protocol-agnostic (receives key bytes, applies to RTCRtpScriptTransform). |
| `src/renderer/src/voice/e2ee-worker.ts` | **Keep** — AES-128-GCM frame encryption. Protocol-agnostic. |
| `src/renderer/src/components/auth/DeviceTrustGate.tsx` | **Keep** — Device approval flow is protocol-agnostic. |
| `src/renderer/src/env.d.ts` | **Update** — Replace `mls_epoch` types. |

#### Dusk Client (`../vesper-client/`)

| File | Change |
|------|--------|
| `app/src/services/websocket.ts` | **Simplify** — Remove `mls_epoch: 0` fake encryption. Real Signal sessions will work async. |
| `app/src/stores/chatStore.ts` | **Update** — SDK handles encryption transparently. |
| `app/src/components/chat/TopicBar.tsx` | **Update** — "MLS Encrypted" badge → "E2EE" or "Signal Encrypted". |
| `app/src/components/layout/StatusBar.tsx` | **Update** — Same badge text. |
| `sdk/` (vendored copy) | **Update** — Sync with main SDK changes. |

#### Tests

| File | Change |
|------|--------|
| `server/test/` (107 tests) | **Update** — Tests exercising MLS socket events need rewriting. Tests for message CRUD, auth, server management are likely fine. |
| `client/e2e/` (45 tests) | **Update** — E2E tests covering encrypted messaging flows need rewriting. UI-only tests should survive. |
| `sdk/src/testing/chatHarness.ts` | **Rewrite** — Core test harness for encrypted chat. |

---

## Implementation Plan

### Phase 1: Signal Protocol Crypto Primitives

Build `sdk/src/crypto/signal.ts` — pure TypeScript implementation from spec.

**Dependencies**: `@noble/curves` (X25519, Ed25519), WebCrypto (AES-256-GCM, HKDF, HMAC-SHA256).

**Components**:
1. **X3DH key agreement** (~100 lines)
   - `generateIdentityKeyPair()` — Long-term Ed25519/X25519 key pair
   - `generateSignedPreKey()` — Medium-term X25519 key pair, signed by identity key
   - `generateOneTimePreKeys(count)` — Batch of ephemeral X25519 key pairs
   - `generatePreKeyBundle()` — Package for server upload
   - `performX3DH(ourIdentity, theirBundle)` → shared secret
   - `respondX3DH(ourIdentity, ourPreKeys, initialMessage)` → shared secret

2. **Double Ratchet** (~300 lines)
   - `initSenderSession(sharedSecret)` → SessionState
   - `initReceiverSession(sharedSecret)` → SessionState
   - `ratchetEncrypt(session, plaintext)` → { ciphertext, header, newSession }
   - `ratchetDecrypt(session, ciphertext, header)` → { plaintext, newSession }
   - `serializeSession(session)` / `deserializeSession(bytes)` — For persistence

3. **Sender Keys** (~150 lines)
   - `generateSenderKey()` → { chainKey, signingKey }
   - `senderKeyEncrypt(senderKey, plaintext)` → { ciphertext, signature, iteration }
   - `senderKeyDecrypt(senderKey, ciphertext, signature, iteration)` → plaintext
   - `distributeSenderKey(pairwiseSession, senderKey)` → encrypted distribution message

4. **Voice key derivation** (~20 lines)
   - `deriveVoiceKey(groupSecret)` → 128-bit AES key via HKDF

5. **Utilities**
   - `encodePreKeyBundle(bundle)` / `decodePreKeyBundle(bytes)` — Wire format
   - Session state types, key types

**Export surface** (replacing `mls.ts`):
```typescript
// Init
export async function initCrypto(): Promise<void>

// Pre-key bundles (replaces key packages)
export async function generatePreKeyBundle(identity, count): Promise<PreKeyBundle>
export function encodePreKeyBundle(bundle): Uint8Array
export function decodePreKeyBundle(bytes): PreKeyBundle

// Sessions (replaces MLS groups)
export async function createSession(ourIdentity, theirBundle): Promise<SessionState>
export async function receiveSession(ourIdentity, preKeys, message): Promise<SessionState>

// Encrypt/decrypt (same role as MLS encrypt/decrypt)
export async function encrypt(session, plaintext): Promise<{ ciphertext, session }>
export async function decrypt(session, ciphertext): Promise<{ plaintext, session } | null>

// Sender Keys (replaces MLS group encryption)
export async function createSenderKey(): Promise<SenderKeyState>
export async function senderKeyEncrypt(state, plaintext): Promise<{ ciphertext, state }>
export async function senderKeyDecrypt(state, ciphertext): Promise<{ plaintext, state } | null>

// Voice
export async function deriveVoiceKey(groupSecret): Promise<Uint8Array>

// Serialization
export function serializeSession(session): Uint8Array
export function deserializeSession(bytes): SessionState
export function serializeSenderKey(state): Uint8Array
export function deserializeSenderKey(bytes): SenderKeyState
```

### Phase 2: SDK Client Layer

Replace `encryptedChat.ts` with Signal session management.

**Key simplifications**:
- No commit/welcome flow → fetch pre-key bundle, establish session
- No resync → sessions are self-healing (missed messages just need re-fetch)
- No eviction state machine → remove member = rotate sender keys
- No epoch tracking → Double Ratchet handles key progression automatically
- No group consensus → each pairwise session is independent

**New `VesperEncryptedChat` public API** (largely the same surface, simpler internals):
```typescript
// Scope lifecycle — simplified
async watchScope(scopeId, callback): Promise<Disposable>
async ensureScopeReady(scope): Promise<boolean>  // Fetch pre-keys + establish sessions
async resetScope(scopeId): Promise<void>

// Messaging — same API
async sendText(scope, text): Promise<void>
async encryptOpaque(scope, payload): Promise<{ ciphertext, session }>
async decryptOpaque(scope, ciphertext): Promise<string | null>

// Session management — replaces MLS group operations
async establishSession(userId, deviceId): Promise<void>
async distributeGroupSenderKey(scope): Promise<void>

// Voice — same API
async deriveScopeVoiceKey(scopeId): Promise<Uint8Array | null>

// Member management — simplified
async handleMemberJoin(scope, userId): Promise<void>   // Establish session + send sender key
async handleMemberLeave(scope, userId): Promise<void>  // Rotate sender keys
```

**Socket events** (replacing 10+ MLS events):
- `sender_key_distribution` — Distribute sender key to group members via pairwise sessions
- `session_message` — Pairwise encrypted message (for sender key distribution, DMs)
- Keep: `new_message`, `voice_key`, `add_reaction`, etc. (payload is just ciphertext)

### Phase 3: Server Migration

**New migration**:
```sql
-- Drop MLS tables
DROP TABLE IF EXISTS mls_events;
DROP TABLE IF EXISTS mls_pending_welcomes;
DROP TABLE IF EXISTS mls_pending_resync_requests;
DROP TABLE IF EXISTS mls_pending_history_requests;
DROP TABLE IF EXISTS mls_pending_history_bundles;
DROP TABLE IF EXISTS mls_pending_crypto_evictions;

-- Rename key_packages → pre_key_bundles (or keep and repurpose)
-- key_packages table already has: user_id, client_id, key_package_data, consumed
-- This maps directly to pre-key bundles: user_id, device_id, bundle_data, consumed

-- Add sender key distribution store (optional, for offline delivery)
CREATE TABLE IF NOT EXISTS pending_sender_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_device_id VARCHAR(255),
  scope_id VARCHAR(255) NOT NULL,
  encrypted_sender_key BYTEA NOT NULL,
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_pending_sender_keys_recipient ON pending_sender_keys(recipient_id, scope_id);
```

**Channel handlers** — Strip all `mls_*` handlers. Messages are just ciphertext relay. Add:
- `handle_in("sender_key_distribution", payload, socket)` — Store for offline recipients, broadcast to online ones

**Delete**: 6 Ecto schemas, 5 controllers, 2 workers. **Simplify**: 3 channel modules, 1 context module.

### Phase 4: Client Storage & Dusk

**SQLite schema update** (Electron):
```sql
-- Replace MLS tables
DROP TABLE IF EXISTS mls_groups;
DROP TABLE IF EXISTS mls_group_sync_state;

-- Signal session storage
CREATE TABLE IF NOT EXISTS signal_sessions (
  address TEXT PRIMARY KEY,  -- "userId:deviceId"
  session_data BLOB NOT NULL,
  updated_at TEXT NOT NULL
);

-- Sender key storage (for groups)
CREATE TABLE IF NOT EXISTS sender_keys (
  scope_id TEXT NOT NULL,
  address TEXT NOT NULL,  -- sender's "userId:deviceId"
  key_data BLOB NOT NULL,
  PRIMARY KEY (scope_id, address)
);

-- Remove mls_epoch from message_cache
-- (migration: drop column or ignore it)
```

**Dusk**: Remove the fake base64 encryption in `websocket.ts`. The SDK's `encryptedChat` now handles real encryption with async session establishment — Dusk's two blocking bugs (device trust not surviving reloads, MLS group join never completing) are both eliminated because there's no group join flow at all.

### Phase 5: Tests

- New unit tests for `crypto/signal.ts` — X3DH, Double Ratchet, Sender Keys
- Rewrite `chatHarness.ts` for Signal sessions
- Update server channel tests
- Update E2E tests for new flow (simpler — just verify messages encrypt/decrypt)

---

## What Doesn't Change

- **Identity key management** — Argon2id KDF, encrypted key bundles, recovery mnemonics
- **File encryption** — AES-256-GCM attachment encryption
- **Message payload format** — JSON envelope (version, type, content)
- **Voice frame encryption** — AES-128-GCM in Web Worker via RTCRtpScriptTransform
- **Device trust model** — Approval flow, trusted/pending/revoked states
- **Message storage** — Ciphertext on server, plaintext cache on client, FTS5 search
- **UI** — All components except badge text
- **Transport** — Phoenix channels, WebSocket, REST API structure

## Dependencies

**Add**:
- `@noble/curves` — X25519, Ed25519 (if not already present)
- `@noble/hashes` — HKDF, HMAC-SHA256 (if not already present)

**Remove**:
- `ts-mls` — From both `sdk/package.json` and `client/package.json`

## Migration Considerations

- **No backward compatibility** — This is a clean break. Existing MLS sessions/groups are invalidated. All users will need to re-establish sessions after the update. For a small self-hosted app this is acceptable.
- **Server data** — Existing encrypted messages remain stored as ciphertext. They won't be decryptable after migration (old MLS state is gone). If message history preservation matters, a migration step could re-encrypt cached plaintext, but this is optional.
- **Sender Key tradeoffs** — Weaker post-compromise security than MLS (compromised sender key decrypts that sender's messages until rotation). Acceptable tradeoff for async UX.
