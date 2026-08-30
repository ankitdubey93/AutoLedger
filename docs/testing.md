# Testing

```bash
cd server
npm test                  # single run
npm run test:watch        # watch mode
npm run test:coverage     # coverage — target ≥ 80% on services/, utils/, middleware/

cd client
npm test                  # Vitest + jsdom + Testing Library
```

**Current state: 91 server tests + 12 client tests.**

Server, in `server/src/__tests__/`:

| File | Tier | Covers |
|---|---|---|
| `app.test.ts` | unit | Middleware wiring, 404 shape, no `X-Powered-By` |
| `health.test.ts` | integration | A real `SELECT 1` |
| `migrations.test.ts` | integration | Runner behaviour, SQL idempotency, checksum guard, every CHECK/UNIQUE/trigger/cascade in migration 001 |
| `auth.test.ts` | integration | register/login/check/refresh/logout, cookie flags, rotation, reuse detection |
| `tenantIsolation.test.ts` | integration | **The mandatory cross-tenant suite** |
| `validate.test.ts`, `jwt.test.ts`, `rbac.test.ts` | unit | Pure logic — no database |

Client, in `client/src/__tests__/`: `fetchWithAutoRefresh.test.ts` (single-flight refresh) and `ProtectedRoute.test.tsx` (the `checking` state).

Integration tests need `docker compose up -d postgres`; they are not mocked and will fail if it is down, which is the point.

There is no CI yet. The prior build's `entrypoint.sh` ran the suite before server startup; that gate has no host equivalent and belongs in CI when it is set up.

Tests live in `server/src/__tests__/`, mirroring the source layout (`__tests__/inventory/stockService.test.ts`). Set `globals: true` in `vitest.config.ts` so `describe`/`it`/`expect` need no import.

### Test database

The suite runs against **`autodb_test`, never `autodb`**, so its `TRUNCATE` between tests cannot wipe data you were looking at. `vitest.config.ts` sets `PG_DATABASE` and fixed token secrets in `test.env` — that overrides `server/.env` because dotenv never overwrites an existing key, so the suite does not depend on your local config.

`globalSetup` creates the database if absent and applies migrations, so `npm test` works on a fresh checkout with no manual step.

Two things that are easy to get wrong here, both learned the hard way:

- **`test.env` applies to test *workers*, not to `globalSetup`.** globalSetup reads its environment from dotenv, so taking `PG_DATABASE` from `process.env` there silently migrates and truncates the *development* database. The name lives in one shared constant, `__tests__/setup/testDatabase.ts`, imported by both.
- **`fileParallelism: false` is required.** Vitest runs test files in parallel workers by default; these files share one database and truncate between tests, so parallel files delete each other's fixtures mid-assertion — producing failures that look exactly like tenant-isolation bugs.

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

### The cross-tenant fixture

`tenantIsolation.test.ts` establishes the shape every later module should copy: **user A** in org A only, **user C** in org B only, and **user B in both**.

User B is the one people leave out, and the one that makes the suite meaningful. Without a user who legitimately spans both tenants, a bug that returns an empty list to *everybody* passes every isolation assertion. The suite therefore checks both directions: A must never see C, and B — after switching — must actually see C.

It also asserts against the **raw response text**, not just the parsed shape, so a leak through some field nobody thought to assert on still fails; and it sends a forged `orgId` simultaneously in the query string, an `X-Org-Id` header and the body, asserting the response is byte-identical to the honest one.

## Every new module ships with tests

At minimum:

1. The invariant it enforces (balance, stock non-negativity, legal FSM transitions)
2. Its ROLLBACK path under a mid-transaction failure
3. Its `org_id` authorization scoping

**A module without a cross-tenant isolation test is not done.**

---

Why Vitest rather than Jest, and the patterns for writing these tests — AAA, `it.each`, asserting on rejections, test doubles, `supertest`, and the `vi.mock` hoisting trap — are in [study/tooling/testing-with-vitest.md](../study/tooling/testing-with-vitest.md).
