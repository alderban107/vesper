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

  // Convert base64 to a temporary file and upload via hidden input.
  // This triggers the EmojiUploadModal (ImageCropModal wrapper) to open.
  const buffer = Buffer.from(imageBase64, 'base64')
  const fileInput = page.locator('[data-testid="emoji-upload"]')

  await fileInput.setInputFiles({
    name: `${name}.png`,
    mimeType: 'image/png',
    buffer,
  })

  // Wait for the crop modal to appear
  await page.waitForSelector('[data-testid="image-crop-submit"]', { timeout: 10_000 })

  // Fill emoji name (the input inside EmojiUploadModal)
  const nameInput = page.locator('[data-testid="emoji-name-input"]')
  await nameInput.waitFor({ state: 'visible', timeout: 5_000 })
  await nameInput.fill(name)

  // Click the submit button inside the crop modal ("Finish")
  await page.click('[data-testid="image-crop-submit"]')

  // Wait for emoji to appear in the list (modal closes, settings page shows updated list)
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
    : page.locator('[data-testid="message-input"]')

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

  // Click the custom emoji (custom emojis have title=":name:")
  await page.click(`[data-testid="emoji-picker"] button[title=":${emojiName}:"]`)

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
  // Markdown rendering is lazy-loaded per renderer process. A message can be
  // present one paint before the emoji component has resolved, so wait for the
  // semantic DOM result rather than treating that intermediate fallback as a
  // failed custom-emoji delivery.
  const renderedEmoji = page.locator(
    [
      `img[alt=":${emojiName}:"]`,
      `img[alt="${emojiName}"]`,
      `img.vesper-inline-custom-emoji`,
    ].join(', ')
  )
  const deadline = Date.now() + 5_000

  while (Date.now() < deadline) {
    if (await renderedEmoji.count() > 0) {
      return true
    }

    await page.waitForTimeout(50)
  }

  return false
}
