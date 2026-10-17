import type { Db } from '@deployhealth/db';
import { describe, expect, it } from 'vitest';
import type { R2Bucket } from '../src/backup/r2';
import { age, parseRestoreArgs, restoreBackup, type RestoreDeps } from '../src/backup/restore';
import { dumpKey, MANIFEST_KEY } from '../src/backup/run';
import { sameDatabase } from '../src/restore-cli';

const NOW = new Date('2026-10-18T16:41:00Z');
const DUMPED = new Date('2026-10-18T03:41:00Z');
const SCRATCH = 'postgres://deployhealth:deployhealth@localhost:5432/deployhealth_restore';
const LIVE = 'postgresql://postgres:livepw@postgres.railway.internal:5432/railway';

function manifest(generatedAt: Date, deletions: Array<{ githubId: number; deletedAt: string }>) {
  return JSON.stringify({ format: 'deployhealth-deletions/1', generatedAt: generatedAt.toISOString(), deletions });
}

function setup(options: { manifest?: string | null; empty?: boolean; live?: Array<{ githubId: number; deletedAt: Date }> } = {}) {
  const events: string[] = [];
  const logs: string[] = [];
  const bucket: R2Bucket = {
    putFile: async () => {},
    putText: async () => {},
    list: async () => [
      { key: dumpKey(new Date('2026-10-11T03:41:00Z')), size: 1024 * 1024, lastModified: NOW },
      { key: dumpKey(DUMPED), size: 3 * 1024 * 1024, lastModified: NOW },
    ],
    delete: async () => {},
    getText: async (key) => (key === MANIFEST_KEY ? (options.manifest === undefined ? manifest(DUMPED, [{ githubId: 7, deletedAt: '2026-10-18T09:00:00.000Z' }]) : options.manifest) : null),
    getToFile: async (key) => void events.push(`download ${key}`),
  };
  let reapplied: { deletions: unknown; dumpedAt: Date } | null = null;
  const deps: RestoreDeps = {
    bucket,
    liveDeletions: options.live ? async () => options.live! : null,
    isLiveDatabase: (url) => sameDatabase(url, LIVE),
    openTarget: async () => ({ db: {} as Db, close: async () => void events.push('close') }),
    isEmpty: async () => options.empty ?? true,
    checkTool: async () => void events.push('checkTool'),
    restore: async (file) => void events.push(`restore ${file.split('/').at(-1)}`),
    reapply: async (_db, deletions, dumpedAt) => {
      reapplied = { deletions, dumpedAt };
      return { considered: deletions.length, deleted: 1, notInDump: 0 };
    },
    rowCounts: async () => ({ 'public.users': 3 }),
    tmpDir: '/tmp/x',
    now: () => NOW,
    log: (m) => logs.push(m),
  };
  return { deps, events, logs, reapplied: () => reapplied };
}

const args = (argv: string[]) => {
  const parsed = parseRestoreArgs(argv);
  if ('error' in parsed || parsed.mode !== 'restore') throw new Error(JSON.stringify(parsed));
  return parsed as typeof parsed & { mode: 'restore' };
};

describe('parseRestoreArgs', () => {
  it('takes one source and --into', () => {
    expect(parseRestoreArgs(['--list'])).toMatchObject({ mode: 'list' });
    expect(parseRestoreArgs(['--latest', '--into', SCRATCH])).toEqual({ mode: 'restore', source: { latest: true }, into: SCRATCH, liveDeletions: false, skipDeletions: false });
    expect(parseRestoreArgs(['--latest'])).toHaveProperty('error');
    expect(parseRestoreArgs(['--latest', '--key', 'k', '--into', SCRATCH])).toHaveProperty('error');
    expect(parseRestoreArgs(['--latest', '--into', SCRATCH, '--live-deletions', '--skip-deletions'])).toHaveProperty('error');
    expect(parseRestoreArgs(['--latest', '--into', SCRATCH, '--yes'])).toHaveProperty('error');
  });
});

