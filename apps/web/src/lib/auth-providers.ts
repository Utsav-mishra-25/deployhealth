import type { Provider } from 'next-auth/providers';
import Credentials from 'next-auth/providers/credentials';
import GitHub from 'next-auth/providers/github';
import type { ServerEnv } from '@/env';

export interface DemoUser {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

/**
 * The demo login exists only when AUTH_DEMO_LOGIN=1 AND NODE_ENV is not production. Both
 * conditions are checked here, where the provider list is built, so a production deployment
 * never even registers the provider (tested in test/auth-providers.test.ts).
 */
export function isDemoLoginEnabled(env: Pick<ServerEnv, 'AUTH_DEMO_LOGIN' | 'NODE_ENV'>): boolean {
  return env.AUTH_DEMO_LOGIN === '1' && env.NODE_ENV !== 'production';
}

export function buildProviders(
  env: Pick<ServerEnv, 'AUTH_DEMO_LOGIN' | 'NODE_ENV' | 'AUTH_GITHUB_ID' | 'AUTH_GITHUB_SECRET'>,
  findDemoUser: () => Promise<DemoUser | null>,
): Provider[] {
  const providers: Provider[] = [];

  if (env.AUTH_GITHUB_ID && env.AUTH_GITHUB_SECRET) {
    providers.push(GitHub({ clientId: env.AUTH_GITHUB_ID, clientSecret: env.AUTH_GITHUB_SECRET }));
  }

  if (isDemoLoginEnabled(env)) {
    providers.push(
      Credentials({
        id: 'demo',
        name: 'Demo account',
        credentials: {},
        // Signs in as the seeded demo user; fails if `pnpm db:seed` hasn't run.
        authorize: () => findDemoUser(),
      }),
    );
  }

  return providers;
}
