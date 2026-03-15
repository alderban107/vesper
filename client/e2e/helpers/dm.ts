/**
 * DM helpers: create conversations, send messages, verify state.
 * Covers: R-DM-1, R-DM-2, R-DM-3, R-DM-4, R-DM-5
 */

import type { Page } from '@playwright/test'
import { waitForMessage } from './wait'

const ENCRYPTION_READY_TIMEOUT = 10_000
const ENCRYPTION_POLL_INTERVAL = 500

/** Navigate to the DM view by clicking the DM icon in the server rail. */
export async function openDmView(page: Page): Promise<void> {
  await page.click('[data-testid="sidebar"] button[title="Direct Messages"]')
  await page.waitForSelector('text=Direct Messages', { timeout: 5_000 })
}

/** Create a new DM with a user by username. */
export async function createDm(page: Page, username: string): Promise<void> {
  await openDmView(page)

  // Click the + button to open NewDmModal
  await page.click('[data-testid="sidebar"] button[title="New Message"]')
  await page.waitForSelector('text=New Message', { timeout: 5_000 })

  // Fill username and submit
  await page.locator('input[placeholder="Enter exact username"]').fill(username)
  await page.click('button:has-text("Start Chat")')

  // Wait for the modal to close and the DM to be selected
  await page.waitForSelector('text=New Message', { state: 'hidden', timeout: 5_000 })

  // Wait for the composer to appear
  await page.waitForSelector('.vesper-composer-textarea', { timeout: 5_000 })

  // Wait for MLS encryption to sync before allowing sends
  await waitForEncryptionReady(page)
}

/** Select an existing DM conversation by the other user's display text. */
export async function selectDm(page: Page, displayName: string): Promise<void> {
  await openDmView(page)
  await page.click(`button:has-text("${displayName}")`)
  // Wait for the composer to appear
  await page.waitForSelector('.vesper-composer-textarea', { timeout: 5_000 })
}

/** Send a message in the current DM. Retries if encryption is still syncing. */
export async function sendDmMessage(page: Page, text: string): Promise<void> {
  const deadline = Date.now() + ENCRYPTION_READY_TIMEOUT

  while (Date.now() < deadline) {
    const textarea = page.locator('.vesper-composer-textarea')
    await textarea.fill(text)
    await textarea.press('Enter')

    // Give the send a moment to process
    await page.waitForTimeout(400)

    // Check if encryption error banner appeared
    const alert = page.locator('.vesper-composer-alert')
    const alertVisible = await alert.isVisible().catch(() => false)

    if (alertVisible) {
      // Dismiss the banner, clear composer, wait, retry
      const dismissBtn = alert.locator('button')
      if (await dismissBtn.isVisible().catch(() => false)) {
        await dismissBtn.click().catch(() => {})
      }
      await textarea.fill('')
      await page.waitForTimeout(ENCRYPTION_POLL_INTERVAL)
      continue
    }

    // No error — wait for the message to appear
    await waitForMessage(page, text)
    return
  }

  throw new Error(`Could not send DM "${text}" — encryption did not become ready within ${ENCRYPTION_READY_TIMEOUT}ms`)
}

/**
 * Wait for the MLS encryption to be ready by dismissing any existing error banners.
 */
async function waitForEncryptionReady(page: Page): Promise<void> {
  const deadline = Date.now() + ENCRYPTION_READY_TIMEOUT

  while (Date.now() < deadline) {
    const alert = page.locator('.vesper-composer-alert')
    const alertVisible = await alert.isVisible().catch(() => false)

    if (!alertVisible) return

    // Dismiss the banner and wait
    const dismissBtn = alert.locator('button')
    if (await dismissBtn.isVisible().catch(() => false)) {
      await dismissBtn.click().catch(() => {})
    }
    await page.waitForTimeout(ENCRYPTION_POLL_INTERVAL)
  }
}

/** Send typing in the current DM (type some text without pressing Enter). */
export async function startDmTyping(page: Page): Promise<void> {
  const textarea = page.locator('.vesper-composer-textarea')
  await textarea.type('typing...', { delay: 50 })
}

/** Clear the DM composer without sending. */
export async function clearDmComposer(page: Page): Promise<void> {
  const textarea = page.locator('.vesper-composer-textarea')
  await textarea.fill('')
}

/** Get all visible DM message texts. */
export async function getDmMessages(page: Page): Promise<string[]> {
  const messages = page.locator('[data-testid="message-row"] [data-testid="message-content"]')
  return messages.allTextContents()
}

/** Upload a file attachment in the current DM. */
export async function uploadDmAttachment(
  page: Page,
  filePath: string
): Promise<void> {
  const fileInput = page.locator('.vesper-composer-form input[type="file"]')
  await fileInput.setInputFiles(filePath)
  // Wait for upload to complete (loader disappears)
  await page.waitForSelector('.vesper-composer-icon-button .animate-spin', {
    state: 'hidden',
    timeout: 10_000,
  })
}
