import { CLI_BUNDLE_KB } from '@deployhealth/core';
import { DEMO_PROJECT_IDS } from '@deployhealth/db';
import Link from 'next/link';
import { landingAlertMessage } from '@/lib/landing';
import { REPO_URL } from '@/lib/legal';
import { DEMO_PATHS } from '@/lib/paths';
import { AlertCard } from './alert-card';

const FEATURES = [
  {
    title: 'Env checks on every push and PR',
    body: 'Variables your code reads but no env file defines, ones defined but never read, and env files out of sync. Reported by name and file:line, never values.',
  },
  {
    title: 'Uptime with deploy-aware alerts',
    body: 'Checks your endpoints as often as every minute, and posts to Slack or Discord when one goes down, naming the deploy just before it and what that deploy changed.',
  },
  {
    title: 'Client reports and handoff docs',
    body: 'A monthly report per client (uptime, incidents, deploys, config fixed) with a share link, and a handoff document per project, printable or as Markdown.',
  },
];

const STEPS = [
  { title: 'Add the GitHub Action', body: 'One workflow step runs the scanner on every push and reports what it finds.' },
  { title: 'Add your endpoints', body: 'Name them, pick an interval, and point alerts at a Slack or Discord webhook.' },
  { title: 'Get alerts that name the deploy', body: 'When a check fails soon after a deploy, the alert says which deploy and which variables it introduced.' },
];

/** The signed-out home page: what deployhealth does, in one screen, and the way into the demo. */
export function Landing({ demo }: { demo: boolean }) {
  const demoProject = DEMO_PATHS.project(DEMO_PROJECT_IDS.storefront);
  const button = 'inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium';
  return (
    <div className="space-y-16" data-testid="landing">
      <section className="space-y-6" aria-labelledby="landing-heading">
        <AlertCard
          message={landingAlertMessage()}
          aside={demo ? 'live on the demo' : 'example alert'}
          link={demo ? { href: demoProject, label: 'View deploy b52952e and its findings' } : undefined}
        />
        <h1 id="landing-heading" className="max-w-3xl text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
          deployhealth checks your env vars on every push and pull request, watches your endpoints, and tells you which deploy
          broke what.
        </h1>
        <div className="flex flex-wrap items-center gap-3">
          {demo && (
            <Link href={DEMO_PATHS.clients} className={`${button} bg-emerald-600 text-white hover:bg-emerald-500`}>
              See the live demo
            </Link>
          )}
          <Link
            href="/login"
            className={demo ? `${button} border border-gray-300 bg-white hover:bg-gray-50` : `${button} bg-emerald-600 text-white hover:bg-emerald-500`}
          >
            Sign in with GitHub
          </Link>
          <span className="text-sm text-gray-600">Free while in beta.</span>
        </div>
      </section>

      <section aria-label="What it does" className="grid gap-4 sm:grid-cols-3">
        {FEATURES.map((f) => (
          <div key={f.title} className="rounded-lg border border-gray-200 bg-white p-5">
            <h2 className="font-semibold">{f.title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-gray-600">{f.body}</p>
          </div>
        ))}
      </section>

      <section aria-labelledby="how-heading" className="space-y-4">
        <h2 id="how-heading" className="text-lg font-semibold">
          How it works
        </h2>
        <ol className="grid gap-4 sm:grid-cols-3">
          {STEPS.map((step, i) => (
            <li key={step.title} className="flex gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-sm font-semibold text-white">
                {i + 1}
              </span>
              <div>
                <h3 className="font-medium">{step.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-gray-600">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="text-sm text-gray-600">
          Plus: install the GitHub App for pull request checks, a comment and a check on every pull request that adds env vars
          nobody declared.
        </p>
      </section>

      <section aria-label="Trust" className="rounded-lg border border-gray-200 bg-white p-5">
        <ul className="grid gap-3 text-sm text-gray-700 sm:grid-cols-3">
          <li>
            <strong className="font-medium text-gray-900">
              Your env values never leave your CI: we only see names and file:line. Response bodies are never read.
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
