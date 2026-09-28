import type { AlertEvent, DueEndpoint } from '@deployhealth/db';
import { describe, expect, it } from 'vitest';
import type { CheckResult } from '../src/check';
import { checkEndpoints, pruneOldChecks } from '../src/jobs';

const due = (id: string, url = `https://${id}.example/`): DueEndpoint => ({
  id,
  projectId: 'p1',
  url,
  method: 'GET',
  intervalSeconds: 60,
  expectedStatus: 200,
});

const result = (ok: boolean): CheckResult => ({
  checkedAt: new Date('2026-09-28T12:00:00Z'),
  statusCode: ok ? 200 : 503,
  latencyMs: 50,
  ok,
  error: ok ? null : 'Expected 200, got 503',
});

const event = (type: AlertEvent['type'], webhookUrl: string | null): AlertEvent => ({
  type,
  alertId: 'a1',
  projectId: 'p1',
  projectName: 'shop',
  webhookUrl,
  message: type === 'opened' ? 'a.example started failing' : 'a.example is back up',
});

describe('checkEndpoints job', () => {
  it('checks every claimed endpoint, records results and notifies on alert events', async () => {
    const recorded: string[] = [];
    const notified: Array<[string, { text: string }]> = [];
    const summary = await checkEndpoints({
      claimDue: async () => [due('a'), due('b'), due('c')],
      check: async (t) => result(!t.url.includes('a.')),
      record: async (id, outcome) => {
        recorded.push(`${id}:${outcome.ok}`);
        if (id === 'a') return { consecutiveFailures: 2, event: event('opened', 'https://hooks.example/x') };
        if (id === 'b') return { consecutiveFailures: 0, event: event('resolved', null) };
        return { consecutiveFailures: 0, event: null };
      },
      notify: async (url, payload) => {
        notified.push([url, payload]);
        return true;
      },
      log: () => {},
    });

    expect(recorded.sort()).toEqual(['a:false', 'b:true', 'c:true']);
    expect(summary).toEqual({ checked: 3, failed: 1, opened: 1, resolved: 1, errors: 0 });
    // Only the project with a webhook is notified.
    expect(notified).toEqual([['https://hooks.example/x', { text: '[down] shop: a.example started failing' }]]);
  });

  it('keeps going when one endpoint fails to record, and respects the concurrency limit', async () => {
    let running = 0;
    let peak = 0;
    const summary = await checkEndpoints({
      claimDue: async () => Array.from({ length: 7 }, (_, i) => due(`e${i}`)),
      check: async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return result(true);
      },
      record: async (id) => {
        if (id === 'e3') throw new Error('db down');
        return { consecutiveFailures: 0, event: null };
      },
      notify: async () => true,
      log: () => {},
      concurrency: 3,
    });
    expect(summary).toMatchObject({ checked: 6, errors: 1 });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('does nothing when nothing is due', async () => {
    const summary = await checkEndpoints({
      claimDue: async () => [],
      check: async () => {
        throw new Error('should not run');
      },
      record: async () => ({ consecutiveFailures: 0, event: null }),
      notify: async () => true,
      log: () => {},
    });
    expect(summary).toEqual({ checked: 0, failed: 0, opened: 0, resolved: 0, errors: 0 });
  });
});

describe('pruneOldChecks job', () => {
  it('deletes checks older than 30 days', async () => {
    let cutoff: Date | undefined;
    const deleted = await pruneOldChecks({
      prune: async (olderThan) => {
        cutoff = olderThan;
        return 42;
      },
      now: () => new Date('2026-09-30T03:17:00Z'),
      log: () => {},
    });
    expect(deleted).toBe(42);
    expect(cutoff).toEqual(new Date('2026-08-31T03:17:00Z'));
  });
});
