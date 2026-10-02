import { scanFiles } from '@deployhealth/core';
import { describe, expect, it } from 'vitest';
import { detectAgent } from '../src/pr-check/agents';
import { committedEnvFiles, diffEnvVars, isCommittableSecretEnvFile } from '../src/pr-check/diff';
import {
  checkRunOutput,
  COMMENT_MARKER,
  conclusionFor,
  emptyReport,
  fitLines,
  MAX_GITHUB_TEXT,
  renderComment,
  shorten,
  worthCommenting,
  type PrReport,
} from '../src/pr-check/report';
import { addedLines, findSecrets } from '../src/pr-check/secrets';

// Built indirectly so neither deployhealth's own scanner nor secret scanners read test data as real.
const ENV = ['process', 'env'].join('.');
const fake = (...parts: string[]) => parts.join('');

const scan = (files: Record<string, string>) => scanFiles(new Map(Object.entries(files)));

describe('diffEnvVars on fixture trees', () => {
  const BASE = {
    '.env.example': 'DATABASE_URL=\nOLD_FLAG=\nMAILER_KEY=\n',
    'src/db.ts': `const url = ${ENV}.DATABASE_URL;`,
    'src/mail.ts': `export const key = ${ENV}.MAILER_KEY;\nexport const host = ${ENV}.MAIL_HOST;`,
    'src/flags.ts': `if (${ENV}.OLD_FLAG) enable();`,
    'apps/admin/.env.example': 'ADMIN_TOKEN=\n',
    'apps/admin/index.ts': `auth(${ENV}.ADMIN_TOKEN);`,
  };
  const HEAD = {
    ...BASE,
    '.env.example': 'DATABASE_URL=\nOLD_FLAG=\nMAILER_KEY=\nREDIS_URL=\n',
    // MAILER_KEY renamed to MAIL_API_KEY in the same file; MAIL_HOST stays.
    'src/mail.ts': `export const key = ${ENV}.MAIL_API_KEY;\nexport const host = ${ENV}.MAIL_HOST;`,
    // OLD_FLAG no longer read anywhere.
    'src/flags.ts': 'enable();',
    // Two new variables: one declared at the root, one not.
    'src/cache.ts': `connect(${ENV}.REDIS_URL);\nconst t = ${ENV}.CACHE_TTL;\nconst again = ${ENV}.CACHE_TTL;`,
    // A variable declared at the root but read from a scope whose .env.example lacks it.
    'apps/admin/stripe.ts': `pay(${ENV}.REDIS_URL);`,
  };

  it('finds added (declared or not), removed and renamed variables, with file:line', async () => {
    const diff = diffEnvVars(await scan(BASE), await scan(HEAD));
    expect(diff.added).toEqual([
      { name: 'CACHE_TTL', refs: [{ file: 'src/cache.ts', line: 2 }, { file: 'src/cache.ts', line: 3 }], total: 2, declared: false },
      // Declared at the root, but apps/admin reads it too and its .env.example doesn't list it.
      { name: 'REDIS_URL', refs: [{ file: 'apps/admin/stripe.ts', line: 1 }, { file: 'src/cache.ts', line: 1 }], total: 2, declared: false },
    ]);
    expect(diff.removed).toEqual([{ name: 'OLD_FLAG', refs: [{ file: 'src/flags.ts', line: 1 }], total: 1 }]);
    expect(diff.renamed).toEqual([{ from: 'MAILER_KEY', to: 'MAIL_API_KEY', file: 'src/mail.ts', line: 1, declared: false }]);
    expect(diff.undeclared).toEqual(['CACHE_TTL', 'MAIL_API_KEY', 'REDIS_URL']);
  });

  it('declares a variable once every scope reading it lists it; unchanged code produces no diff', async () => {
    const head = { ...HEAD, 'apps/admin/.env.example': 'ADMIN_TOKEN=\nREDIS_URL=\n', '.env.example': `${HEAD['.env.example']}MAIL_API_KEY=\nCACHE_TTL=\n` };
    const diff = diffEnvVars(await scan(BASE), await scan(head));
    expect(diff.undeclared).toEqual([]);
    expect(diff.added.every((a) => a.declared)).toBe(true);
    expect(diffEnvVars(await scan(BASE), await scan(BASE))).toEqual({ added: [], removed: [], renamed: [], undeclared: [] });
  });

  it('counts any declaration file as declaring (.env.sample, .env.<name>.example), but not .env or .env.local', async () => {
    const head = {
      ...BASE,
      'src/store.ts': `${ENV}.APP_STORE_KEY;\n${ENV}.SAMPLE_KEY;\n${ENV}.LOCAL_ONLY;`,
      '.env.appStore.example': 'APP_STORE_KEY=\n',
      '.env.sample': 'SAMPLE_KEY=\n',
      '.env.local': 'LOCAL_ONLY=x\n',
    };
    const diff = diffEnvVars(await scan(BASE), await scan(head));
    expect(diff.added.map((a) => [a.name, a.declared])).toEqual([
      ['APP_STORE_KEY', true],
      ['LOCAL_ONLY', false],
      ['SAMPLE_KEY', true],
    ]);
  });

  it('treats a variable with a default wherever it is read as declared, and skips platform names', async () => {
    const head = {
      ...BASE,
      'src/cache.ts': `const ttl = ${ENV}.CACHE_TTL ?? 60;\nconst again = ${ENV}.CACHE_TTL || 60;\nconst sha = ${ENV}.GITHUB_SHA;`,
      'src/queue.ts': `const q = ${ENV}.QUEUE_NAME ?? 'jobs';\nconst other = ${ENV}.QUEUE_NAME;`,
    };
    const diff = diffEnvVars(await scan(BASE), await scan(head));
    expect(diff.added.map((a) => [a.name, a.declared])).toEqual([
      ['CACHE_TTL', true], // a default at every read
      ['QUEUE_NAME', false], // one read has no default
    ]);
    expect(diff.undeclared).toEqual(['QUEUE_NAME']);
  });

  it('lists a line that reads a variable twice once in the comment', async () => {
    const diff = diffEnvVars(await scan({ 'a.ts': '' }), await scan({ 'a.ts': `const r = ${ENV}.TWICE ? ${ENV}.TWICE : 'eu';` }));
    expect(diff.added).toEqual([{ name: 'TWICE', refs: [{ file: 'a.ts', line: 1 }], total: 1, declared: false }]);
  });

  it('stores at most 20 references per variable but keeps the total', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `${ENV}.BUSY_VAR // ${i}`).join('\n');
    const diff = diffEnvVars(await scan({ 'a.ts': '' }), await scan({ 'a.ts': many }));
    expect(diff.added[0]).toMatchObject({ name: 'BUSY_VAR', total: 30 });
    expect(diff.added[0]!.refs).toHaveLength(20);
  });
});

