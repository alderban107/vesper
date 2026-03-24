# Vesper API Reference

All endpoints under `/api/v1` unless noted. Responses are JSON. Binary fields are base64-encoded. IDs are UUIDs.

See also: [Configuration Guide](./configuration-guide.md) | [Deployment Guide](./deployment-guide.md) | [Testing Guide](./testing-guide.md)

---

## Auth Pipelines and Rate Limits

| Pipeline | Description |
|----------|-------------|
| (none) | Public, no token needed |
| `authenticated` | `Authorization: Bearer <access_token>` required |
| `trusted_device` | Authenticated + device `trust_state = "trusted"` |

| Action | Limit | Window | Key |
|--------|-------|--------|-----|
| `login` | 5 | 60 s | IP + username |
| `register` | 3 | 60 s | IP |
| `recover` | 3 | 600 s | IP |
| `refresh` | 30 | 60 s | IP |

Rate-limited responses: `429` with `Retry-After` header and `{"error": "rate limit exceeded", "retry_after": <seconds>}`.

---

## Health Check

`GET /health` -- no auth. Returns `200` when healthy, `503` otherwise.

```json
{ "status": "ok", "migrations": "ok", "database": "ok" }
```

---

## Auth Endpoints

### POST /api/v1/auth/register

Rate-limited, no auth. Body: `username`, `password`, `device_id` (min 8 chars), `device_name` (required). Optional crypto fields: `encrypted_key_bundle`, `key_bundle_salt`, `key_bundle_nonce`, `public_identity_key`, `public_key_exchange`, `encrypted_recovery_bundle` (all base64). Optional: `device_platform`.

Returns `201` with session: `{ user, access_token, refresh_token, expires_in, current_device }` plus crypto bundle fields if provided. The registering device is automatically trusted.

### POST /api/v1/auth/login

Rate-limited, no auth. Same body fields as register (minus crypto). Returns `200` with session. New devices start `trust_state: "pending"`.

### POST /api/v1/auth/refresh

Rate-limited, no auth. Body: `{ "refresh_token": "..." }`. Returns new `access_token`, `refresh_token`, `expires_in`, `current_device`.

### POST /api/v1/auth/logout

Rate-limited, no auth. Body: `{ "refresh_token": "..." }` (optional). Returns `{ "ok": true }`.

### POST /api/v1/auth/recover

Rate-limited, no auth. Body: `{ "recovery_key_hash": "..." }`. Returns `{ user_id, encrypted_recovery_bundle }`.

### POST /api/v1/auth/recover/reset

Rate-limited, no auth. Body: `recovery_key_hash`, `new_password`, `device_id`, `device_name`, plus crypto fields. Returns session (same as register).

### GET /api/v1/auth/me

Authenticated. Returns `{ user, current_device }` plus crypto bundle if device is trusted.

### PUT /api/v1/auth/profile

Authenticated. Body (all optional): `display_name`, `avatar_url`, `banner_url`, `status`.

### PUT /api/v1/auth/password

Authenticated. Body: `old_password`, `new_password`, optional crypto fields.

### POST /api/v1/auth/avatar | POST /api/v1/auth/banner

Authenticated. Multipart upload, field: `file`.

### GET /api/v1/avatars/:user_id | GET /api/v1/banners/:user_id

Public, no auth. Returns image file.

### GET /api/v1/auth/devices

Authenticated. Returns `{ devices: [...], current_device }`.

### PUT /api/v1/auth/devices/current/notifications

Authenticated. Body (all optional): `push_token`, `push_platform`, `notification_public_key` (base64), `background_sync_capable`.

### POST /api/v1/auth/devices/:id/approve

Trusted device required. Approves a pending device.

### POST /api/v1/auth/devices/:id/revoke

Trusted device required. Revokes a device (cannot revoke current device).

### POST /api/v1/auth/devices/approve-with-recovery

Authenticated. Body: `{ "recovery_key_hash": "..." }`. Promotes current device to trusted, returns new session.

