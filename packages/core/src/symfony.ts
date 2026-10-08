import type { Reference } from './types';

// Symfony reads env vars in its config YAML as `%env(NAME)%`, optionally through processors:
// `%env(int:NAME)%`, `%env(json:file:NAME)%`, `%env(default:fallback_param:NAME)%`. Only YAML
// under a `config/` directory is read, where Symfony keeps it.

/** `config/packages/doctrine.yaml`, `app/config/services.yml`: a `.yaml`/`.yml` file under a `config` directory. */
export function isSymfonyConfigPath(relPath: string): boolean {
  return /\.ya?ml$/i.test(relPath) && (relPath.startsWith('config/') || relPath.includes('/config/'));
}

// Processors are `prefix:` segments before the name; `default:<param>:` names a fallback parameter.
// Segments hold no `:` and the name no `:` or `)`, so a failed match backtracks only within one
// segment: linear in the line.
const ENV_PLACEHOLDER = /%env\((?<procs>(?:[\w.-]*:)*)(?<name>[A-Za-z_][A-Za-z0-9_]*)\)%/g;
/** `default:<param>:` with a non-empty parameter: the value falls back to it. `default::NAME` falls back to null, no default. */
const FALLBACK = /(?:^|:)default:[^:]/;

/** Each `%env(…)%` in a Symfony config file, one reference per name per line (with a default only if every one has one). */
export function scanSymfonyConfig(source: string, file: string): Reference[] {
  const found = new Map<string, Reference>();
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string;
    if (line.trimStart().startsWith('#')) continue;
    ENV_PLACEHOLDER.lastIndex = 0;
    for (let match = ENV_PLACEHOLDER.exec(line); match; match = ENV_PLACEHOLDER.exec(line)) {
      const { procs, name } = match.groups as { procs: string; name: string };
      const key = `${index}\0${name}`;
      const hasDefault = FALLBACK.test(procs);
      const first = found.get(key);
      if (first) {
        if (!hasDefault) delete first.hasDefault;
        continue;
      }
      const reference: Reference = { name, file, line: index + 1, column: match.index + 1, syntax: '%env()%' };
      if (hasDefault) reference.hasDefault = true;
      found.set(key, reference);
    }
  }
  return [...found.values()];
}
