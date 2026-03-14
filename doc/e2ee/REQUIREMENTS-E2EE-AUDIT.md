# Vesper — E2EE Requirements Audit

> Implementation status of every E2EE requirement. Each entry includes what code
> satisfies the requirement, what's missing, and what must not be removed. This is
> the audit companion to the full requirements analysis.
>
> **Companion documents:**
> - [REQUIREMENTS-E2EE.md](./REQUIREMENTS-E2EE.md) — The full requirements document
>   with design rationale, tradeoff analysis, and detailed discussion of each
>   requirement. Read that first if you need to understand *why* a requirement exists.
> - [E2EE-IMPLEMENTATION.md](./E2EE-IMPLEMENTATION.md) — How the implementation
>   works today. Architecture, key lifecycle, developer guide, gotchas.
> - [DESIGN.md](../DESIGN.md) — Overall architecture.
>
> **Status key:**
> - ✅ **Met** — Requirement is satisfied by the current implementation.
> - ⚠️ **Partial** — Some aspects are implemented; gaps noted inline.
> - ❌ **Not met** — Not yet implemented or explicitly deferred.
> - 📌 **Decision made** — An open design question that has been resolved.

---

## Bug Reference

The "do not remove" warnings in this document reference bugs by ID. These were
identified during the E2EE security review and fixed in the Phase 0–6 refactor.
Removing the code that fixes them would reintroduce the vulnerability.

| ID | Severity | Description | Fixed by |
|----|----------|-------------|----------|
| C1 | Critical | `crypto.db` stored as plain SQLite — MLS epoch secrets readable by anyone with filesystem access | `better-sqlite3-multiple-ciphers` + `safeStorage`-encrypted key |
| C2 | Critical | `message_cache` stored decrypted plaintext in `content TEXT` column | Schema changed to `ciphertext BLOB` + `mls_epoch INTEGER` |
| C3 | Critical | Login `saveIdentity()` passed `bundle.ciphertext` for all three key fields instead of actual public keys | Server login response now returns public keys; client stores them correctly |
| H1 | High | No epoch key retention — messages from past epochs permanently undecryptable after any Commit | `retainKeysForEpochs = 64` via ts-mls config |
| H2 | High | Fake BIP39 wordlist — generated pronounceable nonsense instead of standard dictionary words | Replaced with official 2048-word BIP39 English wordlist |
| H3 | High | Fragile key package serialization — `slice(0,32)` / `slice(32,64)` / `slice(64)` with no length validation | Versioned length-prefixed format in `keySerialization.ts` |
| H4 | High | `replenishKeyPackages()` generated key packages with random identity keys instead of the user's actual signing key | Signature private key stored in encrypted DB; loaded and passed to `createKeyPackageBatch()` |
| H5 | High | No concurrency protection — concurrent encrypt/decrypt/commit operations could corrupt MLS group state | Per-group async mutex via `groupLock.ts` |
| H6 | High | `handleCommit()` caught all errors silently — failed commits were swallowed with no retry or user feedback | 3-attempt retry with exponential backoff; evict state on total failure |

---

## Requirements Index

