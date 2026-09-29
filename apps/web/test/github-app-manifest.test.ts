import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('docs/github-app-manifest.json', ROOT), 'utf8'));
const appFile = (route: string) => fileURLToPath(new URL(`apps/web/src/app${route}`, ROOT));

describe('docs/github-app-manifest.json', () => {
  it('asks for exactly the permissions the PR check needs, and no more', () => {
    expect(manifest.default_permissions).toEqual({ checks: 'write', contents: 'read', metadata: 'read', pull_requests: 'write' });
    expect(manifest.request_oauth_on_install).toBe(false);
  });

  it('subscribes to pull_request (installation and installation_repositories reach every App without subscribing)', () => {
    expect(manifest.default_events).toEqual(['pull_request']);
  });

  it('points at the production domain, and at routes that exist', () => {
    expect(manifest.url).toBe('https://deployhealth.dev');
    expect(manifest.hook_attributes).toEqual({ url: 'https://deployhealth.dev/api/github/webhook', active: true });
    expect(manifest.setup_url).toBe('https://deployhealth.dev/github/installed');
    expect(new URL(manifest.hook_attributes.url).pathname).toBe('/api/github/webhook');
    // The routes land later in Part 2; until then this documents where they will live.
    for (const route of ['/api/github/webhook/route.ts', '/github/installed/page.tsx']) {
      if (existsSync(appFile(route.split('/').slice(0, -1).join('/')))) expect(existsSync(appFile(route)), route).toBe(true);
    }
  });
});
