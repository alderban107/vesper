# Trusted-device history recovery cannot cross device identities

## Reproduce

Environment: macOS, Chromium Playwright, Phoenix test server, fresh E2E database, `p1-extended` project with P0 fixture accounts.

Command:

```bash
npx playwright test -c client/e2e/playwright.config.ts --project=p1-extended --no-deps
```

Minimal observed sequence:

1. Device A decrypts DM messages and later closes.
2. Device B is approved with the account recovery mnemonic.
3. Device B creates a fresh per-device MLS signing identity.
4. Device B can decrypt new live messages after joining the current epoch.
5. Four older authorized DM records remain rendered as `Encrypted message is syncing...`.

Repeated result: the same test at `client/e2e/tests/p1-multi-device.spec.ts:142` failed in multiple full P1 runs. New messages (`Setup msg`, device-2 send, Bob reply) decrypt; four prior records do not.

## Isolate

The failure crosses three ownership domains:

- Device approval creates a new device-local MLS identity at `sdk/src/auth/session.ts:431` via `createFreshLocalDeviceIdentity`.
- Scope recovery packages derive their AES-GCM key from the current device's private MLS identity at `sdk/src/client/encryptedChat.ts:3127-3138`.
- Import catches decryption failure and returns without mutating the cache at `sdk/src/client/encryptedChat.ts:3291-3339`.

A separate identifier mismatch also exists in `syncScope`: checkpoint/MLS state is keyed by backing group ID, while DM message cache and renderer state are keyed by logical conversation ID. `syncScope` currently loads cached messages and `scopeMessages` with `groupId` at `sdk/src/client/encryptedChat.ts:1122-1123`, but `processIncomingMessage` and `applyScopeSyncDelta` write by `scope.id`.

## Hypothesize

1. **Confirmed candidate: package encryption key has device ownership instead of account ownership.**
   - Prediction: device A and device B derive different package keys even though both are trusted for the same user.
   - Falsification: prove approved devices retain the same private MLS identity bytes. The approval code instead explicitly creates a fresh identity, so this candidate survives.

2. **Cache/group identifier split prevents imported plaintext from entering the renderer-visible DM cache.**
   - Prediction: import may persist under conversation ID while restore reads under backing group ID, or vice versa.
   - Falsification: trace all cache reads/writes for a DM with `channelId != conversationId`. Source inspection confirms both identities are used inconsistently.

3. **Recovery publication is lost because it is asynchronous or rejected by server authorization.**
   - Prediction: awaiting publication and routing by conversation ID would resolve the failure.
   - Falsification: both changes were applied; full P1 still failed with the same four records. This is not the root cause.

## Verify

Root cause: the design has no durable account-level secret for cross-device recovery. It tries to encrypt an account recovery artifact with a device-local MLS private identity. Device isolation correctly makes those identities different, so package decryption by another device is impossible by construction. The group/conversation cache-key split then obscures the failure by allowing live MLS state to advance while old renderer records remain unresolved.

Evidence:

- Recovery approval always calls `createFreshLocalDeviceIdentity`.
- Package key derivation consumes `identity.signaturePrivateKey` from that fresh identity.
- Awaiting publication, fixing server route scope, and fixing publication cache scope did not change the four-message failure.
- Live messages decrypt, proving current MLS membership is healthy; only historical plaintext recovery is absent.

Fix plan:

1. Introduce one account-level recovery-package secret, distinct from every device MLS identity.
2. Generate and persist it at registration; restore it from the recovery mnemonic/account backup during device approval and password unlock.
3. Store it in all crypto storage adapters under the user identity record, never on the server in plaintext.
4. Derive per-scope AEAD keys from the account secret plus canonical logical scope ID.
5. Define a single scope identity object that carries `logicalScopeId` and `mlsGroupId`; use the former for message/cache/API ownership and the latter only for MLS state and replay.
6. Add a deterministic SDK test that packages on device A, imports on device B, and proves wrong-device-local identity is irrelevant while wrong account/scope packages are rejected.
