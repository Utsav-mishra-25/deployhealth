import { beforeEach, describe, expect, it, vi } from 'vitest';

const session = { user: { id: '0d3e0000-0000-4000-8000-0000000000b1', login: 'pauser' } };
const queued: unknown[] = [];
let enqueueFails = false;
let event: object | null = null;

vi.mock('@/auth', () => ({ requireUser: async () => session.user, auth: async () => ({ user: session.user }) }));
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/jobs', () => ({
  enqueueAlertWebhook: async (job: unknown) => {
    if (enqueueFails) throw Object.assign(new Error('connect ECONNREFUSED postgres://u:secret@db/x'), { code: 'ECONNREFUSED' });
    queued.push(job);
  },
}));
vi.mock('@deployhealth/db', () => ({
  isDemoUser: async () => false,
  createEndpoint: async () => ({ id: 'e' }),
  updateEndpoint: async () => ({ endpoint: { id: 'e' }, event }),
  deleteEndpoint: async () => {},
}));

const { saveEndpointAction } = await import('@/app/projects/[projectId]/endpoint-actions');

const PROJECT = '0d3e0000-0000-4000-8000-0000000000c2';
const ENDPOINT = '0d3e0000-0000-4000-8000-0000000000e2';

function form(enabled: boolean): FormData {
  const f = new FormData();
  f.set('name', 'Acme API');
  f.set('url', 'https://93.184.215.14/health');
  f.set('method', 'GET');
  f.set('expectedStatus', '200');
  f.set('intervalSeconds', '60');
  if (enabled) f.set('enabled', 'on');
  return f;
}

const PAUSED = {
  type: 'resolved',
  alertId: 'a',
  projectId: PROJECT,
  projectName: 'Acme Storefront',
  webhookUrl: 'https://hooks.slack.com/services/T000/B000/XXXX',
  message: 'Acme API paused (alert open for 12m)',
};

describe('pausing an endpoint with an open alert', () => {
  beforeEach(() => {
    queued.length = 0;
    enqueueFails = false;
    event = null;
  });

  it("queues the resolved webhook for the worker, without the webhook URL", async () => {
    event = PAUSED;
    expect((await saveEndpointAction(PROJECT, ENDPOINT, { status: 'idle' }, form(false))).status).toBe('saved');
    expect(queued).toEqual([{ projectId: PROJECT, type: 'resolved', message: 'Acme API paused (alert open for 12m)' }]);
    expect(JSON.stringify(queued)).not.toContain('hooks.slack.com');
  });

  it('queues nothing when the save raised no event', async () => {
    expect((await saveEndpointAction(PROJECT, ENDPOINT, { status: 'idle' }, form(false))).status).toBe('saved');
    expect(queued).toEqual([]);
  });

  it('still saves when the queue is unreachable, logging the error name and code only', async () => {
    event = PAUSED;
    enqueueFails = true;
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: string) => void errors.push(line));
    try {
      expect((await saveEndpointAction(PROJECT, ENDPOINT, { status: 'idle' }, form(false))).status).toBe('saved');
    } finally {
      spy.mockRestore();
    }
    expect(errors).toEqual(['[alert] webhook not queued: Error ECONNREFUSED']);
  });
});
