# CI / CD Pipelines

This document describes all GitHub Actions workflows in the repository, what triggers
them, and what they produce.

## Change Detection

All test workflows use the same change detection strategy: on every push, the workflow
diffs the branch HEAD against its merge-base with `main`. This means the check evaluates
the **full set of changes the branch introduces** relative to main — not just the files
touched in the latest commit.

This prevents a common gotcha where pushing a docs-only commit to a branch that has
server changes would cause server tests to be skipped, because the per-commit diff
didn't include server files.

When no merge-base can be found (orphan branches, shallow clones), tests run
unconditionally as a safety fallback.

## Workflows

### Test Workflows (branch protection gates)

These run on pushes to non-main, non-tag branches. Each has a gate job that branch
protection should require.

#### `test-server.yml` — Server Tests

Runs when `server/` has non-markdown changes relative to main. Spins up PostgreSQL 17,
compiles with `--warnings-as-errors`, and runs `mix test`.

**Gate job:** `server-checks`

#### `test-client.yml` — Client Checks

Runs when `client/` or `sdk/` has non-markdown changes relative to main. Executes
`npm run check:web` (TypeScript typecheck + Vite web build).

**Gate job:** `client-checks`

#### `test-sdk.yml` — SDK Integration Tests

Runs when `server/`, `client/`, `sdk/`, or `scripts/` has non-markdown changes relative
to main. The test harness boots its own PostgreSQL container (Docker) and spawns isolated
Phoenix instances per test suite — no `services:` container needed.

**Gate job:** `sdk-checks`

#### `test-e2e.yml` — E2E Browser Tests

Runs when `server/`, `client/`, `sdk/`, or `scripts/` has non-markdown changes relative
to main. The Playwright harness boots PostgreSQL (Docker), Phoenix, and Vite automatically
via `globalSetup`. Runs the full suite: p0-smoke → p1-extended → p2-reliability.

On failure, test artifacts (traces, screenshots, video, logs) are uploaded for debugging.

**Gate job:** `e2e-checks`

#### `test-docker.yml` — Docker Build Smoke Test

Runs when code files or Docker infrastructure (`Dockerfile*`, `.dockerignore`,
`docker-compose.yml`) change relative to main. Builds both the server and web client
Docker images without pushing — catches build-context and Dockerfile issues that local
builds wouldn't surface.

**Gate job:** `docker-checks`

### Deploy Workflows

#### `docker-server.yml` — Server Docker Image

Triggers on push to `main` or `v*` tags when `server/` changes. Builds multi-arch
(amd64 + arm64) images using native runners (no QEMU), then stitches a manifest list.

- **Registry:** `ghcr.io/<owner>/vesper-app`
- **Tags:** `main`, semver patterns, `sha-<short>`

#### `docker-web.yml` — Web Client Docker Image

Same structure as the server workflow but for `client/` and `sdk/` changes.

- **Registry:** `ghcr.io/<owner>/vesper-web`
- **Tags:** `main`, semver patterns, `sha-<short>`

#### `release.yml` — Tagged Release (Desktop)

Triggers when a GitHub release is created, or via manual `workflow_dispatch` with a tag
input. Builds Electron desktop apps on Linux, macOS, and Windows runners, then attaches
the binaries to the GitHub release.

**Outputs:** `.AppImage`, `.deb`, `.dmg`, `.exe`

#### `nightly.yml` — Nightly Release

Runs daily at 06:00 UTC via cron, or manually via `workflow_dispatch`.

**Change detection:** Compares `HEAD` of `main` against the existing `nightly` git tag.
If they match, the entire pipeline is skipped. Manual dispatch always builds.

**What it builds (in parallel):**
- Server Docker image (multi-arch amd64 + arm64) → `ghcr.io/<owner>/vesper-app:nightly`
- Web client Docker image (multi-arch amd64 + arm64) → `ghcr.io/<owner>/vesper-web:nightly`
- Desktop Linux (`.AppImage`, `.deb`)
- Desktop macOS (`.dmg`, `.zip`)
- Desktop Windows (`.exe` installer + portable)

**Release strategy:** A single rolling GitHub release tagged `nightly` (marked as
prerelease). Each successful run deletes the previous nightly release and creates a new
one at the current `main` HEAD with all desktop artifacts attached. There are no
date-stamped nightly tags — the `nightly` tag always points to the latest build, and the
commit SHA is recorded in the release body for traceability.

## Branch Protection

Configure branch protection on `main` to require these status checks:

- `server-checks`
- `client-checks`
- `sdk-checks`
- `e2e-checks`
- `docker-checks`

All five use the gate job pattern: the gate succeeds when tests pass OR when tests were
skipped (no relevant changes). It fails only when tests actually fail. This means a
server-only change won't block on client checks, but a broken server will always block.

## Operational Notes

### Docker tag namespaces

The main-push workflows (`docker-server.yml`, `docker-web.yml`) and the nightly workflow
operate on separate tag namespaces. Pushing to `main` produces `:main` tags for immediate
deployment; the nightly produces `:nightly` tags as a stable daily snapshot bundled with
desktop builds. Both coexist without conflict.

### Auto-updater and prereleases

The Electron auto-updater (`electron-updater`) is configured with `allowPrerelease: true`
so that desktop installations receive nightly builds via the rolling prerelease. **This
should be revisited before public release** — end users should probably only receive
stable updates from tagged releases, not nightly prereleases.

### Code signing

Desktop builds are currently **unsigned**. macOS will show an "unidentified developer"
dialog and Windows will show SmartScreen warnings. This is acceptable for internal testing
but must be resolved before distributing to external users. Signing requires:
- **macOS:** Apple Developer account, notarization via `electron-builder`'s `afterSign` hook
- **Windows:** EV code signing certificate or Azure Trusted Signing
