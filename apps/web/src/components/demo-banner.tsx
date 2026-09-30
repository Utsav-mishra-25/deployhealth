import Link from 'next/link';

/** Shown on every /demo page: this is sample data, and nothing here can be changed. */
export function DemoBanner() {
  return (
    <div role="note" aria-label="Demo" className="mb-8 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm print:hidden">
      <p className="text-emerald-900">
        <strong className="font-semibold">Live demo.</strong> Clients, deploys and pull request checks are sample data, read-only. The
        Acme API check and its alert are live: the worker checks it every minute.
      </p>
      <Link href="/login" className="rounded-md bg-emerald-600 px-3 py-1.5 font-medium text-white hover:bg-emerald-500">
        Sign in to monitor your own projects
      </Link>
    </div>
  );
}
