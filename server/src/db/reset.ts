import { pool } from './connect.js';
import { env } from '../config/env.js';
import { runMigrations } from './migrate.js';

/**
 * Dev-only: drop every object in the public schema and re-apply migrations from
 * scratch. Faster and more honest than hand-editing tables when a migration is
 * still being written — the alternative is a database whose shape nobody can
 * reproduce from the repo.
 *
 * Works because `autodb_user` owns the database it created (POSTGRES_USER /
 * POSTGRES_DB in docker-compose.yml).
 */
export async function resetDatabase(): Promise<void> {
  // Refuse before touching anything. There is no confirmation prompt to
  // mistype and no flag to remember — production simply cannot reach the drop.
  if (env.isProduction) {
    throw new Error('resetDatabase() refuses to run with NODE_ENV=production');
  }

  console.log(`[reset] dropping schema public in "${env.PG_DATABASE}"`);
  // CASCADE takes the tables, indexes, triggers and the set_updated_at()
  // function with it. Recreating the schema restores the default search_path.
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');

  const { applied } = await runMigrations();
  console.log(`[reset] rebuilt — ${applied.length} migration(s) applied`);
}

try {
  await resetDatabase();
  await pool.end();
} catch (err) {
  console.error('[reset] failed:', err instanceof Error ? err.message : err);
  await pool.end();
  process.exit(1);
}
