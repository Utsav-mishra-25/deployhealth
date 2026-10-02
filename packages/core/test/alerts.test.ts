import { describe, expect, it } from 'vitest';
import {
  alertOpenedMessage,
  alertResolvedMessage,
  decideAlert,
  endpointLabel,
  failingFor,
  formatDuration,
  uptimeStatus,
  webhookPayload,
  escapeChatText,
  type AlertAction,
} from '../src/alerts';
import { newMissingVars } from '../src/findings';

/** Feed a sequence of check results through the state machine, tracking state like the worker does. */
function run(results: boolean[]): AlertAction[] {
  let failures = 0;
  let hasOk = false;
  let open = false;
  return results.map((ok) => {
    failures = ok ? 0 : failures + 1;
    hasOk ||= ok;
    const action = decideAlert({ ok, consecutiveFailures: failures, hasOkHistory: hasOk, hasOpenAlert: open });
    if (action === 'open') open = true;
    if (action === 'resolve') open = false;
    return action;
  });
}

describe('decideAlert', () => {
  it('opens on the second consecutive failure after an ok check, and resolves on the next ok', () => {
    expect(run([true, false, false, false, true])).toEqual(['none', 'none', 'open', 'none', 'resolve']);
  });

  it('ignores a single failure', () => {
    expect(run([true, false, true, false, true])).toEqual(['none', 'none', 'none', 'none', 'none']);
  });

  it('never alerts for an endpoint that has never been up', () => {
    expect(run([false, false, false, false])).toEqual(['none', 'none', 'none', 'none']);
  });

  it('starts counting once the endpoint has worked', () => {
    expect(run([false, false, true, false, false])).toEqual(['none', 'none', 'none', 'none', 'open']);
  });

  it('keeps one alert open through a long outage and can open again after recovery', () => {
    expect(run([true, false, false, false, false, true, false, false])).toEqual([
      'none',
      'none',
      'open',
      'none',
      'none',
      'resolve',
      'none',
      'open',
    ]);
  });

  it('never opens a second alert while one is open', () => {
    expect(decideAlert({ ok: false, consecutiveFailures: 9, hasOkHistory: true, hasOpenAlert: true })).toBe('none');
  });
});

