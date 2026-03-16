# `@vesper/sdk` — TypeScript SDK for Vesper Clients

## Problem

All protocol logic (REST, WebSocket channels, MLS encryption, WebRTC voice) is embedded in the Electron client. There's no way to build alternative clients, bots, mobile apps, or integrations without reverse-engineering the client source.

## Design Philosophy

The SDK should feel like any other chat SDK. You send strings, you receive strings. You upload files, you download files. The fact that everything is end-to-end encrypted is an implementation detail the consumer never thinks about.

Encryption only surfaces where security requires user involvement:
- **Registration** returns a 24-word recovery mnemonic. The consumer must present it to the user once. This is the only backup path if they lose all devices.
- **New devices** start untrusted and can't participate until approved (via recovery mnemonic or another trusted device). The SDK exposes `client.isReady` and `client.approveWithRecovery()` for this.

Everything else — key generation, key package management, MLS group creation/joins/resyncs, epoch tracking, commit processing, decryption caching — is invisible.

## Goals

- Feel like a normal chat SDK — `sendMessage("hello")`, receive `message.content` as plaintext
- Work in Node.js, browsers, Electron, and React Native
- Provide layered APIs (transport, resource APIs, managed client) so developers pick their abstraction level
- Handle all encryption, key management, and protocol complexity internally

## Non-Goals

- UI components or framework bindings
- Server-side changes

---

## Architecture

Three layers, each usable independently. Inspired by discord.js's layered package design (`@discordjs/rest` → `@discordjs/ws` → `discord.js`).

```
┌─────────────────────────────────────────────────────┐
│  Layer 3: VesperClient                              │
│  Stateful, event-driven, E2EE transparent           │
├─────────────────────────────────────────────────────┤
│  Layer 2: Resource APIs                             │
│  Typed REST wrappers (AuthApi, ServersApi, etc.)    │
├─────────────────────────────────────────────────────┤
│  Layer 1: Transport                                 │
│  VesperHttp (fetch + auth) + VesperSocket (Phoenix) │
├─────────────────────────────────────────────────────┤
│  Cross-cutting: CryptoProvider, Types, EventBus     │
└─────────────────────────────────────────────────────┘
```

### Layer 1 — Transport

**`VesperHttp`** — fetch wrapper with Bearer auth, automatic 401 → refresh → retry, multipart upload, binary download. Modeled on `client/src/renderer/src/api/client.ts`.

**`VesperSocket`** — Phoenix WebSocket wrapper. Channel join/leave/push, event routing, auto-reconnect. Modeled on `client/src/renderer/src/api/socket.ts`.

### Layer 2 — Resource APIs

Typed wrappers over every REST endpoint in `server/lib/vesper_web/router.ex`. No state, no encryption. Each method maps to exactly one endpoint.

| Class | Endpoints |
|-------|-----------|
| `AuthApi` | register, login, refresh, logout, recover, recover/reset, me, profile, password, devices, approve, revoke, approve-with-recovery, avatar, banner |
| `ServersApi` | CRUD, join, leave |
| `ChannelsApi` | CRUD (nested under servers) |
| `MessagesApi` | list, mark read, pins, thread |
| `ConversationsApi` | create, list, show, messages, mark read |
| `MembersApi` | list, kick, ban, unban, bans |
| `RolesApi` | list, create, update, delete, assign |
| `InvitesApi` | invite-code, list, create, delete |
| `AttachmentsApi` | upload (multipart), download (binary) |
| `EmojisApi` | list, upload, delete, file |
| `EncryptionApi` | key packages (upload/fetch/count), pending welcomes, pending resync requests |
| `SearchIndexApi` | get, upsert (optimistic locking), delete |
| `UsersApi` | search |
| `VoiceApi` | ICE config |
| `UnreadApi` | counts |

### Layer 3 — VesperClient

Composes Layer 1 + Layer 2 + `CryptoProvider`. This is what most developers use.

- Transparent MLS encrypt/decrypt — `sendMessage(channelId, "hello")` encrypts internally
- Automatic MLS group lifecycle (join requests, welcome processing, commit handling, resync)
- Key package replenishment (target 20, threshold 5)
- Presence heartbeats + idle detection
- Typed event emitter for real-time events
- Reconnection with exponential backoff
- Decryption cache (in-memory LRU + persistent storage)

---

## REST API Surface

Every endpoint the SDK must cover, grouped by auth level.

### Public (no auth)
```
GET  /health
POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/auth/refresh
POST /api/v1/auth/logout
POST /api/v1/auth/recover
POST /api/v1/auth/recover/reset
GET  /api/v1/avatars/:user_id
GET  /api/v1/banners/:user_id
GET  /api/v1/servers/:server_id/emojis/:emoji_id/file
```

