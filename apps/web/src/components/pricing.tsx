import { PRICING } from '@/lib/marketing';

/**
 * What it costs: free today, and the planned prices as names and prices only (no limits, no
 * features that aren't built). Used by /pricing and the landing page's pricing section.
 */
export function PricingPlans({ headingLevel }: { headingLevel: 'h2' | 'h3' }) {
  const Heading = headingLevel;
  return (
    <div className="space-y-4" data-testid="pricing-plans">
      <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-5 py-4 text-base font-medium text-emerald-950" data-testid="pricing-free">
        {PRICING.free}
      </p>
      <div className="space-y-3">
        <Heading className="text-sm font-semibold uppercase tracking-wide text-gray-500">Planned after the beta</Heading>
        <ul className="grid gap-4 sm:grid-cols-2">
          {PRICING.planned.map((plan) => (
            <li key={plan.name} className="rounded-lg border border-gray-200 bg-white p-5" data-testid="pricing-plan">
              <p className="font-semibold">{plan.name}</p>
              <p className="mt-1 text-2xl font-semibold tracking-tight">{plan.price}</p>
            </li>
          ))}
        </ul>
        <p className="text-sm text-gray-600">{PRICING.notice}</p>
      </div>
    </div>
  );
}
