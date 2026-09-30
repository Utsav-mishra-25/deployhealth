import {
  alertDuration,
  describeFinding,
  FINDING_SECTIONS,
  formatInterval,
  formatPercent,
  formatUtc,
  groupVariablesByScope,
  plural,
  type HandoffData,
} from '@deployhealth/core';
import Link from 'next/link';
import { PrintButton } from '@/components/print-button';
import { SafeMarkdown } from '@/components/safe-markdown';

const th = 'py-1.5 pr-4 text-left text-xs font-medium uppercase tracking-wide text-gray-500';
const td = 'py-1.5 pr-4 align-top';

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="doc-section space-y-3">
      <h2 id={id} className="border-b border-gray-200 pb-1 text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * The printable handoff (print CSS, no external assets). Same data and sections as the Markdown
 * download; "Print or save as PDF" is the PDF path.
 */
export function HandoffView({ data, backHref, markdownHref }: { data: HandoffData; backHref: string; markdownHref: string }) {
  const groups = groupVariablesByScope(data.variables);
  const missing = data.variables.filter((v) => v.defined_in.length === 0).length;

  return (
    <article className="mx-auto max-w-4xl space-y-8 rounded-lg border border-gray-200 bg-white p-8 print:border-0 print:p-0" data-testid="handoff">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href={backHref} className="text-sm text-gray-600 hover:text-gray-900">
          ← Back to project
        </Link>
        <div className="flex gap-2">
          <a href={markdownHref} className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium hover:bg-gray-50">
            Download Markdown
          </a>
          <PrintButton />
        </div>
      </div>

      <header className="space-y-3">
        <h1 className="text-2xl font-semibold">Handoff: {data.project.name}</h1>
        <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
          {data.client && (
            <>
              <dt className="text-gray-500">Client</dt>
              <dd>
                {data.client.name}
                {data.client.contactEmail && <span className="text-gray-500"> ({data.client.contactEmail})</span>}
              </dd>
            </>
          )}
          <dt className="text-gray-500">Repository</dt>
          <dd>github.com/{data.project.repoFullName}</dd>
          <dt className="text-gray-500">Generated</dt>
          <dd>{formatUtc(data.generatedAt)}</dd>
        </dl>
        <p className="text-sm text-gray-600">
          All times UTC. This document lists environment variable <strong>names only</strong>; it never contains their values.
        </p>
      </header>

      <Section id="variables" title="Required environment variables">
        {!data.scan ? (
          <p className="text-sm text-gray-600">No scans yet. Add the GitHub Action below and push once to list every variable the code needs.</p>
        ) : !data.scan.variablesReported ? (
          <p className="text-sm text-gray-600">
            The latest scan (deploy <code className="font-mono">{data.scan.sha.slice(0, 7)}</code>) came from an older scan CLI that only
            reported problems. Re-run the GitHub Action to list every variable; the open findings below still apply.
          </p>
        ) : data.variables.length === 0 ? (
          <p className="text-sm text-gray-600">The code references no environment variables.</p>
        ) : (
          <>
            <p className="text-sm text-gray-600">
              Every variable the code references in the latest scan (deploy <code className="font-mono">{data.scan.sha.slice(0, 7)}</code> on{' '}
              <code className="font-mono break-all">{data.scan.branch}</code>, {formatUtc(data.scan.deployedAt)}), grouped by the env-file scope that has
              to define it.{' '}
              {missing ? <strong className="text-red-700">{plural(missing, 'variable')} missing.</strong> : 'None missing.'}
            </p>
            {groups.map((group) => (
              <div key={group.scope} className="space-y-1">
                <h3 className="text-sm font-semibold">{group.scope === '' ? group.label : <code className="font-mono break-all">{group.scope}</code>}</h3>
                <table className="doc-table w-full table-fixed text-sm" data-testid="handoff-variables">
                  <colgroup>
                    <col className="w-[45%]" />
                    <col className="w-[35%]" />
                    <col className="w-[20%]" />
                  </colgroup>
                  <thead>
                    <tr className="border-b border-gray-200">
                      <th className={th}>Variable</th>
                      <th className={th}>Defined in</th>
                      <th className={th}>Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {group.variables.map((v) => (
                      <tr key={v.var_name}>
                        <td className={`${td} font-mono break-all`}>{v.var_name}</td>
                        <td className={`${td} font-mono break-words text-gray-600`}>{v.defined_in.length ? v.defined_in.join(', ') : '—'}</td>
                        <td className={td}>{v.defined_in.length ? 'ok' : <strong className="text-red-700">missing</strong>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </>
        )}
      </Section>

      <Section id="endpoints" title="Monitored endpoints">
        {data.endpoints.length === 0 ? (
          <p className="text-sm text-gray-600">No endpoints are monitored.</p>
        ) : (
          <div className="doc-scroll">
            <table className="doc-table w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className={th}>Endpoint</th>
                  <th className={th}>URL</th>
                  <th className={th}>Check</th>
                  <th className={th}>Expects</th>
                  <th className={th}>Uptime, 30 days</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.endpoints.map((e) => (
                  <tr key={e.url + e.label}>
                    <td className={`${td} font-medium`}>{e.label}</td>
                    <td className={`${td} font-mono text-xs break-all text-gray-600`}>{e.url}</td>
                    <td className={td}>
                      {e.method} {formatInterval(e.intervalSeconds)}
                      {!e.enabled && ' (paused)'}
                    </td>
                    <td className={td}>{e.expectedStatus}</td>
                    <td className={`${td} tabular-nums`}>{formatPercent(e.uptime)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section id="action" title="GitHub Action">
        <p className="text-sm text-gray-600">
          Scans run in CI on every push. Save the project&rsquo;s ingest token as the repository secret <code className="font-mono">DEPLOYHEALTH_TOKEN</code>{' '}
          (tokens are shown once; regenerate one on the project&rsquo;s settings page), then commit this workflow:
        </p>
        <pre className="overflow-x-auto rounded-md border border-gray-200 bg-gray-50 p-3 font-mono text-xs whitespace-pre-wrap">{data.actionSnippet.trimEnd()}</pre>
      </Section>

      <Section id="findings" title="Open findings">
        {!data.scan ? (
          <p className="text-sm text-gray-600">No scans yet.</p>
        ) : data.findings.length === 0 ? (
          <p className="text-sm text-gray-600">None: every referenced variable is defined, and the env files agree.</p>
        ) : (
          FINDING_SECTIONS.map((section) => {
            const rows = data.findings.filter((f) => f.kind === section.kind);
            if (rows.length === 0) return null;
            return (
              <div key={section.kind} className="space-y-1">
                <h3 className="text-sm font-semibold">
                  {section.title} ({rows.length}) <span className="font-normal text-gray-500">· {section.blurb}</span>
                </h3>
                <ul className="list-disc space-y-0.5 pl-5 text-sm break-words">
                  {rows.map((f, i) => (
                    <li key={`${f.var_name}-${i}`}>
                      <code className="font-mono break-all">{f.var_name}</code>: {describeFinding(f)}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })
        )}
      </Section>

      <Section id="uptime" title="Uptime, last 30 days">
        <p className="text-sm">
          {data.endpoints.length === 0 ? (
            'No endpoints are monitored.'
          ) : (
            <>
              <strong className="tabular-nums">{formatPercent(data.uptime)}</strong> on average across {plural(data.endpoints.length, 'endpoint')},{' '}
              {formatUtc(data.window.from)} to {formatUtc(data.window.to)}.
            </>
          )}
        </p>
      </Section>

      <Section id="alerts" title="Alerts, last 30 days">
        {data.alerts.length === 0 ? (
          <p className="text-sm text-gray-600">No alerts.</p>
        ) : (
          <div className="doc-scroll">
            <table className="doc-table w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className={th}>Opened</th>
                  <th className={th}>Resolved</th>
                  <th className={th}>Duration</th>
                  <th className={th}>What happened</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.alerts.map((a) => (
                  <tr key={a.openedAt.toISOString() + a.message}>
                    <td className={`${td} whitespace-nowrap`}>{formatUtc(a.openedAt)}</td>
                    <td className={`${td} whitespace-nowrap`}>{a.resolvedAt ? formatUtc(a.resolvedAt) : 'still open'}</td>
                    <td className={`${td} whitespace-nowrap`}>{alertDuration(a, data.generatedAt)}</td>
                    <td className={td}>{a.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section id="deploy" title="How to deploy">
        {data.deployNotes ? <SafeMarkdown>{data.deployNotes}</SafeMarkdown> : <p className="text-sm text-gray-600 italic">No deploy notes yet.</p>}
      </Section>

      <footer className="border-t border-gray-200 pt-3 text-xs text-gray-500">
        Generated {formatUtc(data.generatedAt)} by deployhealth. All times UTC.
      </footer>
    </article>
  );
}
