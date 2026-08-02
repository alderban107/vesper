# Vesper deployment guide

This guide describes the supported public-beta deployment contract. Use `docker-compose.yml`, `turnserver.conf`, and `.env.example` from the **same release tag** as the app/web images. Do not copy old Compose fragments from issue comments or deploy mutable `main`/`latest` tags.

For the release, migration, canary, and rollback gates, read [`../docs/RELEASE-RUNBOOK.md`](../docs/RELEASE-RUNBOOK.md) before touching production.

## Supported topology

The bundled deployment is:

- one or more Phoenix application processes;
- PostgreSQL as the authoritative database;
- a same-origin, non-root nginx web edge;
- coturn on host networking for voice relay; and
- a persistent upload volume mounted at `/var/lib/vesper/uploads`.

The current release is **not mixed-writer compatible**. Do not run old and new application binaries against the same writable database. Multi-cohort topology mutation must remain disabled in production.

## Prerequisites

- Docker Engine with Compose v2
- a PostgreSQL and upload-volume backup destination
- a public HTTPS hostname for the web edge
- a public TURN hostname/address with TCP/UDP 3478 and UDP 50000–50100 reachable
- exact matching app and web release references

Resolve and record immutable image digests before deployment:

```bash
docker buildx imagetools inspect ghcr.io/alderban107/vesper-app:<version>
docker buildx imagetools inspect ghcr.io/alderban107/vesper-web:<version>
```

## Configuration

Copy the release template and set restrictive permissions:

```bash
cp .env.example .env
chmod 600 .env
```

At minimum configure:

```dotenv
VESPER_APP_IMAGE=ghcr.io/alderban107/vesper-app@sha256:<digest>
VESPER_WEB_IMAGE=ghcr.io/alderban107/vesper-web@sha256:<digest>
POSTGRES_PASSWORD=<random database password>
SECRET_KEY_BASE=<at least 32 random bytes>
METRICS_TOKEN=<at least 32 random bytes>
PHX_HOST=chat.example.com
CORS_ORIGIN=https://chat.example.com
PUBLIC_SCHEME=https

TURN_SERVER_URL=turn:turn.example.com:3478
TURN_EXTERNAL_IP=<public-ip-or-public-ip/private-ip-behind-NAT>
TURN_USERNAME=vesper
TURN_PASSWORD=<at least 32 random bytes>
TURN_REALM=chat.example.com
```

Production registration defaults to `closed`. To use invite-only registration, set both:

```dotenv
REGISTRATION_MODE=invite_only
REGISTRATION_INVITE_SECRET=<at least 32 random bytes>
```

Do not enable `VESPER_ENABLE_MULTI_COHORT_TOPOLOGY_MUTATIONS` for this release.

### Forwarded addresses

The bundled nginx edge overwrites `X-Forwarded-For` with the socket peer address, and Compose explicitly enables trusted proxy headers on the app. Direct/custom deployments ignore forwarding headers by default. If you build another trusted edge, it must overwrite—not append—client-controlled forwarding headers before you enable `TRUST_PROXY_HEADERS=true`.

### Upload storage

Uploads are durable only when `/var/lib/vesper/uploads` is backed up with the database. The default per-user aggregate quota is 5 GiB and upload creation is limited to 20 requests per hour per user. Override the quota with `MAX_UPLOAD_BYTES_PER_USER`; values below one 50 MiB upload are rejected.

The web edge permits ordinary request bodies up to 1 MiB and grants a 51 MiB multipart envelope only to the attachment route. Phoenix validates the actual uploaded file at 50 MiB.

## TURN relay

The bundled server uses coturn long-term credentials because Vesper currently returns a fixed username/password ICE credential. It intentionally does **not** use TURN REST shared-secret mode. Treat that beta credential as relay-only and rotate it on suspected disclosure. Coturn denies loopback, RFC1918, carrier-grade NAT, link-local, multicast, and reserved peer destinations so an authenticated client cannot use the relay as a path into the host's private network; the bundled total/user and bandwidth quotas also bound credential abuse.

`TURN_SERVER_URL` is delivered to remote clients, so `turn:coturn:3478` is invalid. If the relay is behind NAT, set `TURN_EXTERNAL_IP` in coturn's `public-ip/private-ip` form. A `turns:` URL requires certificates and TLS ingress configured separately; setting the URL alone does not enable TLS.

After deployment, prove relay behavior from outside the server's network. Host reachability is not enough: establish a WebRTC call with relay-only ICE policy and verify a `relay` candidate carries media in both directions. Repository maintainers can temporarily configure the `BETA_TURN_USERNAME`/`BETA_TURN_PASSWORD` Actions secrets and dispatch `validate-public-deployment.yml`; its GitHub-hosted Chromium proves relay-only UDP and TCP payload round trips and uploads sanitized evidence. Remove those temporary secrets after validation.

