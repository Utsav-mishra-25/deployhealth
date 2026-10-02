import { extname } from 'node:path';
import { scanPydanticSettings } from './pydantic';
import type { Reference, Syntax } from './types';

export type Language = 'javascript' | 'python' | 'go' | 'ruby';

export const LANGUAGE_BY_EXTENSION: Readonly<Record<string, Language>> = {
  '.ts': 'javascript',
  '.tsx': 'javascript',
  '.mts': 'javascript',
  '.cts': 'javascript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rb': 'ruby',
};

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
};

export function languageForFile(file: string): Language | undefined {
  return LANGUAGE_BY_EXTENSION[extname(file).toLowerCase()];
}

/**
 * Find env var references in one file's source. `file` is only copied into the results. JS/TS
 * also reads same-line destructuring (`const { <NAME>, <OTHER> = "x" } = process.env`), Python
 * files pydantic-settings fields (pydantic.ts). A line that reads a variable more than
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
  }
  // Loops, not push(...refs): spreading an unbounded array into arguments overflows the stack.
  if (language === 'python') for (const ref of scanPydanticSettings(source, file)) found.push(ref);

  return onePerNameAndLine(found).sort((a, b) => a.line - b.line || a.column - b.column);
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
