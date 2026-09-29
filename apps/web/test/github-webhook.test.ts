import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { handleGithubWebhook, verifySignature, WEBHOOK_RATE_LIMIT, type GithubWebhookDeps } from '@/lib/github-webhook';
import { createRateLimiter } from '@/lib/rate-limit';

// A fake secret, assembled so secret scanners don't mistake the test for a leak.
const SECRET = ['whsec', 'test', '0123456789abcdef'].join('-');
const sign = (body: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

let deliveries = 0;
function delivery(event: string, payload: object, { signature, id }: { signature?: string | null; id?: string } = {}) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': id ?? `delivery-${++deliveries}` };
  const sig = signature === undefined ? sign(body) : signature;
  if (sig !== null) headers['x-hub-signature-256'] = sig;
  return new Request('http://localhost/api/github/webhook', { method: 'POST', headers, body });
}

function setup(overrides: Partial<GithubWebhookDeps> = {}) {
  const calls: string[] = [];
  const seen = new Set<string>();
  const logs: string[] = [];
  let t = 0;
  const deps: GithubWebhookDeps = {
    secret: SECRET,
    limiter: createRateLimiter({ ...WEBHOOK_RATE_LIMIT, now: () => t }),
    recordDelivery: async (id) => (seen.has(id) ? false : (seen.add(id), true)),
    forgetDelivery: async (id) => void seen.delete(id),
    upsertInstallation: async (input, repos) => void calls.push(`upsert ${JSON.stringify(input)} ${JSON.stringify(repos ?? null)}`),
    changeInstallationRepos: async (id, change) => void calls.push(`repos ${id} ${JSON.stringify(change)}`),
    setInstallationSuspended: async (id, at) => void calls.push(`suspended ${id} ${at ? 'yes' : 'no'}`),
    deleteInstallation: async (id) => void calls.push(`delete ${id}`),
    markPullRequestClosed: async (id, repo, n, at) => void calls.push(`closed ${id} ${repo}#${n} ${at ? 'yes' : 'no'}`),
    enqueuePrCheck: async (job) => void calls.push(`enqueue ${JSON.stringify(job)}`),
    log: (m) => void logs.push(m),
    now: () => new Date('2026-09-29T12:00:00Z'),
    ...overrides,
  };
  return { deps, calls, logs, advance: (ms: number) => (t += ms) };
}

const pr = (action: string, extra: object = {}) => ({
  action,
  number: 42,
  installation: { id: 7 },
  repository: { full_name: 'acme/shop' },
  pull_request: { title: 'Add STRIPE_KEY=sk_live_not_really', body: 'super secret body text' },
  ...extra,
});

