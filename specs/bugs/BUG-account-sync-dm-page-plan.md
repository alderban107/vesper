# Large-account DM pagination scans every conversation

## Reproduce

Run `npm --prefix sdk run profile:account-sync` against local PostgreSQL. The physical fixture contains one account in 250 servers with 50,000 direct DMs and 5,000 group DMs. The first DM page returns 101 ordering rows but takes 52.519ms and touches 670,948 shared buffers, exceeding both account-profile budgets.

A prior identical-size run chose a different parallel hash plan and touched 24,413 buffers in 37.36ms. The endpoint remained one request and returned only 100 conversations, but database cost and plan shape were unstable.

## Isolate

`Vesper.Chat.list_conversations_page/2` joins the user's `dm_participants` rows to all matching `dm_conversations`, then performs 55,000 lookups into `rooms` so it can order by `COALESCE(room.last_message_at, conversation.inserted_at)`. PostgreSQL must materialize and sort the full account set before applying `LIMIT 101` because the ordering expression crosses two tables.

The failing plan performs a bitmap scan for all 55,000 user participant rows, a sequential scan of all 55,000 conversations, and 55,000 `rooms_conversation_id_index` probes. The profiler records 220,000 scan rows and 55,001 index-probe loops.

## Hypothesize

1. **Primary: the cross-table activity expression makes the page order non-indexable.** Falsification: an index can satisfy the exact `COALESCE(room.last_message_at, conversation.inserted_at), conversation.id` order without materializing the user's full set.
2. **The missing participant composite index causes the scan.** Falsification: the database already has `(user_id, conversation_id)` and the bad plan still materializes all 55,000 matching memberships.
3. **The cost is only a cold-cache artifact.** Falsification: both recorded plans have zero shared reads and operate entirely from shared-buffer hits.

## Verify

The physical `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` confirms the root cause. Output size, request count, local snapshot size, warm rendering, delta sync, cursor expiry, and second-device convergence all pass their budgets; only DM ordering exceeds its latency and shared-buffer gates. The invariant for the fix is that one DM page must perform bounded work close to the page size without introducing per-room-member writes on each message.
