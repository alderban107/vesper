/**
 * Message action helpers: react, edit, delete, pin.
 * Covers: R-DM-3, R-CHANNEL-5, R-CHANNEL-6, R-EMOJI-1, R-EMOJI-2
 */

import type { Page } from '@playwright/test'

/** Add a reaction to a message. */
export async function addReaction(
  page: Page,
  messageText: string,
  emoji: string
): Promise<void> {
  const row = page.locator(`[data-testid="message-row"]:has-text("${messageText}")`)
  await row.hover()
  await row.locator('[data-testid="react-button"]').click()

  // Wait for emoji picker
  await page.waitForSelector('[data-testid="emoji-picker"]', { timeout: 5_000 })

  // Click the target emoji
  await page.click(`[data-testid="emoji-picker"] button:has-text("${emoji}")`)

  // Wait for picker to close
  await page.waitForSelector('[data-testid="emoji-picker"]', {
    state: 'hidden',
    timeout: 5_000,
  })
}

/** Get reaction counts on a message. Returns Map<emoji, count>. */
export async function getReactions(
  page: Page,
  messageText: string
): Promise<Map<string, number>> {
  const row = page.locator(`[data-testid="message-row"]:has-text("${messageText}")`)
  const reactionButtons = row.locator('[data-testid="reaction-chip"]')
  const count = await reactionButtons.count()

  const reactions = new Map<string, number>()
  for (let i = 0; i < count; i++) {
    const chip = reactionButtons.nth(i)
    const text = await chip.textContent()
    if (!text) continue
    // Format is "emoji count" e.g. "👍 1"
    const match = text.match(/(.+?)\s*(\d+)/)
    if (match) {
      reactions.set(match[1].trim(), parseInt(match[2], 10))
    }
  }

  return reactions
}

/** Edit a message (author only). */
export async function editMessage(
  page: Page,
  originalText: string,
  newText: string
): Promise<void> {
  const row = page.locator(`[data-testid="message-row"]:has-text("${originalText}")`)
  await row.hover()
  await row.locator('[data-testid="message-menu-button"]').click()
  await page.click('[data-testid="edit-message"]')

  // Wait for edit mode — the message content becomes a textarea
  const editInput = row.locator('[data-testid="edit-input"]')
  await editInput.fill(newText)
  await editInput.press('Enter')

  // Wait for edited content to appear
  await page.waitForSelector(`[data-testid="message-row"]:has-text("${newText}")`, {
    timeout: 10_000,
  })
}

/** Delete a message (author only). */
export async function deleteMessage(page: Page, messageText: string): Promise<void> {
  const row = page.locator(`[data-testid="message-row"]:has-text("${messageText}")`)
  await row.hover()
  await row.locator('[data-testid="message-menu-button"]').click()
  await page.click('[data-testid="delete-message"]')

  // Confirm deletion if there's a confirm dialog
  const confirmBtn = page.locator('button:has-text("Delete")').last()
  if (await confirmBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await confirmBtn.click()
  }

  // Wait for message to disappear
  await page.waitForSelector(`[data-testid="message-row"]:has-text("${messageText}")`, {
    state: 'hidden',
    timeout: 10_000,
  })
}

/** Pin a message. */
export async function pinMessage(page: Page, messageText: string): Promise<void> {
  const row = page.locator(`[data-testid="message-row"]:has-text("${messageText}")`)
  await row.hover()
  await row.locator('[data-testid="message-menu-button"]').click()
  await page.click('[data-testid="pin-message"]')

  // Wait for pin confirmation
  await page.waitForTimeout(1_000)
}

/** Unpin a message. */
export async function unpinMessage(page: Page, messageText: string): Promise<void> {
  const row = page.locator(`[data-testid="message-row"]:has-text("${messageText}")`)
  await row.hover()
  await row.locator('[data-testid="message-menu-button"]').click()
  await page.click('[data-testid="unpin-message"]')
  await page.waitForTimeout(1_000)
}

/** Open the pins panel. */
export async function openPinsPanel(page: Page): Promise<void> {
  await page.click('[data-testid="toggle-pins"]')
  await page.waitForSelector('[data-testid="pins-panel"]', { timeout: 5_000 })
}

/** Get pinned message texts from the pins panel. */
export async function getPinnedMessages(page: Page): Promise<string[]> {
  const items = page.locator('[data-testid="pins-panel"] [data-testid="pinned-message"]')
  return items.allTextContents()
}

/** Click a pinned message to jump to it. */
export async function jumpToPinnedMessage(page: Page, text: string): Promise<void> {
  await page.click(`[data-testid="pins-panel"] [data-testid="pinned-message"]:has-text("${text}")`)
}
