import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PUBLISHED_CLI_VERSION } from '../src/constants';
import {
  generateToken,
  githubActionSnippet,
  hashToken,
  ingestPayloadSchema,
  MAX_FINDINGS,
  parseBearer,
  tokenHint,
} from '../src/ingest';
import { CLI_VERSION } from '../src/version';

const valid = {
  sha: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0',
  branch: 'main',
  timestamp: '2026-09-28T12:00:00Z',
  findings: [
    { kind: 'missing', var_name: 'API_KEY', file: 'src/a.ts', line: 3, env_file: null },
    { kind: 'unused', var_name: 'OLD', file: '.env.example', line: 2, env_file: '.env.example' },
    { kind: 'mismatch', var_name: 'X', file: '.env', line: 1, env_file: '.env.example' },
  ],
};

describe('ingestPayloadSchema', () => {
  it('accepts a well-formed payload, including offsets and short shas', () => {
    expect(ingestPayloadSchema.safeParse(valid).success).toBe(true);
    expect(ingestPayloadSchema.safeParse({ ...valid, sha: 'abc1234', timestamp: '2026-09-28T17:30:00+05:30' }).success).toBe(
      true,
    );
    expect(ingestPayloadSchema.safeParse({ ...valid, findings: [] }).success).toBe(true);
  });

  it.each([
    ['non-hex sha', { sha: 'not-a-sha' }],
    ['too-short sha', { sha: 'abc12' }],
    ['empty branch', { branch: '' }],
    ['date without time', { timestamp: '2026-09-28' }],
    ['unknown kind', { findings: [{ ...valid.findings[0], kind: 'bogus' }] }],
    ['line 0', { findings: [{ ...valid.findings[0], line: 0 }] }],
    ['missing var_name', { findings: [{ kind: 'missing', file: null, line: null, env_file: null }] }],
  ])('rejects %s', (_label, override) => {
    expect(ingestPayloadSchema.safeParse({ ...valid, ...override }).success).toBe(false);
  });

  it('accepts variables as names plus env file names, and payloads from older CLIs without them', () => {
    const variables = [
      { var_name: 'DATABASE_URL', scope: '', defined_in: ['.env.example', '.env'] },
      { var_name: 'REDIS_URL', scope: 'apps/api', defined_in: [] },
    ];
    expect(ingestPayloadSchema.parse({ ...valid, variables }).variables).toEqual(variables);
    expect(ingestPayloadSchema.parse(valid).variables).toBeUndefined();
  });

  it.each([
    ['a value smuggled into the name', { var_name: 'STRIPE_KEY=sk_live_123', scope: '', defined_in: [] }],
    ['a name with spaces', { var_name: 'STRIPE KEY', scope: '', defined_in: [] }],
    ['a name starting with a digit', { var_name: '1KEY', scope: '', defined_in: [] }],
    ['a value in defined_in', { var_name: 'STRIPE_KEY', scope: '', defined_in: ['sk_live_123'] }],
    ['an unknown env file', { var_name: 'STRIPE_KEY', scope: '', defined_in: ['.env.staging'] }],
  ])('rejects variables with %s', (_label, variable) => {
    expect(ingestPayloadSchema.safeParse({ ...valid, variables: [variable] }).success).toBe(false);
  });

  it('still accepts exactly what the 0.1.0 CLI sends (no optional flags, no env scopes)', () => {
    const v010 = { ...valid, variables: [{ var_name: 'DATABASE_URL', scope: '', defined_in: ['.env.example', '.env'] }] };
    const parsed = ingestPayloadSchema.parse(v010);
    expect(parsed.env_scopes).toBeUndefined();
    expect(parsed.variables).toEqual(v010.variables);
    expect(parsed.variables![0]).not.toHaveProperty('optional');
  });

  it('accepts 0.2.0 payloads: the newer env file names, optional variables and env scopes', () => {
    const variables = [
      { var_name: 'PROD_DB_URL', scope: 'apps/api', defined_in: ['.env.production', '.env.test.local'] },
      { var_name: 'PORT', scope: 'apps/api', defined_in: [], optional: true },
    ];
    const env_scopes = [
      { scope: '', env_files: [] },
      { scope: 'apps/api', env_files: ['.env.example', '.env.development', '.env.production'] },
    ];
    const parsed = ingestPayloadSchema.parse({ ...valid, variables, env_scopes });
    expect(parsed.variables).toEqual(variables);
    expect(parsed.env_scopes).toEqual(env_scopes);
  });

  it('drops fields it does not know, so a newer CLI never breaks an older server on them', () => {
    const parsed = ingestPayloadSchema.parse({ ...valid, some_future_field: [1], variables: [{ var_name: 'A', scope: '', defined_in: [], later: true }] });
    expect(parsed).not.toHaveProperty('some_future_field');
    expect(parsed.variables![0]).toEqual({ var_name: 'A', scope: '', defined_in: [] });
  });

  it.each([
    ['an unknown env file', [{ scope: '', env_files: ['.env.staging'] }]],
    ['a value instead of an env file', [{ scope: '', env_files: ['sk_live_123'] }]],
    ['too many scopes', Array.from({ length: 1001 }, (_, i) => ({ scope: `s${i}`, env_files: [] }))],
  ])('rejects env scopes with %s', (_label, env_scopes) => {
    expect(ingestPayloadSchema.safeParse({ ...valid, env_scopes }).success).toBe(false);
  });

  it('caps the number of findings', () => {
    const findings = Array.from({ length: MAX_FINDINGS + 1 }, () => valid.findings[0]);
    expect(ingestPayloadSchema.safeParse({ ...valid, findings }).success).toBe(false);
  });
});

