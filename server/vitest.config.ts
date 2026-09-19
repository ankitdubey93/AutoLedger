import { defineConfig } from 'vitest/config';
import { TEST_MAX_WORKERS } from './src/__tests__/setup/testDatabase.js';

export default defineConfig({
  test: {
    // docs/testing.md: describe/it/expect available without imports.
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],

    // Evaluated in the worker BEFORE the test file (and therefore before
    // anything imports config/env.ts), so this is what gives each worker
    // its own PG_DATABASE/REDIS_DB/STORAGE_ROOT — see perWorkerEnv.ts.
    setupFiles: ['src/__tests__/setup/perWorkerEnv.ts'],

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
      // The `postgres-test` cluster (fsync=off), never the dev one on 5432 —
      // perWorkerEnv.ts sets this too; this is the default for anything that
      // somehow loads before it.
      PG_PORT: process.env.PG_TEST_PORT ?? '5433',
      ACCESS_TOKEN_SECRET: 'test-access-secret-not-for-any-real-deployment-0001',
      REFRESH_TOKEN_SECRET: 'test-refresh-secret-not-for-any-real-deployment-0002',
      // Index 1, never 0. globalSetup flushes this database before the suite;
      // flushing index 0 would wipe the dev queues you were watching.
      REDIS_DB: '1',
      // Never the dev store: the suite deletes this directory between files.
      STORAGE_ROOT: 'storage-test',
      // AP-Flow's provider selection (Phase 19). Pinned to the unconfigured
      // state for the same reason as the secrets above: a developer's local
      // .env legitimately carries a real AP_FLOW_AI_PROVIDER=gemini plus a
      // live GEMINI_API_KEY (needed to run the app), and without this pin
      // that leaks into the suite — a few cases assert the behaviour of an
      // UNCONFIGURED provider (e.g. extraction.test.ts's `returns 503 with
      // no client and no ANTHROPIC_API_KEY`) and silently start making real
      // network calls to a real model instead. Every case that wants a real
      // provider injects its own stub client or fetchImpl; none needs a key.
      AP_FLOW_AI_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: '',
      GEMINI_API_KEY: '',
      // Phase 19.2 — the identical pin, same reason: a developer's local
      // .env may carry real Google OAuth credentials and encryption key
      // (needed to run Drive intake locally). Every Drive test that wants a
      // real provider injects its own `deps` object; none needs these.
      GOOGLE_OAUTH_CLIENT_ID: '',
      GOOGLE_OAUTH_CLIENT_SECRET: '',
      INTEGRATION_ENCRYPTION_KEY: '',
    },

    /**
     * Files may run in parallel **because** each worker owns its own resources:
     * database `autodb_test_<n>`, Redis db `<n>` and `storage-test-<n>`, all
     * derived from `VITEST_POOL_ID` in setup/workerResources.ts. Without that,
     * parallel files truncate each other's fixtures mid-assertion and produce
     * failures that look exactly like tenant-isolation bugs.
     *
     * The cap is memory-driven, not core-driven: this machine has 4 cores but
     * only 7.3 GB, and each fork re-imports all 80 services plus
     * sharp/pdfjs/tesseract. `maxWorkers` — `poolOptions.forks.maxForks` does
     * not exist in Vitest 4.x. It must not exceed TEST_MAX_WORKERS, which is
     * how many databases globalSetup clones.
     */
    fileParallelism: true,
    maxWorkers: TEST_MAX_WORKERS,

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
