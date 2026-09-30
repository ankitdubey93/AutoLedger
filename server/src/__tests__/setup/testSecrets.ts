/**
 * The token secrets the test suite runs with — obviously fake, never valid
 * anywhere else. One definition, used by both places that need it:
 *
 *   - vitest.config.ts's `env` block, which reaches the test workers;
 *   - globalSetup.ts, which runs in the main process that `env` block never
 *     reaches, and imports config/env.ts (via the migration runner).
 *
 * Before 2026-09-30 only the first existed. Locally, server/.env quietly
 * supplied the secrets to globalSetup; in CI there is no .env, and the first
 * CI run failed with "ACCESS_TOKEN_SECRET is required".
 */
export const TEST_ACCESS_TOKEN_SECRET = 'test-access-secret-not-for-any-real-deployment-0001';
export const TEST_REFRESH_TOKEN_SECRET = 'test-refresh-secret-not-for-any-real-deployment-0002';
