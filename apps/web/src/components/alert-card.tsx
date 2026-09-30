import Link from 'next/link';

/**
 * One open alert, as the project page shows it: the message, when it opened, and a link to the
 * deploy it names. The landing page renders the same card for its example.
 */
export function AlertCard({ message, aside, link }: { message: string; aside: React.ReactNode; link?: { href: string; label: string } }) {
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="min-w-0 font-medium break-words text-red-800">{message}</p>
        <span className="text-xs text-red-700">{aside}</span>
      </div>
      {link && (
        <Link href={link.href} className="mt-1 inline-block text-sm text-red-700 underline">
          {link.label}
        </Link>
      )}
    </div>
  );
}
