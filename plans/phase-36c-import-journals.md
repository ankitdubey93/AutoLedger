# Phase 36c — CSV import: manual journals

Date: 2026-10-01 · **Status: done — 36c landed (uncommitted)** · Approved design: `/home/ankit/.claude/plans/csv-importer-throughout-the-abundant-cookie.md` (Phase 36, Step C) · Builds on 36a (`d2f04a4`) and 36b (`68dcd01`) on branch `phase-36-csv-import`. The 36b plan (`plans/phase-36b-import-products.md`) holds that step's defect log.

Step C adds the first **grouped** import kind, `JOURNALS`: many CSV rows become one journal entry. It also adds the grouped-kind machinery that 36d (invoices and bills) will reuse:
- a group key per row, recomputed on edit
- group-ordered row listing
- group-level validation
- a bulk include/exclude endpoint
- group headers in the review table
- a documents-per-import cap

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

## Starting state (verified 2026-10-01, after 36b)

**Import machinery**
- `server/src/services/accounting/importKinds.ts`:
  - `ImportKindDef` has `parseRow(cells, columns, rowNumber, ctx: {dateFormat})`, `validateRows(client, orgId, rows)`, `preview`, optional `prepareCommit` and `commitOnClient(client, orgId, importId, createdBy, context)`.
  - The six kinds are `CHART_OF_ACCOUNTS`, `OPENING_BALANCES`, `CUSTOMERS`, `VENDORS`, `ITEMS` and `INVENTORY_ITEMS`.
  - Data kinds keep their columns in separate files (`importItemColumns.ts`, `importInventoryItemColumns.ts`) to avoid an `importKinds` ↔ service import cycle.
- `server/src/services/accounting/importRowParsers.ts`:
  - `parseDataRow(columns, cells, resolved, rowNumber, dateFormat)` sets `groupKey: null`.
  - `dataRowParseErrors(columns, raw, dateFormat)`.
- `server/src/services/accounting/importRowStore.ts` exports `DataRow`, `loadDataRowsOnClient`, `markCommittedOnClient`, `importDateFormatOnClient`, `importDateFormatForRowOnClient` and `LegacyCommitPreview`.
- `server/src/services/accounting/importAccountLookup.ts`:
  - `loadAccountsByCodeOnClient` → `Map<code, ImportAccount>`, where `ImportAccount` is `{id, code, type, isPostable, isActive}`.
  - `accountCodeError(label, code, account, wantTypes)`.
- `server/src/utils/importValues.ts`:
  - `ImportCellType = 'text'|'money'|'percent'|'quantity'|'date'|'enum'`, `CellSpec`, `parseImportCell`, `suggestDateFormat`.
  - The money branch rejects negatives and digit-free words.
- `server/src/services/accounting/migrationImportService.ts`:
  - `createImport` inserts `data` and `group_key` (`StagedRowInput.groupKey`) through `unnest`.
  - `patchRow` for data kinds merges `data`/`raw` with `COALESCE(data,'{}'::jsonb) || $1::jsonb`. It does **not** recompute `group_key`.
  - `listRows` orders by `row_number` (~L292).
  - `commit` runs `prepareCommit`, then `FOR UPDATE`, revalidate-at-commit for data kinds, then `commitOnClient`, then `UPDATE result`.
- `MigrationImportRow` has `values` and `groupKey`. `MigrationCommitPreview` has `summary: PreviewSummaryItem[]` (`{label, value, format:'count'|'money'}`) and `warnings`, and still requires the legacy numeric fields (data kinds set them to 0, `plugAccountCode:''`, `entryDate:null`).
- Migration 078 already admits `JOURNALS` and holds `migration_import_rows.group_key` (≤ 220 chars) with the partial index `idx_migration_rows_group`. **No migration is needed.**
- `config/constants.ts` has `MAX_IMPORT_ROWS = 5000`.

**Journals**
- `server/src/services/accounting/journalService.ts`:
  - `createEntryOnClient(client, orgId, createdBy, {entryDate, description, sourceType?, sourceId?, lines:[{accountId, debitCents, creditCents}]})` (L419). It asserts the period is open, the accounts are postable and the entry balances, and inserts with `source_type = sourceType ?? 'manual'`. It opens no transaction.
  - `assertNotControlAccountsOnClient(client, orgId, accountIds)` (L359) throws the **first** hit with one of three exact messages: receivable, payable, inventory control. Manual journals call it in `createEntry`; `createEntryOnClient` does not.
  - `resolveControlAccountIdOnClient` is module-private (L331).
