import type { Metadata } from 'next';
import Link from 'next/link';
import { auth, signOut } from '@/auth';
import { appUrl } from '@/lib/app-url';
import { SITE_DESCRIPTION } from '@/lib/brand';
import { REPO_URL } from '@/lib/legal';
import './globals.css';

/**
 * Site-wide: absolute URLs for link previews (metadataBase, from the request like every other
 * absolute URL here), and Open Graph / Twitter cards that stay generic on every page, so a shared
 * link never unfurls a client's name. The image is app/opengraph-image.tsx.
 */
export async function generateMetadata(): Promise<Metadata> {
  return {
    metadataBase: new URL(await appUrl()),
    title: 'deployhealth',
    description: SITE_DESCRIPTION,
    openGraph: { title: 'deployhealth', description: SITE_DESCRIPTION, siteName: 'deployhealth', type: 'website' },
    twitter: { card: 'summary_large_image', title: 'deployhealth', description: SITE_DESCRIPTION },
  };
}

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
            <Link href="/privacy" className="hover:text-gray-900">
              Privacy
            </Link>
            <Link href="/terms" className="hover:text-gray-900">
              Terms
            </Link>
            <a href={REPO_URL} className="hover:text-gray-900">
              Source on GitHub
            </a>
          </nav>
        </footer>
      </body>
    </html>
  );
}
