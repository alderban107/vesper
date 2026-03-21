import { test, expect } from '../../fixtures/test-fixtures'

test.describe('Logout', () => {
  test('logging out returns to login page', async ({ page }) => {
    // Pre-authenticate
    await page.addInitScript(() => {
      localStorage.setItem('accessToken', 'test-token')
      localStorage.setItem('refreshToken', 'test-refresh')
    })

    await page.route('**/api/v1/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ user: { id: 'user-1', username: 'testuser' } })
      })
    })

    await page.route('**/api/v1/servers', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ servers: [] })
      })
    })

    await page.goto('/')
    await page.waitForSelector('[data-testid="main-page"]', { timeout: 10_000 })

    // Click logout
    await page.getByTitle('Logout').click()

    // Should be back on login page
    await expect(page.locator('[data-testid="login-form"]')).toBeVisible({ timeout: 10_000 })
  })

  test('clears tokens on logout', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('accessToken', 'test-token')
      localStorage.setItem('refreshToken', 'test-refresh')
    })

    await page.route('**/api/v1/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ user: { id: 'user-1', username: 'testuser' } })
      })
    })

    await page.route('**/api/v1/servers', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ servers: [] })
      })
    })

    await page.goto('/')
    await page.waitForSelector('[data-testid="main-page"]', { timeout: 10_000 })

    await page.getByTitle('Logout').click()
    await page.waitForSelector('[data-testid="login-form"]')

    // Verify tokens are cleared
    const accessToken = await page.evaluate(() => localStorage.getItem('accessToken'))
    expect(accessToken).toBeNull()
  })
})
