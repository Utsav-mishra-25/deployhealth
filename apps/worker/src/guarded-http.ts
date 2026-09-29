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
