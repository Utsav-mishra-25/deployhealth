import type { InstallationSummary, OnboardingState } from '@deployhealth/db';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InstallConfirmation } from '@/components/install-confirmation';
import { OnboardingChecklist } from '@/components/onboarding-checklist';
import { ProjectGettingStarted } from '@/components/project-getting-started';
import { RepoCoverageNotice } from '@/components/repo-coverage-notice';
import { HOW_IT_WORKS } from '@/lib/marketing';
import {
  checklist,
  installAppHref,
  installReturnPath,
  installState,
  parseInstallState,
  uncoveredLine,
  type InstallReturn,
} from '@/lib/onboarding';
import { appCoverage, repoCoverage } from '@/lib/repo-coverage';

const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');

const SLUG = 'deployhealth';
const PROJECT_ID = '0d3e0000-0000-4000-8000-000000000001';

function installation(overrides: Partial<InstallationSummary> = {}): InstallationSummary {
  return {
    githubInstallationId: 42,
    accountLogin: 'acme',
    accountType: 'Organization',
    suspended: false,
    repositorySelection: 'selected',
    repos: [{ fullName: 'acme/shop', projectId: null }],
    ...overrides,
  };
}

const EMPTY: OnboardingState = { installations: [], projects: [], endpoints: 0, deploys: 0, clients: 0 };

/** `slug` null: no GitHub App on this deployment (GITHUB_APP_SLUG unset). */
function stepsOf(state: OnboardingState, appSlug: string | null = SLUG) {
  const slug = appSlug ?? undefined;
  const list = checklist(state, appCoverage(state.installations, installAppHref(slug, { to: 'clients' })), slug);
  return { list, byId: Object.fromEntries(list.steps.map((s) => [s.id, s])) };
}

const done = (state: OnboardingState) => stepsOf(state).list.steps.map((s) => [s.id, s.done]);

