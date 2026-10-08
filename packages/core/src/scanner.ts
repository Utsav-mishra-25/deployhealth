import { extname } from 'node:path';
import { SUPPORTED_LANGUAGES, type LanguageId } from './languages';
import { scanPydanticSettings } from './pydantic';
import { springPlaceholders } from './spring';
import type { Reference, Syntax } from './types';

export type Language = LanguageId;

/** Built from SUPPORTED_LANGUAGES (languages.ts), the one list every result names languages from. */
export const LANGUAGE_BY_EXTENSION: Readonly<Record<string, Language>> = Object.fromEntries(
  SUPPORTED_LANGUAGES.flatMap((l) => l.extensions.map((ext) => [ext, l.id] as const)),
);

export const SCANNED_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(LANGUAGE_BY_EXTENSION));

interface Pattern {
  syntax: Syntax;
  /** Must be global and capture the variable name in a group called `name`. */
  regex: RegExp;
  /**
   * Tested against the rest of the line after the match: true means the code supplies a default
   * there, so the reference can't be MISSING. Same line only, like the patterns themselves.
   */
  defaultAfter?: RegExp;
}

// Env var names: a letter or underscore, then letters, digits, underscores.
const NAME = '(?<name>[A-Za-z_][A-Za-z0-9_]*)';
// A quoted name, e.g. "X" or 'X'. `quotes` is a character class body.
const quoted = (quotes: string) => `(?<q>[${quotes}])${NAME}\\k<q>`;

// What follows a reference when the code supplies a default on the same line. A "default" of
// undefined/null/None/nil is no default at all (`… || undefined` only normalizes ""), so it doesn't count.
/** JS: `process.env.<NAME> ?? 'a'`, `… || 'a'` (and `??=`, `||=`). */
const JS_DEFAULT = /^\s*(?:\?\?|\|\|)=?\s*(?!(?:undefined|null)\b)\S/;
/** Python, after the quoted name: `os.getenv("<NAME>", "a")`, or `os.getenv("<NAME>") or "a"`. */
const PY_DEFAULT = /^\s*(?:,|\)\s*or\b)\s*(?!None\b)[^\s)]/;
/** Ruby `ENV.fetch`, after the quoted name: `ENV.fetch("<NAME>", "a")`, `ENV.fetch "<NAME>", "a"`, `ENV.fetch("<NAME>") { … }` / `do`. */
const RUBY_FETCH_DEFAULT = /^\s*(?:,\s*(?!nil\b)\S|\)\s*(?:\{|do\b))/;
/** Ruby `ENV["<NAME>"] || "a"`. */
const RUBY_INDEX_DEFAULT = /^\s*\|\|\s*(?!nil\b)\S/;
/**
 * PHP: what may follow a read when the code supplies a default. `null` (any case) is no default,
 * and neither is a PHP 8 `throw` expression: `?: throw new …` means the variable is required.
 */
const PHP_NO_DEFAULT = '(?!(?:null|throw)\\b)';
/** `getenv('<NAME>') ?: 'a'`, after the closing parenthesis. Not `??`: getenv returns false, not null. */
const PHP_GETENV_DEFAULT = new RegExp(`^\\s*\\?:\\s*${PHP_NO_DEFAULT}\\S`, 'i');
/** `$_ENV['<NAME>'] ?? 'a'` or `?: 'a'`, after the closing bracket. */
const PHP_INDEX_DEFAULT = new RegExp(`^\\s*(?:\\?\\?|\\?:)\\s*${PHP_NO_DEFAULT}\\S`, 'i');
/**
 * Laravel `env('<NAME>', 'a')` / `Env::get('<NAME>', 'a')`, or `env('<NAME>') ?? 'a'` / `?: 'a'`
 * (also after a `null` second argument), after the quoted name.
 */
const PHP_ENV_DEFAULT = new RegExp(
  `^\\s*(?:,\\s*${PHP_NO_DEFAULT}[^\\s)]|(?:,\\s*null\\s*)?\\)\\s*(?:\\?\\?|\\?:)\\s*${PHP_NO_DEFAULT}\\S)`,
  'i',
);
/**
 * Java/Kotlin, after `System.getenv("<NAME>")` or a map read: Kotlin's `?: d` (not `null`, and not
 * `throw`, `error(…)`, `TODO(…)`, `requireNotNull`/`checkNotNull`, which mean "required"), or
 * `Optional.ofNullable(…).orElse(d)` / `.orElseGet(…)` closing the read.
 */
