import type { FindingRow, HandoffData } from '@deployhealth/core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FindingsByKind } from '@/components/findings-table';
import { HandoffView } from '@/views/handoff-view';

const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');

const FINDINGS: FindingRow[] = [
  { kind: 'missing', var_name: 'REDIS_URL', file: 'apps/api/src/lib/cache.ts', line: 6, env_file: null },
  { kind: 'unused', var_name: 'OLD_FLAG', file: 'apps/api/.env', line: 4, env_file: 'apps/api/.env' },
  { kind: 'mismatch', var_name: 'NEXT_PUBLIC_SUPPORT_EMAIL', file: 'apps/web/.env', line: 2, env_file: 'apps/web/.env.example' },
];
const SCOPES = [
  { scope: 'apps/api', env_files: ['.env.example' as const, '.env' as const] },
  { scope: 'apps/web', env_files: ['.env.example' as const, '.env' as const] },
];
const EXPECTED = [
  'Declare it in apps/api/.env.example and set it on your host',
  'Remove it from apps/api/.env, or ignore it',
  'Add it to apps/web/.env.example',
];

/** The "What to do" cells, in document order. */
function actions(html: string): string[] {
  return [...html.matchAll(/data-testid="finding-action"[^>]*>([\s\S]*?)<\/(?:td|span)>/g)].map((m) => text(m[1]!).trim());
}

describe('"What to do" per finding type', () => {
  it('on the project page: a column with one line per finding', () => {
    const html = renderToStaticMarkup(createElement(FindingsByKind, { findings: FINDINGS, envScopes: SCOPES }));
    expect(html).toContain('>What to do</th>');
    expect(actions(html)).toEqual(EXPECTED);
  });

  it("on the handoff's open findings: the same wording", () => {
    const data: HandoffData = {
      generatedAt: new Date('2026-10-01T00:00:00Z'),
      project: { name: 'acme', repoFullName: 'acme/acme' },
      client: null,
      scan: { sha: 'b52952e0aa11', branch: 'main', deployedAt: new Date('2026-10-01T00:00:00Z'), variablesReported: true },
      variables: [],
      envScopes: SCOPES,
      findings: FINDINGS,
      endpoints: [],
      window: { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-10-01T00:00:00Z') },
      uptime: null,
      alerts: [],
      deployNotes: null,
      actionSnippet: 'name: deployhealth\n',
    };
    const html = renderToStaticMarkup(createElement(HandoffView, { data, backHref: '/p', markdownHref: '/p/handoff.md' }));
    expect(actions(html)).toEqual(EXPECTED.map((line) => `${line}.`));
  });
});
