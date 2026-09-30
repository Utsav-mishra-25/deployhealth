import { describe, expect, it } from 'vitest';
import { newMissingVars, newUndeclaredVars } from '../src/findings';
import type { EnvScope, RequiredVariable } from '../src/types';

const v = (var_name: string, scope: string, extra: Partial<RequiredVariable> = {}): RequiredVariable => ({ var_name, scope, defined_in: [], ...extra });
const ROOT_BARE: EnvScope[] = [
  { scope: '', env_files: [] },
  { scope: 'apps/web', env_files: ['.env.example'] },
];

describe('newUndeclaredVars (deploy correlation for scopes with no env file)', () => {
  it('lists variables the no-env-file scopes newly reference, sorted', () => {
    const variables = [v('STRIPE_KEY', ''), v('REDIS_URL', ''), v('DATABASE_URL', ''), v('WEB_ONLY', 'apps/web')];
    expect(newUndeclaredVars({ variables, envScopes: ROOT_BARE }, new Set(['DATABASE_URL']))).toEqual(['REDIS_URL', 'STRIPE_KEY']);
  });

  it('leaves out optional variables and scopes that have env files (those have MISSING rows)', () => {
    const variables = [v('WITH_DEFAULT', '', { optional: true }), v('NEW_IN_WEB', 'apps/web')];
    expect(newUndeclaredVars({ variables, envScopes: ROOT_BARE }, new Set())).toEqual([]);
  });

  it('counts every variable as new when there is no previous scan', () => {
    expect(newUndeclaredVars({ variables: [v('A', ''), v('B', '')], envScopes: ROOT_BARE }, null)).toEqual(['A', 'B']);
  });

  it('is empty for scans from CLIs before 0.2.0 (no env scopes), so they correlate as before', () => {
    expect(newUndeclaredVars({ variables: [v('A', '')], envScopes: null }, null)).toEqual([]);
  });

  it('works alongside newMissingVars, which is unchanged', () => {
    expect(newMissingVars([{ kind: 'missing', var_name: 'X' }], null)).toEqual(['X']);
  });
});
