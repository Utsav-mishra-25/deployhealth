import { expect, test } from '@playwright/test';
import { createProject, createToken, expectAccessible } from './helpers';
import { signInAsDev } from './session';

const STOREFRONT = '0d3e0000-0000-4000-8000-000000000001';

test('public pages have no serious or critical accessibility violations', async ({ page }) => {
  for (const path of [
    '/',
    '/login',
    '/demo',
    '/demo/clients/acme-corp',
    `/demo/projects/${STOREFRONT}`,
    `/demo/projects/${STOREFRONT}/handoff`,
    '/demo/clients/acme-corp/report',
    '/security',
    '/privacy',
    '/terms',
    '/docs',
    '/docs/nextjs',
    '/docs/laravel',
    '/docs/spring-boot',
    '/pricing',
    '/account/deleted',
  ]) {
    await expectAccessible(page, path);
  }
  await expectAccessible(page, '/no-such-page', 404);
});

test('the signed-in lists, a project with a deploy, its settings and a shared report have none either', async ({ page, browser }) => {
  await signInAsDev(page);

  const suffix = Date.now();
  await page.goto('/clients/new');
  const clientName = `A11y Client ${suffix}`;
  await page.getByLabel('Client name').fill(clientName);
  await page.getByRole('button', { name: 'Create client' }).click();
  await expect(page.getByRole('heading', { name: clientName })).toBeVisible();
  const clientPath = new URL(page.url()).pathname;
  await page.getByRole('link', { name: 'Add project' }).click();
  await expect(page).toHaveURL(/\/projects\/new\?client=/);
  const projectPath = await createProject(page, { name: `a11y-${suffix}`, repo: 'acme/a11y' });
  // A scan, so the project page has a deploy row with a commit link to GitHub.
  const token = await createToken(page, projectPath);
  const scan = await page.request.post('/api/ingest/scan', {
    headers: { authorization: `Bearer ${token}` },
    data: { sha: '0123456789abcdef0123456789abcdef01234567', branch: 'main', timestamp: new Date().toISOString(), findings: [] },
  });
  expect(scan.status()).toBe(201);
  await page.goto(projectPath);
  await expect(page.getByRole('heading', { name: `a11y-${suffix}` })).toBeVisible();
  await expectAccessible(page, projectPath);
  await expectAccessible(page, `${projectPath}/settings`);
  await expectAccessible(page, '/clients');
  await expectAccessible(page, clientPath);
  await expectAccessible(page, '/account');

  await page.goto(`${clientPath}/report`);
  await page.getByRole('button', { name: 'Share report' }).click();
  const shareUrl = await page.getByLabel('Share link').inputValue();
  const stranger = await browser.newContext();
  await expectAccessible(await stranger.newPage(), new URL(shareUrl).pathname);
  await stranger.close();
});
