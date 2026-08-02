# Concurrent first sends fail while a room key is being coordinated

## Reproduce

Environment: macOS, Node SDK standalone chaos harness, local PostgreSQL 17 on `127.0.0.1:5432`, 12 physical users, 18 device actors, six active multi-cohort scopes, 24 cohorts, 180 seeded messages per scope, and a 60-second timed phase.

After multi-cohort cutover, several devices send concurrently. The run recorded 77 failed operations with `Could not prepare room-key epoch: 409` and one restored ciphertext marked as a decrypt failure. The deterministic SDK integration suite still passed 57/57, so the failure requires concurrent first-send coordination across independent devices.

## Isolate

The room-key failures begin after a cohort MLS epoch changes. `VesperEncryptedChat.loadActiveRoomDataKey/1` compares the active envelope's wrapping epoch with the device's current cohort exporter. On a mismatch or local unwrap failure, it calls the repair endpoint. `Vesper.Encryption.report_room_key_epoch_repair/2` then changes the only active room-key epoch to `repair`, so the active-key endpoint returns 404 for every cohort.

Subsequent sends call `coordinateRoomKeyEpoch` with an `initial` request. Concurrent devices then collide with the open repair/coordinator lease and receive HTTP 409. Devices that still have the retired key in memory can temporarily encrypt and decrypt, while a device without that cached key records a decrypt failure.

A second stale-state defect amplified cutover races: the topology event handler refreshed only when the announced generation was greater than the cached generation. Cutover changes topology state without changing generation, so a device that had already cached the prepared generation could retain the pre-cutover state.

## Hypothesize

1. **Primary: a device-local key recovery miss is incorrectly allowed to make the room's active key globally unavailable.** Falsification: reporting a local repair concern leaves the active epoch readable while a replacement epoch is coordinated and atomically activated.
2. **Room-key rotation is not coupled to a successfully published cohort wrapping-key rotation.** Falsification: publishing a new active-topology cohort wrapping key automatically activates the next room-key epoch before application traffic resumes.
3. **Cutover events ignore same-generation state transitions.** Falsification: a cutover event refreshes a cached topology when its generation is equal to the announcement.

## Verify

The focused regression changed the existing multi-cohort integration test to rotate a cohort MLS epoch, publish its authenticated wrapping key, send immediately without a manual room-key coordination call, and require cross-cohort decryption plus an incremented active room-key epoch. Before the fix, the send used cached key material but the active endpoint returned 404 because another device's repair report had removed the active epoch.

The fix keeps the current epoch active when a member reports a local repair concern, records the reason without granting that member a room-wide availability kill switch, refreshes same-generation cutover state, and automatically coordinates a wrapping-key room-key rotation after a successful active-topology wrapping publication. The focused SDK regression passes, and the server test confirms that a repair report leaves `get_active_room_key_epoch/1` readable.

The bounded physical multi-cohort chaos gate then passed with 50,000 simulated users, six physical users, nine device actors, two active rooms, six cohorts, 302 actual operations, 170 encrypted messages, zero operation failures, zero decrypt failures, zero restore misses, and zero repair/resync events.
