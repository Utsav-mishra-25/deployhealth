import type { Provider } from 'next-auth/providers';
import Credentials from 'next-auth/providers/credentials';
import GitHub from 'next-auth/providers/github';
import type { ServerEnv } from '@/env';

/**
 * The OAuth scopes GitHub sign-in asks for. Set explicitly (they're also Auth.js's default for
 * GitHub) because /login, /security and /privacy describe them. Neither gives repository access.
 * `user:email` lets Auth.js read the account's email addresses when the profile email is private;
 * it keeps the primary one, which is stored (see auth.ts).
 */
export const GITHUB_OAUTH_SCOPES = ['read:user', 'user:email'] as const;

/** What each scope we request lets sign-in read, in plain words. */
const SCOPE_READS: Record<(typeof GITHUB_OAUTH_SCOPES)[number], string> = {
  'read:user': 'your GitHub profile (id, login, name and avatar)',
  'user:email': 'your email address, even if it is private on GitHub',
};

/**
 * "Sign-in reads your GitHub profile (…) and your email address, even if it is private on GitHub
 * (scopes read:user, user:email)." Derived from GITHUB_OAUTH_SCOPES, shown on /login, /security
 * and /privacy.
 */
export function githubSignInReads(): string {
  const reads = GITHUB_OAUTH_SCOPES.map((scope) => SCOPE_READS[scope]);
  const list = reads.length > 1 ? `${reads.slice(0, -1).join(', ')} and ${reads.at(-1)}` : reads[0];
  return `Sign-in reads ${list} (GitHub scopes ${GITHUB_OAUTH_SCOPES.join(', ')}).`;
}

export interface DevUser {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

/**
 * The dev login ("Continue as dev user", provider id `dev`) exists only when AUTH_DEMO_LOGIN=1 AND
 * NODE_ENV is not production. Both conditions are checked here, where the provider list is built,
 * so a production deployment never even registers the provider (tested in
 * test/auth-providers.test.ts). It signs in as the local dev account, not the read-only public
 * demo user.
 */
export function isDemoLoginEnabled(env: Pick<ServerEnv, 'AUTH_DEMO_LOGIN' | 'NODE_ENV'>): boolean {
  return env.AUTH_DEMO_LOGIN === '1' && env.NODE_ENV !== 'production';
}

export function buildProviders(
  env: Pick<ServerEnv, 'AUTH_DEMO_LOGIN' | 'NODE_ENV' | 'AUTH_GITHUB_ID' | 'AUTH_GITHUB_SECRET'>,
  findDevUser: () => Promise<DevUser | null>,
): Provider[] {
  const providers: Provider[] = [];

  if (env.AUTH_GITHUB_ID && env.AUTH_GITHUB_SECRET) {
    providers.push(
      GitHub({
        clientId: env.AUTH_GITHUB_ID,
        clientSecret: env.AUTH_GITHUB_SECRET,
        // Deep-merged into the provider's defaults: only the scope changes (to the same value, made explicit).
        authorization: { params: { scope: GITHUB_OAUTH_SCOPES.join(' ') } },
      }),
    );
  }

  if (isDemoLoginEnabled(env)) {
    providers.push(
      Credentials({
        id: 'dev',
        name: 'Dev account',
        credentials: {},
        // Signs in as the local dev account (created on first use).
        authorize: () => findDevUser(),
      }),
    );
  }

  return providers;
}
