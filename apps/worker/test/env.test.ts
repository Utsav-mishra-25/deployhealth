import { describe, expect, it } from 'vitest';
import { parseWorkerEnv } from '../src/env';

const DATABASE_URL = 'postgres://localhost:5432/deployhealth';

describe('parseWorkerEnv', () => {
  it('defaults the demo to off and needs no base URL then', () => {
    expect(parseWorkerEnv({ DATABASE_URL, DEMO_PUBLIC: undefined, DEMO_BASE_URL: undefined })).toEqual({
      DATABASE_URL,
      DEMO_PUBLIC: '0',
      DEMO_BASE_URL: null,
    });
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
});
