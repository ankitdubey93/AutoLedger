# Phase 36b — CSV import: products & services, inventory items with opening stock

Date: 2026-09-30 · **Status: done — 36b landed (uncommitted)** · Approved design: `/home/ankit/.claude/plans/csv-importer-throughout-the-abundant-cookie.md` (Phase 36, Step B) · Builds on 36a (`plans/phase-36a-import-foundation.md`, committed `d2f04a4` on branch `phase-36-csv-import`).

Step B adds the first two **JSONB-staged** import kinds:
- **`ITEMS`** covers Products & Services, of type SERVICE or NON_INVENTORY. An unknown code is created; a known code only has its blank fields filled.
- **`INVENTORY_ITEMS`** creates tracked stock items, together with their linked product and, optionally, their opening stock. It is create-only.

B also delivers the generic machinery every later kind needs:
- typed cell parsing
- `data`/`values` rows and `PATCH {values}`
- `dateFormat`, with inspect's date-format suggestion
- a pre-transaction commit hook
- revalidate-at-commit
- a summary-based preview

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

## Starting state (verified 2026-09-30, after 36a)

**Server, import machinery (36a):**
- `services/accounting/importKinds.ts`:
  - `ImportKindDef extends ImportKindMeta` with `parseRow`, `validateRows`, `preview` and `commitOnClient(client, orgId, importId, createdBy) → MigrationCommitResult`
  - `IMPORT_KINDS … satisfies Record<MigrationImportKind, ImportKindDef>`
  - `getImportKind`, `listImportKindMeta`
- `services/accounting/importRowParsers.ts`: `StagedRowInput`, `ResolvedImportColumns`, and the legacy parsers.
- `utils/importColumns.ts`: `compactHeader`, `resolveColumnIndexes`, `findMissingRequired`.
- `services/accounting/migrationImportService.ts`:
  - `createImport`, which runs `parseAndResolve` and inserts the typed columns through `unnest`
  - `revalidateOnClient`, the batched update
  - `patchRow`, driven by the frozen `COLUMNS` map
  - `inspectImport`
  - `commit`, which runs `FOR UPDATE` then `getImportKind(kind).commitOnClient`, then `UPDATE … SET result`
- `types/accounting.ts`: `MIGRATION_IMPORT_KINDS` (4), `ImportColumnDef`, `ImportEditFieldDef` (`input: 'text'|'money'|'accountType'`), `ImportKindMeta`, `MigrationImportInspection`, `MigrationCommitResult`, and `MigrationImport`/`MigrationImportRow`/`MigrationCommitPreview`.
- Migration 078 already admits `ITEMS` and `INVENTORY_ITEMS` in `chk_migration_imports_kind`. `migration_import_rows.data JSONB` and `.group_key`, and `migration_imports.options JSONB NOT NULL DEFAULT '{}'`, all exist. **No migration is needed in 36b.**
- `schemas/accounting/migrationImportSchema.ts`: `createMigrationImportSchema` (with `columnMap`), `inspectMigrationImportSchema`, `patchMigrationRowSchema` (legacy keys only).

**Server, domain:**
- `services/accounting/itemService.ts`:
  - `createItem(orgId, createdBy, input: CreateItemInput)` (L212) wraps `withTransaction`; inside it are `assertAccount(client, orgId, id, 'Revenue'|'Expense'|'Asset')` (L190, a module-private function) and the INSERT
  - item types come from `items.item_type`: SERVICE, NON_INVENTORY, INVENTORY, FIXED_ASSET
  - `code` is unique per org (23505 → 409 'Item code already exists')
- `services/inventory/itemService.ts`:
  - `createItem(orgId, userId, input: CreateStockItemInput)` (L395) calls `suggestedProfileFor(orgId)` before its transaction; that read goes through the pool and accounting's `settingsService`
  - inside the transaction: `ensureInventoryReadyOnClient` (default category and location), `insertStockItemOnClient`, `ledgerItemService.createLinkedItemOnClient`, and `postOpeningOnClient` (QUANTITY tracking only, through `receiveManualOnClient` with purpose OPENING; `assertNotFuture` on the date)
  - a unique violation goes through `uniqueViolationToApiError` (module-private)
- `services/inventory/documentStockService.ts` is **the only inventory module accounting may import** (rule 16). `services/accounting/{invoiceService,billService,inventoryAccountingService,documentStockLines}.ts` already import it.
- Tables:
  - `stock_categories`: `code ^[A-Z0-9]{2,10}$`, `name`, `default_tracking` (`QUANTITY|LOT|SERIAL`), `default_uom_id`, `is_active`
  - `stock_uoms`: `code ^[A-Z0-9]{1,10}$`, `name`, `decimal_places`, `is_active`
  - `stock_locations`: `code`, `name`, `is_active`
  - `stock_settings`: `default_location_id`
  - `accounts`: `code`, `type`, `is_postable`, `is_active`
  - `ledger_settings`: `books_start_date`
- Utilities: `utils/gtin.ts` → `isValidGtin`; `utils/stockCodePattern.ts` → `ITEM_CODE_REGEX = /^[A-Z0-9][A-Z0-9\-_/.]{0,39}$/`; `utils/dateParse.ts` → `DATE_FORMATS`, `DateFormat`, `parseFlexibleDate(raw, format): string | null`; `utils/money.ts` → `parseMoneyText(raw): number` (throws on garbage, may return a negative).

**Client (36a):**
- Under `Pages/accounting/imports/`: `ColumnMapper.tsx` (with `mappingProblems`), `ImportRowsTable.tsx`, `ImportGuidePanel.tsx`, `importGuides.ts` (`IMPORT_GUIDES`, `MIGRATION_STEPS`), `useImportKinds.ts`.
- `Pages/accounting/NewMigrationImportPage.tsx` (the wizard), `MigrationImportDetailPage.tsx` and `MigrationImportsPage.tsx`.
- `components/imports/ImportButton.tsx`.
- `__tests__/fixtures/importKinds.ts` (`IMPORT_KINDS_FIXTURE`), `__tests__/importWizard.test.tsx`, `__tests__/migrationImport.test.tsx`.
- `Pages/products/ProductsPage.tsx`: the header at ~L150 has a lone "New product or service" button.
- `Pages/inventory/InventoryItemsPage.tsx`: the `PageHeader actions` at ~L108, with `canWrite` already computed through `useAuth`. No test file renders it, and `products.test.tsx` has no page-wide link query.

**Test counts:** 1781 server tests passed (2 skipped); 509 client tests passed.

## Gate

- Phase 36, step B. 36a is committed.
- Phases 24, 28, 32 and 35a (products, inventory, linking, inventory accounts) are built.
- Nothing is gated. No new dependency, no migration.

## Execution rules

**If a proof command fails twice on the same step, stop and report. Do not improvise around it.**

| Symptom | Forbidden | Correct |
|---|---|---|
| Test fails | Weakening or deleting the assertion | Fix the code; the test is the spec |
| A 36a or legacy import test fails | Editing it | Fix the change. `chartImport`, `openingBalanceImport`, `partyImport`, `importMapping`, `importColumns` and `migrationImportConstraints` are the regression gate |
| Type error | `as any`, `@ts-ignore` | Fix the type |
| Query returns no rows | Dropping `org_id` | Fix the fixture (rule 1) |
| Accounting code wants an inventory table | A direct `stock_*` query from `services/accounting/**` | Go through `documentStockService.ts` (rule 16) |
| Need a library | `npm install` | Stop (rule 14) |
| A `[Haiku]` step fails its proof twice | Retrying or trimming | Escalate unchanged to `[Sonnet]`, and note it under the manifest |
| The step needs an undecided choice | Deciding it | Stop and report |

Direct SQL goes through `docker exec autodb_postgres psql -U autodb_user -d autodb -c '...'`. Docker services come up with `docker compose up -d postgres postgres-test redis` from the repo root. Server commands run from `server/`, client commands from `client/`. **Client imports are extensionless** (no `.js`); server imports carry `.js`.

**Anything the plan did not anticipate is a stop-and-report, not a judgment call.**

---

## Slice 1 — Server: generic JSONB-kind machinery

Outcome: a kind can declare `storage: 'data'`. Its rows are parsed through typed cell parsers into `migration_import_rows.data`, edited through `PATCH {values}`, re-validated at commit, and previewed through a generic `summary`. No new kind yet.

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| Pure util | `server/src/utils/importValues.ts` → `ImportCellType`, `ParsedCell`, `parsePercentBp`, `parseQuantityMilli`, `parseImportCell`, `suggestDateFormat` |
| Row-store helpers | `server/src/services/accounting/importRowStore.ts` → `DataRow`, `loadDataRowsOnClient`, `markCommittedOnClient` |
| Types (`types/accounting.ts`) | `ImportStorage`, `ImportCommitContext`, `PreviewSummaryItem`; new fields on `ImportColumnDef`, `ImportEditFieldDef`, `ImportKindMeta`, `MigrationImport`, `MigrationImportRow`, `MigrationCommitPreview`, `MigrationImportInspection` |
| Unit test | `server/src/__tests__/importValues.test.ts` |

