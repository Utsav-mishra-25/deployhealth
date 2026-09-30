import type { Metadata } from 'next';
import Link from 'next/link';
import { li, ProsePage, Section } from '@/components/prose-page';
import { formatLegalDate, LEGAL_LAST_UPDATED, OPERATOR, REPO_URL } from '@/lib/legal';
import { securityContact } from '@/lib/security';

export const metadata: Metadata = { title: 'Terms · deployhealth' };
// Reads SECURITY_CONTACT_EMAIL at request time.
export const dynamic = 'force-dynamic';

/** Public: the terms of the hosted service, short and in plain English. */
export default function TermsPage() {
  const contact = securityContact();
  return (
    <ProsePage testId="terms">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Terms</h1>
        <p className="text-sm text-gray-500" data-testid="last-updated">
          Last updated: {formatLegalDate(LEGAL_LAST_UPDATED)}
        </p>
        <p className="text-gray-700">
          These terms cover the hosted deployhealth service, run by {OPERATOR.name} ({OPERATOR.country}). By using it you
          agree to them.
        </p>
      </header>

      <Section title="A beta service, as is">
        <p>
          deployhealth is in beta and free while it is. It is provided as is, without warranties of any kind, and with no
          uptime guarantee or service level: checks can be late, alerts can be missed, and features can change.
        </p>
      </Section>

      <Section title="Acceptable use">
        <ul className="space-y-2">
          <li className={li}>Only monitor endpoints you own or are authorised to check.</li>
          <li className={li}>
            Don&apos;t use the service for load testing, or to probe or scan anyone else&apos;s systems.
          </li>
          <li className={li}>Don&apos;t try to reach other users&apos; data, or to get around the service&apos;s limits.</li>
        </ul>
        <p>We may suspend or close accounts that abuse the service or break these terms.</p>
      </Section>

      <Section title="Your data">
        <p>
          You keep ownership of everything you put into deployhealth. We use it only to run the service for you, as the{' '}
          <Link className="text-emerald-700 underline" href="/privacy">
            privacy page
          </Link>{' '}
          describes.
        </p>
      </Section>

      <Section title="The code">
        <p>
          The{' '}
          <a className="text-emerald-700 underline" href={REPO_URL}>
            source code
          </a>{' '}
          is public. The app is licensed under FSL-1.1-MIT (each version becomes MIT two years after its release), and the
          scanner and CLI in <code>packages/core</code> under MIT. You may self-host it under those licences.
        </p>
      </Section>

      <Section title="Liability">
        <p>
          As far as the law allows, {OPERATOR.name} is not liable for any indirect or consequential loss, or for losses caused
          by downtime, late checks or missed alerts, and total liability is limited to what you paid for the service in the
          12 months before the claim (nothing, while it is free).
        </p>
      </Section>

      <Section title="Changes">
        <p>
          If these terms change, the new version is posted here with a new date. For changes that matter, we will email
          account holders at least 14 days before they take effect.
        </p>
      </Section>

      <Section title="Contact">
        <p>
          <a className="font-medium text-emerald-700 underline" href={contact.href}>
            {contact.label}
          </a>
        </p>
      </Section>
    </ProsePage>
  );
}
