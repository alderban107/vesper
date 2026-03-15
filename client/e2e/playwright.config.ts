/**
 * Playwright configuration for Vesper E2E tests.
 * Covers: R-HARNESS-1 (fresh stack via globalSetup)
 *         R-HARNESS-3 (artifact preservation)
 *         R-HARNESS-5 (persistent browser profiles)
 *         R-HARNESS-7 (fake media devices)
 */

import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  timeout: 15_000, // fail fast — no test should take longer than 15s
  expect: { timeout: 5_000 },
  fullyParallel: false, // tests share state within a spec file
  retries: 0, // no retries — we want to see real failures
  workers: 1, // sequential — tests within a scenario share server state
  maxFailures: 1, // stop on first failure so we can iterate fast
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: './artifacts/html-report' }],
  ],
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  outputDir: './artifacts/test-results',

  use: {
    // Chromium with fake media devices (R-HARNESS-7)
    browserName: 'chromium',
    launchOptions: {
      args: [
        '--test-type',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--disable-web-security',
        '--allow-insecure-localhost',
      ],
    },

    // Artifact collection on failure (R-HARNESS-3)
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',

    // Permissions
    permissions: ['clipboard-read', 'clipboard-write'],
    ignoreHTTPSErrors: true,
  },

  projects: [
    {
      name: 'p0-smoke',
      testMatch: /p0-.*\.spec\.ts/,
    },
    {
      name: 'p1-extended',
      testMatch: /p1-.*\.spec\.ts/,
      dependencies: ['p0-smoke'],
    },
    {
      name: 'p2-reliability',
      testMatch: /p2-.*\.spec\.ts/,
      dependencies: ['p0-smoke'],
    },
  ],
})
