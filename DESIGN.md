# Vesper — Design Document

> The authoritative reference for all build sessions. No decision should be re-researched
> if it's covered here. Updated as the project evolves.

## 1. Vision & Goals

### What We're Building

A self-hostable, end-to-end encrypted messaging app with text and voice, organized around
servers and channels (like Discord), with DMs and group DMs (like Signal). Runs as an
Electron desktop app connecting to a Phoenix/Elixir backend.

### Why

We surveyed 10+ Discord alternatives (Feb 2026) and found the same problems everywhere:

| Problem | Who Has It |
|---------|-----------|
| No E2EE, or E2EE that's painful to use | Stoat (none), Matrix (verification hell), Discord (none), Root (none) |
| Voice/video missing or broken | Stoat (basic), Spacebar (not working), IRC/Mumble (voice-only or none) |
| Not self-hostable, or self-hosting is a nightmare | Discord, Root, Signal (hard), Matrix/Synapse (resource-heavy) |
| Bad onboarding UX | IRC, Matrix, XMPP |
| Corporate control or closed source | Discord, Root, Telegram (server-side) |
| Tiny team, uncertain future | Stoat (~5 devs), Spacebar (~5 volunteers) |

### What We Solve

1. **E2EE that's invisible.** No device verification prompts, no emoji comparisons, no QR
   codes. Users sign up with username + password. Cryptographic identity is generated and
   managed automatically under the hood.

2. **Voice that works.** Both channel-based (Discord-style, join/leave freely) and call-based
   (Signal-style, ring someone). E2EE for voice too.

3. **Self-hosting that's one command.** `docker compose up` and you're running.

4. **Modern UX.** Threads, reactions, rich media, disappearing messages, typing indicators.
   The features people expect in 2026.

5. **Open source.** The server, the client, the protocol — all open.

### Self-Contained by Design

Both halves of this app — the server and the client — must be fully self-contained.
No external services, no "also install X", no setup guides that span multiple pages.

**Server owner experience:**
- `docker compose up` and you're running. PostgreSQL, TURN/STUN (coturn), and the app
  are all in the compose file. No separate database server to provision, no third-party
  TURN service to sign up for, no reverse proxy required (though supported).
- Configuration is a single `.env` file with a handful of variables.
- Migrations run automatically on first start.
- Updates: `docker compose pull && docker compose up -d`.

**User experience:**
- Download one installer. Double-click. Enter a server address, pick a username, set a
  password. You're chatting.
- No separate key management tool, no browser extension, no CLI. The Electron app handles
  everything: account creation, key generation, encrypted backup, voice, file sharing.
- Auto-updates via electron-builder's built-in update mechanism.
- Runs on Windows, macOS, and Linux from the same codebase.

**What "self-contained" means in practice:**
- The server bundles its own TURN/STUN (coturn) — no reliance on Google's public STUN
  servers or third-party TURN services for voice to work
- The client bundles ts-mls — no WebAssembly compilation, no native crypto dependencies
  to install
- The SFU is built into the server via ex_webrtc — no separate media server process
- Local encrypted SQLite for client-side storage — no external database for the client
- No accounts on any external service required for either server owners or users

### Non-Goals (For Now)

- Federation (servers talking to each other) — adds massive complexity, can be added later
- Mobile apps — Electron desktop first, React Native later
- Web client — Electron only initially
- Bots/integrations — after core features are solid
- Video calls/screen sharing — voice first, video later

---

## 2. Tech Stack

| Layer | Choice | Version/Package | Why |
|-------|--------|-----------------|-----|
| **Backend** | Elixir / Phoenix | Phoenix ~> 1.8 | BEAM VM: massive concurrency, fault tolerance, OTP supervision trees. Phoenix Channels for real-time WebSockets. Discord proved Elixir scales for messaging. |
| **Database** | PostgreSQL | via Ecto ~> 3.x | Reliable, well-supported by Ecto. Stores users, servers, channels, encrypted message blobs. |
| **Cache/Ephemeral** | ETS / Phoenix PubSub | (built-in) | Online presence, typing indicators, real-time state. No Redis needed — BEAM has this. |
| **Auth** | phx.gen.auth + Joken | Joken ~> 2.6 | phx.gen.auth for registration/session foundation. Joken for lightweight JWT (access + refresh tokens). |
| **Password Hashing** | Argon2id | argon2_elixir ~> 4.0 | OWASP recommended. Drop-in with phx.gen.auth. |
| **Frontend** | Electron + React + TypeScript | electron-vite (react-ts) | React for UI, TypeScript for safety, Vite for fast dev. electron-vite for scaffold, electron-builder for packaging. |
| **State Management** | Zustand | ~> 5.x | Lightweight, no boilerplate, works naturally with React. |
| **Styling** | Tailwind CSS | ~> 4.x | Utility-first, fast iteration, consistent design. |
| **Icons** | lucide-react | latest | Consistent SVG icon set. Tree-shakeable, TypeScript-native. |
| **E2EE Protocol** | MLS (RFC 9420) | ts-mls (npm) | Best group encryption protocol. Forward secrecy + post-compromise security. Pure TypeScript — no WASM compilation needed. IETF-listed implementation. |
| **Voice/WebRTC** | ex_webrtc | ~> 0.15 | Pure Elixir WebRTC by Software Mansion. Serves as native SFU. Phoenix Channels for signaling. |
| **Voice Backpressure** | semaphore | ~> 1.3 | Rate-limits concurrent voice room operations (join/leave) to prevent thundering herd. |
| **Markdown** | react-markdown + remark-gfm | ^10.1 / ^4.0 | Client-side markdown rendering in messages. GFM for tables, strikethrough, autolinks. |
| **HTTP Client** | Req | ~> 0.5 | Server-side HTTP requests (link preview fetching). Wraps Finch under the hood. |
| **Job Queue** | Oban | ~> 2.x | Reliable background jobs (message expiry, cleanup). PostgreSQL-backed, no Redis. |
| **Deployment** | Docker Compose | | App + PostgreSQL + coturn (TURN/STUN). One-command self-hosting. |
| **E2E Testing** | Playwright | @playwright/test | Browser automation for E2E tests. Targets Vite dev server in Chromium with mocked APIs. |

### Why Not...

| Alternative | Why We Didn't Choose It |
|-------------|------------------------|
| Rust backend | Elixir's concurrency model is purpose-built for messaging. Rust would need async runtime + manual connection management. |
| mls-rs (WASM) | No official npm package. Would need custom WASM compilation. ts-mls works out of the box. |
| OpenMLS (WASM) | Same problem — no JS/npm package exists. |
| Guardian (auth) | Heavier than Joken. We don't need OAuth2/SSO. Joken is sufficient for single-app JWT. |
| mediasoup/Janus (SFU) | External C++/C services. ex_webrtc keeps everything in Elixir — simpler deployment. |
| Redux | Zustand is lighter, less boilerplate, better DX for our scale. |
| Electron Forge | Vite plugin still experimental. electron-vite provides better DX today. |

---

## 3. Architecture

### System Diagram

