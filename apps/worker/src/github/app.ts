import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { githubFetch, USER_AGENT } from '../guarded-http';

export interface GithubAppCredentials {
  appId: number;
  privateKey: string;
}

/** Bounds memory: installations beyond this are re-authenticated when next used. */
const MAX_CACHED_INSTALLATIONS = 500;

/**
 * Octokit clients for the App's installations. Each signs an App JWT with the private key,
 * exchanges it for an installation token, and reuses that token until shortly before it expires
 * (@octokit/auth-app's cache), so one client per installation is kept. Every request goes
 * through `githubFetch` (api.github.com only, SSRF-guarded). `fetch` is replaceable for tests.
 */
export function createGithubApp(credentials: GithubAppCredentials, { fetch = githubFetch }: { fetch?: typeof githubFetch } = {}) {
  const clients = new Map<number, Octokit>();
  return {
    forInstallation(installationId: number): Octokit {
      let client = clients.get(installationId);
      if (!client) {
        if (clients.size >= MAX_CACHED_INSTALLATIONS) clients.delete(clients.keys().next().value!);
        client = new Octokit({
          authStrategy: createAppAuth,
          auth: { appId: credentials.appId, privateKey: credentials.privateKey, installationId },
          request: { fetch },
          userAgent: USER_AGENT,
          // Octokit logs deprecation warnings and debug lines; keep only warnings and errors.
          log: { debug: () => {}, info: () => {}, warn: (m: string) => console.warn(`[github] ${m}`), error: (m: string) => console.error(`[github] ${m}`) },
        });
        clients.set(installationId, client);
      }
      return client;
    },
  };
}
