import type { Reference } from './types';

// pydantic-settings: a class whose bases include BaseSettings reads one env var per annotated
// field (NAME uppercased, after a literal env_prefix). Line-based like the rest of the scanner, on
// Python's logical lines: physical lines joined inside brackets, triple-quoted strings and after a
// backslash, so a multi-line `Field(...)` or class header is read as one line. Not handled
// (documented): settings bases defined in another file, prefixes or aliases held in variables,
// AliasPath, and env_nested_delimiter's nested names.

interface LogicalLine {
  /** 1-based line of the first physical line. */
  line: number;
  indent: number;
  /** Code with comments removed and continuation lines joined by a space; strings kept. */
  code: string;
}

/** Python's logical lines (blank and comment-only lines dropped). */
export function logicalLines(source: string): LogicalLine[] {
  const physical = source.split(/\r?\n/);
  const out: LogicalLine[] = [];
  let current: LogicalLine | null = null;
  let depth = 0;
  let quote: string | null = null;

  for (let i = 0; i < physical.length; i++) {
    const text = physical[i]!;
    if (!current) {
      if (text.trim() === '') continue;
      current = { line: i + 1, indent: text.length - text.trimStart().length, code: '' };
    }
    let code = '';
    for (let j = 0; j < text.length; ) {
      const c = text[j]!;
      if (quote) {
        if (c === '\\') {
          code += text.slice(j, j + 2);
          j += 2;
        } else if (text.startsWith(quote, j)) {
          code += quote;
          j += quote.length;
          quote = null;
        } else {
          code += c;
          j++;
        }
        continue;
      }
      if (c === '#') break;
      if (c === '"' || c === "'") {
        quote = text.startsWith(c.repeat(3), j) ? c.repeat(3) : c;
        code += quote;
        j += quote.length;
        continue;
      }
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
      code += c;
      j++;
    }
    const backslash = !quote && code.trimEnd().endsWith('\\');
    if (backslash) code = code.trimEnd().slice(0, -1);
    if (quote?.length === 1) quote = null; // a one-quote string never spans lines; recover from bad input
    current.code = current.code ? `${current.code} ${code.trim()}` : code.trim();
    if (depth === 0 && !quote && !backslash) {
      if (current.code) out.push(current);
      current = null;
    }
  }
  if (current?.code) out.push(current);
  return out;
}

/** `text` split on `separator` where it isn't inside brackets or a string. */
function splitTopLevel(text: string, separator: ',' | '='): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let j = 0; j < text.length; j++) {
    const c = text[j]!;
    if (quote) {
      if (c === '\\') j++;
      else if (text.startsWith(quote, j)) {
        j += quote.length - 1;
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") quote = text.startsWith(c.repeat(3), j) ? c.repeat(3) : c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === separator && depth === 0) {
      // `==`, `!=`, `<=`, `>=`, `:=` and keyword `=` inside calls are not assignments.
      if (separator === '=' && ('=!<>:'.includes(text[j - 1] ?? '') || text[j + 1] === '=')) continue;
      parts.push(text.slice(start, j));
      start = j + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim());
}

/** The text inside the parentheses that open at `open`, or null if they never close. */
function insideParens(text: string, open: number): string | null {
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    if (text[j] === '(') depth++;
    else if (text[j] === ')' && --depth === 0) return text.slice(open + 1, j);
  }
  return null;
}

interface PyClass {
  name: string;
  bases: string[];
  /** Indexes into the logical lines: the header, and one past the body's last line (any depth). */
  header: number;
  end: number;
  /** The body's lines at the body's own indent (fields, methods, nested class headers). */
  direct: number[];
}

