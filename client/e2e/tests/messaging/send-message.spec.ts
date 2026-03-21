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

test.describe('Send Message', () => {
  test('shows message input when channel is selected', async ({ page }) => {
    await setupWithChannel(page)
    await page.goto('/')
    await page.waitForSelector('[data-testid="main-page"]')

    // Select the server and channel
    await page.getByTitle('Test Server').click()
    await page.getByText('general').click()

    await expect(page.locator('[data-testid="message-input"]')).toBeVisible()
    await expect(page.locator('[data-testid="send-button"]')).toBeVisible()
  })

  test('send button is disabled when input is empty', async ({ page }) => {
    await setupWithChannel(page)
    await page.goto('/')
    await page.waitForSelector('[data-testid="main-page"]')

    await page.getByTitle('Test Server').click()
    await page.getByText('general').click()

    await expect(page.locator('[data-testid="send-button"]')).toBeDisabled()
  })

  test('send button enables when text is entered', async ({ page }) => {
    await setupWithChannel(page)
    await page.goto('/')
    await page.waitForSelector('[data-testid="main-page"]')

    await page.getByTitle('Test Server').click()
    await page.getByText('general').click()

    await page.locator('[data-testid="message-input"]').fill('Hello world')
    await expect(page.locator('[data-testid="send-button"]')).toBeEnabled()
  })

  test('clears input after sending', async ({ page }) => {
    await setupWithChannel(page)
    await page.goto('/')
    await page.waitForSelector('[data-testid="main-page"]')

    await page.getByTitle('Test Server').click()
    await page.getByText('general').click()

    const input = page.locator('[data-testid="message-input"]')
    await input.fill('Hello world')
    await page.locator('[data-testid="send-button"]').click()

    // Input should be cleared
    await expect(input).toHaveValue('')
  })

  test('shows empty state when no messages', async ({ page }) => {
    await setupWithChannel(page)
    await page.goto('/')
    await page.waitForSelector('[data-testid="main-page"]')

    await page.getByTitle('Test Server').click()
    await page.getByText('general').click()

    await expect(page.getByText('No messages yet')).toBeVisible()
  })
})
