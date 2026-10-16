import { createPrivateKey } from 'node:crypto';
import { parseCommitSha } from '@deployhealth/db/sentry';

/** The only module in apps/worker that reads process.env (by name, so the scanner can check it). */
export interface WorkerEnv {
  DATABASE_URL: string;
  /** 'production' on Railway; Sentry's environment. */
  NODE_ENV: string;
  /** '1' runs the reseed-demo job (nightly and on start), keeping the public demo in seed state. */
  DEMO_PUBLIC: '0' | '1';
  /** The web app's public URL; the demo's failing endpoint is <DEMO_BASE_URL>/api/demo/broken. */
  DEMO_BASE_URL: string | null;
  /** The GitHub App the pull request checks run as; null when not configured (checks are off). */
  GITHUB_APP: { appId: number; privateKey: string } | null;
  /** Sentry's DSN, raw; error reporting is on only when it parses (./sentry.ts). Optional. */
  SENTRY_DSN: string | null;
  /** The commit this build runs, set by Railway; Sentry's release. Null unless a 7–40 character hex SHA. */
  RAILWAY_GIT_COMMIT_SHA: string | null;
  /** A Slack- or Discord-compatible webhook for operator alerts, raw; checked by ./operator.ts. Optional. */
  OPERATOR_WEBHOOK_URL: string | null;
}

type RawWorkerEnv = Partial<
  Record<
    'DATABASE_URL' | 'NODE_ENV' | 'DEMO_PUBLIC' | 'DEMO_BASE_URL' | 'GITHUB_APP_ID' | 'GITHUB_APP_PRIVATE_KEY' | 'SENTRY_DSN' | 'RAILWAY_GIT_COMMIT_SHA' | 'OPERATOR_WEBHOOK_URL',
    string
  >
>;

export function workerEnv(): WorkerEnv {
  return parseWorkerEnv({
    DATABASE_URL: process.env.DATABASE_URL,
    NODE_ENV: process.env.NODE_ENV,
    DEMO_PUBLIC: process.env.DEMO_PUBLIC,
    DEMO_BASE_URL: process.env.DEMO_BASE_URL,
    GITHUB_APP_ID: process.env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
    SENTRY_DSN: process.env.SENTRY_DSN,
    RAILWAY_GIT_COMMIT_SHA: process.env.RAILWAY_GIT_COMMIT_SHA,
    OPERATOR_WEBHOOK_URL: process.env.OPERATOR_WEBHOOK_URL,
  });
}

/** Validation, separate from process.env so it can be tested. Errors never echo secret values. */
export function parseWorkerEnv(raw: RawWorkerEnv): WorkerEnv {
  if (!raw.DATABASE_URL) throw new Error('DATABASE_URL is not set. See apps/worker/.env.example.');
  const demoPublic = raw.DEMO_PUBLIC || '0';
  if (demoPublic !== '0' && demoPublic !== '1') throw new Error(`DEMO_PUBLIC must be 0 or 1, got "${demoPublic}".`);
  const baseUrl = raw.DEMO_BASE_URL || null;
  if (demoPublic === '1') {
    if (!baseUrl) throw new Error('DEMO_PUBLIC=1 needs DEMO_BASE_URL, the web app\'s public URL (e.g. https://deployhealth.dev).');
    let protocol: string;
    try {
      protocol = new URL(baseUrl).protocol;
    } catch {
      throw new Error(`DEMO_BASE_URL is not a URL: "${baseUrl}".`);
    }
    if (protocol !== 'http:' && protocol !== 'https:') throw new Error(`DEMO_BASE_URL must be http(s), got "${baseUrl}".`);
  }
  return {
    DATABASE_URL: raw.DATABASE_URL,
    NODE_ENV: raw.NODE_ENV || 'development',
    DEMO_PUBLIC: demoPublic,
    DEMO_BASE_URL: baseUrl,
    GITHUB_APP: parseGithubApp(raw),
    // Optional and never fatal: a bad value turns its feature off with one error at startup.
    SENTRY_DSN: raw.SENTRY_DSN?.trim() || null,
    RAILWAY_GIT_COMMIT_SHA: parseCommitSha(raw.RAILWAY_GIT_COMMIT_SHA),
    OPERATOR_WEBHOOK_URL: raw.OPERATOR_WEBHOOK_URL?.trim() || null,
  };
}

function parseGithubApp(raw: RawWorkerEnv): WorkerEnv['GITHUB_APP'] {
  const id = raw.GITHUB_APP_ID || undefined;
  const key = raw.GITHUB_APP_PRIVATE_KEY || undefined;
  if (!id && !key) return null;
  if (!id || !key) throw new Error('Set both GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY, or neither (pull request checks off).');
  if (!/^\d+$/.test(id)) throw new Error(`GITHUB_APP_ID must be the App's numeric id, got "${id}".`);
  // The PEM from GitHub, base64-encoded onto one line. A raw PEM (newlines or "\n") works too.
  const pem = key.includes('-----BEGIN') ? key.replace(/\\n/g, '\n') : Buffer.from(key, 'base64').toString('utf8');
  try {
    if (!pem.includes('PRIVATE KEY-----')) throw new Error('not a PEM');
    createPrivateKey(pem);
  } catch {
    throw new Error('GITHUB_APP_PRIVATE_KEY is not a valid private key: base64-encode the .pem file GitHub gave you, on one line.');
  }
  return { appId: Number(id), privateKey: pem };
}
