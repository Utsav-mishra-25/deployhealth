import type { Metadata } from 'next';
import Link from 'next/link';
import { PricingPlans } from '@/components/pricing';
import { isDemoPublic } from '@/lib/demo';
import { PRICING_METADATA } from '@/lib/marketing';
import { DEMO_PATHS } from '@/lib/paths';

export const metadata: Metadata = {
  title: PRICING_METADATA.title,
  description: PRICING_METADATA.description,
  alternates: { canonical: '/pricing' },
};

/** Public: what deployhealth costs today (nothing) and what's planned. No session or user data. */
export default function PricingPage() {
  const demo = isDemoPublic();
  return (
    <article className="mx-auto max-w-3xl space-y-8" data-testid="pricing">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Pricing</h1>
      <PricingPlans headingLevel="h2" />
      <div className="flex flex-wrap items-center gap-3">
        {demo && (
          <Link href={DEMO_PATHS.clients} className="inline-flex items-center justify-center rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800">
            See the live demo
          </Link>
        )}
        <Link
          href="/login"
          className={`inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium ${demo ? 'border border-gray-300 bg-white hover:bg-gray-50' : 'bg-emerald-700 text-white hover:bg-emerald-800'}`}
        >
          Sign in with GitHub
        </Link>
      </div>
    </article>
  );
}
