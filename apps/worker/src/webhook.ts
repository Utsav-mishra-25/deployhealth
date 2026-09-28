import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { BlockedUrlError, guardedLookup, isBlockedAddress, parsePublicHttpUrl } from '@deployhealth/core';
import { USER_AGENT } from './check';

export const WEBHOOK_TIMEOUT_MS = 5_000;

/** POST a JSON body; resolves with the status code. Must honour `signal`. */
export type Poster = (url: URL, body: string, signal: AbortSignal) => Promise<number>;

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

/** The real poster: node:http(s) with the SSRF-guarded lookup; no redirects; body unread. */
export const guardedPost: Poster = (url, body, signal) =>
  new Promise<number>((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && isBlockedAddress(host)) {
      reject(new BlockedUrlError(`${host} is a private or reserved address`));
      return;
    }
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      url,
      {
        method: 'POST',
        signal,
        lookup: guardedLookup,
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'user-agent': USER_AGENT,
        },
      },
      (res) => {
        resolve(res.statusCode ?? 0);
        res.destroy();
      },
    );
    req.on('error', reject);
    req.end(body);
  });
