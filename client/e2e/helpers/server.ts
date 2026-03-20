import type { Page } from '@playwright/test'
import { waitForServerInSidebar, waitForChannel } from './wait'

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
  await page.click('.vesper-guild-header-menu >> text=Copy Invite Code')

  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const code = await page.evaluate(async () => await navigator.clipboard.readText())
      .catch(() => '')
    if (code.trim().length > 0) {
      return code.trim()
    }

    await page.waitForTimeout(200)
  }

  throw new Error('Could not get invite code')
}

export async function joinServerWithCode(page: Page, inviteCode: string): Promise<void> {
  await page.click('[data-testid="sidebar"] button[title="Join Server"]')
  await page.waitForSelector('text=Join a Server', { timeout: 10_000 })

  await page.locator('input[type="text"]').fill(inviteCode)
  await page.click('button:has-text("Join")')

  await page.waitForSelector('text=Join a Server', { state: 'hidden', timeout: 15_000 })
}

export async function selectServer(page: Page, serverName: string): Promise<void> {
  await page.click(`[data-testid="sidebar"] button[title="${serverName}"]`)
  await page.waitForSelector('.vesper-channel-sidebar-title', { timeout: 10_000 })
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
