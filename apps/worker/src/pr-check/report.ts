import { plural, PR_CHECK_TIME_LIMIT_MS } from '@deployhealth/core';
import type { PrCheck, PrCheckMode, PrEnvFile } from '@deployhealth/db';
import type { CheckRunOutput } from '../github/api';
import type { EnvVarDiff } from './diff';
import { secretRuleLabel, type SecretHit } from './secrets';

/** Hidden in every comment, so the App finds its own comment again. */
export const COMMENT_MARKER = '<!-- deployhealth-env-check -->';
export const COMMENT_TITLE = 'deployhealth · env check';
/** Rows per table in the comment. */
const MAX_ROWS = 50;
/**
 * GitHub refuses a comment body, or a check run's summary or text, over 65,535 characters; ours
 * stop at this many (whole lines, then "…and N more"), leaving room to spare.
 */
export const MAX_GITHUB_TEXT = 60_000;
/** A check run's title. */
export const MAX_TITLE = 255;
/** Names listed in the check run's text, and inline in its summary. */
const MAX_LISTED = 1_000;
const MAX_INLINE = 20;
/** Longer paths and names keep their start and end around an ellipsis. */
export const MAX_PATH_CHARS = 160;
export const MAX_NAME_CHARS = 100;

export interface PrReport extends EnvVarDiff {
  envFiles: PrEnvFile[];
  secrets: SecretHit[];
  /** Set when a hard cap stopped the check; the rest of the report is then empty. */
  tooLarge: string | null;
}

export const emptyReport = (tooLarge: string | null = null): PrReport => ({
  added: [],
  removed: [],
  renamed: [],
  undeclared: [],
  envFiles: [],
  secrets: [],
  tooLarge,
});

const hasFindings = (r: PrReport) => r.undeclared.length > 0 || r.envFiles.length > 0 || r.secrets.length > 0;

/**
 * success: nothing undeclared, no env files, no secrets. Otherwise neutral in comment mode and
 * failure in strict mode. A check stopped by a hard cap is neutral: our limit isn't the PR's fault.
 */
export function conclusionFor(report: PrReport, mode: Exclude<PrCheckMode, 'off'>): PrCheck['conclusion'] {
  if (report.tooLarge) return 'neutral';
  if (!hasFindings(report)) return 'success';
  return mode === 'strict' ? 'failure' : 'neutral';
}

/** Comment only when there's something to say (or to correct in an earlier comment). */
export const worthCommenting = (r: PrReport) =>
  r.added.length + r.removed.length + r.renamed.length + r.envFiles.length + r.secrets.length > 0 || r.tooLarge !== null;

/** One line: "2 env vars added (1 not in .env.example), 1 removed, 1 renamed". */
export function summaryLine(r: PrReport): string {
  if (r.tooLarge) return r.tooLarge;
  const parts: string[] = [];
  if (r.added.length) {
    const missing = r.added.filter((a) => !a.declared).length;
    parts.push(`${plural(r.added.length, 'env var')} added${missing ? ` (${missing} not in .env.example)` : ''}`);
  }
  if (r.removed.length) parts.push(`${r.removed.length} removed`);
  if (r.renamed.length) {
    const missing = r.renamed.filter((x) => !x.declared).length;
    parts.push(`${r.renamed.length} renamed${missing ? ` (${missing} not in .env.example)` : ''}`);
  }
  if (r.envFiles.length) parts.push(plural(r.envFiles.length, 'committed env file'));
  if (r.secrets.length) parts.push(plural(r.secrets.length, 'possible secret'));
  return parts.length ? parts.join(', ') : 'No env var changes';
}

/** `text` cut to `max` characters: its start, an ellipsis, and its end (the more telling part of a path). */
export function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor((max - 1) * 0.375);
  return `${text.slice(0, head)}…${text.slice(text.length - (max - 1 - head))}`;
}
const path = (p: string) => shorten(p, MAX_PATH_CHARS);
const name = (n: string) => shorten(n, MAX_NAME_CHARS);

/**
 * `lines` then `tail`, joined, within `max` characters: when they don't fit, the lines that do
 * (whole ones, from the start), a note saying how many were cut, then `tail`.
 */
export function fitLines(lines: readonly string[], max: number, tail: readonly string[] = []): string {
  const whole = [...lines, ...tail].join('\n');
  if (whole.length <= max) return whole;
  const kept: string[] = [];
  let used = tail.join('\n').length + 80; // the note and its blank line
  for (const line of lines) {
    if (used + line.length + 1 > max) break;
    kept.push(line);
    used += line.length + 1;
  }
  return [...kept, '', `…and ${lines.length - kept.length} more lines, cut to fit GitHub's limit.`, ...tail].join('\n');
}

