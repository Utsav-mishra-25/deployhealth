import { CLI_BUNDLE_PATH } from '@deployhealth/core';
// The matcher Next itself uses for `headers()` sources.
import { pathToRegexp } from 'next/dist/compiled/path-to-regexp';
import { describe, expect, it } from 'vitest';
import config, { ALL_ROUTES } from '../next.config';

const rulesFor = async (path: string) => (await config.headers!()).filter((r) => pathToRegexp(r.source, [], {}).test(path));
const headersFor = async (path: string) => Object.fromEntries((await rulesFor(path)).flatMap((r) => r.headers.map((h) => [h.key, h.value])));

describe('next.config headers', () => {
  it('marks the old CLI download deprecated (RFC 9745) and links the migration note', async () => {
    const rules = await config.headers!();
    const rule = rules.find((r) => r.source === CLI_BUNDLE_PATH);
    expect(rule?.headers).toEqual([
      { key: 'Deprecation', value: '@1790640000' }, // 2026-09-29T00:00:00Z
      { key: 'Link', value: expect.stringMatching(/^<https:\/\/github\.com\/.+#deprecated-downloading-the-cli-from-your-instance>; rel="deprecation"$/) },
    ]);
    // Nothing else gets the deprecation headers.
    expect(rules.filter((r) => r.headers.some((h) => h.key === 'Deprecation'))).toHaveLength(1);
    expect((await headersFor('/demo')).Deprecation).toBeUndefined();
  });

  it.each([
    '/',
    '/login',
    '/demo',
    '/demo/projects/00000000-0000-4000-8000-000000000001/handoff',
    '/demo/projects/00000000-0000-4000-8000-000000000001/handoff.md',
    '/clients/acme/report',
    '/share/reports/abc.def',
    '/privacy',
    '/api/ingest/scan',
    '/api/github/webhook',
    '/api/auth/callback/github',
    '/api/health',
    '/.well-known/security.txt',
    '/deployhealth-scan.mjs',
    '/sitemap.xml',
    '/icon.svg',
  ])('sends the security headers on %s', async (path) => {
    expect(await headersFor(path)).toMatchObject({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
  });

  it('keeps HSTS (Cloudflare) and script/style CSP (later phase) out of the app', async () => {
    const all = (await config.headers!()).flatMap((r) => r.headers);
    expect(all.find((h) => h.key.toLowerCase() === 'strict-transport-security')).toBeUndefined();
    expect(all.filter((h) => h.key === 'Content-Security-Policy').map((h) => h.value)).toEqual(["frame-ancestors 'none'"]);
    expect((await config.headers!()).find((r) => r.source === ALL_ROUTES)).toBeDefined();
  });
});
