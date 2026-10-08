// `pnpm --filter @deployhealth/db delete-user --login <login> [--confirm]`, or in production
// `node packages/db/dist/delete-user.js …` (docs/deploy-railway.md, "Delete a user on request").
// Without --confirm it only prints counts. Prints logins, ids and counts only.
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createDb } from './client';
import { DELETION_TABLES, deleteUser, planUserDeletion, UserDeletionError, type UserDeletion, type UserSelector } from './delete-user';

export const UNINSTALL_REMINDER =
  'Ask them to uninstall the deployhealth GitHub App on GitHub (Settings → Applications → Installed GitHub Apps, ' +
  "and on any organization they installed it on): deployhealth can't remove it for them.";

/** The selector from the command line, or an error message. */
export function parseCommand(argv: readonly string[]): { selector: UserSelector; confirm: boolean } | { error: string } {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { login: { type: 'string' }, 'github-id': { type: 'string' }, confirm: { type: 'boolean', default: false } },
    }));
  } catch (error) {
    return { error: (error as Error).message };
  }
  const { login, 'github-id': githubId, confirm } = values;
  if ((login === undefined) === (githubId === undefined)) return { error: 'Give exactly one of --login <login> or --github-id <id>.' };
  if (githubId !== undefined) {
    if (!/^-?\d{1,18}$/.test(githubId)) return { error: '--github-id must be a number.' };
    return { selector: { githubId: Number(githubId) }, confirm: confirm === true };
  }
  if (!login!.trim()) return { error: '--login must not be empty.' };
  return { selector: { login: login!.trim() }, confirm: confirm === true };
}

/** The counts table, one table per line; installations also by account type (counts only). */
export function formatCounts({ user, counts, installationAccounts }: UserDeletion, heading: string): string {
  const width = Math.max(...DELETION_TABLES.map((t) => t.length));
  const accounts = ` (${installationAccounts.user} on a user account, ${installationAccounts.organization} on an organization)`;
  return [
    `User "${user.login}" (GitHub id ${user.githubId})`,
    heading,
    ...DELETION_TABLES.map((table) => `  ${table.padEnd(width)}  ${counts[table]}${table === 'installations' && counts[table] > 0 ? accounts : ''}`),
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
    if (!command.confirm) {
      console.log(formatCounts(await planUserDeletion(handle.db, command.selector), 'Would delete:'));
      console.log('Dry run: nothing was deleted. Run again with --confirm to delete, in one transaction.');
    } else {
      console.log(formatCounts(await deleteUser(handle.db, command.selector), 'Deleted, in one transaction:'));
    }
    console.log(UNINSTALL_REMINDER);
    return 0;
  } catch (error) {
    if (!(error instanceof UserDeletionError)) throw error;
    console.error(error.message);
    return 1;
  } finally {
    await handle.close();
  }
}

// Run only when executed (tsx or dist/delete-user.js), not when a test imports the helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
