# Scripts

## Root Scripts (`scripts/`)

### Environment Loading

**`load-repo-env.mjs`** — Node.js module that loads `.env` from the repo root (or `$VESPER_ENV_FILE`) into `process.env`, normalizes SDK test database variables across both naming conventions (`TEST_DB_*` and `VESPER_SDK_TEST_DB_*`), and optionally starts the local test Postgres container. Exports two functions:

- `loadRepoEnv()` — parse and apply the env file, normalize DB vars, return `{ envFile, repoRoot }`
- `ensureLocalTestPostgres()` — call `loadRepoEnv()` then run `sdk/scripts/start-test-postgres.sh`

**`load-repo-env.d.mts`** — TypeScript type declarations for the above.

**`load-test-env.sh`** — Shell equivalent of the env loader. Sources the `.env` file and exports normalized `TEST_DB_*` / `VESPER_SDK_TEST_DB_*` variables with defaults (host `127.0.0.1`, port `55432`, user/pass `vesper_sdk`). Also exports container, volume, image, and tuning profile vars. Usage: `. scripts/load-test-env.sh <repo-root>`. Every SDK script sources this before doing anything.

### Git Hooks

**`setup-git-hooks.sh`** — Points `core.hooksPath` at `.githooks/` so the repo's pre-commit and pre-push hooks activate. Run once after cloning:

```sh
./scripts/setup-git-hooks.sh
```

**`pre-commit-checks.sh`** — Runs on every commit (via `.githooks/pre-commit`). Loads the test env, starts the test Postgres container if Docker is available, then runs:
1. `mix precommit` in `server/`
2. `npm run check:web` in `client/`

**`pre-push-checks.sh`** — Runs on every push (via `.githooks/pre-push`). Lighter gate — only runs `npm run check:web` in `client/`.

---

## SDK Scripts (`sdk/scripts/`)

### Test Database Management

All three scripts source `load-test-env.sh` for configuration. The container defaults to `vesper-sdk-test-postgres` on port `55432` using `postgres:16-alpine`.

| Script | What it does |
|---|---|
| `start-test-postgres.sh` | Creates a Docker volume and starts the Postgres container with tuned settings (256 MB shared buffers, synchronous_commit off, etc.). No-ops if already running. Waits up to 30 s for readiness. |
| `stop-test-postgres.sh` | Removes the container. Leaves the volume intact. |
| `reset-test-postgres.sh` | Removes both the container and the volume — full reset. |

### Integration Tests

**`run-integration-with-localdb.sh`** — Starts the test Postgres, builds the SDK, then runs all integration tests sequentially (`node --test --test-concurrency=1`).

**`run-integration-watch-with-localdb.sh`** — Same as above but with `--watch` for iterative development.

### Chaos / Load Testing

**`run-chaos-load.mjs`** — A single-process chaos load test. Provisions users, servers, and encrypted channels via the SDK, then runs a timed phase of randomized operations (sends, disconnects, reconnects, syncs, wide restores, login restores) with latency sampling. Reports p50/p95/p99 for each operation class and exits non-zero if p95 exceeds the target or any failures occur. Configurable via `CHAOS_*` environment variables. Can run against an external API (`CHAOS_API_URL`) or boot its own test server, and supports shared fixtures (`CHAOS_SHARED_FIXTURE_PATH`) for multi-worker coordination.

**`run-chaos-load-localdb.sh`** — Convenience wrapper: starts the local test Postgres, builds the SDK, then runs `run-chaos-load.mjs`.

**`run-chaos-soak.mjs`** — Multi-worker soak test orchestrator. Boots a single test server, optionally creates a shared fixture via `mix vesper.scale_fixture`, then spawns multiple `run-chaos-load.mjs` workers in parallel with partitioned user/channel slices. Collects event-loop delay and Postgres stats periodically. Aggregates all worker reports into a combined summary and writes everything to an artifact directory. Configurable via `CHAOS_*` env vars; defaults to 8,000 users across up to 8 workers for 120 s.

**`run-chaos-soak-localdb.sh`** — Convenience wrapper: starts the local test Postgres, builds the SDK, then runs `run-chaos-soak.mjs`.

### Database Profiling

**`profile-localdb-queries.sh`** — Runs `EXPLAIN (ANALYZE, BUFFERS)` on three hot-path query patterns (latest-message lookup, message restore by `after_seq`, mutation replay by `after_seq`) against the most recently created SDK test database. Requires the test Postgres container to be running with data from a prior integration or chaos run.
