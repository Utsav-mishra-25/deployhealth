import { describe, expect, it } from 'vitest';
import { sendWebhook, type Poster } from '../src/webhook';

function poster(...results: Array<number | Error>) {
  const calls: string[] = [];
  const post: Poster = async (url, body) => {
    calls.push(`${url.host} ${body}`);
    const next = results[Math.min(calls.length - 1, results.length - 1)]!;
    if (next instanceof Error) throw next;
    return next;
  };
  return Object.assign(post, { calls });
}

const payload = { text: '[down] shop: api.acme.com started failing' };

describe('sendWebhook', () => {
  it('posts {text} once when it succeeds', async () => {
    const post = poster(200);
    expect(await sendWebhook('https://hooks.slack.com/services/T/B/secret', payload, { post, log: () => {} })).toBe(true);
    expect(post.calls).toEqual([`hooks.slack.com ${JSON.stringify(payload)}`]);
  });

  it('retries exactly once after a failure', async () => {
    const post = poster(new Error('ECONNRESET'), 204);
    expect(await sendWebhook('https://hooks.slack.com/x', payload, { post, log: () => {} })).toBe(true);
    expect(post.calls).toHaveLength(2);
  });

  it('gives up after two attempts, logging without leaking the URL path', async () => {
    const post = poster(500, 500, 500);
    const logs: string[] = [];
    expect(await sendWebhook('https://hooks.slack.com/services/T/B/secret', payload, { post, log: (m) => logs.push(m) })).toBe(false);
    expect(post.calls).toHaveLength(2);
    expect(logs).toEqual([
      '[webhook] hooks.slack.com answered HTTP 500 (attempt 1 of 2)',
      '[webhook] hooks.slack.com answered HTTP 500 (attempt 2 of 2)',
    ]);
    expect(logs.join(' ')).not.toContain('secret');
  });

  it('never posts to private addresses', async () => {
    const post = poster(200);
    const logs: string[] = [];
    expect(await sendWebhook('http://169.254.169.254/latest', payload, { post, log: (m) => logs.push(m) })).toBe(false);
    expect(await sendWebhook('http://localhost:9000/hook', payload, { post, log: (m) => logs.push(m) })).toBe(false);
    expect(post.calls).toEqual([]);
    expect(logs).toHaveLength(2);
  });
});
