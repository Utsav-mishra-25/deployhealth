import { MAX_PR_CHECK_FILES } from '@deployhealth/core';
import type { NewPrCheck, PrCheck, PrCheckMode, PrCheckTarget } from '@deployhealth/db';
import { describe, expect, it } from 'vitest';
import { githubApi } from '../src/github/api';
import { prCheck, type PrCheckDeps } from '../src/jobs';
import { openPrCheckIsolate } from '../src/pr-check/isolate';
import { CANT_CHECK_TITLE, COMMENT_MARKER, NOTHING_CHANGED_TITLE, UNCHECKABLE_SUMMARY, UNCHECKABLE_TITLE } from '../src/pr-check/report';
import { MOCK_APP_ID, mockOctokit, type MockRepo } from './mock-octokit';

const ENV = ['process', 'env'].join('.');
const JOB = { installationId: 7, repoFullName: 'acme/shop', prNumber: 42 };

const BASE = {
  '.env.example': 'DATABASE_URL=\n',
  '.gitignore': 'generated/\n',
  'src/db.ts': `connect(${ENV}.DATABASE_URL);`,
  'generated/client.ts': `${ENV}.TRACKED_THOUGH_GITIGNORED`,
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
    api: (_installationId, repoName) => githubApi(mock.octokit, repoName, { appId: MOCK_APP_ID }),
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
    // Only scannable files were downloaded, each distinct blob once. A tracked file is never
    // gitignored, so generated/client.ts is read and no .gitignore is.
    const blobCalls = mock.calls.filter((c) => c.startsWith('git.getBlob'));
    expect(blobCalls).toHaveLength(4); // .env.example, src/db.ts, generated/client.ts, src/cache.ts
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

  it("never reuses a marked comment this App didn't post: another bot's, or a person's", async () => {
    const mock = mockOctokit(repo());
    mock.state.comments.set(1, { body: `${COMMENT_MARKER}\nplanted by a person`, bot: false });
    mock.state.comments.set(2, { body: `${COMMENT_MARKER}\nplanted by another app`, bot: true, appId: MOCK_APP_ID + 1 });
    await prCheck(JOB, harness(mock).deps);
    expect(mock.state.comments.get(1)!.body).toContain('planted by a person');
    expect(mock.state.comments.get(2)!.body).toContain('planted by another app');
    expect(mock.calls.filter((c) => c.startsWith('issues.updateComment'))).toEqual([]);
    expect(mock.state.comments.size).toBe(3);
  });

  it('posts no comment when a pull request changes no env vars, but still adds the check run', async () => {
    const mock = mockOctokit(repo({ commits: { base1: BASE, head1: { ...BASE, 'src/db.ts': `connect(${ENV}.DATABASE_URL, { pool: 5 });` } } }));
    expect(await prCheck(JOB, harness(mock).deps)).toBe('success');
    expect(mock.state.comments.size).toBe(0);
    // A clean pass says what it read: .env.example, src/db.ts, generated/client.ts; one of them changed.
    expect([...mock.state.checkRuns.values()][0]).toMatchObject({ conclusion: 'success', title: 'Checked 3 files (JS/TS), 1 changed: no undeclared env vars' });
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
    expect(mock.calls.filter((c) => c.startsWith('git.getBlob'))).toEqual([]);
    expect([...mock.state.comments.values()][0]!.body).toContain('needs more than 2000 files; too large to check');
  });

  it('counts every path toward the 2,000-file cap, even when they all share one blob', async () => {
    const copies = Object.fromEntries(Array.from({ length: MAX_PR_CHECK_FILES + 1 }, (_, i) => [`src/copy${i}.ts`, `${ENV}.SAME_EVERYWHERE`]));
    const mock = mockOctokit(repo({ commits: { base1: BASE, head1: { ...BASE, ...copies } } }));
    const { deps, rows } = harness(mock);
    expect(await prCheck(JOB, deps)).toBe('neutral');
    expect(rows[0]).toMatchObject({ addedVars: [], undeclaredVars: [] });
    expect(mock.calls.filter((c) => c.startsWith('git.getBlob'))).toEqual([]);
    expect([...mock.state.comments.values()][0]!.body).toContain('needs more than 2000 files; too large to check');
  });

  it('counts a file unchanged between base and head once', async () => {
    const files = Object.fromEntries(Array.from({ length: 1_200 }, (_, i) => [`src/f${i}.ts`, `export const v${i} = ${i};`]));
    const mock = mockOctokit(repo({ commits: { base1: { ...BASE, ...files }, head1: { ...HEAD, ...files } } }));
    const { deps, rows } = harness(mock);
    expect(await prCheck(JOB, deps)).toBe('neutral');
    expect(rows[0]).toMatchObject({ undeclaredVars: ['REDIS_URL'] });
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

describe("a check the isolate can't finish", () => {
  // Seconds of real work (150,000 new variables in four files under 512 KB), with a 50 ms limit.
  const heavy = Object.fromEntries(
    Array.from({ length: 4 }, (_, f) => [`src/f${f}.ts`, `const {${Array.from({ length: 37_500 }, (_, i) => `K${f}_${i}`).join(',')}} = ${ENV};`]),
  );

  it("reports a neutral check run with a fixed message, comments nothing, and returns instead of throwing", async () => {
    const mock = mockOctokit(repo({ commits: { base1: BASE, head1: { ...HEAD, ...heavy } } }));
    const { deps, rows, logs } = harness(mock);
    expect(await prCheck(JOB, { ...deps, openIsolate: () => openPrCheckIsolate({ limitMs: 50 }) })).toBe('neutral');
    expect(rows).toEqual([expect.objectContaining({ conclusion: 'neutral', addedVars: [], undeclaredVars: [], secretHits: 0, commentId: null })]);
    expect([...mock.state.comments.values()]).toEqual([]);
    expect([...mock.state.checkRuns.values()]).toEqual([{ headSha: 'head1', conclusion: 'neutral', title: UNCHECKABLE_TITLE, summary: UNCHECKABLE_SUMMARY, text: undefined }]);
    expect(logs.at(-1)).toBe("[pr-check] acme/shop#42 head1: couldn't be checked (timeout); not retried");

    // Running the same head again updates that check run in place.
    expect(await prCheck(JOB, { ...deps, openIsolate: () => openPrCheckIsolate({ limitMs: 50 }) })).toBe('neutral');
    expect(mock.state.checkRuns.size).toBe(1);
  });

  it('still throws (so the queue retries) when GitHub fails', async () => {
    const mock = mockOctokit(repo({ commits: { base1: BASE } })); // head1's tree is missing: a 404 from GitHub
    const { deps } = harness(mock);
    await expect(prCheck(JOB, deps)).rejects.toMatchObject({ status: 404 });
  });
});

describe('what the check read: repos it can\'t read, pull requests that change nothing it reads', () => {
  // Rust, C# and shell: languages the scanner doesn't read.
  const RUST = {
    'Cargo.toml': '[package]',
    'src/main.rs': 'fn main() { let url = std::env::var("DATABASE_URL"); }',
    'src/config.rs': 'pub struct Config;',
    'src/util.rs': 'pub fn util() {}',
    'tools/Gen.cs': 'class Gen {}',
    'scripts/deploy.sh': 'echo "$DATABASE_URL"',
  };
  const PR = repo().pulls[42]!;
  const rustRepo = (head: Record<string, string>, files: Array<{ filename: string; patch?: string }> = []) =>
    repo({ commits: { base1: RUST, head1: head }, pulls: { 42: { ...PR, author: 'octocat', files } } });
  const runs = (mock: ReturnType<typeof mockOctokit>) => [...mock.state.checkRuns.values()];
  const blobs = (mock: ReturnType<typeof mockOctokit>) => mock.calls.filter((c) => c.startsWith('git.getBlob'));

  it('a Rust repo: neutral, the can\'t-check title, no comment, no blob downloads; strict mode too', async () => {
    const head = { ...RUST, 'src/feature.rs': 'fn feature() { let k = std::env::var("NEW_KEY"); }' };
    for (const mode of ['comment', 'strict'] as const) {
      const mock = mockOctokit(rustRepo(head, [{ filename: 'src/feature.rs', patch: '@@ -0,0 +1 @@\n+fn feature() {}' }]));
      const { deps, rows } = harness(mock, { mode });
      expect(await prCheck(JOB, deps)).toBe('neutral');
      expect(runs(mock)).toEqual([expect.objectContaining({ conclusion: 'neutral', title: CANT_CHECK_TITLE })]);
      expect(CANT_CHECK_TITLE).toBe("deployhealth can't check this repo yet: no JS/TS, Python, Go, Ruby, PHP or Java/Kotlin files found");
      const summary = runs(mock)[0]!.summary;
      expect(summary).toContain('deployhealth reads JS/TS, Python, Go, Ruby, PHP and Java/Kotlin. Rust, C# and others aren\'t read yet');
      expect(summary).toContain('It holds 4 .rs, 1 .cs, 1 .sh files that deployhealth doesn\'t read.');
      expect(summary).toContain('https://github.com/Utsav-mishra-25/deployhealth#known-limitations');
      expect(summary).not.toContain('src/main'); // counts only, never paths
      expect(mock.state.comments.size).toBe(0);
      expect(blobs(mock)).toEqual([]);
      expect(rows[0]).toMatchObject({ conclusion: 'neutral', addedVars: [], undeclaredVars: [], committedEnvFiles: [], secretHits: 0 });
    }
  });

  it('is still can\'t check with a .env.example, or when the only JS is tests and vendored code', async () => {
    const extras: Array<Record<string, string>> = [
      { '.env.example': 'DATABASE_URL=\n' },
      { 'web/app.test.ts': `${ENV}.A`, 'node_modules/lib/index.js': `${ENV}.B`, 'vendor/x.min.js': `${ENV}.C`, 'e2e/login.spec.ts': `${ENV}.D` },
    ];
    for (const extra of extras) {
      const mock = mockOctokit(rustRepo({ ...RUST, ...extra }));
      const { deps } = harness(mock, { mode: 'strict' });
      expect(await prCheck(JOB, deps)).toBe('neutral');
      expect(runs(mock)[0]).toMatchObject({ conclusion: 'neutral', title: CANT_CHECK_TITLE });
      expect(mock.state.comments.size).toBe(0);
      expect(blobs(mock)).toEqual([]);
    }
  });

  it('a Rust repo whose pull request commits a .env: flagged as today, and the title says both', async () => {
    const mock = mockOctokit(rustRepo({ ...RUST, '.env': 'DATABASE_URL=postgres://x' }));
    const { deps, rows } = harness(mock, { mode: 'strict' });
    expect(await prCheck(JOB, deps)).toBe('failure');
    expect(rows[0]).toMatchObject({ committedEnvFiles: [{ path: '.env', added: true }] });
    expect(runs(mock)[0]).toMatchObject({
      conclusion: 'failure',
      title: "1 committed env file; deployhealth can't check env vars in this repo yet (no JS/TS, Python, Go, Ruby, PHP or Java/Kotlin files)",
    });
    const comment = [...mock.state.comments.values()][0]!.body;
    expect(comment).toContain('#### Committed env files');
    expect(comment).toContain("deployhealth reads JS/TS, Python, Go, Ruby, PHP and Java/Kotlin; Rust, C# and others aren't read yet");
    expect(blobs(mock)).toEqual([]);
  });

  it('a Rust repo whose pull request adds a secret-shaped string: flagged as today', async () => {
    const token = ['gh', 'p_', 'y'.repeat(36)].join('');
    const mock = mockOctokit(rustRepo(RUST, [{ filename: 'src/main.rs', patch: `@@ -0,0 +1 @@\n+let t = "${token}";` }]));
    const { deps, rows } = harness(mock);
    expect(await prCheck(JOB, deps)).toBe('neutral');
    expect(rows[0]).toMatchObject({ secretHits: 1 });
    expect(runs(mock)[0]!.title).toBe("1 possible secret; deployhealth can't check env vars in this repo yet (no JS/TS, Python, Go, Ruby, PHP or Java/Kotlin files)");
    expect(mock.state.comments.size).toBe(1);
    expect(JSON.stringify([...mock.state.comments.values(), ...runs(mock)])).not.toContain(token);
  });

  it('a JS repo whose pull request changes only README.md: the nothing-changed title, success, no comment', async () => {
    const mock = mockOctokit(repo({ commits: { base1: BASE, head1: { ...BASE, 'README.md': 'changed' } } }));
    const { deps } = harness(mock, { mode: 'strict' });
    expect(await prCheck(JOB, deps)).toBe('success');
    expect(runs(mock)[0]).toMatchObject({ conclusion: 'success', title: NOTHING_CHANGED_TITLE });
    expect(NOTHING_CHANGED_TITLE).toBe('No JS/TS, Python, Go, Ruby, PHP or Java/Kotlin files or env files changed');
    expect(runs(mock)[0]!.summary).toContain('Read 3 files (JS/TS 2, 1 env or config file)');
    expect(mock.state.comments.size).toBe(0);
    expect(blobs(mock)).toEqual([]);
  });

  it('a JS repo whose pull request changes only a .rs file: the nothing-changed title, counting the .rs file', async () => {
    const mock = mockOctokit(repo({ commits: { base1: BASE, head1: { ...BASE, 'tools/gen.rs': 'fn gen() {}' } } }));
    const { deps } = harness(mock);
    expect(await prCheck(JOB, deps)).toBe('success');
    expect(runs(mock)[0]!.title).toBe(NOTHING_CHANGED_TITLE);
    expect(runs(mock)[0]!.summary).toContain("This pull request also changed 1 .rs file, which deployhealth doesn't read yet.");
  });

  it('a JS repo whose pull request adds a secret in a .rs file: still flagged as today', async () => {
    const token = ['gh', 'p_', 'z'.repeat(36)].join('');
    const mock = mockOctokit(
      repo({
        commits: { base1: BASE, head1: { ...BASE, 'tools/gen.rs': 'fn gen() {}' } },
        pulls: { 42: { ...PR, author: 'octocat', files: [{ filename: 'tools/gen.rs', patch: `@@ -0,0 +1 @@\n+let t = "${token}";` }] } },
      }),
    );
    const { deps, rows } = harness(mock);
    expect(await prCheck(JOB, deps)).toBe('neutral');
    expect(rows[0]).toMatchObject({ secretHits: 1 });
    expect(runs(mock)[0]!.title).toBe('1 possible secret');
    expect([...mock.state.comments.values()][0]!.body).toContain('**1 possible secret in added lines**');
  });

  describe('a Laravel repo', () => {
    const LARAVEL = {
      artisan: '#!/usr/bin/env php',
      '.env.example': 'APP_KEY=\nBCRYPT_ROUNDS=12\n',
      'config/app.php': "<?php return ['key' => env('APP_KEY'), 'name' => env('APP_NAME', 'Laravel')];",
      'tests/Feature/HomeTest.php': "<?php env('TEST_ONLY');",
    };
    // Laravel's compiled views and cached config: never downloaded, whatever they read.
    const CACHES = {
      'storage/framework/views/0a1b.php': "<?php echo env('COMPILED_VIEW_VAR'); ?>",
      'bootstrap/cache/config.php': "<?php return ['k' => getenv('CACHED_CONFIG_VAR')];",
    };
    const laravelRepo = (base: Record<string, string>, head: Record<string, string>, files: Array<{ filename: string; patch?: string }>) =>
      repo({ commits: { base1: base, head1: head }, pulls: { 42: { ...PR, author: 'octocat', files } } });

    it('flags a new undeclared env() read, never downloads storage/ or bootstrap/cache, and fails in strict mode', async () => {
      const added = "<?php\nclass Pay { public function key() { return env('STRIPE_SECRET'); } }";
      const files = [{ filename: 'app/Services/Pay.php', patch: "@@ -0,0 +1 @@\n+return env('STRIPE_SECRET');" }];
      const withCaches = mockOctokit(laravelRepo({ ...LARAVEL, ...CACHES }, { ...LARAVEL, ...CACHES, 'app/Services/Pay.php': added }, files));
      const { deps, rows } = harness(withCaches, { mode: 'strict' });
      expect(await prCheck(JOB, deps)).toBe('failure');
      expect(runs(withCaches)[0]).toMatchObject({ conclusion: 'failure', title: '1 env var added (1 not in .env.example)' });
      expect(rows[0]!.undeclaredVars).toEqual(['STRIPE_SECRET']);
      expect(JSON.stringify([rows, ...withCaches.state.comments.values(), ...runs(withCaches)])).not.toMatch(/COMPILED_VIEW_VAR|CACHED_CONFIG_VAR|BCRYPT_ROUNDS/);
      const without = mockOctokit(laravelRepo(LARAVEL, { ...LARAVEL, 'app/Services/Pay.php': added }, files));
      await prCheck(JOB, harness(without, { mode: 'strict' }).deps);
      expect(blobs(withCaches)).toHaveLength(blobs(without).length);
    });

    it('a pull request that changes only storage/ and a .rs file: the nothing-changed title, no downloads', async () => {
      const head = { ...LARAVEL, ...CACHES, 'storage/framework/views/0a1b.php': "<?php echo env('NEW_COMPILED'); ?>", 'tools/gen.rs': 'fn gen() {}' };
      const mock = mockOctokit(laravelRepo({ ...LARAVEL, ...CACHES }, head, [{ filename: 'tools/gen.rs', patch: '@@ -0,0 +1 @@\n+fn gen() {}' }]));
      const { deps } = harness(mock, { mode: 'strict' });
      expect(await prCheck(JOB, deps)).toBe('success');
      expect(runs(mock)[0]).toMatchObject({ conclusion: 'success', title: NOTHING_CHANGED_TITLE });
      expect(runs(mock)[0]!.summary).toContain('Read 3 files (PHP 1, 2 env or config files)');
      expect(runs(mock)[0]!.summary).toContain("This pull request also changed 1 .rs file, which deployhealth doesn't read yet.");
      expect(mock.state.comments.size).toBe(0);
      expect(blobs(mock)).toEqual([]);
    });

    it('a clean pass names PHP', async () => {
      const head = { ...LARAVEL, 'config/app.php': "<?php return ['key' => env('APP_KEY'), 'name' => env('APP_NAME', 'Shop')];" };
      const mock = mockOctokit(laravelRepo(LARAVEL, head, [{ filename: 'config/app.php', patch: "@@ -1 +1 @@\n+'Shop'" }]));
      const { deps } = harness(mock);
      expect(await prCheck(JOB, deps)).toBe('success');
      expect(runs(mock)[0]!.title).toBe('Checked 3 files (PHP), 1 changed: no undeclared env vars');
    });
  });

  describe('a Spring Boot repo', () => {
    const SPRING = {
      'pom.xml': '<project/>',
      '.env.example': 'DATABASE_URL=\nSPRING_DATASOURCE_USERNAME=\n',
      'src/main/java/com/example/App.java':
        'import org.springframework.boot.SpringApplication;\nclass App { String url = System.getenv("DATABASE_URL"); }',
      'src/main/resources/application.properties': 'spring.datasource.url=${DATABASE_URL}\n',
      'src/test/java/com/example/AppTest.java': 'class AppTest { String v = System.getenv("TEST_ONLY"); }',
    };
    // Maven's build output: never downloaded, whatever it reads.
    const TARGET = { 'target/classes/application.properties': 'a=${TARGET_SECRET}\n', 'target/generated/Gen.java': 'class Gen { String v = System.getenv("TARGET_GEN"); }' };
    const springRepo = (base: Record<string, string>, head: Record<string, string>, files: Array<{ filename: string; patch?: string }>) =>
      repo({ commits: { base1: base, head1: head }, pulls: { 42: { ...PR, author: 'octocat', files } } });

    it('flags a new undeclared System.getenv, @Value and config placeholder; never downloads target/; strict fails', async () => {
      const head = {
        ...SPRING,
        ...TARGET,
        'src/main/java/com/example/Pay.java': 'class Pay { String k = System.getenv("STRIPE_SECRET"); @Value("${STRIPE_WEBHOOK}") String w; }',
        'src/main/resources/application.properties': 'spring.datasource.url=${DATABASE_URL}\npayments.url=${PAYMENTS_URL}\n',
      };
      const files = [{ filename: 'src/main/java/com/example/Pay.java', patch: '@@ -0,0 +1 @@\n+class Pay {}' }];
      const withTarget = mockOctokit(springRepo({ ...SPRING, ...TARGET }, head, files));
      const { deps, rows } = harness(withTarget, { mode: 'strict' });
      expect(await prCheck(JOB, deps)).toBe('failure');
      expect(rows[0]!.undeclaredVars).toEqual(['PAYMENTS_URL', 'STRIPE_SECRET', 'STRIPE_WEBHOOK']);
      expect(runs(withTarget)[0]).toMatchObject({ conclusion: 'failure', title: '3 env vars added (3 not in .env.example)' });
      expect(JSON.stringify([rows, ...withTarget.state.comments.values(), ...runs(withTarget)])).not.toMatch(/TARGET_SECRET|TARGET_GEN|SPRING_DATASOURCE_USERNAME/);
      const withoutTarget = mockOctokit(springRepo(SPRING, Object.fromEntries(Object.entries(head).filter(([p]) => !p.startsWith('target/'))), files));
      await prCheck(JOB, harness(withoutTarget, { mode: 'strict' }).deps);
      expect(blobs(withTarget)).toHaveLength(blobs(withoutTarget).length);
    });

    it('a pull request that changes only target/ and a .rs file: the nothing-changed title, no downloads', async () => {
      const head = { ...SPRING, ...TARGET, 'target/generated/Gen.java': 'class Gen { String v = System.getenv("NEW_GEN"); }', 'tools/gen.rs': 'fn gen() {}' };
      const mock = mockOctokit(springRepo({ ...SPRING, ...TARGET }, head, [{ filename: 'tools/gen.rs', patch: '@@ -0,0 +1 @@\n+fn gen() {}' }]));
      const { deps } = harness(mock, { mode: 'strict' });
      expect(await prCheck(JOB, deps)).toBe('success');
      expect(runs(mock)[0]).toMatchObject({ conclusion: 'success', title: NOTHING_CHANGED_TITLE });
      expect(runs(mock)[0]!.summary).toContain('Read 3 files (Java/Kotlin 1, 2 env or config files)');
      expect(runs(mock)[0]!.summary).toContain("This pull request also changed 1 .rs file, which deployhealth doesn't read yet.");
      expect(blobs(mock)).toEqual([]);
    });

    it('a clean pass names Java/Kotlin; a default makes a new read declared enough', async () => {
      const head = { ...SPRING, 'src/main/kotlin/com/example/Flags.kt': 'object Flags { val f = System.getenv("FEATURE_FLAG") ?: "off" }' };
      const mock = mockOctokit(springRepo(SPRING, head, [{ filename: 'src/main/kotlin/com/example/Flags.kt', patch: '@@ -0,0 +1 @@\n+object Flags' }]));
      const { deps } = harness(mock, { mode: 'strict' });
      expect(await prCheck(JOB, deps)).toBe('success');
      expect(runs(mock)[0]!.title).toBe('Checked 4 files (Java/Kotlin), 1 changed: no undeclared env vars');
    });
  });

  it('a clean pass says what it read, per language, and stays under 255 characters with every language', async () => {
    const all = { ...BASE, 'svc/main.go': 'package main', 'api/app.py': 'import os', 'lib/task.rb': 'puts 1', 'src/new.ts': 'export const x = 1;' };
    const mock = mockOctokit(repo({ commits: { base1: BASE, head1: all } }));
    const { deps } = harness(mock);
    expect(await prCheck(JOB, deps)).toBe('success');
    const run = runs(mock)[0]!;
    expect(run.title).toBe('Checked 7 files (JS/TS, Python, Go, Ruby), 4 changed: no undeclared env vars');
    expect(run.title.length).toBeLessThan(255);
    expect(run.summary).toContain('Read 7 files (JS/TS 3, Python 1, Go 1, Ruby 1, 1 env or config file), 4 changed in this pull request.');
  });

  it('keeps today\'s comment and conclusion for a pull request that adds an undeclared var', async () => {
    const mock = mockOctokit(repo());
    const { deps } = harness(mock, { mode: 'strict' });
    expect(await prCheck(JOB, deps)).toBe('failure');
    expect(runs(mock)[0]).toMatchObject({ conclusion: 'failure', title: '1 env var added (1 not in .env.example)' });
    expect([...mock.state.comments.values()][0]!.body).toContain('❌ **1 env var added (1 not in .env.example).**');
  });

  it('rewrites an earlier head\'s comment when a later head can\'t be checked, and never creates one', async () => {
    // An earlier head of this pull request got a comment; the current head holds no source file it reads.
    const mock = mockOctokit(rustRepo(RUST));
    mock.state.comments.set(7, { body: `${COMMENT_MARKER}\n⚠️ **1 env var added (1 not in .env.example).**`, bot: true, appId: MOCK_APP_ID });
    const { deps } = harness(mock);
    expect(await prCheck(JOB, deps)).toBe('neutral');
    expect([...mock.state.comments.keys()]).toEqual([7]);
    expect(mock.state.comments.get(7)!.body).toContain(`ℹ️ **${CANT_CHECK_TITLE}.**`);
    expect(mock.state.comments.get(7)!.body).not.toContain('env var added');
  });
});
