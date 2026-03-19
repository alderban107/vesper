import type { Page } from '@playwright/test'
import { sendMessageWithEncryptionRetry } from './sendRetry'

const ENCRYPTION_READY_TIMEOUT = 10_000
const ENCRYPTION_POLL_INTERVAL = 500

export async function openDmView(page: Page): Promise<void> {
  await page.click('[data-testid="sidebar"] button[title="Direct Messages"]')
  await page.waitForSelector('text=Direct Messages', { timeout: 5_000 })
  await page.waitForFunction(() => {
    const composer = document.querySelector('.vesper-composer-textarea')
    return !composer
  }, { timeout: 5_000 })
}

export async function createDm(page: Page, username: string): Promise<void> {
  await openDmView(page)

  await page.click('[data-testid="sidebar"] button[title="New Message"]')
  await page.waitForSelector('text=New Message', { timeout: 5_000 })

  await page.locator('input[placeholder="Enter exact username"]').fill(username)
  await page.click('button:has-text("Start Chat")')

  await page.waitForSelector('text=New Message', { state: 'hidden', timeout: 5_000 })
  await page.waitForSelector('.vesper-composer-textarea', { timeout: 5_000 })

  // MLS encryption may not be ready yet -- dismiss error banners until it syncs
  await waitForEncryptionReady(page)
}

export async function selectDm(page: Page, displayName: string): Promise<void> {
  await openDmView(page)
  await page.click(`[data-testid="dm-row"]:has-text("${displayName}")`)
  await page.waitForSelector('.vesper-composer-textarea', { timeout: 5_000 })
}

export async function sendDmMessage(page: Page, text: string): Promise<void> {
  await sendMessageWithEncryptionRetry(
    page,
    page.locator('.vesper-composer-textarea'),
    page.getByTestId('message-row'),
    text,
    { timeout: ENCRYPTION_READY_TIMEOUT, simplePoll: true, errorLabel: 'DM' }
  )
}

async function waitForEncryptionReady(page: Page): Promise<void> {
  const deadline = Date.now() + ENCRYPTION_READY_TIMEOUT

  while (Date.now() < deadline) {
    const alert = page.locator('.vesper-composer-alert')
    const alertVisible = await alert.isVisible().catch(() => false)

    if (!alertVisible) return

    const dismissBtn = alert.locator('button')
    if (await dismissBtn.isVisible().catch(() => false)) {
      await dismissBtn.click().catch(() => {})
    }
    await page.waitForTimeout(ENCRYPTION_POLL_INTERVAL)
  }
}

export async function startDmTyping(page: Page): Promise<void> {
  const textarea = page.locator('.vesper-composer-textarea')
  await textarea.type('typing...', { delay: 50 })
}

export async function clearDmComposer(page: Page): Promise<void> {
  const textarea = page.locator('.vesper-composer-textarea')
  await textarea.fill('')
}

export async function getDmMessages(page: Page): Promise<string[]> {
  const messages = page.locator('[data-testid="message-row"] [data-testid="message-content"]')
  return messages.allTextContents()
}

export async function uploadDmAttachment(
  page: Page,
  filePath: string
): Promise<void> {
  const fileInput = page.locator('.vesper-composer-form input[type="file"]')
  await fileInput.setInputFiles(filePath)
  await page.waitForSelector('.vesper-composer-icon-button .animate-spin', {
    state: 'hidden',
    timeout: 10_000,
  })

  const textarea = page.locator('.vesper-composer-textarea')
  await textarea.press('Enter')
}
