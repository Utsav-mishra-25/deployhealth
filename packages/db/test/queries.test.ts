import type { FindingRow } from '@deployhealth/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createProject,
  DuplicateProjectNameError,
  findProjectByTokenHash,
  getLatestScan,
  getProjectForOwner,
  getScanVariables,
  listDeploys,
  listProjectsForOwner,
  recordScan,
  rotateProjectToken,
  upsertGithubUser,
} from '../src/queries';
import { makeProject, makeUser, openTestDb, truncateAll } from './test-db';

const handle = openTestDb();
const { db } = handle;

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await handle.close();
});

const FINDINGS: FindingRow[] = [
  { kind: 'missing', var_name: 'API_KEY', file: 'src/b.ts', line: 9, env_file: null },
  { kind: 'missing', var_name: 'API_KEY', file: 'src/a.ts', line: 3, env_file: null },
  { kind: 'mismatch', var_name: 'X', file: '.env', line: 1, env_file: '.env.example' },
  { kind: 'unused', var_name: 'OLD', file: '.env.example', line: 2, env_file: '.env.example' },
];

const at = (iso: string) => new Date(iso);

describe('users', () => {
  it('creates a user on first sign-in and refreshes the profile later', async () => {
    const first = await upsertGithubUser(db, { githubId: 42, login: 'octo', name: 'Octo', email: 'o@x.dev' });
    const second = await upsertGithubUser(db, { githubId: 42, login: 'octo-renamed', avatarUrl: 'https://a/b.png' });
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ login: 'octo-renamed', name: null, email: null, avatarUrl: 'https://a/b.png' });
  });
});

describe('projects', () => {
  it('creates projects and rejects a duplicate name for the same owner', async () => {
    const owner = await makeUser(db);
    const input = { ownerId: owner.id, name: 'shop', repoFullName: 'acme/shop', apiTokenHash: 'h1', apiTokenHint: 'dh_…1' };
    await createProject(db, input);
    await expect(createProject(db, { ...input, apiTokenHash: 'h2' })).rejects.toBeInstanceOf(DuplicateProjectNameError);

    const other = await makeUser(db);
    await expect(createProject(db, { ...input, ownerId: other.id, apiTokenHash: 'h3' })).resolves.toBeTruthy();
  });

  it('only returns a project to its owner', async () => {
    const owner = await makeUser(db);
    const stranger = await makeUser(db);
    const project = await makeProject(db, owner.id);
    expect(await getProjectForOwner(db, project.id, owner.id)).toMatchObject({ id: project.id });
    expect(await getProjectForOwner(db, project.id, stranger.id)).toBeNull();
  });

  it('finds a project by token hash and rotates tokens only for the owner', async () => {
    const owner = await makeUser(db);
    const stranger = await makeUser(db);
    const project = await makeProject(db, owner.id);

    expect(await findProjectByTokenHash(db, project.apiTokenHash)).toMatchObject({ id: project.id });
    expect(await rotateProjectToken(db, project.id, stranger.id, { apiTokenHash: 'new', apiTokenHint: 'dh_…new' })).toBe(false);
    expect(await rotateProjectToken(db, project.id, owner.id, { apiTokenHash: 'new', apiTokenHint: 'dh_…new' })).toBe(true);
    expect(await findProjectByTokenHash(db, project.apiTokenHash)).toBeNull();
    expect(await findProjectByTokenHash(db, 'new')).toMatchObject({ id: project.id, apiTokenHint: 'dh_…new' });
  });

  it('lists an owner’s projects with the latest deploy and its latest scan', async () => {
    const owner = await makeUser(db);
    const quiet = await makeProject(db, owner.id, 'quiet');
    const busy = await makeProject(db, owner.id, 'busy');
    await makeProject(db, (await makeUser(db)).id, 'not-mine');

    await recordScan(db, { projectId: busy.id, sha: 'aaaaaaa', branch: 'main', deployedAt: at('2026-09-01T00:00:00Z'), findings: [] });
    await recordScan(db, { projectId: busy.id, sha: 'bbbbbbb', branch: 'main', deployedAt: at('2026-09-02T00:00:00Z'), findings: FINDINGS });

    const list = await listProjectsForOwner(db, owner.id);
    expect(list.map((p) => p.name)).toEqual(['busy', 'quiet']);
    expect(list[0]).toMatchObject({
      lastDeploy: { sha: 'bbbbbbb', branch: 'main' },
      counts: { missing: 1, unused: 1, mismatch: 1 },
    });
    expect(list[1]).toMatchObject({ id: quiet.id, lastDeploy: null, counts: null });
  });
});

