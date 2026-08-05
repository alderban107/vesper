import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests-electron',
  timeout: 45_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure'
  }
})
