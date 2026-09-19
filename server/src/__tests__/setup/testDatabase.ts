/**
 * The database the integration tests run against — deliberately not the dev
 * one, so `TRUNCATE` between tests can never wipe data you were looking at.
 *
 * Imported by BOTH vitest.config.ts (for the workers' `env`) and globalSetup
 * (which creates it). That sharing is the point: `vitest.config.ts`'s `env`
 * block is applied to test *workers* only, not to the globalSetup process,
 * which reads its environment from dotenv and would otherwise happily migrate
 * and truncate `autodb`.
 */
export const TEST_DATABASE = 'autodb_test';

/**
 * The port of the `postgres-test` container — a SEPARATE cluster from the dev
 * one on 5432, running with `fsync=off`.
 *
 * `resetTables()` TRUNCATEs ~55 tables before almost every test, and TRUNCATE
 * fsyncs a new relation file per table and index: 2055 ms with fsync on, 69 ms
 * with it off. That one setting was most of a 35-minute suite. It cannot be
 * scoped to a database — `fsync` is cluster-wide — so the tests get their own
 * cluster instead of trading away `autodb`'s durability.
 *
 * Read from the environment for the same reason the rest of the connection is:
 * `docker-compose.yml` publishes `${PG_TEST_PORT:-5433}`.
 */
export const TEST_PG_PORT = process.env.PG_TEST_PORT ?? '5433';

/**
 * How many parallel workers the integration project may use, and therefore
 * how many database clones globalSetup creates.
 *
 * 3, not 4 (the core count): each fork re-imports all 80 services plus
 * sharp/pdfjs/tesseract, and this machine has 7.3 GB with swap already
 * under pressure. Memory binds before cores do here.
 */
export const TEST_MAX_WORKERS = 3;
