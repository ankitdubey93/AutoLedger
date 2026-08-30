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
