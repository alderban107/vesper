import { expect, type Page } from '@playwright/test'

function normalizeVisibleText(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFKC')
    .replace(/[\u2012-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

export async function waitForAppShell(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="main-page"]', { timeout: 10_000 })
}

export async function waitForLoginPage(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="login-form"]', { timeout: 10_000 })
}

export async function waitForRegisterPage(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="register-form"]', { timeout: 10_000 })
}

export async function waitForRecoveryModal(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="recovery-modal"]', { timeout: 30_000 })
}

export async function waitForServerInSidebar(page: Page, serverName: string): Promise<void> {
  await page.waitForSelector(`[data-testid="sidebar"] button[title="${serverName}"]`, {
    timeout: 10_000,
  })
}

export async function waitForChannel(page: Page, channelName: string): Promise<void> {
  await page.waitForSelector(`.vesper-channel-row-label:has-text("${channelName}")`, {
    timeout: 10_000,
  })
}

export async function waitForMessage(page: Page, text: string, timeout = 10_000): Promise<void> {
  const normalizedTarget = normalizeVisibleText(text)

  await expect
    .poll(
      async () => {
        try {
          const rowMatches = await page.getByTestId('message-row').evaluateAll((elements) =>
            elements.map((element) => ({
              visible: (element as HTMLElement).offsetParent !== null,
              text:
                (element as HTMLElement).innerText ??
                element.textContent ??
                ''
            }))
          )

          for (const row of rowMatches) {
            const normalizedRowText = normalizeVisibleText(row.text)
            if (row.visible && normalizedRowText.includes(normalizedTarget)) {
              return 1
            }
          }

          const bodyText = await page
            .locator('body')
            .evaluate((element) => (element as HTMLElement).innerText ?? element.textContent ?? '')
            .catch(() => null)
          return normalizeVisibleText(bodyText).includes(normalizedTarget) ? 1 : 0
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
      { timeout }
    )
    .toBeGreaterThan(0)
}

export async function waitForDmConversation(page: Page, username: string): Promise<void> {
  await page.waitForSelector(`[data-testid="dm-row"]:has-text("${username}")`, {
    timeout: 15_000,
  })
}

export async function waitForSocketConnected(page: Page, timeout = 15_000): Promise<void> {
  await waitForAppShell(page)

  const reconnectBanner = page.locator('text=Reconnecting to server')
  const syncBanner = page.locator('text=Syncing latest activity')
  const deadline = Date.now() + timeout

  while (Date.now() < deadline) {
    const reconnecting = await reconnectBanner.isVisible().catch(() => false)
    const syncing = await syncBanner.isVisible().catch(() => false)

    if (!reconnecting && !syncing) {
      // Confirm stability: check twice more with a short gap
      await page.waitForTimeout(200)
      const stillReconnecting = await reconnectBanner.isVisible().catch(() => false)
      const stillSyncing = await syncBanner.isVisible().catch(() => false)
      if (!stillReconnecting && !stillSyncing) {
        return
      }
    }

    await page.waitForTimeout(300)
  }

  // If still showing the banner after timeout, throw so tests fail fast
  // with a clear message instead of timing out on the next assertion.
  const stillReconnecting = await reconnectBanner.isVisible().catch(() => false)
  if (stillReconnecting) {
    throw new Error(`Socket still reconnecting after ${timeout}ms — page is not connected to the server`)
  }
}

export async function waitForTypingIndicator(page: Page, username: string): Promise<void> {
  await page.waitForSelector(`[data-testid="typing-indicator"]:has-text("${username}")`, {
    timeout: 10_000,
  })
}

export async function waitForTypingGone(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="typing-indicator"]', {
    state: 'hidden',
    timeout: 10_000,
  })
}

export async function waitForUnreadBadge(page: Page, target: string): Promise<void> {
  await page.waitForSelector(`.vesper-channel-row:has-text("${target}") .vesper-channel-unread-badge`, {
    timeout: 10_000,
  })
}

export async function waitForDeviceTrustGate(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="device-trust-gate"]', { timeout: 15_000 })
}

export async function waitForDeviceTrustGateGone(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="device-trust-gate"]', {
    state: 'hidden',
    timeout: 10_000,
  })
}

export async function waitForThreadPanel(page: Page): Promise<void> {
  await page.waitForSelector('.vesper-thread-panel', { timeout: 10_000 })
}

export async function waitForThreadReplyCount(
  page: Page,
  count: number
): Promise<void> {
  await page.waitForSelector(`.vesper-thread-subtitle:has-text("${count}")`, {
    timeout: 10_000,
  })
}

export async function waitForSessionNotice(page: Page): Promise<void> {
  await page.waitForSelector(':text("Sign in again on this device")', { timeout: 15_000 })
}
