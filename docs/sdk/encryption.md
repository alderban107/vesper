# Encryption

Vesper uses MLS (Messaging Layer Security, RFC 9420) for end-to-end encryption. The SDK handles all MLS operations internally, but this document explains the underlying model for users who need to understand the security properties or extend the system.

## Architecture

```
User Account
  └── Identity Key Pair (Ed25519 signing + X25519 key exchange)
       ├── Encrypted with password (Argon2id + AES-256-GCM)
       ├── Encrypted with recovery key (24-word BIP39 mnemonic)
       └── MLS Key Packages (uploaded to server)
            └── Used by other members to add this user to MLS groups

MLS Group (one per channel or conversation)
  ├── Group state (serialized, stored locally per device)
  ├── Epoch (increments on membership changes)
  └── Application messages (encrypted with group key)
```

## Key Types

### Identity Keys

Each user has a single identity key pair derived during registration:

- **Signing key** (Ed25519): Signs MLS proposals and commits
- **Key exchange key** (X25519): Used in MLS key schedule

The private keys are never sent to the server in plaintext. They're encrypted twice:

1. With the user's password (via Argon2id key derivation + AES-256-GCM)
2. With a recovery key (random 256-bit key encoded as a BIP39 mnemonic)

### Key Packages

MLS key packages are pre-keys uploaded to the server. When another user wants to add you to an MLS group, they fetch one of your key packages and use it to create a Welcome message.

```typescript
// The SDK manages key packages automatically, but you can replenish manually:
await client.replenishKeyPackages()
```

The SDK maintains a pool of key packages on the server and replenishes them when the count drops below a threshold.

### Recovery Keys

A 24-word BIP39 mnemonic generated during registration. This encodes a 256-bit key that can decrypt the identity key bundle independently of the password.

```typescript
// Generated during registration
const session = await client.register('alice', 'password')
console.log(session.recoveryMnemonic)
// "abandon ability able about above absent absorb abstract ..."

// Later, recover the account
await client.recoverAccount(mnemonic, 'new-password')
```

## MLS Groups

Each channel and DM conversation maps to one MLS group. The SDK identifies groups by scope ID (the channel or conversation UUID).

### Group Lifecycle

1. **Creation**: The first user to join a scope creates the MLS group
2. **Join requests**: Other users request to join; existing members process join requests by adding the requester's key package and creating a commit
3. **Welcome messages**: The server delivers Welcome messages to new members, allowing them to initialize their group state
4. **Messaging**: Members encrypt/decrypt application messages using the shared group key
5. **Membership changes**: Adding or removing members advances the epoch

### Group State

Group state is serialized to bytes and stored locally through the `CryptoStorageRuntime` interface. Each state is tagged with its epoch number.

```typescript
interface MLSGroupInfo {
  groupId: string
  state: Uint8Array
  epoch: number
}
```

The SDK stores the current group state. When a commit advances the epoch, the old state is replaced. Messages encrypted under old epochs can still be decrypted if the state was cached in the decryption cache.

### Commits and Proposals

MLS membership changes happen through commits:

- **Add**: A current member fetches a key package and creates a commit adding the new member
- **Remove**: A current member creates a commit removing another member
- **Update**: A member updates their own key material

The SDK processes these automatically when socket events arrive (`mls_commit`, `mls_welcome`, `mls_remove`).

## Decryption Cache

The SDK maintains an in-memory LRU cache of decrypted message plaintext (2000 entries). This avoids re-decrypting messages when scrolling through history.

```typescript
// The cache is transparent -- fetchMessages and scope events
// populate it automatically.
const text = chat.getDecryptedMessageText(message)
```

Sent messages get special handling: MLS senders cannot decrypt their own ciphertexts (by protocol design), so the SDK caches sent plaintext keyed by the ciphertext's base64 encoding.

## File Encryption

Files are encrypted client-side with AES-256-GCM before upload. The encryption key and IV travel inside the MLS-encrypted message payload.

```typescript
import { encryptFile, decryptFile } from '@vesper/sdk/crypto'

// Encrypt a file before upload
const encrypted = await encryptFile(arrayBuffer)
// encrypted.ciphertext -- upload this to the server
// encrypted.key        -- base64 AES key, goes in the message payload
// encrypted.iv         -- base64 IV, goes in the message payload

// Decrypt a downloaded file
const decrypted = await decryptFile(
  ciphertext,
  encrypted.key,
  encrypted.iv
)
```

The server stores only the ciphertext. Without the key from the message payload (which is MLS-encrypted), the file is unreadable.

## Password-Based Key Derivation

The SDK uses Argon2id (via `hash-wasm`) for password-based key derivation:

```
password + random salt  -->  Argon2id  -->  256-bit AES key
AES key + random IV     -->  AES-256-GCM encrypt(private keys)  -->  EncryptedKeyBundle
```

The `EncryptedKeyBundle` (ciphertext + nonce + salt) is uploaded to the server. On login, the SDK downloads the bundle and re-derives the AES key from the password and stored salt.

## Crypto Types

```typescript
// Encrypted key material stored on the server
interface EncryptedKeyBundle {
  ciphertext: Uint8Array
  nonce: Uint8Array
  salt: Uint8Array
}

// Key package with both public and private parts
interface KeyPackagePair {
  keyPackage: Uint8Array    // Public, uploaded to server
  privateKey: Uint8Array    // Private, stored locally
}

// Result of encrypting a message
interface EncryptedMessage {
  ciphertext: Uint8Array
  epoch: number
  newState: ClientState     // Updated MLS group state
}

// Result of decrypting a message
interface DecryptedMessage {
  plaintext: string
  newState: ClientState
}

// Recovery key data generated during registration
interface RecoveryKeyData {
  mnemonic: string
  hash: string
  encryptedBundle: Uint8Array
  nonce: Uint8Array
}
```

## Voice Key Derivation

For encrypted voice calls, the SDK derives a symmetric key from the MLS group state:

```typescript
import { deriveVoiceKey } from '@vesper/sdk/crypto'

const voiceKey = await deriveVoiceKey(groupState)
// Used to encrypt RTP media frames
```

## Security Properties

MLS provides:

- **Forward secrecy**: Compromising current keys doesn't reveal past messages
- **Post-compromise security**: After a compromise, security is restored once the compromised member updates their key material
- **Group authentication**: All members can verify who sent each message
- **Membership agreement**: All members agree on who is in the group

The server acts as a delivery service. It relays MLS handshake messages and ciphertexts but cannot decrypt any content.
