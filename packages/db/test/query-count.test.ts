import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getClientBySlug, listClientsOverview } from '../src/clients';
import { agentPrStats, listInstallationsForUser, upsertInstallation, upsertPrCheck } from '../src/github';
import { recordCheck } from '../src/monitoring';
import { recordScan } from '../src/queries';
import { projects } from '../src/schema';
import { makeClient, makeEndpoint, makeProject, makeUser, openTestDb, truncateAll } from './test-db';

// The project lists must cost the same number of queries whatever the number of projects: every
// per-project figure (latest scan, uptime, open PR flags, scopes with no env file) comes from one
// statement with lateral joins, never a query per row.

const handle = openTestDb();
const { db } = handle;

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await handle.close();
});

let installationIds = 900;

/** A user with `n` projects, each with everything a row reads: scans, an endpoint with an alert, a flagged PR. */
async function userWithProjects(n: number) {
  const user = await makeUser(db);
  const client = await makeClient(db, user.id, `client-${n}`);
  const inst = await upsertInstallation(db, { githubInstallationId: ++installationIds, accountLogin: 'acme', accountType: 'Organization', installerGithubId: user.githubId }, []);
  for (let i = 0; i < n; i++) {
    const project = await makeProject(db, user.id, `p${n}-${i}`, `acme/p${n}-${i}`);
    await db.update(projects).set({ clientId: client.id }).where(eq(projects.id, project.id));
    await recordScan(db, {
      projectId: project.id,
      sha: 'abcdef1',
      branch: 'main',
      deployedAt: new Date(),
      findings: [{ kind: 'missing', var_name: 'A', file: 'a.ts', line: 1, env_file: null }],
      variables: [{ var_name: 'A', scope: 'api', defined_in: [] }],
      envScopes: [{ scope: 'api', env_files: [] }],
    });
    const endpoint = await makeEndpoint(db, project.id);
    const at = (m: number) => new Date(Date.now() - m * 60_000);
    await recordCheck(db, endpoint.id, { checkedAt: at(5), statusCode: 200, latencyMs: 10, ok: true, error: null });
    await recordCheck(db, endpoint.id, { checkedAt: at(4), statusCode: 503, latencyMs: 10, ok: false, error: 'x' });
    await recordCheck(db, endpoint.id, { checkedAt: at(3), statusCode: 503, latencyMs: 10, ok: false, error: 'x' });
    await upsertPrCheck(db, { projectId: project.id, installationId: inst.id, prNumber: 1, headSha: 'h', baseSha: 'b', authorLogin: 'x', conclusion: 'neutral', undeclaredVars: ['B'], secretHits: 1 });
  }
  return { user, client };
}

/** How many statements `fn` sends to Postgres. */
async function countQueries(fn: () => Promise<unknown>): Promise<number> {
  const spy = vi.spyOn(handle.pool, 'query');
  try {
    await fn();
    return spy.mock.calls.length;
  } finally {
    spy.mockRestore();
  }
}

describe('project lists run a fixed number of queries', () => {
  it('/clients: the same for 1 project as for 20', async () => {
    const one = await userWithProjects(1);
    const twenty = await userWithProjects(20);
    // What the /clients page reads (auth uses JWT sessions: no query).
    const page = (userId: string) => Promise.all([listInstallationsForUser(db, userId), listClientsOverview(db, userId)]);
    const forOne = await countQueries(() => page(one.user.id));
    const forTwenty = await countQueries(() => page(twenty.user.id));
    expect(forOne).toBe(4);
    expect(forTwenty).toBe(forOne);
    expect((await listClientsOverview(db, twenty.user.id)).clients[0]!.projects).toHaveLength(20);
  });

  it("a client's page: the same for 1 project as for 20", async () => {
    const one = await userWithProjects(1);
    const twenty = await userWithProjects(20);
    const range = [new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000)] as const;
    const page = async (userId: string, slug: string) => {
      const client = await getClientBySlug(db, userId, slug);
      await Promise.all([listClientsOverview(db, userId), agentPrStats(db, userId, client!.id, ...range)]);
    };
    const forOne = await countQueries(() => page(one.user.id, one.client.slug));
    const forTwenty = await countQueries(() => page(twenty.user.id, twenty.client.slug));
    expect(forOne).toBe(4);
    expect(forTwenty).toBe(forOne);
  });
});
