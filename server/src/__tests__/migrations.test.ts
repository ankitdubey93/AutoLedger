import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool, closePool } from '../db/connect.js';
import { runMigrations } from '../db/migrate.js';
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

describe('migration runner', () => {
  it('has applied 001 and recorded it in the ledger', async () => {
    const { rows } = await pool.query<{ version: string; filename: string; checksum: string }>(
      'SELECT version, filename, checksum FROM schema_migrations ORDER BY version',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe('001');
    expect(rows[0]?.filename).toBe('001_organizations_and_users.sql');
    // 64 hex characters — a real SHA-256, not a placeholder.
    expect(rows[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is a no-op when everything is already applied', async () => {
    const { applied, skipped } = await runMigrations();
    expect(applied).toEqual([]);
    expect(skipped).toEqual(['001_organizations_and_users.sql']);
  });

  it('the SQL itself is idempotent, not just the ledger', async () => {
    // Re-running the runner only proves the bookkeeping works. Clearing the
    // ledger forces the file to execute a second time against a database that
    // already has every object in it — which is what "additive and idempotent"
    // in guardrails rule 13 actually demands.
    await pool.query('DELETE FROM schema_migrations');

    const { applied } = await runMigrations();
    expect(applied).toEqual(['001_organizations_and_users.sql']);
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
