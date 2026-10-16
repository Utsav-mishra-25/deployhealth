import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { auth, signOut } from '@/auth';
import { PublicNav } from '@/components/public-nav';
import { publicOrigin } from '@/lib/app-url';
import { SITE_DESCRIPTION } from '@/lib/brand';
import { isDemoPublic } from '@/lib/demo';
import { REPO_URL } from '@/lib/legal';
import { HIDE_PUBLIC_NAV_HEADER, statusPageUrl } from '@/lib/site-nav';
import './globals.css';

/**
 * Site-wide: absolute URLs for link previews (metadataBase, from publicOrigin() like every other
 * absolute URL here), and Open Graph / Twitter cards that stay generic on every page, so a shared
 * link never unfurls a client's name. The image is app/opengraph-image.tsx.
 */
export async function generateMetadata(): Promise<Metadata> {
  return {
    metadataBase: new URL(await publicOrigin()),
    title: 'deployhealth',
    description: SITE_DESCRIPTION,
    openGraph: { title: 'deployhealth', description: SITE_DESCRIPTION, siteName: 'deployhealth', type: 'website' },
    twitter: { card: 'summary_large_image', title: 'deployhealth', description: SITE_DESCRIPTION },
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  // Signed out: the public nav, except on shared reports (middleware.ts), which a client opens.
  const showPublicNav = !session?.user && (await headers()).get(HIDE_PUBLIC_NAV_HEADER) !== '1';
  const status = statusPageUrl();
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-50 text-gray-900 antialiased">
        <header className="border-b border-gray-200 bg-white print:hidden">
          <div className="mx-auto flex min-h-14 max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
            <Link href={session ? '/clients' : '/'} className="font-semibold tracking-tight">
              deploy<span className="text-emerald-700">health</span>
            </Link>
            {session?.user && (
              <div className="flex items-center gap-3 text-sm">
                <span className="text-gray-700" data-testid="current-user">
                  {session.user.login}
                </span>
                <Link href="/account" className="text-gray-500 hover:text-gray-900">
                  Account
                </Link>
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
            {showPublicNav && <PublicNav demo={isDemoPublic()} />}
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
        <footer className="border-t border-gray-200 print:hidden">
          <nav aria-label="Footer" className="mx-auto flex max-w-6xl flex-wrap gap-x-6 gap-y-2 px-4 py-6 text-sm text-gray-500">
            <Link href="/docs" className="hover:text-gray-900">
              Docs
            </Link>
            <Link href="/pricing" className="hover:text-gray-900">
              Pricing
            </Link>
            <Link href="/security" className="hover:text-gray-900">
              Security
            </Link>
            <Link href="/privacy" className="hover:text-gray-900">
              Privacy
            </Link>
            <Link href="/terms" className="hover:text-gray-900">
              Terms
            </Link>
            {status && (
              <a href={status} className="hover:text-gray-900">
                Status
              </a>
            )}
            <a href={REPO_URL} className="hover:text-gray-900">
              Source on GitHub
            </a>
          </nav>
        </footer>
      </body>
    </html>
  );
}
