import { defineConfig, devices } from '@playwright/test'

/**
 * 本地：自动构建并起 vite preview（4173）。
 * Docker verify：通过 E2E_BASE_URL=http://web:80 指向 compose 中的 web 服务，
 * 不再启动本地 webServer。
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:4173'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'npm run build && npm run preview',
        url: 'http://localhost:4173',
        reuseExistingServer: true,
        timeout: 120_000,
      },
})
