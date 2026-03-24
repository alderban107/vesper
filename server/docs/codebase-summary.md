# Vesper -- Codebase Summary

This document provides a file-level inventory of the Vesper monorepo, covering
the server, client, SDK, documentation, and supporting infrastructure.

For architecture diagrams, see [system-architecture.md](./system-architecture.md).
For product context, see [project-overview-pdr.md](./project-overview-pdr.md).

## Repository Structure

```
vesper/
  client/           Electron + React desktop app and web client
  config/           Elixir environment configs (config.exs, dev.exs, prod.exs, runtime.exs, test.exs)
  doc/              Design documents, protocol spec, E2EE docs
  docker-compose.yml  Production deployment (app, db, web, coturn)
  landing/          Landing page / marketing site
  scripts/          Git hooks, environment loaders, pre-commit checks
  sdk/              @vesper/sdk -- TypeScript SDK for building clients
  server/           Elixir/Phoenix API backend
  turnserver.conf   coturn configuration
  README.md
  CONTRIBUTING.md
  LICENSE           AGPL-3.0-only
```

## Metrics

| Component | Source Files | Lines of Code (approx) |
|-----------|-------------|----------------------|
| Server (Elixir) | 113 `.ex` files | ~18,500 |
| Server tests | 14 `.exs` files | ~2,900 |
| Server migrations | 60 `.exs` files | -- |
| Client (TypeScript/React) | 104 `.ts`/`.tsx` files | ~31,700 |
| SDK (TypeScript) | 43 `.ts` files | ~21,300 |

---

## Server (`server/`)

### Top-Level Layout

```
server/
  config/           Environment configs (config.exs, dev.exs, prod.exs, runtime.exs, test.exs)
  lib/
    vesper/          Business logic contexts
    vesper_web/      Phoenix web layer (channels, controllers, plugs, router)
  mix.exs            Project definition and dependencies
  priv/
    repo/
      migrations/    60 Ecto migrations
      seeds.exs      Seed data
  test/
    support/         Test helpers (DataCase, ConnCase, ChannelCase, Factory)
    vesper/          Context-level tests
    vesper_web/      Web-layer tests (channels, plugs)
  Dockerfile         Production Docker build
```

### Contexts (`lib/vesper/`)

Each context is a boundary module with internal schemas.

| Context | Boundary Module | Purpose |
|---------|----------------|---------|
| **Accounts** | `Vesper.Accounts` | User registration, authentication, devices, search index snapshots |
| **Chat** | `Vesper.Chat` | Messages, DM conversations, participants, reactions, attachments, pinned messages, read positions |
| **Servers** | `Vesper.Servers` | Server CRUD, channels, memberships, roles, permissions, invites, bans, audit logs, emojis |
| **Encryption** | `Vesper.Encryption` | MLS key packages, pending welcomes, MLS events, group info, resync requests, history bundles/requests, crypto evictions |
| **Runtime** | `Vesper.Runtime` | Room abstraction (unifies channels and DMs), room events, room relations, ETS room cache |
| **Sync** | `Vesper.Sync` | ScopeSyncEvent (shared log), UserSyncEvent (per-user), cursor-based delta polling |
| **Voice** | `Vesper.Voice` | Voice room lifecycle, join/leave, SDP/ICE, media relay, call ring/accept/reject |

### Accounts Context

| File | Description |
|------|-------------|
| `accounts.ex` | Boundary: user CRUD, auth, tokens, device management |
| `accounts/user.ex` | User schema (username, password_hash, display_name, avatar_url, banner_url, status, crypto fields) |
| `accounts/device.ex` | Device schema (client_id, trust_level, notification prefs) |
| `accounts/token.ex` | JWT access token generation via Joken |
| `accounts/user_token.ex` | Refresh token schema (DB-backed, rotatable) |
| `accounts/search_index_snapshot.ex` | Encrypted search index blob per user |

### Chat Context

