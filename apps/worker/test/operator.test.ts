import { describe, expect, it } from 'vitest';
import {
  ALERT_REPEAT_MS,
  BACKLOG_RUNS_BEFORE_ALERT,
  BACKUP_ALERT_REPEAT_MS,
  createOperatorAlerts,
  observeJob,
  FAILURES_BEFORE_ALERT,
  MAX_ALERTS_PER_HOUR,
  NO_OPERATOR_ALERTS,
  operatorWebhookUrl,
} from '../src/operator';

const MINUTE = 60_000;

function harness() {
  let clock = 0;
  const sent: string[] = [];
  const logs: string[] = [];
  const alerts = createOperatorAlerts({
    send: async (text) => {
      sent.push(text);
      return true;
    },
    log: (m) => logs.push(m),
    now: () => clock,
  });
  return { alerts, sent, logs, advance: (ms: number) => (clock += ms) };
}

const failure = Object.assign(new Error(`posting to https://hooks.slack.com/services/T/B/secret failed`), { code: 'ECONNRESET' });

describe('operator alerts: job failures', () => {
  it(`alerts on the ${FAILURES_BEFORE_ALERT}rd failure in a row, with the error's name and code only`, async () => {
    const h = harness();
    await h.alerts.jobFailed('check-endpoints', failure);
    await h.alerts.jobFailed('check-endpoints', failure);
    expect(h.sent).toEqual([]);
    await h.alerts.jobFailed('check-endpoints', failure);
    expect(h.sent).toEqual(['[deployhealth worker] check-endpoints failed 3 times in a row (last error: Error ECONNRESET).']);
    expect(h.sent.join() + h.logs.join()).not.toContain('secret');
  });

  it('a success in between resets the count', async () => {
    const h = harness();
    await h.alerts.jobFailed('prune-checks', failure);
    await h.alerts.jobFailed('prune-checks', failure);
    await h.alerts.jobSucceeded('prune-checks');
    await h.alerts.jobFailed('prune-checks', failure);
    expect(h.sent).toEqual([]);
  });

  it('repeats at most once an hour while it keeps failing, then says when it recovers', async () => {
    const h = harness();
    for (let i = 0; i < 10; i++) await h.alerts.jobFailed('pr-check', failure);
    expect(h.sent).toHaveLength(1);
    h.advance(ALERT_REPEAT_MS);
    await h.alerts.jobFailed('pr-check', failure);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toContain('pr-check failed 11 times in a row');
    await h.alerts.jobSucceeded('pr-check');
    expect(h.sent[2]).toBe('[deployhealth worker] pr-check is succeeding again after 11 failures in a row.');
  });

  it('counts each queue on its own', async () => {
    const h = harness();
    await h.alerts.jobFailed('a', failure);
    await h.alerts.jobFailed('b', failure);
    await h.alerts.jobFailed('a', failure);
    await h.alerts.jobFailed('b', failure);
    expect(h.sent).toEqual([]);
  });

  it(`sends at most ${MAX_ALERTS_PER_HOUR} alerts in an hour, whatever their kinds`, async () => {
    const h = harness();
    for (let q = 0; q < MAX_ALERTS_PER_HOUR + 5; q++) for (let i = 0; i < FAILURES_BEFORE_ALERT; i++) await h.alerts.jobFailed(`queue-${q}`, failure);
    expect(h.sent).toHaveLength(MAX_ALERTS_PER_HOUR);
    expect(h.logs.filter((l) => l.includes('not sent'))).toHaveLength(5);
    h.advance(60 * MINUTE);
    await h.alerts.jobFailed('queue-14', failure);
    expect(h.sent).toHaveLength(MAX_ALERTS_PER_HOUR + 1);
  });
});

describe('operator alerts: the heartbeat', () => {
  it('waits one window after start, then alerts when stale and once when fresh again', async () => {
    const h = harness();
    await h.alerts.heartbeat(600);
    expect(h.sent).toEqual([]); // just started
    h.advance(3 * MINUTE);
    await h.alerts.heartbeat(120);
    expect(h.sent).toEqual([]);
    await h.alerts.heartbeat(300);
    expect(h.sent).toEqual(["[deployhealth worker] the check-endpoints heartbeat is 5 minutes old (the limit is 3): uptime checks aren't running."]);
    h.advance(MINUTE);
    await h.alerts.heartbeat(360);
    expect(h.sent).toHaveLength(1); // rate-limited
    await h.alerts.heartbeat(20);
    expect(h.sent[1]).toBe('[deployhealth worker] the check-endpoints heartbeat is fresh again: uptime checks are running.');
    await h.alerts.heartbeat(20);
    expect(h.sent).toHaveLength(2);
  });

  it('a heartbeat that was never written is stale', async () => {
    const h = harness();
    h.advance(3 * MINUTE);
    await h.alerts.heartbeat(null);
    expect(h.sent[0]).toContain('has never been written');
  });
});

