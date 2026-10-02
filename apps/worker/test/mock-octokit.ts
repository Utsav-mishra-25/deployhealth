import { createHash } from 'node:crypto';
import type { Octokit } from '@octokit/rest';

/** A repository as the mock serves it: files per commit, and pull requests. */
export interface MockRepo {
  commits: Record<string, Record<string, string>>;
  pulls: Record<
    number,
    { state: 'open' | 'closed'; head: string; baseTip: string; mergeBase: string; author: string; commits?: string[]; files?: Array<{ filename: string; status?: string; patch?: string }> }
  >;
  /** Tree entries larger than their content, to test the post-download size check. */
  understate?: Record<string, number>;
  truncated?: boolean;
}

const blobSha = (content: string) => createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0${content}`).digest('hex');
const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });
/** The App the mock acts as: comments it creates carry this id in `performed_via_github_app`. */
export const MOCK_APP_ID = 4242;

/**
 * Just enough of Octokit's REST client for githubApi(): the calls a pull request check makes,
 * against in-memory state, with every call logged in `calls`.
 */
export function mockOctokit(repo: MockRepo) {
  const calls: string[] = [];
  const blobs = new Map<string, string>();
  const state = {
    comments: new Map<number, { body: string; bot: boolean; appId?: number }>(),
    checkRuns: new Map<number, { headSha: string; conclusion: string; title: string; summary: string; text?: string }>(),
    nextId: 1000,
  };
  const pull = (n: number) => repo.pulls[n] ?? (() => { throw notFound(); })();

  const rest = {
    pulls: {
      get: async ({ pull_number }: { pull_number: number }) => {
        calls.push(`pulls.get ${pull_number}`);
        const pr = pull(pull_number);
        return { data: { number: pull_number, state: pr.state, head: { sha: pr.head }, base: { sha: pr.baseTip }, user: { login: pr.author } } };
      },
      listFiles: async ({ pull_number }: { pull_number: number }) => {
        calls.push(`pulls.listFiles ${pull_number}`);
        return { data: (pull(pull_number).files ?? []).map((f) => ({ status: 'modified', ...f })) };
      },
      listCommits: async ({ pull_number }: { pull_number: number }) => {
        calls.push(`pulls.listCommits ${pull_number}`);
        return { data: (pull(pull_number).commits ?? ['feat: change']).map((message) => ({ commit: { message } })) };
      },
    },
    repos: {
      compareCommitsWithBasehead: async ({ basehead }: { basehead: string }) => {
        calls.push(`repos.compare ${basehead}`);
        const [, head] = basehead.split('...');
        const pr = Object.values(repo.pulls).find((p) => p.head === head)!;
        return { data: { merge_base_commit: { sha: pr.mergeBase } } };
      },
    },
    git: {
      getTree: async ({ tree_sha }: { tree_sha: string }) => {
        calls.push(`git.getTree ${tree_sha}`);
        const files = repo.commits[tree_sha] ?? (() => { throw notFound(); })();
        const tree = Object.entries(files).map(([path, content]) => {
          const sha = blobSha(content);
          blobs.set(sha, content);
          return { path, type: 'blob', sha, size: repo.understate?.[path] ?? Buffer.byteLength(content) };
        });
        return { data: { tree, truncated: repo.truncated ?? false } };
      },
      getBlob: async ({ file_sha }: { file_sha: string }) => {
        calls.push(`git.getBlob ${file_sha.slice(0, 7)}`);
        const content = blobs.get(file_sha);
        if (content === undefined) throw notFound();
        return { data: { content: Buffer.from(content).toString('base64'), encoding: 'base64' } };
      },
    },
    issues: {
      listComments: async () => {
        calls.push('issues.listComments');
        return { data: [...state.comments].map(([id, c]) => ({ id, body: c.body, user: { type: c.bot ? 'Bot' : 'User' }, performed_via_github_app: c.appId ? { id: c.appId } : null })) };
      },
      createComment: async ({ body }: { body: string }) => {
        const id = ++state.nextId;
        calls.push(`issues.createComment ${id}`);
        state.comments.set(id, { body, bot: true, appId: MOCK_APP_ID });
        return { data: { id } };
      },
      updateComment: async ({ comment_id, body }: { comment_id: number; body: string }) => {
        calls.push(`issues.updateComment ${comment_id}`);
        if (!state.comments.has(comment_id)) throw notFound();
        state.comments.set(comment_id, { ...state.comments.get(comment_id)!, body });
        return { data: {} };
      },
    },
    checks: {
      create: async (p: { head_sha: string; conclusion: string; output: { title: string; summary: string; text?: string } }) => {
        const id = ++state.nextId;
        calls.push(`checks.create ${id} ${p.conclusion}`);
        state.checkRuns.set(id, { headSha: p.head_sha, conclusion: p.conclusion, ...p.output });
        return { data: { id } };
      },
      update: async (p: { check_run_id: number; conclusion: string; output: { title: string; summary: string; text?: string } }) => {
        calls.push(`checks.update ${p.check_run_id} ${p.conclusion}`);
        const run = state.checkRuns.get(p.check_run_id);
        if (!run) throw notFound();
        state.checkRuns.set(p.check_run_id, { ...run, conclusion: p.conclusion, ...p.output });
        return { data: {} };
      },
    },
  };
  const paginate = {
    iterator: async function* <P>(method: (params: P) => Promise<{ data: unknown[] }>, params: P) {
      yield await method(params);
    },
  };
  return { octokit: { rest, paginate } as unknown as Octokit, calls, state };
}
