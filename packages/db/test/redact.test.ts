import { describe, expect, it } from 'vitest';
import { installConsoleRedaction, REDACTED, redactPath, redactText, redactValue, scrubErrorEvent } from '../src/redact';

// What the servers print and report must never carry a token, a webhook URL, a cookie, an env
// value or anything shaped like a secret. Secret-looking strings are built at run time.
const TOKEN = `dh_${'Ab1x'.repeat(10)}`;
const SLACK = `https://hooks.slack.com/services/T0001/B0002/${'s3cretXy'.repeat(3)}`;
const DISCORD = 'https://discord.com/api/webhooks/123456/abcDEF_ghi';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const BASE64_KEY = 'q9X2mB7vT4kL1pZ8wR6yN3cF5hJ0dS2a+GQ=';

function assertClean(text: string, ...secrets: string[]): void {
  for (const secret of secrets) expect(text).not.toContain(secret);
}

describe('redactText', () => {
  it('replaces an ingest token', () => {
    expect(redactText(`token ${TOKEN} rejected`)).toBe(`token ${REDACTED} rejected`);
  });

  it('keeps only the host of a webhook URL', () => {
    expect(redactText(`posting to ${SLACK} failed`)).toBe(`posting to https://hooks.slack.com/${REDACTED} failed`);
    expect(redactText(DISCORD)).toBe(`https://discord.com/${REDACTED}`);
  });

  it('keeps a bare origin as it is', () => {
    expect(redactText('see https://deployhealth.dev/ and https://deployhealth.dev')).toBe('see https://deployhealth.dev/ and https://deployhealth.dev');
  });

  it('drops credentials and paths from database URLs', () => {
    const out = redactText('connect postgres://deployhealth:hunter2pass@db.internal:5432/deployhealth');
    assertClean(out, 'hunter2pass', 'deployhealth:');
    expect(out).toContain('db.internal:5432');
  });

  it('redacts a full 40-hex commit SHA', () => {
    expect(redactText(`release ${SHA}`)).toBe(`release ${REDACTED}`);
  });

  it('keeps a short SHA and uuids, which identify without revealing', () => {
    expect(redactText('deploy 0123456 for project 3f2b6c1e-8d4a-4f3b-9c2d-1a2b3c4d5e6f')).toBe('deploy 0123456 for project 3f2b6c1e-8d4a-4f3b-9c2d-1a2b3c4d5e6f');
  });

  it('redacts random-looking base64 keys and hex secrets', () => {
    assertClean(redactText(`key ${BASE64_KEY}`), BASE64_KEY.slice(0, 20));
    assertClean(redactText(`hex ${'af09'.repeat(16)}`), 'af09af09af09');
  });

  it('redacts cookies and authorization headers to the end of the line', () => {
    const out = redactText('cookie: authjs.session-token=eyJabc.def; other=1\nAuthorization: Bearer abcdefgh12345678\nnext line');
    assertClean(out, 'authjs.session-token=eyJ', 'abcdefgh12345678');
    expect(out).toContain('next line');
  });

  it('redacts bearer tokens, JWTs and GitHub tokens', () => {
    const jwt = `eyJ${'hbGciOi'}.eyJzdWIiOiIx.${'sig_Part-1'}`;
    const gh = `ghs_${'A1b2C3d4'.repeat(3)}`;
    assertClean(redactText(`Bearer ${'xyzXYZ123'.repeat(2)} then ${jwt} and ${gh}`), 'xyzXYZ123', 'hbGciOi', 'A1b2C3d4');
  });

  it('redacts env assignments and secret-named pairs, never the name', () => {
    const out = redactText('AUTH_SECRET=supersecretvalue STRIPE_KEY=sk_live_1 {"apiKey": "k-123"} password=pw1');
    assertClean(out, 'supersecretvalue', 'sk_live_1', 'k-123', 'pw1');
    expect(out).toContain('AUTH_SECRET=');
    expect(out).toContain('STRIPE_KEY=');
  });

  it('redacts email addresses', () => {
    expect(redactText('mail someone.else+x@example.co.uk now')).toBe(`mail ${REDACTED} now`);
  });

  it('leaves ordinary log lines alone', () => {
    const line = '[check] api.example.com could not be processed: TypeError ECONNRESET';
    expect(redactText(line)).toBe(line);
    const alert = '[alert] opened: acme-storefront: Acme API started failing 4m after deploy b52952e, which introduced 2 missing env vars: REDIS_URL, STRIPE_KEY';
    expect(redactText(alert)).toBe(alert);
  });

  it('runs in linear time on hostile inputs', () => {
    // Long runs that almost match each pattern: a quadratic regex takes seconds on these.
    const inputs = [
      'a'.repeat(200_000),
      `${'a1'.repeat(100_000)}:`,
      'ab://'.repeat(40_000),
      'x@'.repeat(100_000),
      `${'A'.repeat(100_000)}=`,
      'password '.repeat(20_000),
      'f'.repeat(31).concat(' ').repeat(6_000),
      `${'aB3'.repeat(10)} `.repeat(6_000),
    ];
    for (const input of inputs) {
      const started = performance.now();
      redactText(input);
      expect(performance.now() - started).toBeLessThan(1_000);
    }
  });
});

