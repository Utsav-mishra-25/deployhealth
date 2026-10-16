/**
 * The e2e server's GitHub App webhook secret (playwright.config.ts passes it as
 * GITHUB_APP_WEBHOOK_SECRET): a fixed test constant, never a real App's secret, so the specs can
 * send signed installation events the way GitHub would.
 */
export const E2E_WEBHOOK_SECRET = 'e2e-webhook-secret-not-a-real-app';
