# Decrypted room data keys survive an authenticated session reset

## Reproduce

Inspect `VesperEncryptedChat.reset/0` after a room key has been cached by `loadActiveRoomDataKey/1` or `coordinateRoomKeyEpoch/3`. The method clears `scopeTopologies` and the MLS/control state, but it never clears `roomDataKeys`.

The same `VesperEncryptedChat` instance can therefore retain decrypted room keys after sign-out and before a later account session starts.

## Isolate

The retained secret is owned by `VesperEncryptedChat.roomDataKeys`, keyed only by room ID and room-key epoch. `reset/0` is the canonical auth-session teardown path, invoked when client state becomes `signed_out`. No other teardown path clears this map.

## Hypothesize

1. **Primary: room-key cache ownership is not modeled as session state.** Falsification: `reset/0` or a delegated state owner clears every cached room key.
2. **The storage runtime owns and clears these keys.** Falsification: `roomDataKeys` is an in-memory map on `VesperEncryptedChat`, not persisted crypto storage.
3. **Room IDs prevent reuse across accounts.** Falsification: a later account can be authorized for the same room, while the invariant still requires every decrypted secret from the prior session to be destroyed before the next session starts.

## Verify

Confirmed root cause: topology cache teardown and decrypted-key teardown are separate ad-hoc maps, and only the topology map participates in `reset/0`. The invariant is that all decrypted room-key material belongs to one authenticated client session and is removed atomically with the rest of that session's crypto state.

The fix must give room topology and room data keys one state owner whose `clear/0` operation clears both maps, and `VesperEncryptedChat.reset/0` must call that operation.
