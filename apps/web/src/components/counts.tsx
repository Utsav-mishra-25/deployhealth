import type { FindingCounts, FindingKind } from '@deployhealth/core';

export const KIND_STYLES: Record<FindingKind, { label: string; text: string; bg: string; ring: string }> = {
  missing: { label: 'Missing', text: 'text-red-700', bg: 'bg-red-50', ring: 'ring-red-200' },
  unused: { label: 'Unused', text: 'text-amber-800', bg: 'bg-amber-50', ring: 'ring-amber-200' },
  mismatch: { label: 'Mismatch', text: 'text-violet-700', bg: 'bg-violet-50', ring: 'ring-violet-200' },
};

const KINDS: FindingKind[] = ['missing', 'unused', 'mismatch'];

/** Compact "2 missing · 1 unused · 0 mismatch" pills; greyed out when zero. */
export function CountPills({ counts }: { counts: FindingCounts }) {
  return (
    <span className="inline-flex gap-1.5">
      {KINDS.map((kind) => {
        const s = KIND_STYLES[kind];
        const n = counts[kind];
        return (
          <span
            key={kind}
            title={`${n} ${s.label.toLowerCase()}`}
            className={`rounded px-1.5 py-0.5 text-xs font-medium tabular-nums ring-1 ring-inset ${
              n > 0 ? `${s.bg} ${s.text} ${s.ring}` : 'bg-gray-50 text-gray-500 ring-gray-200'
            }`}
          >
            {n} {s.label.toLowerCase()}
          </span>
        );
      })}
    </span>
  );
}

/** The three big numbers at the top of a project page. */
export function SummaryCards({ counts }: { counts: FindingCounts }) {
  return (
    <div className="grid grid-cols-3 gap-3">
      {KINDS.map((kind) => {
        const s = KIND_STYLES[kind];
        const n = counts[kind];
        return (
          <div key={kind} className={`rounded-lg p-4 ring-1 ring-inset ${n > 0 ? `${s.bg} ${s.ring}` : 'bg-white ring-gray-200'}`}>
            <div className={`text-3xl font-semibold tabular-nums ${n > 0 ? s.text : 'text-gray-500'}`}>{n}</div>
            <div className="mt-1 text-sm text-gray-600">{s.label}</div>
          </div>
        );
      })}
    </div>
  );
}
