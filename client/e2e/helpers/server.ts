/**
 * Server and channel helpers.
 * Covers: R-SERVER-1, R-SERVER-2, R-SERVER-3, R-SERVER-4, R-SERVER-5, R-SERVER-6
 */

import type { Page } from '@playwright/test'
import { waitForServerInSidebar, waitForChannel } from './wait'

/** Create a new server through the UI. */
export async function createServer(page: Page, name: string): Promise<void> {
  // Click the + (Create Server) button in the server rail
  await page.click('[data-testid="sidebar"] button[title="Create Server"]')
  await page.waitForSelector('text=Create a Server', { timeout: 10_000 })

  await page.locator('input[type="text"]').fill(name)
  await page.click('button:has-text("Create")')

  // Wait for modal to close and server to appear
  await page.waitForSelector('text=Create a Server', { state: 'hidden', timeout: 15_000 })
  await waitForServerInSidebar(page, name)
}

/** Create a text channel in the currently selected server. */
export async function createChannel(page: Page, name: string): Promise<void> {
  // Open server header menu
  await page.click('.vesper-guild-header-button')
  await page.waitForSelector('.vesper-guild-header-menu', { timeout: 5_000 })

  // Click "Create Channel" in the dropdown
  await page.click('.vesper-guild-header-menu >> text=Create Channel')

  // Wait for the channel name input in the modal form
  const nameInput = page.locator('form.glass-card input[type="text"]')
  await nameInput.waitFor({ state: 'visible', timeout: 5_000 })

  // Fill channel name
  await nameInput.fill(name)

  // Wait for submit button to be enabled (React state update)
  const submitBtn = page.locator('form.glass-card button[type="submit"]')
  await submitBtn.waitFor({ state: 'visible', timeout: 2_000 })

  // Click submit and wait for the API response
  const [response] = await Promise.all([
    page.waitForResponse((res) => res.url().includes('/channels') && res.request().method() === 'POST', { timeout: 10_000 }),
    submitBtn.click(),
  ])

  if (!response.ok()) {
    const body = await response.text().catch(() => 'no body')
    throw new Error(`Create channel API failed (${response.status()}): ${body}`)
  }

  // Wait for the channel to appear in the sidebar
  await waitForChannel(page, name)
}

/** Create a voice channel in the currently selected server. */
export async function createVoiceChannel(page: Page, name: string): Promise<void> {
  await page.click('.vesper-guild-header-button')
  await page.waitForSelector('.vesper-guild-header-menu', { timeout: 5_000 })
  await page.click('.vesper-guild-header-menu >> text=Create Channel')

  const nameInput = page.locator('form.glass-card input[type="text"]')
  await nameInput.waitFor({ state: 'visible', timeout: 5_000 })

  // Select voice channel type
  await page.click('text=Voice Channel')
  await nameInput.fill(name)
  await page.click('form.glass-card button[type="submit"]')

  await waitForChannel(page, name)
}

/** Get the invite code for the currently active server. */
export async function getInviteCode(page: Page): Promise<string> {
  // Click the invite link button in the sidebar header
  await page.click('[data-testid="sidebar"] button[title="Show invite code"]')

  // Wait for the invite code to appear
  const codeEl = await page.waitForSelector(
    '[data-testid="sidebar"] code',
    { timeout: 10_000 }
  )
  const code = await codeEl.textContent()
  if (!code) throw new Error('Could not get invite code')

  return code.trim()
}

/** Join a server using an invite code. */
export async function joinServerWithCode(page: Page, inviteCode: string): Promise<void> {
  // Click the "Join Server" button in the server rail
  await page.click('[data-testid="sidebar"] button[title="Join Server"]')
  await page.waitForSelector('text=Join a Server', { timeout: 10_000 })

  await page.locator('input[type="text"]').fill(inviteCode)
  await page.click('button:has-text("Join")')

  await page.waitForSelector('text=Join a Server', { state: 'hidden', timeout: 15_000 })
}

/** Click on a server in the server rail by name. */
export async function selectServer(page: Page, serverName: string): Promise<void> {
  await page.click(`[data-testid="sidebar"] button[title="${serverName}"]`)
  // Wait for channel list to load
  await page.waitForSelector('.vesper-channel-sidebar-title', { timeout: 10_000 })
}

/** Click on a channel by name. */
export async function selectChannel(page: Page, channelName: string): Promise<void> {
  await page.click(`.vesper-channel-row:has(.vesper-channel-row-label:text("${channelName}"))`)
  // Wait for composer to appear
  await page.waitForSelector('[data-testid="message-input"]', { timeout: 10_000 })
}

/** Get all visible channel names in the sidebar. */
export async function getChannelNames(page: Page): Promise<string[]> {
  const labels = page.locator('.vesper-channel-row-label')
  return labels.allTextContents()
}

/** Get all member names from the member list panel. */
export async function getMemberNames(page: Page): Promise<string[]> {
  // Open member list if not visible
  const memberPanel = page.locator('[data-testid="member-list"]')
  if (!(await memberPanel.isVisible())) {
    await page.click('[data-testid="toggle-members"]')
    await page.waitForSelector('[data-testid="member-list"]', { timeout: 5_000 })
  }
  const names = page.locator('[data-testid="member-list"] [data-testid="member-name"]')
  return names.allTextContents()
}
