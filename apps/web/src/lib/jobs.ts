import { PR_CHECK_QUEUE } from '@deployhealth/core';
import { PgBoss } from 'pg-boss';
import { serverEnv } from '@/env';
import type { PrCheckJob } from './github-webhook';

// Send-only: the worker owns the queues (creates them, runs maintenance and schedules). One
// client per server process, kept on globalThis so dev hot reloads don't leak connections.
const globalForBoss = globalThis as typeof globalThis & { __deployhealthBoss?: Promise<PgBoss> };

function boss(): Promise<PgBoss> {
  globalForBoss.__deployhealthBoss ??= (async () => {
    const client = new PgBoss({ connectionString: serverEnv().DATABASE_URL, supervise: false, schedule: false, migrate: false, createSchema: false });
    client.on('error', (error) => console.error('[pg-boss]', error.message));
    await client.start();
    return client;
  })().catch((error: unknown) => {
    globalForBoss.__deployhealthBoss = undefined;
    throw error;
  });
  return globalForBoss.__deployhealthBoss;
}

/**
 * Queue a pull request check. The queue is `stately` per pull request: while one check runs, at
 * most one more waits, and it reads the pull request's current head when it starts. So a burst of
 * pushes costs two checks, not one per push.
 */
export async function enqueuePrCheck(job: PrCheckJob): Promise<void> {
  const client = await boss();
  await client.send(PR_CHECK_QUEUE, { ...job }, { singletonKey: `${job.installationId}:${job.repoFullName.toLowerCase()}#${job.prNumber}` });
}
