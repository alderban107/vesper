# Events

The SDK uses Phoenix WebSocket channels for real-time communication. The `VesperClient` wraps these into a typed event system.

## Client Events

Subscribe to events on the client:

```typescript
// Subscribe to a specific event
const unsub = client.on('ready', (state) => {
  console.log('Client ready, user:', state.user.username)
})

// Unsubscribe
unsub()

// Subscribe to all state changes
const unsub = client.subscribe((state) => {
  console.log('State updated:', state.status)
})
```

### Event Types

```typescript
interface VesperClientEvents {
  // Lifecycle
  state: VesperClientState              // Any state change
  ready: VesperClientState              // Client initialized and synced
  connected: VesperClientState          // Socket connected
  disconnected: VesperClientState       // After client.stop()

  // Connection health
  'connection.lost': VesperClientState  // Socket dropped
  'connection.error': Error             // Socket error

  // Data updates
  'workspace.updated': VesperClientState
  'servers.updated': VesperServer[]
  'conversations.updated': VesperConversation[]
  'devices.updated': VesperClientDeviceEvent

  // Messaging
  'scope.event': VesperClientScopeEvent // Channel/DM messages and events

  // Debug
  raw: VesperClientRawEvent            // Raw Phoenix socket events
  error: Error                         // Unhandled errors
}
```

## Scope Events

Scope events are messages and notifications from channels and DMs you're watching.

```typescript
client.on('scope.event', (event) => {
  console.log(event.type, event.scopeId, event.payload)
})
```

### Watching Scopes

You must watch a scope to receive its events:

```typescript
// Watch a channel
client.watchChannelScope(channelId)

// Watch a DM conversation
client.watchConversationScope(conversationId)
```

Watching joins the Phoenix channel topic (e.g., `chat:channel:{id}`) and begins relaying events.

### Scope Event Types

Events received through `scope.event`:

| Event | Description |
|-------|-------------|
| `new_message` | A new message was sent |
| `message_edited` | A message was edited |
| `message_deleted` | A message was deleted |
| `typing_start` | A user started typing |
| `typing_stop` | A user stopped typing |
| `reaction_update` | A reaction was added or removed |
| `message_pinned` | A message was pinned |
| `message_unpinned` | A message was unpinned |
| `mention` | Current user was mentioned |
| `dm_message` | New DM message |
| `dm_typing_start` | Typing in a DM |
| `dm_typing_stop` | Stopped typing in a DM |

### MLS Events (handled internally)

These events are processed by the SDK's encryption layer. You generally don't need to handle them directly, but they appear on the `raw` event:

| Event | Description |
|-------|-------------|
| `mls_commit` | MLS group membership change |
| `mls_welcome` | Invitation to join an MLS group |
| `mls_remove` | Removed from an MLS group |
| `mls_request_join` | Someone wants to join the group |
| `mls_request_join_all` | Bulk join request |
| `mls_resync_request` | Request to resync group state |
| `mls_history_request` | Request for message history |
| `mls_history_bundle` | History bundle delivery |

### Server Events

| Event | Description |
|-------|-------------|
| `channel_created` | New channel in a server |
| `channel_updated` | Channel settings changed |
| `channel_deleted` | Channel removed |
| `server_membership_revoked` | Kicked from a server |
| `emoji_created` | Custom emoji added |
| `emoji_deleted` | Custom emoji removed |

### Presence Events

| Event | Description |
|-------|-------------|
| `presence_state` | Full presence snapshot for a scope |
| `presence_diff` | Incremental presence update (joins/leaves) |

### Device Events

```typescript
client.on('devices.updated', (event) => {
  // event contains the updated device list
  for (const device of event.devices) {
    console.log(device.name, device.trust_state)
  }
})
```

| Event | Description |
|-------|-------------|
| `device_approval_requested` | A new device wants to be trusted |
| `device_updated` | A device's trust state changed |

### Unread Updates

| Event | Description |
|-------|-------------|
| `unread_update` | Channel unread count changed |
| `dm_unread_update` | DM unread count changed |
| `scope_summary_updated` | Scope summary data refreshed |

## Socket Lifecycle

The socket connects automatically when you call `client.start()` and disconnects on `client.stop()`.

```typescript
client.on('connected', () => {
  console.log('Socket connected')
})

client.on('connection.lost', () => {
  console.log('Socket disconnected, will reconnect...')
})

client.on('connection.error', (err) => {
  console.error('Socket error:', err)
})
```

The Phoenix client handles automatic reconnection with exponential backoff.

### Heartbeat

The client sends periodic heartbeats to keep the connection alive. Configure the interval:

```typescript
const client = createVesperClient({
  heartbeatIntervalMs: 30_000, // default
})
```

## Raw Events

For debugging or custom handling, subscribe to raw socket events:

```typescript
client.on('raw', (event) => {
  console.log('Raw event:', event.topic, event.event, event.payload)
})
```

## Manual Sync

Force a workspace sync at any time:

```typescript
const state = await client.syncNow()
// state contains refreshed servers, conversations, unread counts
```

The client also syncs automatically on reconnection.
