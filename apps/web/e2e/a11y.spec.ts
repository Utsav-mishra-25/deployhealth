import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

const STOREFRONT = '0d3e0000-0000-4000-8000-000000000001';

/** WCAG 2.x A and AA rules; a serious or critical violation fails the page. */
async function expectAccessible(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response?.status(), path).toBe(200);
  await page.waitForLoadState('networkidle');
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const blocking = violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact}): ${v.help}\n${v.nodes.map((n) => `    ${n.target.join(' ')}`).join('\n')}`);
  expect.soft(blocking, `${path}\n${blocking.join('\n')}`).toEqual([]);
}

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
  ]) {
    await expectAccessible(page, path);
  }
});

test('the signed-in lists, a project with a deploy, its settings and a shared report have none either', async ({ page, browser }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue as dev user' }).click();
  await expect(page).toHaveURL(/\/clients$/);

  const suffix = Date.now();
  await page.goto('/clients/new');
  const clientName = `A11y Client ${suffix}`;
  await page.getByLabel('Client name').fill(clientName);
  await page.getByRole('button', { name: 'Create client' }).click();
  await expect(page.getByRole('heading', { name: clientName })).toBeVisible();
  const clientPath = new URL(page.url()).pathname;
  await page.getByRole('link', { name: 'Add project' }).click();
  await page.getByLabel('Project name').fill(`a11y-${suffix}`);
  await page.getByLabel('GitHub repository').fill('acme/a11y');
  await page.getByRole('button', { name: 'Create project' }).click();
  // A scan, so the project page has a deploy row with a commit link to GitHub.
  const token = (await page.getByTestId('new-token').textContent())?.trim() ?? '';
  const scan = await page.request.post('/api/ingest/scan', {
    headers: { authorization: `Bearer ${token}` },
    data: { sha: '0123456789abcdef0123456789abcdef01234567', branch: 'main', timestamp: new Date().toISOString(), findings: [] },
  });
  expect(scan.status()).toBe(201);
  await page.getByRole('link', { name: 'Go to project' }).click();
  await expect(page.getByRole('heading', { name: `a11y-${suffix}` })).toBeVisible();
  const projectPath = new URL(page.url()).pathname;
  await expectAccessible(page, projectPath);
  await expectAccessible(page, `${projectPath}/settings`);
  await expectAccessible(page, '/clients');
  await expectAccessible(page, clientPath);

  await page.goto(`${clientPath}/report`);
  await page.getByRole('button', { name: 'Share report' }).click();
  const shareUrl = await page.getByLabel('Share link').inputValue();
  const stranger = await browser.newContext();
  await expectAccessible(await stranger.newPage(), new URL(shareUrl).pathname);
  await stranger.close();
});