---

## Server Endpoints

All authenticated.

```
GET    /api/v1/servers                                    # list user's servers
POST   /api/v1/servers                                    # create: { "name": "..." }
GET    /api/v1/servers/:id                                # show (must be member)
PUT    /api/v1/servers/:id                                # update (owner only)
DELETE /api/v1/servers/:id                                # delete (owner only)
POST   /api/v1/servers/:server_id/icon                    # upload icon (multipart, max 5MB)
POST   /api/v1/servers/join                               # join: { "invite_code": "..." }
DELETE /api/v1/servers/:server_id/leave                   # leave server
GET    /api/v1/servers/:server_id/invite-code             # get invite code (permission-gated)
```

Public (no auth):
```
GET /api/v1/servers/:server_id/icon
GET /api/v1/servers/:server_id/emojis/:emoji_id/file
```

### Invites
```
GET    /api/v1/servers/:server_id/invites
POST   /api/v1/servers/:server_id/invites
DELETE /api/v1/servers/:server_id/invites/:invite_id
```

### Members and Bans
```
GET    /api/v1/servers/:server_id/members
DELETE /api/v1/servers/:server_id/members/:user_id          # kick
POST   /api/v1/servers/:server_id/members/:user_id/ban
DELETE /api/v1/servers/:server_id/members/:user_id/ban      # unban
GET    /api/v1/servers/:server_id/bans
GET    /api/v1/servers/:server_id/audit-logs
```

### Roles
```
GET    /api/v1/servers/:server_id/roles
POST   /api/v1/servers/:server_id/roles
PUT    /api/v1/servers/:server_id/roles/:role_id
DELETE /api/v1/servers/:server_id/roles/:role_id
PUT    /api/v1/servers/:server_id/members/:user_id/roles    # assign roles to member
```

### Emojis
```
GET    /api/v1/servers/:server_id/emojis
POST   /api/v1/servers/:server_id/emojis                    # multipart upload
PATCH  /api/v1/servers/:server_id/emojis/:emoji_id
DELETE /api/v1/servers/:server_id/emojis/:emoji_id
```

---

## Channel Endpoints

Authenticated. Nested under servers. Types: `"text"`, `"voice"`.

```
GET    /api/v1/servers/:server_id/channels
POST   /api/v1/servers/:server_id/channels
GET    /api/v1/servers/:server_id/channels/:id
PUT    /api/v1/servers/:server_id/channels/:id
DELETE /api/v1/servers/:server_id/channels/:id
```

---

## Message Endpoints

All authenticated.

```
GET /api/v1/channels/:id/messages     # list (params: before, after, after_seq, limit[max 100], lean)
GET /api/v1/channels/:id/pins         # list pinned messages
PUT /api/v1/channels/:id/read         # mark read: { "message_id": "..." }
GET /api/v1/messages?ids[]=...        # batch fetch (max 100 IDs)
GET /api/v1/messages/:id              # single message
GET /api/v1/messages/:id/thread       # thread replies
```

---

## DM Conversation Endpoints

All authenticated.

```
POST /api/v1/conversations                               # create: { "participant_ids": [...], "name": "optional" }
GET  /api/v1/conversations                               # list with last message
GET  /api/v1/conversations/:id                           # show
GET  /api/v1/conversations/:conversation_id/messages     # list (same params as channel messages)
PUT  /api/v1/conversations/:conversation_id/read         # mark read: { "message_id": "..." }
```

---

## Attachment Endpoints

All authenticated.

**POST /api/v1/attachments** -- multipart. Fields: `file` (required), `encrypted` (`"true"`/`"false"`), `message_id` (optional). Max 50 MB. Files expire after `FILE_EXPIRY_DAYS` (default 30). Returns `201` with `{ attachment: { id, filename, content_type, size_bytes, encrypted, expires_at } }`.

**GET /api/v1/attachments/:id** -- downloads file. Access authorized by message scope (server member or DM participant).

