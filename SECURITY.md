# Security policy

Vesper is pre-1.0 encrypted-messaging software. Public-beta builds should be treated as security-sensitive beta software, not as an independently audited replacement for mature messengers.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose message content, account sessions, server credentials, or other users. Use GitHub's private vulnerability reporting for this repository; if that form is unavailable, contact the repository owner privately through the contact route on their GitHub profile. Include affected versions, reproduction steps, impact, and any proposed mitigation. Avoid accessing data that is not yours and stop once the issue is demonstrated.

## Supported versions

Only the newest published release receives security fixes. Release artifacts are accepted only from the repository's release workflow. Always verify `SHA256SUMS` and GitHub build provenance. A release marked `unsigned-beta` intentionally lacks Apple Developer ID/notarization and Windows Authenticode trust; verify its attested `UNSIGNED-NATIVE-BUILDS.txt` disclosure and expect operating-system warnings. For a release using the `signed` policy, additionally verify native platform signatures. Linux packages rely on checksums and GitHub provenance rather than a separate native signature in either mode.

## Deployment defaults

Production configuration fails closed on several boundaries:

- registration defaults to `closed`;
- `CORS_ORIGIN` must list explicit origins and cannot contain `*`;
- `/metrics` requires a dedicated bearer token of at least 32 bytes;
- blank `JWT_SECRET` values fall back to the strong cookie secret, while explicit JWT keys shorter than 32 bytes fail startup;
- forwarding headers are ignored unless a trusted edge is explicitly enabled; the bundled edge overwrites, rather than appends, the client address;
- multi-cohort topology mutation is disabled unless explicitly enabled;
- Docker uploads use a persistent volume with per-user aggregate quota and upload-rate limits;
- the bundled TURN relay denies private/link-local/reserved peer destinations and applies allocation/bandwidth quotas to its shared beta credential;
- Docker migrations complete successfully before the application starts, and disabled startup migration still performs a read-only schema health check.

See `docs/RELEASE-RUNBOOK.md` for required secrets, migration rehearsal, monitoring, canarying, and rollback.