describe('committed env files', () => {
  it('flags .env, .env.local and .env.*.local that the pull request adds or changes, never .env.example', () => {
    expect(['.env', 'a/.env.local', '.env.production.local', 'x/.env'].every(isCommittableSecretEnvFile)).toBe(true);
    expect(['.env.example', '.env.production', 'env', '.envrc', 'x/.env.sample'].some(isCommittableSecretEnvFile)).toBe(false);
    const base = [{ path: '.env', sha: 'a' }, { path: 'fixtures/.env', sha: 'f' }];
    const head = [{ path: '.env', sha: 'b' }, { path: 'fixtures/.env', sha: 'f' }, { path: 'web/.env.local', sha: 'c' }, { path: '.env.example', sha: 'd' }];
    expect(committedEnvFiles(base, head)).toEqual([
      { path: '.env', added: false },
      { path: 'web/.env.local', added: true },
    ]);
  });
});

describe('secrets in added lines', () => {
  const samples: Record<string, string> = {
    'aws-access-key-id': fake('AKIA', 'IOSFODNN7EXAMPLE'),
    'github-token': fake('gh', 'p_', 'a'.repeat(36)),
    'slack-token': fake('xox', 'b-', '123456789012-abcdefghij'),
    'slack-webhook': fake('https://hooks.', 'slack.com/services/', 'T0000000/B0000000/', 'x'.repeat(24)),
    'private-key': fake('-----BEGIN ', 'RSA PRIVATE', ' KEY-----'),
    'deployhealth-token': fake('dh', '_', 'A'.repeat(43)),
  };
  const patch = (lines: string[]) => ['@@ -10,3 +10,4 @@ context', ...lines].join('\n');

  it('reads added lines with their new line numbers, skipping removed and context lines', () => {
    const p = ['@@ -1,3 +1,3 @@', ' keep', '-gone', '+new one', ' keep', '@@ -20,2 +20,3 @@', ' ctx', '+added a', '+added b', '\\ No newline at end of file'].join('\n');
    expect(addedLines(p)).toEqual([
      { line: 2, text: 'new one' },
      { line: 21, text: 'added a' },
      { line: 22, text: 'added b' },
    ]);
  });

  it('matches every rule on added lines only, and records where, never the value', () => {
    for (const [rule, value] of Object.entries(samples)) {
      const hits = findSecrets([{ filename: 'config/app.ts', patch: patch([' context', `+const x = "${value}";`]) }]);
      expect(hits, rule).toEqual([{ rule, file: 'config/app.ts', line: 11 }]);
      expect(JSON.stringify(hits)).not.toContain(value);
      // The same value on a removed or context line is not reported.
      expect(findSecrets([{ filename: 'a', patch: patch([`-${value}`, ` ${value}`]) }]), rule).toEqual([]);
    }
    expect(findSecrets([{ filename: 'bin.png' }])).toEqual([]);
    expect(findSecrets([{ filename: 'a.ts', patch: patch([`+const token = ${ENV}.GITHUB_TOKEN;`, '+// see -----BEGIN (?:RSA )?PRIVATE KEY----- docs']) }])).toEqual([]);
  });
});