### Authenticated
```
GET  /api/v1/auth/me
GET  /api/v1/auth/devices
POST /api/v1/auth/devices/approve-with-recovery
PUT  /api/v1/auth/profile
PUT  /api/v1/auth/password
POST /api/v1/auth/avatar
POST /api/v1/auth/banner

GET/POST       /api/v1/servers
GET/PUT/DELETE /api/v1/servers/:id
POST           /api/v1/servers/join
DELETE         /api/v1/servers/:server_id/leave
GET            /api/v1/servers/:server_id/invite-code
GET/POST       /api/v1/servers/:server_id/invites
DELETE         /api/v1/servers/:server_id/invites/:invite_id
GET            /api/v1/servers/:server_id/members
DELETE         /api/v1/servers/:server_id/members/:user_id
POST           /api/v1/servers/:server_id/members/:user_id/ban
DELETE         /api/v1/servers/:server_id/members/:user_id/ban
GET            /api/v1/servers/:server_id/bans
GET            /api/v1/servers/:server_id/audit-logs
GET/POST       /api/v1/servers/:server_id/roles
PUT/DELETE     /api/v1/servers/:server_id/roles/:role_id
PUT            /api/v1/servers/:server_id/members/:user_id/roles
GET/POST       /api/v1/servers/:server_id/emojis
DELETE         /api/v1/servers/:server_id/emojis/:emoji_id

GET/POST/PUT/DELETE /api/v1/servers/:server_id/channels
GET                 /api/v1/servers/:server_id/channels/:id

GET  /api/v1/channels/:id/messages
PUT  /api/v1/channels/:id/read
GET  /api/v1/channels/:id/pins
GET  /api/v1/messages/:id/thread

GET/POST /api/v1/conversations
GET      /api/v1/conversations/:id
GET      /api/v1/conversations/:conversation_id/messages
PUT      /api/v1/conversations/:conversation_id/read

GET  /api/v1/unread
POST /api/v1/attachments
GET  /api/v1/attachments/:id
GET  /api/v1/users/search
GET  /api/v1/voice/config
```

### Authenticated + Trusted Device
```
POST   /api/v1/auth/devices/:id/approve
POST   /api/v1/auth/devices/:id/revoke
POST   /api/v1/key-packages
GET    /api/v1/key-packages/me/count
GET    /api/v1/key-packages/:user_id
GET    /api/v1/pending-welcomes/:channel_id
DELETE /api/v1/pending-welcomes/:id
GET    /api/v1/pending-resync-requests/:channel_id
DELETE /api/v1/pending-resync-requests/:id
GET    /api/v1/search-index
PUT    /api/v1/search-index
DELETE /api/v1/search-index
```

---

## WebSocket Channels

Connect to `/socket` with `{token: accessToken}` param. Phoenix channel protocol.

### Topics

| Topic | Channel | Purpose |
|-------|---------|---------|
| `chat:channel:{id}` | ChatChannel | Text channel messaging + MLS |
| `dm:{id}` | DmChannel | DM messaging + MLS + call signaling |
| `voice:channel:{id}` | VoiceChannel | WebRTC signaling + voice MLS |
| `voice:dm:{id}` | VoiceChannel | DM call signaling |
| `user:{id}` | UserChannel | Presence, notifications, device events |
| `presence:server:{id}` | ServerPresenceChannel | Server member presence |

### Chat/DM Events

**Client sends:**
| Event | Payload |
|-------|---------|
| `new_message` | `{ciphertext, mls_epoch, parent_message_id?, attachment_ids?, mentioned_user_ids?}` |
| `add_reaction` | `{message_id, emoji}` or `{message_id, ciphertext, mls_epoch}` |
| `remove_reaction` | `{message_id, emoji}` or `{message_id, ciphertext, mls_epoch}` |
| `edit_message` | `{message_id, ciphertext, mls_epoch}` |
| `delete_message` | `{message_id}` |
| `pin_message` | `{message_id}` (chat only, manage_messages perm) |
| `unpin_message` | `{message_id}` (chat only) |
| `set_disappearing` | `{ttl}` (admin only) |
| `typing_start` | `{}` |
| `typing_stop` | `{}` |
| `mls_request_join` | `{}` |
| `mls_request_join_all` | `{}` |
| `mls_resync_request` | `{request_id, last_known_epoch?, reason?}` |
| `mls_commit` | `{commit_data}` |
| `mls_remove` | `{removed_user_id, commit_data}` |
| `mls_welcome` | `{recipient_id, welcome_data}` |

