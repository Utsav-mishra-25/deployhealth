import { HOST_CHECK_SPACING_MS, MAX_CLAIM_PER_OWNER, PR_CHECK_TIME_LIMIT_MS } from '@deployhealth/core';
import { CHECK_RETENTION_DAYS } from '@deployhealth/core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import PrivacyPage from '@/app/privacy/page';
import SecurityPage from '@/app/security/page';
import TermsPage from '@/app/terms/page';
import { resetServerEnvForTests } from '@/env';
import { githubSignInReads } from '@/lib/auth-providers';
import { CHECK_RETENTION_TEXT, DELETION_RECORD_TEXT, ERROR_REPORTS_TEXT, formatLegalDate, LEGAL_LAST_UPDATED, OPERATOR, SELF_SERVE_DATA_TEXT, SUBPROCESSORS } from '@/lib/legal';
import { ACCOUNT_DELETION_RECORD_DAYS } from '@deployhealth/db';
import { REDACTED } from '@deployhealth/db/redact';

const saved = { ...process.env };
beforeAll(() => {
  Object.assign(process.env, { DATABASE_URL: 'postgres://x@localhost/db', AUTH_SECRET: 'x'.repeat(32), SECURITY_CONTACT_EMAIL: 'security@deployhealth.example' });
  resetServerEnvForTests();
});
afterAll(() => {
  process.env = { ...saved };
  resetServerEnvForTests();
});

const render = (page: () => React.ReactNode) => renderToStaticMarkup(createElement(page));
/** The text of the element with this data-testid (no nested elements in the ones we read). */
const textOf = (html: string, testId: string) => new RegExp(`data-testid="${testId}"[^>]*>([^<]*)<`).exec(html)?.[1];
const plain = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

describe('/privacy and /security agree', () => {
  it('state the same check retention, from the shared constant', () => {
    const privacy = render(PrivacyPage);
    const security = render(SecurityPage);
    expect(CHECK_RETENTION_TEXT).toContain(`${CHECK_RETENTION_DAYS} days`);
    expect(textOf(privacy, 'retention')).toBe(CHECK_RETENTION_TEXT);
    expect(textOf(security, 'retention')).toBe(CHECK_RETENTION_TEXT);
  });

  it('describe the GitHub sign-in scopes the same way, including private email addresses', () => {
    const privacy = render(PrivacyPage);
    const security = render(SecurityPage);
    expect(plain(textOf(privacy, 'signin-reads') ?? '')).toBe(githubSignInReads());
    expect(plain(textOf(security, 'signin-reads') ?? '')).toBe(githubSignInReads());
    expect(githubSignInReads()).toContain('read:user, user:email');
    expect(githubSignInReads()).toContain('private');
  });

  it('describe error reports, self-serve export and deletion, and the deletion record the same way', () => {
    const privacy = render(PrivacyPage);
    const security = render(SecurityPage);
    for (const [testId, text] of [
      ['error-reports', ERROR_REPORTS_TEXT],
      ['self-serve-data', SELF_SERVE_DATA_TEXT],
      ['deletion-record', DELETION_RECORD_TEXT],
    ] as const) {
      expect(plain(textOf(privacy, testId) ?? '')).toBe(text);
      expect(plain(textOf(security, testId) ?? '')).toBe(text);
    }
    // True to the code: the scrubber's placeholder, the record's retention, Sentry as a subprocessor.
    expect(ERROR_REPORTS_TEXT).toContain(REDACTED);
    expect(DELETION_RECORD_TEXT).toContain(`${ACCOUNT_DELETION_RECORD_DAYS} days`);
    expect(SUBPROCESSORS.map((s) => s.name)).toContain('Sentry');
    expect(plain(privacy)).not.toContain('planned');
  });

  it('use the same contact', () => {
    for (const html of [render(PrivacyPage), render(SecurityPage), render(TermsPage)]) {
      expect(html).toContain('href="mailto:security@deployhealth.example"');
    }
  });
});

describe('/privacy', () => {
  it('names the operator, the hosting region, every subprocessor, the email use and the date', () => {
    const text = plain(render(PrivacyPage));
    expect(text).toContain(`${OPERATOR.name} (${OPERATOR.country})`);
    expect(text).toContain('Railway, in its Singapore region');
    for (const s of SUBPROCESSORS) expect(text).toContain(`${s.name}: ${s.purpose}.`);
    expect(text).toContain('Never for marketing, and it is never shared with anyone.');
    expect(text).toContain('No analytics, no advertising');
    expect(text).toContain(`Last updated: ${formatLegalDate(LEGAL_LAST_UPDATED)}`);
    expect(formatLegalDate(new Date('2026-09-30T00:00:00Z'))).toBe('30 September 2026');
  });
});

describe('/terms', () => {
  it('covers the beta, acceptable use, ownership, licences, liability and changes', () => {
    const text = plain(render(TermsPage));
    expect(text).toContain(`${OPERATOR.name} (${OPERATOR.country})`);
    expect(text).toContain('no uptime guarantee');
    expect(text).toContain('Only monitor endpoints you own or are authorised to check.');
    expect(text).toContain('You keep ownership of everything');
    expect(text).toContain('FSL-1.1-MIT');
    expect(text).toMatch(/under MIT\. You may self-host it/);
    expect(text).toContain(`Last updated: ${formatLegalDate(LEGAL_LAST_UPDATED)}`);
    expect(text).not.toMatch(/governing law|jurisdiction/i);
  });
});

describe('/security states what the code does', () => {
  it('gives the pull request time limit, the per-owner cap, and that redirects aren\'t counted toward spacing', () => {
    const text = plain(render(SecurityPage));
    expect(text).toContain(`stops after ${PR_CHECK_TIME_LIMIT_MS / 1000} seconds of work`);
    expect(text).toContain('“Couldn\'t be checked”');
    expect(text).toContain(`at most ${MAX_CLAIM_PER_OWNER} checks started per minute`);
    expect(text).toContain("requests that follow a redirect (up to 5 per check) aren't counted toward the spacing");
    expect(text).not.toMatch(/flood/);
  });

  it("states strict mode's limit plainly: couldn't be checked and too large are neutral, which GitHub counts as passing", () => {
    const text = plain(render(SecurityPage)).replace(/\s+/g, ' ');
    expect(text).toContain(
      "Strict mode's limit: a pull request that couldn't be checked (the check crashed, ran out of time, or hit an error on our side) or was too large to check",
    );
    expect(text).toContain('gets a neutral check run, even in strict mode, and GitHub counts a neutral check as passing.');
    expect(text).toContain('Strict mode blocks a merge only for what a check actually found.');
  });

  it('says spacing is per hostname, so different names for one server are spaced separately', () => {
    const text = plain(render(SecurityPage));
    expect(text).toContain(`Checks are spaced per hostname: one hostname is checked at most once every ${HOST_CHECK_SPACING_MS / 1000} seconds, however many accounts monitor it.`);
    expect(text).toContain('Different names for one server (another subdomain or alias, or its IP address) are spaced separately.');
    // Never the stronger claim that a server (rather than a name) is protected.
    expect(text).not.toMatch(/(spaced|checked) [^.]*per (server|IP)/i);
    expect(text).not.toContain('.gitignore');
  });
});
