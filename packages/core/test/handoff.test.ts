import { describe, expect, it } from 'vitest';
import { formatInterval, formatPercent, formatUtc, plural } from '../src/format';
import { dotenvExample, findingAction, groupVariablesByScope, parseHandoffVariables, renderHandoffMarkdown, variableStatus, type HandoffData } from '../src/handoff';
import type { RequiredVariable } from '../src/types';

const at = (iso: string) => new Date(iso);
const v = (var_name: string, scope: string, defined_in: RequiredVariable['defined_in']): RequiredVariable => ({ var_name, scope, defined_in });

const VARIABLES = [
  v('STRIPE_KEY', 'apps/api', []),
  v('DATABASE_URL', 'apps/api', ['.env.example', '.env']),
  v('REDIS_URL', 'apps/api', []),
  v('NEXT_PUBLIC_API_URL', 'apps/web', ['.env.example']),
  v('LOG_LEVEL', '', ['.env.example', '.env', '.env.local']),
];

function data(overrides: Partial<HandoffData> = {}): HandoffData {
  return {
    generatedAt: at('2026-09-28T12:00:00Z'),
    project: { name: 'acme-storefront', repoFullName: 'acme/storefront' },
    client: { name: 'Acme Corp', contactEmail: 'ops@acme.example' },
    scan: { sha: 'b52952e0aa11', branch: 'main', deployedAt: at('2026-09-28T11:34:00Z'), variablesReported: true },
    variables: VARIABLES,
    envScopes: null,
    findings: [
      { kind: 'missing', var_name: 'REDIS_URL', file: 'apps/api/src/lib/cache.ts', line: 6, env_file: null },
      { kind: 'unused', var_name: 'S3_REGION', file: 'apps/worker/.env.example', line: 5, env_file: 'apps/worker/.env.example' },
    ],
    endpoints: [
      { label: 'Acme API', url: 'https://api.acme.example/health', method: 'GET', intervalSeconds: 60, expectedStatus: 200, enabled: true, uptime: 0.99937 },
      { label: 'example.net', url: 'https://example.net/', method: 'HEAD', intervalSeconds: 900, expectedStatus: 204, enabled: false, uptime: null },
    ],
    window: { from: at('2026-08-29T00:00:00Z'), to: at('2026-09-28T12:00:00Z') },
    uptime: 0.99937,
    alerts: [
      { endpoint: 'Acme API', openedAt: at('2026-09-28T11:39:00Z'), resolvedAt: null, paused: false, message: 'Acme API started failing | badly' },
      { endpoint: 'Acme API', openedAt: at('2026-09-20T08:00:00Z'), resolvedAt: at('2026-09-20T08:21:00Z'), paused: false, message: 'Acme API started failing' },
      { endpoint: 'Acme API', openedAt: at('2026-09-10T08:00:00Z'), resolvedAt: at('2026-09-10T08:12:00Z'), paused: true, message: 'Acme API started failing' },
    ],
    deployNotes: '### Railway\n\n1. Push to `main`.\n2. Watch the deploy.',
    actionSnippet: '# .github/workflows/deployhealth.yml\nname: deployhealth\n',
    ...overrides,
  };
}

describe('formatting', () => {
  it('rounds uptime down to two decimals, so one failure never shows as 100%', () => {
    expect([0.99937, 0.9994, 0.99999, 0.5, 0, 2 / 3].map(formatPercent)).toEqual(['99.93%', '99.94%', '99.99%', '50.00%', '0.00%', '66.66%']);
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(null)).toBe('no data');
  });

  it('formats UTC times, intervals and plurals', () => {
    expect(formatUtc(at('2026-09-28T09:04:59.999Z'))).toBe('2026-09-28 09:04 UTC');
    expect([60, 300, 900].map(formatInterval)).toEqual(['every minute', 'every 5 minutes', 'every 15 minutes']);
    expect([plural(1, 'project'), plural(3, 'project'), plural(0, 'incident')]).toEqual(['1 project', '3 projects', '0 incidents']);
  });
});

describe('groupVariablesByScope', () => {
  it('puts the repository root first, then scopes and names alphabetically', () => {
    expect(groupVariablesByScope(VARIABLES).map((g) => [g.label, g.variables.map((x) => x.var_name)])).toEqual([
      ['Repository root', ['LOG_LEVEL']],
      ['apps/api', ['DATABASE_URL', 'REDIS_URL', 'STRIPE_KEY']],
      ['apps/web', ['NEXT_PUBLIC_API_URL']],
    ]);
  });
});

