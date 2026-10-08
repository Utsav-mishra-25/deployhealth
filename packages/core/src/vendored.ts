// Code nobody in the repository wrote: installed dependencies, vendored copies, build output and
// caches. The scanner never reads it, so a bundled package manager or a committed bundle can't
// flood a scan with its own env var reads.

/**
 * Directory names never entered, at any depth. `build` is deliberately absent: a committed
 * `build/` is as often build scripts (webpack, gulp) that read real env vars as build output,
 * which is gitignored anyway; committed bundles are caught by the size and `.min.*` rules.
 * Names that are build output only in context (`bootstrap/cache`, Laravel's `storage/`) are in
 * build-dirs.ts.
 */
export const VENDORED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  '.next',
  'venv',
  '.venv',
  '.yarn',
  'vendor',
  'third_party',
  'bower_components',
  'out',
  'coverage',
  '.turbo',
  '.vercel',
  '.output',
  '.svelte-kit',
  '.nuxt',
  '.cache',
  '.pnpm-store',
  '__pycache__',
  'site-packages',
  '.phpunit.cache',
]);

/** Generated files: Yarn Plug'n'Play's loaders and minified bundles. */
export function isVendoredFileName(name: string): boolean {
  return name === '.pnp.cjs' || name === '.pnp.loader.mjs' || /\.min\.(?:js|mjs|cjs)$/.test(name);
}

/** Source files larger than this are bundles, not code people wrote, and are never read. */
export const MAX_SOURCE_FILE_BYTES = 512 * 1024;
