import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import { clientIp, createRateLimiter } from '@/lib/rate-limit';

describe('createRateLimiter', () => {
  it('allows `limit` requests per window per key, then says how long to wait', () => {
    let t = 0;
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => t });
    expect([1, 2, 3].map(() => limiter.check('1.2.3.4').ok)).toEqual([true, true, true]);
    expect(limiter.check('1.2.3.4')).toEqual({ ok: false, remaining: 0, retryAfterSeconds: 60 });
    t = 45_000;
    expect(limiter.check('1.2.3.4')).toMatchObject({ ok: false, retryAfterSeconds: 15 });
    expect(limiter.check('5.6.7.8').ok).toBe(true);
    t = 60_000;
    expect(limiter.check('1.2.3.4')).toEqual({ ok: true, remaining: 2, retryAfterSeconds: 0 });
  });
});

describe('clientIp', () => {
  it('uses the hop the proxy appended, not the ones the client sent', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': '203.0.113.9' }))).toBe('203.0.113.9');
    expect(clientIp(new Headers({ 'x-forwarded-for': '6.6.6.6, 1.1.1.1, 203.0.113.9' }))).toBe('203.0.113.9');
    expect(clientIp(new Headers())).toBe('unknown');
  });
});

describe('middleware on /share', () => {
  it('answers 429 with Retry-After after 30 requests a minute from one IP', async () => {
    const { middleware, SHARED_REPORT_LIMIT, config } = await import('@/middleware');
    expect(config.matcher).toEqual(['/share/:path*', '/api/health/worker']);
    const request = (ip: string) => new NextRequest('http://localhost/share/reports/abc.def', { headers: { 'x-forwarded-for': ip } });
    for (let i = 0; i < SHARED_REPORT_LIMIT.limit; i++) expect(middleware(request('198.51.100.1')).status).toBe(200);
    const limited = middleware(request('198.51.100.1'));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // A forged first hop doesn't buy a fresh window.
    expect(middleware(request('10.9.9.9, 198.51.100.1')).status).toBe(429);
    expect(middleware(request('198.51.100.2')).status).toBe(200);
  });
});

describe('GET /api/health', () => {
  it('answers ok and logs nothing, whatever the query or headers', async () => {
    const { GET } = await import('@/app/api/health/route');
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: string) => void logs.push(line));
    try {
      expect(await GET().json()).toEqual({ ok: true });
      expect(logs).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('middleware on /api/health/worker', () => {
  it('limits the deep health check per IP, in a window of its own', async () => {
    const { middleware, WORKER_HEALTH_LIMIT, config } = await import('@/middleware');
    const { WORKER_HEALTH_PATH } = await import('@/lib/worker-health');
    expect(config.matcher).toContain(WORKER_HEALTH_PATH);
    const health = (ip: string) => new NextRequest(`http://localhost${WORKER_HEALTH_PATH}`, { headers: { 'x-forwarded-for': ip } });
    const share = (ip: string) => new NextRequest('http://localhost/share/reports/abc.def', { headers: { 'x-forwarded-for': ip } });
    for (let i = 0; i < WORKER_HEALTH_LIMIT.limit; i++) expect(middleware(health('192.0.2.7')).status).toBe(200);
    expect(middleware(health('192.0.2.7')).status).toBe(429);
    // Share links from the same IP still have their own 30.
    expect(middleware(share('192.0.2.7')).status).toBe(200);
    expect(middleware(health('192.0.2.8')).status).toBe(200);
  });
});
