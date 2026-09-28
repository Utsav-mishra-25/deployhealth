import { hashToken } from '@deployhealth/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_GITHUB_ID } from '../src/demo';
import { findProjectByTokenHash, getLatestScan, listDeploys, listProjectsForOwner } from '../src/queries';
import { projects, users } from '../src/schema';
import { DEMO_DEPLOY_COUNT, DEMO_PROJECT, demoDeploys, seed } from '../src/seed';
import { makeUser, openTestDb, truncateAll } from './test-db';

const handle = openTestDb();
const { db } = handle;
const NOW = new Date('2026-09-28T12:00:00Z');

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await handle.close();
});

describe('seed', () => {
  it('creates the demo user, one project and ten scanned deploys', async () => {
    const result = await seed(db, NOW);

    const [user] = await db.select().from(users).where(eq(users.githubId, DEMO_GITHUB_ID));
    expect(user).toMatchObject({ id: result.userId, login: 'demo' });

    const [project] = await listProjectsForOwner(db, result.userId);
    expect(project).toMatchObject({ name: DEMO_PROJECT.name, repoFullName: DEMO_PROJECT.repoFullName });

    const deploys = await listDeploys(db, result.projectId);
    expect(deploys).toHaveLength(DEMO_DEPLOY_COUNT);
    expect(deploys.every((d) => d.scanCount === 1)).toBe(true);
    expect(deploys[0]?.deploy.deployedAt.getTime()).toBeLessThan(NOW.getTime());
    expect(deploys.map((d) => d.deploy.source).filter((s) => s === 'manual')).toHaveLength(1);
  });

  it('ends on a latest deploy with every kind of finding', async () => {
    const result = await seed(db, NOW);
    const [latest] = await listDeploys(db, result.projectId);
    expect(latest?.counts).toEqual({ missing: 2, unused: 2, mismatch: 1 });
    const detail = await getLatestScan(db, result.projectId, latest!.deploy.id);
    expect(detail?.findings.map((f) => `${f.kind}:${f.var_name}`)).toEqual([
      'missing:ANALYTICS_WRITE_KEY',
      'missing:SMTP_PASSWORD',
      'unused:OLD_PAYPAL_CLIENT_ID',
      'unused:S3_REGION',
      'mismatch:NEXT_PUBLIC_CHECKOUT_V2',
    ]);
  });

  it('prints a token that authenticates the demo project', async () => {
    const result = await seed(db, NOW);
    expect(await findProjectByTokenHash(db, hashToken(result.token))).toMatchObject({ id: result.projectId });
  });

  it('is idempotent and leaves other users alone', async () => {
    const other = await makeUser(db);
    await seed(db, NOW);
    const second = await seed(db, NOW);

    expect(await db.select().from(users)).toHaveLength(2);
    expect(await db.select().from(projects)).toHaveLength(1);
    expect(await listDeploys(db, second.projectId)).toHaveLength(DEMO_DEPLOY_COUNT);
    expect((await db.select().from(users).where(eq(users.id, other.id)))[0]).toBeTruthy();
  });

  it('builds deterministic, unique shas in chronological order', () => {
    const deploys = demoDeploys(NOW);
    expect(new Set(deploys.map((d) => d.sha)).size).toBe(DEMO_DEPLOY_COUNT);
    expect(deploys.map((d) => d.sha)).toEqual(demoDeploys(NOW).map((d) => d.sha));
    const times = deploys.map((d) => d.deployedAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});
