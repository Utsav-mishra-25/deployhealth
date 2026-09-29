import { describe, expect, it } from 'vitest';
import {
  generateToken,
  githubActionSnippet,
  hashToken,
  ingestPayloadSchema,
  MAX_FINDINGS,
  parseBearer,
  tokenHint,
} from '../src/ingest';

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
    ['an unknown env file', { var_name: 'STRIPE_KEY', scope: '', defined_in: ['.env.production'] }],
  ])('rejects variables with %s', (_label, variable) => {
    expect(ingestPayloadSchema.safeParse({ ...valid, variables: [variable] }).success).toBe(false);
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
  it('points at the app, reads the token from a repo secret and passes sha and branch', () => {
    const yaml = githubActionSnippet({ appUrl: 'https://dh.example.com/' });
    expect(yaml).toContain('curl -fsSL https://dh.example.com/deployhealth-scan.mjs -o "$RUNNER_TEMP/deployhealth-scan.mjs"');
    expect(yaml).toContain('--url https://dh.example.com \\');
    expect(yaml).toContain('DEPLOYHEALTH_TOKEN: ${{ secrets.DEPLOYHEALTH_TOKEN }}');
    expect(yaml).toContain('--token "$DEPLOYHEALTH_TOKEN"');
    expect(yaml).toContain('--sha "${{ github.sha }}"');
    expect(yaml).toContain('--branch "${{ github.ref_name }}"');
    expect(yaml).toContain('branches: [main]');
    expect(yaml).not.toContain('dh.example.com//');
  });

  it('uses the given branch', () => {
    expect(githubActionSnippet({ appUrl: 'http://localhost:3000', branch: 'release' })).toContain('branches: [release]');
  });
});
