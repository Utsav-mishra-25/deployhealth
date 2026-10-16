import { expect, type Page, test } from '@playwright/test';
import { createProject, createToken, expectFirstRunScreen, resetDevUser, sendWebhook } from './helpers';
import { signInAsDev } from './session';

// The first run on a fresh account, as a new user walks it: the checklist on an empty home, a
// project, the GitHub App install round trip (GitHub's signed webhook, then its redirect to the
// Setup URL with the install link's state), the "App doesn't cover this repo" case, a site, and
// the optional Action. Every first-run screen also gets axe and a 375 px check.

const DEMO_STOREFRONT = '0d3e0000-0000-4000-8000-000000000001'; // the demo user's project, not the dev user's
const DEV_GITHUB_ID = -2;
const INSTALL = 'https://github.com/apps/deployhealth/installations/new';

/** GitHub's installation.created delivery, sent by the dev user's GitHub id. */
function installed(id: number, account: string, selection: 'all' | 'selected', repos: string[]) {
  return {
    action: 'created',
    installation: { id, account: { login: account, type: 'User' }, repository_selection: selection },
    sender: { id: DEV_GITHUB_ID },
    repositories: repos.map((full_name) => ({ full_name })),
  };
}

async function stepsDone(page: Page) {
  const steps = page.getByTestId('onboarding-checklist').locator('[data-testid^="step-"]');
  return steps.evaluateAll((els) => els.map((el) => `${el.getAttribute('data-testid')}=${el.getAttribute('data-done')}`));
}

// The dev account starts empty and is left empty: the other specs keep their own data, and the
// GitHub App setup test in smoke.spec.ts expects no installation. Only the dev user's rows go.
test.beforeAll(() => resetDevUser());
test.afterAll(() => resetDevUser());