describe('the first-run checklist', () => {
  it("follows the landing page's setup order and wording, with the Action last and optional", () => {
    const { list } = stepsOf(EMPTY);
    expect(list.steps.map((s) => s.title)).toEqual([
      HOW_IT_WORKS[0].title,
      'Add a project for a repo',
      'Add a site (a URL to watch)',
      'Optional: deploy history with the Action',
    ]);
    expect(list.steps.map((s) => s.body)).toEqual([HOW_IT_WORKS[0].body, expect.any(String), HOW_IT_WORKS[1].body, HOW_IT_WORKS[2].body]);
    expect(list.steps.map((s) => s.optional)).toEqual([false, false, false, true]);
  });

  it('nothing done: install links to GitHub coming back to /clients; sites and the Action wait for a project', () => {
    const { list, byId } = stepsOf(EMPTY);
    expect(done(EMPTY)).toEqual([
      ['app', false],
      ['project', false],
      ['site', false],
      ['action', false],
    ]);
    expect(list.complete).toBe(false);
    expect(byId.app!.action).toEqual({ href: 'https://github.com/apps/deployhealth/installations/new?state=clients', label: 'Install the GitHub App', external: true });
    expect(byId.project!.action?.href).toBe('/projects/new');
    expect(byId.site!.action).toBeNull();
    expect(byId.site!.blocked).toMatch(/add one first/);
    expect(byId.action!.action).toBeNull();
  });

  it('App installed: step 1 is done and links to what it covers', () => {
    const state = { ...EMPTY, installations: [installation()] };
    expect(done(state)).toEqual([
      ['app', true],
      ['project', false],
      ['site', false],
      ['action', false],
    ]);
    expect(stepsOf(state).byId.app!.action?.href).toBe('/github/installed');
    // A suspended installation checks nothing.
    expect(done({ ...EMPTY, installations: [installation({ suspended: true })] })[0]).toEqual(['app', false]);
  });

  it('project added: the site and Action steps link to the newest project', () => {
    const state = { ...EMPTY, projects: [{ id: 'p-old', name: 'old', repoFullName: 'acme/old' }, { id: PROJECT_ID, name: 'shop', repoFullName: 'acme/shop' }] };
    const { byId } = stepsOf(state);
    expect(done(state).map(([, d]) => d)).toEqual([false, true, false, false]);
    expect(byId.site!.action?.href).toBe(`/projects/${PROJECT_ID}#add-endpoint`);
    expect(byId.action!.action?.href).toBe(`/projects/${PROJECT_ID}/settings#deploy-history`);
  });

  it('site added, and all done: the checklist is complete (hidden) without the optional Action', () => {
    const project = { id: PROJECT_ID, name: 'shop', repoFullName: 'acme/shop' };
    expect(done({ ...EMPTY, projects: [project], endpoints: 1 }).map(([, d]) => d)).toEqual([false, true, true, false]);
    const all = { ...EMPTY, installations: [installation()], projects: [project], endpoints: 1 };
    expect(stepsOf(all).list.complete).toBe(true);
    expect(renderToStaticMarkup(createElement(OnboardingChecklist, { checklist: stepsOf(all).list }))).toBe('');
    expect(done({ ...all, deploys: 2 }).at(-1)).toEqual(['action', true]);
  });

  it('without a GitHub App on the deployment, step 1 says so and does not hold the checklist open', () => {
    const project = { id: PROJECT_ID, name: 'shop', repoFullName: 'acme/shop' };
    const { list, byId } = stepsOf({ ...EMPTY, projects: [project], endpoints: 1 }, null);
    expect(byId.app!.action).toBeNull();
    expect(byId.app!.blocked).toBe('Not available on this deployment.');
    expect(list.complete).toBe(true);
  });

  it("names the projects the App doesn't cover under step 2, linking to the coverage notice", () => {
    const state: OnboardingState = {
      ...EMPTY,
      installations: [installation()],
      projects: [
        { id: 'a', name: 'shop', repoFullName: 'acme/shop' },
        { id: 'b', name: 'dh-laravel-test', repoFullName: 'acme/dh-laravel-test' },
        { id: 'c', name: 'blog', repoFullName: 'elsewhere/blog' },
      ],
    };
    const note = stepsOf(state).byId.project!.note;
    expect(note).toEqual({ text: "2 projects aren't covered by the App: dh-laravel-test, blog", href: '/github/installed#not-covered', label: 'How to add them' });
    expect(uncoveredLine(['shop'])).toBe("1 project isn't covered by the App: shop");
    // An 'all repositories' installation covers every repo of its account: no note for those.
    const all = { ...state, installations: [installation({ repositorySelection: 'all', repos: [] })] };
    expect(stepsOf(all).byId.project!.note).toEqual({ text: "1 project isn't covered by the App: blog", href: '/github/installed#not-covered', label: 'How to add it' });
    // Before any installation, step 1 already says to install it: no note.
    expect(stepsOf({ ...state, installations: [] }).byId.project!.note).toBeUndefined();
  });

  it('renders each step with a text state, step 2 with the repositories the App can see, and the Action collapsed', () => {
    const state = { ...EMPTY, installations: [installation()] };
    const html = renderToStaticMarkup(createElement(OnboardingChecklist, { checklist: stepsOf(state).list, suggestedRepos: ['acme/shop'] }));
    expect(text(html)).toContain('Get set up1 of 3 done');
    expect(text(html)).toContain('1.Install the GitHub AppDone');
    expect(text(html)).toContain('2.Add a project for a repoTo do');
    expect(html).toContain('href="/projects/new?repo=acme%2Fshop"');
    expect(html).toMatch(/<details[^>]*data-testid="step-action"[^>]*><summary[^>]*>Optional: deploy history with the Action<\/summary>/);
    expect(html).not.toMatch(/<details[^>]*open/);
  });
});

