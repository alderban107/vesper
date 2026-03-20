# Storage

The SDK separates session storage (auth tokens) from crypto storage (MLS keys, group state, caches). Both are pluggable through interfaces.

## Session Stores

Session stores persist JWT tokens and the server URL. Three implementations ship with the SDK.

### FileSessionStore (Node.js / Electron)

Persists to a JSON file on disk.

```typescript
import { createFileSessionStore } from '@vesper/sdk/client/file-session-store'

const store = createFileSessionStore(
  '/path/to/.vesper/session.json',
  'http://127.0.0.1:4000'
)

const client = createVesperClient({ sessionStore: store })
```

File format:

```json
{
  "serverUrl": "http://127.0.0.1:4000",
  "accessToken": "eyJ...",
  "refreshToken": "eyJ...",
  "notice": null
}
```

### BrowserSessionStore

Uses `localStorage`. Selected automatically when running in a browser and no custom store is provided.

Keys:
- `vesper:access_token`
- `vesper:refresh_token`
- `vesper:server_url`
- `vesper:session_notice`

### MemorySessionStore

In-memory, for testing or ephemeral sessions.

```typescript
import { MemorySessionStore } from '@vesper/sdk/api'

const store = new MemorySessionStore('http://127.0.0.1:4000')
```

### Custom Session Store

Implement the `SessionStore` interface:

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

## Crypto Storage

Crypto storage persists MLS identity keys, group states, key packages, and message caches. The interface is more complex because it must handle concurrent async operations scoped to a user.

### CryptoStorageRuntime

The `CryptoStorageRuntime` wraps a `CryptoDbApi` backend with user-scoped context management:

```typescript
const client = createVesperClient({
  storage: () => new FileCryptoStorage('/path/to/crypto.json'),
  // or
  storage: { type: 'memory' },
  // or
  storageRuntime: myCustomRuntime,
})
```

The `storage` option accepts either a config object or a factory function that returns a `CryptoDbApi` implementation.

### Built-in Adapters

#### MemoryStorage

In-memory, data lost on process exit. Good for testing.

```typescript
import { MemoryStorage } from '@vesper/sdk/storage'

const storage = new MemoryStorage()
```

#### FileCryptoStorage (Node.js)

Persists all crypto state to a single JSON file.

```typescript
import { FileCryptoStorage } from '@vesper/sdk/storage/file'

const storage = new FileCryptoStorage('/path/to/crypto.json')
```

Stores identity keys, group states, key packages, and cached messages in a structured JSON format. Writes are atomic (write-then-rename).

#### IndexedDbStorage (Browser)

Uses IndexedDB with one database per user. Selected automatically in the browser.

```typescript
import { IndexedDbStorage } from '@vesper/sdk/storage'
```

Object stores:
- `identity` -- identity key material
- `groups` -- MLS group states
- `keyPackages` -- unused key packages
- `messages` -- cached message data
- `decryptions` -- plaintext decryption cache

### CryptoDbApi Interface

All storage adapters implement this interface:

```typescript
interface CryptoDbApi {
  // Identity
  saveIdentity(userId, publicIdentityKey, publicKeyExchange,
               encryptedPrivateKeys, nonce, salt,
               signaturePrivateKey?): Promise<void>
  loadIdentity(userId): Promise<IdentityData | null>
  deleteIdentity(userId): Promise<void>

  // MLS group state
  saveGroupState(groupId, state: Uint8Array, epoch: number): Promise<void>
  loadGroupState(groupId): Promise<{ state: Uint8Array; epoch: number } | null>
  deleteGroupState(groupId): Promise<void>
  loadGroupSyncCursor(groupId): Promise<number>
  saveGroupSyncCursor(groupId, lastEventSeq: number): Promise<void>

  // Key packages
  saveKeyPackages(packages): Promise<void>
  loadKeyPackages(): Promise<KeyPackageRecord[]>
  loadKeyPackageByRef(ref: string): Promise<KeyPackageRecord | null>
  consumeKeyPackage(id: number): Promise<void>
  countKeyPackages(): Promise<number>

  // Message cache
  cacheMessage(msg: CachedMessageRecord): Promise<void>
  loadCachedMessages(channelId): Promise<CachedMessageRecord[]>
  clearCachedMessages(channelId): Promise<void>
  loadCachedMessageDecryption(messageId): Promise<string | null>
  saveCachedMessageDecryption(messageId, plaintext): Promise<void>

  // Full-text search index
  indexDecryptedMessage(messageId, channelId, content): Promise<void>
  removeFromFtsIndex(messageId): Promise<void>
  searchDecryptedMessages(query, channelId?): Promise<SearchResult[]>
}
```

### User-Scoped Context

Crypto operations run inside a user context. The `CryptoStorageRuntime` tracks which user's data is active using Node.js `AsyncLocalStorage` (or a synchronous fallback in the browser).

```typescript
// The VesperClient manages this automatically.
// If using the runtime directly:
await runtime.run(userId, async () => {
  const identity = await runtime.loadIdentity(userId)
  // ...
})
```

### Lifecycle

```typescript
// Configure the storage backend
runtime.configure({ type: 'memory' })

// Initialize for a specific user (called during login)
runtime.init(userId)

// Reset all state (called during logout)
runtime.reset()
```
