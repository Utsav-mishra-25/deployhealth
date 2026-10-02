import { afterEach, describe, expect, it } from 'vitest';
import { resetServerEnvForTests } from '@/env';
import { contactFor, SECURITY_ADVISORY_URL, securityContact, securityTxt } from '@/lib/security';

const NOW = new Date('2026-09-29T15:30:00Z');

describe('security contact', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    resetServerEnvForTests();
  });

  it('uses SECURITY_CONTACT_EMAIL, else a private advisory on GitHub', () => {
    expect(contactFor('security@deployhealth.example')).toEqual({ href: 'mailto:security@deployhealth.example', label: 'security@deployhealth.example' });
    expect(contactFor(undefined)).toEqual({ href: SECURITY_ADVISORY_URL, label: 'a private security advisory on GitHub' });
  });

  it('reads and validates SECURITY_CONTACT_EMAIL from the environment', () => {
    Object.assign(process.env, { DATABASE_URL: 'postgres://x@localhost/db', AUTH_SECRET: 'x'.repeat(32), SECURITY_CONTACT_EMAIL: 'sec@example.com' });
    resetServerEnvForTests();
    expect(securityContact().href).toBe('mailto:sec@example.com');
    process.env.SECURITY_CONTACT_EMAIL = 'not an email';
    resetServerEnvForTests();
    expect(() => securityContact()).toThrow('SECURITY_CONTACT_EMAIL must be an email address');
  });
});

describe('security.txt (RFC 9116)', () => {
  it('has Contact, an Expires under a year out, and points at the policy page', () => {
    const txt = securityTxt({ baseUrl: 'https://dh.example', contact: contactFor('sec@example.com'), now: NOW });
    expect(txt).toBe(
      [
        'Contact: mailto:sec@example.com',
        'Expires: 2027-03-28T00:00:00.000Z',
        'Preferred-Languages: en',
        'Canonical: https://dh.example/.well-known/security.txt',
        'Policy: https://dh.example/security',
        '',
      ].join('\n'),
    );
  });

  it('is served as text/plain at /.well-known/security.txt, with the URL the browser used', async () => {
    Object.assign(process.env, { DATABASE_URL: 'postgres://x@localhost/db', AUTH_SECRET: 'x'.repeat(32) });
    delete process.env.SECURITY_CONTACT_EMAIL;
    resetServerEnvForTests();
    const { GET } = await import('@/app/.well-known/security.txt/route');
    const response = GET(new Request('http://internal:8080/.well-known/security.txt', { headers: { 'x-forwarded-host': 'dh.example', 'x-forwarded-proto': 'https' } }));
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    // Built from the request's host headers, so no shared cache may keep it.
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.text();
    expect(body).toContain(`Contact: ${SECURITY_ADVISORY_URL}\n`);
    expect(body).toContain('Policy: https://dh.example/security\n');
  });
});
