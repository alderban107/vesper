# Vesper

Self-hostable, end-to-end encrypted messaging.

<!-- TODO: Add screenshot -->

## Features

- **End-to-end encryption** — MLS protocol (RFC 9420), all encryption/decryption happens client-side
- **Voice calls** — WebRTC with SFU architecture, supports DM and channel calls
- **Servers & channels** — create communities with text and voice channels
- **Direct messages** — private 1-on-1 conversations
- **File sharing** — encrypted file uploads with previews
- **Threads & replies** — side threads stay off the main timeline, inline replies target specific messages
- **Mentions** — @user and @everyone notifications
- **Emoji reactions** — react to messages
- **Message pinning** — pin important messages in channels
- **Invite links** — shareable invite codes for servers
- **Docker deployment** — one-command self-hosting with Docker Compose

## Running the Server

### Docker (recommended)

Pre-built multi-arch images (`linux/amd64`, `linux/arm64`) are published to GHCR:

| Image | Description |
|-------|-------------|
| `ghcr.io/alderban107/vesper-app` | Phoenix API server |
| `ghcr.io/alderban107/vesper-web` | Web client (nginx) |

1. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` and configure — see [Environment Variables](#environment-variables) for the full reference. At minimum, set:
   - `VESPER_APP_IMAGE` and `VESPER_WEB_IMAGE` — matching release tags or immutable digests; never `main`/`latest` in production
   - `SECRET_KEY_BASE` — generate with `mix phx.gen.secret` or `openssl rand -base64 48`
   - `POSTGRES_PASSWORD` — database password
   - `TURN_SERVER_URL`, `TURN_EXTERNAL_IP`, and `TURN_PASSWORD` — publicly reachable TURN relay coordinates and credentials
   - `CORS_ORIGIN` — explicit public web/desktop origins (wildcards are rejected)
   - `METRICS_TOKEN` — at least 32 random bytes for the protected metrics endpoint

3. Start the stack:
   ```bash
   docker compose pull && docker compose up -d
   ```

This starts the Phoenix server, PostgreSQL, and a coturn TURN server for voice relay. The host firewall/NAT must expose TCP/UDP 3478 and UDP 50000–50100 to the address in `TURN_EXTERNAL_IP`; `TURN_SERVER_URL` is sent to remote clients and therefore cannot use a Compose-only hostname. Use the Compose and environment files from the same release tag as the images. Production upgrades require the maintenance-window procedure in [`docs/RELEASE-RUNBOOK.md`](docs/RELEASE-RUNBOOK.md); this release is not mixed-writer compatible.

### From source

Prerequisites: Elixir 1.15+, PostgreSQL

```bash
cd server
mix setup        # install deps, create DB, run migrations
mix phx.server   # start on localhost:4000
```

Dev database defaults: `postgres:postgres@localhost/vesper_dev`

To point local Phoenix dev at a custom Postgres instance, set:
`DEV_DB_HOST`, `DEV_DB_PORT`, `DEV_DB_USER`, `DEV_DB_PASS`, and optionally `DEV_DB_NAME`.

The repo pre-commit hook now defaults its test database settings to the SDK local DB helper
(`localhost:55432`, user/password `vesper_sdk`) unless `TEST_DB_*` is already set.

For a shared local source setup, put these in the repo root `.env` so Phoenix
dev, the SDK live tests, and the Playwright harness all point at the same local
Postgres instance:

`DEV_DB_HOST`, `DEV_DB_PORT`, `DEV_DB_USER`, `DEV_DB_PASS`, `DEV_DB_NAME`,
`TEST_DB_HOST`, `TEST_DB_PORT`, `TEST_DB_USER`, `TEST_DB_PASS`,
`VESPER_SDK_TEST_DB_HOST`, `VESPER_SDK_TEST_DB_PORT`,
`VESPER_SDK_TEST_DB_USER`, and `VESPER_SDK_TEST_DB_PASS`.

## Downloading the Client

### Pre-built releases

Download from [Releases](https://github.com/alderban107/vesper/releases) — available for Linux (AppImage, deb), macOS (DMG), and Windows (installer, portable).

### Web client (Docker)

A browser-based client is available as a Docker image — no download required. Add the `web` service to your Docker Compose stack:

```bash
docker compose up -d web
```

This serves the web client on port `8080` (configurable via `WEB_PORT` in `.env`). Users can access it at `http://your-host:8080`. The web client has full feature parity with the desktop app, including E2EE messaging, voice calls, and file sharing — all running in the browser via IndexedDB and the Web Notification API.

