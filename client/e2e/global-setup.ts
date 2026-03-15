/**
 * Playwright global setup: boots the local stack.
 * Covers: R-HARNESS-1, R-HARNESS-2, R-HARNESS-4
 */

import { bootStack } from './harness/stack'

export default async function globalSetup(): Promise<void> {
  console.log('[e2e] Global setup starting...')
  await bootStack()
  console.log('[e2e] Global setup complete.')
}
