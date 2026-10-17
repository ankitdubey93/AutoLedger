# Phase 47 — Business snapshot

Date: 2026-10-17 · **Status: done — Phase 47 landed** · Approved design: `/home/ankit/.claude/plans/pasted-content-id-ae3a-business-delightful-hickey.md`

A direct feature request, numbered like 24/30/32…/46 (the next free number). Three slices:

| Slice | Outcome |
|---|---|
| **47a** | `GET /api/v1/reports/business-snapshot` returns performance, position, seven ratios (current vs prior period), AR/AP aging and a 12-month trend, exportable as CSV/XLSX/PDF; accounts gain an optional `balanceSheetClass` override. |
| **47b** | A **Business snapshot** report page with Recharts charts, four "Business health" tiles on the dashboard, and a balance-sheet-class select on the account form and chart settings. |
| **47c** | Study notes, docs synced, guardrail review clean. |

**User decisions (fixed — do not reopen):**
1. A full report page **plus** headline tiles on the dashboard.
2. Charts use **Recharts** (`recharts@3.10.1`, exact). The existing hand-rolled SVG charts (`TrendChart.tsx`, `Pages/home/BarChart.tsx`, `EquationBar.tsx`, `ProportionBar.tsx`) are **not** migrated.
3. The page has a period picker and shows every KPI **vs the prior period** (same length, immediately before), plus a **12-month trend**.
4. Current/non-current is **derived from the chart tree with a nullable override column** `accounts.balance_sheet_class`. This is the same pattern as Phase 45's `cash_flow_category`.
   - **Asset:** under ancestor `1400` it is `NON_CURRENT`; otherwise it is `CURRENT`.
   - **Liability:** under ancestor `2500` it is `NON_CURRENT`; otherwise it is `CURRENT`.
   - **Equity, Revenue and Expense** have no class.

**Plan-time decisions:**
- **No new `ReportCell` kind.** In exports, a `PERCENT` ratio is a `percent` cell and a `TIMES` ratio is a `text` cell such as `"5.83×"`. This keeps `reportCsv.ts`, `xlsxWriter.ts` and `reportPdfRenderer.ts` untouched. The design doc proposed a `ratio` cell; this replaces it.
- **`cashFlowService.ts` is not refactored.** The snapshot service carries its own copy of the ancestry CTE, which is copied from `cashFlowService.ts`. This leaves a tested statement untouched. The design doc said "factor the CTE"; this replaces it.
- **Fixed assets = non-current assets.** The default chart has no other non-current asset. This is documented in `docs/accounting.md`.
- **Net worth = total assets − total liabilities.** It equals `balanceSheet().equity.totalCents`, because that total includes derived retained and current earnings. A test asserts the identity.
- **Ratios are integer basis points.** For example, 5.8333× is stored as `58333`. A ratio is `null` when its denominator is ≤ 0.
- **No step commits.** The user decides when to commit.

## Dispatch — read this before executing anything

You are executing this plan as **one tier only**. Your tier is the one named in the request
(`[Haiku]` or `[Sonnet]`). Then:

1. Work **down the dispatch manifest in step order**. If the request names a batch, run only
   that batch's steps. Do not reorder steps to group tiers.
2. Run a step only if its tier matches yours **and** every step in its `Depends on`
   is marked `done` in the manifest. Otherwise stop and report the blocking step.
3. When the next `todo` step carries the **other** tier, stop and report:
   "Step N is [other tier] — switch model and resume." Do not run it because it looks small.
4. After a step's proof command passes, set its `Status` to `done` in the manifest in the
   same edit session. That column is the only record of progress.
5. If a proof fails twice, stop and report per Execution rules. Never weaken a test,
   a type, an assertion or a guardrail to get a step through, and never `npm install`
   anything the step did not name.
6. Anything this plan did not anticipate is a stop-and-report, not a judgment call.

## Starting state (verified 2026-10-17, HEAD `8c7b5d5`, tree clean)

**Schema**
- The last migration is `103_ledger-core_bank_transaction_delete.sql`, so this phase uses **`104`**.
- `accounts` has these columns: `id, org_id, code, name, type, parent_id, is_postable, is_active, description, bank_account_kind (097), cash_flow_category (099), created_by, created_at, updated_at`.
  - There is no current/non-current flag.
- `099_ledger-core_account_cash_flow_category.sql` is the exact analogue for the new migration: `ADD COLUMN IF NOT EXISTS` plus a `DO $$ … pg_constraint` guarded CHECK.

**Default chart** (`services/accounting/accountService.ts` `DEFAULT_CHART`)
- **Current assets** sit under `1100`, which sits under `1000`: 1110 Operating Cash (BANK), 1120 AR, 1130 Prepaid Expenses, 1140 Inventory, 1150 Supplier Prepayments, 1180 GST/VAT Input.
- **Non-current assets** sit under `1400`: 1500 Fixed Assets / Equipment, and 1590 Accumulated Depreciation (an Asset with a contra balance).
- **Current liabilities** sit under `2010`, which sits under `2000`: 2100 AP, 2120 Accrued Liabilities, 2130 Customer Deposits, 2140 GST/VAT Output, 2160 Payroll.
- **Non-current liabilities** sit under `2500`: 2510 Notes Payable.
- **Equity:** 3100 Capital, 3200, 3300, 3400.
- **Revenue:** 4100 Product Revenue, 4200, 4800, 4910.
- **Cost of sales:** under `5000` (5050, 5100 Direct Materials, 5200, 5300, 5400).
- **Operating expenses:** under `6000` (6100 Salaries & Wages, 6110 Rent & Utilities, …).

**Server, existing — reuse, do not duplicate**
- `services/accounting/reportService.ts`
  - `profitAndLoss(orgId, from|null, to|null)` returns `{from, to, revenue, costOfSales, grossProfitCents, operatingExpenses, netIncomeCents}`.
    - It resolves the fiscal-YTD default window.
    - It throws `ApiError(422, 'from must not be after to')`.
    - Cost of sales is the Expense accounts whose code starts with `'5'`.
  - `balanceSheet(orgId, asOf)` and `loadReportContext(orgId)`.
- `services/accounting/agingService.ts` → `arAging(orgId, asOf)` and `apAging(orgId, asOf)` return `AgingReport` with `buckets: AgingBucketAmount[]` (5 entries), `totalOutstandingCents` and `totalOverdueCents`.
- `utils/comparisonPeriods.ts`
  - `comparisonPeriods(from, to, 'previousPeriod', 1)` returns `[{from, to, label}]`, the period immediately before.
  - `addMonthsClamped(iso, months)`.
- `utils/cashFlowCategory.ts` `deriveCashFlowCategory` is the analogue for the new derive util. `__tests__/cashFlowCategory.test.ts` is the analogue for its test.
- `services/accounting/cashFlowService.ts:56-80` holds the ancestry recursive CTE to copy.
- `utils/money.ts` → `parseCents(text)`.
- `utils/reportCellText.ts` → `bpToPercentText`.
- `controllers/accounting/reportController.ts` `cashFlow` handler is the controller analogue: `readReportFormat`, then the service call, then `sendReportFile` or `res.json({ success: true, ...report })`.
- `routes/accounting/reportRoutes.ts`: every GET is `authenticate, requirePermission('reports.view')`.
- `services/accounting/reportTables.ts` `cashFlowTable` and `profitAndLossTable` are the table-builder analogues. Its local helpers are `money()` and `text()`, plus `dateLabel()` and `amountColumns()`.
- `types/reportTable.ts`: `ReportCell` kinds are `text`, `money`, `quantity`, `percent {bp}`, `date` and `empty`.
- Account write paths that carry `cashFlowCategory` today, all of which must carry `balanceSheetClass` too:
  - `schemas/accounting/accountSchema.ts` (`createAccountSchema`, `updateAccountSchema`)
  - `services/accounting/accountService.ts`, at these places:
    - `AccountRow`
    - `ACCOUNT_COLUMNS`
    - `assertCashFlowCategoryMatchesType`
    - `toAccount`
    - `createAccountOnClient`
    - `createAccount`
    - `updateAccount` (including its `COLUMNS` map)
  - `services/accounting/chartImportService.ts:216`
  - `types/accounting.ts` `Account` (line ~75), `CASH_FLOW_CATEGORIES` (line ~2239)
- `__tests__/accounting/cashFlow.test.ts` is the integration-test analogue. It uses `createApp`, `resetTables`, `createUserWithOrg` and `loginAgent`, a `postManual` helper over `POST /api/v1/manual-journals`, `binary()` for downloads, and a `DB check` case expecting `23514`.

**Client, existing**
- There is no chart library in `client/package.json`. React is `19.2.8`.
- `Pages/reports/CashFlowPage.tsx` is the page analogue: `useLedgerSettings` and `fiscalYearBounds` for the default window, from/to date inputs, `ExportMenu`, `LoadingState` and `BackLink`.
- `Pages/reports/ReportsPage.tsx` `SECTIONS`. Its first section is `'Financial statements'`.
- `routes/ProductRoutes.tsx:246-259` holds the report routes.
- `services/fetchServices.ts`:
  - `getCashFlow` (line ~2967) is the fetcher analogue.
  - `Account`, `CreateAccountInput` and `UpdateAccountInput` carry `cashFlowCategory?` (lines ~554, ~667, ~696).
  - `AgingBucketAmount` (line ~1121).
- `Pages/accounting/NewAccountForm.tsx` has `CASH_FLOW_OPTIONS`, `hasCashFlowCategory`, and a `cashFlowCategory` select. `Pages/settings/ChartSettingsPage.tsx:250-265` has a per-row cash flow select plus `handleSetCashFlow`.
- `Pages/home/DashboardPage.tsx` `FullDashboard` renders `MetricTile`s in `<div className="grid">`. `components/ui/StatTile.tsx` takes `{label, icon, tone, value, hint, to}`.
- CSS tokens: `--accent --accent-soft --good --bad --warn --muted --border --panel --panel-2 --text --bg`.
- Tests: `client/src/__tests__/setup.ts` only imports jest-dom.
  - `__tests__/cashFlow.test.tsx` is the page-test analogue: it mocks `useLedgerSettings` and `fetch` via `vi.stubGlobal`.
  - `__tests__/dashboard.test.tsx` uses `mockRoutes(dashboard, extra)`, which returns `404` for unhandled URLs.

**Study notes:** `study/react/hand-rolled-svg-charts.md` and `study/architecture/cash-flow-statement-indirect-method.md` exist. There is no note on financial ratios and none on a chart library.

## Gate

Accounting module, provenance tag `ledger-core`. Its prerequisites are built:
- Phase 4 (statements)
- Phase 3.9 / 25 (aging)
- Phase 45 (reports suite, export, `cash_flow_category` pattern)
- Phase 38c (`reports.view`)

Nothing is gated, and no roadmap debt is assigned to this phase.

## Execution rules

**If a proof command fails twice on the same step, stop and report. Do not improvise around it.**

