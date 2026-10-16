import type { Metadata } from 'next';
import Link from 'next/link';
import { isDemoPublic } from '@/lib/demo';
import { DEMO_PATHS } from '@/lib/paths';

export const metadata: Metadata = { title: 'Page not found · deployhealth' };

/** Every 404 (unknown paths and notFound()): a way back, in the site's style. Nothing about why. */
export default function NotFound() {
  const links = [{ href: '/', label: 'Home' }, ...(isDemoPublic() ? [{ href: DEMO_PATHS.clients, label: 'Demo' }] : []), { href: '/docs', label: 'Docs' }];
  return (
    <div className="mx-auto mt-8 max-w-md rounded-xl border border-gray-200 bg-white p-6 text-center shadow-sm sm:mt-16 sm:p-8" data-testid="not-found">
      <p className="text-sm font-medium text-emerald-700">404</p>
      <h1 className="mt-1 text-xl font-semibold">Page not found</h1>
      <p className="mt-2 text-sm text-gray-600">This page doesn&apos;t exist, or the link is out of date.</p>
      <nav aria-label="Ways back" className="mt-6 flex flex-wrap justify-center gap-3">
        {links.map((link, i) => (
          <Link
            key={link.href}
            href={link.href}
            className={`rounded-md px-4 py-2 text-sm font-medium ${i === 0 ? 'bg-emerald-700 text-white hover:bg-emerald-800' : 'border border-gray-300 bg-white hover:bg-gray-50'}`}
          >
            {link.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
