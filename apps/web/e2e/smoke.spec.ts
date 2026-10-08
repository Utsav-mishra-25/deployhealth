import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const STOREFRONT = '0d3e0000-0000-4000-8000-000000000001';
const SCRIPTED_ALERT = 'Acme API started failing 4m after deploy b52952e, which introduced 2 missing env vars: REDIS_URL, STRIPE_KEY';

test('landing page for a signed-out visitor, one click to the demo', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(/\/$/);
  const landing = page.getByTestId('landing');
  await expect(landing.getByRole('alert')).toContainText(SCRIPTED_ALERT);
  await expect(landing.getByRole('heading', { level: 1 })).toHaveText(/tells you which deploy broke what\.$/);
  await expect(landing).toContainText('Free while in beta.');
  await expect(landing.getByTestId('landing-languages')).toContainText('Reads JS/TS, Python, Go, Ruby and PHP.');
  await expect(landing).not.toContainText(/\$\d|per month|pricing/i);
  await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', 'deployhealth');
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute('content', 'summary_large_image');
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('type', 'image/svg+xml');

  await landing.getByRole('link', { name: 'See the live demo' }).click();
  await expect(page).toHaveURL(/\/demo$/);
  await expect(page.getByRole('note', { name: 'Demo' })).toContainText('pull request checks are sample data, read-only');

  await page.goto('/');
  await page.getByTestId('landing').getByRole('link', { name: 'Sign in with GitHub' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('link', { name: 'See a live demo' })).toBeVisible();
});

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
  // Fresh at any hour: the worker reseeds every 30 minutes, so it's always been down for under an hour.
  await expect(storefrontRow.getByTestId('failing-for')).toHaveText(/^Acme API down for [1-5]?\dm$/);
  await expect(page.getByTestId('project-row').filter({ hasText: 'northwind-site' }).getByTestId('failing-for')).toHaveCount(0);

  // The project: the real alert, named endpoints, percentages kept, nothing editable.
  await storefrontRow.getByRole('link', { name: 'acme-storefront' }).click();
  await expect(page).toHaveURL(`/demo/projects/${STOREFRONT}`);
  await expect(page).toHaveTitle('acme-storefront · Live demo · deployhealth');
  // Link previews stay generic: no project or client names in the Open Graph title.
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', 'deployhealth');
  await expect(page.getByRole('alert').filter({ hasText: 'Acme API started failing' })).toContainText(SCRIPTED_ALERT);
  const apiCard = page.getByTestId('endpoint-card').filter({ hasText: 'Acme API' });
  await expect(apiCard.getByTestId('endpoint-status')).toHaveText('Down');
  await expect(apiCard.getByTestId('failing-for')).toHaveText(/^Down for [1-5]?\dm$/);
  await expect(apiCard.locator('header')).toContainText(/24h\s*[\d.]+%\s*7d\s*[\d.]+%/);
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Acme Corp');
  await expect(page.locator('main form')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Settings/ })).toHaveCount(0);

  // Sample pull request checks: the agent PR behind the incident, a clean rename, a strict failure.
  // They aren't real pull requests, so nothing links to GitHub.
  const prs = page.getByRole('region', { name: 'Pull requests' });
  await expect(prs.getByTestId('pr-check-row')).toHaveCount(3);
  await expect(prs.getByTestId('sample-marker')).toHaveCount(3);
  const claudePr = prs.getByTestId('pr-check-row').filter({ hasText: '#87' });
  await expect(claudePr.getByTestId('agent-badge')).toHaveText('Claude');
  await expect(claudePr.getByTestId('pr-undeclared')).toHaveText('2');
  await expect(claudePr).toContainText('Flagged');
  await expect(prs.getByTestId('pr-check-row').filter({ hasText: '#86' })).toContainText('Passed');
  const strictPr = prs.getByTestId('pr-check-row').filter({ hasText: '#88' });
  await expect(strictPr).toContainText('Failed');
  await expect(strictPr).toContainText('1 possible secret');
  await expect(prs.getByRole('link')).toHaveCount(0);
  await expect(page.locator('main a[href*="github.com"]')).toHaveCount(0);

  // Export the handoff: the printable page, then the Markdown download.
  await page.getByRole('link', { name: 'Export handoff' }).click();
  await expect(page.getByRole('heading', { name: 'Handoff: acme-storefront' })).toBeVisible();
  await expect(page).toHaveTitle('Handoff · acme-storefront · Live demo · deployhealth');
  await expect(page.getByTestId('handoff')).toContainText('All times UTC');
  await expect(page.getByTestId('handoff-variables').first()).toContainText('REDIS_URL');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download Markdown' }).click()]);
  expect(download.suggestedFilename()).toBe('acme-storefront-handoff.md');
  const markdown = await readFile((await download.path())!, 'utf8');
  expect(markdown).toContain('| `REDIS_URL` | — | **missing** |');
  expect(markdown).toContain('## How to deploy');

  // The client's monthly report, and the month's agent pull requests.
  await page.goto('/demo/clients/acme-corp');
  await expect(page.getByTestId('agent-pr-stat')).toContainText(/Agent PRs that added undeclared env vars this month: \d+ of \d+/);
  await expect(page).toHaveTitle('Acme Corp · Live demo · deployhealth');
  await page.getByRole('link', { name: 'Monthly report' }).click();
  await expect(page.getByTestId('report-summary')).toHaveText(/^1 project, .+ uptime, .+, \d+ deploys?, .+ fixed$/);
  await expect(page).toHaveTitle(/^Report · [A-Z][a-z]+ \d{4} · Live demo · deployhealth$/);
  await expect(page.getByTestId('report')).toContainText('All times UTC');
  await expect(page.getByRole('button', { name: 'Share report' })).toHaveCount(0);
});

