import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { createProject, createToken } from './helpers';
import { addDevSession, signInAsDev } from './session';

const STOREFRONT = '0d3e0000-0000-4000-8000-000000000001';
const SCRIPTED_ALERT = 'Acme API started failing 4m after deploy b52952e, which introduced 2 missing env vars: REDIS_URL, STRIPE_KEY';

const HEADLINE = "Know which deploy broke your client's site, before they call you.";

test('landing page for a signed-out visitor: the hero first, the alert below it, one click to the demo', async ({ page }) => {
  const response = await page.goto('/');
  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(/\/$/);
  const landing = page.getByTestId('landing');
  const hero = landing.getByTestId('landing-hero');
  await expect(hero.getByRole('heading', { level: 1 })).toHaveText(HEADLINE);
  await expect(hero).toContainText('Monthly reports your clients can read.');
  await expect(hero).toContainText('Free during the beta.');
  await expect(hero).not.toContainText('Reads JS/TS');
  await expect(hero.getByRole('alert')).toHaveCount(0);
  await expect(landing).not.toContainText('Plus:');

  // The live alert sits below the hero and the screenshot, under its own heading.
  const alert = landing.getByTestId('landing-alert');
  await expect(alert.getByRole('heading', { level: 2 })).toHaveText('What an alert looks like (live from the demo)');
  await expect(alert.getByRole('alert')).toContainText(SCRIPTED_ALERT);
  await expect(alert.getByRole('alert')).toContainText('Alerts like this go to Slack or Discord.');
  const heroBox = (await hero.boundingBox())!;
  const shotBox = (await landing.getByTestId('landing-screenshot').boundingBox())!;
  const alertBox = (await alert.boundingBox())!;
  expect(shotBox.y).toBeGreaterThan(heroBox.y + heroBox.height - 1);
  expect(alertBox.y).toBeGreaterThan(shotBox.y + shotBox.height - 1);

  // The screenshot is the committed asset, loaded from this site, with its size and alt set.
  const shot = landing.getByTestId('landing-screenshot');
  await expect(shot).toHaveAttribute('src', '/landing/demo-clients.png');
  await expect(shot).toHaveAttribute('width', '2080');
  await expect(shot).toHaveAttribute('height', '912');
  await expect(shot).toHaveAttribute('alt', /clients list/);
  expect(await shot.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(2080);
  const shotLink = landing.getByTestId('landing-screenshot-link');
  await expect(shotLink).toHaveAttribute('href', '/demo');
  await expect(shotLink).toHaveAccessibleName(/^Open the live demo: The deployhealth demo's clients list/);
  await shotLink.click();
  await expect(page).toHaveURL(/\/demo$/);
  await page.goBack();

  // The FAQ is plain <details>; the languages are one line in it, not in the hero.
  const faq = landing.getByTestId('faq');
  await expect(faq.locator('details')).toHaveCount(4);
  const stack = faq.locator('details').filter({ hasText: "What if my stack isn't supported?" });
  await stack.getByText("What if my stack isn't supported?").click();
  await expect(stack).toContainText('including WordPress');
  await expect(stack).toContainText('Supported today: JS/TS, Python, Go, Ruby, PHP, Java/Kotlin.');
  await expect(landing).not.toContainText('Reads JS/TS');
  await expect(landing.getByTestId('pricing-plans')).toContainText('Free during the beta: everything you see in the demo.');

  // Metadata: the landing page's own title and preview; the image stays the site's one.
  await expect(page).toHaveTitle("deployhealth: know which deploy broke your client's site");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /^Checks every pull request for config nobody declared/);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', HEADLINE);
  await expect(page.locator('meta[property="og:description"]')).toHaveAttribute('content', /^Checks every pull request/);
  await expect(page.locator('meta[property="og:image:alt"]')).toHaveAttribute('content', `deployhealth: ${HEADLINE}`);
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', /\/opengraph-image/);
  await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute('content', 'summary_large_image');
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('type', 'image/svg+xml');
  expect((await page.request.get('/opengraph-image')).status()).toBe(200);

  await landing.getByRole('link', { name: 'See the live demo' }).click();
  await expect(page).toHaveURL(/\/demo$/);
  await expect(page.getByRole('note', { name: 'Demo' })).toContainText('pull request checks are sample data, read-only');

  await page.goto('/');
  await page.getByTestId('landing').getByRole('link', { name: 'Sign in with GitHub' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('link', { name: 'See a live demo' })).toBeVisible();

  // Other pages keep the generic preview, so a shared link never carries a client's name.
  await page.goto('/docs');
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', 'deployhealth');
});

test('the header on every public page: Demo, Docs, Pricing and Sign in with GitHub, with no JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  for (const path of ['/', '/login', '/demo', `/demo/projects/${STOREFRONT}`, '/demo/clients/acme-corp/report', '/pricing', '/docs', '/docs/nextjs', '/security', '/privacy', '/terms', '/github/installed', '/no-such-page']) {
    await page.goto(path);
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link'), path).toHaveText(['Demo', 'Docs', 'Pricing', 'Sign in with GitHub']);
    await expect(nav.getByRole('link', { name: 'Demo' })).toHaveAttribute('href', '/demo');
    await expect(nav.getByRole('link', { name: 'Docs' })).toHaveAttribute('href', '/docs');
    await expect(nav.getByRole('link', { name: 'Pricing' })).toHaveAttribute('href', '/pricing');
    await expect(nav.getByRole('link', { name: 'Sign in with GitHub' })).toHaveAttribute('href', '/login');
    await expect(page.getByRole('navigation', { name: 'Footer' }).getByRole('link', { name: 'Pricing' })).toHaveAttribute('href', '/pricing');
  }
  await context.close();
});

