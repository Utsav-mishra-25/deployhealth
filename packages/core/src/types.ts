import type { EnvFileName } from './env-files';

/** The access pattern a reference was found with. */
export type Syntax =
  | 'process.env'
  | 'import.meta.env'
  | 'os.environ'
  | 'os.getenv'
  | 'os.Getenv'
  | 'os.LookupEnv'
  | 'ENV'
  /** A field of a pydantic-settings class (pydantic.ts). */
  | 'BaseSettings';

/** A single use of an env var in code. Paths are POSIX and relative to the scan root; 1-based. */
export interface Reference {
  name: string;
  file: string;
  line: number;
  column: number;
  syntax: Syntax;
  /**
   * The code supplies a default on the same line (`process.env.<NAME> ?? 'a'`, `os.getenv("<NAME>", "a")`,
   * Ruby's ENV.fetch with a default or a block, …), so a missing definition isn't an error. Only
   * set when true.
   */
  hasDefault?: true;
}

/**
 * A scope and the env files it has. A scope with none (in practice the root, holding code outside
 * every other scope) gets no MISSING rows: nothing there declares anything yet, so the UI shows
 * one notice and offers the variable list as a starting `.env.example` instead.
 */
export interface EnvScope {
  scope: string;
  env_files: EnvFileName[];
}

/** How the scanner matches a variable name; the ingest schema enforces the same shape. */
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A variable the code references, in the env scope it belongs to, with the scope's env files that
 * define it. Names only, never values. Empty `defined_in` means it is MISSING, unless it is
 * `optional` or its scope has no env file at all.
 */
export interface RequiredVariable {
  var_name: string;
  /** Directory that owns the env files, relative to the repo root; '' is the root. */
  scope: string;
  defined_in: EnvFileName[];
  /** Every reference in the scope has an inline default, so it needn't be defined. Only set when true. */
  optional?: true;
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
