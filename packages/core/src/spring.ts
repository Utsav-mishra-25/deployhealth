import type { Reference } from './types';

// Spring. Two things read env vars here: `${NAME}` placeholders (in `@Value("…")` annotations and
// in application*/bootstrap* config files), which are references like code, and relaxed binding,
// which maps an env var such as SPRING_DATASOURCE_URL onto the property spring.datasource.url with
// no reference anywhere. Relaxed binding only ever marks names used (never MISSING): see
// `springUsedNames`. Every function here is linear in its input.

/** `application.properties`, `application-prod.yml`, `bootstrap.yaml`, … at any depth. */
export function isSpringConfigName(name: string): boolean {
  return /^(?:application|bootstrap)(?:-[\w.-]+)?\.(?:properties|ya?ml)$/.test(name);
}

/** An env var name as Spring placeholders use one: UPPER_SNAKE. `${server.port}` is a property. */
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const NAME_CHAR = /[\w.\-[\]]/;

export interface Placeholder {
  name: string;
  /** 0-based index of the `$` in the text. */
  index: number;
  /** `${NAME:default}`, or inside another placeholder's default. */
  hasDefault: boolean;
}

/**
 * The env var placeholders in `text`: `${NAME}` is a read, `${NAME:default}` an optional one, and
 * a placeholder inside another's default (`${A:${B}}`) is optional too. Dotted property names
 * are ignored. With `escaped` (Kotlin, where a bare `${…}` is string interpolation) only `\${`
 * counts. One pass with a stack of open placeholders.
 */
export function springPlaceholders(text: string, { escaped = false }: { escaped?: boolean } = {}): Placeholder[] {
  const found: Placeholder[] = [];
  // Each open placeholder: whether it's in its default part.
  const open: boolean[] = [];
  let inDefault = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '$' && text[i + 1] === '{') {
      const start = i;
      let end = i + 2;
      while (end < text.length && NAME_CHAR.test(text[end]!)) end++;
      const name = text.slice(i + 2, end);
      const next = text[end];
      const counts = !escaped || text[i - 1] === '\\';
      if (counts && ENV_NAME.test(name) && (next === '}' || next === ':')) {
        found.push({ name, index: start, hasDefault: next === ':' || inDefault > 0 });
      }
      if (next === ':') {
        open.push(true);
        inDefault++;
        i = end + 1;
      } else if (next === '}') {
        i = end + 1;
      } else {
        open.push(false);
        i = end;
      }
      continue;
    }
    if (ch === '}' && open.length > 0 && open.pop()) inDefault--;
    i++;
  }
  return found;
}

/** One reference per name per line: the first, with a default only if every one has one. */
function addReference(found: Map<string, Reference>, line: number, ref: Omit<Reference, 'line'>): void {
  const key = `${line}\0${ref.name}`;
  const first = found.get(key);
  if (!first) found.set(key, { ...ref, line });
  else if (!ref.hasDefault) delete first.hasDefault;
}

export interface SpringConfig {
  references: Reference[];
  /** Every property key the file sets, as Spring's env form (spring.datasource.url → SPRING_DATASOURCE_URL). */
  keyEnvNames: Set<string>;
}

/**
 * A Spring config file: placeholders in its values (comments skipped) and the env form of every
 * key it sets. Properties keys are `key=value`, `key: value` or `key value`; YAML keys are joined
 * along their indentation (`spring:` / `  datasource:` / `    url:`), skipping block scalars
 * (`key: |`) and list items. Only names and keys are kept, never values.
 */
