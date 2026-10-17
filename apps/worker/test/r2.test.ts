import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlockedUrlError } from '@deployhealth/core';
import { afterAll, describe, expect, it } from 'vitest';
import { parseListObjects, r2Bucket, R2Error, signS3, type R2Transport } from '../src/backup/r2';
import { R2_HOST, r2Request, type R2HttpRequest } from '../src/guarded-http';

const dir = mkdtempSync(join(tmpdir(), 'deployhealth-r2-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CONFIG = { accountId: 'a'.repeat(32), bucket: 'deployhealth-backups', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret-key-never-logged' };

describe('signing (AWS Signature Version 4, via aws4)', () => {
  it("matches AWS's published S3 example: GET /test.txt with a Range header", () => {
    // docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html, "Example: GET Object".
    const headers = signS3(
      {
        host: 'examplebucket.s3.amazonaws.com',
        method: 'GET',
        path: '/test.txt',
        region: 'us-east-1',
        headers: {
          Range: 'bytes=0-9',
          'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          'x-amz-date': '20130524T000000Z',
        },
      },
      { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
      { range: true },
    );
    expect(headers.Authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it("signs R2 requests for region auto and service s3, the body's hash included", async () => {
    const sent: R2HttpRequest[] = [];
    const transport: R2Transport = async (request) => {
      sent.push(request);
      return { status: 200, body: Buffer.alloc(0) };
    };
    await r2Bucket(CONFIG, transport).putText('deletions.json', '{"a":1}');
    const [request] = sent;
    expect(request!.url.toString()).toBe(`https://${'a'.repeat(32)}.r2.cloudflarestorage.com/deployhealth-backups/deletions.json`);
    expect(String(request!.headers.Authorization)).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(request!.headers['x-amz-content-sha256']).toBe(createHash('sha256').update('{"a":1}').digest('hex'));
    expect(JSON.stringify(request!.headers)).not.toContain('secret-key-never-logged');
  });
});

describe('r2Request: R2 hosts only', () => {
  it('refuses any other host, plain http, and a port, before connecting', async () => {
    for (const url of ['https://example.com/x', `http://${'a'.repeat(32)}.r2.cloudflarestorage.com/x`, `https://${'a'.repeat(32)}.r2.cloudflarestorage.com:8443/x`, 'https://evil.r2.cloudflarestorage.com.example.com/x']) {
      await expect(r2Request({ method: 'GET', url: new URL(url), headers: {} })).rejects.toThrow(BlockedUrlError);
    }
  });

  it('accepts account hosts and the EU jurisdiction', () => {
    expect(R2_HOST.test(`${'0f'.repeat(16)}.r2.cloudflarestorage.com`)).toBe(true);
    expect(R2_HOST.test(`${'0f'.repeat(16)}.eu.r2.cloudflarestorage.com`)).toBe(true);
    expect(R2_HOST.test('short.r2.cloudflarestorage.com')).toBe(false);
  });
});

const listing = (keys: string[], next?: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>b</Name>${keys
    .map((k, i) => `<Contents><Key>${k}</Key><LastModified>2026-10-1${i}T03:41:00.000Z</LastModified><Size>${100 + i}</Size></Contents>`)
    .join('')}<IsTruncated>${next ? 'true' : 'false'}</IsTruncated>${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ''}</ListBucketResult>`;

describe('listing', () => {
  it('parses objects, decodes entities, and follows continuation tokens', async () => {
    expect(parseListObjects(listing(['deployhealth/a&amp;b.dump']))).toEqual({
      objects: [{ key: 'deployhealth/a&b.dump', size: 100, lastModified: new Date('2026-10-10T03:41:00Z') }],
      nextToken: null,
    });
    const pages = [listing(['deployhealth/1.dump'], 'tok/1+='), listing(['deployhealth/2.dump'])];
    const urls: string[] = [];
    const transport: R2Transport = async (request) => {
      urls.push(request.url.search);
      return { status: 200, body: Buffer.from(pages.shift()!) };
    };
    const objects = await r2Bucket(CONFIG, transport).list('deployhealth/');
    expect(objects.map((o) => o.key)).toEqual(['deployhealth/1.dump', 'deployhealth/2.dump']);
    expect(urls).toEqual(['?list-type=2&prefix=deployhealth%2F', '?list-type=2&prefix=deployhealth%2F&continuation-token=tok%2F1%2B%3D']);
  });

  it('parses a hostile listing in linear time', () => {
    for (const xml of ['<Contents>'.repeat(200_000), `${'<Contents><Key>'.repeat(100_000)}</Contents>`, '<Key>'.repeat(300_000)]) {
      const started = performance.now();
      parseListObjects(xml);
      expect(performance.now() - started).toBeLessThan(1_000);
    }
  });
});

describe('errors', () => {
  it("name the method, the key and R2's code, never the credentials", async () => {
    const transport: R2Transport = async () => ({ status: 403, body: Buffer.from('<Error><Code>AccessDenied</Code><Message>no</Message></Error>') });
    const file = join(dir, 'x.dump');
    writeFileSync(file, 'dump');
    const error = await r2Bucket(CONFIG, transport)
      .putFile('deployhealth/x.dump', file)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(R2Error);
    expect((error as Error).message).toBe('R2 PUT deployhealth/x.dump answered HTTP 403 (AccessDenied)');
  });

  it('a missing deletions.json is null, not an error', async () => {
    const transport: R2Transport = async () => ({ status: 404, body: Buffer.from('<Error><Code>NoSuchKey</Code></Error>') });
    expect(await r2Bucket(CONFIG, transport).getText('deletions.json')).toBeNull();
  });
});
