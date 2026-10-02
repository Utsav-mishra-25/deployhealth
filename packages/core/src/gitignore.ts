/**
 * A small, dependency-free implementation of .gitignore matching.
 *
 * Supported: comments, `\#` / `\!` escapes, trailing-space trimming, `!` negation,
 * directory-only patterns (`dir/`), anchoring (leading or inner `/`), `*`, `?`, bracket classes
 * (`[a-z]`, `[!a-z]` / `[^a-z]`, `]` first is literal, `\` escapes, `[:alpha:]`-style names) and
 * `**` in leading, trailing and inner positions. Rules from deeper .gitignore files take
 * precedence over shallower ones; within a file the last match wins.
 *
 * Matching runs in time linear in the path for each pattern: a pattern is compiled into a small
 * state machine (never a RegExp built from its text) and simulated over a set of states, so no
 * pattern can make it backtrack. Like git, `*`, `?` and classes never match `/`, and a pattern
 * with an invalid class (unclosed, or an unknown `[:name:]`) never matches anything.
 *
 * Not supported: core.excludesFile, .git/info/exclude.
 */

/** Longer lines are dropped: no real pattern needs them. */
export const MAX_GITIGNORE_PATTERN_LENGTH = 1_024;
/** Only the first this many rules of one .gitignore file are kept. */
export const MAX_GITIGNORE_RULES_PER_FILE = 1_000;

interface Rule {
  /** Directory (relative to the scan root, POSIX, '' for the root) that owns the .gitignore. */
  base: string;
  /** null: the pattern is invalid and never matches. */
  glob: CompiledGlob | null;
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
      if (ignored !== rule.negate) continue; // the rule can't change the answer
      const local = relativeTo(rule.base, relPath);
      if (local === null || !rule.glob) continue;
      if (matchGlob(rule.glob, local)) ignored = !rule.negate;
    }
    return ignored;
  }
}

/** Parse .gitignore source into rules (without a base). Exported for tests. */
export function parseGitignore(source: string): Array<Omit<Rule, 'base'>> {
  const rules: Array<Omit<Rule, 'base'>> = [];
  for (const rawLine of source.split(/\r?\n/)) {
    if (rules.length >= MAX_GITIGNORE_RULES_PER_FILE) break;
    if (rawLine.length > MAX_GITIGNORE_PATTERN_LENGTH) continue;
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

  return { glob: compileGlob(pattern), negate, dirOnly, source: rawLine };
}

/** Remove trailing spaces unless the last one is escaped with a backslash. */
function trimTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === ' ' && line[end - 2] !== '\\') end--;
  return line.slice(0, end);
}

// ---------------------------------------------------------------------------------------------
// Glob → state machine
// ---------------------------------------------------------------------------------------------

type CharTest = (ch: string) => boolean;

type Token =
  | { kind: 'literal'; ch: string }
  /** One character other than `/` that passes `test` (`?` and classes). */
  | { kind: 'one'; test: CharTest }
  /** `*`: any run of characters other than `/`. */
  | { kind: 'star' }
  // A leading or inner double star followed by a slash: zero or more whole directories.
  | { kind: 'dirs' }
  /** A trailing `/**`'s `**`: anything at all. */
  | { kind: 'rest' };

/** A state: consume one character that passes `test` and go to `next`, or (split) go to both `a` and `b` without consuming. */
type State = { test: CharTest; next: number } | { a: number; b: number } | 'accept';

interface CompiledGlob {
  states: State[];
  start: number;
  /** Literal text every match starts / ends with: a cheap filter before the simulation. */
  prefix: string;
  suffix: string;
}

const notSlash: CharTest = (ch) => ch !== '/';
const anyChar: CharTest = () => true;
const isSlash: CharTest = (ch) => ch === '/';

/** Compile a glob, or null when it holds an invalid bracket class (git: never matches). */
export function compileGlob(glob: string): CompiledGlob | null {
  const tokens = tokenize(glob);
  if (!tokens) return null;

  // Built back to front, so each token knows the state that follows it.
  const states: State[] = ['accept'];
  let next = 0;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i]!;
    const at = states.length;
    switch (token.kind) {
      case 'literal': {
        const ch = token.ch;
        states.push({ test: (c) => c === ch, next });
        break;
      }
      case 'one':
        states.push({ test: token.test, next });
        break;
      case 'star':
      case 'rest':
        // at: split(loop, next); at+1: consume one, back to at.
        states.push({ a: at + 1, b: next }, { test: token.kind === 'star' ? notSlash : anyChar, next: at });
        break;
      case 'dirs':
        // (?:.*/)? — at: split(inside, next); at+1: split(any, slash); at+2: any → at+1; at+3: '/' → next.
        states.push({ a: at + 1, b: next }, { a: at + 2, b: at + 3 }, { test: anyChar, next: at + 1 }, { test: isSlash, next });
        break;
    }
    next = at;
  }

  let prefix = '';
  for (const t of tokens) {
    if (t.kind !== 'literal') break;
    prefix += t.ch;
  }
  let suffix = '';
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]!;
    if (t.kind !== 'literal') break;
    suffix = t.ch + suffix;
  }
  return { states, start: next, prefix, suffix };
}

