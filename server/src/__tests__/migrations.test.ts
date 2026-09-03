import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool, closePool } from '../db/connect.js';
import { MIGRATION_FILENAME, runMigrations } from '../db/migrate.js';
import { resetTables, uniqueEmail } from './helpers/factories.js';

/**
 * Integration tier — a real PostgreSQL database with migrations applied.
 *
 * The prior build mocked the pool everywhere, so its CHECK constraints,
 * triggers and migrations were never once executed by a test. These assert the
 * database actually enforces what the schema claims, independently of any
 * application code that is also supposed to.
 */

/** Postgres SQLSTATEs, so a failed assertion names the constraint class. */
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

/** Extracts the SQLSTATE from a driver error without an `any` cast. */
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

afterAll(closePool);

/**
 * Pure assertions on the filename contract — no database involved. They live
 * here rather than in a file of their own because the rule they protect is a
 * migration rule, and it is one the runner enforces before it ever connects.
 */
describe('migration filename contract', () => {
  it('accepts a platform migration', () => {
    expect(MIGRATION_FILENAME.test('001_organizations_and_users.sql')).toBe(true);
  });

  it('accepts an app-tagged filename with a hyphenated slug', () => {
    // Every app slug in config/apps.ts may contain a hyphen. Rejecting these
    // would make the NNN_<app-slug>_<subject>.sql convention in docs/schema.md
    // unusable for ledger-core, ap-flow and fpa-engine alike.
    expect(MIGRATION_FILENAME.test('002_ledger-core_accounts.sql')).toBe(true);
    expect(MIGRATION_FILENAME.test('010_ap-flow_documents.sql')).toBe(true);
  });

  it('still rejects uppercase, spaces and a missing prefix', () => {
    expect(MIGRATION_FILENAME.test('002_Ledger Core.sql')).toBe(false);
    expect(MIGRATION_FILENAME.test('002_LedgerCore_accounts.sql')).toBe(false);
    expect(MIGRATION_FILENAME.test('2_ledger-core_accounts.sql')).toBe(false);
    expect(MIGRATION_FILENAME.test('002_ledger-core_accounts.txt')).toBe(false);
  });

  it('captures the version as the first group', () => {
    expect(MIGRATION_FILENAME.exec('004_ledger-core_journals.sql')?.[1]).toBe('004');
  });
});

/**
 * Expectations are derived from the migrations directory rather than
 * hard-coded, so adding a migration does not require editing this file. A
 * hard-coded list rots on every phase, and a rotting test gets "fixed" by
 * loosening it — which is precisely how the assertion that matters gets lost.
 */
const migrationsDir = path.join(fileURLToPath(new URL('../db/migrations', import.meta.url)));
const migrationFiles = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

describe('migration runner', () => {
  it('has applied every migration on disk and recorded each in the ledger', async () => {
    const { rows } = await pool.query<{ version: string; filename: string; checksum: string }>(
      'SELECT version, filename, checksum FROM schema_migrations ORDER BY version',
    );

    expect(rows.map((r) => r.filename)).toEqual(migrationFiles);
    // Prefixes are strictly sequential from 001, with no gaps.
    expect(rows.map((r) => r.version)).toEqual(
      migrationFiles.map((_, i) => String(i + 1).padStart(3, '0')),
    );
    // 64 hex characters each — real SHA-256s, not placeholders.
    for (const row of rows) expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is a no-op when everything is already applied', async () => {
    const { applied, skipped } = await runMigrations();
    expect(applied).toEqual([]);
    expect(skipped).toEqual(migrationFiles);
  });

  it('the SQL itself is idempotent, not just the ledger', async () => {
    // Re-running the runner only proves the bookkeeping works. Clearing the
    // ledger forces every file to execute a second time against a database that
    // already has every object in it — which is what "additive and idempotent"
    // in guardrails rule 13 actually demands. It is also the only check that
    // 003's backfill does not double-seed an organization that already has a
    // chart of accounts.
    await pool.query('DELETE FROM schema_migrations');

    const { applied } = await runMigrations();
    expect(applied).toEqual(migrationFiles);
  });

  it('refuses to run when an applied migration has been edited', async () => {
    await pool.query("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = '001'");

    await expect(runMigrations()).rejects.toThrow(/has changed since it was applied/);

    // Restore, or every later test in this file runs against a poisoned ledger.
    await pool.query('DELETE FROM schema_migrations');
    await runMigrations();
  });
});

