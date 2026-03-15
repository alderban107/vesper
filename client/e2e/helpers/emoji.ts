/**
 * Custom emoji helpers.
 * Covers: R-EMOJI-1, R-EMOJI-2
 */

import type { Page } from '@playwright/test'

/** Upload a custom emoji through the server settings UI. */
export async function uploadCustomEmoji(
  page: Page,
  name: string,
  imageBase64: string
): Promise<void> {
  // Open server settings
  await page.click('.vesper-guild-header-button')
  await page.waitForSelector('.vesper-guild-header-menu', { timeout: 5_000 })
  await page.click('text=Server Settings')
  await page.waitForSelector('[data-testid="server-settings"]', { timeout: 10_000 })

  // Navigate to emoji tab
  await page.click('[data-testid="emoji-tab"]')
  // The file input is intentionally hidden (class="hidden") — wait for it to exist in DOM
  await page.waitForSelector('[data-testid="emoji-upload"]', { state: 'attached', timeout: 5_000 })

  // Convert base64 to a temporary file and upload
  const buffer = Buffer.from(imageBase64, 'base64')
  const fileInput = page.locator('[data-testid="emoji-upload"]')

  await fileInput.setInputFiles({
    name: `${name}.png`,
    mimeType: 'image/png',
    buffer,
  })

  // Fill emoji name
  const nameInput = page.locator('[data-testid="emoji-name-input"]')
  if (await nameInput.isVisible()) {
    await nameInput.fill(name)
  }

  // Submit
  await page.click('[data-testid="emoji-save"]')

  // Wait for emoji to appear in the list
  await page.waitForSelector(`[data-testid="custom-emoji-list"] :text("${name}")`, {
    timeout: 15_000,
  })

  // Close server settings
  await page.keyboard.press('Escape')
}

/** Use a custom emoji in a message by typing :name: syntax. */
export async function useCustomEmojiInMessage(
  page: Page,
  emojiName: string,
  composer: 'channel' | 'dm' = 'channel'
): Promise<void> {
  const textarea = composer === 'channel'
    ? page.locator('[data-testid="message-input"]')
    : page.locator('.vesper-composer-textarea')

  await textarea.type(`:${emojiName}:`)
}

/** React with a custom emoji using the emoji picker. */
export async function reactWithCustomEmoji(
  page: Page,
  messageText: string,
  emojiName: string
): Promise<void> {
  const row = page.locator(`[data-testid="message-row"]:has-text("${messageText}")`)
  await row.hover()
  await row.locator('[data-testid="react-button"]').click()

  await page.waitForSelector('[data-testid="emoji-picker"]', { timeout: 5_000 })

  // Search for the custom emoji
  const searchInput = page.locator('[data-testid="emoji-picker"] input[type="text"]')
  if (await searchInput.isVisible()) {
    await searchInput.fill(emojiName)
  }

  // Click the custom emoji
  await page.click(`[data-testid="emoji-picker"] [data-emoji-name="${emojiName}"]`)

  await page.waitForSelector('[data-testid="emoji-picker"]', {
    state: 'hidden',
    timeout: 5_000,
  })
}

/** Check if a custom emoji renders correctly (not as raw :name: text). */
export async function isCustomEmojiRendered(
  page: Page,
  emojiName: string
): Promise<boolean> {
  // Custom emojis should render as <img> elements, not raw `:name:` text
  const rawToken = page.locator(`text=:${emojiName}:`)
  const renderedEmoji = page.locator(
    [
      `img[alt=":${emojiName}:"]`,
      `img[alt="${emojiName}"]`,
      `img.vesper-inline-custom-emoji`,
      `[data-emoji-name="${emojiName}"]`,
    ].join(', ')
  )

  const hasRaw = await rawToken.count() > 0
  const hasRendered = await renderedEmoji.count() > 0

  return hasRendered || !hasRaw
}