/** Whether `text` matches the whole glob. O(text × states), no backtracking. */
export function matchGlob(glob: CompiledGlob, text: string): boolean {
  if (!text.startsWith(glob.prefix) || !text.endsWith(glob.suffix)) return false;
  const { states } = glob;
  const seen = new Int32Array(states.length).fill(-1);
  let current: number[] = [];
  let generation = 0;

  // Add `from` and everything reachable from it without consuming a character.
  const add = (list: number[], from: number) => {
    const stack = [from];
    while (stack.length > 0) {
      const s = stack.pop()!;
      if (seen[s] === generation) continue;
      seen[s] = generation;
      const state = states[s]!;
      if (typeof state === 'object' && 'a' in state) stack.push(state.b, state.a);
      else list.push(s);
    }
  };

  add(current, glob.start);
  for (let i = 0; i < text.length && current.length > 0; i++) {
    const ch = text[i]!;
    generation++;
    const following: number[] = [];
    for (const s of current) {
      const state = states[s]!;
      if (typeof state === 'object' && 'test' in state && state.test(ch)) add(following, state.next);
    }
    current = following;
  }
  return current.some((s) => states[s] === 'accept');
}

function tokenize(glob: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;

    if (ch === '*') {
      if (glob[i + 1] === '*') {
        const atStart = i === 0;
        const prevSlash = atStart || glob[i - 1] === '/';
        const nextSlash = glob[i + 2] === '/';
        const atEnd = i + 2 === glob.length;
        if (prevSlash && nextSlash) {
          // `**/` — zero or more directories.
          tokens.push({ kind: 'dirs' });
          i += 3;
          continue;
        }
        if (prevSlash && atEnd && !atStart) {
          // trailing `/**` — everything inside (the preceding `/` is already a token).
          tokens.push({ kind: 'rest' });
          i += 2;
          continue;
        }
        // Any other `**` behaves like `*`.
        tokens.push({ kind: 'star' });
        i += 2;
        continue;
      }
      tokens.push({ kind: 'star' });
      i++;
      continue;
    }

    if (ch === '?') {
      tokens.push({ kind: 'one', test: notSlash });
      i++;
      continue;
    }

    if (ch === '[') {
      const parsed = parseClass(glob, i);
      if (!parsed) return null;
      tokens.push({ kind: 'one', test: parsed.test });
      i = parsed.end;
      continue;
    }

    if (ch === '\\' && i + 1 < glob.length) {
      tokens.push({ kind: 'literal', ch: glob[i + 1]! });
      i += 2;
      continue;
    }

    tokens.push({ kind: 'literal', ch });
    i++;
  }
  return tokens;
}

const POSIX_CLASSES: Readonly<Record<string, CharTest>> = {
  alnum: (c) => /[A-Za-z0-9]/.test(c),
  alpha: (c) => /[A-Za-z]/.test(c),
  blank: (c) => c === ' ' || c === '\t',
  cntrl: (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
  digit: (c) => c >= '0' && c <= '9',
  graph: (c) => c.charCodeAt(0) > 32 && c.charCodeAt(0) < 127,
  lower: (c) => c >= 'a' && c <= 'z',
  print: (c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127,
  punct: (c) => /[!-/:-@[-`{-~]/.test(c),
  space: (c) => /[ \t\n\r\f\v]/.test(c),
  upper: (c) => c >= 'A' && c <= 'Z',
  xdigit: (c) => /[0-9A-Fa-f]/.test(c),
};

/**
 * A bracket class starting at `glob[open] === '['`, as git's wildmatch reads it: `!` or `^` first
 * negates, `]` first is a literal, `\` escapes the next character, `a-z` is a range (`z-a`
 * matches nothing), `[:name:]` is a POSIX class. Never matches `/`. Null when invalid.
 */
function parseClass(glob: string, open: number): { test: CharTest; end: number } | null {
  let j = open + 1;
  const negated = glob[j] === '!' || glob[j] === '^';
  if (negated) j++;
  const parts: CharTest[] = [];
  for (let first = true; ; first = false) {
    if (j >= glob.length) return null; // never closed
    let ch = glob[j]!;
    if (ch === ']' && !first) break;
    if (ch === '[' && glob[j + 1] === ':') {
      const close = glob.indexOf(':]', j + 2);
      if (close !== -1) {
        const named = POSIX_CLASSES[glob.slice(j + 2, close)];
        if (!named) return null;
        parts.push(named);
        j = close + 2;
        continue;
      }
    }
    if (ch === '\\') {
      j++;
      if (j >= glob.length) return null;
      ch = glob[j]!;
    }
    if (glob[j + 1] === '-' && j + 2 < glob.length && glob[j + 2] !== ']') {
      let k = j + 2;
      if (glob[k] === '\\') k++;
      if (k >= glob.length) return null;
      const [lo, hi] = [ch, glob[k]!];
      parts.push((c) => c >= lo && c <= hi);
      j = k + 1;
      continue;
    }
    const literal = ch;
    parts.push((c) => c === literal);
    j++;
  }
  const test: CharTest = (c) => c !== '/' && parts.some((part) => part(c)) !== negated;
  return { test, end: j + 1 };
}

function relativeTo(base: string, path: string): string | null {
  if (base === '') return path;
  if (path.startsWith(`${base}/`)) return path.slice(base.length + 1);
  return null;
}