### Build from source

Prerequisites: Node 24+

```bash
cd client
npm install
npm run dev          # Electron dev with hot reload
npm run dev:web      # web client dev server
npm run check:web    # typecheck + production web build
npm run build:web    # production web build (outputs dist-web/)
npm run test:e2e:p0  # Playwright smoke run
npm run test:sdk:e2e # SDK live suite
npm run dist:linux   # build AppImage + deb
```

To run the same verification used by the git pre-commit hook from the repo root:

```bash
./scripts/setup-git-hooks.sh
./scripts/pre-commit-checks.sh
./scripts/pre-push-checks.sh
```

The dev server connects to `http://localhost:4000` by default.

## Connecting

The client connects to a Vesper server URL. In development, this defaults to `localhost:4000`. For self-hosted instances, enter your server's URL when registering or logging in.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Backend | Elixir / Phoenix |
| Frontend | Electron + React + TypeScript |
| Database | PostgreSQL |
| E2EE | MLS via OpenMLS (Rust/WASM) |
| Voice | WebRTC via ex_webrtc (SFU) |
| Auth | Argon2 + JWT |
| State | Zustand (client), ETS + PubSub (server) |
| Styling | Tailwind CSS |
| Jobs | Oban |

## Project Structure

The root `package.json` defines an npm workspaces monorepo linking `client/` and `sdk/`.

```
server/                  Elixir/Phoenix backend (API + WebSocket)
  lib/vesper/              domain logic (accounts, chat, encryption)
  lib/vesper_web/          controllers, channels, router
  config/test.exs          test DB config (supports TEST_DB_* env overrides)
  priv/repo/migrations/    database migrations
  test/
    test_helper.exs        ExUnit bootstrap
    support/
      data_case.ex         base test case (Ecto sandbox)
      factory.ex           test data factories
    vesper/chat/           domain-level tests
      message_deletion_test.exs

client/                  Electron + React frontend
  src/main/                Electron main process (encrypted SQLite, IPC)
  src/preload/             context bridge (IPC between main ↔ renderer)
  src/renderer/src/
    sdk/                   renderer bootstrap for the SDK and E2EE test hooks
    stores/                Zustand app state wired to SDK-owned E2EE flows
    components/            React UI components
  e2e/                     Playwright E2E test suite
    tests/                   spec files (p0-smoke, p1-core, p2-edge)
    fixtures/                test data and attachments
    harness/                 test orchestration helpers
    REQUIREMENTS.md          full test plan

sdk/                     TypeScript SDK (@vesper/sdk npm workspace)
  src/                     SDK source (auth, crypto, client, transport, voice)
  test/                    live integration tests (boots Phoenix)
  examples/                example apps (CLI client, bots, OpenTUI)
  scripts/                 local Postgres helper and chaos/load test runners

scripts/                 repo-level tooling
  setup-git-hooks.sh       configure git hooks from .githooks/
  pre-commit-checks.sh     pre-commit gate (server precommit + client web check)
  pre-push-checks.sh       pre-push gate (client web check)
  load-test-env.sh         source repo .env and normalize test DB vars (shell)
  load-repo-env.mjs        same as above for Node (used by SDK test harness)

.github/workflows/
  test-server.yml          server CI — mix test + PostgreSQL 17
  test-client.yml          client CI — typecheck + production build
  docker-server.yml        build & push attested main/SHA server snapshots
  docker-web.yml           build & push attested main/SHA web snapshots
  release.yml              signed desktop + attested container release gate
  nightly.yml              CI-only distributed recovery soak
.github/CI.md             CI/CD pipeline documentation

doc/
  DESIGN.md                architecture overview
  PROTOCOL.md              HTTP + WebSocket protocol reference
  E2EE-CORRECTNESS-PLAN.md RCA + remaining durability/scale follow-up
  sdk/                     SDK developer guides (quickstart, auth, messaging, etc.)
  e2ee/                    end-to-end encryption documentation
    README.md                     current E2EE doc index
    E2EE-IMPLEMENTATION.md        developer guide
    MLS-BOOTSTRAP-AND-EVICTION.md large-room topology notes
    SDK-CHAOS-SCALE-PLAN.md       chaos + scale validation plan

docker-compose.yml       full stack (PostgreSQL, Phoenix, web client, coturn)
turnserver.conf          coturn configuration for voice relay
```

