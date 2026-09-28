import { execFileSync } from 'node:child_process';

/** Reset the demo user's data (the seed only touches the demo user) before the smoke test. */
export default function globalSetup(): void {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set (apps/web/.env.local)');
  execFileSync('pnpm', ['--filter', '@deployhealth/db', 'seed'], { stdio: 'inherit', env: process.env });
}