describe('detectAgent', () => {
  it('knows coding agents by their PR author login, and not dependency bots or people', () => {
    const cases: Array<[string, string | null]> = [
      ['Copilot', 'Copilot'],
      ['copilot-swe-agent[bot]', 'Copilot'],
      ['chatgpt-codex-connector[bot]', 'Codex'],
      ['claude[bot]', 'Claude'],
      ['devin-ai-integration[bot]', 'Devin'],
      ['cursor[bot]', 'Cursor'],
      ['sweep-ai[bot]', 'Sweep'],
      ['dependabot[bot]', null],
      ['renovate[bot]', null],
      ['claudia-dev', null],
      ['octocat', null],
    ];
    for (const [login, name] of cases) expect(detectAgent(login, []), login).toEqual({ isAgent: name !== null, name });
  });

  it('also finds them in Co-Authored-By trailers', () => {
    const commit = (trailer: string) => `feat: add caching\n\nLonger body.\n\n${trailer}`;
    expect(detectAgent('octocat', [commit('Co-Authored-By: Claude <noreply@anthropic.com>')])).toEqual({ isAgent: true, name: 'Claude' });
    expect(detectAgent('octocat', ['wip', commit('Co-authored-by: Cursor Agent <cursoragent@cursor.com>')])).toEqual({ isAgent: true, name: 'Cursor' });
    expect(detectAgent('octocat', [commit('co-authored-by: devin-ai-integration[bot] <158243242+devin-ai-integration[bot]@users.noreply.github.com>')]).name).toBe('Devin');
    expect(detectAgent('octocat', [commit('Co-authored-by: Mona Lisa <mona@example.com>'), 'mentions Claude in the subject only'])).toEqual({ isAgent: false, name: null });
    expect(detectAgent('dependabot[bot]', [commit('Co-authored-by: Copilot <x@y>')])).toEqual({ isAgent: false, name: null });
  });
});

