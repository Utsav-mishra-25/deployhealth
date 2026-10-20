import type { Db, Endpoint, Project } from '@deployhealth/db';
import { describe, expect, it, vi } from 'vitest';
import { alertDestination } from '@/lib/alert-destination';

const OWNER = 'owner-1';
const WEBHOOK = 'https://hooks.slack.com/services/T000/B000/XXXX';
const db = {} as Db;

/** Fake owner-scoped queries over these projects: webhook per project id, endpoint count per project id. */
function queries(webhooks: Record<string, string | null>, endpoints: Record<string, number>) {
  return {
    getProjectForOwner: vi.fn(async (_db: Db, projectId: string, ownerId: string) =>
      ownerId === OWNER && projectId in webhooks ? ({ id: projectId, alertWebhookUrl: webhooks[projectId] } as Project) : null,
    ),
    listEndpointsForOwner: vi.fn(async (_db: Db, ownerId: string, projectId: string) =>
      ownerId === OWNER ? (Array.from({ length: endpoints[projectId] ?? 0 }, () => ({}) as Endpoint)) : [],
    ),
  };
}

const projects = [{ id: 'old' }, { id: 'mid' }, { id: 'new' }];

describe('alertDestination: the checklist\'s "Choose where alerts go"', () => {
  it('a webhook on any project: done, and no endpoint is read', async () => {
    const q = queries({ old: null, mid: WEBHOOK, new: null }, { old: 1 });
    expect(await alertDestination(db, OWNER, { projects, endpoints: 1 }, q)).toEqual({ webhookSet: true, projectId: null });
    expect(q.getProjectForOwner).toHaveBeenCalledTimes(3);
    expect(q.listEndpointsForOwner).not.toHaveBeenCalled();
  });

  it('no webhook: the oldest project with an endpoint, stopping at the first one found', async () => {
    const q = queries({ old: null, mid: null, new: null }, { mid: 2, new: 1 });
    expect(await alertDestination(db, OWNER, { projects, endpoints: 3 }, q)).toEqual({ webhookSet: false, projectId: 'mid' });
    expect(q.listEndpointsForOwner.mock.calls.map((c) => c[2])).toEqual(['old', 'mid']);
  });

  it('no webhook and no endpoint: nothing to link, and no endpoint is read', async () => {
    const q = queries({ old: null, mid: null, new: null }, {});
    expect(await alertDestination(db, OWNER, { projects, endpoints: 0 }, q)).toEqual({ webhookSet: false, projectId: null });
    expect(q.listEndpointsForOwner).not.toHaveBeenCalled();
    expect(await alertDestination(db, OWNER, { projects: [], endpoints: 0 }, q)).toEqual({ webhookSet: false, projectId: null });
  });

  it('reads through the owner-scoped queries with the owner id, and returns no URL', async () => {
    const q = queries({ old: WEBHOOK }, {});
    const result = await alertDestination(db, OWNER, { projects: [{ id: 'old' }], endpoints: 0 }, q);
    expect(q.getProjectForOwner).toHaveBeenCalledWith(db, 'old', OWNER);
    expect(JSON.stringify(result)).not.toContain('hooks.slack.com');
    // Another owner's id finds nothing (the query is owner-scoped), so it never counts as set.
    expect(await alertDestination(db, 'someone-else', { projects: [{ id: 'old' }], endpoints: 0 }, q)).toEqual({ webhookSet: false, projectId: null });
  });
});
