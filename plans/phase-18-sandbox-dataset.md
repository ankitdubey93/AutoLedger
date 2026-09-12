# Build plan — Phase 18: the sandbox dataset

**Date:** 2026-09-12
**Status: DONE — 2026-09-12.** All 22 steps executed. Migration, types, fixtures, all 8 seeder files, the orchestrator, the controller/routes, the CLI, and the client card are written and verified end-to-end against a live database. **1394 server tests** (10 new in `sandboxFixtures.test.ts`, 14 new in `sandbox.test.ts` covering cross-tenant isolation, RBAC, the forged-orgId proof, data-realism assertions and the failed-reload regression) **+ 244 client tests** (10 new in `SandboxCard.test.tsx`), all green, zero regressions in either suite. `guardrail-review` found and fixed one finding (a hand-rolled `.toFixed(2)` money format, replaced with the existing `formatCents` helper). Study note written and indexed. `docs/api.md`, `docs/schema.md`, `docs/roadmap.md`, `docs/development.md`, `CLAUDE.md` and `README.md` all updated in the same change.
**Phase:** 18 (platform) · **Strategic plan:** `~/.claude/plans/now-we-have-completed-dynamic-boole.md` · **Roadmap:** [docs/roadmap.md](../docs/roadmap.md) · **Schema:** [docs/schema.md](../docs/schema.md) · **API:** [docs/api.md](../docs/api.md)

> This file is now a historical record, not a live plan. The durable account of what shipped is [roadmap.md § Phase 18, as delivered](../docs/roadmap.md#phase-18-as-delivered). Safe to delete. Do **not** execute it again — migration 047 is applied and checksummed.

A one-click, 24-month demo dataset covering all seven apps, seeded through the real services so every trigger, FSM and audit row fires genuinely.

**Deviations from the plan as written, all discovered by actually running the seeder against a live database rather than by re-reading the plan:**

1. **A real race condition, fixed in production code.** `apFlowDocumentService.createApFlowDocument` unconditionally enqueues the real `ap-flow-extract` job. If a worker is running while seeding, it would race a genuine (and, unconfigured, failing) extraction against the seeder's canned one — two processes writing the same rows with no ordering guarantee. Fixed with a small, backward-compatible `{ skipEnqueue: true }` option, used only by the seeder.
2. **The AP-Flow FSM does not allow `PENDING → EXTRACTED` directly** (only `PROCESSING → EXTRACTED`), so the seeder calls `markProcessing` — the same atomic guard the real handler uses — before `savePipelineResult`.
3. **Three enum/shape mismatches** the plan's contracts got wrong, caught only by `npm run typecheck`: `PaymentDirection` is `'RECEIVE'|'PAY'`, not `'IN'|'OUT'`; `BillStatus` after approval is `'POSTED'`, not `'APPROVED'`; a `DRIVER_PERCENT` forecast line needs a **CENTS** source driver plus its own `percentBps` on the line, not a separate BPS driver.
4. **`resolveMonth`'s `day` parameter (capped 1–28) was misused for due-date arithmetic** (`5 + paysInDays`, which overflows past 28 for any term beyond ~3 weeks). Fixed with a genuine `addDays(dateStr, days)` calendar-arithmetic helper in `sandboxManifest.ts`, used for every due date instead.
5. **`fiscalPeriodService.generatePeriods` creates the WHOLE fiscal year containing a date, not just the month asked for.** Looping it over a 24-month window that spans 3 calendar years therefore also creates OPEN periods for calendar months entirely outside the dataset (e.g. Jan 2024, Dec 2026). The original "close all but the last 4 by array position" logic closed a real data-bearing month and left an empty future one open. Fixed by filtering to the dataset's own date range before deciding what to close; out-of-range periods are simply left untouched at their default `OPEN` status. BoardDeck's seeder was fixed the same way — it must pick its READY/BLOCKED candidates by real calendar month, not by "oldest/newest OPEN in the full list."
6. **The bank-reconciliation design in the plan was backwards.** `bankMatchService`'s own candidate query only ever considers a document with `amount_due_cents > 0` — so building the statement CSV from *payments already created* (as originally planned) leaves nothing left to match against, and the suggester falls back to unrelated same-amount candidates, scoring low across the board. Fixed by restructuring: invoices/bills from the reconciliation window are left **unpaid** by the direct-payment loop; the statement is built from *their* open amounts; and the seeder calls `bankMatchService.matchTransaction` on every line whose top suggestion clears `AUTO_MATCH_THRESHOLD`, creating the payment through the real reconciliation flow rather than in advance of it. This also meant narrowing `bank-import.json`'s window to the current month only (every real payment lands there regardless of which historical document it settles) and date-bounding the "open documents" query — a deliberately-partial older invoice (kept for AR-aging realism) also has `amount_due_cents > 0` and would otherwise leak into the current month's statement.
7. **The client card forced two existing tests to change.** `SandboxCard` reads the session (via `useAuth()`) to decide whether to show its `OWNER`-only actions, and `useAuth` throws outside `AuthProvider` by design. Both `AppChooserPage.test.tsx` and `onboardingState.test.tsx` were rendering `<AppChooserPage />` *bare*, outside the provider the real app always mounts it inside — so both needed wrapping. That was a latent fragility in those tests, not a problem with the card; the alternative (reading the raw context and null-guarding it) would have diverged from the `useAuth()` convention every other role-gated component in the client already follows.
8. **A shared button label needed `within()` in the card's own test.** The trigger and the `ConfirmDialog`'s confirm button both read "Load sample data", so a bare `getByRole('button', { name: … })` matched two elements. Scoping to the dialog is the fix the codebase's own `accessible-dialogs-and-focus.md` study note already prescribes for exactly this.
9. **A marker that lied, found by exercising the live API rather than the tests.** `loadSandbox` claims its `sandbox_datasets` row in its own committed transaction *before* running the seeders — deliberately, so the `UNIQUE (org_id)` constraint is the race guard rather than a check-then-insert. But because seeding is many transactions (rule 5) and not one, a seeder throwing left that claim behind: the marker said `loaded: true` with all-zero counts while the organization actually held a full previous seed, and the client would have faithfully rendered "a dataset is loaded" over a grid of zeros. Found by calling `DELETE /sandbox` then `POST /sandbox/load` against the running server — no unit test would have caught it, because it only appears when a load fails *after* the claim commits. Fixed by wrapping the fan-out in `try/catch` and releasing the claim before rethrowing: the partial business data can't be rolled back, but the marker *asserting a successful load* can and must be withdrawn.
10. **The same path also leaked its internal cause.** That reload surfaced `409 Account code already exists` — `accountService.createAccount` noticing the duplicate `4300`, raised only after `completeOnboarding` had already mutated settings. Fixed with `assertNotAlreadySeeded` at the very top of LedgerCore's own seeder: it checks for the sentinel account and refuses with the real reason ("this organization already contains sample data … load into a fresh organization instead") before anything is written. The check lives in LedgerCore's seeder, not the platform orchestrator, because knowing what a seeded LedgerCore looks like is LedgerCore's business and the orchestrator queries no app's tables (rule 16). Both behaviours are now covered by a named regression test.
11. **BoardDeck's close-readiness `PERIOD_OPEN` check means both demo runs must target OPEN periods** — a closed one fails that check by construction, so "READY" is not "a closed, clean month" but "an open, clean month," and the bank-import window must not overlap it or every open month becomes BLOCKED via unmatched noise lines.

**Verified against a live database, twice, from a clean `DROP SCHEMA`:** `npm run seed:demo` completes; `npm run verify:integrity` passes both before and after; the two BoardDeck close runs land `READY` (July, offset −2) and `BLOCKED` (September, offset 0) exactly as designed; bank reconciliation produces a genuine mixed queue (11 `MATCHED`, 14 `UNMATCHED`); AP-Flow lands one `POSTED` and two `EXTRACTED` documents; TaxGuard lands one honest `PENDING` corpus row; UnitEcon's cohort matrix shows real retention decay (a two-customer cohort drops from 100% to 50% exactly where the churning customer's fixture schedule ends) and PVM shows non-trivial per-line price/volume/mix variance, with `excludedForeignCurrencyInvoices: 2` confirming the honesty valve fires for exactly the two FX customers.

