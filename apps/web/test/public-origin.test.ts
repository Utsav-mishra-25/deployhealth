import { githubActionSnippet } from '@deployhealth/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerEnvForTests, serverEnv } from '@/env';
import {
  MISSING_PUBLIC_ORIGIN_ERROR,
  publicOrigin,
  publicOriginFor,
  reportMissingPublicOrigin,
  resetPublicOriginReportForTests,
} from '@/lib/app-url';

// A request whose Host and X-Forwarded-Host both claim to be someone else.
const SPOOFED = { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' };
const requestHeaders = { current: new Headers(SPOOFED) };

vi.mock('next/headers', () => ({ headers: async () => requestHeaders.current }));
vi.mock('@/auth', () => ({ auth: async () => null, signOut: async () => {} }));

const BASE_ENV = { DATABASE_URL: 'postgres://x@localhost/db', AUTH_SECRET: 'x'.repeat(32) };
const saved = { ...process.env };

function setEnv(env: Record<string, string | undefined>) {
  for (const key of ['PUBLIC_ORIGIN', 'NODE_ENV', 'AUTH_GITHUB_ID', 'AUTH_GITHUB_SECRET', 'SECURITY_CONTACT_EMAIL']) delete process.env[key];
  Object.assign(process.env, BASE_ENV, env);
  resetServerEnvForTests();
}

beforeEach(() => {
  requestHeaders.current = new Headers(SPOOFED);
  resetPublicOriginReportForTests();
});

afterEach(() => {
  process.env = { ...saved };
  resetServerEnvForTests();
  resetPublicOriginReportForTests();
  vi.restoreAllMocks();
});

describe('PUBLIC_ORIGIN', () => {
  it('accepts an origin only (scheme, host, optional port), dropping one trailing slash', () => {
    for (const [value, origin] of [
      ['https://deployhealth.dev', 'https://deployhealth.dev'],
      ['https://deployhealth.dev/', 'https://deployhealth.dev'],
      ['http://localhost:3100', 'http://localhost:3100'],
    ]) {
      setEnv({ PUBLIC_ORIGIN: value });
      expect(serverEnv().PUBLIC_ORIGIN).toBe(origin);
    }
    for (const value of ['deployhealth.dev', 'https://deployhealth.dev/app', 'https://deployhealth.dev?x=1', 'ftp://deployhealth.dev', 'https://user@deployhealth.dev']) {
      setEnv({ PUBLIC_ORIGIN: value });
      expect(() => serverEnv(), value).toThrow('PUBLIC_ORIGIN must be an origin like https://deployhealth.dev');
    }
  });
});

describe('set: a spoofed Host or X-Forwarded-Host never wins', () => {
  beforeEach(() => setEnv({ PUBLIC_ORIGIN: 'https://deployhealth.dev' }));

  it('in the helper', async () => {
    expect(await publicOrigin()).toBe('https://deployhealth.dev');
    expect(publicOriginFor(new Headers(SPOOFED))).toBe('https://deployhealth.dev');
  });

  it('in security.txt, which is never cached', async () => {
    const { GET } = await import('@/app/.well-known/security.txt/route');
    const response = GET(new Request('http://internal:8080/.well-known/security.txt', { headers: SPOOFED }));
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.text();
    expect(body).toContain('Policy: https://deployhealth.dev/security\n');
    expect(body).not.toContain('evil.example');
  });

  it('in the sitemap', async () => {
    const { default: sitemap } = await import('@/app/sitemap');
    const urls = (await sitemap()).map((entry) => entry.url);
    expect(urls).toContain('https://deployhealth.dev/docs/nextjs');
    expect(urls.every((url) => url.startsWith('https://deployhealth.dev/'))).toBe(true);
  });

  it('in canonical URLs: metadataBase resolves a docs page canonical against the real origin', async () => {
    const { generateMetadata: layoutMetadata } = await import('@/app/layout');
    const { generateMetadata: docsMetadata } = await import('@/app/docs/[stack]/page');
    const base = (await layoutMetadata()).metadataBase as URL;
    const canonical = (await docsMetadata({ params: Promise.resolve({ stack: 'nextjs' }) })).alternates?.canonical as string;
    expect(new URL(canonical, base).href).toBe('https://deployhealth.dev/docs/nextjs');
  });

  it('in the Action snippet, where the URL is quoted', async () => {
    const snippet = githubActionSnippet({ appUrl: await publicOrigin() });
    expect(snippet).toContain('--url "https://deployhealth.dev" \\');
    expect(snippet).not.toContain('evil.example');
  });

  it('logs nothing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    setEnv({ PUBLIC_ORIGIN: 'https://deployhealth.dev', NODE_ENV: 'production', AUTH_GITHUB_ID: 'id', AUTH_GITHUB_SECRET: 'secret' });
    reportMissingPublicOrigin();
    await publicOrigin();
    expect(error).not.toHaveBeenCalled();
  });
});

describe('unset', () => {
  it('in development: the request host, and no error', async () => {
    setEnv({ NODE_ENV: 'development' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    requestHeaders.current = new Headers({ host: 'localhost:3000' });
    expect(await publicOrigin()).toBe('http://localhost:3000');
    expect(error).not.toHaveBeenCalled();
  });

  it('in production: pages still get an origin (the request host, as before) and the error is logged once', async () => {
    setEnv({ NODE_ENV: 'production', AUTH_GITHUB_ID: 'id', AUTH_GITHUB_SECRET: 'secret' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // At startup (instrumentation.ts), then on every request: one line in total.
    const { register } = await import('@/instrumentation');
    register();
    requestHeaders.current = new Headers({ host: 'deployhealth.dev', 'x-forwarded-proto': 'https' });
    expect(await publicOrigin()).toBe('https://deployhealth.dev');
    const { default: sitemap } = await import('@/app/sitemap');
    expect((await sitemap())[0]?.url).toBe('https://deployhealth.dev/');
    const { GET } = await import('@/app/.well-known/security.txt/route');
    expect(GET(new Request('https://deployhealth.dev/.well-known/security.txt', { headers: { host: 'deployhealth.dev' } })).status).toBe(200);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(MISSING_PUBLIC_ORIGIN_ERROR);
    expect(MISSING_PUBLIC_ORIGIN_ERROR).toMatch(/^PUBLIC_ORIGIN is not set/);
  });

  it('a broken environment at startup throws nowhere: the first request reports it', async () => {
    for (const key of ['DATABASE_URL', 'AUTH_SECRET', 'PUBLIC_ORIGIN']) delete process.env[key];
    resetServerEnvForTests();
    const { register } = await import('@/instrumentation');
    expect(() => register()).not.toThrow();
  });
});
