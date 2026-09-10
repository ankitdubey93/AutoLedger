# Testing

```bash
cd server
npm test                  # single run
npm run test:watch        # watch mode
npm run test:coverage     # coverage — target ≥ 80% on services/, utils/, middleware/

cd client
npm test                  # Vitest + jsdom + Testing Library
```

**Current state: 868 server tests + 172 client tests** (as of Phase 9.5). The table below was last fully re-verified at Phase 7 — rows for Phase 8/9's own test files are not yet listed here; only Phase 9.5's are added in this pass.

Server, in `server/src/__tests__/`:

| File | Tier | Covers |
|---|---|---|
| `app.test.ts` | unit | Middleware wiring, 404 shape, no `X-Powered-By` |
| `health.test.ts` | integration | A real `SELECT 1` |
| `migrations.test.ts` | integration | Runner behaviour, SQL idempotency, checksum guard, every CHECK/UNIQUE/trigger/cascade in migration 001 |
| `auth.test.ts` | integration | register/login/check/refresh/logout, cookie flags, rotation, reuse detection |
| `tenantIsolation.test.ts` | integration | **The mandatory cross-tenant suite** |
| `validate.test.ts`, `jwt.test.ts`, `rbac.test.ts` | unit | Pure logic — no database |
| `platform/apps.test.ts` | integration | `GET /apps` auth requirement, registry shape, `isAppSlug` |
| `money.test.ts` | unit | Branded `Cents`, rounding half-away-from-zero, the `BIGINT`-string parser and its precision cliff |
| `rateLimit.test.ts` | unit | 429 after the limit, the error envelope, successful logins not counted |
| `ledger-core/accounts.test.ts` | integration | The 44-account seed, the tree, re-parent cycle rejection, **cross-tenant isolation** |
| `ledger-core/journals.test.ts` | integration | Posting, unbalanced rejection, reversal, ROLLBACK, forged `sourceType`, **cross-tenant isolation** |
| `ledger-core/ledgerConstraints.test.ts` | integration | **The database as the guardrail** — every case bypasses the service and writes raw SQL |
| `ledger-core/reports.test.ts` | integration | Trial balance totals, type-aware balances, `asOf`, and that no summary table exists |
| `platform/queue.test.ts` | integration (Redis) | Job processing via a real `Worker`, retry-then-dead-letter, `jobId` dedup |
| `platform/webhookEndpoints.test.ts` | integration | `assertDeliverableUrl`'s SSRF rules, signature unit cases, endpoint CRUD, secret never leaked, **cross-tenant isolation** |
| `platform/outboxDrain.test.ts` | integration (Redis) | `emitEvent` rollback-leaves-no-row proof, fan-out, idempotent re-drain, stale-delivery sweep, **cross-org isolation** |
| `platform/webhookDelivery.test.ts` | integration (Redis, `fetch` stubbed) | Signed delivery, retry/status transitions, no-secret-in-body, **cross-tenant isolation** |
| `ledger-core/outboxEmission.test.ts` | integration | One case per event type from the real posting services, rollback emits nothing, **cross-org scoping** |
| `mimeSniff.test.ts` | unit | Magic-byte detection for PDF/PNG/JPEG, the CSV UTF-8-round-trip carve-out, a renamed-file spoof and an executable-disguised-as-PDF spoof both refused |
| `storageService.test.ts` | unit (real `fs` against `storage-test/`) | Idempotent `put`, the two-level hex fan-out path, cross-org isolation (`two orgs uploading identical bytes get two blobs`), `blobPath`'s traversal/non-UUID rejection |
| `platform/documents.test.ts` | integration | Upload idempotency (`201`→`200`), MIME/size rejection (`415`/`413`), role gates, pagination, download headers, attach/detach, **cross-tenant isolation** (3 cases: `GET`/`GET .../file`/`DELETE` on another org's document, all `404`) |
| `platform/documentConstraints.test.ts` | integration | **The database as the guardrail** — the composite FK rejecting a cross-tenant link, `0A000` on `UPDATE` for both tables, `23505`/`23514` constraint violations, cascade delete, the audit trail — all via raw SQL, bypassing the service |

Client, in `client/src/__tests__/`: `fetchWithAutoRefresh.test.ts` (single-flight refresh), `ProtectedRoute.test.tsx` (the `checking` state), `AppChooserPage.test.tsx` (a `building` app links, a `planned` app doesn't, API failure shows an error), `ledgerCoreMoney.test.ts` (the client's half of the integer-cents rule, including the balance check the entry form performs), and (Phase 7) `ledgerCoreWebhooks.test.tsx` / `ledgerCoreWebhookDeliveries.test.tsx`. (Phase 9.5) `DocumentsPage.test.tsx` (upload/list/delete, the `415` message surfaced verbatim, Delete hidden while linked) and `AttachmentsPanel.test.tsx` (upload-then-link ordering, a `409` rendered as "Already attached to this record", detach-after-confirm, `readOnly` hiding every control).

Integration tests need `docker compose up -d postgres`; they are not mocked and will fail if it is down, which is the point. From Phase 7, tests that exercise the job queue also need `docker compose up -d redis` — `globalSetup` flushes Redis database index **1** (never index 0) before the run, the same `autodb_test`-not-`autodb` discipline applied to Redis.

There is no CI yet. The prior build's `entrypoint.sh` ran the suite before server startup; that gate has no host equivalent and belongs in CI when it is set up.

Tests live in `server/src/__tests__/`, mirroring the source layout — platform tests under `__tests__/platform/`, an app's tests under `__tests__/<app-slug>/` (e.g. `__tests__/ledger-core/journalService.test.ts`). One test root and one test database for the whole suite; apps do not get their own. Set `globals: true` in `vitest.config.ts` so `describe`/`it`/`expect` need no import.

### Test database

The suite runs against **`autodb_test`, never `autodb`**, so its `TRUNCATE` between tests cannot wipe data you were looking at. `vitest.config.ts` sets `PG_DATABASE` and fixed token secrets in `test.env` — that overrides `server/.env` because dotenv never overwrites an existing key, so the suite does not depend on your local config.

`globalSetup` creates the database if absent and applies migrations, so `npm test` works on a fresh checkout with no manual step.

Two things that are easy to get wrong here, both learned the hard way:

- **`test.env` applies to test *workers*, not to `globalSetup`.** globalSetup reads its environment from dotenv, so taking `PG_DATABASE` from `process.env` there silently migrates and truncates the *development* database. The name lives in one shared constant, `__tests__/setup/testDatabase.ts`, imported by both.
- **`fileParallelism: false` is required.** Vitest runs test files in parallel workers by default; these files share one database and truncate between tests, so parallel files delete each other's fixtures mid-assertion — producing failures that look exactly like tenant-isolation bugs. This does not change per app: `autodb_test` and `fileParallelism: false` stay suite-wide, not per-app, or the same failure mode reappears the moment two apps' tests run at once.

## Two tiers, both required

### Unit tests

Mock the pool with `vi.mock('../db/connect')`. Cover pure logic:

- cents conversion and rounding
- double-entry balance validation
- FSM transition legality
- BOM cycle detection
- report math

### Integration tests

Run against a **real PostgreSQL database** with migrations applied. The prior build had none, so its CHECK constraints, triggers, and migrations were never verified by CI. These must exist from Phase 1 and must cover:

- Migrations apply cleanly from empty, and are idempotent on re-run
- DB constraints actually reject bad rows (`chk_exclusive_debit_credit`, `chk_line_nonzero`, `UNIQUE (org_id, code)`, `UNIQUE (LOWER(email))`)
- Triggers fire (`updated_at`, later `audit_logs` snapshots)
- **Cross-tenant isolation**: a user in org A cannot read or write any row in org B, for every endpoint

**Constraint and trigger tests assert the SQLSTATE, not the message string.** `23505` for a unique violation, `23514` for a CHECK, `0A000` for the immutability trigger. Messages get reworded; error codes are the contract.

From Phase 3 a third thing must be tested, and it is easy to get wrong: **the deferred balance trigger fires at `COMMIT`, not at `INSERT`.** A test that inserts one unbalanced line and expects an immediate rejection will pass for the wrong reason or fail confusingly. The assertion belongs on the `COMMIT`:

```ts
await client.query('BEGIN');
await client.query('INSERT INTO ledger_lines ...');   // succeeds — deferred
await client.query('INSERT INTO ledger_lines ...');   // succeeds — deferred
await expect(client.query('COMMIT')).rejects.toThrow(/balance/i);
```

Write these against the raw pool, deliberately bypassing the service. The point of the trigger is that it holds when the service is not involved, so a test that goes through `journalService` proves the service, not the database.

### The cross-tenant fixture

`tenantIsolation.test.ts` establishes the shape every later module should copy: **user A** in org A only, **user C** in org B only, and **user B in both**.

User B is the one people leave out, and the one that makes the suite meaningful. Without a user who legitimately spans both tenants, a bug that returns an empty list to *everybody* passes every isolation assertion. The suite therefore checks both directions: A must never see C, and B — after switching — must actually see C.

It also asserts against the **raw response text**, not just the parsed shape, so a leak through some field nobody thought to assert on still fails; and it sends a forged `orgId` simultaneously in the query string, an `X-Org-Id` header and the body, asserting the response is byte-identical to the honest one.

## Every new module ships with tests

At minimum:

1. The invariant it enforces (balance, stock non-negativity, legal FSM transitions)
2. Its ROLLBACK path under a mid-transaction failure
3. Its `org_id` authorization scoping

**A module without a cross-tenant isolation test is not done — one per app, not one for the whole suite.** `tenantIsolation.test.ts` covers the platform tables (`organizations`, `organization_members`); each app's first org-scoped table needs its own instance of the same fixture shape, because a bug in one app's scoping is invisible to a test that only ever queries another app's tables.

**No test makes a network call.** From Phase 10 (vision extraction) and Phase 17 (QuickBooks) the codebase talks to external APIs; those are stubbed at the `fetch` boundary in tests, always. A suite that needs an API key to pass is a suite that fails in CI and gets skipped, and a stubbed call is also the only way to test the error paths — a rate limit, a truncated response, an expired token — that matter most and never happen on demand.

---

Why Vitest rather than Jest, and the patterns for writing these tests — AAA, `it.each`, asserting on rejections, test doubles, `supertest`, and the `vi.mock` hoisting trap — are in [study/tooling/testing-with-vitest.md](../study/tooling/testing-with-vitest.md).