```
┌──────────────────────────────────────────────────┐
│               Electron + React                   │
│                                                  │
│  ┌──────────┐  ┌───────────┐  ┌──────────────┐  │
│  │   React  │  │  ts-mls   │  │   WebRTC     │  │
│  │    UI    │  │  (E2EE)   │  │  (Voice)     │  │
│  └────┬─────┘  └─────┬─────┘  └──────┬───────┘  │
│       │              │               │           │
│  ┌────┴──────────────┴───┐     ICE/DTLS/SRTP    │
│  │    WebSocket Client   │           │           │
│  └───────────┬───────────┘           │           │
└──────────────┼───────────────────────┼───────────┘
               │                       │
               │ wss://                │ UDP/TCP
               │                       │
┌──────────────┼───────────────────────┼───────────┐
│              │    Phoenix Server     │           │
│  ┌───────────┴───────────┐  ┌───────┴────────┐  │
│  │   Phoenix Channels    │  │   ex_webrtc    │  │
│  │                       │  │   (SFU)        │  │
│  │  - chat:channel_id    │  │                │  │
│  │  - dm:conversation_id │  │  - Audio mux   │  │
│  │  - voice:signaling    │  │  - ICE/DTLS    │  │
│  │  - user:notifications │  │  - SRTP relay  │  │
│  └───────────┬───────────┘  └────────────────┘  │
│              │                                   │
│  ┌───────────┴───────────────────────────────┐   │
│  │              Application Layer            │   │
│  │                                           │   │
│  │  ┌─────────┐ ┌──────────┐ ┌───────────┐  │   │
│  │  │  Auth   │ │ Key Pkg  │ │   Oban    │  │   │
│  │  │ Joken + │ │ Directory│ │  (Jobs)   │  │   │
│  │  │ Argon2  │ │          │ │           │  │   │
│  │  └─────────┘ └──────────┘ └───────────┘  │   │
│  └───────────────────┬───────────────────────┘   │
│                      │                           │
│               ┌──────┴──────┐                    │
│               │ PostgreSQL  │                    │
│               └─────────────┘                    │
└──────────────────────────────────────────────────┘
```

### Core Principles

1. **Server is blind.** The server stores and forwards MLS ciphertext. It cannot read
   message content. It maintains a Key Package Directory (public key bundles) so clients
   can establish encrypted sessions, but never has access to private keys or plaintext.

2. **Server is dumb for voice.** The ex_webrtc SFU forwards encrypted audio packets
   without decrypting them. E2EE voice uses WebRTC Insertable Streams to encrypt media
   frames before the SFU ever sees them.

3. **Server is smart for coordination.** Presence, typing indicators, channel membership,
   permissions — the server manages all metadata. Only message *content* is encrypted.

4. **Fail gracefully.** OTP supervision trees restart crashed processes. WebSocket
   reconnection is automatic. Offline messages queue and deliver on reconnect.

---

## 4. Identity & Authentication

### The Matrix Problem

Matrix's E2EE identity system requires users to:
- Verify every new device with emoji comparisons or QR codes
- Understand cross-signing, key backup, and security keys
- Deal with "unverified session" warnings that train users to click through

This is the single biggest UX failure in encrypted messaging. We solve it.

### Our Approach: Invisible Cryptography

Users experience: **username + password**. That's it.

Under the hood:

```
Account Creation:
  1. User picks username + password
  2. Client generates Ed25519 signing key pair
  3. Client generates X25519 key exchange key pair (for MLS)
  4. Private keys bundled → encrypted with Argon2id(password) → sent to server
  5. Public keys sent to server (for Key Package Directory)
  6. Server stores: password hash, encrypted key bundle, public keys
  7. Recovery key generated (24-word mnemonic) → shown once → user writes it down

New Device Login:
  1. User enters username + password
  2. Server returns encrypted key bundle
  3. Client decrypts with Argon2id(password) → has full identity
  4. No verification prompts. No emoji. No QR codes.
  5. Client uploads a new MLS key package for this device

Password Change:
  1. Client decrypts key bundle with old password
  2. Re-encrypts with new password
  3. Uploads new encrypted bundle + new password hash

Account Recovery (forgot password):
  1. User enters recovery key (24-word mnemonic)
  2. Recovery key decrypts a separately-stored backup of the key bundle
  3. User sets new password, re-encrypts bundle
```

### Key Derivation

```
password ──→ Argon2id(password, salt, t=3, m=64MB, p=4) ──→ 32-byte key
                                                              │
                                          ┌───────────────────┤
                                          ▼                   ▼
                                    AES-256-GCM          HMAC-SHA256
                                   (encrypt keys)      (auth the blob)
```

### Token Strategy

```
Access Token:  JWT signed with server secret, 15-minute expiry, contains user_id + device_id
Refresh Token: Opaque token stored in DB (phx.gen.auth token table), 30-day expiry
               Stored in OS keychain on client (Electron safeStorage API)

Flow:
  1. Login → server returns access_token + refresh_token
  2. Client uses access_token for API calls + WebSocket auth
  3. When access_token expires → client sends refresh_token → gets new access_token
  4. Refresh token rotation: each use issues a new refresh token, invalidates the old one
```

### What the Server Knows

