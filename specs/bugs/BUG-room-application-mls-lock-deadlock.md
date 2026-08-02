# Multi-cohort application encryption deadlocks under the MLS mutation lock

## Reproduce

Environment: macOS, Node SDK integration harness, live Phoenix server and PostgreSQL, multi-cohort room with two active cohort MLS groups and one active room-key epoch.

Minimal sequence:

1. Establish two cohorts and publish authenticated wrapping keys.
2. Coordinate and activate one complete room-key epoch.
3. Call `sendText` from a cohort member.
4. The send does not complete; a five-second timeout fires, and teardown waits on the blocked operation.

The standalone room application cipher vector encrypts and decrypts immediately, so the cryptographic primitive is not the source of the hang.

## Isolate

The blocked path is:

- `performSend` calls `withReadyScopeOperation`.
- `withReadyScopeOperation` enters `withLockedScopeOperation`, which owns the non-reentrant cohort MLS group lock.
- The callback calls `encryptApplicationForScope`.
- The multi-cohort branch calls `loadActiveRoomDataKey`.
- `loadActiveRoomDataKey` calls `deriveScopeCohortWrappingKey`.
- `deriveScopeCohortWrappingKey` calls `withLockedScopeOperation` for the same cohort group.

`encryptForScope` already documents that this lock is non-reentrant and must not be reacquired.

## Hypothesize

1. **Primary: room application encryption incorrectly inherits the MLS mutation lock.**
   - Prediction: the send blocks before network push while the same group lock waits on itself.
   - Falsification: if the multi-cohort send completes when application work runs after readiness but outside the MLS lock, this is confirmed.

2. **The room-key AEAD or WebCrypto operation blocks.**
   - Prediction: the standalone deterministic vector also hangs.
   - Falsification: the vector completes in milliseconds. This candidate is false.

3. **The server rejects or fails to broadcast the new ciphertext.**
   - Prediction: the send returns an error or reaches server logs before hanging.
   - Falsification: the operation blocks before `pushScopeEventResolved`. This candidate is false.

## Verify

Confirmed root cause: the readiness abstraction owns a lock whose purpose is inseparable from the legacy MLS application-encryption design. Multi-cohort room-key encryption is read-only with respect to cohort MLS state, but it was invoked inside that mutation lock and then needed the same lock to derive or refresh its wrapping key. The non-reentrant queue waits on itself by construction.

Fix plan:

1. Keep `withReadyScopeOperation` for operations that mutate MLS group state.
2. Add an application-operation readiness path that waits for membership but does not retain the MLS lock for multi-cohort room-key work.
3. Route multi-cohort message, edit, and reaction encryption through that path; retain the legacy path for single-group MLS ciphertext.
4. Re-run the live two-cohort send/edit/reaction contract and assert neither cohort MLS epoch advances during room-key application events.