**Server broadcasts:**
| Event | Payload |
|-------|---------|
| `new_message` | Full message object (id, ciphertext, mls_epoch, sender, attachments, reactions, etc.) |
| `reaction_update` | `{action, message_id, emoji/ciphertext, sender_id}` |
| `message_edited` | `{message_id, ciphertext, mls_epoch, edited_at}` |
| `message_deleted` | `{message_id}` |
| `message_pinned` | `{channel_id, message_id, pinned_by}` |
| `message_unpinned` | `{channel_id, message_id}` |
| `disappearing_ttl_updated` | `{channel_id, disappearing_ttl}` |
| `typing_start` | `{user_id, username}` (excludes sender) |
| `typing_stop` | `{user_id}` (excludes sender) |
| All MLS events | Same payloads as sent, plus `sender_id` |

### Voice Events

**Client sends:** `answer {sdp}`, `ice_candidate {candidate}`, `mute {muted}`, `call_ring {}`, `call_accept {}`, `call_reject {}`, `voice_key {payload}`, all MLS events.

**Server pushes:** `offer {sdp, track_map, publish_map, e2ee_creator_id}`, `ice_candidate {candidate}`, `renegotiate {sdp, ...}`, `voice_state_update {participants[]}`, `incoming_call {caller_id, conversation_id}`, `call_rejected {user_id}`, `call_timeout {}`.

### User Channel Events

**Client sends:** `heartbeat {}`, `set_status {status: online|idle|dnd}`

**Server pushes:** `presence_state`, `presence_diff`, `unread_update {channel_id, message_id}`, `mention {channel_id, sender_id}`, `dm_message {conversation_id, message_id, sender_id, sender_info}`, `dm_unread_update {conversation_id, message_id}`, `device_approval_requested`, `device_updated`, `new_conversation`, `emoji_created`, `emoji_deleted`

---

## Encryption Internals

> Consumers of `VesperClient` (Layer 3) never interact with anything in this section. It documents the internal machinery for SDK contributors and security auditors.

### Primitives
- **MLS ciphersuite:** `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`
- **Identity encryption:** Argon2id (t=3, m=64MB, p=4) derives AES-256-GCM key from password
- **File encryption:** AES-256-GCM with random key per file; key + IV embedded inside the MLS-encrypted message payload
- **Voice encryption:** 128-bit key derived from MLS exporter secret (label `"voice-e2ee"`)
- **Recovery key:** 24-word BIP39 mnemonic from 256-bit random, SHA-256 hash stored server-side

### Internal Interfaces

These are SDK-internal extension points, not public API. The defaults work out of the box.

**`CryptoProvider`** — Abstracts MLS operations. Default wraps `ts-mls`. Exists so the SDK can be tested with mocks and potentially swap MLS libraries in the future.

**`CryptoStorage`** — Pluggable persistence for MLS group state, identity keys, and key packages. Three bundled adapters:
- `IndexedDBStorage` — browsers (default when `window` exists)
- `SqliteStorage` — Node.js / Electron
- `MemoryStorage` — tests and stateless agents

### Wire Format

Messages are JSON-encoded before MLS encryption:

```typescript
// Text message
{ v: 1, type: "text", text: "Hello world" }

// File attachment (AES key travels inside the encrypted envelope)
{ v: 1, type: "file", text: "optional caption", file: {
    id: "attachment-uuid", name: "photo.jpg",
    content_type: "image/jpeg", size: 204800,
    key: "base64-aes-key", iv: "base64-iv"
}}
```

### Group Lifecycle (automatic)

The SDK manages MLS groups without consumer involvement:
- **Join:** On `joinChannel()`, the SDK requests admission, waits for a welcome from an existing member, processes it, and starts decrypting.
- **Resync:** If decryption fails (epoch mismatch), the SDK automatically requests resync, gets removed + re-added, and retries. Consumers see a brief `syncing: true` on the message, then it resolves.
- **Key packages:** SDK monitors the server-side count and replenishes when it drops below 5 (target: 20).
- **Commit processing:** Incoming commits are applied automatically with retry backoff `[100, 500, 2000]` ms.

### Device Trust

| State | Can use the platform | What the consumer sees |
|-------|---------------------|----------------------|
| `trusted` | Yes | `client.isReady === true` |
| `pending` | No | `client.isReady === false`, must call `approveWithRecovery()` |
| `revoked` | No | `client.isReady === false`, must re-register |

---

## Core Types

