# Room topology mutations are not bound to the authorized room

## Reproduce

Authorize a user for scope A, then call `RoomCryptoTopologyController.cutover/2` or `rollback/2` with a topology ID that belongs to room B. The controller authorizes scope A but passes only the caller-supplied topology ID to `Encryption.append_room_topology_cutover/1` or `rollback_preparing_room_topology/2`.

The encryption context locks and mutates the topology by ID without comparing its `room_id` to the already-authorized room.

## Isolate

The ownership check is split across two unrelated identifiers: the controller validates `scope_id`, while the context mutation validates only `topology_id`. The same unbound lookup also exists in requested-generation reads.

## Hypothesize

1. **Primary: topology APIs do not carry the authorized room identity into the database lookup.** Falsification: every externally selected topology is queried by both room ID and topology ID.
2. **Migration authorization validates the topology indirectly.** Falsification: `authorize_migration/2` receives only the room resolved from `scope_id`.
3. **Topology UUID secrecy prevents exploitation.** Falsification: authorization cannot depend on identifiers remaining unknown, and topology IDs are returned by migration APIs and durable events.

## Verify

Confirmed root cause: controller authorization and context mutation are separate operations with no shared room invariant. The invariant is that any topology selected by a request must belong to the exact room that the request already authorized.

The fix must require `room_id` in the context APIs for topology generation reads, cutover, and rollback, and lock the topology with both identifiers before any state transition.
