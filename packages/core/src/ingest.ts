import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { FINDING_KINDS, SHA_PATTERN, type FindingCounts } from './types';

/** Upper bound on findings per scan; protects the ingest endpoint from runaway payloads. */
export const MAX_FINDINGS = 10_000;

export const findingRowSchema = z.object({
  kind: z.enum(FINDING_KINDS),
  var_name: z.string().min(1).max(200),
  file: z.string().min(1).max(1000).nullable(),
  line: z.number().int().positive().nullable(),
  env_file: z.string().min(1).max(1000).nullable(),
});

/** Body of `POST /api/ingest/scan`. Shared by the CLI (sender) and the web app (receiver). */
export const ingestPayloadSchema = z.object({
  sha: z.string().regex(SHA_PATTERN, 'sha must be a hex commit id'),
  branch: z.string().min(1).max(255),
  timestamp: z.iso.datetime({ offset: true }),
  findings: z.array(findingRowSchema).max(MAX_FINDINGS),
});

export type IngestPayload = z.infer<typeof ingestPayloadSchema>;

export interface IngestResponse {
  deployId: string;
  scanId: string;
  counts: FindingCounts;
}

export const TOKEN_PREFIX = 'dh_';

/** A new ingest token: `dh_` + 32 random bytes (base64url). Shown to the user once. */
export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

/** What the database stores. Tokens are high-entropy, so a plain SHA-256 is enough. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Non-secret reminder of which token is active, e.g. `dh_…x9Qz`. */
export function tokenHint(token: string): string {
  return `${TOKEN_PREFIX}…${token.slice(-4)}`;
}

/** Extract a deployhealth token from an `Authorization: Bearer …` header, or null. */
export function parseBearer(header: string | null | undefined): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  const token = match?.[1];
  return token?.startsWith(TOKEN_PREFIX) ? token : null;
}

/** Name of the repository secret the snippet expects. */
export const TOKEN_SECRET_NAME = 'DEPLOYHEALTH_TOKEN';

/** Path (on the web app) of the single-file CLI bundle the snippet downloads. */
export const CLI_BUNDLE_PATH = '/deployhealth-scan.mjs';

/**
 * Copy-pasteable GitHub Actions workflow that scans the repo on every push to `branch` and
 * reports to the deployhealth instance at `appUrl`.
 */
export function githubActionSnippet({ appUrl, branch = 'main' }: { appUrl: string; branch?: string }): string {
  const url = appUrl.replace(/\/+$/, '');
  return `# .github/workflows/deployhealth.yml
name: deployhealth

on:
  push:
    branches: [${branch}]

jobs:
  env-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 22
      - name: Scan env vars and report to deployhealth
        env:
          ${TOKEN_SECRET_NAME}: \${{ secrets.${TOKEN_SECRET_NAME} }}
        run: |
          curl -fsSL ${url}${CLI_BUNDLE_PATH} -o "$RUNNER_TEMP/deployhealth-scan.mjs"
          node "$RUNNER_TEMP/deployhealth-scan.mjs" \\
            --url ${url} \\
            --token "$${TOKEN_SECRET_NAME}" \\
            --sha "\${{ github.sha }}" \\
            --branch "\${{ github.ref_name }}"
`;
}
