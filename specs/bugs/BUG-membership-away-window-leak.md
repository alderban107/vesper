# Rejoined devices decrypt ciphertext from an away membership window

## Reproduce

Environment: macOS, Node SDK integration harness, local PostgreSQL on `127.0.0.1:5432`, Docker auto-start disabled.

Sequence:

1. A guest user joins a server on primary and secondary devices.
2. The owner sends `before-leave`; the guest decrypts it.
3. The secondary disconnects and the primary leaves the server, removing both guest devices.
4. The owner sends `while-away`.
5. Both guest devices rejoin and establish a new MLS membership generation.
6. The owner sends `after-rejoin`.
7. The guest primary decrypts `after-rejoin`, but also returns plaintext `while-away`.

Observed in the full SDK integration suite after the application/control lock ownership refactor. The assertion `guest primary must not decrypt messages sent outside its membership generation` failed because the away-window message was present as plaintext.

## Isolate

The unauthorized plaintext is introduced by peer history recovery, not by MLS decryption. The rejoined device cannot decrypt the original `while-away` ciphertext with its post-rejoin group state. However, `sendHistoryBundle` authorizes a requester only with `hasMemberDevice`, then serializes every cached or currently known plaintext message. `HistoryBundleItem` contains no source `mlsEpoch`, so neither the sender nor receiver can preserve the message's original membership boundary.

The durable request path also drops the requester generation. `handle_mls_history_request` receives `membership_generation`, but `PendingHistoryRequest` does not store it and the live broadcast omits it. The receiver then inserts bundle plaintext as a successfully decrypted synthetic message with `raw.mls_epoch: null`, which explains why the policy assertion sees normal plaintext rather than a decryption placeholder.

## Hypothesize

1. **Primary: current-membership authorization is incorrectly used as historical authorization.**
   - Prediction: after rejoin, a peer history bundle includes `while-away` because the sender filters by current group membership only and has no per-message epoch constraint.
   - Falsification: the bundle sender derives membership intervals from durable join/remove events and filters each message by its immutable source epoch, yet the away-window plaintext still appears.
2. **The post-rejoin MLS state directly decrypts the old away-window ciphertext.**
   - Prediction: the message appears without any history bundle and retains its original ciphertext epoch.
   - Falsification: the only successful path rewrites the message from a plaintext bundle with synthetic `raw.mls_epoch: null`.
3. **The server returns plaintext for historical messages.**
   - Prediction: the scope sync response contains plaintext or a decryptable server-side recovery object.
   - Falsification: server message rows contain ciphertext only; plaintext enters at the peer-generated bundle path.

## Verify

Confirmed root cause: the recovery protocol treats "member now" as permission to receive all plaintext a peer has ever cached. Source inspection establishes the complete path: the request carries a generation but persistence and broadcast discard it; `sendHistoryBundle` checks only current device membership; every cached plaintext is serialized without its original MLS epoch; and `processHistoryBundleOnce` installs those items as successful decryptions with `raw.mls_epoch: null`. The failing churn test observes exactly that output shape after a remove/rejoin cycle.

The violated invariant is: a recovery bundle may disclose a message only when that message's immutable MLS epoch falls inside a durable membership interval for the exact requester user/device. The fix preserves generation provenance end to end and enforces this interval before plaintext leaves the sending device. Current membership remains necessary for delivery but is not sufficient for historical authorization.

Verification after the fix:

- The durable event stream records exact-device join transitions and post-commit generations for single and batched removals.
- Pending and live history requests preserve the requester's current membership generation.
- The sender derives exact-device membership intervals and includes only legacy MLS messages from the same immutable group whose source epoch falls inside an interval.
- The receiver independently requires an existing server-backed message row with the same group, scheme, and source epoch. History bundles can no longer synthesize attributed messages or apply room-key ciphertext using an unrelated MLS epoch.
- `multi-device-chaos.test.mjs` passed 12/12 twice after the change. The churn regression preserved `before-leave` and `after-rejoin` for both devices and rejected `while-away`.
- The populated durable-cutover migration regression passed 1/1 after the legacy-only recovery restriction, confirming post-cutover room-key history remains on its native key path.
