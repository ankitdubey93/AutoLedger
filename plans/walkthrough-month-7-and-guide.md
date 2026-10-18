# Walkthrough month 7 + the product test guide

Date: 2026-10-17 · **Status: done** · Not a numbered phase (like "Walkthrough months 5–6"). Approved
design: `/home/ankit/.claude/plans/splendid-cuddling-cookie.md`.

The user wants to try everything built so far as a user. Three outcomes:

| Slice | Outcome |
|---|---|
| **1** | The scenario is re-anchored to `2026-03` with I20's due-date bug fixed, and the six existing months still replay cent for cent. |
| **2** | A scored **month 7** (multi-currency, sales tax, manual + repeating journals, FX revaluation, period 6 closed) replays through the real API and equals the answer key, cent for cent. |
| **3** | `npm run walkthrough` writes month 7's narrative, fixes the walkthrough's label drift, and writes a new `walkthrough/guide/` — a module-by-module test guide with "Try to break it" checks — replacing `11-feature-tour.md`. |
| **4** | The guide is proven against the running app (label check + browser smoke on `seed:demo`), docs/CLAUDE.md/study note are updated, guardrails clean. |

**User decisions (fixed — do not reopen):**
1. Both a scored month 7 **and** a detailed test guide covering every other feature.
2. Every guide section ends with **"Try to break it"** checks naming the exact refusal.

**Plan-time decisions (fixed):**
- No migration, no route, no server service/controller change, no new dependency. Only `server/src/scripts/`,
  `server/src/__tests__/accounting/`, the generated `walkthrough/` folder, docs and study notes.
- Re-anchor the committed copy to **`2026-03`** (months 1–7 = March–September 2026; every month-7 date and
  the revaluation reversal on 2026-10-01 are before today, 2026-10-17).
- A foreign-currency receipt is a **manual payment** into a new bank account `1115` — bank statements are
  base-currency only (`bankMatchService` filters candidates on the base currency).
- The guide's prose lives in markdown templates under `server/src/scripts/walkthroughGuide/`; a renderer
  fills `{{…}}` tokens from the dataset and **throws** on an unknown token. `walkthrough/` stays generated
  output — never hand-edited.
- Tax summary is asserted by totals (`output.taxCents`, `input.taxCents`, `netTaxPayableCents`,
  both `differenceCents`), never by row list. Cash flow is asserted every month by `netChangeCents` only;
  month 7 additionally asserts the three section totals.
- No commits. The user decides when to commit.

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

## Starting state (verified 2026-10-17, HEAD `58d7356`, tree clean)

- **Generator** `server/src/scripts/`: `generateWalkthrough.ts` (1403 lines; `main()` ≈ L1363 is a flat list of
  `write(path, content)` calls; `write()` at L54 creates subfolders; renderers `renderReadme` L414 — a
  hand-maintained file list at L424–441, `renderTutorial` L466, `renderDocuments` L159, `renderBankStatements`
  L227, `renderExpectedResults` L312, `renderTheBusiness` L380, `renderSetup` L370, `renderAdjustments` L603,
  `renderProductsAndOrders` L804, `renderClosingTheQuarter` L1043, `renderFeatureTour` L1239; name helpers
  `customerName`, `vendorName`, `accountName` + `DEFAULT_NAMES` L71–100, `datasetDocByRef`).
- `walkthroughDates.ts` — `WalkthroughMonth = 1..6`, `WALKTHROUGH_MONTHS`, `defaultAnchor()` (six months
  back), `resolveDate(anchor, m: WalkthroughMonth | 7, day 1–28)`, `lastDayOfWalkthroughMonth`, `monthName`,
  `calendarYear`, `shiftIsoDate`, `daysBetweenIso`.
- `walkthroughDataset.ts` — `WALKTHROUGH_DATASET` with `extraAccounts, vendors, customers, invoices, bills,
  noise, notes, products, stockItems, orders, journals, bankRules, extraVendors, depositApplications,
  periodCloses`; helpers `resolveTokens` (`{M5}`/`{M6}`/`{Y6}`), `documentLines`, `allVendors`. Every document
  has `dueDays: 0`; I20 alone carries `dueDate: {month: 7, day: 22}`. Customer keys: `brightline-analytics`,
  `kestrel-logistics`, `ferrous-works`, `novato-health`, `orchid-media`, `pinnacle-robotics`.
- `walkthroughExpected.ts` — `computeExpectedResults(anchor): ExpectedMonth[]`; `buildLedgerLines()`
  simulates postings at month granularity (`SimLine.month`) and reports filter `l.month <= month`; the ACC1
  auto-reversal is already emitted with `month: 7`. Its own `documentDueDate` (L272) reads `doc.dueDate`.
- `walkthroughTiers.ts` (`resolveSettlementLines`, `verifyExpectedScores`), `walkthroughStatements.ts`
  (`statement1`–`statement6`), `walkthroughCsv.ts`, `walkthroughParties.ts`.
- `walkthroughReplay.ts` — `createWalkthroughReplay(api: ReplayClient, anchor)`; `ReplayClient` has `get` and
  `post` only; `replayMonth(month)` has scripted branches for 5 and 6; `importStatement` holds a
  `Record<WalkthroughMonth, Body>`; `closePeriods(afterMonth)` generates periods for `dateOf(1,1)` and
  `dateOf(6,1)`; B14's schedule ends month 6 day 1; ACC1 ends month 6 day 28 (`generated === 2`).
- `seedDemo.ts` — fetch client, `DEMO_EMAIL`/`DEMO_PASSWORD` defaults `demo@autoledger.dev` / `autoledger-demo`
  (L33–34), replays `WALKTHROUGH_MONTHS`, then adds current-month open documents.
- `__tests__/accounting/walkthrough.test.ts` (425 lines) — `ANCHOR {2026, 4}` (L39), internal checks (L48–151,
  incl. `toHaveLength(6)` L85, month-4 and month-6 hand figures), statement parse tests, the end-to-end replay
  (`240_000` ms timeout), a cross-tenant case. `replayClient()` adapts supertest (get/post only).
- `walkthrough/` committed at `--anchor 2026-04`, contains `00`–`11` markdown, CSVs, `statements/month-1..6`.
- Baseline tests: **2489 server passing (2 skipped) + 713 client**.
- Real API facts the plan relies on (verified):
  - `POST /api/v1/accounts` body `{code, name, type, parentId, isPostable, description, bankAccountKind: 'BANK'|'CREDIT_CARD'|null, cashFlowCategory, balanceSheetClass}` → `201 {success, account}`.
  - `POST /api/v1/customers` body `{name, email, phone, billingAddress, taxNumber, notes, defaultPaymentTermId}` → `201 {customer}`.
  - `POST /api/v1/fx-rates` `{fromCode:'EUR', toCode:'USD', rateDate, rate:'1.08000000', source:'MANUAL'}` → `201 {rate}`.
  - `POST /api/v1/payments` `{direction:'RECEIVE', paymentDate, amountCents, currencyCode:'EUR', cashAccountId, customerId, vendorId:null, method:null, reference, notes:null, allocations:[{invoiceId, billId:null, amountCents}], entryDate:null}` → `201 {payment}`.
  - `POST /api/v1/fx-revaluations` `{asOfDate}` → `201 {revaluation}` (posts at `asOfDate`, reversal on the next day). `GET /api/v1/reports/fx-exposure?asOf=` → `FxExposureReport` (`documents[]`, `totalDeltaCents`, `alreadyRevalued`).
  - Invoice/bill lines accept `taxRateBp` (0–10000); documents accept `currencyCode`. Tax posts to `2140` (sales) / `1180` (purchases).
  - Manual journals: `POST /api/v1/manual-journals {narration, entryDate, lines:[{accountId, description, debitCents, creditCents}], action:'draft'|'post'}` → `201 {journal}`; `DELETE /:id` → `204`; `POST /:id/void {voidDate}` → `200 {journal}`; `POST /repeating {…, name, frequency, intervalCount, startDate, endDate, autoReverse}` → `201 {journal, schedule}`; repeating journals always post.
  - `GET /api/v1/reports/tax-summary?from&to` → `{success, from, to, output:{rows, netCents, taxCents}, input:{…}, netTaxPayableCents, outputCheck:{differenceCents}, inputCheck:{differenceCents}}`. `GET /api/v1/reports/cash-flow?from&to` → `{success, netIncomeCents, operating:{totalCents}, investing:{totalCents}, financing:{totalCents}, netChangeCents, openingCashCents, closingCashCents, cashAccounts[]}`.
  - Client: `Pages/sales/PaymentDialog.tsx` ("Record a receipt") lets the user choose the cash account; the payment is posted in the document's own currency.
- Playwright 1.63.0 is in the npx cache at `~/.npm/_npx/e41f203b7505f1fb/node_modules` with Chromium cached; `/usr/bin/google-chrome` exists. Nothing is installed into the project.

## Gate

No phase gate: every feature exercised is shipped (Phases 8, 26, 34, 42, 44, 45, 46, 47). Debt carried: none.

## Execution rules

**If a proof command fails twice on the same step, stop and report. Do not improvise around it.**

