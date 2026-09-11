# FP&A Engine — App Spec & Build Ladder

**Slug:** `fpa-engine` · **Domain:** Financial Modeling · **Phase:** 12
**Status: Phase 12 done.** `config/apps.ts` marks it `'building'`. Every checkbox below is ticked — see [roadmap.md](roadmap.md#phase-12-as-delivered) for what was actually delivered.

FP&A Engine turns LedgerCore's posted actuals into a linked 3-statement forecast: income statement, cash flow, and balance sheet, month by month, under a scenario's assumptions. It posts nothing back to the general ledger — a forecast is read-only arithmetic over facts LedgerCore already owns, never a source document.

**Gated on LedgerCore Phase 4.** It needs `reportService.balanceSheet` (the opening balance sheet a projection starts from) and posted `journal_entries`/`ledger_lines` (the actuals a projection's baseline and trailing-12-months chart come from). It needs no background job, no FX beyond base currency, and no Document Vault.

---

## Core technical capabilities

### A. Models and scenarios

A **model** is a named forecast container: a start month, a horizon in months (1–60), and the month through which actuals are considered final (`actualsThrough`). Creating a model creates its own default **Base** scenario in the same transaction — a model with no scenario is not a reachable state.

A **scenario** carries its own working-capital and tax assumptions — days sales outstanding (DSO), days payable outstanding (DPO), and a tax rate, each an organization can vary to build an Upside, a Downside, or any number of Custom scenarios off the same model. Exactly one scenario per model is the default, enforced by a partial unique index, not a service check.

Models have a lifecycle — `DRAFT → ACTIVE → ARCHIVED`, with `ARCHIVED → ACTIVE` — but **no terminal state**. Nothing here posts to the ledger, so archiving carries no integrity obligation; the contrast with AP-Flow's `POSTED` or a fiscal period's `LOCKED` is deliberate, and is why there is no immutability trigger anywhere in this app's two tables.

### B. Assumptions — three kinds, integer basis points

Each scenario carries per-account assumptions on Revenue and Expense accounts only:

| Kind | Meaning | Applied as |
|---|---|---|
| `GROWTH_BPS` | Compounding month-over-month growth | `scaleCents(prevMonth, 10000 + growthBps, 10000)` |
| `FIXED_CENTS` | A flat amount every month | the stored cents value, unchanged |
| `PERCENT_OF_REVENUE_BPS` | A percentage of that month's total revenue | `scaleCents(revenueCents, percentOfRevenueBps, 10000)`, resolved in a second pass after revenue is known |

An account with **no** assumption flat-lines its last posted actual — the single most consequential default in the engine, stated here and in the engine's own header comment. A revenue account can never carry `PERCENT_OF_REVENUE_BPS` — the circularity guard `assumptionService.upsertAssumption` enforces, which is what lets the engine resolve every percent-of-revenue account in one extra pass rather than a fixed-point iteration.

Every rate here is an **integer basis point**, never `NUMERIC` or a float — `growth_bps`, `percent_of_revenue_bps`, `tax_rate_bps`, `dso_days`, `dpo_days` are all `INT`, and every application of them downstream is `scaleCents`, exact `BigInt` scaling (guardrails rule 3). Contrast with `fx_rates.rate` (Phase 8), which genuinely needs 8 decimal places and pays for that by staying a string end to end; a growth rate does not need that precision, and an integer is both cheaper and exact.

### C. The projection engine — a pure function

`utils/fpaProjection.ts`'s `projectModel` is pure: no database import, no clock, no I/O. The same input always produces the same output, and it is unit-tested (15 cases) without a running Postgres — the same posture `utils/matchScore.ts` established for bank-reconciliation scoring.

Per month, per account: two passes. Pass one resolves every `GROWTH_BPS`, `FIXED_CENTS`, and flat-lined account; revenue is then fully known, so pass two resolves every `PERCENT_OF_REVENUE_BPS` account against it. Cost of sales splits from operating expenses by **code prefix** (`5xxx`), not a sixth account type — the identical ruling `reportService.profitAndLoss` already records. A loss pays **no tax** — a negative operating income yields `taxCents: 0`, never a negative (refundable) tax that would quietly manufacture cash. Working capital uses a **30-day month convention**: `receivablesCents = scaleCents(revenueCents, dsoDays, 30)`, deterministic regardless of a calendar month's true length, the same simplification the aging-bucket reports already make.

**Why the balance sheet's `balances` flag is a real proof, not a hard-coded value.** Substituting the cash-flow identity (`netCashFlowCents = netIncomeCents − changeInReceivablesCents + changeInPayablesCents`) into the balance-sheet equality and simplifying algebraically reduces it, by induction over the months, to exactly the model's **opening** balance-sheet identity:

```
openingCash + openingReceivables + openingOtherAssets
  === openingPayables + openingOtherLiabilities + openingEquity
```

Since those opening figures come straight from `reportService.balanceSheet` — which already asserts its own `balances` flag — every projected month balances if and only if the actual books balanced on the day the model's actuals end. `balances: false` is therefore never a rounding artefact (every scaling operation is exact `BigInt` arithmetic); it means a genuine bug in this engine or a genuine imbalance already present in the GL. `fpaProjection.test.ts` case 10 proves the flag is load-bearing by breaking the opening equity figure by exactly one cent and watching `balances` flip to `false`.

**Deliberate simplifications, stated once here:** `otherAssetsCents`, `otherLiabilitiesCents`, and `equityCents` are held **flat** at their opening value for every projected month — Phase 12 models no capex, no depreciation, and no debt schedule. That is ForecasterPro's (Phase 13) territory, explicitly out of scope here.

### D. Cash runway

`runwayMonths` is the 0-based index of the first month whose closing cash goes negative, `null` if none does within the horizon. `cashOutMonth` is that month's label. `averageMonthlyBurnCents` is the mean of the first three months' net cash outflow, truncated — the same truncation discipline `scaleCents` uses, never `Math.round`.

### E. Scenario comparison

`GET /models/:id/comparison` runs a full projection per scenario and reduces each to a summary: runway, cash-out month, closing cash, total revenue, total net income, and its own `balances` flag. Scenarios run **sequentially**, not `Promise.all` — each projection issues several queries, and a wide model with many scenarios should not burst the connection pool for a latency win not worth the risk.

---

## The rule-16 boundary, in practice

`services/fpa-engine/` and `controllers/fpa-engine/` contain **zero SQL against any LedgerCore table** — proven structurally:

```bash
grep -rnE "FROM (accounts|ledger_lines|journal_entries|ledger_settings|ledger_invoice_settings)" server/src/services/fpa-engine/ server/src/controllers/fpa-engine/
```

returns nothing. Every LedgerCore fact FP&A needs arrives through an exported LedgerCore service function, added to `services/ledger-core/reportService.ts` for this phase:

- **`monthlyActualsByAccount(orgId, from, to)`** — posted actuals bucketed by calendar month, base currency, `INNER JOIN`ed like `profitAndLoss` (a month with no activity produces no row).
- **`resolveControlAccounts(orgId)`** — the org's cash/receivable/payable control accounts, resolved per slot: the configured `ledger_settings`/`ledger_invoice_settings` column, else the default-chart code (`1110`/`1120`/`2100`), else `null`. Generalizes `agingService`'s own private resolver to all three slots FP&A needs.

`forecastService.ts` is the app boundary in practice, mirroring `services/ap-flow/postingService.ts`'s own header ruling — applied here to reads rather than writes.

`fpa_assumptions.account_id` carries **no `REFERENCES`** into LedgerCore's `accounts` table — rules 8 and 16 collide, and 16 wins, the identical ruling migration 032 records for `ap_flow_line_items.account_id`. Validity is enforced at the service layer via `accountService.getAccountById` (a `404` on a cross-tenant or unknown account), safe because accounts are retired via `is_active = false` and never actually deleted.

---

## Build ladder

### Phase 12 — linked model, scenarios & cash runway

- [x] `config/apps.ts` — flip `fpa-engine` from `'planned'` to `'building'`
- [x] `fpa_models`, `fpa_scenarios` migrations — no immutability trigger, no terminal FSM state (deliberate — see Section A)
- [x] `fpa_assumptions` migration — a discriminated-union CHECK matching the kind/payload shape the schema enforces
- [x] Two exported LedgerCore functions: `reportService.monthlyActualsByAccount`, `reportService.resolveControlAccounts`
- [x] `utils/fpaProjection.ts` — the pure projection engine, unit-tested without a database
- [x] `services/fpa-engine/forecastService.ts` — assembles a scenario's projection and a model's scenario comparison, zero SQL
- [x] `/api/v1/fpa-engine` — 14 routes: models (7), scenarios (2), assumptions (3), projection (1), comparison (1)
- [x] Client: model list/create/detail, scenario and assumption editors, the 3-statement projection page with a visible `balances` badge, scenario comparison
- [x] Cross-tenant isolation tests across models, scenarios, assumptions, the actuals bridge, and the projection itself — every one asserting `404`, never `403` or `200`

**Acceptance ✅ — verified.** Every projected month balances by integer equality when the opening books balance (`fpaProjection.test.ts`), and the same property holds end-to-end through the real API against real posted journal entries (`projection.test.ts`). Cross-tenant actuals never leak into another org's projection, proven by seeding ten times the money in a second organization and asserting the first organization's figures are unchanged to the cent.

---

## Phase 13 boundary — what ForecasterPro owns instead

FP&A Engine's three assumption kinds (`GROWTH_BPS`, `FIXED_CENTS`, `PERCENT_OF_REVENUE_BPS`) are deliberately narrow. **ForecasterPro (Phase 13)** owns everything past them:

- **Driver-based rolling forecasting** — a driver library beyond the three kinds here, and a rolling (not fixed-horizon) update cadence.
- **Headcount planning** — no headcount table, no FTE-driven expense model exists in this phase.
- **Zero-based budgeting** — no budget-vs-actual comparison of any kind; that is also BoardDeck Automator's (Phase 15) territory for the board-deck variance narrative.
- **Capex, depreciation, and a debt schedule** — `otherAssetsCents`/`otherLiabilitiesCents`/`equityCents` are held flat here specifically because modeling their movement is out of scope for Phase 12.

If a future change to this app tempts adding a driver library, a headcount table, or a budget comparison, that is Phase 13 or Phase 15 scope — stop and route it there.

---

## Not built

No scenario cloning (a new scenario is built from scratch, or by hand-copying assumption values). No projection export (PDF/CSV/XLSX) — the client renders the statement tables, nothing more. No fiscal-period alignment — projections use plain monthly calendar buckets (`starts_on`/`actuals_through` are constrained to the first of a month by CHECK), not LedgerCore's fiscal periods. No multi-currency projection — actuals and openings come from the `base_*_cents` columns only, the same base-currency-only limit Phase 6 recorded for bank reconciliation. No external driver data (headcount, pipeline, CRM) feeding an assumption automatically. No stored/cached projection — every read recomputes from LedgerCore's raw ledger lines, the same "no summary table" discipline `reportService`'s own header states.

When a phase lands, tick its boxes and update [roadmap.md](roadmap.md), [api.md](api.md), [schema.md](schema.md) and `CLAUDE.md` in the same change.
