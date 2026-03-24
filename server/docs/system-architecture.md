# System Architecture

> See also: [Project Overview](project-overview-pdr.md) | [API Reference](api-reference.md) | [Code Standards](code-standards.md)

## High-Level Components

```mermaid
graph TB
    subgraph Clients
        WEB[Web Client<br/>React + Vite]
        ELECTRON[Electron Desktop<br/>React + SQLite]
        BOT[SDK Bots<br/>Node.js]
    end

    subgraph SDK["@vesper/sdk"]
        AUTH_SDK[Auth]
        CRYPTO[MLS Crypto<br/>OpenMLS WASM]
        TRANSPORT[Phoenix WebSocket]
        VOICE_SDK[Voice Client]
        STORAGE[Storage Adapters]
    end

    subgraph Server["Phoenix Server (Elixir/OTP)"]
        ENDPOINT[VesperWeb.Endpoint<br/>Bandit HTTP/2]
        ROUTER[Router + Plugs<br/>Auth, RateLimit]
        CHANNELS[Phoenix Channels<br/>Chat, DM, Voice, User]
        CONTEXTS[Contexts<br/>Accounts, Chat, Servers,<br/>Encryption, Runtime, Sync]
        VOICE_SRV[Voice Rooms<br/>Room + Router GenServers]
        OBAN[Oban Workers<br/>Expire, Purge, Evict]
        CACHES[ETS Caches<br/>Permissions, Members, Rooms]
    end

    DB[(PostgreSQL 17)]
    TURN[coturn<br/>STUN/TURN]

    WEB & ELECTRON & BOT --> SDK
    SDK --> ENDPOINT
    AUTH_SDK --> ROUTER
    TRANSPORT --> CHANNELS
    VOICE_SDK --> VOICE_SRV
    VOICE_SDK -.->|WebRTC| TURN
    CHANNELS --> CONTEXTS
    CONTEXTS --> DB
    VOICE_SRV --> TURN
    OBAN --> DB
    CACHES -.->|invalidation| CONTEXTS
```

## OTP Supervision Tree

```mermaid
graph TD
    SUP[Vesper.Supervisor<br/>one_for_one]

    SUP --> TEL[VesperWeb.Telemetry]
    SUP --> REPO[Vesper.Repo<br/>Ecto pool]
    SUP --> MIG[Vesper.Migrator]
    SUP --> DNS[DNSCluster]
    SUP --> PUB[Phoenix.PubSub<br/>pool: schedulers_online]
    SUP --> OBAN_SUP[Oban<br/>queues: default=10, crypto=20]
    SUP --> NOTIF[Task.Supervisor<br/>NotificationSupervisor<br/>max: 500]
    SUP --> CLEANUP[Task.Supervisor<br/>Voice.CleanupSupervisor<br/>max: 100]
    SUP --> MC[MemberCache<br/>GenServer + ETS]
    SUP --> PC[PermissionsCache<br/>GenServer + ETS]
    SUP --> REG[Registry<br/>Voice.Registry, unique]
    SUP --> RS[Voice.RoomSupervisor<br/>DynamicSupervisor, max: 500]
    SUP --> PRES[VesperWeb.Presence]
    SUP --> EP[VesperWeb.Endpoint]

    RS -->|spawns| ROOM[Voice.Room<br/>GenServer, transient]
    ROOM -->|linked| ROUTER_P[Voice.Room.Router<br/>RTP forwarding]
```

## Message Send Flow

The hot path for sending a message. All DB operations are wrapped in a single `Repo.transaction` for all-or-nothing atomicity.

```mermaid
sequenceDiagram
    participant C as Client
    participant CH as ChatChannel
    participant CHAT as Chat Context
    participant RT as Runtime
    participant DB as PostgreSQL
    participant SYNC as Sync
    participant PUB as PubSub

    C->>CH: "new_message" {ciphertext, mls_epoch, client_nonce}
    CH->>CH: Permission check (ETS cache)
    CH->>CH: Base64 decode ciphertext
    CH->>CHAT: create_message(attrs, preload: [])

    rect rgb(240, 248, 255)
        Note over CHAT,DB: Single Repo.transaction
        CHAT->>DB: INSERT message (ON CONFLICT nonce = idempotent)
        CHAT->>RT: project_message(message)
        RT->>RT: Room lookup (ETS cache hit)
        RT->>DB: Idempotency check (RoomEvent by message_id)
        RT->>DB: CTE: UPDATE rooms seq + INSERT room_event
        RT->>DB: UPDATE rooms last_message (GREATEST, race-free)
        RT->>SYNC: append_scope_event (O(1) shared log)
        SYNC->>DB: INSERT scope_sync_events
    end

    CHAT-->>CH: {:ok, message}
    CH->>PUB: broadcast! "new_message"
    CH->>PUB: notify_unread, notify_mentions
    CH-->>C: :ok
```

**Query count per message: 7** (message INSERT, BEGIN, idempotency check, CTE seq+event, room update, sync insert, COMMIT)

**Chaos hardening:**
- Idempotent via `client_nonce` partial unique index — safe retries
- All-or-nothing transaction — no orphaned messages
- `GREATEST()` for last_message_seq — race-free under concurrent sends
- CTE combines seq increment + event insert atomically — no seq gaps

## MLS Encryption Architecture

The server is an untrusted relay. All encryption/decryption happens client-side via OpenMLS WASM.

