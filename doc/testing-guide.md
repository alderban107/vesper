# Vesper Testing Guide

How to run tests, what patterns to follow, and how CI enforces quality.

See also: [Protocol Reference](PROTOCOL.md) | [Configuration Guide](./configuration-guide.md) | [Deployment Guide](./deployment-guide.md)

---

## Test Stack

| Layer | Tool | What it covers |
|-------|------|----------------|
| Server unit/integration | ExUnit + Ecto.Sandbox | Elixir contexts, controllers, channels |
| E2E browser tests | Playwright (Chromium) | Full-stack user flows through the web client |
| SDK integration | Node.js built-in test runner | TypeScript SDK against a live server |
| Client checks | TypeScript compiler | Type correctness for the React client |

---

## Running Server Tests

```bash
cd server

# Run all tests
mix test

# Run a single file
mix test test/vesper/accounts_test.exs

# Run a single test by line number
mix test test/vesper/accounts_test.exs:42

# Run tests matching a name pattern
mix test --only test_name:"pattern"

# Verbose output
mix test --trace
```

### First-time setup

```bash
cd server
mix deps.get
mix ecto.create
mix ecto.migrate
```

The `mix test` alias automatically runs `ecto.create --quiet` and `ecto.migrate --quiet` before tests.

### Environment variables

Server tests use `config/test.exs` defaults. Override with:

| Variable | Default | Purpose |
|----------|---------|---------|
| `TEST_DB_USER` | `postgres` | PostgreSQL username |
| `TEST_DB_PASS` | `postgres` | PostgreSQL password |
| `TEST_DB_HOST` | `localhost` | Database host |
| `TEST_DB_PORT` | `5432` | Database port |
| `MIX_TEST_PARTITION` | (empty) | Appended to DB name for parallel CI |

---

## Test Case Templates

Vesper provides three ExUnit case templates in `test/support/`:

### DataCase

For tests that need database access but no HTTP or channel infrastructure.

```elixir
defmodule Vesper.SomeContextTest do
  use Vesper.DataCase, async: true

  test "creates a record" do
    user = insert_user()
    assert user.id
  end
end
```

Uses `Ecto.Adapters.SQL.Sandbox` in shared mode (non-async) or exclusive mode (async). The `async: true` tag enables concurrent test execution within the module.

### ConnCase

For HTTP controller tests. Provides `Phoenix.ConnTest` helpers and a pre-built `conn`.

```elixir
defmodule VesperWeb.SomeControllerTest do
  use Vesper.ConnCase, async: true

  test "returns 200", %{conn: conn} do
    conn = get(conn, "/health")
    assert json_response(conn, 200)["status"] == "ok"
  end
end
```

### ChannelCase

For WebSocket channel tests. Provides `Phoenix.ChannelTest` helpers and a `connect_user_socket/2` helper that creates a user, device, and authenticated socket in one call.

```elixir
defmodule VesperWeb.SomethingChannelTest do
  use Vesper.ChannelCase, async: true

  test "joins and sends a message" do
    user = insert_user()
    socket = connect_user_socket(user)
    {:ok, _, socket} = subscribe_and_join(socket, "chat:channel:#{channel_id}", %{})
    ref = push(socket, "new_message", %{...})
    assert_reply ref, :ok
  end
end
```

---

## Factory

`test/support/factory.ex` provides minimal factory functions for inserting test records:

```elixir
insert_user(attrs \\ %{})
insert_device(user, attrs \\ %{})
insert_server(owner, attrs \\ %{})
insert_channel(server, attrs \\ %{})
insert_role(server, attrs \\ %{})
insert_member_role(membership, role)
insert_membership(user, server, attrs \\ %{})
```

All factories generate UUIDs and timestamps automatically. Override any field by passing it in `attrs`.

---

## Existing Test Files

```
test/
  vesper/
    accounts_test.exs                 # User registration, auth, password changes
    chat/
      message_deletion_test.exs       # Message deletion logic
      file_storage_test.exs           # File upload/storage
    chat_pagination_test.exs          # Message pagination queries
    encryption_test.exs               # MLS key packages, welcomes, events
    servers/
      permissions_test.exs            # Role/permission checks
    sync_cursor_test.exs              # Sync cursor encoding/decoding
    sync_fuzz_test.exs                # Fuzz testing of sync logic
    urgent_sync_test.exs              # Urgent sync event delivery
    query_benchmark_test.exs          # DB query performance
    query_trace_test.exs              # Query plan analysis
  vesper_web/
    channels/
      mls_channel_test.exs            # MLS WebSocket events
    plugs/
      rate_limit_test.exs             # Rate limiting behavior
```

