import * as Sentry from '@sentry/node';
type Integration = { name: string };
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REDACTED } from '../src/redact';
import { initSentry, parseCommitSha, parseDsn, reportError, sentryOptions } from '../src/sentry';

// The real SDK with a transport that keeps what it would have sent: an error thrown with a
// secret-looking string in its message and its context must leave the process scrubbed.
const TOKEN = `dh_${'Zq7Xw2'.repeat(7)}`;
const SLACK = `https://hooks.slack.com/services/T0001/B0002/${'xS3cret9'.repeat(3)}`;
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const DSN = 'https://publickey@o1.ingest.example.com/42';

const sent: string[] = [];

beforeAll(() => {
  const options = sentryOptions({ dsn: DSN, release: SHA, environment: 'test' }, 'worker');
  Sentry.init({
    ...options,
    // The production options, minus the process-level handlers (not for a test runner), and a
    // transport that records what it would have sent.
    integrations: (options.integrations as Integration[]).filter((i) => !/^OnUn/.test(i.name)),
    transport: (transportOptions) =>
      Sentry.createTransport(transportOptions, async (request) => {
        sent.push(typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body));
        return { statusCode: 200 };
      }),
  });
});

afterAll(async () => {
  await Sentry.close();
});

describe('error reports', () => {
  it('scrubs a thrown error with a token and a Slack webhook URL in its message and context', async () => {
    Sentry.withScope((scope) => {
      scope.setExtras({ webhookUrl: SLACK, note: `posting with ${TOKEN} to ${SLACK}`, env: `AUTH_SECRET=${'k'.repeat(40)}` });
      scope.setContext('job', { token: TOKEN, url: SLACK, cookie: 'authjs.session-token=abc' });
      scope.setTag('queue', 'check-endpoints');
      scope.addBreadcrumb({ message: `log line with ${TOKEN}` });
      try {
        throw new Error(`webhook ${SLACK} refused token ${TOKEN}`);
      } catch (error) {
        reportError(error, { queue: 'check-endpoints' });
      }
    });
    await Sentry.flush(2_000);
    const body = sent.join('\n');
    expect(body).toContain('webhook https://hooks.slack.com/[redacted] refused token [redacted]');
    for (const secret of [TOKEN, 'xS3cret9', 'authjs.session-token', 'kkkkkkkk']) expect(body).not.toContain(secret);
    expect(body).not.toContain('"breadcrumbs"');
    expect(body).not.toContain('"job"');
    // The release is the commit SHA, as set; the queue tag stays readable.
    expect(body).toContain(`"release":"${SHA}"`);
    expect(body).toContain('check-endpoints');
    expect(body).toContain(REDACTED);
  });
});

describe('initSentry', () => {
  it('stays off without a DSN, and says so once for one that does not parse', () => {
    const logs: string[] = [];
    expect(initSentry({ dsn: null, release: null, environment: 'test' }, 'web', (m) => logs.push(m))).toBe(false);
    expect(logs).toEqual([]);
    expect(initSentry({ dsn: `https://hooks.example.com/${TOKEN}`, release: null, environment: 'test' }, 'web', (m) => logs.push(m))).toBe(false);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/SENTRY_DSN is not a Sentry DSN/);
    expect(logs[0]).not.toContain(TOKEN);
  });

  it('takes a release only from a hex commit SHA', () => {
    expect(parseCommitSha(` ${SHA.toUpperCase()} `)).toBe(SHA);
    expect(parseCommitSha('main')).toBeNull();
    expect(parseCommitSha(undefined)).toBeNull();
  });

  it('parses DSNs', () => {
    expect(parseDsn(DSN)).toBe(DSN);
    expect(parseDsn('https://o1.ingest.example.com/42')).toBeNull();
    expect(parseDsn('ftp://k@x/1')).toBeNull();
    expect(parseDsn('nope')).toBeNull();
  });

  it('sends nothing but errors: no tracing, no PII, no default integrations', () => {
    const options = sentryOptions({ dsn: DSN, release: null, environment: 'production' }, 'web');
    expect(options).toMatchObject({ sendDefaultPii: false, skipOpenTelemetrySetup: true, includeLocalVariables: false, maxBreadcrumbs: 0, defaultIntegrations: false });
    expect(options.tracesSampleRate).toBeUndefined();
    expect(options.release).toBeUndefined();
  });
});
