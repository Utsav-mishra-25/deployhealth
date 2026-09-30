import { redirect } from 'next/navigation';
import { auth, signIn } from '@/auth';
import { serverEnv } from '@/env';
import Link from 'next/link';
import { githubSignInReads, isDemoLoginEnabled } from '@/lib/auth-providers';

export const dynamic = 'force-dynamic';

const ERRORS: Record<string, string> = {
  CredentialsSignin: 'The dev sign-in failed. Check that the database is reachable and migrated.',
  OAuthCallbackError: 'GitHub sign-in was cancelled or failed. Please try again.',
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await auth()) redirect('/clients');
  const { error } = await searchParams;
  const env = serverEnv();
  const github = Boolean(env.AUTH_GITHUB_ID && env.AUTH_GITHUB_SECRET);
  const demo = isDemoLoginEnabled(env);

  return (
    <div className="mx-auto mt-8 max-w-sm rounded-xl border border-gray-200 bg-white p-6 shadow-sm sm:mt-16 sm:p-8">
      <h1 className="text-xl font-semibold">Sign in</h1>
      <p className="mt-1 text-sm text-gray-600">One page for every client project you maintain.</p>

      {error && (
        <p role="alert" className="mt-4 rounded bg-red-50 p-3 text-sm text-red-700">
          {ERRORS[error] ?? 'Sign-in failed. Please try again.'}
        </p>
      )}

      <div className="mt-6 space-y-3">
        {github && (
          <form
            action={async () => {
              'use server';
              await signIn('github', { redirectTo: '/clients' });
            }}
          >
            <button className="w-full rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700">
              Sign in with GitHub
            </button>
            <p className="mt-2 text-xs leading-relaxed text-gray-500" data-testid="signin-reads">
              {githubSignInReads()} No repository access. The optional GitHub App is separate.
            </p>
          </form>
        )}
        {demo && (
          <form
            action={async () => {
              'use server';
              await signIn('dev', { redirectTo: '/clients' });
            }}
          >
            <button className="w-full rounded-md border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50">
              Continue as dev user
            </button>
          </form>
        )}
        {!github && !demo && (
          <p className="text-sm text-gray-600">
            No sign-in method is configured. Set <code>AUTH_GITHUB_ID</code> and <code>AUTH_GITHUB_SECRET</code>, or{' '}
            <code>AUTH_DEMO_LOGIN=1</code> for local development.
          </p>
        )}
      </div>

      {env.DEMO_PUBLIC === '1' && (
        <p className="mt-6 border-t border-gray-100 pt-4 text-center text-sm text-gray-600">
          Just looking?{' '}
          <Link href="/demo" className="font-medium text-emerald-700 hover:underline">
            See a live demo
          </Link>
          , no sign-in needed.
        </p>
      )}
    </div>
  );
}
