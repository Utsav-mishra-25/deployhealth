import { createReadStream, createWriteStream } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { BlockedUrlError, guardedLookup, isBlockedAddress, systemGuardedLookup, type EndpointMethod } from '@deployhealth/core';

/**
 * The ONLY module that opens outbound HTTP connections from deployhealth's servers. Every request
 * goes through node:http(s) with the SSRF-guarded DNS lookup, which re-checks the address at
 * connect time (so redirects and DNS rebinding are covered) on a bounded resolver (A and AAAA in
 * parallel, a deadline, failing closed); literal IPs are checked up front;
 * connections aren't pooled; response bodies are never read, except by githubFetch and r2Request
 * (fixed hosts only, capped in memory or streamed to a file). `test/no-unguarded-http.test.ts`
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

// One keep-alive agent: a check can make hundreds of blob requests to the same host. GitHub calls
// keep the guard on the system resolver (getaddrinfo), not the bounded one user URLs get.
const GITHUB_LOOKUP = systemGuardedLookup;
const githubAgent = new https.Agent({ keepAlive: true, maxSockets: 8, lookup: GITHUB_LOOKUP });

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
      const req = https.request(url, { method, signal, lookup: GITHUB_LOOKUP, agent: githubAgent, headers }, (response) => {
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

// ---------------------------------------------------------------------------------------------
// Cloudflare R2 (the backup service: dumps and deletions.json), signed by apps/worker/src/backup/r2.ts
// ---------------------------------------------------------------------------------------------

/** R2's S3 API hosts: `<32-hex account id>.r2.cloudflarestorage.com`, or its EU jurisdiction. */
export const R2_HOST = /^[0-9a-f]{32}\.(?:eu\.)?r2\.cloudflarestorage\.com$/;
/** The largest R2 response read into memory (bucket listings, deletions.json, error bodies). */
export const MAX_R2_RESPONSE_BYTES = 8 * 1024 * 1024;
const R2_TIMEOUT_MS = 30 * 60_000;

export interface R2HttpRequest {
  method: 'GET' | 'PUT' | 'DELETE';
  url: URL;
  /** Signed headers (aws4), sent as they are. */
  headers: Record<string, string | number>;
  /** A file streamed as the body (its size is in content-length), or bytes. */
  body?: { file: string } | Buffer;
  /** Stream a 200 response's body into this file instead of memory (downloads). */
  saveTo?: string;
  signal?: AbortSignal;
}

export interface R2HttpResponse {
  status: number;
  /** The body, up to MAX_R2_RESPONSE_BYTES; empty when it was saved to a file. */
  body: Buffer;
}

/**
 * One request to R2's S3 API, and nothing else: https only, an R2 host only, the guarded lookup on
 * the system resolver (a fixed host, like GitHub's), no redirects followed. The one guarded
 * function besides githubFetch that reads response bodies: capped in memory, or streamed to a file.
 */
export function r2Request(request: R2HttpRequest): Promise<R2HttpResponse> {
  const { url } = request;
  if (url.protocol !== 'https:' || !R2_HOST.test(url.hostname) || url.port) {
    return Promise.reject(new BlockedUrlError(`r2Request only talks to Cloudflare R2 (<account id>.r2.cloudflarestorage.com), not ${url.host}`));
  }
  return new Promise<R2HttpResponse>((resolve, reject) => {
    const req = https.request(
      url,
      { method: request.method, signal: request.signal ?? AbortSignal.timeout(R2_TIMEOUT_MS), lookup: systemGuardedLookup, agent: false, headers: request.headers },
      (res) => {
        const status = res.statusCode ?? 0;
        if (request.saveTo && status === 200) {
          const out = createWriteStream(request.saveTo);
          pipeline(res, out).then(() => resolve({ status, body: Buffer.alloc(0) }), reject);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_R2_RESPONSE_BYTES) {
            res.destroy();
            reject(new Error(`R2 response larger than ${MAX_R2_RESPONSE_BYTES / 1024 / 1024} MB`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (request.body && !Buffer.isBuffer(request.body)) {
      pipeline(createReadStream(request.body.file), req).catch(reject);
    } else {
      req.end(request.body);
    }
  });
}