**One cosmetic, non-blocking imperfection recorded rather than fixed under time pressure:** because `generatePeriods` always creates a full fiscal year, the seeded org ends up with ~36 fiscal-period rows instead of the conceptual ~24 — 19 real months `CLOSED`, 1 `LOCKED`, and 16 `OPEN` (4 real + 12 genuinely-empty out-of-range months from adjacent fiscal years). This does not affect any correctness check (`verify:integrity`, close-readiness, aging all read by date range, not period count) and is honest — every extra row is a real, zero-activity period, not fabricated data — but a LedgerCore "Fiscal Periods" screen will look busier than necessary. Worth a follow-up in Phase 20's audit if it reads as clutter in the UI; not fixed here because doing so would mean either teaching `generatePeriods` to create a single month (a production-code change with a bigger blast radius) or deleting the extraneous rows after the fact (which needs its own justification against the same immutability posture governing everything else in this phase).

---

## 1. Starting state (verified against the filesystem, 2026-09-12)

**Exists and may be assumed by every step below:**

- **Migrations `001`–`046` applied.** Latest: `044_taxguard_pgvector.sql`, `045_taxguard_corpus.sql`, `046_taxguard_questions.sql`. **The next free prefix is `047`.**
- All seven apps are `status: 'building'` in `server/src/config/apps.ts`. All seven route trees are mounted in `server/src/routes/index.ts`.
- **No seed/demo/fixture infrastructure of any kind.** `server/package.json` scripts are exactly: `dev, build, start, worker, worker:start, migrate, db:reset, verify:integrity, typecheck, test, test:watch, test:coverage`. There is no root `package.json`. `server/src/scripts/` contains only `verifyIntegrity.ts`.
- The only seeding anywhere is `accountService.seedDefaultChart(q: Queryable, orgId)` (45 accounts, idempotent via `ON CONFLICT DO NOTHING`), called from `authService.register`.
- Platform route/controller/service analogues to copy: `routes/documents.ts`, `controllers/documentController.ts`, `services/documentService.ts`.
- CLI script analogues to copy: `server/src/db/reset.ts` (exported function + `env.isProduction` refusal) and `server/src/scripts/verifyIntegrity.ts` (the CLI tail that runs on import and exits).
- Test helpers: `server/src/__tests__/helpers/factories.ts` → `resetTables()`, `createUserWithOrg()`, `loginAgent()`, `uniqueEmail()`. `resetTables()` TRUNCATEs an explicit table list that **must be extended** by this phase.
- `vitest.config.ts` pins `fileParallelism: false` and the `autodb_test` database. Do not change either.

**Does not exist — this plan creates it:**

- Any `sandbox/` directory, any fixture file, any `seed:demo` script, any `/api/v1/sandbox` route, any `sandbox_datasets` table.

**Verified service contracts this plan calls** (exact, copied from source):

```ts
// services/ledger-core/customerService.ts
createCustomer(orgId, createdBy, input: CreateCustomerInput): Promise<Customer>
  CreateCustomerInput = { name, email, phone, billingAddress, taxNumber, notes }   // all string|null except name

// services/ledger-core/vendorService.ts
createVendor(orgId, createdBy, input: CreateVendorInput): Promise<Vendor>

// services/ledger-core/invoiceService.ts
createInvoice(orgId, createdBy, input: CreateInvoiceInput): Promise<Invoice>
  CreateInvoiceInput = { customerId, issueDate, dueDate, currencyCode?, notes, paymentTerms, lines: InvoiceLineInput[] }
  InvoiceLineInput   = { description, quantityMilli, unitPriceCents, revenueAccountId, taxRateBp }
issueInvoice(orgId, userId, id, entryDate: string | null): Promise<Invoice>

// services/ledger-core/billService.ts
createBill(orgId, createdBy, input: CreateBillInput): Promise<Bill>
submitBill(orgId, id): Promise<Bill>
approveBill(orgId, userId, id, ...): Promise<Bill>

// services/ledger-core/paymentService.ts
createPayment(orgId, createdBy, input: CreatePaymentInput): Promise<Payment>
  CreatePaymentInput = { direction, paymentDate, amountCents, currencyCode?, cashAccountId,
                         customerId, vendorId, method, reference, notes,
                         allocations: AllocationInput[], entryDate }
  AllocationInput    = { invoiceId: string|null, billId: string|null, amountCents: number }

// services/ledger-core/fxRateService.ts
upsertRate(...)                        // see file for exact signature before use
// services/ledger-core/bankImportService.ts
importStatement(orgId, createdBy, input: ImportStatementInput): Promise<ImportStatementResult>
  ImportStatementInput = { accountId, fileName, content, dateFormat, columnMap, closingBalanceCents, closingBalanceOn }
// services/ledger-core/fiscalPeriodService.ts
generatePeriods(...)   closePeriod(...)   // read the file for exact signatures
// services/ledger-core/settingsService.ts
completeOnboarding(orgId, input: OnboardingInput): Promise<LedgerSettings>
  OnboardingInput = { organizationName, legalName, baseCurrency, fiscalYearStartMonth,
                      fiscalYearStartDay, booksStartDate, industry, timezone, cashAccountId }

// services/ap-flow/apFlowDocumentService.ts
savePipelineResult(orgId, id, pages: PipelinePage[], extraction: ExtractionResult, classifications: LineItemClassification[]): Promise<void>
  PipelinePage = { pageNumber, widthPx, heightPx, redactedSha256, ocrText, redactedRegions }   // NOT exported today — Step 12 exports it

// services/forecaster/planService.ts    createPlan(orgId, createdBy, { name, description, startsOn, horizonMonths, actualsThrough })
// services/forecaster/driverService.ts  createDriver(orgId, planId, { name, unitLabel, kind })
// services/fpa-engine/modelService.ts   createModel(orgId, createdBy, { name, description, startsOn, horizonMonths, actualsThrough })
// services/unitecon/productLineService.ts  createProductLine(orgId, ...)
// services/boarddeck/closeRunService.ts    createRun(orgId, userId, fiscalPeriodId)
```

---

## 2. Gate

