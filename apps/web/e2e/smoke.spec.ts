import { expect, test } from '@playwright/test';

test('login → clients → create client and project → add endpoint → view project', async ({ page }) => {
  // Login with the demo account (seeded by global setup); the home page is /clients.
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole('button', { name: 'Continue with the demo account' }).click();
  await expect(page).toHaveURL(/\/clients$/);
  await expect(page.getByTestId('current-user')).toHaveText('demo');

  // Seeded overview: clients with their projects, the unassigned one under "No client".
  await expect(page.getByRole('link', { name: 'Acme Corp' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Northwind Bakery' })).toBeVisible();
  await expect(page.getByRole('rowheader', { name: 'No client' })).toBeVisible();
  const storefrontRow = page.getByTestId('project-row').filter({ hasText: 'acme-storefront' });
  await expect(storefrontRow.getByTestId('uptime-badge')).toHaveText('Down');

  // The seeded project: breadcrumb, the linked alert, endpoints and config findings.
  await storefrontRow.getByRole('link', { name: 'acme-storefront' }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(crumbs).toContainText('Clients');
  await expect(crumbs).toContainText('Acme Corp');
  await expect(page.getByRole('alert').filter({ hasText: 'api.acme.example started failing' })).toContainText(
    'api.acme.example started failing 4m after deploy b52952e, which introduced 2 missing env vars: REDIS_URL, STRIPE_KEY',
  );
  await expect(page.getByTestId('endpoint-card').filter({ hasText: 'api.acme.example' }).getByTestId('endpoint-status')).toHaveText('Down');
  await expect(page.getByRole('cell', { name: 'apps/web/src/lib/analytics.ts:4' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Deploys' }).getByRole('row')).toHaveCount(11);

  // Create a client.
  const suffix = Date.now();
  const clientName = `Smoke Client ${suffix}`;
  await page.goto('/clients/new');
  await page.getByLabel('Client name').fill(clientName);
  await page.getByLabel(/Contact email/).fill('smoke@client.example');
  await page.getByRole('button', { name: 'Create client' }).click();
  await expect(page.getByRole('heading', { name: clientName })).toBeVisible();

  // Create a project for it (the client is preselected from the client page).
  await page.getByRole('link', { name: 'Add project' }).click();
  await expect(page.getByLabel('Client')).toHaveValue(/[0-9a-f-]{36}/);
  const projectName = `smoke-${suffix}`;
  await page.getByLabel('Project name').fill(projectName);
  await page.getByLabel('GitHub repository').fill('acme/smoke');
  await page.getByRole('button', { name: 'Create project' }).click();
  const token = (await page.getByTestId('new-token').textContent())?.trim() ?? '';
  expect(token).toMatch(/^dh_[A-Za-z0-9_-]{43}$/);
  await expect(page.locator('pre')).toContainText('secrets.DEPLOYHEALTH_TOKEN');

  // Report a scan with the new token, as the GitHub Action would.
  const response = await page.request.post('/api/ingest/scan', {
    headers: { authorization: `Bearer ${token}` },
    data: {
      sha: '0123456789abcdef0123456789abcdef01234567',
      branch: 'main',
      timestamp: new Date().toISOString(),
      findings: [{ kind: 'missing', var_name: 'LOG_LEVEL', file: 'src/server.ts', line: 4, env_file: null }],
    },
  });
  expect(response.status()).toBe(201);

  // View the project: assigned to the client, with its scan.
  await page.getByRole('link', { name: 'Go to project' }).click();
  await expect(page.getByRole('heading', { name: projectName })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(clientName);
  await expect(page.getByRole('cell', { name: 'src/server.ts:4' })).toBeVisible();

  // Add an endpoint; without a worker it shows the empty "no checks yet" state.
  const addForm = page.locator('form').filter({ has: page.getByRole('button', { name: 'Add endpoint' }) });
  await addForm.getByLabel('URL').fill('https://example.com/health');
  await addForm.getByLabel('Method').selectOption('HEAD');
  await addForm.getByLabel('Interval').selectOption('60');
  await addForm.getByRole('button', { name: 'Add endpoint' }).click();
  const card = page.getByTestId('endpoint-card').filter({ hasText: 'https://example.com/health' });
  await expect(card).toBeVisible();
  await expect(card.getByTestId('endpoint-status')).toHaveText('No checks yet');
  await expect(card).toContainText('HEAD · every minute · expects 200');
  await expect(card.getByText('No checks yet', { exact: true }).last()).toBeVisible();

  // A private URL is refused by the SSRF guard.
  await addForm.getByLabel('URL').fill('http://169.254.169.254/latest/meta-data/');
  await addForm.getByRole('button', { name: 'Add endpoint' }).click();
  await expect(addForm).toContainText('169.254.169.254 is a private or reserved address');

  // The client page lists the new project.
  await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: clientName }).click();
  await expect(page.getByTestId('project-row').filter({ hasText: projectName })).toBeVisible();
});
