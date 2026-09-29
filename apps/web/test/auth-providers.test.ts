import { describe, expect, it } from 'vitest';
import { buildProviders, isDemoLoginEnabled } from '@/lib/auth-providers';

const findDevUser = async () => ({ id: 'u1', name: 'Dev', email: null, image: null });
const github = { AUTH_GITHUB_ID: 'gh-id', AUTH_GITHUB_SECRET: 'gh-secret' };

/** Resolve ids the way Auth.js does (@auth/core lib/utils/providers.js): `options.id ?? id`. */
function providerIds(env: Parameters<typeof buildProviders>[0]): string[] {
  return buildProviders(env, findDevUser).map((entry) => {
    const provider = (typeof entry === 'function' ? entry() : entry) as { id: string; options?: { id?: string } };
    return provider.options?.id ?? provider.id;
  });
}

describe('dev login provider', () => {
  it('is registered when AUTH_DEMO_LOGIN=1 outside production', () => {
    expect(providerIds({ ...github, AUTH_DEMO_LOGIN: '1', NODE_ENV: 'development' })).toEqual(['github', 'dev']);
    expect(providerIds({ ...github, AUTH_DEMO_LOGIN: '1', NODE_ENV: 'test' })).toEqual(['github', 'dev']);
  });

  it('is absent in production even when AUTH_DEMO_LOGIN=1', () => {
    expect(providerIds({ ...github, AUTH_DEMO_LOGIN: '1', NODE_ENV: 'production' })).toEqual(['github']);
    expect(isDemoLoginEnabled({ AUTH_DEMO_LOGIN: '1', NODE_ENV: 'production' })).toBe(false);
  });

  it('is absent when AUTH_DEMO_LOGIN is not 1', () => {
    for (const NODE_ENV of ['development', 'test', 'production'] as const) {
      expect(providerIds({ ...github, AUTH_DEMO_LOGIN: '0', NODE_ENV })).toEqual(['github']);
      expect(isDemoLoginEnabled({ AUTH_DEMO_LOGIN: '0', NODE_ENV })).toBe(false);
    }
  });
});

describe('GitHub provider', () => {
  it('is registered only when both OAuth credentials are set', () => {
    expect(providerIds({ AUTH_DEMO_LOGIN: '0', NODE_ENV: 'development' })).toEqual([]);
    expect(providerIds({ AUTH_GITHUB_ID: 'x', AUTH_DEMO_LOGIN: '1', NODE_ENV: 'development' })).toEqual(['dev']);
  });
});
