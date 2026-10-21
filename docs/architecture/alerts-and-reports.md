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

- **Open** when the endpoint has **2 consecutive failures** (`ALERT_FAILURE_THRESHOLD`) and **at
  least one ok check** in its history. At most one open alert per endpoint (partial unique index
  `alerts_one_open_per_endpoint`).
- **Resolve** after **2 consecutive ok checks** (`ALERT_RECOVERY_THRESHOLD`), so a flapping host
  (fail, fail, ok, fail, fail, …) is one incident and one pair of webhooks. `recordCheck()` keeps
  both counters (`endpoints.consecutive_failures`, `consecutive_ok`) in the one update (ok:
  failures 0, ok + 1; failed: failures + 1, ok 0) and passes them to `decideAlert()`. The resolved
  message ("Acme API is back up (alert open for 21m)") runs from the open to the resolving check,
  and the row gets `resolution = 'recovered'`. Between the first ok and the resolving one the
  endpoint stays "down" (the alert decides).
- **Pause resolves:** `updateEndpoint()` turning `enabled` from true to false resolves the open
  alert in the same transaction (`resolved_at` = now, `resolution = 'paused'`) and returns a
  'resolved' event with `alertPausedMessage()`: "Acme API paused (alert open for 12m)", so the
  webhook reads "[resolved] Acme Storefront: Acme API paused (alert open for 12m)". Changing
  `enabled` either way resets both counters (and every edit makes the endpoint due now), so
  re-enabling starts fresh. A check claimed before the pause and recorded after it is stored but
  takes no alert action (`recordCheck()` skips the rule on a disabled endpoint).
  `alerts.resolution` is null while open and on rows resolved before migration 0010 (read as
  recovered).
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
  and continue on failure; at most one retry. A pause happens in the web app, which makes no
  outbound HTTP: the save action queues `alert-webhook` (`{ projectId, type, message }`, never the
  URL) and the worker reads the project's current name and URL (`alertWebhookTarget()`) and sends
  it through the same guarded sender. A failed enqueue is logged (name and code) and the save
  still succeeds. `webhookPayload()` escapes the text for chat
  (`escapeChatText`: `&` `<` `>` as entities, a zero-width space after the `@` of `@everyone`,
  `@here`, `@channel`).
- **Down duration:** "Down for 21m" next to endpoint and project badges counts from the open
  alert's `created_at` (the number the resolved message uses), so it stays through the ok check
  before recovery. "Failing for 1m" (failing, no open alert) counts from the first failed check of
  the current run: `failingSinceSql()` in `monitoring.ts` (also used for the alert's first
  failure). Both are exposed as `EndpointMonitoring.failingSince` and
  `ProjectListItem.failingSince`, and labelled by `failingFor()` in core.

- **The deploy diff** behind the message (new MISSING, new undeclared) is `deployConfigChange()` in
  db `deploy-config.ts`, which the monthly report also counts with. That module reads by project
  and deploy id, so it isn't exported from the package; its callers scope first. A linked deploy's
  message is pinned byte for byte (`test/monitoring.test.ts`).

## Checks: HEAD fallback and spacing

- **HEAD fallback** (`runCheck()`, worker `check.ts`): when the request that ends the redirect
  chain is a HEAD and gets 405, one GET goes to that same URL within the same 10 s budget
  (`CHECK_TIMEOUT_MS`), following no redirect of its own; its status and latency are the result,
  and a failing GET reads "Expected 200, got 503". No fallback for any other status, for GET
  checks, or when 405 is the expected status.
- **Spacing:** checks of one hostname start at least `HOST_CHECK_SPACING_MS` (10 s) apart across
  all users, and one claim hands out start times within `CLAIM_WINDOW_MS` (50 s), so it starts at
  most `MAX_CHECKS_PER_HOST_PER_CLAIM` (5) checks of a hostname. More than 5 endpoints on one
  hostname at "Every minute" are therefore checked less often than every minute. The endpoint
  form says so under Interval, and the timeout and redirects under URL; /security has the same
  sentence; all built from those constants (core `limits.ts`, `constants.ts`).
- **Falling behind:** each check-endpoints run logs `claimed`, `due_but_unclaimed` (enabled
  endpoints still due right after the claim, `countDueEndpoints()`), `due_waiting_on_host` (those
  on hostnames the claim left at the per-host cap) and `run_ms`. The operator alert fires after 5
  runs in a row with `due_but_unclaimed - due_waiting_on_host > 0`, so 8 every-minute endpoints on
  one host never trigger it (worker.md).

## Alert history

- `listAlerts(db, ownerId, projectId, { limit = 50 })` (owner-scoped, at most 200): open and
  resolved alerts newest first, with the endpoint's url and name, the linked deploy's sha and the
  resolution ('recovered', 'paused', or null while open). No page uses it yet.
- `EndpointMonitoring.failures24h`: failed checks in the last 24 h, from the same query as the
  uptime windows; the endpoint card shows "31 failures in 24h" when it's above 0.

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
- **Incidents** are alerts opened in the month; duration is open → resolve (a pause ends it at the
  pause), or → month end / now. `paused` marks one resolved by a pause: the technical details say
  "12m (paused)" (`incidentDetailDuration()`), and so does the handoff's alert table
  (`alertDuration()`); the client-facing table and summary never do.
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
  summary, four tiles ("uptime", "outage(s)", "deploy(s)", "config issue(s) fixed"), then per project
  its uptime per endpoint and its outages (an "Outages" table: endpoint, opened, resolved, duration, "After a deploy": "Yes,
  missing 2 settings", "Yes" or "—"). No variable names, alert messages or commits there.
- **Technical details** (an `h2`, printed): per project its repository, the deploys table
  (commit and branch as text, "New config issues", "Fixed", by kind and variable), the alerts as
  sent (each with its opened time and duration, "(paused)" when a pause resolved it), and the open
  findings with file:line.
- **No commit links** on the report or the share link (clients often can't open the repository);
  the signed-in project page keeps them. `test/report-view.test.ts` checks both halves.
