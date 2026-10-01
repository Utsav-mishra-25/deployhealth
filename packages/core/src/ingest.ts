import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { CLI_NPM_PACKAGE, PUBLISHED_CLI_VERSION, TOKEN_PREFIX, TOKEN_SECRET_NAME } from './constants';
import { isEnvFileName, MAX_ENV_FILES_PER_SCOPE, type EnvFileName } from './env-files';
import { ENV_NAME_PATTERN, FINDING_KINDS, SHA_PATTERN, type FindingCounts } from './types';

/** Upper bound on findings per scan; protects the ingest endpoint from runaway payloads. */
export const MAX_FINDINGS = 10_000;
/** Upper bound on referenced variables per scan. */
export const MAX_VARIABLES = 10_000;
/** Upper bound on env scopes per scan. */
export const MAX_ENV_SCOPES = 1_000;

export const findingRowSchema = z.object({
  kind: z.enum(FINDING_KINDS),
  var_name: z.string().min(1).max(200),
  file: z.string().min(1).max(1000).nullable(),
  line: z.number().int().positive().nullable(),
  env_file: z.string().min(1).max(1000).nullable(),
});

/**
 * An env file's base name: only the names the scanner reads (`isEnvFileName`: the fixed names,
 * plus `.env.<name>.example` / `.sample` / `.template` from 0.3.0), never an arbitrary string.
 */
export const envFileNameSchema = z.custom<EnvFileName>(
  (value) => typeof value === 'string' && value.length <= 80 && isEnvFileName(value),
  'must be an env file name',
);

/**
 * A referenced variable. The shape only admits names: `var_name` must look like an env var name
 * and `defined_in` can only list env file names, so no value can ride along. `optional`
 * (0.2.0+): every reference has an inline default.
 */
export const requiredVariableSchema = z.object({
  var_name: z.string().max(200).regex(ENV_NAME_PATTERN, 'var_name must be an env var name'),
  scope: z.string().max(1000),
  defined_in: z.array(envFileNameSchema).max(MAX_ENV_FILES_PER_SCOPE),
  optional: z.boolean().optional(),
});

/** A scope and the env files it has (0.2.0+). One with none gets a notice instead of MISSING rows. */
export const envScopeSchema = z.object({
  scope: z.string().max(1000),
  env_files: z.array(envFileNameSchema).max(MAX_ENV_FILES_PER_SCOPE),
});

/** Body of `POST /api/ingest/scan`. Shared by the CLI (sender) and the web app (receiver). */
export const ingestPayloadSchema = z.object({
  sha: z.string().regex(SHA_PATTERN, 'sha must be a hex commit id'),
  branch: z.string().min(1).max(255),
  timestamp: z.iso.datetime({ offset: true }),
  findings: z.array(findingRowSchema).max(MAX_FINDINGS),
  /** Every referenced variable (handoff exports list them). Optional: older CLIs don't send it. */
  variables: z.array(requiredVariableSchema).max(MAX_VARIABLES).optional(),
  /** Every scope with its env files. Optional: CLIs before 0.2.0 don't send it. */
  env_scopes: z.array(envScopeSchema).max(MAX_ENV_SCOPES).optional(),
});

export type IngestPayload = z.infer<typeof ingestPayloadSchema>;

export interface IngestResponse {
  deployId: string;
  scanId: string;
  counts: FindingCounts;
}

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

/** The pinned CLI invocation, e.g. `npx --yes deployhealth-scan@0.2.0`. */
export const cliNpx = (version: string = PUBLISHED_CLI_VERSION) => `npx --yes ${CLI_NPM_PACKAGE}@${version}`;
export const CLI_NPX = cliNpx();

/**
 * Copy-pasteable GitHub Actions workflow that scans the repo on every push to `branch` and
 * reports to the deployhealth instance at `appUrl`. It runs the pinned npm release with a
 * read-only token, and passes sha and branch through the runner's env (no `${{ }}` in the script).
 * `version` defaults to the published CLI; the npm README pins the version it ships with.
 */
export function githubActionSnippet({ appUrl, branch = 'main', version }: { appUrl: string; branch?: string; version?: string }): string {
  const url = appUrl.replace(/\/+$/, '');
  return `# .github/workflows/deployhealth.yml
name: deployhealth

# Must not run on pull_request events from forks: the job reads a repository secret.
on:
  push:
    branches: [${branch}]

jobs:
  env-scan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v5
        with:
          persist-credentials: false
      - uses: actions/setup-node@v5
        with:
          node-version: 22
          package-manager-cache: false
      - name: Scan env vars and report to deployhealth
        env:
          ${TOKEN_SECRET_NAME}: \${{ secrets.${TOKEN_SECRET_NAME} }}
        run: |
          ${cliNpx(version)} \\
            --url ${url} \\
            --token "$${TOKEN_SECRET_NAME}" \\
            --sha "$GITHUB_SHA" \\
            --branch "$GITHUB_REF_NAME"
`;
}
