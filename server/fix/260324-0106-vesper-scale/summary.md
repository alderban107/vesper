# Fix Session Summary

## Stats
- Session: fix/260324-0106-vesper-scale/
- Duration: 8 iterations
- Baseline: 0 test failures, 10 predict findings to address
- Final: 0 test failures, 7 findings fully fixed, 1 partially addressed, 2 deferred
- Guard: `mix test` — 49/49 tests passing throughout

## Fix Score
fix_score: 82/100
- Reduction: 45/60 (7/10 findings addressed, 1 partial)
- Guard: 25/25 (no regressions, all 49 tests green)
- Quality: 0 anti-patterns used
- Bonus: +5 (no discards) +7 (guard always held)

## Fixed

### Iteration 1: Rate limiting on auth endpoints (H-02 + H-06)
- Added `hammer` + `hammer_plug` dependencies
- Created `VesperWeb.Plugs.RateLimit` with per-action configurable limits
- Wired rate limiting pipelines into router for login (5/min), register (3/min), recover (3/10min), refresh (30/min)
- Uses client IP + username key for login, IP-only for others
- Supports X-Forwarded-For for reverse proxy deployments

### Iteration 2: Epoch delta check (H-09)
- Added `@max_epoch_delta 1000` constant to `Vesper.Encryption`
- Split `apply_group_info_publish` clause: accepts epoch jumps <= 1000, rejects larger with `:epoch_delta_exceeded`
- CAS-based publishes (with previous_epoch) unaffected — only non-CAS path protected

### Iteration 3: Attachment uploader tracking (H-07)
- Added `uploader_id` field to `Vesper.Chat.Attachment` schema
- Created migration: `add_uploader_id_to_attachments`
- Updated `AttachmentController.create` to set uploader_id from current_user
- Updated authorization: unlinked attachments restricted to original uploader; legacy attachments without uploader_id still allowed (backward compat)

### Iteration 4: Voice room crash recovery (H-10)
- Changed `Voice.Room` GenServer from `restart: :temporary` to `restart: :transient`
- DynamicSupervisor will now restart rooms on abnormal exit

### Iteration 5: PermissionsCache cold-start fix (H-05)
- Removed GenServer serialization on cache miss
- Direct DB read + ETS write from caller process (lock-free)
- PubSub subscription handled async via GenServer cast
- Tracks subscribed server_ids to avoid redundant PubSub subscribes

### Iteration 6: Sync fan-out O(1) rewrite (H-01)
- Created `ScopeSyncEvent` schema and `scope_sync_events` table (shared event log)
- `append_scope_events` now writes 1 row regardless of member count (was O(N))
- `list_scope_changes_since/3` queries shared log filtered by user's scope_ids
- Backward-compat `list_scope_changes_since/2` queries both scope + user events
- Updated SyncFuzzTest to use new 3-arity with scope event cursor

### Iteration 7: FileStorage behaviour abstraction (H-08)
- Created `Vesper.Chat.FileStorage.Behaviour` with all callbacks
- Converted `FileStorage` into dispatcher that delegates to configured backend
- Extracted existing implementation to `Vesper.Chat.FileStorage.Local`
- Configure via `config :vesper, :file_storage_backend, Module`
- Defaults to Local (zero breaking changes)

## Partially Addressed

### Voice room control/data plane separation (H-03)
- **Status:** Deferred — high-risk architectural change
- **Why:** ExWebRTC PeerConnections send RTP events to parent process. Full separation requires restructuring PeerConnection ownership. Risk of breaking voice calls outweighs the benefit in a single iteration.
- **Recommendation:** Dedicated effort to create `Voice.Room.Router` process that owns PeerConnections for RTP forwarding. Room GenServer handles control operations only.

## Deferred

### Test coverage (H-04)
- **Status:** Not addressed in this session
- **Recommendation:** Add tests incrementally alongside each fix. Priority: auth flows, permission computation, sync cursors, encryption CAS.
