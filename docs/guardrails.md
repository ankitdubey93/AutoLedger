# Engineering Guardrails

Full detail for the rules summarised in `CLAUDE.md`. These apply to every module. The prior codebase violated 1, 2, 3, and 7, and the violations compounded until a reset was cheaper than a repair (see [Lessons](#appendix--lessons-from-the-discarded-build)).

## 1. Controllers are thin HTTP adapters

Controllers only: extract and validate HTTP input, call a service, format the response. **Zero SQL. Zero business logic.**

```ts
// CORRECT
export const createJournalEntry = async (req, res, next) => {
  const { date, description, lines } = req.body;
  const entry = await journalService.createEntry(req.user.orgId, req.user.id, { date, description, lines });
  res.status(201).json({ success: true, entry });
};

// WRONG — SQL in controller
export const createJournalEntry = async (req, res, next) => {
  await pool.query('INSERT INTO ...');  // ← belongs in a service
};
```

The previous build leaked SQL into `authController` and `aiController` and it never got cleaned up. Catch it in review, every time.

## 2. Services own all DB logic

Every `pool.query` / `client.query` call lives under `src/services/`. Services take plain data arguments, return plain objects, and never touch `req`/`res`. **This includes auth** — there is an `authService.ts` from day one; the register/login/refresh/logout flow does not query the DB from a controller.

## 3. Money is integer cents — never floating point

Validation **and** storage are both in integer cents. There is no `DECIMAL` money column anywhere in the schema.

```ts
// CORRECT
const toCents = (n: number) => Math.round(Number(n) * 100);
const totalDebitCents  = lines.reduce((s, l) => s + toCents(l.debit), 0);
const totalCreditCents = lines.reduce((s, l) => s + toCents(l.credit), 0);
if (totalDebitCents !== totalCreditCents) throw new ApiError(400, "Entry is unbalanced.");

// WRONG
if (Math.abs(totalDebit - totalCredit) > 0.01) { ... }  // accumulates float error
```

Every money column is `BIGINT` cents — `debit_cents`, `credit_cents`, `amount_cents`, `unit_price_cents`. Conversion helpers live in one place, `utils/money.ts`. This applies to reports too: an `isBalanced` flag is an integer equality check, never an epsilon comparison.

## 4. A ledger line has exactly one side populated

Both `debit_cents > 0` and `credit_cents > 0` is invalid, and so is both being zero. Rejected in the service before the DB is touched, **and** enforced by CHECK constraints in the migration. Application validation and DB constraints are belt and braces — write both.

## 5. Parameterized queries only

Always `$1, $2, ...` with a values array. Never interpolate user input into SQL — not even "safe-looking" values like sort columns or table names. Whitelist identifiers against a constant map instead.

```ts
// CORRECT — whitelisted identifier
const SORT_COLUMNS = { date: 'entry_date', created: 'created_at' } as const;
const col = SORT_COLUMNS[req.query.sort] ?? 'entry_date';
await pool.query(`SELECT * FROM journal_entries WHERE org_id = $1 ORDER BY ${col}`, [orgId]);
```

## 6. Transaction safety

Use explicit `BEGIN` / `COMMIT` / `ROLLBACK` on a checked-out client. Inside a transaction block, **every** query must use that `client` — a stray `pool.query` runs on a different connection and silently escapes the transaction.

```ts
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('INSERT ...');   // client, not pool
  await client.query('COMMIT');
} catch (e) {
  await client.query('ROLLBACK');
  throw e;
} finally {
  client.release();
}
```

Never do post-`COMMIT` follow-up work inside the same function and call it part of the operation. If something must happen after commit, it is a queued job (Phase 5), not a fire-and-forget query with a swallowed error.

## 7. Tenant scoping is mandatory on every query

Every read and write is filtered by `org_id`. A query without an `org_id` predicate is a data-leak bug, full stop. Never trust an ID from the request body or params to imply ownership — always filter or join on the caller's `org_id` resolved by middleware.

```ts
// CORRECT
'SELECT * FROM accounts WHERE id = $1 AND org_id = $2'

// WRONG — caller could pass any account id in the database
'SELECT * FROM accounts WHERE id = $1'
```

`user_id` is **never** an access-control boundary. It appears on transactional rows only as a `created_by` audit field. See [architecture.md](architecture.md) for the tenancy model.

## 8. Token handling

- Access tokens: signed and verified with `ACCESS_TOKEN_SECRET` (15m)
- Refresh tokens: signed and verified with `REFRESH_TOKEN_SECRET` (7d)
- There is **no `JWT_SECRET`**. The prior build carried a legacy third secret that was read but unused — do not recreate it.
- Refresh tokens are persisted in `refresh_tokens` and deleted on logout
- Never log decoded token payloads

## 9. Financial documents are immutable once posted

Posted journals are append-only. Corrections happen through **reversing entries** — a new entry with debits and credits swapped, linked to the original via `reverses_entry_id` — never by mutating or deleting a posted row. There is no `PUT /journals/:id` and no `DELETE /journals/:id`; there is `POST /journals/:id/reverse`.

This propagates to every future module: posted invoices, goods receipts, and payroll runs get reversed, not edited.

## 10. State transitions use explicit finite state machines

Documents with a lifecycle declare their legal transitions in **one** table in code and validate against it. No ad-hoc status string assignment scattered across services.

```ts
const PO_TRANSITIONS: Record<PoStatus, PoStatus[]> = {
  DRAFT:     ['APPROVED', 'CANCELLED'],
  APPROVED:  ['RECEIVED', 'CANCELLED'],
  RECEIVED:  ['CLOSED'],
  CLOSED:    [],
  CANCELLED: [],
};
```

## 11. Email is normalised to lowercase

Store emails lowercased on write, compare lowercased on read, and back it with a functional unique index (`UNIQUE (LOWER(email))`). The prior build checked `LOWER(email)` on register but exact-matched on login, which let users register accounts they could not log into.

## 12. Every foreign key is declared

Every `*_id` column that references another table has an actual `REFERENCES` constraint with an explicit `ON DELETE` behaviour. The prior build left `user_id` columns as bare UUIDs, permitting orphaned rows. Index every FK used in a join, and every scope column.

---

## Appendix — Lessons From the Discarded Build

The previous implementation was deleted on 2026-07-30 rather than refactored. These are the specific reasons — each is now prevented by a rule above. There is no git history to recover this from; this table is the record.

| What went wrong | Now prevented by |
|---|---|
| Scoped everything by `user_id`; an ERP needs org-level tenancy. Every table would have needed a backfill migration. | Rule 7 + `org_id` from migration 001 |
| SQL in `authController.ts` and `aiController.ts`, never extracted | Rules 1, 2 — `authService` exists from day one |
| Money validated in cents but stored as `DECIMAL(15,2)` | Rule 3 — `BIGINT` cents only |
| `isBalanced` computed with `Math.abs(d - c) < 0.01` | Rule 3 — integer equality |
| `accounts.user_id`, `journal_entries.user_id`, `ledger_lines.user_id` had no FK constraints; orphaned rows possible | Rule 12 |
| `register` matched `LOWER(email)`, `login` matched exactly — users could be locked out | Rule 11 |
| `pool.query` after `COMMIT` for CSV self-learning, errors swallowed | Rule 6 — post-commit work is a queued job |
| `PUT`/`DELETE` on journal entries left commented out indefinitely, undecided | Rule 9 — reversing entries, decided |
| All tests mocked the pool; migrations, constraints and triggers were never exercised | [testing.md](testing.md) — integration tests from Phase 1 |
| `training_data.csv` tracked in git and appended to at runtime → permanent working-tree churn | DB-backed corpus, `org_id` scoped ([roadmap.md](roadmap.md) Phase 15) |
| `server/coverage/` committed to the repo | Phase 0 `.gitignore` |
| Docs claimed a git repo and a `TODO.md` that did not exist | Verify against the filesystem before documenting |

**The meta-lesson:** the documentation drifted from reality, and the drift hid the structural problem until a rewrite was cheaper than a repair. When a change lands, update the status board in `CLAUDE.md` plus [api.md](api.md) and [schema.md](schema.md) in the same pass. A `BUILT` row that is not true is worse than no row.
