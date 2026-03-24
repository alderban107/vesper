# E2EE Correctness And Scale Plan

Status note (2026-03-23):

- The branch that accompanies this document already implemented the immediate durability fixes, per-scope checkpoints, SDK-owned repair triggers, same-user history repair, External Commit durability, and sponsored transition durability described here.
- The sections below are now a mix of original RCA and the remaining scale plan, not a list of still-open correctness bugs.
- The main work left after this branch is large-room topology, broader message-outbox durability, and Discord-scale operational tuning.

This document covers the remaining work after `94c6de0`.

That commit fixed the three review items that started this thread:

- External Commit now persists local state before advertising the new epoch.
- Initial GroupInfo publish failure now fails scope creation instead of being swallowed.
- First GroupInfo publish now serializes on a per-scope advisory lock and returns a conflict instead of falling through to a unique-index crash.

Those fixes close the immediate holes. They do not yet give us a full "rocky network, many devices, many clients, long history" design.

The remaining job has four parts:

- remove the rest of the silent wedge cases
- move MLS repair ownership into the SDK
- bound recovery cost with checkpoints and tail replay
- stop using one fixed cohort shape for every room size

## Current truth

- The current branch is a solid small and medium scope base.
- It is still possible to wedge replay after a crash in the wrong spot.
- Some repair behavior still lives in renderer stores instead of the SDK.
- Message delivery durability is weaker than control-plane durability.
- A single MLS group per 50k to 250k member room is not a viable long-term shape.

## Non-negotiable invariants

- A scope either converges or enters explicit repair. It must not sit in a silent half-broken state.
- No control-plane mutation is considered complete until local durability and remote durability agree on what happened.
- Every replayable control-plane write has an idempotency key and a retry path.
- The SDK owns repair, resync, and same-user recovery. Consumers should not have to run protocol workflows in app state stores.
- Reconnect and restore fetch a checkpoint plus a bounded tail. They do not replay years of MLS and room history by default.
- Large rooms use the same architecture family with a different deployment topology.

## Confirmed remaining gaps

### 1. Replay can wedge after a crash between state persist and cursor persist

Current code still writes the MLS state and the durable replay cursor as separate durability boundaries:

- `sdk/src/client/encryptedChat.ts`
  - `setGroupState()`
  - `replayDurableEvents()`

Failure path:

1. durable commit `seq = N` is applied locally
2. `saveGroupState()` succeeds
3. process crashes before `saveGroupSyncCursor(N)`
4. restart fetches `N` again
5. replay tries to re-apply the same commit
6. duplicate handling is too coarse to classify it as safe
7. replay stops at the same event forever

This is a real permanent wedge.

### 2. Repair ownership still leaks into renderer code

Pending resync and history work is still driven partly by renderer stores:

- `client/src/renderer/src/stores/messageStore.ts`
- `client/src/renderer/src/stores/presenceStore.ts`

That means headless clients, background clients, or third-party SDK consumers can miss important repair work even if they use the SDK correctly.

### 3. Replay and commit handling do not distinguish duplicate, stale, corrupt, and recoverable states

Current code mostly reduces commit handling to `true` or `false`:

- `sdk/src/client/encryptedChat.ts`
  - `handleCommit()`
  - `processPendingCommits()`
  - `decryptForScopeWithRecovery()`

That is too little information. Duplicate commit replay, real divergence, stale state, missing Welcome, and corrupt local state need different handling.

### 4. We only journal part of the control plane

The current durable outbox work covers GroupInfo publish and external-commit broadcast. It does not yet cover the whole MLS control surface.

The remaining operations that need the same treatment:

- `mls_remove`
- `mls_welcome`
- `mls_history_bundle`
- same-user repair sends
- regular message sends

Relevant code:

- `sdk/src/client/encryptedChat.ts`
  - `deliverSponsoredTransition()`
  - `sendPayload()`
- `server/lib/vesper_web/channels/chat_channel.ex`
- `server/lib/vesper_web/channels/dm_channel.ex`
- `server/lib/vesper_web/channels/voice_channel.ex`
- `server/lib/vesper/encryption.ex`

`mls_commit` has idempotency. The rest of the control plane still needs the same standard.

### 5. One MLS group per room does not scale to very large rooms

For DMs and smaller encrypted channels, one MLS group per scope is fine.