---

## Query Benchmark Test

`test/vesper/query_benchmark_test.exs` measures database query performance. Use it to detect regressions in critical paths:

```bash
mix test test/vesper/query_benchmark_test.exs --trace
```

---

## E2E Browser Tests (Playwright)

E2E tests live in `client/e2e/` and use Playwright with Chromium. The test harness automatically boots PostgreSQL (via Docker), the Phoenix server, and the Vite dev server through `globalSetup`.

### Test tiers

| Project | Purpose | CI enforcement |
|---------|---------|----------------|
| `p0-smoke` | Critical path smoke tests | Blocks PRs on failure |
| `p1-extended` | Core feature coverage | Informational (does not block) |
| `p2-reliability` | Edge cases and reliability | Informational (does not block) |

### Running locally

```bash
cd client

# Install Playwright browsers (first time)
npx playwright install chromium --with-deps

# Run p0 smoke suite
npm run test:e2e:p0

# Run all suites
npx playwright test -c e2e/playwright.config.ts

# Run a specific project
npx playwright test -c e2e/playwright.config.ts --project=p1-extended
```

### E2E environment

E2E tests use `MIX_ENV=test` with `VESPER_E2E=1` to switch from `Ecto.Sandbox` to a real connection pool, allowing concurrent browser clients to hit the same server.

| Variable | Default | Purpose |
|----------|---------|---------|
| `VESPER_E2E` | (unset) | Set to `1` to enable E2E mode |
| `VESPER_E2E_DB_POOL_SIZE` | `64` | Connection pool size in E2E mode |

---

## SDK Integration Tests

The TypeScript SDK has its own integration test suite that boots a full server per test file.

```bash
cd client

# Run SDK integration tests
npm run test:sdk:e2e
```

The SDK tests use Node.js's built-in test runner (`node --test`). Each test file starts a disposable PostgreSQL container and Phoenix server.

### Performance tuning

Set `VESPER_PERF_MULTIPLIER` to slow down timing-sensitive assertions in CI:

```bash
VESPER_PERF_MULTIPLIER=5 npm run test:sdk:e2e
```

---

## Pre-commit Checks

Run the full precommit suite before pushing:

```bash
cd server
mix precommit
```

This alias runs:
1. `mix compile --warnings-as-errors` - compilation with strict warnings
2. `mix deps.unlock --unused` - clean up unused deps
3. `mix format` - code formatting
4. `mix test` - full test suite

Individual checks:

```bash
mix compile --warnings-as-errors    # catch warnings
mix format --check-formatted        # verify formatting
mix test                            # run tests
```

---

## CI Pipeline

### Workflows

| Workflow | File | Trigger | Gate job |
|----------|------|---------|----------|
| Server Tests | `test-server.yml` | Push (server/ changes) | `server-checks` |
| E2E Tests | `test-e2e.yml` | Push (server/, client/, sdk/ changes) | `e2e-checks` |
| SDK Tests | `test-sdk.yml` | Push (server/, client/, sdk/ changes) | `sdk-checks` |
| Client Tests | `test-client.yml` | Push (client/ changes) | - |
| Docker Build | `test-docker.yml` | Push | - |

All workflows use change detection against the branch's merge-base with `main`. If only unrelated files changed (e.g., markdown), the test jobs skip but the gate job still reports success so branch protection passes.

### CI services

Server tests provision a `postgres:17` service container. E2E and SDK tests use Docker to boot their own PostgreSQL instances via the test harness.

### Required CI configuration

Branch protection should require these status checks:
- `server-checks`
- `e2e-checks`
- `sdk-checks`

---

## Writing New Tests

1. Pick the right case template: `DataCase` for context logic, `ConnCase` for HTTP, `ChannelCase` for WebSocket.
2. Use `async: true` when the test does not depend on shared global state.
3. Use the factory functions (`insert_user`, `insert_server`, etc.) instead of raw Repo inserts.
4. For channel tests, use `connect_user_socket/2` to get an authenticated socket.
5. Test both success and error paths. Channel events should test `:ok` replies and `{:error, %{reason: ...}}` replies.
6. Keep tests focused. One assertion per test when practical.
