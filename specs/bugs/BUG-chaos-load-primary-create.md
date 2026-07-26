# Chaos load primary cannot create the initial encrypted scope

## Reproduce

Environment: macOS, local PostgreSQL on `127.0.0.1:5432`, Docker auto-start disabled. Run the chaos load with 3 physical users, 1 active channel, 3 seed messages, and a 5-second timed phase.

The harness registers the users, joins the channel socket for each assigned actor, then fails before multi-cohort preparation with `Primary actor could not create channel:<id>`. The failure is `ensureScopeReady(scope, true) === false` inside the pre-existing legacy bootstrap path.

## Isolate

`provisionScenario` creates the server with a dedicated admin device, but excludes that owner from `actorsByScope`. It then chooses the first invited load actor as `primaryActor` and calls `ensureScopeReady(scope, true)`. `ensureChannelGroupReady` explicitly permits initial creation of a server channel's legacy MLS group only when `localUserId === ownerUserId`; invited members correctly return `false`.

The failure occurs before the new multi-cohort helper runs. Watching the empty scope is not causal: the creator authorization branch rejects the selected actor based on stable server ownership.

## Hypothesize

1. **Primary: the load harness assigns initial group ownership to an invited actor instead of the server owner.**
   - Prediction: `resolveChannelOwnerId` differs from the selected primary actor, so `ensureChannelGroupReady(..., true)` returns false at the owner check.
   - Falsification: the selected actor is the server owner or creation still fails when the admin is the creator.
2. **Watching an empty scope corrupts local creation state.**
   - Prediction: skipping `watchScope` makes the same invited actor able to create.
   - Falsification: the source rejects the invited actor before `createGroup`, independent of watch state.
3. **The multi-cohort migration changes the effective topology too early.**
   - Prediction: the failed topology is already `multi_cohort`.
   - Falsification: the failure occurs during legacy bootstrap before the prepare endpoint is called.

## Verify

Confirmed root cause: the load harness violated the server-channel creator invariant. The admin creates the server, but an invited actor was selected to create the initial MLS group. The SDK intentionally restricts initial legacy group creation to the server owner, so the load command could compile yet could never bootstrap a normal server channel.

The fix is to make the admin actor the initial group creator and let all physical load devices join through the normal network path. This preserves the production authorization rule instead of weakening it for tests.
