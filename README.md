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

2. Edit `.env` and configure:
   - `SECRET_KEY_BASE` — generate with `mix phx.gen.secret` or `openssl rand -base64 48`
   - `POSTGRES_PASSWORD` — database password
   - `TURN_PASSWORD` — password for the TURN server (voice relay)
   - `PHX_HOST` — your server's hostname (default: `localhost`)
   - `APP_PORT` — external port (default: `4000`)
   - `API_URL` — full URL to the API server (for the web client, e.g. `https://vesper.yourdomain.com`)

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
npm run build:web    # production web build (outputs dist-web/)
npm run dist:linux   # build AppImage + deb
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

```
server/          Elixir/Phoenix backend (API + WebSocket)
client/          Electron + React frontend
docker-compose.yml
turnserver.conf  coturn configuration for voice relay
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, testing, and code conventions.

## License

[AGPL-3.0](LICENSE)
