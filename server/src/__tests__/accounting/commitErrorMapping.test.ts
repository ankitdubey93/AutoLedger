import { describe, expect, it } from 'vitest';
import { ApiError } from '../../utils/apiError.js';
import { commitErrorToApiError } from '../../services/accounting/migrationImportService.js';

/** Unit tier: the post-ROLLBACK pg error mapping of a migration-import commit, with fake error objects. */
describe('commitErrorToApiError', () => {
  const retry = 'Another user was posting at the same time — nothing was imported. Commit again.';

  it('maps a deadlock (40P01) and a serialization failure (40001) to a 409 "commit again"', () => {
    for (const code of ['40P01', '40001']) {
      const mapped = commitErrorToApiError({ code });
      expect(mapped).toBeInstanceOf(ApiError);
      expect(mapped?.status).toBe(409);
      expect(mapped?.message).toBe(retry);
    }
  });

  it('keeps the unique and foreign-key mappings', () => {
    const dup = commitErrorToApiError({ code: '23505', constraint: 'ux_migration_imports_one_committed_opening' });
    expect(dup?.status).toBe(409);
    expect(dup?.message).toBe('This organization already has a committed opening-balance import');
    const fk = commitErrorToApiError({ code: '23503' });
    expect(fk?.status).toBe(422);
    expect(fk?.message).toBe('A referenced account does not exist');
  });

  it('returns null for anything else', () => {
    expect(commitErrorToApiError({ code: '23505', constraint: 'other' })).toBeNull();
    expect(commitErrorToApiError(new Error('boom'))).toBeNull();
  });
});