describe('signature verification', () => {
  it('accepts a valid signature and rejects tampered, missing, malformed or wrong-secret ones with 401', async () => {
    const body = '{"zen":"Keep it logically awesome."}';
    expect(verifySignature(SECRET, Buffer.from(body), sign(body))).toBe(true);
    expect(verifySignature(SECRET, Buffer.from(`${body} `), sign(body))).toBe(false); // tampered
    expect(verifySignature(SECRET, Buffer.from(body), null)).toBe(false); // missing
    expect(verifySignature(SECRET, Buffer.from(body), 'sha1=abc')).toBe(false);
    expect(verifySignature(SECRET, Buffer.from(body), `sha256=${'0'.repeat(63)}`)).toBe(false);
    expect(verifySignature(SECRET, Buffer.from(body), sign(body, 'another-secret-entirely'))).toBe(false);

    const { deps, calls } = setup();
    expect((await handleGithubWebhook(delivery('ping', { zen: 'hi', hook_id: 1 }), deps)).status).toBe(202);
    const tampered = delivery('pull_request', pr('opened'), { signature: sign(JSON.stringify(pr('closed'))) });
    expect((await handleGithubWebhook(tampered, deps)).status).toBe(401);
    expect((await handleGithubWebhook(delivery('pull_request', pr('opened'), { signature: null }), deps)).status).toBe(401);
    expect((await handleGithubWebhook(delivery('pull_request', pr('opened'), { signature: 'sha256=zz' }), deps)).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('answers 404 when the App is not configured, and 413 past 5 MB', async () => {
    expect((await handleGithubWebhook(delivery('ping', {}), setup({ secret: undefined }).deps)).status).toBe(404);
    const huge = JSON.stringify({ padding: 'x'.repeat(5 * 1024 * 1024) });
    const request = new Request('http://localhost/api/github/webhook', { method: 'POST', headers: { 'x-hub-signature-256': sign(huge), 'x-github-event': 'ping', 'x-github-delivery': 'big' }, body: huge });
    expect((await handleGithubWebhook(request, setup().deps)).status).toBe(413);
  });
});

describe('delivery dedupe', () => {
  it('processes a delivery id once; a redelivery is acknowledged but not handled again', async () => {
    const { deps, calls } = setup();
    const first = await handleGithubWebhook(delivery('pull_request', pr('opened'), { id: 'same' }), deps);
    const again = await handleGithubWebhook(delivery('pull_request', pr('opened'), { id: 'same' }), deps);
    expect([first.status, again.status]).toEqual([202, 202]);
    expect(await again.json()).toEqual({ result: 'duplicate' });
    expect(calls).toEqual(['enqueue {"installationId":7,"repoFullName":"acme/shop","prNumber":42}']);
  });

  it('forgets the delivery when handling fails, so a redelivery runs it again', async () => {
    let fail = true;
    const { deps, calls } = setup({
      enqueuePrCheck: async (job) => {
        if (fail) throw new Error('queue down');
        calls.push(`enqueue ${job.prNumber}`);
      },
    });
    expect((await handleGithubWebhook(delivery('pull_request', pr('opened'), { id: 'retry-me' }), deps)).status).toBe(500);
    fail = false;
    expect((await handleGithubWebhook(delivery('pull_request', pr('opened'), { id: 'retry-me' }), deps)).status).toBe(202);
    expect(calls).toEqual(['enqueue 42']);
  });
});

describe('rate limit per installation', () => {
  it('allows 120 deliveries a minute per installation, then answers 429 with Retry-After', async () => {
    const { deps, calls, advance } = setup();
    for (let i = 0; i < 120; i++) expect((await handleGithubWebhook(delivery('pull_request', pr('labeled')), deps)).status).toBe(202);
    advance(15_000);
    const limited = await handleGithubWebhook(delivery('pull_request', pr('opened')), deps);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('45');
    expect(calls).toEqual([]); // nothing handled, nothing recorded
    // Another installation is unaffected; the first recovers after the window.
    expect((await handleGithubWebhook(delivery('pull_request', pr('opened', { installation: { id: 8 } })), deps)).status).toBe(202);
    advance(45_000);
    expect((await handleGithubWebhook(delivery('pull_request', pr('opened')), deps)).status).toBe(202);
  });

  it('only counts deliveries whose signature checks out', async () => {
    const { deps } = setup();
    for (let i = 0; i < 200; i++) await handleGithubWebhook(delivery('pull_request', pr('opened'), { signature: sign('forged') }), deps);
    expect((await handleGithubWebhook(delivery('pull_request', pr('opened')), deps)).status).toBe(202);
  });
});

describe('events', () => {
  const installation = (action: string, extra: object = {}) => ({
    action,
    installation: { id: 7, account: { login: 'acme', type: 'Organization' } },
    sender: { id: 101, login: 'alice' },
    ...extra,
  });

  it('handles installation events inline', async () => {
    const { deps, calls } = setup();
    await handleGithubWebhook(delivery('installation', installation('created', { repositories: [{ full_name: 'acme/shop' }, { full_name: 'acme/api' }] })), deps);
    await handleGithubWebhook(delivery('installation', installation('suspend')), deps);
    await handleGithubWebhook(delivery('installation', installation('unsuspend')), deps);
    await handleGithubWebhook(delivery('installation_repositories', { action: 'added', installation: { id: 7 }, repositories_added: [{ full_name: 'acme/site' }], repositories_removed: [] }), deps);
    await handleGithubWebhook(delivery('installation', installation('deleted')), deps);
    expect(calls).toEqual([
      'upsert {"githubInstallationId":7,"accountLogin":"acme","accountType":"Organization","installerGithubId":101} ["acme/shop","acme/api"]',
      'suspended 7 yes',
      'upsert {"githubInstallationId":7,"accountLogin":"acme","accountType":"Organization","installerGithubId":101} null',
      'suspended 7 no',
      'repos 7 {"added":["acme/site"],"removed":[]}',
      'delete 7',
    ]);
  });

  it('queues a check for a new head or base, marks closed and reopened, ignores the rest', async () => {
    const { deps, calls } = setup();
    for (const action of ['opened', 'synchronize', 'labeled', 'closed', 'reopened']) await handleGithubWebhook(delivery('pull_request', pr(action)), deps);
    await handleGithubWebhook(delivery('pull_request', pr('edited', { changes: { title: { from: 'x' } } })), deps);
    await handleGithubWebhook(delivery('pull_request', pr('edited', { changes: { base: { ref: { from: 'develop' } } } })), deps);
    const job = 'enqueue {"installationId":7,"repoFullName":"acme/shop","prNumber":42}';
    expect(calls).toEqual([job, job, 'closed 7 acme/shop#42 yes', 'closed 7 acme/shop#42 no', job, job]);
  });

  it('never writes payload contents to the log', async () => {
    const { deps, logs } = setup();
    await handleGithubWebhook(delivery('pull_request', pr('opened')), deps);
    await handleGithubWebhook(delivery('pull_request', { action: 'opened', number: 'not-a-number' }), deps);
    expect(logs.length).toBe(2);
    for (const line of logs) {
      expect(line).not.toMatch(/sk_live|secret body|STRIPE|acme\/shop/);
    }
  });
});