```typescript
type UUID = string;
type ISOTimestamp = string;
type Base64String = string;

interface User {
  id: UUID;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  banner_url: string | null;
  status: string | null;
}

interface Device {
  id: UUID;
  client_id: string;
  name: string;
  platform: string | null;
  trust_state: "pending" | "trusted" | "revoked";
  approval_method: string | null;
  trusted_at: ISOTimestamp | null;
  revoked_at: ISOTimestamp | null;
  last_seen_at: ISOTimestamp | null;
  inserted_at: ISOTimestamp;
}

interface Server {
  id: UUID;
  name: string;
  icon_url: string | null;
  owner_id: UUID;
  channels: Channel[];
  emojis: CustomEmoji[];
}

interface Channel {
  id: UUID;
  name: string;
  type: "text" | "voice" | "category";
  category_id: UUID | null;
  topic: string | null;
  position: number;
  disappearing_ttl: number | null;
  permission_overrides: PermissionOverride[];
}

interface Message {
  id: UUID;
  channel_id: UUID | null;
  conversation_id: UUID | null;
  sender_id: UUID;
  sender: { id: UUID; username: string; display_name: string | null; avatar_url: string | null };
  ciphertext: Base64String | null;
  mls_epoch: number | null;
  parent_message_id: UUID | null;
  edited_at: ISOTimestamp | null;
  expires_at: ISOTimestamp | null;
  inserted_at: ISOTimestamp;
  attachments: Attachment[];
  reactions: Reaction[];
}

interface Attachment {
  id: UUID;
  filename: string;
  content_type: string;
  size_bytes: number;
  encrypted: boolean;
}

interface Reaction {
  id: UUID;
  emoji: string | null;
  ciphertext: Base64String | null;
  mls_epoch: number | null;
  sender_id: UUID;
  inserted_at: ISOTimestamp;
}

interface DmConversation {
  id: UUID;
  type: "direct" | "group";
  name: string | null;
  disappearing_ttl: number | null;
  participants: DmParticipant[];
  last_message: Message | null;
}

interface ServerRole {
  id: UUID;
  server_id: UUID;
  name: string;
  color: string | null;
  permissions: number;
  position: number;
}

// Permissions bitfield
const Permissions = {
  ADMINISTRATOR:    0x00000001,
  MANAGE_SERVER:    0x00000002,
  MANAGE_CHANNELS:  0x00000004,
  MANAGE_ROLES:     0x00000008,
  KICK_MEMBERS:     0x00000010,
  BAN_MEMBERS:      0x00000020,
  CREATE_INVITES:   0x00000040,
  MANAGE_MESSAGES:  0x00000080,
  SEND_MESSAGES:    0x00000100,
  VIEW_CHANNEL:     0x00000200,
  MANAGE_EMOJIS:    0x00000400,
} as const;
```

---

## Event System

All events are typed. `client.on()` returns an unsubscribe function. `client.once()` fires once then auto-removes.

### DecryptedMessage

The SDK's primary output type. Consumers never see ciphertext — every message event delivers this:

```typescript
interface DecryptedMessage {
  id: UUID;
  channelId: UUID | null;
  conversationId: UUID | null;
  senderId: UUID;
  sender: { id: UUID; username: string; displayName: string | null; avatarUrl: string | null };
  content: string;                      // Decrypted plaintext (or "" if file-only)
  payload: MessagePayload;              // Parsed v1 payload (text or file)
  parentMessageId: UUID | null;         // Non-null if thread reply
  editedAt: ISOTimestamp | null;
  expiresAt: ISOTimestamp | null;
  insertedAt: ISOTimestamp;
  attachments: DecryptedAttachment[];   // Includes decryption key/iv for files
  reactions: DecryptedReaction[];       // Emoji plaintext, not ciphertext
  mentionedUserIds: UUID[];
  isMentioningMe: boolean;             // Pre-computed: does this mention the current user?
  isThreadReply: boolean;              // Pre-computed: parentMessageId !== null
}

interface DecryptedAttachment {
  id: UUID;
  filename: string;
  contentType: string;
  sizeBytes: number;
  key: string;                          // AES-256-GCM key (from decrypted payload)
  iv: string;                           // 12-byte IV
  download(): Promise<ArrayBuffer>;     // Fetches + decrypts the file in one call
}

interface DecryptedReaction {
  emoji: string;                        // Always plaintext after decryption
  senderIds: UUID[];                    // All users who reacted with this emoji
  count: number;
  includesMe: boolean;                  // Pre-computed
}
```

### Event Map

