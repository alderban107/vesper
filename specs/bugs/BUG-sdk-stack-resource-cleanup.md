# SDK test stacks leak databases and artifacts when lifecycle ownership ends early

## Reproduce

Environment: macOS, Node SDK integration/load harness, local PostgreSQL on `127.0.0.1:5432`, Docker auto-start disabled.

1. Run the SDK chaos/load command repeatedly or interrupt it during stack bootstrap.
2. Inspect PostgreSQL databases matching `vesper_test_sdk_%` and `packages/sdk/artifacts/*`.
3. Observe partition databases and Phoenix logs that remain after the owning Node command has exited.
4. Repeated leaked partitions and logs eventually exhaust the host disk and make subsequent tool processes fail with `ENOSPC`.

## Isolate

`bootServerStack` creates the partition database and artifact directory before starting Phoenix, but it has no rollback path if migration, process startup, or health polling throws. Both `run-chaos-load.mjs` and `run-chaos-soak.mjs` call the asynchronous `teardownServerStack` in `finally` without `await`, so the command can finish while database drop and artifact deletion are still pending.

The Node test files do await teardown in their `t.after` hooks. The leak is therefore isolated to failed bootstrap and the two executable load drivers, not the common successful test teardown path.

## Hypothesize

1. **Primary: lifecycle resources have no single awaited owner through both bootstrap failure and normal shutdown.**
   - Prediction: awaiting teardown in both drivers and rolling back partial bootstrap leaves no partition database or artifact directory after the command exits.
   - Falsification: resources remain after a successful command despite awaited teardown, or a deliberately failed bootstrap cleans itself without new rollback logic.
2. **PostgreSQL refuses database drops because Phoenix still owns connections.**
   - Prediction: teardown reaches `mix ecto.drop` but logs a drop failure while the child remains alive.
   - Falsification: the child exits before the drop and the unawaited promise is the only missing sequencing edge.
3. **Artifact retention is intentional configuration.**
   - Prediction: `VESPER_SDK_KEEP_ARTIFACTS=1` is set during the leaking runs.
   - Falsification: the variable is unset and normal teardown would remove artifacts if allowed to finish.

## Verify

Confirmed root cause: resource creation and cleanup were split across promises without one owner awaiting the complete lifecycle. The load and soak drivers discarded the teardown promise, and bootstrap exceptions bypassed teardown entirely. The teardown implementation already terminates Phoenix before dropping PostgreSQL and only preserves artifacts when `VESPER_SDK_KEEP_ARTIFACTS=1`, which falsifies the connection-order and intentional-retention alternatives.

The fix makes `bootServerStack` transactional with respect to its external resources: on any bootstrap exception it terminates the child if started, closes the log stream, drops the partition database, and removes the artifact directory. Both executable drivers await the same teardown promise in `finally`. Verification requires a successful load command followed by zero `vesper_test_sdk_%` databases and zero retained default artifacts.
