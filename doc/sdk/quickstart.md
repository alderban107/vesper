# Quickstart

## Install

The SDK is a workspace package. Build it from the repo root:

```bash
npm install
npm run build -w @vesper/sdk
```

## Node.js Client

```typescript
import path from 'node:path'
import { createVesperClient } from '@vesper/sdk'
import { createFileSessionStore } from '@vesper/sdk/client/file-session-store'
import { FileCryptoStorage } from '@vesper/sdk/storage/file'

const baseUrl = process.env.VESPER_API_URL ?? 'http://127.0.0.1:4000'
const stateDir = path.join(process.cwd(), '.vesper-sdk')

const client = createVesperClient({
  baseUrl,
  sessionStore: createFileSessionStore(
    path.join(stateDir, 'session.json'),
    baseUrl
  ),
  storage: () => new FileCryptoStorage(
    path.join(stateDir, 'crypto.json')
  ),
  auth: {
    getDeviceIdentity: () => ({
      id: 'my-node-device',
      name: 'My Node App',
      platform: 'node',
    }),
  },
})
```

## Register or Login

```typescript
// Register a new account
const session = await client.register('alice', 'strong-password-here')
// session.recoveryMnemonic contains the 24-word backup phrase -- save it

// Or login to existing account
const session = await client.login('alice', 'strong-password-here')

// Or restore a persisted session from disk
const session = await client.restoreSession()
if (!session) {
  // No saved session, need to login
}
```

## Connect and Sync

```typescript
await client.start()

const state = client.getState()
// state.user         -- your VesperUser
// state.servers      -- servers you belong to
// state.conversations -- your DM conversations
// state.canUseE2EE   -- true if device is trusted
```

## Send an Encrypted Message

```typescript
const chat = client.createEncryptedChat()

// Join a channel's MLS group
const channelId = state.servers[0].channels[0].id
await chat.joinScope(channelId, 'channel')

// Send a message
const msg = await chat.sendMessage(channelId, 'Hello from the SDK')
```

## Receive Messages

```typescript
// Subscribe to scope events (messages, typing, etc.)
const unsub = client.on('scope.event', (event) => {
  if (event.type === 'new_message') {
    const plaintext = chat.getDecryptedMessageText(event.payload)
    console.log(`${event.payload.senderUsername}: ${plaintext}`)
  }
})

// Watch a specific channel for real-time updates
client.watchChannelScope(channelId)
```

## Fetch Message History

```typescript
const messages = await chat.fetchMessages(channelId, {
  limit: 50,
  before: someMessageId, // pagination cursor
})

for (const msg of messages) {
  console.log(`${msg.senderUsername}: ${msg.plaintext}`)
}
```

## Cleanup

```typescript
client.stop()       // disconnect socket, stop heartbeat
await client.logout() // clear session and crypto state
```

## Low-Level Setup

If you need more control, wire the transport layer directly:

```typescript
import { createVesperAuthClient } from '@vesper/sdk/auth'
import { createVesperTransport } from '@vesper/sdk/transport'
import { MemoryStorage } from '@vesper/sdk/storage'
import { getCurrentUser, listServers } from '@vesper/sdk/api'

const transport = createVesperTransport({
  baseUrl: 'http://127.0.0.1:4000',
  fetchImpl: fetch,
})

const auth = createVesperAuthClient({
  transport,
  storage: new MemoryStorage(),
  getDeviceIdentity: () => ({
    id: 'low-level-device',
    name: 'Low-Level Device',
    platform: 'node',
  }),
})

await auth.login('alice', 'strong-password-here')

const me = await getCurrentUser(transport.httpClient)
const servers = await listServers(transport.httpClient)
```

## Next Steps

- [Authentication](./authentication.md) for device trust and account recovery
- [Messaging](./messaging.md) for message payloads, file attachments, and threads
- [Events](./events.md) for real-time subscriptions
- [Bots](./bots.md) for building automated agents
