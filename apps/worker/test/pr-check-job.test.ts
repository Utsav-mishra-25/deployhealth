import { MAX_PR_CHECK_FILES } from '@deployhealth/core';
import type { NewPrCheck, PrCheck, PrCheckMode, PrCheckTarget } from '@deployhealth/db';
import { describe, expect, it } from 'vitest';
import { githubApi } from '../src/github/api';
import { prCheck, type PrCheckDeps } from '../src/jobs';
import { COMMENT_MARKER } from '../src/pr-check/report';
import { mockOctokit, type MockRepo } from './mock-octokit';

const ENV = ['process', 'env'].join('.');
const JOB = { installationId: 7, repoFullName: 'acme/shop', prNumber: 42 };

const BASE = {
  '.env.example': 'DATABASE_URL=\n',
  '.gitignore': 'generated/\n',
  'src/db.ts': `connect(${ENV}.DATABASE_URL);`,
  'generated/client.ts': `${ENV}.IGNORED_BY_GITIGNORE`,
  'README.md': `${ENV}.NOT_SCANNED`,
};
const HEAD = { ...BASE, 'src/cache.ts': `redis(${ENV}.REDIS_URL);` };
const HEAD2 = { ...HEAD, '.env.example': 'DATABASE_URL=\nREDIS_URL=\n' };

function repo(overrides: Partial<MockRepo> = {}): MockRepo {
  return {
    commits: { base1: BASE, head1: HEAD, head2: HEAD2 },
    pulls: { 42: { state: 'open', head: 'head1', baseTip: 'tip', mergeBase: 'base1', author: 'claude[bot]', files: [{ filename: 'src/cache.ts', patch: '@@ -0,0 +1 @@\n+redis();' }] } },
    ...overrides,
  };
}

/** prCheck's dependencies over an in-memory store (the db side is covered by packages/db tests). */
function harness(mock: ReturnType<typeof mockOctokit>, { mode = 'comment', target = true }: { mode?: PrCheckMode; target?: boolean } = {}) {
  const rows: PrCheck[] = [];
  const logs: string[] = [];
  const project: PrCheckTarget = { installationId: 'inst-uuid', project: { id: 'project-uuid', name: 'shop', prCheckMode: mode } };
  const deps: PrCheckDeps = {
    findTarget: async (installationId, repoName) => (target && installationId === 7 && repoName === 'acme/shop' ? project : null),
    findCommentId: async (projectId, prNumber) => rows.filter((r) => r.projectId === projectId && r.prNumber === prNumber && r.commentId).at(-1)?.commentId ?? null,
    saveCheck: async (input: Omit<NewPrCheck, 'id' | 'createdAt' | 'updatedAt' | 'closedAt'>) => {
      const existing = rows.find((r) => r.projectId === input.projectId && r.prNumber === input.prNumber && r.headSha === input.headSha);
      if (existing) return Object.assign(existing, input, { commentId: existing.commentId, checkRunId: existing.checkRunId });
      const row = { id: `row-${rows.length + 1}`, commentId: null, checkRunId: null, closedAt: null, createdAt: new Date(), updatedAt: new Date(), ...input } as PrCheck;
      rows.push(row);
      return row;
    },
    setGithubIds: async (id, ids) => void Object.assign(rows.find((r) => r.id === id)!, ids),
    api: (_installationId, repoName) => githubApi(mock.octokit, repoName),
    log: (m) => void logs.push(m),
  };
  return { deps, rows, logs };
}

