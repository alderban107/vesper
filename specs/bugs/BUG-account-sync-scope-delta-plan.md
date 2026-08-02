# Large-account scope delta can multiply the full DM membership set by the event window

## Reproduce

Run `npm --prefix sdk run profile:account-sync` with 50,000 direct DMs, 5,000 group DMs, 100 relevant changes, and 10,000 unrelated scope events.

The bounded delta request took 12.546 seconds. Its matching `EXPLAIN (ANALYZE, BUFFERS)` took 23.117 seconds, exceeded the 25 ms SQL budget, and reported 555,565,100 scanned rows despite returning 100 events.

## Isolate

`Vesper.Sync.relevant_scope_events_query/4` switches to a materialized `user_dm_scopes` CTE when the global event-ID window exceeds 5,000. PostgreSQL chose the scope-event primary-key scan as the outer input and rescanned all 55,000 materialized DM memberships for each of 10,100 candidate events.

The plan stayed entirely in shared buffers (`sharedReadBlocks = 0`), so disk pressure and cold-cache I/O do not explain the failure. Other account and history queries remained within budget.

## Hypothesize

1. **Primary: the adaptive materialized-membership branch permits an unindexed CTE nested loop whose work is account membership count multiplied by candidate event count.** Falsification: the plan performs bounded indexed membership probes and never rescans the whole 55,000-row set per event.
2. **Host CPU contention alone caused the latency.** Falsification: the plan's 555,565,100 logical scanned rows explain the order-of-magnitude failure independently of host load.
3. **The new user-targeted read-event path changed scope event volume.** Falsification: the profiler's explicit SQL reads `scope_sync_events` and `dm_participants`; user read events are stored in `user_sync_events` and are absent from this plan.

## Verify

Confirmed root cause: the materialized CTE was used as the inner side of a nested loop with 10,100 loops. The invariant is that DM scope authorization work must scale with the bounded candidate event window, never with `account DM count * event window`.

The adaptive branch was removed. Both production and profiler queries now use the direct `(user_id, conversation_id)` participant join. The full physical profile with 55,000 conversations, 10,100 candidate scope events, and 92,570 stored messages completed the scope-delta SQL in 8.904 ms. The plan scanned 10,100 candidate rows, performed indexed membership probes, returned the bounded page, and passed all budgets.
