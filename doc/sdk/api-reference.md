# API Reference

Complete reference for every export path in `@vesper/sdk`.

## `@vesper/sdk`

Main entry point. Re-exports the client and all namespaced modules.

### `createVesperClient(options?): VesperClient`

Factory function for the high-level client.

```typescript
interface VesperClientOptions {
  baseUrl?: string                       // Server URL (default: http://127.0.0.1:4000)
  fetchImpl?: typeof fetch               // Custom fetch for Node.js < 22
  sessionStore?: SessionStore            // Token persistence
  storage?: CryptoStorageConfig | (() => CryptoDbApi)
  storageRuntime?: CryptoStorageRuntime  // Pre-configured runtime
  heartbeatIntervalMs?: number           // Socket heartbeat (default: 30000)
  auth?: VesperAuthClientOptions         // Auth layer config
}

interface VesperAuthClientOptions {
  getDeviceIdentity: () => LocalDeviceIdentity
}

interface LocalDeviceIdentity {
  id: string          // Stable device UUID
  name: string        // Human-readable name
  platform: string    // 'node' | 'electron' | 'web' | 'ios' | 'android'
}
```

### VesperClient

#### Lifecycle

| Method | Returns | Description |
|--------|---------|-------------|
| `register(username, password)` | `Promise<VesperAuthSession>` | Create account with E2EE keys |
| `login(username, password)` | `Promise<VesperAuthSession>` | Sign in, decrypt keys |
| `restoreSession()` | `Promise<VesperAuthSession \| null>` | Resume persisted session |
| `recoverAccount(mnemonic, newPassword)` | `Promise<VesperAuthSession>` | Recover with 24-word phrase |
| `start(forceFull?)` | `Promise<VesperClientState \| null>` | Connect socket, sync workspace |
| `stop()` | `void` | Disconnect socket |
| `logout()` | `Promise<void>` | Sign out, clear all state |

#### State

| Method | Returns | Description |
|--------|---------|-------------|
| `getState()` | `VesperClientState` | Current state snapshot |
| `subscribe(listener)` | `() => void` | Subscribe to all state changes |
| `on(event, listener)` | `() => void` | Subscribe to specific event |

```typescript
interface VesperClientState {
  status: 'signed_out' | 'ready'
  started: boolean
  connected: boolean
  user: VesperUser | null
  currentDevice: VesperAuthDevice | null
  devices: VesperAuthDevice[]
  canUseE2EE: boolean
  servers: VesperServer[]
  conversations: VesperConversation[]
  unreadCounts: {
    channels: Record<string, number>
    conversations: Record<string, number>
  }
  syncToken: string | null
}
```

#### Servers

| Method | Returns | Description |
|--------|---------|-------------|
| `listServers()` | `Promise<VesperServer[]>` | List joined servers |
| `createServer(name)` | `Promise<VesperServer>` | Create a server |
| `joinServerByInvite(code)` | `Promise<VesperServer>` | Join by invite code |
| `leaveServer(serverId)` | `Promise<void>` | Leave a server |
| `deleteServer(serverId)` | `Promise<void>` | Delete (owner only) |
| `createServerChannel(serverId, input)` | `Promise<VesperChannel>` | Add a channel |
| `deleteServerChannel(serverId, channelId)` | `Promise<void>` | Remove a channel |
| `fetchServerChannels(serverId)` | `Promise<VesperChannel[]>` | List channels |
| `fetchServerMembers(serverId)` | `Promise<VesperServerMember[]>` | List members |

#### Conversations

| Method | Returns | Description |
|--------|---------|-------------|
| `listConversations()` | `Promise<VesperConversation[]>` | List DM conversations |
| `createConversation(participantIds, name?)` | `Promise<VesperConversation>` | Create DM/group DM |

#### Devices

