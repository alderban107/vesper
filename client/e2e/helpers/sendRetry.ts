import { expect, type Locator, type Page } from '@playwright/test'

const DEFAULT_TIMEOUT = 60_000
const POLL_INTERVAL = 500

interface SendOptions {
  timeout?: number
  /** Text to match in the feed. Defaults to the message text itself. */
  confirmText?: string
  /**
   * If true, skip the evaluateAll visibility/class filtering and just use
   * waitForMessage-style detection (simpler, used by DMs).
   */
  simplePoll?: boolean
  errorLabel?: string
}

/**
 * Send a message and retry if MLS encryption isn't ready yet.
 *
 * The encryption handshake can lag behind the UI, so the composer may show an
 * error banner on the first attempt. This helper wraps the fill-send-check
 * cycle and retries on those transient encryption errors until the message
 * actually lands in the feed.
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
    if (!sent) {
      await inputLocator.fill(text)
      await inputLocator.press('Enter')
      sent = true
    }

    if (opts.simplePoll) {
      // DM-style: brief pause then check for error banner before polling the feed
      await page.waitForTimeout(400)
      const alert = page.locator('.vesper-composer-alert')
      const alertVisible = await alert.isVisible().catch(() => false)
      if (alertVisible) {
        sent = false
        await dismissEncryptionAlert(page)
        await inputLocator.fill('')
        await page.waitForTimeout(POLL_INTERVAL)
        continue
      }
      // No error -- wait for the message to appear via the standard visibility poll
      await pollForVisibleMessage(feedLocator, confirmText)
      return
    }

    // Channel/thread style: race the feed poll against the error banner
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
    }
  }

  throw new Error(
    `Could not send ${errorLabel} "${text}" -- encryption did not become ready within ${timeout}ms`
  )
}

/**
 * Poll until a confirmed (not sending, not failed, actually visible) message
 * appears in the feed. Used by channel and thread senders.
 */
function pollForConfirmedMessage(feedLocator: Locator, text: string): Promise<void> {
  return expect
    .poll(
      async () =>
        feedLocator
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
          ),
      { timeout: 10_000 }
    )
    .toBeGreaterThan(0)
}

/**
 * Simpler visibility poll: waits for any matching message-row to be rendered
 * and visible. Used by DM sender via waitForMessage.
 */
function pollForVisibleMessage(feedLocator: Locator, text: string): Promise<void> {
  return expect
    .poll(
      async () =>
        feedLocator
          .filter({ hasText: text })
          .evaluateAll((elements) =>
            elements.filter((el) => {
              if (!(el instanceof HTMLElement)) return false
              const style = window.getComputedStyle(el)
              if (style.visibility === 'hidden' || style.display === 'none') return false
              return el.getClientRects().length > 0
            }).length
          ),
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
