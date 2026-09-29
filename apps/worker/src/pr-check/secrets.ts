/** A secret-shaped string on an added line. Only where and which rule: the value is never kept. */
export interface SecretHit {
  rule: string;
  file: string;
  line: number;
}

/** A small, high-signal set: formats with fixed prefixes, so false positives are rare. */
export const SECRET_RULES: ReadonlyArray<{ id: string; label: string; pattern: RegExp }> = [
  { id: 'aws-access-key-id', label: 'AWS access key ID', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'github-token', label: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/ },
  { id: 'slack-token', label: 'Slack token', pattern: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/ },
  { id: 'slack-webhook', label: 'Slack webhook URL', pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]{16,}/ },
  { id: 'private-key', label: 'Private key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { id: 'deployhealth-token', label: 'deployhealth ingest token', pattern: /\bdh_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/ },
];

/** The lines a unified diff adds, with their line numbers in the new file. */
export function addedLines(patch: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let next = 0;
  for (const raw of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (next === 0 || raw.startsWith('\\')) continue; // before the first hunk, or "\ No newline at end of file"
    if (raw.startsWith('+')) out.push({ line: next++, text: raw.slice(1) });
    else if (raw.startsWith('-')) continue;
    else next++; // context line
  }
  return out;
}

/** Every rule match on added lines, one hit per rule per line, in file order. */
export function findSecrets(files: ReadonlyArray<{ filename: string; patch?: string }>): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const file of files) {
    if (!file.patch) continue;
    for (const { line, text } of addedLines(file.patch)) {
      for (const rule of SECRET_RULES) if (rule.pattern.test(text)) hits.push({ rule: rule.id, file: file.filename, line });
    }
  }
  return hits;
}

export const secretRuleLabel = (id: string) => SECRET_RULES.find((r) => r.id === id)?.label ?? id;
