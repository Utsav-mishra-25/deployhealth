import { expect, test } from '@playwright/test';

test('login → create project → view project', async ({ page }) => {
  // Login with the demo account (seeded by global setup).
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole('button', { name: 'Continue with the demo account' }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByTestId('current-user')).toHaveText('demo');

  // The seeded project shows its latest scan, findings with file:line, and ten deploys.
  await page.getByRole('link', { name: /acme-storefront/ }).click();
  await expect(page.getByRole('heading', { name: 'acme-storefront' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Latest scan' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'apps/web/src/lib/analytics.ts:4' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Deploys' }).getByRole('row')).toHaveCount(11);

  // Create a project: the token and the Action snippet are shown once.
  await page.goto('/projects/new');
  const name = `smoke-${Date.now()}`;
  await page.getByLabel('Project name').fill(name);
  await page.getByLabel('GitHub repository').fill('acme/smoke');
  await page.getByRole('button', { name: 'Create project' }).click();
  const token = (await page.getByTestId('new-token').textContent())?.trim() ?? '';
  expect(token).toMatch(/^dh_[A-Za-z0-9_-]{43}$/);
  await expect(page.locator('pre')).toContainText('deployhealth-scan.mjs');
  await expect(page.locator('pre')).toContainText('secrets.DEPLOYHEALTH_TOKEN');

  // Report a scan with the new token, as the GitHub Action would.
  const response = await page.request.post('/api/ingest/scan', {
    headers: { authorization: `Bearer ${token}` },
    data: {
      sha: '0123456789abcdef0123456789abcdef01234567',
      branch: 'main',
      timestamp: new Date().toISOString(),
      findings: [
        { kind: 'missing', var_name: 'LOG_LEVEL', file: 'src/server.ts', line: 4, env_file: null },
        { kind: 'unused', var_name: 'OLD_FLAG', file: '.env.example', line: 5, env_file: '.env.example' },
      ],
    },
  });
  expect(response.status()).toBe(201);

  // View the new project.
  await page.getByRole('link', { name: 'Go to project' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'src/server.ts:4' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'OLD_FLAG' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Deploys' }).getByRole('row')).toHaveCount(2);
});
