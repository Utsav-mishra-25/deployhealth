import type { InstallationSummary, OnboardingState } from '@deployhealth/db';
import { HOW_IT_WORKS } from './marketing';
import type { AppCovers } from './project-status';
import { appCoverage, coversRepo, repoCoverage, type AppCoverage } from './repo-coverage';

// The first-run checklist on /clients and the GitHub App install round trip. The checklist's steps
// are the landing page's "how it works" (HOW_IT_WORKS), in the same order.

/**
 * Where the App's install link comes back to. GitHub passes the install URL's `state` on to the
 * Setup URL (/github/installed), which sends a signed-in user back to that page. Only these values
 * are accepted; anything else shows /github/installed itself. `state` only picks the page: it is
 * never used to link an installation (that comes from signed webhook deliveries alone).
 */
export type InstallReturn = { to: 'clients' } | { to: 'new-project' } | { to: 'settings'; projectId: string };

const STATE_PATTERN = /^(clients|new-project|settings\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))$/;

/** The `state` value for a return step. */
export function installState(ret: InstallReturn): string {
  return ret.to === 'settings' ? `settings.${ret.projectId}` : ret.to;
}

/** A `state` from the Setup URL's query string, or null for anything outside the allowlist. */
export function parseInstallState(state: string | string[] | undefined): InstallReturn | null {
  const match = typeof state === 'string' ? STATE_PATTERN.exec(state) : null;
  if (!match) return null;
  if (match[2]) return { to: 'settings', projectId: match[2] };
  return { to: match[1] as 'clients' | 'new-project' };
}

/** The query parameter that shows the one-line confirmation on the page the user came back to. */
export const INSTALLED_PARAM = 'app';
export const INSTALLED_VALUE = 'installed';

/** The project page's flag after creating a project: a one-line confirmation. */
export const CREATED_PARAM = 'created';

/** Where a return step lands, with the confirmation flag. */
export function installReturnPath(ret: InstallReturn): string {
  const path = ret.to === 'clients' ? '/clients' : ret.to === 'new-project' ? '/projects/new' : `/projects/${ret.projectId}/settings`;
  return `${path}?${INSTALLED_PARAM}=${INSTALLED_VALUE}`;
}

/** GitHub's install page for the App, coming back to `ret`. Null when the App isn't configured (no slug). */
export function installAppHref(appSlug: string | undefined, ret: InstallReturn): string | null {
  if (!appSlug) return null;
  return `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new?state=${encodeURIComponent(installState(ret))}`;
}

/**
 * "Not set up"'s reason on the signed-in project lists (/clients and a client's page): whether the
 * user's own installations (`listInstallationsForUser`) cover a repository. Both pages call this,
 * so a project's reason reads the same on each.
 */
export function appCoversFor(installations: readonly InstallationSummary[], appSlug: string | undefined): AppCovers {
  return coversRepo(appCoverage(installations, installAppHref(appSlug, { to: 'clients' })));
}

export type StepId = 'app' | 'project' | 'site' | 'alerts' | 'action';

export interface ChecklistStep {
  id: StepId;
  title: string;
  body: string;
  done: boolean;
  optional: boolean;
  /** Where to do it; null when it can't be done yet (or at all) and `blocked` says why. */
  action: { href: string; label: string; external?: boolean } | null;
  blocked?: string;
  /** A warning under the step (the App doesn't cover some projects). */
  note?: { text: string; href: string; label: string };
}

export interface Checklist {
  steps: ChecklistStep[];
  /** Every required step that can be done here is done: the checklist isn't shown. */
  complete: boolean;
}

export const CHECKLIST_TITLE = 'Get set up';

/** "1 project isn't covered by the App: shop" / "2 projects aren't covered by the App: shop, blog". */
export function uncoveredLine(names: readonly string[]): string {
  return `${names.length} ${names.length === 1 ? "project isn't" : "projects aren't"} covered by the App: ${names.join(', ')}`;
}

/** The anchor on /github/installed that lists the user's projects the App doesn't cover. */
export const NOT_COVERED_HREF = '/github/installed#not-covered';