describe('coming back from the GitHub App install', () => {
  const steps: InstallReturn[] = [{ to: 'clients' }, { to: 'new-project' }, { to: 'settings', projectId: PROJECT_ID }];

  it('carries the step in state and lands back on it with the confirmation flag', () => {
    expect(steps.map(installState)).toEqual(['clients', 'new-project', `settings.${PROJECT_ID}`]);
    for (const step of steps) expect(parseInstallState(installState(step))).toEqual(step);
    expect(steps.map(installReturnPath)).toEqual(['/clients?app=installed', '/projects/new?app=installed', `/projects/${PROJECT_ID}/settings?app=installed`]);
    expect(installAppHref('deployhealth', steps[2]!)).toBe(`https://github.com/apps/deployhealth/installations/new?state=settings.${PROJECT_ID}`);
    expect(installAppHref(undefined, steps[0]!)).toBeNull();
  });

  it('accepts nothing outside the allowlist', () => {
    for (const state of [
      undefined,
      '',
      'Clients',
      'clients ',
      'clients/../x',
      '/clients',
      'https://evil.example',
      '//evil.example',
      'settings.',
      'settings.not-a-uuid',
      `settings.${PROJECT_ID}/x`,
      `settings.${PROJECT_ID.toUpperCase()}`,
      `project.${PROJECT_ID}`,
      ['clients'],
    ]) {
      expect(parseInstallState(state as string | undefined), JSON.stringify(state)).toBeNull();
    }
  });

  it('confirms from the installations themselves, never from the flag alone', () => {
    const installed = text(renderToStaticMarkup(createElement(InstallConfirmation, { installations: [installation(), installation({ accountLogin: 'utsav', repositorySelection: 'all', repos: [] })], reloadHref: '/clients?app=installed' })));
    expect(installed).toBe('GitHub App installed on acme (1 repository), utsav (all repositories).');
    const waiting = text(renderToStaticMarkup(createElement(InstallConfirmation, { installations: [], reloadHref: '/clients?app=installed' })));
    expect(waiting).toBe('Back from GitHub. The installation can take a few seconds to reach deployhealth: reload this page.');
  });
});

describe("whether the user's installations cover a repository", () => {
  const coverage = (installations: InstallationSummary[], url: string | null = 'https://github.com/apps/deployhealth/installations/new?state=new-project') =>
    appCoverage(installations, url);

  it('covered: a listed repository (case-insensitive), or any repository of an account with All repositories', () => {
    expect(repoCoverage(coverage([installation()]), 'ACME/Shop').state).toBe('covered');
    expect(repoCoverage(coverage([installation({ repositorySelection: 'all', repos: [] })]), 'acme/never-listed').state).toBe('covered');
    expect(repoCoverage(coverage([installation({ accountLogin: 'Acme', repositorySelection: 'all', repos: [] })]), 'acme/x').state).toBe('covered');
    // 'all' never reaches another account's repositories.
    expect(repoCoverage(coverage([installation({ repositorySelection: 'all', repos: [] })]), 'other/x').state).toBe('not-installed');
  });

  it("not covered: says why and links to the installation's Repository access, or to install it on that account", () => {
    const notSelected = repoCoverage(coverage([installation()]), 'acme/dh-laravel-test');
    expect(notSelected).toMatchObject({ state: 'not-selected', account: { login: 'acme', settingsUrl: 'https://github.com/organizations/acme/settings/installations/42' } });
    const html = renderToStaticMarkup(createElement(RepoCoverageNotice, { coverage: notSelected, repo: 'acme/dh-laravel-test' }));
    expect(text(html)).toBe(
      "The GitHub App is installed on acme, but not on acme/dh-laravel-test, so its pull requests aren't checked. On GitHub, open the App's settings for acme → Repository access, and select this repository (or All repositories).",
    );
    expect(html).toContain('href="https://github.com/organizations/acme/settings/installations/42"');

    const elsewhere = repoCoverage(coverage([installation()]), 'utsav/site');
    expect(text(renderToStaticMarkup(createElement(RepoCoverageNotice, { coverage: elsewhere, repo: 'utsav/site' })))).toBe(
      "The GitHub App is installed on acme, but not on utsav, so pull requests on utsav/site aren't checked. Install the GitHub App on utsav and select this repository.",
    );
    const none = repoCoverage(coverage([]), 'utsav/site');
    expect(text(renderToStaticMarkup(createElement(RepoCoverageNotice, { coverage: none, repo: 'utsav/site' })))).toBe(
      "The GitHub App isn't installed yet, so pull requests on utsav/site aren't checked. Install the GitHub App and select this repository.",
    );
    const user = repoCoverage(coverage([installation({ accountLogin: 'utsav', accountType: 'User', githubInstallationId: 7 })]), 'utsav/x');
    expect(user).toMatchObject({ state: 'not-selected', account: { settingsUrl: 'https://github.com/settings/installations/7' } });
  });

  it('suspended, and no App on the deployment', () => {
    expect(repoCoverage(coverage([installation({ suspended: true })]), 'acme/shop').state).toBe('suspended');
    expect(repoCoverage(coverage([installation({ suspended: true }), installation({ githubInstallationId: 9 })]), 'acme/shop').state).toBe('covered');
    expect(repoCoverage(coverage([], null), 'acme/shop').state).toBe('no-app');
    for (const state of ['covered', 'no-app'] as const) {
      const c = state === 'covered' ? repoCoverage(coverage([installation()]), 'acme/shop') : repoCoverage(coverage([], null), 'x/y');
      expect(renderToStaticMarkup(createElement(RepoCoverageNotice, { coverage: c, repo: 'acme/shop' }))).toBe('');
    }
  });

  it("only the installations it's given count: another user's never reach the checklist or the notes", () => {
    // getOnboardingState and listInstallationsForUser return the user's own installations only
    // (packages/db/test/isolation.test.ts); with none, nothing is covered.
    const state: OnboardingState = { ...EMPTY, projects: [{ id: 'a', name: 'shop', repoFullName: 'acme/shop' }] };
    const { byId } = stepsOf(state);
    expect(byId.app!.done).toBe(false);
    expect(repoCoverage(appCoverage(state.installations, 'https://x'), 'acme/shop').state).toBe('not-installed');
  });
});

