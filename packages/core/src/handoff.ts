import { formatDuration } from './alerts';
import { formatInterval, formatPercent, formatUtc, plural } from './format';
import { isEnvFileName, sortEnvFileNames } from './env-files';
import { ENV_NAME_PATTERN, type EnvScope, type FindingRow, type RequiredVariable } from './types';

// The handoff export: what a freelancer gives a client when a contract ends. Built from names only
// (the scanner never reads env values, and the ingest contract can't carry them), rendered as
// Markdown here and as a printable page in the web app, from the same HandoffData.

export interface HandoffEndpoint {
  /** Name, else host. */
  label: string;
  url: string;
  method: 'GET' | 'HEAD';
  intervalSeconds: number;
  expectedStatus: number;
  enabled: boolean;
  /** Share of ok checks over the window; null without checks. */
  uptime: number | null;
}

export interface HandoffAlert {
  endpoint: string;
  openedAt: Date;
  resolvedAt: Date | null;
  message: string;
}

export interface HandoffData {
  generatedAt: Date;
  project: { name: string; repoFullName: string };
  client: { name: string; contactEmail: string | null } | null;
  /** The latest scan's deploy; null before the first scan. */
  scan: { sha: string; branch: string; deployedAt: Date; variablesReported: boolean } | null;
  /** Every referenced variable in the latest scan. */
  variables: RequiredVariable[];
  /** The latest scan's scopes and their env files; null for scans from CLIs before 0.2.0. */
  envScopes: EnvScope[] | null;
  /** The latest scan's findings (open issues). */
  findings: FindingRow[];
  endpoints: HandoffEndpoint[];
  /** The uptime and alert window: the last 30 days. */
  window: { from: Date; to: Date };
  /** Average of the endpoints' uptimes that have data. */
  uptime: number | null;
  /** Alerts opened in the window, or still open. Oldest first. */
  alerts: HandoffAlert[];
  /** Markdown from project settings. Untrusted: the web page renders it without raw HTML. */
  deployNotes: string | null;
  /** The GitHub Action workflow, pointing at this deployhealth instance. */
  actionSnippet: string;
}

export interface VariableGroup {
  scope: string;
  /** "Repository root" for '', else the scope path. */
  label: string;
  variables: RequiredVariable[];
}

export const ROOT_SCOPE_LABEL = 'Repository root';

/** Variables by scope: the root first, then scopes alphabetically; names sorted within each. */
export function groupVariablesByScope(variables: readonly RequiredVariable[]): VariableGroup[] {
  const byScope = new Map<string, RequiredVariable[]>();
  for (const v of variables) byScope.set(v.scope, [...(byScope.get(v.scope) ?? []), v]);
  return [...byScope.keys()]
    .sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map((scope) => ({
      scope,
      label: scope === '' ? ROOT_SCOPE_LABEL : scope,
      variables: [...byScope.get(scope)!].sort((a, b) => a.var_name.localeCompare(b.var_name)),
    }));
}

/** Where a variable stands: defined, optional (a default in code), in a scope with no env file yet, or missing. */
export type VariableStatus = 'ok' | 'optional' | 'no-env-file' | 'missing';

export const VARIABLE_STATUS_LABELS: Record<VariableStatus, string> = {
  ok: 'ok',
  optional: 'optional (default in code)',
  'no-env-file': 'no env file yet',
  missing: 'missing',
};

/** The scopes a scan found with no env file at all. Empty for older scans, which didn't report scopes. */
export function scopesWithoutEnvFiles(envScopes: readonly EnvScope[] | null): Set<string> {
  return new Set((envScopes ?? []).filter((s) => s.env_files.length === 0).map((s) => s.scope));
}

export function variableStatus(v: RequiredVariable, bareScopes: ReadonlySet<string>): VariableStatus {
  if (v.defined_in.length > 0) return 'ok';
  if (v.optional) return 'optional';
  return bareScopes.has(v.scope) ? 'no-env-file' : 'missing';
}

/**
 * A starting `.env.example` for one scope: every variable as `NAME=`, sorted, names only (values
 * are never known). Optional ones get a comment saying the code has a default.
 */
export function dotenvExample(variables: readonly RequiredVariable[]): string {
  const lines: string[] = [];
  for (const v of [...variables].sort((a, b) => a.var_name.localeCompare(b.var_name))) {
    if (v.optional) lines.push('# optional: the code has a default');
    lines.push(`${v.var_name}=`);
  }
  return `${lines.join('\n')}\n`;
}

