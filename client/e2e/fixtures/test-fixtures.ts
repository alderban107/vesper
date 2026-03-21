import { test as base } from '@playwright/test'
import { getMockScript } from './mock-api'

interface TestFixtures {
  /** A unique test user for this test run */
  testUser: { username: string; password: string }
}

/**
 * Custom test fixture that:
 * 1. Injects mock window.cryptoDb / window.electron / window.notifications
 *    before any app code runs
 * 2. Clears localStorage between tests for isolation
 * 3. Provides a unique testUser per test
 */
export const test = base.extend<TestFixtures>({
  testUser: async ({}, use) => {
    const id = Math.random().toString(36).slice(2, 10)
    await use({
      username: `testuser_${id}`,
      password: `TestPass123!_${id}`
    })
  },

  page: async ({ page }, use) => {
    // Inject mocks before any page navigation
    await page.addInitScript(getMockScript())

    // Clear localStorage for test isolation
    await page.addInitScript(() => {
      localStorage.clear()
    })

    await use(page)
  }
})

export { expect } from '@playwright/test'
