/** The only module in apps/worker that reads process.env (by name, so the scanner can check it). */
export interface WorkerEnv {
  DATABASE_URL: string;
  /** '1' runs the reseed-demo job (nightly and on start), keeping the public demo in seed state. */
  DEMO_PUBLIC: '0' | '1';
  /** The web app's public URL; the demo's failing endpoint is <DEMO_BASE_URL>/api/demo/broken. */
  DEMO_BASE_URL: string | null;
}

export function workerEnv(): WorkerEnv {
  return parseWorkerEnv({
    DATABASE_URL: process.env.DATABASE_URL,
    DEMO_PUBLIC: process.env.DEMO_PUBLIC,
    DEMO_BASE_URL: process.env.DEMO_BASE_URL,
  });
}

/** Validation, separate from process.env so it can be tested. */
export function parseWorkerEnv(raw: Record<keyof WorkerEnv, string | undefined>): WorkerEnv {
  if (!raw.DATABASE_URL) throw new Error('DATABASE_URL is not set. See apps/worker/.env.example.');
  const demoPublic = raw.DEMO_PUBLIC || '0';
  if (demoPublic !== '0' && demoPublic !== '1') throw new Error(`DEMO_PUBLIC must be 0 or 1, got "${demoPublic}".`);
  const baseUrl = raw.DEMO_BASE_URL || null;
  if (demoPublic === '1') {
    if (!baseUrl) throw new Error('DEMO_PUBLIC=1 needs DEMO_BASE_URL, the web app\'s public URL (e.g. https://web-production-1234.up.railway.app).');
    let protocol: string;
    try {
      protocol = new URL(baseUrl).protocol;
    } catch {
      throw new Error(`DEMO_BASE_URL is not a URL: "${baseUrl}".`);
    }
    if (protocol !== 'http:' && protocol !== 'https:') throw new Error(`DEMO_BASE_URL must be http(s), got "${baseUrl}".`);
  }
  return { DATABASE_URL: raw.DATABASE_URL, DEMO_PUBLIC: demoPublic, DEMO_BASE_URL: baseUrl };
}
