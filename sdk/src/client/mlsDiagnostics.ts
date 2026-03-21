/**
 * MLS diagnostics counters for observing protocol health.
 *
 * Tracks per-scope metrics (epoch transitions, welcome attempts, join
 * request handling, key package consumption) with negligible runtime cost.
 * Always-on — each operation is an integer increment + Map lookup.
 *
 * Tests read these counters via `getDiagnostics().forScope(scopeId)` and
 * assert that values stay within expected budgets. An epoch count of 58
 * when you expected 2 is the kind of thing that should fail a build.
 */

export interface ScopeDiagnostics {
  /** Current MLS epoch for this scope's group. */
  epoch: number
  /** Number of times createGroup completed for this scope. */
  groupCreations: number
  /** Number of commits successfully processed. */
  commitsProcessed: number
  /** Number of commits that failed (wrong epoch, wrong group, etc.). */
  commitsFailed: number
  /** Number of welcomes successfully processed. */
  welcomesProcessed: number
  /** Number of welcomes that failed (no matching key package, etc.). */
  welcomesFailed: number
  /** Number of join requests handled (add-member operations). */
  joinRequestsHandled: number
  /** Number of key packages consumed locally during group creation. */
  keyPackagesConsumed: number
}

function emptyScopeDiagnostics(): ScopeDiagnostics {
  return {
    epoch: 0,
    groupCreations: 0,
    commitsProcessed: 0,
    commitsFailed: 0,
    welcomesProcessed: 0,
    welcomesFailed: 0,
    joinRequestsHandled: 0,
    keyPackagesConsumed: 0
  }
}

export class MLSDiagnostics {
  private readonly scopes = new Map<string, ScopeDiagnostics>()

  private ensure(scopeId: string): ScopeDiagnostics {
    let entry = this.scopes.get(scopeId)
    if (!entry) {
      entry = emptyScopeDiagnostics()
      this.scopes.set(scopeId, entry)
    }
    return entry
  }

  recordGroupCreated(scopeId: string): void {
    this.ensure(scopeId).groupCreations++
  }

  recordCommit(scopeId: string, succeeded: boolean): void {
    const entry = this.ensure(scopeId)
    if (succeeded) {
      entry.commitsProcessed++
    } else {
      entry.commitsFailed++
    }
  }

  recordWelcome(scopeId: string, succeeded: boolean): void {
    const entry = this.ensure(scopeId)
    if (succeeded) {
      entry.welcomesProcessed++
    } else {
      entry.welcomesFailed++
    }
  }

  recordJoinRequestHandled(scopeId: string): void {
    this.ensure(scopeId).joinRequestsHandled++
  }

  recordKeyPackageConsumed(scopeId: string): void {
    this.ensure(scopeId).keyPackagesConsumed++
  }

  updateEpoch(scopeId: string, epoch: number): void {
    this.ensure(scopeId).epoch = epoch
  }

  /** Get diagnostics for a single scope, or null if no events recorded. */
  forScope(scopeId: string): ScopeDiagnostics | null {
    return this.scopes.get(scopeId) ?? null
  }

  /** Get a snapshot of all scope diagnostics. */
  allScopes(): Record<string, ScopeDiagnostics> {
    const result: Record<string, ScopeDiagnostics> = {}
    for (const [id, entry] of this.scopes) {
      result[id] = { ...entry }
    }
    return result
  }

  /** Clear diagnostics for a single scope. */
  clearScope(scopeId: string): void {
    this.scopes.delete(scopeId)
  }

  /** Reset all diagnostics. */
  reset(): void {
    this.scopes.clear()
  }
}