/** Findings grouped by kind, in the order the page and the Markdown list them. */
export const FINDING_SECTIONS = [
  { kind: 'missing', title: 'Missing', blurb: 'referenced in code, not defined in its scope' },
  { kind: 'unused', title: 'Unused', blurb: 'defined in an env file, never referenced' },
  { kind: 'mismatch', title: 'Mismatch', blurb: '.env and .env.example disagree' },
] as const;

/** One line per finding, e.g. "referenced at apps/api/src/lib/cache.ts:6". */
export function describeFinding(f: FindingRow): string {
  const at = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : 'unknown location';
  if (f.kind === 'missing') return `referenced at ${at}`;
  if (f.kind === 'unused') return `defined at ${at}, never referenced`;
  return `defined at ${at}, absent from ${f.env_file ?? 'its counterpart'}`;
}

/** How long an alert lasted, or has lasted so far. */
export function alertDuration(alert: Pick<HandoffAlert, 'openedAt' | 'resolvedAt'>, now: Date): string {
  const end = alert.resolvedAt ?? now;
  return `${formatDuration(end.getTime() - alert.openedAt.getTime())}${alert.resolvedAt ? '' : ' so far'}`;
}

/** Table cells can't contain pipes or line breaks. */
function cell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** The status column in Markdown: MISSING in bold, the rest as their labels. */
function statusCell(status: VariableStatus): string {
  return status === 'missing' ? `**${VARIABLE_STATUS_LABELS.missing}**` : VARIABLE_STATUS_LABELS[status];
}

