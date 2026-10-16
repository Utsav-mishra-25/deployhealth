import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { E2E_WEBHOOK_SECRET } from './webhook-secret';


/** POST a signed GitHub webhook delivery to the e2e server. */
export async function sendWebhook(request: APIRequestContext, event: string, payload: object): Promise<number> {
  const body = JSON.stringify(payload);
  const response = await request.post('/api/github/webhook', {
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': randomUUID(),
      'x-hub-signature-256': `sha256=${createHmac('sha256', E2E_WEBHOOK_SECRET).update(body).digest('hex')}`,
    },
    data: body,
  });
  return response.status();
}

/**
 * Empties the dev account (its projects, clients and installations; the user row stays) through
 * the db package's `resetDevUser`, which never touches the demo or any other user
 * (packages/db/test/dev-reset.test.ts). Same database as global setup.
 */
export function resetDevUser(): void {
  const script = [
    "import { createDb } from './src/client.ts';",
    "import { resetDevUser } from './src/dev-reset.ts';",
    'const handle = createDb(process.env.DATABASE_URL, { max: 1 });',
    'try { console.log(JSON.stringify(await resetDevUser(handle.db))); } finally { await handle.close(); }',
  ].join('\n');
  execFileSync('pnpm', ['--silent', '--filter', '@deployhealth/db', 'exec', 'node', '--import', 'tsx', '--input-type=module', '-e', script], {
    env: process.env,
    encoding: 'utf8',
  });
}

/**
 * Creates a project from /projects/new (or the page it's on) and returns its path. The form picks
 * from the App's repositories when there are some: "Another repository…" types this one instead.
 */
export async function createProject(page: Page, { name, repo }: { name: string; repo: string }): Promise<string> {
  if (!/\/projects\/new/.test(page.url())) await page.goto('/projects/new');
  const picker = page.getByTestId('repo-picker');
  if (await picker.count()) await picker.selectOption({ label: 'Another repository…' });
  await page.getByRole('textbox', { name: /owner\/repo/ }).fill(repo);
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}\?created=1$/);
  return new URL(page.url()).pathname;
}

/** The Action's token, created (or replaced) in the project's settings, where it appears once. */
export async function createToken(page: Page, projectPath: string): Promise<string> {
  await page.goto(`${projectPath}/settings`);
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: /^(Create|Regenerate) token$/ }).click();
  const token = (await page.getByTestId('new-token').textContent())?.trim() ?? '';
  expect(token).toMatch(/^dh_[A-Za-z0-9_-]{43}$/);
  return token;
}

/** WCAG 2.x A and AA rules; a serious or critical violation fails the page. Navigates unless `path` is null. */
export async function expectAccessible(page: Page, path: string | null, status = 200) {
  if (path !== null) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(status);
  }
  await page.waitForLoadState('networkidle');
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const blocking = violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact}): ${v.help}\n${v.nodes.map((n) => `    ${n.target.join(' ')}`).join('\n')}`);
  expect.soft(blocking, `${path ?? page.url()}\n${blocking.join('\n')}`).toEqual([]);
}

/** The page never scrolls sideways at the current viewport. Navigates unless `path` is null. */
export async function expectNoSidewaysScroll(page: Page, path: string | null, status = 200) {
  if (path !== null) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(status);
  }
  await page.waitForLoadState('networkidle');
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `${path ?? page.url()} is ${scrollWidth}px wide at ${clientWidth}px`).toBeLessThanOrEqual(clientWidth);
}

/** axe at the current size, then no sideways scroll at 375 px, on the page as it is now. */
export async function expectFirstRunScreen(page: Page) {
  await expectAccessible(page, null);
  const size = page.viewportSize();
  await page.setViewportSize({ width: 375, height: 812 });
  await expectNoSidewaysScroll(page, null);
  if (size) await page.setViewportSize(size);
}
