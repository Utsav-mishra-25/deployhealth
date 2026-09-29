import { CLI_BUNDLE_PATH } from '@deployhealth/core';
import { describe, expect, it } from 'vitest';
import config from '../next.config';

describe('next.config headers', () => {
  it('marks the old CLI download deprecated (RFC 9745) and links the migration note', async () => {
    const rules = await config.headers!();
    const rule = rules.find((r) => r.source === CLI_BUNDLE_PATH);
    expect(rule?.headers).toEqual([
      { key: 'Deprecation', value: '@1790640000' }, // 2026-09-29T00:00:00Z
      { key: 'Link', value: expect.stringMatching(/^<https:\/\/github\.com\/.+#deprecated-downloading-the-cli-from-your-instance>; rel="deprecation"$/) },
    ]);
    // Nothing else gets the header.
    expect(rules).toHaveLength(1);
  });
});