**Phase 18 is gated on nothing that is unbuilt.** It consumes Phases 3–16, all verified `✅ done` in [docs/roadmap.md](../docs/roadmap.md) and confirmed present on the filesystem in §1. Redis/BullMQ (Phase 7) is present but **this plan enqueues no jobs** — see Step 12 and Step 14 for why AP-Flow and TaxGuard are seeded without the worker.

**No roadmap debt is assigned to Phase 18** — it is a new phase. The 15 skipped study notes from Phases 12–16 are *not* in scope here; they are recorded in the strategic plan as a separate decision.

**Dependency policy:** this phase adds **no npm package**. Fixtures are JSON/CSV read with `node:fs/promises` and validated with `zod` (present since Phase 3). If any step appears to need a new package, that is a stop-and-report (rule 14).

---

## 3. Execution rules

> **If a proof command fails twice on the same step, stop and report. Do not improvise around it.**

| Symptom | Forbidden | Correct |
|---|---|---|
| Migration checksum error | Editing `047_*.sql` after it applied | A new sequential migration `048_` (rule 13) |
| Test fails | Weakening or deleting the assertion | Fix the code; the test is the spec |
| Type error | `as any`, `@ts-ignore`, loosening `tsconfig` | Fix the type |
| Seeder query returns no rows | Dropping the `org_id` predicate | Fix the fixture or the parameters (rule 1) |
| Trial balance does not balance after seeding | An epsilon comparison, rounding, a plug entry | Fix the fixture amounts; integer cents equality (rule 3) |
| Need a helper library | `npm install` anything | Stop and ask (rule 14) |
| "The seeder needs to write another app's table" | A direct `INSERT` from `services/sandbox/` | Call that app's own exported service function (rule 16) |
| Posting into a closed period fails | Reopening the period, or bypassing the guard | Fix the seeding **order** — post first, close last (Step 10) |
| Money in a fixture reads as a JSON number | `Number(...)` on it | Decimal string through `parseMoneyText` (rule 3) |

**Anything this plan did not anticipate is a stop-and-report, not a judgment call.**

---

## Slice A — the fixture format and the platform record

Outcome: fixtures exist on disk, parse under a schema, and a table records what was loaded into which org.

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| Migration | `047_platform_sandbox_datasets.sql` |
| Table | `sandbox_datasets` |
| Columns | `id, org_id, dataset_version, anchor_month, loaded_by, loaded_at, counts, created_at, updated_at` |
| Types file | `server/src/types/sandbox.ts` |
| Types | `SandboxDataset`, `SandboxStatus`, `SandboxCounts`, `SandboxSeedContext` |
| Fixture root | `sandbox/` (repo root, **not** under `server/`) |
| Manifest | `sandbox/manifest.json` |
| Schema file | `server/src/schemas/sandboxSchema.ts` |
| Loader | `server/src/services/sandbox/sandboxManifest.ts` → `loadManifest`, `resolveMonth` |

### Step 1 — migration `047_platform_sandbox_datasets.sql`

- **Depends on:** nothing
- **Skill:** `new-migration`
- **Read first:** `server/src/db/migrations/046_taxguard_questions.sql` (header-comment style, CHECK style) and `027_platform_onboarding_states.sql` (the platform-table shape, audit trigger, `set_updated_at` trigger)
- **Files:** `server/src/db/migrations/047_platform_sandbox_datasets.sql` (new)
- **Contract — write this literally:**
  ```sql
  CREATE TABLE IF NOT EXISTS sandbox_datasets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    dataset_version TEXT NOT NULL CHECK (length(btrim(dataset_version)) > 0
                                         AND length(dataset_version) <= 40),
    anchor_month    DATE NOT NULL,
    counts          JSONB NOT NULL DEFAULT '{}'::jsonb,
    loaded_by       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    loaded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ux_sandbox_datasets_org UNIQUE (org_id),
    CONSTRAINT chk_sandbox_counts_object CHECK (jsonb_typeof(counts) = 'object')
  );

  CREATE INDEX IF NOT EXISTS idx_sandbox_datasets_org ON sandbox_datasets (org_id);

  CREATE OR REPLACE TRIGGER trg_sandbox_datasets_updated_at
    BEFORE UPDATE ON sandbox_datasets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

  CREATE OR REPLACE TRIGGER trg_sandbox_datasets_audit
    AFTER INSERT OR UPDATE OR DELETE ON sandbox_datasets
    FOR EACH ROW EXECUTE FUNCTION audit_row_change('platform');
  ```
  `UNIQUE (org_id)` is the one-dataset-per-org rule enforced by the database, not by a service check — it is what makes a double load impossible rather than merely refused.
- **Guardrails:** #8 every `*_id` has `REFERENCES` + explicit `ON DELETE` · #13 additive and idempotent, `IF NOT EXISTS` throughout
- **Proof:** `cd server && npm run migrate && npm run migrate` — applies once, second run reports 0 applied, no error
- **If it fails:** do **not** edit the file after a successful apply — the runner checksums it. Write `048_` instead.
- **Owes:** `docs/schema.md` section — paid in Step 19

### Step 2 — `types/sandbox.ts`

- **Depends on:** Step 1
- **Skill:** `new-module` (types layer)
- **Read first:** `server/src/types/onboarding.ts` — copy its `as const` + derived-union + type-guard idiom
- **Files:** `server/src/types/sandbox.ts` (new)
- **Contract — write these literally:**
  ```ts
  export interface SandboxCounts {
    customers: number; vendors: number; invoices: number; bills: number;
    payments: number; bankLines: number; apFlowDocuments: number;
    forecastPlans: number; fpaModels: number; productLines: number;
    closeRuns: number; corpusDocuments: number;
  }
  export interface SandboxDataset {
    orgId: string; datasetVersion: string; anchorMonth: string;  // 'YYYY-MM-01'
    counts: SandboxCounts; loadedAt: string;
  }
  export interface SandboxStatus { loaded: boolean; dataset: SandboxDataset | null; }
  /** Passed to every per-app seedSandbox. `userId` is the OWNER doing the load. */
  export interface SandboxSeedContext {
    orgId: string;
    userId: string;
    /** Resolves a fixture `monthOffset` to 'YYYY-MM-DD'. */
    monthDate(offset: number, day: number): string;
    /** 'YYYY-MM-01' for offset 0. */
    anchorMonth: string;
  }
  ```
- **Guardrails:** #3 every money field in these types is `*Cents: number`
- **Proof:** `cd server && npm run typecheck` exits 0
- **If it fails:** fix the type. Never `as any`.
- **Owes:** nothing

### Step 3 — the `sandbox/` fixture folder

- **Depends on:** nothing (can run in parallel with Steps 1–2)
- **Skill:** none — authored data files
- **Read first:** `server/src/services/ledger-core/accountService.ts` lines 342–420 (`DEFAULT_CHART`) to get the exact account **codes** every fixture must reference: `1110` Operating Cash, `1120` AR, `1180` GST/VAT Input Credit, `2100` AP, `2140` GST/VAT Output Payable, `3400` Opening Balance Equity, `4xxx` revenue, `5xxx` cost of sales, `6xxx` opex.
- **Files (all new):**
  ```
  sandbox/README.md
  sandbox/manifest.json
  sandbox/ledger-core/customers.json  vendors.json  invoices.json  bills.json
                     payments.json    fx-rates.json  bank-statement.csv
  sandbox/ap-flow/extractions/*.json           (canned ExtractionResult payloads)
  sandbox/ap-flow/invoices/*.png|pdf           (2–3 small sample images)
  sandbox/forecaster/drivers.json headcount.json forecast-lines.json budget.json
  sandbox/fpa-engine/model.json assumptions.json
  sandbox/unitecon/settings.json product-lines.json
  sandbox/taxguard/sample-act.pdf              (public-domain tax act)
  ```
