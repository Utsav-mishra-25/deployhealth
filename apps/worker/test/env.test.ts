import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseWorkerEnv } from '../src/env';

const DATABASE_URL = 'postgres://localhost:5432/deployhealth';

describe('parseWorkerEnv', () => {
  it('defaults the demo to off and needs no base URL then', () => {
    expect(parseWorkerEnv({ DATABASE_URL, DEMO_PUBLIC: undefined, DEMO_BASE_URL: undefined })).toEqual({
      DATABASE_URL,
      NODE_ENV: 'development',
      DEMO_PUBLIC: '0',
      DEMO_BASE_URL: null,
      GITHUB_APP: null,
      SENTRY_DSN: null,
      RAILWAY_GIT_COMMIT_SHA: null,
      OPERATOR_WEBHOOK_URL: null,
    });
  });

  it('keeps the optional observability settings raw and never throws over them', () => {
    const env = parseWorkerEnv({ DATABASE_URL, SENTRY_DSN: ' not a dsn ', OPERATOR_WEBHOOK_URL: 'nope', RAILWAY_GIT_COMMIT_SHA: 'ABCDEF0123456789abcdef0123456789abcdef01' });
    expect(env).toMatchObject({ SENTRY_DSN: 'not a dsn', OPERATOR_WEBHOOK_URL: 'nope', RAILWAY_GIT_COMMIT_SHA: 'abcdef0123456789abcdef0123456789abcdef01' });
    expect(parseWorkerEnv({ DATABASE_URL, RAILWAY_GIT_COMMIT_SHA: 'main' }).RAILWAY_GIT_COMMIT_SHA).toBeNull();
  });

  it('requires an http(s) DEMO_BASE_URL when DEMO_PUBLIC=1', () => {
    expect(parseWorkerEnv({ DATABASE_URL, DEMO_PUBLIC: '1', DEMO_BASE_URL: 'https://web.up.railway.app' })).toMatchObject({
      DEMO_PUBLIC: '1',
      DEMO_BASE_URL: 'https://web.up.railway.app',
    });
    expect(() => parseWorkerEnv({ DATABASE_URL, DEMO_PUBLIC: '1', DEMO_BASE_URL: undefined })).toThrow(/needs DEMO_BASE_URL/);
    expect(() => parseWorkerEnv({ DATABASE_URL, DEMO_PUBLIC: '1', DEMO_BASE_URL: 'not a url' })).toThrow(/not a URL/);
    expect(() => parseWorkerEnv({ DATABASE_URL, DEMO_PUBLIC: '1', DEMO_BASE_URL: 'ftp://x.dev' })).toThrow(/http\(s\)/);
  });

  it('rejects anything but 0 or 1, and a missing DATABASE_URL', () => {
    expect(() => parseWorkerEnv({ DATABASE_URL, DEMO_PUBLIC: 'yes', DEMO_BASE_URL: undefined })).toThrow(/0 or 1/);
    expect(() => parseWorkerEnv({ DATABASE_URL: undefined, DEMO_PUBLIC: undefined, DEMO_BASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });

  it('reads the GitHub App id and its base64 PEM key, and never echoes the key in errors', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const b64 = Buffer.from(pem).toString('base64');
    expect(parseWorkerEnv({ DATABASE_URL, GITHUB_APP_ID: '123456', GITHUB_APP_PRIVATE_KEY: b64 }).GITHUB_APP).toEqual({ appId: 123456, privateKey: pem });
    // A raw PEM with escaped newlines (how some dashboards store it) works too.
    expect(parseWorkerEnv({ DATABASE_URL, GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: pem.replace(/\n/g, '\\n') }).GITHUB_APP?.privateKey).toBe(pem);

    expect(() => parseWorkerEnv({ DATABASE_URL, GITHUB_APP_ID: '123456' })).toThrow(/both GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY/);
    expect(() => parseWorkerEnv({ DATABASE_URL, GITHUB_APP_ID: 'deployhealth', GITHUB_APP_PRIVATE_KEY: b64 })).toThrow(/numeric id/);
    const secretLooking = Buffer.from('secret-but-not-a-key').toString('base64');
    let message = '';
    try {
      parseWorkerEnv({ DATABASE_URL, GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: secretLooking });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/not a valid private key/);
    expect(message).not.toContain(secretLooking);
  });
});
