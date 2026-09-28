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
}

export const FINDING_KINDS = ['missing', 'unused', 'mismatch'] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

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
