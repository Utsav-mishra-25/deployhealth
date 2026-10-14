import https from 'node:https';
import { EventEmitter } from 'node:events';
import { guardedLookup, systemGuardedLookup } from '@deployhealth/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubFetch, guardedPost, guardedRequest } from '../src/guarded-http';

/** Captures the options each https.request gets, and fails the request without touching the network. */
function captureRequests() {
  const seen: Array<{ lookup: unknown }> = [];
  vi.spyOn(https, 'request').mockImplementation(((_url: unknown, options: { lookup: unknown }) => {
    seen.push({ lookup: options.lookup });
    const req = Object.assign(new EventEmitter(), {
      end: () => queueMicrotask(() => req.emit('error', new Error('stubbed'))),
    });
    return req;
  }) as unknown as typeof https.request);
  return seen;
}

afterEach(() => vi.restoreAllMocks());

describe('which DNS each outbound client uses', () => {
  it('endpoint checks and alert webhooks use the bounded resolver (guardedLookup)', async () => {
    const seen = captureRequests();
    const signal = AbortSignal.timeout(5_000);
    await expect(guardedRequest(new URL('https://status.example.com/'), 'GET', signal)).rejects.toThrow('stubbed');
    await expect(guardedPost(new URL('https://hooks.example.com/x'), '{}', signal)).rejects.toThrow('stubbed');
    expect(seen.map((s) => s.lookup)).toEqual([guardedLookup, guardedLookup]);
  });

  it('GitHub API calls keep the system resolver (getaddrinfo), unchanged by the bounded one', async () => {
    const seen = captureRequests();
    await expect(githubFetch('https://api.github.com/repos/acme/shop')).rejects.toThrow('stubbed');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.lookup).toBe(systemGuardedLookup);
    expect(systemGuardedLookup).not.toBe(guardedLookup);
  });
});
