import type { Locator, Page } from '@playwright/test'
import { sendAttachmentWithEncryptionRetry, sendMessageWithEncryptionRetry } from './sendRetry'
import { waitForSocketConnected } from './wait'

const ENCRYPTION_READY_TIMEOUT = 30_000
const ENCRYPTION_POLL_INTERVAL = 500
const DM_HYDRATION_TIMEOUT = 5_000

export async function openDmView(page: Page): Promise<void> {
  const dmButton = page.locator('[data-testid="sidebar"] button[title="Direct Messages"]')
  const classes = await dmButton.getAttribute('class')
  if (!classes?.includes('bg-accent')) {
    await dmButton.click()
  }
  await page.waitForSelector('text=Direct Messages', { timeout: 5_000 })
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
  const normalizedDisplayName = displayName.trim()
  const initialState = await resolveDmState(page, normalizedDisplayName)
  if (initialState.kind === 'open') {
    const row = await findDmRow(page, normalizedDisplayName)
    if (row) {
      await row.click()
      await waitForOpenDm(page, normalizedDisplayName)
      return
    }

    await waitForSocketConnected(page)
    return
  }
  if (initialState.kind === 'listed') {
    await initialState.row.click()
    await waitForOpenDm(page, normalizedDisplayName)
    return
  }

  const hydratedState = await waitForDmState(page, normalizedDisplayName, DM_HYDRATION_TIMEOUT)
  if (hydratedState.kind === 'open') {
    return
  }
  if (hydratedState.kind === 'listed') {
    await hydratedState.row.click()
    await waitForOpenDm(page, normalizedDisplayName)
    return
  }

  await openDmView(page)

  await page.waitForFunction((name) => {
    return Array.from(document.querySelectorAll('[data-testid="dm-row"]')).some((element) =>
      element.textContent?.includes(name)
    )
  }, normalizedDisplayName, { timeout: 15_000 })

  const row = await findDmRow(page, normalizedDisplayName)
  if (!row) {
    throw new Error(`Could not find DM row for ${normalizedDisplayName}`)
  }

  await row.click()
  await waitForOpenDm(page, normalizedDisplayName)
}

async function findDmRow(page: Page, displayName: string): Promise<Locator | null> {
  const rows = page.getByTestId('dm-row')
  const count = await rows.count()

  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index)
    const text = (await row.textContent().catch(() => null))?.trim()
    if (text?.includes(displayName)) {
      return row
    }
  }

  return null
}

async function waitForOpenDm(page: Page, displayName: string): Promise<void> {
  await page.waitForFunction((name) => {
    const title = document
      .querySelector('.vesper-chat-header .text-text-primary.font-semibold')
      ?.textContent
      ?.trim()
    return title === name && Boolean(document.querySelector('.vesper-composer-textarea'))
  }, displayName, { timeout: 10_000 })

  await waitForSocketConnected(page)
  await waitForEncryptionReady(page)

  // Allow async scope watch to complete Phoenix channel subscription.
  // joinChannelChat fires the watch asynchronously; this gives it
  // time to connect before tests interact with the channel.
  await page.waitForTimeout(3_000)
}

async function resolveDmState(
  page: Page,
  displayName: string
): Promise<
  | { kind: 'open' }
  | { kind: 'listed'; row: Locator }
  | { kind: 'missing' }
> {
  const header = page.locator('.vesper-chat-header .text-text-primary.font-semibold')
  const composer = page.locator('.vesper-composer-textarea')
  const currentHeader =
    (await header.count().catch(() => 0)) > 0
      ? (await header.first().textContent().catch(() => null))?.trim()
      : null

  if (currentHeader === displayName && await composer.isVisible().catch(() => false)) {
    return { kind: 'open' }
  }

  const row = await findDmRow(page, displayName)
  if (row) {
    return { kind: 'listed', row }
  }

  return { kind: 'missing' }
}

async function waitForDmState(
  page: Page,
  displayName: string,
  timeoutMs: number
): Promise<
  | { kind: 'open' }
  | { kind: 'listed'; row: Locator }
  | { kind: 'missing' }
> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const state = await resolveDmState(page, displayName)
    if (state.kind !== 'missing') {
      return state
    }

    await page.waitForTimeout(200)
  }

  return { kind: 'missing' }
}

export async function sendDmMessage(page: Page, text: string): Promise<void> {
  await sendMessageWithEncryptionRetry(
    page,
    page.locator('.vesper-composer-textarea'),
    page.getByTestId('message-row'),
    text,
    { timeout: ENCRYPTION_READY_TIMEOUT, errorLabel: 'DM' }
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
  await sendAttachmentWithEncryptionRetry(
    page,
    textarea,
    page.locator('[data-testid="message-row"] [data-testid="attachment"]'),
    { errorLabel: 'DM attachment' }
  )
}
