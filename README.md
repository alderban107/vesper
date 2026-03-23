# Vesper

Self-hostable, end-to-end encrypted messaging.

<!-- TODO: Add screenshot -->

## Features

- **End-to-end encryption** — MLS protocol (RFC 9420), all encryption/decryption happens client-side
- **Voice calls** — WebRTC with SFU architecture, supports DM and channel calls
- **Servers & channels** — create communities with text and voice channels
- **Direct messages** — private 1-on-1 conversations
- **File sharing** — encrypted file uploads with previews
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
   - `SECRET_KEY_BASE` — generate with `mix phx.gen.secret` or `openssl rand -base64 48`
   - `POSTGRES_PASSWORD` — database password
   - `TURN_PASSWORD` — password for the TURN server (voice relay)

3. Start the stack:
   ```bash
   docker compose pull && docker compose up -d
   ```

This starts the Phoenix server, PostgreSQL, and a coturn TURN server for voice relay. No source checkout needed — images are pulled from GHCR.

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

Prerequisites: Node 20+

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
| E2EE | MLS via ts-mls |
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
    crypto/                E2EE layer (MLS, identity, payloads, key serialization)
    stores/                Zustand stores (auth, crypto, messages, servers)
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
  docker-server.yml        build & push server Docker image
  docker-web.yml           build & push web client Docker image
  release.yml              build desktop installers
  nightly.yml              daily nightly release (Docker + desktop)
.github/CI.md             CI/CD pipeline documentation

doc/
  DESIGN.md                architecture overview
  PROTOCOL.md              HTTP + WebSocket protocol reference
  sdk/                     SDK developer guides (quickstart, auth, messaging, etc.)
  e2ee/                    end-to-end encryption documentation
    REQUIREMENTS-E2EE.md          requirements & design analysis
    REQUIREMENTS-E2EE-AUDIT.md    implementation status audit
    E2EE-IMPLEMENTATION.md        developer guide

docker-compose.yml       full stack (PostgreSQL, Phoenix, web client, coturn)
turnserver.conf          coturn configuration for voice relay
```

## Environment Variables

All variables are set in `.env` (loaded by Docker Compose) or exported in the shell when running from source. Copy `.env.example` as a starting point.

<details>
<summary>Full environment variable reference</summary>

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

### CORS & Origins

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `CORS_ORIGIN` | `*` (prod) | No | Allowed origin for CORS and WebSocket connections. Set to your frontend URL in production (e.g. `https://app.example.com`). Use a comma-separated list for multiple origins. When unset, CORS allows all origins and a warning is logged. |

### Voice / WebRTC

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `TURN_PASSWORD` | — | **Yes** | Shared secret for the TURN relay server |
| `TURN_SERVER_URL` | `turn:coturn:3478` | No | TURN server URL. For proxied web deployments, use `turns:your-host:443?transport=tcp`. |
| `TURN_USERNAME` | `vesper` | No | TURN username |
| `VOICE_ICE_TRANSPORT_POLICY` | `relay` if TURN is set, else `all` | No | ICE transport policy: `all` (STUN + TURN) or `relay` (TURN only) |

### File Storage

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `FILE_EXPIRY_DAYS` | `30` | No | Number of days uploaded files are retained before cleanup |

### Web Client (Docker)

These apply to the `web` service in Docker Compose.

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `API_URL` | — | No | Full URL to the API server (e.g. `https://vesper.yourdomain.com`). Injected into the web client at container startup. When empty, the client connects to the same host it's served from. |
| `WEB_PORT` | `8080` | No | External port the web client is served on |

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, testing, and code conventions.

## License

[AGPL-3.0](LICENSE)