| File | Description |
|------|-------------|
| `chat.ex` | Boundary: message CRUD, conversations, reactions, read positions |
| `chat/message.ex` | Message schema (ciphertext, mls_epoch, sender, channel/conversation, expires_at) |
| `chat/attachment.ex` | File attachment schema (storage_key, content_type, size, uploader_id) |
| `chat/dm_conversation.ex` | DM conversation schema (type: direct or group) |
| `chat/dm_participant.ex` | Join table: user <-> conversation |
| `chat/reaction.ex` | Emoji reaction schema |
| `chat/channel_read_position.ex` | Per-user read cursor for channels |
| `chat/dm_read_position.ex` | Per-user read cursor for DMs |
| `chat/pinned_message.ex` | Pinned message reference |
| `chat/file_storage.ex` | Local filesystem storage adapter |
| `chat/file_storage/` | Storage implementation directory |

### Servers Context

| File | Description |
|------|-------------|
| `servers.ex` | Boundary: server/channel CRUD, membership, roles, permissions, invites |
| `servers/server.ex` | Server schema (name, owner, icon, invite_code) |
| `servers/channel.ex` | Channel schema (name, type, position, disappearing_ttl) |
| `servers/membership.ex` | User-server membership join table |
| `servers/role.ex` | Role schema (name, color, position, permissions bitfield) |
| `servers/member_role.ex` | User-role assignment join table |
| `servers/permissions.ex` | Bitfield constants and helpers (11 permission bits) |
| `servers/permissions_cache.ex` | ETS-backed permissions cache with PubSub invalidation |
| `servers/member_cache.ex` | ETS-backed member ID cache with PubSub invalidation |
| `servers/invite.ex` | Invite link schema |
| `servers/emoji.ex` | Custom emoji schema (name, image data, creator) |
| `servers/channel_role_permission.ex` | Per-channel role permission overrides |
| `servers/channel_user_permission.ex` | Per-channel user permission overrides |
| `servers/server_ban.ex` | Server ban records |
| `servers/audit_log.ex` | Audit log entries |

### Encryption Context

| File | Description |
|------|-------------|
| `encryption.ex` | Boundary: key package directory, welcome storage, MLS event log, group info |
| `encryption/key_package.ex` | MLS key package schema (user_id, client_id, consumed flag) |
| `encryption/pending_welcome.ex` | MLS Welcome message waiting for recipient |
| `encryption/mls_event.ex` | Durable MLS control-plane event (commits, proposals) |
| `encryption/mls_group_info.ex` | Latest GroupInfo per scope for External Commits |
| `encryption/pending_resync_request.ex` | Request from device to rejoin MLS group |
| `encryption/pending_history_bundle.ex` | Encrypted history bundle for same-user recovery |
| `encryption/pending_history_request.ex` | History recovery request |
| `encryption/pending_crypto_eviction.ex` | Pending crypto eviction marker |

### Runtime Context

| File | Description |
|------|-------------|
| `runtime.ex` | Boundary: room CRUD, ETS room cache, room-event append, sequence management |
| `runtime/room.ex` | Room schema (kind, current_seq, last_message tracking) |
| `runtime/room_event.ex` | Room event schema (event_type, ciphertext, mls_epoch, room_seq) |
| `runtime/room_relation.ex` | Room relationship schema |
| `runtime/room_state_event.ex` | Room state event schema |

### Sync

| File | Description |
|------|-------------|
| `sync.ex` | Boundary: append scope/user events, cursor-based polling queries |
| `scope_sync_event.ex` | Shared scope event schema (event_type, scope_kind, scope_id, payload) |
| `user_sync_event.ex` | Per-user event schema |
| `sync_cursor.ex` | Cursor tracking for delta sync |

### Voice Context

| File | Description |
|------|-------------|
| `voice.ex` | Boundary: room lifecycle, join/leave, SDP/ICE, media relay |
| `voice/room.ex` | GenServer: per-room state, peer connections, call state machine |
| `voice/room_router.ex` | GenServer: data-plane RTP packet forwarding (separated from control) |
| `voice/room_supervisor.ex` | DynamicSupervisor for voice rooms (max 500) |

### Workers (`lib/vesper/workers/`)

