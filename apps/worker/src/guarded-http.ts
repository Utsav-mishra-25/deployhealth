import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { BlockedUrlError, guardedLookup, isBlockedAddress, type EndpointMethod } from '@deployhealth/core';

/**
 * The ONLY module that opens outbound HTTP connections from deployhealth's servers. Every request
 * goes through node:http(s) with the SSRF-guarded DNS lookup, which re-checks the address at
 * connect time (so redirects and DNS rebinding are covered); literal IPs are checked up front;
 * connections aren't pooled; response bodies are never read. `test/no-unguarded-http.test.ts`
 * fails CI if any other file makes requests.
 */

export const USER_AGENT = 'deployhealth-monitor/1.0 (+https://github.com/Utsav-mishra-25/deployhealth)';

/** The status line and redirect target of one response. Bodies are never read. */
export interface ResponseHead {
  status: number;
  location: string | null;
}

/** One HTTP request, resolved as soon as response headers arrive. Must honour `signal`. */
export type HttpRequester = (url: URL, method: EndpointMethod, signal: AbortSignal) => Promise<ResponseHead>;

/** POST a JSON body; resolves with the status code. Must honour `signal`. */
export type Poster = (url: URL, body: string, signal: AbortSignal) => Promise<number>;

/** One request with the guarded lookup. `body` is sent as-is; the response body is discarded. */
function send<T>(
  url: URL,
  options: { method: string; headers: Record<string, string | number>; signal: AbortSignal; body?: string },
  onHead: (res: http.IncomingMessage) => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // Literal IPs never reach `lookup`, so check them here.
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && isBlockedAddress(host)) {
      reject(new BlockedUrlError(`${host} is a private or reserved address`));
      return;
    }
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      url,
      { method: options.method, signal: options.signal, lookup: guardedLookup, agent: false, headers: options.headers },
      (res) => {
        resolve(onHead(res));
        res.destroy(); // never read or store the body
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

/** Endpoint checks: a fresh connection per request (so latency includes connect + TLS). */
export const guardedRequest: HttpRequester = (url, method, signal) =>
  send(url, { method, signal, headers: { 'user-agent': USER_AGENT, accept: '*/*' } }, (res) => ({
    status: res.statusCode ?? 0,
    location: res.headers.location ?? null,
  }));

/** Alert webhooks: POST JSON, no redirects followed. */
export const guardedPost: Poster = (url, body, signal) =>
  send(
    url,
    {
      method: 'POST',
      signal,
      body,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'user-agent': USER_AGENT },
    },
    (res) => res.statusCode ?? 0,
  );

// ---------------------------------------------------------------------------------------------
// GitHub's REST API (the pull request checks), for Octokit's `request.fetch`
// ---------------------------------------------------------------------------------------------

/** The only origin githubFetch talks to. */
export const GITHUB_API_ORIGIN = 'https://api.github.com';
/** The largest GitHub response read (a big repo's recursive tree is a few MB). */
export const MAX_GITHUB_RESPONSE_BYTES = 32 * 1024 * 1024;
const GITHUB_TIMEOUT_MS = 30_000;
const MAX_GITHUB_REDIRECTS = 3;

// One keep-alive agent: a check can make hundreds of blob requests to the same host.
const githubAgent = new https.Agent({ keepAlive: true, maxSockets: 8, lookup: guardedLookup });

/**
 * `fetch` for Octokit, restricted to api.github.com: the guarded lookup, a keep-alive agent,
 * a 30 s default timeout, response bodies read up to MAX_GITHUB_RESPONSE_BYTES, and redirects
 * followed only within api.github.com (at most 3).
 */
export async function githubFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  let url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  const body = init.body == null ? undefined : typeof init.body === 'string' || init.body instanceof Uint8Array ? init.body : null;
  if (body === null) throw new TypeError('githubFetch sends string or byte bodies only');
  const signal = init.signal ?? AbortSignal.timeout(GITHUB_TIMEOUT_MS);

  for (let hop = 0; ; hop++) {
    if (url.origin !== GITHUB_API_ORIGIN) throw new BlockedUrlError(`githubFetch only talks to ${GITHUB_API_ORIGIN}, not ${url.origin}`);
    const res = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const req = https.request(url, { method, signal, lookup: guardedLookup, agent: githubAgent, headers }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_GITHUB_RESPONSE_BYTES) {
            response.destroy();
            reject(new Error(`GitHub response larger than ${MAX_GITHUB_RESPONSE_BYTES / 1024 / 1024} MB`));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
        response.on('error', reject);
      });
      req.on('error', reject);
      req.end(body);
    });

    const location = res.headers.location;
    if ([301, 302, 307, 308].includes(res.status) && location && init.redirect !== 'manual' && hop < MAX_GITHUB_REDIRECTS) {
      url = new URL(location, url);
      continue;
    }
    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(res.headers)) {
      if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    const noBody = res.status === 204 || res.status === 205 || res.status === 304 || method === 'HEAD';
    return new Response(noBody ? null : new Uint8Array(res.body), { status: res.status, headers: responseHeaders });
  }
}