- Inventory control ids come from `accounting/itemService.ts` → `resolveInventoryControlAccountIdsOnClient(client, orgId): Promise<Set<string>>`.
- `server/src/services/accounting/fiscalPeriodService.ts` → `assertPeriodOpenOnClient(client, orgId, entryDate)` (L277). It **throws** 422 `The fiscal period covering ${entryDate} is ${status.toLowerCase()}; reopen it or post to an open period`; a date with no period row is allowed.
- `journal_entries.source_type` is free text (`length(btrim) > 0`). The opening-balance import uses `'opening_balance'`. `recurringService.ts:266` only accepts `'manual'` entries as templates.
- `server/src/utils/money.ts` → `formatCents(value: Cents): string`, `sumCents`.

**Client**
- Under `client/src/Pages/accounting/imports/`: `ImportRowsTable.tsx` (the typed path, plus the data path editing `row.raw` and saving `{values}`), `ImportGuidePanel.tsx`, and `importGuides.ts`. `MIGRATION_STEPS` currently holds conversion-date, chart, customers, vendors, products, opening, stock; its comment says Step D inserts invoices and bills before `stock`.
- `client/src/Pages/accounting/JournalsPage.tsx`: the header (~L152-166) has a lone `<Link to="/journals/new">New entry</Link>`.
- `client/src/Pages/accounting/JournalDetailPage.tsx`: the Source row (~L154) renders the raw `entry.sourceType`, and "Make recurring" shows only for `'manual'`.
- Tests: `client/src/__tests__/journals.test.tsx` has no page-wide link query; fixture `__tests__/fixtures/importKinds.ts`; `importWizard.test.tsx`; `migrationImport.test.tsx`.

**Test counts:** 1816 server tests passed (2 skipped); 515 client tests passed.

## Gate

- Phase 36, step C. 36a and 36b are committed.
- Phases 3, 4, 25 and 35a (journals, periods, control-account refusal, inventory control accounts) are built.
- No migration, no dependency.

## Execution rules

**If a proof command fails twice on the same step, stop and report. Do not improvise around it.**

| Symptom | Forbidden | Correct |
|---|---|---|
| Test fails | Weakening the assertion | Fix the code |
| A 36a/36b or journal test fails | Editing it | Fix the change. Every existing `__tests__/accounting/*` file is the gate |
| Type error | `as any`, `@ts-ignore` | Fix the type |
| Query returns no rows | Dropping `org_id` | Fix the fixture (rule 1) |
| Balance check | Floats or an epsilon | Integer cents equality (rule 3) |
| Need a library | `npm install` | Stop (rule 14) |
| A `[Haiku]` step fails twice | Retrying or trimming | Escalate unchanged to `[Sonnet]`; note it |
| An undecided choice | Deciding it | Stop and report |

Docker services come up with `docker compose up -d postgres postgres-test redis`. Server commands run from `server/`, client commands from `client/`; **run vitest sequentially** (parallel runs corrupt the shared worker DBs). Server imports use `.js`; client imports are extensionless.

**Anything the plan did not anticipate is a stop-and-report, not a judgment call.**

---

## Slice 1 — Server: grouped-kind machinery

Outcome: a kind can declare `groupKeyOf`. Rows carry a group key that is recomputed on every edit, list in group order, and can be excluded or included a whole group at a time. Staging refuses more than 1000 groups.

**Names:**

| Kind | Name |
|---|---|
| Type (`types/accounting.ts`) | `ImportCellType` gains `'signedMoney'` (edit `utils/importValues.ts`) |
| Meta fields | `ImportKindMeta.groupHeaderFields: readonly string[]` (`[]` = not grouped) |
| Def hooks | `ImportKindDef.groupKeyOf?: (values: Readonly<Record<string, string \| number \| null>>, raw: Readonly<Record<string, string>>) => string \| null` and `ImportKindDef.groupNoun?: string` |
| Constant | `MAX_IMPORT_DOCUMENTS = 1000` in `config/constants.ts` |
| Service export | `setRowsStatus(orgId, importId, rowIds, status)` in `migrationImportService.ts` |
| Schema | `setRowsStatusSchema` |
| Controller export | `setRowsStatus` |
| Route | `POST /api/v1/migration-imports/:id/rows/status` |

### Step 1 — [Sonnet] Grouped-kind machinery + bulk status + `signedMoney`

- **Model:** [Sonnet]. Staging SQL, window ordering and the transaction around the bulk update.
- **Depends on:** —
- **Read first:** `migrationImportService.ts` (`createImport`, `listRows`, `patchRow`, `revalidateOnClient`), `importKinds.ts`, `utils/importValues.ts`, and `controllers/accounting/migrationImportController.ts` together with `routes/accounting/migrationImportRoutes.ts` (copy the `patchRow` handler and route shape).
- **Files:**
  - `utils/importValues.ts`
  - `types/accounting.ts`
  - `config/constants.ts`
  - `services/accounting/importKinds.ts`
  - `services/accounting/migrationImportService.ts`
  - `schemas/accounting/migrationImportSchema.ts`
  - `controllers/accounting/migrationImportController.ts`
  - `routes/accounting/migrationImportRoutes.ts`
  - `__tests__/importValues.test.ts` (**append** 2 tests)
