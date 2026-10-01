import { describe, expect, it } from 'vitest';
import { compareEnvFileNames, isDeclarationFile, isEnvFileName, sortEnvFileNames } from '../src/env-files';

describe('env file names', () => {
  it.each([
    '.env.example',
    '.env',
    '.env.local',
    '.env.production.local',
    '.env.test.local',
    '.env.sample',
    '.env.template',
    '.env.dist',
    '.env.defaults',
    'example.env',
    'sample.env',
    'env.example',
    '.env.appStore.example',
    '.env.local.sample',
    '.env.ci-runner.template',
    '.env.e2e.example',
  ])('reads %s', (name) => {
    expect(isEnvFileName(name)).toBe(true);
  });

  it.each(['.env.staging', '.env.a.b.example', `.env.${'x'.repeat(65)}.example`, '.env..example', 'env', '.envrc', 'production.env', '.env.example.bak', 'a/.env'])(
    'ignores %s',
    (name) => {
      expect(isEnvFileName(name)).toBe(false);
    },
  );

  it('treats .env.example and the template names as declaration files, never a machine’s values', () => {
    for (const name of ['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.defaults', 'example.env', 'sample.env', 'env.example', '.env.appStore.example', '.env.x.sample', '.env.x.template']) {
      expect(isDeclarationFile(name), name).toBe(true);
    }
    for (const name of ['.env', '.env.local', '.env.production', '.env.test.local', '.env.staging']) {
      expect(isDeclarationFile(name), name).toBe(false);
    }
  });

  it('orders the pre-0.3.0 names first, then the other fixed names, then the rest by name', () => {
    expect(sortEnvFileNames(['.env.zeta.example', 'env.example', '.env', '.env.appStore.example', '.env.sample', '.env.example', '.env'])).toEqual([
      '.env.example',
      '.env',
      '.env.sample',
      'env.example',
      '.env.appStore.example',
      '.env.zeta.example',
    ]);
    expect(compareEnvFileNames('.env.production', '.env.local')).toBeGreaterThan(0);
  });
});