- **Contract — the two rules that govern every file:**
  1. **Dates are relative.** Every dated row carries `"monthOffset": -23..0` and `"day": 1..28`. **No absolute date appears in any fixture.** Day is capped at 28 so no month is invalid.
  2. **Money is a decimal string.** `"unitPrice": "1450.00"`, never `1450.00` and never `145000`. Parsed at load through `utils/money.ts`'s `parseMoneyText` (rule 3 applies at the file boundary).

  `manifest.json` is exactly:
  ```json
  {
    "datasetVersion": "1.0.0",
    "baseCurrency": "USD",
    "months": 24,
    "description": "A 24-month services business with FX exposure, used to demonstrate all seven AutoLedger apps.",
    "apps": ["ledger-core","ap-flow","forecaster","fpa-engine","unitecon","boarddeck","taxguard"]
  }
  ```
  **Data-realism requirements — the dataset is wrong if any of these fail:**
  - Customers acquired **spread across** offsets −23..−2, not all at −23. Cohort assignment uses a customer's earliest positive-revenue month over *all* history; a customer first billed before the display window is dropped into `excludedPriorCustomers` (`utils/uniteconCohort.ts`).
  - Per-cohort revenue **tapers** month over month, or the retention matrix reads 100% everywhere and proves nothing.
  - Sales are **mostly base currency**. Exactly 3–4 invoices are non-base (EUR/GBP) so the FX engine demos and `pvmService`'s `excludedForeignCurrencyInvoices` shows a non-zero honest count.
  - `bank-statement.csv` is tuned so **some lines score ≥ 85** (`AUTO_MATCH_THRESHOLD` in `utils/matchScore.ts`) and **at least two score below it**, leaving a real approval queue. Amounts and dates must match seeded payments closely but not exactly for the sub-threshold ones.
  - At least one month is left with a **DRAFT invoice and an unmatched bank line** so a BoardDeck close run comes back `BLOCKED`; a different, earlier month is clean so another run comes back `READY`.
  - `fx-rates.json` rates **move** across the 24 months, and at least one foreign-currency invoice is still open at a period end so unrealized revaluation has something to revalue.
  - Budget figures diverge from actuals **in both directions**, with one large driver, or BvA and every BoardDeck section render as zeros.

  `sandbox/README.md` states, per app, what its dataset demonstrates and which screen to look at.
- **Guardrails:** #3 decimal strings only
- **Proof:** `python3 -c "import json,glob,sys; [json.load(open(f)) for f in glob.glob('sandbox/**/*.json', recursive=True)]"` exits 0 (valid JSON). Full schema validation is Step 4's proof.
- **If it fails:** malformed JSON → fix the file. Do not relax the schema in Step 4 to accommodate a bad fixture.
- **Owes:** nothing

### Step 4 — `schemas/sandboxSchema.ts` + `services/sandbox/sandboxManifest.ts`

- **Depends on:** Steps 2, 3
- **Skill:** `new-module` (service layer)
- **Read first:** `server/src/schemas/ledger-core/journalSchema.ts` for the zod idiom; `server/src/utils/money.ts` for `parseMoneyText`
- **Files:** `server/src/schemas/sandboxSchema.ts` (new), `server/src/services/sandbox/sandboxManifest.ts` (new)
- **Contract — write these literally:**
  ```ts
  // sandboxManifest.ts
  export interface SandboxManifest {
    datasetVersion: string; baseCurrency: string; months: number;
    description: string; apps: string[];
  }
  /** Reads sandbox/ from the repo root. Throws ApiError(500,...) if absent or invalid. */
  export async function loadManifest(): Promise<SandboxManifest>;
  /** Reads and zod-parses one fixture file, relative to sandbox/. */
  export async function loadFixture<T>(relativePath: string, schema: ZodType<T>): Promise<T>;
  /** offset -23..0, day 1..28 -> 'YYYY-MM-DD', relative to an anchor 'YYYY-MM-01'. */
  export function resolveMonth(anchorMonth: string, offset: number, day: number): string;
  ```
  The `sandbox/` root resolves as `path.resolve(process.cwd(), '..', 'sandbox')` **only if** `process.cwd()` ends in `server`; otherwise `path.resolve(process.cwd(), 'sandbox')`. Every npm script runs with `cwd = server/`, and the test runner does too — this is the same `cwd`-relative convention `env.STORAGE_ROOT` already uses.
  Every fixture schema converts money with `parseMoneyText` inside a `.transform(...)`, so a fixture value reaches the rest of the codebase already as integer cents.
- **Guardrails:** #3 no float ever touches a money value · #2 this file is a service, not a controller
- **Proof:** `cd server && npm run typecheck` exits 0
- **If it fails:** fix the type or the fixture — never widen a schema to `z.any()`.
- **Owes:** nothing

### Step 5 — fixture-validation unit test

- **Depends on:** Step 4
- **Skill:** `new-module` (tests)
- **Read first:** `server/src/__tests__/mimeSniff.test.ts` for a pure unit test with no database
- **Files:** `server/src/__tests__/platform/sandboxFixtures.test.ts` (new)
- **Contract — these named cases:**
  - `'manifest.json parses and declares all seven app slugs'`
  - `'every ledger-core fixture parses against its schema'`
  - `'every forecaster/fpa-engine/unitecon fixture parses against its schema'`
  - `'no fixture contains an absolute date'` — recursively walk each parsed object, assert no string matches `/^\d{4}-\d{2}-\d{2}$/`
  - `'every money value is a decimal string, never a JSON number'`
  - `'resolveMonth("2026-09-01", -23, 15) === "2024-10-15"'` — hand-computed
  - `'resolveMonth clamps nothing and throws on day > 28'`
- **Guardrails:** none specific — this test touches no database
- **Proof:** `cd server && npm test -- sandboxFixtures` → all cases pass
- **If it fails:** a failing "absolute date" or "decimal string" case means the **fixture** is wrong. Fix the fixture, not the test.
- **Owes:** nothing

---

## Slice B — the per-app seeders

Outcome: each app can populate itself, calling only its own services.

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| Per-app file | `server/src/services/<app-slug>/sandboxSeed.ts` (7 files) |
| Per-app export | `export async function seedSandbox(ctx: SandboxSeedContext): Promise<Partial<SandboxCounts>>` |
| Orchestrator | `server/src/services/sandbox/sandboxService.ts` |
| Orchestrator exports | `loadSandbox`, `unloadSandbox`, `getSandboxStatus` |

**The rule that governs this entire slice (rule 16):** each `sandboxSeed.ts` imports **only** from its own app's service folder plus platform services. `services/ledger-core/sandboxSeed.ts` may import `invoiceService`; it may **not** import anything under `services/forecaster/`. The orchestrator imports the seven `seedSandbox` functions and **contains no SQL at all**.

### Step 6 — `services/ledger-core/sandboxSeed.ts` — settings, customers, vendors