---

## Sync Endpoints

All authenticated.

**GET /api/v1/sync** -- full or delta sync. Param: `since` (opaque cursor, omit for full). Returns `{ token, full, servers, conversations, conversation_resets, channel_activity, unread_counts }`.

**GET /api/v1/sync/urgent** -- mentions/replies/DM notifications. Params: `since`, `limit` (max 100). Returns `{ token, events: [{ id, scope_kind, scope_id, event_type, payload, inserted_at }] }`.

**POST /api/v1/sync/scopes** -- per-scope sync. Body: `{ since, limit, scopes: [{ kind, id, after_seq?, after? }] }`. Returns messages and events per scope.

**GET /api/v1/unread** -- unread counts for all channels and conversations.

---

## Other Endpoints

**GET /api/v1/users/search?q=...** -- authenticated. User search.

**GET /api/v1/voice/config** -- authenticated. Returns `{ ice_servers, ice_transport_policy }`.

---

## MLS Encryption Endpoints

All require `trusted_device` pipeline.

### Key Packages
```
POST   /api/v1/key-packages                     # bulk upload: { "key_packages": ["<b64>", ...] }
GET    /api/v1/key-packages/me/count             # count for current device
POST   /api/v1/key-packages/me/consume           # mark consumed: { "key_package": "<b64>" }
DELETE /api/v1/key-packages/me                   # purge all for current device
GET    /api/v1/key-packages/:user_id             # fetch & consume one (param: device_id)
```

### Welcomes, Events, Resync
```
GET    /api/v1/pending-welcomes/:channel_id
DELETE /api/v1/pending-welcomes/:id
GET    /api/v1/mls-events/:channel_id            # durable event replay
GET    /api/v1/pending-resync-requests/:channel_id
DELETE /api/v1/pending-resync-requests/:id
```

### Group Info (External Commit, RFC 9420)
```
GET /api/v1/group-info/:scope_id
PUT /api/v1/group-info/:scope_id
```

`scope_id`: channel UUID, conversation UUID, or `voice:channel:<id>` / `voice:dm:<id>`.

PUT body: `group_info_data` (b64, required), `ratchet_tree_data` (b64), `epoch` (int, required), `previous_epoch`, `commit_data`, `commit_id`.

### Sponsored Transition
```
POST /api/v1/mls-sponsored-transition/:scope_id
```

Atomic MLS transition: commit + optional remove + optional welcome + group info. Body: `group_info_data`, `ratchet_tree_data`, `epoch`, `previous_epoch`, `recipient_id`, `commit_data`, `commit_id`, optionally `remove_commit_data`, `welcome_data`, `recipient_device_id`, `recipient_key_package_ref`.

### History Recovery
```
GET    /api/v1/pending-history-requests/:channel_id
DELETE /api/v1/pending-history-requests/:id
GET    /api/v1/pending-history-bundles/:channel_id
DELETE /api/v1/pending-history-bundles/:id
```

### Encrypted Search Index
```
GET    /api/v1/search-index
PUT    /api/v1/search-index
DELETE /api/v1/search-index
```

---

## WebSocket Connection

```
wss://<host>/socket/websocket?token=<access_token>
```

JWT verified on connect. Socket assigns: `user_id`, `device_id`, `device_client_id`, `device_trust_state`, `username`, `display_name`. Revoked devices rejected. Socket ID: `user_socket:<user_id>:<device_id>`.

---

## WebSocket Channels

### ChatChannel -- `chat:channel:<channel_id>`

Join: server member with view permission. On join, replays recent `mls_request_join_all` from other users.

**Client events:**