describe('renderHandoffMarkdown', () => {
  const md = renderHandoffMarkdown(data());

  it('has every section, in order, and says times are UTC', () => {
    const headings = md.split('\n').filter((l) => l.startsWith('## '));
    expect(headings).toEqual([
      '## Required environment variables',
      '## Monitored endpoints',
      '## GitHub Action',
      '## Open findings',
      '## Uptime, last 30 days',
      '## Alerts, last 30 days',
      '## How to deploy',
    ]);
    expect(md).toContain('All times UTC.');
    expect(md).toContain('| Client | Acme Corp (ops@acme.example) |');
    expect(md).toContain('**2 variables missing.**');
  });

  it('flags missing variables and lists where the others are defined', () => {
    expect(md).toContain('| `REDIS_URL` | — | **missing** |');
    expect(md).toContain('| `DATABASE_URL` | `.env.example`, `.env` | ok |');
  });

  it('lists endpoints, alerts (escaped for tables) and the deploy notes verbatim', () => {
    expect(md).toContain('| Acme API | https://api.acme.example/health | GET every minute | 200 | 99.93% |');
    expect(md).toContain('| example.net | https://example.net/ | HEAD every 15 minutes (paused) | 204 | no data |');
    expect(md).toContain('| 2026-09-28 11:39 UTC | still open | 21m so far | Acme API started failing \\| badly |');
    expect(md).toContain('| 2026-09-20 08:00 UTC | 2026-09-20 08:21 UTC | 21m | Acme API started failing |');
    expect(md).toContain('| 2026-09-10 08:00 UTC | 2026-09-10 08:12 UTC | 12m (paused) | Acme API started failing |');
    expect(md).toContain('### Railway\n\n1. Push to `main`.');
    expect(md).toContain('```yaml\n# .github/workflows/deployhealth.yml\nname: deployhealth\n```');
  });

  it('says what to do about each open finding', () => {
    expect(md).toContain(
      '- `REDIS_URL`: referenced at apps/api/src/lib/cache.ts:6. Declare it in the .env.example for its code and set it on your host.',
    );
    expect(md).toContain('- `S3_REGION`: defined at apps/worker/.env.example:5, never referenced. Remove it from apps/worker/.env.example, or ignore it.');
    const scoped = renderHandoffMarkdown(data({ envScopes: [{ scope: '', env_files: ['.env'] }, { scope: 'apps/api', env_files: ['.env.example'] }] }));
    expect(scoped).toContain('Declare it in apps/api/.env.example and set it on your host.');
  });

  it('round-trips the required-variables list through parseHandoffVariables', () => {
    const expected = groupVariablesByScope(VARIABLES).flatMap((g) => g.variables);
    expect(parseHandoffVariables(md)).toEqual(expected);
    // Deploy notes can't inject rows: parsing stops at the next section.
    const sneaky = renderHandoffMarkdown(data({ deployNotes: '## Required environment variables\n\n### `x`\n\n| `FAKE` | — | **missing** |' }));
    expect(parseHandoffVariables(sneaky)).toEqual(expected);
  });

  it('round-trips the declaration file names 0.3.0 reads, in display order, and drops anything else', () => {
    const variables: RequiredVariable[] = [
      { var_name: 'APP_STORE_KEY', scope: '', defined_in: ['.env.example', '.env.sample', 'example.env', '.env.appStore.example'] },
    ];
    const rendered = renderHandoffMarkdown(data({ variables }));
    expect(parseHandoffVariables(rendered)).toEqual(variables);
    const tampered = rendered.replace('`.env.appStore.example`', '`.env.appStore.example`, `.env.staging`, `sk_live_1`');
    expect(parseHandoffVariables(tampered)).toEqual(variables);
  });

  it('explains scans from older CLIs, projects without variables and projects without scans', () => {
    const older = renderHandoffMarkdown(data({ scan: { ...data().scan!, variablesReported: false }, variables: [] }));
    expect(older).toContain('came from an older scan CLI');
    expect(parseHandoffVariables(older)).toEqual([]);
    expect(renderHandoffMarkdown(data({ variables: [] }))).toContain('The code references no environment variables.');
    expect(renderHandoffMarkdown(data({ scan: null, variables: [], findings: [] }))).toContain('No scans yet.');
    expect(renderHandoffMarkdown(data({ deployNotes: null }))).toContain('_No deploy notes yet._');
  });
});

