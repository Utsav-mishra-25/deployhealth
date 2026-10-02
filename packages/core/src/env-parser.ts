import { readFile } from 'node:fs/promises';

export interface EnvEntry {
  key: string;
  value: string;
  /** 1-based line of the `KEY=` part (the first line, for multi-line values). */
  line: number;
}

export interface EnvParseResult {
  entries: EnvEntry[];
  /**
   * Keys of commented-out assignments (`# KEY=value`, `## export KEY=`), with their lines. A
   * template such as `.env.example` documents optional variables this way.
   */
  commented: Array<{ key: string; line: number }>;
  /** Non-blank, non-comment lines that are not `KEY=value` assignments. */
  invalid: Array<{ line: number; text: string }>;
  /**
   * Where parsing stopped early, if it did: a quote that never closes (`quote`; the rest of the
   * file is that value) or a `-----BEGIN` block with no `-----END` line (`block`; the rest of the
   * file is skipped). Nothing after that line becomes a key.
   */
  unterminated: { line: number; kind: 'quote' | 'block' } | null;
}

// Keys follow dotenv: letters, digits, underscore, dot and dash, not starting with a digit.
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/;
// A commented-out assignment: only env var names, so prose such as `# Note: a=b` isn't one.
const COMMENTED_ASSIGNMENT = /^\s*#+\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const QUOTES = new Set(['"', "'", '`']);
const PEM_BEGIN = '-----BEGIN ';
const PEM_END = '-----END ';

/**
 * Parse dotenv-style source.
 *
 * Supported: `KEY=value`, `export KEY=value`, spaces around `=`, full-line `#` comments,
 * inline ` # comments` after unquoted values, single/double/backtick quoted values, and
 * quoted values spanning multiple lines. Escapes (`\n`, `\t`, `\"`, `\\`) are expanded only
 * inside double quotes. Duplicate keys are all returned; callers decide which one wins.
 *
 * A value is never read as a key:
 * - A quote that never closes makes the rest of the file that value, and parsing stops there
 *   (`unterminated`), so the lines of a pasted key can't become variable names.
 * - An unquoted `-----BEGIN …` (a PEM block, on its own line or as a value) skips every line up
 *   to and including the next `-----END …` line; with none, the rest of the file is skipped.
 *   A key on the BEGIN line keeps that line as its value.
 *
 * Linear in the size of the source.
 */
export function parseEnv(source: string): EnvParseResult {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  const entries: EnvEntry[] = [];
  const commented: EnvParseResult['commented'] = [];
  const invalid: EnvParseResult['invalid'] = [];
  let unterminated: EnvParseResult['unterminated'] = null;

  /** Index of the line that ends a block opened on line `from`, or -1. */
  const blockEnd = (from: number) => {
    for (let k = from + 1; k < lines.length; k++) if ((lines[k] ?? '').trim().startsWith(PEM_END)) return k;
    return -1;
  };

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] ?? '';
    const trimmed = text.trim();
    if (trimmed.startsWith('#')) {
      const key = COMMENTED_ASSIGNMENT.exec(text)?.[1];
      if (key) commented.push({ key, line: i + 1 });
      continue;
    }
    if (trimmed === '') continue;

    if (trimmed.startsWith(PEM_BEGIN)) {
      const end = blockEnd(i);
      if (end === -1) {
        unterminated = { line: i + 1, kind: 'block' };
        break;
      }
      i = end;
      continue;
    }

    const match = ASSIGNMENT.exec(text);
    if (!match) {
      invalid.push({ line: i + 1, text });
      continue;
    }

    const key = match[1] as string;
    const rest = (match[2] ?? '').trimStart();
    const startLine = i + 1;
    const quote = rest[0];

    if (quote !== undefined && QUOTES.has(quote)) {
      const quoted = readQuoted(lines, i, rest, quote);
      entries.push({ key, value: quoted.value, line: startLine });
      if (quoted.endIndex === -1) {
        unterminated = { line: startLine, kind: 'quote' };
        break;
      }
      i = quoted.endIndex;
      continue;
    }

    const value = stripInlineComment(rest).trim();
    entries.push({ key, value, line: startLine });
    if (value.startsWith(PEM_BEGIN)) {
      const end = blockEnd(i);
      if (end === -1) {
        unterminated = { line: startLine, kind: 'block' };
        break;
      }
      i = end;
    }
  }

  return { entries, commented, invalid, unterminated };
}

export async function readEnvFile(path: string): Promise<EnvParseResult> {
  return parseEnv(await readFile(path, 'utf8'));
}

/**
 * Read a quoted value that starts at `rest` on line `startIndex`, possibly continuing onto
 * following lines. Each line is scanned once. When the closing quote never appears, the value
 * is the rest of the file and `endIndex` is -1.
 */
function readQuoted(lines: string[], startIndex: number, rest: string, quote: string): { value: string; endIndex: number } {
  const parts: string[] = [];
  let text = rest.slice(1);
  for (let index = startIndex; ; ) {
    const close = findClosingQuote(text, quote);
    if (close !== -1) {
      parts.push(text.slice(0, close));
      const raw = parts.join('\n');
      return { value: quote === '"' ? unescapeDouble(raw) : raw, endIndex: index };
    }
    parts.push(text);
    index++;
    if (index >= lines.length) {
      const raw = parts.join('\n');
      return { value: quote === '"' ? unescapeDouble(raw) : raw, endIndex: -1 };
    }
    text = lines[index] ?? '';
  }
}

/** The closing quote's index in one line, or -1. A backslash escapes the next character (at the end of a line, the line break). */
function findClosingQuote(text: string, quote: string): number {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++; // skip the escaped character
      continue;
    }
    if (ch === quote) return i;
  }
  return -1;
}

function unescapeDouble(raw: string): string {
  return raw.replace(/\\([nrt"\\])/g, (_, ch: string) => {
    switch (ch) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      default:
        return ch;
    }
  });
}

/** `#` starts a comment only at the beginning or after whitespace, so `URL=http://x/#a` survives. */
function stripInlineComment(value: string): string {
  const match = /(^|\s)#/.exec(value);
  return match ? value.slice(0, match.index) : value;
}
