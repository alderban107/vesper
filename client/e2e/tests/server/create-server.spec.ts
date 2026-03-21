import { test, expect } from '../../fixtures/test-fixtures'

// Helper: set up an authenticated session
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
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ servers: [] })
      })
    }
  })
}

test.describe('Create Server', () => {
  test('opens create server modal from sidebar', async ({ page }) => {
    await setupAuth(page)
    await page.goto('/')
    await page.waitForSelector('[data-testid="main-page"]')

    await page.getByTitle('Create Server').click()
    await expect(page.getByText('Create a Server')).toBeVisible()
    await expect(page.getByLabel('Server Name')).toBeVisible()
  })

  test('cancel closes the modal', async ({ page }) => {
    await setupAuth(page)
    await page.goto('/')
    await page.waitForSelector('[data-testid="main-page"]')

    await page.getByTitle('Create Server').click()
    await expect(page.getByText('Create a Server')).toBeVisible()

    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByText('Create a Server')).not.toBeVisible()
  })

  test('create button is disabled when name is empty', async ({ page }) => {
    await setupAuth(page)
    await page.goto('/')
    await page.waitForSelector('[data-testid="main-page"]')

    await page.getByTitle('Create Server').click()
    await expect(page.getByRole('button', { name: 'Create' })).toBeDisabled()
  })

  test('creates a server successfully', async ({ page }) => {
    await setupAuth(page)

    await page.route('**/api/v1/servers', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            server: {
              id: 'server-1',
              name: 'Test Server',
              invite_code: 'abc123',
              channels: [{ id: 'ch-1', name: 'general', type: 'text', topic: null, disappearing_ttl: null }]
            }
          })
        })
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ servers: [] })
        })
      }
    })

    await page.goto('/')
    await page.waitForSelector('[data-testid="main-page"]')

    await page.getByTitle('Create Server').click()
    await page.getByLabel('Server Name').fill('Test Server')
    await page.getByRole('button', { name: 'Create' }).click()

    // Modal should close
    await expect(page.getByText('Create a Server')).not.toBeVisible({ timeout: 5_000 })
  })
})
