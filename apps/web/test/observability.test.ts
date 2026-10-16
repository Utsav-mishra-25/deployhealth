import { afterEach, describe, expect, it, vi } from 'vitest';

const reportError = vi.fn();
const initSentry = vi.fn(() => false);
vi.mock('@deployhealth/db/sentry', async (importOriginal) => ({ ...(await importOriginal<object>()), reportError, initSentry }));

afterEach(() => {
  vi.clearAllMocks();
});

describe('request errors', () => {
  it('are reported with the route pattern and method only: never the path, headers or query', async () => {
    const { reportRequestError } = await import('@/lib/observability');
    const error = new Error('boom');
    const token = 'djEuYWJjZGVmMTIzNDU2Nzg5MA.c2lnbmF0dXJlMTIzNDU2Nzg5MA';
    await reportRequestError(
      error,
      { path: `/share/reports/${token}?x=1`, method: 'GET', headers: { cookie: 'authjs.session-token=abc' } },
      { routerKind: 'App Router', routePath: '/share/reports/[token]', routeType: 'render', renderSource: 'react-server-components', revalidateReason: undefined },
    );
    expect(reportError).toHaveBeenCalledWith(error, { route: '/share/reports/[token]', route_type: 'render', router: 'App Router', method: 'GET' });
    expect(JSON.stringify(reportError.mock.calls)).not.toMatch(/djEu|authjs|x=1/);
  });
});

describe('startObservability', () => {
  it('starts Sentry with the commit SHA as the release, and only a DSN that is set', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://localhost/x');
    vi.stubEnv('AUTH_SECRET', 'a'.repeat(32));
    vi.stubEnv('SENTRY_DSN', 'https://key@o1.ingest.example.com/42');
    vi.stubEnv('RAILWAY_GIT_COMMIT_SHA', '0123456789abcdef0123456789abcdef01234567');
    const { resetServerEnvForTests } = await import('@/env');
    resetServerEnvForTests();
    const { startObservability } = await import('@/lib/observability');
    const before = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug, trace: console.trace };
    try {
      startObservability();
      expect(initSentry).toHaveBeenCalledWith(
        { dsn: 'https://key@o1.ingest.example.com/42', release: '0123456789abcdef0123456789abcdef01234567', environment: 'test' },
        'web',
        expect.any(Function),
      );
    } finally {
      // startObservability() wraps console for the whole process; put it back for the other tests.
      Object.assign(console, before);
      vi.unstubAllEnvs();
      resetServerEnvForTests();
    }
  });
});