describe('recordScan', () => {
  it('stores a deploy, a scan with server-side counts and every finding', async () => {
    const project = await makeProject(db, (await makeUser(db)).id);
    const result = await recordScan(db, {
      projectId: project.id,
      sha: 'abc1234',
      branch: 'main',
      deployedAt: at('2026-09-01T10:00:00Z'),
      findings: FINDINGS,
    });

    expect(result.counts).toEqual({ missing: 1, unused: 1, mismatch: 1 });
    const detail = await getLatestScan(db, project.id, result.deployId);
    expect(detail?.deploy).toMatchObject({ sha: 'abc1234', branch: 'main', source: 'ingest' });
    expect(detail?.scan).toMatchObject({ missingCount: 1, unusedCount: 1, mismatchCount: 1 });
    // Sorted by kind (enum order), then name, then file.
    expect(detail?.findings).toEqual([FINDINGS[1], FINDINGS[0], FINDINGS[3], FINDINGS[2]]);
  });

  it('stores referenced variables, merging repeats, and records that the CLI reported them', async () => {
    const project = await makeProject(db, (await makeUser(db)).id);
    const base = { projectId: project.id, branch: 'main', deployedAt: at('2026-09-01T10:00:00Z'), findings: FINDINGS };
    const withVariables = await recordScan(db, {
      ...base,
      sha: 'abc1234',
      variables: [
        { var_name: 'REDIS_URL', scope: 'apps/api', defined_in: [] },
        { var_name: 'DATABASE_URL', scope: 'apps/api', defined_in: ['.env'] },
        { var_name: 'DATABASE_URL', scope: '', defined_in: ['.env.example'] },
        { var_name: 'DATABASE_URL', scope: 'apps/api', defined_in: ['.env.example'] },
      ],
    });
    expect(await getScanVariables(db, withVariables.scanId)).toEqual([
      { scope: '', var_name: 'DATABASE_URL', defined_in: ['.env.example'] },
      { scope: 'apps/api', var_name: 'DATABASE_URL', defined_in: ['.env.example', '.env'] },
      { scope: 'apps/api', var_name: 'REDIS_URL', defined_in: [] },
    ]);
    expect((await getLatestScan(db, project.id, withVariables.deployId))?.scan.variablesReported).toBe(true);

    // An older CLI sends no variables: nothing stored, and the scan says so.
    const older = await recordScan(db, { ...base, sha: 'def5678' });
    expect(await getScanVariables(db, older.scanId)).toEqual([]);
    expect((await getLatestScan(db, project.id, older.deployId))?.scan.variablesReported).toBe(false);
    // A newer CLI on a project with no references at all: empty, but reported.
    const none = await recordScan(db, { ...base, sha: 'fed9876', variables: [] });
    expect((await getLatestScan(db, project.id, none.deployId))?.scan.variablesReported).toBe(true);
  });

  it('stores optional flags and env scopes (CLI 0.2.0+), and lists the scopes with no env file', async () => {
    const project = await makeProject(db, (await makeUser(db)).id);
    const scan = await recordScan(db, {
      projectId: project.id,
      sha: 'abc1234',
      branch: 'main',
      deployedAt: at('2026-09-01T10:00:00Z'),
      findings: [],
      variables: [
        { var_name: 'DEPLOY_KEY', scope: '', defined_in: [] },
        { var_name: 'DEPLOY_TARGET', scope: '', defined_in: [], optional: true },
        { var_name: 'PORT', scope: 'apps/api', defined_in: [], optional: true },
        // Merged with a copy that isn't optional: it isn't.
        { var_name: 'PORT', scope: 'apps/api', defined_in: ['.env.production'] },
        { var_name: 'PROD_DB_URL', scope: 'apps/api', defined_in: ['.env.production'] },
      ],
      envScopes: [
        { scope: '', env_files: [] },
        { scope: 'apps/api', env_files: ['.env.example', '.env.production'] },
        { scope: 'tools', env_files: [] }, // no variables: no notice
      ],
    });
    expect(await getScanVariables(db, scan.scanId)).toEqual([
      { scope: '', var_name: 'DEPLOY_KEY', defined_in: [] },
      { scope: '', var_name: 'DEPLOY_TARGET', defined_in: [], optional: true },
      { scope: 'apps/api', var_name: 'PORT', defined_in: ['.env.production'] },
      { scope: 'apps/api', var_name: 'PROD_DB_URL', defined_in: ['.env.production'] },
    ]);
    const detail = await getLatestScan(db, project.id, scan.deployId);
    expect(detail?.scan.envScopes).toEqual([
      { scope: '', env_files: [] },
      { scope: 'apps/api', env_files: ['.env.example', '.env.production'] },
      { scope: 'tools', env_files: [] },
    ]);
    expect(detail?.scopesWithoutEnvFiles).toEqual([{ scope: '', variables: 2 }]);
  });

  it('stores a 0.1.0-shaped scan exactly as before: no env scopes, nothing optional, no notices', async () => {
    const project = await makeProject(db, (await makeUser(db)).id);
    const scan = await recordScan(db, {
      projectId: project.id,
      sha: 'abc1234',
      branch: 'main',
      deployedAt: at('2026-09-01T10:00:00Z'),
      findings: FINDINGS,
      variables: [{ var_name: 'REDIS_URL', scope: '', defined_in: [] }],
    });
    const detail = await getLatestScan(db, project.id, scan.deployId);
    expect(detail?.scan.envScopes).toBeNull();
    expect(detail?.scopesWithoutEnvFiles).toEqual([]);
    expect(await getScanVariables(db, scan.scanId)).toEqual([{ scope: '', var_name: 'REDIS_URL', defined_in: [] }]);
  });

  it('adds a scan to the existing deploy when the same sha is reported again', async () => {
    const project = await makeProject(db, (await makeUser(db)).id);
    const base = { projectId: project.id, sha: 'abc1234', deployedAt: at('2026-09-01T10:00:00Z') };
    const first = await recordScan(db, { ...base, branch: 'main', findings: FINDINGS });
    const second = await recordScan(db, {
      ...base,
      branch: 'other',
      deployedAt: at('2026-09-05T10:00:00Z'),
      findings: [FINDINGS[0]!],
    });

    expect(second.deployId).toBe(first.deployId);
    expect(second.scanId).not.toBe(first.scanId);

    const deployList = await listDeploys(db, project.id);
    expect(deployList).toHaveLength(1);
    // The deploy keeps its first branch and time; counts come from the newest scan.
    expect(deployList[0]).toMatchObject({
      deploy: { branch: 'main', deployedAt: at('2026-09-01T10:00:00Z') },
      counts: { missing: 1, unused: 0, mismatch: 0 },
      scanCount: 2,
    });
    expect((await getLatestScan(db, project.id, first.deployId))?.findings).toEqual([FINDINGS[0]]);
  });

  it('stores large scans in batches', async () => {
    const project = await makeProject(db, (await makeUser(db)).id);
    const many: FindingRow[] = Array.from({ length: 2500 }, (_, i) => ({
      kind: 'missing',
      var_name: `VAR_${i}`,
      file: 'src/big.ts',
      line: i + 1,
      env_file: null,
    }));
    const result = await recordScan(db, { projectId: project.id, sha: 'fffffff', branch: 'main', deployedAt: new Date(), findings: many });
    expect(result.counts.missing).toBe(2500);
    expect((await getLatestScan(db, project.id, result.deployId))?.findings).toHaveLength(2500);
  });
});

describe('listDeploys / getLatestScan', () => {
  it('lists deploys newest first and scopes scan lookups to the project', async () => {
    const owner = await makeUser(db);
    const project = await makeProject(db, owner.id);
    const other = await makeProject(db, owner.id);
    const old = await recordScan(db, { projectId: project.id, sha: '1111111', branch: 'main', deployedAt: at('2026-09-01T00:00:00Z'), findings: [] });
    await recordScan(db, { projectId: project.id, sha: '2222222', branch: 'main', deployedAt: at('2026-09-03T00:00:00Z'), findings: FINDINGS });

    const list = await listDeploys(db, project.id);
    expect(list.map((d) => d.deploy.sha)).toEqual(['2222222', '1111111']);
    expect(list[1]?.counts).toEqual({ missing: 0, unused: 0, mismatch: 0 });

    expect(await getLatestScan(db, other.id, old.deployId)).toBeNull();
  });
});
