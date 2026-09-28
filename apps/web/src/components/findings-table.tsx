import type { FindingKind, FindingRow } from '@deployhealth/core';
import { KIND_STYLES } from './counts';

const DESCRIPTIONS: Record<FindingKind, string> = {
  missing: 'Referenced in code, not defined in any env file for its scope',
  unused: 'Defined in an env file, never referenced',
  mismatch: '.env and .env.example disagree',
};

function location(f: FindingRow): string {
  return f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : '—';
}

function detail(f: FindingRow): string {
  if (f.kind === 'mismatch') return `missing from ${f.env_file}`;
  if (f.kind === 'unused') return 'never referenced';
  return 'not defined';
}

/** One table per kind, with file:line for every finding. */
export function FindingsByKind({ findings }: { findings: FindingRow[] }) {
  return (
    <div className="space-y-6">
      {(['missing', 'unused', 'mismatch'] as const).map((kind) => {
        const rows = findings.filter((f) => f.kind === kind);
        const s = KIND_STYLES[kind];
        return (
          <section key={kind} aria-labelledby={`findings-${kind}`}>
            <h3 id={`findings-${kind}`} className="flex items-baseline gap-2">
              <span className={`text-sm font-semibold uppercase tracking-wide ${s.text}`}>{s.label}</span>
              <span className="text-sm text-gray-500">
                {rows.length} {rows.length === 1 ? 'finding' : 'findings'} · {DESCRIPTIONS[kind]}
              </span>
            </h3>
            {rows.length === 0 ? (
              <p className="mt-2 text-sm text-gray-400">None</p>
            ) : (
              <table className="mt-2 w-full overflow-hidden rounded-lg bg-white text-left text-sm ring-1 ring-gray-200">
                <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Variable</th>
                    <th className="px-3 py-2 font-medium">Location</th>
                    <th className="px-3 py-2 font-medium">Detail</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((f, i) => (
                    <tr key={`${f.var_name}-${f.file}-${f.line}-${i}`}>
                      <td className="px-3 py-2 font-mono font-medium">{f.var_name}</td>
                      <td className="px-3 py-2 font-mono text-gray-700">{location(f)}</td>
                      <td className="px-3 py-2 text-gray-500">{detail(f)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}
    </div>
  );
}
