import { CHECK_RETENTION_DAYS } from '@deployhealth/core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import PrivacyPage from '@/app/privacy/page';
import SecurityPage from '@/app/security/page';
import TermsPage from '@/app/terms/page';
import { resetServerEnvForTests } from '@/env';
import { githubSignInReads } from '@/lib/auth-providers';
import { CHECK_RETENTION_TEXT, formatLegalDate, LEGAL_LAST_UPDATED, OPERATOR, SUBPROCESSORS } from '@/lib/legal';

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
