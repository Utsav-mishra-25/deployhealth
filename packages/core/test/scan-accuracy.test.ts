import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanProject } from '../src/scan';
import type { FindingRow } from '../src/types';

// Scanner accuracy on real repositories (0.3.0): declaration files besides .env.example.
const FIXTURE = fileURLToPath(new URL('./fixtures/accuracy/', import.meta.url));

const unused = (var_name: string, file: string, line: number): FindingRow => ({ kind: 'unused', var_name, file, line, env_file: file });

describe('declaration files besides .env.example', () => {
  const NAMES = {
    sample: '.env.sample',
    template: '.env.template',
    'dotenv-dist': '.env.dist',
    defaults: '.env.defaults',
    'example-env': 'example.env',
    'sample-env': 'sample.env',
    'env-example': 'env.example',
    'named-example': '.env.appStore.example',
    'named-sample': '.env.local.sample',
    'named-template': '.env.ci-runner.template',
  };

  it('each one makes a scope and declares its variables, which can be UNUSED', async () => {
    const result = await scanProject(`${FIXTURE}env-names`);
    for (const [dir, name] of Object.entries(NAMES)) {
      expect(result.envScopes, dir).toContainEqual({ scope: dir, env_files: [name] });
      expect(result.variables, dir).toContainEqual({ var_name: 'DECLARED', scope: dir, defined_in: [name] });
      expect(result.findings, dir).toContainEqual(unused('LEFTOVER', `${dir}/${name}`, 2));
    }
    expect(result.findings.filter((f) => f.kind === 'missing')).toEqual([]);
  });

  it('ignores other names (.env.staging, a dotted .env.<a>.<b>.example)', async () => {
    const result = await scanProject(`${FIXTURE}env-names`);
    expect(result.envFiles.filter((f) => f.startsWith('ignored-'))).toEqual([]);
    // Their code falls into the root scope, which has no env file: listed, never MISSING.
    expect(result.envScopes).toContainEqual({ scope: '', env_files: [] });
    expect(result.variables).toContainEqual({ var_name: 'NOT_READ', scope: '', defined_in: [] });
  });

  it('still compares only .env with .env.example for MISMATCH', async () => {
    const result = await scanProject(`${FIXTURE}env-names/mixed`);
    expect(result.envScopes).toEqual([{ scope: '', env_files: ['.env.example', '.env', '.env.sample'] }]);
    expect(result.variables).toEqual([
      { var_name: 'SAMPLE_ONLY', scope: '', defined_in: ['.env.sample'] },
      { var_name: 'SHARED', scope: '', defined_in: ['.env.example', '.env', '.env.sample'] },
    ]);
    expect(result.findings).toEqual([]);
  });
});