describe('prCheck against a mocked Octokit', () => {
  it('reads the trees and blobs it needs, stores the result, comments once and adds the check run', async () => {
    const mock = mockOctokit(repo());
    const { deps, rows } = harness(mock);
    expect(await prCheck(JOB, deps)).toBe('neutral');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      prNumber: 42,
      headSha: 'head1',
      baseSha: 'base1', // the merge base, not the base branch tip
      authorLogin: 'claude[bot]',
      authorIsAgent: true,
      agentName: 'Claude',
      addedVars: [{ name: 'REDIS_URL', refs: [{ file: 'src/cache.ts', line: 1 }], total: 1, declared: false }],
      undeclaredVars: ['REDIS_URL'],
      conclusion: 'neutral',
      secretHits: 0,
    });
    // Only scannable, non-ignored files were downloaded, each distinct blob once (plus .gitignore).
    const blobCalls = mock.calls.filter((c) => c.startsWith('git.getBlob'));
    expect(blobCalls).toHaveLength(4); // .gitignore, .env.example, src/db.ts, src/cache.ts
    const [comment] = [...mock.state.comments.values()];
    expect(comment!.body.startsWith(`${COMMENT_MARKER}\n### deployhealth · env check`)).toBe(true);
    expect(comment!.body).toContain('| `REDIS_URL` | `src/cache.ts:1` | ❌ **not declared** |');
    expect([...mock.state.checkRuns.values()]).toEqual([expect.objectContaining({ headSha: 'head1', conclusion: 'neutral', title: '1 env var added (1 not in .env.example)' })]);
    expect(rows[0]).toMatchObject({ commentId: [...mock.state.comments.keys()][0], checkRunId: [...mock.state.checkRuns.keys()][0] });
  });

  it('never reports (or downloads) test files and fixtures, but keeps a source file named like one', async () => {
    const withTests = {
      ...HEAD,
      'src/cache.test.ts': `expect(${ENV}.UNIT_ONLY)`,
      'src/__tests__/cache.ts': `${ENV}.JEST_ONLY`,
      'e2e/login.spec.ts': `${ENV}.E2E_ONLY`,
      'tests/test_cache.py': 'os.getenv("PY_TEST_ONLY")',
      'test/fixtures/app/.env.example': 'FIXTURE_VAR=\n',
      'test/fixtures/app/index.ts': `${ENV}.FIXTURE_VAR`,
      'src/contest.ts': `${ENV}.CONTEST_VAR`,
    };
    const mock = mockOctokit(repo({ commits: { base1: BASE, head1: withTests } }));
    const { deps, rows } = harness(mock);
    expect(await prCheck(JOB, deps)).toBe('neutral');
    expect(rows[0]!.addedVars.map((v) => v.name)).toEqual(['CONTEST_VAR', 'REDIS_URL']);
    expect(rows[0]!.undeclaredVars).toEqual(['CONTEST_VAR', 'REDIS_URL']);
    const comment = [...mock.state.comments.values()][0]!.body;
    for (const name of ['UNIT_ONLY', 'JEST_ONLY', 'E2E_ONLY', 'PY_TEST_ONLY', 'FIXTURE_VAR']) expect(comment).not.toContain(name);
    // Test files never count against the fetch budget: same downloads as without them, plus contest.ts.
    expect(mock.calls.filter((c) => c.startsWith('git.getBlob'))).toHaveLength(5);
  });

  it('never fetches vendored code (.yarn/, .pnp.cjs, *.min.js) or a source file over 512 KB', async () => {
    const withVendored = {
      ...HEAD,
      '.yarn/releases/yarn-4.0.0.cjs': `${ENV}.FROM_YARN_RELEASE`,
      '.pnp.cjs': `${ENV}.FROM_PNP`,
      'public/app.min.js': `${ENV}.FROM_MIN_JS`,
      'src/bundle.js': `${ENV}.FROM_BIG_BUNDLE;\n${'/'.repeat(512 * 1024)}`,
    };
    const mock = mockOctokit(repo({ commits: { base1: BASE, head1: withVendored } }));
    const { deps, rows } = harness(mock);
    expect(await prCheck(JOB, deps)).toBe('neutral');
    expect(rows[0]!.addedVars.map((v) => v.name)).toEqual(['REDIS_URL']);
    const comment = [...mock.state.comments.values()][0]!.body;
    for (const name of ['FROM_YARN_RELEASE', 'FROM_PNP', 'FROM_MIN_JS', 'FROM_BIG_BUNDLE']) expect(comment).not.toContain(name);
    // The same downloads as without them: none of the four is fetched or counted against the budget.
    expect(mock.calls.filter((c) => c.startsWith('git.getBlob'))).toHaveLength(4);
  });

  it('fails the check in strict mode, and succeeds once the variable is declared', async () => {
    const mock = mockOctokit(repo());
    expect(await prCheck(JOB, harness(mock, { mode: 'strict' }).deps)).toBe('failure');
    const fixed = mockOctokit(repo({ pulls: { 42: { ...repo().pulls[42]!, head: 'head2' } } }));
    expect(await prCheck(JOB, harness(fixed, { mode: 'strict' }).deps)).toBe('success');
    expect([...fixed.state.checkRuns.values()][0]!.conclusion).toBe('success');
    // Declared and nothing else to flag: still worth a comment, since a variable was added.
    expect([...fixed.state.comments.values()][0]!.body).toContain('✅ **1 env var added.**');
  });

  it('is idempotent: the same head again updates the same comment and check run', async () => {
    const mock = mockOctokit(repo());
    const { deps, rows } = harness(mock);
    await prCheck(JOB, deps);
    await prCheck(JOB, deps);
    expect(rows).toHaveLength(1);
    expect(mock.state.comments.size).toBe(1);
    expect(mock.state.checkRuns.size).toBe(1);
    expect(mock.calls.filter((c) => c.startsWith('issues.createComment'))).toHaveLength(1);
    expect(mock.calls.filter((c) => c.startsWith('issues.updateComment'))).toHaveLength(1);
    expect(mock.calls.filter((c) => c.startsWith('checks.'))).toEqual([expect.stringMatching(/^checks\.create/), expect.stringMatching(/^checks\.update/)]);
  });

  it('on a new push keeps the one comment (updated in place) and adds a check run for the new head', async () => {
    const r = repo();
    const mock = mockOctokit(r);
    const { deps, rows } = harness(mock);
    await prCheck(JOB, deps);
    r.pulls[42]!.head = 'head2';
    await prCheck(JOB, deps);
    expect(rows.map((x) => [x.headSha, x.conclusion])).toEqual([
      ['head1', 'neutral'],
      ['head2', 'success'],
    ]);
    expect(mock.state.comments.size).toBe(1);
    expect([...mock.state.comments.values()][0]!.body).toContain('Checked `head2`');
    expect([...mock.state.checkRuns.values()].map((c) => [c.headSha, c.conclusion])).toEqual([
      ['head1', 'neutral'],
      ['head2', 'success'],
    ]);
  });

  it('finds its comment by the hidden marker when it has no record of it, and replaces a deleted one', async () => {
    const mock = mockOctokit(repo());
    await prCheck(JOB, harness(mock).deps);
    const [id] = [...mock.state.comments.keys()];
    await prCheck(JOB, harness(mock).deps); // fresh store: no comment id on record
    expect([...mock.state.comments.keys()]).toEqual([id]);
    expect(mock.calls).toContain('issues.listComments');

    mock.state.comments.clear(); // someone deleted it
    const { deps, rows } = harness(mock);
    rows.push({ id: 'old', projectId: 'project-uuid', prNumber: 42, headSha: 'older', commentId: id } as PrCheck);
    await prCheck(JOB, deps);
    expect(mock.state.comments.size).toBe(1);
    expect([...mock.state.comments.keys()][0]).not.toBe(id);
  });

  it('posts no comment when a pull request changes no env vars, but still adds the check run', async () => {
    const mock = mockOctokit(repo({ commits: { base1: BASE, head1: { ...BASE, 'src/db.ts': `connect(${ENV}.DATABASE_URL, { pool: 5 });` } } }));
    expect(await prCheck(JOB, harness(mock).deps)).toBe('success');
    expect(mock.state.comments.size).toBe(0);
    expect([...mock.state.checkRuns.values()][0]).toMatchObject({ conclusion: 'success', title: 'No env var changes' });
  });

  it("does nothing in 'off' mode, for a closed pull request, or when no project matches", async () => {
    const off = mockOctokit(repo());
    expect(await prCheck(JOB, harness(off, { mode: 'off' }).deps)).toBe('off');
    expect(off.calls).toEqual([]);

    const none = mockOctokit(repo());
    const { deps, rows, logs } = harness(none, { target: false });
    expect(await prCheck(JOB, deps)).toBe('no-project');
    expect(none.calls).toEqual([]);
    expect(rows).toEqual([]);
    expect(logs).toEqual(['[pr-check] acme/shop#42: no linked project for this repo; nothing stored']);

    const closed = mockOctokit(repo({ pulls: { 42: { ...repo().pulls[42]!, state: 'closed' } } }));
    expect(await prCheck(JOB, harness(closed).deps)).toBe('closed');
    expect(closed.calls).toEqual(['pulls.get 42', 'repos.compare tip...head1']);
  });

  it('flags committed env files and secret-shaped strings, and never stores or prints their values', async () => {
    const token = ['gh', 'p_', 'x'.repeat(36)].join('');
    const r = repo({
      commits: { base1: BASE, head1: { ...BASE, 'web/.env.local': `API_TOKEN=${token}` } },
      pulls: { 42: { ...repo().pulls[42]!, author: 'octocat', files: [{ filename: 'web/.env.local', patch: `@@ -0,0 +1 @@\n+API_TOKEN=${token}` }] } },
    });
    const mock = mockOctokit(r);
    const { deps, rows, logs } = harness(mock);
    expect(await prCheck(JOB, deps)).toBe('neutral');
    expect(rows[0]).toMatchObject({ committedEnvFiles: [{ path: 'web/.env.local', added: true }], secretHits: 1, authorIsAgent: false });
    const everything = JSON.stringify({ rows, logs, comments: [...mock.state.comments.values()], runs: [...mock.state.checkRuns.values()] });
    expect(everything).not.toContain(token);
    expect([...mock.state.checkRuns.values()][0]!.text).toContain('`web/.env.local:1` GitHub token');
  });
});