### Step 1 — [Haiku] `importValues.ts` + unit tests

- **Model:** [Haiku]. Pure functions whose behaviour is written out below.
- **Depends on:** —
- **Skill:** none
- **Read first:** `server/src/utils/importColumns.ts` (house style) and `server/src/utils/dateParse.ts` (the `DateFormat` type and `parseFlexibleDate`).
- **Files:** `server/src/utils/importValues.ts` (new), `server/src/__tests__/importValues.test.ts` (new)
- **Contract:**
  ```ts
  import { parseMoneyText } from './money.js';
  import { parseFlexibleDate, type DateFormat } from './dateParse.js';

  export type ImportCellType = 'text' | 'money' | 'percent' | 'quantity' | 'date' | 'enum';
  export type ParsedCell = { ok: true; value: string | number | null } | { ok: false; error: string };

  /** Structural subset of ImportColumnDef this module needs (keeps utils free of types/accounting). */
  export interface CellSpec {
    label: string;
    type: ImportCellType;
    maxLength: number | null;
    /** lowercase alias -> canonical value; enum only. */
    enumAliases: Readonly<Record<string, string>> | null;
    /** What to show in the error, e.g. ['Service', 'Non-inventory']; enum only. */
    enumLabels: readonly string[] | null;
  }

  /** '10' '10%' '12.5 %' 'GST on Income (15%)' -> bp; zero words -> 0; else null. Max 2 decimals, 0..10000 bp. Integer arithmetic only. */
  export function parsePercentBp(text: string): number | null;
  /** '12' '12.5' '1,250.125' -> milli-units (int). Max 3 decimals, 0..1_000_000_000. Negative/garbage -> null. Integer arithmetic only. */
  export function parseQuantityMilli(text: string): number | null;
  export function parseImportCell(spec: CellSpec, text: string, dateFormat: DateFormat): ParsedCell;
  /** Given non-empty date cell texts: all /^\d{4}-\d{2}-\d{2}$/ (or none given) -> 'ISO'; any d/m/y-shaped value whose first part > 12 -> 'DMY'; else any whose second part > 12 -> 'MDY'; else null (ambiguous). Separators / - . */
  export function suggestDateFormat(samples: readonly string[]): DateFormat | null;
  ```
  **`parsePercentBp`**
  - Trim and lowercase.
  - These zero words return `0`: `exempt`, `tax exempt`, `no tax`, `none`, `zero rated`, `zero-rated`, `n/a`. So does any text containing `exempt`.
  - Otherwise try `/(\d+)(?:\.(\d{1,2}))?\s*%/` anywhere in the text, then `/^(\d+)(?:\.(\d{1,2}))?$/` on the whole text.
  - `bp = Number(int) * 100 + Number((frac ?? '').padEnd(2, '0'))`.
  - Above 10000, or no match → `null`.

  **`parseQuantityMilli`**
  - Trim, then remove commas only when the text matches `/^\d{1,3}(,\d{3})+(\.\d+)?$/`.
  - Then require `/^(\d+)(?:\.(\d{1,3}))?$/`.
  - `milli = int * 1000 + Number(frac.padEnd(3, '0'))`.
  - Above 1_000_000_000 → `null`.

  **`parseImportCell`** trims the text; an empty result gives `{ ok: true, value: null }` for every type. Otherwise, by type:
  - `text`: when `maxLength !== null && length > maxLength` the error is `` `${label} is longer than ${maxLength} characters` ``; otherwise the value is the trimmed text.
  - `money`: try `parseMoneyText`. If it throws, the error is `` `${label} "${text}" is not an amount` ``. A negative result gives `` `${label} cannot be negative` ``.
  - `percent`: a null result gives `` `${label} "${text}" is not a percentage like 10 or 12.5%` ``.
  - `quantity`: a null result gives `` `${label} "${text}" is not a quantity (up to 3 decimal places)` ``.
  - `date`: a null result gives `` `${label} "${text}" is not a date in ${FORMAT_HINT[dateFormat]} format` ``, where `FORMAT_HINT = { ISO: 'YYYY-MM-DD', DMY: 'DD/MM/YYYY', MDY: 'MM/DD/YYYY' }`.
  - `enum`: `enumAliases?.[text.toLowerCase()]`; when it is undefined the error is `` `${label} "${text}" must be one of: ${(enumLabels ?? []).join(', ')}` ``.

  Test cases, with these exact names:
  1. `percent: plain, suffixed and embedded` covers `'10'` → 1000, `'12.5%'` → 1250, `'GST on Income (15%)'` → 1500 and `'0'` → 0.
  2. `percent: exempt words are zero` covers `'Tax Exempt'` → 0.
  3. `percent: rejects garbage, 3 decimals and >100%` covers `'abc'`, `'10.125'` and `'101'`, each → null.
  4. `quantity: integers, decimals, thousands` covers `'12'` → 12000, `'0.5'` → 500 and `'1,250.125'` → 1250125.
  5. `quantity: rejects negative and 4 decimals` covers `'-1'` and `'1.2345'`, each → null.
  6. `cell: empty is null for every type`.
  7. `cell: money negative is an error` expects the exact message.
  8. `cell: enum maps aliases and lists labels on failure`.
  9. `cell: text over maxLength is an error`.
  10. `cell: date in DMY` covers `'31/01/2026'` → `'2026-01-31'`.
  11. `suggestDateFormat` covers `['2026-01-31']` → 'ISO', `['31/01/2026']` → 'DMY', `['01/31/2026']` → 'MDY', `['01/02/2026']` → null and `[]` → 'ISO'.
- **Guardrails:** #3: no float arithmetic on amounts; build bp and milli from the digit strings.
- **Proof:** `npx vitest run src/__tests__/importValues.test.ts` passes, and `npm run typecheck` exits 0.
- **If it fails:** fix the function, never the expected values.
- **Owes:** nothing.

### Step 2 — [Sonnet] Types, row store, and the generic data-kind path in the service

- **Model:** [Sonnet]. Transaction boundaries, the commit hook and staging SQL.
- **Depends on:** 1
- **Skill:** none (service edit)
- **Read first:** `migrationImportService.ts` in full, `importKinds.ts` in full, and `importRowParsers.ts` (`StagedRowInput`).
- **Files:**
  - `types/accounting.ts` (edit)
  - `services/accounting/importRowStore.ts` (new)
  - `services/accounting/importRowParsers.ts` (edit)
  - `services/accounting/importKinds.ts` (edit)
  - `services/accounting/migrationImportService.ts` (edit)
  - `schemas/accounting/migrationImportSchema.ts` (edit)
  - `controllers/accounting/migrationImportController.ts` (edit, the `patchRow` handler only, if its call shape changes)
