import { describe, expect, it } from 'vitest';
import { pageTitle, reportMetadata } from '@/lib/titles';

describe('page titles', () => {
  it('name the project or client, then the demo marker, then the site', () => {
    expect(pageTitle(['acme-storefront'], 'app')).toBe('acme-storefront · deployhealth');
    expect(pageTitle(['Handoff', 'acme-storefront'], 'demo')).toBe('Handoff · acme-storefront · Live demo · deployhealth');
    expect(pageTitle([], 'app')).toBe('deployhealth');
  });

  it('title reports by month only, never the client', () => {
    const now = new Date('2026-09-30T12:00:00Z');
    expect(reportMetadata('app', undefined, now).title).toBe('Report · September 2026 · deployhealth');
    expect(reportMetadata('demo', '2026-08', now).title).toBe('Report · August 2026 · Live demo · deployhealth');
    expect(reportMetadata('app', 'nonsense', now).title).toBe('Monthly report · deployhealth');
  });
});