- **Contract:**
  - **`importValues.ts`:** add `'signedMoney'` to `ImportCellType`. `parseImportCell` for `signedMoney` behaves exactly like `money` (digit-free guard, `parseMoneyText`, the same "is not an amount" error), except that a negative is allowed. Append these tests:
    - `signedMoney keeps the sign`: `'-12.50'` → -1250, `'12.50'` → 1250
    - `signedMoney rejects words`: `'abc'` → an error containing `is not an amount`
  - **Types:**
    - `ImportKindMeta` gains `groupHeaderFields: readonly string[]`. All six existing kinds get `[]`, and `listImportKindMeta` includes the field.
    - `ImportKindDef` gains the two optional hooks from the Names table.
  - **`createImport`:** after `parsed` is built, when `def.groupKeyOf` is defined, set `row.groupKey = def.groupKeyOf(row.data ?? {}, row.raw)` for every row. Then count the distinct non-null keys; above `MAX_IMPORT_DOCUMENTS` → `ApiError(422, \`This file has ${String(n)} ${def.groupNoun ?? 'documents'}; one import takes at most ${String(MAX_IMPORT_DOCUMENTS)} — split it into smaller files\`)`.
  - **`patchRow`** (data kinds): after the `data`/`raw` UPDATE, when `def.groupKeyOf` is defined, re-read that row's `data`/`raw` on `client` and run
    ```sql
    UPDATE migration_import_rows SET group_key = $1 WHERE id = $2 AND org_id = $3 AND import_id = $4
    ```
    with the recomputed key. This happens before `revalidateOnClient`.
  - **`listRows`:** load the import's kind (the existing `assertImportExists` returns it). When the kind's def has `groupKeyOf`, order by
    ```sql
    ORDER BY MIN(row_number) OVER (PARTITION BY COALESCE(group_key, id::text)), row_number
    ```
    otherwise keep `ORDER BY row_number ASC`. The two ORDER BY strings are **constants** chosen by a boolean (rule 4).
  - **`setRowsStatus(orgId, importId, rowIds: string[], status: 'VALID' | 'EXCLUDED'): Promise<MigrationImport>`**, inside `withTransaction`:
    1. `SELECT status FROM migration_imports WHERE id=$1 AND org_id=$2 FOR UPDATE`: missing → 404 `Migration import not found`; COMMITTED → 409 `This import has already been committed`.
    2. Run:
       ```sql
       UPDATE migration_import_rows
          SET status = $1, errors = CASE WHEN $1 = 'EXCLUDED' THEN '{}'::text[] ELSE errors END
        WHERE org_id = $2 AND import_id = $3 AND id = ANY($4::uuid[])
       ```
       When `rowCount !== new Set(rowIds).size` → 404 `Some rows were not found in this import`.
    3. `return revalidateOnClient(client, orgId, importId)`.

    Note: setting `VALID` puts the row back into validation; `revalidateOnClient` then assigns the row's real status.
  - **Schema:** `setRowsStatusSchema = z.object({ rowIds: z.array(z.uuid()).min(1).max(MAX_IMPORT_ROWS), status: z.enum(['VALID', 'EXCLUDED']) })`.
  - **Controller `setRowsStatus`:** `parseBody` → service → `res.json({ success: true, import })`.
  - **Route:** `router.post('/:id/rows/status', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), migrationImportController.setRowsStatus);`, placed immediately after the `PATCH /:id/rows/:rowId` route.
- **Guardrails:**
  - #1: every statement carries `org_id` and `import_id`
  - #4: ORDER BY picked from constants
  - #5: bulk update, recompute and revalidate on one `client`
  - #2: no SQL in the controller
- **Proof:** `npm run typecheck` exits 0; `npm run lint` exits 0; `npx vitest run src/__tests__/importValues.test.ts src/__tests__/accounting/importMapping.test.ts src/__tests__/accounting/itemImport.test.ts src/__tests__/accounting/inventoryItemImport.test.ts src/__tests__/accounting/partyImport.test.ts src/__tests__/accounting/chartImport.test.ts src/__tests__/accounting/openingBalanceImport.test.ts` passes, with every existing test unedited.
- **Owes:** docs, in Step 7.

## Slice 2 — Server: the `JOURNALS` kind

Outcome: a journal CSV groups into entries by `JournalNumber`, or by Date + Narration (Xero-style) when there is no number. Each entry is validated as a whole: lines, balance, accounts, control accounts and open period. Commit posts every entry in one transaction with `source_type 'migration_import'`.

**Names:**

