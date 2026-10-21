import type { AlertEvent, DueEndpoint } from '@deployhealth/db';
import { describe, expect, it } from 'vitest';
import type { CheckResult } from '../src/check';
import { backlogBeyondSpacing, checkEndpoints, checkSummaryLine, checkSummaryWorthLogging, pruneOldChecks, reseedDemo, sendAlertWebhook } from '../src/jobs';
import { createOperatorAlerts } from '../src/operator';

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

/** A claim result with no host at the per-host cap. */
const claimed = (...endpoints: DueEndpoint[]) => ({ endpoints, hostsAtCap: [] as string[] });

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
      claimDue: async () => claimed(due('a'), due('b'), due('c')),
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
    expect(summary).toEqual({ claimed: 3, checked: 3, failed: 1, opened: 1, resolved: 1, errors: 0, dueButUnclaimed: null, dueWaitingOnHost: null, runMs: expect.any(Number) });
    // Only the project with a webhook is notified.
    expect(notified).toEqual([['https://hooks.example/x', { text: '[down] shop: a.example started failing' }]]);
  });

  it('keeps going when one endpoint fails to record, and respects the concurrency limit', async () => {
    const logs: string[] = [];
    const reported: unknown[] = [];
    let running = 0;
    let peak = 0;
    const summary = await checkEndpoints({
      heartbeat: async () => {},
      claimDue: async () => claimed(...Array.from({ length: 7 }, (_, i) => due(`e${i}`, `https://e${i}.example/?token=abc`))),
      check: async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return result(true);
      },
      record: async (id) => {
        if (id === 'e3') throw Object.assign(new Error('insert failed for https://e3.example/?token=abc'), { code: '23505' });
        return { consecutiveFailures: 0, event: null };
      },
      notify: async () => true,
      log: (m) => void logs.push(m),
      report: (error) => void reported.push(error),
      concurrency: 3,
    });
    expect(summary).toMatchObject({ checked: 6, errors: 1 });
    // The error itself goes to error reports, which scrub it (packages/db/src/sentry.ts).
    expect(reported).toEqual([expect.objectContaining({ code: '23505' })]);
    expect(peak).toBeLessThanOrEqual(3);
    // The host only, and the error's name and code: never the URL or the message.
    expect(logs).toEqual(['[check] e3.example could not be processed: Error 23505']);
  });

  it('sends alert webhooks outside the check slots, and waits for them before the heartbeat', async () => {
    const order: string[] = [];
    let releaseWebhook!: () => void;
    const webhookDone = new Promise<void>((resolve) => (releaseWebhook = resolve));
    const run = checkEndpoints({
      heartbeat: async () => void order.push('heartbeat'),
      claimDue: async () => claimed(due('a'), due('b'), due('c')),
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
    expect(order).toEqual(['heartbeat', 'check https://a.example/', 'webhook started', 'check https://b.example/', 'check https://c.example/']);
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
      claimDue: async () => claimed(due('s2', 'https://shared.example/2', at(10)), due('o', 'https://other.example/', at(0)), due('s1', 'https://shared.example/1', at(0))),
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
      claimDue: async () => claimed(),
      check: async () => {
        throw new Error('should not run');
      },
      record: async () => ({ consecutiveFailures: 0, event: null }),
      notify: async () => true,
      log: () => {},
    });
    expect(summary).toEqual({ claimed: 0, checked: 0, failed: 0, opened: 0, resolved: 0, errors: 0, dueButUnclaimed: null, dueWaitingOnHost: null, runMs: expect.any(Number) });
  });
});

