import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// Next loads .env.local for the dev server; load it here too so global setup seeds the same database.
if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const PORT = 3100;

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    // Optional: point at an already-installed Chromium instead of `playwright install chromium`.
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // The demo login only exists outside production, so the smoke test runs against `next dev`.
    command: `pnpm exec next dev --port ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: true,
    env: { AUTH_DEMO_LOGIN: '1' },
    timeout: 120_000,
  },
});
