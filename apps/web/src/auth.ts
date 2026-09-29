import { ensureDevUser, linkInstallationsForUser, upsertGithubUser } from '@deployhealth/db';
import NextAuth, { type DefaultSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { serverEnv } from '@/env';
import { buildProviders } from '@/lib/auth-providers';
import { getDb } from '@/lib/db';

declare module 'next-auth' {
  interface Session {
    user: { id: string; login: string } & DefaultSession['user'];
  }
}

/**
 * Claims this app adds to the Auth.js JWT. (`next-auth/jwt` only re-exports `@auth/core/jwt`,
 * which can't be augmented from here without depending on @auth/core directly.)
 */
interface AppClaims {
  userId?: string;
  login?: string;
}

interface GithubProfile {
  id: number | string;
  login: string;
  name?: string | null;
  email?: string | null;
  avatar_url?: string | null;
}

// Config is built per request (lazily) so env validation never runs during `next build`.
export const { handlers, auth, signIn, signOut } = NextAuth(() => {
  const env = serverEnv();
  return {
    secret: env.AUTH_SECRET,
    // Railway (and most PaaS) terminate TLS at a proxy; trust its Host / X-Forwarded-* headers.
    trustHost: true,
    session: { strategy: 'jwt' },
    pages: { signIn: '/login' },
    providers: buildProviders(env, async () => {
      const user = await ensureDevUser(getDb());
      return { id: user.id, name: user.name, email: user.email, image: user.avatarUrl };
    }),
    callbacks: {
      // Runs with `account`/`profile` only at sign-in; afterwards the JWT already carries userId.
      async jwt({ token: jwt, account, profile, user }) {
        const token = jwt as typeof jwt & AppClaims;
        if (account?.provider === 'github' && profile) {
          const gh = profile as unknown as GithubProfile;
          const dbUser = await upsertGithubUser(getDb(), {
            githubId: Number(gh.id),
            login: gh.login,
            name: gh.name,
            email: gh.email,
            avatarUrl: gh.avatar_url,
          });
          // GitHub App installations this account made before signing up become theirs now.
          await linkInstallationsForUser(getDb(), dbUser.id, dbUser.githubId);
          token.userId = dbUser.id;
          token.login = dbUser.login;
        } else if (account?.provider === 'dev' && user?.id) {
          token.userId = user.id;
          token.login = 'dev';
        }
        return token;
      },
      session({ session, token }) {
        const claims = token as typeof token & AppClaims;
        if (claims.userId) session.user.id = claims.userId;
        if (claims.login) session.user.login = claims.login;
        return session;
      },
    },
  };
});

/** The signed-in user, or a redirect to /login. Use at the top of every protected page/action. */
export async function requireUser(): Promise<{ id: string; login: string; name?: string | null; image?: string | null }> {
  const session = await auth();
  if (!session?.user?.id) redirect('/login');
  return session.user;
}
