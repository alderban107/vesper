# Bounded account sync skips events and redownloads the workspace

## Reproduce

Environment: Phoenix sync controllers and SDK/client workspace synchronization on the current working tree.

1. Create more than 100 urgent user events after a device cursor.
2. Request `/api/v1/sync/urgent` with `limit=100`.
3. The response returns the first 100 events.
4. Decode the returned token. Its `user_sync_event_id` is the newest event in the account, not the ID of the last returned event.
5. Request the next page with that token. The unreturned events are skipped.

A separate restart path shows the account workspace is held only in process memory while the durable local database stores cryptographic state and messages. A restart therefore forces another broad full sync. Full sync preloads every server's channels and emojis while `Chat.list_conversations/2` silently caps the account at 100 conversations.

## Isolate

The cursor violation is in `VesperWeb.UrgentSyncController.index/2`: it limits the result set but encodes `Sync.latest_event_id_for_user/1` into the returned token. The same high-water behavior exists in workspace sync, whose delta reader is unbounded.

The startup cost is split across `VesperWeb.SyncController.index/2`, `Servers.list_user_servers/2`, `Chat.list_conversations/2`, and `VesperClient.syncNow/1`. The SDK does not load or save an account workspace projection through `CryptoStorageRuntime`, so the database cannot render the account before the network responds.

## Hypothesize

1. **Primary: page ownership and cursor ownership are separate computations.** A bounded query returns one page while another query chooses the cursor from the whole log. Falsification: every returned token equals the last returned event unless the response proves there are no remaining relevant events.
2. **Workspace startup is broad because the local database lacks an account projection.** Falsification: the SDK can hydrate servers, conversations, unread state, and its sync token from the storage adapter before HTTP sync.
3. **The 100-conversation cap is intentional archival behavior.** Falsification: the response exposes pagination or search that makes older conversations reachable. It currently exposes neither.

## Verify

Confirmed root cause: the synchronization contract does not make a response page and its continuation cursor one atomic result. The controller independently reads a limited page and the global high-water mark, so `returned events < events through token` whenever backlog exceeds the limit. This violates the invariant that a client may advance a cursor only through records represented in committed local state.

The related performance defect has the same ownership problem: the network response is treated as the workspace state rather than as a bounded update to a durable local projection. Correct synchronization requires one page result to own its next cursor and `has_more` flag, followed by local atomic persistence before cursor advancement.
