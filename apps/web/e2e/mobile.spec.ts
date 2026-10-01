import { expect, type Page, test } from '@playwright/test';

const STOREFRONT = '0d3e0000-0000-4000-8000-000000000001';

test.use({ viewport: { width: 375, height: 812 } });

/** The page never scrolls sideways: wide tables scroll inside their own box instead. */
async function expectNoSidewaysScroll(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response?.status(), path).toBe(200);
  await page.waitForLoadState('networkidle');
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `${path} is ${scrollWidth}px wide at ${clientWidth}px`).toBeLessThanOrEqual(clientWidth);
}

test('public pages fit a 375 px phone, signed out', async ({ page }) => {
  for (const path of [
    '/',
    '/login',
    '/demo',
    `/demo/projects/${STOREFRONT}`,
    `/demo/projects/${STOREFRONT}/handoff`,
    '/demo/clients/acme-corp',
    '/demo/clients/acme-corp/report',
    '/security',
    '/privacy',
    '/terms',
    '/github/installed',
  ]) {
    await expectNoSidewaysScroll(page, path);
  }

  // The demo overview shows each project's uptime status next to its name, on screen.
  await page.goto('/demo');
  const badge = page.getByTestId('project-row').filter({ hasText: 'acme-storefront' }).getByTestId('uptime-badge');
  await expect(badge).toHaveText('Down');
  await expect(badge).toBeInViewport({ ratio: 1 });
  await expect(page.getByTestId('project-row').filter({ hasText: 'acme-storefront' }).getByTestId('failing-for')).toBeInViewport({ ratio: 1 });
});

test('signed-in pages and a shared report fit a 375 px phone', async ({ page, browser }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue as dev user' }).click();
  await expect(page).toHaveURL(/\/clients$/);

  // A client with a long name, and a project with a scan, a long endpoint URL and a report to share.
  const suffix = Date.now();
  await page.goto('/clients/new');
  const clientName = `Mobile Client With A Rather Long Name ${suffix}`;
  await page.getByLabel('Client name').fill(clientName);
  await page.getByRole('button', { name: 'Create client' }).click();
  await expect(page.getByRole('heading', { name: clientName })).toBeVisible();
  const clientUrl = page.url();
  await page.getByRole('link', { name: 'Add project' }).click();
  await page.getByLabel('Project name').fill(`mobile-${suffix}`);
  await page.getByLabel('GitHub repository').fill('acme/a-repository-with-quite-a-long-name');
  await page.getByRole('button', { name: 'Create project' }).click();
  const token = (await page.getByTestId('new-token').textContent())?.trim() ?? '';
  const scan = await page.request.post('/api/ingest/scan', {
    headers: { authorization: `Bearer ${token}` },
    data: {
      sha: 'fedcba9876543210fedcba9876543210fedcba98',
      branch: 'feature/a-branch-name-that-goes-on-for-a-while',
      timestamp: new Date().toISOString(),
      findings: [{ kind: 'missing', var_name: 'A_RATHER_LONG_ENVIRONMENT_VARIABLE_NAME', file: 'services/billing/src/providers/stripe/webhooks.ts', line: 128, env_file: null }],
      variables: [{ var_name: 'A_RATHER_LONG_ENVIRONMENT_VARIABLE_NAME', scope: 'services/billing', defined_in: [] }],
    },
  });
  expect(scan.status()).toBe(201);
  await page.getByRole('link', { name: 'Go to project' }).click();
  await expect(page.getByRole('heading', { name: `mobile-${suffix}` })).toBeVisible();
  const projectUrl = new URL(page.url()).pathname;
  const addForm = page.locator('form').filter({ has: page.getByRole('button', { name: 'Add endpoint' }) });
  await addForm.getByLabel('Name').fill('Billing API');
  await addForm.getByLabel('URL').fill('https://example.com/a/very/long/health/check/path/that/keeps/going?with=a&query=string');
  await addForm.getByRole('button', { name: 'Add endpoint' }).click();
  await expect(page.getByTestId('endpoint-card')).toHaveCount(1);

  const clientPath = new URL(clientUrl).pathname;
  for (const path of ['/clients', clientPath, `${clientPath}/report`, projectUrl, `${projectUrl}/settings`, `${projectUrl}/handoff`]) {
    await expectNoSidewaysScroll(page, path);
  }

  await page.goto(`${clientPath}/report`);
  await page.getByRole('button', { name: 'Share report' }).click();
  const shareUrl = await page.getByLabel('Share link').inputValue();
  const stranger = await browser.newContext({ viewport: { width: 375, height: 812 } });
  await expectNoSidewaysScroll(await stranger.newPage(), new URL(shareUrl).pathname);
  await stranger.close();
});