describe('hard caps on what a check fetches', () => {
  it('refuses a pull request needing more than 2,000 files before downloading them', async () => {
    const big = Object.fromEntries(Array.from({ length: MAX_PR_CHECK_FILES + 1 }, (_, i) => [`src/f${i}.ts`, `export const v${i} = ${i};`]));
    const mock = mockOctokit(repo({ commits: { base1: BASE, head1: { ...BASE, ...big } } }));
    const { deps, rows } = harness(mock, { mode: 'strict' });
    expect(await prCheck(JOB, deps)).toBe('neutral');
    expect(rows[0]).toMatchObject({ conclusion: 'neutral', addedVars: [], undeclaredVars: [] });
    expect(mock.calls.filter((c) => c.startsWith('git.getBlob')).length).toBeLessThan(10); // only .gitignore files
    expect([...mock.state.comments.values()][0]!.body).toContain('needs more than 2000 files; too large to check');
  });

  it('refuses more than 20 MB, counting the real size when a tree entry understates it', async () => {
    // 45 files just under the 512 KB source limit: 22.5 MB, all of which would be fetched.
    const chunk = 'x'.repeat(500 * 1024);
    const heavy = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`data/blob${i}.ts`, `// ${i}\n${chunk}`]));
    const mock = mockOctokit(repo({ commits: { base1: BASE, head1: { ...BASE, ...heavy } } }));
    expect(await prCheck(JOB, harness(mock).deps)).toBe('neutral');
    expect([...mock.state.comments.values()][0]!.body).toContain('more than 20 MB');

    const liar = mockOctokit(
      repo({
        commits: { base1: BASE, head1: { ...BASE, 'src/huge.ts': `// ${'y'.repeat(21 * 1024 * 1024)}` } },
        understate: { 'src/huge.ts': 10 },
      }),
    );
    expect(await prCheck(JOB, harness(liar).deps)).toBe('neutral');
    expect([...liar.state.comments.values()][0]!.body).toContain('more than 20 MB');
  });

  it('skips a repository whose tree GitHub truncates', async () => {
    const mock = mockOctokit(repo({ truncated: true }));
    expect(await prCheck(JOB, harness(mock).deps)).toBe('neutral');
    expect(mock.calls.some((c) => c.startsWith('git.getBlob'))).toBe(false);
  });
});
