import { format } from 'node:util';

// Redaction for everything the servers print or report: log lines (both apps wrap `console` with
// installConsoleRedaction() at startup, so Next's and libraries' own logs pass through it too) and
// error reports (scrubErrorEvent(), Sentry's beforeSend). No database code: imported as
// `@deployhealth/db/redact`, the internal code web and worker already share. Not in core: core is
// the published scanner.
//
// Over-redacting is fine; leaking is not. Every pattern is bounded (no unbounded prefix that can
// backtrack), so a line of any length is redacted in linear time (test/redact.test.ts times it).

export const REDACTED = '[redacted]';

/** Keys whose values are dropped whole, wherever they appear in an object. */
const SECRET_KEY = /secret|token|passw|pwd|key|dsn|credential|cookie|session|auth|signature|webhook|database_url|^url$|^body$|^data$|^headers?$|^query/i;

/** A URL with any scheme: kept as scheme://host only (no userinfo, path, query or fragment). */
const URL_PATTERN = /\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s"'<>`]+/gi;

/** Token shapes, whole: deployhealth ingest tokens, GitHub, Slack, JWTs. */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bdh_[A-Za-z0-9_-]+/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]+/g,
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.?[A-Za-z0-9_-]*/g,
];

/** `Cookie: …`, `Authorization: …` and other credential headers: the rest of the line. */
const HEADER_PATTERN = /\b(cookie|set-cookie|authorization|proxy-authorization|x-hub-signature(?:-256)?|x-api-key)(["']?\s{0,8}[:=]\s{0,8})[^\r\n]*/gi;

/** `Bearer abc…`, `Basic abc…`, `token abc…`. */
const SCHEME_PATTERN = /\b(bearer|basic|token)(\s{1,8})[A-Za-z0-9._~+/=-]{8,}/gi;

/** `some_secret: value`, `"apiKey": "value"`, `password=value`: the value. */
const SECRET_PAIR_PATTERN =
  /\b([A-Za-z0-9_.-]{0,40}(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|private[_-]?key|access[_-]?key|dsn|credential|cookie|session)[A-Za-z0-9_.-]{0,40})(["']?\s{0,8}[:=]\s{0,8}["']?)([^\s"',;&]+)/gi;

/** `NAME=value`, the shape of an env assignment: the value (never env values, anywhere). */
const ENV_ASSIGNMENT_PATTERN = /\b([A-Z][A-Z0-9_]{1,63})=([^\s"'&;,]+)/g;

/** Email addresses. */
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}\b/g;

/** 32+ hex characters (secrets, hashes, full commit SHAs): whole. */
const HEX_PATTERN = /\b[0-9a-f]{32,}\b/gi;

/** 32+ base64/base64url characters that mix upper case, lower case and digits (random keys). */
const BASE64_PATTERN = /[A-Za-z0-9+/_-]{32,}={0,2}/g;

function keepOrigin(match: string): string {
  const scheme = match.slice(0, match.indexOf('://'));
  const rest = match.slice(scheme.length + 3);
  let host = '';
  try {
    host = new URL(match).host;
  } catch {
    // Not a URL the parser accepts: drop all of it after the scheme.
  }
  if (!host) return `${scheme}://${REDACTED}`;
  // Only a host (and maybe a trailing slash) is kept as it was; userinfo, a path or a query is not.
  return rest === host || rest === `${host}/` ? match : `${scheme}://${host}/${REDACTED}`;
}

function looksRandom(run: string): boolean {
  return /[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run);
}

/** The text with anything that could hold a secret or a value replaced by `[redacted]`. */
export function redactText(text: string): string {
  let out = text.replace(URL_PATTERN, keepOrigin);
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
  out = out
    .replace(HEADER_PATTERN, (_m, name: string, sep: string) => `${name}${sep}${REDACTED}`)
    .replace(SCHEME_PATTERN, (_m, scheme: string, space: string) => `${scheme}${space}${REDACTED}`)
    .replace(SECRET_PAIR_PATTERN, (m, name: string, sep: string, value: string) => (value === REDACTED ? m : `${name}${sep}${REDACTED}`))
    .replace(ENV_ASSIGNMENT_PATTERN, (m, name: string, value: string) => (value === REDACTED ? m : `${name}=${REDACTED}`))
    .replace(EMAIL_PATTERN, REDACTED)
    .replace(HEX_PATTERN, REDACTED)
    .replace(BASE64_PATTERN, (run) => (looksRandom(run) ? REDACTED : run));
  return out;
}

const MAX_DEPTH = 8;

/**
 * A deep copy with every string redacted and the values of secret-looking keys (`token`,
 * `headers`, `cookie`, `body`, `query`, …) dropped whole. Cycles and depth past 8 become `[redacted]`.
 */
export function redactValue(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH || seen.has(value)) return REDACTED;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = SECRET_KEY.test(key) ? REDACTED : redactValue(item, depth + 1, seen);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Error reports (Sentry's event shape, typed loosely so this package needs no Sentry dependency)
// ---------------------------------------------------------------------------------------------

/** Contexts kept on an error report: the runtime and OS (no app or request data). */
const KEPT_CONTEXTS = ['runtime', 'os', 'trace'] as const;

type Loose = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One path segment: a long one that isn't a uuid (a share link's token) goes whole. */
function redactSegment(segment: string): string {
  return segment.length >= 24 && !UUID.test(segment) ? REDACTED : redactText(segment);
}

/** A request URL or route as its origin and path, without the query or fragment, each path segment redacted. */
export function redactPath(raw: string): string {
  const noQuery = raw.replace(/[?#].*$/s, '');
  let origin = '';
  let path = noQuery;
  try {
    const url = new URL(noQuery);
    origin = url.origin;
    path = url.pathname;
  } catch {
    // A route ("GET /projects/[projectId]") or a bare path.
  }
  return origin + path.split('/').map(redactSegment).join('/');
}

/**
 * Scrub an error event before it leaves the process: no request body, headers, cookies, query
 * string, user, breadcrumbs (they repeat log lines) or source lines and local variables; the
 * request keeps its method and path, and every message, exception value, tag and extra is
 * redacted. Returns the same event object, changed in place.
 */
export function scrubErrorEvent<T extends object>(event: T): T {
  const e = event as Loose;
  const request = e.request as Loose | undefined;
  if (request) {
    e.request = { method: typeof request.method === 'string' ? request.method : undefined, url: typeof request.url === 'string' ? redactPath(request.url) : undefined };
  }
  delete e.user;
  delete e.breadcrumbs;
  if (typeof e.message === 'string') e.message = redactText(e.message);
  const logentry = e.logentry as Loose | undefined;
  if (logentry) e.logentry = { message: typeof logentry.message === 'string' ? redactText(logentry.message) : undefined };
  if (typeof e.transaction === 'string') e.transaction = redactPath(e.transaction);
  const exception = e.exception as { values?: Loose[] } | undefined;
  for (const value of exception?.values ?? []) {
    if (typeof value.value === 'string') value.value = redactText(value.value);
    const frames = (value.stacktrace as { frames?: Loose[] } | undefined)?.frames ?? [];
    for (const frame of frames) {
      delete frame.vars;
      delete frame.pre_context;
      delete frame.context_line;
      delete frame.post_context;
    }
  }
  if (e.extra !== undefined) e.extra = redactValue(e.extra);
  if (e.tags !== undefined) e.tags = redactValue(e.tags);
  const contexts = e.contexts as Loose | undefined;
  if (contexts) {
    const kept: Loose = {};
    for (const name of KEPT_CONTEXTS) if (contexts[name] !== undefined) kept[name] = redactValue(contexts[name]);
    e.contexts = kept;
  }
  return event;
}

// ---------------------------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------------------------

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
const INSTALLED = Symbol.for('deployhealth.consoleRedaction');

type ConsoleLike = Pick<Console, (typeof CONSOLE_METHODS)[number]>;

/**
 * Route every console method through redactText(): its arguments are formatted as console would
 * (util.format, so errors print their stack), redacted, then printed as one string. Installed once
 * per process at startup (worker index.ts, web instrumentation.ts); calling it again does nothing.
 */
export function installConsoleRedaction(target: ConsoleLike = console): void {
  const marked = target as ConsoleLike & { [INSTALLED]?: true };
  if (marked[INSTALLED]) return;
  for (const method of CONSOLE_METHODS) {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => original(redactText(format(...args)));
  }
  marked[INSTALLED] = true;
}
