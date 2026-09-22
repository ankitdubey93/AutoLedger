import { describe, expect, it } from 'vitest';
import { validateAppSelection } from '../services/organizationAppService.js';
import { ApiError } from '../utils/apiError.js';

/**
 * Pure unit tier for Phase 27's selection rules — no database. The rules:
 * known slug, not `planned`, every `requires` present in the same set.
 */

function rejection(appSlugs: string[]): ApiError {
  try {
    validateAppSelection(appSlugs);
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected validateAppSelection to throw');
}

describe('validateAppSelection', () => {
  it('dedupes, keeping first-seen order', () => {
    expect(validateAppSelection(['ledger-core', 'ledger-core'])).toEqual(['ledger-core']);
  });

  it('accepts an app together with what it requires', () => {
    expect(validateAppSelection(['ap-flow', 'ledger-core'])).toEqual(['ap-flow', 'ledger-core']);
  });

  it('rejects an app whose requirement is missing', () => {
    const err = rejection(['ap-flow']);
    expect(err.status).toBe(422);
    expect(err.message).toBe('AP-Flow requires LedgerCore');
  });

  it('rejects an unknown slug', () => {
    const err = rejection(['nope']);
    expect(err.status).toBe(422);
    expect(err.message).toBe('Unknown app "nope"');
  });

  it('accepts an app with no requirements on its own', () => {
    expect(validateAppSelection(['taxguard'])).toEqual(['taxguard']);
  });
});
