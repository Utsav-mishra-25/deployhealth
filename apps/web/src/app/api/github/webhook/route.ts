import {
  changeInstallationRepos,
  deleteInstallation,
  forgetDelivery,
  markPullRequestClosed,
  recordDelivery,
  setInstallationSuspended,
  upsertInstallation,
} from '@deployhealth/db';
import { serverEnv } from '@/env';
import { getDb } from '@/lib/db';
import { handleGithubWebhook, WEBHOOK_RATE_LIMIT } from '@/lib/github-webhook';
import { enqueuePrCheck } from '@/lib/jobs';
import { createRateLimiter } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// Per server process (see lib/rate-limit.ts), keyed by installation id after the signature checks out.
const limiter = createRateLimiter(WEBHOOK_RATE_LIMIT);

export function POST(request: Request): Promise<Response> {
  const db = getDb();
  return handleGithubWebhook(request, {
    secret: serverEnv().GITHUB_APP_WEBHOOK_SECRET,
    limiter,
    recordDelivery: (id) => recordDelivery(db, id),
    forgetDelivery: (id) => forgetDelivery(db, id),
    upsertInstallation: (input, repos) => upsertInstallation(db, input, repos),
    changeInstallationRepos: (id, change) => changeInstallationRepos(db, id, change),
    setInstallationSuspended: (id, at) => setInstallationSuspended(db, id, at),
    deleteInstallation: (id) => deleteInstallation(db, id),
    markPullRequestClosed: (id, repo, prNumber, at) => markPullRequestClosed(db, id, repo, prNumber, at),
    enqueuePrCheck,
    log: (message) => console.log(message),
  });
}
