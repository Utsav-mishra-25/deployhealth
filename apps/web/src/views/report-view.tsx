import {
  describeFinding,
  FINDING_SECTIONS,
  formatDuration,
  formatPercent,
  formatUtc,
  plural,
  reportTotals,
  summaryLine,
  type FindingKey,
  type ReportData,
} from '@deployhealth/core';

const th = 'py-1.5 pr-4 text-left text-xs font-medium uppercase tracking-wide text-gray-500';
const td = 'py-1.5 pr-4 align-top';

function Keys({ keys, tone }: { keys: FindingKey[]; tone: 'red' | 'green' }) {
  if (keys.length === 0) return <span className="text-gray-400">—</span>;
  const color = tone === 'red' ? 'bg-red-50 text-red-800 ring-red-200' : 'bg-emerald-50 text-emerald-800 ring-emerald-200';
  return (
    <span className="flex flex-wrap gap-1">
      {keys.map((k) => (
        <span key={`${k.kind}:${k.var_name}`} className={`rounded px-1.5 py-0.5 font-mono text-xs ring-1 ring-inset ${color}`}>
          {k.kind} {k.var_name}
        </span>
      ))}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 p-3">
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}

/**
 * A client's monthly report (printable; no external assets). Rendered for the owner, for the
 * demo, and for anyone holding a signed share link: the same view, with different toolbars.
 */
export function ReportView({ data, toolbar, banner }: { data: ReportData; toolbar?: React.ReactNode; banner?: React.ReactNode }) {
  const totals = reportTotals(data);
  const inProgress = data.generatedAt.getTime() < data.month.to.getTime();

  return (
    <article className="mx-auto max-w-4xl space-y-8 rounded-lg border border-gray-200 bg-white p-8 print:border-0 print:p-0" data-testid="report">
      {banner}
      {toolbar && <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">{toolbar}</div>}

      <header className="space-y-2">
        <p className="text-sm font-medium uppercase tracking-wide text-emerald-700">Monthly report</p>
        <h1 className="text-2xl font-semibold">
          {data.client.name} · {data.month.label}
          {inProgress && <span className="text-gray-500"> (to date)</span>}
        </h1>
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-lg text-emerald-950" data-testid="report-summary">
          {summaryLine(totals)}
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="uptime (endpoint average)" value={formatPercent(totals.uptime)} />
        <Stat label={totals.incidents === 1 ? 'incident' : 'incidents'} value={String(totals.incidents)} />
        <Stat label={totals.deploys === 1 ? 'deploy' : 'deploys'} value={String(totals.deploys)} />
        <Stat label="config issues fixed" value={String(totals.fixed)} />
        <Stat label="introduced" value={String(totals.introduced)} />
      </div>

      {data.projects.length === 0 && <p className="text-sm text-gray-600">This client has no projects.</p>}

      {data.projects.map((project) => (
        <section key={project.name} aria-label={project.name} className="doc-section space-y-4" data-testid="report-project">
          <div className="border-b border-gray-200 pb-1">
            <h2 className="text-lg font-semibold">{project.name}</h2>
            <p className="text-xs break-all text-gray-500">github.com/{project.repoFullName}</p>
          </div>

          <div className="space-y-1">
            <h3 className="text-sm font-semibold">Uptime</h3>
            {project.endpoints.length === 0 ? (
              <p className="text-sm text-gray-600">No monitored endpoints.</p>
            ) : (
              <table className="doc-table w-full table-fixed text-sm">
                <colgroup>
                  <col className="w-[40%]" />
                  <col className="w-[40%]" />
                  <col className="w-[20%]" />
                </colgroup>
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className={th}>Endpoint</th>
                    <th className={th}>Checks</th>
                    <th className={th}>Uptime</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {project.endpoints.map((e) => (
                    <tr key={e.url + e.label}>
                      <td className={`${td} font-medium break-words`}>{e.label}</td>
                      <td className={`${td} tabular-nums text-gray-600`}>{e.checks.toLocaleString('en')}</td>
                      <td className={`${td} tabular-nums`}>{formatPercent(e.uptime)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="space-y-1">
            <h3 className="text-sm font-semibold">Incidents</h3>
            {project.incidents.length === 0 ? (
              <p className="text-sm text-gray-600">None.</p>
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
                    {project.incidents.map((i) => (
                      <tr key={i.openedAt.toISOString() + i.message}>
                        <td className={`${td} whitespace-nowrap`}>{formatUtc(i.openedAt)}</td>
                        <td className={`${td} whitespace-nowrap`}>{i.resolvedAt ? formatUtc(i.resolvedAt) : 'still open'}</td>
                        <td className={`${td} whitespace-nowrap`}>{formatDuration(i.durationMs)}</td>
                        <td className={td}>{i.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="space-y-1">
            <h3 className="text-sm font-semibold">
              Deploys <span className="font-normal text-gray-500">· {plural(project.deploys.length, 'deploy')}</span>
            </h3>
            {project.deploys.length > 0 && (
              <div className="doc-scroll">
                <table className="doc-table w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200">
                      <th className={th}>Deployed</th>
                      <th className={th}>Commit</th>
                      <th className={th}>Introduced</th>
                      <th className={th}>Fixed</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {project.deploys.map((d) => (
                      <tr key={d.sha}>
                        <td className={`${td} whitespace-nowrap`}>{formatUtc(d.deployedAt)}</td>
                        <td className={`${td} whitespace-nowrap font-mono`}>
                          {d.sha.slice(0, 7)} <span className="text-gray-500">{d.branch}</span>
                        </td>
                        <td className={td}>
                          <Keys keys={d.introduced} tone="red" />
                        </td>
                        <td className={td}>
                          <Keys keys={d.fixed} tone="green" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="space-y-1">
            <h3 className="text-sm font-semibold">Open findings now</h3>
            {project.openFindings.length === 0 ? (
              <p className="text-sm text-gray-600">None.</p>
            ) : (
              FINDING_SECTIONS.map((section) => {
                const rows = project.openFindings.filter((f) => f.kind === section.kind);
                if (rows.length === 0) return null;
                return (
                  <div key={section.kind}>
                    <p className="text-sm">
                      {section.title} ({rows.length}) <span className="text-gray-500">· {section.blurb}</span>
                    </p>
                    <ul className="list-disc pl-5 text-sm">
                      {rows.map((f, i) => (
                        <li key={`${f.var_name}-${i}`}>
                          <code className="font-mono">{f.var_name}</code>: {describeFinding(f)}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })
            )}
          </div>
        </section>
      ))}

      <footer className="border-t border-gray-200 pt-3 text-xs text-gray-500">
        {data.month.label}, {formatUtc(data.month.from)} to {formatUtc(inProgress ? data.generatedAt : data.month.to)}. Generated{' '}
        {formatUtc(data.generatedAt)} by deployhealth. All times UTC.
      </footer>
    </article>
  );
}