## Initial deployment

Pull and start the exact release set:

```bash
docker compose pull
docker compose up -d
```

The app command runs the release migration before starting Phoenix. Startup fails if the migration fails. The app then performs a read-only pending-version check for `/health`, even though `RUN_MIGRATIONS_ON_START=false` prevents each replica from running migrations itself.

Verify the stack:

```bash
docker compose ps
curl -fsS https://chat.example.com/health
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" \
  https://chat.example.com/metrics | head
```

Expected health fields are:

```json
{"status":"ok","migrations":"ok","database":"ok"}
```

Also verify:

- registration is `403` while closed;
- an unlisted Origin is denied for HTTP and WebSocket connections;
- uploads survive app/container replacement;
- the app process is non-root and cannot modify `/app`;
- the web process is non-root with a read-only root filesystem; and
- TURN relay media works from an external network.

## TLS termination

Terminate TLS at a trusted reverse proxy or load balancer in front of the web service. Proxy only to the host's configured `WEB_PORT`; the Phoenix app is intentionally not published by the bundled Compose file.

Set `PUBLIC_SCHEME=https`. The web container ignores inbound forwarding scheme headers and injects this trusted value when proxying to Phoenix.

Preserve WebSocket upgrade headers and use timeouts suitable for long-lived connections. Do not log `Authorization`, refresh tokens, `METRICS_TOKEN`, or TURN credentials.

## Upgrades

Use a maintenance window:

1. verify checksums, provenance, native signatures where applicable, and exact OCI digests;
2. restore the current database backup into an isolated rehearsal target;
3. run the new release migration and all API/SDK/browser recovery gates there;
4. back up the production database **and** upload volume;
5. stop every old writer and drain WebSockets;
6. run one release migration job;
7. start only new-version replicas; and
8. canary and monitor before broad traffic.

Do not use `mix ecto.rollback` as production rollback. Once new writers have emitted tenure-bound state, stop them and restore the rehearsed database/upload backup together.

## Multi-replica operation

For multiple application replicas, remove the per-container migration command and run `bin/vesper eval 'Vesper.Release.migrate()'` once as a deployment job while old writers are stopped. Keep `RUN_MIGRATIONS_ON_START=false` on replicas; health remains red if their release sees a pending migration.

Set `DNS_CLUSTER_QUERY` to a DNS A/AAAA name that returns every application replica; it is not an SRV record. Vesper normalizes the query to an absolute name so resolver search domains cannot change its meaning. All replicas must share `RELEASE_COOKIE` and the same `RELEASE_NODE` basename, while each node name uses its own discoverable IP (for example `vesper@10.0.0.12`). Verify `Node.list()` from every replica before relying on cross-node Phoenix PubSub.

The four-worker soak proves multi-process clients against one application/database deployment. It is not multi-region or database-failover evidence. Validate node loss, load-balancer behavior, PostgreSQL failover, and upload-storage consistency in your own canary before calling that topology supported.

## Monitoring and backups

Protect `/metrics` with `METRICS_TOKEN`. Alert on:

- health or migration status not `ok`;
- HTTP exceptions and p95/p99 latency;
- database queue latency;
- durable-dispatch failures, dead letters, backlog depth, and oldest backlog age;
- upload-volume utilization and quota rejections; and
- repeated authentication/recovery rate-limit events.

Back up PostgreSQL and the upload volume as one recoverable release point. Regularly restore both into an isolated environment and run message, attachment, leave/rejoin history-denial, restart, and second-device recovery checks.

## Troubleshooting

### `JWT_SECRET` startup failure

Unset/blank `JWT_SECRET` safely uses `SECRET_KEY_BASE`. An explicit JWT key shorter than 32 bytes fails startup. Replace it with a strong random value rather than weakening the check.

### `/health` reports `migrations=pending`

Run the exact release migration job against that database while writers are stopped. Do not mark the deployment healthy manually or set a bypass flag.

### uploads return `413`

Check whether the actual file exceeds 50 MiB, the multipart envelope exceeds 51 MiB, the user's aggregate quota is exhausted, or the trusted edge has a stricter request limit.

### voice connects directly but relay-only fails

Verify public DNS, firewall/NAT rules, `TURN_EXTERNAL_IP`, long-term username/password mode, realm consistency, and UDP relay ports 50000–50100. Test from outside the host network.

### a release workflow failed during publication

Leave the GitHub release draft, inspect both GHCR version tags, remove any partial final tag, and reconcile both registries before rerunning from the same immutable tag. See the runbook's failed-publication procedure.
