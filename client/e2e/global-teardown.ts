/**
 * Playwright global teardown: stops processes and drops the E2E database.
 * Covers: R-HARNESS-2
 */

import { teardownStack } from './harness/stack'
import { readRunState, clearRunState } from './harness/state'

export default async function globalTeardown(): Promise<void> {
  console.log('[e2e] Global teardown starting...')
  try {
    const state = readRunState()
    teardownStack(state)
    clearRunState()
  } catch (err) {
    console.warn('[e2e] Teardown encountered an issue:', err)
  }
  console.log('[e2e] Global teardown complete.')
}
