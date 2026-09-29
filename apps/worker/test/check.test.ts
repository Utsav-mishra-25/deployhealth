import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeError, runCheck, type HttpRequester, type ResponseHead } from '../src/check';
import { guardedRequest } from '../src/guarded-http';

const NOW = new Date('2026-09-28T12:00:00Z');
const target = { url: 'https://api.acme.com/health', method: 'GET' as const, expectedStatus: 200 };

/** A fake clock that advances 25ms per request, so latency is deterministic. */
function fakeDeps(request: HttpRequester, extra: object = {}) {
  let t = 0;
  const timed: HttpRequester = async (url, method, signal) => {
    t += 25;
    return request(url, method, signal);
  };
  return { request: timed, now: () => NOW, clock: () => t, ...extra };
}

/** A requester that returns `heads` in order (repeating the last) and records each call. */
function respond(...heads: ResponseHead[]) {
  const calls: Array<{ url: string; method: string }> = [];
  const request: HttpRequester = async (url, method) => {
    calls.push({ url: url.href, method });
    return heads[Math.min(calls.length - 1, heads.length - 1)]!;
  };
  return Object.assign(request, { calls });
}

const rejectWith = (error: object): HttpRequester => async () => {
  throw Object.assign(new Error('request failed'), error);
};

describe('runCheck with a mocked fetch', () => {
  it('records a success with status and latency', async () => {
    const result = await runCheck(target, fakeDeps(respond({ status: 200, location: null })));
    expect(result).toEqual({ checkedAt: NOW, statusCode: 200, latencyMs: 25, ok: true, error: null });
  });

  it('records a wrong status as a failure with a short error', async () => {
    const result = await runCheck(target, fakeDeps(respond({ status: 503, location: null })));
    expect(result).toEqual({ checkedAt: NOW, statusCode: 503, latencyMs: 25, ok: false, error: 'Expected 200, got 503' });
  });

  it('accepts a non-200 expected status', async () => {
    const result = await runCheck({ ...target, expectedStatus: 204 }, fakeDeps(respond({ status: 204, location: null })));
    expect(result.ok).toBe(true);
  });

  it('times out after the budget and reports it', async () => {
    const hang: HttpRequester = (_url, _method, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    const result = await runCheck(target, { request: hang, now: () => NOW, timeoutMs: 30 });
    expect(result).toEqual({ checkedAt: NOW, statusCode: null, latencyMs: null, ok: false, error: 'Timed out after 0.03s' });
  });

  it('reports DNS failures', async () => {
    const result = await runCheck(target, fakeDeps(rejectWith({ code: 'ENOTFOUND' })));
    expect(result).toMatchObject({ ok: false, statusCode: null, latencyMs: null, error: 'DNS lookup failed (ENOTFOUND)' });
  });

  it('reports TLS and connection errors', async () => {
    expect((await runCheck(target, fakeDeps(rejectWith({ code: 'CERT_HAS_EXPIRED' })))).error).toBe('TLS error (CERT_HAS_EXPIRED)');
    expect((await runCheck(target, fakeDeps(rejectWith({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' })))).error).toBe(
      'TLS error (ERR_TLS_CERT_ALTNAME_INVALID)',
    );
    expect((await runCheck(target, fakeDeps(rejectWith({ code: 'ECONNREFUSED' })))).error).toBe('Connection refused');
  });

  it('follows redirects (relative and absolute) and measures to the final response', async () => {
    const request = respond(
      { status: 301, location: '/v2/health' },
      { status: 302, location: 'https://cdn.acme.com/health' },
      { status: 200, location: null },
    );
    const result = await runCheck(target, fakeDeps(request));
    expect(result).toMatchObject({ ok: true, statusCode: 200, latencyMs: 75 });
    expect(request.calls.map((c) => c.url)).toEqual([
      'https://api.acme.com/health',
      'https://api.acme.com/v2/health',
      'https://cdn.acme.com/health',
    ]);
  });

  it('switches to GET after a 303 and keeps HEAD otherwise', async () => {
    const request = respond({ status: 307, location: '/a' }, { status: 303, location: '/b' }, { status: 200, location: null });
    await runCheck({ ...target, method: 'HEAD' }, fakeDeps(request));
    expect(request.calls.map((c) => c.method)).toEqual(['HEAD', 'HEAD', 'GET']);
  });

  it('stops after 5 redirects', async () => {
    const request = respond({ status: 302, location: '/loop' });
    const result = await runCheck(target, fakeDeps(request));
    expect(result).toMatchObject({ ok: false, statusCode: 302, error: 'Too many redirects (more than 5)' });
    expect(request.calls).toHaveLength(6);
  });

  it('refuses redirects to non-http schemes', async () => {
    const result = await runCheck(target, fakeDeps(respond({ status: 302, location: 'file:///etc/passwd' })));
    expect(result).toMatchObject({ ok: false, error: 'Redirected to an unsupported URL (file:)' });
  });
});

describe('describeError', () => {
  it('falls back to a truncated message', () => {
    expect(describeError(new Error('x'.repeat(500)), false)).toHaveLength(200);
  });
});

describe('guardedRequest (real requests, SSRF guard)', () => {
  let server: ReturnType<typeof createServer>;
  let port: number;
  let hits = 0;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits++;
      res.end('secret internal data');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('never connects to a loopback server, whether addressed by IP or by name', async () => {
    for (const url of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`, `http://[::ffff:7f00:1]:${port}/`]) {
      const result = await runCheck({ url, method: 'GET', expectedStatus: 200 }, { request: guardedRequest });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/^Blocked: /);
    }
    expect(hits).toBe(0);
  });
});
