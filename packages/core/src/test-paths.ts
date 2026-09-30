import { ENV_FILE_BASENAMES } from './types';

/**
 * Directory names whose contents are tests or fixtures, skipped at any depth (env files included,
 * so a fixture's .env never becomes a scope) unless the scan includes tests.
 */
export const TEST_DIRS: ReadonlySet<string> = new Set(['test', 'tests', '__tests__', 'spec', 'e2e', 'fixtures', '__fixtures__', 'testdata']);

/** Test file names: *.test.*, *.spec.*, *_test.go, test_*.py, *_test.py, conftest.py, *_spec.rb. */
const TEST_FILE_NAMES: readonly RegExp[] = [/.\.test\./, /.\.spec\./, /_test\.go$/, /^test_.*\.py$/, /_test\.py$/, /^conftest\.py$/, /_spec\.rb$/];

const ENV_NAMES: ReadonlySet<string> = new Set(ENV_FILE_BASENAMES);

/** A test file by its base name. Env files never are: `.env.test.local` is an env file. */
export function isTestFileName(name: string): boolean {
  return !ENV_NAMES.has(name) && TEST_FILE_NAMES.some((pattern) => pattern.test(name));
}

/** A POSIX path relative to the scan root that is a test file, or inside a test directory. */
export function isTestPath(relPath: string): boolean {
  const parts = relPath.split('/');
  const name = parts.pop()!;
  return parts.some((dir) => TEST_DIRS.has(dir)) || isTestFileName(name);
}
