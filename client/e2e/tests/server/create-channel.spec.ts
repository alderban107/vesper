import { test, expect } from '../../fixtures/test-fixtures'

async function setupWithServer(page: import('@playwright/test').Page): Promise<void> {
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

test.describe('Create Channel', () => {
  test('opens create channel modal from sidebar', async ({ page }) => {
    await setupWithServer(page)
    await page.goto('/')
    await page.waitForSelector('[data-testid="main-page"]')

    // Click the server
    await page.getByTitle('Test Server').click()
    await expect(page.getByText('Test Server')).toBeVisible()

    // Click create channel button (the + next to "Text Channels")
    await page.getByTitle('Create Channel').click()
    await expect(page.getByText('Create Channel')).toBeVisible()
  })

  test('can toggle between text and voice channel types', async ({ page }) => {
    await setupWithServer(page)
    await page.goto('/')
    await page.waitForSelector('[data-testid="main-page"]')

    await page.getByTitle('Test Server').click()
    await page.getByTitle('Create Channel').click()

    // Default should be text
    const voiceButton = page.getByRole('button', { name: 'Voice' })
    await voiceButton.click()

    // Click text again
    const textButton = page.getByRole('button', { name: 'Text' })
    await textButton.click()
  })

  test('creates a text channel', async ({ page }) => {
    await setupWithServer(page)

    await page.route('**/api/v1/servers/server-1/channels', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            channel: { id: 'ch-2', name: 'new-channel', type: 'text', topic: null, disappearing_ttl: null }
          })
        })
      }
    })

    await page.goto('/')
    await page.waitForSelector('[data-testid="main-page"]')

    await page.getByTitle('Test Server').click()
    await page.getByTitle('Create Channel').click()
    await page.getByLabel('Channel Name').fill('new-channel')
    await page.getByRole('button', { name: 'Create' }).click()

    await expect(page.getByText('Create Channel')).not.toBeVisible({ timeout: 5_000 })
  })
})
