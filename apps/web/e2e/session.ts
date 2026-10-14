import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * Auth.js's session cookie over plain http (the e2e server is http://localhost): no `__Secure-`
 * prefix, which Auth.js only uses when the request is https. It is also the JWE's salt.
 */
export const SESSION_COOKIE = 'authjs.session-token';

/** Written by global-setup.ts (gitignored). */
export const DEV_SESSION_FILE = new URL('./.auth/dev-session.json', import.meta.url);

/** Adds the dev user's session to the page's browser context, without navigating. */
export async function addDevSession(page: Page): Promise<void> {
  const { name, value } = JSON.parse(readFileSync(DEV_SESSION_FILE, 'utf8')) as { name: string; value: string };
  const url = test.info().project.use.baseURL!;
  await page.context().addCookies([{ name, value, url, httpOnly: true, sameSite: 'Lax' }]);
}

/**
 * Signs in as the dev user, then proves the server accepted the session: /login sends a signed-in
 * user to /clients, and the header names the user. A rejected cookie fails here, never later.
 */
export async function signInAsDev(page: Page): Promise<void> {
  await addDevSession(page);
  await page.goto('/login');
  await expect(page).toHaveURL(/\/clients$/);
  await expect(page.getByTestId('current-user')).toHaveText('dev');
}
