import type { DeployHistoryItem } from '@deployhealth/db';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DeployList } from '@/components/deploy-list';
import { changeLine, commitUrl, outageLine } from '@/lib/deploy-changes';

const T0 = new Date('2026-10-13T12:00:00Z');
const min = (n: number) => new Date(T0.getTime() + n * 60_000);

describe('changeLine', () => {
  it('names what a deploy added and fixed, per kind', () => {
    expect(changeLine({ kind: 'diff', introduced: [{ kind: 'missing', var_name: 'REDIS_URL' }], fixed: [] })).toBe('+1 missing: REDIS_URL');
    expect(changeLine({ kind: 'diff', introduced: [], fixed: [{ kind: 'unused', var_name: 'OLD_FLAG' }] })).toBe('fixed 1 unused: OLD_FLAG');
    expect(
      changeLine({
        kind: 'diff',
        introduced: [
          { kind: 'missing', var_name: 'REDIS_URL' },
          { kind: 'missing', var_name: 'STRIPE_KEY' },
          { kind: 'mismatch', var_name: 'PORT' },
        ],
        fixed: [{ kind: 'missing', var_name: 'DB_URL' }],
      }),
    ).toBe('+2 missing: REDIS_URL, STRIPE_KEY · +1 mismatch: PORT · fixed 1 missing: DB_URL');
  });

  it('caps the names like alerts do, counts stay exact', () => {
    const introduced = Array.from({ length: 9 }, (_, i) => ({ kind: 'missing' as const, var_name: `V${i}` }));
    expect(changeLine({ kind: 'diff', introduced, fixed: [] })).toBe('+9 missing: V0, V1, V2, V3, V4 and 4 more');
  });

  it('no change, the first scan, a deploy without a scan', () => {
    expect(changeLine({ kind: 'diff', introduced: [], fixed: [] })).toBe('no change');
    expect(changeLine({ kind: 'first' })).toBe('first scan');
    expect(changeLine({ kind: 'unscanned' })).toBe('not scanned');
  });
});

describe('outageLine', () => {
  it('says how long after the deploy the outage started, and whether it is over', () => {
    expect(outageLine({ startedAt: min(14), resolvedAt: null, endpoint: 'Acme API', more: 0 }, T0)).toBe('Outage started 14m after this deploy (Acme API), still down');
    expect(outageLine({ startedAt: min(14), resolvedAt: min(35), endpoint: 'Acme API', more: 0 }, T0)).toBe(
      'Outage started 14m after this deploy (Acme API), resolved after 21m',
    );
    expect(outageLine({ startedAt: min(90), resolvedAt: min(95), endpoint: 'shop.example', more: 2 }, T0)).toBe(
      'Outage started 1h 30m after this deploy (shop.example), resolved after 5m · 2 more outages',
    );
  });
});

describe('commitUrl', () => {
  const sha = 'b52952e0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6';
  it('links the commit on GitHub when the project names a repository', () => {
    expect(commitUrl('acme/storefront', sha, false)).toBe(`https://github.com/acme/storefront/commit/${sha}`);
  });

  it('stays plain text without a repository, on the demo, or for a sha that is not one', () => {
    expect(commitUrl('not a repo', sha, false)).toBeNull();
    expect(commitUrl('', sha, false)).toBeNull();
    expect(commitUrl('acme/storefront', sha, true)).toBeNull();
    expect(commitUrl('acme/storefront', 'main"><x', false)).toBeNull();
  });
});

describe('DeployList renders the commit', () => {
  const row = (sha: string): DeployHistoryItem => ({
    deploy: { id: '0d3e0000-0000-4000-8000-0000000000aa', projectId: 'p', sha, branch: 'main', deployedAt: T0, source: 'ingest', createdAt: T0 },
    counts: { missing: 0, unused: 0, mismatch: 0 },
    scanCount: 1,
    change: { kind: 'first' },
    outage: null,
  });
  const render = (sha: string, readOnly = false) =>
    renderToStaticMarkup(createElement(DeployList, { projectPath: '/projects/p', repoFullName: 'acme/shop', deploys: [row(sha)], selectedId: undefined, readOnly }));

  it('as a GitHub link for a hex sha', () => {
    const html = render('b52952e0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6');
    expect(html).toContain('href="https://github.com/acme/shop/commit/b52952e0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('as plain text for a sha that is not hex (ingest rejects those, but the page never trusts it)', () => {
    for (const sha of ['zzzzzzz', 'main"><x', 'javascript:alert(1)', 'b52952e0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a']) {
      const html = render(sha);
      expect(html).not.toContain('github.com');
      expect(html).not.toContain('data-testid="commit-link"');
      expect(html).toMatch(/<code class="font-mono text-gray-700">[^<]*<\/code>/);
    }
  });

  it('as plain text on the demo', () => {
    expect(render('b52952e0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6', true)).not.toContain('github.com');
  });
});
