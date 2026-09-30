import type { Metadata } from 'next';
import Link from 'next/link';
import { li, ProsePage, Section } from '@/components/prose-page';
import { githubSignInReads } from '@/lib/auth-providers';
import { CHECK_RETENTION_TEXT, DELETION_REQUEST_DAYS, formatLegalDate, HOSTING, LEGAL_LAST_UPDATED, OPERATOR, SUBPROCESSORS } from '@/lib/legal';
import { securityContact } from '@/lib/security';

export const metadata: Metadata = { title: 'Privacy · deployhealth' };
// Reads SECURITY_CONTACT_EMAIL at request time.
export const dynamic = 'force-dynamic';

/**
 * Public: what the hosted service stores, for how long, where, and who else processes it. Keep it
 * true to the code, like /security (shared constants and wording in lib/legal.ts and
 * lib/auth-providers.ts; test/legal.test.ts checks the two pages agree).
 */
export default function PrivacyPage() {
  const contact = securityContact();
  const contactLink = (
    <a className="font-medium text-emerald-700 underline" href={contact.href} data-testid="privacy-contact">
      {contact.label}
    </a>
  );
  return (
    <ProsePage testId="privacy">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Privacy</h1>
        <p className="text-sm text-gray-500" data-testid="last-updated">
          Last updated: {formatLegalDate(LEGAL_LAST_UPDATED)}
        </p>
        <p className="text-gray-700">
          The hosted deployhealth service is run by {OPERATOR.name} ({OPERATOR.country}). This page says what it stores
          about you, for how long, where, and how to have it deleted. The technical detail is on{' '}
          <Link className="text-emerald-700 underline" href="/security">
            Security
          </Link>
          .
        </p>
      </header>

      <Section title="What we store">
        <ul className="space-y-2">
          <li className={li}>
            <strong>Your account:</strong> your GitHub id, login, name, email address and avatar URL, from GitHub sign-in.{' '}
            <span data-testid="signin-reads">{githubSignInReads()}</span> Sign-in gets no access to your repositories; the
            optional GitHub App is separate.
          </li>
          <li className={li}>
            <strong>Environment variable names and file:line</strong> for each deploy the scanner reports (commit sha,
            branch and time), the findings (missing, unused, out of sync), and the names each env file defines.
          </li>
          <li className={li}>
            <strong>Endpoint URLs</strong> you add, and for each check its time, status code, latency and a short error reason.
          </li>
          <li className={li}>
            <strong>Alerts</strong> (when they opened and resolved, and the message) and your alert webhook URL. Logs show
            only the webhook&apos;s host.
          </li>
          <li className={li}>
            <strong>Ingest tokens</strong>, as a SHA-256 hash only.
          </li>
          <li className={li}>
            <strong>Pull request check summaries</strong>, if you install the GitHub App: the pull request number, its
            author, whether a coding agent wrote it, variable names with file:line, the names of committed env files and a
            count of secret-shaped strings.
          </li>
          <li className={li}>
            What you type in: clients, their contact emails, notes and deploy notes.
          </li>
        </ul>
      </Section>

      <Section title="What we never store">
        <ul className="space-y-2">
          <li className={li}>The values of your environment variables.</li>
          <li className={li}>Response bodies from the endpoints we check.</li>
          <li className={li}>The contents of your files (the GitHub App discards them when a check finishes).</li>
          <li className={li}>Secret strings found in pull requests (only how many there were).</li>
        </ul>
      </Section>

      <Section title="How we use your email address">
        <p>
          To tell you about a security incident that affects your data, and later for alert and account emails you choose
          to receive. Never for marketing, and it is never shared with anyone.
        </p>
      </Section>

      <Section title="How long we keep it">
        <p>
          <span data-testid="retention">{CHECK_RETENTION_TEXT}</span> Uninstalling the GitHub App deletes its pull request
          checks. Everything else is kept while your account exists, until you ask us to delete it.
        </p>
      </Section>

      <Section title="Where it is stored, and who processes it">
        <p>
          The service and its database run on {HOSTING.provider}, in its {HOSTING.region} region. These companies process
          data for the service:
        </p>
        <ul className="space-y-2">
          {SUBPROCESSORS.map((s) => (
            <li key={s.name} className={li}>
              <strong>{s.name}:</strong> {s.purpose}.
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Cookies and tracking">
        <p>
          No analytics, no advertising and no tracking of any kind. The only cookies are the ones sign-in needs: your
          session cookie, and short-lived ones the sign-in library uses while you sign in (CSRF protection and the OAuth
          state).
        </p>
      </Section>

      <Section title="Deleting your data">
        <p>
          Ask at {contactLink} from the email address on your GitHub account, and we will delete your account and everything
          it owns within {DELETION_REQUEST_DAYS} days. Self-serve deletion in the app is planned.
        </p>
      </Section>

      <Section title="Contact">
        <p>Questions about this page, or about your data: {contactLink}.</p>
      </Section>
    </ProsePage>
  );
}
