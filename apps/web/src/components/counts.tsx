import type { FindingCounts, FindingKind } from '@deployhealth/core';

export const KIND_STYLES: Record<FindingKind, { label: string; text: string; bg: string; ring: string }> = {
  missing: { label: 'Missing', text: 'text-red-700', bg: 'bg-red-50', ring: 'ring-red-200' },
  unused: { label: 'Unused', text: 'text-amber-800', bg: 'bg-amber-50', ring: 'ring-amber-200' },
  mismatch: { label: 'Mismatch', text: 'text-violet-700', bg: 'bg-violet-50', ring: 'ring-violet-200' },
};

const KINDS: FindingKind[] = ['missing', 'unused', 'mismatch'];

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

/** What the three kinds mean, in one line, where the counts first appear. */
export const FINDINGS_LEGEND: Record<FindingKind, string> = {
  missing: 'read in code, but in no env file',
  unused: 'in an env file, never read',
  mismatch: '.env and .env.example disagree',
};

export function FindingsLegend() {
  return (
    <p className="mt-2 text-xs text-gray-500" data-testid="findings-legend">
      {KINDS.map((kind, i) => (
        <span key={kind}>
          {i > 0 && ' · '}
          <span className="font-medium text-gray-600">{KIND_STYLES[kind].label}</span>: {FINDINGS_LEGEND[kind]}
        </span>
      ))}
    </p>
  );
}
