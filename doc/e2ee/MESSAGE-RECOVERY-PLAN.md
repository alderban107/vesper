# Message History Recovery: Options & Recommendation

*March 2026 — Planning document*

---

## The Problem

Vesper uses MLS for end-to-end encryption. MLS has a fundamental property: the sender
cannot decrypt their own messages after encryption, because the ratchet key is consumed.
The `sentMessageCache` bridges this gap during a live session by mapping ciphertext back
to plaintext when the server echoes the message. But when the user logs out, we clear
that cache (correctly — it's the fix for issue #21). After re-login, those messages are
gone.

Messages from *other* group members still decrypt fine. New messages work. But every
message the user themselves sent before logout shows "[Message unavailable - decryption
failed]." In a single-user test this looks catastrophic. In a multi-user channel it's
less visible but still a real loss.

Beyond the sender-self-decryption issue, any scenario where the user loses their local
MLS group state — device loss, browser storage cleared, moving to a different machine —
produces the same result: old messages can't be decrypted.

Discord users expect full message history, everywhere, instantly. Wire's "no history for
privacy" answer is fine for government clients; it's not fine for us. We need a plan.

---

## What Vesper Already Has

Before evaluating options, it's worth noting what's already in place:

- **24-word BIP39 recovery mnemonic** generated at registration. Currently used to
  encrypt the user's signature private key for identity recovery. The 256-bit key
  derived from this mnemonic is a natural candidate for additional backup duties.
- **Server-stored encrypted key bundle** — the user's private key encrypted under their
  password (Argon2id + AES-256-GCM), stored on the server. This is how login works
  across devices.
- **IndexedDB message cache** — stores *ciphertext* (not plaintext) locally. This was a
  deliberate security decision: plaintext never hits disk.
- **MLS group state persistence** — serialized to IndexedDB (web) or SQLite (Electron),
  scoped per user as of the issue #22 fix.

---

## The Options

### Option 1: Encrypted Message Backup (Server-Stored)

The approach Signal converged on. After decrypting each incoming message, re-encrypt the
plaintext under a per-user **backup key** and upload to the server. The server stores
opaque encrypted blobs it can't read.

**How it would work:**

1. Derive a backup encryption key from the user's recovery mnemonic (or a separate
   backup credential). This key never leaves the client.
2. When a message is decrypted (or sent), encrypt the plaintext content under the backup
   key using AES-256-GCM with a per-message nonce.
3. Upload the encrypted backup entry to a server-side backup store, keyed by message ID
   and channel/conversation ID.
4. On new device or after re-login: derive the backup key from the recovery mnemonic,
   download backup entries for the channels being viewed, decrypt locally.

**What gets backed up:**
- Message plaintext (the decoded payload — text content, file metadata)
- Message ID, channel ID, sender ID, timestamp (needed for reassembly)
- *Not* MLS key material (forward secrecy is preserved)
- Media files could optionally be backed up separately, re-encrypted under the same key

**Recovery flow:**
1. Log in on new device / after logout
2. Prompted: "Enter your recovery phrase to restore message history"
3. Messages download and decrypt in the background as the user navigates channels
4. Without the recovery phrase: fresh start, only new messages going forward

**Pros:**
- MLS forward secrecy fully preserved — we back up plaintext, not keys
- Recovery survives total device loss (backup is server-side)
- The recovery mnemonic already exists — no new credential for users to manage
- Granular: can back up continuously (each message as it arrives) or periodically
- Server learns nothing about message content

**Cons:**
- Server storage cost scales with message volume
- Requires new server-side API endpoints and storage
- The recovery mnemonic becomes even more critical — losing it means losing both
  identity recovery AND message history
- Backup upload is an additional network operation per message (can be batched/async)
- Users who never saved their recovery mnemonic lose history on device change

**Complexity: Medium-high.** New server endpoints, client-side backup/restore logic,
migration for existing users.

---

### Option 2: Device-to-Device Sync

