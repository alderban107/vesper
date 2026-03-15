# E2EE Message History Recovery: Platform Research

*Research document — March 2026*

This document surveys how major end-to-end encrypted messaging platforms handle message history across sessions, device changes, and logouts. The goal is to inform Vesper's architectural decisions about whether and how to support message history recovery.

---

## Table of Contents

1. [Signal](#1-signal)
2. [Matrix / Element](#2-matrix--element)
3. [WhatsApp](#3-whatsapp)
4. [iMessage](#4-imessage)
5. [Wire](#5-wire)
6. [Discord](#6-discord-for-contrast)
7. [MLS (RFC 9420) and Key Export](#7-mls-rfc-9420-and-key-export)
8. [Synthesis: Approaches to Key Backup](#8-synthesis-approaches-to-key-backup)
9. [Implications for Vesper](#9-implications-for-vesper)

---

## 1. Signal

### Message History Survival

Signal has historically been the strictest about message locality: messages lived only on the device that received them. Logging out, uninstalling, or switching phones meant losing everything unless you had a local backup. This changed significantly in January 2025 and again later that year.

**Current state (as of early 2026):**

- **Device-to-device transfer**: When linking a new device, Signal offers to sync messages and media from the last 45 days directly from the primary device. This requires the old device to be online and functional — it's a direct encrypted transfer, not server-mediated.
- **Secure Backups** (rolled out Android beta mid-2025, iOS late 2025): Server-stored encrypted backup archives. The backup is encrypted with a locally-generated 64-character recovery key that is never shared with Signal's servers. Zero-knowledge architecture — Signal cannot access, decrypt, or recover any part of the backup. Includes all text messages and the last 45 days of media.
- **Android-to-Android direct transfer**: Older mechanism using a local Wi-Fi connection and QR code. The old phone must be present and functional. Signal is unregistered on the old device after transfer.

### Key Management

Signal uses per-device keys throughout. Each device generates its own identity key pair, prekeys, and signed prekeys. The Signal Protocol (Double Ratchet + X3DH) creates unique session keys for every device pair.

**Secure Value Recovery (SVR / SVR2):**
- SVR is *not* for message backup — it protects a `master_key` that derives the `registration_lock_secret` and stores the user's profile data, contact list, and settings.
- The master_key incorporates 256 bits of server-stored random data (`c2`), making it impossible to brute-force even with a weak PIN.
- SVR2 runs inside AMD SEV-SNP enclaves (moved from Intel SGX), enforcing a maximum failed guess count. The enclave provides remote attestation so clients can verify they're talking to real enclave code.
- The PIN → master_key flow: User's PIN + OPRF (oblivious pseudorandom function) against the enclave → derives auth_key + c2 retrieval → master_key. The enclave rate-limits guesses.

SVR handles *account recovery* (profile, contacts, settings, registration lock). It does **not** handle message history recovery — that's what Secure Backups and device transfer are for.

### Cryptographic Architecture of Secure Backups

- 64-character recovery key generated locally (never sent to server)
- Backup archive encrypted with this key using authenticated encryption
- Stored on Signal's servers in encrypted form
- Deletion: disabling Secure Backups auto-deletes the server-side archive
- If the recovery key is lost, the backup is permanently inaccessible

### User Experience

1. **New device setup**: "Would you like to transfer messages from the last 45 days?" Requires old device online.
2. **Secure Backups**: Enable in Settings → Backups. Presented with a 64-character recovery key to write down. On new device, enter the recovery key to restore.
3. **Lost device, no backup**: All message history is gone. PIN recovers profile/contacts/settings only.

### Tradeoffs and Criticisms

- The 64-character recovery key is a high bar for non-technical users. Losing it means permanent data loss.
- SVR's reliance on hardware enclaves (SGX, then SEV-SNP) has been criticized — enclave vulnerabilities exist (Spectre-class attacks, firmware bugs). Signal's counter: rate-limiting makes these attacks impractical at scale.
- 45-day media window is a pragmatic storage constraint, not a cryptographic one.
- Server-stored encrypted backup is a relatively new departure from Signal's historical "nothing on the server" philosophy.

---

## 2. Matrix / Element

### Message History Survival

Matrix's approach is the most architecturally complex of the platforms surveyed. Message history can survive device changes and logouts *if* the user has set up key backup. Without it, encrypted messages from before the new device joined are permanently undecryptable (appearing as "Unable to decrypt" placeholders).

### Key Management: The Full Stack

Matrix uses a layered key hierarchy:

**Layer 1 — Olm (device-to-device)**
Each device generates a Curve25519 identity key pair and Ed25519 signing key pair. Olm sessions (based on Double Ratchet) are established between device pairs for secure key exchange.

**Layer 2 — Megolm (room encryption)**
Each device creates outbound Megolm sessions for rooms it's participating in. Megolm is a sender-key ratchet — the sender encrypts once with their session key, and the ciphertext is readable by anyone who has the corresponding inbound Megolm session key. Inbound session keys are distributed to other devices in the room via Olm.

Megolm sessions rotate periodically (by time, message count, or membership change). Each rotation creates a new session key that must be distributed.

**Layer 3 — Cross-signing (user verification)**
Three key pairs per user:
- **Master key**: The root of trust for the user's identity
- **Self-signing key**: Signs the user's own device keys (master key signs this)
- **User-signing key**: Signs other users' master keys (for verification)

Cross-signing allows verifying a *user* rather than each *device* individually. Once you verify a user's master key, all their devices signed by their self-signing key are transitively trusted.

**Layer 4 — SSSS (Secure Secret Storage and Sharing)**
SSSS stores the private cross-signing keys and the Megolm backup decryption key in the user's account_data on the homeserver, encrypted with a "default key" that is itself derived from a passphrase (PBKDF2) or represented as a "Security Key" (base58-encoded random bytes).

Secrets stored in SSSS:
- `m.cross_signing.master` — master cross-signing private key
- `m.cross_signing.self_signing` — self-signing private key
- `m.cross_signing.user_signing` — user-signing private key
- `m.megolm_backup.v1` — the private key for decrypting Megolm key backups

### Key Backup (Server-Side Encrypted Megolm Key Backup)

This is the mechanism that actually enables message history recovery:

1. A Curve25519 key pair is generated specifically for backup purposes.
2. The **public** backup key is uploaded to the homeserver and signed by the user's master cross-signing key.
3. Each inbound Megolm session key is encrypted to the backup public key (using ECIES/HPKE-style encryption) and uploaded to the homeserver as part of the backup.
4. The **private** backup key is stored in SSSS (encrypted under the user's passphrase/Security Key).
5. On a new device, after verifying (via cross-signing or entering the Security Key/passphrase), the device retrieves the private backup key from SSSS, downloads the encrypted Megolm session keys from the server, and decrypts them locally.

The homeserver stores the encrypted Megolm keys but cannot decrypt them — it doesn't have the backup private key.

### User Experience

**Setup (first device):**
1. Create account, generate device keys automatically.
2. Prompted to set up "Security Key" or "Security Phrase" (passphrase).
3. This initializes SSSS and key backup. The user must save the Security Key or remember the passphrase.

**New device:**
1. Log in. See "Verify this device" prompt.
2. Option A: Verify with another logged-in device (emoji comparison or QR scan). The existing device shares SSSS secrets via Olm.
3. Option B: Enter Security Key or Security Phrase. The device decrypts SSSS, retrieves cross-signing keys and backup key, downloads and decrypts Megolm session backups.
4. Once keys are restored, previously-undecryptable messages become readable.

**No backup, no other device:**
All pre-existing encrypted messages are permanently lost on the new device.

### Tradeoffs and Criticisms

- **Complexity**: The key hierarchy (Olm → Megolm → cross-signing → SSSS → key backup) is the most complex in any production messaging system. Users struggle with it.
- **"Unable to decrypt" errors**: Endemic in the Matrix ecosystem. Key backup failures, race conditions in key sharing, devices that miss Megolm session distributions — all produce messages that are permanently undecryptable.
- **Security vulnerabilities**: The Nebuchadnezzar paper (2022) found practically-exploitable vulnerabilities: a malicious homeserver could trivially add devices to rooms to receive Megolm keys, identifier confusion broke Olm authentication, and the key backup scheme lacked IND-CCA security. Many of these have been mitigated since, but the attack surface of the layered architecture is large.
- **UX friction**: Users must understand and manage the Security Key/Passphrase. Losing it without having another verified device means losing all message history.

---

## 3. WhatsApp

### Message History Survival

WhatsApp messages are stored on the device. Cloud backups (Google Drive on Android, iCloud on iOS) have existed for years, but historically these were *not* end-to-end encrypted — they were encrypted with keys that Google/Apple (and by extension, Meta/law enforcement with a warrant) could access.

In October 2021, WhatsApp added **end-to-end encrypted backups** as an opt-in feature.

### Key Management

WhatsApp uses the Signal Protocol for message encryption (Double Ratchet + prekeys). Each device has its own key pair. WhatsApp is primarily single-device (one phone), with linked companion devices that derive their session from the primary.

### E2EE Backup Architecture

The E2EE backup system offers two modes:

**Mode 1 — User-managed 64-digit encryption key:**
- A random 256-bit key is generated on the device.
- The backup (all messages, media) is encrypted with this key.
- The encrypted backup is uploaded to Google Drive or iCloud.
- The user stores the 64-digit key themselves.
- If lost, the backup is permanently inaccessible.

**Mode 2 — Password-protected (HSM Backup Key Vault):**
- A random 256-bit encryption key is generated on the device.
- The backup is encrypted with this key.
- The encryption key is itself encrypted using a key derived from the user's password via an OPAQUE-based protocol.
- The password-encrypted key is stored in Meta's **HSM-based Backup Key Vault** — a cluster of Hardware Security Modules.
- The HSMs enforce a maximum of 10 failed password attempts before permanently locking.
- The client and HSM communicate over encrypted channels; the intermediate ChatD relay service cannot see the contents.
- On restore, the user provides their password, the HSM derives the key, and the backup encryption key is returned to the client.

The OPAQUE protocol ensures that even if the HSM cluster is compromised, the attacker only gets password-wrapped keys — they still need to brute-force the password against the HSM's attempt limiter.

### User Experience

1. Settings → Chats → Chat Backup → End-to-end Encrypted Backup.
2. Choose: password or 64-digit key.
3. Backup runs automatically on schedule (daily/weekly/monthly) to Google Drive or iCloud.
4. On new device: install WhatsApp, verify phone number, prompted to restore from cloud backup. Enter password or 64-digit key.

### Tradeoffs and Criticisms

- HSM trust: Users must trust Meta's HSM infrastructure. The hardware is trustworthy by design, but the surrounding infrastructure (ChatD, the network) is Meta-controlled.
- The feature is **opt-in**, not default. Most users' backups remain unencrypted.
- Cross-platform transfer (Android ↔ iOS) has historically been painful and sometimes required third-party tools.
- The OPAQUE protocol and HSM-based rate limiting is a strong design — arguably better than Signal's enclave approach for password-mode, since HSMs are simpler and more battle-tested than SGX/SEV.

---

## 4. iMessage

### Message History Survival

iMessage is the most seamless of all platforms for message history sync — adding a new Apple device to your account gives you access to full message history almost immediately. This comes with specific trust assumptions.

### Key Management

**Per-device keys, server-mediated distribution:**
- Each Apple device generates its own encryption key pair (RSA-1280 historically, now ECDH P-256 and post-quantum Kyber-768 with PQ3) and signing key pair (ECDSA P-256).
- Public keys are registered with the Apple Identity Service (IDS).
- When sending a message, the sender queries IDS for *all* public keys of all devices associated with the recipient's Apple ID.
- The message is individually encrypted to each recipient device's public key. A message to one person with 5 devices creates 5 encrypted copies.

**Messages in iCloud:**
- With Messages in iCloud enabled (default), messages are synced to iCloud using CloudKit end-to-end encryption.
- The CloudKit service key is protected by iCloud Keychain syncing — the key is derived from a chain that includes the user's device passcode and Apple ID credentials.
- With standard iCloud (no Advanced Data Protection): The Messages in iCloud encryption key is *included* in the iCloud Backup, which Apple holds keys to. Apple can technically access messages via the backup key.
- With **Advanced Data Protection** (ADP, opt-in since iOS 16.2): The iCloud Backup itself is end-to-end encrypted. Apple no longer holds keys to the backup or the Messages in iCloud encryption key. Full E2EE.

### User Experience

Completely invisible. Log in with Apple ID on new device, messages appear. No key management, no recovery phrases, no verification ceremonies. The tradeoff is the trust model.

### Tradeoffs and Criticisms

- **Centralized trust in Apple**: Apple controls IDS, the key directory. A malicious or compromised Apple could add phantom devices to a user's account to intercept messages. Apple has introduced Contact Key Verification (CKV) to mitigate this, but it's opt-in and requires manual verification.
- **Without ADP**: Apple holds the keys to decrypt your backups and therefore your message history. Law enforcement can compel access.
- **With ADP**: Genuinely E2EE, but Apple can still see metadata (who messages whom, when, which devices).
- **No third-party audit**: The protocol is proprietary. Security analysis relies on Apple's published security guides and independent reverse engineering.
- **The PQ3 upgrade** (2024) is notable — iMessage was the first major messenger to deploy post-quantum cryptography in production.

---

## 5. Wire

### Message History Survival

Wire has historically offered **no message history recovery** on new devices. When you log in on a new device or reinstall Wire, you see only messages received *after* that point. Historical messages are gone.

The explicit message shown to users: *"It's the first time you're using Wire on this device. For privacy reasons, your conversation history will not appear here."*

### Key Management

Wire has undergone a major protocol transition:

**Proteus era (pre-2024):**
- Based on Signal's Double Ratchet protocol (Wire's own implementation called Proteus).
- Per-device keys. Each device generates its own identity key pair.
- Messages encrypted individually to each recipient device (like Signal).
- No server-side key backup, no message backup of any kind.

**MLS era (2024–present):**
- Wire completed migration to MLS (RFC 9420) in 2024–2025, becoming the first major messenger to ship MLS in production.
- Still per-device keys. Each device is an MLS "client" with its own credential and key packages.
- Group key agreement is more efficient — one encryption operation per message regardless of group size.
- Message history is still not transferred to new devices, even with MLS.

### User Experience

1. Install Wire on new device, log in.
2. See system message: "Your conversation history will not appear here."
3. Only new messages from this point forward.
4. If the web app's browser storage is cleared, history is also lost.

### Tradeoffs and Criticisms

- **No recovery at all**: Wire's position is that this is a privacy feature, not a limitation. For enterprise/government customers (Wire's primary market), this is often desirable.
- **Multi-device support**: Wire supports multiple simultaneous devices (up to 8), and messages arrive on all of them. But there's no sync of *past* messages to new devices.
- **MLS migration**: The transition from Proteus to MLS was operationally complex. Mixed-protocol conversations existed during the migration period.

---

## 6. Discord (For Contrast)

### E2EE Status

Discord does **not** end-to-end encrypt text messages. All text messages, DMs, server messages, and files are stored on Discord's servers in a form Discord can read. Discord has full access to all text content.

**What Discord *does* encrypt E2EE:** As of September 2024, Discord deployed the **DAVE protocol** for end-to-end encryption of voice and video calls (DM calls, group DM calls, server voice channels, Go Live streams). DAVE uses MLS (RFC 9420) for group key agreement with ECDSA signature keys. This is audio/video only — text remains unencrypted.

### Message Persistence

- All text messages are stored server-side, permanently (unless manually deleted).
- Full message history is available on any device, any time, with just a login.
- Search across all messages is server-side.
- This is the "zero friction, zero privacy" baseline that Vesper is replacing.

### Why This Matters for Vesper

Vesper users are coming from Discord. They expect:
- Instant access to full message history on any device
- No key management ceremonies
- No "unable to decrypt" errors
- Search that works

The challenge is delivering this UX while actually encrypting everything. Every E2EE platform above makes tradeoffs against this UX baseline. The question for Vesper is which tradeoffs are acceptable.

---

## 7. MLS (RFC 9420) and Key Export

### Epoch Secrets and Forward Secrecy

MLS organizes a group's cryptographic state into **epochs**. Each commit (membership change, key update) advances the group to a new epoch with new key material. The epoch secret is used to derive:

- `encryption_secret` → initializes a per-sender secret tree for message encryption
- `exporter_secret` → allows external protocols to derive keys from MLS state
- `authentication_secret`, `confirmation_key`, `membership_key`, etc.

Forward secrecy means that once an epoch advances, the old epoch's secrets should be deleted. An attacker who compromises current state cannot decrypt past messages.

### Can Epoch Secrets Be Backed Up?

Technically yes, but it violates MLS's security model. Here's the tension:

**What MLS provides:**
- `export_secret()` — RFC 9420 §8 defines an exporter that lets applications derive secrets from the current epoch. This is designed for things like deriving SRTP keys for voice, not for backing up message decryption keys.
- The MLS Extensions draft defines a "safe exporter" built on an Exporter Tree for more structured secret derivation.

**What MLS does NOT provide:**
- Any mechanism for storing or recovering past epoch secrets. The protocol explicitly assumes forward secrecy — old keys are deleted.
- Any built-in backup or recovery mechanism. This is deliberately left to the application layer.

**The fundamental problem:**
MLS's forward secrecy guarantee says: "compromise of current state doesn't reveal past messages." Backing up epoch secrets breaks this. If the backup is compromised, all backed-up epochs are exposed.

### ts-mls Specifics

Looking at Vesper's `ts-mls` dependency, the library exposes:
- `group.exportSecret()` — derives a secret from the current epoch's exporter_secret
- Group state serialization/deserialization — the full group state (including current epoch keys) can be serialized to bytes

The group state serialization is what Vesper currently uses for persistence in IndexedDB/SQLite. This contains the current epoch's key material. It does *not* contain past epoch keys (those are deleted on epoch advancement per forward secrecy).

### OpenMLS Approach

OpenMLS (the Rust MLS implementation) explicitly documents that applications may choose to keep SecretTree data from past epochs to decrypt late-arriving messages, at the cost of forward secrecy. This is a pragmatic concession — real networks have out-of-order delivery.

### Implications

For message history backup, MLS itself doesn't help. The options are:

1. **Back up the plaintext** (or ciphertext + keys) at the application layer, outside MLS.
2. **Back up Megolm-style session keys** — but MLS doesn't use session keys the same way Megolm does. MLS epoch secrets rotate with every commit.
3. **Use the exporter** to derive a stable "backup key" per group, then re-encrypt messages under that key for backup purposes.

None of these are free. All involve either storing plaintext server-side (encrypted under a user-held key) or storing key material that breaks forward secrecy.

---

## 8. Synthesis: Approaches to Key Backup

Across all platforms, four distinct approaches emerge:

### Approach A: No History Recovery (Signal pre-2025, Wire)

- New device = fresh start
- Maximum forward secrecy and simplicity
- Terrible UX for users who switch devices or lose phones
- Viable for security-first audiences, not for Discord replacements

### Approach B: Device-to-Device Transfer (Signal)

- Old device directly syncs to new device over encrypted channel
- No server-side storage of message content
- Requires old device to be available and functional
- Doesn't help with lost/destroyed devices

### Approach C: Server-Stored Encrypted Backup (Signal Secure Backups, WhatsApp E2EE Backup, Matrix Key Backup)

- Encrypted backup stored on server (or cloud provider)
- Decryption key held only by the user (recovery key, password + HSM, Security Key/passphrase)
- Server is cryptographically blind to content
- Variants:
  - **Recovery key only** (Signal): 64-character key, lose it = lose backup
  - **Password + HSM** (WhatsApp): Password-based with hardware rate-limiting
  - **Passphrase + SSSS** (Matrix): Passphrase or Security Key unlocks layered key hierarchy

### Approach D: Transparent Cloud Sync (iMessage with ADP)

- Messages synced to cloud, encrypted with keys derived from account credentials + device chain
- Key distribution handled by platform-controlled identity service
- Seamless UX — users don't manage keys directly
- Requires trusting the platform's key directory (Apple IDS)
- Closed-source, proprietary

### Comparative Table

| Platform | History on new device? | Key model | Backup mechanism | User action required | Forward secrecy preserved? |
|---|---|---|---|---|---|
| Signal (current) | Last 45 days (transfer or backup) | Per-device | Server-stored encrypted backup OR device transfer | Save 64-char recovery key | Broken for backed-up content |
| Matrix/Element | Yes, if key backup enabled | Per-device + cross-signing | Server-stored encrypted Megolm keys | Save Security Key/Phrase | Broken for backed-up sessions |
| WhatsApp | Yes, if E2EE backup enabled | Per-device (Signal Protocol) | Cloud backup encrypted with key/password | Choose password or save 64-digit key | Broken for backed-up content |
| iMessage (ADP) | Full history | Per-device, cloud-synced | iCloud with CloudKit E2EE | Enable ADP (opt-in) | Broken for synced content |
| Wire | No | Per-device (MLS) | None | Nothing | Fully preserved |
| Discord | Full history (not E2EE) | N/A (server-side) | Server stores plaintext | Nothing | N/A |

---

## 9. Implications for Vesper

### The Core Tension

Vesper is a Discord replacement that uses MLS-based E2EE. Discord users expect full message history everywhere, instantly, with no key management. Every E2EE platform either:

1. Gives up on history recovery (Wire), or
2. Stores encrypted backups server-side with a user-managed recovery key (Signal, WhatsApp, Matrix), or
3. Handles it transparently but requires trusting the platform's key infrastructure (iMessage)

### What MLS Makes Harder

Unlike Signal Protocol or Megolm, MLS doesn't have a clean "session key" concept that maps well to backup. Megolm has per-room session keys that rotate relatively slowly — you can back up each one. Signal has the ratchet state per conversation. MLS has epoch secrets that rotate on every commit (membership change, key update), which could be frequent in active groups.

Backing up MLS epoch keys would mean:
- Storing potentially many keys per group (one per epoch)
- Deciding how far back to retain them
- Re-encrypting them under a backup key
- Accepting that the backup breaks forward secrecy for all backed-up epochs

### Practical Options for Vesper

**Option 1: Encrypted message backup (most promising)**

Instead of backing up keys, back up the *plaintext messages* (or re-encrypted ciphertext) at the application layer.

- After decryption, re-encrypt each message under a per-user backup key
- Store the re-encrypted messages server-side
- The backup key is derived from a recovery passphrase/key (like Signal's 64-char key or Matrix's Security Key)
- On new device: enter recovery key → derive backup key → download and decrypt message archive
- Forward secrecy of MLS is preserved (the backup is of plaintext, not of MLS key material)
- The server stores encrypted backup blobs it can't read

**Option 2: Device-to-device sync**

- New device requests message history from an existing logged-in device
- Existing device streams encrypted messages directly
- Requires an online device — doesn't help with total device loss
- Good as a complement to Option 1, not a replacement

**Option 3: Server-side key escrow with HSM/enclave**

- Like WhatsApp's HSM vault approach
- User provides a password, server stores the backup key encrypted under a password-derived key inside an HSM
- Rate-limited password attempts
- Complex infrastructure requirement (HSMs or TEEs)
- Probably overkill for Vesper's scale

**Option 4: Accept no history recovery (Wire model)**

- New device = fresh start
- Simplest implementation
- Worst UX for a Discord replacement
- Could work as an MVP with plans to add backup later

### Recommendation Direction

For a Discord replacement targeting a general audience, Option 1 (encrypted message backup) with Option 2 (device-to-device sync) as a complement appears to be the strongest path. This is essentially what Signal has converged on: server-stored encrypted backup + device transfer.

The key design decisions would be:
1. **Recovery key format**: How long, how user-friendly. Signal's 64 characters is secure but daunting. A BIP39 mnemonic (which Vesper already generates for identity recovery) could double as the backup key.
2. **Backup granularity**: Continuous vs. periodic. Continuous (re-encrypt each message as it arrives) provides best recovery but requires constant upload. Periodic (batch backup) is simpler but risks losing recent messages.
3. **What gets backed up**: Text only? Text + media? How long?
4. **Server storage**: Where do encrypted backup blobs live? Vesper's own server? User-provided cloud storage?
5. **Relationship to existing recovery mnemonic**: Vesper already has a 24-word BIP39 recovery mnemonic for identity key recovery. This could be extended to also derive a backup encryption key, giving users one recovery mechanism for both identity and message history.