describe('redactPath', () => {
  it('keeps the path and drops the query, redacting a share token', () => {
    const shareToken = `${'djEuYWJj'.repeat(4)}.${'Zm9vYmFy1X'.repeat(4)}`;
    const out = redactPath(`https://deployhealth.dev/share/reports/${shareToken}?x=${TOKEN}`);
    assertClean(out, 'djEuYWJj', TOKEN);
    expect(out.startsWith('https://deployhealth.dev/share/reports/')).toBe(true);
  });
});

describe('redactValue', () => {
  it('drops secret-named keys and redacts every string, deeply', () => {
    const out = JSON.stringify(
      redactValue({ webhookUrl: SLACK, headers: { cookie: 'a=b' }, nested: { note: `uses ${TOKEN}`, list: [`sha ${SHA}`] }, count: 3 }),
    );
    assertClean(out, 's3cretXy', 'a=b', TOKEN, SHA);
    expect(out).toContain('"count":3');
  });

  it('survives cycles', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(redactValue(a)).toEqual({ name: 'a', self: REDACTED });
  });
});

describe('scrubErrorEvent', () => {
  it('removes request data, user, breadcrumbs and source context, and redacts what remains', () => {
    const event = {
      message: `failed with ${TOKEN}`,
      request: { method: 'POST', url: `https://deployhealth.dev/api/ingest/scan?token=${TOKEN}`, headers: { cookie: 'authjs.session-token=x' }, cookies: { a: 'b' }, data: '{"secret":1}', query_string: 'a=b' },
      user: { email: 'u@example.com', ip_address: '1.2.3.4' },
      breadcrumbs: [{ message: `console ${SLACK}` }],
      exception: { values: [{ type: 'Error', value: `post to ${SLACK}`, stacktrace: { frames: [{ filename: 'a.js', vars: { token: TOKEN }, context_line: `const t = '${TOKEN}'` }] } }] },
      extra: { webhookUrl: SLACK, note: `env DATABASE_URL=postgres://u:p@h/db` },
      tags: { route: '/projects/[projectId]' },
      contexts: { runtime: { name: 'node' }, response: { headers: { 'set-cookie': 'x' } } },
    };
    const out = JSON.stringify(scrubErrorEvent(event));
    assertClean(out, TOKEN, 's3cretXy', 'authjs', 'u@example.com', '1.2.3.4', 'query_string', 'u:p@');
    expect(event.request).toEqual({ method: 'POST', url: 'https://deployhealth.dev/api/ingest/scan' });
    expect(event.exception.values[0]!.stacktrace.frames[0]).toEqual({ filename: 'a.js' });
    expect(event.contexts).toEqual({ runtime: { name: 'node' } });
    expect(event.tags).toEqual({ route: '/projects/[projectId]' });
  });
});

describe('installConsoleRedaction', () => {
  it('formats, redacts and prints one string, once installed', () => {
    const printed: unknown[][] = [];
    const target = { log: (...a: unknown[]) => printed.push(a), info: () => {}, warn: () => {}, error: (...a: unknown[]) => printed.push(a), debug: () => {}, trace: () => {} };
    installConsoleRedaction(target);
    installConsoleRedaction(target); // idempotent
    target.log('[webhook] %s failed', SLACK);
    target.error('[worker] error', new Error(`bad token ${TOKEN}`));
    expect(printed).toHaveLength(2);
    expect(printed[0]).toEqual([`[webhook] https://hooks.slack.com/${REDACTED} failed`]);
    assertClean(String(printed[1]![0]), TOKEN);
    expect(String(printed[1]![0])).toContain('bad token');
  });
});
