import { PgBoss } from 'pg-boss';
import { workerEnv } from './env';

/**
 * Phase 1: boot pg-boss (which creates its own `pgboss` schema) and stay up, so the Railway
 * service and the queue are in place. Phase 2 registers the uptime-check and correlation jobs.
 */
async function main(): Promise<void> {
  const boss = new PgBoss(workerEnv().DATABASE_URL);
  boss.on('error', (error) => console.error('[worker] pg-boss error', error));

  await boss.start();
  console.log('[worker] pg-boss started; no jobs registered yet (Phase 2)');

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received, stopping`);
    await boss.stop({ graceful: true });
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error('[worker] failed to start', error);
  process.exit(1);
});
