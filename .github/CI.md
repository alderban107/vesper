# CI / CD pipelines

This document describes every GitHub Actions workflow in the repository, what triggers it, and what it is allowed to publish.

## Change detection

All branch test workflows diff the branch HEAD against its merge-base with `main`. The check therefore covers the full branch, not only the latest push. If no merge-base can be found, the workflow runs as a fail-safe.

Every test workflow ends in a stable gate job. Branch protection should require the gate jobs rather than conditional worker jobs.

## Branch protection gates

These workflows run on pushes to non-`main`, non-tag branches:

### `test-server.yml` — `server-checks`

Runs for non-Markdown changes under `server/`. It uses pinned PostgreSQL 17, audits Hex dependencies, compiles with `--warnings-as-errors`, verifies the history-authorization migration upgrade path, and runs the complete server test suite.

### `test-client.yml` — `client-checks`

Runs for non-Markdown changes under `client/` or `sdk/`. It audits the client dependency tree, runs Vitest, performs strict TypeScript checks, and builds the web client.

### `test-sdk.yml` — `sdk-checks`

Runs for relevant server, client, SDK, script, or workflow changes. The SDK harness starts a pinned PostgreSQL image and isolated Phoenix instances. It runs the live SDK integration suite and the multi-cohort chaos gate with CI-adjusted performance thresholds.

### `test-e2e.yml` — `e2e-checks`

Runs the retained Playwright projects in one shared harness invocation. Playwright executes `p0-smoke` first as the dependency for `p1-extended` and `p2-reliability`, preserving the users, recovery keys, database, and browser state those projects intentionally share. Failure traces, screenshots, video, and logs are uploaded.

### `test-docker.yml` — `docker-checks`

Builds the server and web Dockerfiles without pushing whenever code or container infrastructure changes.

Require all five gate jobs on `main`:

- `server-checks`
- `client-checks`
- `sdk-checks`
- `e2e-checks`
- `docker-checks`

A gate succeeds when its worker passed or was correctly skipped because no relevant files changed. A failed or cancelled worker fails the gate.

## Publication workflows

Publication authority is deliberately split between snapshots and releases.

### `docker-server.yml` and `docker-web.yml` — attested snapshots

A push to `main` builds native `linux/amd64` and `linux/arm64` images and publishes multi-architecture `main` and `sha-*` snapshot manifests:

- `ghcr.io/<owner>/vesper-app`
- `ghcr.io/<owner>/vesper-web`

These workflows emit SBOMs and build provenance, but they do not publish versioned production tags. Operators must not deploy mutable `main` tags as releases.

### `release.yml` — stable release gate

This workflow is manually dispatched from an existing `v<version>` tag, with the same tag supplied as its input. It fails unless the selected ref, checked-out commit, GitHub workflow identity, and `client/package.json` version agree.

The release gate performs, in order:

1. server and SDK audits, warnings-as-errors compilation, migration verification, server tests, and live SDK protocol tests;
2. native desktop builds for Linux, macOS x64/arm64, and Windows;
3. mandatory macOS signing/notarization and Windows Authenticode verification;
4. native amd64/arm64 candidate builds for both container images, each with SBOM and provenance;
5. release-set validation, checksums, GitHub build-provenance attestation, and a complete draft GitHub release;
6. publication of versioned multi-architecture container manifests;
7. conversion of the verified draft into a public release.

If required signing credentials or any platform artifact are absent, no public GitHub release is created. Follow `docs/RELEASE-RUNBOOK.md` for credentials, canarying, migration, verification, and rollback.

### `nightly.yml` — distributed recovery validation only

Nightly runs at 06:00 UTC or by manual dispatch. It executes the four-worker recovery soak against a pinned PostgreSQL fixture and retains JSON evidence for 14 days.

Nightly has read-only repository permissions. It does not create tags, releases, desktop binaries, or container images. This prevents unsigned rolling artifacts from bypassing the stable release gate.

## Performance thresholds

Some SDK tests contain hard latency assertions. GitHub-hosted runners are slower and noisier than local hardware, so CI sets `VESPER_PERF_MULTIPLIER=5`. Local runs default to `1` and should continue to meet the stricter thresholds.

The multiplier absorbs runner variance; it is not permission to ignore order-of-magnitude regressions. Nightly and release evidence must report the actual observed latencies alongside the configured threshold.

## Supply-chain rules

- GitHub Actions are pinned by full commit SHA.
- CI service images and Docker base images are pinned by digest.
- Stable desktop and versioned OCI artifacts come only from `release.yml`.
- Production Compose deployments require explicit release images through `VESPER_APP_IMAGE` and `VESPER_WEB_IMAGE`; mutable `main`, `latest`, and former nightly tags are not release inputs.
- The Electron updater follows stable signed releases (`allowPrerelease=false`).
