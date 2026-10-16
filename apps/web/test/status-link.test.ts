import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetServerEnvForTests } from '@/env';
import { parseStatusPageUrl, reportStatusPageUrlProblem, statusPageUrl } from '@/lib/site-nav';

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