```mermaid
sequenceDiagram
    participant A as Device A
    participant S as Server (Relay)
    participant B as Device B

    Note over A,B: Group Creation
    A->>S: Upload key packages (POST /key-packages)
    A->>A: Create MLS group locally
    A->>S: Publish GroupInfo (PUT /group-info/:scope)

    Note over A,B: Member Join (External Commit)
    B->>S: Fetch GroupInfo (GET /group-info/:scope)
    B->>B: Construct External Commit
    B->>S: Publish new GroupInfo + commit event (CAS on epoch)
    S->>A: Broadcast mls_commit via channel

    Note over A,B: Sponsored Transition (Add/Remove)
    A->>S: POST /mls-sponsored-transition
    S->>S: Advisory lock + CAS epoch + idempotent commit
    S->>B: Broadcast mls_welcome + mls_commit
    B->>B: Process Welcome, join group

    Note over A,B: Message Send
    A->>A: Encrypt with MLS group key
    A->>S: "new_message" {ciphertext, mls_epoch}
    S->>B: Relay ciphertext (server never decrypts)
    B->>B: Decrypt with MLS group key
```

**Key protection mechanisms:**
- GroupInfo publish uses CAS (compare-and-swap) on `previous_epoch`
- Max epoch delta check (`@max_epoch_delta = 1000`) prevents inflation attacks
- Advisory locks serialize concurrent group state changes
- Idempotency keys prevent duplicate commits on retry

## Sync Architecture

Replaced per-user fan-out (O(N) writes) with shared event log (O(1) writes).

```mermaid
graph LR
    subgraph Write Path
        MSG[Message Send] -->|1 row| SSE[scope_sync_events<br/>shared log]
        MUT[Mutation] -->|1 row| SSE
        DM_NOTIF[DM Notification] -->|per-user| USE[user_sync_events<br/>urgent only]
    end

    subgraph Read Path
        CLIENT[Client Sync Poll] -->|GET /sync| SC[SyncController]
        SC -->|query by scope_ids| SSE
        SC -->|query by user_id| USE
        SC -->|cursor| CURSOR[SyncCursor<br/>base64 encoded]
    end
```

**Design:**
- `scope_sync_events`: append-only log, 1 row per scope event (not per user)
- `user_sync_events`: per-user urgent events (DM messages, mentions only)
- Clients poll with opaque cursor (synced_at + event_id, 1-second lookback)
- Scope changes resolved at read time by joining against user's memberships

## Voice Room Architecture

Two-process design separates control plane from data plane.

```mermaid
graph TB
    subgraph "Voice.Room (Control)"
        JOIN[handle_call :join]
        LEAVE[handle_call :leave]
        SDP[handle_call :sdp_answer]
        MEDIA[handle_call :set_media_slot]
        CALL[Call signaling<br/>ring/accept/reject]
    end

    subgraph "Voice.Room.Router (Data)"
        RTP[RTP forwarding<br/>1250+ msgs/sec]
        ICE_FWD[ICE candidate relay]
        WS_RELAY[WebSocket frame relay<br/>mixed transport]
    end

    PC1[PeerConnection A] -->|ex_webrtc events| RTP
    PC2[PeerConnection B] -->|ex_webrtc events| RTP
    RTP -->|PeerConnection.send_rtp| PC2
    RTP -->|channel push| WS_CLIENT[WebSocket Client C]

    JOIN -->|push_routing_table| RTP
    LEAVE -->|push_routing_table| RTP

    RTP -->|:pc_failed| JOIN
```

**Transport modes:**
- **WebRTC** (default): PeerConnection per participant, SDP/ICE negotiation, RTP forwarding
- **WebSocket**: No PeerConnection needed, frames relayed via Phoenix channel push
- **Mixed**: WebRTC and WebSocket participants coexist, Router bridges between them

## ETS Caching Layer

Three ETS caches reduce DB queries on hot paths:

| Cache | Table | Key | Value | Invalidation |
|-------|-------|-----|-------|-------------|
| PermissionsCache | `:vesper_permissions_cache` | `{user_id, server_id}` | permissions bitfield | PubSub on role change |
| MemberCache | `:vesper_member_cache` | `server_id` | MapSet of user_ids | PubSub on join/leave |
| RoomCache | `:vesper_room_cache` | `{:channel\|:dm, scope_id}` | Room struct (immutable fields) | Never (immutable) |

**PermissionsCache** reads are lock-free (ETS `:read_concurrency`). On cache miss, the calling process queries DB directly and writes to ETS — no GenServer serialization bottleneck.

## Data Model Overview

```mermaid
erDiagram
    users ||--o{ devices : has
    users ||--o{ memberships : has
    users ||--o{ messages : sends
    servers ||--o{ channels : contains
    servers ||--o{ memberships : has
    servers ||--o{ roles : defines
    memberships ||--o{ member_roles : assigned
    roles ||--o{ member_roles : assigned
    channels ||--o{ messages : contains
    dm_conversations ||--o{ messages : contains
    dm_conversations ||--o{ dm_participants : has
    messages ||--o{ attachments : has
    messages ||--o{ reactions : has
    rooms ||--o{ room_events : logs
    rooms ||--|| channels : maps
    rooms ||--|| dm_conversations : maps
```

**Key relationships:**
- Each channel/DM has exactly one Room (event sourcing container)
- Messages belong to either a channel OR a conversation (CHECK constraint)
- Room events reference messages for the event stream
- Permissions computed from roles via bitfield ORing with channel-level overrides
