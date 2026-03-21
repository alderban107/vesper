import { test, expect } from '../../fixtures/test-fixtures'

async function setupWithServers(page: import('@playwright/test').Page): Promise<void> {
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
            name: 'Alpha Server',
            invite_code: 'alpha1',
            channels: [
              { id: 'ch-1', name: 'general', type: 'text', topic: null, disappearing_ttl: null },
              { id: 'ch-2', name: 'random', type: 'text', topic: null, disappearing_ttl: null }
            ]
          },
          {
            id: 'server-2',
            name: 'Beta Server',
            invite_code: 'beta2',
            channels: [
              { id: 'ch-3', name: 'chat', type: 'text', topic: null, disappearing_ttl: null }
            ]
          }
        ]
      })
    })
  })

  await page.route('**/api/v1/dm/conversations', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ conversations: [] })
    })
  })
}

test.describe('Sidebar Navigation', () => {
  test('shows sidebar with server icons', async ({ page }) => {
    await setupWithServers(page)
    await page.goto('/')
    await page.waitForSelector('[data-testid="sidebar"]')

    await expect(page.getByTitle('Direct Messages')).toBeVisible()
    await expect(page.getByTitle('Alpha Server')).toBeVisible()
    await expect(page.getByTitle('Beta Server')).toBeVisible()
    await expect(page.getByTitle('Create Server')).toBeVisible()
    await expect(page.getByTitle('Join Server')).toBeVisible()
  })

  test('clicking a server shows its channels', async ({ page }) => {
    await setupWithServers(page)
    await page.goto('/')
    await page.waitForSelector('[data-testid="sidebar"]')

    await page.getByTitle('Alpha Server').click()
    await expect(page.getByText('Alpha Server')).toBeVisible()
    await expect(page.getByText('general')).toBeVisible()
    await expect(page.getByText('random')).toBeVisible()
  })

  test('switching between servers updates channel list', async ({ page }) => {
    await setupWithServers(page)
    await page.goto('/')
    await page.waitForSelector('[data-testid="sidebar"]')

    // Select Alpha
    await page.getByTitle('Alpha Server').click()
    await expect(page.getByText('general')).toBeVisible()

    // Switch to Beta
    await page.getByTitle('Beta Server').click()
    await expect(page.getByText('chat')).toBeVisible()
  })

  test('clicking DM button switches to DM view', async ({ page }) => {
    await setupWithServers(page)
    await page.goto('/')
    await page.waitForSelector('[data-testid="sidebar"]')

    await page.getByTitle('Alpha Server').click()
    await expect(page.getByText('Alpha Server')).toBeVisible()

    // Switch to DMs
    await page.getByTitle('Direct Messages').click()
    await expect(page.getByText('Direct Messages')).toBeVisible()
  })

  test('shows user bar at bottom', async ({ page }) => {
    await setupWithServers(page)
    await page.goto('/')
    await page.waitForSelector('[data-testid="sidebar"]')

    // Should show username
    await expect(page.getByText('testuser')).toBeVisible()
    await expect(page.getByTitle('Settings')).toBeVisible()
    await expect(page.getByTitle('Logout')).toBeVisible()
  })
})
