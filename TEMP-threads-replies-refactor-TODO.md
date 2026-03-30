# TEMP TODO — Threads/Replies Refactor

> Temporary working document for branch `fix/replies-vs-threads`.
> Delete this file before merging the PR.

## Goal

Decouple:

- **thread membership** (`thread_root_message_id`)
- **inline reply targeting** (`reply_to_message_id`)

These are distinct concepts and should be stored, queried, synced, cached, and rendered independently.

## Target data model

Each message may have:

- `thread_root_message_id` — root message of the thread this message belongs to
- `reply_to_message_id` — specific message this message is replying to

Valid states:

- neither set → normal message
- `reply_to_message_id` only → inline reply in main feed
- `thread_root_message_id` only → thread message
- both set → thread message replying to a specific message in the thread

## Rollout plan

### Stage 1 — schema expansion
- Add `thread_root_message_id`
- Add `reply_to_message_id`
- Keep legacy `parent_message_id` and `is_reply` for compatibility
- Add indexes for thread queries and reply lookups

### Stage 2 — server model + validation
- Add new fields to `Vesper.Chat.Message`
- Validate same-scope references
- Require thread roots to point to top-level messages
- If both fields are set, ensure the reply target is the thread root or belongs to the same thread

### Stage 3 — transport/protocol
- Accept and emit `thread_root_message_id` and `reply_to_message_id`
- Keep legacy fields during transition
- Prefer new fields when present

### Stage 4 — server query changes
- Threads should query/count on `thread_root_message_id`
- Inline replies should use `reply_to_message_id`
- Stop flattening thread-internal replies to the root

### Stage 5 — client/store/UI refactor
- Main feed shows only messages with `thread_root_message_id == null`
- Thread panel shows only messages with `thread_root_message_id == activeThreadRootId`
- Reply previews use `reply_to_message_id`
- Reply previews should render in thread view too
- Thread composer defaults to thread membership only
- Replying inside thread sets both `thread_root_message_id` and `reply_to_message_id`

### Stage 6 — cache/storage updates
- Persist new fields in:
  - Electron sqlite cache
  - IndexedDB crypto cache
  - SDK storage layers
  - renderer hydration/store paths

### Stage 7 — legacy migration/backfill
- Old inline replies:
  - `reply_to_message_id = parent_message_id`
- Old thread messages:
  - `thread_root_message_id = canonical_thread_root(parent_message_id)`
- Keep dual-read compatibility during transition

### Stage 8 — tests
- Server tests for validation/query behavior
- E2E coverage for:
  - main-feed inline replies
  - thread messages excluded from main feed
  - replies inside threads
  - refresh/reload persistence

## Cleanup before merge
- Delete this file before merging the PR
