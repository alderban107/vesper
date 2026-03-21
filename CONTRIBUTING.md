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
npm run check:web  # typecheck + production web build
```

The client connects to `http://localhost:4000` by default.

## Running Tests

### Full pre-commit verification

```bash
./scripts/setup-git-hooks.sh
./scripts/pre-commit-checks.sh
./scripts/pre-push-checks.sh
```

The git hooks run these checks automatically:

- `pre-commit` runs `./scripts/pre-commit-checks.sh`
- `pre-push` runs `./scripts/pre-push-checks.sh`

`pre-commit` runs `mix precommit` in `server/`, then `npm run check:web` in `client/`. `pre-push` reruns `npm run check:web`, so a push is blocked if the web app no longer typechecks or builds.

Git hooks help for local clones, but the real repo-wide gate is GitHub Actions. Five CI workflows run on every push to non-`main` branches:

- **Server Tests** (`test-server.yml`) — runs `mix test` with PostgreSQL when `server/` files change
- **Client Checks** (`test-client.yml`) — runs `npm run check:web` when `client/` or `sdk/` files change
- **SDK Tests** (`test-sdk.yml`) — runs the SDK live integration suite when `server/`, `client/`, `sdk/`, or `scripts/` files change
- **E2E Tests** (`test-e2e.yml`) — runs Playwright browser E2E tests when `server/`, `client/`, `sdk/`, or `scripts/` files change
- **Docker Build** (`test-docker.yml`) — smoke-tests that both Docker images build when code or Docker files change

All workflows detect changes by diffing the branch against its merge-base with `main` (not per-commit), so a docs-only follow-up push won't cause tests to be skipped when the branch has code changes. All use a gate job pattern so branch protection status checks pass even when tests are skipped (e.g., a server-only change won't block on client checks).

Configure branch protection to require: `server-checks`, `client-checks`, `sdk-checks`, `e2e-checks`, and `docker-checks`. See `.github/CI.md` for full pipeline documentation.

### Server tests

```bash
cd server
mix test
```

Server tests live in `server/test/` with support modules in `server/test/support/`:

| Path | Purpose |
|------|---------|
| `test/test_helper.exs` | ExUnit bootstrap, starts Ecto sandbox |
| `test/support/data_case.ex` | Base test case with Ecto sandbox checkout |
| `test/support/factory.ex` | Test data factories (users, servers, channels, messages, attachments) |
| `test/vesper/chat/message_deletion_test.exs` | Attachment file cleanup on message deletion |

The test database is configured in `server/config/test.exs` and supports env var overrides (`TEST_DB_HOST`, `TEST_DB_USER`, `TEST_DB_PASS`) for CI and Docker environments.

`mix precommit` (used by git hooks) runs in the test environment and chains: compile with warnings-as-errors → unused deps check → format → test.

### Client E2E tests

```bash
cd client
npm run test:e2e
```

E2E tests live in `client/e2e/` and use Playwright. The harness boots Phoenix
and Vite itself, and also starts the shared local Postgres helper container
when Docker is available. The suite is organized by priority (`p0-` smoke,
`p1-` core features, `p2-` edge cases) with 21 spec files, fixtures, and
harness tooling. See `client/e2e/REQUIREMENTS.md` for the full test plan.

Set `VESPER_PERF_MULTIPLIER` (default `1`) to scale timing thresholds on
slower machines (e.g., `VESPER_PERF_MULTIPLIER=3` triples all timeout windows).

### SDK live tests

```bash
cd client
npm run test:sdk:e2e
```

This runs the Node-based live SDK suite in `sdk/test/`. It boots
Phoenix automatically and uses the same local Postgres helper and root `.env`
settings as the Playwright harness.

**Note:** There are no client unit tests yet. `npm run check:web` (typecheck + production build) is the current client-side CI gate.

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

## Web Client Testing (Docker)

The web client runs as a static build served by nginx inside Docker. Testing changes requires a rebuild cycle:

