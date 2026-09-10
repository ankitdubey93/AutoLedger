# Engineering Guardrails

Full detail for the 16 rules summarised in `CLAUDE.md` — this file uses the same numbering, so a rule cited by number means the same thing in both places. These apply to every app in the suite. The prior codebase violated 1, 2, 3, and 7, and the violations compounded until a reset was cheaper than a repair (see [Lessons](#appendix--lessons-from-the-discarded-build)).

## 1. Tenant scoping is mandatory on every query

Every read and write is filtered by `org_id`. A query without an `org_id` predicate is a data-leak bug, full stop. Never trust an ID from the request body or params to imply ownership — always filter or join on the caller's `org_id` resolved by middleware.

```ts
// CORRECT
'SELECT * FROM accounts WHERE id = $1 AND org_id = $2'

// WRONG — caller could pass any account id in the database
'SELECT * FROM accounts WHERE id = $1'
```

`user_id` is **never** an access-control boundary. It appears on transactional rows only as a `created_by` audit field. See [architecture.md](architecture.md) for the tenancy model.

## 2. Controllers are thin HTTP adapters; services own all DB logic

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

Every `pool.query` / `client.query` call lives under `src/services/`. Services take plain data arguments, return plain objects, and never touch `req`/`res`. **This includes auth and the app registry** — there is an `authService.ts` and an `appService.ts` from day one; no flow queries the DB from a controller.

The previous build leaked SQL into `authController` and `aiController` and it never got cleaned up. Catch it in review, every time.

## 3. Money is integer cents — never floating point

Validation **and** storage are both in integer cents. There is no `DECIMAL` money column anywhere in the schema.

```ts
// CORRECT
const toCents = (n: number) => Math.round(Number(n) * 100);
const totalDebitCents  = lines.reduce((s, l) => s + toCents(l.debit), 0);
const totalCreditCents = lines.reduce((s, l) => s + toCents(l.credit), 0);
if (totalDebitCents !== totalCreditCents) throw new ApiError(422, "Entry is unbalanced.");

// WRONG
if (Math.abs(totalDebit - totalCredit) > 0.01) { ... }  // accumulates float error
```

Every money column is `BIGINT` cents — `debit_cents`, `credit_cents`, `amount_cents`, `unit_price_cents`. Conversion helpers live in one place, `utils/money.ts`, which arrives in Phase 3 with the first money column. This applies to reports too: an `isBalanced` flag is an integer equality check, never an epsilon comparison.

**Cents at the boundary too, not just in the database.** A request or an extracted document that carries `450.00` is converted on the way in, before anything sums it — `JSON.parse` produces an IEEE-754 double, and there is no exception to this rule for values that are "only in transit".

**An exchange rate (`NUMERIC(18,8)`, Phase 8) is not money and is the one documented exception to "BIGINT cents"** — a rate is a ratio needing sub-cent precision, never an amount. It stays a `string` end to end, both on the wire and in TypeScript, and is converted through exactly one chokepoint, `utils/fxRate.ts`'s `rateNumerator` (scaled to an integer numerator, never a bare `Number(rate) * cents` float multiplication). Converting a native amount to base currency always goes through `convertToBase`, which is `scaleCents` under the hood — the same exact-`BigInt`, half-up rounding every other rational-factor scaling in this codebase uses (rule 3's `scaleCents` for tax, now reused for FX).

## 4. Parameterized queries only

Always `$1, $2, ...` with a values array. Never interpolate user input into SQL — not even "safe-looking" values like sort columns or table names. Whitelist identifiers against a constant map instead.

```ts
// CORRECT — whitelisted identifier
const SORT_COLUMNS = { date: 'entry_date', created: 'created_at' } as const;
const col = SORT_COLUMNS[req.query.sort] ?? 'entry_date';
await pool.query(`SELECT * FROM journal_entries WHERE org_id = $1 ORDER BY ${col}`, [orgId]);
```

## 5. Transaction safety

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

Never do post-`COMMIT` follow-up work inside the same function and call it part of the operation. If something must happen after commit, it is a queued job, not a fire-and-forget query with a swallowed error. Phase 7 delivered the mechanism: `outboxService.emitEvent` writes an event row on the *same transaction client* as the financial fact it describes, and a separate background drain (`server/src/queue/handlers/outboxDrainHandler.ts`) turns that row into a webhook delivery — an HTTP call cannot happen inside the transaction, and firing it after `COMMIT` without a durable record loses the notification on any crash between the two. See [study/architecture/transactional-outbox.md](../study/architecture/transactional-outbox.md).

## 6. Posted financial documents are immutable

Posted journals are append-only. Corrections happen through **reversing entries** — a new entry with debits and credits swapped, linked to the original via `reverses_entry_id` — never by mutating or deleting a posted row. There is no `PUT /journals/:id` and no `DELETE /journals/:id`; there is `POST /journals/:id/reverse`.

From Phase 3 this is **also enforced by the database**: `reject_mutation()` is a `BEFORE UPDATE OR DELETE` trigger on `journal_entries` and `ledger_lines` that raises `0A000` naming this rule. A route that violated the rule would fail at runtime rather than corrupt the ledger. `journal_entries.org_id` is `ON DELETE RESTRICT` for the same reason — a cascade from `organizations` would otherwise be a delete the trigger has to abort.

This propagates to every app that posts financial documents: invoices, budgets, board decks get reversed or superseded, not silently edited in place.

## 7. A ledger line has exactly one side populated

Both `debit_cents > 0` and `credit_cents > 0` is invalid, and so is both being zero. Rejected in the service before the DB is touched, **and** enforced by CHECK constraints in the migration. Application validation and DB constraints are belt and braces — write both.

The entry-level rule — `SUM(debits) = SUM(credits)`, at least two lines — cannot be a CHECK constraint, because a CHECK sees one row and this spans many. From Phase 3 it is a `DEFERRABLE INITIALLY DEFERRED` constraint trigger that fires at `COMMIT`, so lines can be inserted one at a time without being transiently invalid, plus a second deferred trigger on `journal_entries AFTER INSERT` to catch a header written with no lines at all. Integer equality, never an epsilon.

```ts
// CORRECT
if (totalDebits !== totalCredits) throw new ApiError(422, '...');

// WRONG — the reason money is BIGINT cents is so this is never needed
if (Math.abs(totalDebits - totalCredits) < 0.01) { /* ... */ }
```

## 8. Every foreign key is declared

Every `*_id` column that references another table has an actual `REFERENCES` constraint with an explicit `ON DELETE` behaviour. The prior build left `user_id` columns as bare UUIDs, permitting orphaned rows. Index every FK used in a join, and every scope column.

## 9. Email is normalised to lowercase

Store emails lowercased on write, compare lowercased on read, and back it with a functional unique index (`UNIQUE (LOWER(email))`). The prior build checked `LOWER(email)` on register but exact-matched on login, which let users register accounts they could not log into.

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

## 11. Token handling

- Access tokens: signed and verified with `ACCESS_TOKEN_SECRET` (15m)
- Refresh tokens: signed and verified with `REFRESH_TOKEN_SECRET` (7d)
- There is **no `JWT_SECRET`**. The prior build carried a legacy third secret that was read but unused — do not recreate it.
- Refresh tokens are persisted in `refresh_tokens` and deleted on logout
- Never log decoded token payloads

## 12. Account types are exactly five

`Asset`, `Liability`, `Equity`, `Revenue`, `Expense` — never a sixth. Enforced by a CHECK constraint on `accounts.type` (LedgerCore, Phase 3) and mirrored in application validation. See [schema.md](schema.md#conventions).

Cost of Goods Sold is the one that tempts people into a sixth type. It is not one — COGS accounts are `Expense`, separated from operating expenses by the `5xxx` code range and by their parent account, which is how the P&L derives gross profit.

## 13. Migrations are additive, idempotent, and never edited after landing

`server/src/db/migrations/` is the **only** migration directory, sequential 3-digit prefix, one shared sequence across every app (`NNN_<app-slug>_<subject>.sql`; platform migrations carry no app tag). Use `IF NOT EXISTS` / `IF EXISTS`. **Never edit an applied migration** — write a new one. Destructive changes (dropping a column, narrowing a type) need explicit sign-off first. Full detail: [schema.md](schema.md#migration-rules).

## 14. No dependency before the phase that needs it

Do not add a package, an external service connection, or a Postgres extension speculatively. One module, one change, only its dependencies. Redis was provisioned since Phase 0 and wired up in Phase 7 (`bullmq` + `ioredis`, the worker process, the webhook dispatcher); any LLM/embeddings SDK remains gated. The LLM carve-out covers exactly two apps, **AP-Flow's vision extraction (Phase 10)** and **TaxGuard AI's RAG (Phase 16)**, and nothing else; both are recorded in [roadmap.md](roadmap.md#phase-renumbering--2026-09-01). Full policy and the approved-for-later table: [development.md](development.md#dependency-policy).

## 15. Every module ships tests, including a cross-tenant isolation test

At minimum: the invariant the module enforces, its ROLLBACK path under a mid-transaction failure, and its `org_id` authorization scoping. **A module without a cross-tenant isolation test is not done.** Full detail, including the mandatory shared-user fixture shape: [testing.md](testing.md).

## 16. App boundaries are namespaces, not tenancy

The app slug in `/api/v1/<app-slug>/<module>` is a routing convenience, not a security boundary. `org_id` remains the only thing that scopes data access — every rule above applies identically whether a route sits under a platform path or an app path. Concretely:

- An app's routes still resolve the active org from the verified access token, never from the `:appSlug` param or anything else in the URL.
- No app queries another app's tables directly. A cross-app effect goes through LedgerCore's GL via `source_type` / `source_id` (e.g. AP-Flow posts a bill; it does not `INSERT` into LedgerCore's tables from AP-Flow's own service).
- `config/apps.ts` is the single source of truth for which slugs exist; a request for an unknown or not-yet-built slug returns `404`, not a partial or default response.

See [architecture.md](architecture.md#suite-structure).

---

## Appendix — Lessons From the Discarded Build

The previous implementation was deleted on 2026-07-30 rather than refactored. These are the specific reasons — each is now prevented by a rule above. There is no git history to recover this from; this table is the record.

| What went wrong | Now prevented by |
|---|---|
| Scoped everything by `user_id`; an ERP needs org-level tenancy. Every table would have needed a backfill migration. | Rule 1 + `org_id` from migration 001 |
| SQL in `authController.ts` and `aiController.ts`, never extracted | Rule 2 — `authService` exists from day one |
| Money validated in cents but stored as `DECIMAL(15,2)` | Rule 3 — `BIGINT` cents only |
| `isBalanced` computed with `Math.abs(d - c) < 0.01` | Rule 3 — integer equality |
| `accounts.user_id`, `journal_entries.user_id`, `ledger_lines.user_id` had no FK constraints; orphaned rows possible | Rule 8 |
| `register` matched `LOWER(email)`, `login` matched exactly — users could be locked out | Rule 9 |
| `pool.query` after `COMMIT` for CSV self-learning, errors swallowed | Rule 5 — post-commit work is a queued job |
| `PUT`/`DELETE` on journal entries left commented out indefinitely, undecided | Rule 6 — reversing entries, decided |
| All tests mocked the pool; migrations, constraints and triggers were never exercised | Rule 15 + [testing.md](testing.md) — integration tests from Phase 1 |
| `training_data.csv` tracked in git and appended to at runtime → permanent working-tree churn | DB-backed corpus, `org_id` scoped, if the idea ever returns — see [roadmap.md](roadmap.md#dropped-from-scope) |
| `server/coverage/` committed to the repo | Phase 0 `.gitignore` |
| Docs claimed a git repo and a `TODO.md` that did not exist | Verify against the filesystem before documenting |

**The meta-lesson:** the documentation drifted from reality, and the drift hid the structural problem until a rewrite was cheaper than a repair. When a change lands, update the status board in `CLAUDE.md` plus [api.md](api.md) and [schema.md](schema.md) in the same pass. A `BUILT` row that is not true is worse than no row.
