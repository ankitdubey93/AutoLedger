# Build plan — LedgerCore Phase 8: multi-currency FX engine

**Date:** 2026-09-08
**Status: DONE — 2026-09-10.** All 6 slices (A–F) plus the spine executed. **776 server tests** (up from 717, plan estimated 790–820 — landed slightly under estimate) **+ 150 client tests** (up from 144). `guardrail-review` ran clean after one fix (two signed money columns in `fxRevaluationService.ts` parsed via bare `Number()` instead of `parseCents()` — corrected). `docs-sync` ran clean for every file in scope. The worked example passes as the named test `fxRealized.test.ts`'s `"reproduces docs/ledger-core.md's worked example to the paisa"`. `npm run verify:integrity` passes. This file is now a historical record; safe to delete.
**Phase:** 8 (LedgerCore) · **Spec:** [docs/ledger-core.md § D](../docs/ledger-core.md) and [§ 3 the worked example](../docs/ledger-core.md#3-realized-fx--the-worked-example) · **Roadmap:** [docs/roadmap.md § Phase 8, as delivered](../docs/roadmap.md#phase-8-as-delivered) · **Schema:** [docs/schema.md](../docs/schema.md) · **API:** [docs/api.md](../docs/api.md)

**Deviations from the plan as written, all recorded in the roadmap and study notes:** (1) `settingsService`/`settingsSchema` expose the three new FX posting-account columns through `GET`/`PATCH /ledger-core/settings` — the plan said to follow `payable_account_id`'s "existing pattern," but that pattern turned out to have no read/write path through the API at all (a pre-existing Phase 3.9 gap discovered mid-execution); the FX columns were wired properly instead, which is the more complete and clearly-intended behavior. (2) Step D4's aging/dashboard rework did not add a separate `baseOutstandingCents` field as sketched — `AgingCounterpartyRow`/`AgingBucketAmount` had no native-currency field to begin with, so the existing fields were simply switched to sum `base_amount_cents`/`base_total_cents`, matching the convention `reportService`'s trial balance, P&L, and balance sheet already followed (which, on inspection, were already on `base_*` columns — Slice B's step for those two files turned out to be a no-op; only `db/integrity.ts` needed the native→base switch). (3) The Phase 8+ schema sketch's `fx_rates` design (no `org_id`, `base_code`/`quote_code` naming) was superseded by an org-scoped table (`from_code`/`to_code`) — recorded as a deliberate change in `docs/schema.md`, reasoned through in decision 1 of this plan's §4. (4) `payment_allocations.base_amount_cents` is a deliberate, single exception to this codebase's "derive, never store" rule — anticipated by the plan (§7 risk 3) and confirmed necessary during D3.

Two client tests needed fixing unrelated to new functionality: `ledgerCoreInvoices.test.tsx`'s and `ledgerCoreBills.test.tsx`'s detail-page render helpers were missing `<LedgerSettingsProvider>`, which `NewInvoicePage`/`BillDetailPage` now require for the currency selector — both fixed by wrapping the existing render helpers, matching the pattern already used elsewhere in the same files.

---

## 1. Starting state (verified against the filesystem, 2026-09-08)

**Exists and may be assumed by every step below:**

- **Migrations `001`–`021` applied.** Latest three: `019_ledger-core_bank_reconciliation.sql`, `020_platform_outbox_and_webhooks.sql`, `021_ledger-core_unmatched_alert_threshold.sql`. **The next free prefix is `022`.**
- **`ledger_lines` already carries the FX columns**, written by migration 004: `currency_code CHAR(3) NOT NULL`, `fx_rate NUMERIC(18,8) NOT NULL DEFAULT 1 CHECK (fx_rate > 0)`, `base_debit_cents BIGINT`, `base_credit_cents BIGINT`, plus CHECKs `chk_base_nonzero`, `chk_exclusive_base`, `chk_side_agrees_with_base`. **Every existing row is base currency at `fx_rate = 1`, so `base_* = native *`.** Nothing in the codebase writes a rate other than 1.
- **`assert_journal_entry_balanced()`** (migration 004) is a `DEFERRABLE INITIALLY DEFERRED` constraint trigger attached to **both** `ledger_lines` (INSERT/UPDATE/DELETE) and `journal_entries` (INSERT). It currently raises if `SUM(debit_cents) <> SUM(credit_cents)` **or** `SUM(base_debit_cents) <> SUM(base_credit_cents)`, and if `COUNT(*) < 2`. **The native-sum check is what makes a mixed-currency entry impossible today. Slice B changes it.**
- **`journalService`** — `createEntryOnClient(client, orgId, createdBy, input) => Promise<string>` and `reverseEntryOnClient(client, orgId, createdBy, id, entryDate) => Promise<string>` are the only sanctioned GL write paths. `createEntryOnClient` reads `organizations.base_currency` itself and hard-codes `$6, 1, v.debit_cents, v.credit_cents` into the `ledger_lines` insert. `JournalLineInput = { accountId, debitCents, creditCents }`. Both call `fiscalPeriodService.assertPeriodOpenOnClient`.
- **`invoiceService`** — `issueInvoice` builds `glLines` (receivable debit, one credit per distinct revenue account, one tax credit) and posts via `createEntryOnClient` inside its own transaction. `voidInvoice` reverses. `invoices.currency_code` exists but is always the org base currency.
- **`billService`** — the AP mirror; `approveBill` posts, `voidBill` reverses. `bills.currency_code` exists, always base.
- **`paymentService`** — `createPaymentOnClient` / `voidPaymentOnClient` (transaction-client halves) and `createPayment` / `voidPayment` (transaction owners). `createPaymentOnClient` reads `organizations.base_currency` as the payment's `currency_code`, resolves a control account via `resolveControlAccount`, builds **exactly two** GL lines (cash + control, both for the full `amountCents`), generates the payment uuid up front, posts the entry, inserts `payments`, inserts `payment_allocations`, and emits the `payment.recorded` outbox event. `allocatedCentsSubquery(alias, column)` is exported and is the single definition of "how much of a document is settled".
- **`fiscalPeriodService`** — `assertPeriodOpenOnClient(client, orgId, date)`, `generatePeriods`, `closePeriod`, `reopenPeriod`, `lockPeriod`.
- **`bankMatchService`** — scores unmatched bank lines against open invoices/bills and, on `matchTransaction`, calls `paymentService.createPaymentOnClient`. Bank statements are **base currency only**.
- **Aggregation, already on base columns:** `dashboardService` (every `FILTER` aggregate) and `agingService`'s GL control-account balance query use `base_debit_cents`/`base_credit_cents`.
- **Aggregation, still on native columns — Slice B switches these:** `reportService` (trial balance, P&L, balance sheet — lines 36–37, 89–90, 128–129, 194–195, 290–291), `accountLedgerService` (opening balance, period totals, the `SUM(...) OVER (...)` running balance, and the recursive-CTE rollup — lines 31–51, 89, 109–110, 183–184, 205–208, 270–295), and `db/integrity.ts` checks 1 and 2 (lines 46–47, 85–90).
- **`agingService`** derives outstanding from `d.total_cents - allocatedCentsSubquery(...)` — **native document cents**, which stops equalling the GL control balance the moment a foreign-currency document exists.
- **`utils/money.ts`** — `Cents` brand, `cents`, `toCents`, `parseCents`, `formatCents`, `addCents`, `sumCents`, `scaleCents(amount, numerator, denominator)` (exact `BigInt`, rounds half up, rejects a negative or non-integer numerator/denominator), `parseMoneyText`. **There is no rate type and no rate arithmetic anywhere.**
- **`utils/`** also has: `apiError`, `cookies`, `csv`, `dateParse`, `fiscalYear`, `jwt`, `levenshtein`, `matchScore`, `parseBody`, `queryParam` (`readPagination`, `optionalIsoDate`, `optionalUuid`, `optionalText`), `requestContext`, `requireUser`, `routeParam` (`requireParam`), `validate`, `webhookSignature`, `webhookUrl`.
- **`db/transaction.ts`** — `beginTransaction(client)`, `withTransaction(fn)`, `applyAuditContext(client)`. A bare `client.query('BEGIN')` is a bug (Phase 5).
- **`types/ledger-core.ts`** (~800 lines) holds every FSM table: `INVOICE_TRANSITIONS`, `BILL_TRANSITIONS`, `PAYMENT_TRANSITIONS`, `FISCAL_PERIOD_TRANSITIONS`, `BANK_TRANSACTION_TRANSITIONS`, each with a `canTransitionX` helper.
- **`types/webhooks.ts`** — `OUTBOX_EVENT_TYPES` is a 5-element `as const` array. `outbox_events.event_type` is plain `TEXT` with only a length CHECK, so **adding an event type needs no migration**.
- **`routes/ledger-core/index.ts`** mounts 12 sub-routers: accounts, bank-imports, bank-transactions, bills, customers, fiscal-periods, invoices, journals, payments, reports, settings, vendors.
- **The default chart already seeds the three FX accounts** (`accountService.DEFAULT_CHART` and migration 003): `4910 Realized FX Gain` (Revenue), `6810 Realized FX Loss` (Expense), `6820 Unrealized FX Gain/Loss` (Expense). **No backfill is owed** — this debt was paid forward in Phase 3.
- **`ledger_settings`** has `payable_account_id`, `tax_input_account_id`, `default_expense_account_id` (migration 012, composite FKs to `accounts (org_id, id)`), plus `base_currency` living on `organizations`, not here. **There are no FX posting-account columns.**
- **Client** — `client/src/Pages/ledger-core/` holds 40+ files including `LedgerCoreSidebar.tsx`, `LedgerCoreRoutes.tsx`, `NewInvoicePage.tsx`, `NewBillPage.tsx`, `PaymentDialog.tsx`, `ConfirmDialog.tsx`, `BackLink.tsx`, `money.ts`.
- **Tests:** 717 server (`server/src/__tests__/`, 25 files under `ledger-core/`) + 144 client. `helpers/factories.ts` exports `resetTables`, `uniqueEmail`, `createUserWithOrg`, `addMember`, `loginAgent`.

**Does NOT exist — do not assume it:**

- No `fx_rates` table, no rate lookup, no rate arithmetic, no rate type.
- No way to create an invoice, bill, or payment in any currency but the org's base currency. Every service reads `organizations.base_currency` and uses it unconditionally.
- No FX gain/loss posting anywhere. `4910`/`6810`/`6820` have never received a line.
- No revaluation of any kind, no `fx_revaluations` table, no FX report.
- No per-account currency. `accounts` has no currency column and Phase 8 **does not add one**.
- No multi-currency bank statements (Phase 6 excluded them deliberately).

---

## 2. Gate

**Phase 8 needs Phases 3 and 7** ([docs/roadmap.md](../docs/roadmap.md) line 17). Both are delivered and verified above: the GL core with its FX columns (Phase 3), and the transactional outbox (Phase 7) whose `emitEvent` this phase uses for `fx.revaluation_posted`. **The gate is open. Nothing in this plan is blocked.**

`ledger-core` is already `status: 'building'` in `server/src/config/apps.ts` — no registry change is needed.

**Roadmap debt this phase carries:** none owed *to* it. Phase 3 pre-seeded `4910`/`6810`/`6820` precisely so Phase 8 would not need a chart backfill; verify with `grep -n "4910" server/src/services/ledger-core/accountService.ts` before assuming otherwise.

**Debt this phase pays off:** the "FX columns exist but every line is written at rate 1" gap that Phases 3, 3.8, and 3.9 each recorded.

**Phase 8 gates Phase 11** (AP-Flow posting, "FX at invoice date"). Nothing in this plan may leave the rate lookup private to LedgerCore — `fxRateService.resolveRateOnClient` is the seam Phase 11 will call.

---

## 3. Execution rules

> **If a proof command fails twice on the same step, stop and report. Do not improvise around it.**

Every step's `Proof` runs from `server/` unless stated otherwise. The full server suite needs Postgres and Redis up (`docker compose up -d`) and `npm run migrate` applied.

| Symptom | Forbidden | Correct |
|---|---|---|
| Migration checksum error | Editing an applied migration (`001`–`021`, or one this plan already applied) | A new sequential migration (rule 13) |
| A test fails | Weakening, skipping, or deleting the assertion | Fix the code — the test is the spec |
| Type error | `as any`, `@ts-ignore`, loosening `tsconfig` | Fix the type |
| Query returns no rows | Dropping the `org_id` predicate | Fix the fixture or the parameters (rule 1) |
| Balance assertion fails | An epsilon, a float, `Math.round` on a product | Integer cents equality; `scaleCents` for scaling (rule 3) |
| A rate needs multiplying | `nativeCents * Number(rate)` | `convertToBase` from `utils/fxRate.ts` (Step A2) |
| Need a helper library | `npm install` anything | Stop and ask (rule 14) — **this phase adds zero dependencies** |
| "Just update the posted invoice's rate" | Adding a `PUT`/`PATCH` on an ISSUED document | It is frozen at posting; correction is void + re-enter (rule 6) |
| Column missing at runtime | Adding it ad hoc in a service | A new migration, then update this plan |
| An existing test now expects different GL lines | Changing the test to match new output without understanding why | Read Step D3's "deliberately unchanged" note — the base-currency path must stay byte-identical |

**Anything this plan did not anticipate is a stop-and-report, not a judgment call.**

---

## 4. Decisions fixed at plan time — do not re-decide these

These are the choices an executor would otherwise have to guess. They are settled.

