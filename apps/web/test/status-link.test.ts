import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetServerEnvForTests } from '@/env';
import { footerLinks, parseStatusPageUrl, reportStatusPageUrlProblem, statusPageUrl } from '@/lib/site-nav';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetServerEnvForTests();
});

function env(statusPageUrl: string | undefined) {
  vi.stubEnv('DATABASE_URL', 'postgres://localhost/x');
  vi.stubEnv('AUTH_SECRET', 'a'.repeat(32));
  vi.stubEnv('STATUS_PAGE_URL', statusPageUrl);
  resetServerEnvForTests();
}

describe("the footer's Status link", () => {
  it('is an https URL, or hidden', () => {
    expect(parseStatusPageUrl(' https://status.deployhealth.dev ')).toBe('https://status.deployhealth.dev/');
    expect(parseStatusPageUrl(undefined)).toBeNull();
    expect(parseStatusPageUrl('')).toBeNull();
    expect(parseStatusPageUrl('http://status.deployhealth.dev')).toBeNull();
    expect(parseStatusPageUrl('javascript:alert(1)')).toBeNull();
    expect(parseStatusPageUrl('https://user:pass@status.deployhealth.dev')).toBeNull();
    expect(parseStatusPageUrl('status.deployhealth.dev')).toBeNull();
  });

  it('comes from STATUS_PAGE_URL, hidden when unset, with one startup error when unusable', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    env(undefined);
    expect(statusPageUrl()).toBeNull();
    reportStatusPageUrlProblem();
    expect(error).not.toHaveBeenCalled();

    env('https://deployhealth.betteruptime.com');
    expect(statusPageUrl()).toBe('https://deployhealth.betteruptime.com/');

    env('ftp://status.example');
    expect(statusPageUrl()).toBeNull();
    reportStatusPageUrlProblem();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toMatch(/^STATUS_PAGE_URL is not an https URL/);
  });
});

describe('the footer', () => {
  const labels = (share: boolean, status: string | null) => footerLinks({ share, status }).map((l) => l.label);

  it('links Docs, Pricing, Security, Privacy, Terms, Status (when set) and the source', () => {
    expect(labels(false, 'https://status.deployhealth.dev/')).toEqual(['Docs', 'Pricing', 'Security', 'Privacy', 'Terms', 'Status', 'Source on GitHub']);
    expect(labels(false, null)).toEqual(['Docs', 'Pricing', 'Security', 'Privacy', 'Terms', 'Source on GitHub']);
  });

  it('on /share/* shows only Privacy and Terms', () => {
    expect(footerLinks({ share: true, status: 'https://status.deployhealth.dev/' })).toEqual([
      { href: '/privacy', label: 'Privacy' },
      { href: '/terms', label: 'Terms' },
    ]);
  });
});
