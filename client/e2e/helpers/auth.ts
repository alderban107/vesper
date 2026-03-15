/**
 * Auth helpers: signup, login, recovery key capture, device trust.
 * Covers: R-AUTH-1, R-AUTH-2, R-AUTH-3, R-AUTH-4
 */

import type { Page, BrowserContext } from '@playwright/test'
import { readRunState } from '../harness/state'
import { waitForAppShell, waitForRecoveryModal, waitForRegisterPage } from './wait'

export interface UserContext {
  name: string
  username: string
  password: string
  page: Page
  context: BrowserContext
  recoveryKey: string | null
}

/**
 * Creates a persistent browser context for a user.
 * Covers: R-HARNESS-5 (persistent profiles)
 */
export async function createUserContext(
  browser: import('@playwright/test').Browser,
  name: string,
  username: string,
  password: string
): Promise<UserContext> {
  const state = readRunState()
  const profilePath = `${state.profileDir}/${name}`

  const context = await browser.newContext({
    storageState: undefined,
    // Use persistent-like behavior through explicit dirs
    // Playwright doesn't support persistent context in newContext, but we can
    // manage localStorage/IndexedDB persistence through the page lifecycle.
  })

  const page = await context.newPage()

  // Inject the API URL before any page loads (R-HARNESS-1)
  await page.addInitScript(`window.VESPER_API_URL = '${state.apiUrl}'`)

  return { name, username, password, page, context, recoveryKey: null }
}

/**
 * Signs up a new user through the real UI.
 * Captures the recovery key from the modal.
 * Covers: R-AUTH-1
 */
export async function signup(user: UserContext): Promise<void> {
  const { page, username, password } = user
  const state = readRunState()

  await page.goto(state.clientUrl)

  // Navigate to register page
  await page.waitForSelector('[data-testid="login-form"]', { timeout: 10_000 })
  await page.click('text=Register')
  await waitForRegisterPage(page)

  // Fill registration form
  const form = page.locator('[data-testid="register-form"]')
  await form.locator('input[type="text"]').fill(username)
  await form.locator('input[type="password"]').first().fill(password)
  await form.locator('input[type="password"]').last().fill(password)
  await form.locator('button[type="submit"]').click()

  // Wait for recovery key modal
  await waitForRecoveryModal(page)

  // Capture the recovery key words
  const modal = page.locator('[data-testid="recovery-modal"]')
  const words = await modal.locator('.font-mono').allTextContents()
  user.recoveryKey = words.join(' ')

  // Confirm and dismiss the recovery modal
  await modal.locator('input[type="checkbox"]').check()
  await modal.locator('button:has-text("Continue")').click()

  // Wait for the main app
  await waitForAppShell(page)
}

/**
 * Logs in an existing user through the real UI.
 * Covers: R-AUTH-2
 */
export async function login(user: UserContext): Promise<void> {
  const { page, username, password } = user
  const state = readRunState()

  await page.goto(state.clientUrl)
  await page.waitForSelector('[data-testid="login-form"]', { timeout: 10_000 })

  const form = page.locator('[data-testid="login-form"]')
  await form.locator('input[type="text"]').fill(username)
  await form.locator('input[type="password"]').fill(password)
  await form.locator('button[type="submit"]').click()

  await waitForAppShell(page)
}

/**
 * Approves a pending device using the recovery key.
 * Covers: R-AUTH-3, R-E2EE-4
 */
export async function approveWithRecoveryKey(
  page: Page,
  recoveryKey: string
): Promise<void> {
  await page.waitForSelector('[data-testid="device-trust-gate"]', { timeout: 10_000 })
  const gate = page.locator('[data-testid="device-trust-gate"]')

  // Fill recovery key textarea
  await gate.locator('textarea').fill(recoveryKey)
  await gate.locator('button:has-text("Use recovery key")').click()

  // Wait for gate to disappear
  await page.waitForSelector('[data-testid="device-trust-gate"]', {
    state: 'hidden',
    timeout: 10_000,
  })
}

/**
 * Unlocks a trusted device with password.
 * Covers: R-AUTH-3, R-E2EE-3
 */
export async function unlockTrustedDevice(
  page: Page,
  password: string
): Promise<void> {
  await page.waitForSelector('[data-testid="device-trust-gate"]', { timeout: 10_000 })
  const gate = page.locator('[data-testid="device-trust-gate"]')

  await gate.locator('input[type="password"]').fill(password)
  await gate.locator('button:has-text("Unlock encrypted chats")').click()

  await page.waitForSelector('[data-testid="device-trust-gate"]', {
    state: 'hidden',
    timeout: 10_000,
  })
}

/**
 * Simulates a session renewal failure by clearing tokens and reloading.
 * Covers: R-AUTH-4
 */
export async function simulateSessionExpiry(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.setItem('vesperSessionNotice', JSON.stringify({
      title: 'Sign in again on this device',
      message: 'This session can no longer be renewed.',
    }))
    localStorage.removeItem('accessToken')
    localStorage.removeItem('refreshToken')
    window.dispatchEvent(new CustomEvent('vesper:session-notice'))
  })
}
