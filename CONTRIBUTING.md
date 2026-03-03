# Contributing to Vesper

## Prerequisites

- Elixir 1.15+
- Node 20+
- PostgreSQL

## Development Setup

### Server

```bash
cd server
mix setup          # install deps, create DB, run migrations
mix phx.server     # start on localhost:4000
```

### Client

```bash
cd client
npm install
npm run dev        # start Electron with hot reload
```

The client connects to `http://localhost:4000` by default.

## Running Tests

### Server tests

```bash
cd server
mix test           # 107 tests
```

### Client E2E tests

```bash
cd client
npm run test:e2e
```

E2E tests use Playwright and require both the server and a test database to be running.

## Code Conventions

### Server (Elixir)

- Follow the contexts pattern — business logic in `lib/vesper/`, thin controllers in `lib/vesper_web/`
- Run `mix format` before committing
- Validate at the changeset level, not in controllers

### Client (TypeScript/React)

- Strict TypeScript — no `any` types except when interfacing with untyped libraries
- Zustand stores: always use selectors (`useStore((s) => s.prop)`), never bare `useStore()`
- All crypto code stays in `src/crypto/`, all voice code in `src/voice/`
- Functional components only

### General

- UUIDs for all primary keys
- UTC timestamps everywhere
- Commit messages should explain the *why*, not just the *what*

## Security

Vesper is an E2EE application. If you discover a security vulnerability, especially one that affects encryption, key management, or message confidentiality:

1. **Do not open a public issue**
2. Email the maintainer directly with details
3. Allow reasonable time for a fix before disclosure

The server must never see plaintext message content. Private keys must never leave the client unencrypted. Any PR that violates these invariants will be rejected.
