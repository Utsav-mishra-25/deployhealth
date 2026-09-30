import { monthOf, parseMonth } from '@deployhealth/core';
import { getClientBySlug, getProjectForOwner } from '@deployhealth/db';
import type { Metadata } from 'next';
import { getDb } from '@/lib/db';
import { isUuid } from '@/lib/format';

/** Whose data a page shows: the signed-in user's, or the public demo's. */
export type TitleScope = 'app' | 'demo';

/** "acme-storefront · deployhealth", "Handoff · acme-storefront · Live demo · deployhealth". */
export function pageTitle(parts: readonly string[], scope: TitleScope): string {
  return [...parts, ...(scope === 'demo' ? ['Live demo'] : []), 'deployhealth'].join(' · ');
}

/**
 * A project page's title, looked up with the same owner scoping as the page. The caller passes the
 * owner (the session's user, or the demo user), so demo pages never touch the session. No owner, or
 * not theirs: just the prefix, and the page itself redirects or 404s.
 */
export async function projectMetadata(scope: TitleScope, ownerId: string | null, projectId: string, prefix?: string): Promise<Metadata> {
  const project = ownerId && isUuid(projectId) ? await getProjectForOwner(getDb(), projectId, ownerId) : null;
  return { title: pageTitle([...(prefix ? [prefix] : []), ...(project ? [project.name] : [])], scope) };
}

export async function clientMetadata(scope: TitleScope, ownerId: string | null, slug: string): Promise<Metadata> {
  const client = ownerId ? await getClientBySlug(getDb(), ownerId, slug) : null;
  return { title: pageTitle(client ? [client.name] : [], scope) };
}

/** "Report · September 2026 · deployhealth": the month only, never the client's name. */
export function reportMetadata(scope: TitleScope, monthKey: string | undefined, now = new Date()): Metadata {
  const month = monthKey === undefined ? monthOf(now) : parseMonth(monthKey);
  return { title: pageTitle(month ? ['Report', month.label] : ['Monthly report'], scope) };
}
