# Retained sync cursors silently accept stale device state

## Reproduce

Environment: Phoenix sync controllers with the daily `Vesper.Workers.PurgeSyncEvents` retention policy.

1. Persist a workspace cursor on a signed-in device.
2. Keep the device offline for more than seven days.
3. The purge worker deletes all scope and user sync events older than seven days.
4. Reconnect with the old, structurally valid cursor.
5. `/api/v1/sync` treats it as a delta cursor. If no retained events exist after its numeric IDs, the response is an empty delta rather than a compact full snapshot.

Observed contract violation: the server accepts a cursor whose required event interval no longer exists, so durable local state can remain stale indefinitely.

## Isolate

`Vesper.Workers.PurgeSyncEvents` deletes both sync logs after seven days. `Vesper.SyncCursor` retains `synced_at`, but `VesperWeb.SyncController.index/2` decides full versus delta only from the presence of integer event IDs. `VesperWeb.UrgentSyncController.index/2` has the same assumption for its user-event cursor.

The gap is at the server protocol boundary, before paging or client persistence: cursor validity is not checked against the same retention policy that deletes the cursor's source records.

## Hypothesize

1. **Primary: cursor validity and event retention are separate policies.** Prediction: a cursor older than the retention window is accepted as a delta even when its source interval has been deleted. Falsification: either controller rejects or resets an old cursor based on `synced_at`.
2. **Numeric cursor gaps alone prove expiry.** Prediction: comparing the cursor ID with the minimum retained ID reliably identifies stale cursors. Falsification: global sequences legitimately contain gaps for a specific user and scope authorization, so ID gaps are ambiguous.
3. **The local workspace projection makes expiry harmless.** Prediction: every server-side change can be reconstructed from the retained local projection without a snapshot. Falsification: membership, server metadata, unread summaries, and recently active conversations may all change while the device is offline.

## Verify

The root cause is confirmed by source-level falsification. The purge worker has a hard seven-day cutoff, while both controllers accept any decoded cursor with the expected integer fields. No expiry check exists. Numeric ID comparison cannot safely replace timestamp validation because user IDs share a global sequence and scope events are filtered by current authorization.

The invariant is: a delta cursor is valid only while the server guarantees that every event after that cursor remains queryable. Once that guarantee expires, workspace sync must return a compact full snapshot, and urgent sync must signal the client to rebuild from that snapshot instead of treating an empty urgent page as convergence.
