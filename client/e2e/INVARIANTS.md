# End-to-end acceptance invariants

The old P1/P2 browser suite was a collection of order-dependent feature tours. It duplicated unit and context coverage, depended on state created by `p0-smoke.spec.ts`, and frequently reported selector/timing failures as product correctness failures. Those shells are not release gates.

The browser layer now keeps only tests that exercise a boundary the lower layers cannot prove:

| Browser test | Boundary it owns |
|---|---|
| `p0-smoke.spec.ts` | Renderer-to-server encrypted channel/DM exchange, cached DM plaintext on both peers, and refresh recovery. Darvell's cache assertions are preserved. |
| `p1-device-trust.spec.ts` | User-visible trusted-device approval/unlock flow. |
| `p1-multi-device.spec.ts` | Two live authorized devices receive and decrypt the same DM traffic. Darvell's concurrent-device assertions are preserved. |
| `p2-storage-contract.spec.ts` | Real browser IndexedDB and Electron SQLite checkpoint journals survive state deletion. |

Release acceptance comes from cross-layer invariants rather than one long browser scenario:

| Invariant | Authoritative coverage |
|---|---|
| Limited invites are capacity-safe and idempotent under concurrent redemption | `server/test/vesper/servers/invite_test.exs` |
| History is bounded by application tenure, including leave/rejoin away windows and concurrent channel creation | `server/test/vesper/history_authorization_test.exs` |
| A history sponsor cannot forge or roll back plaintext | `sdk/test/message-authenticity.test.mjs`, `server/test/vesper/history_authorization_test.exs` |
| A late-opening DM device recovers every authorized message without receiving pre-tenure data | `sdk/test/client-dx.test.mjs` |
| Room keys survive restart/topology change but remain unavailable to a rejoined tenure | `server/test/vesper/room_topology_test.exs`, `sdk/test/client-dx.test.mjs` |
| MLS control state, dispatch journals, replay cursors, and encrypted room keys survive adapter restart | `sdk/test/storage-hotpaths.test.mjs`, `sdk/test/client-dx.test.mjs`, `p2-storage-contract.spec.ts` |
| Sync pagination and compact-snapshot boundaries are deterministic | `server/test/vesper/urgent_sync_test.exs`, `server/test/vesper/sync_fuzz_test.exs`, SDK integration tests |
| Device churn, offline catch-up, revocation, and multi-device decryptability remain correct | `sdk/test/multi-device-chaos.test.mjs` |

A browser test should be added only when the invariant depends on browser/Electron integration. Context, protocol, transaction, and storage invariants belong at the lowest layer that can deterministically reproduce the failure.
