# Multi-cohort load bootstrap aborts on one retryable creator result

## Reproduce

Run the Phase 13 physical fixture with 6 users, 9 actor devices, 2 active rooms, target cohort size 3, and Docker disabled. One run completes; a subsequent identical run fails before the timed phase with `Could not create load cohort <id>` because `prepareCohortTopology(topology, true)` returned false once.

## Isolate

The failure is inside the load driver. Peer cohort members already use `waitFor` around `prepareCohortTopology(..., false)`, but the first member uses a single `prepareCohortTopology(..., true)` attempt and throws immediately. The operation covers socket readiness, group creation, GroupInfo publication, and signed wrapping-key publication; each substep is idempotent and may return false while a retryable publication is still in flight.

## Hypothesize

1. **Primary: the driver incorrectly treats retryable idempotent cohort creation as a one-shot action.**
   - Prediction: bounded retry of the same creator operation converges without changing topology IDs or creating duplicate cohorts.
   - Falsification: repeated calls continue failing until timeout or create conflicting durable state.
2. **The selected creator is not authorized for its prepared cohort.**
   - Prediction: every retry fails deterministically with authorization errors.
   - Falsification: the same fixture sometimes completes, and topology resolution assigned that exact user/device to the cohort.
3. **The topology preparation produced duplicate or corrupt cohort rows.**
   - Prediction: retries conflict on group identity or envelope count.
   - Falsification: server topology tests prove locked unique assignment and the successful run produced exactly 6 cohorts and 6 envelopes.

## Verify

Confirmed root cause: the load driver violated the protocol's retry contract. Prepared cohort creation is idempotent, but only peer joins were polled; creator publication aborted on the first false result. The identical fixture's success/failure variation rules out deterministic authorization or topology corruption.

The fix is bounded convergence polling for the creator under the existing bootstrap timeout. It does not weaken the timeout or assertions and cannot duplicate durable state because group creation, GroupInfo publication, wrapping-key publication, and topology preparation are idempotent by key and generation.