describe('a project before any data', () => {
  const render = (props: Partial<Parameters<typeof ProjectGettingStarted>[0]> = {}) =>
    text(
      renderToStaticMarkup(
        createElement(ProjectGettingStarted, {
          projectId: PROJECT_ID,
          repo: 'acme/shop',
          coverage: repoCoverage(appCoverage([installation()], 'https://x'), 'acme/shop'),
          prCheckMode: 'comment',
          prChecks: 0,
          endpoints: 0,
          ...props,
        }),
      ),
    );

  it('says what shows up and what makes it appear: a pull request, a site, optionally the Action', () => {
    const copy = render();
    expect(copy).toContain('What shows up here');
    expect(copy).toContain('Open a pull request on acme/shop to see the first check: a comment and a deployhealth / env check on GitHub, listed here too.');
    expect(copy).toContain('Add a site (a URL to watch): deployhealth requests it on a schedule and alerts you when it fails.');
    expect(copy).toContain("Add the Action for deploy history: each push's env check, and alerts that name the deploy.");
    expect(copy).not.toMatch(/No scans yet|token/i);
  });

  it("says when the App doesn't cover the repo, checks are off, or pull requests are already in", () => {
    const notCovered = render({ repo: 'acme/blog', coverage: repoCoverage(appCoverage([installation()], 'https://x'), 'acme/blog') });
    expect(notCovered).toContain('The GitHub App is installed on acme, but not on acme/blog');
    expect(render({ prCheckMode: 'off' })).toContain('Pull request checks are off for this project. Turn them on in Settings.');
    expect(render({ prChecks: 2 })).toContain('Pull requests on acme/shop are being checked: see them below.');
    expect(render({ endpoints: 1 })).toContain("Your sites are listed below; each one's first check runs within its interval.");
    expect(render({ coverage: { state: 'no-app' } })).toContain("The GitHub App isn't set up on this deployment");
  });
});