## Environment Variables

All variables are set in `.env` (loaded by Docker Compose) or exported in the shell when running from source. Copy `.env.example` as a starting point.

<details>
<summary>Full environment variable reference</summary>

### Release images

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `VESPER_APP_IMAGE` | — | **Yes** (Compose) | API image pinned to the selected release tag or immutable digest. |
| `VESPER_WEB_IMAGE` | — | **Yes** (Compose) | Web image pinned to the same selected release or immutable digest. |

### Database

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `POSTGRES_USER` | `vesper` | No | PostgreSQL username |
| `POSTGRES_PASSWORD` | — | **Yes** | PostgreSQL password |
| `POSTGRES_DB` | `vesper_prod` | No | PostgreSQL database name |
| `DATABASE_URL` | — | **Yes** (prod) | Full Ecto connection string, e.g. `ecto://user:pass@host/db`. Only used in production; dev/test use compiled config. |
| `POOL_SIZE` | `10` | No | Database connection pool size |
| `ECTO_IPV6` | — | No | Set to `true` or `1` to connect to PostgreSQL over IPv6 |
| `DEV_DB_HOST` | `localhost` | No | Phoenix dev PostgreSQL host when running from source |
| `DEV_DB_PORT` | `5432` | No | Phoenix dev PostgreSQL port when running from source |
| `DEV_DB_USER` | `postgres` | No | Phoenix dev PostgreSQL username when running from source |
| `DEV_DB_PASS` | `postgres` | No | Phoenix dev PostgreSQL password when running from source |
| `DEV_DB_NAME` | `vesper_dev` | No | Phoenix dev PostgreSQL database name when running from source |

### Server

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `SECRET_KEY_BASE` | — | **Yes** (prod) | Secret for signing cookies and tokens. Generate with `mix phx.gen.secret` or `openssl rand -base64 48`. |
| `PHX_HOST` | `localhost` | No | Hostname for URL generation (e.g. `vesper.yourdomain.com`) |
| `APP_PORT` | `4000` | No | External port the API server listens on |
| `PHX_SERVER` | — | No | Set to `true` to start the HTTP server (set automatically in Docker) |
| `JWT_SECRET` | same as `SECRET_KEY_BASE` | No | Separate secret for JWT signing, if desired |
| `DNS_CLUSTER_QUERY` | — | No | DNS query for clustering in multi-node deployments |
| `METRICS_TOKEN` | — | **Yes** (prod) | Bearer token for `/metrics`; must contain at least 32 bytes. |
| `REGISTRATION_MODE` | `closed` | No | `closed`, `open`, or `invite_only`. Production defaults closed. |
| `REGISTRATION_INVITE_SECRET` | — | **Yes** for `invite_only` | Shared registration secret compared in constant time. |
| `RUN_MIGRATIONS_ON_START` | `true` | No | Docker sets this false and runs a fail-closed release migration before startup. Multi-replica deployments should use a separate migration job. |

### CORS & Origins

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `CORS_ORIGIN` | — | **Yes** (prod) | Comma-separated explicit origins for CORS and WebSockets. Unset, empty, and wildcard values fail startup. Packaged clients may require their concrete file origin or `null`, depending on platform. |

