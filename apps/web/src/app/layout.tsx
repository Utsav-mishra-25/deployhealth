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
        <header className="border-b border-gray-200 bg-white print:hidden">
          <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
            <Link href={session ? '/clients' : '/'} className="font-semibold tracking-tight">
              deploy<span className="text-emerald-600">health</span>
            </Link>
            {session?.user && (
              <div className="flex items-center gap-3 text-sm">
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
        <footer className="border-t border-gray-200 print:hidden">
          <nav aria-label="Footer" className="mx-auto flex max-w-6xl flex-wrap gap-x-6 gap-y-2 px-4 py-6 text-sm text-gray-500">
            <Link href="/security" className="hover:text-gray-900">
              Security
            </Link>
            <a href="https://github.com/Utsav-mishra-25/deployhealth" className="hover:text-gray-900">
              Source on GitHub
            </a>
          </nav>
        </footer>
      </body>
    </html>
  );
}