describe('conclusions and the comment', () => {
  const report = (overrides: Partial<PrReport> = {}): PrReport => ({ ...emptyReport(), ...overrides });
  const undeclared = report({
    added: [{ name: 'CACHE_TTL', refs: [{ file: 'src/cache.ts', line: 2 }], total: 3, declared: false }],
    undeclared: ['CACHE_TTL'],
  });

  it('is success with nothing to flag, neutral in comment mode, failure in strict mode, neutral when too large', () => {
    const declaredOnly = report({ added: [{ name: 'X', refs: [{ file: 'a.ts', line: 1 }], total: 1, declared: true }] });
    for (const mode of ['comment', 'strict'] as const) expect(conclusionFor(declaredOnly, mode)).toBe('success');
    expect(conclusionFor(undeclared, 'comment')).toBe('neutral');
    expect(conclusionFor(undeclared, 'strict')).toBe('failure');
    expect(conclusionFor(report({ envFiles: [{ path: '.env', added: true }] }), 'strict')).toBe('failure');
    expect(conclusionFor(report({ secrets: [{ rule: 'github-token', file: 'a', line: 1 }] }), 'comment')).toBe('neutral');
    expect(conclusionFor(emptyReport('This pull request needs more than 2000 files; too large to check.'), 'strict')).toBe('neutral');
  });

  it('renders one marked comment with tables and file:line, never values', () => {
    const body = renderComment(
      report({
        ...undeclared,
        removed: [{ name: 'OLD_FLAG', refs: [{ file: 'src/flags.ts', line: 1 }], total: 1 }],
        renamed: [{ from: 'MAILER_KEY', to: 'MAIL_API_KEY', file: 'src/mail.ts', line: 1, declared: true }],
        envFiles: [{ path: 'web/.env.local', added: true }],
        secrets: [{ rule: 'github-token', file: 'config/app.ts', line: 11 }],
      }),
      { mode: 'comment', headSha: '0123456789abcdef' },
    );
    expect(body.startsWith(`${COMMENT_MARKER}\n### deployhealth · env check\n`)).toBe(true);
    expect(body).toContain('⚠️ **1 env var added (1 not in .env.example), 1 removed, 1 renamed, 1 committed env file, 1 possible secret.**');
    expect(body).toContain('| `CACHE_TTL` | `src/cache.ts:2` (+2 more) | ❌ **not declared** |');
    expect(body).toContain('| `MAILER_KEY` | `MAIL_API_KEY` | `src/mail.ts:1` | ✅ declared |');
    expect(body).toContain('| `OLD_FLAG` | `src/flags.ts:1` |');
    expect(body).toContain('| `web/.env.local` | added in this pull request |');
    expect(body).toContain('**1 possible secret in added lines** (see the `deployhealth / env` check run for where).');
    expect(body).not.toContain('config/app.ts'); // secret locations go to the check run only
    expect(body).toContain('Checked `0123456`');
  });

  it('escapes file names that could break the table, and truncates long tables', () => {
    const odd = report({ added: [{ name: 'X', refs: [{ file: 'we|ird`name.ts', line: 1 }], total: 1, declared: true }] });
    expect(renderComment(odd, { mode: 'comment', headSha: 'abc' })).toContain('| `X` | `` we\\|ird`name.ts:1 `` | ✅ declared |');
    const many = report({ removed: Array.from({ length: 60 }, (_, i) => ({ name: `V${i}`, refs: [{ file: 'a.ts', line: i + 1 }], total: 1 })) });
    const body = renderComment(many, { mode: 'comment', headSha: 'abc' });
    expect(body).toContain('…and 10 more.');
    expect(body.match(/^\| `V\d+`/gm)).toHaveLength(50);
  });

  it('comments only when there is something to say; the check run lists secret locations', () => {
    expect(worthCommenting(emptyReport())).toBe(false);
    expect(worthCommenting(emptyReport('too large'))).toBe(true);
    expect(worthCommenting(report({ removed: [{ name: 'X', refs: [{ file: 'a', line: 1 }], total: 1 }] }))).toBe(true);
    const output = checkRunOutput(report({ secrets: [{ rule: 'aws-access-key-id', file: 'infra/main.tf', line: 4 }] }), 'neutral');
    expect(output).toMatchObject({ conclusion: 'neutral', title: '1 possible secret' });
    expect(output.text).toContain('- `infra/main.tf:4` AWS access key ID');
    expect(checkRunOutput(emptyReport(), 'success')).toEqual({ conclusion: 'success', title: 'No env var changes', summary: 'No env var changes.', text: undefined });
  });
});