When a user logs in on a new device (or after logout), an existing logged-in session
streams message history directly over an encrypted channel.

**How it would work:**

1. New session detects it has no local message history for channels it joins.
2. If another session exists (e.g., Electron app open while logging into web), the new
   session requests history via an encrypted side-channel.
3. The existing session sends decrypted message content, re-encrypted for the new
   session's transport, directly peer-to-peer or relayed through the server.
4. No persistent server-side backup involved.

**Pros:**
- No server-side storage needed
- No recovery key needed (the existing device *is* the backup)
- Forward secrecy preserved — plaintext is shared ephemerally, not stored

**Cons:**
- Requires an existing device to be online and logged in at the time of sync
- Total device loss = total history loss (this is the killer problem)
- Complex to implement: need a side-channel protocol, conflict resolution, progress UI
- Doesn't help with the logout-and-re-login-same-device scenario at all (the session
  that had the messages is gone)

**Complexity: Medium.** Needs a sync protocol but no server-side storage. Fundamentally
limited by requiring an online source device.

---

### Option 3: Local Plaintext Cache (Encrypted at Rest)

Instead of only caching ciphertext in IndexedDB, also cache decrypted plaintext locally,
encrypted under a key derived from the user's password or recovery mnemonic.

**How it would work:**

1. After decrypting a message, store the plaintext in a separate IndexedDB object store
   (or SQLite table), encrypted with AES-256-GCM using a key derived from the user's
   credentials.
2. On re-login, derive the local cache key from the password, decrypt the local cache.
3. Messages are available immediately without any server round-trip.

**Pros:**
- No server-side changes needed
- Instant history restoration (no download)
- Simple implementation — it's just an additional local write

**Cons:**
- Doesn't survive device loss, browser storage clear, or moving to a new machine
- Plaintext is on disk (encrypted, but still). This was something we deliberately
  avoided in the current design.
- The encryption key must be derivable on re-login — if it's password-derived, changing
  the password invalidates the cache. If it's mnemonic-derived, the user must enter the
  mnemonic on every login (bad UX) or we store the derived key somewhere (which key do
  we encrypt *that* with?).
- Per-user IndexedDB scoping (our issue #22 fix) means the cache is already isolated,
  but the key management is circular.

**Complexity: Low-medium.** Simple to build but has real key management problems and
doesn't solve the cross-device case.

---

### Option 4: Transparent Server-Side Backup (Trust-the-Server Model)

Store message plaintext on the server, encrypted under a key that the server manages on
the user's behalf (derived from their account credentials via server-side KDF).

**How it would work:**

1. The server stores message content encrypted under a per-user key derived from the
   user's password hash (which the server already has for authentication).
2. The client doesn't need to manage backup keys — the server handles it.
3. On any device, after login, messages are available from the server immediately.

This is essentially how Discord works, except with an encryption layer that the server
controls.

**Pros:**
- Seamless UX — identical to Discord, no recovery keys, no ceremonies
- Works across all devices instantly
- No user-facing complexity at all

**Cons:**
- The server can read messages. This is not end-to-end encryption for the backup layer.
  It's encryption-at-rest with server-held keys.
- Defeats the purpose of E2EE for anyone who cares about it
- Legally, the server operator can be compelled to decrypt stored messages
- Vesper's privacy promise becomes misleading

**Complexity: Low.** But the security tradeoff is severe enough that I don't think this
is a real option for us. Including it for completeness.

---

### Option 5: Hybrid — Encrypted Backup + Recovery Mnemonic Unification

This is a refined version of Option 1, designed specifically around what Vesper already
has. The key insight: **the recovery mnemonic already exists and users are already told
to save it.** We can derive the backup encryption key from the same mnemonic, giving
users a single credential that handles both identity recovery and message history.

**How it would work:**

1. At registration, the 24-word recovery mnemonic is generated (already happens).
2. From the mnemonic's 256-bit key, derive two sub-keys using HKDF:
   - `identity_recovery_key` — used for identity key backup (current behavior)
   - `message_backup_key` — used for message history backup (new)
3. When the client decrypts a message (or sends one), it encrypts the plaintext under
   `message_backup_key` and uploads to a server-side backup store. This can be batched
   and async — doesn't need to block the message flow.
4. The server stores: `{message_id, channel_id, user_id, encrypted_content, nonce, timestamp}`
5. On re-login or new device:
   - If the user has their recovery mnemonic: prompt to enter it, derive
     `message_backup_key`, download and decrypt history.
   - If the user doesn't have it: fresh start, new messages only. The existing MLS
     group state handles new message decryption.
6. Optionally, after successful recovery, the client can re-cache decrypted messages
   locally so subsequent logins don't require the mnemonic (using the local cache
   approach from Option 3, with the password-derived key for the local layer).

