import { CLI_BUNDLE_KB } from '@deployhealth/core';
import { DEMO_PROJECT_IDS } from '@deployhealth/db';
import Link from 'next/link';
import { landingAlertMessage } from '@/lib/landing';
import { REPO_URL } from '@/lib/legal';
import { HERO, HOW_IT_WORKS, PRICING, WHO_FOR } from '@/lib/marketing';
import { DEMO_PATHS } from '@/lib/paths';
import { AlertCard } from './alert-card';
import { Faq } from './faq';
import { PricingPlans } from './pricing';

/** The committed screenshot of /demo's clients list (2x; shown at half its pixel size). */
export const LANDING_SCREENSHOT = {
  src: '/landing/demo-clients.png',
  width: 2080,
  height: 912,
  alt: "The deployhealth demo's clients list: projects grouped by client, worst first. acme-storefront is down, northwind-site needs attention and portfolio is healthy.",
} as const;

/**
 * The signed-out home page, freelancer first: the hero, what the product looks like, a real alert,
 * who it's for, the real setup order, pricing, questions, and the trust strip.
 */
export function Landing({ demo }: { demo: boolean }) {
  const demoProject = DEMO_PATHS.project(DEMO_PROJECT_IDS.storefront);
  const button = 'inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium';
  const primary = `${button} bg-emerald-700 text-white hover:bg-emerald-800`;
  const secondary = `${button} border border-gray-300 bg-white hover:bg-gray-50`;
  // A plain committed image: no optimizer route, nothing fetched from elsewhere. With the demo
  // public it links there; the link's name starts "Open the live demo", then the image's alt.
  const screenshot = (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={LANDING_SCREENSHOT.src}
      width={LANDING_SCREENSHOT.width}
      height={LANDING_SCREENSHOT.height}
      alt={LANDING_SCREENSHOT.alt}
      className="h-auto w-full max-w-4xl rounded-lg border border-gray-200 bg-white shadow-sm"
      data-testid="landing-screenshot"
    />
  );
  return (
    <div className="space-y-16" data-testid="landing">
      <section className="space-y-6" aria-labelledby="landing-heading" data-testid="landing-hero">
        <h1 id="landing-heading" className="max-w-3xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          {HERO.headline}
        </h1>
        <p className="max-w-3xl text-base leading-relaxed text-gray-700 sm:text-lg" data-testid="landing-subline">
          {HERO.subline}
        </p>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            {demo && (
              <Link href={DEMO_PATHS.clients} className={primary}>
                See the live demo
              </Link>
            )}
            <Link href="/login" className={demo ? secondary : primary}>
              Sign in with GitHub
            </Link>
          </div>
          <p>
            <Link href="/docs" className="text-sm font-medium text-emerald-700 hover:underline">
              {HERO.docsLink}
            </Link>
          </p>
          <p className="text-sm text-gray-600" data-testid="landing-free">
            {PRICING.freeShort}
          </p>
        </div>
      </section>

      {demo ? (
        <Link href={DEMO_PATHS.clients} className="block max-w-4xl rounded-lg hover:opacity-90" data-testid="landing-screenshot-link">
          <span className="sr-only">Open the live demo: </span>
          {screenshot}
        </Link>
      ) : (
        screenshot
      )}

      <section aria-labelledby="alert-heading" className="space-y-3" data-testid="landing-alert">
        <h2 id="alert-heading" className="text-lg font-semibold">
          {demo ? 'What an alert looks like (live from the demo)' : 'What an alert looks like'}
        </h2>
        <AlertCard
          message={landingAlertMessage()}
          aside="Alerts like this go to Slack or Discord."
          link={demo ? { href: demoProject, label: 'View deploy b52952e and its findings' } : undefined}
        />
      </section>

      <section aria-labelledby="who-heading" className="space-y-4">
        <h2 id="who-heading" className="text-lg font-semibold">
          Who it&apos;s for
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {WHO_FOR.map((group) => (
            <div key={group.title} className="rounded-lg border border-gray-200 bg-white p-5" data-testid="who-for">
              <h3 className="font-semibold">{group.title}</h3>
              <p className="mt-2 font-medium text-gray-900">{group.lead}</p>
              <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed text-gray-600">
                {group.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="how-heading" className="space-y-4">
        <h2 id="how-heading" className="text-lg font-semibold">
          How it works
        </h2>
        <ol className="grid gap-4 sm:grid-cols-3" data-testid="how-it-works">
          {HOW_IT_WORKS.map((step, i) => (
            <li key={step.title} className="flex gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-700 text-sm font-semibold text-white">
                {i + 1}
              </span>
              <div>
                <h3 className="font-medium">{step.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-gray-600">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="pricing-heading" className="space-y-4">
        <h2 id="pricing-heading" className="text-lg font-semibold">
          Pricing
        </h2>
        <PricingPlans headingLevel="h3" />
        <Link href="/pricing" className="inline-block text-sm font-medium text-emerald-700 hover:underline">
          More on pricing
        </Link>
      </section>

      <section aria-labelledby="faq-heading" className="space-y-4">
        <h2 id="faq-heading" className="text-lg font-semibold">
          Questions
        </h2>
        <Faq />
      </section>

      <section aria-label="Trust" className="rounded-lg border border-gray-200 bg-white p-5">
        <ul className="grid gap-3 text-sm text-gray-700 sm:grid-cols-3">
          <li>
            <strong className="font-medium text-gray-900">
              We store variable names and file:line, never values. The PR check reads your code in memory and discards it; the Action sends names only. Response bodies are never read.
            </strong>{' '}
            <Link href="/security" className="text-emerald-700 underline">
              What we store
            </Link>
          </li>
          <li>
            <strong className="font-medium text-gray-900">Scanner is MIT, {CLI_BUNDLE_KB} KB, zero dependencies.</strong>{' '}
            <a href={`${REPO_URL}/tree/main/packages/core`} className="text-emerald-700 underline">
              Read it
            </a>
          </li>
          <li>
            <strong className="font-medium text-gray-900">Self-hostable.</strong>{' '}
            <a href={REPO_URL} className="text-emerald-700 underline">
              Source on GitHub
            </a>
          </li>
        </ul>
      </section>
    </div>
  );
}