| Event | Payload | Reply |
|-------|---------|-------|
| `new_message` | `ciphertext`, `mls_epoch`, `client_nonce?`, `parent_message_id?`, `mentioned_user_ids?`, `attachment_ids?` | `:ok` |
| `edit_message` | `message_id`, `ciphertext`, `mls_epoch` | `:ok` |
| `delete_message` | `message_id` | `:ok` |
| `add_reaction` | `message_id` + (`ciphertext`, `mls_epoch`) or (`emoji`) | `:ok` |
| `remove_reaction` | `message_id` + (`ciphertext`, `mls_epoch`) or (`emoji`) | `:ok` |
| `pin_message` | `message_id` | `:ok` (manage_messages perm) |
| `unpin_message` | `message_id` | `:ok` (manage_messages perm) |
| `set_disappearing` | `ttl` (seconds or null) | `:ok` (manage_channels perm) |
| `typing_start` / `typing_stop` | `{}` | none |
| `mls_request_join` | `device_id?` | `:ok` |
| `mls_request_join_all` | `{}` | `{:ok, %{seq}}` |
| `mls_commit` | `commit_data`, `idempotency_key?` | `{:ok, %{seq}}` |
| `mls_remove` | `removed_user_id`, `commit_data`, `removed_device_id?`, `eviction_id?` | `{:ok, %{seq}}` |
| `mls_welcome` | `recipient_id`, `welcome_data`, `recipient_device_id?`, `key_package_ref?` | `{:ok, %{id}}` |
| `mls_resync_request` | `request_id`, `last_known_epoch?`, `reason?`, `device_id?` | none |
| `mls_eviction_claim` | `id` | `:ok` (trusted only) |
| `mls_eviction_skip` | `id`, `target_user_id`, `target_device_id?`, `reason?` | `:ok` (trusted only) |
| `mls_history_request` | `device_id?` | none |
| `mls_history_bundle` | `ciphertext`, `mls_epoch`, `recipient_id`, `recipient_device_id?` | `:ok` |

**Broadcast events:** `new_message`, `message_edited`, `message_deleted`, `reaction_update`, `message_pinned`, `message_unpinned`, `disappearing_ttl_updated`, `typing_start`, `typing_stop`, all `mls_*` events.

### DmChannel -- `dm:<conversation_id>`

Join: conversation participant. Same events as ChatChannel minus pin/unpin. `set_disappearing` requires no permissions. Extra event: `call_reject`. DM messages push `dm_message` and `dm_unread_update` to each participant's UserChannel.

### VoiceChannel -- `voice:channel:<id>` or `voice:dm:<id>`

Join: server member (channel) or DM participant. Param `transport`: `"webrtc"` (default) or `"websocket"`.

**Client events:** `answer` (`sdp`), `ice_candidate` (`candidate`), `mute` (`muted`), `media_state` (`slot`, `active`), `voice_key` (opaque), `call_ring` (DM only), `call_accept`, `call_reject`, `media_frame` (`slot`, `data`, `seq?`), plus `mls_request_join`, `mls_request_join_all`, `mls_commit`, `mls_remove`, `mls_welcome`, `mls_resync_request`.

**Server events:** `offer` (SDP + track_map + publish_map + e2ee_creator_id), `joined` (websocket), `ice_candidate`, `voice_state_update` (participants list), `voice_key`, `media_frame`, `call_timeout`, `error`.

### UserChannel -- `user:<user_id>`

Join: own channel only. Heartbeat-based presence (5 min idle timeout).

**Client events:** `heartbeat` (resets idle timer), `set_status` (`"online"`, `"idle"`, `"dnd"`).

**Server events:** `presence_state`, `unread_update`, `dm_unread_update`, `dm_message`, `mention`, `new_conversation`, `device_approval_requested`, `device_updated`, `dm_typing_start`, `dm_typing_stop`, `mls_history_request_pending`, `mls_history_bundle_pending`, `disconnect`.

### ServerPresenceChannel -- `presence:server:<server_id>`

Join: server member. Tracks member presence. Server events: `presence_state`, `presence_diff`, `scope_mutation` (`kind`, `scope_id`).

### ScopeChannel -- `scope:dm:<conversation_id>`

Join: DM participant. Receives `scope_mutation` events for real-time DM updates.
