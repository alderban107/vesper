# SDK Chaos And Scale Plan

This is the current engineering target for SDK-first sync, multi-device recovery, and high-load validation.

## What is already in place

- SDK-first device and chat harnesses live in `sdk/src/testing`.
- The SDK integration stack can run against a dedicated local Postgres instance on port `55432` through the scripts in `sdk/scripts`.
- Channel and DM unread hot paths now track `last_read_seq` and use `room_seq` comparisons in [`server/lib/vesper/chat.ex`](/Users/pp/code/vesper/server/lib/vesper/chat.ex).
- The SDK chaos suite covers:
  - same-user offline catch-up
  - trusted relogin restore
  - shared-channel catch-up
  - long and short channel histories across multiple devices
  - alternating multi-sender channel backlog restore
  - DM restore across relogin
  - join/leave/rejoin churn

## Current validation limits

Membership leave, kick, and rejoin now use durable sponsor intents, fenced leases, batched device removals, and generation checks. An old eviction cannot complete after a user rejoins. Legacy peer-history recovery checks exact device membership-generation intervals, so current membership does not authorize ciphertext sent while the device was absent.

The SDK load runner now creates physical multi-cohort rooms, authenticated wrapping keys, staged room-key epochs, durable cutovers, room-key application traffic, reconnects, and bounded restores. The July 2026 CI-sized fixture used 6 users, 9 actor devices, 10 physical participants, 2 rooms, 6 cohorts, and 6 room-key envelopes. It sent 280 messages with 280 application fanout publishes, zero failures, zero decrypt failures, zero restore misses, and no repair events. Measured p95 values were 44.43 ms send acknowledgement, 86.67 ms sampled delivery, 98.53 ms reconnect restore, 126.74 ms login restore, 15.46 ms scope sync, and 49.76 ms wide restore.

These are deterministic local regression results, not proof of 50k or 500k concurrent production users. The `simulatedUsers` field weights logical operations for budget accounting; it does not create that many sockets, devices, PostgreSQL connections, or geographic network paths. Distributed load, multi-node failover, regional latency, and production hardware saturation remain unverified.

## Shipped protocol invariants

- Apply Welcome before later commits and replay durable control events in sequence.
- Persist group state, replay cursor, and pending control intents through one atomic checkpoint write.
- Serialize cohort MLS mutations separately from room application replay so room-key derivation cannot recurse into the same non-reentrant lock.
- Fetch current hot state through bounded scope queries; page older history incrementally.
- Keep pre-cutover ciphertext on its immutable MLS group and use `vesper-room-v1` only after the durable topology cutover event.
- Assign one user's trusted devices to one cohort and publish one opaque room-key envelope per cohort.
- Treat duplicate requests as idempotent, stale fencing tokens as conflicts, incomplete envelope sets as non-activatable, and corrupt or missing state as explicit repair.
- Await test-stack teardown and roll back failed bootstrap so local partition databases and Phoenix artifacts do not accumulate.

## Performance work that matters most next

### Server

- Keep unread math on `room_seq` and extend that style to other restore queries where possible.
- Add direct metrics around:
  - channel message fetch duration
  - DM message fetch duration
  - durable MLS event fetch duration
  - pending welcome fetch duration
  - websocket broadcast fanout latency
- Validate indexes against the actual sync queries before adding more speculative ones.

### SDK/client

- Avoid redundant scope refreshes during bootstrap and resync.
- Keep join and restore readiness event-driven instead of time-gated.
- Separate “ready to send latest traffic” from “fully restored long backlog” so a device is not blocked on work it does not need yet.
- Move expensive cache and search-index writes off the immediate decrypt path where possible.

## Chaos matrix to keep growing

- Same user with 3-5 trusted devices, mixed online and offline, long and short backlogs.
- Alternating senders into one offline device’s backlog.
- DM restore after one device logs out and later logs back in.
- Server join, leave, rejoin, and multi-device resubscription.
- Large history restore after one device loses local state but keeps a trusted session.
- Mixed scopes per user: several servers, several DMs, active and dormant channels.

## Honest validation path for 500k-class load

1. Keep the current SDK harness for correctness and local regression coverage.
2. Add service-level metrics and trace points for sync and MLS endpoints.
3. Run compressed-cohort load first to find query and fanout hot spots.
4. Move to distributed load generation before making any 500k claim.
5. Report separate numbers for:
   - latest-message sync
   - backlog restore
   - websocket delivery
   - end-to-end decrypt completion

The goal is simple: fast latest sync, bounded backlog restore, true multi-device recovery, and no privacy promises that depend on wishful thinking.