- **Depends on:** Steps 2, 4
- **Skill:** `new-module` (service layer)
- **Read first:** `services/ledger-core/settingsService.ts` (`completeOnboarding`, `OnboardingInput`), `customerService.ts`, `vendorService.ts`
- **Files:** `server/src/services/ledger-core/sandboxSeed.ts` (new)
- **Contract:** export `seedSandbox(ctx)`. In order:
  1. Call `settingsService.completeOnboarding(ctx.orgId, {...})` with `baseCurrency` from the manifest, `fiscalYearStartMonth: 1`, `fiscalYearStartDay: 1`, `booksStartDate: ctx.monthDate(-23, 1)`, `timezone: 'UTC'`, `cashAccountId` resolved from account code `1110`, `industry: 'Services'`, `legalName: null`, `organizationName` unchanged from the org's current name.
  2. `createCustomer` for each row in `customers.json`; keep a `Map<fixtureKey, customerId>`.
  3. `createVendor` for each row in `vendors.json`; keep a `Map<fixtureKey, vendorId>`.
  Resolve account **ids** from account **codes** via `accountService` — fixtures reference codes, never ids, because ids are generated per org.
- **Guardrails:** #1 `ctx.orgId` passed to every service call · #2 no SQL in this file — it calls services only · #16 imports nothing outside `services/ledger-core/` and platform
- **Proof:** `cd server && npm run typecheck` exits 0 · `grep -c "pool.query\|client.query" server/src/services/ledger-core/sandboxSeed.ts` returns `0`
- **If it fails:** if a service lacks a needed function, **stop and report** — do not add SQL to this file.
- **Owes:** nothing

### Step 7 — LedgerCore invoices and bills

- **Depends on:** Step 6
- **Skill:** `new-module` (service layer)
- **Read first:** `invoiceService.ts` (`createInvoice`, `issueInvoice`), `billService.ts` (`createBill`, `submitBill`, `approveBill`)
- **Files:** `server/src/services/ledger-core/sandboxSeed.ts` (edit — extend `seedSandbox`)
- **Contract:** for each invoice fixture row, `createInvoice` then `issueInvoice(orgId, userId, id, entryDate)` **except** the rows flagged `"leaveDraft": true`, which stay DRAFT so a BoardDeck close run can fail its `NO_DRAFT_INVOICES` check. For each bill row: `createBill` → `submitBill` → `approveBill`, except rows flagged `"leaveUnapproved": true`.
  `entryDate` is always the invoice's own issue date. `currencyCode` is omitted for base-currency rows and set explicitly for the 3–4 FX rows.
- **Guardrails:** #1 org scoping · #3 every amount already integer cents from Step 4's transform · #6 no `PUT`/`DELETE` on an issued invoice anywhere in this file
- **Proof:** `cd server && npm run typecheck` exits 0
- **If it fails:** an unbalanced-entry error from the deferred trigger means the **fixture amounts** are wrong (tax + net ≠ total). Fix the fixture; never add a plug line.
- **Owes:** nothing

### Step 8 — LedgerCore payments and FX rates

- **Depends on:** Step 7
- **Skill:** `new-module` (service layer)
- **Read first:** `paymentService.ts` (`createPayment`, `CreatePaymentInput`, `AllocationInput`), `fxRateService.ts` (`upsertRate` — read the exact signature before writing)
- **Files:** `server/src/services/ledger-core/sandboxSeed.ts` (edit)
- **Contract:** seed `fx-rates.json` **before** any FX invoice is issued — `issueInvoice` resolves a rate at the invoice date and fails without one. That makes the real order: settings → customers/vendors → **fx rates** → invoices → bills → payments. Revise Step 7's placement accordingly if it was written otherwise.
  Payments: `createPayment` with `direction: 'IN'` allocated to invoices, `'OUT'` allocated to bills. Leave a deliberate subset of invoices unpaid and one partially paid so AR aging has all buckets populated.
- **Guardrails:** #1 · #3 integer cents · #5 do not open a transaction here — each service owns its own
- **Proof:** `cd server && npm run typecheck` exits 0
- **If it fails:** "no exchange rate" → the rate fixture's date range does not cover the invoice date. Fix the fixture.
- **Owes:** nothing

### Step 9 — LedgerCore bank statement import

- **Depends on:** Step 8
- **Skill:** `new-module` (service layer)
- **Read first:** `bankImportService.ts` (`importStatement`, `ImportStatementInput`)
- **Files:** `server/src/services/ledger-core/sandboxSeed.ts` (edit)
- **Contract:** read `sandbox/ledger-core/bank-statement.csv` as a **string**, rewrite its relative-offset date column to real dates via `ctx.monthDate`, and pass it as `content`. `accountId` is the `1110` account. `dateFormat` matches the CSV. The real 40/30/30 match engine then runs and produces genuine `bank_match_suggestions` — do not fabricate scores.
- **Guardrails:** #1 · #4 parameterized only (inside the service, not here)
- **Proof:** `cd server && npm run typecheck` exits 0
- **If it fails:** a CSV parse error means the fixture's delimiter/quoting is wrong. Fix the CSV.
- **Owes:** nothing

### Step 10 — LedgerCore fiscal periods, closed last

- **Depends on:** Step 9
- **Skill:** `new-module` (service layer)
- **Read first:** `fiscalPeriodService.ts` — `generatePeriods` and `closePeriod` exact signatures; `db/migrations/016_ledger-core_period_posting_guard.sql`
- **Files:** `server/src/services/ledger-core/sandboxSeed.ts` (edit — this must be the **last** block of `seedSandbox`)
- **Contract:** **Order is load-bearing.** Migration 016 refuses any posting into a `CLOSED` or `LOCKED` period, and a date covered by *no* period is open. So: generate periods **after** every invoice, bill and payment above has posted, then close the oldest 20 periods, then `lock` exactly one of them. Leave the most recent 4 periods `OPEN`. The month carrying the DRAFT invoice and the unmatched bank line stays `OPEN` so its close run reports `BLOCKED`.
- **Guardrails:** #1 · #10 status transitions go through the FSM table, never an ad-hoc status write
- **Proof:** `cd server && npm run typecheck` exits 0
- **If it fails:** `P0001` "period is closed" means this block ran too early. Move it, do not reopen the period and do not touch the trigger.
- **Owes:** nothing

### Step 11 — the remaining four analytics seeders

- **Depends on:** Step 10 (they read LedgerCore actuals)
- **Skill:** `new-module` (service layer)
- **Read first:** `services/forecaster/planService.ts`, `driverService.ts`, `headcountService.ts`, `forecastLineService.ts`, `budgetService.ts`; `services/fpa-engine/modelService.ts`, `assumptionService.ts`; `services/unitecon/settingsService.ts`, `productLineService.ts`; `services/boarddeck/closeRunService.ts`
- **Files (all new):**
  - `server/src/services/forecaster/sandboxSeed.ts`
  - `server/src/services/fpa-engine/sandboxSeed.ts`
  - `server/src/services/unitecon/sandboxSeed.ts`
  - `server/src/services/boarddeck/sandboxSeed.ts`
