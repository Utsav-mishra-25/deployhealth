import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppNextSteps } from '@/components/app-next-steps';
import { newProjectHref, projectPrefill, safeReturnPath, signInHref } from '@/lib/github-app';

describe('next steps after installing the GitHub App', () => {
  it('lists each repository without a project, with a link that pre-fills it', () => {
    const html = renderToStaticMarkup(createElement(AppNextSteps, { repos: ['acme/api', 'acme/web.site'] }));
    expect(html).toContain('href="/projects/new?repo=acme%2Fapi"');
    expect(html).toContain('href="/projects/new?repo=acme%2Fweb.site"');
    expect(html.replace(/<[^>]+>/g, '')).toContain('Add a project for acme/api to start pull request checks');
    expect(html.replace(/<[^>]+>/g, '')).toContain('Add a project for acme/web.site to start pull request checks');
  });

  it('shows the first few with a link to the rest, and nothing when every repository has a project', () => {
    const html = renderToStaticMarkup(createElement(AppNextSteps, { repos: ['a/one', 'a/two', 'a/three'], limit: 1 }));
    expect(html).toContain('a/one');
    expect(html).not.toContain('a/two');
    expect(html.replace(/<[^>]+>/g, '')).toContain('And 2 more on the GitHub App page.');
    expect(html).toContain('href="/github/installed"');
    expect(renderToStaticMarkup(createElement(AppNextSteps, { repos: [] }))).toBe('');
  });

  it('pre-fills the new project form only from an owner/repo name', () => {
    expect(newProjectHref('acme/shop')).toBe('/projects/new?repo=acme%2Fshop');
    expect(projectPrefill('acme/shop.web')).toEqual({ repoFullName: 'acme/shop.web', name: 'shop.web' });
    expect(projectPrefill(`acme/${'r'.repeat(80)}`)?.name).toHaveLength(64);
    for (const repo of [undefined, '', 'acme', 'acme/shop/extra', '<script>/x', 'acme/sh op']) expect(projectPrefill(repo), String(repo)).toBeNull();
  });

  it('signs in and comes back only to a path on this site', () => {
    expect(signInHref('/github/installed')).toBe('/login?next=%2Fgithub%2Finstalled');
    for (const next of ['/github/installed', '/clients', '/projects/0d3e0000-0000-4000-8000-000000000001']) expect(safeReturnPath(next)).toBe(next);
    for (const next of [undefined, '', 'github/installed', '//evil.example', '/\\evil.example', 'https://evil.example', '/github/installed?x=1', '/a b', '/..', '/%2F%2Fevil']) {
      expect(safeReturnPath(next), String(next)).toBeNull();
    }
  });
});
