# CI / CD Pipelines

This document describes all GitHub Actions workflows in the repository, what triggers
them, and what they produce.

## Workflows

### `test-client.yml` — Client Checks

Runs on pushes to non-main, non-tag branches when files under `client/` change.
Executes `npm run check:web` (TypeScript typecheck + Vite web build). The `client-checks`
job is a branch protection gate.

### `test-server.yml` — Server Tests

Runs on pushes to non-main, non-tag branches when files under `server/` change.
Spins up PostgreSQL 17, compiles with `--warnings-as-errors`, and runs `mix test`. The
`server-tests` job is a branch protection gate.

### `docker-server.yml` — Server Docker Image

Triggers on push to `main` or `v*` tags when `server/` changes. Builds multi-arch
(amd64 + arm64) images using native runners (no QEMU), then stitches a manifest list.

- **Registry:** `ghcr.io/<owner>/vesper-app`
- **Tags:** `main`, semver patterns, `sha-<short>`

### `docker-web.yml` — Web Client Docker Image

Same structure as the server workflow but for `client/` changes.

- **Registry:** `ghcr.io/<owner>/vesper-web`
- **Tags:** `main`, semver patterns, `sha-<short>`

### `release.yml` — Tagged Release (Desktop)

Triggers when a GitHub release is created, or via manual `workflow_dispatch` with a tag
input. Builds Electron desktop apps on Linux, macOS, and Windows runners, then attaches
the binaries to the GitHub release.

**Outputs:** `.AppImage`, `.deb`, `.dmg`, `.exe`

### `nightly.yml` — Nightly Release

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
