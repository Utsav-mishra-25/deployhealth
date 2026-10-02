# Alerts and reports

When an alert opens and resolves, how it names the deploy that broke things, webhooks, endpoint
names, and the monthly report's numbers. Read before changing `packages/core/src/alerts.ts`,
`report.ts`, `handoff.ts`, `format.ts`, `recordCheck()` or the report views.

## Layout (core)

```
    src/alerts.ts     decideAlert() state machine, alert messages, endpointLabel(), failingFor()
    src/format.ts     formatUtc(), formatPercent() (rounds down), formatInterval(), plural()
    src/handoff.ts    HandoffData, renderHandoffMarkdown(), parseHandoffVariables()
    src/report.ts     report months (UTC), findingsDiff(), ReportData, reportTotals(), summaryLine()
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
  ", plus"), "…which had no new config findings", or "…no deploy in the 30 minutes before the
  first failure". Each kind lists every name up to 6, else 5 and "and N more"
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

## Report data model

- **Months are UTC** (`parseMonth('YYYY-MM')` → `[from, to)`). A month in progress counts up to now.
- **Uptime** per endpoint = ok / checks over the month from `uptimeBetween()`: complete days from
  `endpoint_daily_stats`, other days from raw checks. The report's uptime is the average of the
  endpoints that have checks (each endpoint counts once).
- **Incidents** are alerts opened in the month; duration is open → resolve, or → month end / now.
- **Deploys** are the month's deploys; each is diffed (`findingsDiff`, by kind + variable) against
  the previous scanned deploy (including one before the month): introduced and fixed.
- **Open findings** are the latest scan's, as of now.
- `summaryLine(reportTotals(data))` is the plain-English line, pinned by tests in core and db:
  "3 projects, 99.94% uptime, 1 incident (21m), 14 deploys, 2 config issues fixed".
