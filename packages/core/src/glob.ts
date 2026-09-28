/**
 * Globs for variable names (used by --ignore). `*` matches any run of characters, `?`
 * matches exactly one; everything else is literal. Matching is case-sensitive and anchored,
 * so `NODE_*` matches `NODE_ENV` but not `MY_NODE_ENV`.
 */
export function nameGlobToRegExp(pattern: string): RegExp {
  let source = '';
  for (const ch of pattern) {
    if (ch === '*') source += '.*';
    else if (ch === '?') source += '.';
    else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/** Build a predicate that returns true for names matching any of `patterns`. */
export function createNameFilter(patterns: readonly string[]): (name: string) => boolean {
  const regexes = patterns.map(nameGlobToRegExp);
  return (name) => regexes.some((regex) => regex.test(name));
}