- **Contract:** each exports `seedSandbox(ctx)` and calls only its own app's services.
  - **forecaster** — one plan (`startsOn` = offset −3, `actualsThrough` = offset −4, `horizonMonths` 12), its drivers + monthly values, headcount roles, forecast lines, then one budget version compiled and **approved** (so the freeze trigger is demonstrable).
  - **fpa-engine** — one model with the default Base scenario plus one downside scenario, and per-account assumptions from `assumptions.json`.
  - **unitecon** — settings (`grossMarginBps` 7000, acquisition accounts by code) and product lines mapped to revenue accounts.
  - **boarddeck** — two close runs: one against a clean closed period (expect `READY`), one against the month holding the DRAFT invoice and unmatched bank line (expect `BLOCKED`). **Do not** generate a `.pptx` here — that is a queued job and needs the worker; the UI button demonstrates it live.
- **Guardrails:** #16 — `forecaster/sandboxSeed.ts` must not import from `services/fpa-engine/`, and none of these may import another app's tables
- **Proof:** `cd server && npm run typecheck` exits 0 · for each of the four files, `grep -nE "FROM (accounts|ledger_lines|journal_entries|invoices|bills)" <file>` returns nothing
- **If it fails:** stop and report rather than reaching into another app.
- **Owes:** nothing

### Step 12 — `services/ap-flow/sandboxSeed.ts`

- **Depends on:** Step 10
- **Skill:** `new-module` (service layer)
- **Read first:** `services/ap-flow/apFlowDocumentService.ts` (`createApFlowDocument`, `savePipelineResult`, and the **non-exported** `PipelinePage` at line 637), `services/ap-flow/postingService.ts`, `services/documentService.ts` (`uploadDocument`), `services/storageService.ts`
- **Files:** `server/src/services/ap-flow/sandboxSeed.ts` (new), `server/src/services/ap-flow/apFlowDocumentService.ts` (edit — add `export` to `interface PipelinePage`)
- **Contract:** for each sample invoice image:
  1. `documentService.uploadDocument(orgId, userId, { buffer, originalname })` — real bytes, real SHA-256, real vault row.
  2. `apFlowDocumentService.createApFlowDocument(...)` → a `PENDING` row.
  3. `apFlowDocumentService.savePipelineResult(orgId, id, pages, extraction, classifications)` with `pages` and `extraction` read from `sandbox/ap-flow/extractions/*.json` → the row lands genuinely `EXTRACTED`.
  **Do not enqueue `ap-flow-extract` and do not call `extractionService`.** The pipeline needs OCR, a worker and an API key; this path needs none and produces the same rows, the same FSM transition and the same audit trail.
  Then: post **exactly one** document via `postingService` so the AP-Flow → GL link is visible end to end, and leave **exactly one** in the review queue so the human-in-the-loop screen has content.
  `page.redactedSha256` must reference bytes actually written to storage, or `GET /:id/pages/:n/image` 404s — write the sample image through `storageService.put` and use the returned hash.
- **Guardrails:** #1 · #16 AP-Flow posts through `journalService` via `postingService`, never its own GL SQL · #6 the posted document is immutable afterwards
- **Proof:** `cd server && npm run typecheck` exits 0
- **If it fails:** a CHECK violation on `ap_flow_extractions` means the canned extraction JSON does not match `ExtractionResult`. Fix the fixture.
- **Owes:** nothing

### Step 13 — `services/taxguard/sandboxSeed.ts`

- **Depends on:** Step 4
- **Skill:** `new-module` (service layer)
- **Read first:** `services/taxguard/corpusService.ts`, `db/migrations/045_taxguard_corpus.sql` (the `chk_taxguard_corpus_ready` CHECK)
- **Files:** `server/src/services/taxguard/sandboxSeed.ts` (new)
- **Contract:** upload `sandbox/taxguard/sample-act.pdf` via `documentService.uploadDocument`, then `corpusService.addCorpusDocument(...)` → a `PENDING` row, and **stop there**. Enqueue `taxguard-embed` only when `env` has an embeddings key configured **and** a worker is running — in practice, enqueue it and let it fail harmlessly to the dead-letter queue if unconfigured, or skip the enqueue entirely. **Never write a `READY` row directly**: `chk_taxguard_corpus_ready` requires `ingested_at IS NOT NULL AND chunk_count > 0`, and faking those would be a lie in the demo data. A `PENDING` corpus row with a real PDF behind it is the honest state until Phase 19 lands a working provider.
- **Guardrails:** #1 · #5 the enqueue happens after the insert transaction commits, never inside it
- **Proof:** `cd server && npm run typecheck` exits 0
- **If it fails:** if a `READY` row seems required for the demo, **stop and report** — do not bypass the CHECK.
- **Owes:** nothing

### Step 14 — the orchestrator `services/sandbox/sandboxService.ts`

- **Depends on:** Steps 6–13
- **Skill:** `new-module` (service layer)
- **Read first:** `services/documentService.ts` for the platform-service shape; `services/onboardingService.ts` for the missing-row-is-a-default idiom
- **Files:** `server/src/services/sandbox/sandboxService.ts` (new)
- **Contract — write these literally:**
  ```ts
  export async function getSandboxStatus(orgId: string): Promise<SandboxStatus>;
  export async function loadSandbox(orgId: string, userId: string): Promise<SandboxDataset>;
  export async function unloadSandbox(orgId: string, userId: string): Promise<void>;
  ```
  `loadSandbox` reads the manifest, builds a `SandboxSeedContext` with `anchorMonth` = the first of the current month, then calls the seven `seedSandbox` functions **in this order**: `ledger-core` → `ap-flow` → `forecaster` → `fpa-engine` → `unitecon` → `boarddeck` → `taxguard`. It sums the returned `Partial<SandboxCounts>` and inserts one `sandbox_datasets` row.
  **Seeding is many transactions, not one.** Each service owns its own `BEGIN…COMMIT`; wrapping them would mean those services running off a client they did not check out, which is exactly what rule 5 forbids. Say this in the file header.
  A second load is refused by `ux_sandbox_datasets_org` — catch `23505` and throw `new ApiError(409, 'Sample data is already loaded for this organization')`.
  `unloadSandbox` throws `new ApiError(409, 'No sample data is loaded for this organization')` when no row exists. Otherwise it deletes the `sandbox_datasets` row and **truncates nothing** — see Step 15 for the honest scope of unload.
- **Guardrails:** #1 every query scoped by `org_id` · #2 the only SQL in this file is against `sandbox_datasets`, the platform table it owns · #16 it calls seven exported functions and touches no app table
- **Proof:** `cd server && npm run typecheck` exits 0 · `grep -nE "FROM (invoices|bills|accounts|forecaster_plans|fpa_models)" server/src/services/sandbox/sandboxService.ts` returns nothing
- **If it fails:** stop and report.
- **Owes:** nothing

### Step 15 — decide and document unload's real scope