| Symptom | Forbidden | Correct |
|---|---|---|
| Migration checksum error | Editing the applied migration | A new sequential migration (rule #13) |
| Test fails | Weakening or deleting the assertion | Fix the code; the test is the spec |
| Type error | `as any`, `@ts-ignore`, loosening `tsconfig` | Fix the type |
| Query returns no rows | Dropping the `org_id` predicate | Fix the fixture or the parameters (rule #1) |
| Ratio/amount assertion off by one | Floats, `Math.round` on a float quotient, an epsilon | The BigInt half-up formula in Step 4 (rule #3) |
| Need a helper library | `npm install` something not in the plan | Stop and ask (rule #14). Only `recharts@3.10.1` and `react-is@19.2.8` are sanctioned |
| Column missing at runtime | Adding it ad hoc in the service | Stop; Step 1 owns the schema |
| A `[Haiku]` step's proof fails twice | Retrying in a loop, trimming the step, "good enough" | Re-dispatch the step **unchanged** to Sonnet with the failure output, and note the escalation in this file under "Escalations" |
| The step needs a decision the plan never made | Deciding it | Stop and report — the plan is the defect |

**Anything the plan did not anticipate is a stop-and-report, not a judgment call.**

Proof commands that need SQL run through `docker exec autodb_postgres psql -U autodb_user -d autodb -c '...'`. `psql` is not on the host, and there is no `DATABASE_URL`.

---

## Slice 47a — Server

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| Migration | `server/src/db/migrations/104_ledger-core_account_balance_sheet_class.sql` |
| Column / constraint | `accounts.balance_sheet_class TEXT NULL` · `chk_accounts_balance_sheet_class` |
| Types (`server/src/types/accounting.ts`) | `BALANCE_SHEET_CLASSES`, `BalanceSheetClass`, `isBalanceSheetClass`, `SNAPSHOT_RATIO_KEYS`, `SnapshotRatioKey`, `SnapshotRatioKind`, `SnapshotRatioUnavailableReason`, `SnapshotPeriod`, `SnapshotPerformance`, `SnapshotPosition`, `SnapshotRatioValue`, `SnapshotRatio`, `SnapshotAging`, `SnapshotTrendPoint`, `BusinessSnapshot` |
| API field | `balanceSheetClass` on `Account`, create and update |
| Derive util | `server/src/utils/balanceSheetClass.ts` → `deriveBalanceSheetClass` |
| Ratio util | `server/src/utils/financialRatios.ts` → `SNAPSHOT_RATIO_SPECS`, `ratioBp`, `computeRatioValues`, `buildRatios` |
| Service | `server/src/services/accounting/businessSnapshotService.ts` → `businessSnapshot`, `snapshotTrendWindows` |
| Controller export | `reportController.businessSnapshot` |
| Route | `GET /api/v1/reports/business-snapshot` |
| Table builder | `reportTables.ts` → `businessSnapshotTable` |
| Unit tests | `server/src/__tests__/balanceSheetClass.test.ts`, `server/src/__tests__/financialRatios.test.ts` |
| Integration test | `server/src/__tests__/accounting/businessSnapshot.test.ts` |

### Step 1 — [Sonnet] Migration 104 — `accounts.balance_sheet_class`

- **Model:** [Sonnet] — a migration (rule #13, unrepairable in place)
- **Depends on:** —
- **Skill:** new-migration
- **Read first:** `server/src/db/migrations/099_ledger-core_account_cash_flow_category.sql` — copy its structure exactly.
- **Files:** `server/src/db/migrations/104_ledger-core_account_balance_sheet_class.sql` (new)
- **Contract — write this SQL literally:**
  ```sql
  -- Phase 47 — an optional current/non-current override for Asset and Liability
  -- accounts. NULL means "derive it from the chart tree" (utils/balanceSheetClass.ts):
  -- under 1400 / 2500 is NON_CURRENT, everything else CURRENT. Not a sixth account type (rule 12).
  ALTER TABLE accounts ADD COLUMN IF NOT EXISTS balance_sheet_class TEXT NULL;

  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_accounts_balance_sheet_class') THEN
      ALTER TABLE accounts
        ADD CONSTRAINT chk_accounts_balance_sheet_class CHECK (
          balance_sheet_class IS NULL
          OR (balance_sheet_class IN ('CURRENT', 'NON_CURRENT')
              AND type IN ('Asset', 'Liability'))
        );
    END IF;
  END $$;
  ```
  No backfill, no index (the column is never a filter or join key).
- **Guardrails:** #13 additive and idempotent, and the filename carries the `ledger-core` tag · #12 this is a report attribute, not a type
- **Proof:**
  - `cd server && npm run migrate && npm run migrate` exits 0 both times.
  - `docker exec autodb_postgres psql -U autodb_user -d autodb -c "SELECT conname FROM pg_constraint WHERE conname = 'chk_accounts_balance_sheet_class'"` returns 1 row.
  - `npm test -- migrations` passes.
- **If it fails:** a checksum error means a file was edited after apply. Never edit `099` or any earlier migration.
- **Owes:** the `docs/schema.md` block (Step 17)

### Step 2 — [Haiku] Snapshot and balance-sheet-class types

- **Model:** [Haiku] — transcription of literal type definitions
- **Depends on:** 1
- **Skill:** none (types)
- **Read first:** `server/src/types/accounting.ts` lines 60–80 (`Account`) and ~2239–2243 (`CASH_FLOW_CATEGORIES`), and `AgingBucketAmount` (~911).
- **Files:** `server/src/types/accounting.ts` (edit)
- **Contract:**
  1. Add this to `Account`, directly after `cashFlowCategory`:
     ```ts
     /** Phase 47 — explicit current/non-current override; null = derived (Asset/Liability only). */
     balanceSheetClass: BalanceSheetClass | null;
     ```
  2. Append this directly after `isCashFlowCategory`:
     ```ts
     /** Phase 47 — current vs non-current, a report attribute of Asset/Liability accounts (rule 12: not a type). */
     export const BALANCE_SHEET_CLASSES = ['CURRENT', 'NON_CURRENT'] as const;
     export type BalanceSheetClass = (typeof BALANCE_SHEET_CLASSES)[number];
     export function isBalanceSheetClass(value: string): value is BalanceSheetClass {
       return (BALANCE_SHEET_CLASSES as readonly string[]).includes(value);
     }

     /** Phase 47 — business snapshot. Every amount is base-currency integer cents; every ratio integer bp. */
     export const SNAPSHOT_RATIO_KEYS = [
       'GROSS_MARGIN',
       'CURRENT_RATIO',
       'DEBT_RATIO',
       'DEBT_TO_EQUITY',
       'WORKING_CAPITAL_TO_TOTAL_ASSETS',
       'FIXED_ASSETS_TO_NET_WORTH',
       'CURRENT_LIABILITIES_TO_NET_WORTH',
     ] as const;
     export type SnapshotRatioKey = (typeof SNAPSHOT_RATIO_KEYS)[number];
     /** PERCENT displays bp as "12.50%"; TIMES displays bp as "1.25×". */
     export type SnapshotRatioKind = 'PERCENT' | 'TIMES';
     export type SnapshotRatioUnavailableReason = 'DENOMINATOR_ZERO' | 'DENOMINATOR_NEGATIVE';

     export interface SnapshotPeriod {
       from: string;
       to: string;
     }

     export interface SnapshotPerformance {
       revenueCents: number;
       costOfSalesCents: number;
       grossProfitCents: number;
       operatingExpensesCents: number;
       netIncomeCents: number;
     }

     export interface SnapshotPosition {
       asOf: string;
       currentAssetsCents: number;
       /** Net of contra accounts such as 1590 Accumulated Depreciation. Also "fixed assets". */
       nonCurrentAssetsCents: number;
       totalAssetsCents: number;
       currentLiabilitiesCents: number;
       nonCurrentLiabilitiesCents: number;
       totalLiabilitiesCents: number;
       /** totalAssets − totalLiabilities; equals the balance sheet's equity total. */
       netWorthCents: number;
       /** currentAssets − currentLiabilities. */
       workingCapitalCents: number;
     }

     export interface SnapshotRatioValue {
       /** null when the denominator is ≤ 0. */
       valueBp: number | null;
       reason: SnapshotRatioUnavailableReason | null;
     }

     export interface SnapshotRatio {
       key: SnapshotRatioKey;
       label: string;
       kind: SnapshotRatioKind;
       current: SnapshotRatioValue;
       prior: SnapshotRatioValue;
     }

     export interface SnapshotAging {
       asOf: string;
       /** Exactly 5 entries, in AGING_BUCKETS order. */
       buckets: AgingBucketAmount[];
       totalOutstandingCents: number;
       totalOverdueCents: number;
     }

     export interface SnapshotTrendPoint {
       /** YYYY-MM */
       month: string;
       /** The month's last day, or the period's `to` for the final point. */
       asOf: string;
       revenueCents: number;
       costOfSalesCents: number;
       grossProfitCents: number;
       grossMarginBp: number | null;
       currentRatioBp: number | null;
       debtRatioBp: number | null;
       debtToEquityBp: number | null;
     }

     export interface BusinessSnapshot {
       period: SnapshotPeriod;
       priorPeriod: SnapshotPeriod;
       performance: { current: SnapshotPerformance; prior: SnapshotPerformance };
       /** current is as at period.to; prior is as at priorPeriod.to. */
       position: { current: SnapshotPosition; prior: SnapshotPosition };
       /** SNAPSHOT_RATIO_KEYS order. */
       ratios: SnapshotRatio[];
       receivables: SnapshotAging;
       payables: SnapshotAging;
       /** Exactly 12 points, oldest first; the last point's asOf is period.to. */
       trend: SnapshotTrendPoint[];
     }
     ```
- **Guardrails:** #12 not a sixth account type · #3 amounts are `*Cents: number` and ratios `*Bp`
- **Proof:** `cd server && npm run typecheck`. Expect errors **only** in `accountService.ts` (missing `balanceSheetClass` in `toAccount`), and Step 5 fixes them. Report the error list. Any error in another file is a failure.
- **If it fails:** never make `balanceSheetClass` optional to silence the error.
- **Owes:** nothing

### Step 3 — [Haiku] `deriveBalanceSheetClass` + unit test

- **Model:** [Haiku] — a pure function whose rules and cases are listed here
- **Depends on:** 2
- **Skill:** none (pure util)
- **Read first:** `server/src/utils/cashFlowCategory.ts`, `server/src/__tests__/cashFlowCategory.test.ts`
- **Files:** `server/src/utils/balanceSheetClass.ts` (new), `server/src/__tests__/balanceSheetClass.test.ts` (new)
- **Contract:**
  ```ts
  import type { AccountType, BalanceSheetClass } from '../types/accounting.js';

  /**
   * Phase 47 — the current/non-current class of a balance-sheet account.
   * Equity, Revenue and Expense return null. Rules, in order: an explicit
   * override wins; an Asset under 1400 or a Liability under 2500 is
   * NON_CURRENT; every other Asset/Liability (including a root-level credit
   * card) is CURRENT. `ancestorCodes` excludes the account's own code.
   */
  export function deriveBalanceSheetClass(input: {
    type: AccountType;
    ancestorCodes: readonly string[];
    override: BalanceSheetClass | null;
  }): BalanceSheetClass | null;
  ```
  The body runs these checks in order:
  1. `type` is not Asset or Liability → `null`.
  2. `override !== null` → `override`.
  3. Asset and `ancestorCodes.includes('1400')` → `'NON_CURRENT'`.
  4. Liability and `ancestorCodes.includes('2500')` → `'NON_CURRENT'`.
  5. Otherwise → `'CURRENT'`.
- **Test cases (exact):**

  | Case name | Input | Expected |
  |---|---|---|
  | `prepaid under 1100 is current` | Asset `['1100','1000']` | `'CURRENT'` |
  | `equipment under 1400 is non-current` | Asset `['1400','1000']` | `'NON_CURRENT'` |
  | `notes payable under 2500 is non-current` | Liability `['2500','2000']` | `'NON_CURRENT'` |
  | `accounts payable under 2010 is current` | Liability `['2010','2000']` | `'CURRENT'` |
  | `root-level credit card is current` | Liability `[]` | `'CURRENT'` |
  | `override wins` | Asset `['1400','1000']`, override `'CURRENT'` | `'CURRENT'` |
  | `equity has no class` | Equity `['3000']` | `null` |
  | `revenue ignores an override` | Revenue `['4000']`, override `'CURRENT'` | `null` |

  Every case without a listed override uses override `null`.
- **Guardrails:** #12
- **Proof:** `cd server && npx vitest run src/__tests__/balanceSheetClass.test.ts` shows 8 passed.
- **If it fails:** fix the function, not the expected values.
- **Owes:** nothing

### Step 4 — [Sonnet] `financialRatios` util + unit test

- **Model:** [Sonnet] — rounding arithmetic (tie-break 2)
- **Depends on:** 2
- **Skill:** none (pure util)
- **Read first:** `server/src/utils/comparisonPeriods.ts` `variance` (the existing bp convention), `server/src/utils/money.ts` `scaleCents` (BigInt rounding style)
- **Files:** `server/src/utils/financialRatios.ts` (new), `server/src/__tests__/financialRatios.test.ts` (new)
- **Contract:**
  ```ts
  import type {
    SnapshotPerformance, SnapshotPosition, SnapshotRatio, SnapshotRatioKey,
    SnapshotRatioKind, SnapshotRatioValue,
  } from '../types/accounting.js';
  import { SNAPSHOT_RATIO_KEYS } from '../types/accounting.js';

  export const SNAPSHOT_RATIO_SPECS: Record<SnapshotRatioKey, { label: string; kind: SnapshotRatioKind }> = {
    GROSS_MARGIN: { label: 'Gross margin', kind: 'PERCENT' },
    CURRENT_RATIO: { label: 'Current ratio', kind: 'TIMES' },
    DEBT_RATIO: { label: 'Debt ratio', kind: 'PERCENT' },
    DEBT_TO_EQUITY: { label: 'Debt to equity', kind: 'TIMES' },
    WORKING_CAPITAL_TO_TOTAL_ASSETS: { label: 'Working capital to total assets', kind: 'PERCENT' },
    FIXED_ASSETS_TO_NET_WORTH: { label: 'Fixed assets to net worth', kind: 'TIMES' },
    CURRENT_LIABILITIES_TO_NET_WORTH: { label: 'Current liabilities to net worth', kind: 'PERCENT' },
  };

  /** numerator / denominator in bp, rounded half away from zero, exact (BigInt). */
  export function ratioBp(numeratorCents: number, denominatorCents: number): SnapshotRatioValue;

  export function computeRatioValues(
    performance: SnapshotPerformance,
    position: SnapshotPosition,
  ): Record<SnapshotRatioKey, SnapshotRatioValue>;

  /** One SnapshotRatio per key, in SNAPSHOT_RATIO_KEYS order. */
  export function buildRatios(
    current: { performance: SnapshotPerformance; position: SnapshotPosition },
    prior: { performance: SnapshotPerformance; position: SnapshotPosition },
  ): SnapshotRatio[];
  ```
  `ratioBp` works as follows:
  - `denominatorCents === 0` → `{ valueBp: null, reason: 'DENOMINATOR_ZERO' }`
  - `denominatorCents < 0` → `{ valueBp: null, reason: 'DENOMINATOR_NEGATIVE' }`
  - Otherwise:
    ```ts
    const n = BigInt(numeratorCents) * 10000n;
    const d = BigInt(denominatorCents);
    const mag = (2n * (n < 0n ? -n : n) + d) / (2n * d);
    const valueBp = Number(n < 0n ? -mag : mag) + 0; // + 0 normalises -0
    return { valueBp, reason: null };
    ```
  `computeRatioValues` uses these numerator / denominator pairs:

  | Key | Numerator | Denominator |
  |---|---|---|
  | `GROSS_MARGIN` | `grossProfitCents` | `revenueCents` |
  | `CURRENT_RATIO` | `currentAssetsCents` | `currentLiabilitiesCents` |
  | `DEBT_RATIO` | `totalLiabilitiesCents` | `totalAssetsCents` |
  | `DEBT_TO_EQUITY` | `totalLiabilitiesCents` | `netWorthCents` |
  | `WORKING_CAPITAL_TO_TOTAL_ASSETS` | `workingCapitalCents` | `totalAssetsCents` |
  | `FIXED_ASSETS_TO_NET_WORTH` | `nonCurrentAssetsCents` | `netWorthCents` |
  | `CURRENT_LIABILITIES_TO_NET_WORTH` | `currentLiabilitiesCents` | `netWorthCents` |

  `buildRatios` maps each key to `{ key, label, kind, current, prior }`, taking `label` and `kind` from `SNAPSHOT_RATIO_SPECS`.
- **Test cases (exact):**
  - `ratioBp(700000, 120000)` → `{ valueBp: 58333, reason: null }`
  - `ratioBp(1, 3)` → `3333`
  - `ratioBp(1, 8)` → `1250`
  - `ratioBp(1, 20000)` → `1`, because 0.5 bp rounds away from zero
  - `ratioBp(-1, 20000)` → `-1`
  - `ratioBp(0, 5)` → `valueBp` satisfies `Object.is(valueBp, 0)`
  - `ratioBp(5, 0)` → `{ valueBp: null, reason: 'DENOMINATOR_ZERO' }`
  - `ratioBp(5, -3)` → `{ valueBp: null, reason: 'DENOMINATOR_NEGATIVE' }`
  - `computeRatioValues` on the fixture below → `GROSS_MARGIN 6000`, `CURRENT_RATIO 58333`, `DEBT_RATIO 4333`, `DEBT_TO_EQUITY 7647`, `WORKING_CAPITAL_TO_TOTAL_ASSETS 4833`, `FIXED_ASSETS_TO_NET_WORTH 7353`, `CURRENT_LIABILITIES_TO_NET_WORTH 1765`
    - performance: `{ revenueCents: 300000, costOfSalesCents: 120000, grossProfitCents: 180000, operatingExpensesCents: 100000, netIncomeCents: 80000 }`
    - position: `{ asOf: '2026-09-30', currentAssetsCents: 700000, nonCurrentAssetsCents: 500000, totalAssetsCents: 1200000, currentLiabilitiesCents: 120000, nonCurrentLiabilitiesCents: 400000, totalLiabilitiesCents: 520000, netWorthCents: 680000, workingCapitalCents: 580000 }`
  - `buildRatios` returns 7 entries whose `key`s equal `SNAPSHOT_RATIO_KEYS` in order, and whose `kind` for `CURRENT_RATIO` is `'TIMES'`.
- **Guardrails:** #3 no float division anywhere in the file (`grep -n "Math.round\|/ 100\b" server/src/utils/financialRatios.ts` returns nothing)
- **Proof:** `cd server && npx vitest run src/__tests__/financialRatios.test.ts` passes all cases.
- **If it fails:** never change an expected value; recompute by hand and stop if the plan's value is wrong.
- **Owes:** the study note (Step 15)

### Step 5 — [Haiku] Account API carries `balanceSheetClass`

- **Model:** [Haiku] — a mechanical mirror of the existing `cashFlowCategory` path, field by field
- **Depends on:** 1, 2
- **Skill:** none (mirror edit)
- **Read first:** `server/src/services/accounting/accountService.ts` lines 35–100 and 200–380, and `server/src/schemas/accounting/accountSchema.ts`
- **Files:** `server/src/schemas/accounting/accountSchema.ts` (edit), `server/src/services/accounting/accountService.ts` (edit), `server/src/services/accounting/chartImportService.ts` (edit, line ~216)
- **Contract — at every place `cashFlowCategory` / `cash_flow_category` appears, add the twin directly after it:**
  - **schema:**
    - `createAccountSchema`: `balanceSheetClass: z.enum(BALANCE_SHEET_CLASSES).nullable().default(null),`
    - `updateAccountSchema`: `balanceSheetClass: z.enum(BALANCE_SHEET_CLASSES).nullable().optional(),`
    - Import `BALANCE_SHEET_CLASSES` in the existing types import.
  - **`AccountRow`:** `balance_sheet_class: string | null;`
  - **`ACCOUNT_COLUMNS`:** insert `balance_sheet_class` after `cash_flow_category`.
  - **New guard** below `assertCashFlowCategoryMatchesType`:
    ```ts
    /** Phase 47 — only Asset and Liability accounts have a current/non-current class. */
    function assertBalanceSheetClassMatchesType(value: BalanceSheetClass | null, type: AccountType): void {
      if (value !== null && type !== 'Asset' && type !== 'Liability') {
        throw new ApiError(422, 'Only asset and liability accounts have a balance sheet class');
      }
    }
    ```
  - **`toAccount`:**
    - Add the re-validation `if (row.balance_sheet_class !== null && !isBalanceSheetClass(row.balance_sheet_class)) throw new Error(\`Unknown balance sheet class "${row.balance_sheet_class}" on account ${row.id}\`);`.
    - Map `balanceSheetClass: row.balance_sheet_class,`.
  - **`createAccountOnClient` and `createAccount`:**
    - Add the input field `balanceSheetClass: BalanceSheetClass | null;`.
    - Call `assertBalanceSheetClassMatchesType(input.balanceSheetClass, input.type)`.
    - The INSERT column list gains `balance_sheet_class` as `$11`, and the values array gains `input.balanceSheetClass`.
  - **`updateAccount`:**
    - Add the input `balanceSheetClass?: BalanceSheetClass | null | undefined;`.
    - When it is `!== undefined`, call `assertBalanceSheetClassMatchesType(input.balanceSheetClass, existing.type)`.
    - Add `balanceSheetClass: 'balance_sheet_class'` to `COLUMNS`.
  - **`chartImportService.ts`:** add `balanceSheetClass: null,` after `cashFlowCategory: null,`.
  - **Do not touch:** `DEFAULT_CHART` or its seed INSERT. New accounts derive their class.
- **Guardrails:** #4 the column name comes from the frozen `COLUMNS` map only · #1 the update keeps `WHERE id = $1 AND org_id = $2`
- **Proof:**
  - `cd server && npm run typecheck` exits 0.
  - `npm test -- accounts cashFlow` passes. The existing tests are unchanged and must stay green.
- **If it fails:** type errors in a test file that builds an `Account` literal mean that test needs `balanceSheetClass: null` added. Stop and report instead if it is more than 3 files.
- **Owes:** the `docs/api.md` field (Step 17)

### Step 6 — [Sonnet] `businessSnapshotService`

- **Model:** [Sonnet] — tenant-scoped aggregate SQL and money tie-outs
- **Depends on:** 3, 4, 5
- **Skill:** new-module (service layer)
- **Read first:** `server/src/services/accounting/cashFlowService.ts` lines 1–120 (CTE, row typing, re-validation style), and `reportService.ts` `profitAndLoss` (lines 150–265)
- **Files:** `server/src/services/accounting/businessSnapshotService.ts` (new)
- **Contract:**
  ```ts
  import { pool } from '../../db/connect.js';
  import { parseCents } from '../../utils/money.js';
  import { comparisonPeriods } from '../../utils/comparisonPeriods.js';
  import { deriveBalanceSheetClass } from '../../utils/balanceSheetClass.js';
  import { buildRatios, ratioBp } from '../../utils/financialRatios.js';
  import { profitAndLoss } from './reportService.js';
  import { apAging, arAging } from './agingService.js';

  /** Exactly 12 windows ending with the month containing `to`, oldest first. */
  export function snapshotTrendWindows(to: string): { month: string; from: string; to: string }[];

  export async function businessSnapshot(
    orgId: string,
    from: string | null,
    to: string | null,
  ): Promise<BusinessSnapshot>;
  ```
  - **`snapshotTrendWindows(to)`:** for `k = 11` down to `0`, take the calendar month `k` months before `to`'s month. Each window is:
    - `month = 'YYYY-MM'`
    - `from = 'YYYY-MM-01'`
    - `to =` that month's last day, except `k = 0`, where `to` is the input `to`

    Use `Date.UTC` arithmetic only (no local time). Example: `snapshotTrendWindows('2026-09-15')`:
    - `[0]` is `{ month: '2025-10', from: '2025-10-01', to: '2025-10-31' }`
    - `[11]` is `{ month: '2026-09', from: '2026-09-01', to: '2026-09-15' }`
  - **`businessSnapshot` flow:**
    1. `const pnl = await profitAndLoss(orgId, from, to);` — this resolves defaults and throws the 422.
    2. `const [prior] = comparisonPeriods(pnl.from, pnl.to, 'previousPeriod', 1);` then `const priorPnl = await profitAndLoss(orgId, prior.from, prior.to);`.
    3. `const windows = snapshotTrendWindows(pnl.to);`
    4. **Query A — account classes.** Copy the CTE from `cashFlowService.ts`, with the anchor restricted:
       ```sql
       WITH RECURSIVE ancestry AS (
         SELECT a.id AS account_id, a.parent_id, ARRAY[]::text[] AS codes
           FROM accounts a WHERE a.org_id = $1 AND a.type IN ('Asset', 'Liability')
         UNION ALL
         SELECT an.account_id, p.parent_id, an.codes || p.code
           FROM ancestry an JOIN accounts p ON p.id = an.parent_id AND p.org_id = $1
       ), paths AS (
         SELECT account_id, codes FROM ancestry WHERE parent_id IS NULL
       )
       SELECT a.id, a.type, a.balance_sheet_class, p.codes
         FROM accounts a JOIN paths p ON p.account_id = a.id
        WHERE a.org_id = $1
       ```
       - Re-validate `type` with `isAccountType` and `balance_sheet_class` with `isBalanceSheetClass`, throwing `Error` the way `cashFlowService` does.
       - Build a `Map<id, { type, cls }>` with `cls = deriveBalanceSheetClass({ type, ancestorCodes: codes, override })`.
    5. **Query B — balances at 13 dates.** `$2` is `[...windows.map(w => w.to), prior.to]` (index 1–12 are the trend, 13 is prior):
       ```sql
       SELECT l.account_id, p.idx::int AS idx,
              SUM(l.base_debit_cents)::text  AS debit_cents,
              SUM(l.base_credit_cents)::text AS credit_cents
         FROM unnest($2::date[]) WITH ORDINALITY AS p(as_of, idx)
         JOIN journal_entries e ON e.org_id = $1 AND e.entry_date <= p.as_of
         JOIN ledger_lines l    ON l.journal_entry_id = e.id AND l.org_id = $1
         JOIN accounts a        ON a.id = l.account_id AND a.org_id = $1
        WHERE a.type IN ('Asset', 'Liability')
        GROUP BY l.account_id, p.idx
       ```
       - For each row, take the account's class from the map. A missing id means `throw new Error(\`Account ${id} missing from the class map\`)`.
       - The signed balance is `debit − credit` for an Asset and `credit − debit` for a Liability.
       - Add it to that index's CA / NCA / CL / NCL, all with `parseCents`.
       - Build a `SnapshotPosition` per index: `totalAssets = CA + NCA`, `totalLiabilities = CL + NCL`, `netWorth = TA − TL`, `workingCapital = CA − CL`, and `asOf` = that index's date.
       - An index with no rows is all zeros.
    6. **Query C — monthly P&L.** `$2` is the window `from`s and `$3` the window `to`s:
       ```sql
       SELECT p.idx::int AS idx,
              COALESCE(SUM(l.base_credit_cents - l.base_debit_cents) FILTER (WHERE a.type = 'Revenue'), 0)::text AS revenue_cents,
              COALESCE(SUM(l.base_debit_cents - l.base_credit_cents)
                       FILTER (WHERE a.type = 'Expense' AND a.code LIKE '5%'), 0)::text AS cost_of_sales_cents
         FROM unnest($2::date[], $3::date[]) WITH ORDINALITY AS p(from_date, to_date, idx)
         JOIN journal_entries e ON e.org_id = $1 AND e.entry_date >= p.from_date AND e.entry_date <= p.to_date
         JOIN ledger_lines l    ON l.journal_entry_id = e.id AND l.org_id = $1
         JOIN accounts a        ON a.id = l.account_id AND a.org_id = $1
        WHERE a.type IN ('Revenue', 'Expense')
        GROUP BY p.idx
       ```
       A missing index is zero.
    7. **Trend points.** Build `SnapshotTrendPoint` `i` from window `i` (index `i+1`):
       - `grossProfitCents = revenue − costOfSales`
       - `grossMarginBp = ratioBp(gp, revenue).valueBp`
       - `currentRatioBp = ratioBp(CA, CL).valueBp`
       - `debtRatioBp = ratioBp(TL, TA).valueBp`
       - `debtToEquityBp = ratioBp(TL, NW).valueBp`
    8. **Performance** `{ current, prior }` from `pnl` / `priorPnl`:
       - `revenueCents: pnl.revenue.totalCents`
       - `costOfSalesCents: pnl.costOfSales.totalCents`
       - `grossProfitCents: pnl.grossProfitCents`
       - `operatingExpensesCents: pnl.operatingExpenses.totalCents`
       - `netIncomeCents: pnl.netIncomeCents`
    9. **Position:** `current` = index 12 and `prior` = index 13.
    10. **Ratios:** `ratios = buildRatios({ performance: current, position: current }, { performance: prior, position: prior })`.
    11. **Aging:** run `Promise.all([arAging(orgId, pnl.to), apAging(orgId, pnl.to)])`, then map each to a `SnapshotAging` of `{ asOf, buckets, totalOutstandingCents, totalOverdueCents }`, dropping `rows`.
    12. **Return** `{ period: { from: pnl.from, to: pnl.to }, priorPeriod: { from: prior.from, to: prior.to }, performance, position, ratios, receivables, payables, trend }`.
  - **No transaction.** These are read-only `pool.query` calls, the same as the other reports.
- **Guardrails:**
  - #1: every `FROM`/`JOIN` on `accounts`, `journal_entries` and `ledger_lines` carries `org_id = $1`, **including the CTE's recursive term**.
  - #3: `parseCents` on every text sum, no floats.
  - #4: date arrays are parameters, never interpolated.
- **Proof:**
  - `cd server && npm run typecheck && npm run lint` exits 0.
  - `grep -c "org_id = \$1" server/src/services/accounting/businessSnapshotService.ts` ≥ 9.
- **If it fails:** a query that returns nothing in Step 8 means fixing the fixture or parameters, never removing an `org_id` predicate.
- **Owes:** tests (Step 8)

### Step 7 — [Haiku] Controller handler, route, export table

- **Model:** [Haiku] — copies the `cashFlow` handler and `cashFlowTable` shape, with rows listed literally
- **Depends on:** 6
- **Skill:** new-module (controller/routes)
- **Read first:**
  - `server/src/controllers/accounting/reportController.ts` (`cashFlow` handler, lines 153–167)
  - `server/src/routes/accounting/reportRoutes.ts`
  - `server/src/services/accounting/reportTables.ts` `cashFlowTable` (line ~630) and `amountColumns()` (line ~51)
- **Files:** `server/src/controllers/accounting/reportController.ts` (edit), `server/src/routes/accounting/reportRoutes.ts` (edit), `server/src/services/accounting/reportTables.ts` (edit)
- **Contract:**
  - **Controller.** Add an import `import * as businessSnapshotService from '../../services/accounting/businessSnapshotService.js';`, add `businessSnapshotTable` to the `reportTables.js` import, then add:
    ```ts
    /** GET /reports/business-snapshot?from=YYYY-MM-DD&to=YYYY-MM-DD (defaults as the P&L) */
    export const businessSnapshot: RequestHandler = async (req, res) => {
      const user = requireUser(req);
      const from = optionalIsoDate(req, 'from');
      const to = optionalIsoDate(req, 'to');
      const format = readReportFormat(req);

      const report = await businessSnapshotService.businessSnapshot(user.orgId, from, to);
      if (format !== null) {
        const ctx = await reportService.loadReportContext(user.orgId);
        await sendReportFile(res, businessSnapshotTable(ctx, report), format);
        return;
      }
      res.json({ success: true, ...report });
    };
    ```
  - **Route.** Insert directly after the `/cash-flow` line:
    `router.get('/business-snapshot', authenticate, requirePermission('reports.view'), reportController.businessSnapshot);`
  - **Table builder.**
    - Signature: `export function businessSnapshotTable(ctx: ReportContext, report: BusinessSnapshot): ReportTable`.
    - Import `BusinessSnapshot` and `SnapshotRatioValue` from `../../types/accounting.js`. Do not import `SNAPSHOT_RATIO_SPECS`: use `ratio.label` / `ratio.kind`.
    - Columns, exactly:
      ```ts
      [
        { key: 'item', label: 'Item', align: 'left', widthChars: 36 },
        { key: 'current', label: 'Current', align: 'right', widthChars: 16 },
        { key: 'prior', label: 'Prior period', align: 'right', widthChars: 16 },
      ]
      ```
    - A local helper `ratioCell(kind, v: SnapshotRatioValue): ReportCell` returns:
      - `{ kind: 'empty' }` when `v.valueBp === null`
      - `{ kind: 'percent', bp: v.valueBp }` for `'PERCENT'`
      - `text(\`${(v.valueBp / 10000).toFixed(2)}×\`)` for `'TIMES'`. This is display only, never fed back into money.
    - Rows, in order:
      1. **Performance:** a heading `Performance`, then detail rows (indent 1) for Revenue, Cost of sales, Gross profit, Operating expenses and Net income, each as `money` current and prior.
      2. **Position:** a heading `Financial position`, then detail rows (indent 1) for Current assets, Non-current assets, Total assets (`subtotal`), Current liabilities, Non-current liabilities, Total liabilities (`subtotal`), Net worth (`total`) and Working capital.
      3. **Ratios:** a heading `Ratios`, then one detail row (indent 1) per `report.ratios` entry, with `item = ratio.label`, `current = ratioCell(ratio.kind, ratio.current)` and `prior = ratioCell(ratio.kind, ratio.prior)`.
      4. **Aging:** a heading `Aged receivables`, then one detail row per bucket (`item = bucket.label`, `current = money(bucket.amountCents)`, prior empty), then `subtotal` "Total outstanding". The same for `Aged payables` from `report.payables`.
      5. **Trend:** a heading `12-month trend`, then one detail row per trend point, with `item = point.month`, `current = money(point.revenueCents)` and `prior = money(point.grossProfitCents)`.
    - `title: 'Business snapshot'`.
    - `subtitle: \`${ctx.organizationName} · ${dateLabel(report.period.from)} – ${dateLabel(report.period.to)} · ${ctx.baseCurrency}\``.
    - `footnotes`, exactly:
      ```ts
      [
        `Prior period: ${dateLabel(report.priorPeriod.from)} – ${dateLabel(report.priorPeriod.to)}.`,
        '12-month trend rows: Current = revenue, Prior period = gross profit.',
        'Fixed assets are non-current assets. A blank ratio has a zero or negative denominator.',
      ]
      ```
    - `filenameStem: \`business-snapshot-${report.period.from}-${report.period.to}\``.
- **Guardrails:** #2 no SQL in the controller · rule 38c, the route carries `requirePermission('reports.view')` (the router-walking test fails otherwise)
- **Proof:** `cd server && npm run typecheck && npm run lint` exits 0, and `npx vitest run src/__tests__/platform/routePermissions.test.ts` (the router-walking ungated-route test) passes.
- **If it fails:** never add the route without `requirePermission`.
- **Owes:** the `docs/api.md` row (Step 17)

### Step 8 — [Sonnet] Integration tests — `businessSnapshot.test.ts`

- **Model:** [Sonnet] — real-Postgres integration, tie-outs, cross-tenant isolation
- **Depends on:** 7
- **Skill:** isolation-test
- **Read first:** `server/src/__tests__/accounting/cashFlow.test.ts` (whole file: setup, `postManual`, `binary`, the `DB check` and `cross-tenant` cases)
- **Files:** `server/src/__tests__/accounting/businessSnapshot.test.ts` (new)
- **Fixture.** In `beforeEach`, reset and seed org A and org B as `cashFlow.test.ts` does. A helper `seedBase()` posts these manual journals in org A, all dated `2026-09-15`, using `postManual` copied from `cashFlow.test.ts`:

  | # | Debit | Credit | Cents |
  |---|---|---|---|
  | J1 | 1500 | 3100 | 600000 |
  | J2 | 1130 | 2510 | 400000 |
  | J3 | 1130 | 4100 | 300000 |
  | J4 | 5100 | 2120 | 120000 |
  | J5 | 6100 | 1590 | 100000 |

  Query constants: `FROM = '2026-09-01'`, `TO = '2026-09-30'`. The prior period is `2026-08-01`–`2026-08-31`.
- **Test cases (exact names and expectations):**
  1. `position and performance from a hand-computed ledger`: after `seedBase()`, `GET /api/v1/reports/business-snapshot?from=FROM&to=TO` returns `200`.
     - `position.current` equals `{ asOf: '2026-09-30', currentAssetsCents: 700000, nonCurrentAssetsCents: 500000, totalAssetsCents: 1200000, currentLiabilitiesCents: 120000, nonCurrentLiabilitiesCents: 400000, totalLiabilitiesCents: 520000, netWorthCents: 680000, workingCapitalCents: 580000 }`.
     - `performance.current` equals `{ revenueCents: 300000, costOfSalesCents: 120000, grossProfitCents: 180000, operatingExpensesCents: 100000, netIncomeCents: 80000 }`.
     - `priorPeriod` equals `{ from: '2026-08-01', to: '2026-08-31' }`.
  2. `ratios in bp`: the current values by key are `GROSS_MARGIN 6000`, `CURRENT_RATIO 58333`, `DEBT_RATIO 4333`, `DEBT_TO_EQUITY 7647`, `WORKING_CAPITAL_TO_TOTAL_ASSETS 4833`, `FIXED_ASSETS_TO_NET_WORTH 7353` and `CURRENT_LIABILITIES_TO_NET_WORTH 1765`. Every `prior` is `{ valueBp: null, reason: 'DENOMINATOR_ZERO' }`, because August is empty.
  3. `ties to the balance sheet and P&L`:
     - `GET /reports/balance-sheet?asOf=TO`: `assets.totalCents === position.current.totalAssetsCents`, `liabilities.totalCents === totalLiabilitiesCents` and `equity.totalCents === netWorthCents`.
     - `GET /reports/profit-and-loss?from=FROM&to=TO`: `grossProfitCents === performance.current.grossProfitCents`.
  4. `override moves an account between classes`: `PATCH /api/v1/accounts/<1130 id>` with `{ balanceSheetClass: 'NON_CURRENT' }` returns `200`, and the response's `account.balanceSheetClass === 'NON_CURRENT'`. Then `position.current.currentAssetsCents === 0`, `nonCurrentAssetsCents === 1200000`, and the `CURRENT_RATIO` current is `0`.
  5. `override refused on revenue`: `PATCH` 4100 with `{ balanceSheetClass: 'CURRENT' }` returns `422`, with `body.error === 'Only asset and liability accounts have a balance sheet class'`.
  6. `DB check`: `pool.query("UPDATE accounts SET balance_sheet_class = 'CURRENT' WHERE code = '3100' AND org_id = $1", [orgA])` rejects with `{ code: '23514' }`.
  7. `negative net worth`: `seedBase()`, then post `6100 Dr / 2120 Cr 800000`.
     - `netWorthCents === -120000`.
     - `DEBT_TO_EQUITY`, `FIXED_ASSETS_TO_NET_WORTH` and `CURRENT_LIABILITIES_TO_NET_WORTH` current are each `{ valueBp: null, reason: 'DENOMINATOR_NEGATIVE' }`.
  8. `empty organization`: with no journals, the response is `200`, every `position.current` amount is `0`, `trend.length === 12`, and every ratio current `valueBp === null`.
  9. `trend ends at the period`:
     - `trend.length === 12`.
     - `trend[11]` is `{ month: '2026-09', asOf: '2026-09-30', revenueCents: 300000, costOfSalesCents: 120000, grossProfitCents: 180000, grossMarginBp: 6000, currentRatioBp: 58333 }` (use `toMatchObject`).
     - `trend[0].month === '2025-10'` and `trend[10].revenueCents === 0`.
  10. `aging matches the aging reports`:
      - Create a customer and issue an invoice using `createCustomer` and `issueInvoice` from `helpers/accountingFixtures.ts`, dated in September.
      - `receivables.totalOutstandingCents` equals `GET /reports/ar-aging?asOf=TO` `totalOutstandingCents` and is `> 0`.
      - `receivables.buckets.length === 5`.
      - `payables.totalOutstandingCents === 0`.
  11. `exports`: `?format=csv`, `?format=xlsx` and `?format=pdf` each return `200`.
      - `content-disposition` contains `business-snapshot-2026-09-01-2026-09-30`.
      - The CSV body contains `Current ratio` and `5.83×`.
      - `?format=doc` returns `400`.
  12. `bad window`: `?from=2026-10-01&to=2026-09-01` returns `422`.
  13. `cross-tenant`: after `seedBase()` in org A, org B's agent gets `200` with `position.current.totalAssetsCents === 0` and `performance.current.revenueCents === 0`.
  14. `snapshotTrendWindows`: import it directly. `snapshotTrendWindows('2026-09-15')[0]` equals `{ month: '2025-10', from: '2025-10-01', to: '2025-10-31' }`, and `[11]` equals `{ month: '2026-09', from: '2026-09-01', to: '2026-09-15' }`. `snapshotTrendWindows('2026-03-31')[11].to === '2026-03-31'`, and `[10].to === '2026-02-28'`.
- **Guardrails:** #15 the cross-tenant case is mandatory · #1 never weaken a fixture by querying without `org_id`
- **Proof:** `cd server && npx vitest run src/__tests__/accounting/businessSnapshot.test.ts` shows 14 passed. Then run the full `npm test`: there must be zero failures, and the skipped count stays at 2.
- **If it fails:**
  - If a manual journal fixture is refused (`422`), report which account. Do not swap accounts without stopping.
  - If a hand-computed number disagrees, recompute from the J1–J5 table. Stop if the plan is wrong. Never edit the expectation to match the output.
- **Owes:** nothing more

---

## Slice 47b — Client

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| Dependencies | `recharts@3.10.1`, `react-is@19.2.8` (exact, `--save-exact`) |
| Fetcher / types (`client/src/services/fetchServices.ts`) | `getBusinessSnapshot`, `BusinessSnapshot`, `SnapshotPerformance`, `SnapshotPosition`, `SnapshotRatio`, `SnapshotRatioKey`, `SnapshotRatioValue`, `SnapshotAging`, `SnapshotTrendPoint`, `BalanceSheetClass` |
| Format helpers | `client/src/utils/ratio.ts` → `formatRatio`, `ratioUnavailableText` |
| Chart components (`client/src/components/charts/`) | `ProfitabilityChart.tsx`, `RatioTrendChart.tsx`, `PositionChart.tsx`, `AgingStackChart.tsx` |
| Page | `client/src/Pages/reports/BusinessSnapshotPage.tsx` (default export `BusinessSnapshotPage`) |
| Route | `/reports/business-snapshot` |
| Dashboard component | `client/src/Pages/home/BusinessHealthTiles.tsx` (default export) |
| Account form options | `BALANCE_SHEET_CLASS_OPTIONS`, `hasBalanceSheetClass` in `NewAccountForm.tsx` |
| Tests | `client/src/__tests__/businessSnapshot.test.tsx` (new), `client/src/__tests__/dashboard.test.tsx` (edit), `client/src/__tests__/cashFlow.test.tsx` (edit — account form case) |

### Step 9 — [Haiku] Dependencies, test polyfill, fetcher, types, format helpers

- **Model:** [Haiku] — the install command is literal, and the types mirror Step 2
- **Depends on:** 8
- **Skill:** none (client)
- **Read first:** `client/src/services/fetchServices.ts` `getCashFlow` (~2967) and `Account` / `CreateAccountInput` / `UpdateAccountInput` (~540–700), and `client/src/__tests__/setup.ts`
- **Files:** `client/package.json` + lockfile (via npm), `client/src/__tests__/setup.ts` (edit), `client/src/services/fetchServices.ts` (edit), `client/src/utils/ratio.ts` (new)
- **Contract:**
  1. `cd client && npm install --save-exact recharts@3.10.1 react-is@19.2.8`. Nothing else.
  2. Append to `setup.ts`:
     ```ts
     // Recharts' ResponsiveContainer observes its parent's size; jsdom has no ResizeObserver.
     // The stub never fires, so charts render at zero size in tests — assertions use the
     // visually-hidden data tables each chart renders beside its SVG.
     class ResizeObserverStub {
       observe(): void {}
       unobserve(): void {}
       disconnect(): void {}
     }
     globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
     ```
  3. In `fetchServices.ts`:
     - Add `export type BalanceSheetClass = 'CURRENT' | 'NON_CURRENT';` beside `CashFlowCategory`.
     - Add `/** Phase 47. */ balanceSheetClass?: BalanceSheetClass | null;` after `cashFlowCategory?` in `Account`, `CreateAccountInput` and `UpdateAccountInput`.
  4. Add a new block `/* ---------------------------------------------------- accounting: Phase 47 business snapshot */` directly after `getCashFlow`:
     - Transcribe the Step 2 interfaces `SnapshotRatioKey` (as a string-literal union of the 7 keys), `SnapshotRatioValue`, `SnapshotRatio`, `SnapshotPeriod`, `SnapshotPerformance`, `SnapshotPosition`, `SnapshotAging` (with `buckets: AgingBucketAmount[]`), `SnapshotTrendPoint` and `BusinessSnapshot`, each with a `/** Mirrors server/src/types/accounting.ts's X. */` comment.
     - Add `getBusinessSnapshot(from: string | null = null, to: string | null = null, signal?: AbortSignal): Promise<BusinessSnapshot>`, which is `getCashFlow` with the path `/reports/business-snapshot`.
  5. Create `client/src/utils/ratio.ts`:
     ```ts
     import type { SnapshotRatioValue } from '../services/fetchServices';

     /** 1250 PERCENT → "12.50%"; 58333 TIMES → "5.83×"; null → "—". Display only. */
     export function formatRatio(kind: 'PERCENT' | 'TIMES', valueBp: number | null): string {
       if (valueBp === null) return '—';
       return kind === 'PERCENT' ? `${(valueBp / 100).toFixed(2)}%` : `${(valueBp / 10000).toFixed(2)}×`;
     }

     /** The tooltip text for an unavailable ratio. */
     export function ratioUnavailableText(value: SnapshotRatioValue): string | null {
       if (value.reason === 'DENOMINATOR_ZERO') return 'Not available: the denominator is zero.';
       if (value.reason === 'DENOMINATOR_NEGATIVE') return 'Not meaningful: the denominator is negative (for example, negative net worth).';
       return null;
     }
     ```
- **Guardrails:** #14 only the two named packages
- **Proof:** `cd client && npm run typecheck && npm test` exits 0 (no regressions), and `grep '"recharts": "3.10.1"' client/package.json` matches.
- **If it fails:** a peer-dependency error from npm is a stop-and-report. Do not use `--force` or `--legacy-peer-deps`.
- **Owes:** the `docs/development.md` dependency note (Step 17)

### Step 10 — [Haiku] Chart components

- **Model:** [Haiku] — four presentational components whose props and Recharts elements are listed
- **Depends on:** 9
- **Skill:** none (client)
- **Read first:** `client/src/components/TrendChart.tsx` (its `visually-hidden` table and the comment explaining why), and `client/src/utils/money.ts` `formatCents`
- **Files:** `client/src/components/charts/ProfitabilityChart.tsx`, `RatioTrendChart.tsx`, `PositionChart.tsx`, `AgingStackChart.tsx` (all new)
- **Contract — every component follows this shape:**
  - The outer `<figure className="m-0">`.
  - A `<div aria-hidden="true" style={{ width: '100%', height: 260 }}>` that wraps `<ResponsiveContainer width="100%" height="100%">`.
  - A `<table className="visually-hidden">` with a `<caption>` that carries every plotted value. Format money with `formatCents` and ratios with `formatRatio`.
  - Colours are CSS variables passed as strings, for example `fill="var(--accent)"`. There are no hex literals.
  - Axes use `tick={{ fill: 'var(--muted)', fontSize: 12 }}` and `stroke="var(--border)"`. `CartesianGrid` uses `stroke="var(--border)" strokeDasharray="3 3" vertical={false}`.
  - The money axis `tickFormatter` is `(v: number) => formatCents(v)`.

  | Component | Props | Recharts elements |
  |---|---|---|
  | `ProfitabilityChart` | `{ points: SnapshotTrendPoint[] }` | `ComposedChart data={points}`, `XAxis dataKey="month"`, `YAxis yAxisId="money"`, `YAxis yAxisId="pct" orientation="right" tickFormatter={(v: number) => formatRatio('PERCENT', v)}`, `Bar yAxisId="money" dataKey="revenueCents" name="Revenue" fill="var(--accent)"`, `Bar yAxisId="money" dataKey="costOfSalesCents" name="Cost of sales" fill="var(--warn)"`, `Line yAxisId="pct" dataKey="grossMarginBp" name="Gross margin" stroke="var(--good)" dot={false} connectNulls`, `Tooltip`, `Legend`. Caption: `Revenue, cost of sales and gross margin by month`. Table columns: Month, Revenue, Cost of sales, Gross profit, Gross margin. |
  | `RatioTrendChart` | `{ points: SnapshotTrendPoint[] }` | `LineChart data={points}`, `XAxis dataKey="month"`, `YAxis yAxisId="times" tickFormatter={(v: number) => formatRatio('TIMES', v)}`, `YAxis yAxisId="pct" orientation="right" tickFormatter={(v: number) => formatRatio('PERCENT', v)}`, `Line yAxisId="times" dataKey="currentRatioBp" name="Current ratio" stroke="var(--accent)"`, `Line yAxisId="times" dataKey="debtToEquityBp" name="Debt to equity" stroke="var(--bad)"`, `Line yAxisId="pct" dataKey="debtRatioBp" name="Debt ratio" stroke="var(--warn)"`, each `dot={false} connectNulls`, `Tooltip`, `Legend`. Caption: `Current ratio, debt to equity and debt ratio by month`. |
  | `PositionChart` | `{ position: SnapshotPosition }` | `BarChart` over two rows, `[{ name: 'Assets', current: CA, nonCurrent: NCA, netWorth: 0 }, { name: 'Liabilities & net worth', current: CL, nonCurrent: NCL, netWorth: max(NW, 0) }]`, with `XAxis dataKey="name"`, `YAxis`, and `Bar stackId="a"` ×3: `current` "Current" `var(--accent)`, `nonCurrent` "Non-current" `var(--accent-soft)`, `netWorth` "Net worth" `var(--good)`. Add `Tooltip` and `Legend`. Caption: `Assets against liabilities and net worth`. The table lists all 9 position amounts. |
  | `AgingStackChart` | `{ receivables: SnapshotAging; payables: SnapshotAging }` | `BarChart layout="vertical"` over two rows, `Receivables` and `Payables`, each with keys `CURRENT, D1_30, D31_60, D61_90, D90_PLUS` taken from `buckets[].amountCents`. Use `XAxis type="number"` and `YAxis type="category" dataKey="name"`, and five `Bar stackId="a"` with `name` = the bucket `label` and fills `var(--good)`, `var(--accent)`, `var(--warn)`, `var(--bad)`, `var(--bad)`, plus `Tooltip` and `Legend`. Caption: `Receivables and payables by age`. The table has a row per bucket with both amounts. |

  Import only from `'recharts'`.
- **Guardrails:** none server-side. Money stays integer cents until `formatCents`.
- **Proof:** `cd client && npm run typecheck && npm run lint` exits 0.
- **If it fails:** a Recharts prop type error means checking the prop name against `node_modules/recharts/types/`. Never cast to `any`.
- **Owes:** the study note (Step 15)

### Step 11 — [Haiku] `BusinessSnapshotPage`, route, reports index entry

- **Model:** [Haiku] — copies `CashFlowPage`'s data flow, with the layout listed
- **Depends on:** 10
- **Skill:** none (client)
- **Read first:** `client/src/Pages/reports/CashFlowPage.tsx` (whole), `client/src/components/ui/StatTile.tsx`, `client/src/Pages/reports/ReportsPage.tsx`
- **Files:** `client/src/Pages/reports/BusinessSnapshotPage.tsx` (new), `client/src/routes/ProductRoutes.tsx` (edit), `client/src/Pages/reports/ReportsPage.tsx` (edit)
- **Contract:**
  - **Data flow.** Copy `CashFlowPage`'s `userFrom`/`userTo` state, `useLedgerSettings` + `fiscalYearBounds` defaults, effect with `ignore` flag, error and `LoadingState` handling, calling `getBusinessSnapshot(from || null, to || null)`.
  - **Presets.** A `<select aria-label="Period">` with these options, each setting both dates:

    | Option (value) | Window |
    |---|---|
    | `This month` (`month`) | first of `today`'s month → today |
    | `This quarter` (`quarter`) | first day of the calendar quarter → today |
    | `Year to date` (`ytd`, the default) | `defaults.startDate` → today |
    | `Custom` (`custom`) | leaves the date inputs as they are |

    Editing a date input sets the select to `custom`.
  - **Header.** `BackLink to="/reports" label="Back to reports"`, `<h2>` "Business snapshot", the subtitle "How the business is performing, and its financial position, computed from ledger lines on every request.", `ExportMenu path="/reports/business-snapshot" params={{ from: from || null, to: to || null }}`, the preset select and the From/To date inputs.
  - **Body.** Rendered when the report is loaded, in this order:
    1. **KPIs** in `<div className="grid">`: six `StatTile`s, each with `value` = `formatCents(current)` and `hint` = `` `Prior period ${formatCents(prior)}` ``:
       - Revenue (icon `TrendingUp`)
       - Cost of sales (`PackageMinus`)
       - Gross profit (`Coins`)
       - Gross margin (`Percent`). Its `value` is `formatRatio('PERCENT', <GROSS_MARGIN current valueBp>)` and its `hint` uses `formatRatio` on the prior value.
       - Net worth (`Landmark`)
       - Working capital (`Wallet`)

       Icons come from `lucide-react`. `tone` is `'neutral'`, except Net worth and Working capital, which are `'bad'` when their current amount is negative and `'good'` otherwise.
    2. **Profitability:** `<div className="card">` with `<h3 className="m-0 mb-3 text-sm font-semibold">Profitability — last 12 months</h3>` and `<ProfitabilityChart points={report.trend} />`.
    3. **Ratios:** a `card` with `<h3>Ratios</h3>`, then a `<table>` with columns Ratio, Current and Prior period, one row per `report.ratios`. Each cell is `formatRatio(ratio.kind, value.valueBp)` with `title={ratioUnavailableText(value) ?? undefined}`. Below the table, `<RatioTrendChart points={report.trend} />`.
    4. **Position and aging:** a two-column grid (`grid grid-cols-1 md:grid-cols-2 gap-4`), holding a `card` "Financial position" with `<PositionChart position={report.position.current} />` and a `card` "Aged receivables & payables" with `<AgingStackChart receivables={report.receivables} payables={report.payables} />`, plus links `Aged receivables →` to `/reports/aged-receivables` and `Aged payables →` to `/reports/aged-payables`.
    5. A footnote `<p className="text-xs text-[var(--muted)]">`: "Prior period: {dateLabel}. Fixed assets are non-current assets. Accounts are current or non-current by their place in the chart of accounts, or by the override in Chart of accounts." Format the dates with `formatDate` from `utils/date`.
  - **Route.** Import the page and add `<Route path="/reports/business-snapshot" element={<BusinessSnapshotPage />} />` directly before `/reports/profit-and-loss`.
  - **Reports index.** Add a new **first** section to `SECTIONS`:
    `{ heading: 'Overview', reports: [{ name: 'Business snapshot', description: 'Gross margin, cost of sales, key ratios, aging and a 12-month trend, with charts.', path: 'reports/business-snapshot' }] }`.
- **Guardrails:** money is formatted only by `formatCents`, and ratios only by `formatRatio`
- **Proof:** `cd client && npm run typecheck && npm run lint && npm test` exits 0. If `navigation.test.tsx` counts report sections or cards and now fails, **stop and report**; Step 14 owns test changes.
- **If it fails:** no inline number formatting outside the two helpers.
- **Owes:** nothing

### Step 12 — [Haiku] Balance sheet class on the account form and chart settings

- **Model:** [Haiku] — mirrors the cash flow select twice
- **Depends on:** 9
- **Skill:** none (client)
- **Read first:** `client/src/Pages/accounting/NewAccountForm.tsx` (lines 28–50, 60–95, 195–215), `client/src/Pages/settings/ChartSettingsPage.tsx` (lines 50–60, 125–140, 245–265, 330–340)
- **Files:** `client/src/Pages/accounting/NewAccountForm.tsx` (edit), `client/src/Pages/settings/ChartSettingsPage.tsx` (edit)
- **Contract:**
  - **`NewAccountForm.tsx`:**
    - Add, after `hasCashFlowCategory`:
      ```ts
      /** Phase 47 — current/non-current; '' is "Automatic" (sent as null, derived from the chart tree). */
      export const BALANCE_SHEET_CLASS_OPTIONS: { value: '' | BalanceSheetClass; label: string }[] = [
        { value: '', label: 'Automatic' },
        { value: 'CURRENT', label: 'Current' },
        { value: 'NON_CURRENT', label: 'Non-current' },
      ];

      export function hasBalanceSheetClass(type: AccountType): boolean {
        return type === 'Asset' || type === 'Liability';
      }
      ```
    - Add the state `const [balanceSheetClass, setBalanceSheetClass] = useState<'' | BalanceSheetClass>('');`.
    - In the submit payload, beside the cash flow spread: `...(hasBalanceSheetClass(type) ? { balanceSheetClass: balanceSheetClass === '' ? null : balanceSheetClass } : {}),`.
    - Reset it to `''` wherever `setCashFlowCategory('')` is called on a type change.
    - Render, directly after the cash flow `<label>`, a `<label>` "Balance sheet class" with a `<select>` over `BALANCE_SHEET_CLASS_OPTIONS`, shown when `hasBalanceSheetClass(type)`. It uses the same classes as the cash flow select.
  - **`ChartSettingsPage.tsx`:**
    - Add a row prop `onSetBalanceSheetClass: (node: AccountNode, value: '' | BalanceSheetClass) => Promise<void>`.
    - Add a `handleBalanceSheetClassChange` that copies `handleCashFlowChange`.
    - Add a `<select aria-label={\`Balance sheet class ${node.code}\`}>` that copies the cash flow select, shown when `hasBalanceSheetClass(node.type)`, with `value={node.balanceSheetClass ?? ''}`.
    - Add the page handler `handleSetBalanceSheetClass`, which calls `updateAccount(node.id, { balanceSheetClass: value === '' ? null : value })`, a copy of `handleSetCashFlow`.
    - Import `BALANCE_SHEET_CLASS_OPTIONS`, `hasBalanceSheetClass` and `BalanceSheetClass`.
- **Guardrails:** the field is sent only for Asset/Liability; the server refuses it on other types with `422`
- **Proof:** `cd client && npm run typecheck && npm run lint && npm test` exits 0.
- **If it fails:** an existing test asserting an exact payload `toEqual` on account create is expected to need no change, because the field is only spread for Asset/Liability. If it does fail, stop and report.
- **Owes:** nothing

### Step 13 — [Haiku] Dashboard "Business health" tiles

- **Model:** [Haiku] — one presentational component with its own fetch, copying `FullDashboard`'s effect
- **Depends on:** 11
- **Skill:** none (client)
- **Read first:** `client/src/Pages/home/DashboardPage.tsx` (lines 90–240), `client/src/components/ui/StatTile.tsx`
- **Files:** `client/src/Pages/home/BusinessHealthTiles.tsx` (new), `client/src/Pages/home/DashboardPage.tsx` (edit)
- **Contract:**
  - **`BusinessHealthTiles` (no props).**
    - On mount it calls `getBusinessSnapshot()` (YTD default), using the effect-with-`ignore` pattern.
    - **While loading** it renders `null`.
    - **On error** it renders `<p className="text-sm text-[var(--muted)]">Business health is unavailable right now.</p>`.
    - **Loaded**, it renders:
      ```tsx
      <section aria-labelledby="business-health-heading" className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 id="business-health-heading" className="m-0 text-sm font-semibold">Business health</h3>
          <Link to="/reports/business-snapshot" className="text-xs">View business snapshot →</Link>
        </div>
        <div className="grid">{/* four StatTiles */}</div>
      </section>
      ```
    - The four `StatTile`s, all with `to="/reports/business-snapshot"`:

      | Label | Value | Icon | Hint |
      |---|---|---|---|
      | `Gross margin (YTD)` | `formatRatio('PERCENT', GROSS_MARGIN current)` | `Percent` | — |
      | `Current ratio` | `formatRatio('TIMES', CURRENT_RATIO current)` | `Scale` | — |
      | `Debt to equity` | `formatRatio('TIMES', DEBT_TO_EQUITY current)` | `Landmark` | — |
      | `Working capital` | `formatCents(position.current.workingCapitalCents)` | `Wallet` | `` `As at ${formatDate(report.period.to)}` `` |

      `tone` is `'neutral'`.
  - **`DashboardPage.tsx`:** render `<BusinessHealthTiles />` in `FullDashboard` directly after the closing `</div>` of the Assets/Liabilities/Equity/Cash `grid`. `FullDashboard` is only shown when `can('reports.view')`, so there is no extra permission check.
- **Guardrails:** the dashboard must still render if the snapshot request fails (the error branch above)
- **Proof:** `cd client && npm run typecheck && npm run lint` exits 0. `dashboard.test.tsx` may now log unhandled `404`s for `/reports/business-snapshot`. Step 14 adds the route mock.
- **If it fails:** never make `FullDashboard` wait on the snapshot.
- **Owes:** nothing

### Step 14 — [Haiku] Client tests

- **Model:** [Haiku] — named cases with literal expectations and existing mock helpers
- **Depends on:** 11, 12, 13
- **Skill:** none (client tests)
- **Read first:** `client/src/__tests__/cashFlow.test.tsx` (whole), `client/src/__tests__/dashboard.test.tsx` (lines 1–130)
- **Files:** `client/src/__tests__/businessSnapshot.test.tsx` (new), `client/src/__tests__/dashboard.test.tsx` (edit), `client/src/__tests__/cashFlow.test.tsx` (edit)
- **Contract:**
  - **Fixture.** In `businessSnapshot.test.tsx`, `snapshotFixture(): BusinessSnapshot` uses the Step 8 numbers:
    - `position.current` and `performance.current` exactly as in Step 8 case 1, with `prior` all zeros and `asOf: '2026-08-31'`
    - ratios as Step 8 case 2, with `label`/`kind` from Step 4's `SNAPSHOT_RATIO_SPECS`, and `prior` `{ valueBp: null, reason: 'DENOMINATOR_ZERO' }`
    - 12 trend points, months `2025-10` … `2026-09`, all zeros except the last, which matches Step 8 case 9 with `debtRatioBp: 4333` and `debtToEquityBp: 7647`
    - `receivables`/`payables` with 5 zero buckets (labels `Current`, `1–30 days`, `31–60 days`, `61–90 days`, `90+ days`)
  - **Mocks.** Mock `useLedgerSettings` exactly as `cashFlow.test.tsx` does, and `fetch` via `vi.stubGlobal`, answering URLs containing `/reports/business-snapshot` with `{ success: true, ...snapshotFixture() }`.
  - **Cases:**
    1. `renders KPIs`: `screen.getByText(formatCents(300000))` (revenue) and `screen.getByText('60.00%')` (gross margin) are present.
    2. `renders every ratio`: the texts `Current ratio`, `5.83×`, `Debt ratio`, `43.33%`, `Debt to equity` and `0.76×` are present (use `getAllByText(...).length > 0` where a value also appears in a chart table).
    3. `unavailable prior ratio shows a dash with a reason`: an element with title `Not available: the denominator is zero.` exists, and its text is `—`.
    4. `period preset refetches`: change the `Period` select to `month`, and the last fetch URL contains `/reports/business-snapshot?from=` with the first of the current month.
    5. `chart data is available to screen readers`: `screen.getByText('Revenue, cost of sales and gross margin by month')` (a caption) is present.
  - **`dashboard.test.tsx`:** in `mockRoutes`, before the 404 fallback, answer URLs containing `/api/v1/reports/business-snapshot` with `jsonResponse(200, { success: true, ...snapshot })`. `snapshot` is a minimal `BusinessSnapshot` literal with the same numbers. Add the case `shows business health tiles`: `await screen.findByText('Business health')`, then `screen.getByText('5.83×')` and a link with name matching `/View business snapshot/` pointing to `/reports/business-snapshot`.
  - **`cashFlow.test.tsx`:** add the case `account form sends balanceSheetClass for an asset`, a copy of the existing cash flow payload case. Choose `Non-current` in the `Balance sheet class` select for an Asset, submit, and the POST body has `balanceSheetClass: 'NON_CURRENT'`. For a Revenue type, the select is absent (`queryByLabelText('Balance sheet class')` is `null`).
  - **`navigation.test.tsx`:** if Step 11 reported a failure here, update only the expected section/card count by exactly +1 section and +1 card. Leave every other assertion as it is.
- **Proof:** `cd client && npm test` passes with zero failures, and `npx vitest run src/__tests__/businessSnapshot.test.tsx` shows 5 passed.
- **If it fails:** a text matching several elements needs `getAllByText`. Never delete a case.
- **Owes:** nothing

---

## Slice 47c — Study notes, docs, review

### Step 15 — [Sonnet] Study notes

- **Model:** [Sonnet] — accuracy-critical interview material
- **Depends on:** 8, 14
- **Skill:** study-note
- **Read first:** `docs/study-notes.md`, `study/TEMPLATE.md`, `study/react/hand-rolled-svg-charts.md`, `study/architecture/cash-flow-statement-indirect-method.md`, `study/README.md`
- **Files:**
  - `study/architecture/financial-ratios-in-integer-basis-points.md` (new)
  - `study/react/charts-with-recharts.md` (new)
  - `study/architecture/cash-flow-statement-indirect-method.md` (edit)
  - `study/README.md` (edit: index and coverage tracker)
- **Contract — the notes must cover:**
  - **Ratios note:**
    - The seven ratios, their formulas and what each tells a lender or owner.
    - Why integer bp, and the BigInt half-away-from-zero formula `(2|n| + d) / 2d`.
    - `-0` normalisation.
    - `null` + reason vs `Infinity`/`NaN`, and why negative net worth makes D/E meaningless rather than "very good".
    - Point-in-time (balance sheet) vs period (P&L) figures.
    - Contra accounts (1590) netting inside non-current assets.
    - The derived + override classification and why it is not a sixth account type.
    - One `unnest(date[]) WITH ORDINALITY` query for 13 as-at balances vs 13 round trips.
    - Rejected alternatives: floats, a stored snapshot table, `DECIMAL`.
    - 4–8 Q&As.
  - **Recharts note:**
    - How Recharts composes SVG declaratively (child elements as configuration, with the chart reading its children). Verify against `recharts@3.10.1` source or docs.
    - `ResponsiveContainer` and `ResizeObserver`, and why jsdom renders zero-size charts.
    - Theming via CSS custom properties in SVG presentation attributes.
    - The visually-hidden table pattern.
    - When a library beats hand-rolled SVG (`hand-rolled-svg-charts.md`), and when canvas would win (thousands of points).
    - Bundle-size cost.
    - 4–8 Q&As.
    - Flag anything not verified.
  - **Cash-flow note extension:** a section "A second derived-with-override attribute (Phase 47)", covering `balance_sheet_class` and why the CTE was copied rather than shared this phase.
  - **README:** add both new notes to the index, and add coverage rows "Financial ratios in integer bp — 47 ✅" and "Charts with a React chart library — 47 ✅".
- **Proof:** `grep -c "^### Q\|^\*\*Q" study/architecture/financial-ratios-in-integer-basis-points.md study/react/charts-with-recharts.md` shows ≥ 4 each (match the template's question heading style), and `grep -n "47" study/README.md` shows the new rows.
- **Owes:** nothing

### Step 16 — [Sonnet] Guardrail review and full verification

- **Model:** [Sonnet] — verification
- **Depends on:** 15
- **Skill:** guardrail-review
- **Files:** none, unless the review finds a violation. Then fix it in the offending file and re-run.
- **Contract:** review the full diff since `8c7b5d5`. Specifically confirm:
  - #1: every SQL statement in `businessSnapshotService.ts`, including the recursive CTE term, has `org_id = $1`.
  - #2: no SQL in `reportController.ts`.
  - #3: no float arithmetic on cents or bp server-side.
  - #4: date arrays are parameterised.
  - #13: `104` is additive and idempotent.
  - #14: only `recharts`/`react-is` were added.
  - #15: a cross-tenant test exists.
- **Proof:** all of these exit 0:
  - `cd server && npm run typecheck && npm run lint && npm test` (the skipped count stays at 2)
  - `cd server && npm run verify:integrity`
  - `cd client && npm run typecheck && npm run lint && npm test`
  - `cd server && npm run migrate` (a no-op)

  Record the test totals (server passed/skipped, client passed) for Step 17.
- **If it fails:** fix forward. Never suppress a lint rule.
- **Owes:** nothing

### Step 17 — [Sonnet] Docs sync

- **Model:** [Sonnet] — docs must match what landed
- **Depends on:** 16
- **Skill:** docs-sync
- **Files:** `docs/api.md`, `docs/schema.md`, `docs/accounting.md`, `docs/roadmap.md`, `docs/development.md`, `CLAUDE.md` (all edits)
- **Contract:**
  - **`api.md`:**
    - Add a row after `/cash-flow`: `| GET | /business-snapshot | reports.view | Phase 47 — …performance, position, seven ratios (bp, null + reason on a ≤ 0 denominator) current vs prior period, AR/AP aging summary, 12-month trend; ?from=&to= defaults as the P&L; ?format=csv|xlsx|pdf |`.
    - Add the `balanceSheetClass` field to the accounts create/update docs, with its `422` message.
  - **`schema.md`:** a Phase 47 block for migration `104`.
  - **`accounting.md`:** a "Business snapshot" section with the definitions table from this plan's design doc, and "fixed assets = non-current assets".
  - **`roadmap.md`:**
    - A Phase 47 row in the phase table.
    - A `## Phase 47, as delivered` section after Phase 46, with the totals from Step 16 and **Deliberately not built**:
      - budgets/benchmarks
      - charts in PDF exports
      - DSO/DPO and inventory turnover
      - scheduled/emailed snapshots
      - `balance_sheet_class` in the chart CSV import
      - a current/non-current grouped balance sheet statement
  - **`development.md`:** the client dependency `recharts` (Phase 47, why) and its `react-is` peer.
  - **`CLAUDE.md`:** one `- **Phase 47** — …` bullet after Phase 46, in the same style, with the test totals. Change the state heading to `Phase 47 done`.
- **Proof:** the `docs-sync` skill's own checks pass, and `grep -n "business-snapshot" docs/api.md` and `grep -n "Phase 47" docs/roadmap.md CLAUDE.md` both match.
- **Owes:** nothing

### Step 18 — [Haiku] Close this plan

- **Model:** [Haiku] — a status edit
- **Depends on:** 17
- **Files:** `plans/phase-47-business-snapshot.md` (edit)
- **Contract:** change the top line's `**Status: todo**` to `**Status: done — Phase 47 landed**`, and confirm every manifest row is `done`.
- **Proof:** `grep -c "| todo |" plans/phase-47-business-snapshot.md` prints `0`.

---

## Dispatch manifest

| Batch | Step | Tier | Title | Depends on | Blocks | Status |
|---|---|---|---|---|---|---|
| A | 1 | Sonnet | Migration 104 — `balance_sheet_class` | — | 2,5 | done |
| B | 2 | Haiku | Snapshot + class types | 1 | 3,4,5 | done |
| B | 3 | Haiku | `deriveBalanceSheetClass` + test | 2 | 6 | done |
| C | 4 | Sonnet | `financialRatios` + test | 2 | 6 | done |
| D | 5 | Haiku | Account API `balanceSheetClass` | 1,2 | 6 | done |
| E | 6 | Sonnet | `businessSnapshotService` | 3,4,5 | 7 | done |
| F | 7 | Haiku | Controller, route, export table | 6 | 8 | done |
| G | 8 | Sonnet | Integration tests | 7 | 9 | done |
| H | 9 | Haiku | Deps, polyfill, fetcher, helpers | 8 | 10,12 | done |
| H | 10 | Haiku | Chart components | 9 | 11 | done |
| H | 11 | Haiku | Snapshot page, route, index | 10 | 13,14 | done |
| H | 12 | Haiku | Account form + chart settings select | 9 | 14 | done |
| H | 13 | Haiku | Dashboard health tiles | 11 | 14 | done |
| H | 14 | Haiku | Client tests | 11,12,13 | 15 | done |
| I | 15 | Sonnet | Study notes | 8,14 | 16 | done |
| I | 16 | Sonnet | Guardrail review + full verification | 15 | 17 | done |
| I | 17 | Sonnet | Docs sync | 16 | 18 | done |
| J | 18 | Haiku | Close plan | 17 | — | done |

**Batches:**
- **Sonnet:** Step 1 (A); Step 4 (C); Step 6 (E); Step 8 (G); Steps 15–17 (I).
- **Haiku:** Steps 2–3 (B); Step 5 (D); Step 7 (F); Steps 9–14 (H), the whole client slice; Step 18 (J).
- **Do not batch across:**
  - Step 6 with Step 8: the service and the tests that prove its tie-outs are run by Sonnet in sequence, but the tests must be written against the finished service, not alongside it.
  - Step 1 with anything else: the migration must apply twice before any code reads the column.

**Escalations:** (none yet — record any Haiku → Sonnet re-dispatch here with the step number and the failure.)

## Plan corrections

- **Step 6 (found by Step 8):** `comparisonPeriods(from, to, 'previousPeriod', 1)` returns `count + 1` periods, `[current, prior]`, not `[prior]` as Starting state claims. The contract's `const [prior] = …` computed every prior figure for the current period; two Step 8 cases failed. Fixed in the service to `const [, prior] = …` (`businessSnapshotService.ts:107`), the only non-test change in Step 8.

- **Step 10 (blocked by the Haiku runner, decided by the user 2026-10-17):** `RatioTrendChart` plotted `debtRatioBp` (a `PERCENT` ratio) on a single `TIMES` axis, labelling 43.33% as "0.43×". The contract now gives debt ratio its own right-hand `pct` axis, as `ProfitabilityChart` does.
- **Step 18:** its Proof (`grep -c "| todo |"`) matches its own Proof line, so it can never print 0. Verified instead with a grep anchored to manifest rows: `grep -cE '^\| [A-J] \| [0-9]+ \|.*\| todo \|$'` prints 0.

## Risks & open questions

- **Recharts and React 19.2:** `recharts@3.10.1` declares a peer range of `react ^16.8 … ^19.0` (verified on the registry 2026-10-17). It needs `react-is` as a peer, which is why `react-is@19.2.8` is installed to match `react@19.2.8`. If npm still reports a peer conflict, Step 9 stops.
- **CSS variables in SVG attributes:** `fill="var(--accent)"` relies on presentation attributes accepting `var()`, which current Chrome, Firefox and Safari do. It was not verified in the in-app browser. The Step 15 note must flag this, and the user's manual check (Definition of done) covers it.
- **Query B scale:** the ledger lines are joined 13 times (once per as-at date). This is fine at demo scale. A large org would want a cumulative window sum instead. This goes in the study note as the known trade-off and is not optimised now.
- **Non-default charts:** an org whose fixed assets are not under `1400`, or whose long-term debt is not under `2500`, gets those accounts classed as current until it sets the override. The page footnote says so.
- **Manual-journal refusals:** J1–J5 avoid bank, credit-card, AR, AP and inventory accounts (Phase 44 refusals). 1590 and 2510 are assumed postable by manual journal, since neither is a system role in `config/systemAccounts.ts`. If refused, Step 8 stops.

## Definition of done

- Server tests (including 14 new integration and the unit tests) and client tests are green, with the skipped count unchanged at 2, and `verify:integrity` is clean.
- `guardrail-review` finds zero violations.
- `docs/api.md`, `schema.md`, `accounting.md`, `roadmap.md`, `development.md` and `CLAUDE.md` describe Phase 47 as built.
- Two new study notes and one extended note are filed, with the `study/README.md` index and tracker updated.
- **Manual check (user):** run `npm run seed:demo` and `./dev.sh`, then open `/reports/business-snapshot` in light and dark themes. The totals must match the Balance sheet and P&L pages for the same dates. Download CSV, XLSX and PDF, and confirm the dashboard tiles link through.
- This file's status is `done`.
