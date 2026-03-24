# Vesper Configuration Guide

All configuration options for the Vesper server, organized by subsystem.

See also: [Deployment Guide](./deployment-guide.md) | [API Reference](./api-reference.md) | [Testing Guide](./testing-guide.md)

---

## Server Core

### DATABASE_URL

**Required in production.** Ecto connection URL for PostgreSQL.

```
DATABASE_URL=ecto://USER:PASS@HOST/DATABASE
```

Not used in development or test (those use `DEV_DB_*` / `TEST_DB_*` variables).

### SECRET_KEY_BASE

**Required in production.** Used to sign/encrypt cookies and other secrets. Must be at least 64 bytes.

Generate with:
```bash
mix phx.gen.secret
# or
openssl rand -hex 64
```

### JWT_SECRET

Optional. Signing key for JWT access and refresh tokens (HS256). Defaults to `SECRET_KEY_BASE` if not set. Use a separate value to allow rotating JWT keys independently of the Phoenix secret.

In development, defaults to: `dev-secret-change-in-production-must-be-at-least-32-bytes!`

### PORT

HTTP listen port. Default: `4000`.

```
PORT=4000
```

### PHX_HOST

The hostname for the server. Used in URL generation and WebSocket origin checks. Default: `example.com` in production.

```
PHX_HOST=chat.example.com
```

### PHX_SERVER

Set to `true` to start the HTTP server. Automatically set in the Docker image. Required when running a release:

```
PHX_SERVER=true bin/vesper start
```

### ECTO_IPV6

Set to `true` or `1` to enable IPv6 socket options for database connections.

### DNS_CLUSTER_QUERY

Optional DNS SRV record for Erlang clustering in multi-node deployments. Most deployments can ignore this.

### POOL_SIZE

Database connection pool size. Default: `10`.

```
POOL_SIZE=20
```

---

## CORS

### CORS_ORIGIN

Controls which origins can make cross-origin requests.

| Value | Behavior |
|-------|----------|
| (unset) | Allows all origins (`*`). Logs a warning. |
| `*` | Allows all origins. No warning. |
| `https://chat.example.com` | Single allowed origin |
| `https://a.example.com,https://b.example.com` | Comma-separated list |

The WebSocket `check_origin` setting follows the same logic: when `CORS_ORIGIN` is unset or `*`, origin checking is disabled.

Allowed methods: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`.
Allowed headers: `authorization`, `content-type`.

---

## Voice / WebRTC

### TURN_SERVER_URL

TURN server URL. When set, the voice config endpoint includes it in the ICE server list alongside the default Google STUN server.

```
TURN_SERVER_URL=turn:coturn:3478
TURN_SERVER_URL=turns:turn.example.com:443?transport=tcp
```

When unset, only the public Google STUN server is advertised. Voice calls will fail for clients behind symmetric NATs without a TURN server.

### TURN_USERNAME

Username for TURN authentication. Default: `vesper`.

### TURN_PASSWORD

**Required when `TURN_SERVER_URL` is set.** Shared secret for TURN authentication. The server raises on startup if `TURN_SERVER_URL` is set without `TURN_PASSWORD`.

### VOICE_ICE_TRANSPORT_POLICY

Controls which ICE candidates clients should use.

| Value | Behavior |
|-------|----------|
| `all` | Try direct connections first, fall back to TURN |
| `relay` | Force all media through TURN relay |
| (unset) | `relay` if `TURN_SERVER_URL` is set, `all` otherwise |

Use `relay` for proxied web deployments where direct UDP is blocked.

### ICE servers configuration

In `config/config.exs`, the default ICE servers list includes Google's public STUN server:

```elixir
config :vesper, :ice_servers, [
  %{urls: "stun:stun.l.google.com:19302"}
]
```

In production, when `TURN_SERVER_URL` is set, the list becomes:

```elixir
[
  %{urls: "stun:stun.l.google.com:19302"},
  %{urls: turn_url, username: turn_user, credential: turn_pass}
]
```

Clients fetch this configuration from `GET /api/v1/voice/config`.

---

## File Storage

### UPLOAD_DIR

Absolute path for file uploads. Default: `/app/priv/uploads` in production releases.

```
UPLOAD_DIR=/data/vesper/uploads
```

In development, files are stored relative to the application directory (`priv/uploads/`).

### FILE_EXPIRY_DAYS

Number of days before attachments expire and are eligible for cleanup. Default: `30`.

```
FILE_EXPIRY_DAYS=90
```

The `ExpireAttachmentBlobs` worker deletes expired files daily at 03:00 UTC.

### Max upload size

Hardcoded at 50 MB (52,428,800 bytes) in `Vesper.Chat.FileStorage.Local`. The Bandit HTTP adapter's body size limit is configured to match in `endpoint.ex`. To change it, modify both locations.

---

## Oban (Background Jobs)

### Queue sizes

Configured in `config/config.exs`:

```elixir
config :vesper, Oban,
  repo: Vesper.Repo,
  queues: [default: 10, crypto_evictions: 20]