- **Depends on:** Step 14
- **Skill:** none — a written decision plus a small code change
- **Files:** `server/src/services/sandbox/sandboxService.ts` (edit — header comment + `unloadSandbox` body)
- **Contract:** posted documents are immutable by trigger and **must stay that way**, so unload does **not** unpick the ledger. `unloadSandbox` deletes only the `sandbox_datasets` row and returns; the API documents plainly that removing seeded financial data means deleting the organization. State this in the file header and in `docs/api.md` (Step 19). Do **not** add a `DELETE FROM invoices` path, and do **not** disable the immutability trigger to make one work.
- **Guardrails:** #6 posted documents are immutable — this step exists to stop that rule being quietly broken for convenience
- **Proof:** `grep -n "TRUNCATE\|DELETE FROM invoices\|DELETE FROM journal" server/src/services/sandbox/sandboxService.ts` returns nothing
- **If it fails:** n/a
- **Owes:** `docs/api.md` note — paid in Step 19

---

## Slice C — the surfaces

Outcome: the dataset is loadable from a terminal and from the UI.

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| Controller | `server/src/controllers/sandboxController.ts` → `status`, `load`, `unload` |
| Routes file | `server/src/routes/sandbox.ts` |
| Route base | `/api/v1/sandbox` |
| CLI script | `server/src/scripts/seedDemo.ts` |
| npm script | `"seed:demo": "tsx src/scripts/seedDemo.ts"` |
| Client API fns | `getSandboxStatus`, `loadSandbox`, `unloadSandbox` in `client/src/services/fetchServices.ts` |
| Client component | `client/src/Pages/SandboxCard.tsx` |

### Step 16 — controller, routes, mount

- **Depends on:** Step 14
- **Skill:** `new-module` (controller → routes → mount)
- **Read first:** `controllers/documentController.ts` and `routes/documents.ts` — copy the `requireUser` + envelope idiom and the `authenticate` + `requireRole` ordering exactly
- **Files:** `server/src/controllers/sandboxController.ts` (new), `server/src/routes/sandbox.ts` (new), `server/src/routes/index.ts` (edit — one `apiRouter.use` line)
- **Contract — the exact route table:**

  | Method | Path | Auth | Success | Body |
  |---|---|---|---|---|
  | GET | `/api/v1/sandbox` | any member | `200` | `{ success: true, sandbox: SandboxStatus }` |
  | POST | `/api/v1/sandbox/load` | `OWNER` | `201` | `{ success: true, dataset: SandboxDataset }` |
  | DELETE | `/api/v1/sandbox` | `OWNER` | `200` | `{ success: true }` |

  Failure paths: `409 'Sample data is already loaded for this organization'` on a second load · `409 'No sample data is loaded for this organization'` on unload with nothing loaded · `403` below `OWNER` on either write.
  `OWNER` only, not `OWNER, ADMIN`: loading writes two years of financial documents into the organization's books, which is an owner-level act.
  Mount in `routes/index.ts` **beside the platform routes, above the app routers**, with a comment naming Phase 18:
  ```ts
  // Phase 18 — the sandbox dataset. Platform-level: it orchestrates every
  // app's own seeder and owns no app's tables (guardrails rule 16).
  apiRouter.use('/sandbox', sandboxRoutes);
  ```
- **Guardrails:** #2 zero SQL in the controller · #1 `orgId` from `requireUser(req)` only, never the body
- **Proof:** `cd server && npm run typecheck` exits 0 · `grep -c "query(" server/src/controllers/sandboxController.ts` returns `0`
- **If it fails:** fix the type; never `as any`.
- **Owes:** `docs/api.md` — paid in Step 19

### Step 17 — the CLI `npm run seed:demo`

- **Depends on:** Step 14
- **Skill:** none — a script, mirroring an existing one
- **Read first:** `server/src/db/reset.ts` (the `env.isProduction` refusal) and `server/src/scripts/verifyIntegrity.ts` (the CLI tail: run on import, print, `pool.end()`, `process.exit`)
- **Files:** `server/src/scripts/seedDemo.ts` (new), `server/package.json` (edit — add `"seed:demo": "tsx src/scripts/seedDemo.ts"` next to `verify:integrity`)
- **Contract:** the script refuses under `NODE_ENV=production`, exactly as `resetDatabase` does. It resolves the target organization as: the org named by `process.argv[2]` if given, else the **single** organization in the database; if there are zero or more than one and no argument was given, it prints the list and exits 1 rather than guessing. It then calls `loadSandbox(orgId, ownerUserId)` where `ownerUserId` is that org's `OWNER`, prints the returned counts, and exits 0.
- **Guardrails:** #14 no new package — `tsx` already runs every other script
- **Proof:** `cd server && npm run seed:demo` against a database with one registered org exits 0 and prints non-zero counts; running it a second time exits 1 with the `409` message
- **If it fails:** a `409` on the first run means a `sandbox_datasets` row already exists — that is correct behaviour, reset the database to retest.
- **Owes:** `docs/development.md` scripts table — paid in Step 19

### Step 18 — the client "Load sample data" card

- **Depends on:** Step 16
- **Skill:** none — a client page
- **Read first:** `client/src/Pages/SetupChecklist.tsx` (a card rendered on the chooser, fails silently), `client/src/Pages/AppChooserPage.tsx`, `client/src/components/ConfirmDialog.tsx`, and `client/src/services/fetchServices.ts` around line 2103 for the section-comment + typed-mirror idiom
- **Files:** `client/src/services/fetchServices.ts` (edit — add a `// --- Sandbox (Phase 18) ---` section with the three functions and their mirrored types), `client/src/Pages/SandboxCard.tsx` (new), `client/src/Pages/AppChooserPage.tsx` (edit — render `<SandboxCard />` beside `<SetupChecklist />`)
- **Contract:** the card calls `getSandboxStatus()` on mount using the `ignore`-flag effect idiom (**not** `AbortController` — see `fetchServices.ts:80-89` for why). When nothing is loaded it shows a short explanation of what the dataset contains and a "Load sample data" button behind a `ConfirmDialog` (`tone: 'default'`, body naming the 24-month scope). While loading it shows a busy state — **the request takes many seconds**, so the button must be disabled and labelled, not left to look frozen. On success it reloads status and shows the counts. When loaded it shows the counts, the dataset version, and a "Remove" action behind a `ConfirmDialog` with `tone: 'danger'` whose body states plainly that removing only clears the marker and that seeded financial records stay (Step 15). The card renders **nothing** for a non-`OWNER`.
- **Guardrails:** client money formatting goes through `client/src/utils/money.ts`, never `toFixed` on a raw number
- **Proof:** `cd client && npm run typecheck && npm test` exits 0
- **If it fails:** fix the type; never `as any`.
- **Owes:** nothing

---

## Slice D — tests, review, docs

### Step 19 — integration + isolation tests

- **Depends on:** Steps 16, 17
- **Skill:** `isolation-test`
- **Read first:** `server/src/__tests__/platform/documents.test.ts` (the closest platform integration test, including its three cross-tenant cases), `server/src/__tests__/helpers/factories.ts`
- **Files:** `server/src/__tests__/platform/sandbox.test.ts` (new), `server/src/__tests__/helpers/factories.ts` (edit — add `sandbox_datasets` to the `resetTables()` TRUNCATE list)
- **Contract — these exact named cases:**
  - `'POST /sandbox/load seeds the dataset and returns 201 with counts'`
  - `'the seeded trial balance balances'` — integer equality on total debits vs total credits, **never** an epsilon
  - `'runIntegrityChecks passes after seeding'` — import `db/integrity.ts` directly (not the CLI script, which exits the process)
  - `'a second POST /sandbox/load returns 409'`
  - `'GET /sandbox reports loaded: false before and loaded: true after'`
  - `'POST /sandbox/load as ACCOUNTANT returns 403'`
  - `'POST /sandbox/load as ADMIN returns 403'`
  - `'DELETE /sandbox with nothing loaded returns 409'`
  - **Cross-tenant isolation:** `'org B sees loaded: false after org A loads'` · `'org B sees none of org A customers, invoices or bank lines'` · `'a forged orgId in query, X-Org-Id header and body is ignored'` — assert the response is byte-identical to the honest one, per [docs/testing.md](../docs/testing.md)
  - `'seeded cohorts produce at least three cohort rows with decaying retention'` — the fixture-realism guard; without it a regression in the fixture silently empties the demo
  - `'seeded PVM reports a non-zero excludedForeignCurrencyInvoices'`
  - `'one BoardDeck close run is READY and one is BLOCKED'`
