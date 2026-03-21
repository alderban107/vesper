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
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ servers: [] })
      })
    }
  })
}

test.describe('Join Server', () => {
  test('opens join server modal', async ({ page }) => {
    await setupAuth(page)
    await page.goto('/')
    await page.waitForSelector('[data-testid="main-page"]')

    await page.getByTitle('Join Server').click()
    await expect(page.getByText('Join a Server')).toBeVisible()
    await expect(page.getByLabel('Invite Code')).toBeVisible()
  })

  test('shows error for invalid invite code', async ({ page }) => {
    await setupAuth(page)

    await page.route('**/api/v1/servers/join', async (route) => {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Invalid invite code' })
      })
    })

    await page.goto('/')
    await page.waitForSelector('[data-testid="main-page"]')

    await page.getByTitle('Join Server').click()
    await page.getByLabel('Invite Code').fill('badcode')
    await page.getByRole('button', { name: 'Join' }).click()

    await expect(page.getByText('Invalid invite code')).toBeVisible()
  })

  test('joins server successfully', async ({ page }) => {
    await setupAuth(page)

    await page.route('**/api/v1/servers/join', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          server: {
            id: 'server-2',
            name: 'Joined Server',
            invite_code: 'validcode',
            channels: [{ id: 'ch-1', name: 'general', type: 'text', topic: null, disappearing_ttl: null }]
          }
        })
      })
    })

    await page.goto('/')
    await page.waitForSelector('[data-testid="main-page"]')

    await page.getByTitle('Join Server').click()
    await page.getByLabel('Invite Code').fill('validcode')
    await page.getByRole('button', { name: 'Join' }).click()

    // Modal should close
    await expect(page.getByText('Join a Server')).not.toBeVisible({ timeout: 5_000 })
  })
})
