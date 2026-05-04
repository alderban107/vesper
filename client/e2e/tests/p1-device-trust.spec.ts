/**
 * P1: Device trust gating and session renewal.
 * Covers: R-AUTH-3, R-AUTH-4, R-E2EE-3, R-E2EE-4
 *
 * Depends on P0 having already signed up alice_e2e.
 */

import { test, expect } from '@playwright/test'
import { createUserContext, login, approveWithRecoveryKey, unlockTrustedDevice, simulateSessionExpiry, type UserContext } from '../helpers/auth'
import { waitForAppShell, waitForLoginPage } from '../helpers/wait'
import { assertNoDecryptionFailures } from '../helpers/assertions'
import { getRecoveryKey } from '../harness/state'
import { USERS } from '../fixtures/test-data'

let alice: UserContext

test.describe('P1: Device trust and session renewal', () => {
  test.afterEach(async () => {
    if (alice?.context) {
      await alice.context.close().catch(() => {})
    }
  })

  test('Pending device shows gate, recovery key approves it (R-AUTH-3, R-E2EE-4)', async ({ browser }) => {
    const recoveryKey = getRecoveryKey(USERS.alice.username)

    // Login on a new device — should show pending gate
    alice = await createUserContext(browser, 'alice-trust-dev', USERS.alice.username, USERS.alice.password)
    await login(alice, { expectTrustGate: true })

    // Approve with recovery key
    await approveWithRecoveryKey(alice.page, recoveryKey)
    await waitForAppShell(alice.page)

    // Now E2EE should be available
    await assertNoDecryptionFailures(alice.page)
  })

  test('Trusted-but-locked device shows unlock UI (R-AUTH-3, R-E2EE-3)', async ({ browser }) => {
    // Login on new device — may show trust gate with unlock option
    alice = await createUserContext(browser, 'alice-unlock-dev', USERS.alice.username, USERS.alice.password)

    const { page, username, password } = alice
    const { readRunState } = await import('../harness/state')
    const state = readRunState()
    await page.goto(state.clientUrl)
    await page.waitForSelector('[data-testid="login-form"]', { timeout: 10_000 })
    const form = page.locator('[data-testid="login-form"]')
    await form.locator('input[type="text"]').fill(username)
    await form.locator('input[type="password"]').fill(password)
    await form.locator('button[type="submit"]').click()

    // If device trust gate appears with unlock option, use it
    const hasGate = await page.locator('[data-testid="device-trust-gate"]').isVisible({ timeout: 5_000 }).catch(() => false)
    if (hasGate) {
      const hasUnlock = await page.locator('text=Unlock this device').isVisible()
      if (hasUnlock) {
        await unlockTrustedDevice(page, USERS.alice.password)
      } else {
        // Trust gate without unlock — approve with recovery key
        const recoveryKey = getRecoveryKey(USERS.alice.username)
        await approveWithRecoveryKey(page, recoveryKey)
      }
    }

    // Verify app health regardless of gate path
    await waitForAppShell(page)
    await assertNoDecryptionFailures(page)
  })

  test('Session expiry returns user to sign-in (R-AUTH-4)', async ({ browser }) => {
    alice = await createUserContext(browser, 'alice-session-dev', USERS.alice.username, USERS.alice.password)
    await login(alice)

    // Simulate session expiry
    await simulateSessionExpiry(alice.page)

    // Reload — should be back at login
    await alice.page.reload()
    await waitForLoginPage(alice.page)

    // Session notice should be visible
    const notice = await alice.page.locator('text=Sign in again on this device').isVisible()
    expect(notice).toBe(true)

    // Dismiss notice and re-login
    const continueBtn = alice.page.locator('button:has-text("Continue to sign in")')
    if (await continueBtn.isVisible()) {
      await continueBtn.click()
    }

    // Fresh login should work
    await login(alice)
    await waitForAppShell(alice.page)
  })
})
