import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SecretSteps } from '@/components/secret-steps';
import { SetupOptions } from '@/components/setup-options';
import { TokenReveal } from '@/components/token-reveal';

const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');

describe('the setup copy', () => {
  it('splits setup into two options: pull request checks need no token at all', () => {
    const html = text(renderToStaticMarkup(createElement(SetupOptions, {})));
    expect(html).toContain('Pull request checks');
    expect(html).toContain('Install the deployhealth GitHub App on the repository and add a project for its exact owner/repo. No token, no secret, no variable.');
    expect(html).toContain('Deploy history and alerts');
    expect(html).toContain('repository secret named DEPLOYHEALTH_TOKEN');
  });

  it('says where the secret goes, and that it is not a Variable or an environment secret', () => {
    const html = text(renderToStaticMarkup(createElement(SecretSteps, { repo: 'acme/api' })));
    expect(html).toContain('In acme/api: Settings → Secrets and variables → Actions → Secrets tab → New repository secret, named DEPLOYHEALTH_TOKEN.');
    expect(html).toContain('Not a Variable: the Variables tab shows values in plain text');
    expect(html).toContain('Not an environment secret');
  });

  it('shows the token once, in the token box only, on the screen after a project is created', () => {
    const token = 'dh_0123456789abcdef0123456789abcdef';
    const html = renderToStaticMarkup(createElement(TokenReveal, { token, snippet: 'jobs: {}' }));
    expect(html.split(token)).toHaveLength(2);
    expect(text(html)).toContain('No token, no secret, no variable.');
    expect(text(html)).toContain('Secrets tab → New repository secret');
  });
});
