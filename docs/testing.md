# Testing

```bash
cd server
npm test                  # single run
npm run test:watch        # watch mode
npm run test:coverage     # coverage — target ≥ 80% on services/ and utils/
```

**Current state: 4 tests.** `__tests__/app.test.ts` (unit — middleware wiring, 404 shape, no `X-Powered-By`) and `__tests__/health.test.ts` (integration — a real `SELECT 1` against the Postgres container). Integration tests need `docker compose up -d postgres`; they are not mocked and will fail if it is down, which is the point.

There is no CI yet. The prior build's `entrypoint.sh` ran the suite before server startup; that gate has no host equivalent and belongs in CI when it is set up.

Tests live in `server/src/__tests__/`, mirroring the source layout (`__tests__/inventory/stockService.test.ts`). Set `globals: true` in `vitest.config.ts` so `describe`/`it`/`expect` need no import.

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

## Every new module ships with tests

At minimum:

1. The invariant it enforces (balance, stock non-negativity, legal FSM transitions)
2. Its ROLLBACK path under a mid-transaction failure
3. Its `org_id` authorization scoping

**A module without a cross-tenant isolation test is not done.**

---

Why Vitest rather than Jest, and the patterns for writing these tests — AAA, `it.each`, asserting on rejections, test doubles, `supertest`, and the `vi.mock` hoisting trap — are in [study/tooling/testing-with-vitest.md](../study/tooling/testing-with-vitest.md).