describe('restoreBackup', () => {
  it('downloads the newest dump, restores it, and re-applies deletions.json since the dump, saying how old the manifest is', async () => {
    const { deps, events, logs, reapplied } = setup();
    await restoreBackup(args(['--latest', '--into', SCRATCH]), deps);
    expect(events).toEqual(['checkTool', `download ${dumpKey(DUMPED)}`, 'restore 2026-10-18T03-41-00.000Z.dump', 'close']);
    expect(reapplied()).toEqual({ deletions: [{ githubId: 7, deletedAt: new Date('2026-10-18T09:00:00Z') }], dumpedAt: DUMPED });
    expect(logs).toContain('[restore] account deletions from deletions.json from the bucket, written 13 hours ago (2026-10-18T03:41:00.000Z; 1 deletions)');
    expect(logs.some((l) => /Deletions made after deletions.json was written aren't in it/.test(l))).toBe(true);
    expect(logs.at(-1)).toMatch(/public\.users\s+3/);
  });

  it('adds the live database with --live-deletions', async () => {
    const live = [{ githubId: 8, deletedAt: new Date('2026-10-18T15:00:00Z') }];
    const { deps, reapplied, logs } = setup({ live });
    await restoreBackup(args(['--latest', '--into', SCRATCH, '--live-deletions']), deps);
    expect((reapplied()!.deletions as unknown[]).length).toBe(2);
    expect(logs).toContain('[restore] account deletions from the live database (1 deletions)');
  });

  it('refuses to start without any record of deletions, before touching anything', async () => {
    const { deps, events } = setup({ manifest: null });
    await expect(restoreBackup(args(['--latest', '--into', SCRATCH]), deps)).rejects.toThrow(/No record of account deletions to re-apply/);
    expect(events).toEqual([]);
  });

  it('restores without re-applying only when told to, and says never to switch production to it', async () => {
    const { deps, logs, reapplied } = setup({ manifest: null });
    await restoreBackup(args(['--latest', '--into', SCRATCH, '--skip-deletions']), deps);
    expect(reapplied()).toBeNull();
    expect(logs[0]).toMatch(/Never switch production to this database/);
  });

  it('refuses a database that has tables, before downloading', async () => {
    const { deps, events } = setup({ empty: false });
    await expect(restoreBackup(args(['--latest', '--into', SCRATCH]), deps)).rejects.toThrow(/has tables/);
    expect(events).toEqual(['close']);
  });

  it('refuses the live database as the target', async () => {
    const { deps, events } = setup();
    await expect(restoreBackup(args(['--latest', '--into', 'postgresql://other:pw@POSTGRES.railway.internal:5432/railway']), deps)).rejects.toThrow(/is the live database/);
    expect(events).toEqual([]);
  });

  it('takes a downloaded file, its time from its name', async () => {
    const { deps, reapplied } = setup();
    await restoreBackup(args(['--file', '/backups/2026-10-11T03-41-00.000Z.dump', '--into', SCRATCH]), deps);
    expect(reapplied()!.dumpedAt).toEqual(new Date('2026-10-11T03:41:00Z'));
    await expect(restoreBackup(args(['--file', '/backups/latest.dump', '--into', SCRATCH]), setup().deps)).rejects.toThrow(/keep the name it had in the bucket/);
  });

  it('a key that is not in the bucket says so', async () => {
    await expect(restoreBackup(args(['--key', 'deployhealth/nope.dump', '--into', SCRATCH]), setup().deps)).rejects.toThrow(/No dump deployhealth\/nope\.dump/);
  });
});

describe('helpers', () => {
  it('ages read in hours, then days', () => {
    expect(age(13 * 3_600_000)).toBe('13 hours');
    expect(age(3_600_000)).toBe('1 hour');
    expect(age(3.5 * 24 * 3_600_000)).toBe('3.5 days');
  });

  it('sameDatabase compares host, port and name, not credentials', () => {
    expect(sameDatabase(LIVE, 'postgres://x:y@Postgres.Railway.Internal:5432/railway')).toBe(true);
    expect(sameDatabase(LIVE, SCRATCH)).toBe(false);
    expect(sameDatabase('nope', LIVE)).toBe(false);
  });
});
