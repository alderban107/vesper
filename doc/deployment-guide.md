# Vesper Deployment Guide

How to deploy and operate a Vesper instance. Covers Docker Compose quickstart, production configuration, voice/TURN setup, and scaling.

See also: [Configuration Guide](./configuration-guide.md) | [Protocol Reference](PROTOCOL.md) | [Testing Guide](./testing-guide.md)

---

## Architecture Overview

A production Vesper deployment has four services:

| Service | Image | Purpose |
|---------|-------|---------|
| `db` | `postgres:17-alpine` | PostgreSQL database |
| `app` | `ghcr.io/alderban107/vesper-app:main` | Elixir/Phoenix API server |
| `web` | `ghcr.io/alderban107/vesper-web:main` | Static web client (Nginx) |
| `coturn` | `coturn/coturn:latest` | TURN relay for voice/WebRTC |

The `app` server handles all API requests, WebSocket connections, and voice SFU media routing. The `web` service serves the React client as static files.

---

## Docker Compose Quickstart

### 1. Create a `.env` file

```bash
# Required
POSTGRES_PASSWORD=change-me-to-a-secure-password
SECRET_KEY_BASE=$(openssl rand -hex 64)
TURN_PASSWORD=change-me-to-a-secure-turn-secret

# Recommended
PHX_HOST=chat.example.com
CORS_ORIGIN=https://chat.example.com
JWT_SECRET=$(openssl rand -hex 32)

# Optional (shown with defaults)
POSTGRES_USER=vesper
POSTGRES_DB=vesper_prod
APP_PORT=4000
WEB_PORT=8080
FILE_EXPIRY_DAYS=30
TURN_SERVER_URL=turn:coturn:3478
TURN_USERNAME=vesper
```

### 2. Create turnserver.conf

```ini
listening-port=3478
tls-listening-port=5349
realm=chat.example.com
use-auth-secret
no-cli
no-tcp-relay
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
```

### 3. Start services

```bash
docker compose up -d
```

The `app` service waits for `db` to be healthy before starting. On first boot, the application automatically runs database migrations.

### 4. Verify

```bash
curl http://localhost:4000/health
# {"status":"ok","migrations":"ok","database":"ok"}
```

Open `http://localhost:8080` in a browser to access the web client.

---

## Docker Compose File

The full `docker-compose.yml`:

```yaml
services:
  db:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-vesper}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD required}
      POSTGRES_DB: ${POSTGRES_DB:-vesper_prod}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-vesper}"]
      interval: 5s
      timeout: 5s
      retries: 5

  app:
    image: ghcr.io/alderban107/vesper-app:main
    build:
      context: ./server
      dockerfile: Dockerfile
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    environment:
      DATABASE_URL: ecto://${POSTGRES_USER:-vesper}:${POSTGRES_PASSWORD}@db/${POSTGRES_DB:-vesper_prod}
      SECRET_KEY_BASE: ${SECRET_KEY_BASE:?SECRET_KEY_BASE required}
      PHX_HOST: ${PHX_HOST:-localhost}
      PORT: "4000"
      JWT_SECRET: ${JWT_SECRET:-}
      TURN_SERVER_URL: ${TURN_SERVER_URL:-turn:coturn:3478}
      TURN_USERNAME: ${TURN_USERNAME:-vesper}
      TURN_PASSWORD: ${TURN_PASSWORD:?TURN_PASSWORD required}
      FILE_EXPIRY_DAYS: ${FILE_EXPIRY_DAYS:-30}
    ports:
      - "${APP_PORT:-4000}:4000"
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:4000/health"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 60s

  web:
    image: ghcr.io/alderban107/vesper-web:main
    build:
      context: ./client
      dockerfile: Dockerfile.web
    restart: unless-stopped
    environment:
      API_URL: ${API_URL:-}
    ports:
      - "${WEB_PORT:-8080}:80"

  coturn:
    image: coturn/coturn:latest
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./turnserver.conf:/etc/turnserver.conf:ro
    command: [
      "-c", "/etc/turnserver.conf",
      "--static-auth-secret=${TURN_PASSWORD:?TURN_PASSWORD required}"
    ]

volumes:
  pgdata:
```

---

## Production Dockerfile

The server uses a multi-stage Docker build:

**Stage 1 (build):** `elixir:1.18-otp-27-slim`
- Installs system deps (git, build-essential, libssl-dev)
- Compiles Elixir dependencies
- Compiles application and builds a Mix release

**Stage 2 (runtime):** `debian:bookworm-slim`
- Minimal runtime with libstdc++6, openssl, libncurses6, ca-certificates, curl
- Creates upload directories at `/app/priv/uploads/avatars` and `/app/priv/uploads/banners`
- Copies the release from the build stage
- Sets `PHX_SERVER=true` for release mode
- Exposes port 4000
- Healthcheck: `curl -sf http://localhost:4000/health` every 10s