export function renderHandoffMarkdown(data: HandoffData): string {
  const out: string[] = [];
  const line = (text = '') => out.push(text);
  const bareScopes = scopesWithoutEnvFiles(data.envScopes);
  const statuses = data.variables.map((v) => variableStatus(v, bareScopes));
  const missingCount = statuses.filter((s) => s === 'missing').length;
  const undeclaredCount = statuses.filter((s) => s === 'no-env-file').length;

  line(`# Handoff: ${data.project.name}`);
  line();
  line('| | |');
  line('| --- | --- |');
  if (data.client) {
    line(`| Client | ${cell(data.client.name)}${data.client.contactEmail ? ` (${cell(data.client.contactEmail)})` : ''} |`);
  }
  line(`| Repository | [${cell(data.project.repoFullName)}](https://github.com/${data.project.repoFullName}) |`);
  line(`| Generated | ${formatUtc(data.generatedAt)} |`);
  line();
  line('All times UTC. This document lists environment variable **names only**; it never contains their values.');
  line();

  line('## Required environment variables');
  line();
  if (!data.scan) {
    line('No scans yet. Add the GitHub Action below and push once to list every variable the code needs.');
  } else if (!data.scan.variablesReported) {
    line(
      `The latest scan (deploy \`${data.scan.sha.slice(0, 7)}\`) came from an older scan CLI that only reported problems. ` +
        'Re-run the GitHub Action to list every variable; the open findings below still apply.',
    );
  } else if (data.variables.length === 0) {
    line('The code references no environment variables.');
  } else {
    line(
      `Every variable the code references in the latest scan (deploy \`${data.scan.sha.slice(0, 7)}\` on \`${cell(data.scan.branch)}\`, ` +
        `${formatUtc(data.scan.deployedAt)}), grouped by the env-file scope that has to define it. ` +
        (missingCount ? `**${plural(missingCount, 'variable')} missing.**` : 'None missing.') +
        (undeclaredCount
          ? ` ${plural(undeclaredCount, 'variable')} ${undeclaredCount === 1 ? 'is' : 'are'} in a scope with no env file yet; a starting \`.env.example\` follows its table.`
          : ''),
    );
    for (const group of groupVariablesByScope(data.variables)) {
      line();
      line(group.scope === '' ? `### ${ROOT_SCOPE_LABEL}` : `### \`${group.scope}\``);
      line();
      line('| Variable | Defined in | Status |');
      line('| --- | --- | --- |');
      for (const v of group.variables) {
        const definedIn = v.defined_in.length ? v.defined_in.map((f) => `\`${f}\``).join(', ') : '—';
        line(`| \`${v.var_name}\` | ${definedIn} | ${statusCell(variableStatus(v, bareScopes))} |`);
      }
      if (bareScopes.has(group.scope)) {
        line();
        line('No env file in this scope yet. A starting `.env.example` (names only):');
        line();
        line('```dotenv');
        line(dotenvExample(group.variables).trimEnd());
        line('```');
      }
    }
  }
  line();

  line('## Monitored endpoints');
  line();
  if (data.endpoints.length === 0) {
    line('No endpoints are monitored.');
  } else {
    line('| Endpoint | URL | Check | Expects | Uptime, 30 days |');
    line('| --- | --- | --- | --- | --- |');
    for (const e of data.endpoints) {
      const check = `${e.method} ${formatInterval(e.intervalSeconds)}${e.enabled ? '' : ' (paused)'}`;
      line(`| ${cell(e.label)} | ${cell(e.url)} | ${check} | ${e.expectedStatus} | ${formatPercent(e.uptime)} |`);
    }
  }
  line();

  line('## GitHub Action');
  line();
  line(
    'Scans run in CI on every push. Save the project\'s ingest token as the repository secret `DEPLOYHEALTH_TOKEN` ' +
      '(tokens are shown once; regenerate one on the project\'s settings page), then commit this workflow:',
  );
  line();
  line('```yaml');
  line(data.actionSnippet.trimEnd());
  line('```');
  line();

  line('## Open findings');
  line();
  if (!data.scan) {
    line('No scans yet.');
  } else if (data.findings.length === 0) {
    line('None: every referenced variable is defined, and the env files agree.');
  } else {
    for (const section of FINDING_SECTIONS) {
      const rows = data.findings.filter((f) => f.kind === section.kind);
      if (rows.length === 0) continue;
      line(`### ${section.title} (${rows.length})`);
      line();
      line(`_${section.blurb}_`);
      line();
      for (const f of rows) line(`- \`${f.var_name}\`: ${describeFinding(f)}`);
      line();
    }
  }
  if (out[out.length - 1] !== '') line();

  line('## Uptime, last 30 days');
  line();
  line(
    data.endpoints.length === 0
      ? 'No endpoints are monitored.'
      : `**${formatPercent(data.uptime)}** on average across ${plural(data.endpoints.length, 'endpoint')}, ` +
          `${formatUtc(data.window.from)} to ${formatUtc(data.window.to)}.`,
  );
  line();

  line('## Alerts, last 30 days');
  line();
  if (data.alerts.length === 0) {
    line('No alerts.');
  } else {
    line('| Opened | Resolved | Duration | What happened |');
    line('| --- | --- | --- | --- |');
    for (const a of data.alerts) {
      line(
        `| ${formatUtc(a.openedAt)} | ${a.resolvedAt ? formatUtc(a.resolvedAt) : 'still open'} | ` +
          `${alertDuration(a, data.generatedAt)} | ${cell(a.message)} |`,
      );
    }
  }
  line();

  line('## How to deploy');
  line();
  line(data.deployNotes?.trim() || '_No deploy notes yet._');
  line();
  return out.join('\n');
}

const ROW = /^\| `([^`]+)` \| (.*?) \| (.*?) \|$/;

/**
 * Read the required-variables section back out of a handoff's Markdown: the list, by scope, in
 * the order it was written. The section is machine-readable on purpose (a client can diff two
 * handoffs, or check a deploy against one); the tests round-trip it.
 */
export function parseHandoffVariables(markdown: string): RequiredVariable[] {
  const lines = markdown.split('\n');
  const start = lines.indexOf('## Required environment variables');
  if (start === -1) return [];
  const out: RequiredVariable[] = [];
  let scope: string | null = null;
  for (const text of lines.slice(start + 1)) {
    if (text.startsWith('## ')) break;
    if (text === `### ${ROOT_SCOPE_LABEL}`) scope = '';
    else if (/^### `.+`$/.test(text)) scope = text.slice(5, -1);
    const row = scope !== null ? ROW.exec(text) : null;
    if (!row || !ENV_NAME_PATTERN.test(row[1]!)) continue;
    const definedIn = row[2] === '—' ? [] : row[2]!.split(', ').map((f) => f.replace(/`/g, ''));
    const variable: RequiredVariable = {
      var_name: row[1]!,
      scope: scope!,
      defined_in: sortEnvFileNames(definedIn.filter(isEnvFileName)),
    };
    if (row[3] === VARIABLE_STATUS_LABELS.optional) variable.optional = true;
    out.push(variable);
  }
  return out;
}
