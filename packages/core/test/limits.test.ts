import { describe, expect, it } from 'vitest';
import {
  createFetchBudget,
  HOST_CHECK_SPACING_MS,
  LimitExceededError,
  MAX_ENDPOINTS_PER_PROJECT,
  MAX_ENDPOINTS_PER_USER,
  MAX_INGEST_BODY_BYTES,
  MAX_PR_CHECK_BYTES,
  MAX_PR_CHECK_FILES,
} from '../src/limits';

const MB = 1024 * 1024;

describe('hard caps', () => {
  it('are the documented values', () => {
    expect({ MAX_ENDPOINTS_PER_PROJECT, MAX_ENDPOINTS_PER_USER, HOST_CHECK_SPACING_MS, MAX_INGEST_BODY_BYTES, MAX_PR_CHECK_FILES, MAX_PR_CHECK_BYTES }).toEqual({
      MAX_ENDPOINTS_PER_PROJECT: 100,
      MAX_ENDPOINTS_PER_USER: 500,
      HOST_CHECK_SPACING_MS: 10_000,
      MAX_INGEST_BODY_BYTES: 5 * MB,
      MAX_PR_CHECK_FILES: 2_000,
      MAX_PR_CHECK_BYTES: 20 * MB,
    });
  });
});

describe('createFetchBudget (pull request checks)', () => {
  const caught = (fn: () => void) => {
    try {
      fn();
    } catch (error) {
      return error as LimitExceededError;
    }
    throw new Error('expected a LimitExceededError');
  };

  it('allows exactly 2,000 files, and refuses the 2,001st before it is fetched', () => {
    const budget = createFetchBudget();
    for (let i = 0; i < MAX_PR_CHECK_FILES; i++) budget.take(100);
    expect(budget.used).toEqual({ files: 2_000, bytes: 200_000 });
    const error = caught(() => budget.take(1));
    expect(error).toBeInstanceOf(LimitExceededError);
    expect(error.limit).toBe('prCheckFiles');
    expect(error.message).toBe('This pull request needs more than 2000 files; too large to check.');
    expect(budget.used.files).toBe(2_000);
  });

  it('allows exactly 20 MB, and refuses a file that would cross it', () => {
    const budget = createFetchBudget();
    budget.take(15 * MB);
    budget.take(5 * MB);
    expect(caught(() => budget.take(1)).limit).toBe('prCheckBytes');
    expect(budget.used).toEqual({ files: 2, bytes: 20 * MB });
  });

  it('counts the real size after download, so an understated tree entry cannot slip past', () => {
    const budget = createFetchBudget({ maxBytes: 1000 });
    budget.take(10); // the tree said 10 bytes...
    expect(caught(() => budget.verify(10, 2000)).limit).toBe('prCheckBytes'); // ...GitHub sent 2000
    const ok = createFetchBudget({ maxBytes: 1000 });
    ok.take(500);
    ok.verify(500, 480);
    expect(ok.used.bytes).toBe(480);
  });

  it('rejects nonsense sizes', () => {
    expect(() => createFetchBudget().take(-1)).toThrow(TypeError);
    expect(() => createFetchBudget().take(Number.NaN)).toThrow(TypeError);
  });
});
