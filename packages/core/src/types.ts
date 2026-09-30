/** The access pattern a reference was found with. */
export type Syntax =
  | 'process.env'
  | 'import.meta.env'
  | 'os.environ'
  | 'os.getenv'
  | 'os.Getenv'
  | 'os.LookupEnv'
  | 'ENV';

/** A single use of an env var in code. Paths are POSIX and relative to the scan root; 1-based. */
export interface Reference {
  name: string;
  file: string;
  line: number;
  column: number;
  syntax: Syntax;
  /**
   * The code supplies a default on the same line (`process.env.X ?? 'a'`, `os.getenv("X", "a")`,
   * Ruby's ENV.fetch with a default or a block, …), so a missing definition isn't an error. Only
   * set when true.
   */
  hasDefault?: true;
}

/** The env files read in every scope, in the order handoffs and reports list them. */
export const ENV_FILE_BASENAMES = ['.env.example', '.env', '.env.local'] as const;
export type EnvFileBasename = (typeof ENV_FILE_BASENAMES)[number];

/** How the scanner matches a variable name; the ingest schema enforces the same shape. */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A variable the code references, in the env scope it belongs to, with the scope's env files that
 * define it. Names only, never values. Empty `defined_in` means it is MISSING.
 */
export interface RequiredVariable {
  var_name: string;
  /** Directory that owns the env files, relative to the repo root; '' is the root. */
  scope: string;
  defined_in: EnvFileBasename[];
}

export const FINDING_KINDS = ['missing', 'unused', 'mismatch'] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

/** A full or abbreviated git commit id. */
export const SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

/**
 * One finding, in exactly the shape stored in the `findings` table and sent to the ingest API.
 *
 * - missing:  `file`/`line` = code reference; `env_file` = null
 * - unused:   `file`/`line` = env file line; `env_file` = that env file
 * - mismatch: `file`/`line` = where it IS defined; `env_file` = the env file it is ABSENT from
 */
export interface FindingRow {
  kind: FindingKind;
  var_name: string;
  file: string | null;
  line: number | null;
  env_file: string | null;
}

export interface FindingCounts {
  missing: number;
  unused: number;
  mismatch: number;
}

/** Something that did not stop the scan but is worth showing (e.g. an unparsable env line). */
export interface Warning {
  file: string;
  line?: number;
  message: string;
}