| Kind | Name |
|---|---|
| Kind | `JOURNALS` (append to `MIGRATION_IMPORT_KINDS`) |
| Columns file | `server/src/services/accounting/importJournalColumns.ts` → `JOURNAL_COLUMNS`, `JOURNAL_EDIT_FIELDS`, `journalGroupKey` |
| Service | `server/src/services/accounting/journalImportService.ts` → `validateRows`, `preview`, `commitOnClient` |
| journalService export | `listControlAccountsOnClient(client, orgId): Promise<Map<string, string>>` (account id → refusal message) |
| fiscalPeriodService export | `periodStatusOnClient(client, orgId, date): Promise<FiscalPeriodStatus \| null>` |
| Result | `{ kind: 'JOURNALS'; entryCount: number; lineCount: number }` |
| Source type | `'migration_import'`, with `sourceId` = the import id |
| Test | `server/src/__tests__/accounting/journalImport.test.ts` |

### Step 2 — [Sonnet] Control-account map + non-throwing period status

- **Model:** [Sonnet]. It refactors a guard that protects the subledgers.
- **Depends on:** 1
- **Read first:** `journalService.ts` L325-410 and `fiscalPeriodService.ts` L270-295.
- **Files:** `services/accounting/journalService.ts`, `services/accounting/fiscalPeriodService.ts`
- **Contract:**
  ```ts
  /** Every control account this org has, mapped to the exact message assertNotControlAccountsOnClient throws for it. */
  export async function listControlAccountsOnClient(client: Queryable, orgId: string): Promise<Map<string, string>>;
  ```
  - Build the map from the same three sources as today: receivable (`ledger_invoice_settings`, fallback `1120`), payable (`ledger_settings`, fallback `2100`), and `resolveInventoryControlAccountIdsOnClient`.
  - The messages are **byte-identical** to the current receivable, payable and inventory messages, with the account `code` looked up once per id.
  - Rewrite `assertNotControlAccountsOnClient(client, orgId, accountIds)` as: build the map, then throw `ApiError(422, message)` for the **first** id in `accountIds` order that is in the map.

    **Precedence note (must stay):** today the receivable check wins over payable, which wins over inventory, whatever the line order. Preserve it: iterate receivable, then payable, then inventory, and throw on the first of those present in `accountIds`. To make that possible, store the map in that insertion order and iterate the map, checking `accountIds.includes(id)`.
  ```ts
  /** The status of the fiscal period covering `date`, or null when no period covers it (posting allowed). Never throws. */
  export async function periodStatusOnClient(client: PoolClient, orgId: string, date: string): Promise<FiscalPeriodStatus | null>;
  ```
  `assertPeriodOpenOnClient` then calls it; its behaviour and message are unchanged.
- **Guardrails:**
  - #1
  - the refusal rule is unchanged: manual journals must still refuse all three control-account kinds with the same messages
- **Proof:** `npm run typecheck` exits 0; `npx vitest run $(ls src/__tests__/accounting/*.test.ts | grep -iE "journal|control|period|partyAccount|inventoryAccount")` passes unedited (print the file list first).
- **Owes:** nothing.

### Step 3 — [Sonnet] `JOURNALS` columns, service and registry entry

- **Model:** [Sonnet]. Double-entry validation and GL posting.
- **Depends on:** 2
- **Read first:** `itemImportService.ts` and `importItemColumns.ts` (mirror the file shape and preview fields) and `importRowStore.ts`.
- **Files:**
  - `types/accounting.ts` (append `'JOURNALS'`, add the result member)
  - `services/accounting/importJournalColumns.ts` (new)
  - `services/accounting/journalImportService.ts` (new)
  - `services/accounting/importKinds.ts` (entry)
