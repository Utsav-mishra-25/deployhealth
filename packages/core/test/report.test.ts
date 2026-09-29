import { describe, expect, it } from 'vitest';
import { findingsDiff, monthOf, parseMonth, reportTotals, shiftMonth, summaryLine, type ReportData, type ReportTotals } from '../src/report';
import type { FindingRow } from '../src/types';

const totals = (overrides: Partial<ReportTotals> = {}): ReportTotals => ({
  projects: 3,
  uptime: 0.9994,
  incidents: 1,
  incidentMs: 21 * 60_000,
  deploys: 14,
  introduced: 1,
  fixed: 2,
  openFindings: 4,
  ...overrides,
});

describe('months (UTC)', () => {
  it('parses YYYY-MM into [first of the month, first of the next)', () => {
    expect(parseMonth('2026-09')).toEqual({
      key: '2026-09',
      from: new Date('2026-09-01T00:00:00Z'),
      to: new Date('2026-10-01T00:00:00Z'),
      label: 'September 2026',
    });
    expect(parseMonth('2026-12')?.to).toEqual(new Date('2027-01-01T00:00:00Z'));
  });

  it('rejects anything else', () => {
    for (const bad of ['2026-13', '2026-00', '2026-9', '26-09', '2026-09-01', '', undefined, null]) expect(parseMonth(bad)).toBeNull();
  });

  it('finds the month of a date in UTC and moves between months', () => {
    expect(monthOf(new Date('2026-10-01T00:30:00+02:00')).key).toBe('2026-09');
    expect(shiftMonth(parseMonth('2026-01')!, -1).key).toBe('2025-12');
    expect(shiftMonth(parseMonth('2026-12')!, 1).key).toBe('2027-01');
  });
});

describe('findingsDiff', () => {
  const f = (kind: FindingRow['kind'], var_name: string) => ({ kind, var_name });

  it('reports what a deploy introduced and fixed, by kind and variable', () => {
    const before = [f('missing', 'LOG_LEVEL'), f('unused', 'OLD_KEY'), f('missing', 'SENTRY_DSN')];
    const after = [f('missing', 'SENTRY_DSN'), f('missing', 'SENTRY_DSN'), f('missing', 'REDIS_URL'), f('mismatch', 'OLD_KEY')];
    expect(findingsDiff(before, after)).toEqual({
      introduced: [f('missing', 'REDIS_URL'), f('mismatch', 'OLD_KEY')],
      fixed: [f('missing', 'LOG_LEVEL'), f('unused', 'OLD_KEY')],
    });
  });

  it('counts everything as introduced without a previous scan, and nothing when unchanged', () => {
    expect(findingsDiff(null, [f('missing', 'A')])).toEqual({ introduced: [f('missing', 'A')], fixed: [] });
    expect(findingsDiff([f('missing', 'A')], [f('missing', 'A')])).toEqual({ introduced: [], fixed: [] });
  });
});

describe('summaryLine', () => {
  it('matches the example exactly', () => {
    expect(summaryLine(totals())).toBe('3 projects, 99.94% uptime, 1 incident (21m), 14 deploys, 2 config issues fixed');
  });

  it('handles singulars, zeros, several incidents and missing data', () => {
    expect(summaryLine(totals({ projects: 1, deploys: 1, fixed: 1 }))).toBe('1 project, 99.94% uptime, 1 incident (21m), 1 deploy, 1 config issue fixed');
    expect(summaryLine(totals({ incidents: 0, incidentMs: 0, deploys: 0, fixed: 0, uptime: 1 }))).toBe(
      '3 projects, 100% uptime, no incidents, 0 deploys, no config issues fixed',
    );
    expect(summaryLine(totals({ incidents: 3, incidentMs: 65 * 60_000 }))).toBe('3 projects, 99.94% uptime, 3 incidents (1h 5m total), 14 deploys, 2 config issues fixed');
    expect(summaryLine(totals({ uptime: null }))).toContain(', no uptime data, ');
  });
});

describe('reportTotals', () => {
  it('averages endpoint uptime (each endpoint counts once) and sums the rest', () => {
    const data: ReportData = {
      client: { id: 'c', name: 'Acme', contactEmail: null },
      month: parseMonth('2026-09')!,
      generatedAt: new Date('2026-10-01T09:00:00Z'),
      projects: [
        {
          name: 'a',
          repoFullName: 'x/a',
          endpoints: [
            { label: 'A', url: 'https://a', checks: 43_200, ok: 43_200, uptime: 1 },
            { label: 'B', url: 'https://b', checks: 10_000, ok: 9_988, uptime: 0.9988 },
          ],
          incidents: [{ endpoint: 'B', openedAt: new Date(), resolvedAt: new Date(), durationMs: 21 * 60_000, message: 'B started failing' }],
          deploys: [{ sha: 's', branch: 'main', deployedAt: new Date(), introduced: [], fixed: [{ kind: 'missing', var_name: 'X' }] }],
          openFindings: [],
        },
        {
          name: 'b',
          repoFullName: 'x/b',
          endpoints: [{ label: 'C', url: 'https://c', checks: 0, ok: 0, uptime: null }],
          incidents: [],
          deploys: [],
          openFindings: [{ kind: 'unused', var_name: 'Y', file: '.env.example', line: 1, env_file: '.env.example' }],
        },
      ],
    };
    expect(reportTotals(data)).toEqual({
      projects: 2,
      uptime: (1 + 0.9988) / 2,
      incidents: 1,
      incidentMs: 21 * 60_000,
      deploys: 1,
      introduced: 0,
      fixed: 1,
      openFindings: 1,
    });
    expect(summaryLine(reportTotals(data))).toBe('2 projects, 99.94% uptime, 1 incident (21m), 1 deploy, 1 config issue fixed');
  });
});
