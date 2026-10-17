# Alerts and reports

When an alert opens and resolves, how it names the deploy that broke things, webhooks, endpoint
names, and the monthly report's numbers. Read before changing `packages/core/src/alerts.ts`,
`report.ts`, `handoff.ts`, `format.ts`, `recordCheck()` or the report views.

## Layout (core)

```
    src/alerts.ts     decideAlert() state machine, alert messages, endpointLabel(), failingFor()
    src/format.ts     formatUtc(), formatPercent() (rounds down), formatInterval(), plural()
    src/handoff.ts    HandoffData, renderHandoffMarkdown(), parseHandoffVariables()
    src/report.ts     report months (UTC), findingsDiff(), ReportData, reportTotals(), reportSummary(),
                      durationWords()
```

## Endpoint names

- **Endpoint names:** optional, at most 60 characters. `endpointLabel({ url, name })` in core is the
  only way to name an endpoint in messages, badges, rows and webhooks: the name, else the host.
  Alert messages store the label at the time they open; renames don't rewrite history.

## Alert rule

Applied in `recordCheck()` (one transaction per check) via `decideAlert()` in core:

- **Open** when the endpoint has **2 consecutive failures** and **at least one ok check** in its
  history. At most one open alert per endpoint (partial unique index `alerts_one_open_per_endpoint`).
- **Resolve** on the next ok check.
- **Correlation:** link (`related_deploy_id`) the project's most recent deploy in the **30 minutes
  before the first failed check**. Compare that deploy's latest scan with the previous scanned
  deploy's latest scan, and list only the MISSING vars that are **new**. Scopes with no env file
  have no MISSING rows, so for those (only when the scan has `env_scopes`, i.e. CLI 0.2.0+) the
  new list is the non-optional variables they reference that the previous scan didn't reference at
  all (its variables plus its findings' names; no previous scan: all of them). The message is built
  by `alertOpenedMessage()`: "…started failing 4m after deploy b52952e, which introduced 2 missing
  env vars: …", "…which introduced 2 new env vars no env file declares: …" (both kinds joined by
  ", plus"), "…which changed no config" (the deploy's config diff is empty), or "…no deploy in the
  30 minutes before the first failure". Each kind lists every name up to 6, else 5 and "and N more"
  (`listNames()`, `MAX_ALERT_NAMES`); counts stay exact. Webhooks reuse the message.
- **Webhook:** if `projects.alert_webhook_url` is set, POST `{text}` on open and on resolve. Log
  and continue on failure; at most one retry. `webhookPayload()` escapes the text for chat
  (`escapeChatText`: `&` `<` `>` as entities, a zero-width space after the `@` of `@everyone`,
  `@here`, `@channel`).
- **Down duration:** "Down for 21m" (or "Failing for 1m" before an alert opens) next to endpoint
  and project badges is measured from the first failed check of the current run:
  `failingSinceSql()` in `monitoring.ts` (also used for the alert's first failure), exposed as
  `EndpointMonitoring.failingSince` and `ProjectListItem.failingSince`, and labelled by
  `failingFor()` in core.

- **The deploy diff** behind the message (new MISSING, new undeclared) is `deployConfigChange()` in
  db `deploy-config.ts`, which the monthly report also counts with. That module reads by project
  and deploy id, so it isn't exported from the package; its callers scope first. A linked deploy's
  message is pinned byte for byte (`test/monitoring.test.ts`).

## Deploy history

- The project page's deploy history (`listDeployHistory`, db `deploy-history.ts`) diffs each
  deploy's latest scan against the latest scan of the previous deploy (by `deployed_at`) that has
  one, with the report's `findingsDiff` (by kind + variable), so a re-scan of the same sha
  replaces the first. Finding names are stored per scan, so no new storage.
- **Outage marker:** an outage is an alert's run of failed checks; it starts at the first failed
  check after the last ok check before the alert opened (the moment `alertOpenedMessage()`
  measures from), or the alert's open time once those checks are pruned
  (`CHECK_RETENTION_DAYS`). It is shown under the deploy it started after and before the next one,
  with "N more outages" when several did. Unlike `related_deploy_id`, there is no 30-minute window.

## Report data model

- **Months are UTC** (`parseMonth('YYYY-MM')` → `[from, to)`). A month in progress counts up to now.
- **Uptime** per endpoint = ok / checks over the month from `uptimeBetween()`: complete days from
  `endpoint_daily_stats`, other days from raw checks. The report's uptime is the average of the
  endpoints that have checks (each endpoint counts once).
- **Incidents** are alerts opened in the month; duration is open → resolve, or → month end / now.
  `afterDeploy` is the alert's `related_deploy_id` (read within the project) and its
  `deployConfigChange()` count (new MISSING plus new undeclared, as the message counted them; a
  re-scan of that deploy since can change it); null without a linked deploy.
- **Deploys** are the month's deploys; each is diffed (`findingsDiff`, by kind + variable) against
  the previous scanned deploy (including one before the month): introduced ("new config issues" on
  the page) and fixed.
- **Open findings** are the latest scan's, as of now.
- **Prepared by** (`preparedBy`) is the client's owner's GitHub name, else their login: the one
  thing about the owner a report (and so a share link) shows.
- **The summary** is `reportSummary(data)`, a paragraph for the client, pinned by tests in core
  and db: "In October, Acme's sites were up 99.81% of the time. There was one outage (30 minutes,
  16 Oct) after a deploy that was missing two settings. 10 updates were deployed and seven
  configuration issues were fixed." Built from the numbers only: no variable, file, commit or
  branch. Counts of things up to nine in words, durations in words with digits
  (`durationWords()`), dates as "16 Oct" (UTC); "So far in October" while the month runs. No
  endpoints: "no sites were monitored for <client>" and no outage sentence; endpoints without
  checks: "no uptime data yet"; an open outage: "ongoing … so far", or "still ongoing at the end of
  the month"; more than `SUMMARY_MAX_OUTAGES` (5) outages: the first five by date, "and N more".

## The report page

`views/report-view.tsx`, the same for the owner, /demo and a share link:

- **For the client, on top:** "Monthly report", the client and month, "Prepared by <name>", the
  summary, four tiles (uptime, incidents, deploys, config issues fixed), then per project its uptime
  per endpoint and its incidents (endpoint, opened, resolved, duration, "After a deploy": "Yes,
  missing 2 settings", "Yes" or "—"). No variable names, alert messages or commits there.
- **Technical details** (an `h2`, printed): per project its repository, the deploys table
  (commit and branch as text, "New config issues", "Fixed", by kind and variable), the alerts as
  sent, and the open findings with file:line.
- **No commit links** on the report or the share link (clients often can't open the repository);
  the signed-in project page keeps them. `test/report-view.test.ts` checks both halves.