- **Guardrails:** #15 a cross-tenant isolation test is mandatory · assert SQLSTATE not message text for any raw-SQL constraint case
- **Proof:** `cd server && npm test -- sandbox` → all cases pass. Then the full suite: `npm test` → 1370 + new, zero regressions.
- **If it fails:** a failing realism case means the **fixture** is wrong (Step 3), not the test. Fix the fixture.
- **Owes:** nothing

### Step 20 — `guardrail-review` over the full diff

- **Depends on:** Step 19
- **Skill:** `guardrail-review`
- **Files:** the whole diff
- **Contract:** run the skill. Pay particular attention to rule 16 across the eight new `sandboxSeed.ts` / orchestrator files, rule 2 in `sandboxController.ts`, rule 3 across every fixture transform, and rule 6 in `unloadSandbox`.
- **Proof:** the review reports no findings, or every finding is fixed and the review re-run clean
- **If it fails:** fix the code. A finding is not waived by explaining it.
- **Owes:** nothing

### Step 21 — `docs-sync`

- **Depends on:** Step 20
- **Skill:** `docs-sync`
- **Files:** `docs/api.md`, `docs/schema.md`, `docs/roadmap.md`, `docs/development.md`, `CLAUDE.md`, `README.md`
- **Contract:**
  - **`docs/api.md`** — a `### Sandbox — /api/v1/sandbox — Phase 18` section with the Step 16 route table, the two `409` messages, the `OWNER`-only rationale, and the honest statement of what unload does and does not remove.
  - **`docs/schema.md`** — a `## Phase 18 — the sandbox dataset (platform) — applied` section covering `sandbox_datasets` and the `UNIQUE (org_id)` one-dataset rule.
  - **`docs/roadmap.md`** — a phase-table row for 18 and a `## Phase 18, as delivered` section in the established rhythm (what a user can now do · **Landed** · Tests · **Deliberately not built**). The *Deliberately not built* paragraph must record: no per-row unload; no second dataset shape or size option; no `.pptx` generated at seed time; no TaxGuard `READY` corpus without an embeddings provider; no `audit_logs` retention despite the tens of thousands of rows a load writes.
  - **`docs/development.md`** — `npm run seed:demo` in the scripts table, and the `sandbox/` folder in the layout.
  - **`CLAUDE.md`** — one line under the built list. Nothing more; it stays an index.
  - **`README.md`** — **fix the stale status block** while here: it still says "Status — Phase 10 complete" and lists five apps as `'planned'`. That is a lie about the current build and it is cheap to correct in this pass.
- **Proof:** `docs-sync` reports no drift
- **If it fails:** fix the doc, not the skill's expectation.
- **Owes:** nothing

### Step 22 — study note

- **Depends on:** Step 21
- **Skill:** `study-note`
- **Files:** `study/architecture/deterministic-demo-fixtures.md` (new), `study/README.md` (edit — index row + coverage-tracker row)
- **Contract:** the note covers, at mechanism depth: why demo data is replayed through real services rather than `INSERT`ed (triggers, FSMs and the audit trail are the product, and data that bypasses them proves nothing); relative-offset dates vs absolute dates and why absolute ones rot a fixture; decimal-string money at a file boundary as the same parse-don't-validate rule the HTTP boundary uses; why seeding is many transactions rather than one, tied to rule 5; ordering forced by a database guard (the fiscal-period trigger) as an example of schedule being a correctness property; and reaching a mid-pipeline FSM state through an exported persistence seam (`savePipelineResult`) rather than re-running an external-dependency pipeline. Alternatives rejected: SQL dump, factory-only test fixtures, a shared always-on demo tenant. 4–8 interview questions with full written answers.
- **Proof:** the note exists, follows `study/TEMPLATE.md`, and `study/README.md` links it in both the index and the coverage tracker
- **If it fails:** n/a
- **Owes:** nothing — this closes the phase's obligations

---

## 4. Risks & open questions

- **Fixture realism is the real work.** The code in Slice B is mechanical; making 24 months of invoices yield a believable retention curve, a meaningful PVM split and a two-sided budget variance will take iteration. Expect to run Step 19's realism cases, look at the actual screens, and revise `sandbox/` several times. Budget for that rather than treating Step 3 as one-and-done.
- **`fxRateService.upsertRate`'s exact signature was not read during planning** — Step 8 says to read it first. If it turns out not to accept a caller-supplied date, stop and report; do not write `fx_rates` directly.
- **`fiscalPeriodService.generatePeriods` / `closePeriod` signatures were not read** — same instruction in Step 10.
- **Sample-file licensing.** `sandbox/taxguard/sample-act.pdf` and the AP-Flow invoice images must be public-domain or self-generated. Do not commit a copyrighted tax act or a real supplier's invoice. If no suitable public-domain act is at hand, generate a short synthetic one with `Section 1`/`Section 2` headings matching `utils/taxActParse.ts`'s regex — that is honest and it demonstrates the parser.
- **Seed runtime is unknown.** Two years of invoices, bills, payments and a bank import through the real services, each with its own transaction and audit triggers, may take tens of seconds. If the HTTP route times out in practice, the correct fix is to move the load onto the existing BullMQ queue as a job — **that is a scope change, so stop and report** rather than deciding it mid-build.
- **`audit_logs` growth is accepted, not solved.** A load writes tens of thousands of rows and retention is not built. Recorded in Step 21's roadmap entry.

---

## 5. Definition of done

- Migration `047` applies twice cleanly.
- `npm run typecheck` and `npm test` both green, with the new `sandbox.test.ts` cases passing and no regression in the existing 1370.
- `npm run verify:integrity` passes **after** a seed — the seeded ledger balances.
- `npm run seed:demo` populates a fresh org from a terminal; a second run refuses with `409`.
- In the browser: register an org, click "Load sample data", and every app renders non-empty — a balancing trial balance, populated AR/AP aging, a cohort matrix with decay, a PVM split, a budget-vs-actual with two-sided variance, one `READY` and one `BLOCKED` close run, an AP-Flow review queue with one item and one posted document traceable to its source image.
- `guardrail-review` clean; rule 16 confirmed by grep across all eight seeder files.
- `docs-sync` clean; `README.md`'s stale Phase 10 status block corrected.
- `study/architecture/deterministic-demo-fixtures.md` written and indexed.
- This plan file marked `Status: DONE` with any deviations recorded, per the convention the other files in `plans/` follow.