describe('alert messages', () => {
  const deployedAt = new Date('2026-09-28T12:00:00Z');
  const deploy = { sha: 'b52952e8192c38c054e53b5447ea20de88f2e2e9', deployedAt };
  const at = (minutes: number) => new Date(deployedAt.getTime() + minutes * 60_000);

  it('names the deploy and the new MISSING vars', () => {
    expect(
      alertOpenedMessage({
        endpoint: { url: 'https://api.acme.com/health' },
        firstFailureAt: at(4),
        deploy,
        newMissing: ['REDIS_URL', 'STRIPE_KEY'],
      }),
    ).toBe('api.acme.com started failing 4m after deploy b52952e, which introduced 2 missing env vars: REDIS_URL, STRIPE_KEY');
  });

  it('uses the singular for one variable', () => {
    expect(alertOpenedMessage({ endpoint: { url: 'https://x.dev' }, firstFailureAt: at(12.5), deploy, newMissing: ['A'] })).toBe(
      'x.dev started failing 12m after deploy b52952e, which introduced 1 missing env var: A',
    );
  });

  it('names variables new in a scope with no env file, which have no MISSING rows', () => {
    expect(
      alertOpenedMessage({ endpoint: { name: 'Acme API', url: 'https://x.dev' }, firstFailureAt: at(4), deploy, newMissing: [], newUndeclared: ['REDIS_URL', 'STRIPE_KEY'] }),
    ).toBe('Acme API started failing 4m after deploy b52952e, which introduced 2 new env vars no env file declares: REDIS_URL, STRIPE_KEY');
    expect(alertOpenedMessage({ endpoint: { url: 'https://x.dev' }, firstFailureAt: at(4), deploy, newMissing: [], newUndeclared: ['A'] })).toBe(
      'x.dev started failing 4m after deploy b52952e, which introduced 1 new env var no env file declares: A',
    );
  });

  it('names both kinds when a deploy has both', () => {
    expect(alertOpenedMessage({ endpoint: { url: 'https://x.dev' }, firstFailureAt: at(4), deploy, newMissing: ['A'], newUndeclared: ['B', 'C'] })).toBe(
      'x.dev started failing 4m after deploy b52952e, which introduced 1 missing env var: A, plus 2 new env vars no env file declares: B, C',
    );
  });

  describe('caps the names it lists, keeping the counts exact', () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `VAR_${String(i + 1).padStart(2, '0')}`);
    const lead = 'x.dev started failing 4m after deploy b52952e, which introduced';
    const missing = (n: number) => alertOpenedMessage({ endpoint: { url: 'https://x.dev' }, firstFailureAt: at(4), deploy, newMissing: names(n) });
    const undeclared = (n: number) =>
      alertOpenedMessage({ endpoint: { url: 'https://x.dev' }, firstFailureAt: at(4), deploy, newMissing: [], newUndeclared: names(n) });

    it('lists every name up to six', () => {
      expect(missing(1)).toBe(`${lead} 1 missing env var: VAR_01`);
      expect(missing(5)).toBe(`${lead} 5 missing env vars: VAR_01, VAR_02, VAR_03, VAR_04, VAR_05`);
      expect(missing(6)).toBe(`${lead} 6 missing env vars: VAR_01, VAR_02, VAR_03, VAR_04, VAR_05, VAR_06`);
      expect(undeclared(1)).toBe(`${lead} 1 new env var no env file declares: VAR_01`);
      expect(undeclared(5)).toBe(`${lead} 5 new env vars no env file declares: VAR_01, VAR_02, VAR_03, VAR_04, VAR_05`);
      expect(undeclared(6)).toBe(`${lead} 6 new env vars no env file declares: VAR_01, VAR_02, VAR_03, VAR_04, VAR_05, VAR_06`);
    });

    it('lists five and "and N more" above six', () => {
      expect(missing(7)).toBe(`${lead} 7 missing env vars: VAR_01, VAR_02, VAR_03, VAR_04, VAR_05 and 2 more`);
      expect(missing(40)).toBe(`${lead} 40 missing env vars: VAR_01, VAR_02, VAR_03, VAR_04, VAR_05 and 35 more`);
      expect(undeclared(40)).toBe(`${lead} 40 new env vars no env file declares: VAR_01, VAR_02, VAR_03, VAR_04, VAR_05 and 35 more`);
    });

    it('caps each kind separately in the ", plus" join', () => {
      const both = alertOpenedMessage({
        endpoint: { url: 'https://x.dev' },
        firstFailureAt: at(4),
        deploy,
        newMissing: names(40),
        newUndeclared: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
      });
      expect(both).toBe(
        `${lead} 40 missing env vars: VAR_01, VAR_02, VAR_03, VAR_04, VAR_05 and 35 more, plus 7 new env vars no env file declares: A, B, C, D, E and 2 more`,
      );
      expect(alertOpenedMessage({ endpoint: { url: 'https://x.dev' }, firstFailureAt: at(4), deploy, newMissing: ['A'], newUndeclared: names(6) })).toBe(
        `${lead} 1 missing env var: A, plus 6 new env vars no env file declares: VAR_01, VAR_02, VAR_03, VAR_04, VAR_05, VAR_06`,
      );
    });

    it('reads the same in the webhook, which reuses the message', () => {
      expect(webhookPayload('opened', 'acme', missing(40)).text).toBe(`[down] acme: ${lead} 40 missing env vars: VAR_01, VAR_02, VAR_03, VAR_04, VAR_05 and 35 more`);
    });
  });

  it('says so when the linked deploy had no new findings', () => {
    expect(alertOpenedMessage({ endpoint: { url: 'https://x.dev' }, firstFailureAt: at(0.5), deploy, newMissing: [] })).toBe(
      'x.dev started failing under a minute after deploy b52952e, which had no new config findings',
    );
  });

  it('says so when there was no deploy in the window', () => {
    expect(alertOpenedMessage({ endpoint: { url: 'https://x.dev:8443/' }, firstFailureAt: at(0), deploy: null, newMissing: [] })).toBe(
      'x.dev:8443 started failing; no deploy in the 30 minutes before the first failure',
    );
  });

  it('describes resolution and webhook payloads', () => {
    expect(alertResolvedMessage({ endpoint: { url: 'https://x.dev' }, openedAt: at(0), resolvedAt: at(75) })).toBe(
      'x.dev is back up (alert open for 1h 15m)',
    );
    expect(webhookPayload('opened', 'shop', 'x.dev started failing')).toEqual({ text: '[down] shop: x.dev started failing' });
    expect(webhookPayload('resolved', 'shop', 'x.dev is back up')).toEqual({ text: '[resolved] shop: x.dev is back up' });
  });

  it('escapes chat markup and mass mentions in webhook text', () => {
    const name = '<!channel> & <@U123> <https://evil.example|click> @everyone @here @Channel';
    const { text } = webhookPayload('opened', name, `${name} started failing`);
    expect(text).not.toMatch(/[<>]/);
    expect(text).not.toMatch(/@(everyone|here|channel)/i);
    expect(text).toBe(
      '[down] &lt;!channel&gt; &amp; &lt;@U123&gt; &lt;https://evil.example|click&gt; @\u200beveryone @\u200bhere @\u200bChannel: ' +
        '&lt;!channel&gt; &amp; &lt;@U123&gt; &lt;https://evil.example|click&gt; @\u200beveryone @\u200bhere @\u200bChannel started failing',
    );
    expect(escapeChatText('a@everyoneelse b@here.')).toBe('a@everyoneelse b@\u200bhere.');
  });

  it('formats durations and labels', () => {
    expect([0, 59_999, 60_000, 3_600_000, 3_660_000].map(formatDuration)).toEqual(['under a minute', 'under a minute', '1m', '1h', '1h 1m']);
    const hours = (h: number) => h * 3_600_000;
    expect([hours(23) + 3_540_000, hours(24), hours(24) + 3_540_000, hours(51)].map(formatDuration)).toEqual(['23h 59m', '1d', '1d', '2d 3h']);
    expect(endpointLabel({ url: 'https://api.acme.com/health?x=1' })).toBe('api.acme.com');
    expect(endpointLabel({ url: 'not a url' })).toBe('not a url');
  });

  it('names endpoints by their name when set, falling back to the host', () => {
    expect(endpointLabel({ url: 'https://api.acme.com/health', name: 'Acme API' })).toBe('Acme API');
    expect(endpointLabel({ url: 'https://api.acme.com/health', name: '  Acme API  ' })).toBe('Acme API');
    expect(endpointLabel({ url: 'https://api.acme.com/health', name: '   ' })).toBe('api.acme.com');
    expect(endpointLabel({ url: 'https://api.acme.com/health', name: null })).toBe('api.acme.com');

    const endpoint = { url: 'https://api.acme.com/health', name: 'Acme API' };
    const deploy = { sha: 'b52952e0000000000000000000000000000000000', deployedAt: at(0) };
    const opened = alertOpenedMessage({ endpoint, firstFailureAt: at(4), deploy, newMissing: ['REDIS_URL', 'STRIPE_KEY'] });
    expect(opened).toBe('Acme API started failing 4m after deploy b52952e, which introduced 2 missing env vars: REDIS_URL, STRIPE_KEY');
    expect(alertResolvedMessage({ endpoint, openedAt: at(0), resolvedAt: at(21) })).toBe('Acme API is back up (alert open for 21m)');
    expect(webhookPayload('opened', 'shop', opened).text).toBe(`[down] shop: ${opened}`);
  });
});

