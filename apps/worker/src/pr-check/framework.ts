import { DOCS_STACK_SLUGS, LARAVEL_MARKER, passesTreeRules, treeMarkers, usesSpring, type DocsStackSlug } from '@deployhealth/core';
import { posix } from 'node:path';

// Which framework's docs page the pull request comment links ("What this checks"). Runs in the
// isolate with the rest of the analysis: linear in the paths and files it's given.

/** Where the docs live; the comment's footer already links deployhealth.dev. */
export const DOCS_BASE_URL = 'https://deployhealth.dev/docs';

/** Next.js's config file: next.config.js, .mjs, .cjs or .ts. */
const NEXT_CONFIG = /^next\.config\.(?:js|mjs|cjs|ts)$/;
const JVM_SOURCE = /\.(?:java|kt|kts)$/;

export interface FrameworkInput {
  /** Every path in head's tree; vendored, build-output and test paths are left out here. */
  headTree: readonly string[];
  /** [path, text] of the head files the check scanned (tests and build scripts already left out); empty when it read no code. */
  headFiles: ReadonlyArray<readonly [string, string]>;
}

/**
 * The frameworks head uses, in DOCS_STACK_SLUGS order: Next.js (a next.config file) and Laravel
 * (an `artisan` file) from the tree listing alone, so even a check that downloads no code knows
 * them; Spring Boot from Java or Kotlin source that mentions org.springframework.
 */
export function detectFrameworks({ headTree, headFiles }: FrameworkInput): DocsStackSlug[] {
  const markers = treeMarkers(headTree);
  const found = new Set<DocsStackSlug>();
  for (const path of headTree) {
    const name = posix.basename(path);
    if (name !== LARAVEL_MARKER && !NEXT_CONFIG.test(name)) continue;
    if (!passesTreeRules(path, { markers })) continue;
    found.add(name === LARAVEL_MARKER ? 'laravel' : 'nextjs');
  }
  if (headFiles.some(([path, text]) => JVM_SOURCE.test(path) && usesSpring(text))) found.add('spring-boot');
  return DOCS_STACK_SLUGS.filter((slug) => found.has(slug));
}

/**
 * The comment's "What this checks" link: the stack page when exactly one framework is detected,
 * else /docs (none, or a monorepo with several: the index lists each stack's page).
 */
export function docsUrl(frameworks: readonly DocsStackSlug[]): string {
  return frameworks.length === 1 ? `${DOCS_BASE_URL}/${frameworks[0]}` : DOCS_BASE_URL;
}
