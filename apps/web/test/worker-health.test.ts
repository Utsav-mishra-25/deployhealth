import { describe, expect, it } from 'vitest';
import { SITEMAP_PATHS } from '@/app/sitemap';
import { workerHealthResponse } from '@/lib/worker-health';

describe('workerHealthResponse', () => {
  it('answers 200 {"ok":true} when the worker is alive', async () => {
    const response = await workerHealthResponse(async () => true);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
  });

  it('answers 503 {"ok":false} when it is not, or the database cannot be read', async () => {
    for (const isHealthy of [async () => false, async () => Promise.reject(new Error('connect ECONNREFUSED db.internal:5432'))]) {
      const response = await workerHealthResponse(isHealthy);
      expect(response.status).toBe(503);
      expect(await response.text()).toBe('{"ok":false}');
    }
  });

  it('is never cached or indexed', async () => {
    const response = await workerHealthResponse(async () => true);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
  });

  it('is not in the sitemap', () => {
    expect(SITEMAP_PATHS.some((path) => path.startsWith('/api/'))).toBe(false);
  });
});
