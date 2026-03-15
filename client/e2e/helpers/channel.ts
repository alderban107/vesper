/**
 * Channel messaging helpers.
 * Covers: R-CHANNEL-1, R-CHANNEL-2, R-CHANNEL-3, R-CHANNEL-4
 */

import type { Page } from '@playwright/test'
import { waitForMessage, waitForThreadPanel } from './wait'

const ENCRYPTION_READY_TIMEOUT = 20_000
const ENCRYPTION_POLL_INTERVAL = 500

/** Send a message in the current channel. Retries if encryption is still syncing.
 *  When the message contains custom emoji shortcodes that get rendered as images,
 *  pass `waitForText` with a text fragment that will still be visible after rendering.
 */
export async function sendChannelMessage(page: Page, text: string, waitForText?: string): Promise<void> {
  const deadline = Date.now() + ENCRYPTION_READY_TIMEOUT
  const confirmText = waitForText ?? text
  let sent = false

  while (Date.now() < deadline) {
    if (!sent) {
      const input = page.locator('[data-testid="message-input"]')
      await input.fill(text)
      await input.press('Enter')
      sent = true
    }

    // Wait for either the message to appear, an encryption error, or timeout
    const result = await Promise.race([
      page.waitForSelector(`[data-testid="message-row"]:has-text("${confirmText}")`, { timeout: 10_000 })
        .then(() => 'sent' as const),
      page.waitForSelector('.vesper-composer-alert', { timeout: 10_000 })
        .then(() => 'error' as const),
    ]).catch(() => 'timeout' as const)

    if (result === 'sent') return

    // Only retry on encryption error (not timeout — the first send may still be processing)
    if (result === 'error') {
      sent = false
      const alert = page.locator('.vesper-composer-alert')
      if (await alert.isVisible().catch(() => false)) {
        const dismissBtn = alert.locator('button')
        if (await dismissBtn.isVisible().catch(() => false)) {
          await dismissBtn.click().catch(() => {})
        }
      }
      const input = page.locator('[data-testid="message-input"]')
      await input.fill('')
      await page.waitForTimeout(ENCRYPTION_POLL_INTERVAL)
    }
  }

  throw new Error(`Could not send channel message "${text}" — encryption did not become ready within ${ENCRYPTION_READY_TIMEOUT}ms`)
}

/** Get all visible messages (root-level, not thread replies). */
export async function getChannelMessages(page: Page): Promise<string[]> {
  const messages = page.locator('[data-testid="message-row"] [data-testid="message-content"]')
  return messages.allTextContents()
}

/** Open a thread from a message containing the given text. */
export async function openThread(page: Page, messageText: string): Promise<void> {
  const row = page.locator(`[data-testid="message-row"]:has-text("${messageText}")`).first()
  // Hover to show action row
  await row.hover()
  // Click the "Start thread" action button (not the thread-link)
  await row.locator('[data-testid="thread-button"].vesper-message-action-button').click()
  await waitForThreadPanel(page)
}

/** Send a reply in the open thread panel. Retries if encryption is still syncing. */
export async function sendThreadReply(page: Page, text: string): Promise<void> {
  const deadline = Date.now() + ENCRYPTION_READY_TIMEOUT
  let sent = false

  while (Date.now() < deadline) {
    if (!sent) {
      const textarea = page.locator('.vesper-thread-composer-textarea')
      await textarea.fill(text)
      await textarea.press('Enter')
      sent = true
    }

    const result = await Promise.race([
      page.waitForSelector(`.vesper-thread-feed :text("${text}")`, { timeout: 10_000 })
        .then(() => 'sent' as const),
      page.waitForSelector('.vesper-composer-alert', { timeout: 10_000 })
        .then(() => 'error' as const),
    ]).catch(() => 'timeout' as const)

    if (result === 'sent') return

    if (result === 'error') {
      sent = false
      const alert = page.locator('.vesper-composer-alert')
      if (await alert.isVisible().catch(() => false)) {
        const dismissBtn = alert.locator('button')
        if (await dismissBtn.isVisible().catch(() => false)) {
          await dismissBtn.click().catch(() => {})
        }
      }
      const textarea = page.locator('.vesper-thread-composer-textarea')
      await textarea.fill('')
      await page.waitForTimeout(ENCRYPTION_POLL_INTERVAL)
    }
  }

  throw new Error(`Could not send thread reply "${text}" — encryption did not become ready within ${ENCRYPTION_READY_TIMEOUT}ms`)
}

/** Get all thread replies from the open thread panel. */
export async function getThreadReplies(page: Page): Promise<string[]> {
  const replies = page.locator('.vesper-thread-feed [data-testid="message-content"]')
  return replies.allTextContents()
}

/** Close the thread panel. */
export async function closeThread(page: Page): Promise<void> {
  await page.click('.vesper-thread-close')
  await page.waitForSelector('.vesper-thread-panel', { state: 'hidden', timeout: 5_000 })
}

/** Get the thread reply count shown on a parent message. */
export async function getThreadCount(page: Page, messageText: string): Promise<number> {
  const row = page.locator(`[data-testid="message-row"]:has-text("${messageText}")`)
  const badge = row.locator('[data-testid="thread-count"]')
  if (!(await badge.isVisible())) return 0
  const text = await badge.textContent()
  return parseInt(text || '0', 10)
}

/** Upload a file attachment in the current channel. */
export async function uploadChannelAttachment(
  page: Page,
  filePath: string
): Promise<void> {
  const fileInput = page.locator('.vesper-composer-form input[type="file"]')
  await fileInput.setInputFiles(filePath)
  await page.waitForSelector('.vesper-composer-icon-button .animate-spin', {
    state: 'hidden',
    timeout: 10_000,
  })
}

/** Start typing in the channel (triggers typing indicator). */
export async function startChannelTyping(page: Page): Promise<void> {
  const input = page.locator('[data-testid="message-input"]')
  await input.type('typing...', { delay: 50 })
}

/** Clear the channel composer. */
export async function clearChannelComposer(page: Page): Promise<void> {
  const input = page.locator('[data-testid="message-input"]')
  await input.fill('')
}
