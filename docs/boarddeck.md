# BoardDeck Automator — App Spec & Build Ladder

**Slug:** `boarddeck` · **Domain:** Board Reporting & Close · **Phase:** 15
**Status: Phase 15 done.** `config/apps.ts` marks it `'building'`. Every checkbox below is ticked — see [roadmap.md](roadmap.md#phase-15-as-delivered) for what was actually delivered.

BoardDeck Automator has three modules over LedgerCore's and ForecasterPro's own data: a monthly close checklist (five deterministic readiness checks against a fiscal period), budget-vs-actual (BvA) variance at board-section grain, and background-job `.pptx` deck generation combining both plus LedgerCore's P&L and balance sheet. It creates no new financial source document — closing a period is the one exception, and even that write goes through LedgerCore's own `fiscalPeriodService`, never a direct `UPDATE`.

**Gated on background jobs (Phase 7) and ForecasterPro's budgets (Phase 13)** — see [roadmap.md](roadmap.md), "Needs 7, 13". In practice this phase also depends on LedgerCore's live statements (Phase 4, for P&L/balance sheet), fiscal periods (also Phase 4), and Phase 9.5's `storageService` (for the generated `.pptx` blob — routed around the Document Vault itself; see Section C).

---

## Core technical capabilities

### A. Monthly close

`reportService.closeReadiness(orgId, from, to)` — one new bridge function on LedgerCore's own `services/ledger-core/reportService.ts`, the same pattern every prior analytics app used to reach LedgerCore. It runs four independent, `org_id`-scoped queries inside the requested date window and returns their totals: summed `ledger_lines.base_debit_cents`/`base_credit_cents`, a count of `DRAFT` invoices, a count of `DRAFT`/`AWAITING_APPROVAL` bills, and a count of `UNMATCHED` bank transactions.

`closeRunService.createRun`/`rerunChecks` turn that single call plus the period's own `status` into exactly five stored checks:

| Check | Passes when |
|---|---|
| `PERIOD_OPEN` | the LedgerCore fiscal period's status is `OPEN` |
| `TRIAL_BALANCE_BALANCED` | `totalDebitCents === totalCreditCents`, integer equality |
| `NO_DRAFT_INVOICES` | zero `DRAFT` invoices issued inside the period |
| `NO_UNPOSTED_BILLS` | zero `DRAFT`/`AWAITING_APPROVAL` bills dated inside the period |
| `NO_UNMATCHED_BANK_LINES` | zero `UNMATCHED` bank transactions dated inside the period |

A run is `READY` when all five pass, `BLOCKED` otherwise — one run per period (`UNIQUE (org_id, fiscal_period_id)`), re-run replaces the check rows in place rather than creating a second run. `POST /close-runs/:id/close-period` is legal only from `READY`, and the only thing it does is call `fiscalPeriodService.closePeriod` — **BoardDeck never writes `fiscal_periods` directly.** These five checks are this phase's own invention, not a roadmap-specified list: a real close would also cover accruals, prepaids, depreciation and inter-company eliminations, none of which exist anywhere in this codebase, so none are checked.

### B. Budget vs Actual (BvA)

`utils/boarddeckVariance.ts`'s `summarizeVariance(rows, topN)` is **pure** — no database import, no clock — unit-tested (9 cases) without a running Postgres, mirroring `utils/uniteconPvm.ts`'s and `utils/forecasterBuild.ts`'s own posture. It takes ForecasterPro's own `varianceService.planVariance` rows (already per-account, per-month budget vs. actual) and:

1. Collapses every account across months into one bucket, summing `budgetCents`/`actualCents` as plain integer addition.
2. Classifies each bucket into one of four sections by `sectionOf(accountType, accountCode)`: `Revenue`, `Cost of Sales` (`Expense` with a `5xxx` code), `Operating Expenses` (any other `Expense`), or `Other` — the identical `5xxx`/`6xxx` convention `reportService.profitAndLoss` already uses for gross profit, **not** a sixth account type (rule 12).
3. Recomputes `varianceCents = actualCents − budgetCents` from the summed figures at both the account and section grain — never summed from the input rows' own `varianceCents` — so the four section variances are provably consistent with their own operands and sum exactly to `totalVarianceCents`, to the cent, always.
4. Sorts every account by `Math.abs(varianceCents)` descending (tie-broken by account code) and returns the top `topN` as `drivers`.

All four sections are always present in the response, in fixed order, with zeros where there is no activity — a board deck with a silently missing row is worse than one with a zero. `bvaService.bvaReport` is the entire service: it calls `varianceService.planVariance` once and `summarizeVariance` once, with zero SQL of its own.

### C. `.pptx` deck generation

A deck row (`boarddeck_decks`) is created synchronously with status `PENDING`; its bytes are not. `POST /decks` returns `202`, and the `boarddeck-generate` background job (Phase 7's `bullmq` infrastructure) does the actual work: `handleBoardDeckGenerate` reads the period's P&L and balance sheet (`reportService.profitAndLoss`/`balanceSheet`), the period's close checks if any run exists (`closeRunService.findChecksForPeriod`), and — when the deck was created with a `planId` — the BvA summary (swallowing a `422 no approved budget version` rather than failing the deck). `services/boarddeck/deckBuilderService.ts`'s `buildDeck` then renders these into a `.pptx` via `pptxgenjs`, entirely from already-fetched data with zero SQL and zero cross-app imports — the same "takes data, not ids" posture that makes it unit-testable without Postgres.

A deck has **4 slides** (Title, Profit & Loss, Balance Sheet, Close Checklist) when created without a `planId`, or **6** (the same four plus Budget vs Actual and Top Variance Drivers) when a `planId` is given and reaches the builder.

**The generated bytes are stored via `storageService.put` (Phase 9.5), addressed by `sha256` on `boarddeck_decks` itself — deliberately NOT through the platform Document Vault (`documents`/`document_links`).** A `.pptx` is server-produced trusted output, not an untrusted client upload, and `utils/mimeSniff.ts`'s allowlist (PDF/PNG/JPEG/CSV) does not include it; widening a security-relevant allowlist to accommodate this one case was rejected. `GET /decks/:id/download` streams the blob with `Content-Disposition: attachment`, legal only from `READY`.

**pptxgenjs's own `.d.ts` (v4.0.1) does not typecheck cleanly under this project's `"module": "NodeNext"` + TypeScript 7.0.2** — verified independently against `moduleResolution: "Bundler"`, where the identical default import resolves correctly. `deckBuilderService.ts` works around the mismatch with a narrow, hand-written interface for exactly the API surface it calls (`addSlide`/`addText`/`addTable`/`write`) and one explicit type assertion, never `any` or `@ts-ignore`, and the project's tsconfig is untouched. Full detail: [development.md](development.md).

---

## The rule-16 boundary, in practice

`services/boarddeck/` and `controllers/boarddeck/` contain **zero SQL against any other app's table** — proven structurally:

```bash
grep -rnE "FROM (accounts|ledger_lines|journal_entries|invoices|invoice_lines|customers|vendors|bills|payments|fiscal_periods|fpa_|forecaster_|unitecon_)" server/src/services/boarddeck/ server/src/controllers/boarddeck/
```

returns nothing. The **only** functions any `boarddeck` service or the generate handler calls into another app are:

- `reportService.closeReadiness` — `closeRunService.createRun`/`rerunChecks`
- `reportService.profitAndLoss`/`balanceSheet` — the generate handler
- `fiscalPeriodService.getPeriodById` — `closeRunService`, `deckService.createDeck`
- `fiscalPeriodService.closePeriod` — `closeRunService.closePeriodFromRun`
- `varianceService.planVariance` — `bvaService.bvaReport`
- `planService.getPlanById` — `deckService.createDeck`
- `organizationService.getById` — the generate handler

`boarddeck_close_runs.fiscal_period_id`, `boarddeck_decks.fiscal_period_id` and `boarddeck_decks.plan_id` all carry **no `REFERENCES`** into LedgerCore's or ForecasterPro's tables — rules 8 and 16 collide, and 16 wins, the identical ruling migrations 032, 034, 037–041 already carry. Validity is enforced at the service layer via `fiscalPeriodService.getPeriodById`/`planService.getPlanById`, both of which already 404 a cross-tenant id.

`utils/boarddeckVariance.ts` and `services/boarddeck/deckBuilderService.ts` are both pure — no `pool`, no `client.query`, no `db/connect` import, no cross-app service import — verified by grep with an empty result.

---

## Build ladder

### Phase 15 — monthly close, budget-vs-actual, `.pptx` deck generation

- [x] `config/apps.ts` — flip `boarddeck` from `'planned'` to `'building'`
- [x] `042_boarddeck_close_runs.sql` — `boarddeck_close_runs`/`boarddeck_close_checks`, no `REFERENCES fiscal_periods` (rule 16), no immutability trigger (rule 6 does not apply)
- [x] `reportService.closeReadiness` — the new LedgerCore-facing close-readiness bridge
- [x] `services/boarddeck/closeRunService.ts` — zero SQL against other apps' tables, `/close-runs` (5 routes)
- [x] `utils/boarddeckVariance.ts` — the pure BvA summarizer, unit-tested (9 cases) without a database
- [x] `services/boarddeck/bvaService.ts` — zero SQL, `GET /bva`
- [x] `pptxgenjs` installed (Phase 15's approved dependency)
- [x] `043_boarddeck_decks.sql` — `boarddeck_decks`, no `REFERENCES`, no immutability trigger
- [x] `services/boarddeck/deckBuilderService.ts` — the pure `.pptx` renderer, no SQL, no cross-app import
- [x] `services/boarddeck/deckService.ts` + `queue/handlers/boarddeckGenerateHandler.ts` — the async generation lifecycle (`PENDING → GENERATING → READY|FAILED`), `/decks` (6 routes including download)
- [x] Client: `BoardDeckCloseRunsPage` (Close period hidden, not disabled, below OWNER/ADMIN, `ConfirmDialog`-gated), `BoardDeckBvaPage` (the no-approved-budget `422` empty state, never a raw error), `BoardDeckDecksPage` (a PENDING/GENERATING deck polls every 3s until it leaves those states; Delete hidden below OWNER/ADMIN)
- [x] Cross-tenant isolation tests across all three modules — close readiness, close runs, BvA, decks — every one asserting `404` (or, for the download route, `404` with no bytes streamed) or an unchanged-to-the-cent figure, never `403` or a leak

**Acceptance ✅ — verified.** 1323 server tests (1322 passed, 1 skipped — the same pre-existing gated E2E case UnitEcon's own total carried; 50 new) plus 226 client tests (8 new), all green — see [roadmap.md](roadmap.md#phase-15-as-delivered) for the breakdown. `npm run verify:integrity` passes, unaffected by construction since BoardDeck posts nothing to the GL except through `fiscalPeriodService.closePeriod`'s own existing, already-tested path. The rule-16 `grep` above returns nothing.

**Not written for this phase: study notes.** Skipped at the user's direction — recorded as debt in [roadmap.md](roadmap.md#phase-15-as-delivered), the same wording Phases 12, 13 and 14 used for their own skipped notes.

---

## Not built

No accrual, prepaid, depreciation or inter-company close check — the five checks are computable from data that already exists in this codebase, not an exhaustive close procedure (Section A). No BvA at a grain other than section/account — no product, department, or cost-center dimension. No chart-selection or custom branding for a generated deck — the layout and the four/six-slide manifest are fixed. No charts inside the deck — every slide is a table. No PDF or XLSX export alongside `.pptx`. No scheduling a recurring deck, and no emailing a deck. No deletion of the stored blob on deck delete — the row is removed, the bytes are not (the same accepted cost `documentService.uploadDocument`'s own rollback path carries). No multi-period or trailing-twelve-month deck — one fiscal period per deck. No auto-closing a period without a human pressing the button. No webhook event or outbox entry on any BoardDeck action — a deck finishing is a UI-polled status change, not a financial fact. No onboarding wizard — BoardDeck has none, matching FP&A Engine, AP-Flow, ForecasterPro and UnitEcon.

When a phase lands, tick its boxes and update [roadmap.md](roadmap.md), [api.md](api.md), [schema.md](schema.md) and `CLAUDE.md` in the same change.
