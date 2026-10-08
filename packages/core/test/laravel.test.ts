import { describe, expect, it } from 'vitest';
import { LARAVEL_FRAMEWORK_NAMES } from '../src/laravel';
import { ENV_NAME_PATTERN } from '../src/types';

describe('LARAVEL_FRAMEWORK_NAMES', () => {
  it('is the generated union: env var names only, no duplicates', () => {
    expect(LARAVEL_FRAMEWORK_NAMES.size).toBe(198);
    for (const name of LARAVEL_FRAMEWORK_NAMES) expect(name).toMatch(ENV_NAME_PATTERN);
  });

  it('holds what the framework and the skeleton read for an app (11.x through 13.x), not request data or its own flags', () => {
    for (const name of ['BCRYPT_ROUNDS', 'BROADCAST_CONNECTION', 'PHP_CLI_SERVER_WORKERS', 'APP_TIMEZONE', 'SESSION_COOKIE', 'MERCURE_URL', 'POSTMARK_API_KEY', 'RESEND_API_KEY', 'DB_SSLMODE']) {
      expect(LARAVEL_FRAMEWORK_NAMES.has(name), name).toBe(true);
    }
    for (const name of ['VITE_APP_NAME', 'HTTP_HOST', 'REQUEST_METHOD', 'LARAVEL_OCTANE', 'TEST_TOKEN', 'HERD_HOME', 'LARAVEL_CLOUD']) {
      expect(LARAVEL_FRAMEWORK_NAMES.has(name), name).toBe(false);
    }
  });
});
