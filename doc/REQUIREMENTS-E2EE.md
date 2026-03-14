# Vesper — E2EE Requirements & Design Analysis

> This document covers the hard requirements, design rationale, open decisions, and
> footguns for Vesper's end-to-end encryption. It is meant to be read in full —
> each requirement includes the reasoning behind it, the tradeoffs considered, and
> the implications of each choice.
>
> **Companion documents:**
> - [REQUIREMENTS-E2EE-AUDIT.md](./REQUIREMENTS-E2EE-AUDIT.md) — Implementation
>   status of every requirement. Shows what's met, what's partial, and what's not
>   yet implemented, with references to the specific code that satisfies each one.
> - [E2EE-IMPLEMENTATION.md](./E2EE-IMPLEMENTATION.md) — How the implementation
>   works today. Architecture, key lifecycle, developer guide, gotchas.
> - [DESIGN.md](./DESIGN.md) §5 — Overall E2EE architecture.
>
> Source: `client/src/renderer/src/crypto/`

---

## Requirements Index

> **Status column** links to the [implementation audit](./REQUIREMENTS-E2EE-AUDIT.md)
> which details what code satisfies each requirement, what's missing, and what must
> not be removed.

| ID | Summary | [Audit Status](./REQUIREMENTS-E2EE-AUDIT.md) |
|----|---------|-------|
| [R-PROTO-1](#r-proto-1-mls-rfc-9420-is-the-group-encryption-protocol) | MLS (RFC 9420) is the group encryption protocol | [✅ Met](./REQUIREMENTS-E2EE-AUDIT.md#r-proto-1-mls-rfc-9420-is-the-group-encryption-protocol) |
| [R-PROTO-2](#r-proto-2-the-server-must-be-cryptographically-blind-to-message-content) | Server must be cryptographically blind to message content | [✅ Met](./REQUIREMENTS-E2EE-AUDIT.md#r-proto-2-the-server-must-be-cryptographically-blind-to-message-content) |
| [R-PROTO-3](#r-proto-3-mls-authentication-is-required-not-optional) | MLS authentication is required, not optional | [✅ Met](./REQUIREMENTS-E2EE-AUDIT.md#r-proto-3-mls-authentication-is-required-not-optional) |
| [R-PROTO-4](#r-proto-4-ts-mls-must-be-security-audited-before-production) | ts-mls must be security-audited before production | [❌ Not met](./REQUIREMENTS-E2EE-AUDIT.md#r-proto-4-ts-mls-must-be-security-audited-before-production) |
| [R-KEY-1](#r-key-1-one-identity-per-user-account-not-per-device) | One identity per user account, not per device | [✅ Met](./REQUIREMENTS-E2EE-AUDIT.md#r-key-1-one-identity-per-user-account-not-per-device) |
| [R-KEY-2](#r-key-2-recovery-key-must-use-actual-bip39) | Recovery key must use actual BIP39 | [✅ Met](./REQUIREMENTS-E2EE-AUDIT.md#r-key-2-recovery-key-must-use-actual-bip39) |
| [R-KEY-3](#r-key-3-key-packages-must-be-pre-generated-and-replenished-proactively) | Key packages must be pre-generated and replenished proactively | [⚠️ Partial](./REQUIREMENTS-E2EE-AUDIT.md#r-key-3-key-packages-must-be-pre-generated-and-replenished-proactively) |
| [R-KEY-4](#r-key-4-private-key-material-must-not-exist-in-memory-longer-than-necessary) | Private key material must not exist in memory longer than necessary | [⚠️ Partial](./REQUIREMENTS-E2EE-AUDIT.md#r-key-4-private-key-material-must-not-exist-in-memory-longer-than-necessary) |
| [R-STORE-1](#r-store-1-mls-group-state-must-be-encrypted-at-rest-critical) | MLS group state must be encrypted at rest | [✅ Met](./REQUIREMENTS-E2EE-AUDIT.md#r-store-1-mls-group-state-must-be-encrypted-at-rest-critical) |
| [R-STORE-2](#r-store-2-decrypted-message-content-must-not-be-stored-as-plaintext-critical) | Decrypted message content must not be stored as plaintext | [✅ Met](./REQUIREMENTS-E2EE-AUDIT.md#r-store-2-decrypted-message-content-must-not-be-stored-as-plaintext-critical) |
| [R-STORE-3](#r-store-3-key-package-private-data-must-be-stored-securely) | Key package private data must be stored securely | [✅ Met](./REQUIREMENTS-E2EE-AUDIT.md#r-store-3-key-package-private-data-must-be-stored-securely) |
| [R-EPOCH-1](#r-epoch-1-historical-messages-require-historical-epoch-keys-hard-problem) | Historical messages require historical epoch keys | [✅ Met](./REQUIREMENTS-E2EE-AUDIT.md#r-epoch-1-historical-messages-require-historical-epoch-keys-hard-problem) |
| [R-EPOCH-2](#r-epoch-2-epoch-key-deletion-must-be-tied-to-message-lifecycle) | Epoch key deletion must be tied to message lifecycle | [❌ Not met](./REQUIREMENTS-E2EE-AUDIT.md#r-epoch-2-epoch-key-deletion-must-be-tied-to-message-lifecycle) |
| [R-DEVICE-1](#r-device-1-new-device-bootstrap-requires-re-establishing-group-membership) | New device bootstrap requires re-establishing group membership | [⚠️ Partial](./REQUIREMENTS-E2EE-AUDIT.md#r-device-1-new-device-bootstrap-requires-re-establishing-group-membership) |
| [R-DEVICE-2](#r-device-2-multiple-active-devices-receive-the-same-commits) | Multiple active devices receive the same Commits | [⚠️ Partial](./REQUIREMENTS-E2EE-AUDIT.md#r-device-2-multiple-active-devices-receive-the-same-commits) |
| [R-HIST-1](#r-hist-1-decide-the-history-policy-explicitly) | Decide the history policy explicitly | [📌 Decided](./REQUIREMENTS-E2EE-AUDIT.md#r-hist-1-decide-the-history-policy-explicitly) |
| [R-MEMBER-1](#r-member-1-key-rotation-on-member-leave-must-not-fan-out-catastrophically) | Key rotation on member leave must not fan-out catastrophically | [⚠️ Partial](./REQUIREMENTS-E2EE-AUDIT.md#r-member-1-key-rotation-on-member-leave-must-not-fan-out-catastrophically) |
| [R-MEMBER-2](#r-member-2-joins-must-not-block-on-sender-availability) | Joins must not block on sender availability | [✅ Met](./REQUIREMENTS-E2EE-AUDIT.md#r-member-2-joins-must-not-block-on-sender-availability) |
| [R-MEMBER-3](#r-member-3-the-group-creator-problem) | The group creator problem | [⚠️ Partial](./REQUIREMENTS-E2EE-AUDIT.md#r-member-3-the-group-creator-problem) |
| [R-SEARCH-1](#r-search-1-full-text-search-must-be-client-side-only) | Full-text search must be client-side only | [⚠️ Partial](./REQUIREMENTS-E2EE-AUDIT.md#r-search-1-full-text-search-must-be-client-side-only) |
| [R-SEARCH-2](#r-search-2-server-side-search-must-be-limited-to-metadata) | Server-side search must be limited to metadata | [✅ Met](./REQUIREMENTS-E2EE-AUDIT.md#r-search-2-server-side-search-must-be-limited-to-metadata) |
| [R-PERF-1](#r-perf-1-never-decrypt-all-messages-on-channel-open) | Never decrypt all messages on channel open | [⚠️ Partial](./REQUIREMENTS-E2EE-AUDIT.md#r-perf-1-never-decrypt-all-messages-on-channel-open) |
| [R-PERF-2](#r-perf-2-epoch-key-lookups-must-be-o1) | Epoch key lookups must be O(1) | [✅ Met](./REQUIREMENTS-E2EE-AUDIT.md#r-perf-2-epoch-key-lookups-must-be-o1) |
| [R-PERF-3](#r-perf-3-group-state-updates-must-not-block-message-display) | Group state updates must not block message display | [⚠️ Partial](./REQUIREMENTS-E2EE-AUDIT.md#r-perf-3-group-state-updates-must-not-block-message-display) |
| [R-BOT-1](#r-bot-1-bots-are-e2ee-members-with-explicit-user-consent) | Bots are E2EE members with explicit user consent | [❌ Not met](./REQUIREMENTS-E2EE-AUDIT.md#r-bot-1-bots-are-e2ee-members-with-explicit-user-consent) |
| [R-BOT-2](#r-bot-2-bots-cannot-join-channels-automatically) | Bots cannot join channels automatically | [❌ Not met](./REQUIREMENTS-E2EE-AUDIT.md#r-bot-2-bots-cannot-join-channels-automatically) |
| [R-DM-1](#r-dm-1-dms-have-different-churn-expectations) | DMs have different churn expectations | [✅ Met](./REQUIREMENTS-E2EE-AUDIT.md#r-dm-1-dms-have-different-churn-expectations) |
| [R-DM-2](#r-dm-2-dm-history-semantics-should-differ-from-channel-history) | DM history semantics should differ from channel history | [✅ Met](./REQUIREMENTS-E2EE-AUDIT.md#r-dm-2-dm-history-semantics-should-differ-from-channel-history) |
| [R-DM-3](#r-dm-3-dm-key-rotation-policy-should-be-stricter) | DM key rotation policy should be stricter | [⚠️ Partial](./REQUIREMENTS-E2EE-AUDIT.md#r-dm-3-dm-key-rotation-policy-should-be-stricter) |
| [R-FILE-1](#r-file-1-files-must-be-encrypted-client-side-before-upload) | Files must be encrypted client-side before upload | [✅ Met](./REQUIREMENTS-E2EE-AUDIT.md#r-file-1-files-must-be-encrypted-client-side-before-upload) |
| [R-FILE-2](#r-file-2-large-file-decryption-must-be-chunked) | Large file decryption must be chunked | [❌ Not met](./REQUIREMENTS-E2EE-AUDIT.md#r-file-2-large-file-decryption-must-be-chunked) |
| [R-FILE-3](#r-file-3-file-deduplication-is-not-possible-with-e2ee) | File deduplication is not possible with E2EE | [✅ Met](./REQUIREMENTS-E2EE-AUDIT.md#r-file-3-file-deduplication-is-not-possible-with-e2ee) |
| [R-LINK-1](#r-link-1-server-side-link-preview-fetching-is-a-metadata-leak) | Server-side link preview fetching is a metadata leak | [❌ Not met](./REQUIREMENTS-E2EE-AUDIT.md#r-link-1-server-side-link-preview-fetching-is-a-metadata-leak) |
| [R-LINK-2](#r-link-2-link-preview-fetch-must-be-optional-and-auditable) | Link preview fetch must be optional and auditable | [❌ Not met](./REQUIREMENTS-E2EE-AUDIT.md#r-link-2-link-preview-fetch-must-be-optional-and-auditable) |
| [R-NOTIF-1](#r-notif-1-mention-user-ids-must-not-be-sent-in-plaintext-current-bug) | Mention user IDs must not be sent in plaintext | [📌 Decided](./REQUIREMENTS-E2EE-AUDIT.md#r-notif-1-mention-user-ids-in-plaintext-accepted-metadata-leak) |
| [R-NOTIF-2](#r-notif-2-push-notifications-for-mobile-must-be-designed-before-adding-mobile-clients) | Push notifications for mobile must be designed before adding mobile clients | [❌ Not met](./REQUIREMENTS-E2EE-AUDIT.md#r-notif-2-push-notifications-for-mobile-must-be-designed-before-adding-mobile-clients) |
| [R-REACT-1](#r-react-1-decide-whether-reactions-are-encrypted) | Decide whether reactions are encrypted | [✅ Met](./REQUIREMENTS-E2EE-AUDIT.md#r-react-1-reactions-are-encrypted) |
| [R-VOICE-1](#r-voice-1-voice-key-rotation-on-member-joinleave-must-be-immediate) | Voice key rotation on member join/leave must be immediate | [⚠️ Partial](./REQUIREMENTS-E2EE-AUDIT.md#r-voice-1-voice-key-rotation-on-member-joinleave-must-be-immediate) |
| [R-VOICE-2](#r-voice-2-voice-and-text-channels-should-use-separate-mls-groups) | Voice and text channels should use separate MLS groups | [✅ Met](./REQUIREMENTS-E2EE-AUDIT.md#r-voice-2-voice-and-text-channels-should-use-separate-mls-groups) |

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

MLS provides forward secrecy, post-compromise security, and efficient group key
management for groups from 2 to ~50,000 members. One protocol for both DMs and
channels is the correct approach — two encryption systems would double the attack
surface and the implementation burden.

Cipher suite: `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` (current default). This
is appropriate. The post-quantum cipher suite (`X-Wing`) should remain opt-in until
ts-mls has been audited and the performance characteristics of X-Wing in large groups
are understood.

### R-PROTO-2: The server must be cryptographically blind to message content

The server stores and forwards MLS ciphertext. It must never receive plaintext, must
never have access to any private key material, and must never be able to derive message
encryption keys. This is already the design — but it has implications for several
features discussed below (search, notifications, link previews) that need to be thought
through carefully.

### R-PROTO-3: MLS authentication is required, not optional

MLS doesn't just encrypt — it authenticates. Every message contains a signature from
the sender's identity key, verifiable by all group members. This prevents the server
from impersonating senders or injecting messages. The implementation MUST verify sender
authentication when decrypting; silently accepting unauthenticated messages is a
critical vulnerability.

### R-PROTO-4: ts-mls must be security-audited before production

ts-mls is a pure TypeScript MLS implementation that has not undergone a formal security
audit. This is already called out in the design doc. The requirement is: **do not
remove this from the pre-release checklist**. An unaudited E2EE implementation is not
E2EE in any meaningful security sense.

---

## 4. Identity and Key Management

### R-KEY-1: One identity per user account, not per device

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

**Current issue:** `identity.ts` generates a custom wordlist of programmatically
constructed pronounceable strings (like `bcfod`, `becos`). This is not BIP39. The words
are not human-recognizable, not compatible with standard hardware wallet tooling, and
harder to transcribe accurately.

**Requirement:** Use the actual BIP39 English wordlist (2048 words). It should be
bundled as a static asset. The encoding algorithm already implements 11-bit indexing
correctly — only the wordlist source needs to change.

### R-KEY-3: Key packages must be pre-generated and replenished proactively

Key packages are consumed one-per-group-join. A user with no remaining key packages
cannot be added to new groups. The current design uploads 10-20 at a time and
replenishes after consumption — this is correct in principle.

**Requirements:**
- Never let the count drop to zero. When count falls below a threshold (suggest: 5),
  replenish immediately rather than waiting for the next consumption event.
- The replenishment call should be retried if it fails, with backoff.
- On login to a new device, generate and upload a fresh batch immediately before any
  channel joins are attempted.
- Key packages should have a lifetime set (they do via `defaultLifetime`) — enforce
  server-side rejection of expired key packages.

### R-KEY-4: Private key material must not exist in memory longer than necessary

After decrypting the key bundle at login, the raw private key bytes should be zeroed
from memory after importing into the Web Crypto API. JavaScript's GC makes this
difficult to guarantee, but the obvious copies (temporary Uint8Arrays) should be
zeroed after use. This is a best-effort requirement given the JS runtime, but the intent
should be explicit.

---

## 5. Local Storage

### R-STORE-1: MLS group state must be encrypted at rest (CRITICAL)

**Current issue:** `client/src/main/db.ts` creates `crypto.db` as a plain SQLite
database with no encryption. The `mls_groups` table stores group state as raw bytes.
MLS group state contains key material — specifically, the epoch secret from which all
message encryption keys are derived. Storing this in plaintext means that anyone with
filesystem access to the user's machine can read the group state and derive decryption
keys for messages in the current epoch.

**Requirement:** The entire `crypto.db` must be encrypted at rest. Options:
1. Use Electron's `safeStorage` API to encrypt a symmetric key, then use that key with
   SQLite's encryption extension (SEE, sqlcipher, or better-sqlite3-multiple-ciphers)
2. Encrypt all BLOB columns individually before storing (less ideal — the index and
   metadata are still exposed)

The design doc mentions `safeStorage` as the intended approach — this must be implemented.

### R-STORE-2: Decrypted message content must not be stored as plaintext (CRITICAL)

**Current issue:** The `message_cache` table in `crypto.db` stores the `content` column
as plaintext TEXT after decryption. This means anyone with access to the local database
file has full read access to all cached messages, bypassing E2EE entirely.

**Requirement:** Either:
- Encrypt the `content` column with a key derived from the user's password or stored in
  `safeStorage` before writing to cache (same protection as the key bundle)
- Or: don't persist decrypted plaintext at all — keep only the ciphertext locally, and
  re-decrypt on load. This is simpler and avoids the "what do you encrypt the cache with"
  question.

The re-decrypt approach has a significant implication: **you need to retain the epoch
keys** used to encrypt historical messages, or you cannot display them. See R-EPOCH-1.

### R-STORE-3: Key package private data must be stored securely

The `local_key_packages` table stores `key_package_private` as raw bytes. This is
private HPKE key material. It must be covered by the same at-rest encryption as the
group state (R-STORE-1).

---

## 6. Epoch Key Retention

### R-EPOCH-1: Historical messages require historical epoch keys (HARD PROBLEM)

MLS forward secrecy means that epoch keys should be deleted after the epoch advances.
But users expect to be able to scroll up and read historical messages. These two
requirements are in direct tension.

**The fundamental issue:** `decryptMessage` in `mls.ts` only accepts the current
`ClientState` and can only decrypt messages from the current epoch. If a Commit has
been issued (e.g., because someone joined or left), old messages encrypted in the
previous epoch cannot be decrypted with the new state.

**Current behavior:** The `message_cache` table stores decrypted plaintext. This
sidesteps the epoch problem — once decrypted, the plaintext is stored and re-displayed
without needing to re-decrypt. But this conflicts with R-STORE-2.

**Options for resolving this tension:**

**Option A: Cache ciphertext + per-epoch keys (recommended)**
- Store ciphertext locally (never plaintext)
- Maintain an `epoch_keys` table in `crypto.db` keyed by `(group_id, epoch)`
- Each epoch key is the minimum material needed to decrypt messages from that epoch
- Decrypt on display from ciphertext + epoch key
- Delete epoch keys when all messages from that epoch have either been deleted or
  rendered inaccessible (e.g., due to disappearing message expiry)
- Epoch keys are never sent to the server — they live only in the local encrypted DB

**Option B: Plaintext cache with strong local encryption**
- Cache decrypted plaintext, but encrypt the cache with a key from `safeStorage`
- Simpler implementation, but means plaintext persists indefinitely on disk
- Weaker forward secrecy property: compromising the device later reveals all history,
  not just current epoch content

**Option C: No persistent local cache (Signal approach)**
- Only keep messages in memory during the session
- App re-fetches and re-decrypts from server ciphertext on each launch
- Requires epoch key retention to re-decrypt
- History is bounded by what the server retains

**Decision needed:** Which option do we implement? The recommendation is Option A.
It preserves forward secrecy semantics, supports history display, and gives us a clean
model for disappearing messages (delete the epoch key when all messages in it expire).

### R-EPOCH-2: Epoch key deletion must be tied to message lifecycle

When disappearing messages expire, the associated ciphertext is deleted from the server.
If we implement Option A above, we must also delete the local epoch key once no messages
from that epoch remain in the local cache. Otherwise, the epoch key persists indefinitely
and forward secrecy is illusory.

Specifically: when the Oban job deletes expired messages server-side, the client must
also delete them from local cache. When the last message from an epoch is deleted from
local cache, that epoch's key should be deleted from `epoch_keys`.

---

## 7. Multi-Device

### R-DEVICE-1: New device bootstrap requires re-establishing group membership

**The current problem:** A new device downloads the encrypted key bundle and recovers
the identity keys. But it has no MLS group state for any channel the user is a member
of. The `mls_groups` table is empty.

**What must happen on new device login:**
1. The device generates fresh key packages and uploads them to the server
2. For each channel the user is a member of, the device must request to join the MLS group
3. An existing member (another device or another user) must process that join request,
   issue a Commit + Welcome, and deliver the Welcome to the new device
4. The new device processes the Welcome and has the current group state
5. Historical messages before the join point cannot be decrypted on the new device
   (this is correct MLS behavior — new device = new group member)

**The UX implication:** "You're viewing this channel on a new device. Messages from
before you logged in here aren't available." This needs to be communicated clearly.
If historical access is required on new devices, see R-HIST-1.

### R-DEVICE-2: Multiple active devices receive the same Commits

If Device A and Device B are both online and both receive the same Commit, they should
both process it and arrive at the same epoch state. MLS is designed for this — the same
Commit applied to the same prior state produces the same new state. This should just
work, but it needs to be tested explicitly. A client must not process the same Commit
twice.

---

## 8. History Access for New Channel Members

### R-HIST-1: Decide the history policy explicitly

New members joining a channel cannot decrypt messages from before they joined. This is
correct MLS behavior and provides strong privacy guarantees. But it's also a significant
UX regression from Discord, where new members can scroll back and read years of history.

**Options:**

**Option A: No history for new members (Signal-style)**
- Simplest. Correct from a privacy perspective.
- Existing members' past messages are protected even from new members they invite.
- Significant Discord parity gap.

**Option B: Server-stored plaintext for historical access**
- Messages are stored server-side in plaintext in addition to E2EE ciphertext.
- New members can read history. Server operator can read history.
- This is not E2EE for historical purposes. Defeats the point.
- Do not do this.

**Option C: History snapshot on join (complex, correct)**
- When a new member joins, a designated member (e.g., the adder) creates an encrypted
  history bundle: a snapshot of recent messages re-encrypted under the Welcome's group
  secret.
- The new member decrypts the bundle via their Welcome and gets the history.
- This requires the adder to have the historical plaintext cached locally.
- Complex to implement correctly. Puts history burden on one client being online and
  cooperative.

**Option D: History epoch key sharing (compromise)**
- The adder shares past epoch keys (not messages) with the new member, wrapped in the
  Welcome's group secret.
- The new member can then fetch server-stored ciphertext and decrypt it.
- Exposes past key material to the new member — weakens forward secrecy for the history
  shared with them, but not for the overall group.
- Simpler than Option C but has meaningful security tradeoffs.

**Recommendation:** Start with Option A. Communicate it clearly in the UI. Add a
"History for new members" setting at the channel level later if there's demand, with
Option C as the implementation path.

**The important thing is to decide this now** — retrofitting history access after
the protocol is established is much harder than building in the hooks upfront.

---

## 9. Member Joins and Leaves

### R-MEMBER-1: Key rotation on member leave must not fan-out catastrophically

When a member leaves a channel, the correct action is to issue a Remove Commit, starting
a new MLS epoch. The departed member has no key material for the new epoch and cannot
decrypt future messages.

**The thundering herd problem:** In a channel with 500 members, if 50 people leave
simultaneously (e.g., server reboot, mass kick), 50 Remove Commits need to be issued.
Each remaining member needs to process all 50. That's 450 × 50 = 22,500 Commit
processing operations.

**Requirements:**
- Commits must be serialized — only one Commit can be in-flight per group at a time.
  A member should not issue a new Commit until the previous one is confirmed by the server.
- If a member's Commit fails because someone else's Commit was processed first (epoch
  advanced), that member must re-process the winning Commit and retry if their desired
  operation is still needed.
- **Batch removes:** A member issuing a Commit should be able to batch multiple remove
  proposals in a single Commit. If someone is processing a Remove for user A, they
  should also include any other pending removes in the same Commit to reduce fanout.
- **Remove batching window:** Consider a server-side coordination mechanism: when a
  remove event occurs, the server waits up to N milliseconds (suggest: 100ms) for
  additional removes to batch, then signals "one of you should issue a batched Remove
  Commit for these members."
- **Lazy rotation for large channels:** For channels above a configurable member
  threshold (suggest: 100), consider delayed key rotation — batch removes over a time
  window rather than rotating immediately on every leave. The tradeoff: departed members
  can decrypt messages for up to that window. This is explicitly acceptable for
  general-purpose channels; voice/private channels should always rotate immediately.

### R-MEMBER-2: Joins must not block on sender availability

The current flow for joining an MLS group requires an existing member to be online,
process the join request, and emit a Commit + Welcome. If no existing member is online,
the joining user cannot decrypt messages.

**Requirements:**
- The server must store pending Welcome messages for offline delivery (already in the
  schema via `mls_pending_welcomes` — verify this is actually used).
- The join request (`mls_request_join`) must be relayed to all online members, not just
  one. Multiple members may race to respond — the first Welcome received by the joiner
  should be used; subsequent ones can be acknowledged and discarded.
- There must be a timeout + retry mechanism: if no Welcome arrives within N seconds,
  re-broadcast the join request.

### R-MEMBER-3: The group creator problem

The first user to open a channel creates the MLS group. If the channel exists but no
one has the group state (e.g., the creator left, or this is a freshly deployed server),
any member should be able to create a new group. The subsequent member joins via
normal join request + Welcome flow.

This is already implemented in `cryptoStore.ts` (`createGroup` function). It works but
has a race: two members might both try to create the group simultaneously. The server
needs to handle this — probably by treating the first Commit as authoritative and
rejecting the second.

---

## 10. Search

### R-SEARCH-1: Full-text search must be client-side only

The server cannot search encrypted message content. Server-side search indexes are
impossible without either breaking E2EE (storing plaintext) or implementing
searchable symmetric encryption (which is complex, expensive, and still leaks query
patterns to the server).

**The approach:** SQLite FTS5 on the local message cache. This already partially exists
— `searchMessages` in `db.ts` uses a LIKE query on the `content` column. Replace this
with SQLite FTS5 for proper full-text search with ranking.

**Limitations to communicate:**
- Search only covers messages that have been loaded and decrypted on this device.
- Messages from before the user joined the channel are not searchable.
- Messages only cached during prior sessions are searchable; messages that have never
  been loaded on this device are not.
- Cross-channel search is bounded by what's in the local cache.

**Implication on caching strategy:** Search quality degrades if messages are never
cached. If we adopt the Option A epoch key approach (R-EPOCH-1), we should cache
ciphertext and decrypt on demand for display, but also maintain an FTS5 index over
the decrypted content. The FTS5 index content must be protected by the same encryption
as the rest of `crypto.db` (R-STORE-1).

**Approach for large channels:** When a user first opens a large channel, loading and
decrypting thousands of messages for the search index is expensive. Options:
- Background indexing: decrypt and index messages lazily as the user scrolls
- Limit initial index to the most recent N messages (suggest: last 1000 per channel)
- Show "index building" progress for channels being indexed for the first time

### R-SEARCH-2: Server-side search must be limited to metadata

The server CAN search on metadata: sender IDs, timestamps, channel membership. An API
that returns "all messages from user X in channel Y between time A and B" is fine — the
client then fetches those ciphertext blobs and decrypts them. This is not full-text
search but it satisfies the "find messages from Alice" use case without breaking E2EE.

---

## 11. Performance: Large Channel Decryption

### R-PERF-1: Never decrypt all messages on channel open

Loading a channel with 10,000 messages must not trigger 10,000 decryption operations.

**Requirements:**
- Load and decrypt only the most recent N messages (suggest: 50) on channel open.
- Decrypt additional messages lazily as the user scrolls up (virtual list / infinite scroll).
- Ciphertext blobs and decrypted plaintext (or the FTS index) are cached locally so
  messages don't need to be re-fetched and re-decrypted on subsequent views.
- Decryption must happen off the main thread. The current implementation does MLS
  crypto synchronously in the renderer process — this will block the UI for large batches.
  Move decryption to a Web Worker (there's already an `e2ee-worker.ts` for voice; the
  same pattern applies to message decryption).

### R-PERF-2: Epoch key lookups must be O(1)

When decrypting a historical message, the client must look up the epoch key for that
message's epoch. This lookup must be fast. A table indexed on `(group_id, epoch)` is
sufficient. Do not scan all epoch keys linearly.

### R-PERF-3: Group state updates must not block message display

Processing a Commit updates the group state in memory and on disk. This should not
block rendering of messages that are already decrypted. The update should happen
asynchronously, with a lock to prevent concurrent state updates.

---

## 12. Bots

### R-BOT-1: Bots are E2EE members with explicit user consent

When bots are implemented, they must be first-class MLS group members — they hold
key packages like any user, receive Welcomes, and can decrypt messages they're invited
to see. This is the only approach that doesn't require a special "bypass E2EE for bots"
mode, which would be a security hole.

**Implications:**
- Inviting a bot to a channel means explicitly granting it decryption access. The UI
  must make this visible. "Adding this bot will allow it to read messages in this
  channel" — not hidden, not implicit.
- Bot credentials are managed by the bot operator. The Vesper server does not hold bot
  private keys.
- Bots should be visually distinguished in the member list and in messages (verified
  bot badge or similar).
- Removing a bot triggers a Remove Commit like any other member removal. After removal,
  the bot cannot decrypt future messages.

### R-BOT-2: Bots cannot join channels automatically

A bot must be explicitly added by a channel administrator. No mechanism should allow
a bot to self-add or to receive messages from channels it hasn't been explicitly invited
to.

---

## 13. DMs vs. Channels

The current design uses MLS for both (see DESIGN.md §5 "MLS Group Mapping"). This is
correct — same protocol, different membership sizes and churn patterns. The key
behavioral differences are:

### R-DM-1: DMs have different churn expectations

A DM between two people has exactly two MLS group members. Key rotation events are rare
(only on device changes or if the DM is a group DM with an added/removed participant).
The thundering herd concerns from R-MEMBER-1 don't apply.

However, group DMs (3-10 people) are more like small channels and have the same join/leave
considerations, just at smaller scale.

### R-DM-2: DM history semantics should differ from channel history

For DMs, there's a strong argument that a new participant added to a group DM should
NOT get history by default — unlike channels, DMs have a strong expectation that "what
was said before you joined stays before you joined." This should be the default, with
explicit history sharing (Option C from R-HIST-1) as an opt-in when the adder chooses
to share history with the new participant.

### R-DM-3: DM key rotation policy should be stricter

When someone is removed from a group DM, key rotation should be immediate and
unconditional — no batching window, no lazy rotation. DMs are more private than general
channels and the threat model is more personal.

---

## 14. File Attachments

### R-FILE-1: Files must be encrypted client-side before upload

**Current status:** The schema has `encrypted BOOLEAN NOT NULL DEFAULT FALSE`. The
design doc mentions encrypted file uploads. The actual encryption implementation needs
to be verified and made concrete.

**Required approach:**
1. Client generates a random 256-bit AES-GCM key for each file
2. Client encrypts the file with this key before uploading
3. The file encryption key (and decryption nonce, and content type) is included in the
   message ciphertext — encrypted by MLS alongside the message text
4. The server receives: encrypted file blob (cannot decrypt) + message ciphertext
   (cannot decrypt the key inside)
5. Recipient decrypts the message → extracts the file key → decrypts the file

**The message format must evolve to support this.** A message with an attachment is
not just a text string — it's a structured object containing text content, attachment
references, and decryption keys. The plaintext that MLS encrypts should be a JSON
(or msgpack) payload, not a bare string. This is a breaking change to the current
`encryptMessage(state, plaintext: string)` signature.

### R-FILE-2: Large file decryption must be chunked

AES-GCM requires authentication before decryption begins. For large files, this means
the entire ciphertext must be downloaded before decryption and playback can start.

**Requirement:** For files above a threshold (suggest: 5MB), use chunked encryption:
- Split the file into chunks (suggest: 256KB each)
- Each chunk is encrypted with AES-GCM independently, with the chunk index included
  in the associated data to prevent chunk reordering attacks
- A per-file master key encrypts each chunk key (or the chunk keys are derived from
  the master key with chunk index)
- This allows streaming decryption: download chunk → decrypt chunk → play/display chunk
- Particularly important for video files

### R-FILE-3: File deduplication is not possible with E2EE

Identical files uploaded by different users will produce different ciphertexts (random
keys). Server-side deduplication is impossible without decryption. This is an accepted
cost. Storage implications should be noted in the self-hosting documentation.

---

## 15. Rich Media Embeds and Link Previews

### R-LINK-1: Server-side link preview fetching is a metadata leak

**Current implementation:** `POST /link-preview` — the client sends a URL to the server,
which fetches it and returns preview metadata. The server now knows which URLs are being
shared, by whom, and approximately when.

This is not a content privacy violation (the URL is in the encrypted message the server
can't read), but it is a **deliberate metadata disclosure by the client**. The client
is explicitly telling the server "this URL was just shared." This is a meaningful
privacy regression compared to doing nothing.

**Options:**

**Option A: Sender-side preview generation, encrypted to group (Signal approach)**
- The sender's client fetches the URL, renders a preview (title, description, image)
- This preview is included in the encrypted message payload
- Recipients see the preview without making any network requests
- The server never learns which URLs are shared
- Downside: the sender's IP is exposed to the URL's host (but this happens when they
  visit the link anyway)

**Option B: Receiver-side preview generation (current approach but honest)**
- Each client fetches the URL when it displays the message
- Server never learns the URL
- Each recipient's IP is exposed to the URL's host
- No server involvement needed

**Option C: Keep server-side proxy but document the tradeoff**
- Server protects recipient IPs but learns URLs
- Acceptable for some deployments, unacceptable for others

**Recommendation:** Implement Option A (sender-side) as default. It's the most
privacy-preserving and doesn't require server infrastructure. Receiver-side rendering
(Option B) should be a client fallback for URLs that fail or for images the sender
didn't preview.

### R-LINK-2: Link preview fetch must be optional and auditable

Whatever approach is chosen, link preview fetching must be opt-in or opt-out at the
user level. A user should be able to disable automatic external URL requests entirely.

---

## 16. Notifications and Mentions

### R-NOTIF-1: Mention user IDs must not be sent in plaintext (CURRENT BUG)

**Current issue:** The WebSocket event `new_message` takes a payload that includes
`mentioned_user_ids` as a plaintext field alongside the `ciphertext`. This means the
server knows exactly which users were @mentioned in every message, even though it
cannot read the message content.

For a general-purpose chat app this is probably acceptable metadata leakage, but it
contradicts the stated goal of the server being blind to message content. At minimum
this should be documented as a design decision rather than an oversight.

**Options:**
- Include mention IDs inside the encrypted message payload (server can't read them,
  but also can't route notifications — clients must poll)
- Keep mention IDs plaintext but acknowledge it as a known metadata leak
- Encrypt mention IDs separately, readable only by each mentioned user, for server-routed
  notifications (complex)

**Recommendation:** Keep mention IDs as metadata (plaintext) for notification routing,
but document it explicitly as a known metadata disclosure. This is the pragmatic choice
given that notification delivery requires the server to know who to wake up.

### R-NOTIF-2: Push notifications for mobile must be designed before adding mobile clients

Mobile push notifications in E2EE are a well-known hard problem. Apple and Google's
push systems require the server to send a payload to their infrastructure. Options:
- Generic "you have a new message" notification (no content, no sender — very safe, poor UX)
- Include sender name but no content (reveals sender as metadata, reasonable compromise)
- Sealed sender notifications (complex, requires per-device encrypted payloads)

Mobile is currently out of scope. But the decision about which notification approach to
use has architectural implications (server-side notification content, payload format).
Design it before building mobile, not after.

---

## 17. Reactions

### R-REACT-1: Decide whether reactions are encrypted

**Current schema:** Reactions have an optional `ciphertext` and `mls_epoch` column,
suggesting encryption is planned but not decided. The emoji field exists as plaintext.

**The tradeoff:**
- Unencrypted reactions: server knows who reacted to which message with which emoji.
  This leaks some information (reactions reveal sentiment; 💀 or ❤️ on a message says
  something even without reading the message).
- Encrypted reactions: server cannot see the emoji content. But it also cannot compute
  aggregate counts (how many 👍 does this message have?) without client aggregation.
  The server would only know "user X added a reaction to message Y."

**Recommendation:** Encrypt reaction emoji content. The reaction event can include
an encrypted blob alongside the message ID and sender ID (both metadata the server
already knows). All clients decrypt the emoji and compute their own aggregate counts.
This is a minor implementation complexity for a meaningful privacy improvement.

---

## 18. Voice

### R-VOICE-1: Voice key rotation on member join/leave must be immediate

The current design derives a voice encryption key from the MLS group's exporter secret
via `deriveVoiceKey`. When a member joins or leaves the voice channel, the MLS group
for that voice channel must issue a Commit (starting a new epoch), and all participants
must re-derive the voice key from the new epoch's exporter secret.

This must happen synchronously with the join/leave event — a departed member hearing
encrypted audio they can't decrypt is the desired behavior; a departed member hearing
audio they CAN decrypt is a security failure.

### R-VOICE-2: Voice and text channels should use separate MLS groups

This is already the design (separate groups per channel type). Verify that the voice
MLS group lifecycle is independent of the text MLS group for the same channel — they
should be. Voice groups should be ephemeral: created when the first participant joins,
dissolved when the last one leaves. The exporter secret used for voice key derivation
is isolated to voice participants, not exposed to text-only members.

---

## 19. Open Design Decisions

The following questions do not have answers yet. They need decisions before the E2EE
implementation is refactored, because each one has architectural consequences.

| # | Question | Options | Impact |
|---|----------|---------|--------|
| 1 | History for new channel members? | No history / History snapshot / Epoch key sharing | Core protocol |
| 2 | Epoch key retention strategy? | Option A (ciphertext + epoch keys) / Option B (encrypted plaintext cache) / Option C (no persistence) | Local storage schema |
| 3 | Message payload format? | Bare string / Structured JSON / msgpack | Attachment key delivery, mentions |
| 4 | Search implementation? | SQLite LIKE (current) / SQLite FTS5 / No server search | UX |
| 5 | Link preview approach? | Sender-side / Receiver-side / Server proxy | Privacy |
| 6 | Mention IDs in metadata? | Keep plaintext / Encrypt / Document as accepted leak | Metadata privacy |
| 7 | Remove Commit batching? | Immediate / Windowed batching | Scale |
| 8 | Reaction encryption? | Yes / No | Privacy |
| 9 | Commit authority for large channels? | First-committer wins / Designated committer / Round-robin | Coordination |
| 10 | Bot credential management? | Bot operator managed / Server-managed (dangerous) | Future arch |

---

## 20. Pre-Release Security Checklist

- [ ] Commission security audit of ts-mls (full library, not just Vesper's usage)
- [ ] Commission security audit of the identity backup/recovery flow
- [ ] Penetration test of the Phoenix API (focus: key package injection, IDOR)
- [ ] All bugs in the "E2EE implementation: security bugs and correctness issues" issue resolved
- [ ] Verify MLS sender authentication is checked on every `decryptMessage` call
- [ ] Verify ts-mls forward secrecy: confirm old epoch secrets are zeroed after epoch advance
- [ ] Verify forward secrecy for disappearing messages: confirm epoch keys are deleted
      when all messages using them have expired
- [ ] Review Argon2id parameters (t=3, m=64MB, p=4) against current OWASP recommendations
- [ ] Rate limiting on auth endpoints and key package endpoints
- [ ] CSP headers on the web client
- [ ] Audit Electron renderer security settings (`contextIsolation: true`, `nodeIntegration: false`)
- [ ] File attachment encryption: verify files are actually encrypted before upload
- [ ] Document the metadata disclosure from link preview proxying (or switch to sender-side)
- [ ] Document mention user ID metadata disclosure as a known accepted limitation

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