| File | Description |
|------|-------------|
| `expire_messages.ex` | Oban cron: deletes messages past their `expires_at` |
| `expire_attachment_blobs.ex` | Oban cron: removes expired file attachments from disk |
| `purge_key_packages.ex` | Oban cron: cleans consumed/old key packages |
| `purge_welcomes.ex` | Oban cron: removes stale pending welcomes |
| `purge_expired_tokens.ex` | Oban cron: cleans expired refresh tokens |
| `process_pending_crypto_evictions.ex` | Oban: processes pending crypto eviction markers |

### Web Layer (`lib/vesper_web/`)

#### Channels

| File | Topic Pattern | Purpose |
|------|--------------|---------|
| `chat_channel.ex` | `chat:channel:<id>` | Text message send/receive, MLS events, typing, reactions, pins |
| `dm_channel.ex` | `dm:<id>` | DM message send/receive, MLS events, typing, reactions |
| `voice_channel.ex` | `voice:channel:<id>`, `voice:dm:<id>` | WebRTC signaling (SDP, ICE), media frames, mute state |
| `user_channel.ex` | `user:<id>` | Per-user notifications, presence tracking, heartbeat |
| `server_presence_channel.ex` | `presence:server:<id>` | Server-wide online/idle presence |
| `scope_channel.ex` | `scope:dm:<id>` | Lightweight scope subscription for DM sync |
| `user_socket.ex` | -- | Socket authentication (JWT verification) |
| `presence.ex` | -- | Phoenix.Presence configuration |
| `channel_helpers.ex` | -- | Shared helper functions for channels |

#### Controllers

| File | Route Prefix | Purpose |
|------|-------------|---------|
| `auth_controller.ex` | `/api/v1/auth` | Register, login, refresh, logout, profile, devices |
| `server_controller.ex` | `/api/v1/servers` | Server CRUD, members, roles, bans, invites, audit logs |
| `channel_controller.ex` | `/api/v1/servers/:id/channels` | Channel CRUD |
| `message_controller.ex` | `/api/v1/channels/:id/messages` | Message listing, batch, threads, pins |
| `conversation_controller.ex` | `/api/v1/conversations` | DM conversation CRUD and messages |
| `attachment_controller.ex` | `/api/v1/attachments` | File upload and download |
| `avatar_controller.ex` | `/api/v1/avatars` | User avatar and banner upload |
| `emoji_controller.ex` | `/api/v1/servers/:id/emojis` | Custom emoji CRUD |
| `key_package_controller.ex` | `/api/v1/key-packages` | MLS key package upload, consume, count |
| `pending_welcome_controller.ex` | `/api/v1/pending-welcomes` | Fetch and delete pending MLS welcomes |
| `mls_event_controller.ex` | `/api/v1/mls-events` | Replay MLS control-plane events |
| `group_info_controller.ex` | `/api/v1/group-info` | GroupInfo for External Commits |
| `sponsored_transition_controller.ex` | `/api/v1/mls-sponsored-transition` | MLS sponsored transitions |
| `pending_resync_request_controller.ex` | `/api/v1/pending-resync-requests` | MLS resync requests |
| `pending_history_request_controller.ex` | `/api/v1/pending-history-requests` | History recovery requests |
| `pending_history_bundle_controller.ex` | `/api/v1/pending-history-bundles` | History recovery bundles |
| `sync_controller.ex` | `/api/v1/sync` | Cursor-based delta sync |
| `urgent_sync_controller.ex` | `/api/v1/sync/urgent` | Urgent sync events |
| `scope_sync_controller.ex` | `/api/v1/sync/scopes` | Scope-level sync |
| `unread_controller.ex` | `/api/v1/unread` | Unread count aggregation |
| `search_index_controller.ex` | `/api/v1/search-index` | Encrypted search index CRUD |
| `voice_controller.ex` | `/api/v1/voice/config` | WebRTC/TURN configuration |
| `user_controller.ex` | `/api/v1/users` | User search |
| `health_controller.ex` | `/health` | Health check endpoint |

#### Plugs

| File | Purpose |
|------|---------|
| `plugs/auth.ex` | JWT Bearer token verification |
| `plugs/rate_limit.ex` | Hammer-based rate limiting (per action) |
| `plugs/require_trusted_device.ex` | Device trust level gate |

