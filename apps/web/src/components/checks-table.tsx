import type { Check } from '@deployhealth/db';
import { TimeAgo } from './time-ago';

export function ChecksTable({ checks }: { checks: Check[] }) {
  return (
    <table className="w-full text-left text-sm">
      <thead className="text-xs uppercase tracking-wide text-gray-500">
        <tr>
          <th className="py-1.5 pr-2 font-medium sm:pr-3">Checked</th>
          <th className="px-2 py-1.5 sm:px-3 font-medium">Status</th>
          <th className="px-2 py-1.5 sm:px-3 font-medium">Latency</th>
          <th className="py-1.5 pl-2 font-medium sm:pl-3">Result</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">
        {checks.map((c) => (
          <tr key={c.id}>
            <td className="py-1.5 pr-2 whitespace-nowrap sm:pr-3 text-gray-600">
              <TimeAgo date={c.checkedAt} />
            </td>
            <td className="px-2 py-1.5 sm:px-3 font-mono">{c.statusCode ?? '—'}</td>
            <td className="px-2 py-1.5 sm:px-3 whitespace-nowrap tabular-nums">{c.latencyMs === null ? '—' : `${c.latencyMs} ms`}</td>
            <td className={`min-w-34 py-1.5 pl-2 sm:pl-3 ${c.ok ? 'text-emerald-700' : 'text-red-700'}`}>{c.ok ? 'OK' : c.error}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