| Method | Returns | Description |
|--------|---------|-------------|
| `fetchDevices()` | `Promise<VesperClientState>` | Refresh device list |
| `approveDevice(deviceId)` | `Promise<void>` | Approve pending device |
| `revokeDevice(deviceId)` | `Promise<void>` | Revoke a device |
| `approveCurrentDeviceWithRecovery(mnemonic)` | `Promise<VesperClientState>` | Self-approve with recovery key |
| `unlockTrustedDevice(password)` | `Promise<VesperClientState>` | Decrypt keys on trusted device |
| `verifyRecoveryKey(mnemonic)` | `Promise<void>` | Verify recovery phrase |

#### Profile

| Method | Returns | Description |
|--------|---------|-------------|
| `updateProfile(attrs)` | `Promise<VesperUser>` | Update display name, status |
| `uploadAvatar(file)` | `Promise<VesperUser>` | Set avatar image |
| `uploadBanner(file)` | `Promise<VesperUser>` | Set profile banner |
| `searchUsers(username)` | `Promise<VesperUser[]>` | Search by username |

#### Messaging

| Method | Returns | Description |
|--------|---------|-------------|
| `createEncryptedChat()` | `VesperEncryptedChat` | Get encrypted chat interface |
| `syncNow(forceFull?)` | `Promise<VesperClientState>` | Manual workspace sync |
| `replenishKeyPackages()` | `Promise<void>` | Upload more MLS key packages |

#### Scope Watchers

| Method | Returns | Description |
|--------|---------|-------------|
| `watchChannelScope(channelId)` | `VesperClientScopeEvent[]` | Subscribe to channel events |
| `watchConversationScope(conversationId)` | `VesperClientScopeEvent[]` | Subscribe to DM events |

#### Transport Access

| Method | Returns | Description |
|--------|---------|-------------|
| `apiFetch(path, options?)` | `Promise<Response>` | Raw HTTP request |
| `apiUpload(path, formData)` | `Promise<Response>` | File upload |
| `getHttpClient()` | `VesperHttpClient` | HTTP client instance |
| `getSocketClient()` | `VesperSocketClient` | Socket client instance |
| `getAuthClient()` | `VesperAuthClient` | Auth client instance |
| `getSessionStore()` | `SessionStore` | Session store instance |
| `getAuthSession()` | `VesperAuthSession \| null` | Current auth session |
| `getStorageRuntime()` | `CryptoStorageRuntime` | Crypto storage runtime |
| `getServerUrl()` | `string` | Configured server URL |

---

## `@vesper/sdk/client/file-session-store`

### `createFileSessionStore(filePath, serverUrl): FileSessionStore`

Creates a session store backed by a JSON file.

---

## `@vesper/sdk/auth`

### `createVesperAuthClient(options): VesperAuthClient`

Low-level auth client for use without `VesperClient`.

```typescript
interface VesperAuthClientOptions {
  transport: VesperTransport
  storage: CryptoDbApi | CryptoStorageRuntime
  getDeviceIdentity: () => LocalDeviceIdentity
}
```

#### VesperAuthClient Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `register(username, password)` | `Promise<VesperAuthSession>` | Create account |
| `login(username, password)` | `Promise<VesperAuthSession>` | Sign in |
| `logout()` | `Promise<void>` | Sign out |
| `checkAuth()` | `Promise<VesperAuthSession \| null>` | Validate current tokens |
| `recoverAccount(mnemonic, newPassword)` | `Promise<VesperAuthSession>` | Account recovery |
| `verifyRecoveryKey(mnemonic)` | `Promise<void>` | Validate mnemonic |
| `fetchDevices(state)` | `Promise<DeviceListState>` | Get device list |
| `approveDevice(deviceId)` | `Promise<void>` | Approve a device |
| `revokeDevice(deviceId)` | `Promise<void>` | Revoke a device |
| `approveCurrentDeviceWithRecovery(mnemonic)` | `Promise<VesperAuthSession>` | Self-approve |
| `unlockTrustedDevice(user, device, password)` | `Promise<VesperAuthSession>` | Unlock keys |
| `updateProfile(attrs)` | `Promise<VesperUser>` | Update profile |
| `uploadAvatar(file)` | `Promise<VesperUser>` | Upload avatar |
| `uploadBanner(file)` | `Promise<VesperUser>` | Upload banner |
| `replenishKeyPackages(user, canUseE2EE)` | `Promise<void>` | Upload key packages |

