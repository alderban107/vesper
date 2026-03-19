# Vesper SDK

Start here if you want the smallest working Node setup.

For longer sample apps, see [examples/README.md](./examples/README.md).

## Quickstart

Install and build the workspace package first, then create a client with an explicit session store and crypto storage.

```js
import path from 'node:path'

import { createVesperClient } from '@vesper/sdk'
import { createFileSessionStore } from '@vesper/sdk/client/file-session-store'
import { FileCryptoStorage } from '@vesper/sdk/storage/file'

const baseUrl = process.env.VESPER_API_URL ?? 'http://127.0.0.1:4000'
const stateDir = path.join(process.cwd(), '.vesper-sdk')

const client = createVesperClient({
  baseUrl,
  sessionStore: createFileSessionStore(path.join(stateDir, 'session.json'), baseUrl),
  storage: () => new FileCryptoStorage(path.join(stateDir, 'crypto.json')),
  auth: {
    getDeviceIdentity: () => ({
      id: 'example-node-device',
      name: 'Example Node Device',
      platform: 'node'
    })
  }
})

const username = process.env.VESPER_USERNAME ?? 'alice'
const password = process.env.VESPER_PASSWORD ?? 'super-secret-password'

const session = (await client.restoreSession()) ?? (await client.login(username, password))
await client.start(false)

console.log({
  userId: session.user.id,
  username: session.user.username,
  serverCount: client.getState().servers.length,
  conversationCount: client.getState().conversations.length
})

const chat = client.createEncryptedChat()
```

## Low-level setup

If you want to work below `createVesperClient()`, prefer explicit transport wiring over the shared defaults:

```js
import { createVesperAuthClient } from '@vesper/sdk/auth'
import { createVesperTransport } from '@vesper/sdk/transport'
import { MemoryStorage } from '@vesper/sdk/storage'
import { getCurrentUser } from '@vesper/sdk/api'

const transport = createVesperTransport({
  baseUrl: 'http://127.0.0.1:4000',
  fetchImpl: fetch
})

const auth = createVesperAuthClient({
  transport,
  storage: new MemoryStorage(),
  getDeviceIdentity: () => ({
    id: 'low-level-node-device',
    name: 'Low-level Node Device',
    platform: 'node'
  })
})

await auth.login('alice', 'super-secret-password')
const me = await getCurrentUser(transport.httpClient)
```