- **Contract:**

  **Registry entry `JOURNALS`:**
  - label `Journal entries`, noun `journal lines`, storage `data`
  - requiredOneOf `[['debit','credit'],['amount']]`
  - `groupHeaderFields: ['journalNumber','date','narration']`
  - `groupKeyOf: journalGroupKey`, `groupNoun: 'journals'`
  - `parseRow`: `parseDataRow(JOURNAL_COLUMNS, …)`, since `createImport` applies `groupKeyOf` itself

  **`JOURNAL_COLUMNS`:**

  | key | header | label | req | type | maxLength | inTemplate | synonyms | note | example |
  |---|---|---|---|---|---|---|---|---|---|
  | journalNumber | `JournalNumber` | Journal number | | text | 40 | ✓ | journal number, journal no, journal, entry number, entry no, journal id, reference, ref | Rows with the same number form one entry. Blank: rows with the same Date and Narration are grouped, as in Xero. The number only groups rows — the entry gets its own reference. | J-001 |
  | date | `*Date` | Date | ✓ | date | null | ✓ | date, journal date, entry date, transaction date | Every line of an entry must have the same date, in an open period. | 2026-06-30 |
  | narration | `*Narration` | Narration | ✓ | text | 500 | ✓ | narration, journal narration, memo, journal description | Every line of an entry must have the same narration. It becomes the entry's description. | June accruals |
  | accountCode | `*AccountCode` | Account code | ✓ | text | 20 | ✓ | account code, account, code, gl code, account number | Any postable account except receivable, payable and inventory control accounts. | 6100 |
  | debit | `Debit` | Debit | | money | null | ✓ | debit, dr, debit amount | Use Debit and Credit, or one signed Amount column. | 1200.00 |
  | credit | `Credit` | Credit | | money | null | ✓ | credit, cr, credit amount | Leave blank on a debit line. | |
  | amount | `Amount` | Signed amount | | signedMoney | null | ✗ | amount, line amount, net amount | Instead of Debit and Credit: positive is a debit, negative a credit. | 1200.00 |

  - missingMessages: `date` → `Could not find a date column in the file`; `narration` → `Could not find a narration column in the file`; `accountCode` → `Could not find an account code column in the file`; `debit`/`credit`/`amount` → `Could not find an amount column, or a debit/credit pair, in the file`.
  - `JOURNAL_EDIT_FIELDS`: every column, `text` input, `options: null`, `maxLength` copied, `nullable` true except `date`, `narration` and `accountCode`.

  ```ts
  /** 'N:' + upper(journalNumber) when set; else 'D:' + (ISO date value ?? raw date text) + '|' + lower(narration text).slice(0, 200). Null only when all three are blank. */
  export function journalGroupKey(values: Readonly<Record<string, string | number | null>>, raw: Readonly<Record<string, string>>): string | null;
  ```

  **`validateRows(client, orgId, rows)`.** Load once:
  - `dateFormat = rows[0] ? await importDateFormatForRowOnClient(client, orgId, rows[0].id) : 'ISO'`
  - `loadAccountsByCodeOnClient` for every account code
  - `listControlAccountsOnClient`
  - a per-date cache of `periodStatusOnClient`

  Group rows by `row.groupKey`; a row with a null key is its own group. The **group label** is `journal ${journalNumber}` when a number is set, else `journal dated ${date} "${narration}"`.

  Per row, in this order:
  1. `dataRowParseErrors`
  2. `Date is required`, `Narration is required`, `Account code is required` for the respective null values (skip when a parse error was already reported for that column)
  3. line side:
     - `amount !== null`: `amount === 0` → `A line needs a non-zero amount`
     - otherwise: both debit and credit > 0 → `A line has either a debit or a credit, not both`; neither > 0 → `A line needs a debit or a credit amount`
  4. `accountCodeError('AccountCode', code, account, ['Asset','Liability','Equity','Revenue','Expense'])`, then, when the account resolves, the control map's message for its id

  Per group, each message appended to **every** row in the group:
  1. group line count < 2 → `` `The ${label} has only one line — an entry needs at least two` ``
  2. number-grouped only: a row whose `date` differs from the first row's → **that row** gets `` `Date differs from row ${first.rowNumber} (${first.raw.date}) — every line of ${label} must match` ``; the same for `narration`
  3. when every row in the group has a resolved side, and the debits ≠ the credits (integer sums of cents; `amount` > 0 counts as a debit, < 0 as a credit of `-amount`) → `` `The ${label} does not balance: debits ${formatCents(d)}, credits ${formatCents(c)}` ``
  4. the group date parses, and `periodStatusOnClient` is `'CLOSED'` or `'LOCKED'` → `` `The fiscal period covering ${date} is ${status.toLowerCase()}; reopen it or change the date` ``

  **`preview`:**
  - `summary`: `[{label:'Journal entries to post', value:groups, format:'count'}, {label:'Lines', value:rows, format:'count'}, {label:'Total debits', value:sumDebits, format:'money'}]` over non-EXCLUDED rows
  - `warnings`: when `ledger_settings.books_start_date` (accounting's own table, `to_char(...,'YYYY-MM-DD')`) is set and any group date is earlier: `` `${n} journal(s) are dated before your conversion date (${d}) — they post into the period before it.` ``
  - legacy fields: 0, `''`, `null`, as the ITEMS preview sets them

  **`commitOnClient(client, orgId, importId, createdBy, _context)`:**
  - `loadDataRowsOnClient`, then group in first-row order (the same grouping)
  - resolve accounts
  - for each group, call `createEntryOnClient(client, orgId, createdBy, { entryDate: date, description: narration, sourceType: 'migration_import', sourceId: importId, lines })`, where each line is `{accountId, debitCents, creditCents}` with the signed amount split as above
  - wrap `ApiError`s as `` `The ${label} (rows ${first}–${last}): ${message}` ``
  - `markCommittedOnClient`
  - return `{ kind: 'JOURNALS', entryCount, lineCount }`
- **Guardrails:**
  - #7: one side per line, and each entry balances, checked here **and** by `createEntryOnClient` and the deferred trigger
  - #3: integer cents only
  - #5: on `client`
  - #1
  - the control-account refusal is enforced at validate time, and again at commit (revalidate-at-commit)
- **Proof:** `npm run typecheck` exits 0; the Step 1 proof list still passes.
- **Owes:** docs, in Step 7.

### Step 4 — [Sonnet] `JOURNALS` integration tests + bulk-status tests

- **Model:** [Sonnet]
- **Depends on:** 3
- **Skill:** isolation-test
- **Read first:** `__tests__/accounting/itemImport.test.ts` (setup and helpers) and one journal test (period close setup: `ls src/__tests__/accounting | grep -i period`).
- **Files:** `server/src/__tests__/accounting/journalImport.test.ts` (new)
- **Contract:** onboard each org with a past `booksStartDate` and generate fiscal periods as the existing period tests do. Write these tests, with these exact names:
  1. `rows sharing a JournalNumber stage as one balanced entry`: 3 rows J-1 (Dr 6100 1000.00; Cr 1110 600.00; Cr 1110 400.00) → `errorCount` 0; all three rows share a `groupKey`; the preview `summary` has entries 1, lines 3, total debits 100000.
  2. `without a JournalNumber, Date + Narration group rows (Xero-style)`: two entries of two rows each, told apart by narration → the preview says 2 entries.
  3. `a signed Amount column works instead of Debit/Credit`: `Amount 250` / `-250` → VALID.
  4. `an unbalanced journal flags every row in it`: the error `The journal J-2 does not balance: debits …, credits …` is on both rows.
  5. `a single-line journal is refused`.
  6. `mismatched dates within a numbered journal flag the differing row only`.
  7. `control accounts are refused at validation with the manual-journal message`: `AccountCode 1120` → the row error equals the exact receivable message `assertNotControlAccountsOnClient` throws (import `listControlAccountsOnClient` into the test or copy the literal text).
  8. `a closed period is a row error`: close the period covering the date through the fiscal-period API → contains `is closed; reopen it or change the date`.
  9. `commit posts one entry per group with source migration_import`:
     - the result equals `{kind:'JOURNALS', entryCount:2, lineCount:4}`
     - `GET /api/v1/journals` shows both entries with the narrations as descriptions
     - `GET /api/v1/journals/:id` has `sourceType 'migration_import'` and `sourceId` = the import id
     - the trial balance still balances (`GET /api/v1/reports/trial-balance`: total debits = total credits)
  10. `editing a JournalNumber regroups the row`: change the third row of a two-plus-one file from `J-9` to `J-1` through `PATCH {values:{journalNumber:'J-1'}}` → its `groupKey` equals the J-1 rows' key, and `GET rows` returns it adjacent to them.
  11. `bulk exclude drops a whole journal and revalidates`: an import with a valid J-1 and an unbalanced J-2 → `POST /:id/rows/status {rowIds: J-2 row ids, status:'EXCLUDED'}` → 200, the import is `VALIDATED`, and commit posts 1 entry.
  12. `bulk status: unknown row ids are 404, committed import is 409`.
  13. `more than 1000 journals is 422`: 1001 single-row groups with distinct numbers → 422 containing `1001 journals; one import takes at most 1000`.
  14. `revalidate at commit: a period closed after validation blocks commit`: validate, then close the period, then commit → 409 `became invalid since validation`; no entry is posted.
  15. `cross-tenant: org B's accounts don't resolve; org B cannot read, bulk-exclude or commit org A's import` → 404s.
- **Proof:** `npx vitest run src/__tests__/accounting/journalImport.test.ts` passes, then the full `npm test`, with 2 skipped.
- **Owes:** nothing.

## Slice 3 — Client

### Step 5 — [Sonnet] Client types, grouped review table, journal labels, guide, Import button, fixture

- **Model:** [Sonnet]. Per the 36b tiering correction, verbatim guide copy and fixture transcription go to Sonnet.
- **Depends on:** 3
- **Read first:**
  - `client/src/Pages/accounting/imports/ImportRowsTable.tsx`, `importGuides.ts`
  - `client/src/Pages/accounting/MigrationImportDetailPage.tsx`, `JournalsPage.tsx`, `JournalDetailPage.tsx`
  - `client/src/services/fetchServices.ts` (the migration-import block)
  - `__tests__/fixtures/importKinds.ts`
- **Files:** those, plus a `fetchServices.ts` wrapper for the bulk status route.
- **Contract:**
  - **`fetchServices.ts`:**
    - `MigrationImportKind` adds `'JOURNALS'`
    - `ImportColumnMeta.type` adds `'signedMoney'`
    - `ImportKindMeta` gains `groupHeaderFields: string[]`
    - `MigrationCommitResult` adds `{ kind: 'JOURNALS'; entryCount: number; lineCount: number }`
    - add:
      ```ts
      /** POST /migration-imports/:id/rows/status — OWNER, ADMIN or ACCOUNTANT. */
      export function setMigrationImportRowsStatus(id: string, body: { rowIds: string[]; status: 'VALID' | 'EXCLUDED' }): Promise<{ success: boolean; import: MigrationImport }>;
      ```
  - **`ImportRowsTable`:**
    - When `meta.groupHeaderFields.length > 0`, then before the first row of each run of consecutive rows sharing a `groupKey` (a null key is its own run), render one header `<tr>` whose single cell spans every column. The cell holds:
      - the non-empty `row.raw[field]` values of the run's first row for `groupHeaderFields`, joined with ` · `, in bold
      - ` — ${n} line(s)`
      - when not read-only, a ghost button: `Exclude` when any row in the run is not EXCLUDED, else `Include`, with `aria-label={\`${Exclude|Include} group ${headerText}\`}`
    - The button calls a new prop `onSetGroupStatus(rowIds: string[], status: 'VALID' | 'EXCLUDED')`.
    - The detail page implements that prop with `setMigrationImportRowsStatus`, then refreshes.
  - **Detail page committed card:** `JOURNALS` → `` `Committed: ${entryCount} journal entries posted (${lineCount} lines).` ``
  - **`JournalDetailPage`:** in the Source row, when `entry.sourceType === 'migration_import'`, render `Imported (CSV)`, with the `sourceId` as `<Link to={\`/migration-imports/${sourceId}\`}>view import</Link>`. Other sources are unchanged.
  - **`JournalsPage`:** wrap the `New entry` link in `<div className="flex items-center gap-2">` and add `<ImportButton kind="JOURNALS" returnTo="/journals" />` before it.
  - **`IMPORT_GUIDES.JOURNALS`:**
    - intro: `Post several journal entries at once — accruals, adjustments or year-to-date summaries.`
    - steps: the shared five
    - rules, verbatim:
      - `Rows with the same JournalNumber form one entry. Without a JournalNumber, rows with the same Date and Narration are grouped — the same way Xero does it.`
      - `Each entry needs at least two lines and must balance: total debits equal total credits.`
      - `Use Debit and Credit columns, or one signed Amount column (positive is a debit, negative a credit).`
      - `Receivable, payable and inventory control accounts are refused — use invoices, bills and Inventory for those so every balance stays traceable.`
      - `Every date must fall in an open period. Imported entries are marked "Imported" and are corrected by reversing them, like any posted entry.`
  - **`MIGRATION_STEPS`:** append after `stock`: `{key:'journals', label:'Other journals (optional)', hint:'Adjustments not covered by the steps above, such as accruals or year-to-date summaries.', to:'/migration-imports/new?kind=JOURNALS', kind:'JOURNALS'}`. Keep the existing Step D comment.
  - **Fixture:** add `groupHeaderFields: []` to the six existing entries, append `JOURNALS` transcribed from `server/src/services/accounting/importJournalColumns.ts` and its `importKinds.ts` entry, and add `'signedMoney'` where needed. **Transcribe notes and labels byte-for-byte.**
- **Proof:** `npm run typecheck` exits 0; `npm run lint` exits 0; `npx vitest run src/__tests__/journals.test.tsx src/__tests__/importWizard.test.tsx src/__tests__/migrationImport.test.tsx` passes, unedited except the fixture. Then run
  ```sh
  node -e "const f=require('fs');const s=f.readFileSync('src/__tests__/fixtures/importKinds.ts','utf8');const g=f.readFileSync('../server/src/services/accounting/importJournalColumns.ts','utf8');for(const m of g.matchAll(/note: '([^']+)'/g)){if(!s.includes(m[1]))console.log('MISSING:',m[1])}"
  ```
  from `client/`. It must print nothing (the byte-comparison proof from the 36b tiering correction). If the server file uses double-quoted strings, adapt the regex to them and say so.
- **Owes:** nothing.

### Step 6 — [Sonnet] Client tests

- **Depends on:** 5
- **Files:** `__tests__/migrationImport.test.tsx`, `__tests__/journals.test.tsx` (append only)
- **Contract:** add these tests, with these exact names:
  1. `grouped rows render one header per journal with its line count`
  2. `Exclude group sends every row id of that journal with status EXCLUDED`
  3. `a committed journal import shows entry and line counts`
  4. `an imported journal shows "Imported (CSV)" with a link to its import` (in `journals.test.tsx`, reusing its detail-page mock)
  5. `the Journals page has an Import button linking to the JOURNALS wizard`
- **Proof:** `npm test` passes (all), and `npm run typecheck` exits 0.

---

## Spine

### Step 7 — [Sonnet] Docs sync

- **Depends on:** 4, 6
- **Skill:** docs-sync
- **Files:**
  - `docs/api.md` § Migration imports: the JOURNALS kind with its columns, grouping, validation and failure paths; `POST /:id/rows/status`; `groupHeaderFields`; `signedMoney`; the 1000-document 422; the grouped row ordering; the JOURNALS result
  - `docs/api.md` § journals: `source_type 'migration_import'`
  - `docs/accounting.md` § Phase 36: 36c as delivered
  - `docs/roadmap.md`: 36c as delivered, with this plan's defect log; state that no migration was needed; imported journals cannot become recurring templates (`recurringService` accepts `'manual'` only)
  - `CLAUDE.md`: extend the bullet to 36a–c, kept short

### Step 8 — [Sonnet] Study notes

- **Depends on:** 4, 6
- **Skill:** study-note
- **Files:**
  - extend `study/architecture/staged-import-and-two-phase-commit.md`: grouped documents from flat rows; group keys derived and re-derived on edit; group-level vs row-level errors; Xero's Date+Narration grouping as an implicit key and its collision risk; why a document cap exists
  - extend `study/postgresql/window-functions-and-running-totals.md`: `MIN(row_number) OVER (PARTITION BY …)` as a sort key that keeps groups together
  - extend `study/architecture/double-entry-as-an-invariant.md`: validating balance before posting vs relying on the deferred trigger; one refusal map shared by the manual path and the import path
  - update `study/README.md`

### Step 9 — [Sonnet] Guardrail review + full verification

- **Depends on:** 7, 8
- **Skill:** guardrail-review
- **Proof:** `cd server && npm run typecheck && npm run lint && npm test && npm run verify:integrity`; `cd client && npm run typecheck && npm run lint && npm test`. All green and zero violations; check rule 7 especially (journal lines and balance) and rule 4 (the ORDER BY constants). Then set `Status: done`.

---

## Dispatch manifest

| Batch | Step | Tier | Title | Depends on | Blocks | Status |
|---|---|---|---|---|---|---|
| A | 1 | Sonnet | Grouped-kind machinery + bulk status + signedMoney | — | 2 | done |
| A | 2 | Sonnet | Control-account map + period status | 1 | 3 | done |
| A | 3 | Sonnet | `JOURNALS` columns, service, registry | 2 | 4, 5 | done |
| A | 4 | Sonnet | `JOURNALS` + bulk-status integration tests | 3 | 7, 8 | done |
| A | 5 | Sonnet | Client: grouped table, labels, guide, button, fixture | 3 | 6 | done |
| A | 6 | Sonnet | Client tests | 5 | 7, 8 | done |
| A | 7 | Sonnet | Docs sync | 4, 6 | 9 | done |
| A | 8 | Sonnet | Study notes | 4, 6 | 9 | done |
| A | 9 | Sonnet | Guardrail review + verification | 7, 8 | — | done |

Every step is Sonnet: 36c is almost entirely judgment (group semantics, double-entry validation, a guard refactor). The one transcription-shaped piece, the fixture, follows the 36b tiering correction.
- Steps 4 and 5 may run in parallel once 3 is done: Step 4 runs only server vitest (Docker Postgres), Step 5 only client vitest (jsdom), so their test runs cannot collide.
- Steps 7 and 8 may run in parallel.

**Escalations:** none yet.

**Plan defects found during execution:**
- Step 2: the contract said to throw on the first control-map entry present in the lines (map order). That would change which inventory account is named when a journal has several. Runner kept today's behaviour exactly: receivable, then payable, then the remaining ids in line order. Accepted — messages and precedence byte-identical; codes now fetched in one query.
- Step 4: its runner lost Bash to a classifier outage after the new file passed (16/16); the orchestrator ran the full proof itself: 1834 passed | 2 skipped, typecheck and lint clean. A 200-two-line-journal commit test passes inside a 12.5 s file; exact timing not captured, 1000 entries unmeasured.
- Step 1: `patchRow` recomputes `group_key` only when `values` is sent (the only edit that can change it). Accepted.

## Risks & open questions

- **Date + Narration grouping cannot tell two different entries apart** when they share both the date and the narration; the import merges them into one. The guide recommends `JournalNumber` for exactly this reason. Mention it in the docs.
- **The group key truncates the narration to 200 characters.** Two narrations identical in their first 200 characters on the same date group together. Negligible.
- **A 1000-entry commit posts 1000 entries in one transaction** with per-entry period and account checks. It has not been timed; measure it in Step 4 if cheap, and otherwise note it as unmeasured.
- **Imported journals are not recurring templates** (`source_type` is not `'manual'`). This is deliberate, and documented.
- **The row listing orders by a window function over the whole import** (up to 5000 rows): an O(n log n) sort per page request. Acceptable at this cap.

## Definition of done

- Server and client typecheck, lint and tests are green; `verify:integrity` is clean; guardrail-review is clean; every earlier test is unedited except the approved fixture.
- Docs and study notes are updated.
- In the running app: Journals → Import → a Xero manual-journal export (no number column) maps, groups by Date + Narration, previews its entry count, and posts entries that open as "Imported (CSV)".
