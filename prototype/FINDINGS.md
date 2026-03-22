# OpenMLS WASM Prototype — Findings

## Executive Summary

**OpenMLS WASM is viable as a drop-in replacement for ts-mls.** The prototype demonstrates all critical operations including External Commits, the key feature that ts-mls lacks. The WASM binary is 1.49 MB, the API is clean, and all 15 test scenarios pass.

**Recommendation: Proceed with the ts-mls → OpenMLS swap.**

---

## Build Process

### What worked
- OpenMLS already ships an `openmls-wasm` crate with wasm-bindgen bindings in their repo
- We extended it with Vesper-specific features (External Commits, voice key derivation, member listing, remove member)
- Build command: `wasm-pack build --target web --release`
- Build time: ~36 seconds (first build), ~24s compilation + ~12s wasm-opt
- Produces a ready-to-use npm package in `pkg/`

### Dependencies
- Rust toolchain (rustup)
- `wasm-pack` (cargo install)
- `wasm32-unknown-unknown` target

### Build configuration
- Feature flag: `js` on the `openmls` crate (enables `getrandom/wasm_js` + `fluvio-wasm-timer`)
- Also need `getrandom` v0.2 with `js` feature for `openmls_rust_crypto` and `openmls_basic_credential`
- Crate type: `cdylib` (for WASM) + `rlib` (for native tests)

---

## Bundle Size

| Artifact | Size |
|----------|------|
| WASM binary (optimized) | **1.49 MB** |
| JS bindings | 24 KB |
| TypeScript declarations | 5.5 KB |
| Total package | 1.6 MB |

**Context:**
- Electron: negligible — apps are already 100+ MB
- Browser: 1.49 MB is fine with lazy loading, comparable to many JS bundles
- Can be further reduced with `wasm-opt -Oz` or by limiting ciphersuites

---

## API Mapping: mls.ts → OpenMLS WASM

| Vesper `mls.ts` function | OpenMLS WASM equivalent | Notes |
|--------------------------|-------------------------|-------|
| `initCipherSuite()` | `new Provider()` | Implicit — cipher suite is compiled in |
| `createMLSGroup()` | `Group.create_new(provider, identity, groupId)` | Simpler API — identity instead of raw key package |
| `addMemberToGroup()` | `group.add_member(provider, sender, keyPackage)` | Returns `CommitBundle` with commit + welcome + optional group_info |
| `processWelcome()` | `Group.join_from_welcome(provider, welcomeBytes, ratchetTree?)` | Direct, no manual decoder workarounds |
| `processCommitMessage()` | `group.process_message(provider, msgBytes)` | Unified message processing — handles commits, proposals, and app messages |
| `encryptMessage()` | `group.create_message(provider, sender, plaintext)` | Returns raw bytes, caller handles epoch tracking |
| `decryptMessage()` | `group.process_message(provider, ciphertext)` | Returns `ProcessResult` with kind + optional message bytes |
| `serializeGroupState()` | N/A — see "Persistence" section | OpenMLS uses a `StorageProvider` trait instead of manual serialization |
| `deserializeGroupState()` | N/A — see "Persistence" section | Same |
| `deriveVoiceKey()` | `group.export_secret(provider, 'voice-e2ee', context, 16)` | Direct mapping via MLS exporter |
| `groupHasMember()` | `JSON.parse(group.member_identities()).includes(id)` | Or check `member_count()` |
| `getGroupMemberIdentities()` | `JSON.parse(group.member_identities())` | Returns JSON array of identity strings |
| `findGroupMemberLeafIndex()` | Needs implementation | Not yet exposed in WASM bindings |
| `removeMemberFromGroup()` | `group.remove_member(provider, sender, leafIndex)` | Returns `CommitBundle` |
| `buildClientCredentialIdentity()` | Pure JS — `${userId}:${deviceId}` | No crypto dependency needed |
| `createKeyPackageBatch()` | Loop calling `identity.key_package(provider)` | Each call generates a fresh key package |
| `encodeKeyPackageBytes()` | `keyPackage.to_bytes()` | Direct |
| `decodeKeyPackageBytes()` | `KeyPackage.from_bytes(bytes)` | Direct |
| **NEW: External Commit** | `Group.join_from_external_commit(provider, joiner, groupInfo, ratchetTree?)` | **The key new feature** |
| **NEW: Export GroupInfo** | `group.export_group_info(provider, signer)` | For publishing to server |

### Functions NOT needed in new wrapper
- `decodeMlsMessageFromBytes()` — ts-mls decoder workaround, not needed
- `assertPublicCommitMessage()` — ts-mls type guard, not needed
- `processPublicCommitWrapper()` — ts-mls PSK index workaround, not needed
- `makeCredential()` — handled by `Identity` constructor
- All the `clientConfig` reattachment code — OpenMLS handles state properly

---

## What the new `mls.ts` looks like

The wrapper shrinks dramatically. Most of the current 600 lines are:
1. Working around ts-mls bugs (decoder offset, clientConfig) — **eliminated**
2. Manual credential/config plumbing — **handled by Identity/Provider**
3. Encoding/decoding MLS messages — **handled by WASM bindings**

Estimated new wrapper size: **~150 lines** (mostly re-exports and Vesper-specific helpers like `buildClientCredentialIdentity`).

