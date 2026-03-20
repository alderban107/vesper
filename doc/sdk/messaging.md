# Messaging

Messages in Vesper are end-to-end encrypted using MLS (Messaging Layer Security). The SDK manages MLS group state, encryption, and decryption through the `VesperEncryptedChat` interface.

## Scopes

A "scope" is an MLS group tied to either a channel (inside a server) or a conversation (DM). Before sending or receiving messages in a scope, you must join its MLS group.

```typescript
const chat = client.createEncryptedChat()

// Join a server channel
await chat.joinScope(channelId, 'channel')

// Join a DM conversation
await chat.joinScope(conversationId, 'conversation')
```

Joining a scope:
1. Checks if a local MLS group state exists for this scope
2. If not, fetches pending MLS welcome messages from the server
3. If no welcome is available, creates a new MLS group and publishes a commit
4. Starts processing incoming MLS events for the scope

Leave a scope when you no longer need it:

```typescript
await chat.leaveScope(scopeId)
```

## Sending Messages

```typescript
const msg = await chat.sendMessage(channelId, 'Hello, world')
```

`sendMessage` encrypts the text as an MLS application message and sends the ciphertext to the server. The server relays it to all group members.

The returned `ProcessedScopeMessage` contains both the encrypted and decrypted forms:

```typescript
interface ProcessedScopeMessage {
  id: string
  scopeId: string
  channelId: string | null
  conversationId: string | null
  senderId: string | null
  senderUsername: string | null
  parentMessageId: string | null
  insertedAt: string
  content: string           // Server-stored ciphertext
  plaintext: string | null  // Decrypted text (available locally)
}
```

## Receiving Messages

Subscribe to scope events to receive messages in real time:

```typescript
const unsub = client.on('scope.event', (event) => {
  switch (event.type) {
    case 'new_message':
      const text = chat.getDecryptedMessageText(event.payload)
      console.log(`${event.payload.senderUsername}: ${text}`)
      break
    case 'typing_start':
      console.log(`${event.payload.username} is typing...`)
      break
    case 'typing_stop':
      break
  }
})

// Start watching a channel for events
client.watchChannelScope(channelId)

// Or a DM conversation
client.watchConversationScope(conversationId)
```

The `getDecryptedMessageText` method checks the decryption cache first, falling back to the message's `plaintext` field.

## Fetching Message History

```typescript
const messages = await chat.fetchMessages(channelId, {
  limit: 50,
  before: lastMessageId,    // For backward pagination
  after: firstMessageId,    // For forward pagination
  after_seq: 42,            // By sequence number
})
```

History messages are decrypted on fetch using cached group states. If a message's MLS epoch is too old and the group state for that epoch is no longer available, `plaintext` will be `null`.

## Message Payloads

Messages use a versioned payload schema. The SDK encodes and decodes these automatically.

### Text Messages

```typescript
{
  v: 1,
  type: 'text',
  text: 'Hello, world'
}
```

### File Messages

File payloads carry an encrypted attachment reference. The file itself is uploaded separately (encrypted client-side with AES-256-GCM), and the decryption key is embedded in the payload.

```typescript
{
  v: 1,
  type: 'file',
  text: 'Check out this photo',  // Optional caption
  file: {
    id: 'attachment-uuid',        // Server attachment ID
    name: 'photo.jpg',
    content_type: 'image/jpeg',
    size: 1048576,
    key: 'base64-aes-key',       // AES-256-GCM key
    iv: 'base64-iv',             // Initialization vector
    duration: 30,                 // Seconds (video/audio)
    thumbnail: {                  // Optional thumbnail
      id: 'thumb-uuid',
      key: 'base64-key',
      iv: 'base64-iv',
    },
    audio_metadata: {             // Optional audio info
      title: 'Song Name',
      artist: 'Artist',
      album: 'Album',
    },
  },
}
```

### Payload Functions

```typescript
import { encodePayload, decodePayload, getDisplayText } from '@vesper/sdk/crypto'

// Encode for encryption
const json = encodePayload({ v: 1, type: 'text', text: 'Hello' })

// Decode from decrypted plaintext (handles legacy v0 and bare strings)
const payload = decodePayload(plaintextString)

// Get readable text from any payload type
const display = getDisplayText(payload)
// Text messages: returns the text
// File messages: returns the caption, or "[file: photo.jpg]" if no caption
```

## File Encryption

Files are encrypted client-side before upload:

```typescript
import { encryptFile, decryptFile } from '@vesper/sdk/crypto'

// Encrypt
const { ciphertext, key, iv } = await encryptFile(fileArrayBuffer)
// Upload `ciphertext` to the server
// Include `key` and `iv` in the message payload (encrypted by MLS)

// Decrypt
const plainBuffer = await decryptFile(ciphertext, key, iv)
```

Both use AES-256-GCM via the Web Crypto API. The key and IV are random per file and travel inside the MLS-encrypted message payload, so the server never sees them.

## Servers and Channels

```typescript
// Create a server
const server = await client.createServer('My Server')

// Create a channel in a server
const channel = await client.createServerChannel(server.id, {
  name: 'general',
  type: 'text',
})

// List channels
const channels = await client.fetchServerChannels(server.id)

// Delete a channel
await client.deleteServerChannel(server.id, channel.id)

// Get an invite code
// (use the low-level API for this)
import { getServerInviteCode } from '@vesper/sdk/api'
const code = await getServerInviteCode(server.id, client.getHttpClient())

// Join by invite
const joined = await client.joinServerByInvite('INVITE-CODE')

// Leave
await client.leaveServer(server.id)
```

## DM Conversations

```typescript
// Search for users
const users = await client.searchUsers('bob')

// Create a 1:1 DM
const dm = await client.createConversation([users[0].id])

// Create a group DM
const group = await client.createConversation(
  [users[0].id, users[1].id],
  'Project Chat'
)

// List conversations
const conversations = await client.listConversations()
```

## Unread Counts

The client state tracks unread counts per channel and conversation:

```typescript
const state = client.getState()

// Per-channel unreads
state.unreadCounts.channels[channelId]  // number | undefined

// Per-conversation unreads
state.unreadCounts.conversations[conversationId]
```

These update in real time via the socket connection.
