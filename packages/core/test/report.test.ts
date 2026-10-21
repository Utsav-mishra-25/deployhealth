import { describe, expect, it } from 'vitest';
import {
  durationWords,
  findingsDiff,
  incidentDetailDuration,
  monthOf,
  parseMonth,
  reportSummary,
  reportTotals,
  shiftMonth,
  type ReportData,
  type ReportIncident,
  type ReportProject,
} from '../src/report';
import type { FindingRow } from '../src/types';

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

describe('reportTotals', () => {
  it('averages endpoint uptime (each endpoint counts once) and sums the rest', () => {
    const data: ReportData = {
      client: { id: 'c', name: 'Acme', contactEmail: null },
      preparedBy: 'Utsav Mishra',
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
          incidents: [
            { endpoint: 'B', openedAt: new Date(), resolvedAt: new Date(), durationMs: 21 * 60_000, paused: false, message: 'B started failing', afterDeploy: null },
          ],
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
  });
});

describe('reportSummary (the paragraph for the client)', () => {
  const OCT = parseMonth('2026-10')!;
  const DONE = new Date('2026-11-02T09:00:00Z');
  const at = (iso: string) => new Date(`2026-10-${iso}Z`);
  const VARS = ['NEXT_PUBLIC_SUPPORT_EMAIL', 'REDIS_URL', 'STRIPE_KEY', 'OLD_FLAG'];

  const incident = (opened: string, minutes: number | null, afterDeploy: ReportIncident['afterDeploy'] = null): ReportIncident => ({
    endpoint: 'Acme API',
    openedAt: at(opened),
    resolvedAt: minutes === null ? null : new Date(at(opened).getTime() + minutes * 60_000),
    durationMs: (minutes ?? 90) * 60_000,
    paused: false,
    message: 'Acme API started failing 4m after deploy b52952e, which introduced 2 missing env vars: REDIS_URL, STRIPE_KEY',
    afterDeploy,
  });

  function report(overrides: Partial<ReportProject> = {}, generatedAt = DONE, name = 'Acme'): ReportData {
    const deploys = Array.from({ length: 10 }, (_, i) => ({
      sha: `b52952e${i}`,
      branch: 'main',
      deployedAt: at(`0${(i % 9) + 1}T10:00:00`),
      introduced: i === 0 ? [{ kind: 'mismatch' as const, var_name: 'NEXT_PUBLIC_SUPPORT_EMAIL' }] : [],
      fixed: i < 7 ? [{ kind: 'missing' as const, var_name: `${VARS[i % VARS.length]}_${i}` }] : [],
    }));
    return {
      client: { id: 'c', name, contactEmail: null },
      preparedBy: 'Utsav Mishra',
      month: OCT,
      generatedAt,
      projects: [
        {
          name: 'acme-storefront',
          repoFullName: 'acme/storefront',
          endpoints: [
            { label: 'Acme API', url: 'https://api.acme.example', checks: 10_000, ok: 9_962, uptime: 0.9962 },
            { label: 'Acme storefront', url: 'https://acme.example', checks: 10_000, ok: 10_000, uptime: 1 },
          ],
          incidents: [],
          deploys,
          openFindings: VARS.map((var_name) => ({ kind: 'missing' as const, var_name, file: 'src/env.ts', line: 3, env_file: null })),
          ...overrides,
        },
      ],
    };
  }

  it('matches the example: one outage after a deploy that was missing two settings', () => {
    expect(reportSummary(report({ incidents: [incident('16T09:00:00', 30, { newConfigIssues: 2 })] }))).toBe(
      "In October, Acme's sites were up 99.81% of the time. There was one outage (30 minutes, 16 Oct) after a deploy that was missing two settings. " +
        '10 updates were deployed and seven configuration issues were fixed.',
    );
  });

  it('a paused incident reads like any other: no "(paused)" for the client', () => {
    const paused = { ...incident('16T09:00:00', 30, { newConfigIssues: 2 }), paused: true };
    const summary = reportSummary(report({ incidents: [paused] }));
    expect(summary).toBe(
      "In October, Acme's sites were up 99.81% of the time. There was one outage (30 minutes, 16 Oct) after a deploy that was missing two settings. " +
        '10 updates were deployed and seven configuration issues were fixed.',
    );
    expect(summary).not.toContain('paused');
  });

  it('the technical details say "(paused)" after the duration', () => {
    expect(incidentDetailDuration({ durationMs: 12 * 60_000, paused: true })).toBe('12m (paused)');
    expect(incidentDetailDuration({ durationMs: 12 * 60_000, paused: false })).toBe('12m');
    expect(incidentDetailDuration({ durationMs: 75 * 60_000, paused: false })).toBe('1h 15m');
  });

  it('no incidents', () => {
    expect(reportSummary(report())).toBe(
      "In October, Acme's sites were up 99.81% of the time. There were no outages. 10 updates were deployed and seven configuration issues were fixed.",
    );
  });

  it('one open incident, in the month in progress and after it ended', () => {
    const open = { incidents: [incident('17T16:23:00', null, { newConfigIssues: 1 })] };
    expect(reportSummary(report(open, new Date('2026-10-17T17:53:00Z')))).toContain(
      'So far in October, ',
    );
    expect(reportSummary(report(open, new Date('2026-10-17T17:53:00Z')))).toContain(
      'There is one ongoing outage (since 17 Oct, 1 hour 30 minutes so far) after a deploy that was missing one setting.',
    );
    expect(reportSummary(report(open))).toContain('There was one outage (from 17 Oct, still ongoing at the end of the month) after a deploy that was missing one setting.');
  });

  it('several incidents: the total, then each by date, with or without a deploy before it', () => {
    const three = { incidents: [incident('16T09:00:00', 30, { newConfigIssues: 2 }), incident('04T09:00:00', 65, { newConfigIssues: 0 }), incident('20T09:00:00', 10)] };
    expect(reportSummary(report(three))).toContain(
      'There were three outages, 1 hour 45 minutes in total: 4 Oct (1 hour 5 minutes, after a deploy), ' +
        '16 Oct (30 minutes, after a deploy that was missing two settings) and 20 Oct (10 minutes).',
    );
    const seven = { incidents: Array.from({ length: 7 }, (_, i) => incident(`1${i}T09:00:00`, 1)) };
    expect(reportSummary(report(seven))).toContain(
      'There were seven outages, 7 minutes in total: 10 Oct (1 minute), 11 Oct (1 minute), 12 Oct (1 minute), 13 Oct (1 minute), 14 Oct (1 minute) and 2 more.',
    );
  });

  it('no endpoints: says so, and no outage sentence', () => {
    expect(reportSummary(report({ endpoints: [], deploys: [] }, DONE, 'Jones & Sons'))).toBe(
      'In October, no sites were monitored for Jones & Sons. No updates were deployed.',
    );
  });

  it('a month with no uptime data: says so, and never "There were no outages."', () => {
    const noData = [
      { label: 'A', url: 'https://a', checks: 0, ok: 0, uptime: null },
      { label: 'B', url: 'https://b', checks: 0, ok: 0, uptime: null },
    ];
    expect(reportSummary(report({ endpoints: noData.slice(0, 1), deploys: [] }, DONE, 'Globex Labs'))).toBe(
      "In October, there was no uptime data yet for Globex Labs' site. No updates were deployed.",
    );
    const summary = reportSummary(report({ endpoints: noData }, DONE, 'Globex Labs'));
    expect(summary).toMatch(/^In October, there was no uptime data yet for Globex Labs' sites\. 10 updates were deployed/);
    expect(summary).not.toContain('outage');
  });

  it('one deploy, no fixes, one site', () => {
    const one = report({
      endpoints: [{ label: 'A', url: 'https://a', checks: 100, ok: 100, uptime: 1 }],
      deploys: [{ sha: 'abc1234', branch: 'main', deployedAt: at('02T10:00:00'), introduced: [], fixed: [] }],
    });
    expect(reportSummary(one)).toBe("In October, Acme's site was up 100% of the time. There were no outages. One update was deployed.");
  });

  it('never names a variable, a file, a commit or a branch', () => {
    const data = report({ incidents: [incident('16T09:00:00', 30, { newConfigIssues: 2 }), incident('18T09:00:00', null)] });
    const summary = reportSummary(data);
    for (const name of [...VARS, 'src/env.ts', 'b52952e', 'main', 'acme/storefront', 'env var']) expect(summary).not.toContain(name);
  });

  it('words durations for clients', () => {
    expect([0, 59_999, 60_000, 30 * 60_000, 60 * 60_000, 65 * 60_000, 26 * 3_600_000, 48 * 3_600_000].map(durationWords)).toEqual([
      'less than a minute',
      'less than a minute',
      '1 minute',
      '30 minutes',
      '1 hour',
      '1 hour 5 minutes',
      '1 day 2 hours',
      '2 days',
    ]);
  });
});
