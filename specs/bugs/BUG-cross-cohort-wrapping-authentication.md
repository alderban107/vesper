# Cross-cohort wrapping-key publication lacks an authenticated MLS trust root

## Reproduce

Environment: macOS, Vesper SDK OpenMLS WASM bindings, deterministic SDK cohort topology contract.

Minimal sequence:

1. A room is split into cohorts A and B, each with an independent MLS group and ratchet tree.
2. A member of cohort A fetches cohort B's wrapping-key publication from the server.
3. The publication includes a signer identity, signer public key, GroupInfo digest, and signature.
4. The existing verifier can only inspect the caller's local `GroupState`, which is cohort A's tree.
5. The server stores opaque public material and cannot prove that the supplied signer key is a member of cohort B.

Observed failure: there is no verification path by which a cohort-A client can authenticate cohort B's signer key. Accepting the publication would make the server an unintended key-authentication authority and permit first-publication substitution.

## Isolate

The trust break is in `sdk/src/crypto/cohortWrapping.ts`:

- `verifyCohortWrappingPublication` calls `state._group.member_signing_identities()`.
- `state` is the caller's local cohort MLS state.
- Cross-cohort coordination requires verifying a publication from a different cohort whose private MLS state the caller correctly does not possess.

The WASM layer exports member inspection only from a loaded private `MlsGroup`. It does not expose OpenMLS's read-only public-group validation for an arbitrary published GroupInfo and ratchet tree.

## Hypothesize

1. **Primary: the verifier is coupled to private local group state instead of an authenticated public MLS snapshot.**
   - Prediction: OpenMLS has a public validation path that verifies GroupInfo against its ratchet tree and then exposes authenticated members without joining the group.
   - Falsification: if OpenMLS has no such API, cross-cohort key authentication needs a different protocol trust root.

2. **Server CAS is sufficient to authenticate the key.**
   - Prediction: the first accepted publication is cryptographically bound to an existing trusted key.
   - Falsification: `upsert_cohort_wrapping_key` only prevents same-epoch replacement after insertion; the initial signer key and signature are client-supplied opaque bytes. This candidate is false.

3. **The publication signature authenticates itself.**
   - Prediction: verifying the Ed25519 signature proves the signer belongs to the target cohort.
   - Falsification: the signer public key is included in the same untrusted publication, so self-signature proves possession only. This candidate is false.

## Verify

Confirmed root cause: cross-cohort wrapping-key verification uses the wrong ownership object. Cohort membership authenticity belongs to the published MLS GroupInfo plus ratchet tree, but the SDK verifier requires a private local `GroupState`. This makes correct cross-cohort verification unrepresentable and tempts the coordinator to trust server assertions or self-signed keys.

Evidence:

- `verifyCohortWrappingPublication` derives trusted members only from `state._group.member_signing_identities()`.
- The server's epoch CAS rejects later substitution but has no trust root for the first publication.
- OpenMLS `PublicGroup::from_external` accepts `RatchetTreeIn` and `VerifiableGroupInfo`, validates the tree, verifies the GroupInfo signature using the tree, stores the resulting public group, and returns authenticated group information.
- `PublicGroup::members()` exposes the verified member credentials and signature keys needed to authenticate the wrapping-key signer.

Fix plan:

1. Expose a read-only WASM function backed by `PublicGroup::from_external` that returns the verified group ID, epoch, and member signing identities.
2. Bind every wrapping publication to the actual MLS `groupId` in its signed context, not only the logical cohort ID.
3. Verify arbitrary cohort publications against their canonical durable GroupInfo and ratchet tree before deriving any room-key envelope.
4. Add negative tests for altered GroupInfo, altered ratchet tree, wrong group ID, wrong epoch, substituted signer key, and altered publication signature.
5. Build room-key coordination only on verified publications; never let the server authenticate client key ownership.
