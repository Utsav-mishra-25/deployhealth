/** The only module in apps/worker that reads process.env (by name, so the scanner can check it). */
export interface WorkerEnv {
  DATABASE_URL: string;
}

export function workerEnv(): WorkerEnv {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) throw new Error('DATABASE_URL is not set. See apps/worker/.env.example.');
  return { DATABASE_URL };
}
