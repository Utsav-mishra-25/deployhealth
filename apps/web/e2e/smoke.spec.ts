import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const STOREFRONT = '0d3e0000-0000-4000-8000-000000000001';
const SCRIPTED_ALERT = 'Acme API started failing 4m after deploy b52952e, which introduced 2 missing env vars: REDIS_URL, STRIPE_KEY';

test('public demo without a session: clients, project, handoff and report', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('link', { name: 'See a live demo' }).click();
  await expect(page).toHaveURL(/\/demo$/);
  await expect(page.getByRole('note', { name: 'Demo' })).toContainText('read-only');
  await expect(page.getByTestId('current-user')).toHaveCount(0);

  // Seeded overview, read-only: no create buttons, no forms anywhere.
  await expect(page.getByRole('link', { name: 'Acme Corp' })).toBeVisible();
  await expect(page.getByRole('rowheader', { name: 'No client' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'New client' })).toHaveCount(0);
  const storefrontRow = page.getByTestId('project-row').filter({ hasText: 'acme-storefront' });
  await expect(storefrontRow.getByTestId('uptime-badge')).toHaveText('Down');
  await expect(storefrontRow.getByTestId('failing-for')).toHaveText(/^Acme API down for 2\dm$/);
  await expect(page.getByTestId('project-row').filter({ hasText: 'northwind-site' }).getByTestId('failing-for')).toHaveCount(0);

  // The project: the real alert, named endpoints, percentages kept, nothing editable.
  await storefrontRow.getByRole('link', { name: 'acme-storefront' }).click();
  await expect(page).toHaveURL(`/demo/projects/${STOREFRONT}`);
  await expect(page.getByRole('alert').filter({ hasText: 'Acme API started failing' })).toContainText(SCRIPTED_ALERT);
  const apiCard = page.getByTestId('endpoint-card').filter({ hasText: 'Acme API' });
  await expect(apiCard.getByTestId('endpoint-status')).toHaveText('Down');
  await expect(apiCard.getByTestId('failing-for')).toHaveText(/^Down for 2\dm$/);
  await expect(apiCard.locator('header')).toContainText(/24h\s*[\d.]+%\s*7d\s*[\d.]+%/);
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Acme Corp');
  await expect(page.locator('main form')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Settings/ })).toHaveCount(0);

  // Export the handoff: the printable page, then the Markdown download.
  await page.getByRole('link', { name: 'Export handoff' }).click();
  await expect(page.getByRole('heading', { name: 'Handoff: acme-storefront' })).toBeVisible();
  await expect(page.getByTestId('handoff')).toContainText('All times UTC');
  await expect(page.getByTestId('handoff-variables').first()).toContainText('REDIS_URL');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download Markdown' }).click()]);
  expect(download.suggestedFilename()).toBe('acme-storefront-handoff.md');
  const markdown = await readFile((await download.path())!, 'utf8');
  expect(markdown).toContain('| `REDIS_URL` | — | **missing** |');
  expect(markdown).toContain('## How to deploy');

  // The client's monthly report.
  await page.goto('/demo/clients/acme-corp');
  await page.getByRole('link', { name: 'Monthly report' }).click();
  await expect(page.getByTestId('report-summary')).toHaveText(/^1 project, .+ uptime, .+, \d+ deploys?, .+ fixed$/);
  await expect(page.getByTestId('report')).toContainText('All times UTC');
  await expect(page.getByRole('button', { name: 'Share report' })).toHaveCount(0);
});