describe('schema constraints', () => {
  beforeEach(resetTables);

  it('rejects two users whose emails differ only in case', async () => {
    const email = uniqueEmail('case');
    await pool.query('INSERT INTO users (email, password) VALUES ($1, $2)', [email, 'hash']);

    // guardrails rule 9. The prior build allowed this and then could not log
    // the second user in.
    const code = await errorCode(() =>
      pool.query('INSERT INTO users (email, password) VALUES ($1, $2)', [
        email.toUpperCase(),
        'hash',
      ]),
    );
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it('fires the updated_at trigger on UPDATE, leaving created_at alone', async () => {
    const { rows } = await pool.query<{ id: string; created_at: Date; updated_at: Date }>(
      'INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id, created_at, updated_at',
      [uniqueEmail('trigger'), 'hash'],
    );
    const before = rows[0];
    if (before === undefined) throw new Error('insert returned no row');

    // now() is transaction-scoped, so two statements in the same transaction
    // would produce an identical timestamp. These are separate statements, but
    // the clock still needs room to move.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const { rows: after } = await pool.query<{ created_at: Date; updated_at: Date }>(
      'UPDATE users SET name = $2 WHERE id = $1 RETURNING created_at, updated_at',
      [before.id, 'renamed'],
    );
    const row = after[0];
    if (row === undefined) throw new Error('update returned no row');

    expect(row.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    // If created_at moved, the trigger is overwriting more than it should.
    expect(row.created_at.getTime()).toBe(before.created_at.getTime());
  });

  it('rejects a role outside the four allowed values', async () => {
    const { rows: orgRows } = await pool.query<{ id: string }>(
      "INSERT INTO organizations (name, slug) VALUES ('Role Co', $1) RETURNING id",
      [`role-co-${Date.now()}`],
    );
    const { rows: userRows } = await pool.query<{ id: string }>(
      'INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id',
      [uniqueEmail('role'), 'hash'],
    );
    const orgId = orgRows[0]?.id;
    const userId = userRows[0]?.id;
    if (orgId === undefined || userId === undefined) throw new Error('fixture insert failed');

    const code = await errorCode(() =>
      pool.query('INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, $3)', [
        orgId,
        userId,
        'SUPERUSER',
      ]),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('rejects a lowercase currency code', async () => {
    const code = await errorCode(() =>
      pool.query('INSERT INTO organizations (name, slug, base_currency) VALUES ($1, $2, $3)', [
        'Currency Co',
        `currency-co-${Date.now()}`,
        'usd',
      ]),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it('rejects the same user joining one organization twice', async () => {
    const { rows: orgRows } = await pool.query<{ id: string }>(
      "INSERT INTO organizations (name, slug) VALUES ('Dup Co', $1) RETURNING id",
      [`dup-co-${Date.now()}`],
    );
    const { rows: userRows } = await pool.query<{ id: string }>(
      'INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id',
      [uniqueEmail('dup'), 'hash'],
    );
    const orgId = orgRows[0]?.id;
    const userId = userRows[0]?.id;
    if (orgId === undefined || userId === undefined) throw new Error('fixture insert failed');

    await pool.query('INSERT INTO organization_members (org_id, user_id, role) VALUES ($1,$2,$3)', [
      orgId,
      userId,
      'ADMIN',
    ]);

    const code = await errorCode(() =>
      pool.query('INSERT INTO organization_members (org_id, user_id, role) VALUES ($1,$2,$3)', [
        orgId,
        userId,
        'VIEWER',
      ]),
    );
    expect(code).toBe(UNIQUE_VIOLATION);
  });

  it('cascades memberships when an organization is deleted, but keeps the users', async () => {
    const { rows: orgRows } = await pool.query<{ id: string }>(
      "INSERT INTO organizations (name, slug) VALUES ('Cascade Co', $1) RETURNING id",
      [`cascade-co-${Date.now()}`],
    );
    const { rows: userRows } = await pool.query<{ id: string }>(
      'INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id',
      [uniqueEmail('cascade'), 'hash'],
    );
    const orgId = orgRows[0]?.id;
    const userId = userRows[0]?.id;
    if (orgId === undefined || userId === undefined) throw new Error('fixture insert failed');

    await pool.query('INSERT INTO organization_members (org_id, user_id, role) VALUES ($1,$2,$3)', [
      orgId,
      userId,
      'OWNER',
    ]);
    await pool.query('DELETE FROM organizations WHERE id = $1', [orgId]);

    // Tests the specific ON DELETE choices, not merely that FKs exist. A user
    // is a global identity and must outlive any one organization.
    const members = await pool.query('SELECT 1 FROM organization_members WHERE org_id = $1', [
      orgId,
    ]);
    const users = await pool.query('SELECT 1 FROM users WHERE id = $1', [userId]);

    expect(members.rowCount).toBe(0);
    expect(users.rowCount).toBe(1);
  });
});