1. **Rate direction and naming.** A rate row is `from_code` → `to_code`, and `rate` is *how many units of `to_code` one unit of `from_code` buys*. USD→INR at `83.00000000` means 1 USD = 83 INR. **Rates are always stored foreign → base**, so conversion is a multiplication and never an inversion. The word "base" is overloaded in this codebase (`organizations.base_currency` vs a currency pair's base); `from_code`/`to_code` avoids the collision entirely — never name a column `base_code`.
2. **Rate precision and range.** `NUMERIC(18,8)`, matching `ledger_lines.fx_rate`. `CHECK (rate > 0 AND rate <= 1000000)`. The ceiling is load-bearing: `RATE_SCALE = 100_000_000`, so a rate's integer numerator is `rate × 1e8 ≤ 1e14`, comfortably inside `Number.MAX_SAFE_INTEGER` (~9.007e15), which is what lets `scaleCents` do the arithmetic in exact `BigInt` without a bespoke parser.
3. **Conversion and rounding.** `baseCents = scaleCents(nativeCents, rateNumerator, RATE_SCALE)` — half-up, exact, `BigInt` throughout. Postgres `round(numeric)` rounds half away from zero, which is identical to half-up for the non-negative values every ledger amount has. That identity is what makes the database CHECK in Step B1 agree with the service.
4. **Lookup rule.** *The latest rate on or before the date*, never an exact-date match — rate feeds have weekend and holiday gaps. `ORDER BY rate_date DESC LIMIT 1` with `rate_date <= $3`. If none exists, the caller gets a `422`, never a silent rate of 1.
5. **A currency equal to the org's base currency is always rate 1** and never consults `fx_rates`. There is no `INR → INR` row and none is required.
6. **The balance invariant changes shape.** After Step B1: `SUM(base_debit_cents) = SUM(base_credit_cents)` is enforced **always**; `SUM(debit_cents) = SUM(credit_cents)` is enforced **only when every line in the entry shares one `currency_code`**. This is the standard functional-currency rule — a realized-FX entry legitimately mixes a USD receivable line with an INR gain line, and native amounts across different currencies are not commensurable, so summing them was never meaningful. **Base currency is what balances. This is the single most important idea in the phase and owes a study note.**
7. **Native/base agreement becomes a database CHECK.** `chk_base_matches_rate`: `base_debit_cents = round(debit_cents * fx_rate) AND base_credit_cents = round(credit_cents * fx_rate)`. Every existing row (rate 1) satisfies it.
8. **Documents freeze their rate at posting.** An invoice's `fx_rate` and `base_*_cents` are recomputed on every draft save (so a draft displays honestly) and **frozen at `issue`**; a bill's at `approve`. The frozen rate is what the GL entry uses and what settlement compares against forever after.
9. **Realized FX is a plug line, computed as the imbalance.** Build the payment's cash and control lines from their own currencies and rates, then let `imbalance = Σ baseDebit − Σ baseCredit`. `imbalance > 0` → **credit `4910` Realized FX Gain** for `imbalance`. `imbalance < 0` → **debit `6810` Realized FX Loss** for `−imbalance`. `imbalance == 0` → no FX line. This one rule reproduces both directions of the worked example (a receivable settled high is a gain; a payable settled high is a loss) without a single sign branch.
10. **One control line per allocation — on the FX path only.** When the payment's currency equals the org base currency, `createPaymentOnClient` emits exactly the two lines it emits today, byte-identical, so all 717 existing tests keep passing. When it differs, it emits one control line per allocation (native = that allocation's amount, rate = that document's frozen rate), which is what keeps every ledger line satisfying `chk_base_matches_rate` while the per-allocation base amounts still sum exactly to the control total.
11. **`payment_allocations` gains `base_amount_cents`**, written at creation as `scaleCents(amountCents, documentRateNumerator, RATE_SCALE)`. Aging and GL reconciliation read this stored value rather than recomputing, so the subledger cannot drift from the GL by a rounding cent.
12. **A payment may only allocate to documents in its own currency.** Enforced in the service **and** by a `BEFORE INSERT` trigger on `payment_allocations` (`assert_allocation_currency_matches()`).
13. **Unrealized revaluation posts one entry dated the as-of date and one automatic reversal dated the next day.** The reversal is what keeps the *realized* calculation at settlement honest — it always compares the settlement rate against the document's original frozen rate, never against a revalued carrying amount. Revaluation posts to `6820 Unrealized FX Gain/Loss` against the AR/AP control accounts.
14. **`fx_revaluations` has no status column and therefore no FSM.** A revaluation is created posted and is never voided; re-running for a date that already has one is a `409`. `UNIQUE (org_id, as_of_date)`.
15. **Bank statements stay base currency.** `bankMatchService` must skip foreign-currency documents when scoring, and `matchTransaction` must refuse one with a `422`. Multi-currency bank import remains explicitly not built.
16. **No per-account currency.** `accounts` gains no currency column. A cash account may receive lines in several currencies; its base-currency balance is the authoritative one. State this limit in the docs.
17. **Reporting currency is always the org base currency.** Every statement, the trial balance, the account ledger, aging, and `verify:integrity` aggregate `base_*` columns after Slice B. Native amounts remain visible on the journal-entry detail page and on documents.
18. **One new outbox event type:** `fx.revaluation_posted`. No new queue, no new worker handler, no scheduled job — a revaluation is an accounting act a human triggers, not a cron.
19. **Roles.** Reading rates/revaluations/exposure: any member (`authenticate` only), matching `/reports`. Writing a rate: `OWNER`, `ADMIN`, `ACCOUNTANT`. Deleting a rate: `OWNER`, `ADMIN`. Running a revaluation: `OWNER`, `ADMIN` — it posts to the GL on someone's behalf and is closer to `close` than to `post`.
20. **Migrations this phase writes:** `022`, `023`, `024`, `025`, `026`. Nothing else. If you need a sixth, stop and report.

---

## 5. Slices

Six slices. **A → B → C → D → E is a hard dependency chain — do not reorder.** F (client) depends on A–E but its steps are independent of one another and may be done in any order.

---

## Slice A — `fx_rates`, the rate type, and the lookup

**Outcome:** an organization can record and read exchange rates, and any service can ask "what was USD worth in our base currency on or before this date?" and get an exact integer-cents conversion.

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| App slug | `ledger-core` |
| Migration | `server/src/db/migrations/022_ledger-core_fx_rates.sql` |
| Table | `fx_rates` |
| Columns | `id, org_id, from_code, to_code, rate_date, rate, source, created_by, created_at, updated_at` |
| Constraints | `ux_fx_rates_org_pair_date`, `chk_fx_rates_from_code`, `chk_fx_rates_to_code`, `chk_fx_rates_different`, `chk_fx_rates_rate_range`, `chk_fx_rates_source` |
| Indexes | `idx_fx_rates_lookup` |
| Util file | `server/src/utils/fxRate.ts` → `RATE_SCALE`, `MAX_RATE`, `isCurrencyCode`, `rateNumerator`, `convertToBase`, `formatRate`, `ONE_RATE` |
| Types | `FxRate`, `ResolvedRate` in `server/src/types/ledger-core.ts` |
| Constants | `FX_RATE_SOURCES` in `server/src/types/ledger-core.ts` |
| Service file / exports | `server/src/services/ledger-core/fxRateService.ts` → `listRates`, `upsertRate`, `deleteRate`, `resolveRateOnClient`, `requireRateOnClient` |
| Schema file | `server/src/schemas/ledger-core/fxRateSchema.ts` → `upsertFxRateSchema` |
| Controller | `server/src/controllers/ledger-core/fxRateController.ts` → `list`, `upsert`, `remove`, `latest` |
| Routes file | `server/src/routes/ledger-core/fxRateRoutes.ts` |
| Route base | `/api/v1/ledger-core/fx-rates` |
| Test files | `server/src/__tests__/ledger-core/fxRates.test.ts`, `server/src/__tests__/fxRate.test.ts` |

---

### Step A1 — Migration `022_ledger-core_fx_rates.sql`

- **Depends on:** nothing.
- **Skill:** `new-migration`
- **Read first:** `server/src/db/migrations/019_ledger-core_bank_reconciliation.sql` (header comment style, idempotency idiom, index naming) and `server/src/db/migrations/011_ledger-core_vendors.sql` (a simple org-scoped table with a composite unique).
- **Files:** `server/src/db/migrations/022_ledger-core_fx_rates.sql` (new)
- **Contract — write this table literally:**
  ```sql
  CREATE TABLE IF NOT EXISTS fx_rates (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id     UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

    from_code  CHAR(3) NOT NULL,
    to_code    CHAR(3) NOT NULL,
    rate_date  DATE NOT NULL,
    rate       NUMERIC(18,8) NOT NULL,
    source     TEXT NOT NULL DEFAULT 'MANUAL',

    created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ux_fx_rates_org_pair_date UNIQUE (org_id, from_code, to_code, rate_date),
    CONSTRAINT chk_fx_rates_from_code    CHECK (from_code ~ '^[A-Z]{3}$'),
    CONSTRAINT chk_fx_rates_to_code      CHECK (to_code ~ '^[A-Z]{3}$'),
    CONSTRAINT chk_fx_rates_different    CHECK (from_code <> to_code),
    CONSTRAINT chk_fx_rates_rate_range   CHECK (rate > 0 AND rate <= 1000000),
    CONSTRAINT chk_fx_rates_source       CHECK (source IN ('MANUAL', 'IMPORT'))
  );

  CREATE INDEX IF NOT EXISTS idx_fx_rates_lookup
    ON fx_rates (org_id, from_code, to_code, rate_date DESC);
  ```
  Then attach `set_updated_at` exactly as `011` does for `vendors` (copy that block, changing only the table name), and attach the Phase 5 audit trigger the way migration `018` does for other `ledger-core` tables:
  ```sql
  DROP TRIGGER IF EXISTS trg_fx_rates_audit ON fx_rates;
  CREATE TRIGGER trg_fx_rates_audit
    AFTER INSERT OR UPDATE OR DELETE ON fx_rates
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');
  ```
  Read `018_platform_audit_triggers.sql` first and copy its exact `audit_row_change` invocation signature — do not guess the argument shape.
  `ON DELETE CASCADE` on `org_id` (not `RESTRICT`): a rate is reference data, not a posting, and deleting an org with rates but no journals must stay possible. `created_by` is `RESTRICT` — an audit reference (rule 8).
- **Guardrails:** #1 `org_id` on the table and first in the lookup index · #8 both `*_id` columns get `REFERENCES` with explicit `ON DELETE`, and the FK used in joins is indexed · #13 prefix `022`, additive, idempotent, never edit an applied file
- **Proof:** `npm run migrate` succeeds, then `npm run migrate` again succeeds and reports nothing applied; then `npm test -- migrations` passes.
- **If it fails:** a checksum error means you edited an applied file — revert it and add `023` instead (but `023` is claimed by Step B1, so stop and report). Do not `db:reset` a database you did not create.
- **Owes:** `docs/schema.md` gets the table (paid in Step A7).

---

### Step A2 — `utils/fxRate.ts`

- **Depends on:** nothing (pure module; can be done in parallel with A1).
- **Skill:** none — a utility module. Same fields apply.
- **Read first:** `server/src/utils/money.ts` in full — especially `scaleCents`, whose contract this module builds on, and the doc-comment density it sets. Imports carry the `.js` extension (`./money.js`) — this is ESM and will not build without it.
- **Files:** `server/src/utils/fxRate.ts` (new)
- **Contract — write these literally:**
  ```ts
  /** 1e8 — `fx_rates.rate` and `ledger_lines.fx_rate` are both NUMERIC(18,8). */
  export const RATE_SCALE = 100_000_000;

  /** Matches chk_fx_rates_rate_range. Keeps rate × RATE_SCALE inside Number.MAX_SAFE_INTEGER. */
  export const MAX_RATE = 1_000_000;

  /** The rate a base-currency amount is recorded at. Always this exact string. */
  export const ONE_RATE = '1.00000000';

  export function isCurrencyCode(value: string): boolean;

  /** '83.50000000' -> 8350000000. Throws ApiError(500, 'Unparseable exchange rate from database') on anything else. */
  export function rateNumerator(rate: string): number;

  /** nativeCents x rate, exact, half-up, via scaleCents. Never a float multiplication. */
  export function convertToBase(nativeCents: Cents, rate: string): Cents;

  /** 83.5 -> '83.50000000'. Used only where a rate must be written as a literal. */
  export function formatRate(value: number): string;
  ```
  - `isCurrencyCode`: `/^[A-Z]{3}$/.test(value)`.
  - `rateNumerator`: accept `/^\d{1,10}(\.\d{1,8})?$/` after `trim()`. Split on `.`, right-pad the fraction to 8 digits with `'0'`, concatenate, `Number.parseInt(..., 10)`. Reject a result that is not a safe integer or is `<= 0` or `> MAX_RATE * RATE_SCALE` with `new ApiError(500, 'Unparseable exchange rate from database')`. Note in a comment that `pg` returns `NUMERIC` as a string precisely so it is never routed through a float, and that this function is the only place a rate string becomes a number.
  - `convertToBase`: `return scaleCents(nativeCents, rateNumerator(rate), RATE_SCALE);` with a comment recording that `scaleCents` rounds half up and Postgres `round(numeric)` rounds half away from zero, which is the same thing for the non-negative amounts every ledger line holds — the identity migration `023`'s `chk_base_matches_rate` depends on.
- **Guardrails:** #3 no float ever touches a money value — `Number(rate) * cents` is the forbidden line this module exists to prevent · #4 n/a (no SQL)
- **Proof:** `npm run typecheck` exits 0, and `grep -c "Number(" server/src/utils/fxRate.ts` returns 0 except inside `rateNumerator`'s `parseInt` line.
- **If it fails:** a type error on `scaleCents(nativeCents, ...)` means `nativeCents` is a plain `number` — brand it with `cents(...)` at the call site, never `as Cents`.
- **Owes:** a study note (paid in the spine, Step S3).

---

### Step A3 — Types and constants

- **Depends on:** A1 (column names), A2 (`ONE_RATE`).
- **Skill:** none.
- **Read first:** `server/src/types/ledger-core.ts` lines 700–800 (the Phase 6 block) for the section-comment style and where new blocks go — **append at the end of the file**, do not interleave.
- **Files:** `server/src/types/ledger-core.ts` (edit — append)
- **Contract — write these literally:**
  ```ts
  // ------------------------------------------------------------------ Phase 8 — FX

  export const FX_RATE_SOURCES = ['MANUAL', 'IMPORT'] as const;
  export type FxRateSource = (typeof FX_RATE_SOURCES)[number];

  export function isFxRateSource(value: string): value is FxRateSource {
    return (FX_RATE_SOURCES as readonly string[]).includes(value);
  }

  export interface FxRate {
    id: string;
    fromCode: string;
    toCode: string;
    rateDate: string;   // 'YYYY-MM-DD' — a DATE is a calendar fact, never an instant
    rate: string;       // NUMERIC(18,8) as a string, never a number — see utils/fxRate.ts
    source: FxRateSource;
    createdBy: string;
    createdAt: string;
    updatedAt: string;
  }

  /** What a lookup answers with: the rate, and which row supplied it. */
  export interface ResolvedRate {
    fromCode: string;
    toCode: string;
    rate: string;
    /** The date of the row actually used — on or BEFORE the date asked for. */
    rateDate: string;
    /** true when fromCode === toCode: rate '1.00000000', no row consulted. */
    identity: boolean;
  }
  ```
- **Guardrails:** #10 n/a (no lifecycle here — decision 14) · #12 untouched, still exactly five account types
- **Proof:** `npm run typecheck` exits 0.
- **If it fails:** do not widen `rate` to `number` to make a call site compile — fix the call site.
- **Owes:** nothing.

---

### Step A4 — `fxRateService`

- **Depends on:** A1, A2, A3.
- **Skill:** `new-module` (service layer)
- **Read first:** `server/src/services/ledger-core/vendorService.ts` (a plain org-scoped CRUD service — copy its structure, `ApiError` usage, row-typing, and `23505` handling) and `server/src/services/ledger-core/fiscalPeriodService.ts`'s `assertPeriodOpenOnClient` (the `*OnClient` shape that takes a caller's transaction client).
- **Files:** `server/src/services/ledger-core/fxRateService.ts` (new)
- **Contract — write these signatures literally:**
  ```ts
  export interface ListRatesOptions {
    page: number;
    limit: number;
    fromCode: string | null;
    from: string | null;   // rate_date >=
    to: string | null;     // rate_date <=
  }

  export async function listRates(
    orgId: string,
    options: ListRatesOptions,
  ): Promise<{ rates: FxRate[]; totalCount: number }>;

  export async function upsertRate(
    orgId: string,
    createdBy: string,
    input: { fromCode: string; toCode: string; rateDate: string; rate: string; source: FxRateSource },
  ): Promise<FxRate>;

  export async function deleteRate(orgId: string, id: string): Promise<void>;

  /** null when no rate exists on or before `onDate`. Identity when the codes match. */
  export async function resolveRateOnClient(
    client: Queryable,
    orgId: string,
    fromCode: string,
    toCode: string,
    onDate: string,
  ): Promise<ResolvedRate | null>;

  /** resolveRateOnClient, but throws ApiError(422, ...) instead of returning null. */
  export async function requireRateOnClient(
    client: Queryable,
    orgId: string,
    fromCode: string,
    toCode: string,
    onDate: string,
  ): Promise<ResolvedRate>;
  ```
  - `type Queryable = Pick<PoolClient, 'query'>` — declare it at the top exactly as `journalService.ts` does, so `pool` and a checked-out client both satisfy it.
  - `listRates` → `WHERE org_id = $1` plus optional `AND from_code = $n`, `AND rate_date >= $n`, `AND rate_date <= $n`; `ORDER BY rate_date DESC, from_code ASC, id DESC` (`id DESC` is the pagination tiebreaker, same discipline as `listEntries`); a matching `COUNT(*)` built from the same predicate builder.
  - `upsertRate` → runs inside `withTransaction` (rule 5 — every write goes through `db/transaction.ts`). Validate `isCurrencyCode` on both codes and `fromCode !== toCode` (`ApiError(422, 'A currency cannot have a rate against itself')`). Statement:
    ```sql
    INSERT INTO fx_rates (org_id, from_code, to_code, rate_date, rate, source, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (org_id, from_code, to_code, rate_date)
    DO UPDATE SET rate = EXCLUDED.rate, source = EXCLUDED.source, updated_at = now()
    RETURNING id, from_code, to_code, rate_date, rate, source, created_by, created_at, updated_at
    ```
    Re-posting the same pair and date **overwrites** — a corrected rate is normal operations, and this is not a posted financial document, so rule 6 does not apply. Say that in a comment.
  - `deleteRate` → `DELETE FROM fx_rates WHERE id = $1 AND org_id = $2`; `rowCount === 0` → `ApiError(404, 'Exchange rate not found')`. Comment: deleting a rate cannot corrupt history, because every document and ledger line stores the rate it used, not a pointer to this row.
  - `resolveRateOnClient` → if `fromCode === toCode`, return `{ fromCode, toCode, rate: ONE_RATE, rateDate: onDate, identity: true }` **without querying**. Otherwise:
    ```sql
    SELECT rate::text AS rate, rate_date
      FROM fx_rates
     WHERE org_id = $1 AND from_code = $2 AND to_code = $3 AND rate_date <= $4::date
     ORDER BY rate_date DESC
     LIMIT 1
    ```
    Note in a comment: `rate_date <= $4`, never `= $4` — a rate feed has weekend and holiday gaps, and an exact-date match is a bug waiting for a Saturday.
  - `requireRateOnClient` → on `null`, `throw new ApiError(422, \`No exchange rate for ${fromCode} to ${toCode} on or before ${onDate}\`)` — this exact message shape; several tests assert on it.
