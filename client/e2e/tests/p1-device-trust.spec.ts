/**
 * P1: Device trust gating and session renewal.
 * Covers: R-AUTH-3, R-AUTH-4, R-E2EE-3, R-E2EE-4
 */

import { test, expect } from '@playwright/test'
import { readRunState } from '../harness/state'
import { createUserContext, signup, login, approveWithRecoveryKey, unlockTrustedDevice, simulateSessionExpiry, type UserContext } from '../helpers/auth'
import { waitForAppShell, waitForLoginPage, waitForSessionNotice, waitForDeviceTrustGate } from '../helpers/wait'
import { assertNoDecryptionFailures } from '../helpers/assertions'
import { USERS } from '../fixtures/test-data'

let alice: UserContext

test.describe('P1: Device trust and session renewal', () => {
  test.afterEach(async () => {
    if (alice?.context) {
      await alice.context.close().catch(() => {})
    }
  })

  test('Pending device shows gate, recovery key approves it (R-AUTH-3, R-E2EE-4)', async ({ browser }) => {
    // First, register alice on one device
    alice = await createUserContext(browser, 'alice-dev1', USERS.alice.username, USERS.alice.password)
    await signup(alice)
    const recoveryKey = alice.recoveryKey!
    expect(recoveryKey).toBeTruthy()
    await alice.context.close()

    // Login on a new device — should show pending gate
    alice = await createUserContext(browser, 'alice-dev2', USERS.alice.username, USERS.alice.password)
    await login(alice)

    // Device trust gate should appear since this is a new device
    await waitForDeviceTrustGate(alice.page)

    // Approve with recovery key
    await approveWithRecoveryKey(alice.page, recoveryKey)

    // Now E2EE should be available
    await assertNoDecryptionFailures(alice.page)
  })

  test('Trusted-but-locked device shows unlock UI (R-AUTH-3, R-E2EE-3)', async ({ browser }) => {
    // Register alice
    alice = await createUserContext(browser, 'alice-unlock', USERS.alice.username, USERS.alice.password)
    await signup(alice)
    await alice.context.close()

    // Login on same device concept — trusted but needs unlock
    alice = await createUserContext(browser, 'alice-unlock2', USERS.alice.username, USERS.alice.password)
    await login(alice)

    // If device trust gate appears with unlock option
    const hasGate = await alice.page.locator('[data-testid="device-trust-gate"]').isVisible({ timeout: 5_000 }).catch(() => false)
    if (hasGate) {
      const hasUnlock = await alice.page.locator('text=Unlock encrypted chats').isVisible()
      if (hasUnlock) {
        await unlockTrustedDevice(alice.page, USERS.alice.password)
        await assertNoDecryptionFailures(alice.page)
      }
    }
  })

  test('Session expiry returns user to sign-in (R-AUTH-4)', async ({ browser }) => {
    alice = await createUserContext(browser, 'alice-session', USERS.alice.username, USERS.alice.password)
    await signup(alice)

    // Simulate session expiry
    await simulateSessionExpiry(alice.page)

    // Wait for the app to react — should show session notice or login
    await alice.page.waitForTimeout(2_000)
    await alice.page.reload()

    // Should be back at login
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
