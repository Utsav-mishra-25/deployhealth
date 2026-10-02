import type { AlertEvent, DueEndpoint } from '@deployhealth/db';
import { describe, expect, it } from 'vitest';
import type { CheckResult } from '../src/check';
import { checkEndpoints, pruneOldChecks, reseedDemo } from '../src/jobs';

const T0 = new Date('2026-09-28T12:00:00Z');
const due = (id: string, url = `https://${id}.example/`, runAt = T0): DueEndpoint => ({
  id,
  projectId: 'p1',
  url,
  hostname: new URL(url).hostname,
  method: 'GET',
  intervalSeconds: 60,
  expectedStatus: 200,
  runAt,
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
      heartbeat: async () => {},
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
      heartbeat: async () => {},
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

  it('sends alert webhooks outside the check slots, and waits for them before the heartbeat', async () => {
    const order: string[] = [];
    let releaseWebhook!: () => void;
    const webhookDone = new Promise<void>((resolve) => (releaseWebhook = resolve));
    const run = checkEndpoints({
      heartbeat: async () => void order.push('heartbeat'),
      claimDue: async () => [due('a'), due('b'), due('c')],
      check: async (t) => {
        order.push(`check ${t.url}`);
        return result(!t.url.includes('a.'));
      },
      record: async (id) => (id === 'a' ? { consecutiveFailures: 2, event: event('opened', 'https://hooks.example/x') } : { consecutiveFailures: 0, event: null }),
      notify: async () => {
        order.push('webhook started');
        await webhookDone; // a slow webhook
        order.push('webhook done');
        return true;
      },
      log: () => {},
      concurrency: 1, // one slot: b and c only run if the webhook doesn't hold it
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['check https://a.example/', 'webhook started', 'check https://b.example/', 'check https://c.example/']);
    releaseWebhook();
    await run;
    expect(order.slice(-2)).toEqual(['webhook done', 'heartbeat']);
  });

  it('runs waves in start-time order, each no earlier than its start, so one host is never hit twice in 10s', async () => {
    const events: string[] = [];
    let clock = T0.getTime();
    const at = (s: number) => new Date(T0.getTime() + s * 1000);
    await checkEndpoints({
      heartbeat: async () => {},
      // Two checks of shared.example (10s apart) and one of other.example, claimed out of order.
      claimDue: async () => [due('s2', 'https://shared.example/2', at(10)), due('o', 'https://other.example/', at(0)), due('s1', 'https://shared.example/1', at(0))],
      check: async (t) => {
        events.push(`check ${t.url} at +${(clock - T0.getTime()) / 1000}s`);
        clock += 3_000; // each check takes 3s
        return result(true);
      },
      record: async () => ({ consecutiveFailures: 0, event: null }),
      notify: async () => true,
      log: () => {},
      concurrency: 1,
      sleepUntil: async (until) => {
        events.push(`wait until +${(until.getTime() - T0.getTime()) / 1000}s`);
        clock = Math.max(clock, until.getTime());
      },
    });
    expect(events).toEqual([
      'wait until +0s',
      'check https://other.example/ at +0s',
      'check https://shared.example/1 at +3s',
      'wait until +10s',
      'check https://shared.example/2 at +10s',
    ]);
  });

  it('does nothing when nothing is due', async () => {
    const summary = await checkEndpoints({
      heartbeat: async () => {},
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

describe('checkEndpoints heartbeat', () => {
  const base = {
    check: async () => result(true),
    record: async () => ({ consecutiveFailures: 0, event: null }),
    notify: async () => true,
  };

  it('records a heartbeat after every run, also when nothing is due', async () => {
    const order: string[] = [];
    await checkEndpoints({ ...base, claimDue: async () => [], heartbeat: async () => void order.push('heartbeat'), log: () => {} });
    await checkEndpoints({
      ...base,
      claimDue: async () => [due('a')],
      record: async () => {
        order.push('record');
        return { consecutiveFailures: 0, event: null };
      },
      heartbeat: async () => void order.push('heartbeat'),
      log: () => {},
    });
    expect(order).toEqual(['heartbeat', 'record', 'heartbeat']);
  });

  it('records it even when an endpoint errors, but not when the claim fails', async () => {
    let beats = 0;
    const heartbeat = async () => void beats++;
    await checkEndpoints({ ...base, claimDue: async () => [due('a')], check: async () => Promise.reject(new Error('boom')), heartbeat, log: () => {} });
    expect(beats).toBe(1);
    await expect(checkEndpoints({ ...base, claimDue: async () => Promise.reject(new Error('db down')), heartbeat, log: () => {} })).rejects.toThrow('db down');
    expect(beats).toBe(1);
  });

  it('logs a failed heartbeat write without failing the run', async () => {
    const logs: string[] = [];
    const summary = await checkEndpoints({ ...base, claimDue: async () => [due('a')], heartbeat: async () => Promise.reject(new TypeError('x')), log: (m) => logs.push(m) });
    expect(summary.checked).toBe(1);
    expect(logs).toEqual(['[check] heartbeat not recorded: TypeError']);
  });
});

describe('pruneOldChecks job', () => {
  it('rolls up complete days first, then deletes whole days more than 30 days back', async () => {
    const calls: string[] = [];
    const deleted = await pruneOldChecks({
      rollup: async (before) => {
        calls.push(`rollup before ${before.toISOString()}`);
        return 7;
      },
      prune: async (olderThan) => {
        calls.push(`prune before ${olderThan.toISOString()}`);
        return 42;
      },
      pruneDeliveries: async (olderThan) => {
        calls.push(`deliveries before ${olderThan.toISOString()}`);
        return 3;
      },
      now: () => new Date('2026-09-30T03:17:00Z'),
      log: () => {},
    });
    expect(deleted).toBe(42);
    expect(calls).toEqual([
      'rollup before 2026-09-30T00:00:00.000Z',
      'prune before 2026-08-31T00:00:00.000Z',
      'deliveries before 2026-09-29T03:17:00.000Z', // GitHub delivery ids are kept 24 hours
    ]);
  });

  it('deletes nothing when the rollup fails', async () => {
    let pruned = false;
    await expect(
      pruneOldChecks({
        rollup: async () => Promise.reject(new Error('db down')),
        prune: async () => {
          pruned = true;
          return 0;
        },
        log: () => {},
      }),
    ).rejects.toThrow('db down');
    expect(pruned).toBe(false);
  });
});

describe('reseedDemo job', () => {
  it('reseeds with the current time and logs how long it took, never the ingest token', async () => {
    const seen: Date[] = [];
    const logs: string[] = [];
    const now = new Date('2026-09-28T04:41:00Z');
    await reseedDemo({
      seed: async (at) => {
        seen.push(at);
        return { userId: 'u', projectId: 'p', token: 'dh_secret-token-value' };
      },
      now: () => now,
      log: (m) => logs.push(m),
    });
    expect(seen).toEqual([now]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^\[reseed-demo\] demo data restored in \d+ms$/);
    expect(logs.join('\n')).not.toContain('dh_');
  });

  it('propagates a failed seed so pg-boss retries it', async () => {
    await expect(reseedDemo({ seed: async () => Promise.reject(new Error('db down')), log: () => {} })).rejects.toThrow('db down');
  });
});
