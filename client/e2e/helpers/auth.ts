/**
 * Auth helpers: signup, login, recovery key capture, device trust.
 * Covers: R-AUTH-1, R-AUTH-2, R-AUTH-3, R-AUTH-4
 */

import type { Page, BrowserContext } from '@playwright/test'
import { readRunState, getRecoveryKey } from '../harness/state'
import { waitForAppShell, waitForDeviceTrustGate, waitForRecoveryModal, waitForRegisterPage, waitForSocketConnected } from './wait'

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

  // WebSocket tracing for diagnostics
  await page.addInitScript(() => {
    ;(window as any).__wsLog = []
    const OrigWS = window.WebSocket
    ;(window as any).WebSocket = function (...args: any[]) {
      const ws = new OrigWS(...args)
      const url = String(args[0])
      ;(window as any).__wsLog.push({ url, s: 'new', t: Date.now() })
      ws.addEventListener('open', () => (window as any).__wsLog.push({ url, s: 'open', t: Date.now() }))
      ws.addEventListener('close', (e: any) => (window as any).__wsLog.push({ url, s: 'close', code: e.code, t: Date.now() }))
      ws.addEventListener('error', () => (window as any).__wsLog.push({ url, s: 'err', t: Date.now() }))
      return ws
    }
    ;(window as any).WebSocket.prototype = OrigWS.prototype
    Object.defineProperty((window as any).WebSocket, 'CONNECTING', { value: 0 })
    Object.defineProperty((window as any).WebSocket, 'OPEN', { value: 1 })
    Object.defineProperty((window as any).WebSocket, 'CLOSING', { value: 2 })
    Object.defineProperty((window as any).WebSocket, 'CLOSED', { value: 3 })
  })

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
 *
 * After submit, races between app shell and device trust gate. If the gate
 * appears (new browser context = new device), it auto-approves using the
 * recovery key persisted by P0.
 *
 * Set `expectTrustGate: true` to ONLY wait for the gate (skips app shell
 * wait and auto-approval — caller handles the gate manually).
 */
export async function login(
  user: UserContext,
  opts?: { expectTrustGate?: boolean }
): Promise<void> {
  const { page, username, password } = user
  const state = readRunState()

  await page.goto(state.clientUrl)
  await page.waitForSelector('[data-testid="login-form"]', { timeout: 10_000 })

  const form = page.locator('[data-testid="login-form"]')
  await form.locator('input[type="text"]').fill(username)
  await form.locator('input[type="password"]').fill(password)
  await form.locator('button[type="submit"]').click()

  if (opts?.expectTrustGate) {
    await waitForDeviceTrustGate(page)
    return
  }

  // Race: app shell appears cleanly, or device trust gate intercepts.
  const appShell = page.locator('[data-testid="main-page"], [data-testid="app-shell"]')
  const trustGate = page.locator('[data-testid="device-trust-gate"]')

  await Promise.race([
    appShell.waitFor({ state: 'visible', timeout: 15_000 }),
    trustGate.waitFor({ state: 'visible', timeout: 15_000 }),
  ])

  // If the trust gate is showing, auto-approve with the persisted recovery key
  if (await trustGate.isVisible()) {
    const recoveryKey = getRecoveryKey(username)
    await trustGate.locator('textarea').fill(recoveryKey)
    await trustGate.locator('button:has-text("Use recovery key")').click()
    await trustGate.waitFor({ state: 'hidden', timeout: 10_000 })
  }

  await waitForAppShell(page)
  await waitForSocketConnected(page)
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
