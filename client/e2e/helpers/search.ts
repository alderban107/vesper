/**
 * Search helpers.
 * Covers: R-MSG-3
 */

import type { Page } from '@playwright/test'

/** Open the search bar. */
export async function openSearch(page: Page): Promise<void> {
  await page.click('[data-testid="search-button"]')
  await page.waitForSelector('[data-testid="search-input"]', { timeout: 5_000 })
}

/** Search for a query string. */
export async function searchFor(page: Page, query: string): Promise<void> {
  await openSearch(page)
  await page.locator('[data-testid="search-input"]').fill(query)
  // Wait for results
  await page.waitForSelector('[data-testid="search-results"]', { timeout: 15_000 })
}

/** Get search result texts. */
export async function getSearchResults(page: Page): Promise<string[]> {
  const results = page.locator('[data-testid="search-result"]')
  return results.allTextContents()
}

/** Click a search result to jump to it. */
export async function clickSearchResult(page: Page, text: string): Promise<void> {
  await page.click(`[data-testid="search-result"]:has-text("${text}")`)
  // Wait for navigation
  await page.waitForTimeout(1_000)
}

/** Close the search bar. */
export async function closeSearch(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
}
