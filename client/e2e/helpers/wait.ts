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
  await waitForSocketConnected(page).catch(() => {})

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const state = await page.evaluate((name) => {
      const activeTitle = document
        .querySelector('.vesper-channel-sidebar-title')
        ?.textContent
        ?.trim()
      if (activeTitle === name) {
        return 'open'
      }

      const railButtons = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[data-testid="sidebar"] .vesper-server-rail button[title]')
      )
      return railButtons.some((button) => button.title === name) ? 'listed' : 'missing'
    }, serverName).catch(() => 'missing')

    if (state === 'open' || state === 'listed') {
      return
    }

    await page.waitForTimeout(200)
  }

  const sidebarDiagnostics = await page.evaluate(() => ({
    activeTitle:
      document.querySelector('.vesper-channel-sidebar-title')?.textContent?.trim() ?? null,
    railTitles: Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-testid="sidebar"] .vesper-server-rail button[title]')
    ).map((button) => button.title)
  })).catch(() => ({ activeTitle: null, railTitles: [] as string[] }))

  throw new Error(
    `Server "${serverName}" did not appear in the sidebar within 30000ms: ` +
    JSON.stringify(sidebarDiagnostics)
  )
}

export async function waitForChannel(page: Page, channelName: string): Promise<void> {
  await page.waitForSelector(`.vesper-channel-row-label:has-text("${channelName}")`, {
    timeout: 10_000,
  })
}

export async function waitForChannelEncryptionReady(
  page: Page,
  timeout = 30_000
): Promise<void> {
  await waitForSocketConnected(page).catch(() => {})

  const deadline = Date.now() + timeout
  let lastStatus:
    | {
        scopeId: string | null
        ready: boolean
        hasGroup: boolean
        diagnostics: Record<string, unknown> | null
      }
    | null = null

  while (Date.now() < deadline) {
    const status = await page.evaluate(async () => {
      const bridge = window.__vesperE2eeTest
      if (!bridge) {
        return {
          scopeId: null,
          ready: false,
          hasGroup: false,
          diagnostics: null
        }
      }

      const scopeId = await bridge.resolveActiveChannelScopeId()
      if (!scopeId) {
        return {
          scopeId: null,
          ready: false,
          hasGroup: false,
          diagnostics: null
        }
      }

      const ready = await bridge.prepareScopeForRead(
        { kind: 'channel', id: scopeId },
        { reason: 'e2e_active_channel_wait' }
      ).catch(() => false)

      return {
        scopeId,
        ready,
        hasGroup: bridge.hasGroup(scopeId),
        diagnostics: bridge.getScopeDiagnostics(scopeId)
      }
    }).catch(() => ({
      scopeId: null,
      ready: false,
      hasGroup: false,
      diagnostics: null
    }))

    lastStatus = status
    if (status.ready) {
      return
    }

    await page.waitForTimeout(250)
  }

  throw new Error(
    `Channel encryption did not become ready within ${timeout}ms: ${JSON.stringify(lastStatus)}`
  )
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
              sending: element.classList.contains('vesper-message-row-sending'),
              failed: element.classList.contains('vesper-message-row-failed'),
              text:
                (element as HTMLElement).innerText ??
                element.textContent ??
                ''
            }))
          )

          for (const row of rowMatches) {
            const normalizedRowText = normalizeVisibleText(row.text)
            if (
              row.visible &&
              !row.sending &&
              !row.failed &&
              normalizedRowText.includes(normalizedTarget)
            ) {
              return 1
            }
          }
          return 0
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

  // If still showing the banner after timeout, throw with diagnostics
  const stillReconnecting = await reconnectBanner.isVisible().catch(() => false)
  if (stillReconnecting) {
    const diag = await page.evaluate(() => {
      const w = window as Record<string, unknown>
      return {
        apiUrl: w.VESPER_API_URL,
        hasAccessToken: !!localStorage.getItem('accessToken'),
        wsLog: (w.__wsLog as unknown[])?.slice(-20) ?? 'no-log',
      }
    }).catch(() => ({ error: 'could not evaluate' }))

    throw new Error(
      `Socket still reconnecting after ${timeout}ms\n` +
      `Diagnostics: ${JSON.stringify(diag, null, 2)}`
    )
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

export async function waitForDmEncryptionReady(
  page: Page,
  timeout = 30_000
): Promise<void> {
  await waitForSocketConnected(page).catch(() => {})

  const deadline = Date.now() + timeout

  while (Date.now() < deadline) {
    // Check if the encryption error alert is gone (encryption is ready)
    const alertVisible = await page.locator('.vesper-composer-alert').isVisible().catch(() => false)
    if (!alertVisible) return

    // Dismiss the alert and wait for recovery
    const dismissBtn = page.locator('.vesper-composer-alert button')
    if (await dismissBtn.first().isVisible().catch(() => false)) {
      await dismissBtn.first().click().catch(() => {})
    }

    await page.waitForTimeout(500)
  }
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
