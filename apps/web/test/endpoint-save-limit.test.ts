import { ENDPOINT_SAVE_WINDOW_MS, ENDPOINT_SAVES_PER_WINDOW } from '@deployhealth/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const session = { user: { id: '0d3e0000-0000-4000-8000-0000000000a1', login: 'saver' } };
const saved: string[] = [];

vi.mock('@/auth', () => ({ requireUser: async () => session.user, auth: async () => ({ user: session.user }) }));
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@deployhealth/db', () => ({
  isDemoUser: async () => false,
  createEndpoint: async (_db: unknown, _owner: string, _project: string, input: { url: string }) => (saved.push(input.url), { endpoint: { id: 'e' }, event: null }),
  updateEndpoint: async (_db: unknown, _owner: string, _id: string, input: { url: string }) => (saved.push(input.url), { endpoint: { id: 'e' }, event: null }),
  deleteEndpoint: async () => {},
}));

const { saveEndpointAction } = await import('@/app/projects/[projectId]/endpoint-actions');

const PROJECT = '0d3e0000-0000-4000-8000-0000000000c1';
const ENDPOINT = '0d3e0000-0000-4000-8000-0000000000e1';

function form(url: string): FormData {
  const f = new FormData();
  f.set('name', 'API');
  f.set('url', url);
  f.set('method', 'GET');
  f.set('expectedStatus', '200');
  f.set('intervalSeconds', '300');
  f.set('enabled', 'on');
  return f;
}

describe('saving endpoints is limited per user', () => {
  beforeEach(() => {
    saved.length = 0;
  });

  it(`is ${ENDPOINT_SAVES_PER_WINDOW} saves per ${ENDPOINT_SAVE_WINDOW_MS / 60_000} minutes`, () => {
    expect(ENDPOINT_SAVES_PER_WINDOW).toBe(30);
    expect(ENDPOINT_SAVE_WINDOW_MS).toBe(10 * 60_000);
  });

  it('refuses the 31st save in the window (create and edit count together) with a clear message, before any lookup', async () => {
    // A literal public IP: assertPublicUrl needs no DNS for it.
    for (let i = 0; i < 30; i++) {
      const state = await saveEndpointAction(PROJECT, i % 2 ? ENDPOINT : null, { status: 'idle' }, form(`https://93.184.215.14/health?n=${i}`));
      expect(state.status, `save ${i + 1}`).toBe('saved');
    }
    expect(saved).toHaveLength(30);

    const refused = await saveEndpointAction(PROJECT, null, { status: 'idle' }, form('https://93.184.215.14/health?n=31'));
    expect(refused).toMatchObject({
      status: 'error',
      message: 'Too many endpoint saves: at most 30 every 10 minutes. Try again in 10 minutes.',
    });
    expect(saved).toHaveLength(30);

    // Another user isn't affected.
    session.user = { id: '0d3e0000-0000-4000-8000-0000000000a2', login: 'other' };
    expect((await saveEndpointAction(PROJECT, null, { status: 'idle' }, form('https://93.184.215.14/health'))).status).toBe('saved');
  });
});