**Session key caching (optimization):**

To avoid requiring the mnemonic on every login, after the user enters it once on a
device, derive a **session backup key** from the password and store the
`message_backup_key` encrypted under it locally. On subsequent logins with the same
password, the backup key is available without the mnemonic. Password changes re-wrap
the key. Device loss or storage clear requires the mnemonic again.

**What the UX looks like:**

- **Registration:** "Save this recovery phrase. You'll need it to restore your messages
  if you lose access to your device." (Already happens, but the wording gets more
  important.)
- **Normal logout + re-login (same device):** Messages restore automatically from local
  cache (encrypted under password-derived key). No mnemonic needed.
- **New device or cleared storage:** "Enter your recovery phrase to restore message
  history" prompt after login. Without it, fresh start.
- **Lost mnemonic + lost device:** Identity can be recovered via password (the
  server-stored encrypted key bundle). Message history is lost. This is the correct
  tradeoff — the mnemonic is the backup for the backup.

**Pros:**
- Single recovery credential (the mnemonic already exists)
- Server-side backup survives device loss
- Local cache makes same-device re-login instant
- MLS forward secrecy fully preserved
- Privacy-preserving: server only stores encrypted blobs
- Progressive: can ship the local cache first, add server backup later

**Cons:**
- The mnemonic is now load-bearing for two things. Users who lose it lose more.
- Server storage costs (mitigable with retention policies)
- Implementation spans client + server
- Need to handle the "user registered before backup existed" migration case

**Complexity: Medium-high** for the full version. But it's **decomposable** — the local
cache layer is low complexity and solves the logout/re-login case immediately.

---

## Recommendation

**Option 5 (Hybrid)**, shipped in phases.

The reasoning:

1. **The mnemonic already exists.** Users are already being asked to save a recovery
   phrase. Deriving a backup key from it costs nothing in UX complexity. It's the
   natural extension of what's already there.

2. **Phased delivery reduces risk.** Phase 1 (local encrypted cache) solves the
   immediate problem — logout/re-login on the same device — with minimal server
   changes. Phase 2 (server-side backup) solves the cross-device case. Phase 3
   (device-to-device sync) is a convenience layer on top.

3. **It's what the industry converged on.** Signal, WhatsApp, and Matrix all ended up
   at "server-stored encrypted backup with user-held recovery key." Vesper's version
   is cleaner because we can design it from scratch rather than retrofitting.

4. **It respects the privacy promise.** The server never sees plaintext. The recovery
   mnemonic never leaves the user's control. Forward secrecy is preserved for the MLS
   layer. The backup is a separate, user-controlled encryption layer.

5. **It degrades gracefully.** Lost your mnemonic? You lose history but keep your
   account and can send/receive new messages. Lost your device but have the mnemonic?
   Full recovery. Have neither? Fresh start with a new account. Each layer of loss has
   a proportional consequence.

---

## Implementation Phases

### Phase 1: Local Encrypted Message Cache

*Solves: logout/re-login on same device, page refresh*