describe('the quieter scan in the handoff (CLI 0.2.0+)', () => {
  const variables = [
    v('DEPLOY_KEY', '', []),
    { ...v('DEPLOY_TARGET', '', []), optional: true as const },
    v('STRIPE_KEY', 'apps/api', []),
    { ...v('PORT', 'apps/api', []), optional: true as const },
    v('DATABASE_URL', 'apps/api', ['.env.example', '.env.production']),
  ];
  const envScopes = [
    { scope: '', env_files: [] },
    { scope: 'apps/api', env_files: ['.env.example' as const, '.env.production' as const] },
  ];
  const md = renderHandoffMarkdown(data({ variables, envScopes, findings: [] }));

  it('gives each variable a status: ok, optional, no env file yet, or missing', () => {
    const bare = new Set(['']);
    expect(variables.map((x) => [x.var_name, variableStatus(x, bare)])).toEqual([
      ['DEPLOY_KEY', 'no-env-file'],
      ['DEPLOY_TARGET', 'optional'],
      ['STRIPE_KEY', 'missing'],
      ['PORT', 'optional'],
      ['DATABASE_URL', 'ok'],
    ]);
    expect(md).toContain('| `DEPLOY_KEY` | — | no env file yet |');
    expect(md).toContain('| `DEPLOY_TARGET` | — | optional (default in code) |');
    expect(md).toContain('| `STRIPE_KEY` | — | **missing** |');
    expect(md).toContain('| `DATABASE_URL` | `.env.example`, `.env.production` | ok |');
    expect(md).toContain('**1 variable missing.** 1 variable is in a scope with no env file yet;');
  });

  it('offers a starting .env.example, names only, under a scope with no env file', () => {
    expect(md).toContain(
      '### Repository root\n\n| Variable | Defined in | Status |\n| --- | --- | --- |\n| `DEPLOY_KEY` | — | no env file yet |\n| `DEPLOY_TARGET` | — | optional (default in code) |\n\n' +
        'No env file in this scope yet. A starting `.env.example` (names only):\n\n```dotenv\nDEPLOY_KEY=\n# optional: the code has a default\nDEPLOY_TARGET=\n```',
    );
    expect(md.match(/```dotenv/g)).toHaveLength(1); // only where no env file exists
    expect(dotenvExample([v('B', '', []), v('A', '', [])])).toBe('A=\nB=\n');
  });

  it('round-trips, optional flags included, and ignores the .env.example block', () => {
    expect(parseHandoffVariables(md)).toEqual(groupVariablesByScope(variables).flatMap((g) => g.variables));
  });

  it('shows older scans (no env scopes) exactly as before', () => {
    const older = renderHandoffMarkdown(data({ variables: [v('DEPLOY_KEY', '', [])], envScopes: null }));
    expect(older).toContain('| `DEPLOY_KEY` | — | **missing** |');
    expect(older).not.toContain('```dotenv');
  });
});

describe('findingAction', () => {
  const scopes = [
    { scope: '', env_files: ['.env.example' as const] },
    { scope: 'apps/api', env_files: ['.env.example' as const, '.env' as const] },
    { scope: 'apps/api-gateway', env_files: ['.env' as const] },
  ];

  it('MISSING: declare it in its scope\'s .env.example (the deepest scope containing the file)', () => {
    const missing = (file: string) => ({ kind: 'missing' as const, var_name: 'REDIS_URL', file, line: 6, env_file: null });
    expect(findingAction(missing('apps/api/src/cache.ts'), scopes)).toBe('Declare it in apps/api/.env.example and set it on your host');
    expect(findingAction(missing('apps/api-gateway/main.ts'), scopes)).toBe('Declare it in apps/api-gateway/.env.example and set it on your host');
    expect(findingAction(missing('scripts/seed.ts'), scopes)).toBe('Declare it in .env.example and set it on your host');
    // A scan from a CLI before 0.2.0 has no scopes.
    expect(findingAction(missing('apps/api/src/cache.ts'), null)).toBe('Declare it in the .env.example for its code and set it on your host');
  });

  it('UNUSED: remove it from its env file, or ignore it', () => {
    expect(findingAction({ kind: 'unused', var_name: 'OLD', file: 'apps/api/.env', line: 3, env_file: 'apps/api/.env' }, scopes)).toBe(
      'Remove it from apps/api/.env, or ignore it',
    );
  });

  it('MISMATCH: add it to the env file it is absent from', () => {
    const mismatch = (file: string, absent: string) => ({ kind: 'mismatch' as const, var_name: 'X', file, line: 1, env_file: absent });
    expect(findingAction(mismatch('apps/api/.env', 'apps/api/.env.example'), scopes)).toBe('Add it to apps/api/.env.example');
    expect(findingAction(mismatch('.env.example', '.env'), scopes)).toBe('Add it to .env');
  });
});