test('/pricing: free during the beta, the planned prices, no limits table, in the sitemap', async ({ page }) => {
  const response = await page.goto('/pricing');
  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle('Pricing · deployhealth');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /^Free during the beta/);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/pricing$/);
  await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
  const pricing = page.getByTestId('pricing');
  await expect(pricing.getByRole('heading', { level: 1 })).toHaveText('Pricing');
  await expect(pricing).toContainText('Free during the beta: everything you see in the demo.');
  await expect(pricing.getByTestId('pricing-plan')).toHaveText(['Freelancer$15/month', 'Studio$29/month']);
  await expect(pricing).toContainText('Beta users get advance notice and an early-user price.');
  await expect(pricing.locator('table')).toHaveCount(0);
  await expect(pricing).not.toContainText(/email alerts|branded|seats|limit/i);
  await expect(page.getByTestId('current-user')).toHaveCount(0);

  const sitemap = await (await page.request.get('/sitemap.xml')).text();
  expect(sitemap).toContain('<loc>http://localhost:3100/pricing</loc>');
});

test('/demo guide: three items under the banner, each link resolves', async ({ page }) => {
  await page.goto('/demo');
  const guide = page.getByTestId('demo-guide');
  const banner = page.getByRole('note', { name: 'Demo' });
  expect((await guide.boundingBox())!.y).toBeGreaterThan((await banner.boundingBox())!.y);
  await expect(guide.getByRole('listitem')).toHaveCount(3);
  const links = guide.getByRole('link');
  await expect(links).toHaveText(['The project list', "The deploy that broke Acme's API", "The monthly report you'd send Acme", 'its handoff']);
  const hrefs = await links.evaluateAll((as) => as.map((a) => a.getAttribute('href')!));
  expect(hrefs).toEqual(['/demo#projects', `/demo/projects/${STOREFRONT}#deploys`, '/demo/clients/acme-corp/report', `/demo/projects/${STOREFRONT}/handoff`]);

  // Each target exists: the anchors are on the page they name.
  await links.first().click();
  await expect(page).toHaveURL(/\/demo#projects$/);
  await expect(page.locator('#projects')).toContainText('acme-storefront');
  for (const href of hrefs.slice(1)) {
    const [path, anchor] = href.split('#');
    const response = await page.goto(href);
    expect(response?.status(), href).toBe(200);
    expect(new URL(page.url()).pathname).toBe(path);
    if (anchor) await expect(page.locator(`#${anchor}`)).toBeVisible();
  }
  await page.goto('/demo/clients/acme-corp/report');
  await expect(page.getByTestId('report')).toContainText('Acme Corp');
  await page.goto(`/demo/projects/${STOREFRONT}/handoff`);
  await expect(page.getByTestId('handoff')).toContainText('acme-storefront');
});

test('a friendly 404: in the site style, with links to Home, Demo and Docs', async ({ page }) => {
  const response = await page.goto('/no-such-page');
  expect(response?.status()).toBe(404);
  await expect(page).toHaveTitle('Page not found · deployhealth');
  const notFound = page.getByTestId('not-found');
  await expect(notFound.getByRole('heading', { level: 1 })).toHaveText('Page not found');
  const ways = notFound.getByRole('navigation', { name: 'Ways back' }).getByRole('link');
  await expect(ways).toHaveText(['Home', 'Demo', 'Docs']);
  await ways.filter({ hasText: 'Docs' }).click();
  await expect(page).toHaveURL(/\/docs$/);
  await page.goto('/no-such-page');
  await page.getByTestId('not-found').getByRole('link', { name: 'Demo' }).click();
  await expect(page).toHaveURL(/\/demo$/);
  await page.goto('/no-such-page');
  await page.getByTestId('not-found').getByRole('link', { name: 'Home' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('landing')).toBeVisible();
  // notFound() from a page renders the same.
  expect((await page.goto('/docs/django'))?.status()).toBe(404);
  await expect(page.getByTestId('not-found')).toBeVisible();
});

test('a production build never offers the dev login, even with AUTH_DEMO_LOGIN=1', async ({ page }) => {
  // The e2e server runs `next start` with AUTH_DEMO_LOGIN=1 (playwright.config.ts).
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue as dev user' })).toHaveCount(0);
  await expect(page.getByText('AUTH_DEMO_LOGIN')).toHaveCount(0);
  const providers = await (await page.request.get('/api/auth/providers')).json();
  expect(Object.keys(providers)).toEqual(['github']);
});

test('public URLs come from PUBLIC_ORIGIN, never a spoofed Host or X-Forwarded-Host', async ({ page }) => {
  const origin = 'http://localhost:3100'; // PUBLIC_ORIGIN in playwright.config.ts
  const spoofed = { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' };

  const txt = await page.request.get('/.well-known/security.txt', { headers: spoofed });
  expect(txt.status()).toBe(200);
  expect(txt.headers()['cache-control']).toBe('no-store');
  expect(await txt.text()).toContain(`\nPolicy: ${origin}/security\n`);

  const sitemap = await (await page.request.get('/sitemap.xml', { headers: spoofed })).text();
  expect(sitemap).toContain(`<loc>${origin}/docs/nextjs</loc>`);
  expect(sitemap).not.toContain('evil.example');

  const docs = await (await page.request.get('/docs/nextjs', { headers: spoofed })).text();
  expect(docs).toContain(`<link rel="canonical" href="${origin}/docs/nextjs"/>`);
  expect(docs).not.toContain('evil.example');

  // Signed in: the Action snippet on a project's settings page, its --url quoted.
  await signInAsDev(page);
  const projectPath = await createProject(page, { name: `origin-${Date.now()}`, repo: 'acme/origin' });
  // Hosts only: with X-Forwarded-Proto https, Auth.js would look for the __Secure- cookie instead.
  const settingsResponse = await page.request.get(`${projectPath}/settings`, { headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' }, maxRedirects: 0 });
  expect(settingsResponse.status()).toBe(200);
  const settings = await settingsResponse.text();
  expect(settings).toMatch(/data-testid="current-user"[^>]*>dev</);
  expect(settings).toContain(`--url &quot;${origin}&quot;`);
  // The Action's block names this instance too (its url input defaults to the hosted one).
  expect(settings).toContain(`url: &quot;${origin}&quot;`);
  expect(settings).not.toContain('evil.example');
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
  // One status per project, worst first, under a summary line; reasons list non-zero findings only.
  await expect(page.getByTestId('status-summary')).toHaveText('2 of 3 projects need attention · 1 down');
  await expect(page.getByTestId('project-row')).toHaveText([/acme-storefront/, /northwind-site/, /portfolio/]);
  const storefrontRow = page.getByTestId('project-row').filter({ hasText: 'acme-storefront' });
  await expect(storefrontRow.getByTestId('project-status')).toHaveText('Down');
  // Fresh at any hour: the worker reseeds every 30 minutes, so it's always been down for under an hour.
  await expect(storefrontRow.getByTestId('status-reasons')).toHaveText(
    /^Acme API down for [1-5]?\dm · 3 missing · 1 mismatch · 1 open PR: committed env file, secret-shaped string · 2 unused$/,
  );
  const northwindRow = page.getByTestId('project-row').filter({ hasText: 'northwind-site' });
  await expect(northwindRow.getByTestId('project-status')).toHaveText('Needs attention');
  await expect(northwindRow.getByTestId('status-reasons')).toHaveText('1 open PR: undeclared env vars, committed env file · 1 unused');
  await expect(northwindRow.getByTestId('status-reasons')).not.toContainText(/down for|0 missing|0 mismatch/);
  const portfolioRow = page.getByTestId('project-row').filter({ hasText: 'portfolio' });
  await expect(portfolioRow.getByTestId('project-status')).toHaveText('Healthy');
  await expect(portfolioRow.getByTestId('status-reasons')).toHaveText(/^checked (just now|.+ ago|yesterday)$/);

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
  // Deploy history: what each deploy changed and the outage after the incident's deploy. The demo's
  // repositories are made up, so commits aren't linked, and there's no source column.
  const deploys = page.getByRole('region', { name: 'Deploys' });
  const latestDeploy = deploys.getByTestId('deploy-row').first();
  await expect(latestDeploy.getByTestId('deploy-change')).toHaveText('+2 missing: REDIS_URL, STRIPE_KEY');
  await expect(latestDeploy.getByTestId('deploy-outage')).toHaveText('Outage started 4m after this deploy (Acme API), still down');
  await expect(deploys.getByTestId('deploy-outage')).toHaveCount(1);
  await expect(deploys.getByTestId('deploy-row').last().getByTestId('deploy-change')).toHaveText('first scan');
  await expect(deploys.getByTestId('commit-link')).toHaveCount(0);
  await expect(deploys.getByRole('columnheader', { name: 'Source' })).toHaveCount(0);
  await expect(page.locator('main form')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Settings/ })).toHaveCount(0);

  // Section links on top, in page order: findings, deploys, pull requests, endpoints.
  await expect(page.getByTestId('section-links').getByRole('link')).toHaveText(['Findings', 'Deploys', 'Pull requests', 'Endpoints']);
  const headings = (await page.locator('main h2').allTextContents()).map((h) => h.trim());
  const order = ['Latest scan', 'Findings', 'Deploys', 'Pull requests', 'Endpoints'].map((h) => headings.indexOf(h));
  expect(order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1]!))).toBe(true);
  // Findings say what to do.
  await expect(page.getByRole('columnheader', { name: 'What to do' }).first()).toBeVisible();
  await expect(page.getByTestId('finding-action').first()).toHaveText(/^Declare it in .*\.env\.example and set it on your host$/);
  // Five recent checks per endpoint; the rest under a closed "Show all checks".
  await expect(apiCard.locator('table').first().locator('tbody tr')).toHaveCount(5);
  const moreChecks = apiCard.getByTestId('more-checks');
  await expect(moreChecks.locator('summary')).toHaveText('Show all checks');
  await expect(moreChecks.locator('tbody tr').first()).toBeHidden();
  await moreChecks.locator('summary').click();
  await expect(moreChecks.locator('tbody tr')).toHaveCount(15);

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
  // For the client: who prepared it, a plain summary (no variable names), four tiles, no commit links.
  await expect(page.getByTestId('prepared-by')).toHaveText('Prepared by Demo User');
  await expect(page.getByTestId('report-summary')).toHaveText(/^(So far in|In) [A-Z][a-z]+, Acme Corp's sites were up [\d.]+% of the time\. .+ deployed.*\.$/);
  await expect(page.getByTestId('report-summary')).not.toContainText(/REDIS_URL|STRIPE_KEY|b52952e|env var/);
  await expect(page.getByTestId('report-tiles').locator('> div')).toHaveCount(4);
  await expect(page.getByRole('heading', { name: 'Technical details' })).toBeVisible();
  await expect(page.getByTestId('report').locator('a[href*="/commit/"]')).toHaveCount(0);
  await expect(page).toHaveTitle(/^Report · [A-Z][a-z]+ \d{4} · Live demo · deployhealth$/);
  await expect(page.getByTestId('report')).toContainText('All times UTC');
  await expect(page.getByRole('button', { name: 'Share report' })).toHaveCount(0);
});

test('a project with no env file: one notice instead of MISSING rows, and a starting .env.example', async ({ page }) => {
  // The demo's projects all have env files, so this one is reported through ingest as the CLI would.
  await signInAsDev(page);
  const projectName = `no-env-${Date.now()}`;
  const projectPath = await createProject(page, { name: projectName, repo: 'acme/no-env' });
  const token = await createToken(page, projectPath);
  const response = await page.request.post('/api/ingest/scan', {
    headers: { authorization: `Bearer ${token}` },
    data: {
      sha: '89abcdef0123456789abcdef0123456789abcdef',
      branch: 'main',
      timestamp: new Date().toISOString(),
      findings: [],
      variables: [
        { var_name: 'CONTACT_FORM_ENDPOINT', scope: '', defined_in: [] },
        { var_name: 'NEXT_PUBLIC_SITE_URL', scope: '', defined_in: [] },
      ],
      env_scopes: [{ scope: '', env_files: [] }],
    },
  });
  expect(response.status()).toBe(201);
  await page.goto(projectPath);
  await expect(page.getByRole('heading', { name: projectName })).toBeVisible();

  const notice = page.getByTestId('no-env-file-notice');
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText('No .env.example here: 2 variables referenced');
  await expect(page.locator('#findings-missing')).toContainText('0 findings');

  await notice.getByRole('link', { name: 'Copy them as a starting .env.example' }).click();
  await expect(page).toHaveURL(new RegExp(`${projectPath}/handoff#variables$`));
  const scope = page.getByTestId('handoff-scope').filter({ hasText: 'Repository root' });
  await expect(scope.getByRole('row', { name: /CONTACT_FORM_ENDPOINT/ })).toContainText('no env file yet');
  await expect(scope.getByTestId('env-example')).toContainText('CONTACT_FORM_ENDPOINT=\nNEXT_PUBLIC_SITE_URL=');
  await expect(scope.getByRole('button', { name: 'Copy as .env.example' })).toBeVisible();

  // The Markdown download carries the same starting file.
  const markdown = await (await page.request.get(`${projectPath}/handoff.md`)).text();
  expect(markdown).toContain('```dotenv\nCONTACT_FORM_ENDPOINT=\nNEXT_PUBLIC_SITE_URL=\n```');

  // On the project list it needs attention for the same reason.
  await page.goto('/clients');
  await expect(page.getByTestId('project-row').filter({ hasText: projectName }).getByTestId('status-reasons')).toHaveText('no .env.example: 2 vars undeclared');
});

test('GitHub App setup page: signed out, sign in and come back; a repo link pre-fills the new project', async ({ page }) => {
  await page.goto('/github/installed');
  await expect(page.getByTestId('installed-signed-out')).toContainText('Sign in to deployhealth with the GitHub account you installed it with');
  await page.getByRole('link', { name: 'Sign in and come back' }).click();
  await expect(page).toHaveURL(/\/login\?next=%2Fgithub%2Finstalled$/);
  // Signing in here (the dev login under `next dev`) can't be clicked on a production build: the
  // session is added instead, and /login?next= sends the now signed-in user back.
  await addDevSession(page);
  await page.reload();
  await expect(page).toHaveURL(/\/github\/installed$/);
  await expect(page.getByTestId('current-user')).toHaveText('dev');
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
  await signInAsDev(page);
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
  await expect(page).toHaveURL(/\/projects\/new\?client=/);
  await expect(page.getByLabel('Client')).toHaveValue(/[0-9a-f-]{36}/);
  const projectName = `smoke-${suffix}`;
  const projectPath = await createProject(page, { name: projectName, repo: 'acme/smoke' });
  // Creating a project shows no token: pull request checks need none. The Action's is made in settings.
  await expect(page.getByTestId('new-token')).toHaveCount(0);
  const token = await createToken(page, projectPath);
  await expect(page.getByTestId('pr-checks-option')).toContainText('No token, no secret, no variable.');
  await expect(page.getByTestId('deploy-history-steps')).toContainText('Secrets tab → New repository secret, named DEPLOYHEALTH_TOKEN');
  // The reveal gives the Action's workflow first, then the pinned CLI workflow for any other CI.
  const reveal = (await page.getByTestId('deploy-history-steps').textContent()) ?? '';
  expect(reveal.indexOf('uses: Utsav-mishra-25/deployhealth-action@v1')).toBeGreaterThan(-1);
  expect(reveal.indexOf('uses: Utsav-mishra-25/deployhealth-action@v1')).toBeLessThan(reveal.indexOf('From any other CI'));
  expect(reveal.indexOf('From any other CI')).toBeLessThan(reveal.indexOf('npx --yes deployhealth-scan@'));
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

  await page.goto(projectPath);
  await expect(page.getByRole('heading', { name: projectName })).toBeVisible();
  await expect(page).toHaveTitle(`${projectName} · deployhealth`);
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(clientName);
  await expect(page.getByRole('cell', { name: 'src/server.ts:4' })).toBeVisible();
  // A real project's commit links to GitHub; its only deploy is the first scan.
  const firstDeploy = page.getByRole('region', { name: 'Deploys' }).getByTestId('deploy-row');
  await expect(firstDeploy.getByTestId('commit-link')).toHaveAttribute('href', 'https://github.com/acme/smoke/commit/0123456789abcdef0123456789abcdef01234567');
  await expect(firstDeploy.getByTestId('deploy-change')).toHaveText('first scan');
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
  // The Action's workflow first, then the pinned CLI workflow under "From any other CI", then the local run.
  const deployHistory = page.getByRole('region', { name: 'Optional: deploy history (GitHub Action)' });
  await expect(deployHistory.locator('pre')).toHaveText([
    /uses: Utsav-mishra-25\/deployhealth-action@v1[\s\S]*url: "http:\/\/localhost:\d+"/,
    /npx --yes deployhealth-scan@\d+\.\d+\.\d+ \\\n\s+--url "http:\/\/localhost:\d+"/,
    /^npx --yes deployhealth-scan@\d+\.\d+\.\d+ --dry-run$/,
  ]);
  await expect(deployHistory.locator('span.font-mono')).toHaveText(['.github/workflows/deployhealth.yml', '.github/workflows/deployhealth.yml', 'shell']);
  await expect(deployHistory.getByRole('heading', { level: 4 })).toHaveText(['From any other CI']);
  // Setup order: pull request checks (the App), then the optional Action, then client and alerts.
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(['Pull request checks (GitHub App)', 'Optional: deploy history (GitHub Action)', 'Client, alerts & handoff']);
  await expect(page.getByTestId('secret-steps')).toContainText('In acme/smoke: Settings → Secrets and variables → Actions → Secrets tab');
  await expect(page.getByTestId('secret-steps')).toContainText('Not a Variable');
  await expect(page.getByText(token)).toHaveCount(0);

  // The GitHub App: install link, status, and the mode.
  await expect(page.getByTestId('install-github-app')).toHaveAttribute('href', `https://github.com/apps/deployhealth/installations/new?state=settings.${projectPath.split('/').at(-1)}`);
  await expect(page.getByTestId('github-app-status')).toHaveText("The GitHub App isn't installed on acme/smoke from your GitHub account.");
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
  const summary = await page.getByTestId('report-summary').textContent();
  expect(summary).toMatch(/^(So far in|In) [A-Z][a-z]+, /);
  expect(summary).toContain(clientName);
  expect(summary).not.toContain('LOG_LEVEL');
  await expect(page.getByTestId('prepared-by')).toHaveText(/^Prepared by .+/);
  const preparedBy = await page.getByTestId('prepared-by').textContent();
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
  // The same summary and preparer as the signed-in report; no commit links anywhere on it.
  await expect(shared.getByTestId('report-summary')).toHaveText(summary!);
  await expect(shared.getByTestId('prepared-by')).toHaveText(preparedBy!);
  await expect(shared.getByTestId('report-summary')).not.toContainText(/LOG_LEVEL|0123456/);
  await expect(shared.locator('a[href*="/commit/"], a[href*="github.com"]')).toHaveCount(0);
  // A shared report is for the client: the logo, not the site's navigation, and a footer with
  // Privacy and Terms only.
  await expect(shared.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  await expect(shared.getByRole('navigation', { name: 'Footer' }).getByRole('link')).toHaveText(['Privacy', 'Terms']);
  const tampered = await shared.goto(`${shareUrl.slice(0, -1)}${shareUrl.endsWith('A') ? 'B' : 'A'}`);
  expect(tampered?.status()).toBe(404);
  await stranger.close();
});

test("a client page's project rows: the same status and reasons as /clients", async ({ page }) => {
  await signInAsDev(page);
  const suffix = Date.now();
  await page.goto('/clients/new');
  await page.getByLabel('Client name').fill(`Reasons Client ${suffix}`);
  await page.getByRole('button', { name: 'Create client' }).click();
  await expect(page.getByRole('heading', { name: `Reasons Client ${suffix}` })).toBeVisible();
  const clientPath = new URL(page.url()).pathname;
  await page.getByRole('link', { name: 'Add project' }).click();
  await expect(page).toHaveURL(/\/projects\/new\?client=/);
  await expect(page.getByLabel('Client')).toHaveValue(/[0-9a-f-]{36}/);
  // No scan and no pull request check: "Not set up", with the reason the user's App coverage gives.
  await createProject(page, { name: `reasons-${suffix}`, repo: `acme/reasons-${suffix}` });

  const row = (p: typeof page) => p.getByTestId('project-row').filter({ hasText: `reasons-${suffix}` });
  await page.goto('/clients');
  const status = await row(page).getByTestId('project-status').textContent();
  const reasons = await row(page).getByTestId('status-reasons').textContent();
  expect(status).toBe('Not set up');
  expect(reasons).toMatch(/^(GitHub App not installed on this repo|Waiting for the first pull request check)$/);
  await page.goto(clientPath);
  await expect(row(page).getByTestId('project-status')).toHaveText(status!);
  await expect(row(page).getByTestId('status-reasons')).toHaveText(reasons!);
});

test('account page: export downloads the signed-in user\'s data as JSON, without tokens; the dev user can\'t delete itself', async ({ page }) => {
  // Signed out, the account page and the export send you to sign in.
  await page.goto('/account');
  await expect(page).toHaveURL(/\/login/);

  await signInAsDev(page);
  const suffix = Date.now();
  const projectPath = await createProject(page, { name: `export-${suffix}`, repo: 'acme/export' });
  const token = await createToken(page, projectPath);

  // Signed in, the header links to the account page.
  await page.getByRole('banner').getByRole('link', { name: 'Account' }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole('heading', { name: 'Account', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Export your data' })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByTestId('export-data').click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^deployhealth-export-\d{4}-\d{2}-\d{2}\.json$/);
  const text = await readFile((await file.path())!, 'utf8');
  const data = JSON.parse(text) as { format: string; projects: Array<{ name: string }> };
  expect(data.format).toBe('deployhealth-export/1');
  expect(data.projects.map((p) => p.name)).toContain(`export-${suffix}`);
  expect(text).not.toContain(token);
  expect(text).not.toMatch(/dh_[A-Za-z0-9_-]{8}/);

  // The dev user is refused, like in the operator's delete-user: the section says so, with no form.
  await expect(page.getByRole('heading', { name: 'Delete your account' })).toBeVisible();
  await expect(page.getByText("This account can't be deleted here: it's the local dev user.")).toBeVisible();
  await expect(page.getByTestId('delete-account')).toHaveCount(0);
});

test('the old CLI download is still served, marked deprecated', async ({ request }) => {
  const response = await request.get('/deployhealth-scan.mjs');
  expect(response.status()).toBe(200);
  expect(response.headers()['deprecation']).toBe('@1790640000');
  expect(response.headers()['link']).toMatch(/#deprecated-downloading-the-cli-from-your-instance>; rel="deprecation"$/);
  expect(await response.text()).toMatch(/^#!\/usr\/bin\/env node\n/);
});

test('docs: linked from the landing page and the footer, one page per stack, indexed, with what each example reports', async ({ page }) => {
  // The links are checked by their target, then followed with goto, which waits for the page.
  await page.goto('/');
  await expect(page.getByTestId('landing').getByRole('link', { name: /^Docs/ })).toHaveAttribute('href', '/docs');
  await expect(page.getByRole('navigation', { name: 'Footer' }).getByRole('link', { name: 'Docs' })).toHaveAttribute('href', '/docs');
  await page.goto('/docs');
  await expect(page).toHaveTitle('Docs: catch missing env vars early · deployhealth');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/docs$/);
  await expect(page.locator('meta[name="robots"]')).toHaveCount(0);

  await expect(page.getByRole('link', { name: /^Laravel/ })).toHaveAttribute('href', '/docs/laravel');
  await page.goto('/docs/laravel');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('How to catch a missing env var in Laravel before it reaches production');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/docs\/laravel$/);
  const reads = page.locator('[data-example="laravel-reads"]').getByTestId('docs-result');
  await expect(reads).toContainText('STRIPE_WEBHOOK_SECRET config/services.php:7 · required');
  await expect(reads).toContainText('MISSING MAPS_API_KEY, STRIPE_WEBHOOK_SECRET');
  await expect(page.getByText('npx -y deployhealth-scan --dry-run', { exact: true })).toBeVisible();

  expect((await page.request.get('/docs/django')).status()).toBe(404);
});

test('security: public page linked from the footer, and security.txt', async ({ page, request }) => {
  await page.goto('/login');
  // Footer links are checked by their target and followed with goto, which waits for the page.
  await expect(page.getByRole('navigation', { name: 'Footer' }).getByRole('link', { name: 'Security' })).toHaveAttribute('href', '/security');
  await page.goto('/security');
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
  // Status: STATUS_PAGE_URL (set for this run in playwright.config.ts); hidden when unset (test/status-link.test.ts).
  await expect(footer.getByRole('link')).toHaveText(['Docs', 'Pricing', 'Security', 'Privacy', 'Terms', 'Status', 'Source on GitHub']);
  await expect(footer.getByRole('link', { name: 'Status' })).toHaveAttribute('href', 'https://status.deployhealth.example/');
  await expect(footer.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy');
  await expect(footer.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms');
  await page.goto('/privacy');
  await expect(page.getByTestId('privacy')).toContainText('Utsav Mishra (India)');
  await expect(page.getByTestId('privacy')).toContainText('even if it is private on GitHub');
  await expect(page.getByTestId('last-updated')).toHaveText(/^Last updated: \d{1,2} [A-Z][a-z]+ \d{4}$/);
  await page.goto('/terms');
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
