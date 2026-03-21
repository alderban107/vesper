import { test, expect } from '../../fixtures/test-fixtures'

test.describe('Login', () => {
  test('shows login form on initial load', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('[data-testid="login-form"]')).toBeVisible()
    await expect(page.getByText('Vesper')).toBeVisible()
    await expect(page.getByLabel('Username')).toBeVisible()
    await expect(page.getByLabel('Password')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Log In' })).toBeVisible()
  })

  test('submit button is disabled when fields are empty', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Log In' })).toBeDisabled()
  })

  test('submit button enables when both fields are filled', async ({ page }) => {
    await page.goto('/')
    await page.getByLabel('Username').fill('testuser')
    await page.getByLabel('Password').fill('password123')
    await expect(page.getByRole('button', { name: 'Log In' })).toBeEnabled()
  })

  test('shows error on failed login', async ({ page }) => {
    // Mock the login endpoint to return an error
    await page.route('**/api/v1/auth/login', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Invalid credentials' })
      })
    })

    await page.goto('/')
    await page.getByLabel('Username').fill('wronguser')
    await page.getByLabel('Password').fill('wrongpass')
    await page.getByRole('button', { name: 'Log In' }).click()

    await expect(page.getByText('Invalid credentials')).toBeVisible()
  })

  test('navigates to main page on successful login', async ({ page }) => {
    // Mock successful login
    await page.route('**/api/v1/auth/login', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: 'test-access-token',
          refresh_token: 'test-refresh-token',
          user: { id: 'user-1', username: 'testuser' },
          encrypted_key_bundle: null
        })
      })
    })

    // Mock auth check
    await page.route('**/api/v1/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ user: { id: 'user-1', username: 'testuser' } })
      })
    })

    // Mock servers list
    await page.route('**/api/v1/servers', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ servers: [] })
      })
    })

    await page.goto('/')
    await page.getByLabel('Username').fill('testuser')
    await page.getByLabel('Password').fill('password123')
    await page.getByRole('button', { name: 'Log In' }).click()

    await expect(page.locator('[data-testid="main-page"]')).toBeVisible({ timeout: 10_000 })
  })

  test('can navigate to register page', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Register' }).click()
    await expect(page.locator('[data-testid="register-form"]')).toBeVisible()
  })

  test('can navigate to recovery page', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Forgot password?' }).click()
    await expect(page.getByText('Account Recovery')).toBeVisible()
  })

  test('persists session via localStorage token', async ({ page }) => {
    // Set up tokens as if user was already logged in
    await page.addInitScript(() => {
      localStorage.setItem('accessToken', 'test-token')
      localStorage.setItem('refreshToken', 'test-refresh')
    })

    // Mock auth check to succeed
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
    await expect(page.locator('[data-testid="main-page"]')).toBeVisible({ timeout: 10_000 })
  })
})