The final image is around 150 MB.

---

## Database

### PostgreSQL 17

Vesper requires PostgreSQL 17 (used in Docker Compose and CI). Earlier versions may work but are untested.

### Auto-migrations

The application runs pending Ecto migrations on startup via `Vesper.Migrator`. The health endpoint reports migration status:

```json
{"status": "ok", "migrations": "ok", "database": "ok"}
```

If migrations are pending or failed, the health check returns `503`.

### Connection pool

In production, the default pool size is 10 connections. Adjust with the `POOL_SIZE` environment variable:

```bash
POOL_SIZE=20
```

For machines with multiple cores, consider enabling multiple pools by uncommenting `pool_count` in `config/runtime.exs`.

### IPv6

Set `ECTO_IPV6=true` if your PostgreSQL instance requires IPv6 connections.

---

## File Storage

Uploaded files (attachments, avatars, banners, server icons, emojis) are stored on the local filesystem.

### Upload directory

| Environment | Default path |
|-------------|-------------|
| Development | `priv/uploads/` (relative to app dir) |
| Production (release) | `/app/priv/uploads` |

Override with `UPLOAD_DIR` environment variable.

### Docker volume mount

The Dockerfile creates `/app/priv/uploads` with `avatars/` and `banners/` subdirectories. To persist uploads across container restarts, mount a Docker volume:

```yaml
app:
  volumes:
    - uploads:/app/priv/uploads

volumes:
  uploads:
```

### File expiry

Attachments expire after `FILE_EXPIRY_DAYS` (default 30). The `Vesper.Workers.ExpireAttachmentBlobs` Oban worker runs daily at 03:00 UTC to clean up expired files.

### Upload size limit

Max upload size: 50 MB (52,428,800 bytes). Configured in `Vesper.Chat.FileStorage.Local`.

---

## Voice and TURN Configuration

Vesper uses ExWebRTC for voice calls with a Selective Forwarding Unit (SFU) architecture. The server mediates all audio/video streams.

### ICE/TURN servers

Without a TURN server, voice works only on networks where clients can establish direct UDP connections to the Vesper server. For production deployments behind NATs or firewalls, a TURN relay is required.

The Docker Compose setup includes coturn. Set these environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `TURN_SERVER_URL` | (none) | TURN server URL, e.g. `turn:coturn:3478` or `turns:turn.example.com:443?transport=tcp` |
| `TURN_USERNAME` | `vesper` | TURN username |
| `TURN_PASSWORD` | (required if TURN_SERVER_URL set) | TURN shared secret |
| `VOICE_ICE_TRANSPORT_POLICY` | `relay` if TURN set, else `all` | `"all"` or `"relay"` |

### ICE transport policy

- `"all"` - clients try direct connections first, fall back to TURN relay
- `"relay"` - force all media through the TURN relay. Use this for proxied web deployments where direct UDP is not possible.

### coturn setup

The provided `turnserver.conf` uses `use-auth-secret` mode with the same `TURN_PASSWORD` as the app server. The coturn container runs in `network_mode: host` so it can handle UDP traffic on all necessary ports.

For TLS TURN (recommended for web clients behind corporate firewalls):

```ini
listening-port=3478
tls-listening-port=443
cert=/etc/ssl/turn.pem
pkey=/etc/ssl/turn-key.pem
realm=turn.example.com
use-auth-secret
```

Set `TURN_SERVER_URL=turns:turn.example.com:443?transport=tcp` in the app environment.

### Voice transport modes

Clients can connect with two transport modes:
- `webrtc` (default) - full WebRTC with SDP offer/answer and ICE
- `websocket` - media frames sent over the existing WebSocket connection (no SDP/ICE needed, higher latency)

---

## Health Checks

### Endpoint

```
GET /health
```

No authentication required. Returns:

```json
{
  "status": "ok",       // "ok" or "error"
  "migrations": "ok",   // "ok" or "pending"
  "database": "ok"      // "ok" or "unavailable"
}
```

HTTP 200 when all checks pass, 503 otherwise.

### Docker healthcheck

The Dockerfile includes a built-in healthcheck:

```dockerfile
HEALTHCHECK --interval=10s --timeout=5s --retries=3 --start-period=60s \
  CMD curl -sf http://localhost:4000/health || exit 1
```

The 60-second start period allows time for migrations on first boot.

---

## HTTPS and TLS

The Elixir server does not terminate TLS itself. Use a reverse proxy.

### Nginx example