/**
 * Whether the user's down alerts have somewhere to go (`lib/alert-destination.ts` loads it): a
 * boolean and a project id, never a webhook URL.
 */
export interface AlertDestination {
  /** Any of the user's projects has an alert webhook. */
  webhookSet: boolean;
  /** The first project (oldest first) with an endpoint and no webhook; null when `webhookSet`, or no project has an endpoint. */
  projectId: string | null;
}

export const ALERTS_STEP = {
  title: 'Choose where alerts go',
  body: 'Down alerts go to Slack or Discord. Email is coming.',
} as const;

/** The top of a project's settings when it has endpoints and no webhook. */
export const ALERTS_NOWHERE = 'Alerts for this project have nowhere to go yet.';

/** The settings page's section with the alert webhook field. */
export function alertSettingsHref(projectId: string): string {
  return `/projects/${projectId}/settings#client-alerts`;
}

/**
 * The checklist for one user, from their own data only. `coverage` is built from the same
 * installations (`appCoverage(state.installations, …)`).
 */
export function checklist(state: OnboardingState, coverage: AppCoverage, appSlug: string | undefined, alerts: AlertDestination): Checklist {
  const [app, sites, action] = HOW_IT_WORKS;
  const appAvailable = Boolean(appSlug);
  const appDone = state.installations.some((i) => !i.suspended);
  const newest = state.projects.at(-1);
  const uncovered = appDone ? state.projects.filter((p) => repoCoverage(coverage, p.repoFullName).state !== 'covered').map((p) => p.name) : [];
  const installHref = installAppHref(appSlug, { to: 'clients' });

  const steps: ChecklistStep[] = [
    {
      id: 'app',
      title: app.title,
      body: appAvailable ? app.body : "The GitHub App isn't set up on this deployment, so pull requests aren't checked here.",
      done: appDone,
      optional: false,
      action: !appAvailable ? null : appDone ? { href: '/github/installed', label: 'See what it covers' } : { href: installHref!, label: 'Install the GitHub App', external: true },
      ...(appAvailable ? {} : { blocked: 'Not available on this deployment.' }),
    },
    {
      id: 'project',
      title: 'Add a project for a repo',
      body: 'One project per GitHub repository. Its pull requests are checked once the App covers that repository.',
      done: state.projects.length > 0,
      optional: false,
      action: { href: '/projects/new', label: state.projects.length > 0 ? 'Add another project' : 'Add a project' },
      ...(uncovered.length > 0
        ? { note: { text: uncoveredLine(uncovered), href: NOT_COVERED_HREF, label: uncovered.length === 1 ? 'How to add it' : 'How to add them' } }
        : {}),
    },
    {
      id: 'site',
      title: 'Add a site (a URL to watch)',
      body: sites.body,
      done: state.endpoints > 0,
      optional: false,
      action: newest ? { href: `/projects/${newest.id}#add-endpoint`, label: 'Add a site' } : null,
      ...(newest ? {} : { blocked: 'Sites belong to a project: add one first (step 2).' }),
    },
    {
      id: 'alerts',
      title: ALERTS_STEP.title,
      body: ALERTS_STEP.body,
      done: alerts.webhookSet,
      optional: false,
      action: alerts.projectId ? { href: alertSettingsHref(alerts.projectId), label: ALERTS_STEP.title } : null,
      ...(alerts.webhookSet || alerts.projectId ? {} : { blocked: 'Alerts are for sites: add one first (step 3).' }),
    },
    {
      id: 'action',
      title: 'Optional: deploy history with the Action',
      body: action.body,
      done: state.deploys > 0,
      optional: true,
      action: newest ? { href: `/projects/${newest.id}/settings#deploy-history`, label: 'Set up the Action' } : null,
      ...(newest ? {} : { blocked: 'Set up per project, after step 2.' }),
    },
  ];
  const complete = steps.every((s) => s.optional || s.done || (s.id === 'app' && !appAvailable));
  return { steps, complete };
}