```typescript
interface VesperEvents {
  // --- Connection ---
  "connected": {};
  "disconnected": { reason?: string };
  "reconnecting": { attempt: number };
  "session:expired": {};

  // --- Messages (all decrypted) ---
  "message": { channelId: UUID; message: DecryptedMessage };
  "message:edited": { channelId: UUID; messageId: UUID; content: string; editedAt: ISOTimestamp };
  "message:deleted": { channelId: UUID; messageId: UUID };

  // --- Mentions ---
  "mention": { channelId: UUID; message: DecryptedMessage };

  // --- DMs ---
  "dm": { conversationId: UUID; message: DecryptedMessage };
  "dm:edited": { conversationId: UUID; messageId: UUID; content: string; editedAt: ISOTimestamp };
  "dm:deleted": { conversationId: UUID; messageId: UUID };
  "dm:mention": { conversationId: UUID; message: DecryptedMessage };
  "dm:new_conversation": { conversation: DmConversation };

  // --- Reactions ---
  "reaction:added": { channelId: UUID; messageId: UUID; emoji: string; userId: UUID };
  "reaction:removed": { channelId: UUID; messageId: UUID; emoji: string; userId: UUID };

  // --- Typing ---
  "typing:start": { channelId: UUID; userId: UUID; username: string };
  "typing:stop": { channelId: UUID; userId: UUID };

  // --- Threads ---
  "thread:reply": { channelId: UUID; parentMessageId: UUID; message: DecryptedMessage };

  // --- Pins ---
  "message:pinned": { channelId: UUID; messageId: UUID; pinnedBy: UUID };
  "message:unpinned": { channelId: UUID; messageId: UUID };

  // --- Presence ---
  "presence:update": { userId: UUID; status: "online" | "idle" | "dnd" | "offline" };
  "presence:bulk": { statuses: Record<UUID, "online" | "idle" | "dnd" | "offline"> };

  // --- Unread ---
  "unread:channel": { channelId: UUID; count: number };
  "unread:dm": { conversationId: UUID; count: number };

  // --- Disappearing ---
  "channel:ttl_changed": { channelId: UUID; ttl: number | null };
  "message:expired": { channelId: UUID; messageId: UUID };

  // --- Voice ---
  "voice:incoming_call": { conversationId: UUID; callerId: UUID };
  "voice:state_update": { participants: VoiceParticipant[] };
  "voice:call_rejected": { userId: UUID };
  "voice:call_timeout": {};

  // --- Server ---
  "emoji:created": { serverId: UUID; emoji: CustomEmoji };
  "emoji:deleted": { serverId: UUID; emojiId: UUID };

  // --- Devices ---
  "device:approval_requested": { device: Device };
  "device:updated": { device: Device };
}
```

### Event Hooks Pattern

Every event can be subscribed with `on`, `once`, or filtered with `onMessage`:

```typescript
// Basic subscription (returns unsubscribe function)
const unsub = client.on("message", ({ channelId, message }) => {
  console.log(`[${channelId}] ${message.sender.username}: ${message.content}`);
});

// One-shot
client.once("connected", () => console.log("Ready"));

// Filtered message handler — only fires for messages in specific channels
client.onMessage(channelId, (message) => {
  // Only messages in this channel
});

// Filtered mention handler — only fires when current user is mentioned
client.onMention((message) => {
  // message.isMentioningMe is always true here
  client.sendMessage(message.channelId, `Thanks for the mention, ${message.sender.username}!`);
});

// DM handler
client.onDm((message) => {
  client.sendDm(message.conversationId, `Echo: ${message.content}`);
});

// Unsubscribe
unsub();
```

---

## VesperClient API

### Constructor

```typescript
const client = new VesperClient({
  baseUrl: "https://vesper.example.com",
  device: {
    id: "stable-device-uuid",       // Persist this across sessions
    name: "My App",
    platform: "node",                // "node" | "browser" | "electron" | "ios" | "android"
  },
  cryptoStorage: new IndexedDBStorage(),  // or SqliteStorage, MemoryStorage
  autoReconnect: true,                    // default true
  heartbeatIntervalMs: 30_000,            // default 30s
});
```

### Auth

```typescript
// Register a new account (creates identity, uploads key packages, connects)
const { user, recoveryMnemonic } = await client.register("alice", "s3cret-passw0rd");
// MUST save recoveryMnemonic — it's the only way to recover the account on a new device

// Login (decrypts identity, connects, joins user channel)
const user = await client.login("alice", "s3cret-passw0rd");

// Login on a new device (device starts as "pending" — cannot send/receive yet)
const user = await client.login("alice", "s3cret-passw0rd");
// client.device.trustState === "pending"

// Approve the new device with recovery mnemonic
await client.approveWithRecovery("word1 word2 word3 ... word24");
// client.device.trustState === "trusted" — can now send/receive

// Logout (disconnects socket, clears tokens)
await client.logout();

// Check current state
client.user;                // User | null
client.device;              // Device | null
client.isReady;             // boolean — authenticated + trusted + crypto initialized
```

### Messaging

```typescript
// Send to a channel (encrypts automatically)
await client.sendMessage(channelId, "Hello world");

// Send with mentions (use <@userId> in text)
await client.sendMessage(channelId, "Hey <@user-uuid-here>, check this out");

// Reply to a thread
await client.sendMessage(channelId, "Thread reply", { parentMessageId: msgId });

// Edit a message (re-encrypts)
await client.editMessage(channelId, messageId, "Updated content");

// Delete a message
await client.deleteMessage(channelId, messageId);

// Send to a DM
await client.sendDm(conversationId, "Private message");

// Fetch message history (decrypted)
const messages = await client.getMessages(channelId, { limit: 50 });
const older = await client.getMessages(channelId, { limit: 50, before: messages[0].id });

// Fetch thread replies
const { parent, replies } = await client.getThread(messageId);
```

