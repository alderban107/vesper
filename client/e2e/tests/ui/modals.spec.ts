import { test, expect } from '../../fixtures/test-fixtures'

async function setupAuth(page: import('@playwright/test').Page): Promise<void> {
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
}

test.describe('Modals', () => {
  test('settings modal opens and closes', async ({ page }) => {
    await setupAuth(page)
    await page.goto('/')
    await page.waitForSelector('[data-testid="main-page"]')

    await page.getByTitle('Settings').click()
    await expect(page.getByText('Settings').first()).toBeVisible()
    await expect(page.getByText('Profile')).toBeVisible()
    await expect(page.getByText('Appearance')).toBeVisible()

    await page.getByRole('button', { name: 'Close' }).click()
    // Settings modal should be gone — check for the heading specifically
    await expect(page.locator('.glass-card').filter({ hasText: 'Profile' })).not.toBeVisible()
  })

  test('settings modal has theme toggle', async ({ page }) => {
    await setupAuth(page)
    await page.goto('/')
    await page.waitForSelector('[data-testid="main-page"]')

    await page.getByTitle('Settings').click()
    await expect(page.getByRole('button', { name: 'Dark' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Light' })).toBeVisible()
  })

  test('settings modal has notifications toggle', async ({ page }) => {
    await setupAuth(page)
    await page.goto('/')
    await page.waitForSelector('[data-testid="main-page"]')

    await page.getByTitle('Settings').click()
    await expect(page.getByText('Desktop notifications')).toBeVisible()
  })

  test('settings modal has voice section', async ({ page }) => {
    await setupAuth(page)
    await page.goto('/')
    await page.waitForSelector('[data-testid="main-page"]')

    await page.getByTitle('Settings').click()
    await expect(page.getByText('Voice')).toBeVisible()
    await expect(page.getByText('Input Device')).toBeVisible()
    await expect(page.getByText('Output Device')).toBeVisible()
  })

  test('create server modal has icon header', async ({ page }) => {
    await setupAuth(page)
    await page.goto('/')
    await page.waitForSelector('[data-testid="main-page"]')

    await page.getByTitle('Create Server').click()
    // Verify the modal shows with its glass-card styling
    await expect(page.getByText('Create a Server')).toBeVisible()
    await expect(page.getByLabel('Server Name')).toBeVisible()
  })

  test('join server modal has icon header', async ({ page }) => {
    await setupAuth(page)
    await page.goto('/')
    await page.waitForSelector('[data-testid="main-page"]')

    await page.getByTitle('Join Server').click()
    await expect(page.getByText('Join a Server')).toBeVisible()
    await expect(page.getByLabel('Invite Code')).toBeVisible()
  })
})
