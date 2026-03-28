import type { Locator, Page } from '@playwright/test'

/**
 * The Slate editor selector used across all E2E tests.
 * Matches the data-testid on the Editable component.
 */
export const COMPOSER_SELECTOR = '[data-testid="message-input"]'
export const THREAD_COMPOSER_SELECTOR = '.vesper-thread-panel [data-testid="message-input"]'

/**
 * Type text into a Slate contentEditable editor.
 * Replaces the old textarea .fill() pattern.
 */
export async function fillSlateEditor(page: Page, locator: Locator, text: string): Promise<void> {
  await locator.click()
  await page.keyboard.press('Meta+a')
  if (text) {
    await page.keyboard.type(text)
  } else {
    await page.keyboard.press('Backspace')
  }
}

/**
 * Clear a Slate contentEditable editor.
 */
export async function clearSlateEditor(page: Page, locator: Locator): Promise<void> {
  await locator.click()
  await page.keyboard.press('Meta+a')
  await page.keyboard.press('Backspace')
}