- **Contract:**

  **(a) Types.** Add these, and extend the existing interfaces as listed below:
  ```ts
  export type ImportStorage = 'typed' | 'data';
  export interface PreviewSummaryItem { label: string; value: number; format: 'count' | 'money' }
  /** Built before BEGIN by the kind's prepareCommit (pool reads allowed there), passed into commitOnClient. */
  export interface ImportCommitContext { inventoryProfile: string | null }
  ```
  - `ImportColumnDef` gains:
    - `type: ImportCellType` (imported as a type from `../utils/importValues.js`)
    - `maxLength: number | null`
    - `enumAliases: Readonly<Record<string, string>> | null`
    - `enumLabels: readonly string[] | null`
  - `ImportEditFieldDef.input` becomes `'text' | 'money' | 'accountType' | 'enum'`, and the def gains `options: readonly string[] | null` (the enum select's written values, e.g. `['Service', 'Non-inventory']`).
  - `ImportKindMeta` gains `storage: ImportStorage`.
  - `MigrationImport` gains `dateFormat: DateFormat`, read from `options->>'dateFormat'` and defaulting to `'ISO'`.
  - `MigrationImportRow` gains `values: Record<string, string | number | null>` (`data ?? {}`) and `groupKey: string | null`.
  - `MigrationCommitPreview` gains `summary: PreviewSummaryItem[]` and `warnings: string[]`.
  - `MigrationImportInspection` gains `suggestedDateFormat: DateFormat | null`.

  **(b) Legacy registry entries** (`importKinds.ts`). Every existing column gets `type: 'text', maxLength: null, enumAliases: null, enumLabels: null`. Every existing edit field gets `options: null`. Each of the four kinds gets `storage: 'typed'`. Each legacy `preview` wrapper spreads the service result and adds `summary: [], warnings: []`. Behaviour must not change.

  **(c) `ImportKindDef`** changes to:
  ```ts
  export interface ImportKindDef extends ImportKindMeta {
    parseRow(cells: readonly string[], columns: ResolvedImportColumns, rowNumber: number, ctx: { dateFormat: DateFormat }): StagedRowInput;
    validateRows(client: PoolClient, orgId: string, rows: readonly MigrationImportRow[]): Promise<{ rowId: string; errors: string[] }[]>;
    preview(client: PoolClient, orgId: string, importId: string): Promise<MigrationCommitPreview>;
    /** Optional; runs BEFORE BEGIN. Default: { inventoryProfile: null }. */
    prepareCommit?: (orgId: string) => Promise<ImportCommitContext>;
    commitOnClient(client: PoolClient, orgId: string, importId: string, createdBy: string, context: ImportCommitContext): Promise<MigrationCommitResult>;
  }
  ```
  The legacy wrappers accept and ignore `ctx` and `context`.

  **(d) `StagedRowInput`** gains `data: Record<string, string | number | null> | null` and `groupKey: string | null`. The legacy parsers set both to `null`. Add an export to `importRowParsers.ts`:
  ```ts
  /** Generic parser for storage:'data' kinds: raw[key] = trimmed cell text; data[key] = parsed value (null on '' or parse failure). */
  export function parseDataRow(columns: readonly ImportColumnDef[], cells: readonly string[], resolved: ResolvedImportColumns, rowNumber: number, dateFormat: DateFormat): StagedRowInput;
  /** Parse errors for one data row, in column order: for each column whose raw text is non-empty and whose parseImportCell result is not ok, its error. */
  export function dataRowParseErrors(columns: readonly ImportColumnDef[], raw: Readonly<Record<string, string>>, dateFormat: DateFormat): string[];
  ```

  **(e) `importRowStore.ts`**
  ```ts
  export interface DataRow { id: string; rowNumber: number; values: Record<string, string | number | null>; raw: Record<string, string> }
  /** Non-EXCLUDED (status <> 'EXCLUDED') rows of the import, ordered by row_number. */
  export async function loadDataRowsOnClient(client: PoolClient, orgId: string, importId: string): Promise<DataRow[]>;
  /** UPDATE migration_imports SET status = 'COMMITTED', committed_at = now() WHERE id = $1 AND org_id = $2 */
  export async function markCommittedOnClient(client: PoolClient, orgId: string, importId: string): Promise<void>;
  /** SELECT options->>'dateFormat' ...; returns 'ISO' when absent or not one of DATE_FORMATS. */
  export async function importDateFormatOnClient(client: PoolClient, orgId: string, importId: string): Promise<DateFormat>;
  ```

  **(f) `migrationImportService.ts`:**
  - `ROW_COLUMNS` adds `data, group_key`; `RowRow` and `toRow` map `values: row.data ?? {}` and `groupKey: row.group_key`.
  - `IMPORT_SELECT` adds `COALESCE(i.options->>'dateFormat', 'ISO') AS date_format`; `toImport` maps it, narrowing with `isDateFormat`.
  - `createImport` input gains `dateFormat: DateFormat`. It passes `{ dateFormat }` to `def.parseRow`, inserts `options = jsonb_build_object('dateFormat', $8::text)`, and inserts `data` and `group_key` through two more unnest arrays: `$19::text[]` holds JSON strings, cast per element with `v.data::jsonb`, and `$20::text[]`.
  - `inspectImport`: when `def.columns` has any `type === 'date'`, collect the non-empty trimmed cells of every resolved date column over **all** rows, and set `suggestedDateFormat = suggestDateFormat(samples)`; otherwise `null`.
  - `patchRow` input gains `values?: Record<string, string | null>`. Load `kind` alongside `status` in its first SELECT, then apply these rules:
    - storage `'data'` with any legacy key present → `ApiError(400, 'Edit this import with "values"')`
    - storage `'typed'` with `values` present → `ApiError(400, 'This import kind does not take "values"')`
    - a `values` key that is not a column key → `ApiError(400, \`Unknown field "${key}"\`)`
    - otherwise: `dateFormat = await importDateFormatOnClient(...)`; for each key, `rawPatch[key] = text ?? ''` and `dataPatch[key] = parseImportCell(col, text ?? '', dateFormat)` → its value, or `null` when not ok; then
      ```sql
      UPDATE migration_import_rows SET data = COALESCE(data, '{}'::jsonb) || $1::jsonb, raw = raw || $2::jsonb [, status = $n] WHERE id = $a AND org_id = $b AND import_id = $c RETURNING id
      ```
      `status` is still allowed together with `values`.
  - `commit`:
    1. Before `pool.connect()`, read the kind: `const kindRow = await getImportById(orgId, importId)`, which gives 404 when missing.
    2. `const context = (await def.prepareCommit?.(orgId)) ?? { inventoryProfile: null }`.
    3. Inside the transaction, after the `FOR UPDATE` checks, **if `locked.kind !== kindRow.kind` throw `Error('import kind changed')`**. Unreachable, since kind is immutable, but it fails loudly.
    4. For `storage === 'data'` kinds only, **revalidate at commit**: load the non-EXCLUDED rows with `ROW_COLUMNS`, run `def.validateRows`, and if any row has errors throw `ApiError(409, \`${n} row(s) became invalid since validation — re-validate to see them\`)`.
    5. Call `def.commitOnClient(client, orgId, importId, createdBy, context)`.
    6. The rest is unchanged.
  - `revalidateOnClient` is unchanged. Each data kind's own `validateRows` must include `dataRowParseErrors`.

  **(g) Schemas:**
  - `createMigrationImportSchema` gains `dateFormat: z.enum(DATE_FORMATS).default('ISO')`.
  - `patchMigrationRowSchema` gains `values: z.record(z.string().min(1).max(64), z.string().max(1000).nullable()).optional()`.
  - Keep the existing refines. `values` counts as a field for "No fields to update".
- **Guardrails:**
  - #5: `prepareCommit` is the **only** pool read in commit's flow, and it runs before BEGIN
  - #4: `values` keys never reach SQL; they go into JSON parameters
  - #1: every new statement carries `org_id`
- **Proof:** `npm run typecheck` exits 0, then `npx vitest run src/__tests__/accounting/chartImport.test.ts src/__tests__/accounting/openingBalanceImport.test.ts src/__tests__/accounting/partyImport.test.ts src/__tests__/accounting/importMapping.test.ts src/__tests__/accounting/migrationImportConstraints.test.ts src/__tests__/importColumns.test.ts src/__tests__/importValues.test.ts` passes, with every file unedited.
- **If it fails:** fix the service; legacy behaviour must not move.
- **Owes:** the study note, in Step 11 (the pre-transaction hook, revalidate-at-commit).

---

## Slice 2 — Server: the `ITEMS` kind (Products & Services)

Outcome: a Products & Services CSV stages and validates against the org's accounts and products. Commit creates new products and fills blank fields on existing ones, in one transaction.

**Names:**

| Kind | Name |
|---|---|
| Kind | `ITEMS` (appended to `MIGRATION_IMPORT_KINDS`) |
| Service | `server/src/services/accounting/itemImportService.ts` → `validateRows`, `preview`, `commitOnClient` |
| Item service exports (new) | `createItemOnClient`, `fillMissingItemFieldsOnClient`, `findItemsByCodesOnClient` in `accounting/itemService.ts` |
| Account lookup (new, shared) | `server/src/services/accounting/importAccountLookup.ts` → `ImportAccount`, `loadAccountsByCodeOnClient`, `accountCodeError` |
| Result | `{ kind: 'ITEMS'; createdCount: number; mergedCount: number }` |
| Test | `server/src/__tests__/accounting/itemImport.test.ts` |

### Step 3 — [Sonnet] Item-service extractions + account lookup

- **Model:** [Sonnet]. It refactors a live create path.
- **Depends on:** 2
- **Read first:** `accounting/itemService.ts` L180-255.
- **Files:** `services/accounting/itemService.ts` (edit), `services/accounting/importAccountLookup.ts` (new)
- **Contract:**
  ```ts
  // itemService.ts
  /** The body of createItem's transaction, on the caller's client. Same checks, same INSERT, same 422s; 23505 is left to the caller. */
  export async function createItemOnClient(client: PoolClient, orgId: string, createdBy: string, input: CreateItemInput): Promise<Item>;
  /** Fills ONLY currently-NULL columns: description, sale_price_cents, purchase_price_cents, revenue_account_id, expense_account_id (COALESCE(col, $n)). Name, type and tax rates are never touched. */
  export async function fillMissingItemFieldsOnClient(client: PoolClient, orgId: string, itemId: string, fields: {
    description: string | null; salePriceCents: number | null; purchasePriceCents: number | null;
    revenueAccountId: string | null; expenseAccountId: string | null;
  }): Promise<void>;
  /** SELECT id, code, item_type, is_active ... WHERE org_id = $1 AND code = ANY($2::text[]) — exact code match. */
  export async function findItemsByCodesOnClient(client: PoolClient, orgId: string, codes: readonly string[]): Promise<Map<string, { id: string; itemType: ItemType; isActive: boolean }>>;
  ```
  - `createItem` keeps its stock-managed 422 and its 23505 → 409 mapping, and its transaction body becomes `createItemOnClient`.
  - `fillMissingItemFieldsOnClient` runs `assertAccount` for each non-null account id first (Revenue for `revenueAccountId`, Expense for `expenseAccountId`).
  ```ts
  // importAccountLookup.ts
  export interface ImportAccount { id: string; code: string; type: AccountType; isPostable: boolean; isActive: boolean }
  /** SELECT id, code, type, is_postable, is_active FROM accounts WHERE org_id = $1 AND code = ANY($2::text[]) */
  export async function loadAccountsByCodeOnClient(client: PoolClient, orgId: string, codes: readonly string[]): Promise<Map<string, ImportAccount>>;
  /** null when ok; else exactly one of:
   *  `${label} "${code}" was not found`
   *  `${label} "${code}" must be a ${wantTypes.join(' or ')} account`
   *  `${label} "${code}" is a header account and cannot be posted to`
   *  `${label} "${code}" is inactive` */
  export function accountCodeError(label: string, code: string, account: ImportAccount | undefined, wantTypes: readonly AccountType[]): string | null;
  ```
- **Guardrails:** #1 and #4: `code = ANY($2::text[])` is parameterized; #5: all on `client`.
- **Proof:** `npm run typecheck` exits 0, and `npx vitest run src/__tests__/accounting/items.test.ts` passes. If that file does not exist, run `ls src/__tests__/accounting | grep -i item` and use each of the item test files it lists.
- **If it fails:** fix the extraction; existing item tests are unedited.
- **Owes:** nothing.

### Step 4 — [Sonnet] `ITEMS` registry entry + `itemImportService`

- **Model:** [Sonnet]. Validation rules and merge semantics.
- **Depends on:** 3
- **Read first:** `partyImportService.ts` (the merge-vs-create preview and commit shape to mirror) and the Step 2 row store.
- **Files:** `types/accounting.ts` (append `'ITEMS'` to `MIGRATION_IMPORT_KINDS`; add the result union member), `services/accounting/itemImportService.ts` (new), `services/accounting/importKinds.ts` (add the entry)
- **Contract:**

  **Registry entry `ITEMS`** — label `Products & services`, noun `products`, storage `data`, requiredOneOf `[]`, and `parseRow` = `parseDataRow(IMPORT_KINDS.ITEMS.columns, …)` (define the columns array as a const first, to avoid self-reference).

  | key | header | label | req | type | maxLength | synonyms | note | example |
  |---|---|---|---|---|---|---|---|---|
  | itemCode | `*ItemCode` | Item code | ✓ | text | 40 | code, item code, sku, product code, item | Up to 40 characters. A code that already exists only has its blank fields filled — nothing is overwritten. | CONSULT-HR |
  | itemName | `*ItemName` | Name | ✓ | text | 200 | name, item name, product name, product, service | Up to 200 characters. | Consulting (hourly) |
  | itemType | `Type` | Type | | enum | null | type, item type, product type, kind | Service or Non-inventory. Blank: an existing product keeps its type; a new one is Non-inventory when it has a purchase price or purchases account, otherwise Service. Tracked stock is imported under Inventory. | Service |
  | description | `Description` | Description | | text | 500 | description, sales description, long description | Up to 500 characters. | Senior consultant, per hour |
  | salePrice | `SalesUnitPrice` | Sale price | | money | null | sales unit price, sale price, sales price, price, unit price, rate, selling price | Excluding tax. | 150.00 |
  | salesAccount | `SalesAccount` | Sales account | | text | 20 | sales account, income account, revenue account | A Revenue account code. | 4100 |
  | salesTaxRate | `SalesTaxRate` | Sales tax % | | percent | null | sales tax rate, tax rate, sales tax, tax | A percentage such as 10 or 12.5%. Blank is 0. | 10 |
  | purchasePrice | `PurchasesUnitPrice` | Purchase price | | money | null | purchases unit price, purchase price, cost, unit cost, purchase cost | Excluding tax. | |
  | purchasesAccount | `PurchasesAccount` | Purchases account | | text | 20 | purchases account, purchase account, expense account, cost account | An Expense account code. | |
  | purchasesTaxRate | `PurchasesTaxRate` | Purchase tax % | | percent | null | purchases tax rate, purchase tax rate, purchase tax | A percentage. Blank is 0. | |

  - `itemType` enum:
    - aliases: `service`, `services` → `SERVICE`
    - aliases: `non-inventory`, `non inventory`, `noninventory`, `non-stock`, `non stock`, `goods`, `product` → `NON_INVENTORY`
    - aliases: `inventory`, `stock`, `tracked`, `inventory item` → `INVENTORY`
    - enumLabels `['Service', 'Non-inventory']`
  - missingMessages: `itemCode` → `Could not find an item code column in the file`, `itemName` → `Could not find an item name column in the file`.
  - editFields: every column, in order. Inputs are `text`, except `itemType`, which is `enum` with `options: ['Service', 'Non-inventory']`; `maxLength` copies the column's; `nullable` is true, except `itemCode` and `itemName`.

  **`validateRows(client, orgId, rows)`.** Load everything in one pass: `dateFormat` (unused here, pass `'ISO'`), `findItemsByCodesOnClient` for every non-null `itemCode`, and `loadAccountsByCodeOnClient` for every non-null account code. Then, per row, collect errors in this order:
  1. `dataRowParseErrors(columns, raw, 'ISO')`
  2. `itemCode` null → `Item code is required`; `itemName` null → `Name is required`
  3. `itemCode` appears on two or more rows → `` `Item code "${code}" appears more than once in this file (rows ${list})` ``, where `list` is the row numbers joined with `, `
  4. `itemType === 'INVENTORY'`, or an existing item whose type is `INVENTORY` or `FIXED_ASSET` → `` `"${code}" is a tracked inventory item — import it under Inventory → Import` ``
  5. an existing item of the other non-stock type, with an explicit type given → `` `"${code}" already exists as ${existing === 'SERVICE' ? 'a Service' : 'Non-inventory'} — its type cannot change` ``
  6. `accountCodeError('SalesAccount', …, ['Revenue'])` and `accountCodeError('PurchasesAccount', …, ['Expense'])` when the code is non-null

  **`preview`:**
  - `summary`: `[{label:'Products to create', value:c, format:'count'}, {label:'Existing products to fill in', value:m, format:'count'}]`, counted over non-EXCLUDED rows by whether `itemCode` exists
  - `warnings`: `[]`
  - `canCommit`/`blockingErrorCount`: the same as `partyImportService.preview`
  - every legacy numeric field `0`, `plugAccountCode: ''`, `entryDate: null`

  **`commitOnClient(client, orgId, importId, createdBy, _context)`:**
  - `loadDataRowsOnClient`
  - resolve codes to ids with the same loaders
  - for each row, in row order:
    - existing → `fillMissingItemFieldsOnClient`
    - otherwise → `createItemOnClient`, where the type is `itemType ?? ((purchasePrice !== null || purchasesAccount !== null) ? 'NON_INVENTORY' : 'SERVICE')` and tax rates default to 0
  - wrap every thrown `ApiError` as `` new ApiError(err.status, `Row ${rowNumber} (${itemCode}): ${err.message}`) ``; map a pg 23505 as `` ApiError(409, `Row ${rowNumber} (${itemCode}): Item code already exists`) ``
  - then `markCommittedOnClient`, and return `{ kind: 'ITEMS', createdCount, mergedCount }`
- **Guardrails:**
  - #1: every lookup is scoped by org
  - #16: no inventory table is touched (INVENTORY is refused)
  - #5: all on `client`
- **Proof:** `npm run typecheck` exits 0, and the Step 2 proof test list still passes.
- **If it fails:** fix the new code.
- **Owes:** `docs/api.md`, in Step 12.

### Step 5 — [Sonnet] `ITEMS` integration tests

- **Model:** [Sonnet]. Integration tests against real Postgres.
- **Depends on:** 4
- **Skill:** isolation-test
- **Read first:** `__tests__/accounting/importMapping.test.ts` (setup block, helpers).
- **Files:** `server/src/__tests__/accounting/itemImport.test.ts` (new)
- **Contract:** write these tests, with these exact names:
  1. `a Products & Services CSV stages VALID with parsed values`: `'*ItemCode,*ItemName,Type,SalesUnitPrice,SalesAccount,SalesTaxRate\nCONS,Consulting,Service,150.00,4100,10%'` → 201, `errorCount` 0. `GET rows` gives `rows[0].values` equal to `{itemCode:'CONS', itemName:'Consulting', itemType:'SERVICE', salePrice:15000, salesAccount:'4100', salesTaxRate:1000, …null}`. Assert these keys only.
  2. `unparseable cells are row errors naming the column`: `SalesUnitPrice` `abc` → the row errors contain `'Sale price "abc" is not an amount'`.
  3. `duplicate codes in the file flag both rows`.
  4. `a sales account of the wrong type is a row error`: `SalesAccount 1110` → contains `'SalesAccount "1110" must be a Revenue account'`.
  5. `Type Inventory is refused with a pointer to Inventory import`.
  6. `commit creates new products with derived type`: one row with a purchase price and no Type → `GET /api/v1/items` shows the item with `itemType` `'NON_INVENTORY'`, `purchasePriceCents` set and `saleTaxRateBp` 0; the result is `{kind:'ITEMS', createdCount:1, mergedCount:0}`.
  7. `commit fills only blank fields of an existing product`:
     - create an item through `POST /api/v1/items`, with a name and sale price 100.00 and no description
     - import the same code with a different name, sale price 200.00 and a description
     - after commit: the name is unchanged, the sale price is still 10000, the description is set, and `mergedCount` is 1
  8. `PATCH values fixes a bad cell and revalidates`: stage with `SalesUnitPrice abc`, then `PATCH /:id/rows/:rowId {values:{salePrice:'99.50'}}` → 200, the row is `VALID`, `values.salePrice` is 9950, and the import is `VALIDATED`.
  9. `PATCH with a legacy key on a data kind is 400`: `{accountCode:'1'}` → 400, `'Edit this import with "values"'`.
  10. `PATCH values with an unknown field is 400`.
  11. `commit revalidates: an account deactivated after validation blocks commit`: stage and validate with `SalesAccount` set to a freshly created postable Revenue account; then deactivate it directly through `pool` (`UPDATE accounts SET is_active=false WHERE org_id=$1 AND id=$2`); then commit → 409, the message contains `'became invalid since validation'`, and no item is created.
  12. `cross-tenant: org B's account codes and products do not resolve`: org C creates a Revenue account `4999`; org A imports `SalesAccount 4999` → row error `was not found`. Org C's `GET /:id` on org A's import → 404.
- **Guardrails:** #15, as case 12.
- **Proof:** `npx vitest run src/__tests__/accounting/itemImport.test.ts` passes.
- **If it fails:** fix the service. The expected strings are the Step 4 contract.
- **Owes:** nothing.

---

## Slice 3 — Server: the `INVENTORY_ITEMS` kind

Outcome: an inventory CSV creates tracked items, their linked products and their opening stock (which posts to the GL through the existing OPENING receipt), all in one transaction. Inventory is set up silently if needed. Everything crosses the module boundary only through `documentStockService.ts`.

**Names:**

| Kind | Name |
|---|---|
| Kind | `INVENTORY_ITEMS` (appended to `MIGRATION_IMPORT_KINDS`) |
| Inventory extraction | `createItemOnClient(client, orgId, userId, input, suggestedProfile): Promise<{ id: string; code: string }>` in `services/inventory/itemService.ts` |
| Seam exports (new, `documentStockService.ts`) | `ImportStockReferences`, `loadImportReferencesOnClient`, `createItemForImportOnClient`, `suggestedProfileForImport` |
| Accounting service | `server/src/services/accounting/inventoryItemImportService.ts` → `validateRows`, `preview`, `commitOnClient`, `prepareCommit` |
| Result | `{ kind: 'INVENTORY_ITEMS'; createdCount: number; openingStockCount: number }` |
| Test | `server/src/__tests__/accounting/inventoryItemImport.test.ts` |

### Step 6 — [Sonnet] Inventory extraction + seam functions

- **Model:** [Sonnet]. It crosses the module boundary (rule 16) and a transaction.
- **Depends on:** 2
- **Read first:**
  - `services/inventory/itemService.ts` L186-441
  - `services/inventory/documentStockService.ts` L1-60 (the header contract; extend it and keep its tone)
  - `services/inventory/setupService.ts` L270-330
- **Files:** `services/inventory/itemService.ts` (edit), `services/inventory/documentStockService.ts` (edit)
- **Contract:**
  ```ts
  // inventory/itemService.ts — createItem's transaction body, extracted. createItem = suggestedProfileFor + withTransaction(createItemOnClient) + getItem, unchanged behaviour.
  export async function createItemOnClient(client: PoolClient, orgId: string, userId: string, input: CreateStockItemInput, suggestedProfile: StockIndustryKey): Promise<{ id: string; code: string }>;
  export { uniqueViolationToApiError }; // export the existing function as-is
  ```
  ```ts
  // documentStockService.ts — add a "Phase 36b: CSV import" section; update the header's first paragraph to say the seam now also serves the importer.
  export interface ImportStockReferences {
    /** stock_settings row exists for this org. */
    configured: boolean;
    defaultLocationId: string | null;
    /** Keyed by UPPER(code) AND by LOWER(name) — both keys point at the same entry. */
    categories: Map<string, { id: string; code: string; defaultTracking: 'QUANTITY' | 'LOT' | 'SERIAL'; isActive: boolean }>;
    uoms: Map<string, { id: string; code: string; decimalPlaces: number; isActive: boolean }>;
    locations: Map<string, { id: string; code: string; isActive: boolean }>;
    /** UPPER(code) of existing stock_items among the given codes. */
    existingCodes: Set<string>;
  }
  export async function loadImportReferencesOnClient(client: PoolClient, orgId: string, codes: readonly string[]): Promise<ImportStockReferences>;
  /** createItemOnClient, with a unique violation mapped through uniqueViolationToApiError (re-thrown as ApiError). */
  export async function createItemForImportOnClient(client: PoolClient, orgId: string, userId: string, input: CreateStockItemInput, suggestedProfile: StockIndustryKey): Promise<{ id: string; code: string }>;
  /** Pool read — call BEFORE a transaction. Delegates to setupService.suggestedProfileFor. */
  export async function suggestedProfileForImport(orgId: string): Promise<StockIndustryKey>;
  ```
  `loadImportReferencesOnClient` runs 5 queries, each `WHERE org_id = $1`:
  - `stock_settings` (`default_location_id`)
  - `stock_categories`
  - `stock_uoms`
  - `stock_locations`
  - `stock_items` with `UPPER(code) = ANY($2::text[])`

  Re-export the `CreateStockItemInput` type from the seam so accounting never imports `inventory/itemService.ts`.
- **Guardrails:**
  - #16: accounting will import **only** `documentStockService.ts`
  - #1: org-scoped
  - #5: on `client`; `suggestedProfileForImport` is the only pool read and is documented as pre-transaction
- **Proof:** `npm run typecheck` exits 0, and `ls src/__tests__/inventory | grep -i item` then `npx vitest run` on each file it lists all pass, unedited.
- **If it fails:** fix the extraction.
- **Owes:** `docs/architecture.md` (the seam gains the importer as a caller), in Step 12.

### Step 7 — [Sonnet] `INVENTORY_ITEMS` registry entry + service

- **Model:** [Sonnet]. GL-posting opening stock, the pre-transaction hook, and the cross-module seam.
- **Depends on:** 3, 6
- **Read first:** the new `itemImportService.ts` (mirror its shape) and `services/inventory/itemService.ts` `postOpeningOnClient` (its 422 texts).
- **Files:** `types/accounting.ts` (append `'INVENTORY_ITEMS'`; result member), `services/accounting/inventoryItemImportService.ts` (new), `services/accounting/importKinds.ts` (entry)
- **Contract:**

  **Registry entry `INVENTORY_ITEMS`** — label `Inventory items`, noun `items`, storage `data`, requiredOneOf `[]`, `prepareCommit: inventoryItemImportService.prepareCommit`.

  | key | header | label | req | type | maxLength | synonyms | note | example |
  |---|---|---|---|---|---|---|---|---|
  | itemCode | `ItemCode` | Item code | | text | 40 | code, item code, sku, product code, item | A–Z, 0–9 and - _ / . (converted to upper case). Blank: generated from your item-code scheme. Must not already exist. | WIDGET-01 |
  | itemName | `*ItemName` | Name | ✓ | text | 200 | name, item name, product name, product | Up to 200 characters. | Blue widget |
  | description | `Description` | Description | | text | 1000 | description, long description | | |
  | category | `Category` | Category | | text | 100 | category, item category, group | A stock category's code or name. Blank: your default category. | |
  | unit | `Unit` | Unit | | text | 60 | unit, uom, unit of measure, units | A unit's code or name. Blank: the category's default unit. | |
  | barcode | `Barcode` | Barcode | | text | 14 | barcode, gtin, ean, upc | 8, 12, 13 or 14 digits with a valid check digit. | |
  | reorderPoint | `ReorderPoint` | Reorder point | | quantity | null | reorder point, reorder level, min stock, minimum | | 10 |
  | salePrice | `SalesUnitPrice` | Sale price | | money | null | (ITEMS salePrice synonyms) | | 25.00 |
  | salesAccount | `SalesAccount` | Sales account | | text | 20 | sales account, income account, revenue account | A Revenue account code. Blank: your default. | |
  | salesTaxRate | `SalesTaxRate` | Sales tax % | | percent | null | (ITEMS synonyms) | | |
  | purchasePrice | `PurchasesUnitPrice` | Purchase price | | money | null | (ITEMS synonyms) | Also the opening unit cost when OpeningUnitCost is blank. | 12.00 |
  | purchasesTaxRate | `PurchasesTaxRate` | Purchase tax % | | percent | null | (ITEMS synonyms) | | |
  | inventoryAccount | `InventoryAssetAccount` | Inventory account | | text | 20 | inventory asset account, inventory account, asset account | An Asset account code. Blank: your default inventory account. | |
  | cogsAccount | `CostOfGoodsSoldAccount` | COGS account | | text | 20 | cost of goods sold account, cogs account, cogs | An Expense account code. Blank: your default. | |
  | openingQuantity | `OpeningQuantity` | Opening quantity | | quantity | null | opening quantity, quantity, qty, quantity on hand, qty on hand, on hand, opening stock | Stock on hand to bring in. Blank: no opening stock. | 40 |
  | openingUnitCost | `OpeningUnitCost` | Opening unit cost | | money | null | opening unit cost, unit cost, cost price, average cost, opening cost | Blank: the purchase price. | 11.50 |
  | openingLocation | `OpeningLocation` | Opening location | | text | 100 | opening location, location, warehouse, store | A location's code or name. Blank: your default location. | |
  | openingDate | `OpeningDate` | Opening date | | date | null | opening date, as of, as of date, date | Blank: your conversion date. Cannot be in the future. | 2026-07-01 |

  - missingMessages: `itemName` → `Could not find an item name column in the file`.
  - editFields: every column, `text` input, `nullable` true, except `itemName`.

  **`prepareCommit(orgId)`** → `{ inventoryProfile: await documentStockService.suggestedProfileForImport(orgId) }`.

  **`validateRows`.** Load once:
  - `importDateFormatOnClient`
  - the uppercased non-null codes → `loadImportReferencesOnClient`
  - `findItemsByCodesOnClient` on the same uppercased codes
  - `loadAccountsByCodeOnClient` for every account code
  - `SELECT books_start_date FROM ledger_settings WHERE org_id = $1` (accounting's own table)

  Then, per row, in this order:
  1. `dataRowParseErrors`
  2. `itemName` null → `Name is required`
  3. `code = itemCode?.toUpperCase()`:
     - fails `ITEM_CODE_REGEX` → `` `Item code "${itemCode}" may use only A–Z, 0–9 and - _ / . (max 40)` ``
     - duplicate in the file → the ITEMS duplicate message
     - in `existingCodes`, or in `findItemsByCodes` → `` `"${code}" already exists — to track stock for an existing product, open it in Products & Services and tick Track inventory` ``
  4. `category`, `unit`, `openingLocation` non-null: look up `UPPER(text)`, then `LOWER(text)`.
     - Missing → `` `${Label} "${text}" was not found. Leave it blank to use your default${refs.configured ? '' : ', or set up inventory first (Inventory → Setup)'}` ``, using the labels Category, Unit and Opening location.
     - Inactive → `` `${Label} "${text}" is inactive` ``.
  5. `barcode` non-null and (not `/^[0-9]{8}$|^[0-9]{12,14}$/` or `!isValidGtin`) → `` `Barcode "${barcode}" is not a valid 8, 12, 13 or 14-digit barcode` ``
  6. Accounts:
     - `accountCodeError('SalesAccount', …, ['Revenue'])`
     - `('InventoryAssetAccount', …, ['Asset'])`
     - `('CostOfGoodsSoldAccount', …, ['Expense'])`
  7. Opening stock, only when `openingQuantity` is non-null:
     - `openingQuantity === 0` → `Opening quantity must be more than zero`
     - `openingUnitCost ?? purchasePrice` null → `Enter an OpeningUnitCost or a PurchasesUnitPrice for the opening stock`
     - `openingDate ?? books_start_date` null → `Enter an OpeningDate, or set your conversion date (Settings → Conversion balances)`
     - that date `> today (UTC, YYYY-MM-DD)` → `Opening date cannot be in the future`
     - the resolved category (explicit, else the default category) is known and its `defaultTracking !== 'QUANTITY'` → `Opening stock for lot- or serial-tracked items goes in under Stock movements → Receive`
     - opening fields present but `openingQuantity` null → no error; they are ignored

  **`preview`:**
  - `summary`: `[{label:'Tracked items to create', value, format:'count'}, {label:'Items with opening stock', value, format:'count'}, {label:'Opening stock value', value: Σ round(qtyMilli × unitCostCents / 1000), format:'money'}]`
    - integer arithmetic: `Math.round((qtyMilli * unitCostCents) / 1000)` over safe integers is acceptable as a **preview only**
    - the posted value comes from the movement engine
  - `warnings`: when `!refs.configured`, `['Inventory is not set up yet — committing sets it up with the suggested industry profile, the same as creating your first tracked product.']`

  **`commitOnClient(client, orgId, importId, createdBy, context)`:**
  - `context.inventoryProfile` null → `Error('prepareCommit did not run')`
  - load rows and references (as in validate)
  - for each row, call `documentStockService.createItemForImportOnClient` with:
    ```
    { name, description, categoryId: cat?.id ?? null, uomId: uom?.id ?? null, tracking: null,
      code: code ?? null, codeSchemeId: null, barcode, attributes: {}, reorderPointMilli: reorderPoint,
      product: { salePriceCents, purchasePriceCents, revenueAccountId, assetAccountId, cogsAccountId,
                 saleTaxRateBp: salesTaxRate ?? 0, purchaseTaxRateBp: purchasesTaxRate ?? 0 },
      opening: openingQuantity === null ? undefined : { quantityMilli, unitCostCents: openingUnitCost ?? null,
               occurredOn: openingDate ?? booksStartDate, locationId: loc?.id ?? null } }
    ```
    - cast `context.inventoryProfile` with the seam's exported type guard; if none exists, export `isStockIndustryKey` from the seam, delegating to `config/inventoryIndustryProfiles.ts`
    - wrap errors: `` `Row ${n} (${code ?? itemName}): ${message}` ``
  - `markCommittedOnClient`
  - return `{ kind: 'INVENTORY_ITEMS', createdCount, openingStockCount }`
- **Guardrails:**
  - **#16: `import * as documentStockService from '../inventory/documentStockService.js'` is the only inventory import in this file.** Verify with `grep -n "inventory/" server/src/services/accounting/inventoryItemImportService.ts` showing exactly that import (and type imports from the seam).
  - #3: cents and milli are integers
  - #5: on `client`
  - #1
- **Proof:** `npm run typecheck` exits 0, the Step 2 proof list still passes, and the grep above holds.
- **If it fails:** fix the new code.
- **Owes:** docs, in Step 12.

### Step 8 — [Sonnet] `INVENTORY_ITEMS` integration tests + integrity

- **Model:** [Sonnet]. GL effects and integrity checks.
- **Depends on:** 7
- **Skill:** isolation-test
- **Read first:** `__tests__/accounting/itemImport.test.ts` (Step 5) and one inventory test that creates items (`ls src/__tests__/inventory`).
- **Files:** `server/src/__tests__/accounting/inventoryItemImport.test.ts` (new)
- **Contract:** write these tests, with these exact names. Set the org's conversion date first where needed, through `PATCH /api/v1/settings {booksStartDate}` to a past date in an open period.
  1. `stages VALID and previews opening value`: two rows, one with `OpeningQuantity 40` and `OpeningUnitCost 11.50`, no Category/Unit/Location, inventory **not** set up →
     - `errorCount` 0
     - the preview `summary` includes `{label:'Opening stock value', value:46000, format:'money'}`
     - `warnings` has length 1
  2. `commit sets up inventory, creates items, products and opening stock`:
     - `result` equals `{kind:'INVENTORY_ITEMS', createdCount:2, openingStockCount:1}`
     - `GET /api/v1/inventory/items` lists both
     - `GET /api/v1/items?itemType=INVENTORY` lists both codes
     - the opening item's quantity on hand is 40
  3. `integrity checks pass after an opening-stock import`: run the same checks `npm run verify:integrity` runs. Import the checker the way the existing integrity tests do (`grep -rln "stock_movements_reconcile_with_gl" src/__tests__`) and assert that `stock_balances_match_movements`, `stock_movements_reconcile_with_gl` and `inventory_accounts_reconcile_with_gl` pass. If no programmatic entry point exists, **stop and report** rather than shelling out.
  4. `an existing product code is refused with the Track-inventory pointer`.
  5. `an unknown category names the setup hint when inventory is not set up`.
  6. `a lot-tracked category refuses opening stock`: set up inventory, create a LOT-default category through the inventory API, import with that category and an opening quantity → the tracking error.
  7. `a future opening date is a row error`.
  8. `missing unit cost and purchase price is a row error`.
  9. `DMY dates parse with dateFormat`: stage with `dateFormat:'DMY'` and `OpeningDate` in `DD/MM/YYYY` form → `values.openingDate` is ISO.
  10. `inspect suggests DMY for an unambiguous day-first file`: `/inspect` → `suggestedDateFormat` `'DMY'`.
  11. `all-or-nothing: a bad barcode caught at commit rolls back every row`:
      - stage two valid rows, then set a barcode that passes validation but collides with an existing stock item's barcode (create that item first through `POST /api/v1/inventory/items`)
      - commit → 409
      - neither row's item exists afterwards (`GET /api/v1/inventory/items?q=`)
      - the import is still `VALIDATED`
  12. `cross-tenant: org B's categories and locations do not resolve; org B cannot commit org A's import`.
- **Guardrails:** #15 (case 12). The integrity checks are the rule-3/7 invariants.
- **Proof:** `npx vitest run src/__tests__/accounting/inventoryItemImport.test.ts` passes, then `npm test` fully, 2 skipped.
- **If it fails:** fix the service.
- **Owes:** nothing.

---

## Slice 4 — Client

Outcome: Products & Services and Inventory have Import buttons. The wizard handles date formats. The review table edits data-kind rows as text and enum selects. The preview and committed cards render generic summaries.

### Step 9 — [Sonnet] Client types, data-kind editing, date format, summaries

- **Model:** [Sonnet]. Several interacting components.
- **Depends on:** 2, 4, 7 (server contract final)
- **Read first:** every file under `client/src/Pages/accounting/imports/`, `NewMigrationImportPage.tsx`, `MigrationImportDetailPage.tsx`, and `services/fetchServices.ts` L2813-3000.
- **Files:** `services/fetchServices.ts`, `imports/ImportRowsTable.tsx`, `imports/ColumnMapper.tsx`, `NewMigrationImportPage.tsx`, `MigrationImportDetailPage.tsx` (all edit)
- **Contract:**
  - **`fetchServices.ts`:** mirror every type change from Step 2(a), exactly:
    - `ImportColumnMeta` gains `type`, `maxLength`, `enumAliases`, `enumLabels`
    - `ImportEditFieldMeta` gains `input: 'text'|'money'|'accountType'|'enum'` and `options: string[] | null`
    - `ImportKindMeta` gains `storage`
    - `MigrationImport` gains `dateFormat: 'ISO'|'DMY'|'MDY'`
    - `MigrationImportRow` gains `values` and `groupKey`
    - `MigrationCommitPreview` gains `summary` and `warnings`
    - `MigrationImportInspection` gains `suggestedDateFormat`
    - `MigrationImportKind` adds `'ITEMS' | 'INVENTORY_ITEMS'`
    - `MigrationCommitResult` adds the two members
    - `createMigrationImport` body gains `dateFormat?: 'ISO'|'DMY'|'MDY'`
  - **`ImportRowsTable`**, when `meta.storage === 'data'`:
    - edit text = `row.raw[field.key] ?? ''`
    - `enum` → a `<select>` with `''` plus `field.options`
    - Save sends `{ values: { [key]: text.trim() === '' ? null : text.trim() } }` for **every** edit field (the server re-parses)
    - the read-only display is `row.raw[key]` or `—`
    - the typed path is unchanged
  - **Wizard:**
    - `const hasDates = meta.columns.some(c => c.type === 'date')`
    - when `hasDates`, the map stage shows `<label>Date format in your file <select>` with the options `YYYY-MM-DD` (ISO), `DD/MM/YYYY` (DMY) and `MM/DD/YYYY` (MDY), plus an empty `Choose…` option
    - initial value: `inspection.suggestedDateFormat ?? ''`
    - an empty value when `hasDates` adds the problem `Choose the date format your file uses`
    - the chosen format is sent as `dateFormat`
    - the select is shown even when `exactMatch` hides the mapper
  - **Detail page preview:** when `preview.summary.length > 0`, render a `<dl>` of `label`, with `value` shown as a count or through `formatCents` when `format === 'money'`; then each warning as `<p className="status status--warn">`; the legacy per-kind text stays for typed kinds.
  - **Committed card:**
    - `ITEMS` → `` `Committed: ${createdCount} created, ${mergedCount} filled in.` ``
    - `INVENTORY_ITEMS` → `` `Committed: ${createdCount} items created, opening stock posted for ${openingStockCount}.` ``
- **Proof:** `npm run typecheck` exits 0, and `npm run lint` exits 0.
- **Owes:** nothing.

### Step 10 — [Haiku] Guides, checklist steps, Import buttons, fixture

- **Model:** [Haiku]. Transcription.
- **Depends on:** 9
- **Read first:** `imports/importGuides.ts`, `components/imports/ImportButton.tsx`, and `__tests__/fixtures/importKinds.ts`.
- **Files:** `imports/importGuides.ts`, `Pages/products/ProductsPage.tsx`, `Pages/inventory/InventoryItemsPage.tsx`, `__tests__/fixtures/importKinds.ts` (all edit)
- **Contract:**
  - **`IMPORT_GUIDES.ITEMS`**
    - intro: `Bring in the products and services you sell or buy.`
    - steps: the shared five, as in 36a
    - rules:
      - `A code that already exists only has its blank fields filled — names, types and tax rates are never overwritten.`
      - `Type is Service or Non-inventory. Leave it blank and a product with a purchase price or purchases account becomes Non-inventory, anything else a Service.`
      - `Accounts are account codes: a Revenue account for sales, an Expense account for purchases.`
      - `Tax rates are percentages, such as 10 or 12.5%. Xero-style names like "GST on Income (15%)" work too.`
      - `Tracked stock goes through Inventory → Import instead, so its opening quantity and cost are recorded.`
  - **`IMPORT_GUIDES.INVENTORY_ITEMS`**
    - intro: `Create tracked stock items — each with its product and, optionally, the stock you already hold.`
    - steps: the shared five
    - rules:
      - `Each row creates a tracked item and its product. Existing codes are refused — to track an existing product, open it and tick Track inventory.`
      - `OpeningQuantity with OpeningUnitCost (or the purchase price) posts opening stock on OpeningDate — your conversion date when blank — debiting your inventory account.`
      - `Don't also include inventory in opening balances; the opening-balance import refuses inventory accounts for this reason.`
      - `Category, Unit and OpeningLocation accept a code or a name; leave them blank to use your defaults. Inventory is set up automatically if it isn't yet.`
      - `Lot- and serial-tracked stock is received under Stock movements → Receive, not here.`
  - **`MIGRATION_STEPS`:**
    - insert after `vendors`: `{key:'products', label:'Products & services', hint:'What you sell and buy, before documents that name them.', to:'/migration-imports/new?kind=ITEMS', kind:'ITEMS'}`
    - append after `opening`: `{key:'stock', label:'Inventory items & opening stock', hint:'Tracked stock and the quantity on hand at your conversion date.', to:'/migration-imports/new?kind=INVENTORY_ITEMS', kind:'INVENTORY_ITEMS'}`
    - update the code comment to say Step D inserts open invoices and bills before `stock`
  - **ProductsPage:** wrap the "New product or service" button in `<div className="flex items-center gap-2">` and add `<ImportButton kind="ITEMS" returnTo="/products" />` before it.
  - **InventoryItemsPage:** inside `actions`, before the existing `canWrite &&` new-item control, add `{canWrite && <ImportButton kind="INVENTORY_ITEMS" returnTo="/inventory/items" />}`.
  - **Fixture:** append the `ITEMS` and `INVENTORY_ITEMS` metadata, transcribed from the server registry (`server/src/services/accounting/importKinds.ts`), plus the new fields on the four legacy entries.
- **Proof:** `npm run typecheck` exits 0; `npm run lint` exits 0; `npx vitest run src/__tests__/products.test.tsx src/__tests__/importWizard.test.tsx src/__tests__/migrationImport.test.tsx` passes, unedited except the fixture.
- **Owes:** nothing.

### Step 10b — [Sonnet] Client tests for data kinds

- **Model:** [Sonnet]
- **Depends on:** 10
- **Files:** `__tests__/importWizard.test.tsx`, `__tests__/migrationImport.test.tsx` (edit: **append** tests only)
- **Contract:** add these tests, with these exact names:
  1. `a date-bearing kind shows the date-format select, preset from inspect`: INVENTORY_ITEMS with inspect `suggestedDateFormat:'DMY'` → the select's value is `DMY`, and the POST body has `dateFormat:'DMY'`.
  2. `an ambiguous date format must be chosen before staging`: `suggestedDateFormat:null` → `Choose the date format your file uses` is shown and `Stage import` is disabled.
  3. `a data-kind row edits raw text and saves values`: an ITEMS row with `raw.salePrice 'abc'` → edit it to `99.50` and Save → the PATCH body equals `{values:{…, salePrice:'99.50', …}}`.
  4. `the Type column is a select of options`.
  5. `the preview renders summary items with money formatting`.
  6. `a committed inventory import shows created and opening counts`.
- **Proof:** from `client/`, `npm test` passes and `npm run typecheck` exits 0.

---

## Spine

### Step 11 — [Sonnet] Study notes

- **Depends on:** 8, 10b
- **Skill:** study-note
- **Files:**
  - extend `study/architecture/staged-import-and-two-phase-commit.md`: typed-cell staging into JSONB with the raw text kept; revalidate-at-commit (a TOCTOU between validate and commit); a pre-transaction hook for pool reads (rule 5); fill-blanks merge vs create-only
  - extend `study/architecture/cross-app-transactional-bridge.md`: the seam growing a second caller; why accounting imports one inventory module and re-exported types
  - extend `study/postgresql/jsonb-user-defined-attributes.md`: `COALESCE(data,'{}') || patch` for partial edits
  - one new or extended note on **integer parsing of human decimals** (percent to bp, quantity to milli, no floats), in `study/node-express/parsing-untrusted-csv.md` or a better-fitting note; say which
  - `study/README.md`

### Step 12 — [Sonnet] Docs sync

- **Depends on:** 8, 10b
- **Skill:** docs-sync
- **Files:**
  - `docs/api.md` § Migration imports: `dateFormat`, `suggestedDateFormat`, `PATCH values`, storage `data`, the ITEMS/INVENTORY_ITEMS rules and failure paths, revalidate-at-commit 409, `summary`/`warnings`, and the two result shapes
  - `docs/accounting.md` § Phase 36: 36b as delivered
  - `docs/inventory.md`: import as a creation path
  - `docs/architecture.md`: the seam's new callers
  - `docs/roadmap.md`: 36b as delivered, with the plan-defect log from this file's manifest notes
  - `CLAUDE.md`: extend the Phase 36a bullet to "36a–b" (keep it short)
  - no `schema.md` change (no migration), but state in `roadmap.md` that 36b needed none

### Step 13 — [Sonnet] Guardrail review + full verification

- **Depends on:** 11, 12
- **Skill:** guardrail-review
- **Proof:** `cd server && npm run typecheck && npm run lint && npm test && npm run verify:integrity`; `cd client && npm run typecheck && npm run lint && npm test`. All green, zero violations; pay special attention to rule 16 in `services/accounting/inventoryItemImportService.ts`. Then set `Status: done`.

---

## Dispatch manifest

| Batch | Step | Tier | Title | Depends on | Blocks | Status |
|---|---|---|---|---|---|---|
| A | 1 | Haiku | `importValues.ts` + unit tests | — | 2 | done |
| B | 2 | Sonnet | Types, row store, generic data-kind path | 1 | 3, 6 | done |
| B | 3 | Sonnet | Item-service extractions + account lookup | 2 | 4, 7 | done |
| B | 4 | Sonnet | `ITEMS` kind + service | 3 | 5 | done |
| B | 5 | Sonnet | `ITEMS` integration tests | 4 | 12 | done |
| B | 6 | Sonnet | Inventory extraction + seam functions | 2 | 7 | done |
| B | 7 | Sonnet | `INVENTORY_ITEMS` kind + service | 3, 6 | 8 | done |
| B | 8 | Sonnet | `INVENTORY_ITEMS` tests + integrity | 7 | 12 | done |
| B | 9 | Sonnet | Client types, data editing, date format, summaries | 2, 4, 7 | 10 | done |
| C | 10 | Haiku | Guides, checklist, Import buttons, fixture | 9 | 10b | done |
| D | 10b | Sonnet | Client tests for data kinds | 10 | 11, 12 | done |
| D | 11 | Sonnet | Study notes | 8, 10b | 13 | done |
| D | 12 | Sonnet | Docs sync | 8, 10b | 13 | done |
| D | 13 | Sonnet | Guardrail review + verification | 11, 12 | — | done |

**How the batches group:**
- Step 1 is Haiku.
- Steps 2–9 are Sonnet and run in dependency order; Steps 3–5 and Step 6 may run in parallel once Step 2 is done.
- Step 10 is Haiku; Steps 10b–13 are Sonnet, and Steps 11 and 12 can run in parallel.
- Do not split Step 2 or Step 7 across sessions: each holds a transaction boundary.

**Escalations:**
- Step 10 (Haiku → Sonnet): proof failed on stale preview mocks (scope read too narrowly); Sonnet fixed them in the `mockRoutes` builder and, on review, restored verbatim guide text Haiku had paraphrased, split the InventoryItemsPage `canWrite` wrapper to the contract shape, and restored three fixture notes. **Tiering correction:** long verbatim-copy transcription (guide prose, 30-column fixture) drifted under Haiku — plan such steps as Sonnet, or split fixture transcription into its own step with a byte-comparison proof.

**Plan defects found during execution:**
- Step 2: required new `ImportColumnDef` fields (`type`, `maxLength`, `enumAliases`, `enumLabels`) break the typecheck of the 36a unit test `importColumns.test.ts`, whose 22 column literals lack them. Orchestrator-approved fix: add the four inert defaults (`type: 'text', maxLength: null, enumAliases: null, enumLabels: null`) to each literal — fixture-only, no assertion changed. Also: legacy preview services now return `LegacyCommitPreview` (Omit of summary/warnings), wrapped in the registry.
- Step 4: appending a kind breaks the 36a test `GET /kinds lists the four kinds` (hard-coded list). Orchestrator-approved: assert `toEqual([...MIGRATION_IMPORT_KINDS])` (tracks the source tuple, still checks order/exhaustiveness) and rename to `GET /kinds lists every kind with template metadata`. Also: ITEMS columns live in `importItemColumns.ts` to avoid an importKinds↔service cycle (accepted); preview sets `partiesToCreate/Merge` 0.
- Step 5: found that `parseMoneyText` turns a digit-free word ("abc") into 0 (it strips a trailing 3-letter currency code). Guarded in `parseImportCell` for data kinds. **Pre-existing bug, out of scope:** the legacy opening-balance and bank importers share `parseMoneyText` — reported to the user.
- Step 7: `validateRows` receives no importId, so the contract's `importDateFormatOnClient` was unusable — added `importDateFormatForRowOnClient(client, orgId, rowId)` (org-scoped join). The lot/serial opening check fires only for an explicit Category (the seam exposes no default category); a lot-default category with blank Category is caught at commit by inventory's own 422 and rolls back. Barcode uniqueness against existing stock is checked only at commit (409, all-or-nothing). Timing: 2 rows + 1 opening receipt ≈ 111 ms end-to-end; 1000-row cost still unmeasured.
- Step 10 (scope gap): new required client fields also break the `baseImport`/`baseRow`/inspection factories in `importWizard.test.tsx` and `migrationImport.test.tsx`. Orchestrator-approved: Step 10 adds the defaults there too (`dateFormat: 'ISO'`, `values: {}`, `groupKey: null`, `suggestedDateFormat: null`, and `summary: [], warnings: []` on preview fixtures if needed) — factory-level only, no assertion changes.
- Step 1 (contract gap, accepted): the embedded-percent regex matches the tail of a 3-decimal value (`"5.005%"` → `005%` → 500 bp). Rare in real exports; fix later with a leading `(?<![\d.])` lookbehind if it ever matters.

## Risks & open questions

- **Opening stock posts per item.** Each opening receipt is its own journal entry through `receiveManualOnClient`, so 1000 rows means 1000 entries in one transaction. That is acceptable under the 5000-row cap, but slow; measure in Step 8 and note the timing.
- **The `ITEMS` merge never changes tax rates or names**, by design, because a blank tax rate is indistinguishable from 0%. This is documented in the guide.
- **Stock codes are uppercased and accounting item codes are not.** `INVENTORY_ITEMS` compares uppercase against both tables; `ITEMS` compares exactly, matching the DB unique constraint.
- **The Xero item export has no Type column,** so the derived-type rule decides. A user who disagrees edits the Type column in review.
- **Unknown:** whether a programmatic integrity-check entry point exists for Step 8 case 3. The step stops and reports if it does not.

## Definition of done

- Server and client typecheck, lint and tests are green; `verify:integrity` is clean; guardrail-review is clean; the 36a and legacy import tests are unedited.
- Docs and study notes are updated.
- In the running app:
  - Products & Services → Import → the template round-trips.
  - An Xero items export maps.
  - An inventory import with opening stock posts; the valuation page and the GL agree.
