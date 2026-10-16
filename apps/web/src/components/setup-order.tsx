import { HOW_IT_WORKS } from '@/lib/marketing';

/** The setup order, as on the landing page: the App (no token), your sites, optionally the Action. */
export function SetupOrder() {
  return (
    <section aria-labelledby="setup-order-title" className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-700" data-testid="setup-order">
      <h2 id="setup-order-title" className="font-semibold text-gray-900">
        How setup goes
      </h2>
      <ol className="mt-2 list-decimal space-y-2 pl-5">
        {HOW_IT_WORKS.map((step) => (
          <li key={step.title}>
            <span className="font-medium text-gray-900">{step.title}.</span> {step.body}
          </li>
        ))}
      </ol>
    </section>
  );
}
