// Docker Compose interpolation. A Compose file reads `${VAR}` from the shell or the `.env` beside
// it, so those names count as used in the file's scope (an entry Compose consumes isn't UNUSED).
// They never make MISSING rows: Compose often gets its values from the shell or CI.

/** `docker-compose.yml`, `docker-compose.prod.yaml`, `compose.yaml`, `compose.override.yml`, … but not `composer.yml`. */
export function isComposeFileName(name: string): boolean {
  return /^(?:docker-)?compose(?:[.-][A-Za-z0-9_.-]+)?\.ya?ml$/.test(name);
}

const INTERPOLATION = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?=[}:?+-])|([A-Za-z_][A-Za-z0-9_]*))/g;

/**
 * The variable names a Compose file interpolates: `${VAR}`, `${VAR:-x}`, `${VAR-x}`, `${VAR:?x}`,
 * `${VAR?x}`, `${VAR:+x}`, `${VAR+x}` and `$VAR`. `$$` is a literal dollar sign, and full-line
 * `#` comments are skipped.
 */
export function composeVariableNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const line of source.split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue;
    // Drop escaped dollars first, so `$$VAR` (a literal "$VAR" for the container's shell) isn't read.
    const text = line.replace(/\$\$/g, '');
    for (const match of text.matchAll(INTERPOLATION)) names.add((match[1] ?? match[2])!);
  }
  return names;
}
