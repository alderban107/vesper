# Public-beta release runbook

A Vesper release is not ready because it compiles. The operator must be able to upgrade, observe, and roll it back without weakening message-tenure or MLS authorization.

## Required release inputs

- A tag exactly matching `client/package.json` (`v<version>`).
- macOS Developer ID certificate and notarization credentials:
  `MACOS_CSC_LINK`, `MACOS_CSC_KEY_PASSWORD`, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`.
- Windows Authenticode certificate:
  `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD`.
- Production runtime secrets of at least 32 random bytes where required:
  `SECRET_KEY_BASE`, `METRICS_TOKEN`, `TURN_PASSWORD`, and, when used,
  `REGISTRATION_INVITE_SECRET`.
- One or more explicit `CORS_ORIGIN` values. Wildcards and an unset value are rejected. Add the exact packaged renderer origin (`null` or `file://`, as observed on the target Electron platform) only when desktop access is required.
- `PUBLIC_SCHEME=https` when TLS terminates at a trusted reverse proxy in front of the Docker web service; caller-supplied forwarding headers are ignored.
- A tested PostgreSQL backup and a restore target separate from production.
- `VESPER_APP_IMAGE` and `VESPER_WEB_IMAGE` pinned to the same release version or immutable OCI digests. Production must not use `main`, `latest`, or a nightly artifact.

The release workflow fails closed if native signing/notarization credentials are absent. It publishes only after all three desktop platforms and both architectures of both container images pass, creates `SHA256SUMS`, verifies those checksums, emits GitHub build-provenance attestations, and publishes SBOM/provenance-bearing OCI manifests. The nightly workflow is validation-only and cannot publish public artifacts.

## Code gates

Run from a clean checkout of the exact release tag:

```bash
npm ci
npm audit --omit=dev
npm --prefix sdk run typecheck
VESPER_PERF_MULTIPLIER=5 npm --prefix sdk run test:integration

cd server
mix deps.get
mix hex.audit
mix deps.audit
mix compile --warnings-as-errors
MIX_ENV=test ./scripts/verify-history-upgrade.sh
mix test

cd ../client
npm ci --workspaces=false
npm audit --workspaces=false
npm run test:unit
npm run check:web
npm run build
```

The retained Playwright projects in `client/e2e/INVARIANTS.md` must pass against the release server. A green unit or SDK suite does not substitute for those browser/Electron boundaries.

## Database upgrade

1. Keep `VESPER_ENABLE_MULTI_COHORT_TOPOLOGY_MUTATIONS=false`.
2. Record current migration versions and dispatch backlog metrics.
3. Take a database backup and restore it into a disposable database.
4. Run the release migration against the restored copy:

   ```bash
   bin/vesper eval 'Vesper.Release.migrate()'
   ```

5. Start the new server with `RUN_MIGRATIONS_ON_START=false` and run the API, SDK recovery, and retained browser gates against the restored data.
6. Verify `/health` reports both `migrations=ok` and `database=ok`.
7. Verify no unexpected jump in pending-history, room-key, or durable-dispatch failures.
8. Stop old application writers and drain their WebSocket connections.
9. Run the same release task once against production, then start only new-version application replicas.

The Docker Compose path performs the migration as a fail-closed command before its replacement server starts. Multi-replica orchestrators should instead run it as one maintenance-window deployment job and keep `RUN_MIGRATIONS_ON_START=false` on every application replica.

The 2026-08-01 history-authorization migration intentionally deletes pending history requests and bundles because pre-migration rows cannot be bound to an application-tenure generation. Clients must recover by issuing fresh requests after upgrade. More importantly, the old binary does not maintain the new application-tenure records when it processes membership changes. **This release is therefore not rolling-upgrade or mixed-writer compatible.** Do not run old and new application binaries against the same writable database, and do not roll binaries backward after new binaries have written tenure-bound recovery state. Restore the rehearsed backup instead.

## Canary and rollback

1. Deploy the exact release images to an isolated canary environment restored from a production backup; do not mix versions against the production writer database.
2. Keep topology mutation disabled.
3. Send channel and DM messages, restart both clients, recover a second device, and exercise leave/rejoin history denial.
4. Run the four-worker recovery soak, the single-process multi-cohort chaos gate, and retained browser/Electron boundaries against the canary.
5. Observe the canary for at least one representative traffic interval.
6. Promote only while error rate, request latency, database queue time, dispatch failure rate, and dispatch backlog remain within the deployment's baseline.

For rollback after production writers start, stop writers and restore the rehearsed pre-upgrade database and upload-volume backup. Do not improvise a destructive `mix ecto.rollback` or run the old binary against post-upgrade writes.

## Monitoring

Prometheus metrics are available at `/metrics` with `Authorization: Bearer <METRICS_TOKEN>`. At minimum alert on:

- non-zero sustained `vesper_dispatch_failed_count`, especially dead-lettered events;
- increasing `vesper_dispatch_backlog_depth` or oldest age;
- HTTP exception rate;
- p95/p99 HTTP and database latency relative to the established baseline;
- repeated health-check failures or any migration status other than `ok`.

Do not put `METRICS_TOKEN` in browser configuration or reverse-proxy logs. The metrics route rejects missing, short, and incorrect tokens with a constant-time comparison for equal-length candidates.

## Artifact verification

Download all release assets and then run:

```bash
sha256sum --check SHA256SUMS
```

Also verify the GitHub artifact attestation, macOS code signature/notarization, and Windows Authenticode signature before distributing links. A checksum proves integrity relative to the release manifest; the signatures and provenance establish who produced it.

Resolve and pin the published container digests rather than relying on a mutable tag:

```bash
docker buildx imagetools inspect ghcr.io/alderban107/vesper-app:<version>
docker buildx imagetools inspect ghcr.io/alderban107/vesper-web:<version>
```

Set the resulting references in `VESPER_APP_IMAGE` and `VESPER_WEB_IMAGE`, then archive those digests with the deployment record.
