# SDK Chaos And Scale Plan

This is the current engineering target for SDK-first sync, multi-device recovery, and high-load validation.

## What is already in place

- SDK-first device and chat harnesses live in `packages/sdk/src/testing`.
- The SDK integration stack can run against a dedicated local Postgres instance on port `55432` through the scripts in `packages/sdk/scripts`.
- Channel and DM unread hot paths now track `last_read_seq` and use `room_seq` comparisons in [`server/lib/vesper/chat.ex`](/Users/pp/code/vesper/server/lib/vesper/chat.ex).
- The SDK chaos suite covers:
  - same-user offline catch-up
  - trusted relogin restore
  - shared-channel catch-up
  - long and short channel histories across multiple devices
  - alternating multi-sender channel backlog restore
  - DM restore across relogin
  - join/leave/rejoin churn

## Current hard constraints

### Membership churn is not cryptographic churn yet

[`Vesper.Servers.leave_server/2`](/Users/pp/code/vesper/server/lib/vesper/servers.ex#L478) and [`Vesper.Servers.kick_member/3`](/Users/pp/code/vesper/server/lib/vesper/servers.ex#L498) delete membership rows and broadcast membership changes, but they do not create MLS remove commits for the affected channel scopes.

The chat and DM channels do support client-driven `mls_remove` events in:

- [`server/lib/vesper_web/channels/chat_channel.ex`](/Users/pp/code/vesper/server/lib/vesper_web/channels/chat_channel.ex)
- [`server/lib/vesper_web/channels/dm_channel.ex`](/Users/pp/code/vesper/server/lib/vesper_web/channels/dm_channel.ex)

That means the protocol has the pieces, but server-side leave and kick are still weaker than the privacy model we want. If a device leaves a server through the REST path alone, we are relying on application membership rules, not a fresh MLS epoch.

### 500k users cannot be “proven” by a toy loop

The current SDK load runner is useful for cohort compression and hot-path checks, but it is not evidence that the whole system can sustain 500k active users with sub-30ms behavior. That claim needs staged validation with real concurrency, proper metrics, and honest limits.

## Protocol work that still needs to land

### 1. Make server membership changes drive MLS removal

Needed outcome:

- Leave, kick, and ban must result in MLS remove commits for each encrypted scope the member still belongs to.
- Every surviving member must advance to a fresh epoch before the removed member can be considered fully out.
- The removed device must not be able to decrypt future traffic after the removal point.

Practical direction:

- Introduce a scope-removal coordinator that asks an online trusted member of each scope to author the remove commit.
- Persist “removal pending” state until at least one valid remove commit is durably recorded.
- Treat the REST membership delete as incomplete until the MLS side is finished or explicitly marked degraded.

### 2. Keep restore correctness tied to durable ordering

Restore must continue to obey:

- apply Welcome before replaying later commits
- replay durable commits in order
- fetch and decrypt messages oldest to newest by `room_seq`, then `inserted_at`, then `id`
- persist the scope cursor after each durable event sequence

The SDK harness already follows this ordering in the current restore path, and the chaos tests exercise that path directly.

### 3. Treat history restore as a bounded hot path

The latency target for “latest message” sync is realistic locally. Full history restore needs tighter rules:

- latest-message sync should stay on a narrow query path
- backlog restore should page and decrypt incrementally
- restore should not do repeated whole-scope refetches while MLS bootstrap is still unresolved
- local storage writes should not block every decrypt on the critical path

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
