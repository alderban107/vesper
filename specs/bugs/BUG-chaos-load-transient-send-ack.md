# A transient double-negative message acknowledgement becomes a definitive send failure

## Reproduce

Environment: macOS, Node SDK physical multi-cohort load, local PostgreSQL, 6 users, 9 actor devices, 2 rooms, 6 cohorts, 15-second timed phase, 500 ms p95 budget.

The audit load completed cryptographic setup and sent 267 messages, but recorded one `Failed to send message in chat:channel:<id>` failure. Decrypt failures, restore misses, repair events, query/fanout budgets, and latency percentiles were all clean. Teardown left zero partition databases and artifacts.

## Isolate

`performSend` in the load driver selected only actors marked connected, so an intentionally offline actor was not the source. The generic error can only be reached after `withReadyApplicationOperation` executed the push callback without throwing, `pushScopeEvent` returned false after its watcher-recovery retry, and the two-second nonce confirmation did not observe the message.

The server message path is idempotent on `(scope, sender, client_nonce)` and returns the existing message without re-broadcasting on retry. The SDK already persists that nonce before the network write, but `performSend` treats the unresolved acknowledgement as definitive unless the topology generation changed.

## Hypothesize

1. **Primary: transport uncertainty is incorrectly classified as definitive failure even though the send has a durable idempotency key.**
   - Prediction: one bounded resend with the same client nonce succeeds after two injected false acknowledgements and creates one logical message.
   - Falsification: the bounded resend creates duplicates or still fails when the third acknowledgement succeeds.
2. **The load scheduler selected a disconnected actor.**
   - Prediction: the failed actor has `connected == false`.
   - Falsification: `selectConnectedActor` filters that state and timed operations are serialized.
3. **Room topology changed during the send.**
   - Prediction: refreshing topology returns a newer generation and the existing topology retry runs.
   - Falsification: the fixture performs no topology migration during the timed phase and the generic failure remains possible when generation is unchanged.

## Verify

Confirmed root cause: the message send owns a durable idempotency key, but its retry classification did not. After two channel acknowledgement failures and an inconclusive confirmation sync, an unchanged topology caused immediate failure and deletion of the pending send. That path converts an ambiguous transport result into a definitive protocol result.

The fix performs one bounded resend after refreshing topology regardless of whether the generation changed. It reuses the original client nonce, so an accepted first attempt resolves the existing server row and cannot duplicate fanout. A live-stack regression test injects two false acknowledgements, allows the next push, and asserts that send succeeds with exactly one server message.
