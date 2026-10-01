// Which file names are env files. Browser-safe (no Node imports): the ingest schema, the handoff
// parser and the UI order env file names with the same rules as the scanner.

/** The env files read before CLI 0.3.0, in the order handoffs and reports list them. */
export const ENV_FILE_BASENAMES = [
  '.env.example',
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
  '.env.production',
  '.env.production.local',
  '.env.test',
  '.env.test.local',
] as const;
export type EnvFileBasename = (typeof ENV_FILE_BASENAMES)[number];

/** Committed templates that declare variables, like `.env.example` (0.3.0+). */
export const DECLARATION_FILE_BASENAMES = [
  '.env.sample',
  '.env.template',
  '.env.dist',
  '.env.defaults',
  'example.env',
  'sample.env',
  'env.example',
] as const;

/** `.env.<name>.example` / `.sample` / `.template` (0.3.0+), e.g. `.env.appStore.example`. One name segment, no dots. */
export const NAMED_DECLARATION_FILE = /^\.env\.[A-Za-z0-9_-]{1,64}\.(?:example|sample|template)$/;

/** Every env file name the scanner reads, and the only strings the ingest contract admits as one. */
export type EnvFileName =
  | EnvFileBasename
  | (typeof DECLARATION_FILE_BASENAMES)[number]
  | `.env.${string}.example`
  | `.env.${string}.sample`
  | `.env.${string}.template`;

/** At most this many env files per scope are reported (the ingest schema's limit; the CLI trims to it). */
export const MAX_ENV_FILES_PER_SCOPE = 64;

const KNOWN: readonly string[] = [...ENV_FILE_BASENAMES, ...DECLARATION_FILE_BASENAMES];
const KNOWN_SET: ReadonlySet<string> = new Set(KNOWN);
const DECLARATION_SET: ReadonlySet<string> = new Set(['.env.example', ...DECLARATION_FILE_BASENAMES]);

/** A base name the scanner reads as an env file. */
export function isEnvFileName(name: string): name is EnvFileName {
  return KNOWN_SET.has(name) || NAMED_DECLARATION_FILE.test(name);
}

/**
 * An env file that declares variables for others to fill in (`.env.example`, `.env.sample`,
 * `.env.appStore.example`, …) rather than holding a machine's values. PR checks count a variable
 * as declared when one of these defines it.
 */
export function isDeclarationFile(name: string): boolean {
  return DECLARATION_SET.has(name) || NAMED_DECLARATION_FILE.test(name);
}

/** Display order: the pre-0.3.0 names as listed, then the other fixed names, then the rest by name. */
export function compareEnvFileNames(a: string, b: string): number {
  const rank = (name: string) => {
    const index = KNOWN.indexOf(name);
    return index === -1 ? KNOWN.length : index;
  };
  return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** Distinct names in display order. */
export function sortEnvFileNames<T extends string>(names: Iterable<T>): T[] {
  return [...new Set(names)].sort(compareEnvFileNames);
}
