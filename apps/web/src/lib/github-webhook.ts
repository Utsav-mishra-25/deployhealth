import { createHmac, timingSafeEqual } from 'node:crypto';
import { MAX_WEBHOOK_BODY_BYTES, type PrCheckJobData } from '@deployhealth/core';
import type { InstallationInput } from '@deployhealth/db';
import { z } from 'zod';
import { readBodyUpTo } from './read-body';

/** Deliveries per installation per minute, counted after the signature checks out. */
export const WEBHOOK_RATE_LIMIT = { limit: 120, windowMs: 60_000 };

/** What the webhook queues for the worker; the job reads the pull request's current state itself. */
export type PrCheckJob = PrCheckJobData;

export interface GithubWebhookDeps {
  /** GITHUB_APP_WEBHOOK_SECRET; undefined means the App isn't configured (404). */
  secret: string | undefined;
  limiter: { check: (key: string) => { ok: boolean; retryAfterSeconds: number } };
  recordDelivery: (deliveryId: string) => Promise<boolean>;
  forgetDelivery: (deliveryId: string) => Promise<void>;
  upsertInstallation: (input: InstallationInput, repos?: readonly string[]) => Promise<unknown>;
  changeInstallationRepos: (githubInstallationId: number, change: { added: string[]; removed: string[] }) => Promise<unknown>;
  setInstallationSuspended: (githubInstallationId: number, at: Date | null) => Promise<unknown>;
  deleteInstallation: (githubInstallationId: number) => Promise<unknown>;
  markPullRequestClosed: (githubInstallationId: number, repoFullName: string, prNumber: number, at: Date | null) => Promise<unknown>;
  enqueuePrCheck: (job: PrCheckJob) => Promise<unknown>;
  log: (message: string) => void;
  now?: () => Date;
}

/** `X-Hub-Signature-256: sha256=<hex HMAC of the raw body>`, compared in constant time. */
export function verifySignature(secret: string, body: Buffer, header: string | null): boolean {
  const match = /^sha256=([0-9a-f]{64})$/.exec(header ?? '');
  if (!match) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(match[1]!, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const repo = z.object({ full_name: z.string().min(3).max(200) });
const installationRef = z.object({ id: z.number().int() });
const installationEvent = z.object({
  action: z.string(),
  installation: installationRef.extend({ account: z.object({ login: z.string(), type: z.string() }) }),
  sender: z.object({ id: z.number().int() }),
  repositories: z.array(repo).optional(),
});
const installationReposEvent = z.object({
  action: z.string(),
  installation: installationRef,
  repositories_added: z.array(repo).default([]),
  repositories_removed: z.array(repo).default([]),
});
const pullRequestEvent = z.object({
  action: z.string(),
  number: z.number().int().positive(),
  installation: installationRef,
  repository: repo,
  changes: z.object({ base: z.unknown().optional() }).optional(),
});

type Outcome = 'handled' | 'queued' | 'ignored';

/**
 * POST /api/github/webhook. Verifies the signature before anything else, then rate-limits per
 * installation, drops redeliveries (X-GitHub-Delivery), handles installation events inline and
 * queues pull request checks. Makes no GitHub API calls, answers 202 fast, and never logs bodies.
 */
export async function handleGithubWebhook(request: Request, deps: GithubWebhookDeps): Promise<Response> {
  if (!deps.secret) return reply(404, 'not-configured');

  const body = await readBodyUpTo(request, MAX_WEBHOOK_BODY_BYTES);
  if (body === null) return reply(413, 'too-large');
  if (!verifySignature(deps.secret, body, request.headers.get('x-hub-signature-256'))) return reply(401, 'bad-signature');

  const event = request.headers.get('x-github-event') ?? '';
  const deliveryId = request.headers.get('x-github-delivery') ?? '';
  if (!deliveryId || deliveryId.length > 100) return reply(400, 'no-delivery-id');
  let payload: { installation?: { id?: unknown } } & Record<string, unknown>;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    return reply(400, 'invalid-json');
  }

  const installationId = typeof payload.installation?.id === 'number' ? payload.installation.id : null;
  const limit = deps.limiter.check(installationId === null ? 'app' : `installation:${installationId}`);
  if (!limit.ok) return reply(429, 'rate-limited', { 'retry-after': String(limit.retryAfterSeconds) });

  if (!(await deps.recordDelivery(deliveryId))) return reply(202, 'duplicate');
  try {
    const outcome = await dispatch(event, payload, deps);
    deps.log(`[github] ${event}${typeof payload.action === 'string' ? `.${payload.action}` : ''} ${deliveryId}: ${outcome}`);
    return reply(202, outcome);
  } catch (error) {
    // Let GitHub's redelivery run it again.
    await deps.forgetDelivery(deliveryId);
    deps.log(`[github] ${event} ${deliveryId} failed: ${error instanceof z.ZodError ? 'unexpected payload shape' : (error as Error).message}`);
    return reply(error instanceof z.ZodError ? 400 : 500, 'failed');
  }
}

async function dispatch(event: string, payload: unknown, deps: GithubWebhookDeps): Promise<Outcome> {
  const now = deps.now?.() ?? new Date();
  switch (event) {
    case 'installation': {
      const e = installationEvent.parse(payload);
      const id = e.installation.id;
      const input = { githubInstallationId: id, accountLogin: e.installation.account.login, accountType: e.installation.account.type, installerGithubId: e.sender.id };
      if (e.action === 'created') await deps.upsertInstallation(input, (e.repositories ?? []).map((r) => r.full_name));
      else if (e.action === 'new_permissions_accepted' || e.action === 'unsuspend') {
        await deps.upsertInstallation(input);
        await deps.setInstallationSuspended(id, null);
      } else if (e.action === 'suspend') await deps.setInstallationSuspended(id, now);
      else if (e.action === 'deleted') await deps.deleteInstallation(id);
      else return 'ignored';
      return 'handled';
    }
    case 'installation_repositories': {
      const e = installationReposEvent.parse(payload);
      await deps.changeInstallationRepos(e.installation.id, {
        added: e.repositories_added.map((r) => r.full_name),
        removed: e.repositories_removed.map((r) => r.full_name),
      });
      return 'handled';
    }
    case 'pull_request': {
      const e = pullRequestEvent.parse(payload);
      const job = { installationId: e.installation.id, repoFullName: e.repository.full_name, prNumber: e.number };
      if (e.action === 'closed') {
        await deps.markPullRequestClosed(job.installationId, job.repoFullName, job.prNumber, now);
        return 'handled';
      }
      if (e.action === 'reopened') await deps.markPullRequestClosed(job.installationId, job.repoFullName, job.prNumber, null);
      // A new head (opened, pushed, reopened), or a new base branch.
      if (e.action === 'opened' || e.action === 'synchronize' || e.action === 'reopened' || (e.action === 'edited' && e.changes?.base)) {
        await deps.enqueuePrCheck(job);
        return 'queued';
      }
      return 'ignored';
    }
    default:
      // ping and anything the App isn't subscribed to.
      return 'ignored';
  }
}

function reply(status: number, result: string, headers: Record<string, string> = {}): Response {
  return Response.json({ result }, { status, headers: { 'cache-control': 'no-store', ...headers } });
}