test('first run: checklist, project, App install round trip, coverage, a site and the optional Action', async ({ page }) => {
  await signInAsDev(page);

  // 1. Nothing done: the checklist in the landing page's order; no client offered yet.
  await expect(page.getByTestId('onboarding-checklist')).toBeVisible();
  expect(await stepsDone(page)).toEqual(['step-app=false', 'step-project=false', 'step-site=false', 'step-action=false']);
  await expect(page.getByTestId('onboarding-checklist').getByRole('heading', { level: 3 })).toHaveText([
    '1.Install the GitHub App',
    '2.Add a project for a repo',
    '3.Add a site (a URL to watch)',
  ]);
  await expect(page.getByTestId('step-action').locator('summary')).toHaveText('Optional: deploy history with the Action');
  await expect(page.getByTestId('step-app').getByRole('link', { name: 'Install the GitHub App' })).toHaveAttribute('href', `${INSTALL}?state=clients`);
  await expect(page.getByTestId('step-action').getByRole('link', { name: 'Set up the Action' })).toBeHidden(); // collapsed
  await expect(page.getByTestId('projects-empty')).toBeVisible();
  await expect(page.getByRole('link', { name: 'New client' })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Projects');
  await expectFirstRunScreen(page);

  // 2. A project, before the App: no client field, a plain owner/repo field that says the App
  // isn't installed yet, no token anywhere.
  await page.getByTestId('step-project').getByRole('link', { name: 'Add a project' }).click();
  await expect(page).toHaveURL(/\/projects\/new$/);
  await expect(page.getByTestId('install-first')).toBeVisible();
  await expect(page.getByLabel(/^Client/)).toHaveCount(0);
  await expectFirstRunScreen(page);
  await page.getByRole('textbox', { name: /owner\/repo/ }).fill('utsav-test/dh-laravel-test');
  await expect(page.getByLabel('Project name')).toHaveValue('dh-laravel-test');
  await expect(page.getByTestId('repo-coverage')).toHaveAttribute('data-state', 'not-installed');
  const projectPath = await createProject(page, { name: 'dh-laravel-test', repo: 'utsav-test/dh-laravel-test' });
  const projectId = projectPath.split('/').at(-1)!;
  await expect(page.getByTestId('new-token')).toHaveCount(0);

  // 3. The project before any data: what shows up and when, instead of empty tables.
  await expect(page.getByTestId('project-created')).toContainText('Added dh-laravel-test.');
  const panel = page.getByTestId('project-getting-started');
  await expect(panel.getByTestId('getting-started-prs').getByTestId('repo-coverage')).toHaveAttribute('data-state', 'not-installed');
  await expect(panel.getByTestId('getting-started-sites')).toContainText('Add a site (a URL to watch): deployhealth requests it on a schedule');
  await expect(panel.getByTestId('getting-started-action')).toContainText('Add the Action for deploy history');
  await expect(page.getByText('No scans yet')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Settings', exact: true })).toBeVisible();
  await expectFirstRunScreen(page);

  // 4. Settings in setup order, the install link coming back here, and the token only on request.
  await page.goto(`${projectPath}/settings`);
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(['Pull request checks (GitHub App)', 'Optional: deploy history (GitHub Action)', 'Client, alerts & handoff']);
  await expect(page.getByTestId('install-github-app')).toHaveAttribute('href', `${INSTALL}?state=settings.${projectId}`);
  await expect(page.getByTestId('mode-pending')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create token' })).toBeVisible();
  await expect(page.getByTestId('new-token')).toHaveCount(0);
  await expectFirstRunScreen(page);

  // 5. The install round trip: GitHub delivers the installation (selected repositories that leave
  // this project's out), then sends the browser to the Setup URL with the state: back on settings.
  expect(await sendWebhook(page.request, 'installation', installed(424242, 'utsav-test', 'selected', ['utsav-test/storefront', 'utsav-test/blog']))).toBe(202);
  await page.goto(`/github/installed?installation_id=424242&setup_action=install&state=settings.${projectId}`);
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/settings\\?app=installed$`));
  await expect(page.getByTestId('install-confirmation')).toHaveText('GitHub App installed on utsav-test (2 repositories).');
  // The "Checks 0" case: installed on the account, but not on this repository.
  const notice = page.getByTestId('repo-coverage');
  await expect(notice).toHaveAttribute('data-state', 'not-selected');
  await expect(notice).toContainText('The GitHub App is installed on utsav-test, but not on utsav-test/dh-laravel-test');
  await expect(notice.getByRole('link', { name: "the App's settings for utsav-test" })).toHaveAttribute('href', 'https://github.com/settings/installations/424242');
  await expect(page.getByTestId('install-github-app')).toHaveCount(0);
  await expectFirstRunScreen(page);

  // The other return steps land where they started, each with the one-line confirmation.
  await page.goto('/github/installed?state=new-project');
  await expect(page).toHaveURL(/\/projects\/new\?app=installed$/);
  await expect(page.getByTestId('install-confirmation')).toBeVisible();
  await page.goto('/github/installed?state=clients');
  await expect(page).toHaveURL(/\/clients\?app=installed$/);
  await expect(page.getByTestId('install-confirmation')).toBeVisible();

  // A state outside the allowlist shows the generic page, no redirect; another user's project 404s.
  for (const state of ['https%3A%2F%2Fevil.example', '%2Fclients', 'settings.not-a-uuid', 'Clients']) {
    await page.goto(`/github/installed?state=${state}`);
    await expect(page, state).toHaveURL(new RegExp(`/github/installed\\?state=${state.replace(/[.%]/g, (c) => `\\${c}`)}$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('GitHub App');
  }
  expect((await page.goto(`/github/installed?state=settings.${DEMO_STOREFRONT}`))?.status()).toBe(404);
  expect((await page.goto('/github/installed?state=settings.00000000-0000-4000-8000-000000000000'))?.status()).toBe(404);

  // The generic page lists the project the App doesn't cover, with the fix.
  await page.goto('/github/installed');
  await expect(page.getByTestId('not-covered')).toContainText('dh-laravel-test');
  await expect(page.getByTestId('not-covered').getByTestId('repo-coverage')).toHaveAttribute('data-state', 'not-selected');
  await expect(page.getByTestId('setup-order')).toBeVisible();
  await expectFirstRunScreen(page);

  // 6. Home: step 1 done, step 2 names the uncovered project and links to the notice, and the row says why.
  await page.goto('/clients');
  expect(await stepsDone(page)).toEqual(['step-app=true', 'step-project=true', 'step-site=false', 'step-action=false']);
  await expect(page.getByTestId('checklist-uncovered')).toHaveText("1 project isn't covered by the App: dh-laravel-test. How to add it");
  await expect(page.getByTestId('checklist-uncovered').getByRole('link')).toHaveAttribute('href', '/github/installed#not-covered');
  await expect(page.getByTestId('checklist-suggestions')).toContainText('Add a project for utsav-test/blog');
  const row = page.getByTestId('project-row').filter({ hasText: 'dh-laravel-test' });
  await expect(row.getByTestId('status-reasons')).toHaveText('GitHub App not installed on this repo');
  await expect(page.getByTestId('client-offer')).toBeVisible();
  await expectFirstRunScreen(page);

  // Adding the repository on GitHub (Repository access) fixes it.
  expect(
    await sendWebhook(page.request, 'installation_repositories', {
      action: 'added',
      installation: { id: 424242 },
      repository_selection: 'selected',
      repositories_added: [{ full_name: 'utsav-test/dh-laravel-test' }],
      repositories_removed: [],
    }),
  ).toBe(202);
  await page.reload();
  await expect(page.getByTestId('checklist-uncovered')).toHaveCount(0);
  await expect(row.getByTestId('status-reasons')).toHaveText('Waiting for the first pull request check');

  // An "All repositories" installation covers a repository it has no row for.
  await createProject(page, { name: 'everything', repo: 'utsav-all/site' });
  await page.goto('/clients');
  await expect(page.getByTestId('project-row').filter({ hasText: 'everything' }).getByTestId('status-reasons')).toHaveText('GitHub App not installed on this repo');
  expect(await sendWebhook(page.request, 'installation', installed(434343, 'utsav-all', 'all', []))).toBe(202);
  await page.reload();
  await expect(page.getByTestId('project-row').filter({ hasText: 'everything' }).getByTestId('status-reasons')).toHaveText('Waiting for the first pull request check');
  await expect(page.getByTestId('checklist-uncovered')).toHaveCount(0);

  // 7. The picker: the App's repositories without a project, the name filled in, and now (after
  // the first project) the optional client.
  await page.goto('/projects/new');
  await expect(page.getByTestId('repo-picker')).toHaveValue('utsav-test/blog');
  await expect(page.getByLabel('Project name')).toHaveValue('blog');
  await expect(page.getByLabel(/^Client/)).toBeVisible();
  await page.getByTestId('repo-picker').selectOption('utsav-test/storefront');
  await expect(page.getByLabel('Project name')).toHaveValue('storefront');
  await expect(page.getByTestId('repo-coverage')).toHaveCount(0); // covered: nothing to warn about
  await expectFirstRunScreen(page);

  // 8. A site, from the checklist: then the three steps are done and the checklist goes away.
  await page.goto('/clients');
  await page.getByTestId('step-site').getByRole('link', { name: 'Add a site' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}#add-endpoint$/);
  const addForm = page.locator('#add-endpoint');
  await addForm.getByLabel('URL').fill('https://example.com/health');
  await addForm.getByRole('button', { name: 'Add endpoint' }).click();
  await expect(page.getByTestId('endpoint-card')).toHaveCount(1);
  await expect(page.getByTestId('endpoint-card')).toContainText('No checks yet: the first one runs within 5 minutes.');
  await page.goto('/clients');
  await expect(page.getByTestId('onboarding-checklist')).toHaveCount(0);
  await expect(page.getByTestId('client-offer')).toBeVisible();
  await expectFirstRunScreen(page);

  // 9. Optional: the Action. The token appears once, in settings; a reported scan fills the page.
  const token = await createToken(page, projectPath);
  await expect(page.getByText(token, { exact: true })).toHaveCount(1);
  const scan = await page.request.post('/api/ingest/scan', {
    headers: { authorization: `Bearer ${token}` },
    data: { sha: '0123456789abcdef0123456789abcdef01234567', branch: 'main', timestamp: new Date().toISOString(), findings: [] },
  });
  expect(scan.status()).toBe(201);
  await page.goto(projectPath);
  await expect(page.getByTestId('project-getting-started')).toHaveCount(0);
  await expect(page.getByTestId('findings-legend')).toHaveText(
    'Missing: read in code, but in no env file · Unused: in an env file, never read · Mismatch: .env and .env.example disagree',
  );
  await page.goto(`${projectPath}/settings`);
  await expect(page.getByRole('button', { name: 'Regenerate token' })).toBeVisible();
});