- **Guardrails:** #1 `org_id = $1` in every statement, including the lookup · #2 no `req`/`res` in this file · #4 parameterized only; the optional filters append `$n` placeholders, never interpolate · #5 `upsertRate` uses `withTransaction`; the `*OnClient` functions run no `BEGIN`/`COMMIT`
- **Proof:** `npm run typecheck` exits 0, and `grep -c "org_id" server/src/services/ledger-core/fxRateService.ts` is at least 6 (one per statement).
- **If it fails:** if `rate` comes back as a JS number, you forgot `rate::text` in the SELECT — add it rather than converting in TS.
- **Owes:** `docs/api.md` (Step A7).

---

### Step A5 — Schema, controller, routes, mount

- **Depends on:** A4.
- **Skill:** `new-module` (controller + routes layers)
- **Read first:** `server/src/schemas/ledger-core/fiscalPeriodSchema.ts` (a small zod schema with an ISO-date field), `server/src/controllers/ledger-core/fiscalPeriodController.ts` (thin adapters, `requireUser`, `parseBody`, `requireParam`), `server/src/routes/ledger-core/fiscalPeriodRoutes.ts` (role gating per verb).
- **Files:**
  - `server/src/schemas/ledger-core/fxRateSchema.ts` (new)
  - `server/src/controllers/ledger-core/fxRateController.ts` (new)
  - `server/src/routes/ledger-core/fxRateRoutes.ts` (new)
  - `server/src/routes/ledger-core/index.ts` (edit — add the import and `router.use('/fx-rates', fxRateRoutes);`, both in alphabetical position, after `/fiscal-periods`)