```nginx
upstream vesper_api {
    server 127.0.0.1:4000;
}

upstream vesper_web {
    server 127.0.0.1:8080;
}

server {
    listen 443 ssl http2;
    server_name chat.example.com;

    ssl_certificate     /etc/letsencrypt/live/chat.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/chat.example.com/privkey.pem;

    # API and WebSocket
    location /api/ {
        proxy_pass http://vesper_api;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /socket/ {
        proxy_pass http://vesper_api;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400;
    }

    location /health {
        proxy_pass http://vesper_api;
    }

    # Avatars, banners, icons, emojis (public)
    location ~ ^/(api/v1/avatars|api/v1/banners|api/v1/servers/.*/icon|api/v1/servers/.*/emojis/.*/file) {
        proxy_pass http://vesper_api;
        proxy_set_header Host $host;
    }

    # Web client
    location / {
        proxy_pass http://vesper_web;
    }
}
```

Set these environment variables when using a reverse proxy:

```bash
PHX_HOST=chat.example.com
CORS_ORIGIN=https://chat.example.com
```

### Caddy alternative

```
chat.example.com {
    handle /api/* {
        reverse_proxy localhost:4000
    }
    handle /socket/* {
        reverse_proxy localhost:4000
    }
    handle /health {
        reverse_proxy localhost:4000
    }
    handle {
        reverse_proxy localhost:8080
    }
}
```

---

## CORS

The `cors_plug` library handles CORS. In production, set `CORS_ORIGIN` to your frontend URL:

```bash
CORS_ORIGIN=https://chat.example.com
```

Leaving `CORS_ORIGIN` unset allows all origins (`*`). The server logs a warning when this happens. Acceptable for self-hosted single-tenant deployments but not recommended for public-facing instances.

Allowed methods: GET, POST, PUT, PATCH, DELETE, OPTIONS.
Allowed headers: `authorization`, `content-type`.

---

## Background Workers (Oban)

Vesper uses Oban for scheduled background jobs. Default queue configuration:

| Queue | Concurrency |
|-------|-------------|
| `default` | 10 |
| `crypto_evictions` | 20 |

### Scheduled jobs

| Schedule | Worker | Purpose |
|----------|--------|---------|
| Every minute | `ExpireMessages` | Delete messages past their `expires_at` timestamp |
| Daily 03:00 UTC | `PurgeKeyPackages` | Remove consumed/expired MLS key packages |
| Daily 03:00 UTC | `PurgeWelcomes` | Remove old pending MLS welcomes |
| Daily 03:00 UTC | `ExpireAttachmentBlobs` | Delete expired attachment files from disk |
| Daily 03:00 UTC | `PurgeExpiredTokens` | Clean up expired refresh tokens |

---

## Scaling Considerations

### Single-node deployment

Vesper is designed to run as a single Elixir node. Phoenix PubSub uses an in-memory ETS backend by default. Voice rooms, presence tracking, and caches all live in-process.

### Connection pooling

- Default database pool: 10 connections. Increase `POOL_SIZE` for higher concurrency.
- For multi-core machines, enable `pool_count: 4` (or more) in `runtime.exs` to run multiple connection pools.

### ETS caches

Several hot-path lookups use ETS caches:
- `Vesper.Servers.MemberCache` - server member lists
- `Vesper.Servers.PermissionsCache` - permission checks
- Room state for voice calls

These caches are node-local and do not require external infrastructure.

### WebSocket connections

Each WebSocket connection is a lightweight Erlang process. A single server can handle thousands of concurrent connections. The BEAM VM distributes these across available CPU cores.

### DNS cluster

For multi-node deployments (advanced), set `DNS_CLUSTER_QUERY` to a DNS SRV record that resolves to all nodes. This enables Erlang clustering for distributed PubSub and presence. Most self-hosted deployments do not need this.

---

## Generating Secrets

```bash
# SECRET_KEY_BASE (64+ hex characters)
openssl rand -hex 64

# Or using Elixir
mix phx.gen.secret

# JWT_SECRET (32+ hex characters)
openssl rand -hex 32

# TURN_PASSWORD
openssl rand -hex 32

# POSTGRES_PASSWORD
openssl rand -base64 32
```

---

## Updating

### Pull new images

```bash
docker compose pull
docker compose up -d
```

Migrations run automatically on startup. The health check will report `503` until migrations complete.

### Building from source

```bash
docker compose build
docker compose up -d
```

---

## Troubleshooting

### App won't start

Check database connectivity:
```bash
docker compose logs db
docker compose exec db pg_isready -U vesper
```

Check app logs:
```bash
docker compose logs app
```

### Health check failing

```bash
curl -v http://localhost:4000/health
```

If `migrations` shows `pending`, the app is still running migrations. Wait and retry.
If `database` shows `unavailable`, check PostgreSQL connectivity.

### WebSocket connections failing

Verify `check_origin` settings. If using a reverse proxy, make sure `CORS_ORIGIN` includes your frontend domain, or set `PHX_HOST` to match the domain in the `Host` header.

### Voice not working

1. Check TURN configuration: `curl http://localhost:4000/api/v1/voice/config` (requires auth token)
2. Verify coturn is running: `docker compose logs coturn`
3. For web clients behind corporate firewalls, use `VOICE_ICE_TRANSPORT_POLICY=relay` with a TLS TURN server