### VesperAuthSession

```typescript
interface VesperAuthSession {
  user: VesperUser
  currentDevice: VesperAuthDevice | null
  devices: VesperAuthDevice[]
  canUseE2EE: boolean
  recoveryMnemonic: string | null  // Only present after registration
}
```

---

## `@vesper/sdk/transport`

### `createVesperTransport(options?): VesperTransport`

Creates the low-level transport layer (HTTP client + socket client + session store).

```typescript
interface VesperTransportOptions {
  baseUrl?: string
  fetchImpl?: typeof fetch
  sessionStore?: SessionStore
  socketOptions?: Partial<VesperSocketClientOptions>
}

interface VesperTransport {
  sessionStore: SessionStore
  httpClient: VesperHttpClient
  socketClient: VesperSocketClient
}
```

---

## `@vesper/sdk/api`

REST API functions and HTTP/socket clients. All API functions accept an optional `httpClient` parameter; if omitted, they use a shared default.

### HTTP Client

```typescript
class VesperHttpClient {
  getServerUrl(): string
  getAccessToken(): string | null
  getRefreshToken(): string | null
  setTokens(access: string, refresh: string): void
  clearTokens(): void
  apiFetch(path: string, options?: RequestInit): Promise<Response>
  apiUpload(path: string, formData: FormData): Promise<Response>
}
```

### Socket Client

```typescript
class VesperSocketClient {
  connect(): Socket
  disconnect(): void
  joinChannel(topic: string): Channel
  leaveChannel(topic: string): void
  on(event: string, listener: (payload: unknown) => void): void
  onSocketOpen(listener: () => void): () => void
  onSocketClose(listener: () => void): () => void
  onSocketError(listener: (error: unknown) => void): () => void
}
```

### Chat API Functions

| Function | Method | Endpoint |
|----------|--------|----------|
| `getCurrentUser(http?)` | GET | `/api/v1/auth/me` |
| `listServers(http?)` | GET | `/api/v1/servers` |
| `listConversations(http?)` | GET | `/api/v1/conversations` |
| `fetchWorkspaceSync(since?, http?)` | GET | `/api/v1/sync` |
| `fetchScopesSync(scopes, limit?, since?, http?)` | POST | `/api/v1/sync/scopes` |
| `searchUsers(username, http?)` | GET | `/api/v1/users/search` |
| `createConversation(ids, name?, http?)` | POST | `/api/v1/conversations` |
| `createServer(name, http?)` | POST | `/api/v1/servers` |
| `createServerChannel(serverId, input, http?)` | POST | `/api/v1/servers/{id}/channels` |
| `getServerInviteCode(serverId, http?)` | GET | `/api/v1/servers/{id}/invite-code` |
| `joinServerByInvite(code, http?)` | POST | `/api/v1/servers/join` |
| `leaveServer(serverId, http?)` | DELETE | `/api/v1/servers/{id}/leave` |
| `fetchChannelMessages(channelId, opts?, http?)` | GET | `/api/v1/channels/{id}/messages` |
| `fetchConversationMessages(convId, opts?, http?)` | GET | `/api/v1/conversations/{id}/messages` |

### Crypto API Functions

| Function | Method | Endpoint |
|----------|--------|----------|
| `uploadKeyPackages(packages, deviceId, http?)` | POST | `/api/v1/key-packages` |
| `fetchKeyPackage(userId, deviceId?, http?)` | GET | `/api/v1/key-packages/{userId}` |
| `consumeOwnKeyPackage(keyPackageData, http?)` | POST | `/api/v1/key-packages/me/consume` |
| `purgeMyKeyPackages(deviceId, http?)` | DELETE | `/api/v1/key-packages/mine` |
| `getMyKeyPackageCount(deviceId, http?)` | GET | `/api/v1/key-packages/mine/count` |
| `fetchPendingWelcomes(scopeId, http?)` | GET | `/api/v1/mls/welcomes/{scopeId}` |
| `ackPendingWelcome(id, http?)` | POST | `/api/v1/mls/welcomes/{id}/ack` |
| `fetchMlsEvents(scopeId, fromSeq?, http?)` | GET | `/api/v1/mls/events/{scopeId}` |

