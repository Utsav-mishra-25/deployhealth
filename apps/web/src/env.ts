import { z } from 'zod';

/**
 * The only module in apps/web that reads process.env. Every variable is read by name (no
 * `...process.env` spread) so deployhealth's own scanner can check it against .env.example.
 * Validation runs on first use, not at import time, so `next build` works without secrets.
 */
const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.url(),
    AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters (openssl rand -base64 32)'),
    AUTH_GITHUB_ID: z.string().min(1).optional(),
    AUTH_GITHUB_SECRET: z.string().min(1).optional(),
    /** "1" enables the demo login, but only outside production (see lib/auth-providers.ts). */
    AUTH_DEMO_LOGIN: z.enum(['0', '1']).default('0'),
    /** "1" serves the read-only public demo at /demo (and /api/demo/broken). Default off. */
    DEMO_PUBLIC: z.enum(['0', '1']).default('0'),
    /** Signs report share links. Optional: derived from AUTH_SECRET when unset (lib/share-link.ts). */
    REPORT_SHARE_SECRET: z.string().min(32, 'REPORT_SHARE_SECRET must be at least 32 characters (openssl rand -base64 32)').optional(),
    /** Where to report vulnerabilities, shown on /security and in security.txt. Optional. */
    SECURITY_CONTACT_EMAIL: z.email('SECURITY_CONTACT_EMAIL must be an email address').optional(),
  })
  .refine((env) => env.NODE_ENV !== 'production' || (env.AUTH_GITHUB_ID && env.AUTH_GITHUB_SECRET), {
    message: 'AUTH_GITHUB_ID and AUTH_GITHUB_SECRET are required in production',
  });

export type ServerEnv = z.infer<typeof schema>;

let cached: ServerEnv | undefined;

/** Tests only: forget the validated env so the next serverEnv() re-reads process.env. */
export function resetServerEnvForTests(): void {
  cached = undefined;
}

export function serverEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = schema.safeParse({
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    AUTH_SECRET: process.env.AUTH_SECRET,
    AUTH_GITHUB_ID: process.env.AUTH_GITHUB_ID || undefined,
    AUTH_GITHUB_SECRET: process.env.AUTH_GITHUB_SECRET || undefined,
    AUTH_DEMO_LOGIN: process.env.AUTH_DEMO_LOGIN || undefined,
    DEMO_PUBLIC: process.env.DEMO_PUBLIC || undefined,
    REPORT_SHARE_SECRET: process.env.REPORT_SHARE_SECRET || undefined,
    SECURITY_CONTACT_EMAIL: process.env.SECURITY_CONTACT_EMAIL || undefined,
  });
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.') || 'env'}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment for apps/web:\n${problems}\nSee apps/web/.env.example.`);
  }
  cached = parsed.data;
  return cached;
}
