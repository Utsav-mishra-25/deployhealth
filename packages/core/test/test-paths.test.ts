import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanFiles, scanProject, selectTreeFiles } from '../src/scan';
import { isTestFileName, isTestPath, TEST_DIRS } from '../src/test-paths';

describe('isTestPath', () => {
  it('matches the test file names', () => {
    for (const name of ['app.test.ts', 'app.test.tsx', 'App.spec.js', 'util.spec.mjs', 'client_test.go', 'test_views.py', 'views_test.py', 'conftest.py', 'user_spec.rb', 'login.e2e.ts', 'app.e2e-spec.ts', 'widget.cy.tsx', 'playwright.config.ts', 'vitest.config.mts', 'vitest.workspace.ts', 'vitest.setup.ts', 'jest.config.js', 'jest.setup.cjs', 'cypress.config.ts']) {
      expect(isTestFileName(name), name).toBe(true);
    }
  });

  it('leaves look-alikes alone: contest.ts, latest.py, a file called test.ts, spec.rb, and env files', () => {
    for (const name of ['contest.ts', 'latest.py', 'test.ts', 'testing.ts', 'testing-utils.ts', 'spec.rb', 'inspect.go', 'attest_x.py', '.env.test', '.env.test.local', 'protest_test.rs', 'e2e.ts', 'e2e-spec.ts', 'vite.config.ts', 'playwright.ts', '.env.e2e.example', '.env.cy.sample']) {
      expect(isTestFileName(name), name).toBe(false);
    }
  });

  it('matches anything under a test or fixture directory, at any depth', () => {
    expect([...TEST_DIRS].sort()).toEqual(['__fixtures__', '__mocks__', '__tests__', 'cypress', 'e2e', 'fixtures', 'mocks', 'playwright', 'spec', 'test', 'testdata', 'testing', 'tests']);
    for (const path of ['test/a.ts', 'src/__tests__/a.ts', 'apps/web/e2e/login.ts', 'pkg/testdata/.env', 'spec/models/user.rb', 'lib/__fixtures__/x.js', 'packages/core/test/fixtures/p/.env.example', 'playwright/fixtures.ts', 'apps/web/cypress/support/commands.ts', 'src/mocks/handlers.ts', 'src/__mocks__/fs.ts', 'packages/testing/src/index.ts', 'src/testing/helpers.ts']) {
      expect(isTestPath(path), path).toBe(true);
    }
    for (const path of ['src/contest.ts', 'src/testing-utils.ts', 'src/mocking/x.ts', 'src/playwright-helpers.ts', 'latest/app.ts', 'specs/a.ts', 'src/app.ts', '.env.test.local', '.env.e2e.example']) {
      expect(isTestPath(path), path).toBe(false);
    }
  });
});

describe('scanning skips tests and fixtures by default', () => {
  let root: string;
  const FILES: Record<string, string> = {
    '.env.example': 'APP_KEY=\nTEST_DB_URL=\n',
    'src/app.ts': 'process.env.APP_KEY\nprocess.env.APP_SECRET',
    'src/contest.ts': 'process.env.CONTEST_VAR', // named like a test, but isn't one
    'src/app.test.ts': 'process.env.UNIT_ONLY',
    'src/__tests__/helpers.ts': 'process.env.JEST_ONLY',
    'e2e/login.ts': 'process.env.E2E_ONLY',
    'tests/test_views.py': 'os.getenv("PY_TEST_ONLY")',
    'conftest.py': 'os.environ["TEST_DB_URL"]', // declared, read only by tests: not UNUSED
    'spec/user_spec.rb': 'ENV["RSPEC_ONLY"]',
    'pkg/client_test.go': 'os.Getenv("GO_TEST_ONLY")',
    'pkg/testdata/main.go': 'os.Getenv("TESTDATA_ONLY")',
    // A fixture with its own env file: it must not become a scope.
    'test/fixtures/app/.env.example': 'FIXTURE_VAR=\n',
    'test/fixtures/app/index.ts': 'process.env.FIXTURE_VAR',
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'deployhealth-tests-'));
    for (const [rel, content] of Object.entries(FILES)) {
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), content);
    }
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reports only application code, keeps contest.ts, and says how many files it skipped', async () => {
    const result = await scanProject(root);
    expect(result.variables.map((v) => v.var_name)).toEqual(['APP_KEY', 'APP_SECRET', 'CONTEST_VAR']);
    // TEST_DB_URL is in .env.example and only conftest.py reads it: used, so not UNUSED either.
    expect(result.findings.map((f) => `${f.kind} ${f.var_name}`)).toEqual(['missing APP_SECRET', 'missing CONTEST_VAR']);
    expect(result.scopes).toEqual(['']); // the fixture's .env.example made no scope
    expect(result.envFiles).toEqual(['.env.example']);
    expect(result.testFilesSkipped).toBe(10);
  });

  it('scans everything with includeTests, fixture scopes included', async () => {
    const result = await scanProject(root, { includeTests: true });
    expect(result.testFilesSkipped).toBe(0);
    expect(result.scopes).toEqual(['', 'test/fixtures/app']);
    expect(result.variables.map((v) => v.var_name)).toEqual(
      expect.arrayContaining(['UNIT_ONLY', 'JEST_ONLY', 'E2E_ONLY', 'PY_TEST_ONLY', 'TEST_DB_URL', 'RSPEC_ONLY', 'GO_TEST_ONLY', 'TESTDATA_ONLY', 'FIXTURE_VAR']),
    );
  });

  it('applies the same rule to git trees (the GitHub App never fetches test files) and to in-memory files', async () => {
    const selected = selectTreeFiles(Object.keys(FILES));
    expect(selected).toEqual(['.env.example', 'src/app.ts', 'src/contest.ts']);
    expect(selectTreeFiles(Object.keys(FILES), { includeTests: true })).toHaveLength(Object.keys(FILES).length);

    const inMemory = await scanFiles(new Map(Object.entries(FILES)));
    const onDisk = await scanProject(root);
    expect(inMemory.findings).toEqual(onDisk.findings);
    expect(inMemory.variables).toEqual(onDisk.variables);
    expect(inMemory.testFilesSkipped).toBe(onDisk.testFilesSkipped);
  });
});