### Files

```typescript
// Send a file (encrypts file, uploads, sends message with metadata)
await client.sendFile(channelId, file, { caption: "Check this out" });

// Download + decrypt an attachment from a received message
const buffer = await message.attachments[0].download();
```

### Reactions

```typescript
await client.addReaction(channelId, messageId, "👍");
await client.removeReaction(channelId, messageId, "👍");
```

### Typing

```typescript
// Start typing (auto-stops after 2s of inactivity)
client.startTyping(channelId);
client.stopTyping(channelId);

// Listen for others typing
client.on("typing:start", ({ channelId, userId, username }) => {
  console.log(`${username} is typing in ${channelId}`);
});
```

### Pins

```typescript
await client.pinMessage(channelId, messageId);
await client.unpinMessage(channelId, messageId);
const pins = await client.getPins(channelId);
```

### Channels & Joining

```typescript
// Join a channel to receive real-time events
// This handles: Phoenix channel join + MLS group bootstrap + event wiring
await client.joinChannel(channelId);

// Leave a channel (stops events, leaves Phoenix channel)
client.leaveChannel(channelId);

// Join a DM conversation
await client.joinConversation(conversationId);
```

### Unreads

```typescript
// Get all unread counts
const unreads = await client.getUnreadCounts();
// unreads.channels: Record<UUID, number>
// unreads.conversations: Record<UUID, number>

// Mark as read
await client.markRead(channelId, lastMessageId);
await client.markDmRead(conversationId, lastMessageId);

// Listen for unread changes
client.on("unread:channel", ({ channelId, count }) => { ... });
client.on("unread:dm", ({ conversationId, count }) => { ... });
```

### Presence

```typescript
client.setStatus("online");  // "online" | "idle" | "dnd"

// SDK handles heartbeats automatically — goes idle after 5 min inactivity

client.on("presence:update", ({ userId, status }) => {
  console.log(`${userId} is now ${status}`);
});

// Join server presence to track all members
await client.joinServerPresence(serverId);
```

### Servers

```typescript
const { servers } = await client.servers.list();
const { server } = await client.servers.create("My Server");
const { server } = await client.servers.join("invite-code");
await client.servers.leave(serverId);

// Members
const { members } = await client.members.list(serverId);
await client.members.kick(serverId, userId);
await client.members.ban(serverId, userId, { reason: "spam" });

// Roles
const { roles } = await client.roles.list(serverId);
await client.roles.create(serverId, { name: "Moderator", permissions: Permissions.KICK_MEMBERS | Permissions.BAN_MEMBERS });

// Invites
const { invite } = await client.invites.create(serverId, { maxUses: 10 });
```

### Disappearing Messages

```typescript
// Set channel TTL (seconds, admin only)
await client.setDisappearingTtl(channelId, 3600);  // 1 hour
await client.setDisappearingTtl(channelId, null);   // disable

// Messages with expiresAt auto-fire "message:expired" and are removed from getMessages results
client.on("message:expired", ({ channelId, messageId }) => { ... });
```

### Voice

```typescript
// Join voice channel
const voice = await client.joinVoice(channelId);

// Start DM call
const voice = await client.startCall(conversationId);

voice.setMuted(true);
voice.participants;  // VoiceParticipant[]

// Listen for incoming calls
client.on("voice:incoming_call", ({ conversationId, callerId }) => {
  const voice = await client.answerCall(conversationId);
});

voice.disconnect();
```

### Device Management

```typescript
const { devices } = await client.auth.listDevices();
await client.auth.approveDevice(deviceId);
await client.auth.revokeDevice(deviceId);

client.on("device:approval_requested", ({ device }) => {
  // Another device is asking to be approved
  await client.auth.approveDevice(device.id);
});
```

### Layer 2 Escape Hatch

All resource APIs are public properties for direct access when needed:

```typescript
client.auth       // AuthApi
client.servers    // ServersApi
client.channels   // ChannelsApi
client.messages   // MessagesApi
client.conversations  // ConversationsApi
client.members    // MembersApi
client.roles      // RolesApi
client.invites    // InvitesApi
client.attachments    // AttachmentsApi
client.emojis     // EmojisApi
client.encryption // EncryptionApi
client.users      // UsersApi
client.voice      // VoiceApi
client.unread     // UnreadApi
client.searchIndex    // SearchIndexApi
```

---

## Quickstart: LLM / Agent Integration

The SDK is designed so an LLM agent can register, connect, and start interacting with minimal boilerplate. The entire auth + crypto + socket setup collapses into 3 lines.

### Minimal agent that echoes messages