describe('failingFor', () => {
  const now = new Date('2026-09-28T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it('measures from the first failed check of the run to now, in whole minutes', () => {
    expect(failingFor('down', ago(21 * 60_000), now)).toBe('Down for 21m');
    expect(failingFor('down', ago(21 * 60_000 + 59_999), now)).toBe('Down for 21m');
    expect(failingFor('down', ago(3_600_000 + 5 * 60_000), now)).toBe('Down for 1h 5m');
    expect(failingFor('down', ago(3 * 86_400_000 + 7_200_000), now)).toBe('Down for 3d 2h');
  });

  it('puts the endpoint first when given one', () => {
    expect(failingFor('down', ago(22 * 60_000), now, 'Acme API')).toBe('Acme API down for 22m');
    expect(failingFor('failing', ago(60_000), now, 'cdn.acme.com +1 more')).toBe('cdn.acme.com +1 more failing for 1m');
  });

  it('says Failing before an alert opens, and never goes negative', () => {
    expect(failingFor('failing', ago(90_000), now)).toBe('Failing for 1m');
    expect(failingFor('failing', ago(10_000), now)).toBe('Failing for under a minute');
    expect(failingFor('down', new Date(now.getTime() + 5_000), now)).toBe('Down for under a minute');
  });
});

describe('newMissingVars', () => {
  const missing = (var_name: string) => ({ kind: 'missing' as const, var_name });

  it('returns MISSING vars that were not MISSING in the previous scan', () => {
    expect(
      newMissingVars(
        [missing('STRIPE_KEY'), missing('REDIS_URL'), missing('REDIS_URL'), missing('OLD'), { kind: 'unused', var_name: 'U' }],
        [missing('OLD'), { kind: 'unused', var_name: 'REDIS_URL' }],
      ),
    ).toEqual(['REDIS_URL', 'STRIPE_KEY']);
  });

  it('treats everything as new without a previous scan, and nothing as new when unchanged', () => {
    expect(newMissingVars([missing('B'), missing('A')], null)).toEqual(['A', 'B']);
    expect(newMissingVars([missing('A')], [missing('A')])).toEqual([]);
  });
});

describe('uptimeStatus', () => {
  it.each([
    [{ enabledEndpoints: 0, openAlerts: 0, failingEndpoints: 0 }, 'no_endpoints'],
    [{ enabledEndpoints: 2, openAlerts: 1, failingEndpoints: 1 }, 'down'],
    [{ enabledEndpoints: 2, openAlerts: 0, failingEndpoints: 1 }, 'degraded'],
    [{ enabledEndpoints: 2, openAlerts: 0, failingEndpoints: 0 }, 'up'],
  ] as const)('%o → %s', (input, expected) => {
    expect(uptimeStatus(input)).toBe(expected);
  });
});
