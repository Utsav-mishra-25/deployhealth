/**
 * A small, dependency-free implementation of .gitignore matching.
 *
 * Supported: comments, `\#` / `\!` escapes, trailing-space trimming, `!` negation,
 * directory-only patterns (`dir/`), anchoring (leading or inner `/`), `*`, `?`, `[a-z]` /
 * `[!a-z]` classes and `**` in leading, trailing and inner positions. Rules from deeper
 * .gitignore files take precedence over shallower ones; within a file the last match wins.
 *
 * Not supported: core.excludesFile, .git/info/exclude.
 */

interface Rule {
  /** Directory (relative to the scan root, POSIX, '' for the root) that owns the .gitignore. */
  base: string;
  regex: RegExp;
  negate: boolean;
  dirOnly: boolean;
  /** Original pattern text, kept for debugging. */
  source: string;
}

export class GitignoreMatcher {
  private constructor(private readonly rules: readonly Rule[]) {}

  static empty(): GitignoreMatcher {
    return new GitignoreMatcher([]);
  }

  /** Return a new matcher that also applies the rules of a .gitignore located in `base`. */
  extend(base: string, source: string): GitignoreMatcher {
    const added = parseGitignore(source).map((rule) => ({ ...rule, base }));
    return added.length === 0 ? this : new GitignoreMatcher([...this.rules, ...added]);
  }

  /** `relPath` is POSIX and relative to the scan root. */
  ignores(relPath: string, isDir: boolean): boolean {
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir) continue;
      const local = relativeTo(rule.base, relPath);
      if (local === null) continue;
      if (rule.regex.test(local)) ignored = !rule.negate;
    }
    return ignored;
  }
}

/** Parse .gitignore source into rules (without a base). Exported for tests. */
export function parseGitignore(source: string): Array<Omit<Rule, 'base'>> {
  const rules: Array<Omit<Rule, 'base'>> = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const rule = compilePattern(rawLine);
    if (rule) rules.push(rule);
  }
  return rules;
}

function compilePattern(rawLine: string): Omit<Rule, 'base'> | null {
  let pattern = trimTrailingSpaces(rawLine);
  if (pattern === '' || pattern.startsWith('#')) return null;

  let negate = false;
  if (pattern.startsWith('!')) {
    negate = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith('\\!') || pattern.startsWith('\\#')) {
    pattern = pattern.slice(1);
  }

  let dirOnly = false;
  if (pattern.endsWith('/')) {
    dirOnly = true;
    pattern = pattern.replace(/\/+$/, '');
  }
  if (pattern === '') return null;

  // A slash anywhere except the end anchors the pattern to the .gitignore's directory.
  const anchored = pattern.includes('/');
  pattern = pattern.replace(/^\/+/, '');
  if (!anchored && !pattern.startsWith('**/')) pattern = `**/${pattern}`;

  return { regex: new RegExp(`^${globToRegexSource(pattern)}$`), negate, dirOnly, source: rawLine };
}

/** Remove trailing spaces unless the last one is escaped with a backslash. */
function trimTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === ' ' && line[end - 2] !== '\\') end--;
  return line.slice(0, end);
}

function globToRegexSource(glob: string): string {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i] as string;

    if (ch === '*') {
      if (glob[i + 1] === '*') {
        const atStart = i === 0;
        const prevSlash = atStart || glob[i - 1] === '/';
        const nextSlash = glob[i + 2] === '/';
        const atEnd = i + 2 === glob.length;
        if (prevSlash && nextSlash) {
          // `**/` — zero or more directories.
          out += '(?:.*/)?';
          i += 3;
          continue;
        }
        if (prevSlash && atEnd && !atStart) {
          // trailing `/**` — everything inside (the preceding `/` is already emitted).
          out += '.*';
          i += 2;
          continue;
        }
        // Any other `**` behaves like `*`.
        out += '[^/]*';
        i += 2;
        continue;
      }
      out += '[^/]*';
      i++;
      continue;
    }

    if (ch === '?') {
      out += '[^/]';
      i++;
      continue;
    }

    if (ch === '[') {
      const close = glob.indexOf(']', i + 2);
      if (close !== -1) {
        let body = glob.slice(i + 1, close);
        if (body.startsWith('!')) body = `^${body.slice(1)}`;
        out += `[${body.replace(/\\/g, '\\\\')}]`;
        i = close + 1;
        continue;
      }
    }

    if (ch === '\\' && i + 1 < glob.length) {
      out += escapeRegex(glob[i + 1] as string);
      i += 2;
      continue;
    }

    out += escapeRegex(ch);
    i++;
  }
  return out;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function relativeTo(base: string, path: string): string | null {
  if (base === '') return path;
  if (path.startsWith(`${base}/`)) return path.slice(base.length + 1);
  return null;
}
