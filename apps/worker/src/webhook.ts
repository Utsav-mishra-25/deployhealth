import { BlockedUrlError, parsePublicHttpUrl } from '@deployhealth/core';
import { guardedPost, type Poster } from './guarded-http';

export type { Poster } from './guarded-http';

export const WEBHOOK_TIMEOUT_MS = 5_000;

export interface WebhookDeps {
  post?: Poster;
  log?: (message: string) => void;
  timeoutMs?: number;
}

/**
 * Deliver `{ text }` to a Slack/Discord-compatible incoming webhook. At most two attempts (one
 * retry); failures are logged and swallowed so alerting never blocks checks. URLs that fail the
 * SSRF guard are not retried. Logs show only the host, since webhook URLs embed secrets.
 */
export async function sendWebhook(rawUrl: string, payload: { text: string }, deps: WebhookDeps = {}): Promise<boolean> {
  const post = deps.post ?? guardedPost;
  const log = deps.log ?? ((message) => console.warn(message));
  const timeoutMs = deps.timeoutMs ?? WEBHOOK_TIMEOUT_MS;

  let url: URL;
  try {
    url = parsePublicHttpUrl(rawUrl);
  } catch (error) {
    log(`[webhook] not sent: ${(error as Error).message}`);
    return false;
  }

  const body = JSON.stringify(payload);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const status = await post(url, body, AbortSignal.timeout(timeoutMs));
      if (status >= 200 && status < 300) return true;
      log(`[webhook] ${url.host} answered HTTP ${status} (attempt ${attempt} of 2)`);
    } catch (error) {
      log(`[webhook] ${url.host} failed: ${(error as Error).message} (attempt ${attempt} of 2)`);
      if (error instanceof BlockedUrlError) return false;
    }
  }
  return false;
}
