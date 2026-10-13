import { formatDuration, listNames, type FindingKey, type FindingKind } from '@deployhealth/core/browser';
import type { DeployChange, DeployOutage } from '@deployhealth/db';
import { REPO_FULL_NAME_PATTERN } from './github-app';

const KINDS: FindingKind[] = ['missing', 'mismatch', 'unused'];

/** "+2 missing: REDIS_URL, STRIPE_KEY" or "fixed 1 unused: OLD_FLAG" per kind, names capped like alerts. */
function byKind(keys: readonly FindingKey[], lead: (n: number, kind: FindingKind) => string): string[] {
  return KINDS.flatMap((kind) => {
    const names = keys.filter((k) => k.kind === kind).map((k) => k.var_name);
    return names.length === 0 ? [] : [`${lead(names.length, kind)}: ${listNames(names)}`];
  });
}

/**
 * What a deploy changed, compared with the previous scanned deploy: "+1 missing: REDIS_URL · fixed
 * 1 unused: OLD_FLAG", "no change", "first scan" (nothing to compare with) or "not scanned".
 */
export function changeLine(change: DeployChange): string {
  if (change.kind === 'unscanned') return 'not scanned';
  if (change.kind === 'first') return 'first scan';
  const parts = [...byKind(change.introduced, (n, kind) => `+${n} ${kind}`), ...byKind(change.fixed, (n, kind) => `fixed ${n} ${kind}`)];
  return parts.length === 0 ? 'no change' : parts.join(' · ');
}

/**
 * "Outage started 14m after this deploy (Acme API), resolved after 21m", "…, still down", plus
 * "· 1 more outage" when several started before the next deploy.
 */
export function outageLine(outage: DeployOutage, deployedAt: Date): string {
  const after = formatDuration(outage.startedAt.getTime() - deployedAt.getTime());
  const end = outage.resolvedAt ? `resolved after ${formatDuration(outage.resolvedAt.getTime() - outage.startedAt.getTime())}` : 'still down';
  const more = outage.more > 0 ? ` · ${outage.more} more ${outage.more === 1 ? 'outage' : 'outages'}` : '';
  return `Outage started ${after} after this deploy (${outage.endpoint}), ${end}${more}`;
}

const SHA = /^[0-9a-f]{7,40}$/i;

/**
 * The commit on GitHub, when the project names a GitHub repository (owner/repo) and the sha is
 * one. Null on the demo, whose repositories are made up: never link to whoever owns that name.
 */
export function commitUrl(repoFullName: string, sha: string, readOnly: boolean): string | null {
  if (readOnly || !REPO_FULL_NAME_PATTERN.test(repoFullName) || !SHA.test(sha)) return null;
  return `https://github.com/${repoFullName}/commit/${sha}`;
}