```typescript
import { VesperClient } from "@vesper/sdk";
import { MemoryStorage } from "@vesper/sdk/crypto";

const client = new VesperClient({
  baseUrl: process.env.VESPER_URL,
  device: { id: "agent-001", name: "Echo Agent", platform: "node" },
  cryptoStorage: new MemoryStorage(),
});

// Register or login
if (process.env.VESPER_RECOVERY_KEY) {
  await client.login(process.env.VESPER_USER, process.env.VESPER_PASS);
  await client.approveWithRecovery(process.env.VESPER_RECOVERY_KEY);
} else {
  const { recoveryMnemonic } = await client.register(process.env.VESPER_USER, process.env.VESPER_PASS);
  console.log("VESPER_RECOVERY_KEY=" + recoveryMnemonic);  // Save this
}

// Join all channels on all servers
for (const server of (await client.servers.list()).servers) {
  for (const ch of server.channels.filter(c => c.type === "text")) {
    await client.joinChannel(ch.id);
  }
}

// Respond to messages
client.on("message", async ({ channelId, message }) => {
  if (message.senderId === client.user.id) return;  // Skip own messages
  await client.sendMessage(channelId, `Echo: ${message.content}`);
});

// Respond to mentions specifically
client.onMention(async (message) => {
  await client.sendMessage(message.channelId, `You called? ${message.sender.username}`);
});

// Respond to DMs
client.onDm(async (message) => {
  await client.sendDm(message.conversationId, `Got your DM: ${message.content}`);
});
```

### Agent that monitors a channel and summarizes

```typescript
const client = new VesperClient({
  baseUrl: process.env.VESPER_URL,
  device: { id: "summarizer-001", name: "Summarizer", platform: "node" },
  cryptoStorage: new MemoryStorage(),
});

await client.login(process.env.VESPER_USER, process.env.VESPER_PASS);
await client.joinChannel(targetChannelId);

// Collect recent messages
const history = await client.getMessages(targetChannelId, { limit: 100 });

// An agent can read .content directly — it's already decrypted plaintext
const transcript = history
  .map(m => `${m.sender.username}: ${m.content}`)
  .join("\n");

// Send summary back
await client.sendMessage(targetChannelId, `Summary of last 100 messages:\n${summary}`);
```

### Key DX decisions for agents

1. **`client.register()` does everything** — creates identity keys, encrypts them, generates recovery mnemonic, uploads key packages, connects socket, joins user channel. One call.
2. **`client.login()` does everything** — authenticates, decrypts identity, connects socket, replenishes key packages. One call.
3. **Messages arrive decrypted** — `message.content` is plaintext. No crypto API calls needed.
4. **`sendMessage()` encrypts automatically** — pass plaintext, SDK handles MLS.
5. **`isMentioningMe` is pre-computed** — no regex parsing needed.
6. **`onMention()` and `onDm()` are filtered shortcuts** — skip the event name, get relevant messages only.
7. **`MemoryStorage`** — agents that don't need persistence across restarts use in-memory crypto storage.
8. **Recovery key as env var** — agents store the mnemonic in env, use it to approve new devices automatically.
9. **No manual channel/socket management** — `joinChannel()` handles Phoenix channel join + MLS group bootstrap + event wiring in one call.
10. **Attachments have `.download()`** — one method call to fetch + decrypt a file.

---

## Usage Examples

### Register + send a message

```typescript
import { VesperClient } from "@vesper/sdk";

const client = new VesperClient({
  baseUrl: "https://vesper.example.com",
  device: { id: crypto.randomUUID(), name: "My App", platform: "node" },
});

const { user, recoveryMnemonic } = await client.register("alice", "hunter2");
console.log("Save this recovery key:", recoveryMnemonic);

const { server } = await client.servers.join("invite-code-here");
const textChannel = server.channels.find(c => c.type === "text");

await client.joinChannel(textChannel.id);
await client.sendMessage(textChannel.id, "Hello from the SDK!");

client.on("message", ({ channelId, message }) => {
  console.log(`${message.sender.username}: ${message.content}`);
});
```

### Build a moderation bot

```typescript
client.on("message", async ({ channelId, message }) => {
  // Check for banned words (content is already decrypted)
  if (containsBannedWord(message.content)) {
    await client.deleteMessage(channelId, message.id);
    await client.sendMessage(channelId,
      `Message from ${message.sender.username} removed for policy violation.`
    );
  }
});

// Track new members
client.on("voice:state_update", ({ participants }) => {
  console.log(`Voice channel has ${participants.length} participants`);
});

// Handle mentions as commands
client.onMention(async (message) => {
  const args = message.content.replace(/<@[^>]+>/g, "").trim().split(" ");
  const command = args[0];

  switch (command) {
    case "kick":
      const targetUsername = args[1];
      const member = members.find(m => m.user.username === targetUsername);
      if (member) await client.members.kick(serverId, member.user_id);
      break;
    case "pins":
      const pins = await client.getPins(message.channelId);
      const list = pins.map(p => `- ${p.content.slice(0, 50)}`).join("\n");
      await client.sendMessage(message.channelId, `Pinned messages:\n${list}`);
      break;
  }
});
```