#### Other Web Modules

| File | Purpose |
|------|---------|
| `router.ex` | Route definitions with pipeline composition |
| `endpoint.ex` | Phoenix endpoint configuration |
| `scope_summary.ex` | Helper for broadcasting scope update payloads |
| `telemetry.ex` | Telemetry event definitions and metrics |

### Other Top-Level Modules

| File | Purpose |
|------|---------|
| `application.ex` | OTP application, supervision tree definition |
| `repo.ex` | Ecto Repo configuration |
| `mailer.ex` | Swoosh mailer (local adapter in dev) |
| `migrator.ex` | Auto-migration on boot |
| `release.ex` | Release task helpers |

---

## Client (`client/`)

### Top-Level Layout

```
client/
  e2e/                    Playwright E2E tests
  src/
    main/                 Electron main process
      index.ts            Main entry, window management
      db.ts               SQLite database (encrypted, via better-sqlite3-multiple-ciphers)
    preload/
      index.ts            Preload script (contextBridge)
    renderer/
      src/                React application root
    shared/
      linkPreview.ts      Shared link preview utilities
  electron-builder.yml    Packaging config (Windows, macOS, Linux)
  electron-vite.config.ts Build config
  vite.web.config.ts      Web-only build config
  Dockerfile.web          Static web client Docker build (nginx)
```

### Pages (`renderer/src/pages/`)

| File | Purpose |
|------|---------|
| `LoginPage.tsx` | Login form |
| `RegisterPage.tsx` | Registration form |
| `RecoveryPage.tsx` | Account recovery flow |
| `MainPage.tsx` | Primary application shell (servers, channels, messages) |

### Stores (`renderer/src/stores/`)

Zustand stores for global state.

| File | Purpose |
|------|---------|
| `authStore.ts` | Auth state: tokens, current user, device info |
| `serverStore.ts` | Server list, channels, members, roles, permissions |
| `messageStore.ts` | Message lists per channel/conversation, pagination |
| `dmStore.ts` | DM conversations, participants |
| `voiceStore.ts` | Voice room state, participants, mute/deafen |
| `presenceStore.ts` | Online/idle/offline status per user |
| `syncStore.ts` | Sync cursors, pending events |
| `unreadStore.ts` | Unread counts and mentions per scope |
| `settingsStore.ts` | User preferences (theme, notifications, audio) |
| `uiStore.ts` | UI state (modals, panels, active selections) |
| `resetStores.ts` | Utility to reset all stores on logout |

### Components (`renderer/src/components/`)

| Directory | Files | Purpose |
|-----------|-------|---------|
| `auth/` | AuthShell, DeviceTrustGate, RecoveryKeyModal, ServerConnectionCard | Auth flow UI |
| `chat/` | MessageList, MessageItem, MessageInput, ComposerForm, EmojiPicker, FilePreview, PinnedMessagesPopover, SearchBar, MarkdownContent, etc. | Core messaging UI |
| `chat/message/` | -- | Message sub-components |
| `dm/` | DmSidebar, NewDmModal | DM conversation list and creation |
| `layout/` | Header, Sidebar, PanelShell, AccountPanel, ResizeHandle | Application layout shell |
| `server/` | CreateServerModal, JoinServerModal, ChannelSettingsModal, CreateChannelModal, RoleManager, InviteManager, MemberListPanel, ServerSettingsModal, EmojiUploadModal | Server management UI |
| `voice/` | VoiceChannelPanel, VoiceControls, VoiceParticipants, CallOverlay, IncomingCallModal | Voice call UI |
| `settings/` | SettingsModal, SettingsShell | Settings panels |
| `profile/` | ProfilePopout | User profile display |
| `ui/` | Avatar, ContextMenu, FloatingSurface, ImageCropModal | Reusable UI primitives |

### Hooks (`renderer/src/hooks/`)

| File | Purpose |
|------|---------|
| `useContextMenu.ts` | Right-click context menu positioning |
| `useVisibility.ts` | Page visibility detection (for idle/active status) |

