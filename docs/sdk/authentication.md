# Authentication

The SDK uses JWT-based authentication with automatic token refresh. Each client instance represents one device, and devices must be trusted before they can participate in end-to-end encryption.

## Registration

Registration creates a new account, generates MLS identity keys, and uploads initial key packages to the server.

```typescript
const session = await client.register('alice', 'strong-password-here')

// The session contains a recovery mnemonic ONLY during registration.
// Store this somewhere safe -- it's the only way to recover the account
// if the password is lost.
console.log(session.recoveryMnemonic) // 24-word BIP39 phrase
```

The registration flow:

1. Derives signing and key-exchange keys from the password using Argon2id
2. Creates an encrypted key bundle (private keys encrypted with the password)
3. Generates a 24-word BIP39 recovery mnemonic
4. Creates a recovery data bundle (private keys encrypted with the recovery key)
5. Uploads the public keys, encrypted bundles, and initial MLS key packages to the server
6. Returns a session with JWT tokens

## Login

```typescript
const session = await client.login('alice', 'strong-password-here')
```

Login downloads the encrypted key bundle from the server, decrypts the private keys using the password, and initializes the MLS cipher suite. The first device to login is automatically trusted.

## Session Persistence

Sessions are persisted through the `SessionStore` interface. The SDK includes three implementations:

```typescript
// Node.js / Electron -- persists to a JSON file
import { createFileSessionStore } from '@vesper/sdk/client/file-session-store'
const store = createFileSessionStore('/path/to/session.json', serverUrl)

// Browser -- uses localStorage
// (Used automatically when no store is provided in a browser environment)

// In-memory -- for testing, no persistence
import { MemorySessionStore } from '@vesper/sdk/api'
```

Restore a saved session on startup:

```typescript
const session = await client.restoreSession()
if (session) {
  await client.start()
} else {
  await client.login('alice', 'password')
  await client.start()
}
```

## Session Store Interface

```typescript
interface SessionStore {
  getServerUrl(): string
  getAccessToken(): string | null
  getRefreshToken(): string | null
  setTokens(accessToken: string, refreshToken: string): void
  clearTokens(): void
  setSessionNotice(notice: SessionNotice): void
  clearSessionNotice(): void
  getSessionNotice(): SessionNotice | null
  emitSessionNotice(): void
}
```

Session notices signal conditions like `session_expired` or `device_revoked` that the UI should handle. Subscribe to them via the `'state'` event.

## Device Trust

Vesper uses a device trust model. New devices start in `pending` state and must be approved before they can decrypt messages.

### Trust States

| State | Meaning |
|-------|---------|
| `pending` | Device registered but not yet approved for E2EE |
| `trusted` | Device can encrypt/decrypt messages |
| `revoked` | Device has been removed from the trust chain |

### Approving Devices

From a trusted device, approve a pending one:

```typescript
// List all devices
const state = await client.fetchDevices()

for (const device of state.devices) {
  if (device.trust_state === 'pending') {
    await client.approveDevice(device.id)
  }
}
```

### Approving with Recovery Key

If you only have one device (or no trusted devices), use the recovery mnemonic:

```typescript
const state = await client.approveCurrentDeviceWithRecovery(
  'word1 word2 word3 ... word24'
)
// state.canUseE2EE is now true
```

### Unlocking a Trusted Device

When a trusted device starts up, it needs the password to decrypt its private keys:

```typescript
const state = await client.unlockTrustedDevice(password)
```

### Revoking Devices

```typescript
await client.revokeDevice(deviceId)
```

### Device Identity

Each device needs a stable identity:

```typescript
const client = createVesperClient({
  auth: {
    getDeviceIdentity: () => ({
      id: 'unique-device-id',    // Stable UUID, persisted across restarts
      name: 'My Laptop',         // Human-readable label
      platform: 'node',          // 'node', 'electron', 'web', 'ios', 'android'
    }),
  },
})
```

In the browser, the SDK auto-detects the platform and generates a UUID stored in localStorage.

### VesperAuthDevice Type

```typescript
interface VesperAuthDevice {
  id: string
  client_id: string
  name: string
  platform: string | null
  trust_state: 'pending' | 'trusted' | 'revoked'
  approval_method: string | null
  trusted_at: string | null
  revoked_at: string | null
  last_seen_at: string | null
  inserted_at: string
}
```

## Account Recovery

If the password is lost, recover the account with the 24-word mnemonic:

```typescript
const session = await client.recoverAccount(
  'word1 word2 ... word24',
  'new-password-here'
)
```

This re-derives the identity keys from the recovery mnemonic, re-encrypts them with the new password, and uploads a fresh encrypted key bundle.

To verify a recovery key without changing anything:

```typescript
await client.verifyRecoveryKey('word1 word2 ... word24')
// Throws if the mnemonic is invalid
```

## User Profile

```typescript
await client.updateProfile({
  display_name: 'Alice',
  status: 'online',
})

await client.uploadAvatar(fileBlob)
await client.uploadBanner(fileBlob)
```

## Logout

```typescript
await client.logout()
// Clears tokens, disconnects socket, wipes local crypto state
```