### Voice / WebRTC

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `TURN_PASSWORD` | — | **Yes** | Strong long-term credential password for the bundled TURN relay |
| `TURN_SERVER_URL` | — | **Yes** (Compose) | Publicly resolvable TURN URL delivered to clients, for example `turn:turn.example.com:3478`. A `turns:` URL requires separately configured coturn certificates and TLS ingress. |
| `TURN_EXTERNAL_IP` | — | **Yes** (Compose) | Public address coturn advertises for relayed candidates; forward TCP/UDP 3478 and UDP 50000–50100 to it. |
| `TURN_USERNAME` | `vesper` | No | Long-term TURN credential username |
| `TURN_REALM` | `vesper` | No | TURN authentication realm |
| `VOICE_ICE_TRANSPORT_POLICY` | `relay` if TURN is set, else `all` | No | ICE transport policy: `all` (STUN + TURN) or `relay` (TURN only) |

### File Storage

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `FILE_EXPIRY_DAYS` | `30` | No | Number of days uploaded files are retained before cleanup |
| `UPLOAD_DIR` | `/var/lib/vesper/uploads` (prod) | No | Stable upload path. Docker mounts the named `uploads` volume here. |
| `MAX_UPLOAD_BYTES_PER_USER` | `5368709120` (5 GiB) | No | Hard per-user aggregate quota across linked and pending attachments; must be at least 50 MiB. Upload creation is additionally limited to 20 requests per hour per user. |

### Web Client (Docker)

These apply to the `web` service in Docker Compose.

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `WEB_PORT` | `8080` | No | External port the web client is served on. The nginx image proxies API and WebSocket traffic to the app service so browser traffic remains same-origin. |
| `PUBLIC_SCHEME` | `http` | No | Scheme at the trusted public edge. Set to `https` when TLS terminates at a reverse proxy. The web container ignores caller-supplied forwarding headers. |

### Development & Testing

These are not needed for production deployments.

| Variable | Default | Description |
|----------|---------|-------------|
| `TEST_DB_HOST` | `localhost` | PostgreSQL host for test database |
| `TEST_DB_PORT` | `5432` | PostgreSQL port for test database |
| `TEST_DB_USER` | `postgres` | PostgreSQL user for test database |
| `TEST_DB_PASS` | `postgres` | PostgreSQL password for test database |
| `VESPER_SDK_TEST_DB_HOST` | `127.0.0.1` | Host used by the SDK local Postgres helper |
| `VESPER_SDK_TEST_DB_PORT` | `55432` | Port used by the SDK local Postgres helper |
| `VESPER_SDK_TEST_DB_USER` | `vesper_sdk` | User used by the SDK local Postgres helper |
| `VESPER_SDK_TEST_DB_PASS` | `vesper_sdk` | Password used by the SDK local Postgres helper |
| `VESPER_E2E` | — | Set to `1` to run the server in E2E test mode (real connection pool instead of Ecto sandbox) |
| `MIX_TEST_PARTITION` | — | Appended to test database name for parallel test runs |
| `ELECTRON_RENDERER_URL` | — | Dev server URL for Electron hot reload |

</details>

## File Upload Limits

The maximum upload size is **50 MiB**, hardcoded in two places:

| Location | What it controls |
|----------|-----------------|
| `server/lib/vesper_web/endpoint.ex` → `Plug.Parsers` `:length` | Maximum HTTP request body the server will accept. Requests exceeding this are rejected with a 413 before any application code runs. |
| `server/lib/vesper/chat/file_storage.ex` → `max_upload_size/0` | Application-level limit checked by `AttachmentController`. Returns a descriptive error to the client. |

To change the limit, update **both** values. They must match — if `Plug.Parsers` is lower than `max_upload_size`, uploads between the two values will fail silently with a 413 and no CORS headers. The server must be rebuilt after changing either value.

## Security and release operations

Report vulnerabilities through [SECURITY.md](SECURITY.md). Operators and release maintainers should follow the [public-beta release runbook](docs/RELEASE-RUNBOOK.md) for signing, migration rehearsal, canarying, monitoring, and rollback.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, testing, and code conventions.

## License

[AGPL-3.0](LICENSE)
