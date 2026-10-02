import { generateKeyPairSync, verify } from 'node:crypto';
import { BlockedUrlError } from '@deployhealth/core';
import { describe, expect, it } from 'vitest';
import { githubApi } from '../src/github/api';
import { createGithubApp } from '../src/github/app';
import { githubFetch } from '../src/guarded-http';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

describe('createGithubApp', () => {
  it('signs an App JWT, exchanges it for an installation token once, and reuses the token until it expires', async () => {
    const requests: Array<{ method: string; url: string; auth: string | null }> = [];
    const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      const auth = new Headers(init.headers).get('authorization');
      requests.push({ method: init.method ?? 'GET', url, auth });
      if (url === 'https://api.github.com/app/installations/7/access_tokens') {
        return Response.json({ token: 'ghs_installationtoken', expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 });
      }
      if (url.startsWith('https://api.github.com/repos/acme/shop/git/blobs/')) {
        return Response.json({ content: Buffer.from('hello').toString('base64'), encoding: 'base64' });
      }
      return new Response('{}', { status: 404 });
    }) as typeof globalThis.fetch;

    const app = createGithubApp({ appId: 5126679, privateKey: PEM }, { fetch });
    const api = githubApi(app.forInstallation(7), 'acme/shop', { appId: 1 });
    expect((await api.blob('aaa')).toString()).toBe('hello');
    expect((await githubApi(app.forInstallation(7), 'acme/shop', { appId: 1 }).blob('bbb')).toString()).toBe('hello');

    const tokenRequests = requests.filter((r) => r.url.endsWith('/access_tokens'));
    expect(tokenRequests).toHaveLength(1);
    // The token request carries a JWT signed with the App's private key, issued by the App id.
    const jwt = tokenRequests[0]!.auth!.replace(/^bearer /i, '');
    const [header, payload, signature] = jwt.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    expect(String(claims.iss)).toBe('5126679');
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(11 * 60); // GitHub accepts at most 10 minutes (plus clock drift)
    expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
    // Repository calls use the installation token.
    expect(requests.filter((r) => r.url.includes('/git/blobs/')).map((r) => r.auth)).toEqual(['token ghs_installationtoken', 'token ghs_installationtoken']);
    expect(requests.every((r) => r.url.startsWith('https://api.github.com/'))).toBe(true);
  });
});

describe('githubFetch', () => {
  it('talks to api.github.com only', async () => {
    await expect(githubFetch('https://evil.example/repos')).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(githubFetch('http://api.github.com/repos')).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(githubFetch('https://api.github.com.evil.example/')).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(githubFetch('https://169.254.169.254/latest/meta-data/')).rejects.toBeInstanceOf(BlockedUrlError);
  });
});
