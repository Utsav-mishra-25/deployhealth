/**
 * Coding agents, by the GitHub logins their pull requests come from (compared without "[bot]",
 * case-insensitively) and by the names their commits use in Co-Authored-By trailers.
 * Dependency bots (dependabot, renovate) are not agents.
 */
const AGENTS: ReadonlyArray<{ name: string; logins: readonly string[]; trailer: RegExp }> = [
  { name: 'Claude', logins: ['claude', 'claude-code'], trailer: /\bclaude\b/i },
  { name: 'Codex', logins: ['codex', 'chatgpt-codex-connector'], trailer: /\bcodex\b/i },
  { name: 'Copilot', logins: ['copilot', 'copilot-swe-agent'], trailer: /\bcopilot\b/i },
  { name: 'Cursor', logins: ['cursor', 'cursor-agent'], trailer: /\bcursor(?:agent)?\b/i },
  { name: 'Devin', logins: ['devin', 'devin-ai-integration'], trailer: /\bdevin\b/i },
  { name: 'Sweep', logins: ['sweep', 'sweep-ai'], trailer: /(?!)/ }, // detected by author only
];
const NOT_AGENTS = new Set(['dependabot', 'dependabot-preview', 'renovate', 'renovate-bot']);

export interface AgentMatch {
  isAgent: boolean;
  name: string | null;
}

/** The pull request author first, then any commit's Co-Authored-By trailer. */
export function detectAgent(authorLogin: string, commitMessages: readonly string[]): AgentMatch {
  const login = authorLogin.toLowerCase().replace(/\[bot\]$/, '');
  if (NOT_AGENTS.has(login)) return { isAgent: false, name: null };
  const byAuthor = AGENTS.find((a) => a.logins.includes(login));
  if (byAuthor) return { isAgent: true, name: byAuthor.name };

  for (const message of commitMessages) {
    for (const [, who] of message.matchAll(/^co-authored-by:\s*(.+)$/gim)) {
      const agent = AGENTS.find((a) => a.trailer.test(who!));
      if (agent) return { isAgent: true, name: agent.name };
    }
  }
  return { isAgent: false, name: null };
}