For very large rooms it breaks down:

- add and remove churn rotates one giant tree
- each repair or membership change forces work onto every device in the room
- catch-up cost grows with room size and churn history
- a 250k member room cannot depend on every membership event being processed as one room-wide MLS transition

This is the big scale split. We should stop pretending one literal room topology fits all room sizes.

## Root causes

### Outbound work is still only partly modeled as an intent log

The right model is:

- persist intent
- perform remote write
- observe durable acceptance
- clear intent

We now do this for GroupInfo publish and external-commit broadcast. We need the same shape everywhere else that changes membership or user-visible delivery state.

### Inbound work is still only partly modeled as a checkpoint

The right model is:

- apply one durable event
- persist state and replay position together
- mark health state for the scope

Today state and cursor are separate. That opens the replay wedge.

### Repair is still call-driven instead of state-driven

The SDK tries a few recovery actions when certain methods happen to run. That is fragile. Repair needs its own durable state machine with explicit entry conditions and retry policy.

### Current room crypto topology assumes small groups

Single-group MLS gives strong semantics, but its cost profile tracks total room membership and churn. Discord-class rooms need a split between membership control and message fanout.

## Resolution pillars

### Pillar 1: per-scope transactional checkpoints

Introduce one durable checkpoint record per scope.

Each checkpoint stores:

- serialized local crypto state
- current epoch
- last durable MLS seq applied
- last room seq fully incorporated into the local cache
- current repair state
- current control-plane outbox entries for that scope
- metadata for pending retries and backoff

Storage APIs should move from separate primitives such as `saveGroupState()` and `saveGroupSyncCursor()` to one atomic checkpoint write.

Required adapters:

- IndexedDB
- file storage
- memory storage
- Electron bridge storage

Effect:

- replay crash wedge goes away
- repair state has a durable home
- reconnect recovery becomes deterministic

### Pillar 2: typed apply and replay outcomes

Replace boolean commit handling with explicit outcomes.

Minimum outcome set:

- `applied`
- `already_applied`
- `buffered_waiting_for_state`
- `needs_external_commit`
- `needs_same_user_repair`
- `corrupt_local_state`
- `fatal`

Rules:

- duplicate durable commits advance the replay cursor
- duplicate live commits do not poison the in-memory pending queue
- stale state moves the scope into repair instead of returning a generic failure
- fatal local corruption triggers reset plus repair, not indefinite retry

This removes several bug classes at once:

- crash-after-apply replay wedges
- duplicate replay stalls
- one bad pending commit blocking all later ones
- generic "false" with no repair choice

### Pillar 3: SDK-owned repair worker

Move all MLS repair logic into the SDK lifecycle.

The SDK should own:

- polling and handling pending resync requests
- polling and handling pending history requests
- polling and handling pending history bundles
- user-topic triggers such as `mls_history_request_pending`
- repair retries on reconnect
- stale scope quarantine and retry backoff

Renderer stores should only observe high-level state. They should not run protocol workflows.

Consumer-facing behavior should look like a normal chat SDK:

- scope is ready
- scope is repairing
- scope needs user attention
- message send is queued
- message send failed permanently

### Pillar 4: full control-plane outbox

Generalize the current GroupInfo and external-commit outbox work into one per-scope operation log.

Outbox entry types:

- publish GroupInfo
- broadcast commit
- broadcast remove
- send Welcome
- send history bundle
- send same-user repair package
- send message

Each entry needs:

- stable operation id
- scope id
- type
- payload
- expected epoch or precondition
- retry schedule
- last error

Server-side requirements:

- every replayable write accepts an idempotency key
- duplicate retries return the same durable record where possible
- fanout happens after durable acceptance

This is the main "one fix knocks out multiple issues" area. The same outbox model closes many crash, ack-loss, and reconnect bugs.

### Pillar 5: durable repair state machine

Each scope should have an explicit health state.

Suggested states:

- `healthy`
- `replaying`
- `waiting_for_welcome`
- `waiting_for_same_user_bundle`
- `waiting_for_external_commit`
- `needs_sponsor`
- `corrupt_local_state`
- `failed_manual_intervention`

Examples of transitions:

- duplicate replay event -> stay healthy and advance cursor
- stale local leaf -> reset local state and move to `waiting_for_external_commit`
- missing recent history on same user -> move to `waiting_for_same_user_bundle`
- repeated decrypt failure on fresh traffic -> move to `needs_sponsor`