### Utility Functions

```typescript
function base64ToUint8(b64: string): Uint8Array
function uint8ToBase64(bytes: Uint8Array): string
```

---

## `@vesper/sdk/crypto`

MLS operations, key management, message payloads, and file encryption.

### MLS Operations

| Function | Description |
|----------|-------------|
| `initCipherSuite()` | Initialize the MLS cipher suite (call once) |
| `createMLSGroup(groupId, identity)` | Create a new MLS group |
| `createKeyPackageBatch(identity, count, keys?)` | Generate key packages |
| `addMemberToGroup(state, keyPackage)` | Add a member via key package |
| `removeMemberFromGroup(state, leafIndex)` | Remove a member |
| `groupHasMember(state, identity)` | Check membership |
| `findMemberLeafIndex(state, identity)` | Get member's leaf index |
| `encryptMessage(state, plaintext)` | Encrypt an application message |
| `decryptMessage(state, ciphertext)` | Decrypt an application message |
| `serializeGroupState(state)` | Serialize for storage |
| `deserializeGroupState(bytes)` | Deserialize from storage |
| `processCommitMessage(message, state)` | Apply a commit |
| `processWelcome(welcome, state)` | Process a welcome message |
| `deriveVoiceKey(state)` | Derive key for voice encryption |

### Identity & Recovery

| Function | Description |
|----------|-------------|
| `createEncryptedKeyBundle(privateKeys, password)` | Encrypt keys with password |
| `decryptEncryptedKeyBundle(bundle, password)` | Decrypt keys with password |
| `generateRecoveryKey()` | Generate 24-word mnemonic + key bytes |
| `recoveryKeyToBytes(mnemonic)` | Convert mnemonic to raw key |
| `createRecoveryData(privateKeys)` | Create recovery bundle |
| `decryptWithRecoveryKey(mnemonic, bundle)` | Decrypt with recovery key |
| `derivePasswordKey(password, salt)` | Derive AES key from password |

### Message Payloads

```typescript
// Encode a payload for encryption
function encodePayload(payload: MessagePayload): string

// Decode from decrypted plaintext (handles v0 and bare strings)
function decodePayload(plaintext: string): MessagePayload

// Get readable text from any payload type
function getDisplayText(payload: MessagePayload): string

type MessagePayload = TextPayload | FilePayload

interface TextPayload {
  v: 1
  type: 'text'
  text: string
}

interface FilePayload {
  v: 1
  type: 'file'
  text: string | null
  file: {
    id: string
    name: string
    content_type: string
    size: number
    key: string              // Base64 AES-256-GCM key
    iv: string               // Base64 IV
    duration?: number
    thumbnail?: { id: string; key: string; iv: string }
    audio_metadata?: {
      title?: string
      artist?: string
      album?: string
    }
  }
}
```

### File Encryption

```typescript
interface EncryptedFile {
  ciphertext: ArrayBuffer
  key: string   // Base64
  iv: string    // Base64
}

function encryptFile(data: ArrayBuffer): Promise<EncryptedFile>
function decryptFile(ciphertext: ArrayBuffer, key: string, iv: string): Promise<ArrayBuffer>
```

### Decryption Cache

```typescript
function getCachedDecryption(messageId: string): string | null
function setCachedDecryption(messageId: string, plaintext: string): void
function removeCachedDecryption(messageId: string): void
function clearDecryptionCache(): void
function cacheSentMessage(storage, ciphertextB64: string, plaintext: string): void
function getSentMessage(ciphertextB64: string): string | null
function getStoredSentMessage(storage, ciphertextB64: string): Promise<string | null>
```

---