describe('tokens', () => {
  it('generates distinct dh_ tokens with 256 bits of randomness', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).toMatch(/^dh_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('hashes deterministically to hex SHA-256', () => {
    expect(hashToken('dh_abc')).toBe(hashToken('dh_abc'));
    expect(hashToken('dh_abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('dh_abc')).not.toBe(hashToken('dh_abd'));
  });

  it('shows only the last four characters in the hint', () => {
    expect(tokenHint('dh_0123456789WXYZ')).toBe('dh_…WXYZ');
  });

  it('parses bearer headers and rejects anything else', () => {
    expect(parseBearer('Bearer dh_abc')).toBe('dh_abc');
    expect(parseBearer('bearer   dh_abc  ')).toBe('dh_abc');
    expect(parseBearer('Bearer other_abc')).toBeNull();
    expect(parseBearer('Basic dh_abc')).toBeNull();
    expect(parseBearer('Bearer dh_a dh_b')).toBeNull();
    expect(parseBearer(null)).toBeNull();
  });
});

describe('githubActionSnippet', () => {
  it('runs the pinned npm release with the token from a repo secret, and passes sha and branch', () => {
    const yaml = githubActionSnippet({ appUrl: 'https://dh.example.com/' });
    expect(yaml).toContain(`npx --yes deployhealth-scan@${PUBLISHED_CLI_VERSION} \\\n            --url https://dh.example.com \\`);
    expect(yaml).toContain('DEPLOYHEALTH_TOKEN: ${{ secrets.DEPLOYHEALTH_TOKEN }}');
    expect(yaml).toContain('--token "$DEPLOYHEALTH_TOKEN"');
    expect(yaml).toContain('--sha "$GITHUB_SHA"');
    expect(yaml).toContain('--branch "$GITHUB_REF_NAME"');
    expect(yaml).toContain('branches: [main]');
    expect(yaml).not.toContain('dh.example.com//');
    expect(yaml).not.toContain('curl');
  });

  it('is read-only and safe to paste: job-level contents: read, no expressions in the script, no forks', () => {
    const yaml = githubActionSnippet({ appUrl: 'https://dh.example.com' });
    expect(yaml).toContain('  env-scan:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n');
    expect(yaml).toContain('persist-credentials: false');
    // setup-node v5 would otherwise look for pnpm/yarn in repos whose package.json pins one, and fail.
    expect(yaml).toContain('node-version: 22\n          package-manager-cache: false\n');
    expect(yaml).toMatch(/^# Must not run on pull_request events from forks/m);
    expect(yaml).not.toMatch(/^\s*pull_request/m);
    const script = yaml.slice(yaml.indexOf('run: |'));
    expect(script).not.toContain('${{');
  });

  it('pins the version this repo dogfoods, which is a real release', () => {
    expect(PUBLISHED_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    const workflow = readFileSync(fileURLToPath(new URL('../../../.github/workflows/deployhealth.yml', import.meta.url)), 'utf8');
    expect(workflow).toContain(`npx --yes deployhealth-scan@${PUBLISHED_CLI_VERSION} \\`);
    // The source version can run ahead of the published one while a release is pending, never behind.
    const rank = (v: string) => v.split('.').reduce((n, part) => n * 1000 + Number(part), 0);
    expect(rank(CLI_VERSION)).toBeGreaterThanOrEqual(rank(PUBLISHED_CLI_VERSION));
  });

  it('uses the given branch', () => {
    expect(githubActionSnippet({ appUrl: 'http://localhost:3000', branch: 'release' })).toContain('branches: [release]');
  });
});
