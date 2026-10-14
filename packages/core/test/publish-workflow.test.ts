import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const yaml = readFileSync(fileURLToPath(new URL('../../../.github/workflows/publish-cli.yml', import.meta.url)), 'utf8');
const jobsStart = yaml.indexOf('\njobs:\n');
const buildJob = yaml.slice(yaml.indexOf('\n  build:\n'), yaml.indexOf('\n  publish:\n'));
const publishJob = yaml.slice(yaml.indexOf('\n  publish:\n'));

describe('the Publish CLI workflow (.github/workflows/publish-cli.yml)', () => {
  it('pins every action by full commit SHA, with its version in a comment', () => {
    const uses = [...yaml.matchAll(/uses:\s*(\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThan(0);
    for (const [, ref, rest] of uses) {
      expect(ref, ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      expect(rest, ref).toMatch(/# v\d+\.\d+\.\d+$/);
    }
  });

  it('pins the npm CLI exactly', () => {
    const installs = [...yaml.matchAll(/npm install -g (\S+)/g)].map((m) => m[1]);
    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatch(/^npm@\d+\.\d+\.\d+$/);
  });

  it('builds and tests with no id-token; only the publish job, behind an environment, can mint one', () => {
    expect(jobsStart).toBeGreaterThan(0);
    // Workflow-level permissions grant no id-token (comment lines aside).
    const topLevel = yaml.slice(0, jobsStart).split('\n').filter((line) => !line.startsWith('#'));
    expect(topLevel.join('\n')).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(topLevel.join('\n')).not.toContain('id-token');
    expect(buildJob).toContain('pnpm --filter @deployhealth/core test');
    expect(buildJob).toContain('build:npm');
    expect(buildJob).not.toContain('id-token');
    expect(buildJob).not.toContain('npm publish');
    expect(buildJob).toContain('actions/upload-artifact@');

    expect(publishJob).toContain('needs: build');
    expect(publishJob).toMatch(/^ {4}environment: npm-publish$/m);
    expect(publishJob).toMatch(/^ {6}id-token: write/m);
    expect(publishJob).toContain('actions/download-artifact@');
    // The publish job never checks out or installs the repository: it only gets the built package.
    expect(publishJob).not.toContain('actions/checkout@');
    expect(publishJob).not.toContain('pnpm');
    expect(publishJob).toContain('npm publish --provenance');
  });

  it('only runs by hand, from main', () => {
    expect(yaml).toMatch(/^on:\n {2}workflow_dispatch:\n\n/m);
    expect(buildJob).toContain("if: github.ref == 'refs/heads/main'");
    expect(publishJob).toContain("if: github.ref == 'refs/heads/main'");
  });
});