- **Contract:**
  ```ts
  // fxRateSchema.ts
  export const upsertFxRateSchema = z.object({
    fromCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'fromCode must be a 3-letter ISO currency code'),
    toCode:   z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'toCode must be a 3-letter ISO currency code'),
    rateDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'rateDate must be YYYY-MM-DD'),
    rate:     z.string().regex(/^\d{1,10}(\.\d{1,8})?$/, 'rate must be a positive decimal with at most 8 decimal places'),
    source:   z.enum(FX_RATE_SOURCES).default('MANUAL'),
  });
  ```
  **`rate` is a string on the wire, not a number** — a JSON number cannot carry 8 decimal places reliably and would arrive as a float. Say so in a comment.

  Routes, exactly:

  | Method | Path | Roles | Controller | Success | Failures |
  |---|---|---|---|---|---|
  | GET | `/api/v1/ledger-core/fx-rates` | any member | `list` | `200` `{ success: true, rates, count, totalCount, currentPage, totalPages }` | — |
  | GET | `/api/v1/ledger-core/fx-rates/latest` | any member | `latest` | `200` `{ success: true, rate: ResolvedRate }` | `400` missing/invalid `from`; `422` no rate on or before |
  | POST | `/api/v1/ledger-core/fx-rates` | `OWNER`,`ADMIN`,`ACCOUNTANT` | `upsert` | `201` `{ success: true, rate }` | `400` body; `422` same-currency pair |
  | DELETE | `/api/v1/ledger-core/fx-rates/:id` | `OWNER`,`ADMIN` | `remove` | `204` no body | `404` not found / other tenant |

  **`/latest` must be registered before any `/:id` route** in `fxRateRoutes.ts` or Express will match `latest` as an id. There is no `GET /:id` in this plan — do not add one.
  `latest` reads `from` (required, 3-letter, else `ApiError(400, 'from must be a 3-letter ISO currency code')`) and `on` (optional ISO date via `optionalIsoDate`, defaulting to today's UTC date), resolves `toCode` from `organizations.base_currency` **through a service call, never a query in the controller** — add `getBaseCurrency(orgId): Promise<string>` to `server/src/services/organizationService.ts` if one does not already exist, and check first with `grep -n "base_currency" server/src/services/organizationService.ts`.
- **Guardrails:** #2 **zero SQL in the controller** — if you find yourself writing `pool.query` here, the query belongs in a service · #1 the org comes from `requireUser(req).orgId`, never from a body, header, or param · #16 `/fx-rates` sits under `/ledger-core`, a namespace and not a tenancy boundary
- **Proof:** `npm run typecheck` exits 0 and `npm run dev` boots without an unhandled route error; `grep -n "pool" server/src/controllers/ledger-core/fxRateController.ts` returns nothing.
- **If it fails:** a 404 on `/fx-rates/latest` means route order — move it above any parameterized route.
- **Owes:** `docs/api.md` (Step A7).

---

### Step A6 — Tests: `fxRate.test.ts` and `fxRates.test.ts`

- **Depends on:** A1–A5.
- **Skill:** `isolation-test`
- **Read first:** `server/src/__tests__/money.test.ts` (pure-unit style) and `server/src/__tests__/ledger-core/fiscalPeriods.test.ts` (API-level style with `createUserWithOrg` + `loginAgent`, and its cross-tenant block).
- **Files:**
  - `server/src/__tests__/fxRate.test.ts` (new — pure unit, no database)
  - `server/src/__tests__/ledger-core/fxRates.test.ts` (new — API + isolation)
- **Contract — these named cases, with these expected values:**

  `fxRate.test.ts`:
  1. `rateNumerator('83.50000000')` → `8350000000`
  2. `rateNumerator('83.5')` → `8350000000` (right-padding)
  3. `rateNumerator('1')` → `100000000`
  4. `rateNumerator('0')` throws `ApiError` with status `500`
  5. `rateNumerator('abc')` throws `ApiError` with status `500`
  6. `convertToBase(cents(100000), '83.00000000')` → `8300000` (₹83,000.00 for $1,000.00)
  7. `convertToBase(cents(100000), '83.50000000')` → `8350000` (the worked example's day 10)
  8. `convertToBase(cents(1), '0.00500000')` → `0` and `convertToBase(cents(1), '0.50000000')` → `1` — **names the half-up rule explicitly**
  9. `convertToBase(cents(12345), ONE_RATE)` → `12345` (identity is exact)
  10. `isCurrencyCode('USD')` → true; `isCurrencyCode('usd')` → false; `isCurrencyCode('USDX')` → false

  `fxRates.test.ts`:
  1. `POST /fx-rates` with `{ fromCode: 'USD', toCode: 'INR', rateDate: '2026-01-01', rate: '83.00000000' }` → `201`, body `rate.rate === '83.00000000'`
  2. Posting the same pair and date again with `rate: '84.00000000'` → `201` and `GET` shows **one** row at `84.00000000` (upsert, not a duplicate)
  3. `POST` with `fromCode === toCode` → `422`
  4. `POST` with `rate: '0'` → `400` (zod), and with `rate: '2000000'` → the database CHECK surfaces as `422` or `500` — assert the request **fails** and no row is created
  5. `GET /fx-rates/latest?from=USD&on=2026-03-15` with rows at `2026-01-01` and `2026-02-01` → `200`, `rate.rateDate === '2026-02-01'` — **the latest-on-or-before rule, named "resolves the latest rate on or before the date, not an exact match"**
  6. `GET /fx-rates/latest?from=USD&on=2025-12-31` with the earliest row at `2026-01-01` → `422`, message contains `No exchange rate for USD to`
  7. `GET /fx-rates/latest?from=INR` where `INR` is the org base → `200`, `rate.identity === true`, `rate.rate === '1.00000000'`
  8. `DELETE /fx-rates/:id` as `ACCOUNTANT` → `403`; as `OWNER` → `204`
  9. **Cross-tenant isolation:** org A creates a rate; org B `GET /fx-rates` → the list does not contain it; org B `DELETE /fx-rates/:idFromA` → `404` (never `403`, which would confirm the id exists); org B `GET /fx-rates/latest?from=USD` → `422`, proving A's rates are invisible to B's lookups.
- **Guardrails:** #15 the cross-tenant case is mandatory — without it this module is not done
- **Proof:** `npm test -- fxRate` passes (both files), and the whole suite `npm test` still passes at **717 + the new cases**.
- **If it fails:** a `404` where you expected `200` almost always means the test agent is authenticated to the wrong org — check `loginAgent`, do not relax the `org_id` predicate.
- **Owes:** nothing further.

---

### Step A7 — Docs for Slice A

- **Depends on:** A1–A6.
- **Skill:** `docs-sync`
- **Files:** `docs/schema.md` (edit — a `### Phase 8 — FX rates` block describing `fx_rates`, its unique constraint, and the lookup index), `docs/api.md` (edit — the four routes above with request/response bodies and every status code).
- **Proof:** `grep -n "fx_rates" docs/schema.md` and `grep -n "fx-rates" docs/api.md` both return hits; every route in `fxRateRoutes.ts` appears in `docs/api.md`.
- **If it fails:** n/a — but do not describe anything Slice A did not build. Claiming a capability that does not exist is the failure mode that killed the previous build.

---

## Slice B — Base currency is what balances

**Outcome:** the general ledger can hold a mixed-currency entry, every report and the integrity checker read base-currency columns, and the database itself proves each line's base amount is exactly its native amount at its own rate.

**This slice posts nothing new. It changes what the ledger permits and what the reports read.** It must go green on its own before Slice C writes the first foreign-currency document.

**Names — use exactly these:**

| Kind | Name |
|---|---|
| Migration | `server/src/db/migrations/023_ledger-core_base_currency_balance.sql` |
| Function redefined | `assert_journal_entry_balanced()` |
| New constraint | `chk_ledger_lines_base_matches_rate` |
| Service edits | `journalService.createEntryOnClient`, `reportService`, `accountLedgerService`, `db/integrity.ts` |
| New input field | `JournalLineInput.currencyCode`, `JournalLineInput.fxRate` (both optional) |
| Test files | `server/src/__tests__/ledger-core/fxLedgerConstraints.test.ts` (new), `server/src/__tests__/ledger-core/ledgerConstraints.test.ts` (edit) |

---

### Step B1 — Migration `023_ledger-core_base_currency_balance.sql`

- **Depends on:** A1 applied.
- **Skill:** `new-migration`
- **Read first:** `server/src/db/migrations/004_ledger-core_journals.sql` **in full** — you are redefining its `assert_journal_entry_balanced()` function, and you must reproduce every branch you are not deliberately changing (the `TG_TABLE_NAME` branch, the "entry already deleted" early return, the `line_count < 2` check, the base-sum check).
- **Files:** `server/src/db/migrations/023_ledger-core_base_currency_balance.sql` (new)
- **Contract:**
  1. **`CREATE OR REPLACE FUNCTION assert_journal_entry_balanced()`** — a full redefinition. This is not editing an applied migration; `004` stays untouched on disk and its checksum is unchanged. Keep everything from `004` except the native-sum check, which becomes conditional. Add a `currency_count` variable and select it alongside the sums:
     ```sql
     SELECT COALESCE(SUM(debit_cents), 0),
            COALESCE(SUM(credit_cents), 0),
            COALESCE(SUM(base_debit_cents), 0),
            COALESCE(SUM(base_credit_cents), 0),
            COUNT(*),
            COUNT(DISTINCT currency_code)
       INTO total_debit, total_credit, total_base_debit, total_base_credit, line_count, currency_count
       FROM ledger_lines
      WHERE journal_entry_id = target_entry;
     ```
     The base-sum check stays **unconditional** and keeps its exact message. The native-sum check becomes:
     ```sql
     IF currency_count = 1 AND total_debit <> total_credit THEN
       RAISE EXCEPTION
         'journal entry % is unbalanced (debits=%, credits=%)',
         target_entry, total_debit, total_credit;
     END IF;
     ```
     Write a comment block above the function explaining **why**: base currency is the functional currency and the only one in which an entry can meaningfully balance; a realized-FX entry legitimately holds a USD receivable line and an INR gain line, and adding those two native amounts together would be adding apples to oranges. A single-currency entry still gets the stricter check, so every entry written before Phase 8 — and every base-currency entry written after it — is validated exactly as it was.
     **Do not touch the triggers themselves.** `CREATE OR REPLACE FUNCTION` is enough; the existing `trg_ledger_lines_balanced` and `trg_journal_entries_have_lines` pick up the new body. Re-creating a `CONSTRAINT TRIGGER` here would be a second, redundant definition.
  2. **The new CHECK**, guarded so the file replays:
     ```sql
     DO $$
     BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ledger_lines_base_matches_rate') THEN
         ALTER TABLE ledger_lines ADD CONSTRAINT chk_ledger_lines_base_matches_rate
           CHECK (base_debit_cents  = round(debit_cents  * fx_rate)
              AND base_credit_cents = round(credit_cents * fx_rate));
       END IF;
     END $$;
     ```
     Comment: every existing row has `fx_rate = 1`, so this validates against the whole table without a backfill. `round(numeric)` rounds half away from zero, which for the non-negative values these columns hold is the same rule `scaleCents` applies — that identity is what lets the service and the database agree to the cent.
- **Guardrails:** #3 the invariant stays integer equality — no epsilon appears anywhere in this file · #13 additive and idempotent; `004` is not edited
- **Proof:**
  ```
  npm run migrate && npm run migrate && npm test -- migrations && npm test -- ledgerConstraints
  ```
  All pass. **`npm test -- statements` and `npm test -- journals` must also still pass unchanged** — this migration must not alter behaviour for any single-currency entry.
- **If it fails:** if `ALTER TABLE ... ADD CONSTRAINT` reports existing rows violating the CHECK, **stop and report** — it means some row already has a rate ≠ 1, which contradicts the verified starting state. Do not add `NOT VALID` to get past it.
- **Owes:** `docs/schema.md` (Step B5); a study note on functional-currency balancing (Step S3).

---

### Step B2 — `journalService` accepts a per-line currency and rate

- **Depends on:** B1 applied, A2.
- **Skill:** `new-module` (service layer)
- **Read first:** `server/src/services/ledger-core/journalService.ts` lines 320–410 (`createEntryOnClient`) and 457–530 (`reverseEntryOnClient`).
- **Files:** `server/src/services/ledger-core/journalService.ts` (edit — `JournalLineInput`, `createEntryOnClient`)
- **Contract:**
  ```ts
  export interface JournalLineInput {
    accountId: string;
    debitCents: number;
    creditCents: number;
    /** Phase 8. Omitted means the organization's base currency. */
    currencyCode?: string;
    /** Phase 8. NUMERIC(18,8) as a string. Omitted means ONE_RATE. Required when currencyCode differs from base. */
    fxRate?: string;
  }
  ```
  In `createEntryOnClient`, after resolving `baseCurrency`:
  - For each line compute `lineCurrency = line.currencyCode ?? baseCurrency` and `lineRate = lineCurrency === baseCurrency ? ONE_RATE : (line.fxRate ?? null)`.
  - If `lineCurrency !== baseCurrency && lineRate === null` → `throw new ApiError(500, 'A foreign-currency line requires an explicit fx rate')`. It is `500`, not `422`: no HTTP client can reach this — only a service bug can.
  - If `lineCurrency !== baseCurrency` and `!isCurrencyCode(lineCurrency)` → the same `500`.
  - `baseDebit = convertToBase(cents(line.debitCents), lineRate)`, `baseCredit = convertToBase(cents(line.creditCents), lineRate)`.
  - **The balance pre-check becomes a base-currency check.** Replace the existing `totalDebits !== totalCredits` guard with the sum of `baseDebit` vs the sum of `baseCredit`, keeping the message shape:
    `` `Entry is unbalanced in base currency: debits ${...}, credits ${...}` ``.
    Keep the native check as well, but **only when every line resolves to the same currency** — mirroring migration `023` exactly, so the service and the trigger never disagree about what is legal.
  - The `INSERT ... SELECT ... FROM unnest(...)` grows from 3 arrays to 6 — add `$7::text[]` for currency codes, `$8::numeric[]` for rates, `$9::bigint[]` for base debits, `$10::bigint[]` for base credits, and select them instead of the hard-coded `$6, 1, v.debit_cents, v.credit_cents`. The `unnest` becomes:
    ```sql
    FROM unnest($3::uuid[], $4::bigint[], $5::bigint[], $7::text[], $8::numeric[], $9::bigint[], $10::bigint[])
         AS v(account_id, debit_cents, credit_cents, currency_code, fx_rate, base_debit_cents, base_credit_cents)
    ```
    (`$6` remains the org's base currency, still used for the default. Renumber cleanly if you prefer — just keep every placeholder bound.)
  - Update the block comment that currently says "Phase 3 posts base-currency entries only" to describe the Phase 8 rule instead. **Leaving a stale comment is a defect in this step.**
  - **`reverseEntryOnClient` needs no change.** It already copies `currency_code`, `fx_rate`, and both base columns from the original lines while swapping sides, so a reversal of an FX entry is correct for free. Add a one-line comment saying so, so a later reader does not "fix" it.
- **Guardrails:** #1 unchanged, still `org_id` on every statement · #3 no float — `convertToBase` only · #5 every query on the passed `client` · #7 exactly one side populated per line, and the side must agree between native and base (`chk_side_agrees_with_base` already enforces this; converting cannot change a side because a rate is always positive)
- **Proof:** `npm run typecheck` exits 0, then `npm test -- journals && npm test -- invoices && npm test -- bills && npm test -- payments` — **all pass with no test edits**, proving the base-currency path is unchanged.
- **If it fails:** if `chk_base_matches_rate` rejects an insert, your `convertToBase` and Postgres `round()` disagree — check that you passed the rate as the same string in both places, and that you did not route it through a JS number.
- **Owes:** nothing yet.

---

### Step B3 — Reports and the account ledger read base columns

- **Depends on:** B2.
- **Skill:** none — a targeted refactor. Same fields apply.
- **Read first:** `server/src/services/ledger-core/dashboardService.ts` lines 50–135 — it is **already** on `base_debit_cents`/`base_credit_cents` and is the model to copy.
- **Files:**
  - `server/src/services/ledger-core/reportService.ts` (edit — the three aggregate queries and their row interfaces)
  - `server/src/services/ledger-core/accountLedgerService.ts` (edit — the opening-balance query, the period-totals query, the running-balance window function, and the recursive-CTE rollup)
- **Contract:** in every `SUM(...)`, `SELECT`, and window function over `ledger_lines` in these two files, replace `debit_cents` with `base_debit_cents` and `credit_cents` with `base_credit_cents`. **Alias them back to `debit_cents`/`credit_cents` in the result set** (`SUM(l.base_debit_cents) AS debit_cents`) so the row interfaces, the `parseCents` calls, and every `TrialBalanceRow`/`StatementRow`/`AccountLedgerRow` type stay exactly as they are. No type changes, no API shape changes.
  Add this comment once at the top of each changed query block:
  ```
  // Base currency, not native: the reporting currency is the organization's
  // base currency, and after Phase 8 a line's native amount may be in any
  // currency. Summing native amounts across currencies is meaningless.
  ```
  **Do not touch `journalService.toEntry`'s `totalDebitCents`/`totalCreditCents`** — those are per-entry display totals shown next to the entry's own lines, and staying native is correct there.
- **Guardrails:** #1 every predicate keeps its `org_id` · #4 no interpolation — these are all static strings
- **Proof:** `npm test -- reports && npm test -- statements && npm test -- accountLedger && npm test -- dashboard` all pass **unchanged**, then `grep -n "SUM(l.debit_cents)\|SUM(l.credit_cents)\|SUM(debit_cents)\|SUM(credit_cents)" server/src/services/ledger-core/reportService.ts server/src/services/ledger-core/accountLedgerService.ts` returns **nothing**.
- **If it fails:** a changed number in an existing test means you also changed a predicate or a sign — revert and change only the column names.
- **Owes:** nothing.

---

### Step B4 — `verify:integrity` checks the base-currency invariant

- **Depends on:** B3.
- **Skill:** none.
- **Read first:** `server/src/db/integrity.ts` in full, and `server/src/__tests__/integrity.test.ts` (which proves the checker is capable of failing by disabling triggers).
- **Files:** `server/src/db/integrity.ts` (edit — checks 1 and 2 only)
- **Contract:** check 1 (`SUM(debit_cents)` vs `SUM(credit_cents)` across the whole database) and check 2 (per-entry `HAVING SUM(l.debit_cents) <> SUM(l.credit_cents)`) both switch to `base_debit_cents`/`base_credit_cents`. Check 3 (orphaned lines) is unchanged. Update each check's human-readable label to say "base currency" — e.g. `'Total base-currency debits equal total base-currency credits'` — because the label is what an auditor reads. **The count of checks stays three.** These two queries are the codebase's other deliberate exemption from `org_id` scoping (a whole-database claim); leave that comment in place and do not add a scope predicate.
- **Guardrails:** #3 integer equality, never an epsilon · #1 the documented exemption stands — do not "fix" it
- **Proof:** `npm run verify:integrity` exits 0 against the dev database, and `npm test -- integrity` passes.
- **If it fails:** if the whole-database sums differ, stop and report — that is a real ledger defect, not a test problem.
- **Owes:** `docs/api.md` mentions `verify:integrity`'s claims; update the wording in Step B5.

---

### Step B5 — Tests and docs for Slice B

- **Depends on:** B1–B4.
- **Skill:** `isolation-test`
- **Read first:** `server/src/__tests__/ledger-core/ledgerConstraints.test.ts` — the raw-SQL, bypass-the-service suite. Your new file is its FX sibling and must follow the same shape: `pool.query` directly, `beginTransaction`, deliberate `COMMIT` so the deferred trigger fires.
- **Files:** `server/src/__tests__/ledger-core/fxLedgerConstraints.test.ts` (new), `docs/schema.md` (edit)
- **Contract — these named cases, by raw SQL, bypassing every service:**
  1. **"a mixed-currency entry that balances in base currency commits"** — insert an entry with three lines: debit `1110` 8350000 INR at rate 1; credit `1120` 100000 USD at rate `83.00000000` (base 8300000); credit `4910` 50000 INR at rate 1. `COMMIT` succeeds. Native sums (8350000 vs 150000) do **not** match, and that is the point.
  2. **"a mixed-currency entry that does not balance in base currency is rejected at COMMIT"** — the same entry with the `4910` credit at 40000. `COMMIT` throws, message contains `unbalanced in base currency`.
  3. **"a single-currency entry is still checked natively"** — two INR lines at rate 1, debit 1000, credit 900, both base columns matching their native ones… which cannot be built, because base would also be unbalanced. Build it instead as: debit 1000 at rate 1 (base 1000) and credit 900 at rate 1 (base 900) → rejected, message contains `is unbalanced (debits=` — the **native** message, proving the single-currency branch still fires first.
  4. **"a line whose base amount does not match its rate is rejected on INSERT"** — insert a line with `debit_cents = 100000`, `fx_rate = 83.00000000`, `base_debit_cents = 8299999`. The `INSERT` itself fails (not the `COMMIT`) with a check-constraint violation naming `chk_ledger_lines_base_matches_rate`.
  5. **"round-half-up agrees between the service and the database"** — `debit_cents = 1`, `fx_rate = 0.50000000`, `base_debit_cents = 1` commits; `base_debit_cents = 0` is rejected. Assert `convertToBase(cents(1), '0.50000000') === 1` in the same test so the two rules are visibly the same rule.
  6. **Cross-tenant isolation:** a line in org A referencing an account in org B is still rejected by `assert_account_is_postable` — assert the existing behaviour survives the function redefinition.

  `docs/schema.md`: update the `ledger_lines` section to state the new balancing rule and `chk_ledger_lines_base_matches_rate`, and add a short "Base currency is what balances" note. Update the `verify:integrity` description wherever it appears in `docs/schema.md` or `docs/api.md` to say the sums are base-currency sums.
- **Guardrails:** #15 this suite is the proof the invariant holds independently of the services
- **Proof:** `npm test -- fxLedgerConstraints` passes, then **the full suite**: `npm test` — 717 pre-existing cases still green, plus Slice A's and B's new ones.
- **If it fails:** case 3 failing with the base message instead of the native one means your `IF currency_count = 1` guard is in the wrong place — the native check must come **before** the base check in the function body.
- **Owes:** the study note in Step S3.

---

## Slice C — Foreign-currency invoices and bills

**Outcome:** an invoice or bill can be raised in a currency other than the org's base currency; it stores the rate it was posted at and its base-currency totals, and its GL entry carries the foreign amounts natively.

**Names — use exactly these:**

| Kind | Name |
|---|---|
| Migration | `server/src/db/migrations/024_ledger-core_document_fx.sql` |
| New columns (`invoices` and `bills`, identical) | `fx_rate NUMERIC(18,8) NOT NULL DEFAULT 1`, `base_subtotal_cents BIGINT NOT NULL DEFAULT 0`, `base_tax_cents BIGINT NOT NULL DEFAULT 0`, `base_total_cents BIGINT NOT NULL DEFAULT 0` |
| New constraints | `chk_invoices_fx_rate`, `chk_invoices_base_total`, `chk_bills_fx_rate`, `chk_bills_base_total` |
| Service edits | `invoiceService.createInvoice/updateInvoice/issueInvoice`, `billService.createBill/updateBill/approveBill` |
| Type edits | `Invoice`, `Bill` gain `fxRate: string`, `baseSubtotalCents`, `baseTaxCents`, `baseTotalCents` |
| Test files | `server/src/__tests__/ledger-core/fxDocuments.test.ts` (new) |

---

### Step C1 — Migration `024_ledger-core_document_fx.sql`

- **Depends on:** B1 applied.
- **Skill:** `new-migration`
- **Read first:** `server/src/db/migrations/012_ledger-core_ap_posting_accounts.sql` (the `ADD COLUMN IF NOT EXISTS` + `pg_constraint`-guarded `ADD CONSTRAINT` idiom) and `009_ledger-core_invoices.sql` (the existing `chk_invoices_total`).
- **Files:** `server/src/db/migrations/024_ledger-core_document_fx.sql` (new)
- **Contract:**
  ```sql
  ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fx_rate             NUMERIC(18,8) NOT NULL DEFAULT 1;
  ALTER TABLE invoices ADD COLUMN IF NOT EXISTS base_subtotal_cents BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE invoices ADD COLUMN IF NOT EXISTS base_tax_cents      BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE invoices ADD COLUMN IF NOT EXISTS base_total_cents    BIGINT NOT NULL DEFAULT 0;
  -- ... the same four on bills ...

  -- Backfill: every pre-Phase-8 document is base currency at rate 1, so its
  -- base totals are its native totals. Idempotent because it only ever
  -- touches rows still holding the column default at rate 1.
  UPDATE invoices
     SET base_subtotal_cents = subtotal_cents,
         base_tax_cents      = tax_cents,
         base_total_cents    = total_cents
   WHERE fx_rate = 1 AND base_total_cents = 0 AND total_cents <> 0;
  -- ... the same for bills ...
  ```
  Then, `pg_constraint`-guarded:
  ```sql
  ALTER TABLE invoices ADD CONSTRAINT chk_invoices_fx_rate
    CHECK (fx_rate > 0 AND fx_rate <= 1000000);
  ALTER TABLE invoices ADD CONSTRAINT chk_invoices_base_total
    CHECK (base_total_cents = base_subtotal_cents + base_tax_cents);
  ```
  and the two `bills` equivalents. **No `CHECK (base_total_cents = round(total_cents * fx_rate))`** — the base total is the sum of independently rounded subtotal and tax, which may legitimately differ from the rounded total by one cent; the ledger-line CHECK from `023` is where that rule belongs, and the GL entry is built from per-component amounts. Write that reasoning in a comment so nobody adds the constraint later.
- **Guardrails:** #3 all four money columns are `BIGINT` cents; the rate is the documented `NUMERIC` exception · #13 additive, idempotent, replayable against a populated database
- **Proof:** `npm run migrate && npm run migrate && npm test -- migrations` all pass; then in `psql`, `SELECT count(*) FROM invoices WHERE base_total_cents <> total_cents;` returns 0 on a database with pre-existing invoices.
- **If it fails:** if the backfill `UPDATE` reports more rows on the second run than the first, your `WHERE` guard is wrong — fix the guard, do not make the file non-idempotent.
- **Owes:** `docs/schema.md` (Step C4).

---

### Step C2 — `invoiceService` and `billService` become currency-aware

- **Depends on:** C1 applied, A4, B2.
- **Skill:** `new-module` (service layer)
- **Read first:** `server/src/services/ledger-core/invoiceService.ts` — `createInvoice` (line ~428), `updateInvoice` (~511), `issueInvoice` (~661) — and the parallel three in `billService.ts`.
- **Files:** `server/src/services/ledger-core/invoiceService.ts` (edit), `server/src/services/ledger-core/billService.ts` (edit), `server/src/types/ledger-core.ts` (edit — `Invoice` and `Bill` interfaces), `server/src/schemas/ledger-core/invoiceSchema.ts` (edit), `server/src/schemas/ledger-core/billSchema.ts` (edit)
- **Contract:**
  - **Schemas:** `createInvoiceSchema`/`updateInvoiceSchema` gain
    `currencyCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional()` — omitted means the org's base currency. Same for bills. **No `fxRate` field on the wire** — the rate is never client-supplied; it is always resolved from `fx_rates`.
  - **Types:** `Invoice` and `Bill` each gain `fxRate: string; baseSubtotalCents: number; baseTaxCents: number; baseTotalCents: number;` and their row mappers gain `fx_rate::text AS fx_rate` plus the three `parseCents` reads. Every `SELECT` in these services that lists invoice/bill columns must add the four new ones — `grep -n "subtotal_cents" server/src/services/ledger-core/invoiceService.ts` to find every one of them.
  - **A private helper in each service**, written identically in both:
    ```ts
    async function resolveDocumentFx(
      client: PoolClient,
      orgId: string,
      currencyCode: string,
      onDate: string,
    ): Promise<{ currencyCode: string; rate: string }>
    ```
    It reads `organizations.base_currency`, returns `{ currencyCode: base, rate: ONE_RATE }` when they match, and otherwise calls `fxRateService.requireRateOnClient(client, orgId, currencyCode, base, onDate)` and returns its `rate`. The `422` it raises reads `No exchange rate for USD to INR on or before 2026-09-08`.
  - **On every draft save** (`createInvoice`, `updateInvoice`, and the bill equivalents): resolve the rate for `issue_date` (bills: `bill_date`), then write `fx_rate` and
    `base_subtotal_cents = convertToBase(subtotalCents, rate)`,
    `base_tax_cents = convertToBase(taxCents, rate)`,
    `base_total_cents = base_subtotal_cents + base_tax_cents`
    (an integer addition — **not** a third `convertToBase`, so `chk_invoices_base_total` holds by construction).
  - **At `issueInvoice` / `approveBill`:** re-resolve the rate for the posting date and **freeze it** — `UPDATE` the four columns in the same transaction, before building the GL lines. Comment: the rate is frozen here and never changes again; every later settlement compares against this number.
  - **The GL lines gain currency and rate.** In `issueInvoice`'s `glLines`, every entry gains `currencyCode: documentCurrency, fxRate: frozenRate`. The existing native `debitTotal !== creditTotal` sanity check stays (an invoice is a single-currency document, so its native sums must still match) — keep it and keep its `throw new Error('Invoice posting is unbalanced')`.
  - **The `invoice.issued` and `bill.approved` outbox payloads** gain `fxRate` and `baseTotalCents` alongside the existing `currencyCode`/`totalCents`. Payload additions are backward-compatible; do not rename or remove an existing key.
  - **`voidInvoice`/`voidBill` need no change** — `reverseEntryOnClient` copies currency and rate (see B2).
- **Guardrails:** #1 every new query carries `org_id` · #2 the currency default is resolved in the service, never in the controller · #5 the rate lookup runs on the document's own transaction `client`, so the rate a document freezes and the entry it posts commit together · #6 the freeze happens at issue/approve; an ISSUED invoice's rate is never updated afterwards
- **Proof:** `npm run typecheck` exits 0, then `npm test -- invoices && npm test -- bills && npm test -- invoiceConstraints && npm test -- billConstraints` pass **with no assertion edits** (a base-currency document is unaffected: rate 1, base = native).
- **If it fails:** if an existing test now sees `baseTotalCents: 0`, your draft-save path is not writing the base columns — fix the service, not the migration default.
- **Owes:** `docs/api.md` and `docs/schema.md` (Step C4).

---

### Step C3 — Tests: `fxDocuments.test.ts`

- **Depends on:** C2.
- **Skill:** `isolation-test`
- **Read first:** `server/src/__tests__/ledger-core/invoices.test.ts` (fixture setup, the issue flow, how it asserts on posted GL lines).
- **Files:** `server/src/__tests__/ledger-core/fxDocuments.test.ts` (new)
- **Contract — named cases with exact expected values.** Fixture: an org with `base_currency = 'INR'`, a `USD → INR` rate of `83.00000000` on `2026-01-01`.
  1. **"an invoice in a foreign currency stores the rate and base totals"** — create a draft for $1,000.00 (`subtotalCents: 100000`, no tax) dated `2026-01-10`, `currencyCode: 'USD'` → `fxRate === '83.00000000'`, `baseSubtotalCents === 8300000`, `baseTotalCents === 8300000`.
  2. **"issuing a foreign-currency invoice posts native USD lines with base INR amounts"** — issue it, fetch the journal entry, assert: the `1120` line has `currencyCode === 'USD'`, `debitCents === 100000`, `fxRate === '83.00000000'`, `baseDebitCents === 8300000`; the revenue line mirrors it on the credit side. **This is the worked example's day 1, to the paisa.**
  3. **"a currency with no rate on or before the issue date is refused"** — an invoice dated `2025-12-31` in USD → the draft create returns `422` with a message containing `No exchange rate for USD to INR on or before`.
  4. **"the rate is the latest on or before, not the exact date"** — with rates at `2026-01-01` (83.00) and `2026-02-01` (84.00), an invoice dated `2026-01-15` freezes `83.00000000`.
  5. **"a base-currency invoice is unchanged"** — an INR invoice → `fxRate === '1.00000000'`, `baseTotalCents === totalCents`, and its GL lines carry `currencyCode === 'INR'`.
  6. **"a foreign-currency bill mirrors the invoice"** — the same five assertions against `POST /bills` + `/:id/approve`, with `6100` as the expense account.
  7. **"the trial balance reports a foreign-currency invoice in base currency"** — after case 2, `GET /reports/trial-balance` shows `1120` with a debit of `8300000`, **not** `100000`. This is the Slice B change proving itself end to end.
  8. **Cross-tenant isolation:** org B, whose base is also INR but which has **no** USD rate, cannot create a USD invoice (`422`) even though org A's rate row exists — proving the rate lookup is org-scoped.
- **Proof:** `npm test -- fxDocuments` passes; `npm test` overall stays green.
- **If it fails:** an off-by-one in case 2 means a `convertToBase` call took a rate that had been through a number — trace the string.
- **Owes:** nothing.

---

### Step C4 — Docs for Slice C

- **Depends on:** C1–C3.
- **Skill:** `docs-sync`
- **Files:** `docs/schema.md` (edit — the four new columns on `invoices` and `bills`, their CHECKs, and the "no `base_total = round(total × rate)` constraint" reasoning), `docs/api.md` (edit — `currencyCode` on the invoice and bill create/update bodies, the four new response fields, the new `422`).
- **Proof:** `grep -n "base_total_cents" docs/schema.md` and `grep -n "currencyCode" docs/api.md` both return hits covering invoices and bills.

---

## Slice D — Realized FX on settlement

**Outcome:** settling a foreign-currency invoice or bill at a rate different from the one it was posted at automatically posts the difference to `4910 Realized FX Gain` or `6810 Realized FX Loss`, and the worked example in `docs/ledger-core.md` reproduces to the paisa in a test.

**Names — use exactly these:**

| Kind | Name |
|---|---|
| Migration | `server/src/db/migrations/025_ledger-core_payment_fx.sql` |
| New columns | `payments.fx_rate`, `payments.base_amount_cents`, `payment_allocations.base_amount_cents` |
| New settings columns | `ledger_settings.realized_fx_gain_account_id`, `realized_fx_loss_account_id`, `unrealized_fx_account_id` |
| New trigger | `assert_allocation_currency_matches()` → `trg_allocations_currency` |
| New constraints | `chk_payments_fx_rate`, `fk_ledger_settings_realized_fx_gain_account`, `fk_ledger_settings_realized_fx_loss_account`, `fk_ledger_settings_unrealized_fx_account` |
| Service edits | `paymentService.createPaymentOnClient`, `agingService`, `bankMatchService`, `settingsService` |
| Test files | `server/src/__tests__/ledger-core/fxRealized.test.ts` (new), `server/src/__tests__/ledger-core/fxPaymentConstraints.test.ts` (new) |

---

### Step D1 — Migration `025_ledger-core_payment_fx.sql`

- **Depends on:** C1 applied.
- **Skill:** `new-migration`
- **Read first:** `server/src/db/migrations/014_ledger-core_payments.sql` (the two deferred constraint triggers and the immutability trigger — you are adding a **plain** `BEFORE INSERT` trigger alongside them, not touching theirs) and `012_ledger-core_ap_posting_accounts.sql` (the composite-FK-on-`ledger_settings` idiom you are copying three more times).
- **Files:** `server/src/db/migrations/025_ledger-core_payment_fx.sql` (new)
- **Contract:**
  1. Columns + backfill:
     ```sql
     ALTER TABLE payments ADD COLUMN IF NOT EXISTS fx_rate           NUMERIC(18,8) NOT NULL DEFAULT 1;
     ALTER TABLE payments ADD COLUMN IF NOT EXISTS base_amount_cents BIGINT NOT NULL DEFAULT 0;
     ALTER TABLE payment_allocations ADD COLUMN IF NOT EXISTS base_amount_cents BIGINT NOT NULL DEFAULT 0;

     UPDATE payments            SET base_amount_cents = amount_cents
      WHERE fx_rate = 1 AND base_amount_cents = 0 AND amount_cents <> 0;
     UPDATE payment_allocations SET base_amount_cents = amount_cents
      WHERE base_amount_cents = 0 AND amount_cents <> 0;
     ```
     `chk_payments_fx_rate`: `CHECK (fx_rate > 0 AND fx_rate <= 1000000)`, `pg_constraint`-guarded.
     **`payment_allocations.base_amount_cents` gets no CHECK against a rate** — its rate lives on the *document*, not on the allocation row, and a CHECK cannot reach another table. The service and the aging reconciliation test are what hold it.
  2. Three nullable FX posting-account columns on `ledger_settings`, each with a `pg_constraint`-guarded composite FK to `accounts (org_id, id)` `ON DELETE RESTRICT` and its own index — **copy `012` line for line**, changing only the three names:
     `realized_fx_gain_account_id`, `realized_fx_loss_account_id`, `unrealized_fx_account_id`.
     No backfill: the services fall back to account codes `4910`/`6810`/`6820`, exactly as `resolveControlAccount` falls back to `1120`/`2100` today.
  3. The currency-match trigger:
     ```sql
     CREATE OR REPLACE FUNCTION assert_allocation_currency_matches() RETURNS trigger AS $$
     DECLARE
       payment_currency  CHAR(3);
       document_currency CHAR(3);
     BEGIN
       SELECT currency_code INTO payment_currency
         FROM payments WHERE id = NEW.payment_id AND org_id = NEW.org_id;

       IF NEW.invoice_id IS NOT NULL THEN
         SELECT currency_code INTO document_currency
           FROM invoices WHERE id = NEW.invoice_id AND org_id = NEW.org_id;
       ELSE
         SELECT currency_code INTO document_currency
           FROM bills WHERE id = NEW.bill_id AND org_id = NEW.org_id;
       END IF;

       IF payment_currency IS DISTINCT FROM document_currency THEN
         RAISE EXCEPTION
           'payment currency % cannot settle a document in %', payment_currency, document_currency
           USING ERRCODE = 'P0001';
       END IF;

       RETURN NEW;
     END;
     $$ LANGUAGE plpgsql;

     CREATE OR REPLACE TRIGGER trg_allocations_currency
       BEFORE INSERT ON payment_allocations
       FOR EACH ROW EXECUTE FUNCTION assert_allocation_currency_matches();
     ```
     A plain `BEFORE INSERT`, not deferred: it depends on rows that already exist, so there is no reason to wait for `COMMIT`. Both lookups carry `org_id` — the trigger is a tenancy boundary too.
- **Guardrails:** #1 `org_id` in both trigger lookups · #8 the three new `*_id` columns get composite FKs and indexes · #13 additive, idempotent
- **Proof:** `npm run migrate && npm run migrate && npm test -- migrations && npm test -- payments && npm test -- paymentConstraints` all pass.
- **If it fails:** if `trg_allocations_currency` fires on existing tests, some fixture is allocating across currencies — read the fixture, do not weaken the trigger.
- **Owes:** `docs/schema.md` (Step D6).

---

### Step D2 — `settingsService` exposes the three FX accounts

- **Depends on:** D1 applied.
- **Skill:** `new-module` (service layer)
- **Read first:** `server/src/services/ledger-core/settingsService.ts` (`getSettings`, `updateSettings`, `UpdateSettingsInput`) and `server/src/schemas/ledger-core/settingsSchema.ts` — note how the three Phase 3.9 AP account columns were added, and copy that treatment exactly.
- **Files:** `server/src/services/ledger-core/settingsService.ts` (edit), `server/src/schemas/ledger-core/settingsSchema.ts` (edit), `server/src/types/ledger-core.ts` (edit — `LedgerSettings`)
- **Contract:** `LedgerSettings` gains `realizedFxGainAccountId: string | null; realizedFxLossAccountId: string | null; unrealizedFxAccountId: string | null;`. `updateSettingsSchema` gains the three as `z.string().uuid().nullable().optional()`. `getSettings`' `SELECT` and `updateSettings`' `UPDATE` both grow by three columns, following the existing pattern for `payable_account_id` verbatim.
- **Guardrails:** #1 the composite FK already makes a cross-tenant account unrepresentable; do not add a redundant service check that contradicts it · #4 parameterized
- **Proof:** `npm run typecheck` exits 0; `npm test -- settings` passes.
- **Owes:** `docs/api.md` (Step D6).

---

### Step D3 — Realized FX in `paymentService.createPaymentOnClient`

- **Depends on:** D1, D2, B2, C2.
- **Skill:** `new-module` (service layer) — **this is the heart of the phase; do it in one sitting and do not start Step D4 until its proof is green.**
- **Read first:** `server/src/services/ledger-core/paymentService.ts` lines 400–620 in full (`resolveControlAccount`, `lockAndValidateTargets`, `createPaymentOnClient`), and `docs/ledger-core.md § 3 the worked example` — the test in D5 reproduces it exactly.
- **Files:** `server/src/services/ledger-core/paymentService.ts` (edit), `server/src/schemas/ledger-core/paymentSchema.ts` (edit)
- **Contract:**
  - `CreatePaymentInput` gains `currencyCode?: string` (omitted → base). `createPaymentSchema` gains the same 3-letter regex field as invoices.
  - Replace the unconditional `currencyCode = organizations.base_currency` read with: resolve `baseCurrency`, take `paymentCurrency = input.currencyCode ?? baseCurrency`, and resolve `paymentRate` via `fxRateService.requireRateOnClient(client, orgId, paymentCurrency, baseCurrency, input.paymentDate)` (identity → `ONE_RATE`).
  - `lockAndValidateTargets` additionally selects each target document's `currency_code` and `fx_rate` and returns them on the target record. If any target's `currency_code !== paymentCurrency` → `throw new ApiError(422, \`A ${paymentCurrency} payment cannot settle a document in ${target.currencyCode}\`)`. (The trigger from D1 is the independent second layer — the service raising first is what makes the message readable.)
  - **Building the GL lines — two paths, and the base-currency path must be byte-identical to today:**
    ```
    if (paymentCurrency === baseCurrency) {
      // Unchanged from Phase 3.9: exactly two lines, cash + control, each for
      // the full amountCents at ONE_RATE. Do not restructure this branch.
    } else {
      // Cash line: native paymentCurrency at paymentRate, for input.amountCents.
      // Control lines: ONE PER ALLOCATION — native = allocation.amountCents,
      //   currency = paymentCurrency, rate = that document's frozen fx_rate.
      //   One line per allocation (not grouped) is what keeps every line
      //   satisfying chk_ledger_lines_base_matches_rate while the per-allocation
      //   base amounts still sum exactly to the control total.
      // Then the FX plug (below).
    }
    ```
  - **The FX plug, in both directions, with no sign branch:**
    ```ts
    const baseDebitTotal  = sumCents(glLines.map((l) => convertToBase(cents(l.debitCents),  l.fxRate)));
    const baseCreditTotal = sumCents(glLines.map((l) => convertToBase(cents(l.creditCents), l.fxRate)));
    const imbalance = baseDebitTotal - baseCreditTotal;

    if (imbalance > 0) {
      // More base value came in than the documents were carried at: a gain.
      glLines.push({ accountId: gainAccountId, debitCents: 0, creditCents: imbalance,
                     currencyCode: baseCurrency, fxRate: ONE_RATE });
    } else if (imbalance < 0) {
      glLines.push({ accountId: lossAccountId, debitCents: -imbalance, creditCents: 0,
                     currencyCode: baseCurrency, fxRate: ONE_RATE });
    }
    ```
    Comment this with both directions of the worked example: a $1,000 **receivable** carried at 83.00 and settled at 83.50 gives `imbalance = +50000` → credit `4910`; a $1,000 **payable** in the same circumstances gives `imbalance = −50000` → debit `6810`. Same arithmetic, opposite sign, because a liability moves the other way.
  - **`resolveFxAccount(client, orgId, kind)`** — a new private helper mirroring `resolveControlAccount`: read `ledger_settings.realized_fx_gain_account_id` / `realized_fx_loss_account_id`, falling back to account code `4910` / `6810`. On neither → `throw new ApiError(422, 'No realized FX gain account is configured. Set one in settings.')` (and the loss equivalent). **Resolve it lazily — only when `imbalance !== 0`** — so an org that deleted `4910` can still take base-currency payments.
  - The `payments` INSERT gains `fx_rate` and `base_amount_cents = convertToBase(cents(input.amountCents), paymentRate)`.
  - The `payment_allocations` INSERT gains a `base_amount_cents` array: `convertToBase(cents(a.amountCents), targetDocumentRate)` per allocation.
  - The `payment.recorded` outbox payload gains `fxRate`, `baseAmountCents`, and `realizedFxCents` (the signed `imbalance`, `0` when there is none). Existing keys are untouched.
  - **`voidPaymentOnClient` needs no change** — the reversal copies currency and rate, so voiding an FX payment reverses its realized gain or loss too. Add a one-line comment saying so.
- **Guardrails:** #1 every added query carries `org_id` · #3 the plug is integer cents arithmetic; never `Math.round` a product · #5 everything on the caller's `client` — `bankMatchService` calls this half inside its own transaction · #7 each pushed line has exactly one side > 0 · #10 no new status is introduced; `PAYMENT_TRANSITIONS` is untouched
- **Proof:** `npm run typecheck` exits 0, then `npm test -- payments && npm test -- paymentConstraints && npm test -- bankMatching && npm test -- aging` **all pass with no assertion edits** — that is the proof the base-currency path did not move.
- **If it fails:** if an existing payment test now sees three GL lines instead of two, you took the FX branch for a base-currency payment — the `paymentCurrency === baseCurrency` guard is wrong. **Do not edit the test.**
- **Owes:** the realized-FX study note (Step S3).

---

### Step D4 — Aging reconciles in base currency; bank matching refuses FX documents

- **Depends on:** D3.
- **Skill:** none — a targeted change in two services.
- **Read first:** `server/src/services/ledger-core/agingService.ts` (the `outstanding_cents` expression at line ~62, the bucket sums, and the GL control-balance query at ~199) and `server/src/services/ledger-core/bankMatchService.ts` (the candidate query and `matchTransaction`).
- **Files:** `server/src/services/ledger-core/agingService.ts` (edit), `server/src/services/ledger-core/bankMatchService.ts` (edit)
- **Contract:**
  - **Aging:** add a second outstanding expression in base currency —
    `(d.base_total_cents - COALESCE(<sum of allocation base_amount_cents for POSTED payments>, 0)) AS base_outstanding_cents` — and use **that** for the bucket totals and for the `reconciles` comparison against the GL control account, which is already a base-currency figure. Extend `allocatedCentsSubquery(alias, column)` with a third parameter rather than writing a second near-duplicate subquery:
    ```ts
    export function allocatedCentsSubquery(
      alias: string,
      column: 'invoice_id' | 'bill_id',
      amountColumn: 'amount_cents' | 'base_amount_cents' = 'amount_cents',
    ): string;
    ```
    `amountColumn` is whitelisted by its union type and interpolated — that is rule 4's sanctioned identifier-whitelisting path, and the default keeps all 11 existing call sites unchanged. Add the native outstanding to each counterparty row as `outstandingCents` (unchanged) and the base figure as `baseOutstandingCents` on `AgingCounterpartyRow`; the report's totals and `reconciles` use the base figures. Document in a comment that a mixed-currency AR ledger's *total* is only meaningful in base currency.
  - **Bank matching:** in the candidate-selection query, add `AND d.currency_code = $n` bound to the org's base currency, so a foreign-currency document is never offered as a suggestion (a base-currency bank line cannot settle it). In `matchTransaction`, before creating the payment, re-read the target document's `currency_code` and, if it differs from the base currency, `throw new ApiError(422, 'A base-currency bank line cannot settle a foreign-currency document')`. Comment: multi-currency bank statements are deliberately not built (Phase 6's stated limit), so this is a guard, not a gap.
- **Guardrails:** #1 unchanged · #4 `amountColumn` is whitelisted by its union type, never a caller-supplied string
- **Proof:** `npm test -- aging && npm test -- bankMatching && npm test -- bankReconciliation` pass; `grep -n "amountColumn" server/src/services/ledger-core/agingService.ts` shows it used only with the two literal values.
- **If it fails:** if `reconciles` goes false in an existing test, the aging query and the GL query disagree about which allocations count — both must filter `p.status = 'POSTED'`.
- **Owes:** `docs/api.md` (Step D6).

---

### Step D5 — Tests: the worked example, to the paisa

- **Depends on:** D3, D4.
- **Skill:** `isolation-test`
- **Read first:** `docs/ledger-core.md § 3 the worked example` and `server/src/__tests__/ledger-core/payments.test.ts`.
- **Files:** `server/src/__tests__/ledger-core/fxRealized.test.ts` (new), `server/src/__tests__/ledger-core/fxPaymentConstraints.test.ts` (new)
- **Contract — `fxRealized.test.ts`, named cases with exact expected values.** Fixture: org base `INR`; `USD → INR` rates `83.00000000` on `2026-01-01` and `83.50000000` on `2026-01-10`.
  1. **"the documented worked example reproduces exactly — a receivable settled high is a gain"** — issue a $1,000.00 USD invoice dated `2026-01-01`; receive a $1,000.00 USD payment dated `2026-01-10` against it. Assert the settlement entry has exactly three lines:
     | Account | debitCents | creditCents | currencyCode | fxRate | baseDebitCents | baseCreditCents |
     |---|---|---|---|---|---|---|
     | `1110` | 100000 | 0 | USD | 83.50000000 | 8350000 | 0 |
     | `1120` | 0 | 100000 | USD | 83.00000000 | 0 | 8300000 |
     | `4910` | 0 | 50000 | INR | 1.00000000 | 0 | 50000 |
     **This is the roadmap's stated acceptance criterion for Phase 8. Name the test so it is findable: `reproduces docs/ledger-core.md's worked example to the paisa`.**
  2. **"the mirror case — a payable settled high is a loss"** — the same fixture with a $1,000.00 USD bill approved at 83.00 and paid at 83.50: `2100` debit 100000 USD @ 83.00 (base 8300000), `1110` credit 100000 USD @ 83.50 (base 8350000), `6810` **debit** 50000 INR @ 1 (base 50000).
  3. **"a settlement at the same rate posts no FX line"** — pay on `2026-01-05` (still 83.00) → exactly two lines, no `4910`/`6810`.
  4. **"a base-currency payment is unchanged"** — an INR invoice settled by an INR payment → exactly two lines, `fxRate === '1.00000000'` on both.
  5. **"a partial settlement realizes FX only on the portion settled"** — settle $400.00 of the $1,000.00 at 83.50 → cash base 3340000, control base 3320000, gain 20000.
  6. **"a payment settling two documents at different rates posts one control line each"** — two USD invoices frozen at 83.00 and 84.00, one $2,000.00 payment at 83.50 → four lines: cash, two control lines, one plug; assert the plug is `imbalance = 8350000 − (8300000 + 8400000) = −350000` → a **debit to `6810`** of 350000.
  7. **"voiding an FX payment reverses the realized gain"** — void case 1's payment; the reversal entry has a `4910` **debit** of 50000, and `GET /reports/ar-aging` shows the invoice outstanding again.
  8. **"AR aging reconciles against the GL with a foreign-currency invoice outstanding"** — after case 1's invoice is issued but before payment, `GET /reports/ar-aging` → `reconciles === true` and the total equals 8300000.
  9. **Cross-tenant isolation:** org B cannot allocate a payment to org A's invoice (`422`/`404`, never a posted entry), and org B's `4910` is never touched by org A's settlement.

  **`fxPaymentConstraints.test.ts` — raw SQL, bypassing every service:**
  1. **"an allocation whose payment currency differs from its document's is rejected on INSERT"** — insert a USD payment and an INR invoice directly, then insert the allocation → fails with a message containing `cannot settle a document in`.
  2. **"the currency guard is org-scoped"** — org A's payment cannot allocate to org B's invoice; the composite FK rejects it first, which is the correct layering — assert the insert fails.
- **Proof:** `npm test -- fxRealized && npm test -- fxPaymentConstraints` pass, then the full `npm test` is green.
- **If it fails:** a plug of ±1 cent means you grouped control lines instead of emitting one per allocation — go back to D3's contract.
- **Owes:** nothing.

---

### Step D6 — Docs for Slice D

- **Depends on:** D1–D5.
- **Skill:** `docs-sync`
- **Files:** `docs/schema.md` (edit — the payment/allocation columns, the three `ledger_settings` columns, `trg_allocations_currency`), `docs/api.md` (edit — `currencyCode` on `POST /payments`; the new `422`s; `baseOutstandingCents` on both aging reports; the three FX account fields on `PATCH /settings`).
- **Proof:** `grep -n "realized_fx" docs/schema.md` and `grep -n "baseOutstandingCents" docs/api.md` both return hits.

---

## Slice E — Period-end unrealized revaluation

**Outcome:** an organization can see its open foreign-currency exposure at any date, and post a revaluation entry (with an automatic next-day reversal) that restates open AR/AP at the period-end rate through `6820 Unrealized FX Gain/Loss`.

**Names — use exactly these:**

| Kind | Name |
|---|---|
| Migration | `server/src/db/migrations/026_ledger-core_fx_revaluations.sql` |
| Tables | `fx_revaluations`, `fx_revaluation_lines` |
| `fx_revaluations` columns | `id, org_id, as_of_date, journal_entry_id, reversal_journal_entry_id, total_delta_cents, line_count, created_by, created_at` |
| `fx_revaluation_lines` columns | `id, org_id, revaluation_id, invoice_id, bill_id, currency_code, outstanding_cents, document_rate, revaluation_rate, carrying_base_cents, revalued_base_cents, delta_cents, created_at` |
| Types | `FxExposureRow`, `FxExposureReport`, `FxRevaluation`, `FxRevaluationLine` |
| Service file / exports | `server/src/services/ledger-core/fxRevaluationService.ts` → `computeExposure`, `runRevaluation`, `listRevaluations`, `getRevaluationById` |
| Controller | `server/src/controllers/ledger-core/fxRevaluationController.ts` → `list`, `getOne`, `run` |
| Routes file | `server/src/routes/ledger-core/fxRevaluationRoutes.ts` |
| Route base | `/api/v1/ledger-core/fx-revaluations` (+ `GET /reports/fx-exposure`) |
| New event | `'fx.revaluation_posted'` in `OUTBOX_EVENT_TYPES` |
| Test file | `server/src/__tests__/ledger-core/fxRevaluation.test.ts` |

---

### Step E1 — Migration `026_ledger-core_fx_revaluations.sql`

- **Depends on:** D1 applied.
- **Skill:** `new-migration`
- **Read first:** `019_ledger-core_bank_reconciliation.sql` (a parent table plus a child detail table with composite FKs) and `018_platform_audit_triggers.sql` (the audit-trigger attachment).
- **Files:** `server/src/db/migrations/026_ledger-core_fx_revaluations.sql` (new)
- **Contract:**
  ```sql
  CREATE TABLE IF NOT EXISTS fx_revaluations (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                    UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    as_of_date                DATE NOT NULL,
    journal_entry_id          UUID NOT NULL,
    reversal_journal_entry_id UUID NOT NULL,
    total_delta_cents         BIGINT NOT NULL,
    line_count                INTEGER NOT NULL CHECK (line_count > 0),
    created_by                UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ux_fx_revaluations_org_id_id UNIQUE (org_id, id),
    CONSTRAINT ux_fx_revaluations_org_date  UNIQUE (org_id, as_of_date),
    CONSTRAINT fk_fx_revaluations_entry
      FOREIGN KEY (org_id, journal_entry_id) REFERENCES journal_entries (org_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_fx_revaluations_reversal
      FOREIGN KEY (org_id, reversal_journal_entry_id) REFERENCES journal_entries (org_id, id) ON DELETE RESTRICT
  );
  ```
  `total_delta_cents` has **no** `>= 0` CHECK — a revaluation delta is signed by nature (this is one of the few genuinely signed money columns in the schema, like `bank_transactions.amount_cents`). Say so in a comment.
  `fx_revaluation_lines` mirrors `invoice_lines`' shape: `org_id` + a composite FK to `fx_revaluations (org_id, id)` `ON DELETE CASCADE`, composite FKs to `invoices`/`bills` `ON DELETE RESTRICT`, `CHECK ((invoice_id IS NULL) <> (bill_id IS NULL))` (exactly one populated — copy the idiom from `payment_allocations`), `document_rate`/`revaluation_rate` as `NUMERIC(18,8)`, and the three `BIGINT` cents columns (`delta_cents` signed, the other two `>= 0`).
  Indexes: `idx_fx_revaluations_org_date ON fx_revaluations (org_id, as_of_date DESC)`, `idx_fx_revaluation_lines_revaluation ON fx_revaluation_lines (revaluation_id)`, plus one per FK used in a join.
  Attach `audit_row_change('ledger-core')` to **`fx_revaluations` only** — the detail lines are derived from it and regenerated nowhere, exactly the reasoning that left `bank_match_suggestions` unaudited in Phase 6. State the reason in a comment.
  **No status column, no immutability trigger, no FSM** — see decision 14. Write that decision into the file's header comment so nobody adds one later.
- **Guardrails:** #8 every `*_id` has a `REFERENCES` and an explicit `ON DELETE`; every join FK indexed · #10 deliberately no lifecycle — recorded in the header comment · #13 additive, idempotent
- **Proof:** `npm run migrate && npm run migrate && npm test -- migrations` pass.
- **Owes:** `docs/schema.md` (Step E5).

---

### Step E2 — `fxRevaluationService`

- **Depends on:** E1 applied, A4, B2, D2.
- **Skill:** `new-module` (service layer)
- **Read first:** `server/src/services/ledger-core/agingService.ts` (how outstanding-per-document is computed and how a report reconciles to a control account) and `server/src/services/ledger-core/billService.ts`'s `approveBill` (a service that posts a GL entry inside its own transaction and emits an outbox event).
- **Files:** `server/src/services/ledger-core/fxRevaluationService.ts` (new), `server/src/types/ledger-core.ts` (edit — append the four interfaces), `server/src/types/webhooks.ts` (edit — add `'fx.revaluation_posted'` to `OUTBOX_EVENT_TYPES`, after `'bank.large_unmatched'`)
- **Contract:**
  ```ts
  export interface FxExposureDocument {
    documentType: 'INVOICE' | 'BILL';
    documentId: string;
    documentNumber: string | null;
    counterpartyName: string;
    currencyCode: string;
    outstandingCents: number;      // native, the document's own currency
    documentRate: string;
    revaluationRate: string;
    carryingBaseCents: number;     // outstanding x documentRate
    revaluedBaseCents: number;     // outstanding x revaluationRate
    deltaCents: number;            // revalued - carrying, signed
  }

  export interface FxExposureReport {
    asOfDate: string;
    baseCurrency: string;
    documents: FxExposureDocument[];
    /** Per-currency subtotals, ordered by currencyCode ASC. */
    byCurrency: { currencyCode: string; outstandingCents: number; carryingBaseCents: number; revaluedBaseCents: number; deltaCents: number }[];
    totalDeltaCents: number;
    /** true when a revaluation already exists for asOfDate. */
    alreadyRevalued: boolean;
  }

  export async function computeExposure(orgId: string, asOfDate: string): Promise<FxExposureReport>;

  export async function runRevaluation(
    orgId: string,
    createdBy: string,
    asOfDate: string,
  ): Promise<FxRevaluation>;

  export async function listRevaluations(
    orgId: string,
    options: { page: number; limit: number },
  ): Promise<{ revaluations: FxRevaluation[]; totalCount: number }>;

  export async function getRevaluationById(orgId: string, id: string): Promise<FxRevaluation>;
  ```
  - **`computeExposure`** selects, for each `ISSUED` invoice and `POSTED` bill where `currency_code <> baseCurrency` and `issue_date`/`bill_date` `<= asOfDate`:
    outstanding native `= total_cents − COALESCE(Σ allocations.amount_cents for POSTED payments with payment_date <= asOfDate, 0)`, keeping only rows where that is `> 0`; the document's frozen `fx_rate` as `documentRate`; and the revaluation rate from `fxRateService.requireRateOnClient(pool, orgId, currencyCode, baseCurrency, asOfDate)` — resolved **once per distinct currency**, not once per document.
    `carryingBaseCents = convertToBase(outstanding, documentRate)`, `revaluedBaseCents = convertToBase(outstanding, revaluationRate)`, `deltaCents = revalued − carrying`.
    `alreadyRevalued` is a `SELECT 1 FROM fx_revaluations WHERE org_id = $1 AND as_of_date = $2`.
    **`computeExposure` writes nothing and posts nothing.** It is the preview that makes running a revaluation safe.
  - **`runRevaluation`** opens its own transaction (`pool.connect()` + `beginTransaction`, matching `issueInvoice`), and:
    1. Re-computes the exposure **on the transaction client** — never trusting a figure the caller passed in.
    2. `documents.length === 0` → `throw new ApiError(422, 'There is no open foreign-currency balance to revalue on this date')`.
    3. Sums the deltas separately for AR (invoices) and AP (bills).
    4. Builds the GL lines, all in base currency at `ONE_RATE`:
       - AR delta `> 0` → **debit** the receivable control account by the delta; AR delta `< 0` → **credit** it.
       - AP delta `> 0` (a liability is worth more in base) → **credit** the payable control account; AP delta `< 0` → **debit** it.
       - The `6820` line is the plug, exactly as in D3: `imbalance = Σ baseDebit − Σ baseCredit`; `> 0` → credit `6820`, `< 0` → debit `6820`. **One account for both directions** — `6820 Unrealized FX Gain/Loss` is deliberately a single account, unlike the realized pair.
       - Resolve the control accounts by reusing `paymentService`'s existing fallbacks (`ledger_invoice_settings.receivable_account_id` → `1120`; `ledger_settings.payable_account_id` → `2100`) — **export a helper from `paymentService` rather than duplicating the SQL**, or call `resolveControlAccount` if you make it exported. Resolve `6820` via `ledger_settings.unrealized_fx_account_id` falling back to code `6820`.
    5. Posts the entry with `journalService.createEntryOnClient(client, orgId, createdBy, { entryDate: asOfDate, description: \`Unrealized FX revaluation — ${asOfDate}\`, sourceType: 'fx_revaluation', sourceId: revaluationId, lines })`, generating `revaluationId` up front with `SELECT gen_random_uuid()` the way `createPaymentOnClient` does.
    6. Posts the automatic reversal with `journalService.reverseEntryOnClient(client, orgId, createdBy, entryId, nextDay(asOfDate))`, where `nextDay` is a local helper adding one calendar day to a `YYYY-MM-DD` string **without a `Date` round-trip** (a `DATE` is a calendar fact — see `db/connect.ts`'s type parser). Comment: the reversal is what keeps realized FX honest at settlement, which always compares the settlement rate against the document's original frozen rate.
    7. Inserts `fx_revaluations` and one `fx_revaluation_lines` row per document (one multi-row `unnest` insert, never one statement per line).
    8. `emitEvent(client, orgId, 'ledger-core', 'fx.revaluation_posted', { revaluationId, asOfDate, baseCurrency, totalDeltaCents, lineCount, journalEntryId, reversalJournalEntryId })` — **on the transaction client**, so the event commits with the posting or not at all.
    9. `COMMIT`, then `return await getRevaluationById(orgId, revaluationId)`.
    On `23505` against `ux_fx_revaluations_org_date` → `throw new ApiError(409, 'A revaluation already exists for this date')`.
  - `getRevaluationById` returns the parent plus its lines (a second query, `WHERE org_id = $1 AND revaluation_id = $2`), `404` when absent.
- **Guardrails:** #1 `org_id` in every statement · #2 no `req`/`res` · #3 signed integer cents; the plug is integer subtraction · #5 every query on `client`; the outbox write is on `client`, never `pool`; **no work after `COMMIT`** · #6 the posting is immutable — there is no update path, and a wrong revaluation is corrected by the next period's revaluation, which is stated in the docs · #16 `source_type = 'fx_revaluation'` follows the same GL-hook convention every document uses
- **Proof:** `npm run typecheck` exits 0, and `grep -n "pool.query" server/src/services/ledger-core/fxRevaluationService.ts` shows no `pool.query` inside `runRevaluation`'s transaction.
- **If it fails:** if `reverseEntryOnClient` throws a period-closed error, the day after `asOfDate` falls in a closed period — that is correct behaviour; surface it as the `422` it already is, do not bypass the guard.
- **Owes:** `docs/api.md`, `docs/schema.md` (Step E5); a study note on unrealized revaluation (Step S3).

---

### Step E3 — Controller, routes, mount, and the exposure report

- **Depends on:** E2.
- **Skill:** `new-module` (controller + routes layers)
- **Read first:** `server/src/controllers/ledger-core/reportController.ts` (how a report controller reads query params and shapes its envelope) and `server/src/routes/ledger-core/fiscalPeriodRoutes.ts` (role gating on a state-changing POST).
- **Files:**
  - `server/src/controllers/ledger-core/fxRevaluationController.ts` (new)
  - `server/src/routes/ledger-core/fxRevaluationRoutes.ts` (new)
  - `server/src/routes/ledger-core/index.ts` (edit — `router.use('/fx-revaluations', fxRevaluationRoutes);` in alphabetical position)
  - `server/src/controllers/ledger-core/reportController.ts` (edit — add `fxExposure`)
  - `server/src/routes/ledger-core/reportRoutes.ts` (edit — add `router.get('/fx-exposure', authenticate, reportController.fxExposure);`)
  - `server/src/schemas/ledger-core/fxRevaluationSchema.ts` (new — `runRevaluationSchema`)
- **Contract:**

  | Method | Path | Roles | Success | Failures |
  |---|---|---|---|---|
  | GET | `/api/v1/ledger-core/reports/fx-exposure?asOf=YYYY-MM-DD` | any member | `200` `{ success: true, exposure }` | `400` bad `asOf`; `422` a currency has no rate on or before `asOf` |
  | GET | `/api/v1/ledger-core/fx-revaluations` | any member | `200` `{ success: true, revaluations, count, totalCount, currentPage, totalPages }` | — |
  | GET | `/api/v1/ledger-core/fx-revaluations/:id` | any member | `200` `{ success: true, revaluation }` (with `lines`) | `404` |
  | POST | `/api/v1/ledger-core/fx-revaluations` | `OWNER`,`ADMIN` | `201` `{ success: true, revaluation }` | `400` body; `409` already revalued for that date; `422` nothing to revalue / no rate / closed period |

  `runRevaluationSchema = z.object({ asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'asOfDate must be YYYY-MM-DD') })`.
  `fxExposure` defaults `asOf` to today's UTC date when the param is absent, matching how the other date-bounded reports default.
- **Guardrails:** #2 zero SQL in either controller · #1 org from `requireUser(req).orgId` only
- **Proof:** `npm run typecheck` exits 0; `npm run dev` boots; `grep -n "pool" server/src/controllers/ledger-core/fxRevaluationController.ts` returns nothing.
- **Owes:** `docs/api.md` (Step E5).

---

### Step E4 — Tests: `fxRevaluation.test.ts`

- **Depends on:** E2, E3.
- **Skill:** `isolation-test`
- **Read first:** `server/src/__tests__/ledger-core/statements.test.ts` (a non-trivial multi-document fixture with exact arithmetic) and `server/src/__tests__/ledger-core/outboxEmission.test.ts` (how an emitted event is asserted).
- **Files:** `server/src/__tests__/ledger-core/fxRevaluation.test.ts` (new)
- **Contract — named cases with exact expected values.** Fixture: org base `INR`; a $1,000.00 USD invoice issued `2026-01-05` at rate `83.00000000`; rates `USD→INR` `83.00000000` on `2026-01-01` and `84.00000000` on `2026-01-31`.
  1. **"exposure shows the unrealized delta without posting anything"** — `GET /reports/fx-exposure?asOf=2026-01-31` → one document, `carryingBaseCents === 8300000`, `revaluedBaseCents === 8400000`, `deltaCents === 100000`, `totalDeltaCents === 100000`, `alreadyRevalued === false`; assert the journal-entry count is unchanged by the call.
  2. **"a revaluation posts an entry and an automatic next-day reversal"** — `POST /fx-revaluations { asOfDate: '2026-01-31' }` → `201`; the entry dated `2026-01-31` debits `1120` 100000 and credits `6820` 100000; a second entry dated `2026-02-01` reverses it exactly, with `reversesEntryId` pointing at the first.
  3. **"a payable revalues in the opposite direction"** — a $1,000.00 USD bill at 83.00 revalued at 84.00 → **credit** `2100` 100000, **debit** `6820` 100000.
  4. **"a settled document is not revalued"** — fully settle the invoice on `2026-01-20`, then revalue at `2026-01-31` → `422`, message contains `no open foreign-currency balance`.
  5. **"a partially settled document revalues only the outstanding portion"** — settle $400.00, revalue the remaining $600.00 at 84.00 → `deltaCents === 60000`.
  6. **"revaluing the same date twice is refused"** — a second `POST` for `2026-01-31` → `409`.
  7. **"a base-currency-only organization has nothing to revalue"** — an org with only INR documents → `422`, and `GET /reports/fx-exposure` returns an empty `documents` array with `totalDeltaCents === 0`, never an error.
  8. **"the balance sheet still balances after a revaluation"** — `GET /reports/balance-sheet` as of `2026-01-31` → `assets === liabilities + equity` by **integer equality**. This is the case that proves a mixed-currency ledger is still a coherent one.
  9. **"the revaluation emits fx.revaluation_posted on the same transaction"** — assert one `outbox_events` row with that type and `payload.revaluationId` matching the response.
  10. **"revaluing into a closed period is refused"** — close the period containing `2026-01-31`, then `POST` → `422` from the period guard, and assert **no** `fx_revaluations` row was written (the transaction rolled back whole).
  11. **Cross-tenant isolation:** org B `GET /fx-revaluations/:idFromA` → `404`; org B's exposure report never lists org A's documents; org B's `6820` has a zero balance after org A revalues.
- **Proof:** `npm test -- fxRevaluation` passes; full `npm test` green; `npm run verify:integrity` exits 0 against a database that has run a revaluation.
- **If it fails:** if case 8 fails, the plug landed on the wrong side — re-read E2's step 4 and check the AP sign, which is the one that inverts.
- **Owes:** nothing.

---

### Step E5 — Docs for Slice E

- **Depends on:** E1–E4.
- **Skill:** `docs-sync`
- **Files:** `docs/schema.md` (both tables, the deliberate absence of a status column, why the detail lines are unaudited), `docs/api.md` (the four routes, including `GET /reports/fx-exposure`, with every status code), `docs/api.md`'s webhook-events list (add `fx.revaluation_posted` and its payload shape).
- **Proof:** `grep -n "fx.revaluation_posted" docs/api.md` returns a hit; every route in `fxRevaluationRoutes.ts` and the new report route appear in `docs/api.md`.

---

## Slice F — Client

**Outcome:** rates are manageable, currency is selectable where it matters, and exposure and revaluations are visible. **Every step here depends on Slices A–E being green; the steps within F are independent of one another.**

**Names — use exactly these:**

| Kind | Name |
|---|---|
| New pages | `client/src/Pages/ledger-core/FxRatesPage.tsx`, `FxExposurePage.tsx`, `FxRevaluationsPage.tsx` |
| Edited pages | `NewInvoicePage.tsx`, `NewBillPage.tsx`, `PaymentDialog.tsx`, `InvoiceDetailPage.tsx`, `BillDetailPage.tsx`, `LedgerCoreSidebar.tsx`, `LedgerCoreRoutes.tsx`, `ReportsPage.tsx` |
| Routes | `/app/ledger-core/fx-rates`, `/app/ledger-core/fx-exposure`, `/app/ledger-core/fx-revaluations` |
| Sidebar group | `Currency` |
| Test files | `client/src/__tests__/ledgerCoreFxRates.test.tsx`, `ledgerCoreFxRevaluation.test.tsx` |

---

### Step F1 — `FxRatesPage` and the sidebar group

- **Depends on:** A5.
- **Skill:** none — a client page.
- **Read first:** `client/src/Pages/ledger-core/CustomersPage.tsx` (a list + inline create form with the same table styling) and `client/src/Pages/ledger-core/LedgerCoreSidebar.tsx` (how the Banking and Automation groups were added).
- **Files:** `FxRatesPage.tsx` (new), `LedgerCoreSidebar.tsx` (edit), `LedgerCoreRoutes.tsx` (edit)
- **Contract:** a table of rates (From, To, Date, Rate, Source, actions) with `from`/`fromCode` filters and pagination, plus a create form posting `{ fromCode, toCode, rateDate, rate }` — `rate` sent as a **string**, taken from a text input, never a `<input type="number">` whose value would round-trip through a float. `toCode` is fixed to the org's base currency from `LedgerSettingsContext`/`OrgContext` and shown read-only, with a one-line explanation that rates are always recorded foreign → base. Delete is gated by `ConfirmDialog`. A new sidebar group **Currency** holds Rates, Exposure, Revaluations.
- **Proof:** `cd client && npm run typecheck && npm test` — existing 144 client tests still pass.

---

### Step F2 — Currency selection on documents and payments

- **Depends on:** C2, D3, F1.
- **Skill:** none.
- **Read first:** `NewInvoicePage.tsx` (the draft form and how it posts), `PaymentDialog.tsx` (how it defaults the amount to what is due).
- **Files:** `NewInvoicePage.tsx`, `NewBillPage.tsx`, `PaymentDialog.tsx`, `InvoiceDetailPage.tsx`, `BillDetailPage.tsx` (all edits)
- **Contract:**
  - A currency `<select>` on the invoice and bill draft forms, defaulting to the org's base currency, whose options are the distinct `fromCode`s from `GET /fx-rates` **plus** the base currency. When a non-base currency is chosen, show the resolved rate from `GET /fx-rates/latest?from=<code>&on=<documentDate>` and the base-currency total beneath the native total, live. A `422` from the rate lookup renders inline as "No exchange rate for USD on or before 2026-01-05 — add one under Currency → Rates" with a link, **never** a silent fallback to rate 1.
  - `PaymentDialog` sends the **document's** currency (it cannot differ — the server refuses) and shows the settlement-date rate plus the realized gain or loss it will post, computed client-side for display only and labelled as an estimate.
  - `InvoiceDetailPage`/`BillDetailPage` show `currencyCode`, `fxRate`, and the base-currency total for a foreign-currency document, and show nothing extra for a base-currency one.
- **Proof:** `cd client && npm run typecheck && npm test` passes.

---

### Step F3 — `FxExposurePage` and `FxRevaluationsPage`

- **Depends on:** E3, F1.
- **Skill:** none.
- **Read first:** `BankReconciliationPage.tsx` (a report page with an as-of control) and `FiscalPeriodsPage.tsx` (a register whose one irreversible action is `ConfirmDialog`-gated).
- **Files:** `FxExposurePage.tsx` (new), `FxRevaluationsPage.tsx` (new), `ReportsPage.tsx` (edit — add an FX exposure card), `LedgerCoreRoutes.tsx` (edit)
- **Contract:** `FxExposurePage` takes an as-of date, renders the per-currency subtotals and the per-document table, and carries a **Post revaluation** button gated by `ConfirmDialog` — the dialog names the entry date, the reversal date, and the total delta, because posting is irreversible. The button is hidden when `alreadyRevalued` is true, replaced by a link to that revaluation. `FxRevaluationsPage` lists revaluations and expands one to its lines and its two journal-entry links.
- **Proof:** `cd client && npm run typecheck && npm test` passes.

---

### Step F4 — Client tests

- **Depends on:** F1–F3.
- **Skill:** none.
- **Read first:** `client/src/__tests__/ledgerCoreBankTransactions.test.tsx` (mocking fetch, asserting a `ConfirmDialog` gate).
- **Files:** `client/src/__tests__/ledgerCoreFxRates.test.tsx` (new), `client/src/__tests__/ledgerCoreFxRevaluation.test.tsx` (new)
- **Contract — named cases:**
  1. "renders the rate list and posts a new rate as a string" — assert the request body's `rate` is `'83.5'`, a string, not `83.5`.
  2. "shows the resolved rate and base total when a foreign currency is selected on an invoice draft".
  3. "shows an inline error and no base total when the rate lookup returns 422".
  4. "posting a revaluation requires confirmation" — the button opens `ConfirmDialog`; no request fires until Confirm.
  5. "hides the post button when the date is already revalued".
- **Proof:** `cd client && npm test` — 144 pre-existing plus the new cases, all green.

---

## 6. The spine — every plan ends here

### Step S1 — Full test pass

- **Depends on:** every slice.
- **Proof, run in this order:**
  ```
  cd server && npm run typecheck && npm run lint && npm test
  cd ../client && npm run typecheck && npm test
  cd ../server && npm run verify:integrity
  ```
  Expect roughly **790–820 server tests** (717 + ~75–100 new) and **~160 client tests**. **Record the actual numbers** — they go into `CLAUDE.md` and the roadmap.
  Then re-prove idempotency from a clean database: `npm run db:reset && npm run migrate && npm test`.
- **If it fails:** a failure in a pre-existing test after everything was green slice by slice means two slices interact — most likely D3's payment lines and D4's aging query. Read both before changing either.

### Step S2 — `guardrail-review`

- **Skill:** `guardrail-review`
- **Scope:** the full diff — 5 migrations, ~15 server files, ~10 client files.
- **Pay particular attention to:** rule 1 (`org_id` on `fx_rates`' lookup and inside `assert_allocation_currency_matches`), rule 3 (no float ever multiplies a rate — `grep -rn "Number(.*rate\|parseFloat" server/src` must return nothing outside `fxRate.ts`'s `parseInt`), rule 4 (`allocatedCentsSubquery`'s new `amountColumn` is union-typed, never caller-supplied text), rule 5 (`runRevaluation` and `createPaymentOnClient` do all work on the transaction client, with no post-`COMMIT` follow-up), rule 6 (nothing added a `PUT`/`PATCH` on a posted document or a revaluation), rule 14 (`git diff server/package.json` is **empty** — this phase adds zero dependencies).
- **Proof:** the review reports no findings, or every finding is fixed and the suite re-run.

### Step S3 — Study notes

- **Skill:** `study-note`
- **Files:**
  1. **`study/postgresql/multi-currency-and-functional-currency.md` (new)** — the big one. Why base currency is what balances; why summing native amounts across currencies is meaningless; how `assert_journal_entry_balanced` became conditional on `COUNT(DISTINCT currency_code)` without weakening anything for single-currency entries; `chk_ledger_lines_base_matches_rate` and why Postgres `round(numeric)` and `scaleCents` agree for non-negative values; why the rate is `NUMERIC(18,8)` and not a float, and why `pg` hands it back as a string; the latest-on-or-before lookup and the Saturday bug an exact-date match is waiting for. **Alternatives rejected:** a second `journal_entries.currency_code` column (an entry is not single-currency); storing an inverse rate (two ways to say the same thing is one way too many); a per-account currency (rejected — decision 16); `DECIMAL` amounts with a float rate (the precise mistake that killed the prior build). 4–8 interview questions with full written answers, including "why can't a CHECK constraint enforce that an entry balances?" and "your ledger has a USD line and an INR line in one entry — what does 'balanced' mean?"
  2. **`study/architecture/realized-and-unrealized-fx.md` (new)** — the accounting mechanism as an engineering problem: the plug-line technique and why `imbalance = ΣbaseDebit − ΣbaseCredit` handles both directions with no sign branch; why a document freezes its rate at posting and never after; why revaluation posts a next-day reversal (so realized FX always compares against the original frozen rate); why unrealized uses one account and realized uses two; why settlement is still derived, never stored. Include the worked example from `docs/ledger-core.md` and both directions.
  3. **`study/typescript/branded-types-for-money.md` (extend)** — a section on why a **rate** is deliberately *not* branded and stays a `string` end to end: it is not money, it needs more precision than a `number` can carry across a JSON boundary, and `rateNumerator` is the single chokepoint where it becomes a number.
  4. **`study/postgresql/derived-vs-stored-state.md`** — check whether this note lives in `study/architecture/` (it does: `study/architecture/derived-vs-stored-state.md`) and **extend it** with `payment_allocations.base_amount_cents`: the one place this codebase deliberately *stores* a derived figure, because recomputing a rounded conversion at read time could drift from the ledger line by a cent, and a subledger that does not tie to the GL is worse than a redundant column.
  5. **`study/README.md` (edit)** — add all new notes to the index and update the coverage tracker.
- **Proof:** every new note has the sections `docs/study-notes.md` requires, states the versions verified against, and carries 4–8 questions with written answers. `grep -c "^## " study/postgresql/multi-currency-and-functional-currency.md` matches the template's section count.

### Step S4 — `docs-sync` and the phase record

- **Skill:** `docs-sync`
- **Files:**
  - `docs/roadmap.md` — a new `## Phase 8, as delivered` section following the Phase 6/7 format exactly: what landed, the deliberate deviations table, **"Deliberately not built"** (multi-currency bank statements; per-account currency; an automatic rate feed — rates are entered by hand or imported, there is no external API call and no scheduled fetch; FX on bank matching; a currency other than base on a bank line; quarterly revaluation scheduling; FX translation of a subsidiary's whole trial balance, which is consolidation and not this phase), and the final test counts. Tick Phase 8 in the phase table.
  - `docs/ledger-core.md` — tick the three boxes under "Phase 8 — FX engine"; state that the worked example's acceptance criterion passes as the named test `reproduces docs/ledger-core.md's worked example to the paisa`; update the header status line and the "Not built yet" section (Phase 9 only).
  - `docs/schema.md` — confirm all five migrations are described (Steps A7, C4, D6, E5 did this incrementally; verify nothing was missed).
  - `docs/api.md` — confirm every new route and every changed request/response body is present.
  - `docs/guardrails.md` — add the FX-rate-arithmetic rule to rule 3's detail: a rate is `NUMERIC` as a string, converted only through `utils/fxRate.ts`.
  - `CLAUDE.md` — a Phase 8 bullet in the **Built** list matching the density of the Phase 6 and 7 bullets; update the **Not built** paragraph (Phase 9 remains, plus this phase's stated exclusions); update the "State:" heading to `Phase 8 done — multi-currency FX`.
  - **This file** — delete it, or set `Status: DONE — <date>` with the deviations recorded, following the convention `plans/ledger-core-phase-6-bank-reconciliation.md` set.
- **Proof:** `docs-sync` reports no drift; every claim in the new roadmap section is checkable against the filesystem.

---

## 7. Risks and open questions

1. **The balance-trigger redefinition is the highest-risk change in the phase.** It touches the invariant the whole system exists to protect, and it is used by every document type. Mitigation: Slice B ships and goes green **before** anything writes a foreign-currency row, and its proof requires all 717 pre-existing tests to pass untouched. If Step B1's proof fails, stop — do not continue into Slice C.
2. **Rounding agreement between `scaleCents` and Postgres `round()`.** Verified as identical for non-negative values (both half-away-from-zero, which equals half-up there), and every ledger amount is non-negative. If a case ever arises where a *negative* amount is converted, this identity breaks. It cannot arise today (`chk_line_nonzero` and the `>= 0` CHECKs forbid it), and Step B5 case 5 pins the behaviour. **If you find yourself converting a negative amount, stop and report.**
3. **`payment_allocations.base_amount_cents` is stored, not derived** — a deliberate exception to this codebase's strong "derive, never store" discipline, taken so the subledger cannot drift from the GL by a rounding cent. It is defensible but it *is* an exception; it must be named in the roadmap's deviations table and in the study note, not slipped in quietly.
4. **Existing payment tests are the canary for Step D3.** If a base-currency payment test changes its expected GL lines, the FX branch leaked into the base path. The correct response is to fix `createPaymentOnClient`, never the test.
5. **The reversal date can land in a closed period.** Revaluing the last day of a month whose *following* month is already closed will fail at `reverseEntryOnClient`. That is correct behaviour and Step E4 case 10 pins the neighbouring case, but the client should say so clearly rather than showing a raw `422`. F3 covers the message.
6. **Unknown: whether `organizationService` already exposes a base-currency read.** Step A5 says to `grep` first and add `getBaseCurrency(orgId)` only if it is missing. Do not assume either way, and do not put the query in a controller if it is missing.
7. **Unknown: the exact `audit_row_change` invocation signature.** Steps A1 and E1 both say to read `018_platform_audit_triggers.sql` and copy it verbatim rather than reconstructing it. Do not guess the `TG_ARGV` shape.
8. **Assumption stated in the absence of an answer:** rates are entered by hand or imported by an operator. **No external rate-feed API call is built in this phase** — that would be an outbound network dependency with no approved package, no key management, and no offline story, and Phase 7's `redirect: 'manual'` SSRF discipline would have to be extended to cover it. `source = 'IMPORT'` exists on `fx_rates` so a later phase can populate rates without a schema change. If the intent was a live feed, that is a separate plan and it needs a decision about the provider first.
9. **Test-count estimates (~75–100 new server cases) are estimates.** Do not pad tests to reach a number, and do not skip a named case from a slice's contract to stay under one.

---

## 8. Definition of done

- Migrations `022`–`026` applied, each replayable (`npm run migrate` twice, `npm test -- migrations` green), none of `001`–`021` edited.
- `fx_rates` exists with the latest-on-or-before lookup, org-scoped, exposed at `/api/v1/ledger-core/fx-rates`.
- A mixed-currency journal entry is possible and balances in base currency; a single-currency entry is still checked natively; `chk_ledger_lines_base_matches_rate` holds for every row.
- The trial balance, P&L, balance sheet, account ledger, aging, and `verify:integrity` all report in base currency.
- Invoices and bills can be raised in a foreign currency, freeze their rate at issue/approve, and post native lines with base amounts.
- Settling a foreign-currency document at a different rate posts to `4910` or `6810` automatically, and **`docs/ledger-core.md`'s worked example reproduces to the paisa in a named test** — the roadmap's stated acceptance criterion for this phase.
- `GET /reports/fx-exposure` previews, and `POST /fx-revaluations` posts a revaluation with an automatic next-day reversal through `6820`, emitting `fx.revaluation_posted` on the same transaction.
- A base-currency organization's behaviour is **unchanged in every respect** — proven by all 717 pre-existing server tests passing without a single assertion edit.
- Client: rates manageable, currency selectable on invoices/bills, exposure and revaluations visible, revaluation `ConfirmDialog`-gated.
- `npm test` green in both `server/` and `client/`; `npm run verify:integrity` exits 0; `npm run typecheck` and `npm run lint` clean.
- `guardrail-review` reports no findings; `git diff server/package.json` is empty.
- Study notes written and indexed in `study/README.md`.
- `docs/roadmap.md`, `docs/ledger-core.md`, `docs/schema.md`, `docs/api.md`, `docs/guardrails.md`, and `CLAUDE.md` all updated in the same change; this plan file closed or deleted.
