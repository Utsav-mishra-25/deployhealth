import { describe, expect, it } from 'vitest';
import { composeVariableNames, isComposeFileName } from '../src/compose';

describe('isComposeFileName', () => {
  it('matches docker-compose*.yml and compose*.yaml, not composer.yml or other YAML', () => {
    for (const name of ['docker-compose.yml', 'docker-compose.yaml', 'docker-compose.prod.yml', 'docker-compose-dev.yaml', 'compose.yml', 'compose.yaml', 'compose.override.yml']) {
      expect(isComposeFileName(name), name).toBe(true);
    }
    for (const name of ['composer.yml', 'docker-compose.json', 'compose', 'my-compose.yml', 'ci.yml', 'compose.yml.bak']) {
      expect(isComposeFileName(name), name).toBe(false);
    }
  });
});

describe('composeVariableNames', () => {
  it('reads every interpolation form', () => {
    const source = [
      'image: app:${BRACED}',
      'a: ${WITH_DEFAULT:-x}',
      'b: ${UNSET_DEFAULT-x}',
      'c: ${REQUIRED:?message}',
      'd: ${REQUIRED_UNSET?message}',
      'e: ${ALT:+x}',
      'f: ${ALT_UNSET+x}',
      'g: $PLAIN and $SECOND',
    ].join('\n');
    expect([...composeVariableNames(source)].sort()).toEqual(['ALT', 'ALT_UNSET', 'BRACED', 'PLAIN', 'REQUIRED', 'REQUIRED_UNSET', 'SECOND', 'UNSET_DEFAULT', 'WITH_DEFAULT']);
  });

  it('skips $$ escapes and full-line comments, and reads $$$VAR as a dollar sign then $VAR', () => {
    const source = ['command: echo $$ESCAPED $${ALSO_ESCAPED}', '  # ${COMMENTED}', 'x: $$$AFTER_ESCAPE', 'y: ${}', 'z: $1'].join('\n');
    expect([...composeVariableNames(source)]).toEqual(['AFTER_ESCAPE']);
  });
});