const JVM_DEFAULT =
  /^\s*(?:\?:\s*(?!(?:null|throw|error|TODO|requireNotNull|checkNotNull)\b)\S|\)\s*\.orElse(?:Get)?\s*\(\s*(?!null\b)[^\s)])/;
/** `System.getenv().getOrDefault("<NAME>", d)`, after the name: a non-null second argument. */
const JVM_GET_OR_DEFAULT = /^\s*,\s*(?!null\b)[^\s)]/;
// A PHP function call, not a method (`->env(`), a static call (`::env(`), a variable (`$env(`) or
// part of a longer name (`getenv(` isn't `env(`); a leading `\` (the global namespace) is fine.
const PHP_CALL = '(?<![\\w$>:\\\\])\\\\?';

/**
 * One list per language. Each regex runs over a single line, so references split across
 * lines are not detected. Dynamic keys (`process.env[name]`) are intentionally not matched.
 * Go has no inline default form (`os.Getenv` returns ""), so nothing there is optional.
 */
const PATTERNS: Readonly<Record<Language, readonly Pattern[]>> = {
  javascript: [
    // process.env.<NAME>, process.env?.<NAME>
    { syntax: 'process.env', regex: new RegExp(`\\bprocess\\.env(?:\\?\\.|\\.)${NAME}\\b`, 'g'), defaultAfter: JS_DEFAULT },
    // process.env["<NAME>"] with ', " or ` quotes, optionally process.env?.[...]
    {
      syntax: 'process.env',
      regex: new RegExp(`\\bprocess\\.env(?:\\?\\.)?\\[\\s*${quoted('\'"`')}\\s*\\]`, 'g'),
      defaultAfter: JS_DEFAULT,
    },
    // import.meta.env.<NAME>, import.meta.env?.<NAME>
    {
      syntax: 'import.meta.env',
      regex: new RegExp(`\\bimport\\.meta\\.env(?:\\?\\.|\\.)${NAME}\\b`, 'g'),
      defaultAfter: JS_DEFAULT,
    },
    // import.meta.env["<NAME>"]
    {
      syntax: 'import.meta.env',
      regex: new RegExp(`\\bimport\\.meta\\.env(?:\\?\\.)?\\[\\s*${quoted('\'"`')}\\s*\\]`, 'g'),
      defaultAfter: JS_DEFAULT,
    },
  ],
  python: [
    // os.environ["<NAME>"]: raises KeyError when unset, so never a default.
    { syntax: 'os.environ', regex: new RegExp(`\\bos\\.environ\\s*\\[\\s*${quoted('\'"')}\\s*\\]`, 'g') },
    // os.environ.get("<NAME>"), os.environ.get("<NAME>", default)
    { syntax: 'os.environ', regex: new RegExp(`\\bos\\.environ\\.get\\s*\\(\\s*${quoted('\'"')}`, 'g'), defaultAfter: PY_DEFAULT },
    // os.getenv("<NAME>"), os.getenv("<NAME>", default)
    { syntax: 'os.getenv', regex: new RegExp(`\\bos\\.getenv\\s*\\(\\s*${quoted('\'"')}`, 'g'), defaultAfter: PY_DEFAULT },
  ],
  go: [
    // os.Getenv("<NAME>"), os.Getenv(`<NAME>`)
    { syntax: 'os.Getenv', regex: new RegExp(`\\bos\\.Getenv\\s*\\(\\s*${quoted('"`')}\\s*\\)`, 'g') },
    // os.LookupEnv("<NAME>")
    { syntax: 'os.LookupEnv', regex: new RegExp(`\\bos\\.LookupEnv\\s*\\(\\s*${quoted('"`')}\\s*\\)`, 'g') },
  ],
  ruby: [
    // ENV["<NAME>"], ENV['<NAME>']
    { syntax: 'ENV', regex: new RegExp(`\\bENV\\s*\\[\\s*${quoted('\'"')}\\s*\\]`, 'g'), defaultAfter: RUBY_INDEX_DEFAULT },
    // ENV.fetch("<NAME>"), ENV.fetch("<NAME>", default), ENV.fetch "<NAME>"
    { syntax: 'ENV', regex: new RegExp(`\\bENV\\.fetch(?:\\s*\\(\\s*|\\s+)${quoted('\'"')}`, 'g'), defaultAfter: RUBY_FETCH_DEFAULT },
  ],
  php: [
    // getenv('<NAME>'), getenv("<NAME>", true): through the closing parenthesis, since a second
    // argument is getenv's local_only flag, not a default.
    {
      syntax: 'getenv',
      regex: new RegExp(`${PHP_CALL}getenv\\s*\\(\\s*${quoted('\'"')}\\s*(?:,[^,()]*)?\\)`, 'g'),
      defaultAfter: PHP_GETENV_DEFAULT,
    },
    // $_ENV['<NAME>']
    { syntax: '$_ENV', regex: new RegExp(`\\$_ENV\\s*\\[\\s*${quoted('\'"')}\\s*\\]`, 'g'), defaultAfter: PHP_INDEX_DEFAULT },
    // Laravel: env('<NAME>'), env('<NAME>', default)
    { syntax: 'env()', regex: new RegExp(`${PHP_CALL}env\\s*\\(\\s*${quoted('\'"')}`, 'g'), defaultAfter: PHP_ENV_DEFAULT },
    // Laravel: Env::get('<NAME>'), \Illuminate\Support\Env::get('<NAME>', default)
    { syntax: 'Env::get', regex: new RegExp(`\\bEnv::get\\s*\\(\\s*${quoted('\'"')}`, 'g'), defaultAfter: PHP_ENV_DEFAULT },
  ],
  // Java and Kotlin; `@Value("${…}")` placeholders are read separately (springPlaceholders).
  jvm: [
    // System.getenv("<NAME>")
    {
      syntax: 'System.getenv',
      regex: new RegExp(`\\bSystem\\.getenv\\s*\\(\\s*${quoted('"')}\\s*\\)`, 'g'),
      defaultAfter: JVM_DEFAULT,
    },
    // System.getenv().get("<NAME>")
    {
      syntax: 'System.getenv',
      regex: new RegExp(`\\bSystem\\.getenv\\s*\\(\\s*\\)\\s*\\.get\\s*\\(\\s*${quoted('"')}\\s*\\)`, 'g'),
      defaultAfter: JVM_DEFAULT,
    },
    // Kotlin: System.getenv()["<NAME>"]
    {
      syntax: 'System.getenv',
      regex: new RegExp(`\\bSystem\\.getenv\\s*\\(\\s*\\)\\s*\\[\\s*${quoted('"')}\\s*\\]`, 'g'),
      defaultAfter: JVM_DEFAULT,
    },
    // System.getenv().getOrDefault("<NAME>", default)
    {
      syntax: 'System.getenv',
      regex: new RegExp(`\\bSystem\\.getenv\\s*\\(\\s*\\)\\s*\\.getOrDefault\\s*\\(\\s*${quoted('"')}`, 'g'),
      defaultAfter: JVM_GET_OR_DEFAULT,
    },
  ],
};

/**
 * Reads that only mark a name as used (it can't be UNUSED) without making it a reference that
 * can be MISSING: PHP's `$_SERVER['<NAME>']` holds env vars and request data alike (HTTP_HOST,
 * REQUEST_METHOD, …), so a name read there is never reported as missing.
 */
const USED_ONLY: Readonly<Partial<Record<Language, readonly RegExp[]>>> = {
  php: [new RegExp(`\\$_SERVER\\s*\\[\\s*${quoted('\'"')}\\s*\\]`, 'g')],
};

/** Names a file reads in a way that marks them used but is never a reference (USED_ONLY). */
export function usedOnlyNames(source: string, language: Language): Set<string> {
  const names = new Set<string>();
  const patterns = USED_ONLY[language];
  if (!patterns) return names;
  for (const line of source.split(/\r?\n/)) {
    for (const regex of patterns) {
      regex.lastIndex = 0;
      for (let match = regex.exec(line); match; match = regex.exec(line)) names.add(match.groups!.name!);
    }
  }
  return names;
}

export function languageForFile(file: string): Language | undefined {
  return LANGUAGE_BY_EXTENSION[extname(file).toLowerCase()];
}

/**
 * Find env var references in one file's source. `file` is only copied into the results (and,
 * for Java/Kotlin, says whether it's Kotlin). JS/TS also reads same-line destructuring
 * (`const { <NAME>, <OTHER> = "x" } = process.env`), Python files pydantic-settings fields
 * (pydantic.ts), Java/Kotlin `@Value("${<NAME>}")` placeholders. A line that reads a variable more than
 * once (`process.env.<NAME> ? process.env.<NAME> : x`) gives one reference, at the first read; it
 * has a default only if every read on the line has one. A match that is a whole string literal
 * (`'process.env.<NAME>'`, a bundler `define` key or a message) isn't a read.
 */
export function scanSource(source: string, language: Language, file: string): Reference[] {
  const found: Reference[] = [];
  const lines = source.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string;
    for (const { syntax, regex, defaultAfter } of PATTERNS[language]) {
      regex.lastIndex = 0;
      for (let match = regex.exec(line); match; match = regex.exec(line)) {
        const name = match.groups?.name;
        if (!name || isWholeString(line, match.index, match.index + match[0].length)) continue;
        const reference: Reference = { name, file, line: index + 1, column: match.index + 1, syntax };
        if (defaultAfter?.test(line.slice(match.index + match[0].length))) reference.hasDefault = true;
        found.push(reference);
      }
    }
    if (language === 'javascript') for (const ref of destructuredReads(line, index + 1, file)) found.push(ref);
    if (language === 'jvm') for (const ref of valueAnnotationReads(line, index + 1, file)) found.push(ref);
  }
  // Loops, not push(...refs): spreading an unbounded array into arguments overflows the stack.
  if (language === 'python') for (const ref of scanPydanticSettings(source, file)) found.push(ref);

  return onePerNameAndLine(found).sort((a, b) => a.line - b.line || a.column - b.column);
}

/**
 * Spring's `@Value("${<NAME>}")` / `@Value("${<NAME>:default}")` on one line: each env-name
 * placeholder after `@Value(`. In Kotlin only `\${…}` counts (a bare `${…}` is interpolation).
 */
function valueAnnotationReads(line: string, lineNumber: number, file: string): Reference[] {
  const at = line.indexOf('@Value');
  if (at === -1) return [];
  const escaped = /\.kts?$/i.test(file);
  return springPlaceholders(line.slice(at), { escaped }).map((p) => {
    const reference: Reference = { name: p.name, file, line: lineNumber, column: at + p.index + 1, syntax: '@Value' };
    if (p.hasDefault) reference.hasDefault = true;
    return reference;
  });
}

// `const { <NAME>, <OTHER>: alias, <THIRD> = "x" } = process.env` (or `import.meta.env`), on one line. No nested braces,
// so `{ a: { b } }` patterns aren't read; neither is a destructuring split across lines.
const DESTRUCTURING = /\{([^{}]*)\}\s*(?::[^=;{}]+)?=\s*(process\.env|import\.meta\.env)\b(?!\s*\.|\s*\[|\s*\?\.)/g;
const DESTRUCTURED_KEY = /^\s*(?:(['"])([A-Za-z_][A-Za-z0-9_]*)\1|([A-Za-z_][A-Za-z0-9_]*))\s*(?::\s*[A-Za-z_$][\w$]*\s*)?(=\s*(.*))?$/s;
/** A destructuring default of undefined/null is no default, as for `??` and `||`. */
const DESTRUCTURED_DEFAULT = /^(?!(?:undefined|null)\b)\S/;

/** Each key of a same-line `{ … } = process.env` destructuring; a key with `= default` has a default. */
function destructuredReads(line: string, lineNumber: number, file: string): Reference[] {
  const references: Reference[] = [];
  DESTRUCTURING.lastIndex = 0;
  for (let match = DESTRUCTURING.exec(line); match; match = DESTRUCTURING.exec(line)) {
    const syntax: Syntax = match[2] === 'process.env' ? 'process.env' : 'import.meta.env';
    let offset = match.index + 1;
    for (const part of match[1]!.split(',')) {
      const key = DESTRUCTURED_KEY.exec(part);
      const name = key?.[2] ?? key?.[3];
      if (key && name) {
        const reference: Reference = { name, file, line: lineNumber, column: offset + part.indexOf(name) + 1, syntax };
        if (key[4] && DESTRUCTURED_DEFAULT.test(key[5]!.trim())) reference.hasDefault = true;
        references.push(reference);
      }
      offset += part.length + 1;
    }
  }
  return references;
}

const QUOTE_CHARS = new Set(['"', "'", '`']);

/** `line[start, end)` is exactly the content of a quoted string: the same quote right before and right after. */
function isWholeString(line: string, start: number, end: number): boolean {
  const before = line[start - 1];
  return before !== undefined && QUOTE_CHARS.has(before) && line[end] === before;
}

/** One reference per name and line (the leftmost), with a default only if every one of them has one. */
function onePerNameAndLine(references: Reference[]): Reference[] {
  const merged = new Map<string, Reference>();
  for (const ref of references.slice().sort((a, b) => a.line - b.line || a.column - b.column)) {
    const key = `${ref.line}\0${ref.name}`;
    const first = merged.get(key);
    if (!first) merged.set(key, { ...ref });
    else if (!ref.hasDefault) delete first.hasDefault;
  }
  return [...merged.values()];
}
