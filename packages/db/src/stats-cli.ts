// `pnpm --filter @deployhealth/db stats [--exclude-login <login> ...]`, or in production
// `node packages/db/dist/stats.js …` (docs/deploy-railway.md, "Check usage"). Read-only: one
// READ ONLY transaction. Prints counts only, never names, logins or repository names.
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createDb } from './client';
import { usageStats, type CreatedCounts, type UsageStats } from './stats';

/** The logins to leave out, or an error message. */
export function parseCommand(argv: readonly string[]): { excludeLogins: string[] } | { error: string } {
  let values;
  try {
    ({ values } = parseArgs({ args: [...argv], options: { 'exclude-login': { type: 'string', multiple: true } } }));
  } catch (error) {
    return { error: (error as Error).message };
  }
  const logins = values['exclude-login'] ?? [];
  if (logins.some((l) => !l.trim())) return { error: '--exclude-login must not be empty.' };
  return { excludeLogins: logins.map((l) => l.trim()) };
}

/** The report: one row per count, created totals with their last 7 and 30 days. */
export function formatStats(stats: UsageStats, excludeLoginsGiven: number): string {
  const row = (label: string, value: number | string, rest = '') => `${label.padEnd(34)}${String(value).padStart(6)}${rest}`;
  const created = (label: string, c: CreatedCounts) => row(label, c.total, `${String(c.last7Days).padStart(13)}${String(c.last30Days).padStart(14)}`);
  const excluded =
    excludeLoginsGiven === 0
      ? 'Left out: the demo and dev users.'
      : `Left out: the demo and dev users, and ${stats.excludedByLogin} ${stats.excludedByLogin === 1 ? 'user' : 'users'} matching ${excludeLoginsGiven} --exclude-login ${excludeLoginsGiven === 1 ? 'value' : 'values'}.`;
  return [
    `${''.padEnd(34)}${'total'.padStart(6)}${'last 7 days'.padStart(13)}${'last 30 days'.padStart(14)}`,
    created('users', stats.users),
    created('GitHub App installations', stats.installations),
    row('  on a user account', stats.installations.userAccounts),
    row('  on an organization', stats.installations.organizations),
    created('projects', stats.projects),
    '',
    row('weekly active projects', stats.weeklyActiveProjects, '  (a scan or pull request check in the last 7 days)'),
    row('scans, last 7 days', stats.scansLast7Days),
    row('pull request checks, last 7 days', stats.pullRequestChecksLast7Days),
    '',
    excluded,
  ].join('\n');
}

async function main(): Promise<number> {
  const command = parseCommand(process.argv.slice(2));
  if ('error' in command) {
    console.error(command.error);
    return 2;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    return 1;
  }
  const handle = createDb(url, { max: 1 });
  try {
    console.log(formatStats(await usageStats(handle.db, { excludeLogins: command.excludeLogins }), command.excludeLogins.length));
    return 0;
  } finally {
    await handle.close();
  }
}

// Run only when executed (tsx or dist/stats.js), not when a test imports the helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
