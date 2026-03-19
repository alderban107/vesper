import { expect, type Page } from '@playwright/test'

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
  const rows = page.getByTestId('message-row').filter({ hasText: text })

  await expect
    .poll(
      async () =>
        rows.evaluateAll((elements) =>
          elements.filter((element) => {
            if (!(element instanceof HTMLElement)) return false
            const style = window.getComputedStyle(element)
            if (style.visibility === 'hidden' || style.display === 'none') return false
            return element.getClientRects().length > 0
          }).length
        ),
      { timeout }
    )
    .toBeGreaterThan(0)
}

export async function waitForDmConversation(page: Page, username: string): Promise<void> {
  await page.waitForSelector(`[data-testid="dm-row"]:has-text("${username}")`, {
    timeout: 15_000,
  })
}

export async function waitForSocketConnected(page: Page): Promise<void> {
  // The app logs "Joined user:<id>" on socket connect -- wait for the shell
  // plus a brief stabilization window.
  await waitForAppShell(page)
  await page.waitForTimeout(1_000)
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
