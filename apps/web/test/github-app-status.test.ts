import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppStatusLine } from '@/components/github-app-status';

const render = (status: Parameters<typeof AppStatusLine>[0]['status'], repo: string) =>
  renderToStaticMarkup(createElement(AppStatusLine, { status, repo })).replace(/<[^>]+>/g, '');

describe("the settings page's GitHub App line", () => {
  it('says "Not installed by you on owner/repo" when none of the user\'s own installations covers it', () => {
    expect(render({ state: 'not-installed' }, 'acme/shop')).toBe('Not installed by you on acme/shop.');
  });

  it("never names another account: an existing private repo and a missing one render the same line", () => {
    // getGithubAppStatus returns { state: 'not-installed' } for both (packages/db/test/isolation.test.ts),
    // so the line differs only by the repo name the user typed themselves.
    const existing = render({ state: 'not-installed' }, 'alice-private/secret-plans');
    const missing = render({ state: 'not-installed' }, 'alice-private/does-not-exist');
    expect(existing.replace('secret-plans', 'X')).toBe(missing.replace('does-not-exist', 'X'));
    expect(existing).not.toMatch(/other than yours|another account|by a GitHub account/);
  });

  it('names the account only for the user\'s own installation', () => {
    expect(render({ state: 'active', accountLogin: 'alice' }, 'acme/shop')).toBe('Installed on alice: pull requests on acme/shop are checked.');
  });
});
