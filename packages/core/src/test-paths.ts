import { isEnvFileName } from './env-files';

/**
 * Directory names whose contents are tests, fixtures or test tooling, skipped at any depth (env
 * files included, so a fixture's .env never becomes a scope) unless the scan includes tests.
 */
export const TEST_DIRS: ReadonlySet<string> = new Set([
  'test',
  'tests',
  '__tests__',
  'spec',
  'e2e',
  'fixtures',
  '__fixtures__',
  'testdata',
  'playwright',
  'cypress',
  'mocks',
  '__mocks__',
  'testing',
]);

/**
 * Test file names: *.test.*, *.spec.*, *.e2e.*, *.e2e-spec.* (NestJS), *.cy.*, *_test.go, test_*.py, *_test.py,
 * conftest.py, *_spec.rb, *Test.php, phpunit.xml(.dist), and test runner config and setup files (playwright.config.*,
 * vitest.config.*, vitest.workspace.*, vitest.setup.*, jest.config.*, jest.setup.*, cypress.config.*).
 */
const TEST_FILE_NAMES: readonly RegExp[] = [
  /.\.test\./,
  /.\.spec\./,
  /.\.e2e\./,
  /.\.e2e-spec\./,
  /.\.cy\./,
  /_test\.go$/,
  /^test_.*\.py$/,
  /_test\.py$/,
  /^conftest\.py$/,
  /_spec\.rb$/,
  /.Test\.php$/,
  /^phpunit\.xml(?:\.dist)?$/,
  /^(?:playwright|vitest|jest|cypress)\.config\./,
  /^vitest\.workspace\./,
  /^(?:vitest|jest)\.setup\./,
];

/** A test file by its base name. Env files never are: `.env.test.local` is an env file. */
export function isTestFileName(name: string): boolean {
  return !isEnvFileName(name) && TEST_FILE_NAMES.some((pattern) => pattern.test(name));
}

/** A POSIX path relative to the scan root that is a test file, or inside a test directory. */
export function isTestPath(relPath: string): boolean {
  const parts = relPath.split('/');
  const name = parts.pop()!;
  return parts.some((dir) => TEST_DIRS.has(dir)) || isTestFileName(name);
}
