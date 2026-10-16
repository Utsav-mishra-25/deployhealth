import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';
import { E2E_WEBHOOK_SECRET } from './e2e/webhook-secret';

// `next start` loads .env.local too; load it here so global setup seeds the same database and signs
// the session with the same AUTH_SECRET.
if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const PORT = 3100;

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  workers: 1,
  timeout: 120_000,
  // A production build serves every route ready-made (no compile on first visit, as under
  // `next dev`), so assertions get 15 s: wide margin, but a hang still fails fast.
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    // Optional: point at an already-installed Chromium instead of `playwright install chromium`.
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // The production build from `pnpm e2e` (which runs `next build` first), as Railway serves it.
    // NODE_ENV is production, so the dev login is never registered (AUTH_DEMO_LOGIN=1 is set to
    // prove it); global-setup.ts signs the dev user in with a session cookie instead. Never reuse
    // a server already on the port: it could be `next dev`, or an older build.
    command: `pnpm exec next start --port ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    env: {
      AUTH_DEMO_LOGIN: '1',
      DEMO_PUBLIC: '1',
      SECURITY_CONTACT_EMAIL: 'security@deployhealth.example',
      GITHUB_APP_SLUG: 'deployhealth',
      // A fixed test constant (e2e/webhook-secret.ts): onboarding.spec.ts sends signed installation events.
      GITHUB_APP_WEBHOOK_SECRET: E2E_WEBHOOK_SECRET,
      // Required in production; nothing in the tests contacts GitHub.
      AUTH_GITHUB_ID: 'e2e-placeholder',
      AUTH_GITHUB_SECRET: 'e2e-placeholder',
      PUBLIC_ORIGIN: `http://localhost:${PORT}`,
    },
    timeout: 120_000,
  },
});