| ID | Summary | Status |
|----|---------|--------|
| [R-PROTO-1](#r-proto-1-mls-rfc-9420-is-the-group-encryption-protocol) | MLS (RFC 9420) is the group encryption protocol | ✅ Met |
| [R-PROTO-2](#r-proto-2-the-server-must-be-cryptographically-blind-to-message-content) | Server must be cryptographically blind to message content | ✅ Met |
| [R-PROTO-3](#r-proto-3-mls-authentication-is-required-not-optional) | MLS authentication is required, not optional | ✅ Met |
| [R-PROTO-4](#r-proto-4-ts-mls-must-be-security-audited-before-production) | ts-mls must be security-audited before production | ❌ Not met |
| [R-KEY-1](#r-key-1-one-identity-per-user-account-not-per-device) | One identity per user account, not per device | ✅ Met |
| [R-KEY-2](#r-key-2-recovery-key-must-use-actual-bip39) | Recovery key must use actual BIP39 | ✅ Met |
| [R-KEY-3](#r-key-3-key-packages-must-be-pre-generated-and-replenished-proactively) | Key packages must be pre-generated and replenished proactively | ⚠️ Partial |
| [R-KEY-4](#r-key-4-private-key-material-must-not-exist-in-memory-longer-than-necessary) | Private key material must not exist in memory longer than necessary | ⚠️ Partial |
| [R-STORE-1](#r-store-1-mls-group-state-must-be-encrypted-at-rest-critical) | MLS group state must be encrypted at rest | ✅ Met |
| [R-STORE-2](#r-store-2-decrypted-message-content-must-not-be-stored-as-plaintext-critical) | Decrypted message content must not be stored as plaintext | ✅ Met |
| [R-STORE-3](#r-store-3-key-package-private-data-must-be-stored-securely) | Key package private data must be stored securely | ✅ Met |
| [R-EPOCH-1](#r-epoch-1-historical-messages-require-historical-epoch-keys-hard-problem) | Historical messages require historical epoch keys | ✅ Met |
| [R-EPOCH-2](#r-epoch-2-epoch-key-deletion-must-be-tied-to-message-lifecycle) | Epoch key deletion must be tied to message lifecycle | ❌ Not met |
| [R-DEVICE-1](#r-device-1-new-device-bootstrap-requires-re-establishing-group-membership) | New device bootstrap requires re-establishing group membership | ⚠️ Partial |
| [R-DEVICE-2](#r-device-2-multiple-active-devices-receive-the-same-commits) | Multiple active devices receive the same Commits | ⚠️ Partial |
| [R-HIST-1](#r-hist-1-decide-the-history-policy-explicitly) | Decide the history policy explicitly | 📌 Decided |
| [R-MEMBER-1](#r-member-1-key-rotation-on-member-leave-must-not-fan-out-catastrophically) | Key rotation on member leave must not fan-out catastrophically | ⚠️ Partial |
| [R-MEMBER-2](#r-member-2-joins-must-not-block-on-sender-availability) | Joins must not block on sender availability | ✅ Met |
| [R-MEMBER-3](#r-member-3-the-group-creator-problem) | The group creator problem | ⚠️ Partial |
| [R-SEARCH-1](#r-search-1-full-text-search-must-be-client-side-only) | Full-text search must be client-side only | ⚠️ Partial |
| [R-SEARCH-2](#r-search-2-server-side-search-must-be-limited-to-metadata) | Server-side search must be limited to metadata | ✅ Met |
| [R-PERF-1](#r-perf-1-never-decrypt-all-messages-on-channel-open) | Never decrypt all messages on channel open | ⚠️ Partial |
| [R-PERF-2](#r-perf-2-epoch-key-lookups-must-be-o1) | Epoch key lookups must be O(1) | ✅ Met |
| [R-PERF-3](#r-perf-3-group-state-updates-must-not-block-message-display) | Group state updates must not block message display | ⚠️ Partial |
| [R-BOT-1](#r-bot-1-bots-are-e2ee-members-with-explicit-user-consent) | Bots are E2EE members with explicit user consent | ❌ Not met |
| [R-BOT-2](#r-bot-2-bots-cannot-join-channels-automatically) | Bots cannot join channels automatically | ❌ Not met |
| [R-DM-1](#r-dm-1-dms-have-different-churn-expectations) | DMs have different churn expectations | ✅ Met |
| [R-DM-2](#r-dm-2-dm-history-semantics-should-differ-from-channel-history) | DM history semantics should differ from channel history | ✅ Met |
| [R-DM-3](#r-dm-3-dm-key-rotation-policy-should-be-stricter) | DM key rotation policy should be stricter | ⚠️ Partial |
| [R-FILE-1](#r-file-1-files-must-be-encrypted-client-side-before-upload) | Files must be encrypted client-side before upload | ✅ Met |
| [R-FILE-2](#r-file-2-large-file-decryption-must-be-chunked) | Large file decryption must be chunked | ❌ Not met |
| [R-FILE-3](#r-file-3-file-deduplication-is-not-possible-with-e2ee) | File deduplication is not possible with E2EE | ✅ Met |
| [R-LINK-1](#r-link-1-server-side-link-preview-fetching-is-a-metadata-leak) | Server-side link preview fetching is a metadata leak | ❌ Not met |
| [R-LINK-2](#r-link-2-link-preview-fetch-must-be-optional-and-auditable) | Link preview fetch must be optional and auditable | ❌ Not met |
| [R-NOTIF-1](#r-notif-1-mention-user-ids-in-plaintext-accepted-metadata-leak) | Mention user IDs in plaintext (accepted metadata leak) | 📌 Decided |
| [R-NOTIF-2](#r-notif-2-push-notifications-for-mobile-must-be-designed-before-adding-mobile-clients) | Push notifications for mobile must be designed before adding mobile clients | ❌ Not met |
| [R-REACT-1](#r-react-1-reactions-are-encrypted) | Reactions are encrypted | ✅ Met |
| [R-VOICE-1](#r-voice-1-voice-key-rotation-on-member-joinleave-must-be-immediate) | Voice key rotation on member join/leave must be immediate | ⚠️ Partial |
| [R-VOICE-2](#r-voice-2-voice-and-text-channels-should-use-separate-mls-groups) | Voice and text channels should use separate MLS groups | ✅ Met |

---

## 1. Goals

**Primary goal:** End-to-end encrypted messaging that a non-technical user will never
notice is happening. No device verification ceremonies, no key backup prompts, no
"unverified session" warnings. Encryption is infrastructure — it should be as invisible
as HTTPS.

**Secondary goals:**
- Forward secrecy: a compromised device after the fact should not reveal past messages
- Post-compromise security: a temporarily compromised key should self-heal over time
- Deniability: the server cannot prove what any message said or who said it
- History access: channel messages should be readable by members who were present when
  they were sent, without needing the sender to be online

**Accepted costs:**
- If you lose your password AND your recovery key, your message history is gone. This is
  correct behavior, not a bug. The UX must communicate this clearly once and not again.
- The server knows who talked to whom, when, and how often. Metadata is not hidden.
  E2EE provides content privacy only.

---

## 2. Threat Model

### What we defend against

| Threat | Defense |
|--------|---------|
| Server operator reading message content | MLS encryption — server only stores ciphertext |
| Network eavesdropper | TLS + E2EE (double protection) |
| Compromised device after key rotation | MLS forward secrecy — old epoch keys are deleted |
| Brute-force password attack | Argon2id with strong parameters |
| MITM on key exchange | Key Package authentication via Ed25519 signatures |
| Server injecting fake messages | MLS authenticates sender inside the ciphertext |

### What we partially defend against

**Malicious server (key package substitution).** If the server swaps a user's key
package for an attacker's, an adder will encrypt to the attacker instead of the
intended user. Mitigations: Safety Numbers (optional out-of-band verification, already
in the design), key transparency (future work), or auditable key package signing.
This is the E2EE equivalent of HTTPS without certificate pinning — acceptable for most
threat models, insufficient for the highest-security use cases.

**Metadata analysis.** The server knows who is in which channel, who sent messages to
whom and when, and roughly how long messages are (from ciphertext size). If this metadata
matters to the threat model of a given deployment, Vesper is not the right tool. This is
an accepted limitation, not something to paper over.

### What we explicitly do not defend against

- Compromised client device with an active session (attacker has your keys)
- Screen capture, keylogging, or OS-level compromise
- Denial of service against the server
- Side-channel attacks on ts-mls (mitigate via security audit before production release)

---

## 3. Protocol Requirements

### R-PROTO-1: MLS (RFC 9420) is the group encryption protocol

> **Status: ✅ Met**
>
> Implemented via the `ts-mls` library. Cipher suite:
> `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`. Used for all channels and DMs.
>
> **What satisfies this:** `crypto/mls.ts` wraps ts-mls with the correct cipher suite
> constant. Both `createMLSGroup()` and `processWelcome()` use a custom
> `vesperClientConfig` that sets `retainKeysForEpochs: 64`.
>
> **Do not remove:** The cipher suite selection, the config object, or the ts-mls
> dependency. Changing the cipher suite is a breaking protocol change.

MLS provides forward secrecy, post-compromise security, and efficient group key
management for groups from 2 to ~50,000 members. One protocol for both DMs and
channels is the correct approach — two encryption systems would double the attack
surface and the implementation burden.

Cipher suite: `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` (current default). This
is appropriate. The post-quantum cipher suite (`X-Wing`) should remain opt-in until
ts-mls has been audited and the performance characteristics of X-Wing in large groups
are understood.

### R-PROTO-2: The server must be cryptographically blind to message content

> **Status: ✅ Met**
>
> The server stores and relays ciphertext only. All MLS protocol messages (Commit,
> Welcome, join requests) are relayed opaquely. The server never has access to plaintext
> or key material.
>
> **What satisfies this:** `chat_channel.ex` and `dm_channel.ex` receive base64-encoded
> ciphertext and broadcast it without processing. Message storage uses `ciphertext`
> BYTEA column. Reactions store encrypted emoji with the sentinel value `"encrypted"`.
>
> **Do not remove:** The opaque relay pattern in channel handlers, the ciphertext-only
> storage schema, or the base64 encoding at the transport boundary.

The server stores and forwards MLS ciphertext. It must never receive plaintext, must
never have access to any private key material, and must never be able to derive message
encryption keys. This is already the design — but it has implications for several
features discussed below (search, notifications, link previews) that need to be thought
through carefully.

### R-PROTO-3: MLS authentication is required, not optional

> **Status: ✅ Met**
>
> Verified via source audit: ts-mls checks Ed25519 signatures on every
> `processPrivateMessage()` call. The path is `unprotectPrivateMessage →
> getSignaturePublicKeyFromLeafIndex → verifyFramedContentSignature`. Invalid
> signatures throw `CryptoVerificationError("Signature invalid")`.
>
> **What satisfies this:** The ts-mls library's internal signature verification.
> Vesper does not bypass or disable this check. The audit comment in `mls.ts` documents
> the verification path.
>
> **Do not remove:** The ts-mls library performs this check internally — there is no
> code to remove. But do not add any catch-all error handling that would silently
> swallow `CryptoVerificationError`.

MLS doesn't just encrypt — it authenticates. Every message contains a signature from
the sender's identity key, verifiable by all group members. This prevents the server
from impersonating senders or injecting messages. The implementation MUST verify sender
authentication when decrypting; silently accepting unauthenticated messages is a
critical vulnerability.

### R-PROTO-4: ts-mls must be security-audited before production

> **Status: ❌ Not met**
>
> ts-mls has not undergone a formal security audit. This remains a hard gate for
> production deployment.

ts-mls is a pure TypeScript MLS implementation that has not undergone a formal security
audit. This is already called out in the design doc. The requirement is: **do not
remove this from the pre-release checklist**. An unaudited E2EE implementation is not
E2EE in any meaningful security sense.

---

## 4. Identity and Key Management

### R-KEY-1: One identity per user account, not per device

> **Status: ✅ Met**
>
> A single Ed25519 signature key pair is generated at registration and encrypted with
> the user's password. The encrypted bundle is stored on the server and downloaded on
> login to any device. All devices share the same identity.
>
> **What satisfies this:** `authStore.ts` registration flow (key generation +
> encryption), login flow (bundle download + decryption), the encrypted key bundle
> fields on the server's `users` table, and the `identity_keys` table in local storage.
>
> **Do not remove:** The server-side `encrypted_key_bundle`, `key_bundle_salt`,
> `key_bundle_nonce` fields, the local `identity_keys` table, or the
> `createEncryptedKeyBundle`/`decryptEncryptedKeyBundle` functions in `identity.ts`.

Vesper uses a shared key model: the same private keys exist on all a user's devices,
distributed via the encrypted key bundle. This is a deliberate tradeoff against the
per-device key model (used by Signal Desktop) where each device is a separate MLS
group member.

**Implications of this choice:**
- A user is one MLS leaf node regardless of how many devices they use. Groups don't
  grow with device count.
- Adding a new device means downloading and decrypting the key bundle — no join request
  to every group. Simpler UX.
- Compromising one device compromises all devices (same keys). This is the correct
  tradeoff for a Discord-replacement product that prioritizes ease of use.
- MLS's per-device forward secrecy is unavailable. What you get instead: per-epoch
  forward secrecy (keys from previous epochs cannot decrypt messages in the current one).

This decision should be documented explicitly. If per-device keys are ever desired,
the entire MLS group membership model changes and is not a backwards-compatible migration.

### R-KEY-2: Recovery key must use actual BIP39

> **Status: ✅ Met**
>
> The official 2048-word BIP39 English wordlist is bundled in
> `crypto/bip39-wordlist.ts`. The encoding algorithm (32 bytes + SHA-256 checksum → 24
> × 11-bit indices) is correctly implemented in `identity.ts`.
>
> **What satisfies this:** `bip39-wordlist.ts` (the wordlist), `generateRecoveryKey()`
> and `recoveryKeyToBytes()` in `identity.ts`.
>
> **Do not remove:** The wordlist file or the BIP39 encoding/decoding functions.
> Changing the wordlist is a breaking change that invalidates all existing recovery keys.
>
> **Breaking change note:** The Phase 3 refactor replaced a fake procedurally-generated
> wordlist with the real BIP39 list. Recovery keys generated before this change are
> invalid.

**Requirement:** Use the actual BIP39 English wordlist (2048 words). It should be
bundled as a static asset. The encoding algorithm already implements 11-bit indexing
correctly — only the wordlist source needs to change.

### R-KEY-3: Key packages must be pre-generated and replenished proactively

> **Status: ⚠️ Partial**
>
> Key packages are generated in batches of 20 (`KEY_PACKAGE_TARGET`) and replenished
> when the server count drops below 5 (`KEY_PACKAGE_THRESHOLD`). Replenishment now
> correctly uses the stored signature key pair (fixed in Phase 3).
>
> **What's implemented:** Batch generation, threshold-based replenishment, correct
> identity binding via stored signature key.
>
> **What's missing:** Replenishment retry on failure (currently fails silently with a
> `console.warn`). Server-side key package expiration (no `expires_at` column or
> Oban purge job). Immediate replenishment on new device login before channel joins.
>
> **What satisfies the implemented portion:** `authStore.ts`
> `replenishKeyPackages()`, the `signature_private_key` column in `identity_keys`,
> `loadIdentity()` in `storage.ts`.
>
> **Do not remove:** The `KEY_PACKAGE_THRESHOLD` check, the signature key storage,
> or the `loadIdentity()` call in `replenishKeyPackages()`. Removing signature key
> binding regresses to bug H4 (random identity keys on replenished packages).

Key packages are consumed one-per-group-join. A user with no remaining key packages
cannot be added to new groups.

**Requirements:**
- Never let the count drop to zero. When count falls below a threshold (suggest: 5),
  replenish immediately rather than waiting for the next consumption event.
- The replenishment call should be retried if it fails, with backoff.
- On login to a new device, generate and upload a fresh batch immediately before any
  channel joins are attempted.
- Key packages should have a lifetime set (they do via `defaultLifetime`) — enforce
  server-side rejection of expired key packages.

### R-KEY-4: Private key material must not exist in memory longer than necessary

> **Status: ⚠️ Partial**
>
> The signature private key is stored in the encrypted local database for use by
> `replenishKeyPackages()`. This is an intentional design choice — the key must persist
> across sessions. Temporary copies during key derivation and bundle decryption are not
> explicitly zeroed.
>
> **What's missing:** Explicit zeroing of temporary `Uint8Array` copies after use.
> JavaScript's GC makes this a best-effort guarantee regardless. The `noble` crypto
> libraries used by ts-mls are designed with constant-time operations but the MLS
> state machine hasn't been analyzed for key material lifetime.

After decrypting the key bundle at login, the raw private key bytes should be zeroed
from memory after importing into the Web Crypto API. JavaScript's GC makes this
difficult to guarantee, but the obvious copies (temporary Uint8Arrays) should be
zeroed after use. This is a best-effort requirement given the JS runtime, but the intent
should be explicit.

---

## 5. Local Storage

### R-STORE-1: MLS group state must be encrypted at rest (CRITICAL)

> **Status: ✅ Met**
>
> `crypto.db` is encrypted using `better-sqlite3-multiple-ciphers` with a 256-bit
> key. The key is encrypted at rest using Electron's `safeStorage` API (OS keychain)
> and stored in `crypto.db.key`. Automatic migration from unencrypted databases is
> supported. Graceful degradation on systems without a keychain (warning logged,
> DB opened unencrypted).
>
> **What satisfies this:** `db.ts` — `getOrCreateEncryptionKey()`, `applyKey()`,
> `isUnencryptedDb()`, `migrateToEncrypted()`, `initDb()`. The
> `better-sqlite3-multiple-ciphers` dependency in `package.json`.
>
> **Do not remove:** The `better-sqlite3-multiple-ciphers` dependency, the key
> management functions, the `PRAGMA key` call in `initDb()`, or the migration logic.
> Reverting to plain `better-sqlite3` regresses to critical bug C1.

The entire `crypto.db` must be encrypted at rest. The `mls_groups` table stores group
state as raw bytes containing epoch secrets from which all message encryption keys
are derived. Storing this in plaintext means anyone with filesystem access can derive
decryption keys.

### R-STORE-2: Decrypted message content must not be stored as plaintext (CRITICAL)

> **Status: ✅ Met**
>
> The `message_cache` table stores `ciphertext BLOB` and `mls_epoch INTEGER` — never
> plaintext `content`. Messages are decrypted on demand for display and held in an
> in-memory LRU cache (`decryptionCache.ts`, 2000 entries). The FTS5 index stores
> decrypted content but is inside the encrypted `crypto.db`.
>
> **What satisfies this:** The `message_cache` schema (ciphertext + mls_epoch columns),
> `cacheMessage()` in `db.ts` and `storage.ts`, the LRU decryption cache, and the
> FTS5 table inside the encrypted database.
>
> **Do not remove:** The ciphertext-only schema, the LRU cache, or the encrypted
> database wrapping the FTS5 index. Adding a plaintext `content` column to
> `message_cache` regresses to critical bug C2.

Either encrypt cached content or don't persist plaintext at all. The implementation
chose the latter: only ciphertext is persisted, with on-demand decryption.

### R-STORE-3: Key package private data must be stored securely

> **Status: ✅ Met**
>
> The `local_key_packages` table is inside the encrypted `crypto.db`. Private key
> packages use a versioned serialization format (`keySerialization.ts`) with
> length-prefixed fields instead of fragile fixed-offset byte slicing.
>
> **What satisfies this:** The encrypted database (R-STORE-1) covers this table.
> `serializePrivatePackage()` / `deserializePrivatePackage()` in `keySerialization.ts`
> provide the serialization format.
>
> **Do not remove:** The versioned serialization functions. Reverting to raw byte
> concatenation with `slice()` regresses to bug H3 (fragile serialization with no
> length validation).

---

## 6. Epoch Key Retention

### R-EPOCH-1: Historical messages require historical epoch keys (HARD PROBLEM)

> **Status: ✅ Met**
>
> **Decision: 📌 Option A — store ciphertext + per-epoch keys, never plaintext.**
>
> Implemented via ts-mls's built-in `historicalReceiverData` mechanism rather than a
> custom epoch key table. The `retainKeysForEpochs` config is set to 64 (up from
> the library default of 4). Each retained epoch adds ~2–5 KB to the serialized
> `ClientState`. At 64 epochs, total overhead is ~128–320 KB per group.
>
> **What satisfies this:** The `RETAIN_KEYS_FOR_EPOCHS = 64` constant in `mls.ts`,
> the `vesperClientConfig` object passed to `createGroup()` and `joinGroup()`, and
> ts-mls's internal `historicalReceiverData` map.
>
> **Do not remove:** The `retainKeysForEpochs` config or reduce it significantly
> without understanding the impact on historical message decryption. Reducing to the
> default of 4 means messages become unreadable after just 4 Commits.

MLS forward secrecy means that epoch keys should be deleted after the epoch advances.
But users expect to be able to scroll up and read historical messages. These two
requirements are in direct tension.

The implementation resolves this by retaining epoch key material for 64 epochs within
the MLS `ClientState`, allowing historical decryption within that window while still
providing forward secrecy beyond it.

### R-EPOCH-2: Epoch key deletion must be tied to message lifecycle

> **Status: ❌ Not met**
>
> Epoch key deletion is currently handled by ts-mls's fixed-window retention (oldest
> epochs beyond 64 are dropped). There is no mechanism to delete epoch keys when the
> last message from that epoch is deleted (e.g., via disappearing messages).
>
> **What's missing:** A post-delete hook that checks whether any messages remain for
> a given epoch and, if not, removes that epoch's key material from the retained set.
> This is architecturally complex because ts-mls manages `historicalReceiverData`
> internally — custom epoch-level deletion would require either library support or
> a wrapper that manipulates the serialized state.

When disappearing messages expire and the last message from an epoch is deleted, that
epoch's key should also be deleted. Otherwise forward secrecy is bounded by the
retention window rather than by actual message lifecycle.

---

## 7. Multi-Device

### R-DEVICE-1: New device bootstrap requires re-establishing group membership

> **Status: ⚠️ Partial**
>
> The identity key download and key package generation work. Pending Welcome messages
> are stored server-side (`mls_pending_welcomes`) and delivered on reconnect via
> `fetchPendingWelcomes()`. However, there is no explicit "rejoin all channels"
> flow on new device login — the user must visit each channel to trigger
> `ensureGroupMembership()`.
>
> **What satisfies the partial implementation:** `ensureGroupMembership()` in
> `cryptoStore.ts` (3-tier check: memory → DB → pending welcomes),
> `mls_pending_welcomes` server-side storage, `fetchPendingWelcomes()` API.

A new device downloads the encrypted key bundle and recovers the identity keys. But it
has no MLS group state. For each channel, the device must process a Welcome from an
existing member. Historical messages before the join point cannot be decrypted on the
new device — this is correct MLS behavior.

### R-DEVICE-2: Multiple active devices receive the same Commits

> **Status: ⚠️ Partial**
>
> MLS Commits are broadcast to all channel members via WebSocket. Two devices
> logged into the same account should both process the Commit and arrive at the same
> epoch state. However, this is not explicitly tested and there is no deduplication
> mechanism to prevent processing the same Commit twice.

If Device A and Device B are both online and both receive the same Commit, they should
both process it and arrive at the same epoch state. MLS is designed for this — the same
Commit applied to the same prior state produces the same new state. This should just
work, but it needs to be tested explicitly. A client must not process the same Commit
twice.

---

## 8. History Access for New Channel Members

### R-HIST-1: Decide the history policy explicitly

> **Status: 📌 Decision made — Option A (no history for new members)**
>
> New members joining a channel cannot decrypt messages from before they joined. This
> is the v1 behavior. Option C (history snapshot on join) is the future path if
> history access is desired.
>
> **What satisfies this:** The MLS protocol itself — a Welcome message produces state
> for the current epoch only. No code needs to be added; this is the default behavior.
>
> **Do not add:** Server-stored plaintext for historical access (Option B). This
> defeats E2EE.

New members joining a channel cannot decrypt pre-join messages. This is correct MLS
behavior and provides strong privacy guarantees. It is a significant UX regression from
Discord, where new members can scroll back — but the privacy tradeoff is worth it.

---

## 9. Member Joins and Leaves

### R-MEMBER-1: Key rotation on member leave must not fan-out catastrophically

> **Status: ⚠️ Partial**
>
> The per-group async mutex (`groupLock.ts`) ensures Commits are serialized within a
> client. Commit retry with backoff (3 attempts: 100ms, 500ms, 2s) handles epoch
> mismatch from concurrent committers.
>
> **What's missing:** Batch Remove Commits (collecting multiple leaves into a single
> Commit), server-side batching coordination, and lazy rotation for large channels.
>
> **What satisfies the partial implementation:** `withGroupLock()` wrapping all
> state-mutating operations in `cryptoStore.ts`, the retry logic in `handleCommit()`.
>
> **Do not remove:** The group lock or the commit retry logic. Without these,
> concurrent operations corrupt MLS state (bug H5) and failed commits are silently
> dropped (bug H6).

When a member leaves, a Remove Commit starts a new epoch. The thundering herd problem
(50 simultaneous leaves in a 500-member channel) is mitigated by serialized commits and
retry, but not yet by batching.

### R-MEMBER-2: Joins must not block on sender availability

> **Status: ✅ Met**
>
> Pending Welcome messages are stored server-side (`mls_pending_welcomes` table) and
> delivered when the joining user comes online. Join requests (`mls_request_join`) are
> broadcast to all online members. The `ensureGroupMembership()` function checks for
> pending welcomes on startup.
>
> **What satisfies this:** `mls_pending_welcomes` server-side storage,
> `Encryption.store_pending_welcome()`, `fetchPendingWelcomes()` in the crypto API,
> the pending welcome check in `ensureGroupMembership()`.

### R-MEMBER-3: The group creator problem

> **Status: ⚠️ Partial**
>
> Any member can create the MLS group if none exists (`createGroup()` in
> `cryptoStore.ts`). The `groupSetupInProgress` flag prevents double-creation within
> a single client.
>
> **What's missing:** Server-side first-wins coordination. If two members simultaneously
> create the group, both succeed locally but only one Commit can be authoritative. The
> server does not currently arbitrate this race.

---

## 10. Search

### R-SEARCH-1: Full-text search must be client-side only

> **Status: ⚠️ Partial**
>
> FTS5 infrastructure is in place: `message_fts` virtual table in encrypted `crypto.db`,
> `indexDecryptedMessage()` / `removeFromFtsIndex()` / `searchMessages()` functions
> wired through the full IPC stack. The FTS index is populated when messages are
> decrypted for display.
>
> **What's missing:** UI integration — `searchMessages()` in `messageStore` currently
> returns empty results. The search bar component exists but isn't connected to the
> FTS5 backend. Background indexing for historical messages is not implemented.
>
> **What satisfies the partial implementation:** `message_fts` table in `db.ts`,
> FTS5 query functions, IPC handlers, storage abstraction, and the fire-and-forget
> indexing call in `processIncomingMessage()`.
>
> **Do not remove:** The FTS5 table, the indexing functions, or the indexing calls
> in `processIncomingMessage` and `handleMessageEdited`. These are the foundation
> for search.

The server cannot search encrypted content. Client-side FTS5 is the only correct
approach.

### R-SEARCH-2: Server-side search must be limited to metadata

> **Status: ✅ Met**
>
> The server has no plaintext search capability. Message content is stored as
> ciphertext only. Any future server-side search must be restricted to metadata
> (sender, timestamp, channel).

---

## 11. Performance: Large Channel Decryption

### R-PERF-1: Never decrypt all messages on channel open

> **Status: ⚠️ Partial**
>
> Messages are loaded from the server API in batches (not all at once). The LRU
> decryption cache (2000 entries) prevents re-decrypting previously viewed messages.
>
> **What's missing:** True lazy decryption on scroll — currently all loaded messages
> are decrypted immediately. Virtual list integration to decrypt only visible messages
> is not implemented.
>
> **What satisfies the partial implementation:** `decryptionCache.ts` (LRU cache),
> the cache check in `processIncomingMessage()`.
>
> **Do not remove:** The decryption cache. Without it, scrolling through a channel
> triggers redundant re-decryption of every visible message.

### R-PERF-2: Epoch key lookups must be O(1)

> **Status: ✅ Met**
>
> ts-mls stores `historicalReceiverData` as a `Map<bigint, EpochReceiverData>`.
> Map lookups are O(1). No linear scan is performed during decryption.

### R-PERF-3: Group state updates must not block message display

> **Status: ⚠️ Partial**
>
> The per-group async mutex prevents concurrent state corruption, and state updates
> are async. However, all MLS operations still run on the renderer main thread.
> A Web Worker for crypto operations is not yet implemented.
>
> **What's missing:** Web Worker offloading of MLS operations. Risk: `ClientState`
> may not survive `structuredClone` for transfer to a Worker.

---

## 12. Bots

### R-BOT-1: Bots are E2EE members with explicit user consent

> **Status: ❌ Not met — bots are not yet implemented.**

When bots are implemented, they must be first-class MLS group members — they hold
key packages like any user, receive Welcomes, and can decrypt messages they're invited
to see. Inviting a bot must explicitly communicate that it gains decryption access.

### R-BOT-2: Bots cannot join channels automatically

> **Status: ❌ Not met — bots are not yet implemented.**

---

## 13. DMs vs. Channels

### R-DM-1: DMs have different churn expectations

> **Status: ✅ Met**
>
> DMs use the same MLS protocol as channels but with different membership dynamics.
> The `dm_channel.ex` handlers are separate from `chat_channel.ex`, allowing
> DM-specific behavior. The DM send flow in `messageStore.ts` has special logic
> for group creation and participant management.

### R-DM-2: DM history semantics should differ from channel history

> **Status: ✅ Met (by the no-history-for-new-members policy)**
>
> New participants added to a group DM cannot decrypt prior messages. This is the
> correct privacy behavior for DMs.

### R-DM-3: DM key rotation policy should be stricter

> **Status: ⚠️ Partial**
>
> DM Remove Commits trigger immediate key rotation (no batching window). However,
> there is no explicit policy enforcement distinguishing DM rotation urgency from
> channel rotation. The behavior is the same for both — individual Remove Commits
> per leave event.

---

## 14. File Attachments

### R-FILE-1: Files must be encrypted client-side before upload

> **Status: ✅ Met**
>
> `fileEncryption.ts` encrypts files with AES-256-GCM using a random per-file key
> and IV before upload. The key and IV are embedded in the `FilePayload` (v1 structured
> format) which is MLS-encrypted with the message. The server stores only the encrypted
> blob.
>
> **What satisfies this:** `encryptFile()` / `decryptFile()` in `fileEncryption.ts`,
> the `FilePayload` type in `payload.ts`, the `encodePayload()` call in
> `MessageInput.tsx` for file uploads.
>
> **Do not remove:** The file encryption functions, the `FilePayload` type, or the
> pattern of embedding file keys inside MLS-encrypted payloads. Without this, file
> encryption keys would need to travel separately, potentially in plaintext.

### R-FILE-2: Large file decryption must be chunked

> **Status: ❌ Not met**
>
> Files are encrypted and decrypted in a single shot. No chunked encryption for
> streaming decryption of large files. Files over ~50 MB may cause memory pressure.

### R-FILE-3: File deduplication is not possible with E2EE

> **Status: ✅ Met (by design)**
>
> Each file upload generates a random key, producing different ciphertext even for
> identical files. No server-side deduplication is attempted.

---

## 15. Rich Media Embeds and Link Previews

### R-LINK-1: Server-side link preview fetching is a metadata leak

> **Status: ❌ Not met**
>
> The server still has a `POST /link-preview` endpoint that fetches URLs on behalf
> of clients. Sender-side preview generation (the recommended approach) is not yet
> implemented. A TODO comment exists in `LinkPreview.tsx`.
>
> **Future path:** Sender-side preview generation — the sender's client fetches
> the URL, renders a preview, and includes it in the encrypted `MessagePayload`.
> Recipients see the preview without making network requests. The server never
> learns which URLs are shared.

### R-LINK-2: Link preview fetch must be optional and auditable

> **Status: ❌ Not met**
>
> No user-facing setting to disable automatic link preview fetching.

---

## 16. Notifications and Mentions

### R-NOTIF-1: Mention user IDs in plaintext (accepted metadata leak)

> **Status: 📌 Decision made — accepted metadata leak**
>
> Mentioned user IDs are sent as plaintext alongside encrypted message content for
> server-side notification routing. This is documented as a known metadata disclosure
> rather than a bug.
>
> **Rationale:** Notification delivery requires the server to know who to notify.
> Encrypting mention IDs would require either client-side polling (poor UX) or
> per-recipient encrypted mention blobs (complex). The pragmatic choice is to accept
> this metadata leak and document it.

### R-NOTIF-2: Push notifications for mobile must be designed before adding mobile clients

> **Status: ❌ Not met — mobile is out of scope for v1.**

---

## 17. Reactions

### R-REACT-1: Reactions are encrypted

> **Status: ✅ Met**
>
> **Decision: 📌 Encrypt reaction emoji content.**
>
> Emoji content is MLS-encrypted before sending. The server stores reactions with the
> sentinel emoji value `"encrypted"` and an opaque ciphertext blob. Clients decrypt
> emoji locally and compute aggregate counts client-side.
>
> **What satisfies this:** The encrypted reaction handlers in `chat_channel.ex` and
> `dm_channel.ex` (pattern-match on `ciphertext` field), `handle_reaction/7` overload
> in `channel_helpers.ex`, `remove_encrypted_reaction/2` in `chat.ex`, and the
> encrypt/decrypt calls in `messageStore.ts` for `addReaction`/`removeReaction`/
> `handleReactionUpdate`.
>
> **Do not remove:** The encrypted reaction path in the channel handlers, the
> `ciphertext`/`mls_epoch` columns on the reactions schema, or the client-side
> encrypt/decrypt for reactions. Removing these regresses to plaintext emoji visible
> to the server.
>
> **Limitation:** The unique constraint `[:message_id, :sender_id, :emoji]` limits
> encrypted reactions to one per user per message (all share the sentinel value).
> This matches Signal/WhatsApp behavior. Plaintext fallback exists for when no MLS
> group is established.

---

## 18. Voice

### R-VOICE-1: Voice key rotation on member join/leave must be immediate

> **Status: ⚠️ Partial**
>
> `deriveVoiceKey()` in `mls.ts` derives a 128-bit key from the MLS group's exporter
> secret. The key changes when the epoch advances (after a Commit). However, the
> automatic re-derivation on voice channel join/leave events is not fully wired —
> the voice channel handlers issue MLS events but the client-side voice encryption
> pipeline doesn't automatically re-derive the key on epoch change.
>
> **What satisfies the partial implementation:** `deriveVoiceKey()`, `getVoiceKey()`
> in `cryptoStore.ts`.

### R-VOICE-2: Voice and text channels should use separate MLS groups

> **Status: ✅ Met**
>
> Voice channels use separate channel IDs and therefore separate MLS groups. The
> voice MLS group is independent of the text MLS group for the same channel.

---

## 19. Design Decisions (Resolved)

All design decisions from the original analysis have been resolved:

| # | Question | Decision | Implemented |
|---|----------|----------|-------------|
| 1 | History for new channel members? | **No history (Option A)** — future path is Option C | ✅ |
| 2 | Epoch key retention strategy? | **Option A: ciphertext + per-epoch keys** — via ts-mls `retainKeysForEpochs=64` | ✅ |
| 3 | Message payload format? | **Structured JSON (v1)** — `payload.ts` with `TextPayload`/`FilePayload` | ✅ |
| 4 | Search implementation? | **SQLite FTS5** — infrastructure wired, UI pending | ⚠️ |
| 5 | Link preview approach? | **Sender-side generation** — not yet implemented | ❌ |
| 6 | Mention IDs in metadata? | **Accepted leak** — documented, not encrypted | ✅ |
| 7 | Remove Commit batching? | **Deferred** — individual commits with retry for now | ⚠️ |
| 8 | Reaction encryption? | **Yes** — emoji encrypted, server stores sentinel | ✅ |
| 9 | Commit authority for large channels? | **First-committer wins** with retry — no server arbitration yet | ⚠️ |
| 10 | Bot credential management? | **Deferred** — bots not yet implemented | ❌ |

---

## 20. Pre-Release Security Checklist

- [ ] Commission security audit of ts-mls (full library, not just Vesper's usage)
- [ ] Commission security audit of the identity backup/recovery flow
- [ ] Penetration test of the Phoenix API (focus: key package injection, IDOR)
- [x] All critical and high bugs from the E2EE refactor resolved (C1, C2, C3, H1-H6)
- [x] Verify MLS sender authentication is checked on every `decryptMessage` call
- [ ] Verify ts-mls forward secrecy: confirm old epoch secrets are zeroed after epoch advance
- [ ] Verify forward secrecy for disappearing messages: confirm epoch keys are deleted
      when all messages using them have expired
- [ ] Review Argon2id parameters (t=3, m=64MB, p=4) against current OWASP recommendations
- [ ] Rate limiting on auth endpoints and key package endpoints
- [ ] CSP headers on the web client
- [ ] Audit Electron renderer security settings (`contextIsolation: true`, `nodeIntegration: false`)
- [x] File attachment encryption: verify files are actually encrypted before upload
- [ ] Document the metadata disclosure from link preview proxying (or switch to sender-side)
- [x] Document mention user ID metadata disclosure as a known accepted limitation

---

## 21. Scope Boundaries

Things this document does NOT cover because they're separate concerns:

- **Voice encryption architecture** — already documented in DESIGN.md §6. The requirements
  here (R-VOICE-1, R-VOICE-2) note the interaction with MLS; the voice-specific design is
  elsewhere.
- **TLS transport security** — required but not E2EE-specific. Standard HTTPS/WSS.
- **Server-side access control** — permissions, roles, channel membership. These determine
  who CAN be in a group, but the E2EE layer determines what they can READ.
- **Operational security** (log retention, backup encryption) — the server operator's
  responsibility, documented in the self-hosting guide.
