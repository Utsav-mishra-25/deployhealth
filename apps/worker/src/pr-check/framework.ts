import { DOCS_STACK_SLUGS, LARAVEL_MARKER, passesTreeRules, treeMarkers, usesSpring, type DocsStackSlug } from '@deployhealth/core';
import { posix } from 'node:path';

// Which framework's docs page the pull request comment links ("What this checks"). Runs in the
// isolate with the rest of the analysis: linear in the files it's given, never throws on them.

/** Where the docs live; the comment's footer already links deployhealth.dev. */
export const DOCS_BASE_URL = 'https://deployhealth.dev/docs';

const JVM_SOURCE = /\.(?:java|kt|kts)$/;

/** True when a package.json (its text) lists `next` in dependencies or devDependencies. */
export function dependsOnNext(packageJson: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJson);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object') return false;
  const has = (field: string) => {
    const deps = (parsed as Record<string, unknown>)[field];
    return !!deps && typeof deps === 'object' && !Array.isArray(deps) && Object.hasOwn(deps, 'next');
  };
  return has('dependencies') || has('devDependencies');
}

export interface FrameworkInput {
  /** Every path in head's tree (vendored, build-output and test paths are left out here). */
  headTree: readonly string[];
  /** [path, text] of the head files the check scanned (tests and build scripts already left out). */
  headFiles: ReadonlyArray<readonly [string, string]>;
  /** [path, text] of head's package.json files (only when the check read code). */
  packageJsons: ReadonlyArray<readonly [string, string]>;
}

/**
 * The frameworks head uses: Laravel (an `artisan` file), Spring Boot (Java or Kotlin source that
 * mentions org.springframework) and Next.js (a package.json that depends on `next`), in
 * DOCS_STACK_SLUGS order.
 */
export function detectFrameworks({ headTree, headFiles, packageJsons }: FrameworkInput): DocsStackSlug[] {
  const markers = treeMarkers(headTree);
  const found = new Set<DocsStackSlug>();
  if (packageJsons.some(([, text]) => dependsOnNext(text))) found.add('nextjs');
  if (headTree.some((path) => posix.basename(path) === LARAVEL_MARKER && passesTreeRules(path, { markers }))) found.add('laravel');
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
