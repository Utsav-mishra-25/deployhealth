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
}

// Keys follow dotenv: letters, digits, underscore, dot and dash, not starting with a digit.
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/;
// A commented-out assignment: only env var names, so prose such as `# Note: a=b` isn't one.
const COMMENTED_ASSIGNMENT = /^\s*#+\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const QUOTES = new Set(['"', "'", '`']);

/**
 * Parse dotenv-style source.
 *
 * Supported: `KEY=value`, `export KEY=value`, spaces around `=`, full-line `#` comments,
 * inline ` # comments` after unquoted values, single/double/backtick quoted values, and
 * quoted values spanning multiple lines. Escapes (`\n`, `\t`, `\"`, `\\`) are expanded only
 * inside double quotes. Duplicate keys are all returned; callers decide which one wins.
 */
export function parseEnv(source: string): EnvParseResult {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  const entries: EnvEntry[] = [];
  const commented: EnvParseResult['commented'] = [];
  const invalid: EnvParseResult['invalid'] = [];

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] ?? '';
    const trimmed = text.trim();
    if (trimmed.startsWith('#')) {
      const key = COMMENTED_ASSIGNMENT.exec(text)?.[1];
      if (key) commented.push({ key, line: i + 1 });
      continue;
    }
    if (trimmed === '') continue;

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
      if (quoted) {
        entries.push({ key, value: quoted.value, line: startLine });
        i = quoted.endIndex;
        continue;
      }
      // Unterminated quote: fall through and treat the line as an unquoted value.
    }

    entries.push({ key, value: stripInlineComment(rest).trim(), line: startLine });
  }

  return { entries, commented, invalid };
}

export async function readEnvFile(path: string): Promise<EnvParseResult> {
  return parseEnv(await readFile(path, 'utf8'));
}

/**
 * Read a quoted value that starts at `rest` on line `startIndex`, possibly continuing onto
 * following lines. Returns null when the closing quote never appears.
 */
function readQuoted(
  lines: string[],
  startIndex: number,
  rest: string,
  quote: string,
): { value: string; endIndex: number } | null {
  let buffer = rest.slice(1);
  let index = startIndex;

  for (;;) {
    const close = findClosingQuote(buffer, quote);
    if (close !== -1) {
      const raw = buffer.slice(0, close);
      return { value: quote === '"' ? unescapeDouble(raw) : raw, endIndex: index };
    }
    index++;
    if (index >= lines.length) return null;
    buffer += '\n' + lines[index];
  }
}

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
