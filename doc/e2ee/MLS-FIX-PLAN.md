# MLS Fix Plan

## Current Problems

### 1. ts-mls doesn't support External Commits
External Commits (RFC 9420 §12.4) let a new member add themselves to a group using published GroupInfo — no existing member needs to be online. This is the proper solution to the "someone needs to be online" UX problem. **ts-mls explicitly lists this as a missing feature.**

### 2. ts-mls has known reliability and safety issues
The E2EE implementation guide documents several ts-mls-specific pitfalls: the decoder offset bug (`undefined + 2 = NaN`), `clientConfig` not surviving serialization round-trips, and epoch storms reaching 58+ from duplicate join requests. The library has no formal security audit, listed in §13 of the implementation guide as a "hard gate for production deployment."

---

## Open GitHub Issues and How OpenMLS Affects Them

### #76 — MLS group join UX overhaul (parent issue)
The three-stage plan (transparent UX → server routing → proactive joins) works around the limitation that MLS requires an online member to add new users. **External Commits make Stages 2 and 3 largely unnecessary.** With External Commits, the new member adds *themselves* — no routing, no proactive join batching, no multi-admin coordination needed. Stage 1 (transparent UX) is still valuable for the brief moment while the External Commit is processing.

### #75 — SDK: Proactive MLS group join at invite accept time
This is the most complex of the three stages — batch processing N channels at invite time, key package budget management, partial failure handling, multi-admin coordination. **External Commits eliminate this entire issue.** The new member's client fetches GroupInfo for each channel and issues External Commits independently. No inviter coordination, no batch processing, no admin being online.

### #74 — Server: Route MLS join requests to any online group member
This adds server-side routing of join requests to any online member, not just ones watching the channel. **External Commits reduce this to a much simpler problem.** The server stores GroupInfo (published after each epoch by any member); new members fetch it and self-join. The server still plays a role, but as a GroupInfo directory rather than a join request router. The durable pending join queue proposed in #74 is still useful as a fallback for cases where GroupInfo isn't published yet.

### #73 — UX: Transparent encryption setup progress
This is pure UI work (state machine, status cards, retry with backoff). **Still needed regardless of library choice.** Even with External Commits, there's a brief async window during setup. Good UX for this state is always valuable.

### #24 — MLS group admission is automatic (no access control)
Currently any server member's client auto-admits join requests without human approval. **External Commits make this worse if not handled carefully** — a new member could self-join any group whose GroupInfo is available. However, this is solvable: the server controls who can fetch GroupInfo (same permission check as channel access), and External Commits can require application-level authorization. OpenMLS supports custom credential validation that could gate admission.

### #66 — E2E: Get p1 and p2 test suites passing
Many test failures are likely caused by MLS convergence timing. **External Commits would simplify tests** — no more waiting for member-initiated joins, no Welcome timing issues, no epoch storm risks from duplicate join requests. The MLS diagnostics system (#71) stays valuable for budget assertions.

---

## ts-mls Known Issues That OpenMLS Resolves

From the E2EE-IMPLEMENTATION.md "Debugging MLS Issues" section and §13 Security Considerations:

| Issue | ts-mls | OpenMLS |
|-------|--------|---------|
| **External Commits** | Missing feature | Full support |
| **Decoder offset bug** (`undefined + 2 = NaN`) | Requires manual wrapper with explicit `offset = 0` | Rust type system prevents this class of bug |
| **`clientConfig` not serialized** | Must manually reattach after every deserialize | `StorageProvider` trait handles full state persistence |
| **No formal security audit** | Listed as "hard gate for production" in §13 | Formally analyzed by Cryspen, used by Wire in production |
| **Epoch storms** (58+ from duplicate joins) | Requires careful deduplication in 2,600-line state machine | External Commits eliminate the join round-trip that causes storms |
| **State corruption recovery** | `resetGroup` nuclear option, then wait for member to re-add you | Delete state → fetch GroupInfo → External Commit back in (self-service) |
| **Multi-device rejoin** | Each device joins lazily, one channel at a time, needs online member | Each device fetches GroupInfo and External Commits independently |
| **Key package exhaustion** | 20 packages, N channels = risk of running out during batch join | External Commits don't consume the *joiner's* key packages — the joiner uses GroupInfo, not a Welcome |
| **Side-channel resistance** | "not been analyzed for side channels" (§13) | Rust + constant-time crypto primitives from RustCrypto |

---

## Options

### Option A: Fix ts-mls issues, live without External Commits
- Debug and fix the join flow bugs using the new MLS diagnostics tooling
- Fix the device trust persistence bug in Dusk
- Implement Stages 1-3 from #76 to work around the online-member requirement
- Least risky, but requires ~3 complex PRs (#73, #74, #75) to work around a limitation that External Commits solve natively
- ts-mls remains unaudited

### Option B: Implement External Commits in ts-mls
- ts-mls is open source (MIT license)
- Would need to implement GroupInfo generation, External Commit creation/processing
- Non-trivial crypto work — the External Commit path through the ratchet tree is different from normal commits
- High risk: modifying someone else's crypto library with no formal audit

### Option C: Replace ts-mls with OpenMLS (Rust → WASM)
- OpenMLS has full RFC 9420 support including External Commits
- Rust compiled to WASM — runs in both Node.js (Electron) and browser
- Battle-tested, actively maintained, used by Wire in production, formally analyzed
- The `mls.ts` wrapper layer (~600 lines) would need rewriting to call OpenMLS instead of ts-mls
- The `encryptedChat.ts` orchestration layer stays mostly the same but gets simpler (External Commits eliminate many code paths)
- Server infrastructure (pending welcomes, durable events, etc.) stays as-is
- New server endpoint: publish/fetch GroupInfo per scope
- Closes or simplifies #75, #74, #76, #66 and addresses #24's concerns more cleanly
- No official npm package for OpenMLS WASM bindings yet — may need to build from source with wasm-pack

### Option D: Hybrid — fix immediate bugs now, evaluate OpenMLS
- Phase 1: Fix device trust bug + debug join flow with diagnostics (unblocks Dusk immediately)
- Phase 2: Ship #73 (transparent UX) — pure UI, no protocol dependency
- Phase 3: Prototype OpenMLS WASM — build from source, test in harness, measure bundle size
- Phase 4: If viable, swap ts-mls → OpenMLS, add External Commit support, simplify #74/#75/#76

---

## Recommendation

**Option D.** Ship the UX improvements (#73) since they're valuable regardless of library choice. Prototype OpenMLS WASM to see if the library swap is viable. If it is, it solves or simplifies 6 open issues and puts the crypto on an audited foundation — that's where the effort should go rather than building the complex workarounds in #74 and #75.

The key insight: #74 and #75 together are significant engineering effort to work around a limitation that External Commits solve natively. If OpenMLS is viable, that effort is better spent on the library swap.

---

## Immediate Action Items

1. **Ship #73** (transparent encryption UX) — pure UI work, no protocol dependency, immediate user impact
2. **Prototype OpenMLS WASM** — `wasm-pack build` with `--target web`, test in a minimal harness, check bundle size and API surface
3. **If OpenMLS works**: plan the `mls.ts` rewrite + GroupInfo server endpoint + External Commit integration
4. **If OpenMLS doesn't work** (WASM too large, API gaps, build issues): proceed with #74 and #75 as designed
5. **Use MLS diagnostics to catch regressions** — the contributors built `MLSDiagnostics` and E2E helpers for exactly this
