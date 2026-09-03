---
name: guardrail-review
description: Audit AutoLedger server code against the 16 hard rules — tenant scoping, no SQL in controllers, integer cents, parameterized queries, transaction client discipline, posted-document immutability, FK constraints, token handling, app-boundary namespacing. Use before committing, when finishing a module, on request for a review, or when asked whether code is safe to ship.
---

# Guardrail review

Audits a diff (or a directory) against the rules in [CLAUDE.md](../../../CLAUDE.md) and [docs/guardrails.md](../../../docs/guardrails.md). Four of these rules were violated by the prior build and the violations compounded until a rewrite was cheaper than a repair.

All greps below are `-r` — they already reach into an app's subfolder (`server/src/services/ledger-core/…`) as well as the unprefixed platform files (`server/src/services/authService.ts`). Nothing app-specific to add there; the review just covers more files as apps land.

## Scope the review

```bash
git status --short
git diff --stat HEAD
```

Review the changed files. If asked for a full audit, review all of `server/src/`.

## Detectors

Grep finds candidates; **you** confirm by reading. A grep hit is a lead, not a finding, and a clean grep is not a pass — rules 1 and 5 need a human read of every query.

### 1. Tenant scoping — the one that leaks data

Read **every** SQL string in the diff. For each, ask: is there an `org_id = $n` predicate, or a join to a table that carries one?

```bash
grep -rn "FROM \|JOIN \|UPDATE \|DELETE FROM \|INSERT INTO " server/src/services/
```

- A `SELECT`/`UPDATE`/`DELETE` without an `org_id` predicate is a **tenant data leak** — report it as the top finding regardless of what else is in the diff.
- `WHERE id = $1` alone is wrong even when the id came from a previous scoped query. Scope every statement.
- An `INSERT` must write `org_id` from `req.user.orgId`, never from the body.
- `user_id` used as an access check is a bug. It is `created_by` only.

Forged-org check:

```bash
grep -rn "req.headers\|req.body.orgId\|req.query.org\|req.params.orgId\|x-org" server/src/
```

Active org comes from the verified access token only.

### 2. No SQL in controllers

```bash
grep -rn "pool.query\|client.query\|pool.connect\|BEGIN\|COMMIT" server/src/controllers/
```

Any hit is a violation. Controllers extract input, call a service, format a response. This includes `authController`.

### 3. Money

```bash
grep -rn "DECIMAL\|NUMERIC(\|parseFloat\|toFixed\|Math.abs" server/src/
grep -rniE "(amount|price|total|balance|debit|credit)[a-z_]*\s*:\s*number" server/src/types/
```

- Any money column or field not in integer cents → violation.
- `Math.abs(d - c) < epsilon` for balance → violation. `isBalanced` is `totalDebitCents === totalCreditCents`.
- Cents conversion outside `utils/money.ts` → violation (duplicate rounding rules drift).

### 4. Parameterized queries

```bash
grep -rn '\${' server/src/services/ | grep -i "select\|insert\|update\|delete\|where\|order by"
```

Interpolation is allowed **only** for an identifier resolved through a constant whitelist map. Confirm the map exists, is `as const`, and has a fallback for unknown keys. Anything else → violation.

### 5. Transaction discipline

For every function containing `BEGIN`:

```bash
grep -rn -A 40 "client.query('BEGIN')" server/src/services/ | grep "pool.query"
```

- A `pool.query` between `BEGIN` and `COMMIT` silently escapes the transaction → violation.
- Missing `ROLLBACK` in `catch` or missing `client.release()` in `finally` → violation (pool exhaustion).
- Work after `COMMIT` inside the same function → violation. It is a queued job (Phase 7) or it is not part of the operation.

### 6. Immutability of posted documents

```bash
grep -rn "router.put\|router.patch\|router.delete" server/src/routes/
```

No `PUT`/`PATCH`/`DELETE` on a posted journal, invoice, receipt, or payroll run. Corrections are `POST /:id/reverse` writing a new entry linked by `reverses_entry_id`.

### 7. Ledger line invariant

A line has exactly one side populated. Confirm **both** the service check and the CHECK constraints `chk_line_nonzero` and `chk_exclusive_debit_credit` exist. One without the other is a violation.

### 8. Schema constraints

```bash
grep -rn "_id" server/src/db/migrations/ | grep -v "REFERENCES"
grep -rn "REFERENCES" server/src/db/migrations/ | grep -v "ON DELETE"
```

Every `*_id` needs a `REFERENCES` with an explicit `ON DELETE`. Every FK used in a join and every scope column needs an index.

### 9. Auth and tokens

```bash
grep -rn "JWT_SECRET" server/ docker-compose.yml .env.example
grep -rn "console.log" server/src/middleware/ server/src/utils/jwt.ts server/src/services/authService.ts
```

- `JWT_SECRET` must not exist anywhere. Only `ACCESS_TOKEN_SECRET` (15m) and `REFRESH_TOKEN_SECRET` (7d).
- A decoded token payload must never reach a log.
- Emails: lowercased on **both** write and read paths, backed by `UNIQUE (LOWER(email))`. Register-lowercase + login-exact locked users out of the prior build — check both sides.

### 10. FSM and enums

Status transitions come from one exported transition table validated in one place. Ad-hoc `status = 'APPROVED'` assignments scattered across services → violation. Account types are exactly the five; a sixth → violation.

### 11. Tests

```bash
ls server/src/__tests__/
```

A module with no cross-tenant isolation test **is not done** — report it as a blocking finding, not a nice-to-have. Also required: the invariant it enforces, and its ROLLBACK path.

### 12. Dependencies and phase order

```bash
git diff HEAD -- server/package.json client/package.json
```

Any new dependency must belong to the phase currently being built ([docs/development.md](../../../docs/development.md) dependency table). An ORM in the diff → violation, no exceptions. `ioredis`/`bullmq` before Phase 7 → violation. An LLM/embeddings SDK anywhere outside Phase 10 (AP-Flow vision extraction) and Phase 16 (TaxGuard AI) → violation — the "no LLM" ruling still applies to every other app.

### 13. App boundaries

```bash
grep -rn "org_id" server/src/services/*/  2>/dev/null | grep -v "\$"
grep -rln "req.params.appSlug\|req.params.app" server/src/services/ server/src/controllers/ 2>/dev/null
```

- The `:appSlug` route param must never be used as (or substitute for) the tenancy scope — `orgId` from the verified token is still the only predicate that matters. A service reading `req.params.appSlug` at all is a smell worth reading closely.
- An app's service querying a table that belongs to a different app (e.g. `ap-flow`'s service selecting from `journal_entries` directly instead of going through LedgerCore's `journalService`) → violation. Cross-app effects go through the GL via `source_type`/`source_id`, never a direct cross-app query.
- A slug not present in `server/src/config/apps.ts` reachable through any route → violation; unknown slugs must 404.

## Report

Order findings by blast radius: tenant leaks → money correctness → transaction/immutability → constraints → tests → style. For each: file:line, which rule, the concrete failure it causes, and the fix.

State plainly if the diff is clean. Do not manufacture findings to look thorough.
