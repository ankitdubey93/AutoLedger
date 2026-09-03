import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pool } from './connect.js';
import { MIGRATIONS_ADVISORY_LOCK_KEY } from '../config/constants.js';

/**
 * The migration runner. Applies every `.sql` file in `migrations/` that has not
 * been applied yet, in filename order, each inside its own transaction.
 *
 * PostgreSQL has *transactional DDL* — CREATE TABLE, ALTER TABLE and friends
 * roll back like any other statement. So a migration that fails halfway leaves
 * the database exactly as it was, and there is no such thing as a
 * "half-applied" file here. MySQL cannot do this, which is why migration tools
 * in that world need manual down-scripts and repair commands.
 *
 * See study/postgresql/migrations-and-schema-evolution.md.
 */

/**
 * `001_organizations_and_users.sql` — 3-digit prefix, snake_case, no gaps.
 *
 * The hyphen in the character class is deliberate and load-bearing: from Phase 3
 * a migration is tagged with the app that owns it, `NNN_<app-slug>_<subject>.sql`
 * (docs/schema.md), and every app slug in `config/apps.ts` may contain a hyphen —
 * `002_ledger-core_accounts.sql`. Without it the runner rejects the naming
 * convention the schema doc mandates. Platform migrations carry no app tag.
 *
 * Exported so the filename contract can be asserted directly rather than
 * inferred from a runner failure.
 */
export const MIGRATION_FILENAME = /^(\d{3})_[a-z0-9_-]+\.sql$/;

/**
 * `import.meta.dirname` would be shorter, but it is a Node-ESM-only property:
 * under Vitest the modules go through Vite's module runner, which populates
 * `import.meta.url` and not always `dirname`. Deriving it from the URL works
 * identically under tsx (src/), `node dist/`, and Vitest.
 */
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

interface Migration {
  version: string;
  filename: string;
  sql: string;
  checksum: string;
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Reads and validates the migration set. Rejects a duplicate or skipped prefix
 * rather than applying files in a surprising order — two developers each
 * adding `004_` on separate branches is the classic way a migration silently
 * never runs.
 */
async function loadMigrations(): Promise<Migration[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  const sqlFiles = entries.filter((name) => name.endsWith('.sql')).sort();

  const migrations: Migration[] = [];
  const seen = new Map<string, string>();

  for (const filename of sqlFiles) {
    const match = MIGRATION_FILENAME.exec(filename);
    if (!match) {
      throw new Error(
        `Invalid migration filename "${filename}". Expected NNN_snake_case.sql ` +
          'for a platform migration, or NNN_<app-slug>_<subject>.sql for an app ' +
          'migration, e.g. 002_ledger-core_accounts.sql (docs/schema.md).',
      );
    }

    // `match[1]` is `string | undefined` under noUncheckedIndexedAccess even
    // though the regex guarantees the group. The check is cheap; the assertion
    // it replaces would be a lie.
    const version = match[1];
    if (version === undefined) throw new Error(`Could not read version from "${filename}"`);

    const duplicate = seen.get(version);
    if (duplicate !== undefined) {
      throw new Error(
        `Duplicate migration prefix ${version}: "${duplicate}" and "${filename}". ` +
          'Prefixes are strictly sequential — renumber one of them.',
      );
    }
    seen.set(version, filename);

    const expected = String(migrations.length + 1).padStart(3, '0');
    if (version !== expected) {
      throw new Error(
        `Migration numbering gap: expected ${expected}_*.sql but found "${filename}". ` +
          'Prefixes must be sequential with no gaps.',
      );
    }

    const sql = await readFile(path.join(MIGRATIONS_DIR, filename), 'utf8');
    migrations.push({ version, filename, sql, checksum: sha256(sql) });
  }

  return migrations;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies all pending migrations. Safe to call concurrently: the advisory lock
 * serialises runners, so two servers booting at once cannot race.
 */
export async function runMigrations(): Promise<MigrationResult> {
  const migrations = await loadMigrations();

  // A dedicated client, held for the whole run. pg_advisory_lock is
  // SESSION-scoped, so it must be taken and released on one connection — and
  // it has to outlive the per-file transactions below, which rules out
  // pg_advisory_xact_lock.
  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATIONS_ADVISORY_LOCK_KEY]);

    // Created by the runner rather than by 001, so the ledger exists before
    // the first migration is consulted. IF NOT EXISTS keeps it idempotent.
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT PRIMARY KEY,
        filename   TEXT NOT NULL,
        checksum   TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ version: string; filename: string; checksum: string }>(
      'SELECT version, filename, checksum FROM schema_migrations',
    );
    const alreadyApplied = new Map(rows.map((r) => [r.version, r]));

    for (const migration of migrations) {
      const record = alreadyApplied.get(migration.version);

      if (record !== undefined) {
        // guardrails rule 13 says never edit an applied migration. Comparing
        // checksums turns that from a convention people remember into
        // something the tooling actually catches — an edited file that already
        // ran would otherwise diverge silently between environments forever.
        if (record.checksum !== migration.checksum) {
          throw new Error(
            `Migration ${migration.filename} has changed since it was applied.\n` +
              `  recorded: ${record.checksum}\n` +
              `  current:  ${migration.checksum}\n\n` +
              'Applied migrations are immutable (docs/guardrails.md rule 13). ' +
              'Revert the edit and write a new migration instead.',
          );
        }
        skipped.push(migration.filename);
        continue;
      }

      // One transaction per file. Transactional DDL means a throw here rolls
      // back the schema change AND the ledger insert together, so the two can
      // never disagree.
      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, filename, checksum) VALUES ($1, $2, $3)',
          [migration.version, migration.filename, migration.checksum],
        );
        await client.query('COMMIT');
        applied.push(migration.filename);
        console.log(`[migrate] applied ${migration.filename}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(
          `Migration ${migration.filename} failed and was rolled back: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
    }

    return { applied, skipped };
  } finally {
    // Released before the client goes back to the pool. A pooled connection
    // that still holds an advisory lock would block every future runner.
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATIONS_ADVISORY_LOCK_KEY]);
    client.release();
  }
}

/**
 * Only run when executed directly (`npm run migrate`), never when a test or
 * globalSetup imports runMigrations().
 *
 * `process.argv[1]` is `string | undefined` under noUncheckedIndexedAccess, so
 * the `?? ''` is load-bearing rather than defensive noise.
 */
const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (isDirectRun) {
  try {
    const { applied, skipped } = await runMigrations();
    console.log(
      applied.length === 0
        ? `[migrate] up to date — ${skipped.length} migration(s) already applied`
        : `[migrate] done — ${applied.length} applied, ${skipped.length} already up to date`,
    );
    await pool.end();
  } catch (err) {
    console.error('[migrate] failed:', err instanceof Error ? err.message : err);
    await pool.end();
    process.exit(1);
  }
}
