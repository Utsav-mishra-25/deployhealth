import { describe, expect, it } from 'vitest';
import { prResult } from '@/components/pr-checks';

describe('the result shown for a pull request check', () => {
  const base = { undeclared: 0, envFiles: 0, secretHits: 0 };
  it('reads "Not checked" for a neutral check that flagged nothing (can\'t check, too large, couldn\'t finish)', () => {
    expect(prResult({ ...base, conclusion: 'neutral' })).toBe('unchecked');
  });
  it('keeps Flagged for a neutral check that flagged something, and Passed / Failed as they are', () => {
    expect(prResult({ ...base, conclusion: 'neutral', undeclared: 1 })).toBe('neutral');
    expect(prResult({ ...base, conclusion: 'neutral', envFiles: 1 })).toBe('neutral');
    expect(prResult({ ...base, conclusion: 'neutral', secretHits: 1 })).toBe('neutral');
    expect(prResult({ ...base, conclusion: 'success' })).toBe('success');
    expect(prResult({ ...base, conclusion: 'failure', secretHits: 2 })).toBe('failure');
  });
});