test('signed in: client and project, a named endpoint, deploy notes, handoff and a shared report', async ({ page, browser }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.getByRole('button', { name: 'Continue as dev user' }).click();
  await expect(page).toHaveURL(/\/clients$/);
  await expect(page.getByTestId('current-user')).toHaveText('dev');

  // Create a client, then a project for it (preselected from the client page).
  const suffix = Date.now();
  const clientName = `Smoke Client ${suffix}`;
  await page.goto('/clients/new');
  await page.getByLabel('Client name').fill(clientName);
  await page.getByLabel(/Contact email/).fill('smoke@client.example');
  await page.getByRole('button', { name: 'Create client' }).click();
  await expect(page.getByRole('heading', { name: clientName })).toBeVisible();
  const clientUrl = page.url();

  await page.getByRole('link', { name: 'Add project' }).click();
  await expect(page.getByLabel('Client')).toHaveValue(/[0-9a-f-]{36}/);
  const projectName = `smoke-${suffix}`;
  await page.getByLabel('Project name').fill(projectName);
  await page.getByLabel('GitHub repository').fill('acme/smoke');
  await page.getByRole('button', { name: 'Create project' }).click();
  const token = (await page.getByTestId('new-token').textContent())?.trim() ?? '';
  expect(token).toMatch(/^dh_[A-Za-z0-9_-]{43}$/);

  // Report a scan with the new token, as the GitHub Action would, including the variable list.
  const response = await page.request.post('/api/ingest/scan', {
    headers: { authorization: `Bearer ${token}` },
    data: {
      sha: '0123456789abcdef0123456789abcdef01234567',
      branch: 'main',
      timestamp: new Date().toISOString(),
      findings: [{ kind: 'missing', var_name: 'LOG_LEVEL', file: 'src/server.ts', line: 4, env_file: null }],
      variables: [
        { var_name: 'DATABASE_URL', scope: '', defined_in: ['.env.example'] },
        { var_name: 'LOG_LEVEL', scope: '', defined_in: [] },
      ],
    },
  });
  expect(response.status()).toBe(201);

  await page.getByRole('link', { name: 'Go to project' }).click();
  await expect(page.getByRole('heading', { name: projectName })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(clientName);
  await expect(page.getByRole('cell', { name: 'src/server.ts:4' })).toBeVisible();
  const projectUrl = page.url();

  // Add a named endpoint; without a worker it shows "No checks yet".
  const addForm = page.locator('form').filter({ has: page.getByRole('button', { name: 'Add endpoint' }) });
  await addForm.getByLabel('Name').fill('Smoke API');
  await addForm.getByLabel('URL').fill('https://example.com/health');
  await addForm.getByLabel('Method').selectOption('HEAD');
  await addForm.getByLabel('Interval').selectOption('60');
  await addForm.getByRole('button', { name: 'Add endpoint' }).click();
  const card = page.getByTestId('endpoint-card').filter({ hasText: 'Smoke API' });
  await expect(card).toContainText('https://example.com/health');
  await expect(card.getByTestId('endpoint-status')).toHaveText('No checks yet');
  await expect(card.getByTestId('failing-for')).toHaveCount(0);

  // A private URL is refused by the SSRF guard.
  await addForm.getByLabel('URL').fill('http://169.254.169.254/latest/meta-data/');
  await addForm.getByRole('button', { name: 'Add endpoint' }).click();
  await expect(addForm).toContainText('169.254.169.254 is a private or reserved address');

  // Deploy notes are untrusted Markdown: no raw HTML, no images in the handoff.
  await page.getByRole('link', { name: /Settings/ }).click();
  await page.getByLabel(/How to deploy/).fill('## Railway\n\n1. Push to `main`.\n\n<script>window.pwned = true</script>\n\n![pixel](https://tracker.example/p.gif)');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Saved')).toBeVisible();

  await page.goto(`${projectUrl}/handoff`);
  const handoff = page.getByTestId('handoff');
  await expect(handoff.getByRole('heading', { name: 'Railway' })).toBeVisible();
  await expect(handoff.locator('script, img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { pwned?: boolean }).pwned)).toBeUndefined();
  await expect(handoff).toContainText('Smoke API');
  await expect(page.getByTestId('handoff-variables')).toContainText('LOG_LEVEL');

  // Share the client's report, open the link with no session, and check a tampered one fails.
  await page.goto(clientUrl);
  await page.getByRole('link', { name: 'Monthly report' }).click();
  await expect(page.getByTestId('report-summary')).toHaveText(/^1 project, /);
  await page.getByRole('button', { name: 'Share report' }).click();
  const shareUrl = await page.getByLabel('Share link').inputValue();
  expect(shareUrl).toMatch(/\/share\/reports\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);

  const stranger = await browser.newContext();
  const shared = await stranger.newPage();
  await shared.goto(shareUrl);
  await expect(shared.getByRole('heading', { name: new RegExp(`${clientName} · `) })).toBeVisible();
  await expect(shared.getByTestId('report-project')).toHaveCount(1);
  await expect(shared.getByTestId('report-project')).toContainText(projectName);
  await expect(shared.getByTestId('current-user')).toHaveCount(0);
  const tampered = await shared.goto(`${shareUrl.slice(0, -1)}${shareUrl.endsWith('A') ? 'B' : 'A'}`);
  expect(tampered?.status()).toBe(404);
  await stranger.close();
});
