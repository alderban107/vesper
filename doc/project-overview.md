# Vesper -- Project Overview and Product Design Requirements

## What Vesper Is

Vesper is a self-hostable, end-to-end encrypted messaging platform.
It combines the organizational structure of Discord (servers, channels, roles)
with the encryption guarantees of Signal (E2EE for every message and voice call).
The entire stack is open source under AGPL-3.0.

A server operator runs `docker compose up` and gets a fully working instance:
PostgreSQL, the Phoenix API, a static web client, and a TURN/STUN server (coturn)
all come bundled. Users download the Electron app, point it at a server URL, create
an account, and start talking. There is no key verification ceremony, no QR code
scanning, no device cross-signing UI. Cryptographic identity is generated and
managed transparently by the SDK.

## Core Features

### Servers and Channels

Servers are the top-level organizational unit. Each server has text channels and
voice channels, a role-based permission system with bitfield permissions, and
an invite system (codes and links). Channels within a server form individual
MLS encryption groups.

### Direct Messages

1:1 and group DMs exist outside of any server. Each DM conversation gets its own
MLS group. Conversations support the same message features as channels: encryption,
reactions, threads, pinning, and disappearing messages.

### Voice and Video

Voice uses an SFU (Selective Forwarding Unit) built into the Elixir server via
`ex_webrtc`. Each voice channel or DM call spawns a `Voice.Room` GenServer that
manages peer connections, SDP offer/answer negotiation, ICE candidate exchange,
and RTP packet forwarding through a separate `Router` process. Backpressure is
enforced with a semaphore to prevent thundering-herd problems on join/leave.

Media slots are defined per participant: voice audio, share audio, camera video,
and share video. The Room supports up to 25 concurrent participants.

### File Attachments

Files are uploaded as encrypted blobs via a REST endpoint, stored on the server
filesystem, and referenced by messages. An Oban worker (`ExpireAttachmentBlobs`)
cleans up expired files. The upload path is: client encrypts file locally, uploads
ciphertext to `/api/v1/attachments`, attaches the returned ID to a message.

### Roles and Permissions

Permissions use a bitfield model (see [system-architecture.md](./system-architecture.md)
for the full bit table). Permission resolution follows:
server owner > administrator > role hierarchy > channel overrides.
Roles are ordered by position and combined with bitwise OR. Channel-level overrides
can grant or deny specific permissions per-role or per-user.

### Disappearing Messages

Channels can set a `disappearing_ttl` (in seconds). Messages in those channels get
an `expires_at` timestamp, and the `ExpireMessages` Oban worker (running every minute)
deletes expired messages. The TTL is cached on the channel socket to avoid per-message
DB lookups.

### Search

Encrypted search uses a client-side index approach. The client maintains an encrypted
search index snapshot that is synced to the server via `/api/v1/search-index`.
The server stores the encrypted blob without being able to read it. Search happens
entirely on the client.

## Architecture Summary

| Component | Technology | Role |
|-----------|-----------|------|
| Server | Elixir 1.18+ / Phoenix 1.8 | API, WebSocket channels, SFU, background jobs |
| Database | PostgreSQL 17 | Persistent storage for all domain data |
| Client | Electron 40 / React 19 / TypeScript | Desktop application with web build option |
| SDK | TypeScript (`@vesper/sdk`) | API client, MLS crypto, transport, voice |
| Crypto | OpenMLS via `vesper-openmls-wasm` | MLS RFC 9420 implementation (WASM) |
| Voice | ex_webrtc 0.15 | Pure-Elixir WebRTC SFU |
| Jobs | Oban 2.18 | PostgreSQL-backed background job queue |
| Auth | Joken (JWT) + Argon2id | Access/refresh token auth with password hashing |
| Deployment | Docker Compose | app + db + web + coturn in one compose file |

For detailed module inventories, see [codebase-summary.md](./codebase-summary.md).
For architecture diagrams, see [system-architecture.md](./system-architecture.md).

## Encryption Model

Vesper uses MLS (Messaging Layer Security, RFC 9420) for all E2EE operations.
The implementation runs in the SDK via `vesper-openmls-wasm`, a WASM build of the
OpenMLS library.

**Key principles:**

- Every channel and every DM conversation is an independent MLS group.
- The server is an untrusted relay. It stores encrypted ciphertext, key package
  blobs, Welcome messages, and GroupInfo -- but never has access to plaintext
  or private keys.
- Key packages are uploaded by clients and consumed atomically (one per join
  operation) using `FOR UPDATE SKIP LOCKED` to prevent races.
- New members join via External Commit (RFC 9420 section 12.4), using published
  GroupInfo and a CAS (Compare-And-Swap) serialization mechanism on the server.
- The server maintains a durable MLS event log per channel (`mls_events` table)
  so that clients can replay missed control-plane events (commits, proposals,
  key updates) on reconnect.
- Pending Welcomes, resync requests, and history bundles provide recovery paths
  for devices that fall behind or need to bootstrap from another device.

**What the server stores (all opaque encrypted blobs):**

- `key_packages` -- pre-uploaded MLS key packages per user/device
- `pending_welcomes` -- MLS Welcome messages waiting to be fetched
- `mls_events` -- ordered log of MLS control-plane events per scope
- `mls_group_info` -- latest GroupInfo per scope (for External Commits)
- `pending_resync_requests` -- requests from a device to rejoin a group
- `pending_history_bundles` / `pending_history_requests` -- same-user history recovery

**What the server never sees:**

- Message plaintext
- Private signing or encryption keys
- Group secrets or epoch keys
- File contents (files are encrypted client-side before upload)

## Sync Architecture

Vesper uses a two-tier sync system:

1. **ScopeSyncEvent** -- a shared, append-only log of scope-level events (messages,
   reactions, pins, MLS events). One row per event regardless of member count.
   Clients poll with cursor-based delta sync to catch up on missed events.

2. **UserSyncEvent** -- per-user events for things that target a specific user
   (DM notifications, device approval events, urgent messages).

This design avoids O(N) fan-out writes when broadcasting to large servers. The
scope membership is resolved at read time, not write time.

See [system-architecture.md](./system-architecture.md) for the sync data flow.

## Non-Goals (Current Scope)

These are explicitly out of scope for the current phase of development:

- **Federation** -- servers do not talk to each other. This could be added later
  but would add significant protocol complexity.
- **Mobile apps** -- Electron desktop first. React Native is a future option.
- **Bots and integrations** -- will be added after core features are stable.
- **Video calls / screen sharing** -- the media slot infrastructure exists
  (camera_video, share_video), but the client-side UI is voice-only for now.
- **Plugin system** -- no third-party extension mechanism yet.
- **Bridging** -- no Matrix/IRC/Discord bridge support.

## Self-Hosting Requirements

A Vesper instance needs:

- Docker and Docker Compose
- A machine with a public IP (for TURN/STUN to work behind NATs)
- A `.env` file with: `POSTGRES_PASSWORD`, `SECRET_KEY_BASE`, `TURN_PASSWORD`,
  and optionally `PHX_HOST`, `JWT_SECRET`, `FILE_EXPIRY_DAYS`

The compose file starts four services:

| Service | Image | Purpose |
|---------|-------|---------|
| `db` | postgres:17-alpine | Database |
| `app` | vesper-app | Phoenix API server |
| `web` | vesper-web | Static web client (nginx) |
| `coturn` | coturn/coturn | TURN/STUN relay for WebRTC |

Migrations run automatically on first boot via `Vesper.Migrator`.
Updates are `docker compose pull && docker compose up -d`.

## License

AGPL-3.0-only for the server, client, and SDK.
