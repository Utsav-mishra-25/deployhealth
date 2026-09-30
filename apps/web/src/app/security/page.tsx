import {
  CHECK_TIMEOUT_MS,
  HOST_CHECK_SPACING_MS,
  MAX_ENDPOINTS_PER_PROJECT,
  MAX_ENDPOINTS_PER_USER,
  MAX_PR_CHECK_BYTES,
  MAX_PR_CHECK_FILES,
  MAX_REDIRECTS,
} from '@deployhealth/core';
import type { Metadata } from 'next';
import Link from 'next/link';
import { li, ProsePage, Section } from '@/components/prose-page';
import { githubSignInReads } from '@/lib/auth-providers';
import { CHECK_RETENTION_TEXT, REPO_URL } from '@/lib/legal';
import { securityContact } from '@/lib/security';
import { SHARE_LINK_DAYS } from '@/lib/share-link';

export const metadata: Metadata = { title: 'Security · deployhealth' };
// Reads SECURITY_CONTACT_EMAIL at request time.
export const dynamic = 'force-dynamic';

/** Public: what deployhealth stores and does, and how to report a vulnerability. */
export default function SecurityPage() {
  const contact = securityContact();
  return (
    <ProsePage testId="security">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Security</h1>
        <p className="text-gray-700">
          deployhealth looks at your code&apos;s configuration and at your clients&apos; servers, so here is exactly what it
          stores, what it does, and how to reach us. The code is{' '}
          <a className="text-emerald-700 underline" href={REPO_URL}>
            public
          </a>
          , so you can check every claim below.
        </p>
      </header>

      <Section title="What we store">
        <ul className="space-y-2">
          <li className={li}>
            <strong>Variable names and file:line, never values.</strong> For each deploy: the commit sha, branch and time,
            and for each finding the variable name, the file and line that reads it, and the env file involved, plus the
            names each env file defines. The scanner runs in your CI and reads env files only for their names; the
            ingest API accepts only names, paths and line numbers.
          </li>
          <li className={li}>
            <strong>Findings</strong> per deploy (missing, unused, out of sync), so you can see what changed.
          </li>
          <li className={li}>
            <strong>Endpoint URLs</strong> you add, with their names and settings, and for each check its time, status
            code, latency and a short error reason. <span data-testid="retention">{CHECK_RETENTION_TEXT}</span>
          </li>
          <li className={li}>
            <strong>Alerts</strong> (when they opened and resolved, and the message) and your alert webhook URL. Webhook
            URLs contain secrets, so logs show only their host.
          </li>
          <li className={li}>
            <strong>Ingest tokens</strong> only as a SHA-256 hash. The token itself is shown once, when it&apos;s created.
          </li>
          <li className={li}>
            <strong>Your account:</strong> your GitHub id, login, name, email address and avatar URL, from GitHub sign-in.{' '}
            <span data-testid="signin-reads">{githubSignInReads()}</span> Sign-in gets no access to your repositories (the
            optional GitHub App below is separate). Clients, deploy notes and contact emails are what you type in.
          </li>
        </ul>
      </Section>

      <Section title="How checks run">
        <ul className="space-y-2">
          <li className={li}>
            One request per check (GET or HEAD) with a {CHECK_TIMEOUT_MS / 1000}-second budget, following at most{' '}
            {MAX_REDIRECTS} redirects.
          </li>
          <li className={li}>
            <strong>SSRF-guarded.</strong> A URL must be public http(s): no credentials, no private, loopback, link-local
            or otherwise reserved addresses. That&apos;s checked when you save it, and again at connect time for every
            redirect hop, which also defeats DNS rebinding. Alert webhooks go through the same guard.
          </li>
          <li className={li}>
            <strong>Response bodies are never read or stored:</strong> only the status code and timing.
          </li>
          <li className={li}>
            A hostname is checked at most once every {HOST_CHECK_SPACING_MS / 1000} seconds, however many accounts
            monitor it, and an account can monitor at most {MAX_ENDPOINTS_PER_USER} endpoints ({MAX_ENDPOINTS_PER_PROJECT}{' '}
            per project). deployhealth can&apos;t be used to flood a server.
          </li>
        </ul>
      </Section>

      <Section title="The GitHub App (pull request checks)">
        <p>
          If you install it, the App asks GitHub for read access to the contents of the repositories you choose, and write
          access to their pull requests and checks (to comment and add the <code>deployhealth / env</code> check). For each
          pull request it reads, at the pull request&apos;s head and at its merge base, only the files the scanner reads
          (source files in the scanned languages, env files and <code>.gitignore</code>), plus the pull request&apos;s diff
          and commit messages. At most {MAX_PR_CHECK_FILES.toLocaleString('en')} files and {MAX_PR_CHECK_BYTES / 1024 / 1024} MB per
          pull request, fetched only from api.github.com.
        </p>
        <p>
          It stores what it reports: variable names with file:line, the names of committed env files, how many secret-shaped
          strings it saw (never the strings), the pull request number, its author and whether a coding agent wrote it. File
          contents are discarded as soon as the check finishes. Webhook deliveries are verified with a shared secret before
          anything is read, and uninstalling the App deletes its pull request checks.
        </p>
      </Section>

      <Section title="How share links work">
        <p>
          A monthly report&apos;s share link isn&apos;t stored anywhere: the link itself carries the client, the month and
          an expiry date {SHARE_LINK_DAYS} days out, signed with HMAC-SHA256 using a key only the server has. Anyone with
          the link can read that one report until it expires, and nothing else; changing any part of it breaks the
          signature. Links can&apos;t be revoked one by one: rotating the key revokes all of them at once. Shared pages are
          rate-limited per IP address and ask search engines not to index them.
        </p>
      </Section>

      <Section title="Report a vulnerability">
        <p>
          Please report security issues to{' '}
          <a className="font-medium text-emerald-700 underline" href={contact.href} data-testid="security-contact">
            {contact.label}
          </a>
          , not in a public issue. Include what you found and how to reproduce it. Testing against your own account and
          your own endpoints is welcome; please don&apos;t access other people&apos;s data or degrade the service.
        </p>
        <p>
          Machine-readable: <Link className="text-emerald-700 underline" href="/.well-known/security.txt">/.well-known/security.txt</Link>.
        </p>
      </Section>

      <Section title="Our commitment">
        <p>
          If a security incident affects your data, we will email every affected user within <strong>72 hours</strong> of
          confirming it, at the email address on their GitHub account, saying what happened, which data was involved, and
          what we are doing about it.
        </p>
      </Section>
    </ProsePage>
  );
}