```bash
# Build and restart the web container
sudo docker compose build web && sudo docker compose up -d web

# Web client: http://localhost:8080
# API server: http://localhost:4000
```

### Debugging in the browser

The web build includes source maps (`vite.web.config.ts` → `sourcemap: true`), so browser devtools show original source locations instead of minified line numbers.

When using automated browser tools that don't expose devtools (e.g., Playwright, agent-browser), inject a log interceptor to capture console output:

```javascript
// Paste into browser console or eval via automation
window.__logs = [];
const _log = console.log;
console.log = (...args) => {
  window.__logs.push(args.map(a =>
    typeof a === 'object' ? JSON.stringify(a) : String(a)
  ).join(' '));
  _log.apply(console, args);
};
const _err = console.error;
console.error = (...args) => {
  window.__logs.push('ERROR: ' + args.map(a =>
    typeof a === 'object' ? (a?.stack || JSON.stringify(a)) : String(a)
  ).join(' '));
  _err.apply(console, args);
};

// After triggering the action, read captured logs:
JSON.stringify(window.__logs, null, 2)
```

### Database inspection

Query the PostgreSQL database directly for debugging:

```bash
sudo docker compose exec db psql -U vesper -d vesper_prod -c "SELECT ..."
```

### IndexedDB isolation between users

The web client's IndexedDB crypto storage is namespaced per user (`vesper-crypto-{userId}`). Each login creates or reopens the database for that specific user. On logout, all in-memory stores and caches are cleared via `resetAllStores()`, and the storage adapter is reset so the next login opens a fresh database for the new user.

The legacy un-namespaced `vesper-crypto` database (from before this fix) is automatically deleted on the first login after the migration.

### Two-user E2EE testing

MLS group joining requires both users to be online simultaneously — one user sends `mls_request_join`, and an online group member handles it by sending a Commit + Welcome. This means single-browser automation cannot test the full two-user channel flow.

**Workarounds:**
- **DM conversations** don't have this limitation. The sender creates the group and adds the recipient in one operation (`sendDmMessage` → `createGroup` → `handleJoinRequest` for each participant). The welcome is stored server-side for offline delivery.
- **Two browser windows** (manual testing) — the most reliable way to verify cross-user decryption in channels.
- **Page reload after send** — verifies that group state persistence and `clientConfig` reattachment work correctly (exercises `deserializeGroupState`).

## Migration Safety

Container images are published on every push to `main` and deployments can happen automatically. This means migrations must be backwards-compatible with the previous release — a bad migration can't be rolled back if it breaks the schema for the currently-running code.

### Expand-and-contract pattern

Never remove or rename a column/table in the same release that stops using it. Split the change across releases:

1. **Release N** — Add the new column/table. Code handles both old and new.
2. **Release N+1** — Migrate existing data, switch code to use only the new structure.
3. **Release N+2** — Drop the old column/table.

### Safe vs unsafe examples

**Unsafe** (single release):
```elixir
# Migration: rename column
rename table(:users), :name, to: :display_name

# Code: only reads :display_name
# Problem: if you rollback to the previous image, it still expects :name
```

**Safe** (two releases):
```elixir
# Release 1 migration: add new column, backfill
alter table(:users) do
  add :display_name, :string
end
execute "UPDATE users SET display_name = name"

# Release 1 code: reads from :display_name, falls back to :name

# Release 2 migration: drop old column
alter table(:users) do
  remove :name
end
```

### Rules of thumb

- Adding a column or table is always safe
- Adding an index concurrently is always safe (use `CREATE INDEX CONCURRENTLY`)
- Removing a column is safe only after the previous release stopped reading it
- Renaming is never atomic — treat it as add + migrate + drop
- Changing a column type requires the same expand-and-contract approach

## Security

Vesper is an E2EE application. If you discover a security vulnerability, especially one that affects encryption, key management, or message confidentiality:

1. **Do not open a public issue**
2. Email the maintainer directly with details
3. Allow reasonable time for a fix before disclosure

The server must never see plaintext message content. Private keys must never leave the client unencrypted. Any PR that violates these invariants will be rejected.
