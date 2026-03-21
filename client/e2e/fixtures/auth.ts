import type { Page } from '@playwright/test'

/**
 * Register a new user through the UI.
 * Assumes the app is on the login page.
 */
export async function registerUser(
  page: Page,
  username: string,
  password: string
): Promise<void> {
  // Navigate to register page
  await page.getByRole('button', { name: 'Register' }).click()
  await page.waitForSelector('[data-testid="register-form"]')

  // Fill in the form
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByLabel('Confirm Password').fill(password)

  // Submit
  await page.getByRole('button', { name: 'Register', exact: true }).click()
}

/**
 * Log in through the UI.
 * Assumes the app is on the login page.
 */
export async function loginUser(
  page: Page,
  username: string,
  password: string
): Promise<void> {
  await page.waitForSelector('[data-testid="login-form"]')
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Log In' }).click()
}

/**
 * Log out through the sidebar.
 * Assumes user is on the main page.
 */
export async function logoutUser(page: Page): Promise<void> {
  await page.getByTitle('Logout').click()
}

/**
 * Wait for the main page to be visible after login.
 */
export async function waitForMainPage(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="main-page"]', { timeout: 10_000 })
}

/**
 * Wait for the login page to be visible.
 */
export async function waitForLoginPage(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="login-form"]', { timeout: 10_000 })
}