describe('operatorWebhookUrl', () => {
  it('accepts a public URL and refuses others with one line that never quotes the path', () => {
    const logs: string[] = [];
    expect(operatorWebhookUrl('https://hooks.slack.com/services/T/B/secret', (m) => logs.push(m))).toBe('https://hooks.slack.com/services/T/B/secret');
    expect(operatorWebhookUrl(null, (m) => logs.push(m))).toBeNull();
    expect(logs).toEqual([]);
    expect(operatorWebhookUrl('http://localhost/hook/secret', (m) => logs.push(m))).toBeNull();
    expect(operatorWebhookUrl('not a url', (m) => logs.push(m))).toBeNull();
    expect(logs).toHaveLength(2);
    expect(logs.join()).not.toContain('secret');
    expect(logs[0]).toMatch(/operator alerts are off/);
  });
});

describe('observeJob', () => {
  it('reports and counts a failure, throws it again for the queue to retry, and clears the count on success', async () => {
    const h = harness();
    const reported: Array<[unknown, Record<string, string>]> = [];
    const deps = { report: (error: unknown, tags: Record<string, string>) => reported.push([error, tags]), operator: h.alerts };
    for (let i = 0; i < FAILURES_BEFORE_ALERT; i++) await expect(observeJob('prune-checks', () => Promise.reject(failure), deps)).rejects.toBe(failure);
    expect(reported).toEqual([[failure, { queue: 'prune-checks' }], [failure, { queue: 'prune-checks' }], [failure, { queue: 'prune-checks' }]]);
    expect(h.sent).toHaveLength(1);
    expect(await observeJob('prune-checks', async () => 'done', deps)).toBe('done');
    expect(h.sent[1]).toContain('prune-checks is succeeding again');
  });
});

describe('operator alerts: the backup heartbeat', () => {
  const DAY_S = 86_400;
  it('says nothing while backups are not set up (no row yet)', async () => {
    const h = harness();
    h.advance(30 * 24 * 3_600_000);
    await h.alerts.backupHeartbeat(null);
    expect(h.sent).toEqual([]);
  });

  it('alerts after 8 days without a successful run, at most once a day, and once when it succeeds again', async () => {
    const h = harness();
    await h.alerts.backupHeartbeat(7.9 * DAY_S);
    expect(h.sent).toEqual([]);
    await h.alerts.backupHeartbeat(8.2 * DAY_S);
    expect(h.sent).toEqual(["[deployhealth worker] the backup service hasn't succeeded for 8 days (the limit is 8): check its cron runs on Railway."]);
    h.advance(ALERT_REPEAT_MS);
    await h.alerts.backupHeartbeat(8.3 * DAY_S);
    expect(h.sent).toHaveLength(1);
    h.advance(BACKUP_ALERT_REPEAT_MS);
    await h.alerts.backupHeartbeat(9.3 * DAY_S);
    expect(h.sent).toHaveLength(2);
    await h.alerts.backupHeartbeat(0.1 * DAY_S);
    expect(h.sent[2]).toBe('[deployhealth worker] the backup service is succeeding again.');
  });
});

describe('operator alerts: check-endpoints falling behind', () => {
  it(`alerts when due endpoints are left unclaimed ${BACKLOG_RUNS_BEFORE_ALERT} runs in a row, with counts only`, async () => {
    expect(BACKLOG_RUNS_BEFORE_ALERT).toBe(5);
    const { alerts, sent } = harness();
    for (let run = 1; run < BACKLOG_RUNS_BEFORE_ALERT; run++) await alerts.checkBacklog(3);
    expect(sent).toEqual([]);
    await alerts.checkBacklog(12);
    expect(sent).toEqual(['[deployhealth worker] check-endpoints left 12 due endpoints unclaimed 5 runs in a row, not counting per-host spacing: checks are falling behind their intervals.']);
  });

  it('a run that leaves none resets the count, silently when nothing was sent', async () => {
    const { alerts, sent } = harness();
    for (let run = 0; run < 4; run++) await alerts.checkBacklog(3);
    await alerts.checkBacklog(0);
    for (let run = 0; run < 4; run++) await alerts.checkBacklog(3);
    expect(sent).toEqual([]);
  });

  it('repeats at most once an hour while it lasts, then says once when it recovers', async () => {
    const { alerts, sent, advance } = harness();
    for (let run = 0; run < 5; run++) {
      await alerts.checkBacklog(2);
      advance(MINUTE);
    }
    for (let run = 0; run < 30; run++) {
      await alerts.checkBacklog(2);
      advance(MINUTE);
    }
    expect(sent).toHaveLength(1);
    advance(ALERT_REPEAT_MS);
    await alerts.checkBacklog(2);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe('[deployhealth worker] check-endpoints left 2 due endpoints unclaimed 36 runs in a row, not counting per-host spacing: checks are falling behind their intervals.');

    await alerts.checkBacklog(0);
    await alerts.checkBacklog(0);
    expect(sent.slice(2)).toEqual(['[deployhealth worker] check-endpoints is claiming every due endpoint again.']);
  });

  it('is a no-op without an operator webhook', async () => {
    await expect(NO_OPERATOR_ALERTS.checkBacklog(9)).resolves.toBeUndefined();
  });
});
