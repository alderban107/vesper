# MLS Bootstrap Cohorts And Eviction

This is the next level of scale work after the current SDK-first restore path.

## What We Fixed First

- Restore now prefers lean payloads and `after_seq` deltas.
- The SDK keeps `room_seq` in local cache and resumes from the last good point.
- Latest-message reads come from room summaries instead of scanning message history.
- Mutation sync can short-circuit off `rooms.last_mutation_seq` and `rooms.last_mutation_at`.

That gets the steady-state path into good shape. The next hard parts are cohort joins and cryptographic eviction.

## MLS Bootstrap Cohorts

The bad shape is every device joining a busy scope at once and each existing member reacting independently. That creates:

- repeated `mls_request_join` fanout
- extra commit work
- too many welcome payloads in flight
- ratchet churn on the devices already in the room

The safer shape is one committer per scope and a small batching window.

### Recommended Join Flow

1. Device requests join for `scope_id`.
2. Server persists a pending join request with `user_id`, `device_id`, and `requested_at`.
3. Server picks one active committer for the scope.
4. Server gives that committer a bounded batch of join requests.
5. Committer produces one add commit for the batch and one welcome per device.
6. Server persists the commit cursor and pending welcomes before broadcasting.
7. Devices restore with `after_seq` from the stored post-commit point.

### Practical Batching Rules

- Batch by count: `8-32` devices per commit.
- Batch by time: `10-50ms` max hold time.
- Prefer one batch per scope at a time.
- If a scope is already mid-commit, queue later joiners instead of starting parallel commits.

### Why This Matters

- Commit cost becomes closer to `O(batches)` than `O(joiners * active_members)`.
- Existing devices process fewer commits.
- Join storms stop dominating steady-state message latency.

## Cryptographic Eviction

Transport eviction is already better than it was. A kicked or banned member loses channel access and live subscriptions. That is not enough for encrypted scopes.

The missing piece is durable cryptographic eviction coordination.

### Required Properties

- membership revoke blocks new transport access immediately
- removed member must also be removed from MLS membership
- all encrypted scopes in the server must converge on the remove commit
- reconnecting old devices must not receive new welcomes or history after revoke
- the system must retry if the designated committer disappears

### Recommended Eviction Flow

1. Moderator action creates a `pending_crypto_eviction` per encrypted scope.
2. Server revokes transport access immediately.
3. Server selects an active committer per affected scope.
4. Committer creates `mls_remove` for the target identity set.
5. Server persists the remove commit and marks the eviction row `committed`.
6. Other members replay the durable `mls_remove` event.
7. Once the remove is observed, mark the eviction row `applied`.

### Data Model To Add

- `pending_crypto_evictions`
  - `scope_kind`
  - `scope_id`
  - `server_id`
  - `target_user_id`
  - `target_device_id` nullable
  - `status` = `pending | committed | applied | failed`
  - `attempt_count`
  - `last_error`
  - `committer_device_id`
  - `commit_event_id`

### Failure Handling

- If the selected committer disconnects, another active member can claim the row.
- If the target user leaves multiple scopes, process scopes independently.
- If no committer is online, keep transport revoked and finish crypto eviction on the next active member.

## DBA Notes

The hottest server-side queries now look like this:

- latest message lookup by room summary
- message restore by `room_seq`
- mutation replay by `room_seq` or `inserted_at`

For those paths, the useful indexes are:

- `room_events(room_id, room_seq) WHERE event_type != 'vesper.message'`
- `room_events(room_id, inserted_at) WHERE event_type != 'vesper.message'`
- existing message pagination indexes on scope + timestamp + id
- existing `rooms.last_message_*` and `rooms.last_mutation_*` summary fields

The next DBA pass should use `EXPLAIN (ANALYZE, BUFFERS)` on:

- `Chat.list_*_messages_after_seq`
- `Runtime.list_scope_events_after_seq`
- `Runtime.list_scope_events`
- unread-count queries under large room history

## Recommended Next Build Steps

1. Add a real pending-eviction table and worker.
2. Move scope join handling from open fanout to server-coordinated batches.
3. Add `EXPLAIN ANALYZE` automation for the hot restore queries.
4. Run larger chaos cohorts with wider channel spread and larger seeded history.
