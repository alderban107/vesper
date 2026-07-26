# Prepared cohort migration stalls after prior multi-cohort use

## Reproduce

Environment: macOS, Node SDK integration harness, local PostgreSQL on `127.0.0.1:5432`, one live Phoenix test stack per test, Docker auto-start disabled.

Minimal sequence:

1. Run `sdk isolates MLS control state by assigned room cohort`.
2. In the same Node process, run `sdk migrates a populated room through one durable cutover without losing mixed history`.
3. The first test passes.
4. The migration test creates the legacy room, prepares two cohorts, joins the first `crypto:cohort:*` topic, and then does not complete within ten minutes.

Control observation: the migration test passes in about seven seconds when run alone. The two-test sequence reproduces the stall. No Phoenix or Node test process remained after the interrupted run.

## Isolate

The two-test sequence stalls after the migration clients have joined the room and after one prepared cohort topic reports a successful socket join. A native `sample` of the Node test worker shows the JavaScript main thread idle in `uv__io_poll`/`kevent`; the process is waiting on an unresolved asynchronous operation rather than spinning in WebAssembly or blocking the event loop.

Binary-search probes confirmed that legacy synchronization, the topology prepare request, all prepared-topology fetches, either cohort's creator path, and the first cohort's complete member join all finish. Creating both cohort groups without joining a member also finishes. The stall requires this order: create cohort A, external-commit another member into cohort A, then create cohort B.

The cohort order can be reversed without changing the result. The defect is therefore not tied to one user, one cohort ordinal, legacy-room ownership, or a particular prepared group ID. The first external commit into any prepared cohort leaves shared server or client process state that blocks the next independent cohort preparation.

## Hypothesize

1. **Primary: the prepared-cohort external-commit path leaves a server-side transaction or coordination lock open at room scope.**
   - Prediction: during the stall, PostgreSQL or the Phoenix process shows the second preparation waiting behind work created by the first cohort join.
   - Falsification: the server has no waiting query/process and responds normally to independent requests.
2. **A client-global MLS control promise survives the first prepared cohort join and is incorrectly shared across group IDs.**
   - Prediction: the second client is idle before its network request, or an SDK map/queue contains a promise keyed without the cohort ID.
   - Falsification: the second client sends its request and waits on the server while all SDK coordination maps are group-keyed.
3. **The first cohort join emits a room-wide control event that is routed through the legacy room and starts unintended work for cohort B.**
   - Prediction: server logs show a cohort commit dispatched on the room topic or cohort-B work before its explicit creator call.
   - Falsification: commit storage and fanout are strictly cohort-scoped.

## Verify

Confirmed root cause: `syncScope` serialized the entire fetch, replay, and application-decryption pipeline under the current MLS group lock. After durable cutover, a receiver without the room key entered `syncScope`, held its cohort lock, and then called `loadActiveRoomDataKey`. That method derives the cohort wrapping key through `deriveScopeCohortWrappingKey`, which acquires the same non-reentrant lock. The queue therefore waited on itself.

The timing dependence is explained by the live application path: if the post-cutover event arrived first, it derived and cached the room key without an outer cohort lock, so the later sync did not recurse. Diagnostic delays made that path win and hid the defect. In the failing run, PostgreSQL showed no active or waiting transaction, while repository state showed both cohort GroupInfos, an active generation-2 topology, cutover at room sequence 2, and a post-cutover room-key message at sequence 3. Migration had completed; only receiver replay was blocked.

The fix separates lock ownership by plane:

1. Room application replay and live application events serialize on an `application:<room_id>` lock.
2. MLS membership and durable control replay acquire the assigned group lock only for the control mutation, then release it before application decryption.
3. Legacy ciphertext decryption acquires the immutable message `encryption_group_id` lock itself.
4. Room-key decryption may acquire the current cohort lock to derive wrapping material without recursing.
5. Historical recovery carries the original group ID through bundle lookup and decryption after cutover.

Verification: the exact uninstrumented two-test sequence stalled repeatedly before the fix and completed after the fix with 2/2 tests passing in 12.2 seconds. SDK typecheck also passes.