### Voice (`renderer/src/voice/`)

| File | Purpose |
|------|---------|
| `webrtc.ts` | WebRTC peer connection management |
| `audio.ts` | Audio processing (gain, analysis, output routing) |
| `encryption.ts` | Voice E2EE frame encryption/decryption |
| `e2ee-worker.ts` | Web Worker for voice encryption offloading |

### SDK Bridge (`renderer/src/sdk/`)

| File | Purpose |
|------|---------|
| `bootstrap.ts` | SDK client initialization from auth store |
| `client.ts` | SDK client singleton management |

---

## SDK (`sdk/`)

### Top-Level Layout

```
sdk/
  src/
    api/        REST API and WebSocket clients
    auth/       Device identity and session management
    client/     High-level encrypted chat client, MLS diagnostics
    crypto/     MLS operations, file encryption, key storage, identity
    storage/    Storage adapters (IndexedDB, memory, file)
    transport/  Phoenix socket transport layer
    types/      TypeScript type definitions
    voice/      Voice configuration types
    testing/    Test harnesses for integration tests
  wasm/         vesper-openmls-wasm Rust/WASM source
  test/         Integration tests (node --test)
  examples/     Sample scripts (auth, CLI, bot, recovery, realtime)
```

### API Module (`sdk/src/api/`)

| File | Purpose |
|------|---------|
| `client.ts` | REST API client (fetch-based) for all endpoints |
| `chat.ts` | Chat-specific API helpers |
| `crypto.ts` | Crypto-related API calls (key packages, welcomes, group info) |
| `socket.ts` | Phoenix WebSocket channel management |
| `searchIndex.ts` | Encrypted search index sync |
| `voiceConfig.ts` | TURN/STUN configuration fetch |

### Auth Module (`sdk/src/auth/`)

| File | Purpose |
|------|---------|
| `session.ts` | Session management (login, register, refresh, logout) |
| `deviceIdentity.ts` | Device key generation and storage |

### Client Module (`sdk/src/client/`)

| File | Purpose |
|------|---------|
| `encryptedChat.ts` | High-level encrypted message send/receive using MLS |
| `fileSessionStore.ts` | Node.js file-based session persistence |
| `mlsDiagnostics.ts` | MLS group state debugging and diagnostics |

### Crypto Module (`sdk/src/crypto/`)

| File | Purpose |
|------|---------|
| `mls.ts` | Core MLS operations (create group, add, remove, commit, external join) |
| `identity.ts` | Cryptographic identity (signing keys, credential creation) |
| `payload.ts` | Message payload encryption/decryption |
| `fileEncryption.ts` | Client-side file encryption before upload |
| `groupLock.ts` | Per-group mutex to serialize MLS state transitions |
| `decryptionCache.ts` | LRU cache for recently decrypted messages |
| `keySerialization.ts` | Key import/export helpers |
| `storage.ts` | Crypto key storage abstraction |
| `indexedDbStorage.ts` | Browser IndexedDB storage backend for crypto keys |
| `searchIndexKeyStore.ts` | Keys for encrypted search index |
| `searchIndexSync.ts` | Search index sync logic |
| `bip39-wordlist.ts` | BIP-39 word list for recovery key generation |
| `types.ts` | Crypto type definitions |

### Transport Module (`sdk/src/transport/`)

| File | Purpose |
|------|---------|
| `context.ts` | Transport context (base URL, auth headers) |

### Storage Module (`sdk/src/storage/`)

| File | Purpose |
|------|---------|
| `indexeddb.ts` | IndexedDB storage adapter (browser) |
| `memory.ts` | In-memory storage adapter (testing) |
| `file.ts` | File-based storage adapter (Node.js) |

### Testing Module (`sdk/src/testing/`)

| File | Purpose |
|------|---------|
| `stack.ts` | Test stack setup (server connection, user creation) |
| `chatHarness.ts` | Chat test harness (send/receive encrypted messages) |
| `deviceHarness.ts` | Device management test harness |

---

## Documentation (`doc/`)