describe('checkEndpoints summary: claimed, due_but_unclaimed, run_ms', () => {
  const base = {
    check: async () => result(true),
    record: async () => ({ consecutiveFailures: 0, event: null }),
    notify: async () => true,
    heartbeat: async () => {},
    log: () => {},
  };

  it('counts what the claim took, what it left due (counted after the claim, with its hosts at the cap) and how long the run took', async () => {
    const order: string[] = [];
    const hostsSeen: string[][] = [];
    let t = 1_000;
    const summary = await checkEndpoints({
      ...base,
      claimDue: async () => (order.push('claim'), { endpoints: [due('a'), due('b')], hostsAtCap: ['busy.example'] }),
      countDue: async (hosts) => (order.push('count'), hostsSeen.push(hosts), { due: 7, waitingOnHost: 3 }),
      check: async () => (order.push('check'), (t += 2_500), result(true)),
      clock: () => t,
    });
    expect(order).toEqual(['claim', 'count', 'check', 'check']);
    expect(hostsSeen).toEqual([['busy.example']]);
    expect(summary).toEqual({ claimed: 2, checked: 2, failed: 0, opened: 0, resolved: 0, errors: 0, dueButUnclaimed: 7, dueWaitingOnHost: 3, runMs: 5_000 });
    expect(backlogBeyondSpacing(summary)).toBe(4);
  });

  it('logs a failed count by error name and code, and still runs the checks', async () => {
    const logs: string[] = [];
    const summary = await checkEndpoints({
      ...base,
      claimDue: async () => claimed(due('a')),
      countDue: async () => Promise.reject(Object.assign(new Error('relation "endpoints" ... postgres://u:pw@h/db'), { code: '57P01' })),
      log: (m) => logs.push(m),
    });
    expect(summary).toMatchObject({ claimed: 1, checked: 1, dueButUnclaimed: null, dueWaitingOnHost: null });
    expect(backlogBeyondSpacing(summary)).toBeNull();
    expect(logs).toEqual(['[check] due endpoints not counted: Error 57P01']);
  });

  it('writes the summary line with snake_case backlog and duration keys', () => {
    const line = checkSummaryLine({ claimed: 5, checked: 5, failed: 0, opened: 0, resolved: 0, errors: 0, dueButUnclaimed: 3, dueWaitingOnHost: 3, runMs: 41230 });
    expect(line).toBe(
      '[check] {"claimed":5,"checked":5,"failed":0,"opened":0,"resolved":0,"errors":0,"due_but_unclaimed":3,"due_waiting_on_host":3,"run_ms":41230}',
    );
  });

  it('logs a run that claimed, errored or left endpoints due; a quiet run stays quiet', () => {
    const quiet = { claimed: 0, checked: 0, failed: 0, opened: 0, resolved: 0, errors: 0, dueButUnclaimed: 0, dueWaitingOnHost: 0, runMs: 3 };
    expect(checkSummaryWorthLogging(quiet)).toBe(false);
    expect(checkSummaryWorthLogging({ ...quiet, dueButUnclaimed: null })).toBe(false);
    expect(checkSummaryWorthLogging({ ...quiet, claimed: 1 })).toBe(true);
    expect(checkSummaryWorthLogging({ ...quiet, errors: 1 })).toBe(true);
    expect(checkSummaryWorthLogging({ ...quiet, dueButUnclaimed: 2 })).toBe(true);
  });
});

