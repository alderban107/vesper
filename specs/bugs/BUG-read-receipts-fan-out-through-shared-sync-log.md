# User read receipts fan out through the shared scope sync log

## Reproduce

Call `Chat.mark_channel_read/3` or `Chat.mark_dm_read/3`. Each function calls `Sync.append_scope_events([user_id], "read", ...)`.

`append_scope_events/5` ignores the supplied user IDs and writes one `ScopeSyncEvent`. Every authorized member of that channel or DM can therefore read the event through the shared scope cursor, even though only one user's read position changed.

## Isolate

The obsolete `append_scope_events/5` compatibility wrapper preserves the shape of the former per-user fan-out API while delegating to `append_scope_event/4`. Shared message and metadata events belong in `scope_sync_events`; read-position changes belong in `user_sync_events` with an explicit scope kind and scope ID.

## Hypothesize

1. **Primary: the compatibility wrapper erased the event ownership boundary.** Falsification: read events are inserted only for the user whose read position changed.
2. **The client needs every member's read event.** Falsification: workspace sync uses a read event only to recompute the requesting user's unread count.
3. **Authorization filtering removes the extra work.** Falsification: authorized room members pass the filter, so the event still advances their shared cursor and triggers their unread query.

## Verify

Confirmed root cause: `append_scope_events/5` accepts recipient data that it discards, allowing user-local state to enter the shared scope log. The invariant is that shared scope events represent room-visible state, while user-scope events represent account-local state and are visible only to that user.

The fix must remove the ignored-recipient wrapper, migrate shared callers to `append_scope_event/4`, and add an explicit targeted user-scope event API for read receipts.
