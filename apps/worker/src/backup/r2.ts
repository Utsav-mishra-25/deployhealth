import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import aws4 from 'aws4';
import { r2Request, type R2HttpRequest, type R2HttpResponse } from '../guarded-http';

/**
 * The backup bucket on Cloudflare R2, through its S3 API: requests are signed with AWS Signature
 * Version 4 (aws4, region `auto`) and sent through guarded-http's r2Request (R2 hosts only).
 * Messages name the method, the key and R2's error code, never credentials.
 */

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface R2Object {
  key: string;
  size: number;
  lastModified: Date;
}

export class R2Error extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'R2Error';
  }
}

/** The empty body's SHA-256, for requests without one. */
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** Sign an S3 request (aws4): returns the headers to send. Exposed for the signing test. */
export function signS3(
  request: { host: string; method: string; path: string; headers: Record<string, string | number>; region: string },
  credentials: { accessKeyId: string; secretAccessKey: string },
  extraHeadersToInclude?: Record<string, boolean>,
): Record<string, string | number> {
  // aws4 reads extraHeadersToInclude (its types don't list it): the signing test signs a Range header.
  const options = { host: request.host, method: request.method, path: request.path, service: 's3', region: request.region, headers: { ...request.headers }, extraHeadersToInclude };
  const signed = aws4.sign(options as aws4.Request, credentials);
  return signed.headers as Record<string, string | number>;
}

/** A key's path: `/<bucket>/<key>`, each segment percent-encoded. */
function objectPath(bucket: string, key: string): string {
  return `/${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/** The value of `<tag>…</tag>` in `xml` from `from`, XML entities decoded; linear (indexOf only). */
function tagValue(xml: string, tag: string, from = 0, to = xml.length): string | null {
  const open = xml.indexOf(`<${tag}>`, from);
  if (open === -1 || open >= to) return null;
  const close = xml.indexOf(`</${tag}>`, open);
  if (close === -1 || close > to) return null;
  return decodeXml(xml.slice(open + tag.length + 2, close));
}

function decodeXml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (_m, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name]!);
}

/** A ListObjectsV2 page: its objects, and the token for the next page when it's truncated. In linear time. */
export function parseListObjects(xml: string): { objects: R2Object[]; nextToken: string | null } {
  const objects: R2Object[] = [];
  let at = 0;
  for (;;) {
    const open = xml.indexOf('<Contents>', at);
    if (open === -1) break;
    const close = xml.indexOf('</Contents>', open);
    if (close === -1) break;
    const key = tagValue(xml, 'Key', open, close);
    const size = Number(tagValue(xml, 'Size', open, close));
    const lastModified = new Date(tagValue(xml, 'LastModified', open, close) ?? '');
    if (key !== null && Number.isFinite(size) && !Number.isNaN(lastModified.getTime())) objects.push({ key, size, lastModified });
    at = close + '</Contents>'.length;
  }
  const truncated = tagValue(xml, 'IsTruncated') === 'true';
  return { objects, nextToken: truncated ? tagValue(xml, 'NextContinuationToken') : null };
}

/** SHA-256 (hex) and size of a file, streamed. */
export async function fileDigest(file: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return { sha256: hash.digest('hex'), size: (await stat(file)).size };
}

export type R2Transport = (request: R2HttpRequest) => Promise<R2HttpResponse>;

export interface R2Bucket {
  putFile(key: string, file: string, contentType?: string): Promise<void>;
  putText(key: string, text: string, contentType?: string): Promise<void>;
  list(prefix: string): Promise<R2Object[]>;
  delete(key: string): Promise<void>;
  getText(key: string): Promise<string | null>;
  getToFile(key: string, file: string): Promise<void>;
}

export function r2Bucket(config: R2Config, transport: R2Transport = r2Request): R2Bucket {
  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  const credentials = { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey };

  async function send(method: R2HttpRequest['method'], path: string, options: { headers?: Record<string, string | number>; body?: R2HttpRequest['body']; saveTo?: string; sha256?: string } = {}) {
    const headers = signS3({ host, method, path, region: 'auto', headers: { 'x-amz-content-sha256': options.sha256 ?? EMPTY_SHA256, ...options.headers } }, credentials);
    const response = await transport({ method, url: new URL(`https://${host}${path}`), headers, body: options.body, saveTo: options.saveTo });
    return response;
  }

  function fail(method: string, what: string, response: R2HttpResponse): never {
    const code = tagValue(response.body.toString('utf8'), 'Code');
    throw new R2Error(`R2 ${method} ${what} answered HTTP ${response.status}${code ? ` (${code})` : ''}`, response.status);
  }

  return {
    async putFile(key, file, contentType = 'application/octet-stream') {
      const { sha256, size } = await fileDigest(file);
      const response = await send('PUT', objectPath(config.bucket, key), { headers: { 'content-type': contentType, 'content-length': size }, body: { file }, sha256 });
      if (response.status !== 200) fail('PUT', key, response);
    },

    async putText(key, text, contentType = 'application/json') {
      const body = Buffer.from(text, 'utf8');
      const sha256 = createHash('sha256').update(body).digest('hex');
      const response = await send('PUT', objectPath(config.bucket, key), { headers: { 'content-type': contentType, 'content-length': body.length }, body, sha256 });
      if (response.status !== 200) fail('PUT', key, response);
    },

    async list(prefix) {
      const objects: R2Object[] = [];
      let token: string | null = null;
      // At most 100 pages of 1,000: far beyond what the bucket holds (4 dumps and a manifest).
      for (let page = 0; page < 100; page++) {
        const query = new URLSearchParams({ 'list-type': '2', prefix, ...(token ? { 'continuation-token': token } : {}) });
        const response = await send('GET', `/${encodeURIComponent(config.bucket)}?${query.toString()}`);
        if (response.status !== 200) fail('GET', `list ${prefix}`, response);
        const result = parseListObjects(response.body.toString('utf8'));
        objects.push(...result.objects);
        if (!result.nextToken) return objects;
        token = result.nextToken;
      }
      throw new R2Error(`R2 list ${prefix} has more than 100 pages`, 0);
    },

    async delete(key) {
      const response = await send('DELETE', objectPath(config.bucket, key));
      if (response.status !== 204 && response.status !== 200) fail('DELETE', key, response);
    },

    async getText(key) {
      const response = await send('GET', objectPath(config.bucket, key));
      if (response.status === 404) return null;
      if (response.status !== 200) fail('GET', key, response);
      return response.body.toString('utf8');
    },

    async getToFile(key, file) {
      const response = await send('GET', objectPath(config.bucket, key), { saveTo: file });
      if (response.status !== 200) fail('GET', key, response);
    },
  };
}