describe('checkEndpoints heartbeat', () => {
  const base = {
    check: async () => result(true),
    record: async () => ({ consecutiveFailures: 0, event: null }),
    notify: async () => true,
  };

  it('records a heartbeat right after the claim and again after every run, also when nothing is due', async () => {
    const order: string[] = [];
    await checkEndpoints({ ...base, claimDue: async () => claimed(), heartbeat: async () => void order.push('heartbeat'), log: () => {} });
    expect(order).toEqual(['heartbeat', 'heartbeat']);
    order.length = 0;
    await checkEndpoints({
      ...base,
      claimDue: async () => {
        order.push('claim');
        return claimed(due('a'));
      },
      check: async () => {
        order.push('check');
        return result(true);
      },
      record: async () => {
        order.push('record');
        return { consecutiveFailures: 0, event: null };
      },
      heartbeat: async () => void order.push('heartbeat'),
      log: () => {},
    });
    expect(order).toEqual(['claim', 'heartbeat', 'check', 'record', 'heartbeat']);
  });

  it('is alive while a long run of slow checks is still going', async () => {
    let beats = 0;
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const run = checkEndpoints({
      ...base,
      claimDue: async () => claimed(due('a'), due('b')),
      check: async () => {
        await slow;
        return result(true);
      },
      heartbeat: async () => void beats++,
      log: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(beats).toBe(1); // written after the claim, before any check finished
    release();
    await run;
    expect(beats).toBe(2);
  });

  it('records it even when an endpoint errors, but not when the claim fails', async () => {
    let beats = 0;
    const heartbeat = async () => void beats++;
    await checkEndpoints({ ...base, claimDue: async () => claimed(due('a')), check: async () => Promise.reject(new Error('boom')), heartbeat, log: () => {} });
    expect(beats).toBe(2);
    await expect(checkEndpoints({ ...base, claimDue: async () => Promise.reject(new Error('db down')), heartbeat, log: () => {} })).rejects.toThrow('db down');
    expect(beats).toBe(2);
  });

  it('logs a failed heartbeat write without failing the run', async () => {
    const logs: string[] = [];
    const summary = await checkEndpoints({ ...base, claimDue: async () => claimed(due('a')), heartbeat: async () => Promise.reject(new TypeError('x')), log: (m) => logs.push(m) });
    expect(summary.checked).toBe(1);
    // Both writes failed and were logged; the checks ran anyway.
    expect(logs).toEqual(['[check] heartbeat not recorded: TypeError', '[check] heartbeat not recorded: TypeError']);
  });
});

describe('pruneOldChecks job', () => {
  it('rolls up complete days first, then deletes whole days more than 30 days back', async () => {
    const calls: string[] = [];
    const logs: string[] = [];
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
      pruneAccountDeletions: async (olderThan) => {
        calls.push(`account deletions before ${olderThan.toISOString()}`);
        return 1;
      },
      now: () => new Date('2026-09-30T03:17:00Z'),
      log: (m) => void logs.push(m),
    });
    expect(deleted).toBe(42);
    expect(calls).toEqual([
      'rollup before 2026-09-30T00:00:00.000Z',
      'prune before 2026-08-31T00:00:00.000Z',
      'deliveries before 2026-09-29T03:17:00.000Z', // GitHub delivery ids are kept 24 hours
      'account deletions before 2026-08-26T03:17:00.000Z', // 35 days: past the oldest backup
    ]);
    expect(logs).toEqual([
      '[prune] rolled up 7 endpoint-days; deleted 42 checks before 2026-08-31T00:00:00.000Z, 3 webhook deliveries and 1 account deletion records',
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

describe('sendAlertWebhook job (an alert resolved by a pause in the web app)', () => {
  const job = { projectId: 'p1', type: 'resolved' as const, message: 'Acme API paused (alert open for 12m)' };

  it("posts to the project's current webhook, escaped like every alert", async () => {
    const sent: Array<{ url: string; text: string }> = [];
    const logs: string[] = [];
    const ok = await sendAlertWebhook(job, {
      target: async (id) => (id === 'p1' ? { projectName: 'Acme <Storefront>', webhookUrl: 'https://hooks.example/x' } : null),
      notify: async (url, payload) => (sent.push({ url, text: payload.text }), true),
      log: (m) => logs.push(m),
    });
    expect(ok).toBe(true);
    expect(sent).toEqual([{ url: 'https://hooks.example/x', text: '[resolved] Acme &lt;Storefront&gt;: Acme API paused (alert open for 12m)' }]);
    expect(logs).toEqual(['[alert] resolved: Acme <Storefront>: Acme API paused (alert open for 12m)']);
  });

  it('sends nothing without a webhook, or when the project is gone', async () => {
    const sent: string[] = [];
    const notify = async (url: string) => (sent.push(url), true);
    expect(await sendAlertWebhook(job, { target: async () => ({ projectName: 'shop', webhookUrl: null }), notify, log: () => {} })).toBe(false);
    expect(await sendAlertWebhook(job, { target: async () => null, notify, log: () => {} })).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe('the falling-behind alert never fires on per-host spacing (check-endpoints → operator alerts)', () => {
  // The claim and count numbers below are what packages/db's monitoring.test.ts gets from the real
  // queries for the same setups ("8 every-minute endpoints on one host", "8 endpoints on 8 hosts
  // with a low claim limit").
  async function runs(results: Array<{ claimed: number; hostsAtCap: string[]; due: number; waitingOnHost: number }>) {
    const sent: string[] = [];
    const operator = createOperatorAlerts({ send: async (text) => (sent.push(text), true), log: () => {}, now: () => 0 });
    for (const r of results) {
      const summary = await checkEndpoints({
        claimDue: async () => ({ endpoints: Array.from({ length: r.claimed }, (_, i) => due(`e${i}`)), hostsAtCap: r.hostsAtCap }),
        countDue: async () => ({ due: r.due, waitingOnHost: r.waitingOnHost }),
        check: async () => result(true),
        record: async () => ({ consecutiveFailures: 0, event: null }),
        notify: async () => true,
        heartbeat: async () => {},
        log: () => {},
      });
      const backlog = backlogBeyondSpacing(summary);
      if (backlog !== null) await operator.checkBacklog(backlog);
    }
    return sent;
  }

  it('8 every-minute endpoints on one host: never', async () => {
    const atCap = { claimed: 5, hostsAtCap: ['busy.example'], due: 3, waitingOnHost: 3 };
    const caughtUp = { claimed: 4, hostsAtCap: [], due: 0, waitingOnHost: 0 };
    expect(await runs(Array.from({ length: 20 }, (_, i) => (i % 2 ? caughtUp : atCap)))).toEqual([]);
    expect(await runs(Array(20).fill(atCap))).toEqual([]);
  });

  it('8 endpoints on 8 hosts with a low claim limit: on the 5th run, then the recovery line', async () => {
    const behind = { claimed: 3, hostsAtCap: [], due: 5, waitingOnHost: 0 };
    const clear = { claimed: 8, hostsAtCap: [], due: 0, waitingOnHost: 0 };
    expect(await runs(Array(4).fill(behind))).toEqual([]);
    expect(await runs([...Array(5).fill(behind), clear])).toEqual([
      '[deployhealth worker] check-endpoints left 5 due endpoints unclaimed 5 runs in a row, not counting per-host spacing: checks are falling behind their intervals.',
      '[deployhealth worker] check-endpoints is claiming every due endpoint again.',
    ]);
  });
});
