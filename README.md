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

3. Start the stack:
   ```bash
   docker compose up -d
   ```

This starts the Phoenix server, PostgreSQL, and a coturn TURN server for voice relay.

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

Download from [Releases](https://github.com/alderban107/vesper/releases) — available as AppImage and deb (Linux), and installer and portable exe (Windows). macOS builds coming soon.

### Build from source

Prerequisites: Node 20+

```bash
cd client
npm install
npm run dev          # development with hot reload
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