test('a project with no env file: one notice instead of MISSING rows, and a starting .env.example', async ({ page }) => {
  const PORTFOLIO = '0d3e0000-0000-4000-8000-000000000003';
  await page.goto(`/demo/projects/${PORTFOLIO}`);
  const notice = page.getByTestId('no-env-file-notice');
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText('No .env.example here: 2 variables referenced');
  await expect(page.locator('#findings-missing')).toContainText('0 findings');

  await notice.getByRole('link', { name: 'Copy them as a starting .env.example' }).click();
  await expect(page).toHaveURL(new RegExp(`/demo/projects/${PORTFOLIO}/handoff#variables$`));
  const scope = page.getByTestId('handoff-scope').filter({ hasText: 'Repository root' });
  await expect(scope.getByRole('row', { name: /CONTACT_FORM_ENDPOINT/ })).toContainText('no env file yet');
  await expect(scope.getByTestId('env-example')).toContainText('CONTACT_FORM_ENDPOINT=\nNEXT_PUBLIC_SITE_URL=');
  await expect(scope.getByRole('button', { name: 'Copy as .env.example' })).toBeVisible();

  // The Markdown download carries the same starting file.
  const markdown = await (await page.request.get(`/demo/projects/${PORTFOLIO}/handoff.md`)).text();
  expect(markdown).toContain('```dotenv\nCONTACT_FORM_ENDPOINT=\nNEXT_PUBLIC_SITE_URL=\n```');
});

test('GitHub App setup page: signed out, sign in and come back; a repo link pre-fills the new project', async ({ page }) => {
  await page.goto('/github/installed');
  await expect(page.getByTestId('installed-signed-out')).toContainText('Sign in to deployhealth with the GitHub account you installed it with');
  await page.getByRole('link', { name: 'Sign in and come back' }).click();
  await expect(page).toHaveURL(/\/login\?next=%2Fgithub%2Finstalled$/);
  await page.getByRole('button', { name: 'Continue as dev user' }).click();
  await expect(page).toHaveURL(/\/github\/installed$/);
  // The dev user has no installation linked: the page says what to check, and offers no next steps.
  await expect(page.getByTestId('installations-empty')).toBeVisible();
  await expect(page.getByTestId('app-next-steps')).toHaveCount(0);

  // The next steps link to the new project form, pre-filled; anything that isn't owner/repo is ignored.
  await page.goto('/projects/new?repo=acme%2Fnext-steps');
  await expect(page.getByLabel('GitHub repository')).toHaveValue('acme/next-steps');
  await expect(page.getByLabel('Project name')).toHaveValue('next-steps');
  await page.goto('/projects/new?repo=%3Cscript%3E');
  await expect(page.getByLabel('GitHub repository')).toHaveValue('');

  // Signed in, /login goes to ?next= only when it's a path on this site.
  await page.goto('/login?next=%2Fgithub%2Finstalled');
  await expect(page).toHaveURL(/\/github\/installed$/);
  await page.goto('/login?next=%2F%2Fevil.example');
  await expect(page).toHaveURL(/\/clients$/);
});