```

| Queue | Default concurrency | Used by |
|-------|-------------------|---------|
| `default` | 10 | Message expiry, key package purge, welcome purge, token purge, attachment cleanup |
| `crypto_evictions` | 20 | MLS crypto eviction processing |

### Cron schedules

```elixir
plugins: [
  {Oban.Plugins.Cron,
   crontab: [
     {"* * * * *", Vesper.Workers.ExpireMessages},
     {"0 3 * * *", Vesper.Workers.PurgeKeyPackages},
     {"0 3 * * *", Vesper.Workers.PurgeWelcomes},
     {"0 3 * * *", Vesper.Workers.ExpireAttachmentBlobs},
     {"0 3 * * *", Vesper.Workers.PurgeExpiredTokens}
   ]}
]
```

- `ExpireMessages`: runs every minute, deletes messages past their `expires_at` (disappearing messages)
- `PurgeKeyPackages`: daily at 03:00 UTC, removes consumed/stale MLS key packages
- `PurgeWelcomes`: daily at 03:00 UTC, removes old pending MLS welcome messages
- `ExpireAttachmentBlobs`: daily at 03:00 UTC, deletes expired attachment files from disk
- `PurgeExpiredTokens`: daily at 03:00 UTC, cleans up expired refresh tokens

In test mode, Oban runs inline (`testing: :inline`) so jobs execute synchronously.

---

## Rate Limiting

### Hammer backend

Rate limiting uses the `hammer` library with an ETS backend:

```elixir
config :hammer,
  backend: {Hammer.Backend.ETS, [expiry_ms: 600_000, cleanup_interval_ms: 600_000]}
```

Bucket entries expire after 10 minutes. Cleanup runs every 10 minutes.

### Rate limit values

Defined in `VesperWeb.Plugs.RateLimit`:

| Action | Max requests | Window | Key |
|--------|-------------|--------|-----|
| `login` | 5 | 60 s | `login:<ip>:<username>` |
| `register` | 3 | 60 s | `register:<ip>` |
| `recover` | 3 | 600 s (10 min) | `recover:<ip>` |
| `refresh` | 30 | 60 s | `refresh:<ip>` |
| default | 60 | 60 s | `<action>:<ip>` |

Login uses a compound key of IP + username to prevent credential stuffing while allowing legitimate users on shared IPs to authenticate.

The rate limiter reads the client IP from the `X-Forwarded-For` header (first value) when present, falling back to `conn.remote_ip`.

Rate-limited responses return HTTP 429 with:
```json
{
  "error": "rate limit exceeded",
  "retry_after": 60
}
```

And a `Retry-After` header with the window duration in seconds.

---

## JWT / Joken Configuration

### Development default

```elixir
config :joken,
  default_signer: [
    signer_alg: "HS256",
    key_octet: "dev-secret-change-in-production-must-be-at-least-32-bytes!"
  ]
```

### Production

```elixir
jwt_secret = System.get_env("JWT_SECRET") || secret_key_base

config :joken,
  default_signer: [
    signer_alg: "HS256",
    key_octet: jwt_secret
  ]
```

Algorithm: HS256 (HMAC-SHA256). The signing key is the `JWT_SECRET` environment variable, falling back to `SECRET_KEY_BASE`.

Access tokens contain:
- `sub` - user ID
- `device_id` - device record ID
- Standard JWT claims (exp, iat, etc.)

---

## Development Variables

### Dev database

Used in `config/dev.exs`:

| Variable | Default |
|----------|---------|
| `DEV_DB_USER` | `postgres` |
| `DEV_DB_PASS` | `postgres` |
| `DEV_DB_HOST` | `localhost` |
| `DEV_DB_PORT` | `5432` |
| `DEV_DB_NAME` | `vesper_dev` |

### Test database

Used in `config/test.exs`:

| Variable | Default |
|----------|---------|
| `TEST_DB_USER` | `postgres` |
| `TEST_DB_PASS` | `postgres` |
| `TEST_DB_HOST` | `localhost` |
| `TEST_DB_PORT` | `5432` |

Test database name: `vesper_test` (with optional `MIX_TEST_PARTITION` suffix for parallel CI).

### Development CORS

In development, CORS accepts requests from any `localhost` or `127.0.0.1` origin on any port:

```elixir
config :cors_plug,
  origin: ~r/^http:\/\/(localhost|127\.0\.0\.1):\d+$/
```

### Development endpoint

```elixir
config :vesper, VesperWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}],   # loopback only
  check_origin: false,            # no WebSocket origin check
  code_reloader: true,
  debug_errors: true
```

The development server only listens on localhost. Override the port with `PORT=4200` (or any available port).

---

## E2E Test Mode

When `VESPER_E2E=1` is set (alongside `MIX_ENV=test`), the server switches from `Ecto.Sandbox` to a real connection pool so concurrent browser clients can access the database simultaneously.

| Variable | Default | Purpose |
|----------|---------|---------|
| `VESPER_E2E` | (unset) | Set to `1` to enable E2E mode |
| `VESPER_E2E_DB_POOL_SIZE` | `64` | Connection pool size in E2E mode |

E2E mode also sets `server: true` and `check_origin: false` on the endpoint.

---

## Environment Variable Summary

### Required in production

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection URL |
| `SECRET_KEY_BASE` | Phoenix secret key (64+ hex chars) |
| `TURN_PASSWORD` | TURN shared secret (if using voice) |

### Recommended

| Variable | Default | Purpose |
|----------|---------|---------|
| `PHX_HOST` | `example.com` | Server hostname |
| `CORS_ORIGIN` | `*` (all) | Allowed frontend origins |
| `JWT_SECRET` | `SECRET_KEY_BASE` | JWT signing key |
| `TURN_SERVER_URL` | (none) | TURN server for voice |

### Optional

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `4000` | HTTP listen port |
| `POOL_SIZE` | `10` | Database connection pool |
| `ECTO_IPV6` | `false` | IPv6 database connections |
| `TURN_USERNAME` | `vesper` | TURN username |
| `VOICE_ICE_TRANSPORT_POLICY` | auto | `all` or `relay` |
| `UPLOAD_DIR` | `/app/priv/uploads` | File storage path |
| `FILE_EXPIRY_DAYS` | `30` | Attachment expiry |
| `DNS_CLUSTER_QUERY` | (none) | Multi-node clustering |
| `PHX_SERVER` | `true` in Docker | Enable HTTP server |
