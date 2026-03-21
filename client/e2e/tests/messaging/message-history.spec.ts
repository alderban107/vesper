import { test, expect } from '../../fixtures/test-fixtures'

async function setupWithChannel(page: import('@playwright/test').Page): Promise<void> {
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
      body: JSON.stringify({
        servers: [
          {
            id: 'server-1',
            name: 'Test Server',
            invite_code: 'abc123',
            channels: [
              { id: 'ch-1', name: 'general', type: 'text', topic: null, disappearing_ttl: null }
            ]
          }
        ]
      })
    })
  })
}

test.describe('Message History', () => {
  test('shows placeholder when no channel is selected', async ({ page }) => {
    await setupWithChannel(page)
    await page.goto('/')
    await page.waitForSelector('[data-testid="main-page"]')

    await expect(page.getByText('Select a channel or conversation')).toBeVisible()
  })

  test('shows channel name in header when selected', async ({ page }) => {
    await setupWithChannel(page)
    await page.goto('/')
    await page.waitForSelector('[data-testid="main-page"]')

    await page.getByTitle('Test Server').click()
    await page.getByText('general').click()

    // Header should show channel name
    await expect(page.locator('header, [class*="Header"]').getByText('general')).toBeVisible()
  })
})
