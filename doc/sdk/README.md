# Vesper SDK

TypeScript SDK for building Vesper clients with end-to-end encryption.

The SDK handles authentication, MLS-based encryption, real-time messaging over Phoenix WebSockets, device trust management, and file encryption. It runs in Node.js, Electron, and the browser.

## Documentation

| Guide | Description |
|-------|-------------|
| [Quickstart](./quickstart.md) | Install, authenticate, send your first encrypted message |
| [Authentication](./authentication.md) | Registration, login, sessions, device trust, account recovery |
| [Messaging](./messaging.md) | Sending and receiving encrypted messages, scopes, message payloads |
| [Encryption](./encryption.md) | MLS protocol details, key management, file encryption |
| [Storage](./storage.md) | Session stores, crypto storage adapters, persistence |
| [Events](./events.md) | Real-time events, subscriptions, socket lifecycle |
| [Bots](./bots.md) | Bot framework, commands, mention handling |
| [API Reference](./api-reference.md) | Full type and method reference for every export path |

## Package Exports

The SDK exposes focused entry points so you can import only what you need:

```typescript
import { createVesperClient } from '@vesper/sdk'                    // Main client
import { createFileSessionStore } from '@vesper/sdk/client/file-session-store'
import { createVesperAuthClient } from '@vesper/sdk/auth'           // Auth layer
import { createVesperTransport } from '@vesper/sdk/transport'       // Low-level transport
import { MemoryStorage } from '@vesper/sdk/storage'                 // Storage adapters
import { FileCryptoStorage } from '@vesper/sdk/storage/file'        // Node file storage
import * as VesperApi from '@vesper/sdk/api'                        // REST API functions
import * as VesperCrypto from '@vesper/sdk/crypto'                  // Crypto primitives
import * as VesperTypes from '@vesper/sdk/types'                    // Shared types
import { bootServerStack } from '@vesper/sdk/testing'               // Test utilities
```

## Runtime Requirements

- Node.js 22+ (or a browser with Web Crypto API)
- A running Vesper server instance
- `fetch` available globally (Node 22 has this built in)

## Dependencies

| Package | Purpose |
|---------|---------|
| `ts-mls` | MLS (Messaging Layer Security) protocol implementation |
| `@noble/ciphers` | AES-GCM encryption |
| `@noble/curves` | X25519, Ed25519 key exchange and signing |
| `@noble/hashes` | SHA-256, SHA-512 |
| `hash-wasm` | Argon2id password hashing |
| `@hpke/core` | Hybrid Public Key Encryption |
| `phoenix` | WebSocket client for Phoenix channels |
