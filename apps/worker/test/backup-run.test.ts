import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKUP_RETENTION_WEEKS } from '@deployhealth/db';
import { afterAll, describe, expect, it } from 'vitest';
import type { R2Bucket, R2Object } from '../src/backup/r2';
import { describeBackupError, dumpKey, dumpsNewestFirst, dumpTimeOf, MANIFEST_KEY, runBackup, withRetries, type BackupRunDeps } from '../src/backup/run';

const dir = mkdtempSync(join(tmpdir(), 'deployhealth-backup-run-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const DAY = 24 * 3_600_000;
const NOW = new Date('2026-10-18T03:41:00.000Z');

/** An in-memory bucket; `failPut` makes uploads of dumps fail. */
function memoryBucket(initial: Array<{ key: string; at?: Date; size?: number }> = [], options: { failPut?: boolean } = {}) {
  const objects = new Map<string, R2Object & { text?: string }>();
  for (const o of initial) objects.set(o.key, { key: o.key, size: o.size ?? 10, lastModified: o.at ?? NOW });
  const calls: string[] = [];
  const bucket: R2Bucket = {
    async putFile(key, file) {
      calls.push(`put ${key}`);
      if (options.failPut) throw Object.assign(new Error('R2 PUT failed'), { name: 'R2Error' });
      expect(existsSync(file)).toBe(true);
      objects.set(key, { key, size: 2 * 1024 * 1024, lastModified: NOW });
    },
    async putText(key, text) {
      calls.push(`put ${key}`);
      objects.set(key, { key, size: text.length, lastModified: NOW, text });
    },
    async list(prefix) {
      calls.push(`list ${prefix}`);
      return [...objects.values()].filter((o) => o.key.startsWith(prefix));
    },
    async delete(key) {
      calls.push(`delete ${key}`);
      objects.delete(key);
    },
    async getText(key) {
      return objects.get(key)?.text ?? null;
    },
    async getToFile() {},
  };
  return { bucket, objects, calls };
}

function deps(bucket: R2Bucket, overrides: Partial<BackupRunDeps> = {}) {
  const events: string[] = [];
  const logs: string[] = [];
  const d: BackupRunDeps = {
    bucket,
    now: async () => NOW,
    listDeletions: async () => [{ githubId: 42, deletedAt: new Date('2026-10-10T00:00:00Z') }],
    checkTools: async () => void events.push('checkTools'),
    dump: async (file) => {
      events.push('dump');
      writeFileSync(file, 'PGDMP');
    },
    heartbeat: async () => void events.push('heartbeat'),
    tmpDir: dir,
    log: (m) => logs.push(m),
    ...overrides,
  };
  return { d, events, logs };
}

const weeksAgo = (n: number) => new Date(NOW.getTime() - n * 7 * DAY);

describe('dump keys', () => {
  it('hold the dump time, and read back', () => {
    expect(dumpKey(NOW)).toBe('deployhealth/2026-10-18T03-41-00.000Z.dump');
    expect(dumpTimeOf(dumpKey(NOW))).toEqual(NOW);
    expect(dumpTimeOf('/tmp/2026-10-18T03-41-00.000Z.dump')).toEqual(NOW);
    expect(dumpTimeOf('deployhealth/notes.txt')).toBeNull();
    expect(dumpsNewestFirst([{ key: 'deletions.json', size: 1, lastModified: NOW }])).toEqual([]);
  });
});

describe('runBackup', () => {
  it('uploads deletions.json first, then dumps when there is no dump yet, and writes the heartbeat', async () => {
    const { bucket, objects, calls } = memoryBucket();
    const { d, events } = deps(bucket);
    const result = await runBackup(d);
    expect(calls[0]).toBe(`put ${MANIFEST_KEY}`);
    expect(JSON.parse(objects.get(MANIFEST_KEY)!.text!)).toEqual({
      format: 'deployhealth-deletions/1',
      generatedAt: NOW.toISOString(),
      deletions: [{ githubId: 42, deletedAt: '2026-10-10T00:00:00.000Z' }],
    });
    expect(result).toEqual({ deletions: 1, dumped: dumpKey(NOW), pruned: [] });
    expect(events).toEqual(['checkTools', 'dump', 'heartbeat']);
    // The local dump file is removed once uploaded.
    expect(existsSync(join(dir, '2026-10-18T03-41-00.000Z.dump'))).toBe(false);
  });

  it('skips the dump while the newest is under 6.5 days old, still uploading deletions.json and the heartbeat', async () => {
    const { bucket, calls } = memoryBucket([{ key: dumpKey(new Date(NOW.getTime() - 6 * DAY)) }]);
    const { d, events, logs } = deps(bucket);
    expect((await runBackup(d)).dumped).toBeNull();
    expect(events).toEqual(['heartbeat']);
    expect(calls).toContain(`put ${MANIFEST_KEY}`);
    expect(logs.at(-1)).toMatch(/newest dump is 6\.0 days old/);
  });

  it(`dumps once the newest is 6.5 days old, then keeps the ${BACKUP_RETENTION_WEEKS} newest`, async () => {
    const old = [1, 2, 3, 4, 5].map((n) => ({ key: dumpKey(weeksAgo(n)) }));
    const { bucket, objects } = memoryBucket([...old, { key: 'deployhealth/README.txt' }]);
    const { d } = deps(bucket);
    const result = await runBackup(d);
    expect(result.dumped).toBe(dumpKey(NOW));
    // The new one and the three newest before it stay; weeks 4 and 5 go; non-dumps are never touched.
    expect(result.pruned).toEqual([dumpKey(weeksAgo(4)), dumpKey(weeksAgo(5))]);
    expect(dumpsNewestFirst([...objects.values()]).map((o) => o.key)).toEqual([dumpKey(NOW), dumpKey(weeksAgo(1)), dumpKey(weeksAgo(2)), dumpKey(weeksAgo(3))]);
    expect(objects.has('deployhealth/README.txt')).toBe(true);
  });

  it('never prunes, and writes no heartbeat, when the upload fails', async () => {
    const old = [1, 2, 3, 4, 5].map((n) => ({ key: dumpKey(weeksAgo(n)) }));
    const { bucket, objects, calls } = memoryBucket(old, { failPut: true });
    const { d, events } = deps(bucket);
    await expect(runBackup(d)).rejects.toThrow('R2 PUT failed');
    expect(calls.filter((c) => c.startsWith('delete'))).toEqual([]);
    expect(dumpsNewestFirst([...objects.values()])).toHaveLength(5);
    expect(events).not.toContain('heartbeat');
  });

  it('refuses to dump with a pg_dump older than the server, before dumping', async () => {
    const { bucket } = memoryBucket();
    const { d, events } = deps(bucket, {
      checkTools: async () => {
        throw Object.assign(new Error("pg_dump 16 can't work with a PostgreSQL 18 server: install postgresql-client-18."), { name: 'BackupError' });
      },
    });
    await expect(runBackup(d)).rejects.toThrow(/pg_dump 16/);
    expect(events).toEqual([]);
  });
});

describe('withRetries', () => {
  it('retries twice with backoff, then gives up with the last error', async () => {
    const slept: number[] = [];
    const logs: string[] = [];
    let attempts = 0;
    const run = async () => {
      attempts++;
      throw Object.assign(new Error('boom https://hooks.slack.com/services/T/B/secret'), { code: 'ECONNRESET' });
    };
    await expect(withRetries(run, { sleep: async (ms) => void slept.push(ms), log: (m) => logs.push(m), describe: describeBackupError })).rejects.toThrow('boom');
    expect(attempts).toBe(3);
    expect(slept).toEqual([60_000, 300_000]);
    expect(logs).toEqual([
      '[backup] attempt 1 of 3 failed (Error ECONNRESET); retrying in 60s',
      '[backup] attempt 2 of 3 failed (Error ECONNRESET); retrying in 300s',
    ]);
  });

  it('returns as soon as an attempt succeeds', async () => {
    let attempts = 0;
    const result = await withRetries(async () => (++attempts < 2 ? Promise.reject(new Error('x')) : 'ok'), { sleep: async () => {}, log: () => {}, describe: describeBackupError });
    expect([result, attempts]).toEqual(['ok', 2]);
  });
});
