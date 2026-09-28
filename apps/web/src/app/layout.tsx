import type { Metadata } from 'next';
import Link from 'next/link';
import { auth, signOut } from '@/auth';
import './globals.css';

export const metadata: Metadata = {
  title: 'deployhealth',
  description: 'One page for every client project you maintain: is the config sane, is it up, and did the last deploy break it.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-50 text-gray-900 antialiased">
        <header className="border-b border-gray-200 bg-white">
          <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
            <Link href={session ? '/clients' : '/'} className="font-semibold tracking-tight">
              deploy<span className="text-emerald-600">health</span>
            </Link>
            {session?.user && (
              <div className="flex items-center gap-3 text-sm">
                {session.user.image && (
                  // eslint-disable-next-line @next/next/no-img-element -- tiny avatar, no optimisation needed
                  <img src={session.user.image} alt="" className="h-6 w-6 rounded-full" />
                )}
                <span className="text-gray-700" data-testid="current-user">
                  {session.user.login}
                </span>
                <form
                  action={async () => {
                    'use server';
                    await signOut({ redirectTo: '/login' });
                  }}
                >
                  <button className="text-gray-500 hover:text-gray-900">Sign out</button>
                </form>
              </div>
            )}
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
