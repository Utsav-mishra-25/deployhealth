import { parseMonth, reportSummary, type ReportData } from '@deployhealth/core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReportView } from '@/views/report-view';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const at = (iso: string) => new Date(`2026-10-${iso}Z`);
const VARS = ['NEXT_PUBLIC_SUPPORT_EMAIL', 'REDIS_URL', 'STRIPE_KEY', 'LOG_LEVEL'];
const SHA = 'b52952e8192c38c054e53b5447ea20de88f2e2e9';

const DATA: ReportData = {
  client: { id: 'c', name: 'Acme Corp', contactEmail: null },
  preparedBy: 'Utsav Mishra',
  month: parseMonth('2026-10')!,
  generatedAt: new Date('2026-11-01T09:00:00Z'),
  projects: [
    {
      name: 'acme-storefront',
      repoFullName: 'acme/storefront',
      endpoints: [{ label: 'Acme API', url: 'https://api.acme.example/health', checks: 10_000, ok: 9_981, uptime: 0.9981 }],
      incidents: [
        {
          endpoint: 'Acme API',
          openedAt: at('16T09:00:00'),
          resolvedAt: at('16T09:30:00'),
          durationMs: 30 * 60_000,
          // Resolved by pausing the endpoint: only the technical details say so.
          paused: true,
          message: 'Acme API started failing 4m after deploy b52952e, which introduced 2 missing env vars: REDIS_URL, STRIPE_KEY',
          afterDeploy: { newConfigIssues: 2 },
        },
      ],
      deploys: [
        {
          sha: SHA,
          branch: 'main',
          deployedAt: at('16T08:56:00'),
          introduced: [
            { kind: 'missing', var_name: 'REDIS_URL' },
            { kind: 'mismatch', var_name: 'NEXT_PUBLIC_SUPPORT_EMAIL' },
          ],
          fixed: [{ kind: 'missing', var_name: 'LOG_LEVEL' }],
        },
      ],
      openFindings: [{ kind: 'missing', var_name: 'STRIPE_KEY', file: 'src/pay.ts', line: 4, env_file: null }],
    },
  ],
};

const html = renderToStaticMarkup(createElement(ReportView, { data: DATA }));
const technical = html.slice(html.indexOf('data-testid="technical-details"'));
const clientPart = html.slice(0, html.indexOf('data-testid="technical-details"'));

describe('the monthly report', () => {
  it('says who prepared it, then the summary paragraph', () => {
    expect(text(html)).toContain('Prepared by Utsav Mishra');
    expect(html.indexOf('data-testid="prepared-by"')).toBeLessThan(html.indexOf('data-testid="report-summary"'));
    expect(text(html)).toContain(reportSummary(DATA));
  });

  it('has four tiles: uptime, incidents, deploys, issues fixed (no "introduced")', () => {
    const tiles = /data-testid="report-tiles">([\s\S]*?)<section/.exec(html)![1]!;
    expect(text(tiles).trim()).toBe('99.81% uptime (endpoint average) 1 incident 1 deploy 1 config issue fixed');
    expect(text(clientPart)).not.toMatch(/introduced/i);
  });

  it('keeps variable names, commits and alert messages under "Technical details"', () => {
    for (const name of VARS) expect(clientPart).not.toContain(name);
    expect(clientPart).not.toContain('b52952e');
    expect(text(clientPart)).toContain('Yes, missing 2 settings');
    expect(technical).toContain('<h2 id="technical-details"');
    expect(text(technical)).toContain('New config issues');
    for (const name of VARS) expect(technical).toContain(name);
    expect(text(technical)).toContain('which introduced 2 missing env vars');
  });

  it('says "(paused)" after the duration in the technical details only', () => {
    expect(text(technical)).toContain(
      '2026-10-16 09:00 UTC · 30m (paused) : Acme API started failing 4m after deploy b52952e, which introduced 2 missing env vars: REDIS_URL, STRIPE_KEY',
    );
    expect(text(clientPart)).toContain('30m');
    expect(text(clientPart)).not.toMatch(/paused/i);
  });

  it('links no commit (nor anything else on GitHub)', () => {
    expect(html).not.toContain('/commit/');
    expect(html).not.toMatch(/href="https:\/\/github\.com/);
    expect(html).not.toContain('<a ');
  });
});
