# UnitEcon — App Spec & Build Ladder

**Slug:** `unitecon` · **Domain:** Commercial Analytics · **Phase:** 14
**Status: Phase 14 done.** `config/apps.ts` marks it `'building'`. Every checkbox below is ticked — see [roadmap.md](roadmap.md#phase-14-as-delivered) for what was actually delivered.

UnitEcon is read-only commercial analytics over LedgerCore's own sales data: cohort retention matrices, LTV/CAC unit economics, and Price-Volume-Mix (PVM) variance. It creates no new source document and posts nothing to the general ledger — every figure here is derived, on every request, from ISSUED invoices and posted actuals LedgerCore already owns, plus a small amount of this app's own configuration (a gross-margin assumption, a set of acquisition-spend accounts, and a set of product-line dimensions).

**Gated on LedgerCore Phase 4** (live statements — see [roadmap.md](roadmap.md), "Needs 4"). In practice what Phase 14 actually depends on is Phase 3.8 (sales invoicing — `customers`, `invoices`, `invoice_lines`) and Phase 8 (`invoices.base_subtotal_cents`, added in migration 024). It needs no background job, no FX beyond base currency, and no Document Vault.

---

## Core technical capabilities

### A. The LedgerCore sales bridge

Two new exports on `services/ledger-core/reportService.ts` are the entire surface UnitEcon uses to read LedgerCore, alongside the pre-existing `monthlyActualsByAccount`:

- **`customerRevenueByMonth(orgId, from, to)`** — per-customer, per-month net revenue from `invoices.base_subtotal_cents`, `status = 'ISSUED'` only. `base_subtotal_cents` is tax-exclusive and already base currency (written at issue time regardless of the invoice's native currency), so this function needs **no currency restriction**.
- **`productLineSalesByMonth(orgId, baseCurrency, revenueAccountIds, from, to)`** — per-revenue-account, per-month quantity (`quantity_milli`) and net revenue (`net_cents`) from `invoice_lines`, joined to `ISSUED` invoices in the organization's own base currency only. Also returns `excludedForeignCurrencyInvoices`: the count of `ISSUED` invoices in the window whose `currency_code` differs from the org's base currency — `invoice_lines` carries no `base_*` column (unlike `invoices`/`bills`, which got one in migration 024), so a foreign-currency line cannot be converted at line grain without re-deriving the rate. Reporting the count is the honest alternative to a silent conversion.

Both functions live in LedgerCore's own service file, not UnitEcon's — the same pattern `monthlyActualsByAccount` established for FP&A Engine and ForecasterPro.

### B. Cohort retention

A customer's **cohort month** is the calendar month of their earliest fact with positive net revenue, searched over **all-time** history, not only the requested display window. `cohortService.cohortMatrix` therefore always queries `customerRevenueByMonth` from `'1900-01-01'` through the window's end, and passes the display window separately to the pure engine.

A customer whose first positive-revenue month **precedes** the window is excluded from every row and counted in `excludedPriorCustomers` — reported, never silently dropped. A customer whose first positive-revenue month **follows** the window is dropped silently (it is not "prior", it simply has not happened yet inside the requested range).

`utils/uniteconCohort.ts`'s `buildCohortMatrix` is **pure** — no database import, no clock — unit-tested (10 cases) without a running Postgres, mirroring `utils/forecasterBuild.ts`'s and `utils/fpaProjection.ts`'s own posture. For a cohort of size `cohortSize`, a cell's `retentionBps = round(activeCustomers * 10000 / cohortSize)` — a plain `Math.round`, not `BigInt`, because both operands are non-negative integers with `cohortSize * 10000` far inside the safe-integer range; this is not money. The window is capped at 60 months, matching ForecasterPro's own plan-horizon cap.

### C. Unit economics — CAC, LTV, payback

**Settings** (`unitecon_settings`, `unitecon_acquisition_accounts`) configure two things per organization: `grossMarginBps` (default 7000 = 70.0%) and a set of Expense accounts whose net monthly debit activity counts as customer-acquisition spend. `GET /unitecon/settings` returns defaults **without writing a row** — a row is created only on the first `PATCH`. `PATCH /unitecon/settings`'s `acquisitionAccountIds` is a **replace** set, not a merge: sending `[]` clears the configuration, a legitimate action, not an error.

Per cohort:

```
acquisitionSpendCents        = sum(debitCents - creditCents) over the cohort's acquisition accounts in its cohort month
cacCents                      = acquisitionSpendCents / newCustomers                       (divideCents)
cumulativeRevenueCents        = sum of every cell's netRevenueCents in the cohort's row
cumulativeGrossMarginCents    = cumulativeRevenueCents * grossMarginBps / 10000             (scaleCents)
ltvCents                      = cumulativeGrossMarginCents / newCustomers                   (divideCents)
ltvToCacBps                   = ltvCents * 10000 / cacCents, exact BigInt division           (null if cacCents <= 0)
paybackMonths                 = smallest offset where cumulative per-customer margin >= cacCents (null if never reached in the window)
```

**LTV here is OBSERVED, not modelled** — cumulative gross margin per acquired customer through the end of the requested window. There is no churn-rate model and no extrapolation; a cohort whose true payback lands outside the window reports `paybackMonths: null`, and `observedMonths` tells the reader how much of that cohort's history the window actually covered. This is stated plainly in the client, never left to a tooltip.

`utils/money.ts`'s `divideCents(amount, divisor)` is this phase's one new money primitive: exact `BigInt` division, rounding half away from zero, explicitly **not** `scaleCents(amount, 1, divisor)` — `scaleCents` rejects a negative `numerator` and its `+ d/2n` rounding bias is wrong for a negative `amount` (acquisition spend can be a net credit), where `divideCents` handles the sign explicitly.

### D. Price-Volume-Mix (PVM)

**The product dimension IS the revenue account.** UnitEcon does not classify `invoice_lines.description`, which is free text and not a key. A **product line** (`unitecon_product_lines`) is an organization's opt-in registration of one postable Revenue account as a PVM dimension, with a display name and a unit label — so PVM decomposes at revenue-account grain and no finer. `POST /unitecon/product-lines` rejects a non-`Revenue` account and a non-postable (header) account.

`utils/uniteconPvm.ts`'s `decomposePvm(base, compare)` is **pure**, unit-tested (10 cases) with Postgres out of the loop. For each product with base quantity/revenue `q0`/`n0` and comparison quantity/revenue `q1`/`n1`, and `Q0`/`Q1` the totals across every product in the report:

```
totalVariance = n1 - n0
price         = n1 - round(q1 * n0 / q0)              (0 when q0 = 0)
volume        = round(n0 * (Q1 - Q0) / Q0)             (0 when Q0 = 0 or q0 = 0)
mix           = totalVariance - price - volume          <- always the residual
```

This is algebraically exact: substituting the base unit price `p0 = n0/q0` into the textbook price/volume/mix formulas cancels `q0` out of the volume term entirely, and the three sum to `n1 − n0` exactly. **Mix always carries the rounding residual** rather than being rounded independently — the deliberate ruling that makes the three components sum to the row's total variance to the cent, every time, with no tolerance. A product present only in the comparison period (`q0 = 0`) is **pure mix** by construction: it did not exist in the base period, so it has no price or volume effect to isolate. A base period that sold nothing at all (`Q0 = 0`) makes every row pure mix the same way.

PVM is **restricted to the organization's base currency** — the same `excludedForeignCurrencyInvoices` honesty the sales bridge already provides, surfaced end-to-end through `pvmService.pvmReport`'s response and rendered as a visible client banner, never hidden.

---

## The rule-16 boundary, in practice

`services/unitecon/` and `controllers/unitecon/` contain **zero SQL against any LedgerCore table** — proven structurally:

```bash
grep -rnE "FROM (accounts|ledger_lines|journal_entries|invoices|invoice_lines|customers|vendors|bills|payments|fpa_models|fpa_scenarios|fpa_assumptions|forecaster_)" server/src/services/unitecon/ server/src/controllers/unitecon/
```

returns nothing (two prose-comment mentions of `SELECT ... FROM accounts`, explicitly documenting its absence, are the only hits — read them, they are not SQL). The **only** functions any `unitecon` service calls into another app are:

- `reportService.customerRevenueByMonth` — `cohortService.cohortMatrix`
- `reportService.productLineSalesByMonth` — `pvmService.pvmReport`
- `reportService.monthlyActualsByAccount` — `unitEconomicsService.unitEconomics`
- `accountService.getAccountById` — `settingsService.updateSettings`, `productLineService` (create/list/update)
- `organizationService.getById` — `cohortService.cohortMatrix`, `pvmService.pvmReport`

`unitecon_acquisition_accounts.account_id` and `unitecon_product_lines.revenue_account_id` both carry **no `REFERENCES`** into LedgerCore's `accounts` table — rules 8 and 16 collide, and 16 wins, the identical ruling migrations 032, 034, 037, 038, 039 already carry for the same reason. Validity is enforced at the service layer via `accountService.getAccountById`'s own cross-tenant `404`.

`utils/uniteconCohort.ts` and `utils/uniteconPvm.ts` are both pure — no `pool`, no `client.query`, no `db/connect` import, verified by grep with an empty result.

---

## Currency

Cohorts and unit economics (CAC, LTV) are currency-safe with **no restriction**: they read `invoices.base_subtotal_cents`, which is already the organization's base currency at write time regardless of the invoice's own `currency_code`. PVM is **base-currency only**: `invoice_lines` has no base-currency column, so a foreign-currency line cannot be safely converted at line grain, and `excludedForeignCurrencyInvoices` is surfaced rather than silently misreporting a mixed-currency total.

---

## Build ladder

### Phase 14 — cohort retention, LTV/CAC unit economics, Price-Volume-Mix variance

- [x] `config/apps.ts` — flip `unitecon` from `'planned'` to `'building'`
- [x] `utils/money.ts` — `divideCents`, exact `BigInt` division rounding half away from zero
- [x] `reportService.customerRevenueByMonth`/`productLineSalesByMonth` — the two new UnitEcon-facing bridge functions on LedgerCore's own report service
- [x] `utils/uniteconCohort.ts` — the pure cohort engine, unit-tested (10 cases) without a database
- [x] `services/unitecon/cohortService.ts` — zero SQL, `GET /unitecon/cohorts`
- [x] `040_unitecon_settings.sql` — `unitecon_settings`, `unitecon_acquisition_accounts`, no `REFERENCES accounts` (rule 16), no immutability trigger (rule 6 does not apply)
- [x] `services/unitecon/settingsService.ts` — read-defaults-without-writing, transactional upsert-plus-replace
- [x] `services/unitecon/unitEconomicsService.ts` — CAC/LTV/payback, zero SQL, `GET /unitecon/unit-economics`
- [x] `041_unitecon_product_lines.sql` — `unitecon_product_lines`, no `REFERENCES accounts`, no immutability trigger
- [x] `services/unitecon/productLineService.ts` — validated through `accountService.getAccountById`, not a direct query
- [x] `utils/uniteconPvm.ts` — the pure PVM engine, unit-tested (10 cases) without a database, the rounding-residual-on-mix ruling
- [x] `services/unitecon/pvmService.ts` — zero SQL, `GET /unitecon/pvm`
- [x] `/api/v1/unitecon` — 9 routes: cohorts (1), settings (2), unit-economics (1), product-lines (4), pvm (1)
- [x] Client: `UniteconCohortsPage` (excluded-prior-customers banner, never hidden), `UniteconUnitEconomicsPage` (the observed-not-modelled LTV notice, always visible), `UniteconPvmPage` (excluded-foreign-currency banner, never hidden; the no-product-line empty state), `UniteconSettingsPage` (margin form and product-line delete hidden, not disabled, below OWNER/ADMIN)
- [x] Cross-tenant isolation tests across all six modules — sales facts, cohorts, settings, unit economics, product lines, PVM — every one asserting `404` or an unchanged-to-the-cent figure, never `403` or a leak
- [x] `uniteconConstraints.test.ts` — the database as the guardrail: raw SQL proves every CHECK, unique index and cascade holds regardless of what wrote the row, including the deliberate absence of an immutability trigger

**Acceptance ✅ — verified.** 1273 server tests (1272 passed, 1 skipped — the same pre-existing gated E2E case ForecasterPro's own total carried; 99 new), including 10 + 10 pure-engine unit cases running with Postgres out of the loop, plus 218 client tests (11 new), all green. `npm run verify:integrity` passes, unaffected by construction since UnitEcon posts nothing to the GL. The rule-16 `grep` above returns nothing but two prose comments.

**Not written for this phase: study notes.** Skipped at the user's direction — recorded as debt in [roadmap.md](roadmap.md#phase-14-as-delivered), the same wording Phases 12 and 13 used for their own skipped notes.

---

## Not built

No SKU-level or product-master dimension — a product line is a revenue account, nothing finer (Section D). No churn-rate model, no survival analysis, no predictive or extrapolated LTV — every figure is observed history through the end of the requested window (Section C). No cohort dimension other than first-revenue month — no channel, plan, or geography cohorting. No monthly PVM time series — the report compares exactly two periods, never a rolling sequence. No multi-currency PVM — base currency only (Currency, above). No contribution-margin or payback dashboard beyond the single `paybackMonths` figure. No CSV/PDF/XLSX export, and no `.pptx` deck — that is BoardDeck Automator's (Phase 15) territory. No onboarding wizard — UnitEcon has none, matching FP&A Engine, AP-Flow and ForecasterPro. No webhook event on any UnitEcon action, and no background job — every report is computed synchronously on request. No live link between a UnitEcon report and a ForecasterPro plan or an FP&A Engine scenario/model.

When a phase lands, tick its boxes and update [roadmap.md](roadmap.md), [api.md](api.md), [schema.md](schema.md) and `CLAUDE.md` in the same change.
