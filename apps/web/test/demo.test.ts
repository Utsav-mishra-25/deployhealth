import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerEnvForTests } from '@/env';

const NOT_FOUND = 'NEXT_NOT_FOUND';
const demoUser = { id: '0d3e0000-0000-4000-8000-00000000aaaa', githubId: -1, login: 'demo' };
const seeded = { value: true as boolean };

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error(NOT_FOUND);
  },
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));
vi.mock('@deployhealth/db', () => ({ getDemoUser: async () => (seeded.value ? demoUser : null) }));
// There is deliberately no mock for '@/auth': the demo must never need a session.

function setDemoPublic(value: string | undefined) {
  vi.stubEnv('DATABASE_URL', 'postgres://localhost:5432/test');
  vi.stubEnv('AUTH_SECRET', 'x'.repeat(32));
  vi.stubEnv('DEMO_PUBLIC', value);
  resetServerEnvForTests();
}

beforeEach(() => {
  seeded.value = true;
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetServerEnvForTests();
});

describe('/demo', () => {
  it('404s when DEMO_PUBLIC is unset or 0', async () => {
    const { demoOwner } = await import('@/lib/demo');
    for (const value of [undefined, '0']) {
      setDemoPublic(value);
      await expect(demoOwner()).rejects.toThrow(NOT_FOUND);
    }
  });

  it('serves the demo user without a session when DEMO_PUBLIC=1', async () => {
    setDemoPublic('1');
    const { demoOwner } = await import('@/lib/demo');
    await expect(demoOwner()).resolves.toEqual(demoUser);
  });

  it('404s when DEMO_PUBLIC=1 but the demo has not been seeded', async () => {
    setDemoPublic('1');
    seeded.value = false;
    const { demoOwner } = await import('@/lib/demo');
    await expect(demoOwner()).rejects.toThrow(NOT_FOUND);
  });

  it('renders every demo page through demoOwner(), with no session lookup', async () => {
    const { readFileSync } = await import('node:fs');
    for (const page of ['page.tsx', 'clients/[slug]/page.tsx', 'projects/[projectId]/page.tsx', 'layout.tsx']) {
      const source = readFileSync(new URL(`../src/app/demo/${page}`, import.meta.url), 'utf8');
      expect(source, page).toContain('await demoOwner()');
      expect(source, page).not.toMatch(/requireUser|@\/auth/);
    }
  });
});

describe('/api/demo/broken', () => {
  it('answers 503 with no body and no caching when DEMO_PUBLIC=1', async () => {
    setDemoPublic('1');
    const { GET, HEAD } = await import('@/app/api/demo/broken/route');
    for (const handler of [GET, HEAD]) {
      const response = handler();
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toBe('');
    }
  });

  it('404s when DEMO_PUBLIC is unset', async () => {
    setDemoPublic(undefined);
    const { GET } = await import('@/app/api/demo/broken/route');
    expect(GET().status).toBe(404);
  });
});
