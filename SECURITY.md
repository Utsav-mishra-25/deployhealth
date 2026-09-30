# Security policy

## Reporting a vulnerability

Email **security@deployhealth.dev**, or open a
[private security advisory](https://github.com/Utsav-mishra-25/deployhealth/security/advisories/new).
Please don't open a public issue.

Include what you found, where (URL, file or endpoint), and how to reproduce it. You'll get a reply
within 3 working days.

You're welcome to test against your own account, projects and endpoints on
https://deployhealth.dev. Don't access other users' data, don't degrade the service (no load
testing or denial of service), and don't use the uptime checker to probe third parties.

## Scope

- The hosted service at `deployhealth.dev` (web app, public demo, share links, ingest API,
  GitHub App webhook)
- The code in this repository, including the `deployhealth-scan` npm package

## What we store and how we handle incidents

See https://deployhealth.dev/security: what is stored (variable names and `file:line`, never
values), how checks run, how share links work, and our commitment to email affected users within
72 hours of confirming an incident. The same contact is published in
[`/.well-known/security.txt`](https://deployhealth.dev/.well-known/security.txt).
