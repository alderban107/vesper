import type { Page } from '@playwright/test'
import {
  waitForServerInSidebar,
  waitForChannel,
  waitForSocketConnected
} from './wait'

export async function createServer(page: Page, name: string): Promise<void> {
  await page.click('[data-testid="sidebar"] button[title="Create Server"]')
  await page.waitForSelector('text=Create a Server', { timeout: 10_000 })

  await page.locator('input[type="text"]').fill(name)
  await page.click('button:has-text("Create")')

  await page.waitForSelector('text=Create a Server', { state: 'hidden', timeout: 15_000 })
  await waitForServerInSidebar(page, name)
}

export async function createChannel(page: Page, name: string): Promise<void> {
  await page.click('.vesper-guild-header-button')
  await page.waitForSelector('.vesper-guild-header-menu', { timeout: 5_000 })
  await page.click('.vesper-guild-header-menu >> text=Create Channel')

  const nameInput = page.locator('form.glass-card input[type="text"]')
  await nameInput.waitFor({ state: 'visible', timeout: 5_000 })
  await nameInput.fill(name)

  // Wait for React state to propagate to the submit button
  const submitBtn = page.locator('form.glass-card button[type="submit"]')
  await submitBtn.waitFor({ state: 'visible', timeout: 2_000 })

  const [response] = await Promise.all([
    page.waitForResponse((res) => res.url().includes('/channels') && res.request().method() === 'POST', { timeout: 10_000 }),
    submitBtn.click(),
  ])

  if (!response.ok()) {
    const body = await response.text().catch(() => 'no body')
    throw new Error(`Create channel API failed (${response.status()}): ${body}`)
  }

  await waitForChannel(page, name)
}

export async function createVoiceChannel(page: Page, name: string): Promise<void> {
  await page.click('.vesper-guild-header-button')
  await page.waitForSelector('.vesper-guild-header-menu', { timeout: 5_000 })
  await page.click('.vesper-guild-header-menu >> text=Create Channel')

  const modal = page.locator('.glass-card:has-text("Create Channel")').last()
  await modal.waitFor({ state: 'visible', timeout: 5_000 })

  const nameInput = modal.locator('input[type="text"]')
  await nameInput.waitFor({ state: 'visible', timeout: 5_000 })

  const voiceTypeButton = modal.locator('button:has-text("Voice Channel")').first()
  await voiceTypeButton.click()
  await nameInput.fill(name)

  const submitBtn = modal.locator('button[type="submit"]')
  await submitBtn.waitFor({ state: 'visible', timeout: 2_000 })

  const [response] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes('/channels') && res.request().method() === 'POST',
      { timeout: 10_000 }
    ),
    submitBtn.click(),
  ])

  if (!response.ok()) {
    const body = await response.text().catch(() => 'no body')
    throw new Error(`Create voice channel API failed (${response.status()}): ${body}`)
  }

  await waitForChannel(page, name)
}

export async function getInviteCode(page: Page): Promise<string> {
  await page.click('.vesper-guild-header-button')
  await page.waitForSelector('.vesper-guild-header-menu', { timeout: 5_000 })
  const [response] = await Promise.all([
    page.waitForResponse(
      (res) =>
        res.url().includes('/invite-code') &&
        res.request().method() === 'GET',
      { timeout: 10_000 }
    ),
    page.click('.vesper-guild-header-menu >> text=Copy Invite Code'),
  ])

  if (!response.ok()) {
    const body = await response.text().catch(() => 'no body')
    throw new Error(`Could not get invite code (${response.status()}): ${body}`)
  }

  const data = await response.json().catch(() => null) as { invite_code?: string } | null
  const inviteCode = data?.invite_code?.trim()

  if (!inviteCode) {
    throw new Error('Could not get invite code: missing invite_code payload')
  }

  return inviteCode
}

export async function joinServerWithCode(page: Page, inviteCode: string): Promise<void> {
  await page.click('[data-testid="sidebar"] button[title="Join Server"]')
  await page.waitForSelector('text=Join a Server', { timeout: 10_000 })

  await page.locator('input[type="text"]').fill(inviteCode)
  await page.click('button:has-text("Join")')

  await page.waitForSelector('text=Join a Server', { state: 'hidden', timeout: 15_000 })
  await waitForSocketConnected(page)
}

export async function selectServer(page: Page, serverName: string): Promise<void> {
  await waitForServerInSidebar(page, serverName)

  const deadline = Date.now() + 10_000

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
        document.querySelectorAll<HTMLButtonElement>(
          '[data-testid="sidebar"] .vesper-server-rail button[title]'
        )
      )

      return railButtons.some((button) => button.title === name) ? 'listed' : 'missing'
    }, serverName).catch(() => 'missing')

    if (state === 'open') {
      return
    }

    if (state === 'listed') {
      await page
        .locator(`[data-testid="sidebar"] .vesper-server-rail button[title="${serverName}"]`)
        .first()
        .click({ timeout: 2_000 })
        .catch(() => {})
    }

    await page.waitForTimeout(200)
  }

  throw new Error(`Server "${serverName}" did not become active within 10000ms`)
}

export async function selectChannel(page: Page, channelName: string): Promise<void> {
  const activeLabel = page.locator('.vesper-channel-row-active .vesper-channel-row-label')
  const activeName =
    (await activeLabel.count().catch(() => 0)) > 0
      ? (await activeLabel.first().textContent().catch(() => null))?.trim()
      : null

  if (activeName !== channelName) {
    await page.click(`.vesper-channel-row:has(.vesper-channel-row-label:text("${channelName}"))`)
    await page.waitForSelector(
      `.vesper-channel-row-active .vesper-channel-row-label:text("${channelName}")`,
      { timeout: 10_000 }
    )
  }

  await page.waitForSelector('[data-testid="message-input"]', { timeout: 10_000 })
}

export async function getChannelNames(page: Page): Promise<string[]> {
  const labels = page.locator('.vesper-channel-row-label')
  return labels.allTextContents()
}

export async function getMemberNames(page: Page): Promise<string[]> {
  const memberPanel = page.locator('[data-testid="member-list"]')
  if (!(await memberPanel.isVisible())) {
    await page.click('[data-testid="toggle-members"]')
    await page.waitForSelector('[data-testid="member-list"]', { timeout: 5_000 })
  }
  const names = page.locator('[data-testid="member-list"] [data-testid="member-name"]')
  return names.allTextContents()
}