/** Inline code that survives any file name: no newlines, pipes escaped, a long enough fence. */
function code(text: string): string {
  const clean = text.replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|');
  const longest = Math.max(0, ...[...clean.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return longest ? `${fence} ${clean} ${fence}` : `${fence}${clean}${fence}`;
}

/** A Markdown table of the first MAX_ROWS items (only those are rendered), then "…and N more." */
function table<T>(header: string[], items: readonly T[], row: (item: T) => string[]): string[] {
  const out = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`];
  for (const item of items.slice(0, MAX_ROWS)) out.push(`| ${row(item).join(' | ')} |`);
  if (items.length > MAX_ROWS) out.push('', `…and ${items.length - MAX_ROWS} more.`);
  return out;
}

/** Up to `max` items as lines, then "- …and N more". */
function list<T>(items: readonly T[], max: number, line: (item: T) => string): string[] {
  const out = items.slice(0, max).map(line);
  if (items.length > max) out.push(`- …and ${items.length - max} more`);
  return out;
}

const where = (refs: ReadonlyArray<{ file: string; line: number }>, total: number) =>
  `${code(`${path(refs[0]!.file)}:${refs[0]!.line}`)}${total > 1 ? ` (+${total - 1} more)` : ''}`;

/** The pull request comment (Markdown). Names and file:line only, never values. */
export function renderComment(r: PrReport, { mode, headSha }: { mode: Exclude<PrCheckMode, 'off'>; headSha: string }): string {
  const status = hasFindings(r) ? (mode === 'strict' ? '❌' : '⚠️') : '✅';
  const lines = [COMMENT_MARKER, `### ${COMMENT_TITLE}`, '', `${r.tooLarge ? 'ℹ️' : status} **${summaryLine(r)}.**`];

  if (!r.tooLarge) {
    if (r.added.length) {
      lines.push('', '#### Added', '');
      lines.push(...table(['Variable', 'Read at', '`.env.example`'], r.added, (a) => [code(name(a.name)), where(a.refs, a.total), a.declared ? '✅ declared' : '❌ **not declared**']));
    }
    if (r.renamed.length) {
      lines.push('', '#### Renamed', '');
      lines.push(...table(['From', 'To', 'In', '`.env.example`'], r.renamed, (x) => [code(name(x.from)), code(name(x.to)), code(`${path(x.file)}:${x.line}`), x.declared ? '✅ declared' : '❌ **not declared**']));
    }
    if (r.removed.length) {
      lines.push('', '#### Removed', '', 'No longer read anywhere; you can drop them from your env files and deploy settings.', '');
      lines.push(...table(['Variable', 'Was read at'], r.removed, (x) => [code(name(x.name)), where(x.refs, x.total)]));
    }
    if (r.envFiles.length) {
      lines.push('', '#### Committed env files', '', 'These usually hold real values. Remove them from the pull request and rotate anything they contained.', '');
      lines.push(...table(['File', ''], r.envFiles, (f) => [code(path(f.path)), f.added ? 'added in this pull request' : 'changed in this pull request']));
    }
    if (r.secrets.length) {
      lines.push('', `**${plural(r.secrets.length, 'possible secret')} in added lines** (see the \`deployhealth / env\` check run for where).`);
    }
  }
  const footer = ['', `<sub>Checked ${code(headSha.slice(0, 7))} · mode: ${mode} · names and file:line only, never values · [deployhealth](https://deployhealth.dev)</sub>`];
  return `${fitLines(lines, MAX_GITHUB_TEXT - 1, footer)}\n`;
}

/** The check run: the same summary, plus where each possible secret is (rule, file:line). Each part within GitHub's limits. */
export function checkRunOutput(r: PrReport, conclusion: PrCheck['conclusion']): CheckRunOutput {
  const text: string[] = [];
  if (r.undeclared.length) text.push('### Not in .env.example', '', ...list(r.undeclared, MAX_LISTED, (n) => `- ${code(name(n))}`), '');
  if (r.envFiles.length) text.push('### Committed env files', '', ...list(r.envFiles, MAX_LISTED, (f) => `- ${code(path(f.path))}`), '');
  if (r.secrets.length) {
    text.push('### Possible secrets in added lines', '', 'Values are not shown. If one is real, rotate it: it is in the branch history now.', '');
    text.push(...list(r.secrets, 200, (s) => `- ${code(`${path(s.file)}:${s.line}`)} ${secretRuleLabel(s.rule)}`));
  }
  const inline = r.undeclared.slice(0, MAX_INLINE).map((n) => `\`${name(n)}\``);
  const more = r.undeclared.length > MAX_INLINE ? ` and ${r.undeclared.length - MAX_INLINE} more` : '';
  return {
    conclusion,
    title: shorten(summaryLine(r), MAX_TITLE),
    summary: fitLines([r.tooLarge ? r.tooLarge : `${summaryLine(r)}.${r.undeclared.length ? ` Not in .env.example: ${inline.join(', ')}${more}.` : ''}`], MAX_GITHUB_TEXT),
    text: text.length ? fitLines(text, MAX_GITHUB_TEXT) : undefined,
  };
}

export const UNCHECKABLE_TITLE = "Couldn't be checked";
export const UNCHECKABLE_SUMMARY =
  `deployhealth couldn't finish checking this pull request: a check stops after ${PR_CHECK_TIME_LIMIT_MS / 1000} seconds of work, ` +
  'or when the files it reads can\'t be scanned. Nothing is reported for this commit; pushing again checks the new one.';

/** The check run when the isolate couldn't finish: neutral, a fixed message, never error details. */
export function uncheckableOutput(): CheckRunOutput {
  return { conclusion: 'neutral', title: UNCHECKABLE_TITLE, summary: UNCHECKABLE_SUMMARY };
}
