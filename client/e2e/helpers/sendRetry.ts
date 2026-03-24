import { expect, type Locator, type Page } from '@playwright/test'
import { waitForSocketConnected } from './wait'

const DEFAULT_TIMEOUT = 60_000
const POLL_INTERVAL = 500

interface SendOptions {
  timeout?: number
  /** Text to match in the feed. Defaults to the message text itself. */
  confirmText?: string
  errorLabel?: string
}

interface AttachmentSendOptions {
  timeout?: number
  errorLabel?: string
}

/**
 * Send a message and retry if MLS encryption isn't ready yet.
 *
 * The encryption handshake can lag behind the UI, so the composer may show an
 * error banner on the first attempt. This helper wraps the fill-send-check
 * cycle and retries on those transient encryption errors until the message is
 * confirmed in the feed.
 */
export async function sendMessageWithEncryptionRetry(
  page: Page,
  inputLocator: Locator,
  feedLocator: Locator,
  text: string,
  opts: SendOptions = {}
): Promise<void> {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT
  const confirmText = opts.confirmText ?? text
  const errorLabel = opts.errorLabel ?? 'message'
  const deadline = Date.now() + timeout
  let sent = false

  while (Date.now() < deadline) {
    if (await page.locator('text=Reconnecting to server').isVisible().catch(() => false)) {
      await waitForSocketConnected(page)
    }

    if (!sent) {
      await inputLocator.fill(text)
      await inputLocator.press('Enter')
      sent = true
    }

    // Wait for a confirmed row, not just an optimistic local placeholder.
    const result = await Promise.race([
      pollForConfirmedMessage(feedLocator, confirmText).then(() => 'sent' as const),
      page.waitForSelector('.vesper-composer-alert', { timeout: 10_000 }).then(() => 'error' as const),
    ]).catch(() => 'timeout' as const)

    if (result === 'sent') return

    if (result === 'error') {
      sent = false
      await dismissEncryptionAlert(page)
      await inputLocator.fill('')
      await page.waitForTimeout(POLL_INTERVAL)
      continue
    }

    if (await page.locator('text=Reconnecting to server').isVisible().catch(() => false)) {
      sent = false
      await waitForSocketConnected(page)
      await page.waitForTimeout(POLL_INTERVAL)
    }
  }

  throw new Error(
    `Could not send ${errorLabel} "${text}" -- encryption did not become ready within ${timeout}ms`
  )
}

export async function sendAttachmentWithEncryptionRetry(
  page: Page,
  submitLocator: Locator,
  feedAttachmentLocator: Locator,
  opts: AttachmentSendOptions = {}
): Promise<void> {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT
  const errorLabel = opts.errorLabel ?? 'attachment'
  const deadline = Date.now() + timeout
  let submitted = false

  while (Date.now() < deadline) {
    if (await page.locator('text=Reconnecting to server').isVisible().catch(() => false)) {
      await waitForSocketConnected(page)
    }

    if (!submitted) {
      await submitLocator.press('Enter')
      submitted = true
    }

    const result = await Promise.race([
      expect
        .poll(
          async () => {
            try {
              return await feedAttachmentLocator.evaluateAll((elements) =>
                elements.filter((el) => {
                  if (!(el instanceof HTMLElement)) return false
                  const style = window.getComputedStyle(el)
                  if (style.visibility === 'hidden' || style.display === 'none') return false
                  return el.getClientRects().length > 0
                }).length
              )
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              if (
                message.includes('Execution context was destroyed') ||
                message.includes('Target page, context or browser has been closed')
              ) {
                return 0
              }
              throw error
            }
          },
          { timeout: 10_000 }
        )
        .toBeGreaterThan(0)
        .then(() => 'sent' as const),
      page.waitForSelector('.vesper-composer-alert', { timeout: 10_000 }).then(() => 'error' as const),
    ]).catch(() => 'timeout' as const)

    if (result === 'sent') {
      return
    }

    if (result === 'error') {
      submitted = false
      await dismissEncryptionAlert(page)
      await page.waitForTimeout(POLL_INTERVAL)
      continue
    }

    if (await page.locator('text=Reconnecting to server').isVisible().catch(() => false)) {
      submitted = false
      await waitForSocketConnected(page)
      await page.waitForTimeout(POLL_INTERVAL)
    }
  }

  throw new Error(
    `Could not send ${errorLabel} -- encryption did not become ready within ${timeout}ms`
  )
}

/**
 * Poll until a confirmed (not sending, not failed, actually visible) message
 * appears in the feed. Used by channel and thread senders.
 */
function pollForConfirmedMessage(feedLocator: Locator, text: string): Promise<void> {
  return expect
    .poll(
      async () => {
        try {
          return await feedLocator
            .filter({ hasText: text })
            .evaluateAll((elements) =>
              elements.filter((el) => {
                if (!(el instanceof HTMLElement)) return false
                if (el.classList.contains('vesper-message-row-sending')) return false
                if (el.classList.contains('vesper-message-row-failed')) return false
                const style = window.getComputedStyle(el)
                if (style.visibility === 'hidden' || style.display === 'none') return false
                return el.getClientRects().length > 0
              }).length
            )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (
            message.includes('Execution context was destroyed') ||
            message.includes('Target page, context or browser has been closed')
          ) {
            return 0
          }
          throw error
        }
      },
      { timeout: 10_000 }
    )
    .toBeGreaterThan(0)
}

async function dismissEncryptionAlert(page: Page): Promise<void> {
  const alert = page.locator('.vesper-composer-alert')
  if (await alert.isVisible().catch(() => false)) {
    const dismissBtn = alert.locator('button')
    if (await dismissBtn.isVisible().catch(() => false)) {
      await dismissBtn.click().catch(() => {})
    }
  }
}