const CLASS_HEADER = /^class\s+([A-Za-z_]\w*)\s*(\(?)/;

/**
 * Every class in a file, with base names reduced to their last dotted part
 * (`pydantic_settings.BaseSettings` → `BaseSettings`). One pass with a stack of open classes, so
 * deeply nested classes cost no more than flat ones.
 */
function classesOf(lines: readonly LogicalLine[]): PyClass[] {
  const classes: PyClass[] = [];
  const open: Array<{ cls: PyClass; indent: number; bodyIndent: number | null }> = [];
  for (let index = 0; index < lines.length; index++) {
    const ll = lines[index]!;
    while (open.length > 0 && ll.indent <= open[open.length - 1]!.indent) open.pop()!.cls.end = index;
    const owner = open[open.length - 1];
    if (owner) {
      owner.bodyIndent ??= ll.indent;
      if (ll.indent === owner.bodyIndent) owner.cls.direct.push(index);
    }
    const header = CLASS_HEADER.exec(ll.code);
    if (!header) continue;
    const args = header[2] ? (insideParens(ll.code, header[0].length - 1) ?? '') : '';
    const bases = splitTopLevel(args, ',')
      .filter((b) => b && !b.includes('='))
      .map((b) => b.replace(/\[.*$/s, '').split('.').pop()!.trim());
    const cls: PyClass = { name: header[1]!, bases, header: index, end: lines.length, direct: [] };
    classes.push(cls);
    open.push({ cls, indent: ll.indent, bodyIndent: null });
  }
  return classes;
}

const FIELD = /^([A-Za-z_]\w*)\s*:(?!=)\s*(.+)$/s;
const FIELD_CALL = /^(?:[A-Za-z_]\w*\.)*Field\s*\(/;
const STRING = /^[rRbBuU]?(['"])([A-Za-z_][A-Za-z0-9_]*)\1$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * References for the fields of the pydantic-settings classes in one Python file. `settingsBases`
 * adds class names known (from elsewhere) to be settings classes; `BaseSettings` always is.
 */
export function scanPydanticSettings(source: string, file: string, settingsBases: ReadonlySet<string> = new Set()): Reference[] {
  if (!source.includes('BaseSettings') && settingsBases.size === 0) return [];
  const lines = logicalLines(source);
  const classes = classesOf(lines);

  // Settings classes: BaseSettings subclasses, then subclasses of those in this file, found
  // breadth-first from a map of each name to the classes that list it as a base (linear in the
  // classes, whatever order they're defined in). For a name defined twice, the first qualifying
  // definition in the file is used.
  const children = new Map<string, PyClass[]>();
  for (const cls of classes) {
    for (const base of cls.bases) {
      const list = children.get(base);
      if (list) list.push(cls);
      else children.set(base, [cls]);
    }
  }
  const qualifying = new Set<PyClass>();
  const queue: string[] = ['BaseSettings', ...settingsBases];
  const queued = new Set(queue);
  for (let q = 0; q < queue.length; q++) {
    for (const cls of children.get(queue[q]!) ?? []) {
      qualifying.add(cls);
      if (!queued.has(cls.name)) {
        queued.add(cls.name);
        queue.push(cls.name);
      }
    }
  }
  const settings = new Map<string, PyClass>();
  for (const cls of classes) if (qualifying.has(cls) && !settings.has(cls.name)) settings.set(cls.name, cls);
  if (settings.size === 0) return [];
  // Field types that are models (nested settings), read as JSON or nested names: not one env var each.
  const models = new Set([...settings.keys(), ...classes.filter((c) => c.bases.includes('BaseModel')).map((c) => c.name)]);

  // For each line, the next line at or after it that sets env_prefix (or case_sensitive=True), so
  // a class finds its own setting in O(1) however large its body.
  const nextLineWith = (pattern: RegExp) => {
    const next = new Int32Array(lines.length + 1).fill(lines.length);
    for (let k = lines.length - 1; k >= 0; k--) next[k] = pattern.test(lines[k]!.code) ? k : next[k + 1]!;
    return next;
  };
  const nextPrefix = nextLineWith(/\benv_prefix\s*=\s*[rRuU]?(['"])([A-Za-z0-9_]*)\1/);
  const nextCaseSensitive = nextLineWith(/\bcase_sensitive\s*=\s*True\b/);
  const ownPrefix = (cls: PyClass): string | null => {
    // model_config = SettingsConfigDict(env_prefix=...), class Config: env_prefix = ..., or a class keyword.
    const k = nextPrefix[cls.header]!;
    return k < cls.end ? /\benv_prefix\s*=\s*[rRuU]?(['"])([A-Za-z0-9_]*)\1/.exec(lines[k]!.code)![2]! : null;
  };

  // A class's prefix is its own, else its first settings base's: memoised and iterative, so a
  // chain of thousands of classes neither recurses nor is walked once per class.
  const prefixes = new Map<PyClass, string>();
  const prefixOf = (cls: PyClass): string => {
    const path: PyClass[] = [];
    const onPath = new Set<PyClass>();
    let found = '';
    for (let current: PyClass | undefined = cls; current; ) {
      const known = prefixes.get(current);
      if (known !== undefined) {
        found = known;
        break;
      }
      path.push(current);
      onPath.add(current);
      const own = ownPrefix(current);
      if (own !== null) {
        found = own;
        break;
      }
      current = current.bases.map((b) => settings.get(b)).find((p) => p && !onPath.has(p));
    }
    for (const c of path) prefixes.set(c, found);
    return found;
  };

  const references: Reference[] = [];
  for (const cls of settings.values()) {
    if (cls.direct.length === 0) continue;
    const prefix = prefixOf(cls);
    const caseSensitive = nextCaseSensitive[cls.header + 1]! < cls.end;
    for (const k of cls.direct) {
      const ll = lines[k]!;
      const field = FIELD.exec(ll.code);
      if (!field) continue;
      const [, name, rest] = field as unknown as [string, string, string];
      if (name.startsWith('_') || name === 'model_config') continue;
      const [annotation = '', defaultExpr] = splitTopLevel(rest, '=');
      if (/^(?:typing\.)?ClassVar\b/.test(annotation)) continue;
      if (isModelType(annotation, models)) continue;

      const { value, aliases } = readDefault(defaultExpr);
      const optionalType = /\bNone\b|\bOptional\s*\[/.test(annotation);
      // A default of None counts only when the type says the setting may be absent.
      const hasDefault = value !== null && (value !== 'None' || optionalType);
      const column = ll.indent + 1;
      if (aliases.length > 0) {
        // Any one of several aliases is enough, so none of them is required on its own.
        const alternatives = aliases.length > 1;
        for (const alias of aliases) {
          const ref: Reference = { name: caseSensitive ? alias : alias.toUpperCase(), file, line: ll.line, column, syntax: 'BaseSettings' };
          if (hasDefault || alternatives) ref.hasDefault = true;
          references.push(ref);
        }
        continue;
      }
      const envName = caseSensitive ? `${prefix}${name}` : `${prefix}${name}`.toUpperCase();
      if (!ENV_NAME.test(envName)) continue;
      const ref: Reference = { name: envName, file, line: ll.line, column, syntax: 'BaseSettings' };
      if (hasDefault) ref.hasDefault = true;
      references.push(ref);
    }
  }
  return references;
}

/** The annotation names a model class from this file (optionally `| None` / `Optional[...]`). */
function isModelType(annotation: string, models: ReadonlySet<string>): boolean {
  const core = annotation
    .replace(/^(?:typing\.)?Optional\s*\[(.*)\]$/s, '$1')
    .split('|')
    .map((part) => part.trim())
    .filter((part) => part !== 'None');
  return core.length === 1 && models.has(core[0]!.replace(/^['"]|['"]$/g, ''));
}

/**
 * A field's default expression (null when it has none) and the env names its aliases give
 * (`alias=`, `validation_alias=`, pydantic v1's `env=`, or each string in `AliasChoices(...)`).
 */
function readDefault(expr: string | undefined): { value: string | null; aliases: string[] } {
  if (expr === undefined || expr === '') return { value: null, aliases: [] };
  const call = FIELD_CALL.exec(expr);
  if (!call) return { value: expr, aliases: [] };
  const args = splitTopLevel(insideParens(expr, call[0].length - 1) ?? '', ',').filter(Boolean);
  let value: string | null = null;
  const aliases: string[] = [];
  for (const [i, arg] of args.entries()) {
    const kw = /^([A-Za-z_]\w*)\s*=(?!=)\s*(.*)$/s.exec(arg);
    if (!kw) {
      if (i === 0 && arg !== '...' && arg !== 'Ellipsis') value = arg;
      continue;
    }
    const [, key, val] = kw as unknown as [string, string, string];
    if (key === 'default') value = val === '...' || val === 'Ellipsis' ? null : val;
    else if (key === 'default_factory') value = 'factory';
    else if (key === 'alias' || key === 'validation_alias' || key === 'env') {
      const literal = STRING.exec(val);
      if (literal) aliases.push(literal[2]!);
      const choices = /^(?:[A-Za-z_]\w*\.)*AliasChoices\s*\(/.exec(val);
      if (choices) {
        for (const choice of splitTopLevel(insideParens(val, choices[0].length - 1) ?? '', ',')) {
          const m = STRING.exec(choice);
          if (m) aliases.push(m[2]!);
        }
      }
    }
  }
  return { value, aliases: [...new Set(aliases)] };
}