| Data | Server Has It? |
|------|---------------|
| Username, display name | Yes |
| Password hash (Argon2id) | Yes |
| Encrypted private key bundle | Yes (cannot decrypt without user's password) |
| Public identity keys | Yes |
| Message content | No (only ciphertext) |
| Who messaged whom, when | Yes (metadata) |
| Channel membership | Yes |
| Online/offline status | Yes |

### Safety Numbers (Optional)

For users who want to verify identity out-of-band:
- Each user has a "safety number" derived from their public identity key
- Displayed as a numeric code or QR code in settings
- Compare with a friend in person or over a trusted channel
- Purely optional — never prompted, never required

---

## 5. E2EE Design

### Protocol: MLS (Messaging Layer Security, RFC 9420)

MLS is the IETF standard for group end-to-end encryption. It provides:
- **Forward secrecy**: Past messages can't be decrypted if current keys are compromised
- **Post-compromise security**: If a key is compromised, security self-heals after the next update
- **Scalable groups**: Efficient for groups up to 50,000 members (tree-based key agreement)
- **Single protocol**: Same mechanism for 1:1 DMs and large channels

### Library: ts-mls

- Pure TypeScript implementation of RFC 9420
- `npm install ts-mls` — no WASM, no native compilation
- IETF-listed as an official MLS implementation
- Supports 21 cipher suites including post-quantum (X-Wing hybrid KEM)
- **Caveat**: Has not undergone a formal security audit. Plan for one before public release.

### How It Works

```
Creating an Encrypted Channel:
  1. First user creates an MLS group (generates group state)
  2. When another user joins, their Key Package (public key bundle) is fetched from server
  3. Joiner is added to the MLS group via a Welcome message
  4. Both sides now share a group secret → can derive message encryption keys

Sending a Message:
  1. Sender encrypts plaintext with current group epoch key
  2. Ciphertext sent to server via WebSocket
  3. Server stores ciphertext blob + metadata (sender_id, timestamp, channel_id)
  4. Server broadcasts ciphertext to other channel members via WebSocket
  5. Recipients decrypt with their copy of the group epoch key

Key Updates (Ratcheting):
  1. Periodically (or on member join/leave), a member issues an MLS Commit
  2. Commit updates the group's key material (new epoch)
  3. All members process the Commit → derive new encryption keys
  4. Old keys are deleted → forward secrecy achieved
```

### Key Package Directory

The server maintains a directory of MLS Key Packages — public key bundles that allow
any member to add a new user to an encrypted group without that user being online.

```
POST   /api/key-packages           Upload key packages (clients upload several at a time)
GET    /api/key-packages/:user_id  Fetch a key package for a user (consumed on use)
DELETE /api/key-packages/:id       Remove a key package
```

Clients should upload 10-20 key packages at a time. Each is consumed once when someone
adds them to a group. Client replenishes when running low.

### What the Server Handles vs Client

| Responsibility | Server | Client |
|---------------|--------|--------|
| Store/forward ciphertext | Yes | — |
| Decrypt messages | No | Yes |
| Key Package Directory | Yes (storage) | Yes (generation, consumption) |
| MLS group state | No | Yes (full state) |
| Member add/remove coordination | Yes (relay Commits/Welcomes) | Yes (generate Commits/Welcomes) |
| Key material | Never | Always |

### MLS Group Mapping

| App Concept | MLS Concept |
|-------------|-------------|
| Text channel | MLS group (one per channel) |
| DM conversation | MLS group (2 members) |
| Group DM | MLS group (3+ members) |
| Voice channel | Separate MLS group (for E2EE voice key exchange) |

### Cipher Suite

Default: `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`
- X25519 for key exchange
- AES-128-GCM for message encryption
- SHA-256 for hashing
- Ed25519 for signatures

Post-quantum cipher suite available as opt-in for the paranoid:
`X-Wing (X25519 + ML-KEM-768)` — ts-mls supports this via FIPS-203/204.

### Local Key Storage

On the client, MLS group state and private keys are stored in an encrypted SQLite
database (via `better-sqlite3`), encrypted at rest with a key derived from the user's
password (or stored in OS keychain via Electron's `safeStorage`).

---

## 6. Voice Architecture

### Two Models

**Channel Voice (Discord-style)**
- Users join/leave a voice channel freely
- Always-on room — audio flows as long as anyone is in it
- Routed through ex_webrtc SFU (server relays audio packets)

**DM/Group Calls (Signal-style)**
- One user initiates, others get a ring notification
- Accept/decline
- All calls go through SFU (no P2P, even for 1:1)

### Signaling

All WebRTC signaling flows through Phoenix Channel topics:

```
voice:channel:{channel_id}   — for server voice channels
voice:dm:{conversation_id}   — for DM/group calls
```

Client-to-server events:
```
"answer"           → SDP answer (in response to server's offer)
"ice_candidate"    → ICE candidate (trickle ICE)
"mute"             → { muted: boolean }
"voice_key"        → MLS-derived key exchange ciphertext (broadcast_from)
"call_ring"        → initiate DM call (DM-only)
"call_accept"      → accept ringing call
"call_reject"      → reject ringing call
"mls_request_join" → request MLS group add
"mls_commit"       → MLS commit data (broadcast to all)
"mls_welcome"      → MLS welcome for a specific recipient
```

Server-to-client events:
```
"offer"              → SDP offer (on join + renegotiation), includes track_map
"ice_candidate"      → ICE candidates from server's PeerConnection
"voice_state_update" → current participant list with mute states
"call_timeout"       → ring unanswered after 30 seconds
"error"              → room full, server busy, or join failure
```

### SFU Architecture (ex_webrtc)

The server runs a full-mesh SFU — every call goes through it, including 1:1 DMs.
Each voice room is a `Vesper.Voice.Room` GenServer, supervised by a
`DynamicSupervisor` (`Vesper.Voice.RoomSupervisor`, max 500 rooms).

```
        ┌──────────┐
User A ─┤          ├─ User B
        │  SFU     │
User C ─┤ (Room    ├─ User D
        │ GenServer│
User E ─┤          │
        └──────────┘

- Each user sends ONE audio stream to the SFU via a PeerConnection
- SFU adds sendonly tracks for each existing participant and creates an offer
- New participants trigger renegotiation on all existing peers
- No mixing — each client receives N-1 individual streams and mixes locally
- Server never decodes/decrypts audio content
- Max 25 participants per room
```

**Room GenServer state:**
- `participants` map: user_id → PeerConnection pid, audio track, mute state, pending ICE candidates
- `pc_to_user` / `channel_to_user` maps for O(1) RTP routing and crash handling
- `call_state`: nil | :ringing | :active (DM calls only)
- Renegotiation buffering: `negotiating` + `renegotiate_pending` flags prevent SDP collisions

**Process tuning (for RTP binary traffic):**
- `min_bin_vheap_size: 233_681` — reduces GC frequency for RTP packets
- `fullsweep_after: 20` — reclaims old binaries faster
- `max_heap_size: ~400MB` (configurable) — OOM protection
- Idle timeout: 5 minutes (shuts down empty rooms)

**Backpressure:** Voice joins are gated by `Semaphore` (max 10 concurrent operations
per room) to prevent thundering herd when many users join simultaneously.

### E2EE Voice (Insertable Streams)

For end-to-end encrypted voice, we use the WebRTC Insertable Streams API
(also called Encoded Transforms):

```
Sender:
  Audio capture → Encode (Opus) → Encrypt frame (MLS-derived key) → Send via WebRTC

SFU:
  Receive encrypted frame → Forward encrypted frame (cannot decrypt)

Receiver:
  Receive encrypted frame → Decrypt frame (MLS-derived key) → Decode (Opus) → Play
```

The MLS group for a voice channel provides the shared symmetric key used for
frame encryption. Key rotation happens via MLS Commits when members join/leave.
Voice key exchange ciphertext is relayed via the `voice_key` event.

### TURN/STUN

WebRTC requires TURN/STUN for NAT traversal. Bundled in Docker Compose via coturn:

```yaml
coturn:
  image: coturn/coturn:latest
  network_mode: host          # required for STUN/TURN UDP
  volumes:
    - ./turnserver.conf:/etc/turnserver.conf
  command: >-
    --static-auth-secret=${TURN_PASSWORD}
```

Credentials are configured via `--static-auth-secret` CLI arg (not envsubst or
`lt-cred-mech`). The Phoenix server provides TURN server URL and credentials
to clients via application config.

### Voice UI States

```
Idle         → no call active
Ringing      → incoming call, accept/decline buttons
In Call      → active call, mute/hangup buttons
In Channel   → in voice channel, mute/disconnect, participant list visible
Connecting   → ICE negotiation in progress, spinner
```

### DM Call Flow

```
1. Caller sends "call_ring" on voice:dm:{conversation_id}
2. Server broadcasts "incoming_call" to DM participants via dm:{id} PubSub
3. 30-second ring timer starts on the Room GenServer
4. Callee sends "call_accept" → timer cancelled, call_state set to :active
   OR callee sends "call_reject" → "call_rejected" broadcast
   OR timer fires → "call_timeout" broadcast, room stopped
```

---

## 7. Data Model

### Full Schema

```sql
-- Users
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username        VARCHAR(32) UNIQUE NOT NULL,
    display_name    VARCHAR(64),
    password_hash   TEXT NOT NULL,                    -- Argon2id
    encrypted_key_bundle  BYTEA NOT NULL,             -- AES-256-GCM encrypted private keys
    key_bundle_salt       BYTEA NOT NULL,             -- Argon2id salt for key derivation
    key_bundle_nonce      BYTEA NOT NULL,             -- AES-GCM nonce
    public_identity_key   BYTEA NOT NULL,             -- Ed25519 public key
    public_key_exchange   BYTEA NOT NULL,             -- X25519 public key
    recovery_key_hash     TEXT,                       -- Argon2id hash of recovery key
    encrypted_recovery_bundle BYTEA,                  -- Key bundle encrypted with recovery key
    avatar_url      TEXT,
    status          VARCHAR(16) DEFAULT 'offline',    -- online, idle, dnd, offline
    inserted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auth tokens (refresh tokens, generated by phx.gen.auth)
CREATE TABLE user_tokens (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token       BYTEA NOT NULL UNIQUE,
    context     VARCHAR(32) NOT NULL,                -- "session", "refresh"
    device_name VARCHAR(128),
    sent_to     VARCHAR(255),
    inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Servers (communities)
CREATE TABLE servers (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(100) NOT NULL,
    icon_url    TEXT,
    owner_id    UUID NOT NULL REFERENCES users(id),
    invite_code VARCHAR(16) UNIQUE,
    invite_code_rotated_at TIMESTAMPTZ DEFAULT NOW(), -- lazy 24h rotation
    inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Channels (within servers)
CREATE TABLE channels (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id   UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name        VARCHAR(100) NOT NULL,
    type        VARCHAR(8) NOT NULL CHECK (type IN ('text', 'voice')),
    topic       TEXT,
    position    INTEGER NOT NULL DEFAULT 0,
    disappearing_ttl  INTEGER,                       -- seconds, NULL = disabled
    inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Server memberships
CREATE TABLE memberships (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_id   UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    role        VARCHAR(16) NOT NULL DEFAULT 'member', -- owner, admin, moderator, member
    nickname    VARCHAR(64),
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, server_id)
);

-- DM conversations
CREATE TABLE dm_conversations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type        VARCHAR(8) NOT NULL CHECK (type IN ('direct', 'group')),
    name        VARCHAR(100),                        -- NULL for direct, set for group
    disappearing_ttl  INTEGER,                       -- seconds, NULL = disabled
    inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- DM participants
CREATE TABLE dm_participants (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(conversation_id, user_id)
);

-- Messages (E2EE — server only stores ciphertext)
CREATE TABLE messages (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id  UUID REFERENCES channels(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES dm_conversations(id) ON DELETE CASCADE,
    sender_id   UUID REFERENCES users(id) ON DELETE SET NULL,  -- NULL = deleted user
    content     TEXT,                                -- plaintext (Phase 1 compat, nullable)
    ciphertext  BYTEA,                               -- MLS-encrypted message content
    mls_epoch   BIGINT,                              -- MLS epoch for key lookup
    parent_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,  -- threads
    edited_at   TIMESTAMPTZ,                         -- set on edit
    inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ,                         -- for disappearing messages
    CHECK (
        (channel_id IS NOT NULL AND conversation_id IS NULL) OR
        (channel_id IS NULL AND conversation_id IS NOT NULL)
    )
);

CREATE INDEX idx_messages_channel ON messages(channel_id, inserted_at);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, inserted_at);
CREATE INDEX idx_messages_expires ON messages(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_messages_parent ON messages(parent_message_id);
CREATE INDEX idx_messages_channel_sender ON messages(channel_id, sender_id, inserted_at);
CREATE INDEX idx_messages_convo_sender ON messages(conversation_id, sender_id, inserted_at);
CREATE INDEX idx_messages_sender ON messages(sender_id);

-- MLS Key Packages
CREATE TABLE key_packages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_package_data BYTEA NOT NULL,                 -- serialized MLS KeyPackage
    consumed        BOOLEAN NOT NULL DEFAULT FALSE,
    inserted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_key_packages_user ON key_packages(user_id, consumed);

-- MLS Welcome messages (pending delivery)
CREATE TABLE mls_pending_welcomes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id      UUID REFERENCES channels(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES dm_conversations(id) ON DELETE CASCADE,
    welcome_data    BYTEA NOT NULL,                  -- serialized MLS Welcome
    inserted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Roles (custom server roles)
CREATE TABLE roles (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id   UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name        VARCHAR(64) NOT NULL,
    color       VARCHAR(7),                          -- hex color
    permissions BIGINT NOT NULL DEFAULT 0,           -- bitfield
    position    INTEGER NOT NULL DEFAULT 0,
    inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Role assignments
CREATE TABLE member_roles (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    membership_id UUID NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
    role_id     UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(membership_id, role_id)
);

CREATE INDEX idx_member_roles_role ON member_roles(role_id);

-- File attachments
CREATE TABLE attachments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id  UUID REFERENCES messages(id) ON DELETE CASCADE,  -- nullable (uploaded before linking)
    filename    VARCHAR(255) NOT NULL,
    content_type VARCHAR(255),
    size_bytes  BIGINT,
    storage_key VARCHAR(255) NOT NULL,
    encrypted   BOOLEAN NOT NULL DEFAULT FALSE,
    expires_at  TIMESTAMPTZ,
    inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_attachments_storage_key ON attachments(storage_key);
CREATE INDEX idx_attachments_expires ON attachments(expires_at);

-- Message reactions
CREATE TABLE reactions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id  UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    sender_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji       VARCHAR(32) NOT NULL,
    ciphertext  BYTEA,                               -- encrypted reaction (optional)
    mls_epoch   INTEGER,
    inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(message_id, sender_id, emoji)
);

-- Pinned messages (per channel)
CREATE TABLE pinned_messages (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id  UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    message_id  UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    pinned_by_id UUID REFERENCES users(id) ON DELETE SET NULL,
    inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(channel_id, message_id)
);

-- Invite links (shareable, with optional expiry/limits)
CREATE TABLE invites (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id   UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    creator_id  UUID REFERENCES users(id) ON DELETE SET NULL,
    code        VARCHAR(255) NOT NULL UNIQUE,         -- 12-char base64
    max_uses    INTEGER,                              -- NULL = unlimited
    uses        INTEGER NOT NULL DEFAULT 0,
    expires_at  TIMESTAMPTZ,                          -- NULL = never
    inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Link preview cache (server-side URL metadata)
CREATE TABLE link_previews (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url_hash    VARCHAR(64) NOT NULL UNIQUE,          -- SHA-256 hex of URL
    url         TEXT NOT NULL,
    title       VARCHAR(255),
    description TEXT,
    image_url   TEXT,
    site_name   VARCHAR(255),
    fetched_at  TIMESTAMPTZ NOT NULL,
    inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Channel read positions (unread tracking)
CREATE TABLE channel_read_positions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id  UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_read_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    last_read_at TIMESTAMPTZ,
    UNIQUE(user_id, channel_id)
);

-- DM read positions (unread tracking)
CREATE TABLE dm_read_positions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
    last_read_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    last_read_at TIMESTAMPTZ,
    UNIQUE(user_id, conversation_id)
);
```

### Permission Bitfield

```
Bit 0:  SEND_MESSAGES         (1)
Bit 1:  MANAGE_MESSAGES       (2)      -- delete others' messages, pin/unpin
Bit 2:  MANAGE_CHANNELS       (4)
Bit 3:  MANAGE_SERVER         (8)
Bit 4:  KICK_MEMBERS          (16)
Bit 5:  BAN_MEMBERS           (32)
Bit 6:  INVITE_MEMBERS        (64)     -- view/create invite links
Bit 7:  MANAGE_ROLES          (128)
Bit 8:  MANAGE_VOICE          (256)
Bit 9:  MENTION_EVERYONE      (512)    -- use @everyone mentions
Bit 14: ADMINISTRATOR         (16384)  -- bypasses all permission checks
```

---

## 8. Disappearing Messages

### Settings

Per-channel and per-DM-conversation setting:
- Off (default)
- 1 hour
- 24 hours
- 7 days
- 30 days
- Custom (any duration)

Setting is stored as `disappearing_ttl` (seconds) on the channel or conversation.
Changing the setting affects new messages only — existing messages keep their original TTL.

### Implementation

**Server-side (primary enforcement):**
- Messages are inserted with `expires_at = inserted_at + disappearing_ttl`
- Oban cron job runs every minute, deletes messages where `expires_at < NOW()`
- Index on `expires_at WHERE expires_at IS NOT NULL` keeps this fast

**Client-side (defense in depth):**
- Client tracks `expires_at` for each message in local SQLite
- Client-side timer removes messages from the UI and local DB when they expire
- Protects against a compromised server that stops deleting

### Metadata

When a message is deleted (disappears):
- The entire row is deleted from PostgreSQL — ciphertext, sender_id, timestamps, all of it
- No tombstone, no soft-delete flag, no audit trail left behind
- Server access logs are NOT modified (operational logs may retain connection metadata)

---

## 8a. Data Lifecycle & Cleanup

### Zero-Remnant Principle

When something is deleted, **nothing remains in the database**. No tombstones, no
soft-delete flags, no orphaned rows. The schema enforces this primarily through
`ON DELETE CASCADE` on all foreign keys, but application-level cleanup handles cases
that cascades can't.

### Cascade Map

Every foreign key in the schema uses `ON DELETE CASCADE`. When a parent is deleted,
all children are automatically removed by PostgreSQL:

```
User deleted →
  ├── user_tokens (sessions)
  ├── memberships → member_roles
  ├── dm_participants
  ├── key_packages
  ├── mls_pending_welcomes
  └── messages (sender_id does NOT cascade — see below)

Server deleted →
  ├── channels → messages (via channel_id CASCADE)
  ├── memberships → member_roles
  └── roles → member_roles

Channel deleted →
  ├── messages
  └── mls_pending_welcomes

DM conversation deleted →
  ├── dm_participants
  ├── messages (via conversation_id CASCADE)
  └── mls_pending_welcomes
```

### User Deletion — Special Handling

When a user deletes their account, `sender_id` on messages does NOT cascade (other
users' message history shouldn't vanish). Instead:

1. User row is deleted (cascades tokens, memberships, key packages, DM participations)
2. Application code runs a cleanup job that:
   - Sets `sender_id = NULL` on all messages sent by this user (anonymization, not deletion)
   - Deletes the user's encrypted key bundle and recovery bundle
   - Removes all key packages
   - Issues MLS remove Commits for every group the user was in
3. If the user was the sole remaining participant in a DM conversation, the conversation
   and all its messages are fully deleted (no orphaned conversations)

The `sender_id` FK should use `ON DELETE SET NULL` (not CASCADE) to support this:
```sql
sender_id UUID REFERENCES users(id) ON DELETE SET NULL
```

### Message Deletion (Manual or Disappearing)

Whether triggered by the disappearing message Oban job or a user manually deleting:
- `DELETE FROM messages WHERE id = $1` — full row removal
- No "message was deleted" placeholder stored server-side
- Client may show a local "[message deleted]" indicator from its own cache, but the
  server retains zero trace

### Channel/Server Deletion

- Deleting a channel cascades to all messages, pending MLS welcomes
- Deleting a server cascades to all channels, which cascades to all messages
- Application code also cleans up:
  - MLS group state on all connected clients (sends a group dissolution notification)
  - Active voice connections in the channel (disconnect participants gracefully)

### Consumed Key Packages

Key packages are single-use. After consumption:
- Mark `consumed = true` immediately
- Oban cleanup job purges consumed key packages older than 24 hours
- This prevents unbounded growth of the key_packages table

### Periodic Cleanup Jobs (Oban)

| Job | Schedule | What It Does |
|-----|----------|--------------|
| `ExpireMessages` | Every 1 min | `DELETE FROM messages WHERE expires_at < NOW()` |
| `PurgeKeyPackages` | Every 1 hour | `DELETE FROM key_packages WHERE consumed = true AND inserted_at < NOW() - INTERVAL '24 hours'` |
| `PurgeExpiredTokens` | Every 1 hour | `DELETE FROM user_tokens WHERE inserted_at < NOW() - INTERVAL '30 days'` |
| `PurgeDeliveredWelcomes` | Every 1 hour | `DELETE FROM mls_pending_welcomes WHERE delivered = true AND inserted_at < NOW() - INTERVAL '24 hours'` |

### What We Don't Clean (By Design)

- **Server access logs / application logs**: Operational logs are outside the database.
  Server operators manage their own log retention policy. We document that operators
  SHOULD configure log rotation and avoid logging message content (which they can't
  read anyway since it's ciphertext).
- **PostgreSQL WAL / backup artifacts**: Database backups may contain deleted data.
  Server operators are responsible for their backup retention policy. The design doc
  cannot enforce this — it's an operational concern documented in the self-hosting guide.

---

## 9. Self-Hosting

### Docker Compose

Four services: PostgreSQL, the Phoenix app, a static web client build, and coturn for TURN/STUN.

```yaml
services:
  db:
    image: postgres:17-alpine
    volumes:
      - pgdata:/var/lib/postgresql/data
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-vesper}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?required}
      POSTGRES_DB: ${POSTGRES_DB:-vesper_prod}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready"]
      interval: 5s
      timeout: 5s
      retries: 5

  app:
    image: ghcr.io/alderban107/vesper-app:main
    build: ./server
    depends_on:
      db:
        condition: service_healthy
    ports:
      - "${APP_PORT:-4000}:4000"
    volumes:
      - uploads:/app/priv/uploads
    environment:
      DATABASE_URL: ecto://${POSTGRES_USER:-vesper}:${POSTGRES_PASSWORD}@db/${POSTGRES_DB:-vesper_prod}
      SECRET_KEY_BASE: ${SECRET_KEY_BASE:?required}
      PHX_HOST: ${PHX_HOST:-localhost}
      JWT_SECRET: ${JWT_SECRET}
      TURN_SERVER_URL: ${TURN_SERVER_URL:-turn:coturn:3478}
      TURN_USERNAME: ${TURN_USERNAME:-vesper}
      TURN_PASSWORD: ${TURN_PASSWORD:?required}
      MAX_UPLOAD_SIZE: ${MAX_UPLOAD_SIZE:-26214400}   # 25MB
      FILE_EXPIRY_DAYS: ${FILE_EXPIRY_DAYS:-30}
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://localhost:4000/health"]
      interval: 10s
      start_period: 60s

  web:
    image: ghcr.io/alderban107/vesper-web:main
    build:
      context: ./client
      dockerfile: Dockerfile.web
    ports:
      - "${WEB_PORT:-8080}:80"
    environment:
      API_URL: ${API_URL}

  coturn:
    image: coturn/coturn:latest
    network_mode: host
    volumes:
      - ./turnserver.conf:/etc/turnserver.conf
    command: >-
      --static-auth-secret=${TURN_PASSWORD}

volumes:
  pgdata:
  uploads:
```

### Configuration

All configuration via environment variables in `.env`:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `POSTGRES_PASSWORD` | Yes | — | PostgreSQL password |
| `SECRET_KEY_BASE` | Yes | — | Phoenix secret (64+ hex chars, `mix phx.gen.secret`) |
| `TURN_PASSWORD` | Yes | — | Shared secret for TURN auth |
| `PHX_HOST` | No | `localhost` | Domain name (e.g., `chat.example.com`) |
| `JWT_SECRET` | No | — | JWT signing secret (falls back to SECRET_KEY_BASE) |
| `POSTGRES_USER` | No | `vesper` | PostgreSQL username |
| `POSTGRES_DB` | No | `vesper_prod` | PostgreSQL database name |
| `TURN_SERVER_URL` | No | `turn:coturn:3478` | TURN server URL |
| `TURN_USERNAME` | No | `vesper` | TURN username |
| `MAX_UPLOAD_SIZE` | No | `26214400` | File upload limit in bytes (25MB) |
| `FILE_EXPIRY_DAYS` | No | `30` | Days before uploaded files expire |
| `APP_PORT` | No | `4000` | Host port for Phoenix API |
| `WEB_PORT` | No | `8080` | Host port for static web client |
| `API_URL` | No | — | API URL for web client to connect to |

### Setup

```bash
# Generate secrets
mix phx.gen.secret  # for SECRET_KEY_BASE
openssl rand -hex 32  # for TURN_PASSWORD

# Copy and edit .env
cp .env.example .env

# Start (migrations run automatically on first boot)
docker compose up -d
```

---

## 10. API Surface

### REST API

All endpoints prefixed with `/api/v1`. Auth via `Authorization: Bearer <access_token>`
unless noted otherwise.

#### Auth (public — no token required)
```
POST   /auth/register                     Create account
POST   /auth/login                        Login → access_token + refresh_token
POST   /auth/refresh                      Refresh access token
POST   /auth/logout                       Revoke refresh token
POST   /auth/recover                      Start account recovery
POST   /auth/recover/reset                Complete recovery with new password
```

#### Auth (authenticated)
```
GET    /auth/me                           Current user profile + crypto keys
PUT    /auth/profile                      Update display name, status
PUT    /auth/password                     Change password (re-encrypts key bundle)
POST   /auth/avatar                       Upload avatar image
GET    /avatars/:user_id                  Serve avatar image
```

#### Servers
```
GET    /servers                           List joined servers
POST   /servers                           Create server
GET    /servers/:id                       Server details
PUT    /servers/:id                       Update server (name, icon)
DELETE /servers/:id                       Delete server (owner only)
POST   /servers/join                      Join via invite code { code }
DELETE /servers/:id/leave                 Leave server
GET    /servers/:id/members               List members
DELETE /servers/:id/members/:user_id      Kick member
```

#### Invite Codes & Links
```
GET    /servers/:id/invite-code           Get permanent invite code (permission-gated, 24h rotation)
GET    /servers/:id/invites               List active invite links
POST   /servers/:id/invites               Create invite link { max_uses, expires_at }
DELETE /servers/:id/invites/:invite_id    Revoke invite link
```

#### Roles
```
GET    /servers/:id/roles                 List roles
POST   /servers/:id/roles                 Create role { name, color, permissions }
PUT    /servers/:id/roles/:role_id        Update role
DELETE /servers/:id/roles/:role_id        Delete role
PUT    /servers/:id/members/:user_id/roles  Assign roles to member { role_ids }
```

#### Channels
```
GET    /servers/:server_id/channels       List channels
POST   /servers/:server_id/channels       Create channel
GET    /servers/:server_id/channels/:id   Channel details
PUT    /servers/:server_id/channels/:id   Update channel
DELETE /servers/:server_id/channels/:id   Delete channel
GET    /channels/:id/messages             Message history (paginated, ?before=&limit=)
PUT    /channels/:id/read                 Mark channel as read
GET    /channels/:id/pins                 List pinned messages
```

#### DMs
```
GET    /conversations                     List DM conversations
POST   /conversations                     Create DM { user_ids }
GET    /conversations/:id                 Conversation details
GET    /conversations/:id/messages        DM message history (paginated)
PUT    /conversations/:id/read            Mark DM as read
```

#### Unread
```
GET    /unread                            All unread counts (channels + DMs)
```

#### Files
```
POST   /attachments                       Upload file attachment
GET    /attachments/:id                   Download file attachment
```

#### Link Previews
```
POST   /link-preview                      Fetch URL metadata (server-side, SSRF-protected)
```

#### Users
```
GET    /users/search?q=                   Search users by username
```

#### Key Packages (MLS)
```
POST   /key-packages                      Upload key packages (batch)
GET    /key-packages/me/count             Count remaining key packages
GET    /key-packages/:user_id             Fetch one key package (consumed on fetch)
```

#### Pending Welcomes (MLS)
```
GET    /pending-welcomes/:channel_id      List pending MLS welcomes
DELETE /pending-welcomes/:id              Delete a consumed welcome
```

#### Health (public)
```
GET    /health                            Health check (no auth required)
```

### WebSocket Channels (Phoenix Channels)

Connection: `wss://host/socket/websocket?token=<access_token>`

Six channel topics, routed via `UserSocket`:

#### `chat:channel:{channel_id}` — Server text channels

Join: Verifies channel membership. Assigns `channel_id`, `server_id`, `disappearing_ttl`.

Client → Server:
```
new_message        { ciphertext, mls_epoch, ?parent_message_id, ?attachment_ids, ?mentioned_user_ids }
edit_message       { message_id, ciphertext, mls_epoch }
delete_message     { message_id }
add_reaction       { message_id, emoji }
remove_reaction    { message_id, emoji }
pin_message        { message_id }            — requires manage_messages permission
unpin_message      { message_id }            — requires manage_messages permission
set_disappearing   { ttl }                   — owner/admin only
typing_start       {}
typing_stop        {}
mls_request_join   {}
mls_commit         { commit_data }
mls_remove         { removed_user_id, commit_data }
mls_welcome        { recipient_id, welcome_data }
```

Server → Client:
```
new_message, message_edited, message_deleted, reaction_update,
message_pinned, message_unpinned, disappearing_ttl_updated,
typing_start, typing_stop, mls_request_join, mls_commit, mls_remove, mls_welcome
```

Via `user:{id}` PubSub: `unread_update`, `mention`

#### `dm:{conversation_id}` — Direct messages

Join: Verifies DM participation. Pre-loads participant IDs.

Same events as chat channel (new_message, edit, delete, reactions, typing, MLS),
plus `set_disappearing` (any participant can set, not just owner).

Via `user:{id}` PubSub: `dm_message`, `dm_unread_update`

#### `voice:channel:{channel_id}` / `voice:dm:{conversation_id}` — Voice

Join: Checks membership + channel type (must be "voice" for channels). Joins the
Room GenServer via Semaphore-gated `Voice.join_room/3`. Server pushes initial `offer`.

Client → Server:
```
answer             { sdp }
ice_candidate      { candidate }
mute               { muted }
voice_key          (any)                     — MLS key exchange relay
call_ring          {}                        — DM only
call_accept        {}
call_reject        {}
mls_request_join   {}
mls_commit         { commit_data }
mls_welcome        { recipient_id, welcome_data }
```

Server → Client:
```
offer, ice_candidate, voice_state_update, call_timeout, error,
mls_request_join, mls_commit, mls_welcome
```

#### `user:{user_id}` — Per-user notifications

Join: Only the user themselves can join their own channel. Tracks presence with
5-minute heartbeat timeout.

Client → Server:
```
heartbeat          {}                        — reset idle timer
set_status         { status }                — "online", "idle", "dnd"
```

Receives server pushes from other channels:
```
unread_update, mention, dm_message, dm_unread_update, incoming_call
```

#### `presence:server:{server_id}` — Server presence

Join: Checks server membership. Read-only channel — no client events.
Broadcasts `presence_state` and `presence_diff` via Phoenix Presence.

---

## 11. Phased Build Plan

> All 5 phases are COMPLETE. See PROGRESS.md for detailed session-by-session build logs.

### Phase 1: Foundation — COMPLETE (2026-03-02)

Scaffolding, auth, REST API, Phoenix Channels, React UI, real-time plaintext messaging.
8 database tables, JWT auth, server/channel CRUD, ChatChannel + DmChannel, full Electron UI.

### Phase 2: E2EE — COMPLETE (2026-03-02)

ts-mls integration, key pair generation, encrypted messaging, identity backup/recovery.
Key Package Directory API, MLS group lifecycle, local encrypted SQLite via better-sqlite3.

### Phase 3: Voice — COMPLETE (2026-03-02)

ex_webrtc SFU (GenServer per room), WebRTC signaling via VoiceChannel, DM calls with
ring/accept/reject/timeout, channel voice rooms, E2EE voice via Insertable Streams,
coturn for TURN/STUN.

### Phase 4: Features + Polish — COMPLETE (2026-03-02)

Disappearing messages, file sharing, typing indicators, user presence, roles + permissions,
server management, user settings, Docker Compose deployment, threads, reactions.

### Phase 5: Visual Redesign + E2E Tests — COMPLETE (2026-03-02)

Vesper twilight theme (glassmorphism, animations), Playwright E2E infrastructure,
45 E2E tests covering auth, server management, messaging, DMs, UI interactions.

### Post-Phase Features (2026-03-03)

Additional features built in two feature sessions after Phase 5 completion:
- Context menus, server settings modal, member list panel, markdown rendering
- Unread tracking (channel + DM read positions), presence system
- Emoji picker (500+ Unicode emoji), message pinning, invite links, link previews, mentions
- Three community PRs: security hardening, performance optimizations, ETS caching

---

## 12. Security Considerations

### Threat Model

**In scope (we defend against):**
- Server operator reading message content (E2EE prevents this)
- Network eavesdropper reading messages or voice (TLS + E2EE)
- Compromised device after key rotation (post-compromise security via MLS)
- Brute-force password attacks (Argon2id + rate limiting)
- Session hijacking (short-lived JWTs + refresh token rotation)

**Partially in scope:**
- Metadata analysis (server knows who talks to whom, when — this is inherent to non-P2P)
- Compromised server (can't read content, but can withhold messages, serve malicious clients)

**Out of scope (accepted risks):**
- Compromised client device with active session (attacker has your keys)
- State-level adversary with full network control (we use standard TLS, not Tor)
- Side-channel attacks on the MLS implementation (mitigate via future audit)
- Denial of service against the server

### Trust Boundaries

```
┌─────────────────────────────┐
│  TRUSTED: Client device     │  ← All crypto happens here
│  - Private keys             │
│  - Plaintext messages       │
│  - MLS group state          │
└──────────────┬──────────────┘
               │ TLS (wss://)
┌──────────────┴──────────────┐
│  UNTRUSTED: Server          │  ← Cannot read content
│  - Ciphertext only          │
│  - Metadata (who, when)     │
│  - Encrypted key bundles    │
│  - Key Packages (public)    │
└──────────────┬──────────────┘
               │ TLS (https://)
┌──────────────┴──────────────┐
│  UNTRUSTED: Network         │  ← Encrypted in transit
└─────────────────────────────┘
```

### Implemented Security Measures

**SSRF Protection** — `LinkPreviewFetcher` blocks requests to private/reserved IP ranges
before fetching URLs. Blocked: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
`127.0.0.0/8`, `169.254.0.0/16`, `0.0.0.0/8`, `::1`, `fe80::/10`, `fc00::/7`.
Redirect targets are re-checked (max 3 redirects). Max body 512KB, 5s timeout.

**IDOR Prevention** — `get_channel_if_member/2` performs a single JOIN query that
atomically verifies channel existence and server membership. Used in ChatChannel and
VoiceChannel join handlers. Eliminates TOCTOU races from separate lookup + check.

**Input Validation:**
- `safe_decode64/1` helper in `ChannelHelpers` validates all base64 inputs before processing
- Binary guards on all WebSocket event payloads (rejects non-binary ciphertext/welcome data)
- `String.to_existing_atom` for user-supplied status values (prevents atom table exhaustion)
- Input length validation on user-facing strings

**Resource Limits:**
- `Task.Supervisor` for notifications (`max_children: 500`) and voice cleanup (`max_children: 100`)
  — prevents unbounded process spawning
- Semaphore backpressure on voice room joins (max 10 concurrent operations per room)
- Voice Room GC tuning (`min_bin_vheap_size`, `fullsweep_after`, `max_heap_size`) for RTP traffic

**Caching:**
- `PermissionsCache` (ETS) — hot-path permission checks without DB queries, PubSub invalidation
- `MemberCache` (ETS) — O(1) membership checks via MapSet, incremental PubSub updates

### Security Checklist (Pre-Release)

- [ ] Commission security audit of ts-mls integration
- [ ] Commission security audit of key backup/recovery flow
- [ ] Penetration test of the Phoenix API
- [ ] Review Argon2id parameters against current OWASP recommendations
- [ ] Verify MLS forward secrecy by testing key deletion after epoch changes
- [ ] Rate limiting on auth endpoints
- [ ] CSRF protection on all state-changing endpoints
- [ ] Content Security Policy headers
- [x] Input validation on all API endpoints (prevent injection)
- [ ] Audit Electron security settings (contextIsolation, nodeIntegration disabled in renderer)

---

## 13. Project Structure

```
~/projects/vesper/
├── DESIGN.md                    # This file
├── PROGRESS.md                  # Build progress — what's done, session logs
├── CLAUDE.md                    # Project conventions for Claude sessions
├── CONTRIBUTING.md              # Contribution guide + migration safety rules
├── TODO.md                      # Bug reports, planned features
├── LICENSE                      # AGPL-3.0
├── README.md
├── docker-compose.yml           # Self-hosting deployment (4 services)
├── .env.example                 # Environment variable template
├── turnserver.conf              # coturn configuration
├── .github/workflows/
│   ├── docker.yml               # Build + push Docker images on push to main
│   └── release.yml              # Electron app releases (AppImage, deb, Windows)
│
├── server/                      # Elixir/Phoenix backend
│   ├── mix.exs
│   ├── mix.lock
│   ├── Dockerfile
│   ├── config/
│   │   ├── config.exs
│   │   ├── dev.exs
│   │   ├── prod.exs
│   │   ├── runtime.exs
│   │   └── test.exs
│   ├── lib/
│   │   ├── vesper/              # Business logic (contexts)
│   │   │   ├── accounts/        # User, UserToken schemas
│   │   │   ├── accounts.ex      # Registration, login, JWT, key bundles
│   │   │   ├── servers/         # Server, Channel, Membership, Role, MemberRole,
│   │   │   │                    #   Invite, Permissions, PermissionsCache, MemberCache
│   │   │   ├── servers.ex       # Server + channel CRUD, permissions, invites
│   │   │   ├── chat/            # Message, DmConversation, DmParticipant, Attachment,
│   │   │   │                    #   Reaction, PinnedMessage, LinkPreview, LinkPreviewFetcher,
│   │   │   │                    #   ChannelReadPosition, DmReadPosition
│   │   │   ├── chat.ex          # Messages, DMs, reactions, pins, read positions
│   │   │   ├── voice/
│   │   │   │   ├── room.ex            # GenServer SFU room (max 25 participants)
│   │   │   │   └── room_supervisor.ex # DynamicSupervisor (max 500 rooms)
│   │   │   ├── voice.ex         # Voice room coordination (ensure, join, leave, SDP, ICE)
│   │   │   ├── encryption/      # KeyPackage, PendingWelcome schemas
│   │   │   ├── encryption.ex    # Key package directory, MLS welcome storage
│   │   │   ├── workers/         # Oban job workers (message expiry, cleanup)
│   │   │   └── application.ex   # OTP supervision tree (incl. Task.Supervisors, caches)
│   │   ├── vesper_web/          # Web layer
│   │   │   ├── controllers/
│   │   │   │   ├── auth_controller.ex
│   │   │   │   ├── server_controller.ex    # CRUD + join/leave/kick/invites/roles
│   │   │   │   ├── channel_controller.ex
│   │   │   │   ├── message_controller.ex   # History, pins, mark read
│   │   │   │   ├── conversation_controller.ex
│   │   │   │   ├── attachment_controller.ex
│   │   │   │   ├── avatar_controller.ex
│   │   │   │   ├── unread_controller.ex
│   │   │   │   ├── link_preview_controller.ex
│   │   │   │   ├── user_controller.ex      # Username search
│   │   │   │   ├── health_controller.ex
│   │   │   │   ├── key_package_controller.ex
│   │   │   │   └── pending_welcome_controller.ex
│   │   │   ├── channels/
│   │   │   │   ├── user_socket.ex          # JWT WebSocket auth, topic routing
│   │   │   │   ├── chat_channel.ex         # chat:channel:{id}
│   │   │   │   ├── dm_channel.ex           # dm:{id}
│   │   │   │   ├── voice_channel.ex        # voice:channel:{id}, voice:dm:{id}
│   │   │   │   ├── user_channel.ex         # user:{id} (notifications, presence)
│   │   │   │   ├── server_presence_channel.ex  # presence:server:{id}
│   │   │   │   ├── channel_helpers.ex      # Shared helpers (safe_decode64, etc.)
│   │   │   │   └── presence.ex
│   │   │   ├── plugs/           # Auth plug
│   │   │   └── router.ex
│   │   └── vesper.ex
│   ├── priv/
│   │   ├── repo/migrations/     # 25 migration files
│   │   └── uploads/             # File attachment storage
│   └── test/
│       ├── vesper/              # Context tests (accounts, chat, encryption, servers, voice)
│       ├── vesper_web/
│       │   ├── channels/        # Channel tests
│       │   └── controllers/     # Controller tests
│       └── support/             # Test helpers (conn_case, data_case, factory)
│
├── client/                      # Electron + React frontend
│   ├── package.json
│   ├── electron-vite.config.ts
│   ├── electron-builder.yml     # Packaging config (AppImage, deb, Windows)
│   ├── postcss.config.js        # Tailwind CSS via PostCSS (not @tailwindcss/vite)
│   ├── vite.web.config.ts       # Web build config (for Docker web service)
│   ├── Dockerfile.web           # Static web client build
│   ├── src/
│   │   ├── main/                # Electron main process
│   │   │   ├── index.ts
│   │   │   └── db.ts            # Local encrypted SQLite
│   │   ├── preload/
│   │   │   └── index.ts         # Context bridge
│   │   └── renderer/src/        # React app
│   │       ├── main.tsx
│   │       ├── App.tsx
│   │       ├── api/
│   │       │   ├── client.ts    # REST API client (fetch + auto token refresh)
│   │       │   ├── socket.ts    # Phoenix WebSocket client
│   │       │   └── crypto.ts    # Key package + welcome API
│   │       ├── stores/
│   │       │   ├── authStore.ts
│   │       │   ├── serverStore.ts
│   │       │   ├── messageStore.ts
│   │       │   ├── voiceStore.ts
│   │       │   ├── cryptoStore.ts
│   │       │   ├── dmStore.ts
│   │       │   ├── presenceStore.ts
│   │       │   ├── unreadStore.ts
│   │       │   ├── settingsStore.ts
│   │       │   └── uiStore.ts
│   │       ├── crypto/
│   │       │   ├── mls.ts       # ts-mls wrapper
│   │       │   ├── identity.ts  # Key generation, backup, recovery
│   │       │   └── storage.ts   # Encrypted local SQLite bridge
│   │       ├── voice/
│   │       │   ├── webrtc.ts    # WebRTC connection management
│   │       │   ├── encryption.ts # Insertable Streams encryption
│   │       │   ├── e2ee-worker.ts # AES-128-GCM Web Worker
│   │       │   └── audio.ts    # Audio device management
│   │       ├── data/
│   │       │   └── emojis.ts    # Emoji dataset (500+ Unicode emoji)
│   │       ├── hooks/
│   │       │   └── useContextMenu.ts
│   │       ├── components/
│   │       │   ├── layout/      # Sidebar, Header
│   │       │   ├── chat/        # MessageList, MessageInput, MessageItem, SearchBar,
│   │       │   │                #   DisappearingSettings, EmojiPicker, PinsPanel,
│   │       │   │                #   LinkPreview, MentionAutocomplete, MarkdownContent,
│   │       │   │                #   FilePreview
│   │       │   ├── voice/       # VoiceControls, VoiceParticipants, CallOverlay,
│   │       │   │                #   IncomingCallModal
│   │       │   ├── server/      # CreateServerModal, JoinServerModal, CreateChannelModal,
│   │       │   │                #   ServerSettingsModal, MemberListPanel, InviteManager,
│   │       │   │                #   RoleManager
│   │       │   ├── dm/          # DmSidebar, DmMessageList, DmMessageInput, NewDmModal
│   │       │   ├── ui/          # Avatar, ContextMenu
│   │       │   ├── settings/    # SettingsModal
│   │       │   └── auth/        # RecoveryKeyModal
│   │       └── pages/           # Login, Register, Recovery, Main
│   └── e2e/                     # Playwright E2E tests (45 tests)
│       ├── tests/               # auth/, dm/, messaging/, server/, ui/
│       └── fixtures/            # Test fixtures, mocks, auth helpers
```

---

## Appendix: Key Library Links

| Library | URL | Purpose |
|---------|-----|---------|
| ts-mls | https://github.com/LukaJCB/ts-mls | MLS E2EE (client) |
| ex_webrtc | https://github.com/elixir-webrtc/ex_webrtc | WebRTC SFU (server) |
| Phoenix | https://hexdocs.pm/phoenix | Web framework (server) |
| Joken | https://hexdocs.pm/joken | JWT auth (server) |
| argon2_elixir | https://hex.pm/packages/argon2_elixir | Password hashing (server) |
| Oban | https://hexdocs.pm/oban | Background jobs (server) |
| semaphore | https://hex.pm/packages/semaphore | Voice backpressure (server) |
| Zustand | https://github.com/pmndrs/zustand | State management (client) |
| electron-vite | https://electron-vite.org | Electron build tool (client) |
| better-sqlite3 | https://github.com/WiseLibs/better-sqlite3 | Local encrypted storage (client) |
| lucide-react | https://lucide.dev | SVG icon library (client) |
| Playwright | https://playwright.dev | E2E browser testing (client) |