---

## Persistence (Open Question)

OpenMLS uses a `StorageProvider` trait for state persistence, not manual serialize/deserialize. The current prototype uses `openmls_memory_storage` (in-memory only).

**Options for Vesper:**
1. **Memory storage + manual export/import**: Export ratchet tree + group info on each change, reconstruct group from External Commit on reload. This is the simplest approach and External Commits make it viable — you can always rejoin from stored GroupInfo.
2. **Custom StorageProvider over IndexedDB**: Implement the trait to persist directly to browser/Electron storage. More complex but gives proper persistence.
3. **Serialize the WASM memory**: Hacky but possible in Electron.

**Recommendation:** Start with option 1. External Commits mean that even if state is lost, the client can rejoin by fetching GroupInfo from the server. This is a massive improvement over ts-mls where losing state meant waiting for an online member to re-add you.

---

## Impact on `encryptedChat.ts`

The 2,600-line orchestration layer gets simpler:

1. **Join flow simplification**: The entire Welcome-waiting state machine can be replaced with External Commit. No more `pendingWelcome`, `JOIN_TIMEOUT_MS`, `joinRetryCount`, `deferredJoinRequests`.
2. **Resync simplification**: Instead of nuclear `resetGroup` + wait for re-add, just fetch GroupInfo + External Commit.
3. **Multi-device**: Each device independently fetches GroupInfo and External Commits. No coordination needed.
4. **Epoch storm prevention**: External Commits don't cause the duplicate-join problem because the joiner adds themselves rather than multiple admins racing to add them.

**Estimated reduction:** ~500-800 lines of state machine code can be removed.

---

## Impact on Server

Minimal changes needed:

1. **New endpoint**: `POST/GET /api/scopes/:scope_id/group_info` — store and retrieve the latest GroupInfo for each scope. After any member commits (add, remove, update), they publish updated GroupInfo.
2. **Existing infrastructure stays**: Key package storage, pending welcomes (for backward compat), durable MLS events — all still useful.
3. **Access control for GroupInfo**: Only members with channel access can fetch GroupInfo (addresses #24).

---

## Impact on Open Issues

| Issue | Impact |
|-------|--------|
| **#76** (MLS group join UX overhaul) | Stages 2 and 3 **eliminated**. Stage 1 (transparent UX) still valuable. |
| **#75** (Proactive MLS group join) | **Closed/unnecessary**. External Commits replace the entire batch-join concept. |
| **#74** (Server-route join requests) | **Dramatically simplified**. Server stores GroupInfo instead of routing join requests. |
| **#73** (Transparent encryption UX) | Still needed, library-independent. |
| **#24** (Automatic group admission) | Solvable via server-side GroupInfo access control. |
| **#66** (E2E tests passing) | Simpler tests — no Welcome timing issues, no epoch storms. |

---

## Blockers and Risks

### No blockers found.

### Minor risks:
1. **WASM bindings are not published to npm** — we maintain our own `vesper-openmls-wasm` crate. This means we own the build and can extend the API, but also means we're responsible for updates.
2. **`ExternalCommitResult.take_group()` consumes the struct** — must call `commit_bytes()` first. Minor footgun but easy to document.
3. **Persistence strategy needs design** — the `StorageProvider` trait is different from ts-mls's manual serialize/deserialize. Not a blocker, just needs thought.
4. **OpenMLS uses ChaCha20-Poly1305 by default in their WASM example** — we switched to AES-128-GCM to match Vesper's existing cipher suite. Both work fine.

### What's not tested yet:
- Browser context (only tested in Node.js so far, but `--target web` output is designed for both)
- Very large groups (100+ members)
- Concurrent External Commits (two members joining simultaneously)
- Electron-specific integration

---

## Files in This Prototype

```
prototype/
├── openmls-wasm/           # Rust WASM crate
│   ├── Cargo.toml          # Dependencies and features
│   ├── src/lib.rs          # WASM bindings (~500 lines)
│   └── pkg/                # Built WASM package (npm-ready)
│       ├── vesper_openmls_wasm_bg.wasm  (1.49 MB)
│       ├── vesper_openmls_wasm.js       (24 KB)
│       └── vesper_openmls_wasm.d.ts     (5.5 KB)
└── test-harness/           # Node.js test harness
    ├── package.json
    └── test-harness.mjs    # 15 tests covering all Vesper MLS operations
```

---

## Next Steps

If greenlit, the implementation plan is:

1. **Move `vesper-openmls-wasm` into `sdk/wasm/`** — becomes part of the build pipeline
2. **Rewrite `sdk/src/crypto/mls.ts`** — thin wrapper over WASM bindings (~150 lines)
3. **Update `sdk/src/crypto/types.ts`** — remove ts-mls type imports, use OpenMLS types
4. **Add GroupInfo server endpoint** — `POST/GET /api/scopes/:scope_id/group_info`
5. **Simplify `encryptedChat.ts`** — replace Welcome-waiting with External Commit flow
6. **Design persistence strategy** — probably memory storage + External Commit rejoin
7. **Update E2E tests** — simpler tests, no more Welcome timing issues
8. **Remove ts-mls** from `sdk/package.json` and `client/package.json`