describe("GitHub's size limits", () => {
  const GITHUB_LIMIT = 65_535;
  const longPath = `${'deep/'.repeat(1_000)}file.ts`;
  const longName = `VAR_${'X'.repeat(5_000)}`;
  const many = (n: number) => Array.from({ length: n }, (_, i) => `NAME_${i}`);

  it('keeps the comment, check run summary, text and title within the limits, saying how many more there were', () => {
    const names = many(150_000);
    const report: PrReport = {
      ...emptyReport(),
      added: [{ name: longName, refs: [{ file: longPath, line: 1 }], total: 3, declared: false }, ...names.map((n) => ({ name: n, refs: [{ file: longPath, line: 2 }], total: 1, declared: false }))],
      removed: names.map((n) => ({ name: `OLD_${n}`, refs: [{ file: longPath, line: 3 }], total: 1 })),
      renamed: names.slice(0, 500).map((n) => ({ from: `A_${n}`, to: `B_${n}`, file: longPath, line: 4, declared: false })),
      undeclared: [longName, ...names],
      envFiles: names.slice(0, 5_000).map((n) => ({ path: `${longPath}/${n}/.env`, added: true })),
      secrets: names.slice(0, 5_000).map((n, i) => ({ rule: 'github-token', file: `${longPath}/${n}`, line: i })),
    };
    const comment = renderComment(report, { mode: 'strict', headSha: 'a'.repeat(40) });
    const output = checkRunOutput(report, 'failure');
    for (const text of [comment, output.summary, output.text!]) expect(text.length).toBeLessThan(GITHUB_LIMIT);
    expect(output.title.length).toBeLessThanOrEqual(255);
    expect(comment).toContain('…and 149951 more.');
    expect(comment).toContain('names and file:line only'); // the footer survives
    expect(output.summary).toContain('and 149981 more.');
    expect(output.text).toContain('- …and 149001 more');
    expect(comment).not.toContain(longPath);
    expect(comment).toContain(shorten(longPath, 160));
    expect(comment).not.toContain(longName);
  });

  it('cuts at whole lines with a note, keeping the tail', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i} ${'x'.repeat(90)}`);
    const out = fitLines(lines, 2_000, ['', 'TAIL']);
    expect(out.length).toBeLessThanOrEqual(2_000);
    expect(out.endsWith('\nTAIL')).toBe(true);
    expect(out).toMatch(/…and \d+ more lines, cut to fit GitHub's limit\./);
    expect(fitLines(['short'], MAX_GITHUB_TEXT, ['t'])).toBe('short\nt');
  });

  it('shortens long paths around an ellipsis, keeping the end', () => {
    const short = shorten(longPath, 160);
    expect(short).toHaveLength(160);
    expect(short.endsWith('/file.ts')).toBe(true);
    expect(short).toContain('…');
    expect(shorten('src/a.ts', 160)).toBe('src/a.ts');
  });
});