## `@vesper/sdk/storage`

### `MemoryStorage`

In-memory `CryptoDbApi` implementation. Data lost on process exit.

```typescript
import { MemoryStorage } from '@vesper/sdk/storage'
const storage = new MemoryStorage()
```

### `IndexedDbStorage`

Browser IndexedDB implementation. One database per user.

```typescript
import { IndexedDbStorage } from '@vesper/sdk/storage'
const storage = new IndexedDbStorage()
```

## `@vesper/sdk/storage/file`

### `FileCryptoStorage`

Node.js file-based `CryptoDbApi` implementation. Atomic writes.

```typescript
import { FileCryptoStorage } from '@vesper/sdk/storage/file'
const storage = new FileCryptoStorage('/path/to/crypto.json')
```

---

## `@vesper/sdk/types`

Re-exports from `crypto/types.ts`:

```typescript
interface IdentityKeys { ... }
interface EncryptedKeyBundle { ciphertext: Uint8Array; nonce: Uint8Array; salt: Uint8Array }
interface KeyPackagePair { keyPackage: Uint8Array; privateKey: Uint8Array }
interface MLSGroupInfo { groupId: string; state: Uint8Array; epoch: number }
interface EncryptedMessage { ciphertext: Uint8Array; epoch: number; newState: ClientState }
interface DecryptedMessage { plaintext: string; newState: ClientState }
interface RecoveryKeyData { mnemonic: string; hash: string; encryptedBundle: Uint8Array; nonce: Uint8Array }
```

---

## `@vesper/sdk/testing`

Utilities for integration tests that need a live Vesper server.

### `bootServerStack(): Promise<SdkServerStack>`

Boots a Phoenix test server on a free port with a fresh database.

```typescript
interface SdkServerStack {
  apiPort: number
  apiUrl: string
  artifactDir: string
  dbName: string
  process: ChildProcess
  runId: string
}
```

### `teardownServerStack(stack): Promise<void>`

Stops the server and cleans up the test database.

### Usage

```typescript
import { bootServerStack, teardownServerStack } from '@vesper/sdk/testing'

const stack = await bootServerStack()

const client = createVesperClient({ baseUrl: stack.apiUrl })
await client.register('testuser', 'testpass')
// ... run tests ...

await teardownServerStack(stack)
```

---

## `@vesper/sdk/voice`

Voice/RTC configuration. Re-exports voice config types and helpers for encrypted voice calls.

---

## Data Types

### VesperUser

```typescript
interface VesperUser {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
  banner_url: string | null
  status: string
}
```

### VesperServer

```typescript
interface VesperServer {
  id: string
  name: string
  icon_url: string | null
  owner_id: string
  channels: VesperChannel[]
}
```

### VesperChannel

```typescript
interface VesperChannel {
  id: string
  name: string
  type: string
  category_id?: string | null
  topic: string | null
  position: number
  disappearing_ttl: number | null
  server_id?: string
  last_message_id?: string | null
  last_message_inserted_at?: string | null
  last_message_sender?: VesperMemberPreview | null
}
```

### VesperConversation

```typescript
interface VesperConversation {
  id: string
  type: string
  name: string | null
  disappearing_ttl: number | null
  inserted_at: string
  participants: VesperConversationParticipant[]
  last_message: VesperConversationMessagePreview | null
}
```

### VesperMessage

```typescript
interface VesperMessage {
  id: string
  room_seq?: number | null
  channel_id?: string | null
  conversation_id?: string | null
  server_id?: string | null
  sender_id: string | null
  sender: VesperMemberPreview | null
  parent_message_id?: string | null
  inserted_at: string
  expires_at?: string | null
  content?: string
  ciphertext?: string
  mls_epoch?: number | null
  attachments?: Array<{
    id: string
    filename: string
    content_type: string
    byte_size: number
  }>
  reactions?: Array<{
    emoji: string
    sender_id: string
  }>
}
```

### VesperAuthDevice

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

### VesperMemberPreview

```typescript
interface VesperMemberPreview {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
}
```
