import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { encode } from 'next-auth/jwt';
import { DEV_SESSION_FILE, SESSION_COOKIE } from './session';

/**
 * Reset the demo user's data (the seed only touches the demo user), then sign the dev user in the
 * way a production build allows: the dev login is never registered there, so this mints the
 * Auth.js session cookie the `dev` provider would have produced (same claims as auth.ts's jwt
 * callback), signed with the server's AUTH_SECRET. Specs load it through session.ts.
 */
export default async function globalSetup(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const secret = process.env.AUTH_SECRET;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set (apps/web/.env.local)');
  if (!secret) throw new Error('AUTH_SECRET is not set (apps/web/.env.local)');
  execFileSync('pnpm', ['--filter', '@deployhealth/db', 'seed'], { stdio: 'inherit', env: process.env });

  // ensureDevUser, the function the dev provider calls, run through the db package's tsx like the
  // seed (Playwright's loader can't import the package: its migrations import JSON).
  const script = [
    "import { createDb } from './src/client.ts';",
    "import { ensureDevUser } from './src/demo.ts';",
    'const handle = createDb(process.env.DATABASE_URL, { max: 1 });',
    'try { const u = await ensureDevUser(handle.db); console.log(JSON.stringify({ id: u.id, name: u.name, email: u.email, image: u.avatarUrl })); }',
    'finally { await handle.close(); }',
  ].join('\n');
  const output = execFileSync('pnpm', ['--silent', '--filter', '@deployhealth/db', 'exec', 'node', '--import', 'tsx', '--input-type=module', '-e', script], {
    env: process.env,
    encoding: 'utf8',
  });
  const user = JSON.parse(output.trim().split('\n').at(-1)!) as { id: string; name: string | null; email: string | null; image: string | null };

  const value = await encode({
    secret,
    // Auth.js salts the JWE with the cookie's name.
    salt: SESSION_COOKIE,
    token: { sub: user.id, name: user.name, email: user.email, picture: user.image, userId: user.id, login: 'dev' },
  });
  mkdirSync(new URL('.', DEV_SESSION_FILE), { recursive: true });
  writeFileSync(DEV_SESSION_FILE, JSON.stringify({ name: SESSION_COOKIE, value }));
}