| Symptom | Forbidden | Correct |
|---|---|---|
| A replay figure disagrees with the answer key | Editing the expected figure to match the API | Find which side is wrong; if the product is wrong, stop and report — this plan changes no service |
| Test fails | Weakening or deleting the assertion | Fix the code; the test is the spec |
| Type error | `as any`, `@ts-ignore`, loosening `tsconfig` | Fix the type |
| Balance assertion fails | An epsilon comparison, floats, rounding | Integer cents equality (rule #3) |
| Need a helper library | `npm install` anything | Stop and ask (rule #14). Playwright runs from the npx cache only |
| A guide label is missing from the client | Inventing a label or editing client code | Rewrite the sentence with the label the JSX actually shows |
| A walkthrough file looks wrong | Hand-editing `walkthrough/` | Change the generator, re-run `npm run walkthrough -- --anchor 2026-03` |
| A `[Haiku]` step's proof fails twice | Retrying in a loop, trimming the step | Escalate the step unchanged to Sonnet with the failure output; note it here |
| The step needs a decision the plan never made | Deciding it | Stop and report — the plan is the defect |

Anything the plan did not anticipate is a stop-and-report, not a judgment call.

**Commands.** Run from `server/`: `npm run typecheck`, `npm run lint`, `npx vitest run <file>`,
`npm test`, `npm run walkthrough -- --anchor 2026-03`. Tests need Postgres + Redis up (`docker compose up -d`
from the repo root).

---

## Slice 1 — re-anchor and the due-date fix

**Names — use exactly these, do not rename:**
| Kind | Name |
|---|---|
| New type | `ScenarioMonth = WalkthroughMonth \| 7 \| 8 \| 9` in `walkthroughDates.ts` |
| New helper | `documentDueDate(anchor: AnchorMonth, doc: DatasetDocument): string` exported from `walkthroughDataset.ts` |
| Removed field | `DatasetDocument.dueDate` |
| Anchor | `2026-03`; test `const ANCHOR: AnchorMonth = { year: 2026, month: 3 };` |

### Step 1 — [Sonnet] Re-anchor to 2026-03 and replace `dueDate` with `dueDays`

- **Model:** [Sonnet] — touches five files whose dates must stay in lock-step with the answer key.
- **Depends on:** —
- **Skill:** none (scripts refactor)
- **Read first:** `walkthroughDates.ts` (whole), `walkthroughDataset.ts` I20 record (≈L470–480),
  `walkthroughExpected.ts` L271–275, `walkthroughReplay.ts` `dueDateOf` (≈L194) and `invoiceFromOrder`.
- **Files:**
  - `server/src/scripts/walkthroughDates.ts` (edit) — add
    `export type ScenarioMonth = WalkthroughMonth | 7 | 8 | 9;` and change the `walkthroughMonth`/`m`
    parameter type of `resolveDate`, `lastDayOfWalkthroughMonth`, `monthName`, `calendarYear` from
    `WalkthroughMonth | 7` to `ScenarioMonth`. `defaultAnchor()`: `- 6` → `- 7`, comment "Seven months back".
    Fix the header example to "month 1 is March 2026 … month 7 is September".
  - `server/src/scripts/walkthroughDataset.ts` (edit) — delete the `dueDate?` field from `DatasetDocument`;
    change its `dueDays` doc comment to "Days after the document date the document falls due (0 = on receipt)."
    I20: remove `dueDate: { month: 7, day: 22 }`, set `dueDays: 30`, comment "Due 30 days after the invoice
    date." Add:
    ```ts
    /** A document's due date: its own date plus `dueDays`, calendar-correct across month ends. */
    export function documentDueDate(anchor: AnchorMonth, doc: DatasetDocument): string {
      return shiftIsoDate(resolveDate(anchor, doc.month, doc.day), doc.dueDays);
    }
    ```
    (import `resolveDate`, `shiftIsoDate` from `./walkthroughDates.js`).
  - `server/src/scripts/walkthroughExpected.ts` (edit) — delete the local `documentDueDate` (L271–275) and import
    the dataset's.
  - `server/src/scripts/walkthroughReplay.ts` (edit) — `dueDateOf(doc, date)` becomes
    `return documentDueDate(anchor, doc);` (keep the signature; `date` unused → remove the parameter and update
    every caller). `invoiceFromOrder`'s due date uses `documentDueDate(anchor, doc)` instead of
    `shiftIsoDate(date, 30)`.
  - `server/src/scripts/generateWalkthrough.ts` (edit) — every place that builds a due date (in
    `renderDocuments`: `resolveDate(…, day + dueDays)` and any `doc.dueDate` read) uses `documentDueDate`.
  - `server/src/scripts/walkthroughCsv.ts` (edit) — any due-date column uses `documentDueDate`.
  - `server/src/__tests__/accounting/walkthrough.test.ts` (edit) — `ANCHOR` → `{ year: 2026, month: 3 }`;
    fix any comment naming 2026-04.
- **Guardrails:** #3 (no float dates/money); dataset amounts unchanged.
- **Proof:** `cd server && npm run typecheck` exits 0; `grep -rn "dueDate?:\|doc.dueDate" src/scripts` prints
  nothing; `npx vitest run src/__tests__/accounting/walkthrough.test.ts` → all cases pass (six months, cent
  for cent, at the new anchor).
- **If it fails:** a figure mismatch here means a date-derived value (aging bucket, settlement day) moved;
  compare `git diff` of dates only. Do not change any amount.
- **Owes:** nothing (docs in Step 13).

---

## Slice 2 — month 7: data, answer key, replay

**Names — use exactly these, do not rename:**
| Kind | Name |
|---|---|
| Month type | `WalkthroughMonth = 1 \| 2 \| 3 \| 4 \| 5 \| 6 \| 7`; `WALKTHROUGH_MONTHS = [1, 2, 3, 4, 5, 6, 7]` |
| New dataset fields | `formAccounts`, `extraCustomers`, `fxRates`, `fxPayments`, `fxRevaluations` |
| New line/doc fields | `DatasetLine.taxRateBp?: number` (absent = 0); `DatasetDocument.currency?: 'EUR'` (absent = USD) |
| Journal entry kinds | `'REPEATING' \| 'IMPORT' \| 'POSTED' \| 'DRAFT_DELETED' \| 'POSTED_VOIDED'`; `DatasetJournal.voidDay?: number`; `repeat.endMonth: ScenarioMonth` |
| Dataset helper | `allCustomers(): DatasetCustomer[]` (customers + extraCustomers) |
| Statement | `statement7(anchor, resolved)` in `walkthroughStatements.ts`, ISO/Northwind format (same as statement 4/5) |
| Expected additions | `ExpectedMonth.taxSummary: { outputTaxCents: number; inputTaxCents: number; netTaxPayableCents: number }`, `ExpectedMonth.cashFlowNetChangeCents: number`, `ExpectedMonth.fxRevaluationDeltaCents: number`, `ExpectedMonth.arControlCents: number` |
| Replay functions | `createFormAccounts(month)`, `createExtraCustomers(month)`, `enterFxRates(month)`, `enterManualJournals(month)`, `recordFxPayment(ref)`, `runRevaluation(month)`, `createRepeatingJournal(ref, opts: { name: string; expectGenerated: number \| 'atLeastOne' })` (replaces `createRepeatingAccrual`) |
| Client verb | `ReplayClient.delete(path: string): Promise<ReplayResponse>` |
| Customer key | `rheinwerk` |

### Step 2 — [Sonnet] Month-7 dataset, statement 7 and tiers

- **Model:** [Sonnet] — money, tax and FX data whose every figure the answer key and scorer depend on.
- **Depends on:** Step 1
- **Read first:** `walkthroughDataset.ts` (whole), `walkthroughStatements.ts` (`statement4`/`statement5`),
  `walkthroughTiers.ts` (`TIER_DATE_SHIFT`, `counterpartyName`).
- **Files:** `walkthroughDates.ts`, `walkthroughDataset.ts`, `walkthroughStatements.ts`, `walkthroughTiers.ts`
  (all edit); plus the two exhaustive `Record<WalkthroughMonth, …>` maps so typecheck stays green:
  `walkthroughReplay.ts` `importStatement` (add `7: { fileName: 'month-7.csv', content: statement7(anchor, resolved), dateFormat: 'ISO', columnMap: null }`)
  and `generateWalkthrough.ts` `STATEMENT_FORMAT` (add 7 with the same Northwind ISO entry as month 4/5).
- **Contract — add literally:**
  - `walkthroughDates.ts`: `WalkthroughMonth` and `WALKTHROUGH_MONTHS` gain 7; `ScenarioMonth` becomes
    `WalkthroughMonth | 8 | 9`.
  - Dataset types:
    ```ts
    export interface DatasetFormAccount { month: WalkthroughMonth; code: string; name: string; type: 'Asset' | 'Expense'; parent: string; bankAccountKind: 'BANK' | null }
    export interface DatasetFxRate { month: WalkthroughMonth; day: number | 'LAST'; fromCode: 'EUR'; toCode: 'USD'; rate: string }
    export interface DatasetFxPayment { ref: string; documentRef: string; month: WalkthroughMonth; day: number; amount: string; currency: 'EUR'; cashAccountCode: string }
    export interface DatasetFxRevaluation { month: WalkthroughMonth }
    ```
    `extraCustomers: (DatasetCustomer & { month: WalkthroughMonth; taxNumber: string })[]`.
  - Records (amounts are native currency; dates are day-of-month 7):
    ```ts
    formAccounts: [
      { month: 7, code: '1115', name: 'EUR Receipts Account', type: 'Asset', parent: '1100', bankAccountKind: 'BANK' },
      { month: 7, code: '6150', name: 'Insurance', type: 'Expense', parent: '6000', bankAccountKind: null },
    ],
    extraCustomers: [{ month: 7, key: 'rheinwerk', name: 'Rheinwerk Maschinenbau GmbH', email: 'ap@rheinwerk.example',
      phone: '+49-211-555-0190', address: 'Königsallee 92, 40212 Düsseldorf, Germany', taxNumber: 'DE-814552907' }],
    fxRates: [
      { month: 7, day: 1, fromCode: 'EUR', toCode: 'USD', rate: '1.08000000' },
      { month: 7, day: 16, fromCode: 'EUR', toCode: 'USD', rate: '1.10000000' },
      { month: 7, day: 'LAST', fromCode: 'EUR', toCode: 'USD', rate: '1.09000000' },
    ],
    fxPayments: [{ ref: 'RC1', documentRef: 'I21', month: 7, day: 17, amount: '10000.00', currency: 'EUR', cashAccountCode: '1115' }],
    fxRevaluations: [{ month: 7 }],
    ```
    Invoices (append, under `// --- Month 7: currency, tax and journals ---`):
    | ref | party | day | dueDays | currency | lines (description · qty × price → account · taxRateBp) | total | tier |
    |---|---|---|---|---|---|---|---|
    | I21 | rheinwerk | 3 | 30 | EUR | "Export — press guard assemblies, run 4" · 1 × 10000.00 → 4100 · 0 | 10000.00 | OPEN |
    | I23 | brightline-analytics | 6 | 0 | — | `SVC-DES` "Design & drafting — guard retrofit" · 20 × 110.00 → 4200 · 750; "Fabricated mounting brackets" · 1 × 4800.00 → 4100 · 750 | 7525.00 | AUTO_0 |
    | I24 | novato-health | 13 | 0 | — | "Fabrication — cart frame retrofit" · 1 × 3600.00 → 4200 · 750 | 3870.00 | REVIEW_LATE |
    | I22 | rheinwerk | 21 | 30 | EUR | "Export — guard panels, run 5" · 1 × 6500.00 → 4100 · 0 | 6500.00 | OPEN |
    (`accountCode`/`lineDescription` = the first line's; `vendorReference: null`, `anonMemo: null`, `remainder: null`.)
    Bills: B19 ironclad-supply day 8 `INV-IC-9702` "Steel plate, 10mm — mill order" 1 × 3200.00 → 5100 · 750,
    total 3440.00, AUTO_1; B20 cloudspan day 10 `CS-46790` "ERP hosting — [Month]" 1 × 3480.00 → 6120 · 0,
    total 3480.00, AUTO_2.
    Noise (month 7): `{7,2,'MONTHLY SERVICE CHARGE','-38.00',RULE 6600}`, `{7,5,'HARBOR MUTUAL INS PREMIUM','-1800.00',POST_JOURNAL 1130}`,
    `{7,20,'TRANSFER TO SAVINGS','-1000.00',IGNORE}`, `{7,28,'INTEREST PAID','19.60',RULE 4300}`.
    Journals (append):
    ```ts
    { ref: 'MJ1', entry: 'POSTED', narration: 'Owner contributes plasma cutter', month: 7, day: 3,
      lines: [{ accountCode: '1500', description: 'Plasma cutter — contributed', debit: '6000.00', credit: '0.00' },
              { accountCode: '3100', description: null, debit: '0.00', credit: '6000.00' }], repeat: null },
    { ref: 'MJ2', entry: 'DRAFT_DELETED', narration: 'Plasma cutter contribution (duplicate)', month: 7, day: 10,
      lines: /* same two lines as MJ1 */, repeat: null },
    { ref: 'MJ3', entry: 'POSTED_VOIDED', narration: 'Bonus accrual — posted in error', month: 7, day: 15, voidDay: 18,
      lines: [{ accountCode: '6100', description: null, debit: '1200.00', credit: '0.00' },
              { accountCode: '2120', description: null, debit: '0.00', credit: '1200.00' }], repeat: null },
    { ref: 'INS1', entry: 'REPEATING', narration: 'Insurance amortisation — [Month]', month: 7, day: 28,
      lines: [{ accountCode: '6150', description: null, debit: '600.00', credit: '0.00' },
              { accountCode: '1130', description: null, debit: '0.00', credit: '600.00' }],
      repeat: { endMonth: 9, endDay: 28, autoReverse: false } },
    ```
    `periodCloses` gains `{ afterMonth: 7, closeMonths: [6] }`.
  - `documentLines()` passes `taxRateBp` through (synthesised single line: `taxRateBp: 0`). `resolveTokens`
    also replaces `{M7}`. Rewrite the header comment's "Every document is tax-exempt…" paragraph to: months 1–6
    are tax-exempt; month 7 introduces 7.5% sales tax on some lines and EUR documents. Same change to
    `businessDescription`'s last sentence: "Months 1–6 are tax-exempt so the answer key is checkable by hand;
    month 7 adds 7.5% sales tax and a euro customer."
  - `walkthroughTiers.ts`: `counterpartyName` uses `allCustomers()`; doc comment of `OPEN` → "no bank line
    (unpaid, or settled outside the bank statement)". Tiers skip `currency` documents (they are all `OPEN`).
  - `walkthroughStatements.ts`: `export function statement7(anchor, resolved): string` — the same body shape as
    `statement5` with month 7. Fix the header comment "three" → "seven".
- **Guardrails:** #3 money is decimal strings parsed by `parseMoneyText`; no floats.
- **Proof:** `npm run typecheck` exits 0; `npx vitest run src/__tests__/accounting/walkthrough.test.ts -t "tier score"`
  passes (`verifyExpectedScores(ANCHOR)` → `[]`, now including I23 100, B19 92, B20 85, I24 77).
- **If it fails:** a tier score off by a few points means a memo/date shift differs — fix the dataset's day,
  never the tier table.
- **Owes:** nothing.

### Step 3 — [Sonnet] Answer key for month 7, plus internal tests

- **Model:** [Sonnet] — tax rounding, FX conversion, gain/loss and revaluation arithmetic.
- **Depends on:** Step 2
- **Read first:** `walkthroughExpected.ts` (whole); `server/src/utils/fxRate.ts` (`convertToBase`, `ONE_RATE`);
  `server/src/utils/money.ts` (`scaleCents`); `services/accounting/paymentService.ts` L600–670 (gain/loss plug).
- **Files:** `server/src/scripts/walkthroughExpected.ts` (edit); `server/src/__tests__/accounting/walkthrough.test.ts`
  (edit — the `walkthrough dataset — internal checks` describe only).
- **Contract:**
  - `SimLine.month: ScenarioMonth`.
  - Account classification: replace any hard-coded P&L / balance-sheet code lists with the code-prefix rule
    `1→Asset, 2→Liability, 3→Equity, 4→Revenue, 5→cost of sales (Expense), 6→operating Expense`. Add names to the
    account-name map: `1115 EUR Receipts Account`, `1130 Prepaid Expenses`, `1180 GST/VAT Input Credit`,
    `1500 Fixed Assets / Equipment`, `2140 GST/VAT Output Payable`, `4910 Realized FX Gain`, `6150 Insurance`,
    `6820 Unrealized FX Gain/Loss` (read the real `4910` name from `db/migrations` with
    `grep -rn "'4910'" src/db/migrations` and use it verbatim).
  - `rateOn(date: string): string` — the latest `fxRates` entry with `resolved date <= date` (`'LAST'` →
    `lastDayOfWalkthroughMonth`); throws if none.
  - Invoice posting: per line `netCents = lineCents(qty, price)`, `taxCents = scaleCents(netCents, taxRateBp, 10_000)`
    (half-up, per line — exactly as `computeLineTotals`). Base currency: lines as today plus `CR 2140 Σtax`;
    `DR 1120 Σ(net+tax)`. EUR document: every amount `convertToBase(cents, rateOn(docDate))`.
  - Bill posting: `DR expense net`, `DR 1180 Σtax`, `CR 2100 Σ(net+tax)`.
  - `fxPayments`: `DR cashAccountCode convertToBase(amount, rateOn(paymentDate))`,
    `CR 1120 convertToBase(amount, rateOn(docDate))`, difference → `CR 4910` if positive, `DR 6810` if negative.
  - `fxRevaluations` at month m: for each EUR invoice open at `lastDay(m)` (total − fxPayments allocated through
    m): `delta = convertToBase(outstanding, rateOn(lastDay)) − convertToBase(outstanding, rateOn(docDate))`;
    `delta < 0` → `DR 6820 |delta| / CR 1120 |delta|`, `delta > 0` → mirror; reversal lines at `month: m + 1`.
    `fxRevaluationDeltaCents` = Σdelta for that month, else 0.
  - Journals: `POSTED` → lines once; `DRAFT_DELETED` → nothing; `POSTED_VOIDED` → lines plus their mirror, both in
    `journal.month`; `REPEATING` → unchanged loop (months beyond 7 are filtered by reports already).
  - `outstandingCents(ref)` subtracts `fxPayments` allocations (native) for EUR documents; aging uses the
    document-rate base amount (`agingService` reads `base_total_cents`).
  - `taxSummary` per month = Σ output tax of invoices dated in that month / Σ input tax of bills dated in that
    month; `netTaxPayableCents = output − input`.
  - `cashFlowNetChangeCents` per month = (Δ balance of 1110 + Δ balance of 1115) within that month.
  - `arControlCents` = 1120 balance at `asOf`.
  - After building lines, assert every simulated entry balances (group by the entry they came from; throw
    `walkthrough answer key: entry <label> does not balance`).
- **Tests to add/change (internal checks describe):**
  - L85 `toHaveLength(6)` → `toHaveLength(WALKTHROUGH_MONTHS.length)` (import it).
  - `"every multi-line document's lines sum to its total"` — sum includes per-line tax.
  - `"every vendor and every customer is used…"` iterates `allCustomers()`.
  - New `it("month 7 (currency, tax and journals) matches the plan's hand-checked figures")` asserting from
    `computeExpectedResults(ANCHOR).find(m => m.month === 7)`:
    net income for month 7 alone `2_223_660` (P&L cumulative month 7 minus month 6);
    balances `1115: 1_100_000`, `1120: 1_185_500`, `1130: 120_000`, `1180: 24_000`, `1500: 600_000`,
    `2120: 0`, `2140: 79_500`, `3100: 8_100_000`, `4910 credit: 20_000`, `6820 debit: 6_500`;
    AR aging `CURRENT 715_000`, `D1_30 477_000`; `arControlCents 1_185_500`;
    `taxSummary {outputTaxCents: 79_500, inputTaxCents: 24_000, netTaxPayableCents: 55_500}`;
    `cashFlowNetChangeCents 1_365_660`; `fxRevaluationDeltaCents -6_500`;
    bank reconciliation `ignoredCount 7`.
  - New `it('dates of fx rates and the fx receipt are inside month 7')` (days 1–28 or 'LAST').
- **Guardrails:** #3 integer cents only; use `scaleCents`/`convertToBase`, never `*` on rate strings.
- **Proof:** `npx vitest run src/__tests__/accounting/walkthrough.test.ts -t "internal checks"` passes.
- **If it fails:** recompute the failing hand figure from the dataset by hand first; the hand figures above were
  checked twice (bank movements: −38 −1,800 +7,525 −3,440 −3,480 +3,870 +19.60 = +2,656.60). Report a mismatch
  rather than changing a figure.
- **Owes:** nothing.

### Step 4 — [Sonnet] Replay month 7 through the API and assert it end to end

- **Model:** [Sonnet] — integration test against real PostgreSQL; posting order matters.
- **Depends on:** Step 3
- **Read first:** `walkthroughReplay.ts` (whole); `walkthrough.test.ts` L236–380; `seedDemo.ts` L1–100.
- **Files:** `server/src/scripts/walkthroughReplay.ts` (edit), `server/src/__tests__/accounting/walkthrough.test.ts`
  (edit), `server/src/scripts/seedDemo.ts` (edit).
- **Contract:**
  - `ReplayClient` gains `delete(path: string): Promise<ReplayResponse>`; test `replayClient()` adds
    `delete: async (path) => await a.delete(path)`; `seedDemo.ts`'s fetch client adds a `delete` using
    `method: 'DELETE'` (same headers/cookie jar as `post`).
  - `createFormAccounts(month)` → `POST /api/v1/accounts {code, name, type, parentId: await accountId(parent), isPostable: true, description: null, bankAccountKind, cashFlowCategory: null, balanceSheetClass: null}` → 201; then `accountIdByCode.clear()`.
  - `createExtraCustomers(month)` → `POST /api/v1/customers {name, email, phone, billingAddress: address, taxNumber, notes: null, defaultPaymentTermId: null}` → 201; store id in `customerIdByKey`.
  - `enterFxRates(month)` → `POST /api/v1/fx-rates` per rate → 201.
  - `enterInvoice`/`enterBill` send `currencyCode: doc.currency` when set and `taxRateBp: line.taxRateBp ?? 0`;
    after issue/approve assert `totalCents === parseMoneyText(doc.total)` (native).
  - `enterManualJournals(month)`: `POSTED` → `POST /manual-journals {…, action:'post'}` 201; `DRAFT_DELETED` →
    create with `action:'draft'` 201 then `DELETE /manual-journals/:id` 204; `POSTED_VOIDED` → post 201 then
    `POST /manual-journals/:id/void {voidDate: dateOf(month, voidDay)}` 200.
  - `recordFxPayment('RC1')` → `POST /api/v1/payments` per the Starting-state shape, `amountCents 1_000_000`,
    `reference: 'RC1'`, allocation `{invoiceId: documentId('I21'), billId: null, amountCents: 1_000_000}` → 201.
  - `createRepeatingJournal(ref, {name, expectGenerated})`: the body of today's `createRepeatingAccrual`; ACC1
    calls it with `{name: 'Utilities accrual', expectGenerated: 2}`, INS1 with
    `{name: 'Insurance amortisation', expectGenerated: 'atLeastOne'}` (assert `generated >= 1`).
  - `runRevaluation(7)` → `POST /api/v1/fx-revaluations {asOfDate: lastDayOfWalkthroughMonth(anchor, 7)}` → 201;
    assert `revaluation.totalDeltaCents === -6500` and `revaluation.lineCount === 1`.
  - `closePeriods`: generate for `dateOf(1,1)`, `dateOf(6,1)` and `dateOf(7,1)`.
  - `replayMonth(7)` order, exactly: `createFormAccounts(7)`, `createExtraCustomers(7)`, `enterFxRates(7)`,
    `enterManualJournals(7)`, `enterInvoice(I21)`, `enterInvoice(I23)`, `enterInvoice(I24)`, `enterInvoice(I22)`,
    `recordFxPayment('RC1')`, `enterBill(B19)`, `enterBill(B20)`, `importStatement(7)`, `resolveMonth(7)`,
    `createRepeatingJournal('INS1', …)`, `runRevaluation(7)`, `closePeriods(7)`.
  - Export the new functions in the returned object.
  - Test end-to-end case: rename to `'reproduces the computed answer key for all seven months, cent for cent'`,
    timeout `300_000`. Inside the month loop add, every month:
    - `GET ${REPORTS}/tax-summary?from=<month first day>&to=<asOf>` → 200; `output.taxCents`, `input.taxCents`,
      `netTaxPayableCents` equal `monthExpected.taxSummary`; `outputCheck.differenceCents === 0`,
      `inputCheck.differenceCents === 0`.
    - `GET ${REPORTS}/cash-flow?from=…&to=…` → 200; `netChangeCents === monthExpected.cashFlowNetChangeCents`.
    - AR aging `controlAccount` balance equals `monthExpected.arControlCents` (read the aging response key from
      the existing aging assertion block).
    - `if (month === 7)`: cash flow `operating.totalCents === 1_365_660`, `investing.totalCents === -600_000`,
      `financing.totalCents === 600_000`; `GET ${REPORTS}/fx-exposure?asOf=<lastDay 7>` → `alreadyRevalued === true`;
      `GET /api/v1/manual-journals?status=voided` → exactly one journal (MJ3's narration);
      `GET /api/v1/manual-journals?status=draft` → none with MJ2's narration;
      a late `POST /manual-journals` dated `resolveDate(ANCHOR, 6, 15)` with `action:'post'` → `422`.
  - `seedDemo.ts`: log `month ${m} of ${WALKTHROUGH_MONTHS.length}`; docstring "replays seven months; month 7
    is last month".
- **Guardrails:** #1 never send `orgId` in a body; #5 n/a (HTTP only).
- **Proof:** `npx vitest run src/__tests__/accounting/walkthrough.test.ts` → every case passes, including the
  seven-month replay and the cross-tenant case.
- **If it fails:** a `walkthrough: … failed <status>` error names the call — fix the request shape against the
  Starting-state API facts. A report figure mismatch → stop and report which side is wrong (Execution rules).
- **Owes:** nothing.

---

## Slice 3 — the generated walkthrough and the guide

**Names — use exactly these, do not rename:**
| Kind | Name |
|---|---|
| Month-7 narrative | `walkthrough/11-currency-tax-and-journals.md` from `renderCurrencyTaxAndJournals(anchor, expected)` |
| Statement file | `walkthrough/statements/month-7-northwind-ISO.csv` |
| Shared names module | `server/src/scripts/walkthroughNames.ts` exporting `DEFAULT_ACCOUNT_NAMES`, `accountName(code)`, `customerName(key)`, `vendorName(key)`, `DEMO_DEFAULT_EMAIL = 'demo@autoledger.dev'`, `DEMO_DEFAULT_PASSWORD = 'autoledger-demo'` |
| Guide renderer | `server/src/scripts/walkthroughGuide.ts` exporting `renderGuide(anchor: AnchorMonth): { path: string; content: string }[]` and `fillGuideTokens(anchor, fileName, text): string` |
| Guide templates | `server/src/scripts/walkthroughGuide/*.md` (names below) → `walkthrough/guide/<same name>` |
| Guide test | `server/src/__tests__/accounting/walkthroughGuide.test.ts` |
| Removed | `walkthrough/11-feature-tour.md`, `renderFeatureTour()` |

**Guide tokens (the complete set — anything else throws):**
| Token | Output |
|---|---|
| `{{customer:<key>}}` | customer name from `allCustomers()` |
| `{{vendor:<key>}}` | vendor name from `allVendors()` |
| `{{doc:<ref>}}` | `<ref> (<party name>)` for any invoice/bill ref |
| `{{account:<code>}}` | `` `<code> <name>` `` via `accountName` |
| `{{date:<month>:<day>}}` | `resolveDate(anchor, month, day)` |
| `{{month:<m>}}` | `monthName(anchor, m)` |
| `{{demo.email}}` / `{{demo.password}}` | the two `DEMO_DEFAULT_*` constants |

Unknown token → `throw new Error(\`walkthrough guide: unknown token ${token} in ${fileName}\`)`. Any `{{` left after
filling → `throw new Error(\`walkthrough guide: unfilled braces in ${fileName}\`)`.

**Guide section format (every section of every guide file, verbatim headings):**
```
## N. <Feature>

**Where:** **<Sidebar group>** → **<Page>** (`/route`)   ← or the Settings card path, each segment bold
**Needs:** <only for optional external services: exact env vars / commands>

**Do this:**
1. … exact UI labels in **bold**, one action per step

**You should see:** … concrete results; figures in `backticks`, never bold

**Try to break it:**
- <action> → <exact refusal or behaviour, quoting the message when the UI shows one>

- [ ] Done
```
Bold is reserved for UI labels and the five field names. Every route in `(`/route`)` must exist in
`client/src/routes/ProductRoutes.tsx` or `client/src/App.tsx`. Actions that would change the demo's answer key
are prefixed **⚠ scratch org** and must be done in a second organization (Org menu → **Add organization**).

### Step 5 — [Sonnet] Generator: month 7, label drift, new columns

- **Model:** [Sonnet] — prose that must agree with the answer key and the real UI labels.
- **Depends on:** Step 4
- **Read first:** `generateWalkthrough.ts` renderers named in Starting state; `client/src/components/layout/nav.ts`;
  `client/src/Pages/purchases/BillDetailPage.tsx` (button "Submit for review"); `client/src/Pages/sales/PaymentDialog.tsx`.
- **Files:** `server/src/scripts/walkthroughNames.ts` (new), `server/src/scripts/generateWalkthrough.ts` (edit),
  `server/src/scripts/seedDemo.ts` (edit — import `DEMO_DEFAULT_*`).
- **Contract:**
  - Move `DEFAULT_NAMES` (rename `DEFAULT_ACCOUNT_NAMES`), `accountName`, `customerName` (over `allCustomers()`),
    `vendorName` into `walkthroughNames.ts`; add the eight month-7 account names from Step 3. `generateWalkthrough.ts`
    imports them.
  - Label drift, everywhere in the generator: `Submit for approval` → `Submit for review`;
    `Reports → Bank reconciliation` → `Banking → Reconciliation`; `Reports → AR aging` → `Reports → Aged receivables`;
    `AP aging` → `Aged payables`. Then
    `grep -on "\*\*[A-Z][^*]*\*\* →[^.]*" src/scripts/generateWalkthrough.ts` and check every nav path printed
    against `nav.ts` / `SettingsHubPage.tsx`; correct any that do not exist.
  - `renderDocuments`: add columns `Net`, `Tax`, `Total` and a `Currency` row; EUR documents show
    `EUR 10,000.00 (USD 10,800.00 at 1.08)`; due date from `documentDueDate`.
  - `renderBankStatements`: intro "Seven months, three banks"; a Statement 7 section (Northwind ISO, same
    instructions as month 5, the insurance line → **Post journal** to `1130 Prepaid Expenses`).
  - `renderExpectedResults`: for each month add "Tax summary" (output, input, net payable) and "Cash flow — net
    change"; month 7 adds "Currency" (realized gain `200.00`, revaluation `−65.00`, I22 carried `7,150.00` →
    `7,085.00`) and the note: "Aged receivables totals `11,920.00` while 1120 is `11,855.00`: aging values open
    invoices at their own frozen rate; the `65.00` gap is the month-end revaluation, which reverses on
    {first day of month 8}. This is expected."
  - `renderTheBusiness`: "seven consecutive months"; scope adds currency, tax and journals; accounts table adds
    1115, 1130, 1180, 1500, 2140, 4910, 6150, 6820.
  - `renderTutorial`: a Month 7 block in the same shape as months 5/6, pointing to `11-currency-tax-and-journals.md`,
    with these hints verbatim in meaning: (a) enter the exchange rates **before** the EUR invoices — an invoice dated
    before any rate is refused with "No exchange rate for EUR to USD on or before <date>"; (b) a euro receipt never
    appears as a bank-line suggestion — record it from the invoice with **Record payment** into `1115`;
    (c) **Post revaluation** only once, at month end; (d) **Delete** removes a draft, **Void** reverses a posted
    journal — the void appears on both sides of the trial balance. Step 1 mentions the 13th customer, added by
    form in month 7. Closing section: "Seven months…" and points to `guide/README.md` instead of the feature tour.
  - `renderProductsAndOrders` / `renderClosingTheQuarter`: state that ACC1's last reversal lands on month 7 day 1,
    so 2120 is `850.00` at month 6 and `0.00` after it.
  - `renderReadme`: "seven-month"; list `11-currency-tax-and-journals.md`, `statements/` "seven CSV files", and
    `guide/` ("the module-by-module test guide — start at `guide/README.md`"); drop `11-feature-tour.md`.
  - New `renderCurrencyTaxAndJournals(anchor, expected)` → `11-currency-tax-and-journals.md`, sections in order:
    1 Two new accounts (by form: **Accounting** → **Chart of accounts**, 1115 with **Bank account** ticked, 6150);
    2 A euro customer (**Sales** → **Customers** → **New customer**); 3 Exchange rates (**Accounting** →
    **Exchange rates** → **New rate**, the three rates); 4 Manual journals (MJ1 **Post**; MJ2 **Save draft** then
    **Delete**; MJ3 **Post** then **Void** with void date); 5 Invoices I21/I23/I24/I22 (the **Tax %** column, the
    currency select); 6 The euro receipt RC1 (**Record payment**, cash account 1115, the realized gain); 7 Bills
    B19/B20; 8 Statement 7; 9 The repeating insurance journal (**New repeating journal**, **Run now** on the
    schedule); 10 Month-end revaluation (**Accounting** → **FX exposure** → **Post revaluation**); 11 Close
    period 6; 12 Checkpoints — the Step 3 hand figures, the tax summary (**Reports** → **Tax summary**), cash flow
    (**Reports** → **Cash flow statement**) and the aging-vs-GL note. Each section uses a posting table built with
    the existing `postingTable` helper.
  - `main()`: write statement 7 and `11-currency-tax-and-journals.md`; stop writing `11-feature-tour.md`; delete
    `renderFeatureTour`; final log line names the last day of month 7.
- **Guardrails:** none server-side (scripts only).
- **Proof:** `cd server && npm run typecheck && npm run walkthrough -- --anchor 2026-03` succeeds;
  `rm ../walkthrough/11-feature-tour.md`;
  `grep -rn "Submit for approval\|Reports → Bank reconciliation\|AR aging" ../walkthrough` prints nothing;
  `ls ../walkthrough/statements | wc -l` = `7`; running the generator a second time leaves `git status --short ../walkthrough` unchanged from after the first run.
- **If it fails:** a renderer throwing on month 7 means a missing lookup entry — add it to `walkthroughNames.ts`.
- **Owes:** nothing.

### Step 6 — [Sonnet] Guide renderer, wiring and its test

- **Model:** [Sonnet] — a new mechanism (validated tokens) with a test that defines it.
- **Depends on:** Step 5
- **Read first:** `walkthroughNames.ts`; `generateWalkthrough.ts` `main()` and `write()`.
- **Files:** `server/src/scripts/walkthroughGuide.ts` (new), `server/src/scripts/walkthroughGuide/README.md` (new,
  a placeholder template containing `# AutoLedger test guide` and one token `{{demo.email}}` — replaced in Step 7),
  `server/src/scripts/generateWalkthrough.ts` (edit `main()`), `server/src/__tests__/accounting/walkthroughGuide.test.ts` (new).
- **Contract:**
  ```ts
  export function fillGuideTokens(anchor: AnchorMonth, fileName: string, text: string): string;
  export function renderGuide(anchor: AnchorMonth): { path: string; content: string }[];
  ```
  `renderGuide` reads every `*.md` in `new URL('./walkthroughGuide/', import.meta.url)` with `readdirSync` +
  `readFileSync(…, 'utf8')`, sorted by file name, and returns `{ path: \`guide/${name}\`, content: fillGuideTokens(…) }`.
  Token regex: `/\{\{([a-z.]+)(?::([^}:]+))?(?::([^}]+))?\}\}/g`. `main()` loops `renderGuide(anchor)` → `write(path, content)`.
- **Tests (`walkthroughGuide.test.ts`, no database):**
  - `'fills every token kind'` — `{{customer:kestrel-logistics}}` → `Kestrel Logistics`; `{{doc:I16}}` →
    `I16 (Ferrous Works Ltd)`; `{{account:1110}}` → `` `1110 Operating Cash` ``; `{{date:7:20}}` with
    `{2026,3}` → `2026-09-20`; `{{month:7}}` → `September`; `{{demo.email}}` → `demo@autoledger.dev`.
  - `'throws on an unknown token'` — `{{nope:1}}` → error containing `unknown token`.
  - `'throws on an unknown customer key'` — `{{customer:nobody}}` → throws.
  - `'renders every committed template with no braces left'` — `renderGuide({2026,3})` returns ≥ 1 file and no
    content contains `{{`.
  - `'every guide file is listed in the guide README'` — every returned path except `guide/README.md` appears
    (as its file name) in the README's content.
- **Proof:** `npx vitest run src/__tests__/accounting/walkthroughGuide.test.ts` passes; `npm run walkthrough -- --anchor 2026-03`
  writes `../walkthrough/guide/README.md`.
- **Owes:** study note (Step 15).

### Steps 7–10 — [Sonnet] Guide templates

Each step writes the listed templates in the **Guide section format**, then regenerates. Content per file is fixed
by this table; every bold label must be copied from the JSX of the page named (open it — do not trust this table
for exact wording). "Break" items are the minimum "Try to break it" checks.

| Step | Template | Sections (in order) — **bold** = must be covered |
|---|---|---|
| 7 | `README.md` | How to use the guide: start the stack (`./dev.sh`); `cd server && npm run db:reset && npm run seed:demo`; sign in `{{demo.email}}` / `{{demo.password}}` or **Explore the demo company**; make a scratch org for ⚠ steps; optional-services table (Mailpit: `docker compose --profile mail up -d mailpit` + `MAIL_TRANSPORT=mailpit`, restart server **and** worker, inbox `http://localhost:8025`; Stripe test keys `STRIPE_SECRET_KEY`/`STRIPE_PUBLISHABLE_KEY`/`STRIPE_WEBHOOK_SECRET`; vision key `ANTHROPIC_API_KEY` or `CAPTURE_AI_PROVIDER=gemini`+`GEMINI_API_KEY`; Drive `GOOGLE_SERVICE_ACCOUNT_EMAIL`/`GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`; email-in `INBOUND_MAIL=brevo`, `INBOUND_MAIL_DOMAIN`, `INBOUND_MAIL_WEBHOOK_SECRET`); a coverage table linking all 16 files; suggested order |
| 7 | `01-sign-in-and-account.md` | Sign in + demo button; register; **Forgot password?** → **Send reset link** (link appears in the server log with `MAIL_TRANSPORT=log`) → **Set new password**; verify-email banner **Resend it**; Account settings tabs Profile (**Change email** → **Send confirmation link**), Password, Notifications, Sessions (**Recent sign-ins**, **Sign out of all other sessions**), Status. Break: wrong password ×3 shows failed sign-ins in **Recent sign-ins**; reusing a used reset link is refused; a signed-out session's tab is sent to sign-in on its next action |
| 7 | `02-organizations-members-roles.md` | **Add organization** + its wizard, switch, **Leave**; **Settings → General**; **Members & invitations** (**Invite someone**, copy link); **Roles & permissions** (**New role** from `… view` permissions); accept as the matching email in a private window; role change applies on next request. Break: accept while signed in as a different email (refused); remove/demote the last owner (refused); the viewer opens `/expenses/<id>` and has no **Approve**; paste an org-A invoice URL while in org B (not found) |
| 7 | `03-dashboard-and-navigation.md` | Dashboard tiles ("Invoices owed to you", "Expenses you need to pay", "To review", net income, "Last 6 months", "Accounting equation"), **Business health** tiles (Current ratio, Debt to equity, Gross margin (YTD), Working capital), setup checklist, top-bar Create menu (every entry), command palette (⌘K / Ctrl+K), theme (Light/Dark/System), collapsed sidebar, mobile drawer (narrow the window to < 768px). Break: palette search for a page your role cannot view (absent) |
| 8 | `04-chart-and-system-accounts.md` | Chart tree, account ledger page (From/To, running balance), **System** badge, **Settings → Chart of accounts** (**Rename**, **Retire**, **Mark as bank**, **Mark as credit card**), cash flow category and balance-sheet class on the account form, **Conversion balances** (⚠ scratch org). Break: retire `{{account:1120}}` (refused, system account); mark `{{account:1120}}` as bank (refused); manual journal to `{{account:1120}}` or `{{account:1110}}` (refused, control/bank account) |
| 8 | `05-manual-journals-and-recurring.md` | Manual journals list tabs; **New journal** → **Save draft**, **Post**, **Copy**, **Void** (void date), **Delete** draft; placeholder picker + preview on narration; **New repeating journal**; **Recurring** schedules: **Run now**, Pause, Resume, End, "Next run will read"; **General journal** row → journal page → **Reverse** / **Void journal**. Break: unbalanced lines (Post refused with the imbalance); post dated in closed period `{{month:1}}` (refused); **Reverse** on an invoice's journal entry (refused — reverse the document instead) |
| 8 | `06-sales.md` | Customers (**New customer**, Deactivate/Reactivate, account page **Open items**/**Account ledger**, History & notes **Add note**); Quotes (**Send** → **Mark as sent**, **Record acceptance**, **Record decline**, **Revise**, **Void quote**, review-link **Revoke**, **Download PDF**); Sales orders (**Confirm**, **Request deposit**, **Create invoice**, **Close**, **Reopen**, **Cancel order**); Invoices (list filters, column sort, pagination, **Issue**, **Record payment**, **Make recurring**, **Void**); Credit notes (**Apply credit**, **Void**); **Payments** page (direction filter, **Void**); Statements (Outstanding/Activity, bulk **Print**, **Email**, vendor statements); invoice/statement templates, payment terms, quote/statement emails, online payments settings; optional: public quote and statement pages, Stripe test card `4242 4242 4242 4242`. ⚠ scratch org for every issue/void/payment. Break: edit an issued invoice (no Edit); void a paid invoice (refused until the payment is voided); apply more credit than the note's remaining amount (refused); invoice more than a sales order line's remaining quantity (refused); reuse an accepted quote's link (already decided) |
| 9 | `07-purchases.md` | Vendors; purchase quotes → **Create purchase order** / **Create a draft expense**; purchase orders (**Record prepayment**, **Create bill**, **Close**, **Cancel order**); expenses (**Submit for review**, **Approve**, apply-credit dialog **Approve and apply**, **Duplicate**, **Record payment**, **Apply prepayment**, **Void**, **Make recurring**, **Attachments** → **Choose from Documents**); debit notes (**Void**). ⚠ scratch org for postings. Break: approve a draft that was never submitted (no Approve); a second draft with the same vendor reference (409 message); void a bill whose stock has been sold (refused) |
| 9 | `08-bill-inbox.md` | *Optional — needs a vision key.* **Choose files**, PII masking, **Review queue**, **Post to ledger**, **Re-extract**, duplicate upload, **Settings → Bill inbox** auto-post, **AI usage**, email-in **Copy** / **Generate new address**. Break: upload the same file twice (a visible duplicate, not re-extracted until confirmed); upload a `.txt` (refused) |
| 9 | `09-banking.md` | **Import statement** (three formats, **Column mapping**, closing balance); line actions **Accept**, **Match**, **Unmatch**, **Post journal**, **Ignore**, **Un-ignore**, **Rescore**, **Create a rule from this line**; **Bank rules** (**New rule**, **Apply to unmatched lines**); **Delete selected**, **Restore**, **Deleted** and **History** tabs, **Delete statement**; **Reconciliation** (deleted count). ⚠ scratch org (import `{{date:1:1}}`-month statement from `walkthrough/statements/`). Break: re-import the same file (rows de-duplicated, previously-deleted count shown); look for a suggestion for a EUR invoice (never offered); **Post journal** to a bank account (refused) |
| 9 | `10-products-and-inventory.md` | Products & Services (**Track inventory**, quick-add from an invoice line); **Locations** (**New location**, default location); **Stock movements** Receive / Issue (**Charge to expense account**) / Adjust / Transfer; serial and lot items (**Serial numbers (one per line)**, **Book**, **Hold**, **Release**); **Settings → Inventory → Catalogue** (**Add field**); **Item codes** (builder, **Make default**); **Labels** + **Lookup**; **Valuation** (**Link all**, **Move to current accounts**, **True up**); inventory accounts in **Settings → Financial**. ⚠ scratch org. Break: issue more than on hand (refused); receive a serial number already in stock (refused); transfer to the same location (refused) |
| 10 | `11-currency-and-tax.md` | Beyond month 7: **Exchange rates** list/**Delete**; **FX exposure** and **Revaluations** history; FX accounts in **Settings → Financial**; **Default tax rate %** in **Settings → Invoicing**; **Tax summary** drill-down. Break: EUR invoice dated before the first rate ("No exchange rate for EUR to USD on or before …"); deposit on a EUR order (refused); a second revaluation for the same date (refused / already revalued) |
| 10 | `12-imports.md` | All nine kinds (chart, opening balances ⚠, customers, vendors, products, inventory items, journals, invoices, expenses), **Review column mapping**, **Import as drafts** vs **Import and post**, conversion mode, row status, **Delete import**. Break: a CSV with a blank name row (row INVALID, commit blocked); commit the same import twice (refused) |
| 10 | `13-periods-and-close.md` | **Fiscal periods**: **Generate periods for this fiscal year**, **Close**, **Reopen**, **Lock** (⚠ scratch org only — irreversible). Break: post into a closed period (refused); **Reopen** a locked period (not offered) |
| 10 | `14-reports.md` | Every report with its controls and **Export** (PDF, Excel (.xlsx), CSV — open each file): **Business snapshot** (period presets, vs prior period, trend), Profit & loss with **Compare**, Balance sheet, **Cash flow statement** (net change = cash change), Trial balance (**Hide accounts with no activity**), Aged receivables/payables (control-account check), Sales by customer / by item, Purchases by vendor / by item, **Tax summary**, **Account transactions** (**Group by**, **Columns**), **General journal**, **Ledger exceptions** (**Mark reviewed** with a note, **Show reviewed**, **Reopen**). Break: a `to` before `from` (refused); a 400-day exception window (refused, 366-day limit) |
| 10 | `15-history-audit-and-integrity.md` | History & notes on an invoice, expense, credit note, quote, order, manual journal, contact, bank line; **Settings → Audit → Audit trail** (before/after); **User activity**; `cd server && npm run verify:integrity` (7 checks pass). Break: a viewer opens the audit trail (refused — owner/admin only) |
| 10 | `16-workspace-and-connections.md` | **Documents** vault (filters, **Download**, **Delete**); **Webhooks** (**New endpoint** to `http://localhost:9999/hook` with `nc -lk 9999` running, **Rotate secret**, **I've stored it**, deliveries **Retry**) — needs the worker; **Google Drive** (*optional*); **Settings → Email** sender name / reply-to. Break: a webhook URL that is not http(s) (refused); delete a vault document still attached to an invoice (refused or warned — quote what the UI does) |

For each of Steps 7–10:
- **Model:** [Sonnet] — every label must be verified in JSX; content is prose, not a literal contract.
- **Depends on:** Step 6 (and the previous template step).
- **Read first:** `nav.ts`, `ProductRoutes.tsx`, `SettingsHubPage.tsx`, `ReportsPage.tsx`, and each page file the
  section names (`grep -rln "<label>" client/src/Pages` to find it).
- **Files:** the templates in the row(s) for that step (new), under `server/src/scripts/walkthroughGuide/`.
- **Proof:** `cd server && npm run walkthrough -- --anchor 2026-03` succeeds; `npx vitest run src/__tests__/accounting/walkthroughGuide.test.ts`
  passes; and from the repo root, for the files of that step:
  ```bash
  grep -oh '\*\*[^*]\+\*\*' walkthrough/guide/<files> | sed 's/\*\*//g' | grep -v ':$' | grep -v '^⚠' | sort -u \
    | while IFS= read -r l; do grep -rqF -- "$l" client/src || echo "MISSING: $l"; done
  grep -oh '(`/[^`]*`)' walkthrough/guide/<files> | tr -d '()`' | sed 's#/[0-9a-f-]\{36\}#/:id#g' | sort -u
  ```
  The first command prints no `MISSING:` line except section-format words (`Do this`, `You should see`,
  `Try to break it`, `Where`, `Needs`, `Done`). Every route from the second is present in
  `ProductRoutes.tsx`/`App.tsx` (check each by `grep -n "path=\"<segment>"`).
- **If it fails:** rewrite the sentence with the real label. Never add a label to the client.
- **Owes:** nothing.

---

## Slice 4 — prove it in the app, then docs

### Step 11 — [Sonnet] Seed the demo and smoke-test the guide in a browser

- **Model:** [Sonnet] — debugging against a running app.
- **Depends on:** Step 10
- **Files:** `<scratchpad>/guide-smoke.mjs` (new, **not committed**; scratchpad =
  `/tmp/claude-1000/-home-ankit-Documents-AutoLedger-AutoLedger/<session>/scratchpad`, or `$TMPDIR` in another session).
- **Contract:**
  1. `cd server && npm run db:reset && npm run seed:demo` → ends with `Demo organization "Harbor Point Fabrication" is ready.`;
     `npm run verify:integrity` → all 7 checks pass.
  2. Start the app (`./dev.sh` from the repo root, in the background) and wait for `http://localhost:5173`.
  3. `guide-smoke.mjs` loads Playwright with
     `createRequire(import.meta.url)('/home/ankit/.npm/_npx/e41f203b7505f1fb/node_modules/playwright')`, launches
     Chromium headless, signs in at `/login` with the demo credentials, then for every route collected from
     `walkthrough/guide/*.md` `(`/route`)` (routes containing `:` skipped) visits `http://localhost:5173<route>`,
     waits for network idle, and records a failure if the page shows the app's error boundary or "Page not found",
     or if no element contains that file-section's first bold label. Print `OK <route>` / `FAIL <route> <reason>`.
  4. Fix every FAIL by correcting the template (Steps 7–10 rules), regenerate, re-run until all OK.
  5. Walk month 7 by hand in the browser on a **fresh** org (register a new user) only through sections 1–3 of
     `11-currency-tax-and-journals.md` to confirm the labels it names; stop there.
- **Proof:** the smoke script prints no `FAIL`; `verify:integrity` clean.
- **If it fails:** a route 404 for a real page means the guide's route is wrong — fix the template.
- **Owes:** nothing.

### Step 12 — [Haiku] Literal doc and comment updates

- **Model:** [Haiku] — every edit is spelled out below.
- **Depends on:** Step 11
- **Files and exact replacements:**
  - `SETUP.md` §7: replace "hand-enterable three-month accounting scenario (Harbor Point Fabrication) with a
    tutorial and a computed answer key." with "hand-enterable seven-month accounting scenario (Harbor Point
    Fabrication) with a tutorial, a computed answer key, and `walkthrough/guide/` — a module-by-module test guide
    for every feature."
  - `README.md` layout block: `walkthrough/ Phase 6.1's demo scenario — …` → `walkthrough/ the seven-month demo
    scenario + guide/ (a test guide for every module) — human-readable CSV/markdown;`
  - `docs/architecture.md:152`: "the hand-enterable four-month scenario" → "the hand-enterable seven-month
    scenario and the test guide".
  - `docs/accounting.md:301`: append "(since grown to seven months — see roadmap § Walkthrough month 7 and test guide)".
  - `docs/master-plan.md:390` "4 months" → "7 months"; `:741` "4-month" → "7-month".
  - `docs/development.md` scripts table: `npm run walkthrough` row — "six-month" → "seven-month", "six months back"
    → "seven months back", "`--anchor 2026-04`" → "`--anchor 2026-03`", add "writes `walkthrough/guide/` from
    `src/scripts/walkthroughGuide/*.md`"; `seed:demo` row — "six walkthrough months" → "seven walkthrough months",
    "puts month 6 on last month" → "puts month 7 on last month"; add one line under the table: "To try every
    feature by hand, follow `walkthrough/guide/README.md` against the demo organization."
  - Code comments: `generateWalkthrough.ts` L34–36 "three bank statements in three different formats" → "seven
    bank statements in three bank formats"; `walkthroughDates.ts` header (done in Step 1 — verify).
- **Proof:** `grep -rn "three-month\|four-month\|4-month" SETUP.md README.md docs/architecture.md docs/master-plan.md docs/development.md`
  prints nothing.
- **If it fails:** the exact phrase differs — open the line and replace the stale fact only.
- **Owes:** —

### Step 13 — [Sonnet] Roadmap entry and CLAUDE.md bullet

- **Model:** [Sonnet] — needs the real test counts and an honest "not built" list.
- **Depends on:** Step 12
- **Files:** `docs/roadmap.md` (edit), `CLAUDE.md` (edit).
- **Contract:**
  - Run `cd server && npm test` and `cd client && npm test`; record the passing/skipped counts.
  - `docs/roadmap.md`: new section after "Walkthrough months 5–6": `## Walkthrough month 7 and test guide (2026-10-17, not a numbered phase)`
    — built to `plans/walkthrough-month-7-and-guide.md`; month 7 contents; re-anchor to 2026-03; the I20 due-date
    fix; the aging-vs-GL revaluation gap (expected behaviour, pinned by the test); the guide (16 files + README,
    token-validated templates); new generated files; tests (counts); study note; **Deliberately not built:**
    fixed assets/depreciation, a year-end close, foreign-currency bank statements, a reconciled 1115 statement,
    an automated browser walkthrough committed to CI. In the months 5–6 entry, change "Built to
    `plans/walkthrough-months-5-6.md`" to "Built to a plan file that was not committed". In the Phase 6.1 entry
    (≈L754), change "regenerates the committed folder byte-identically (proven by a determinism test and by
    `git status` …)" to "regenerates the committed folder byte-identically (checked by `git status` after a real
    regeneration; the test checks only that the answer key is deterministic)".
  - `CLAUDE.md`: after the "Walkthrough months 5–6" bullet add one bullet:
    `- **Walkthrough month 7 + test guide (2026-10-17, not a numbered phase)** — \`walkthrough/\` grows to seven verified months (a euro customer with realized and unrealized FX, 7.5% sales tax, manual journals posted/voided/deleted, a repeating insurance amortisation, period 6 closed), re-anchored to 2026-03; \`walkthrough/guide/\` is a module-by-module test guide with "Try to break it" checks, generated from token-validated templates in \`server/src/scripts/walkthroughGuide/\`, replacing the feature tour. No migration. <N> server (2 skipped) + <M> client tests. Detail in [docs/roadmap.md](docs/roadmap.md#walkthrough-month-7-and-test-guide-2026-10-17-not-a-numbered-phase).`
    with the real counts.
- **Proof:** `grep -n "Walkthrough month 7" CLAUDE.md docs/roadmap.md` shows both; the anchor link slug matches
  the heading.
- **Owes:** —

### Step 14 — [Sonnet] Study note

- **Model:** [Sonnet] — accuracy bar.
- **Depends on:** Step 13
- **Skill:** `study-note`
- **Files:** `study/architecture/deterministic-demo-fixtures.md` (edit), `study/README.md` (edit — index row and
  coverage tracker).
- **Contract:** extend with a section "Prose that cannot drift: validated tokens in generated docs" — mechanism
  (templates + a closed token set + throw on unknown/leftover braces + a test that renders every template), the
  re-anchor as a pure date shift proven by the replay, why an answer key pins a known product behaviour (aging vs
  GL after revaluation) instead of hiding it; rejected alternatives (hand-edited markdown; TS string
  concatenation — the feature tour's old shape; a template engine dependency — rule #14); gotchas; two new
  interview Q&As with full answers. Fix the stale "four-month"/"three bank statement" lines (L42, L60, L62).
- **Proof:** `grep -n "validated tokens" study/architecture/deterministic-demo-fixtures.md study/README.md` shows both.
- **Owes:** —

### Step 15 — [Sonnet] docs-sync, guardrail review, full suites

- **Model:** [Sonnet] — verification.
- **Depends on:** Step 14
- **Skill:** `docs-sync`, then `guardrail-review`
- **Proof:** `cd server && npm run typecheck && npm run lint && npm test` (2 skipped, 0 failed);
  `cd client && npm run typecheck && npm run lint && npm test` (713 passing, unchanged);
  `git diff --stat -- server/src/services server/src/controllers server/src/routes server/src/db` prints nothing;
  guardrail review reports zero violations; docs-sync reports no drift.
- **Owes:** —

### Step 16 — [Haiku] Close the plan

- **Model:** [Haiku] — status edit.
- **Depends on:** Step 15
- **Files:** this file — set `Status: done` at the top; every manifest row `done`.
- **Proof:** `grep -c "| todo |" plans/walkthrough-month-7-and-guide.md` → `0`.

---

## Dispatch manifest

| Batch | Step | Tier | Title | Depends on | Blocks | Status |
|---|---|---|---|---|---|---|
| A | 1 | Sonnet | Re-anchor 2026-03 + `dueDays` fix | — | 2 | done |
| A | 2 | Sonnet | Month-7 dataset, statement 7, tiers | 1 | 3 | done |
| A | 3 | Sonnet | Answer key for month 7 + internal tests | 2 | 4 | done |
| A | 4 | Sonnet | Replay month 7 + end-to-end assertions | 3 | 5 | done |
| A | 5 | Sonnet | Generator: month 7, label drift, names module | 4 | 6 | done |
| A | 6 | Sonnet | Guide renderer, wiring, test | 5 | 7 | done |
| A | 7 | Sonnet | Guide templates README, 01–03 | 6 | 8 | done |
| A | 8 | Sonnet | Guide templates 04–06 | 7 | 9 | done |
| A | 9 | Sonnet | Guide templates 07–10 | 8 | 10 | done |
| A | 10 | Sonnet | Guide templates 11–16 | 9 | 11 | done |
| A | 11 | Sonnet | Seed demo + browser smoke | 10 | 12 | done |
| B | 12 | Haiku | Literal doc and comment updates | 11 | 13 | done |
| C | 13 | Sonnet | Roadmap entry + CLAUDE.md bullet | 12 | 14 | done |
| C | 14 | Sonnet | Study note | 13 | 15 | done |
| C | 15 | Sonnet | docs-sync, guardrail review, full suites | 14 | 16 | done |
| D | 16 | Haiku | Close the plan | 15 | — | done |

Steps 1–11 are one Sonnet batch (A); 12 is Haiku (B); 13–15 return to Sonnet (C); 16 is Haiku (D).
Do **not** split Steps 2–4 across sessions without running Step 4's proof: the dataset, answer key and replay
must agree before anything renders from them.

## Plan corrections (found during execution)

- Step 4: `GET /api/v1/reports/fx-exposure` returns `{success, exposure: FxExposureReport}`, not a bare
  `FxExposureReport`; the test reads `body.exposure.alreadyRevalued`. Test-side shape only.
- Step 5: the scenario has six customers, so Rheinwerk is the **seventh**, not the "13th". The new-account
  form's bank field is a select (None / Bank account), not a tickbox; **Record payment** opens "Record a receipt"
  with "Cash / bank account" and **Record**.
- Steps 7–8: the demo button is **Open the demo** (shown only with `VITE_DEMO_EMAIL`/`VITE_DEMO_PASSWORD`); the
  top-bar menu is **New**; `1110` is not a system account; there is no top-level Settings → General (it is the
  **General** link in the Organization card); a revoked session is refused at its next refresh, not its next
  action; labels built from variables or containing `&` are written in backticks, not bold.
- Steps 9–10: a webhook to `http://localhost:9999/hook` is refused (`Webhook URL must not target a private host`);
  guide 16 uses a public https receiver and lists that refusal. `3400` is not in `walkthroughNames.ts`, so
  `{{account:3400}}` throws — written as plain text. The PO button is `Create expense`; the tax summary has no
  drill-down; the general journal has no Export; bank-line Post journal is refused only to the same bank
  account or a control account.
- Step 11: `networkidle` never settles (the app polls) — the smoke uses `domcontentloaded` + label polling, a new
  page per route, `/usr/bin/google-chrome` (the cached headless shell was missing); `/onboarding` and the setup
  checklist are checked in a freshly registered org. A fresh user must finish the setup wizard before section 1.
- Step 12: the proof's `4-month` also matches "24-month sandbox" (master-plan.md:390). Verified with
  `grep -rnE "three-month|four-month|(^|[^0-9])4-month" …` → no match. (That "24-month sandbox" is itself stale —
  the sandbox was removed in Phase 29 — left for docs-sync in Step 15.)
- Step 16: the proof greps for `| todo |`, which its own Proof line contains, so it returns 1. Verified on the
  manifest rows only: 0 `todo`, 16 `done`.
- Step 3: `6810 Realized FX Loss` added to the account-name map (needed for the loss branch; not listed).

## Risks & open questions

- **Tax summary or cash flow quirk in months 1–6** (deposits, notes, inventory) could make the per-month
  assertions in Step 4 fail. That is a stop-and-report: record the quirk; the user decides whether to scope those
  assertions to month 7.
- **Base-currency conversion of EUR lines** is per line in the product; all month-7 EUR amounts are whole euros at
  two-decimal rates, so per-line and per-total conversion agree. If a 422 "does not balance" appears, report it.
- **`4910`'s exact name** is read from the migrations in Step 3 (not assumed).
- **Repeating INS1 depends on today's date:** later occurrences (2026-10-28, 2026-11-28) appear once those dates
  pass; reports are dated, so the scored months are unaffected.
- **Guide labels drift** as the UI changes; the label-check command in Steps 7–10 is the regression check to rerun.
- **Committed-file churn:** re-anchoring rewrites every date in `walkthrough/`; review with `git diff --word-diff`.

## Definition of done

`npm run walkthrough -- --anchor 2026-03` regenerates `walkthrough/` deterministically, with month 7,
statement 7, `11-currency-tax-and-journals.md` and `guide/` (README + 16 files), and without
`11-feature-tour.md`; `walkthrough.test.ts` replays seven months cent for cent; `walkthroughGuide.test.ts`
passes; full server and client suites green; `seed:demo` + `verify:integrity` clean; the guide's labels and
routes check clean and the browser smoke prints no FAIL; docs, CLAUDE.md and the study note updated;
guardrail review clean; this file marked done.
