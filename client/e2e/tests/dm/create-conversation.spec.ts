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

  await page.route('**/api/v1/dm/conversations', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ conversations: [] })
      })
    }
  })
}

test.describe('Create DM Conversation', () => {
  test('opens new DM modal from DM sidebar', async ({ page }) => {
    await setupAuth(page)
    await page.goto('/')
    await page.waitForSelector('[data-testid="main-page"]')

    // Switch to DM view
    await page.getByTitle('Direct Messages').click()

    // Click new message button
    await page.getByTitle('New Message').click()
    await expect(page.getByText('New Message')).toBeVisible()
    await expect(page.getByPlaceholder('Enter exact username')).toBeVisible()
  })

  test('shows error when user is not found', async ({ page }) => {
    await setupAuth(page)

    await page.route('**/api/v1/users/search*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ users: [] })
      })
    })

    await page.goto('/')
    await page.waitForSelector('[data-testid="main-page"]')

    await page.getByTitle('Direct Messages').click()
    await page.getByTitle('New Message').click()
    await page.getByPlaceholder('Enter exact username').fill('nonexistent')
    await page.getByRole('button', { name: 'Start Chat' }).click()

    await expect(page.getByText('User not found')).toBeVisible()
  })

  test('cancel closes the modal', async ({ page }) => {
    await setupAuth(page)
    await page.goto('/')
    await page.waitForSelector('[data-testid="main-page"]')

    await page.getByTitle('Direct Messages').click()
    await page.getByTitle('New Message').click()
    await expect(page.getByText('New Message')).toBeVisible()

    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByText('New Message')).not.toBeVisible()
  })
})
