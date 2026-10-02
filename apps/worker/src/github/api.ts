import type { Octokit } from '@octokit/rest';

export interface PullRequestInfo {
  number: number;
  state: 'open' | 'closed';
  headSha: string;
  /** The merge base of the base branch and the head: what the pull request's diff is against. */
  baseSha: string;
  authorLogin: string;
}

export interface TreeBlob {
  path: string;
  sha: string;
  size: number;
}

export interface PullFile {
  filename: string;
  status: string;
  /** Unified diff; GitHub leaves it out for binary and very large files. */
  patch?: string;
}

export interface CheckRunOutput {
  conclusion: 'neutral' | 'success' | 'failure';
  title: string;
  summary: string;
  text?: string;
}

/** GitHub caps listings; beyond these a pull request is too big to read in full anyway. */
const MAX_PULL_FILES = 3_000;
const MAX_PULL_COMMITS = 250;
export const CHECK_RUN_NAME = 'deployhealth / env';

/**
 * The GitHub calls a pull request check makes, for one repository. `appId` is this GitHub App's
 * id: only comments it posted are ever reused.
 */
export function githubApi(octokit: Octokit, repoFullName: string, { appId }: { appId: number }) {
  const [owner, repo] = repoFullName.split('/') as [string, string];

  return {
    async pullRequest(pullNumber: number): Promise<PullRequestInfo> {
      const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
      const { data: compare } = await octokit.rest.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${pr.base.sha}...${pr.head.sha}`,
        per_page: 1,
      });
      return {
        number: pr.number,
        state: pr.state === 'open' ? 'open' : 'closed',
        headSha: pr.head.sha,
        baseSha: compare.merge_base_commit.sha,
        authorLogin: pr.user?.login ?? 'ghost',
      };
    },

    /** Every blob in the commit's tree; `truncated` when GitHub couldn't list them all. */
    async tree(commitSha: string): Promise<{ blobs: TreeBlob[]; truncated: boolean }> {
      const { data } = await octokit.rest.git.getTree({ owner, repo, tree_sha: commitSha, recursive: 'true' });
      const blobs = data.tree
        .filter((e) => e.type === 'blob' && e.path && e.sha)
        .map((e) => ({ path: e.path!, sha: e.sha!, size: e.size ?? 0 }));
      return { blobs, truncated: data.truncated };
    },

    async blob(sha: string): Promise<Buffer> {
      const { data } = await octokit.rest.git.getBlob({ owner, repo, file_sha: sha });
      return Buffer.from(data.content, data.encoding === 'base64' ? 'base64' : 'utf8');
    },

    async pullFiles(pullNumber: number): Promise<PullFile[]> {
      const files: PullFile[] = [];
      for await (const { data } of octokit.paginate.iterator(octokit.rest.pulls.listFiles, { owner, repo, pull_number: pullNumber, per_page: 100 })) {
        for (const f of data) files.push({ filename: f.filename, status: f.status, patch: f.patch });
        if (files.length >= MAX_PULL_FILES) break;
      }
      return files;
    },

    async commitMessages(pullNumber: number): Promise<string[]> {
      const messages: string[] = [];
      for await (const { data } of octokit.paginate.iterator(octokit.rest.pulls.listCommits, { owner, repo, pull_number: pullNumber, per_page: 100 })) {
        for (const c of data) messages.push(c.commit.message);
        if (messages.length >= MAX_PULL_COMMITS) break;
      }
      return messages;
    },

    /**
     * This App's own comment carrying `marker`, if one exists (state lost, or an older head). A
     * comment counts only if this App posted it (`performed_via_github_app`): anyone can paste
     * the marker into a comment of their own.
     */
    async findMarkedComment(issueNumber: number, marker: string): Promise<number | null> {
      for await (const { data } of octokit.paginate.iterator(octokit.rest.issues.listComments, { owner, repo, issue_number: issueNumber, per_page: 100 })) {
        const mine = data.find((c) => c.performed_via_github_app?.id === appId && c.body?.includes(marker));
        if (mine) return mine.id;
      }
      return null;
    },

    async createComment(issueNumber: number, body: string): Promise<number> {
      const { data } = await octokit.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body });
      return data.id;
    },

    async updateComment(commentId: number, body: string): Promise<void> {
      await octokit.rest.issues.updateComment({ owner, repo, comment_id: commentId, body });
    },

    async createCheckRun(headSha: string, output: CheckRunOutput): Promise<number> {
      const { data } = await octokit.rest.checks.create({
        owner,
        repo,
        name: CHECK_RUN_NAME,
        head_sha: headSha,
        status: 'completed',
        conclusion: output.conclusion,
        output: { title: output.title, summary: output.summary, text: output.text },
      });
      return data.id;
    },

    async updateCheckRun(checkRunId: number, output: CheckRunOutput): Promise<void> {
      await octokit.rest.checks.update({
        owner,
        repo,
        check_run_id: checkRunId,
        status: 'completed',
        conclusion: output.conclusion,
        output: { title: output.title, summary: output.summary, text: output.text },
      });
    },
  };
}

export type GithubApi = ReturnType<typeof githubApi>;