export function scanSpringConfig(source: string, file: string): SpringConfig {
  const yaml = /\.ya?ml$/.test(file);
  const found = new Map<string, Reference>();
  const keyEnvNames = new Set<string>();
  const lines = source.split(/\r?\n/);
  // YAML: the open keys by indentation, each with its key path's env form (null inside a list
  // item, or past MAX_KEY_PATH, so building a path never copies an unbounded parent).
  const stack: Array<{ indent: number; env: string | null }> = [];
  let blockIndent = -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string;
    const trimmed = line.trimStart();
    if (trimmed.startsWith('#') || (!yaml && trimmed.startsWith('!'))) continue;
    for (const p of springPlaceholders(line)) {
      const ref: Omit<Reference, 'line'> = { name: p.name, file, column: p.index + 1, syntax: '${…}' };
      if (p.hasDefault) ref.hasDefault = true;
      addReference(found, index + 1, ref);
    }
    if (!trimmed) continue;
    const indent = line.length - trimmed.length;
    if (!yaml) {
      const key = /^([^=:\s\\]+)\s*(?:[=:]|\s)/.exec(trimmed)?.[1] ?? (/^[^=:\s\\]+$/.test(trimmed) ? trimmed : undefined);
      if (key && key.length <= MAX_KEY_PATH) keyEnvNames.add(envForm(key));
      continue;
    }
    if (blockIndent >= 0) {
      if (indent > blockIndent) continue;
      blockIndent = -1;
    }
    if (trimmed === '---' || trimmed.startsWith('--- ')) {
      stack.length = 0;
      continue;
    }
    while (stack.length > 0 && stack.at(-1)!.indent >= indent) stack.pop();
    if (trimmed.startsWith('- ') || trimmed === '-') {
      stack.push({ indent, env: null });
      continue;
    }
    const match = /^("[^"]*"|'[^']*'|[^\s:#"'{[][^:#]*?)\s*:(?:\s+(.*))?$/.exec(trimmed);
    if (!match) continue;
    const key = match[1]!.replace(/^["']|["']$/g, '');
    const value = (match[2] ?? '').trim();
    const parent = stack.length === 0 ? '' : stack.at(-1)!.env;
    const env = parent === null ? null : `${parent}${parent ? '_' : ''}${envForm(key)}`;
    stack.push({ indent, env: env !== null && env.length <= MAX_KEY_PATH ? env : null });
    if (stack.at(-1)!.env) keyEnvNames.add(stack.at(-1)!.env!);
    if (/^[|>][-+0-9]*(?:\s+#.*)?$/.test(value)) blockIndent = indent;
  }
  return { references: [...found.values()], keyEnvNames };
}

/** Longer property keys aren't Spring properties anyone binds from the environment. */
const MAX_KEY_PATH = 256;

/**
 * Spring's env form of a property key: `my.some-prop[0].name` → `MY_SOMEPROP_0_NAME` (dashes
 * removed, `.` and `[` to `_`, `]` dropped, uppercase).
 */
export function envForm(key: string): string {
  return key.replace(/-/g, '').replace(/\[/g, '.').replace(/\]/g, '').replace(/\./g, '_').toUpperCase();
}

/** Env var prefixes Spring Boot's own properties bind from (spring.*, server.*, management.*, logging.*). */
export const SPRING_BOOT_PREFIXES: readonly string[] = ['SPRING_', 'SERVER_', 'MANAGEMENT_', 'LOGGING_'];

/** A Java or Kotlin file that uses Spring (an import or a fully qualified `org.springframework`). */
export function usesSpring(source: string): boolean {
  return source.includes('org.springframework');
}

const CONFIG_PROPERTIES = /@ConfigurationProperties\s*\(\s*(?:(?:value|prefix)\s*=\s*)?"([a-z0-9][a-z0-9.\-[\]]*)"/g;

/** `@ConfigurationProperties("app.mail")` / `(prefix = "app.mail")`: the env forms of the prefixes, e.g. `APP_MAIL`. */
export function configurationPropertiesPrefixes(source: string): string[] {
  const prefixes: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (!line.includes('@ConfigurationProperties')) continue;
    CONFIG_PROPERTIES.lastIndex = 0;
    for (let match = CONFIG_PROPERTIES.exec(line); match; match = CONFIG_PROPERTIES.exec(line)) prefixes.push(envForm(match[1]!));
  }
  return prefixes;
}

interface PrefixNode {
  next: Map<string, PrefixNode>;
  end: boolean;
}

/**
 * Relaxed binding, for a Spring scope: which of `declared` count as used because Spring binds
 * them to a property. A name counts when it's the env form of a key in the scope's config
 * (`keyEnvNames`), starts with a Spring Boot prefix (SPRING_, SERVER_, MANAGEMENT_, LOGGING_), or
 * starts with a `@ConfigurationProperties` prefix's env form plus `_`. Prefixes are matched through
 * a character trie, so each name costs its own length whatever the number of prefixes.
 */
export function springUsedNames(declared: Iterable<string>, keyEnvNames: ReadonlySet<string>, propertyPrefixes: Iterable<string>): Set<string> {
  const root: PrefixNode = { next: new Map(), end: false };
  for (const prefix of [...SPRING_BOOT_PREFIXES, ...[...propertyPrefixes].map((p) => `${p}_`)]) {
    let node = root;
    for (const ch of prefix) {
      let child = node.next.get(ch);
      if (!child) node.next.set(ch, (child = { next: new Map(), end: false }));
      node = child;
    }
    node.end = true;
  }
  const used = new Set<string>();
  for (const name of declared) {
    if (keyEnvNames.has(name)) {
      used.add(name);
      continue;
    }
    let node: PrefixNode | undefined = root;
    for (let i = 0; i < name.length && node; i++) {
      node = node.next.get(name[i]!);
      if (node?.end && i < name.length - 1) {
        used.add(name);
        break;
      }
    }
  }
  return used;
}