| File | Purpose |
|------|---------|
| `DESIGN.md` | Master design document (architecture, tech choices, rationale) |
| `PROTOCOL.md` | Wire protocol specification |
| `E2EE-CORRECTNESS-PLAN.md` | E2EE correctness RCA and follow-up work |
| `MATRIX-CORE-ANALYSIS.md` | Matrix protocol evaluation |
| `e2ee/` | E2EE documentation index and implementation guide |
| `sdk/` | SDK-specific documentation (encryption guide) |

## Scripts (`scripts/`)

| File | Purpose |
|------|---------|
| `setup-git-hooks.sh` | Install pre-commit and pre-push hooks |
| `pre-commit-checks.sh` | Format check, compile warnings, unused deps |
| `pre-push-checks.sh` | Full test suite before push |
| `load-repo-env.mjs` | Environment variable loader |
| `load-test-env.sh` | Test environment setup |

---

## Key Dependencies

### Server (Elixir)

| Package | Version | Purpose | Type |
|---------|---------|---------|------|
| phoenix | ~> 1.8.4 | Web framework, channels, PubSub | Runtime |
| ecto_sql / phoenix_ecto | ~> 3.13 / ~> 4.5 | Database layer (PostgreSQL via postgrex) | Runtime |
| postgrex | >= 0.0.0 | PostgreSQL driver | Runtime |
| bandit | ~> 1.5 | HTTP server (replaces Cowboy) | Runtime |
| joken | ~> 2.6 | JWT token generation and verification | Runtime |
| argon2_elixir | ~> 4.0 | Password hashing (Argon2id) | Runtime |
| oban | ~> 2.18 | Background job queue (PostgreSQL-backed) | Runtime |
| ex_webrtc | ~> 0.15.0 | WebRTC SFU (peer connections, RTP) | Runtime |
| semaphore | ~> 1.3 | Concurrency limiter for voice operations | Runtime |
| hammer / hammer_plug | ~> 6.2 / ~> 3.0 | Rate limiting | Runtime |
| cors_plug | ~> 3.0 | CORS headers | Runtime |
| swoosh | ~> 1.16 | Email delivery (local dev adapter) | Runtime |
| req | ~> 0.5 | HTTP client (link preview fetching) | Runtime |
| jason | ~> 1.2 | JSON encoding/decoding | Runtime |
| dns_cluster | ~> 0.2.0 | DNS-based cluster discovery | Runtime |

### Client (Electron/React)

| Package | Version | Purpose | Type |
|---------|---------|---------|------|
| react / react-dom | ^19.2 | UI framework | Runtime |
| zustand | ^5.0 | State management | Runtime |
| tailwindcss | ^4.2 | Utility-first CSS | Runtime |
| electron | ^40.6 | Desktop shell | Dev |
| electron-vite | ^5.0 | Build tooling | Dev |
| electron-builder | ^26.8 | Packaging and distribution | Dev |
| phoenix | ^1.8.4 | WebSocket client (matches server) | Runtime |
| better-sqlite3-multiple-ciphers | ^12.6 | Encrypted local SQLite | Runtime |
| lucide-react | ^0.576 | Icon library | Runtime |
| react-markdown / remark-gfm | ^10.1 / ^4.0 | Markdown rendering | Runtime |
| react-virtuoso | ^4.18 | Virtualized list rendering | Runtime |
| @playwright/test | ^1.58 | E2E testing | Dev |

### SDK (TypeScript)

| Package | Version | Purpose | Type |
|---------|---------|---------|------|
| vesper-openmls-wasm | file:./wasm/pkg | MLS RFC 9420 (WASM) | Runtime |
| phoenix | ^1.8.4 | WebSocket transport | Runtime |
| @noble/ciphers | ^2.1 | Symmetric encryption (AES-GCM) | Runtime |
| @noble/curves | ^2.0 | Elliptic curve operations | Runtime |
| @noble/hashes | ^2.0 | Hash functions (SHA-256, etc.) | Runtime |
| @hpke/core | ^1.8 | Hybrid Public Key Encryption | Runtime |
| hash-wasm | ^4.12 | WASM-accelerated hashing | Runtime |
| typescript | ^5.9 | TypeScript compiler | Dev |