The important behavior is simple:

- the SDK notices unhealthy scopes
- the SDK records what it is trying
- the SDK keeps working the repair plan after reconnect or restart
- the SDK only surfaces a hard failure after defined repair paths are exhausted

### Pillar 6: bounded restore and history fetch

Restoring a device should not mean:

- download all room history
- replay all MLS events since the beginning of time
- decrypt whole channels just to show the latest window

The restore model should be:

1. load trusted local checkpoint if it exists
2. fetch latest encrypted checkpoint metadata for the scope
3. replay MLS tail after `last_durable_mls_seq`
4. fetch the latest message window after `last_room_seq`
5. backfill older history only on scroll

For same-user new-device repair:

- use a same-user recovery package that contains current scope state, cursors, and a hot message window
- do not require years of ciphertext replay before the user sees the latest room state

For new members joining a room:

- keep the current policy of no automatic pre-join history access
- if historical access is ever added later, it must be an explicit room policy with its own crypto path

This keeps forward secrecy sane while making same-user restore fast.

### Pillar 7: one architecture, topology chosen by room scale

The SDK should expose one model.

Internally, the crypto topology should scale from the smallest case to the largest one without pretending one literal group shape fits everything.

### Topology A: single cohort MLS

Use for:

- DMs
- small private groups
- small and medium channels with limited churn

Keep the current model, with the checkpoint and repair work above.

This is the one-cohort case of the same architecture.

### Topology B: single cohort MLS with server-coordinated batching

Use for:

- larger rooms that are still small enough to keep one MLS group
- rooms where churn is bursty but not extreme

Add:

- sponsor lease for join and remove work
- batched remove commits
- short batching window for clustered membership changes
- stronger repair scheduling

This stretches the life of the current protocol shape without lying about its limits.

### Topology C: multi-cohort room crypto

Use for:

- very large rooms
- rooms with high churn
- any scope where one room-wide MLS tree becomes a hot spot

High-level design:

- split room membership into cohorts of bounded size
- each cohort keeps its own MLS group for membership and repair
- room messages use a room data-key epoch instead of one giant room-wide MLS leaf tree
- room data-key epochs are rewrapped per cohort rather than per member
- room join and remove touch one cohort plus room-key distribution, not one 250k-member MLS group

What this buys us:

- rotation cost scales with cohort count, not member count
- replay work scales with the cohorts a device belongs to, not the entire room
- membership churn is localized

What this changes:

- it is a larger-scale deployment of the same architecture family
- it needs explicit migration rules
- it should be introduced only after the single-group path is fully correct

### Topology D: broadcast-heavy specialization

For announcement-style or stage-style rooms, use a stricter variant of Topology C:

- few writers
- many readers
- room-key rotation optimized for read-mostly traffic

Voice should likely remain its own tighter-latency topology even when text chat for the same room uses cohorts.

## Server-side work needed for correctness and scale

### 1. Sponsor coordination

The server should assign repair and membership work instead of hoping many clients race politely.

Needed pieces:

- sponsor lease with expiry
- conflict-safe claim and completion
- batched remove queue
- resync dedupe per requester device
- retry handoff if sponsor disappears

This extends the current eviction queue work in `server/lib/vesper/encryption.ex` into a fuller membership coordinator.

### 2. Durable event and fanout separation

Live broadcast should not be the durability boundary.

Required model:

- request appends durable event or pending artifact
- server confirms durable acceptance
- broadcast is dispatched from durable state
- duplicate client retry returns the same durable object

This is especially important for:

- `mls_remove`
- `mls_welcome`
- `mls_history_bundle`
- regular messages

### 3. Partitioned history and hot projections

Large history needs separate paths for:

- latest window reads
- incremental backfill
- durable MLS replay
- unread and summary projections

Keep:

- append-only room event storage by `room_seq`
- append-only MLS control log by durable MLS seq
- hot summary tables for latest message, unread, and membership projections

Do not force restore to scan cold history partitions just to show the current room state.

## Fault injection and observability

We need failure testing around the actual durability boundaries, not just happy-path multi-device churn.

### Client fault matrix

