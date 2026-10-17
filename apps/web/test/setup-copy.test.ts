import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NO_REFERENCES_NOTICE, NoReferencesNotice } from '@/components/env-scope-notice';
import { SecretSteps } from '@/components/secret-steps';
import { SetupOrder } from '@/components/setup-order';
import { TokenReveal } from '@/components/token-reveal';
import { ACTION_WORKFLOW, actionWorkflow } from '@/lib/docs-pages';
import { HOW_IT_WORKS } from '@/lib/marketing';
import { DEPLOY_HISTORY_OPTION, OTHER_CI, PR_CHECKS_OPTION, TOKEN_ONCE } from '@/lib/setup-copy';

const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');

describe('the setup copy', () => {
  it('puts pull request checks first (no token at all) and the Action second, optional, for deploy history', () => {
    expect(PR_CHECKS_OPTION.title).toBe('Pull request checks (GitHub App)');
    expect(PR_CHECKS_OPTION.body).toContain('No token, no secret, no variable.');
    expect(DEPLOY_HISTORY_OPTION.title).toBe('Optional: deploy history (GitHub Action)');
    expect(DEPLOY_HISTORY_OPTION.body).toContain('deploy history and alerts that name the deploy');
    expect(DEPLOY_HISTORY_OPTION.body).toContain('repository secret named DEPLOYHEALTH_TOKEN');
  });

  it('/github/installed lists setup in the landing page order, with no token steps', () => {
    const html = text(renderToStaticMarkup(createElement(SetupOrder)));
    for (const step of HOW_IT_WORKS) expect(html).toContain(`${step.title}. ${step.body}`);
    expect(html.indexOf(HOW_IT_WORKS[0].title)).toBeLessThan(html.indexOf(HOW_IT_WORKS[2].title));
    expect(html).not.toMatch(/New repository secret|DEPLOYHEALTH_TOKEN/);
  });

  it('says where the secret goes, and that it is not a Variable or an environment secret', () => {
    const html = text(renderToStaticMarkup(createElement(SecretSteps, { repo: 'acme/api' })));
    expect(html).toContain('In acme/api: Settings → Secrets and variables → Actions → Secrets tab → New repository secret, named DEPLOYHEALTH_TOKEN.');
    expect(html).toContain('Not a Variable: the Variables tab shows values in plain text');
    expect(html).toContain('Not an environment secret');
  });

  it('shows the token once, in the token box only, when it is created in settings', () => {
    const token = 'dh_0123456789abcdef0123456789abcdef';
    const html = renderToStaticMarkup(createElement(TokenReveal, { token, workflow: 'uses: action', snippet: 'run: npx', repo: 'acme/api' }));
    expect(html.split(token)).toHaveLength(2);
    expect(text(html)).toContain(TOKEN_ONCE);
    expect(text(html)).toContain('In acme/api: Settings → Secrets and variables → Actions → Secrets tab → New repository secret');
    // The old creation screen's wording is gone.
    expect(text(html)).not.toMatch(/Copy your ingest token now|won't be shown again/);
  });

  it('shows the Action workflow first, then the pinned CLI workflow under "From any other CI"', () => {
    const html = text(renderToStaticMarkup(createElement(TokenReveal, { token: 'dh_x', workflow: 'uses: action', snippet: 'run: npx', repo: 'acme/api' })));
    expect(OTHER_CI.title).toBe('From any other CI');
    expect(html.indexOf('uses: action')).toBeGreaterThan(-1);
    expect(html.indexOf('uses: action')).toBeLessThan(html.indexOf(OTHER_CI.title));
    expect(html.indexOf(OTHER_CI.title)).toBeLessThan(html.indexOf('run: npx'));
  });
});

describe("the Action's workflow for this instance", () => {
  it('is byte-identical to ACTION_WORKFLOW on https://deployhealth.dev (no url: line)', () => {
    expect(actionWorkflow({ appUrl: 'https://deployhealth.dev' })).toBe(ACTION_WORKFLOW);
    expect(actionWorkflow({ appUrl: 'https://deployhealth.dev/' })).toBe(ACTION_WORKFLOW);
    expect(ACTION_WORKFLOW).not.toContain('url:');
  });

  it("names any other instance in the Action's url input, so deploys don't go to the hosted one", () => {
    const yaml = actionWorkflow({ appUrl: 'https://dh.agency.example/' });
    expect(yaml).toBe(`${ACTION_WORKFLOW}          url: "https://dh.agency.example"\n`);
    // Under the step's `with:`, next to the token.
    expect(yaml.split('\n').slice(-4, -1)).toEqual(['        with:', '          token: ${{ secrets.DEPLOYHEALTH_TOKEN }}', '          url: "https://dh.agency.example"']);
  });
});

describe('the no-references notice on the project page', () => {
  it('says the last scan found no env var references and which languages are read', () => {
    expect(NO_REFERENCES_NOTICE).toBe('The last scan found no env var references. deployhealth reads JS/TS, Python, Go, Ruby, PHP and Java/Kotlin.');
    expect(renderToStaticMarkup(createElement(NoReferencesNotice, { show: true }))).toContain('deployhealth reads JS/TS, Python, Go, Ruby, PHP and Java/Kotlin.');
    expect(renderToStaticMarkup(createElement(NoReferencesNotice, { show: false }))).toBe('');
  });
});
