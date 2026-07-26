# Account delta sync scans unrelated global scope traffic

## Reproduce

Environment: Phoenix workspace delta sync using the shared `scope_sync_events` log.

1. Give one user membership in a bounded set of servers, channels, and DM conversations.
2. Append a large volume of scope events for unrelated users after that user's cursor.
3. Request `/api/v1/sync` for the user.
4. The scope query walks `scope_sync_events.id` in ascending order and evaluates membership `EXISTS` subqueries for each candidate row until it finds a page or reaches high water.

The response bytes remain bounded, but database work grows with total deployment traffic after the cursor instead of the user's changed scopes.

## Isolate

`Vesper.Sync.relevant_scope_events_query/3` starts from the global event table with `event.id > cursor`, orders by the global primary key, and places server/channel/DM authorization behind one `OR` expression. The event table has an existing `(scope_kind, scope_id, id)` index, but the query shape does not start from the user's indexed memberships or DM participation.

## Hypothesize

1. **Primary: the query is driven by global event order rather than the user's authorized scopes.** Prediction: unrelated events remain candidate rows and each executes authorization checks. Falsification: the plan starts from membership/participant rows and performs indexed event lookups by scope.
2. **Per-user event fanout is required for bounded reads.** Prediction: no shared-log query can avoid unrelated traffic. Falsification: a union of server, channel, and DM membership joins can use the existing scope index while preserving one event write per scope change.
3. **The response limit bounds database work.** Prediction: `LIMIT 101` prevents scanning more than 101 rows. Falsification: the limit applies after authorization filtering, so PostgreSQL may inspect arbitrarily many unrelated rows to find 101 matches.

## Verify

The root cause is confirmed by the query structure and indexes. The only ordered source is the global event primary key; authorization is evaluated after each candidate event. The `(scope_kind, scope_id, id)` index cannot drive the current `OR EXISTS` query from a user's authorized scopes.

The invariant is: shared scope events must remain O(1) writes, while a user's delta read must scale with that user's memberships and matching changed scopes, not with unrelated tenant traffic. The correct query is a union of three membership-driven branches, followed by one outer ID order and page limit.

Verification after implementation: the membership-driven union passes the hidden-channel authorization oracle and the 125-event bounded workspace drain. The full server suite passes 128/128, and the new `(user_id, conversation_id)` DM-participant index is present in the migrated PostgreSQL schema.