### Reacting to messages

```typescript
// React to every message containing "hello"
client.on("message", async ({ channelId, message }) => {
  if (message.content.toLowerCase().includes("hello")) {
    await client.addReaction(channelId, message.id, "👋");
  }
});

// Track reactions
client.on("reaction:added", ({ channelId, messageId, emoji, userId }) => {
  console.log(`${userId} reacted with ${emoji} on ${messageId}`);
});
```

### File handling

```typescript
// Upload
const fileBuffer = fs.readFileSync("report.pdf");
const blob = new Blob([fileBuffer], { type: "application/pdf" });
await client.sendFile(channelId, blob, { caption: "Monthly report" });

// Download from a received message
client.on("message", async ({ channelId, message }) => {
  for (const attachment of message.attachments) {
    if (attachment.contentType.startsWith("image/")) {
      const decryptedData = await attachment.download();
      fs.writeFileSync(`./downloads/${attachment.filename}`, Buffer.from(decryptedData));
    }
  }
});
```

### Watching threads

```typescript
client.on("thread:reply", async ({ channelId, parentMessageId, message }) => {
  console.log(`New reply in thread ${parentMessageId}: ${message.content}`);
});

// Fetch full thread
const { parent, replies } = await client.getThread(parentMessageId);
```

### Layer 2 only (direct API calls, manual crypto)

```typescript
import { VesperHttp, AuthApi, ServersApi } from "@vesper/sdk/transport";

const http = new VesperHttp({ baseUrl: "https://vesper.example.com" });
const auth = new AuthApi(http);
const servers = new ServersApi(http);

const session = await auth.login({
  username: "alice",
  password: "hunter2",
  device: { id: "device-uuid", name: "CLI", platform: "node" },
});
http.setTokens({ accessToken: session.access_token, refreshToken: session.refresh_token });

const { servers: myServers } = await servers.list();
```

---

## Message Processing Pipeline

What happens internally when a message arrives (SDK handles all of this automatically):

1. **Receive** — WebSocket event arrives
2. **Decrypt** — SDK decrypts the message content (checks cache first, falls back to live decryption)
3. **Parse** — Content extracted as plaintext string
4. **Enrich** — `isMentioningMe` computed, reactions grouped with `includesMe`, attachments get `.download()` method
5. **Cache** — Decrypted content cached for fast re-access
6. **Emit** — `"message"` event fires with `DecryptedMessage`. Also fires `"mention"` if applicable, `"thread:reply"` if it's a reply, `"dm"` for DMs.
7. **Unread** — If not the active channel, increments unread count

If decryption temporarily fails (rare, happens during group membership changes), the message arrives with `syncing: true`. The SDK retries automatically and updates the message when decryption succeeds. No consumer action needed.

---

## Error Handling

```typescript
class VesperApiError extends Error {
  status: number;                        // HTTP status code
  errors?: Record<string, string[]>;     // Validation errors (422)
  path?: string;                         // Endpoint path
}

class VesperSocketError extends Error {
  topic: string;                         // Channel topic
  reason?: unknown;                      // Join failure reason
}

class VesperCryptoError extends Error {
  groupId?: string;                      // MLS group that failed
  cause?: Error;                         // Underlying error
}
```

Crypto errors are non-fatal. The client automatically attempts recovery (resync request, group recreation) before surfacing errors to the consumer.

---

## Distribution

- **Package:** `@vesper/sdk` on npm
- **Subpath exports:** `@vesper/sdk`, `@vesper/sdk/transport`, `@vesper/sdk/api`, `@vesper/sdk/types`, `@vesper/sdk/crypto`
- **Output:** Dual ESM/CJS via tsup
- **TypeScript:** 5.5+, ES2022 target
- **Dependencies:** `phoenix` ^1.8.4, `ts-mls` ^1.6.1, `hash-wasm` ^4.12.0
- **Runtimes:** Node 20+, modern browsers, Electron, React Native (with WebCrypto polyfill)

## Implementation Phases

1. **Foundation** — Types, `VesperHttp`, `VesperSocket`, error classes, event emitter
2. **Resource APIs** — All 14 API classes wrapping REST endpoints
3. **Crypto** — Port MLS from `client/src/renderer/src/crypto/mls.ts`, `CryptoProvider`, storage adapters
4. **Managed Client** — `VesperClient` with transparent E2EE, group lifecycle, presence
5. **Voice** — `VoiceSession` with WebRTC + E2EE key derivation
6. **Docs** — TypeDoc API reference, guides, example projects
