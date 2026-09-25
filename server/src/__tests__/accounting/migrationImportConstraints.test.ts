import { afterAll, beforeEach, expect, it } from 'vitest';
import { closePool, pool } from '../../db/connect.js';
import { createUserWithOrg, resetTables } from '../helpers/factories.js';
import type { SeededUser } from '../helpers/factories.js';

/**
 * The database as the guardrail, not the application — migration 029's
 * constraints proven directly against `pool`, bypassing
 * migrationImportService entirely, so they hold regardless of what wrote
 * the row (same discipline as bankConstraints.test.ts).
 */

const CHECK_VIOLATION = '23514';

async function errorCode(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err) {
      return typeof err.code === 'string' ? err.code : undefined;
    }
  }
  return undefined;
}

let user: SeededUser;
let orgId: string;

async function insertImport(kind: 'CHART_OF_ACCOUNTS' | 'OPENING_BALANCES' = 'CHART_OF_ACCOUNTS'): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO migration_imports (org_id, kind, file_name, delimiter, row_count, created_by)
     VALUES ($1, $2, 'fixture.csv', ',', 0, $3) RETURNING id`,
    [orgId, kind, user.id],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('no import id');
  return id;
}

beforeEach(async () => {
  await resetTables();
  user = await createUserWithOrg({ label: 'migconstr', orgName: 'Migration Constraints Org' });
  orgId = user.orgId;
});

afterAll(closePool);

it('a row with both debit and credit non-zero is rejected by chk_migration_rows_one_side', async () => {
  const importId = await insertImport('OPENING_BALANCES');
  const code = await errorCode(() =>
    pool.query(
      `INSERT INTO migration_import_rows (org_id, import_id, row_number, account_code, debit_cents, credit_cents)
       VALUES ($1, $2, 2, '1110', 100, 100)`,
      [orgId, importId],
    ),
  );
  expect(code).toBe(CHECK_VIOLATION);
});

it('a VALID row carrying errors is rejected by chk_migration_rows_valid_has_no_errors', async () => {
  const importId = await insertImport('OPENING_BALANCES');
  const code = await errorCode(() =>
    pool.query(
      `INSERT INTO migration_import_rows (org_id, import_id, row_number, account_code, status, errors)
       VALUES ($1, $2, 2, '1110', 'VALID', ARRAY['something is wrong'])`,
      [orgId, importId],
    ),
  );
  expect(code).toBe(CHECK_VIOLATION);
});

it('a COMMITTED import with a null committed_at is rejected', async () => {
  const importId = await insertImport();
  const code = await errorCode(() =>
    pool.query("UPDATE migration_imports SET status = 'COMMITTED', committed_at = NULL WHERE id = $1", [
      importId,
    ]),
  );
  expect(code).toBe(CHECK_VIOLATION);
});

it('a journal_entry_id on a CHART_OF_ACCOUNTS import is rejected', async () => {
  const importId = await insertImport('CHART_OF_ACCOUNTS');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO journal_entries (org_id, created_by, entry_date, description)
       VALUES ($1, $2, '2026-01-01', 'fixture') RETURNING id`,
      [orgId, user.id],
    );
    const entryId = rows[0]?.id;
    const code = await errorCode(() =>
      client.query('UPDATE migration_imports SET journal_entry_id = $1 WHERE id = $2', [entryId, importId]),
    );
    expect(code).toBe(CHECK_VIOLATION);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

it('deleting an import cascades its rows', async () => {
  const importId = await insertImport('OPENING_BALANCES');
  await pool.query(
    `INSERT INTO migration_import_rows (org_id, import_id, row_number, account_code, debit_cents, credit_cents)
     VALUES ($1, $2, 2, '1110', 100, 0)`,
    [orgId, importId],
  );

  await pool.query('DELETE FROM migration_imports WHERE id = $1', [importId]);

  const { rows } = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM migration_import_rows WHERE import_id = $1',
    [importId],
  );
  expect(rows[0]?.count).toBe('0');
});