- crash after checkpoint state write but before cursor advance
- crash after queueing outbox entry but before send
- crash after server accepted write but before local clear
- duplicate live commit delivery
- out-of-order durable replay page boundaries
- corrupt local checkpoint
- missing or stale GroupInfo
- repeated decrypt failure on fresh traffic

### Server fault matrix

- durable write succeeds, socket ack is dropped
- duplicate idempotency key retry
- sponsor lease holder disappears mid-repair
- first publish race on empty scope
- reconnect storm on one hot room
- history bundle or Welcome stored but not broadcast
- broadcast succeeds but client ack is lost

### Metrics to add

- scope repair state counts
- replay stall count
- duplicate durable event count
- outbox depth and age by type
- repair success and failure by path
- sponsor lease claim latency
- batch remove size
- pending artifact age
- latest-window sync latency
- checkpoint restore latency

Current telemetry in `server/lib/vesper_web/telemetry.ex` is a base. It needs MLS and restore-specific metrics.

## Phased implementation plan

### Phase 0: finish the immediate correctness layer

Scope:

- transactional per-scope checkpoints
- typed replay outcomes
- move resync and history repair ownership into the SDK
- add scope repair state machine
- extend outbox and idempotency to `mls_remove`, `mls_welcome`, and `mls_history_bundle`

Primary files:

- `sdk/src/client/encryptedChat.ts`
- `sdk/src/crypto/storage.ts`
- `sdk/src/crypto/indexedDbStorage.ts`
- `sdk/src/storage/file.ts`
- `sdk/src/storage/memory.ts`
- `server/lib/vesper/encryption.ex`
- channel handlers in `server/lib/vesper_web/channels/`

Exit criteria:

- replay cannot wedge on a duplicate durable commit after restart
- SDK can repair same-user scopes with no renderer help
- every replayable control-plane write survives ack loss and reconnect

### Phase 1: server-coordinated sponsor and repair work

Scope:

- sponsor leases
- resync dedupe and retry handoff
- batched remove queue
- durable completion markers for repair tasks

Exit criteria:

- concurrent sponsors do not create repeated remove storms
- one sponsor disappearing does not strand the repair forever

### Phase 2: message delivery durability and bounded restore

Scope:

- durable message outbox
- latest-window restore path
- lazy backlog backfill
- same-user recovery package with hot state only

Exit criteria:

- restart after `new_message` enqueue does not lose an unsent message
- reconnect to a long-history room shows the latest window without full replay

### Phase 3: storage, fanout, and history scaling

Scope:

- history partition strategy
- hot projections for latest reads and unread
- durable event to fanout dispatch separation
- restore query tuning and telemetry

Exit criteria:

- latest-window sync and backlog backfill use separate query paths
- room history growth does not make hot reconnect path unbounded

### Phase 4: large-room topology

Scope:

- room topology metadata
- cohort membership service
- cohort-based room-key distribution
- migration plan from single MLS rooms

Exit criteria:

- room churn cost scales by cohort count
- large-room traffic no longer depends on one giant room-wide MLS tree

### Phase 5: fault injection, soak, and rollout gates

Scope:

- expand `sdk/test/multi-device-chaos.test.mjs`
- expand `sdk/scripts/run-chaos-load.mjs`
- add server chaos tests for idempotency, sponsor leases, and dropped acks
- add rollout alarms for repair backlog, outbox age, and replay stalls

Exit criteria:

- defined fault matrix passes in CI or nightly soak
- rollout is blocked automatically if repair backlog or replay stall rates cross budget

## One change that solves multiple issues

Three pieces remove a large part of the remaining risk:

1. transactional scope checkpoints
2. a full per-scope outbox with idempotency
3. a durable SDK repair worker

Together they fix or sharply reduce:

- crash-after-apply wedges
- duplicate replay stalls
- missed repair work after reconnect
- renderer coupling
- partial control-plane sends
- message loss after local success but before server ack

## What "Discord scale" means here

We should be direct about this:

- after `94c6de0`, the system is much safer for small and medium encrypted scopes
- it is not yet Discord-scale E2EE
- it can get there only by completing Phase 0 through Phase 5
- the key architectural step is the room-topology split inside one unified architecture, because very large rooms need cohort-based crypto and bounded restore paths

That is the path that makes the SDK look normal to consumers while still being correct under crashes, retries, multi-device churn, and large history.