test('signed in: client and project, a named endpoint, deploy notes, handoff and a shared report', async ({ page, browser }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Continue as dev user' }).click();
  await expect(page).toHaveURL(/\/clients$/);
  await expect(page.getByTestId('current-user')).toHaveText('dev');
  // Signed in, the home page is the clients page, as before.
  await page.goto('/');
  await expect(page).toHaveURL(/\/clients$/);
  await expect(page.getByTestId('landing')).toHaveCount(0);

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
  // Two setup options: pull request checks need no token; the Action needs it as a repository secret.
  await expect(page.getByTestId('pr-checks-option')).toContainText('No token, no secret, no variable.');
  await expect(page.getByTestId('deploy-history-option')).toContainText('Secrets tab → New repository secret, named DEPLOYHEALTH_TOKEN');
  await expect(page.getByText(token, { exact: true })).toHaveCount(1);

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
  await expect(page).toHaveTitle(`${projectName} · deployhealth`);
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
  await expect(page.locator('pre').filter({ hasText: 'npx --yes deployhealth-scan@' })).toHaveCount(2); // Action + local run
  await expect(page.getByRole('heading', { level: 2, name: 'Pull request checks' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Deploy history and alerts' })).toBeVisible();
  await expect(page.getByTestId('secret-steps')).toContainText('In acme/smoke: Settings → Secrets and variables → Actions → Secrets tab');
  await expect(page.getByTestId('secret-steps')).toContainText('Not a Variable');
  await expect(page.getByText(token)).toHaveCount(0);

  // The GitHub App: install link, status, and the mode.
  await expect(page.getByTestId('install-github-app')).toHaveAttribute('href', 'https://github.com/apps/deployhealth/installations/new');
  await expect(page.getByTestId('github-app-status')).toHaveText(`Not installed on acme/smoke yet.`);
  await page.getByLabel(/Strict/).check();
  await page.getByRole('button', { name: 'Save mode' }).click();
  await expect(page.locator('form').filter({ has: page.getByRole('button', { name: 'Save mode' }) }).getByText('Saved')).toBeVisible();
  await expect(page.locator('pre').filter({ hasText: 'deployhealth-scan.mjs' })).toHaveCount(0);
  await page.getByLabel(/How to deploy/).fill('## Railway\n\n1. Push to `main`.\n\n<script>window.pwned = true</script>\n\n![pixel](https://tracker.example/p.gif)');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('form').filter({ has: page.getByRole('button', { name: 'Save settings' }) }).getByText('Saved')).toBeVisible();

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
  await expect(page).toHaveTitle(/^Report · [A-Z][a-z]+ \d{4} · deployhealth$/);
  const shareUrl = await page.getByLabel('Share link').inputValue();
  expect(shareUrl).toMatch(/\/share\/reports\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);

  const stranger = await browser.newContext();
  const shared = await stranger.newPage();
  await shared.goto(shareUrl);
  await expect(shared.getByRole('heading', { name: new RegExp(`${clientName} · `) })).toBeVisible();
  // The client's name stays out of the title and the link preview.
  await expect(shared).toHaveTitle('Monthly report · deployhealth');
  await expect(shared.locator('meta[property="og:title"]')).toHaveAttribute('content', 'deployhealth');
  await expect(shared.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
  await expect(shared.getByTestId('report-project')).toHaveCount(1);
  await expect(shared.getByTestId('report-project')).toContainText(projectName);
  await expect(shared.getByTestId('current-user')).toHaveCount(0);
  const tampered = await shared.goto(`${shareUrl.slice(0, -1)}${shareUrl.endsWith('A') ? 'B' : 'A'}`);
  expect(tampered?.status()).toBe(404);
  await stranger.close();
});

test('the old CLI download is still served, marked deprecated', async ({ request }) => {
  const response = await request.get('/deployhealth-scan.mjs');
  expect(response.status()).toBe(200);
  expect(response.headers()['deprecation']).toBe('@1790640000');
  expect(response.headers()['link']).toMatch(/#deprecated-downloading-the-cli-from-your-instance>; rel="deprecation"$/);
  expect(await response.text()).toMatch(/^#!\/usr\/bin\/env node\n/);
});

test('security: public page linked from the footer, and security.txt', async ({ page, request }) => {
  await page.goto('/login');
  await page.getByRole('navigation', { name: 'Footer' }).getByRole('link', { name: 'Security' }).click();
  await expect(page).toHaveURL(/\/security$/);
  await expect(page.getByRole('heading', { name: 'Security', level: 1 })).toBeVisible();
  await expect(page.getByTestId('security')).toContainText('never values');
  await expect(page.getByTestId('security')).toContainText('72 hours');
  await expect(page.getByTestId('security-contact')).toHaveAttribute('href', 'mailto:security@deployhealth.example');
  await expect(page.getByTestId('current-user')).toHaveCount(0);

  const txt = await request.get('/.well-known/security.txt');
  expect(txt.status()).toBe(200);
  expect(txt.headers()['content-type']).toBe('text/plain; charset=utf-8');
  const body = await txt.text();
  expect(body).toMatch(/^Contact: mailto:security@deployhealth\.example\nExpires: \d{4}-\d\d-\d\dT00:00:00\.000Z\n/);
  expect(body).toMatch(/\nPolicy: http:\/\/localhost:\d+\/security\n$/);
});

test('privacy and terms: public pages linked from the footer', async ({ page }) => {
  await page.goto('/');
  const footer = page.getByRole('navigation', { name: 'Footer' });
  await expect(footer.getByRole('link')).toHaveText(['Security', 'Privacy', 'Terms', 'Source on GitHub']);
  await footer.getByRole('link', { name: 'Privacy' }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByTestId('privacy')).toContainText('Utsav Mishra (India)');
  await expect(page.getByTestId('privacy')).toContainText('even if it is private on GitHub');
  await expect(page.getByTestId('last-updated')).toHaveText(/^Last updated: \d{1,2} [A-Z][a-z]+ \d{4}$/);
  await page.getByRole('navigation', { name: 'Footer' }).getByRole('link', { name: 'Terms' }).click();
  await expect(page).toHaveURL(/\/terms$/);
  await expect(page.getByTestId('terms')).toContainText('Only monitor endpoints you own or are authorised to check.');
});

test('security headers on pages, route handlers and downloads', async ({ request }) => {
  for (const path of ['/', '/demo', '/api/health', '/sitemap.xml', `/demo/projects/${STOREFRONT}/handoff.md`]) {
    const headers = (await request.get(path)).headers();
    expect(headers['x-content-type-options'], path).toBe('nosniff');
    expect(headers['referrer-policy'], path).toBe('strict-origin-when-cross-origin');
    expect(headers['x-frame-options'], path).toBe('DENY');
    expect(headers['content-security-policy'], path).toBe("frame-ancestors 'none'");
    expect(headers['permissions-policy'], path).toBe('camera=(), microphone=(), geolocation=()');
    expect(headers['strict-transport-security'], path).toBeUndefined();
  }
  const sitemap = await (await request.get('/sitemap.xml')).text();
  for (const path of ['/demo', '/security', '/privacy', '/terms']) expect(sitemap).toContain(`<loc>http://localhost:3100${path}</loc>`);
});
