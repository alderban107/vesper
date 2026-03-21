/**
 * MLS diagnostics helpers for E2E tests.
 *
 * Reads per-scope counters from the SDK's MLSDiagnostics instance
 * (exposed on `window.__mlsDiagnostics` by the renderer) and asserts
 * that values stay within expected budgets.
 *
 * Usage:
 *   const diag = await getMlsDiagnostics(bob.page, scopeId)
 *   assertMlsBudget(diag, { maxEpoch: 2, maxJoinRequestsHandled: 1 }, 'bob DM')
 */

import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'

export interface ScopeDiagnosticsSnapshot {
  epoch: number
  groupCreations: number
  commitsProcessed: number
  commitsFailed: number
  welcomesProcessed: number
  welcomesFailed: number
  joinRequestsHandled: number
  keyPackagesConsumed: number
}

export interface MlsBudget {
  maxEpoch?: number
  maxGroupCreations?: number
  maxCommitsProcessed?: number
  maxCommitsFailed?: number
  maxWelcomesProcessed?: number
  maxWelcomesFailed?: number
  maxJoinRequestsHandled?: number
  maxKeyPackagesConsumed?: number
}

/**
 * Read MLS diagnostics for a scope from a Playwright page.
 * Returns null if no diagnostics are available (scope not touched).
 */
export async function getMlsDiagnostics(
  page: Page,
  scopeId: string
): Promise<ScopeDiagnosticsSnapshot | null> {
  return await page.evaluate((id: string) => {
    const diag = (window as any).__mlsDiagnostics
    if (!diag) return null
    const scope = diag.forScope(id)
    if (!scope) return null
    // Return a plain object (structuredClone-safe)
    return {
      epoch: scope.epoch,
      groupCreations: scope.groupCreations,
      commitsProcessed: scope.commitsProcessed,
      commitsFailed: scope.commitsFailed,
      welcomesProcessed: scope.welcomesProcessed,
      welcomesFailed: scope.welcomesFailed,
      joinRequestsHandled: scope.joinRequestsHandled,
      keyPackagesConsumed: scope.keyPackagesConsumed
    }
  }, scopeId)
}

/**
 * Assert that MLS diagnostics for a scope stay within the given budget.
 *
 * Each field in the budget is optional — only specified fields are checked.
 * Failure messages are explicit about which counter exceeded its budget
 * so developers can immediately identify epoch storms or thundering herds.
 */
export function assertMlsBudget(
  diagnostics: ScopeDiagnosticsSnapshot | null,
  budget: MlsBudget,
  label: string
): void {
  expect(diagnostics, `MLS diagnostics missing for ${label}`).not.toBeNull()
  if (!diagnostics) return

  const checks: Array<[string, number, number | undefined]> = [
    ['epoch', diagnostics.epoch, budget.maxEpoch],
    ['groupCreations', diagnostics.groupCreations, budget.maxGroupCreations],
    ['commitsProcessed', diagnostics.commitsProcessed, budget.maxCommitsProcessed],
    ['commitsFailed', diagnostics.commitsFailed, budget.maxCommitsFailed],
    ['welcomesProcessed', diagnostics.welcomesProcessed, budget.maxWelcomesProcessed],
    ['welcomesFailed', diagnostics.welcomesFailed, budget.maxWelcomesFailed],
    ['joinRequestsHandled', diagnostics.joinRequestsHandled, budget.maxJoinRequestsHandled],
    ['keyPackagesConsumed', diagnostics.keyPackagesConsumed, budget.maxKeyPackagesConsumed],
  ]

  for (const [name, actual, max] of checks) {
    if (max !== undefined) {
      expect(
        actual,
        `MLS budget exceeded for ${label}: ${name} = ${actual}, max allowed = ${max}`
      ).toBeLessThanOrEqual(max)
    }
  }
}
