import { expect, type Page } from '@playwright/test'
import { waitForThreadPanel } from './wait'
import { sendMessageWithEncryptionRetry } from './sendRetry'

/**
 * When the message contains custom emoji shortcodes that get rendered as images,
 * pass `waitForText` with a text fragment that will still be visible after rendering.
 */
export async function sendChannelMessage(page: Page, text: string, waitForText?: string): Promise<void> {
  await sendMessageWithEncryptionRetry(
    page,
    page.locator('[data-testid="message-input"]'),
    page.getByTestId('message-row'),
    text,
    { confirmText: waitForText, errorLabel: 'channel message' }
  )
}

export async function getChannelMessages(page: Page): Promise<string[]> {
  const messages = page.locator('[data-testid="message-row"] [data-testid="message-content"]')
  return messages.allTextContents()
}

export async function openThread(page: Page, messageText: string): Promise<void> {
  const row = page.locator(`[data-testid="message-row"]:has-text("${messageText}")`).first()
  await row.scrollIntoViewIfNeeded()
  await row.hover()
  const threadButton = row.locator('[data-testid="thread-button"].vesper-message-action-button')
  await threadButton.waitFor({ state: 'visible', timeout: 5_000 })
  await threadButton.click({ force: true })
  await waitForThreadPanel(page)
}

export async function sendThreadReply(page: Page, text: string): Promise<void> {
  await sendMessageWithEncryptionRetry(
    page,
    page.locator('.vesper-thread-composer-textarea'),
    page.locator('.vesper-thread-feed [data-testid="message-row"]'),
    text,
    { errorLabel: 'thread reply' }
  )
}

export async function getThreadReplies(page: Page): Promise<string[]> {
  await expect
    .poll(
      async () =>
        page
          .locator('.vesper-thread-feed [data-testid="message-row"]')
          .evaluateAll((elements) =>
            elements.filter((element) => {
              if (!(element instanceof HTMLElement)) return false
              const style = window.getComputedStyle(element)
              if (style.visibility === 'hidden' || style.display === 'none') return false
              return element.getClientRects().length > 0
            }).length
          ),
      { timeout: 10_000 }
    )
    .toBeGreaterThan(0)

  const replies = page.locator('.vesper-thread-feed [data-testid="message-content"]')
  return replies.allTextContents()
}

export async function closeThread(page: Page): Promise<void> {
  await page.click('.vesper-thread-close')
  await page.waitForSelector('.vesper-thread-panel', { state: 'hidden', timeout: 5_000 })
}

export async function getThreadCount(page: Page, messageText: string): Promise<number> {
  const row = page.locator(`[data-testid="message-row"]:has-text("${messageText}")`)
  const badge = row.locator('[data-testid="thread-count"]')
  if (!(await badge.isVisible())) return 0
  const text = await badge.textContent()
  return parseInt(text || '0', 10)
}

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

  const input = page.locator('[data-testid="message-input"]')
  await input.press('Enter')
}

export async function startChannelTyping(page: Page): Promise<void> {
  const input = page.locator('[data-testid="message-input"]')
  await input.type('typing...', { delay: 50 })
}

export async function clearChannelComposer(page: Page): Promise<void> {
  const input = page.locator('[data-testid="message-input"]')
  await input.fill('')
}
