import { defineConfig } from 'vitest/config';
import { TEST_DATABASE } from './src/__tests__/setup/testDatabase.js';

export default defineConfig({
  test: {
    // docs/testing.md: describe/it/expect available without imports.
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],

    // Creates autodb_test if absent and applies migrations, once, before any
    // test file runs. Self-healing on purpose — a setup step you have to
    // remember is a setup step that breaks for the next person.
    globalSetup: ['src/__tests__/setup/globalSetup.ts'],

    /**
     * Tests run against a SEPARATE database, never the dev one, so a truncate
     * cannot wipe data you were looking at.
     *
     * These win over server/.env because dotenv does not overwrite a key that
     * is already present in process.env, and Vitest applies `env` before the
     * test modules import config/env.ts. So the suite does not depend on what
     * happens to be in your local .env — including the token secrets.
     */
    env: {
      NODE_ENV: 'test',
      PG_DATABASE: TEST_DATABASE,
      ACCESS_TOKEN_SECRET: 'test-access-secret-not-for-any-real-deployment-0001',
      REFRESH_TOKEN_SECRET: 'test-refresh-secret-not-for-any-real-deployment-0002',
    },

    /**
     * Vitest runs test FILES in parallel workers by default. These files share
     * one database and truncate between tests, so parallel files would delete
     * each other's fixtures mid-assertion — producing failures that look
     * exactly like tenant-isolation bugs and waste an afternoon.
     *
     * At this suite size serial execution costs nothing. When it does start to
     * hurt, the fix is Vitest `projects` (parallel unit files, serial
     * integration files), not turning this back on.
     */
    fileParallelism: false,

    coverage: {
      provider: 'v8',
      // The coverage target applies to the layers that hold logic.
      // Controllers are thin adapters and routes are declarations.
      // Middleware IS logic — auth and rbac are decision points, not plumbing.
      include: ['src/services/**', 'src/utils/**', 'src/middleware/**'],
      reporter: ['text', 'html'],
    },
  },
});
