import { DEMO_PROJECT_IDS } from '@deployhealth/db';
import { DEMO_PATHS } from './paths';

// The public pages' copy, worded once: the landing page, /pricing, the header, the 404 and the
// demo guide use these, and the tests pin them. Only what's true today: no limits, no unbuilt
// features, and prices only as planned.

/** The login page's line, and the freelancers' column on the landing page. */
export const TAGLINE = 'One page for every client project you maintain.';

export const HERO = {
  headline: "Know which deploy broke your client's site, before they call you.",
  subline:
    'deployhealth checks every pull request for config your code needs but nobody declared, watches your sites, and ties each outage to the deploy that caused it. Monthly reports your clients can read.',
  docsLink: 'Docs: Next.js, Laravel, Spring Boot',
} as const;

export const PRICING = {
  free: 'Free during the beta: everything you see in the demo.',
  freeShort: 'Free during the beta.',
  planned: [
    { name: 'Freelancer', price: '$15/month' },
    { name: 'Studio', price: '$29/month' },
  ],
  notice: 'Beta users get advance notice and an early-user price.',
} as const;

export const WHO_FOR = [
  {
    title: 'Freelancers and agencies',
    lead: TAGLINE,
    points: [
      'A monthly report per client (uptime, incidents, deploys, config fixed), with a share link you can send them.',
      'A handoff doc when the project ends: env vars, endpoints and how to deploy, printable or as Markdown.',
    ],
  },
  {
    title: 'Small dev teams',
    lead: 'Like Dependabot, but for your .env.example.',
    points: [
      'A comment and a check on every pull request that reads an env var nobody declared.',
      'Strict mode fails the check, so branch protection can block the merge.',
      'Alerts that name the deploy just before an outage and what it changed.',
    ],
  },
] as const;

/** The real setup order: the App first (no token), then sites, then the optional Action. */
export const HOW_IT_WORKS = [
  {
    title: 'Install the GitHub App',
    body: 'Pull request checks on the repositories you add as projects: a comment and a check, no token or workflow.',
  },
  {
    title: 'Add your sites',
    body: 'Uptime checks as often as every minute, with alerts to Slack or Discord.',
  },
  {
    title: 'Optional: add the Action',
    body: 'One workflow step and a repository secret give you deploy history and alerts that name the deploy.',
  },
] as const;

export const FAQ_COST_ANSWER = `${PRICING.free} After the beta, the planned plans are ${PRICING.planned
  .map((p) => `${p.name} at ${p.price}`)
  .join(' and ')}. ${PRICING.notice}`;

/**
 * The FAQ's line on languages the scanner doesn't read. Its "Supported today" list is core's
 * SUPPORTED_LANGUAGES labels (test/landing.test.ts), so it can't drift from what the scanner reads.
 */
export const FAQ_STACK_SENTENCE =
  'On Rust, C# and other languages we don\'t read yet, the PR check and CLI report "can\'t check" instead of passing. Supported today: JS/TS, Python, Go, Ruby, PHP, Java/Kotlin.';

/** Plain <details>, no JavaScript. */
export const FAQ = [
  {
    question: 'Do you see my secrets?',
    answer:
      "No. deployhealth records variable names and file:line, never values: the Action's scanner runs in your CI and sends names only, and the pull request check keeps names and file:line only. Uptime checks never read response bodies.",
    link: { href: '/security', label: 'What we store' },
  },
  {
    question: 'Do I have to change my code?',
    answer: 'No. deployhealth reads the code and env files you already have. The App and uptime checks need no change to your repository; the optional Action is one workflow step.',
  },
  {
    question: "What if my stack isn't supported?",
    answer: `Uptime checks, monthly reports and handoffs work for any site, including WordPress. ${FAQ_STACK_SENTENCE}`,
  },
  {
    question: 'What does it cost after the beta?',
    answer: FAQ_COST_ANSWER,
    link: { href: '/pricing', label: 'Pricing' },
  },
] as const;

export const LANDING_METADATA = {
  title: "deployhealth: know which deploy broke your client's site",
  description: 'Checks every pull request for config nobody declared, watches your sites, and ties each outage to the deploy that caused it.',
  ogTitle: HERO.headline,
  /** The Open Graph image (app/opengraph-image.tsx) shows the headline, so its alt is the headline. */
  imageAlt: `deployhealth: ${HERO.headline}`,
} as const;

export const PRICING_METADATA = {
  title: 'Pricing · deployhealth',
  description: 'Free during the beta: everything in the demo. Planned after it: Freelancer $15/month and Studio $29/month, with an early-user price.',
} as const;

/** The demo client whose report the guide links (the seed's "Acme Corp", slugified). */
export const DEMO_GUIDE_CLIENT_SLUG = 'acme-corp';

/** /demo's three-item guide: where to look first. */
export const DEMO_GUIDE = {
  projects: { href: `${DEMO_PATHS.clients}#projects`, label: 'The project list', note: 'worst first' },
  deploy: { href: `${DEMO_PATHS.project(DEMO_PROJECT_IDS.storefront)}#deploys`, label: "The deploy that broke Acme's API", note: 'acme-storefront' },
  report: { href: DEMO_PATHS.clientReport(DEMO_GUIDE_CLIENT_SLUG), label: "The monthly report you'd send Acme" },
  handoff: { href: DEMO_PATHS.handoff(DEMO_PROJECT_IDS.storefront), label: 'its handoff' },
} as const;
