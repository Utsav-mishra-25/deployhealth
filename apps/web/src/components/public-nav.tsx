import Link from 'next/link';
import { publicNavLinks } from '@/lib/site-nav';

/**
 * The header's navigation for signed-out visitors: Demo · Docs · Pricing · Sign in with GitHub.
 * No JavaScript: at 375 px it wraps under the logo. Sign-in links to /login (no inline action).
 */
export function PublicNav({ demo }: { demo: boolean }) {
  return (
    <nav aria-label="Main" className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm" data-testid="public-nav">
      {publicNavLinks(demo).map((link) => (
        <Link key={link.href} href={link.href} className="text-gray-700 hover:text-gray-900">
          {link.label}
        </Link>
      ))}
      <Link href="/login" className="rounded-md border border-gray-300 bg-white px-3 py-1.5 font-medium hover:bg-gray-50">
        Sign in with GitHub
      </Link>
    </nav>
  );
}
