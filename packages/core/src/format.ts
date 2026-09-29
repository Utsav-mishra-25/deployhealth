// Formatting shared by the handoff export and the monthly report (and their web pages). Pure, so
// the Markdown and HTML versions of a document always agree.

/** "2026-09-28 12:04 UTC". Handoffs and reports state all times in UTC. */
export function formatUtc(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** "2026-09-28". */
export function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * An uptime ratio as a percentage with two decimals, rounded down so a single failure never shows
 * as "100.00%": 0.99937 → "99.93%". Exactly 1 is "100%"; null (no checks) is "no data".
 */
export function formatPercent(ratio: number | null): string {
  if (ratio === null) return 'no data';
  if (ratio >= 1) return '100%';
  // The epsilon keeps 0.9994 (really 0.99939999…) from flooring to 99.93.
  return `${(Math.floor(ratio * 10_000 + 1e-6) / 100).toFixed(2)}%`;
}

const INTERVALS: Record<number, string> = { 60: 'every minute', 300: 'every 5 minutes', 900: 'every 15 minutes' };

/** "every minute", "every 5 minutes", … */
export function formatInterval(seconds: number): string {
  return INTERVALS[seconds] ?? `every ${seconds}s`;
}

/** "1 project", "3 projects". */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