- Add a `decrypted_messages` object store to the per-user IndexedDB
- After decrypting any message, write `{message_id, channel_id, encrypted_content}` to
  this store, encrypted under a key derived from the user's password (via the same
  Argon2id KDF used for the key bundle)
- On re-login, derive the cache key from the password and use cached plaintext for any
  messages that MLS can't decrypt
- On password change, re-derive the cache key and re-encrypt the local cache
- `processIncomingMessage` checks: sent-message cache → decryption cache → local DB
  cache → MLS decrypt (in that order)

**Scope:** Client-only. No server changes. Estimated 2-3 days.

**What it fixes immediately:**
- Logout + re-login as same user: all messages restored from local cache
- Page refresh: messages available instantly from cache instead of re-decrypting via MLS
- Browser tab closed and reopened: same as above

**What it doesn't fix:**
- New device: no local cache exists
- Browser storage cleared: cache lost
- Different browser on same machine: separate IndexedDB, no cache

### Phase 2: Server-Side Encrypted Backup

*Solves: new device, device loss, browser storage clear*

- Derive `message_backup_key` from recovery mnemonic via HKDF
- New server API: `POST /api/v1/backup/messages` (batch upload encrypted entries),
  `GET /api/v1/backup/messages?channel_id=X&after=Y` (paginated download)
- Client uploads encrypted message content in batches (async, non-blocking)
- On new device: prompt for recovery mnemonic, download and decrypt backup
- Store the `message_backup_key` locally encrypted under the password-derived key so
  the mnemonic isn't needed on every login
- Server-side retention policy: configurable per-server (server owners choose how long
  backup is retained)
- Migration: existing users prompted to "enable message backup" and re-enter their
  recovery mnemonic to derive the backup key

**Scope:** Client + server. New API endpoints, new DB table, client backup/restore
logic. Estimated 1-2 weeks.

### Phase 3: Device-to-Device History Sync

*Solves: convenience case — quick sync without entering mnemonic*

- When a second device is logged in, offer to sync recent message history directly
- Uses an encrypted WebSocket side-channel between the user's own sessions
- Complement to Phase 2, not a replacement — doesn't help with total device loss
- Lower priority. Can be deferred indefinitely without blocking the core experience.

**Scope:** Client + server (relay). Estimated 1 week.

### Phase 4: Logout UX

*Should ship alongside Phase 1.*

- Logout confirmation dialog: "Logging out will end your encrypted session. Your
  messages will be restored when you log back in on this device." (Phase 1 language)
- If Phase 2 is enabled: "Your messages are backed up and can be restored on any
  device with your recovery phrase."
- If Phase 2 is not enabled: "Messages on other devices may not be recoverable.
  Enable message backup in Settings to protect your history."
- Settings page: backup status, option to enter recovery mnemonic to enable backup,
  option to disable backup (with confirmation)

---

## Open Questions

1. **Media backup:** Do we back up file/image content, or just text + file metadata?
   Media is large. Options: text-only backup (show "[Media unavailable]" for
   unrecoverable files), or separate media backup with configurable retention.

2. **Backup key rotation:** If the recovery mnemonic is compromised, the user needs to
   generate a new one and re-encrypt the backup. This is a key rotation ceremony. How
   complex should it be?

3. **Server storage limits:** Who pays for backup storage? Per-user quotas? Server
   owner configurable? This matters for self-hosted instances.

4. **Reactions and edits:** Do we back up reaction emojis and edited content? Edits
   overwrite the original in the backup. Reactions are small. Probably yes to both.

5. **Deletion:** When a message is deleted (by sender or moderator), should the backup
   entry also be deleted? Probably yes — honor deletion intent. But this means the
   server needs to be able to identify which backup entry corresponds to a deleted
   message (it can, via message_id, without seeing content).

6. **Search:** Once we have decrypted content in the local cache (Phase 1), FTS5 search
   becomes viable for the web client too. This is a nice side benefit.
