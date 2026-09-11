# ForecasterPro — App Spec & Build Ladder

**Slug:** `forecaster` · **Domain:** Budgeting & Planning · **Phase:** 13
**Status: Phase 13 done.** `config/apps.ts` marks it `'building'`. Every checkbox below is ticked — see [roadmap.md](roadmap.md#phase-13-as-delivered) for what was actually delivered.

ForecasterPro is driver-based rolling forecasting, headcount planning, and zero-based budgeting: a named plan carries named drivers with a value per month, planned headcount roles, and forecast lines that turn those drivers into an account-by-month expense/revenue build-up. A budget version compiles that build-up into a zero-based, fully-justified budget, is approved once, and is then reported against LedgerCore's posted actuals as budget-vs-actual variance. Like FP&A Engine, it posts nothing back to the general ledger — every figure here is read-only arithmetic over facts LedgerCore already owns and this app's own tables, never a source document.

**Gated on FP&A Engine Phase 12** (in the roadmap sense of "builds on the same actuals bridge and pure-engine discipline" — ForecasterPro does not read FP&A's tables; see [Rule-16 boundary](#the-rule-16-boundary-in-practice) below). It needs `reportService.monthlyActualsByAccount` (the same LedgerCore bridge FP&A Engine uses) for variance, and `accountService` for every account fact. It needs no background job, no FX beyond base currency, and no Document Vault.

---

## Core technical capabilities

### A. Plans and rolling

A **plan** is a named forecast container: a start month, a horizon in months (1–60), and the month through which actuals are considered final (`actualsThrough`). Plans have a lifecycle — `DRAFT → ACTIVE → ARCHIVED`, with `ARCHIVED → ACTIVE` — but **no terminal state**, the identical ruling `fpa_models` carries: nothing on a plan posts to the ledger, so archiving carries no integrity obligation.

**Rolling** is `POST /plans/:id/roll`: the plan's window advances by exactly one month, `horizon_months` held constant, so the plan always covers the same number of months forward from its new `actuals_through`. In the same transaction, every driver's monthly values shift with it — the month that just dropped off the front is deleted, and the newly-added trailing month **copies the value from the month before it**. A driver with no value in that prior month simply gains none in the new month; the engine reports `missingDriverValue` rather than inventing a figure. There is deliberately no automatic or scheduled roll, and no roll-back.

### B. Drivers — one `value` column, three kinds

A **driver** is a named quantity on a plan — a unit count, a price, or a rate — with one value per month. `kind` decides the unit: `COUNT` (a plain integer count), `CENTS` (money in integer cents), or `BPS` (integer basis points). A single `BIGINT value` column serves all three, because the kind lives on the parent row; `driverService.setDriverValues` enforces `value >= 0` for `COUNT` and `BPS` at write time (a `CENTS` driver may legitimately be negative, e.g. a refund-rate driver) — that guard is what guarantees `scaleCents`, which rejects a negative numerator, is never handed one by the forecast engine.

Changing a driver's `kind` is not offered — it would silently reinterpret every stored value and every forecast line that references it. To change a kind, delete the driver and create a new one.

### C. Headcount planning

A **headcount role** — title, an optional department label, a start/end month, an FTE count, an annual salary, and a loading rate — is mapped to an Expense account. A role's monthly cost is computed in three separate, sequentially-rounded steps, mirroring `fpaProjection`'s multi-step rounding discipline:

```
monthlyBase = scaleCents(annualSalaryCents, 1, 12)
withFte     = scaleCents(monthlyBase, fteCount, 1)
amountCents = scaleCents(withFte, 10000 + loadingBps, 10000)
```

Salary is annual ÷ 12, a flat twelfth — the same simplification `fpaProjection` makes with its 30-day month, not a day-count convention. A role is active in a given month when `month >= startsOn && (endsOn === null || month <= endsOn)`; an inactive role is **omitted** from that month's build, not emitted with a zero.

### D. Forecast lines and the pure build engine

A **forecast line** ties an account to one of three formula kinds:

| Kind | Meaning | Applied as |
|---|---|---|
| `DRIVER_PRODUCT` | quantity × rate, two drivers | `scaleCents(rateValue, quantityValue, 1)` |
| `DRIVER_PERCENT` | a percentage of a `CENTS` driver | `scaleCents(sourceValue, percentBps, 10000)` |
| `FIXED_CENTS` | the same amount every month | the stored cents value, unchanged |

`utils/forecasterBuild.ts`'s `buildForecast` is **pure** — no database import, no clock, no I/O — mirroring `utils/fpaProjection.ts`'s own posture, and unit-tested (18 cases) without a running Postgres. A line whose driver has no value stored for a given month costs **zero that month and flags `missingDriverValue: true`**, never an invented figure — the single most consequential default in the engine, stated here as `fpaProjection.ts`'s header states its own. A `FIXED_CENTS` line never varies by month — there is no inflation/escalation curve; escalation is expressible as a driver plus a `DRIVER_PERCENT` line, not a first-class field.

`GET /plans/:id/forecast` recomputes the whole build-up from raw driver values, forecast lines and headcount roles on every request — the same "no summary table" discipline `reportService`'s own header states, and `fpaProjection.ts`'s for FP&A Engine.

**This engine is not a 3-statement model.** It produces a per-account expense/revenue build-up only — no balance sheet, no cash flow. That linkage is FP&A Engine's (Phase 12), reached through its own routes.

### E. Zero-based budgeting and approval

A **budget version** on a plan starts `DRAFT`. `POST /budget-versions/:id/compile` materializes the forecast build-up into `DRIVER`/`HEADCOUNT` lines (delete-then-reinsert, so compiling twice never doubles an amount) while preserving any hand-entered `MANUAL` lines untouched — the entire reason the `source` column exists. Every line, generated or manual, carries a mandatory non-blank **justification** — enforced by a CHECK constraint, not only the service — which is the zero-based-budgeting discipline itself: nothing is carried forward from a prior period, and every number must explain itself.

`POST /budget-versions/:id/approve` freezes the version — **ForecasterPro's only immutability trigger, and `SUPERSEDED` its only terminal state.** Not because a budget reaches the general ledger (it never does), but because an approved budget is a decision of record that BoardDeck Automator (Phase 15) will report variance against; rewriting it would rewrite history. Approving a second version on the same plan supersedes the first in the same transaction, and a partial unique index (`ux_forecaster_budget_versions_one_approved`) makes two simultaneously-`APPROVED` versions on one plan physically impossible — the same technique `ux_fpa_scenarios_one_default` and `ux_migration_imports_one_committed_opening` use. Approving needs `OWNER`/`ADMIN`; every other mutation needs `ACCOUNTANT` and above.

### F. Budget-vs-actual variance

`GET /plans/:id/variance` compares the plan's **approved** budget version's lines against LedgerCore's posted actuals (`reportService.monthlyActualsByAccount`) over the requested window, defaulting to the whole plan horizon. Every (account, month) pair appearing in **either** side is a row — a budgeted-but-unspent account shows its full budget as variance; an unbudgeted actual shows a zero budget — never silently dropped. `varianceCents = actualCents − budgetCents`; `favourable` reads the sign by account type (an expense under budget or a revenue over budget is favourable). There is deliberately **no percentage** — a percentage is undefined at a zero budget, and this codebase never returns a float for money.

---

## The rule-16 boundary, in practice

`services/forecaster/` and `controllers/forecaster/` contain **zero SQL against any LedgerCore or FP&A Engine table** — proven structurally:

```bash
grep -rnE "FROM (accounts|ledger_lines|journal_entries|ledger_settings|ledger_invoice_settings|fpa_models|fpa_scenarios|fpa_assumptions)" server/src/services/forecaster/ server/src/controllers/forecaster/
```

returns nothing. The **only** LedgerCore access anywhere in this app is `reportService.monthlyActualsByAccount`, called once, from `varianceService.ts`. Every account fact — validity, code, name, type — comes from `accountService`'s exported functions (`getAccountById`, `listAccounts`), never a direct query. `varianceService.ts` and `forecastService.ts` both carry ZERO SQL of their own; `forecastService.ts` is the app boundary in practice for the forecast build, mirroring `services/fpa-engine/forecastService.ts`'s own header ruling.

`forecaster_headcount_roles.account_id`, `forecaster_forecast_lines.account_id`, and `forecaster_budget_lines.account_id` all carry **no `REFERENCES`** into LedgerCore's `accounts` table — rules 8 and 16 collide, and 16 wins, the identical ruling migrations 032 (`ap_flow_line_items.account_id`) and 034 (`fpa_assumptions.account_id`) already carry. Validity is enforced at the service layer via `accountService.getAccountById`'s own cross-tenant `404`, safe because accounts are retired via `is_active = false` and never actually deleted.

`forecaster_forecast_lines`' three driver FKs (`quantity_driver_id`, `rate_driver_id`, `source_driver_id`) **are** real composite `REFERENCES` into `forecaster_drivers` — an in-app reference, not a cross-app one — but each is nullable, and exactly one is populated per `kind`. PostgreSQL's default `MATCH SIMPLE` skips a composite FK check entirely when any column of the key is `NULL`, so the constraint is enforced exactly on the kind that uses a given driver slot and silently skipped on the kinds that do not — deliberate, not an accident. Each carries `ON DELETE RESTRICT`, not `CASCADE`: deleting a driver a forecast line depends on fails loudly (`23503`, surfaced as a `409`), never silently zeroing out a forecast.

ForecasterPro does not read FP&A Engine's `fpa_models`/`fpa_scenarios`/`fpa_assumptions` tables, and there is no exported FP&A service function this app calls. "Builds on FP&A Engine's linked model" (the roadmap's phrasing) is read here as *builds on the same LedgerCore actuals bridge and the same pure-engine discipline*, not a live link between a ForecasterPro plan and an FP&A scenario — that link does not exist in this phase.

---

## Build ladder

### Phase 13 — driver-based rolling forecasting, headcount planning, zero-based budgeting

- [x] `config/apps.ts` — flip `forecaster` from `'planned'` to `'building'`
- [x] `forecaster_plans` migration — no immutability trigger, no terminal FSM state (deliberate — see Section A), plus `POST /plans/:id/roll`
- [x] `forecaster_drivers`/`forecaster_driver_values` migrations — one `BIGINT value` column, `kind`-dependent unit; the roll shifts values in the same transaction as the plan's own dates
- [x] `forecaster_headcount_roles` migration — `account_id` with no `REFERENCES` (rule 16), `>= 0`/`>= 1` CHECKs on salary and FTE
- [x] `forecaster_forecast_lines` migration — a discriminated-union CHECK across three nullable driver FKs, `ON DELETE RESTRICT`
- [x] `utils/forecasterBuild.ts` — the pure build engine, unit-tested (18 cases) without a database
- [x] `services/forecaster/forecastService.ts` — assembles a plan's forecast build-up, zero SQL
- [x] `forecaster_budget_versions`/`forecaster_budget_lines` migrations — this app's **only** immutability trigger and terminal state (`SUPERSEDED`), a mandatory non-blank `justification` CHECK, `ux_forecaster_budget_versions_one_approved`
- [x] `services/forecaster/budgetService.ts` — compile (delete-then-reinsert, preserving `MANUAL` lines), approve (supersede-then-approve in one transaction)
- [x] `services/forecaster/varianceService.ts` — budget-vs-actual, zero SQL, the one route into LedgerCore
- [x] `/api/v1/forecaster` — 31 routes: plans (6), drivers (6), headcount (4), forecast lines (5), budget versions (7), budget lines (2), variance (1)
- [x] Client: plan list/create/detail with an inline driver-value grid, headcount and forecast-line editors, a `Roll forward` action gated by `ConfirmDialog`, the forecast page with a visible missing-driver-value warning, the budget page with source badges and an `Approve` action gated by `ConfirmDialog`, the variance page
- [x] Cross-tenant isolation tests across plans, drivers, headcount, forecast lines, the forecast build itself, budget versions and variance — every one asserting `404`, never `403` or `200`
- [x] `forecasterConstraints.test.ts` — the database as the guardrail: raw SQL proves every CHECK, unique index and freeze trigger holds regardless of what wrote the row

**Acceptance ✅ — verified.** 124 server tests (18 pure-engine unit cases with Postgres out of the loop, 106 integration cases) plus 10 client tests, all green. `npm run verify:integrity` passes, unaffected by construction since ForecasterPro posts nothing to the GL. The rule-16 `grep` above returns nothing.

**Not written for this phase: study notes.** Skipped at the user's direction — recorded as debt in [roadmap.md](roadmap.md#phase-13-as-delivered), the same wording Phase 12 used for its own skipped notes.

---

## Not built

No formula language or cross-line references — a forecast line reads drivers, never another line's output. No automatic or scheduled rolling; a roll is not reversible from the API. No seasonality or inflation/escalation curve as a first-class field. No driver import from CSV, and no external driver feed (CRM, ATS, payroll system). No multi-currency — every figure is base currency, the same limit Phase 6 recorded for bank reconciliation and Phase 12 for projections. No fiscal-period alignment — plain monthly calendar buckets, never `fiscal_periods`. No budget export (PDF/CSV/XLSX) and no `.pptx` deck — that is BoardDeck Automator's (Phase 15) territory. No per-department or per-cost-centre rollup beyond the free-text `department` field on a headcount role. No variance percentage, no variance threshold alerting, no webhook event on approval. No live link between a ForecasterPro plan and an FP&A Engine model or scenario — see the rule-16 boundary above. No database-level immutability trigger on `forecaster_plans`, `forecaster_drivers`, `forecaster_headcount_roles`, or `forecaster_forecast_lines` — only `forecaster_budget_versions`/`forecaster_budget_lines` are frozen, deliberately (Section E).

When a phase lands, tick its boxes and update [roadmap.md](roadmap.md), [api.md](api.md), [schema.md](schema.md) and `CLAUDE.md` in the same change.
