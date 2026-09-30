// Next ships its compiled path-to-regexp (the matcher for `headers()` sources) without types.
declare module 'next/dist/compiled/path-to-regexp' {
  export function pathToRegexp(path: string, keys?: unknown[], options?: Record<string, unknown>): RegExp;
}
