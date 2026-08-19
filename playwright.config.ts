import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'packages/plugin/tests',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3191',
    headless: true,
  },
})
