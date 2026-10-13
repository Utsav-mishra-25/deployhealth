import { describe, expect, it } from 'vitest';
import { compareProjects, projectStatus, statusSummary, worstStatusRank, type ProjectStatus, type StatusInput } from '@/lib/project-status';

const NOW = new Date('2026-10-13T12:00:00Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

/** A scanned, quiet project with endpoints that are up. */
const base: StatusInput = {
  counts: { missing: 0, unused: 0, mismatch: 0 },
  uptime: 'up',
  failingSince: null,
  failingEndpoints: [],
  openPrsWithUndeclared: 0,
  openPrsWithEnvFiles: 0,
  openPrsWithSecrets: 0,
  latestScanAt: ago(120),
  latestPrCheckAt: null,
  undeclaredInBareScopes: 0,
};

const status = (overrides: Partial<StatusInput>) => projectStatus({ ...base, ...overrides }, NOW);
const texts = (overrides: Partial<StatusInput>) => status(overrides).reasons.map((r) => r.text);

describe('projectStatus', () => {
  it('Down: an open alert, whatever else is true, with the endpoint and how long', () => {
    const view = status({ uptime: 'down', failingSince: ago(21), failingEndpoints: ['Acme API'], counts: { missing: 2, unused: 0, mismatch: 0 } });
    expect(view.status).toBe('down');
    expect(view.reasons.map((r) => r.text)).toEqual(['Acme API down for 21m', '2 missing']);
    expect(view.reasons[0]!.anchor).toBe('endpoints');
    expect(texts({ uptime: 'down', failingSince: ago(5), failingEndpoints: ['A', 'B', 'C'] })).toEqual(['A +2 more down for 5m']);
  });

  it('Needs attention: MISSING or MISMATCH in the latest scan', () => {
    expect(status({ counts: { missing: 2, unused: 0, mismatch: 1 } })).toMatchObject({ status: 'attention' });
    expect(texts({ counts: { missing: 2, unused: 0, mismatch: 1 } })).toEqual(['2 missing', '1 mismatch']);
    expect(status({ counts: { missing: 0, unused: 0, mismatch: 1 } }).status).toBe('attention');
  });

  it('Needs attention: an open pull request flagged undeclared env vars, an env file or a secret', () => {
    expect(status({ openPrsWithUndeclared: 1 })).toMatchObject({ status: 'attention', reasons: [{ text: '1 open PR adds undeclared env vars', anchor: 'pull-requests' }] });
    expect(texts({ openPrsWithUndeclared: 2 })).toEqual(['2 open PRs add undeclared env vars']);
    expect(texts({ openPrsWithEnvFiles: 1 })).toEqual(['1 open PR commits an env file']);
    expect(texts({ openPrsWithEnvFiles: 3 })).toEqual(['3 open PRs commit env files']);
    expect(texts({ openPrsWithSecrets: 1 })).toEqual(['1 open PR adds a secret-shaped string']);
    expect(status({ openPrsWithSecrets: 1, latestScanAt: null, latestPrCheckAt: ago(3) }).status).toBe('attention');
  });

  it('Needs attention: a scope with no env file that reads non-optional variables', () => {
    expect(status({ undeclaredInBareScopes: 3 })).toMatchObject({ status: 'attention', reasons: [{ text: 'no .env.example: 3 vars undeclared' }] });
    expect(texts({ undeclaredInBareScopes: 1 })).toEqual(['no .env.example: 1 var undeclared']);
  });

  it('Needs attention, not Down: an endpoint failing with no alert yet', () => {
    expect(status({ uptime: 'degraded', failingSince: ago(1), failingEndpoints: ['Shop'] })).toMatchObject({
      status: 'attention',
      reasons: [{ text: 'Shop failing for 1m', anchor: 'endpoints' }],
    });
  });

  it('Not set up: no scan and no pull request check yet, even with endpoints up', () => {
    const view = status({ counts: null, latestScanAt: null, latestPrCheckAt: null });
    expect(view).toEqual({ status: 'not_set_up', reasons: [{ text: 'No scan or pull request check yet' }], checkedAt: null });
    expect(status({ counts: null, latestScanAt: null, uptime: 'no_endpoints' }).status).toBe('not_set_up');
  });

  it('Healthy: nothing to list, checked at the later of the latest scan and pull request check', () => {
    expect(status({})).toEqual({ status: 'healthy', reasons: [], checkedAt: ago(120) });
    expect(status({ latestPrCheckAt: ago(10) }).checkedAt).toEqual(ago(10));
    expect(status({ counts: null, latestScanAt: null, latestPrCheckAt: ago(10) })).toMatchObject({ status: 'healthy', checkedAt: ago(10) });
    expect(status({ uptime: 'no_endpoints' }).status).toBe('healthy');
  });

  it('UNUSED never changes the status but is listed, last, on any row', () => {
    expect(status({ counts: { missing: 0, unused: 3, mismatch: 0 } })).toMatchObject({ status: 'healthy', reasons: [{ text: '3 unused' }] });
    expect(texts({ counts: { missing: 1, unused: 3, mismatch: 0 } })).toEqual(['1 missing', '3 unused']);
  });

  it('lists only non-zero findings, never "0 missing"', () => {
    const all = texts({ counts: { missing: 0, unused: 2, mismatch: 0 }, openPrsWithUndeclared: 1 });
    expect(all).toEqual(['1 open PR adds undeclared env vars', '2 unused']);
    expect(all.join(' ')).not.toMatch(/\b0 /);
  });
});

describe('ordering', () => {
  it('sorts Down, Needs attention, Not set up, Healthy, then by name', () => {
    const rows: Array<{ name: string; status: ProjectStatus }> = [
      { name: 'zeta', status: 'healthy' },
      { name: 'alpha', status: 'healthy' },
      { name: 'mid', status: 'not_set_up' },
      { name: 'b-shop', status: 'attention' },
      { name: 'a-shop', status: 'attention' },
      { name: 'web', status: 'down' },
    ];
    expect([...rows].sort(compareProjects).map((r) => r.name)).toEqual(['web', 'a-shop', 'b-shop', 'mid', 'alpha', 'zeta']);
  });

  it("ranks a group by its worst project; an empty group sorts last", () => {
    expect(worstStatusRank(['healthy', 'down'])).toBe(0);
    expect(worstStatusRank(['healthy', 'not_set_up'])).toBe(2);
    expect(worstStatusRank([])).toBeGreaterThan(worstStatusRank(['healthy']));
  });
});

describe('statusSummary', () => {
  it('counts down projects as needing attention, then breaks out down and not set up', () => {
    expect(statusSummary(['down', 'attention', 'healthy', 'healthy', 'healthy'])).toBe('2 of 5 projects need attention · 1 down');
    expect(statusSummary(['attention', 'not_set_up', 'healthy'])).toBe('1 of 3 projects needs attention · 1 not set up');
    expect(statusSummary(['down'])).toBe('1 of 1 project needs attention · 1 down');
  });

  it('says so when nothing needs attention', () => {
    expect(statusSummary(['healthy', 'healthy', 'not_set_up'])).toBe('2 of 3 projects healthy · 1 not set up');
    expect(statusSummary(['healthy', 'healthy'])).toBe('All 2 projects healthy');
    expect(statusSummary(['healthy'])).toBe('1 project, healthy');
    expect(statusSummary([])).toBeNull();
  });
});
