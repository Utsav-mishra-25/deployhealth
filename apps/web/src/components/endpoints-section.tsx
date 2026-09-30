import type { EndpointMonitoring } from '@deployhealth/db';
import { deleteEndpointAction, saveEndpointAction } from '@/app/projects/[projectId]/endpoint-actions';
import { EndpointForm } from '@/app/projects/[projectId]/endpoint-form';
import { ChecksTable } from './checks-table';
import { ConfirmButton } from './confirm-button';
import { LatencyChart } from './latency-chart';
import { EndpointStatusBadge, FailingFor } from './status-badge';

const EVERY: Record<number, string> = { 60: 'every minute', 300: 'every 5 min', 900: 'every 15 min' };

function percent(value: number | null): string {
  if (value === null) return '—';
  if (value === 1) return '100%';
  return `${(Math.floor(value * 1000) / 10).toFixed(1)}%`;
}

export function EndpointsSection({
  projectId,
  endpoints,
  readOnly = false,
}: {
  projectId: string;
  endpoints: EndpointMonitoring[];
  /** Hides the add, edit and delete forms (the public demo). */
  readOnly?: boolean;
}) {
  return (
    <section aria-labelledby="endpoints" className="space-y-4">
      <h2 id="endpoints" className="text-lg font-semibold">
        Endpoints
      </h2>

      {endpoints.length === 0 && (
        <p className="rounded-lg border border-dashed border-gray-300 bg-white p-6 text-sm text-gray-500">
          {readOnly ? 'No endpoints.' : 'No endpoints yet. Add a health-check URL below and the worker will check it on its interval.'}
        </p>
      )}

      {endpoints.map((m) => (
        <article key={m.endpoint.id} className="rounded-lg border border-gray-200 bg-white" data-testid="endpoint-card">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-4 py-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <EndpointStatusBadge status={m.status} />
              {m.failingSince && <FailingFor state={m.status === 'down' ? 'down' : 'failing'} since={m.failingSince} />}
              {m.endpoint.name && <span className="font-medium">{m.endpoint.name}</span>}
              <span className={m.endpoint.name ? 'min-w-0 font-mono text-xs break-all text-gray-500' : 'min-w-0 font-mono text-sm break-all'}>
                {m.endpoint.url}
              </span>
              <span className="text-xs text-gray-500">
                {m.endpoint.method} · {EVERY[m.endpoint.intervalSeconds]} · expects {m.endpoint.expectedStatus}
              </span>
            </div>
            <div className="flex items-center gap-4 text-sm">
              <span>
                <span className="text-gray-500">24h</span> <strong className="tabular-nums">{percent(m.uptime24h)}</strong>
              </span>
              <span>
                <span className="text-gray-500">7d</span> <strong className="tabular-nums">{percent(m.uptime7d)}</strong>
              </span>
            </div>
          </header>

          {m.recent.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-gray-500">No checks yet</p>
          ) : (
            <div className="grid gap-6 px-4 py-4 lg:grid-cols-2">
              <div className="min-w-0">
                <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500">Latency, last 24h</h3>
                <LatencyChart data={m.latency.map((p) => ({ hour: p.hour.toISOString(), p50: p.p50, p95: p.p95 }))} />
              </div>
              <div className="min-w-0">
                <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500">Recent checks</h3>
                <div className="overflow-x-auto">
                  <ChecksTable checks={m.recent} />
                </div>
              </div>
            </div>
          )}

          {!readOnly && (
          <details className="border-t border-gray-100 px-4 py-2">
            <summary className="cursor-pointer text-sm text-gray-500 hover:text-gray-900">Edit or delete</summary>
            <div className="space-y-3 py-3">
              <EndpointForm
                action={saveEndpointAction.bind(null, projectId, m.endpoint.id)}
                initial={{
                  name: m.endpoint.name ?? '',
                  url: m.endpoint.url,
                  method: m.endpoint.method,
                  intervalSeconds: String(m.endpoint.intervalSeconds),
                  expectedStatus: String(m.endpoint.expectedStatus),
                  enabled: m.endpoint.enabled,
                }}
                submitLabel="Save endpoint"
              />
              <form action={deleteEndpointAction.bind(null, projectId, m.endpoint.id)}>
                <ConfirmButton message="Delete this endpoint and its check history?" className="text-sm text-red-700 hover:underline">
                  Delete endpoint
                </ConfirmButton>
              </form>
            </div>
          </details>
          )}
        </article>
      ))}

      {!readOnly && (
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-semibold">Add endpoint</h3>
        <EndpointForm
          action={saveEndpointAction.bind(null, projectId, null)}
          initial={{ name: '', url: '', method: 'GET', intervalSeconds: '300', expectedStatus: '200', enabled: true }}
          submitLabel="Add endpoint"
          resetOnSave
        />
      </div>
      )}
    </section>
  );
}
