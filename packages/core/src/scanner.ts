import { extname } from 'node:path';
import type { Reference, Syntax } from './types';

export type Language = 'javascript' | 'python' | 'go' | 'ruby';

export const LANGUAGE_BY_EXTENSION: Readonly<Record<string, Language>> = {
  '.ts': 'javascript',
  '.tsx': 'javascript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rb': 'ruby',
};

export const SCANNED_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(LANGUAGE_BY_EXTENSION));

interface Pattern {
  syntax: Syntax;
  /** Must be global and capture the variable name in a group called `name`. */
  regex: RegExp;
}

// Env var names: a letter or underscore, then letters, digits, underscores.
const NAME = '(?<name>[A-Za-z_][A-Za-z0-9_]*)';
// A quoted name, e.g. "X" or 'X'. `quotes` is a character class body.
const quoted = (quotes: string) => `(?<q>[${quotes}])${NAME}\\k<q>`;

/**
 * One list per language. Each regex runs over a single line, so references split across
 * lines are not detected. Dynamic keys (`process.env[name]`) are intentionally not matched.
 */
const PATTERNS: Readonly<Record<Language, readonly Pattern[]>> = {
  javascript: [
    // process.env.<NAME>, process.env?.<NAME>
    { syntax: 'process.env', regex: new RegExp(`\\bprocess\\.env(?:\\?\\.|\\.)${NAME}\\b`, 'g') },
    // process.env["<NAME>"] with ', " or ` quotes, optionally process.env?.[...]
    {
      syntax: 'process.env',
      regex: new RegExp(`\\bprocess\\.env(?:\\?\\.)?\\[\\s*${quoted('\'"`')}\\s*\\]`, 'g'),
    },
    // import.meta.env.<NAME>, import.meta.env?.<NAME>
    {
      syntax: 'import.meta.env',
      regex: new RegExp(`\\bimport\\.meta\\.env(?:\\?\\.|\\.)${NAME}\\b`, 'g'),
    },
    // import.meta.env["<NAME>"]
    {
      syntax: 'import.meta.env',
      regex: new RegExp(`\\bimport\\.meta\\.env(?:\\?\\.)?\\[\\s*${quoted('\'"`')}\\s*\\]`, 'g'),
    },
  ],
  python: [
    // os.environ["<NAME>"]
    { syntax: 'os.environ', regex: new RegExp(`\\bos\\.environ\\s*\\[\\s*${quoted('\'"')}\\s*\\]`, 'g') },
    // os.environ.get("<NAME>"), os.environ.get("<NAME>", default)
    { syntax: 'os.environ', regex: new RegExp(`\\bos\\.environ\\.get\\s*\\(\\s*${quoted('\'"')}`, 'g') },
    // os.getenv("<NAME>"), os.getenv("<NAME>", default)
    { syntax: 'os.getenv', regex: new RegExp(`\\bos\\.getenv\\s*\\(\\s*${quoted('\'"')}`, 'g') },
  ],
  go: [
    // os.Getenv("<NAME>"), os.Getenv(`<NAME>`)
    { syntax: 'os.Getenv', regex: new RegExp(`\\bos\\.Getenv\\s*\\(\\s*${quoted('"`')}\\s*\\)`, 'g') },
    // os.LookupEnv("<NAME>")
    { syntax: 'os.LookupEnv', regex: new RegExp(`\\bos\\.LookupEnv\\s*\\(\\s*${quoted('"`')}\\s*\\)`, 'g') },
  ],
  ruby: [
    // ENV["<NAME>"], ENV['<NAME>']
    { syntax: 'ENV', regex: new RegExp(`\\bENV\\s*\\[\\s*${quoted('\'"')}\\s*\\]`, 'g') },
    // ENV.fetch("<NAME>"), ENV.fetch("<NAME>", default), ENV.fetch "<NAME>"
    { syntax: 'ENV', regex: new RegExp(`\\bENV\\.fetch(?:\\s*\\(\\s*|\\s+)${quoted('\'"')}`, 'g') },
  ],
};

export function languageForFile(file: string): Language | undefined {
  return LANGUAGE_BY_EXTENSION[extname(file).toLowerCase()];
}

/** Find env var references in one file's source. `file` is only copied into the results. */
export function scanSource(source: string, language: Language, file: string): Reference[] {
  const references: Reference[] = [];
  const lines = source.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string;
    for (const { syntax, regex } of PATTERNS[language]) {
      regex.lastIndex = 0;
      for (let match = regex.exec(line); match; match = regex.exec(line)) {
        const name = match.groups?.name;
        if (name) references.push({ name, file, line: index + 1, column: match.index + 1, syntax });
      }
    }
  }

  return references.sort((a, b) => a.line - b.line || a.column - b.column);
}
