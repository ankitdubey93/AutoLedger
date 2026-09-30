# Phase 36a — CSV import foundation (registry, mapping, templates, guides)

Date: 2026-09-30 · **Status: done — 36a landed (uncommitted)** · Approved design: `/home/ankit/.claude/plans/csv-importer-throughout-the-abundant-cookie.md` (Phase 36, Step A)

Step A of four. Steps B (products + inventory items), C (journals) and D (invoices + bills, conversion mode) are separate plans, written after this one lands. **This plan adds no new import kind.** It rebuilds the existing four (chart of accounts, opening balances, customers, vendors) on a shared registry, and adds:
- column mapping
- server-driven templates
- a step wizard and in-page guides
- Import buttons on three list pages

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

## Starting state (verified 2026-09-30)

**Server: the staged importer exists**
- `server/src/services/accounting/migrationImportService.ts` (937 lines):
  - synonym arrays at L53-75
  - `findColumnBySynonyms` (L97) uses `normalizeForMatching` (`utils/matchScore.ts:58`: lowercase, non-alphanumerics → space)
  - `resolveColumns` (L114), which throws the four 422 messages
  - the parsers `parseChartRow` (L237), `parseOpeningRow` (L264) and `parseCustomerRow` (L322)
  - `parseRows` (L360), `toImport` (L399), `toRow` (L451), `listImports` (L513) and `listRows` (L567)
  - `revalidateOnClient` (L609), which runs **one UPDATE per row** (L649-659)
  - `createImport` (L684), `patchRow` (L786), `preview` (L876)
  - `commit` (L891), which checks `VALIDATED` via `pool` **before** `BEGIN`, with no row lock
- Per-kind services:

  | Service | `validateRows` | `preview` | `commitOnClient` |
  |---|---|---|---|
  | `chartImportService.ts` | `(client, orgId, rows)` | `(client, orgId, importId)` | `(client, orgId, importId)` → `{created, merged}` |
  | `openingBalanceImportService.ts` | `(client, orgId, rows)` | same | `(client, orgId, importId, createdBy)` → `{journalEntryId, plugCents}` |
  | `partyImportService.ts` | `(client, orgId, kind, rows)` | same | `(client, orgId, importId)` → `{created, merged}` |

  Each `commitOnClient` sets `status = 'COMMITTED'` itself.
- Controller `controllers/accounting/migrationImportController.ts`, routes `routes/accounting/migrationImportRoutes.ts`, schema `schemas/accounting/migrationImportSchema.ts`.
- Types at `types/accounting.ts` ~L1229-1335: `MIGRATION_IMPORT_KINDS`, `MigrationImport`, `MigrationImportRow`, `MigrationCommitPreview`.
- Tables come from migrations `029` and `062`. `062` names the kind CHECK `chk_migration_imports_kind`. The latest migration is `077`.
- Other pieces:
  - `utils/dateParse.ts` exports `DATE_FORMATS` and `DateFormat` (unused in 36a)
  - `config/constants.ts:125` holds `MAX_CSV_CHARS = 900_000` and L87 holds `MAX_PAGE_SIZE = 100`
- Tests:
  - `__tests__/accounting/{chartImport,openingBalanceImport,partyImport,migrationImportConstraints}.test.ts`
  - helpers `createUserWithOrg`, `loginAgent`, `addMember`, `resetTables` in `__tests__/helpers/factories.ts`
  - the VIEWER pattern at `__tests__/tenantIsolation.test.ts:137-148` (addMember → loginAgent → `POST /api/v1/auth/switch-org`)
- `src/scripts/walkthroughReplay.ts:91` stages imports through `POST /migration-imports` with legacy headers.

**Client**
- `client/src/Pages/accounting/`:
  - `NewMigrationImportPage.tsx` (173 lines: kind select, static template table, file input)
  - `MigrationImportDetailPage.tsx` (497 lines):
    - hard-coded columns per kind
    - `limit: 100` with no pagination
    - the header labels every non-chart kind "Opening balances" (L195)
  - `MigrationImportsPage.tsx`
  - `importTemplates.ts` (`IMPORT_TEMPLATES`, hand-synced with server synonyms; also `csvField`, `templateCsv`)
- `Pages/settings/ConversionBalancesPage.tsx:227` builds a header from `IMPORT_TEMPLATES.OPENING_BALANCES`.
- `services/fetchServices.ts` holds the migration-import types and wrappers at L2813-2989.
- Shared UI: `components/ui/PageHeader.tsx`, `Pagination.tsx`, `formClasses.ts` (`inputClass`, `primaryButtonClass`, `secondaryButtonClass`) and `components/BackLink.tsx` (`{to, label}`).
- `useAuth()` throws outside `<AuthProvider>`. The list-page tests (`__tests__/accounts.test.tsx`, `customers.test.tsx`, `vendors.test.tsx`) render **without** AuthProvider inside a `MemoryRouter`, so **nothing added to a list page may call `useAuth`**.
- The conversion date (`booksStartDate`) is edited on `/settings/conversion-balances`.

**Not present:** any column map on this importer, `/kinds`, `/inspect`, `data`/`group_key` columns, or a status filter on `GET /migration-imports`.

## Gate

- Phase 36 (a direct feature request, numbered after 35a).
- Prerequisites: Phase 9b and Phase 24 (the importer), both built.
- Nothing gated.
- Roadmap debt carried: none.

## Execution rules

**If a proof command fails twice on the same step, stop and report. Do not improvise around it.**

| Symptom | Forbidden | Correct |
|---|---|---|
| Migration checksum error | Editing an applied migration | A new sequential migration (rule 13) |
| Test fails | Weakening or deleting the assertion | Fix the code; the test is the spec |
| An existing legacy import test fails after the registry refactor | Editing that test | Fix the refactor. `chartImport`, `openingBalanceImport` and `partyImport` tests are the regression gate and stay **unedited** |
| Type error | `as any`, `@ts-ignore`, loosening `tsconfig` | Fix the type |
| Query returns no rows | Dropping the `org_id` predicate | Fix the fixture or the parameters (rule 1) |
| Need a helper library | `npm install` anything | Stop and ask (rule 14). This plan adds **no** dependency |
| Column missing at runtime | Adding it ad hoc | Stop; the plan is the defect |
| A `[Haiku]` step's proof fails twice | Retrying in a loop, trimming the step | Escalate the same step unchanged to `[Sonnet]` with the failure output; note the escalation under the manifest |
| The step needs a decision the plan never made | Deciding it | Stop and report |

Direct SQL goes through `docker exec autodb_postgres psql -U autodb_user -d autodb -c '...'`; `psql` is not on the host. Every server command runs from `server/` and every client command from `client/`.

**Anything the plan did not anticipate is a stop-and-report, not a judgment call.**

---

## Slice 1 — Server: registry, mapping, inspect, commit hardening

Outcome: the four existing kinds resolve columns through one registry, which the client can fetch. Users can inspect a file and supply a column map. Commit is serialized and persists its result.

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| Migration | `server/src/db/migrations/078_ledger-core_migration_import_kinds.sql` |
| New columns | `migration_imports.column_map`, `.options`, `.commit_options`, `.result`; `migration_import_rows.data`, `.group_key` |
| Index | `idx_migration_rows_group` |
| Pure util | `server/src/utils/importColumns.ts` → `compactHeader`, `resolveColumnIndexes`, `findMissingRequired` |
| Parsers file | `server/src/services/accounting/importRowParsers.ts` → `StagedRowInput`, `ResolvedImportColumns`, `normalizeAccountType`, `parseChartRow`, `parseOpeningRow`, `parsePartyRow` |
| Registry | `server/src/services/accounting/importKinds.ts` → `ImportKindDef`, `IMPORT_KINDS`, `getImportKind`, `listImportKindMeta` |
| Types (in `types/accounting.ts`) | `ImportColumnDef`, `ImportEditFieldDef`, `ImportKindMeta`, `MigrationImportInspection`, `MigrationCommitResult`, `isMigrationImportStatus` |
| Constant | `MAX_IMPORT_ROWS = 5000` in `config/constants.ts` |
| Service exports (new) | `inspectImport` in `migrationImportService.ts` |
| Controller exports (new) | `kinds`, `inspect` |
| Schema exports (new) | `inspectMigrationImportSchema` |
| Routes (new) | `GET /api/v1/migration-imports/kinds`, `POST /api/v1/migration-imports/inspect` |
| Test file (new) | `server/src/__tests__/accounting/importMapping.test.ts` |

### Step 1 — [Sonnet] Migration 078: widen kinds, add JSONB staging columns

- **Model:** [Sonnet]. A migration, which cannot be repaired in place (rule 13).
- **Depends on:** —
- **Skill:** new-migration
- **Read first:** `server/src/db/migrations/062_ledger-core_party_import.sql`. Copy its header comment style and its drop-then-add CHECK idiom exactly.
- **Files:** `server/src/db/migrations/078_ledger-core_migration_import_kinds.sql` (new)
- **Contract:** write these statements, in this order:
  ```sql
  ALTER TABLE migration_imports DROP CONSTRAINT IF EXISTS chk_migration_imports_kind;
  ALTER TABLE migration_imports ADD CONSTRAINT chk_migration_imports_kind
    CHECK (kind IN ('CHART_OF_ACCOUNTS', 'OPENING_BALANCES', 'CUSTOMERS', 'VENDORS',
                    'ITEMS', 'INVENTORY_ITEMS', 'INVOICES', 'BILLS', 'JOURNALS'));

  ALTER TABLE migration_imports ADD COLUMN IF NOT EXISTS column_map JSONB
    CHECK (column_map IS NULL OR jsonb_typeof(column_map) = 'object');
  ALTER TABLE migration_imports ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(options) = 'object');
  ALTER TABLE migration_imports ADD COLUMN IF NOT EXISTS commit_options JSONB
    CHECK (commit_options IS NULL OR jsonb_typeof(commit_options) = 'object');
  ALTER TABLE migration_imports ADD COLUMN IF NOT EXISTS result JSONB
    CHECK (result IS NULL OR jsonb_typeof(result) = 'object');

  ALTER TABLE migration_import_rows ADD COLUMN IF NOT EXISTS data JSONB
    CHECK (data IS NULL OR jsonb_typeof(data) = 'object');
  ALTER TABLE migration_import_rows ADD COLUMN IF NOT EXISTS group_key TEXT
    CHECK (group_key IS NULL OR length(group_key) <= 220);

  CREATE INDEX IF NOT EXISTS idx_migration_rows_group
    ON migration_import_rows (org_id, import_id, group_key) WHERE group_key IS NOT NULL;
  ```
  The header comment must state these three things:
  1. The five new kinds are admitted by the database now, so Steps B–D need no further kind migration. The TypeScript tuple still lists four until each step adds its kind.
  2. `data` and `group_key` serve the Step B–D kinds; the four legacy kinds keep their typed columns.
  3. `result` replaces the need for a per-kind id column, which would be polymorphic and break rule 8.
- **Guardrails:**
  - #13: additive and idempotent, `IF NOT EXISTS` everywhere; never touch 029 or 062
  - #8: no new `*_id` columns
- **Proof:**
  1. `npm run migrate` exits 0, then run it again: still exits 0 (idempotent).
  2. `docker exec autodb_postgres psql -U autodb_user -d autodb -c "\d migration_import_rows"` lists `data` and `group_key`.
  3. `npx vitest run src/__tests__/migrations.test.ts` passes (the replay test).
- **If it fails:** a syntax error means fix the new file, which is not applied yet. If the replay test fails, stop and report; do not change the replay test.
- **Owes:** `docs/schema.md`, in Step 12.

### Step 2 — [Sonnet] Types, constant, and commit hardening

- **Model:** [Sonnet]. Transaction boundary and row locking.
- **Depends on:** 1
- **Skill:** none (service edit)
- **Read first:** `migrationImportService.ts` L385-500 and L600-676, then L885-937.
- **Files:** `server/src/types/accounting.ts` (edit, the Phase 9b block), `server/src/config/constants.ts` (edit), `server/src/services/accounting/migrationImportService.ts` (edit)
- **Contract:**

  **(a) `types/accounting.ts`.** Add after `isMigrationRowStatus`:
  ```ts
  export function isMigrationImportStatus(value: string): value is MigrationImportStatus {
    return (MIGRATION_IMPORT_STATUSES as readonly string[]).includes(value);
  }

  export type MigrationCommitResult =
    | { kind: 'CHART_OF_ACCOUNTS'; createdCount: number; mergedCount: number }
    | { kind: 'OPENING_BALANCES'; journalEntryId: string; plugCents: number }
    | { kind: 'CUSTOMERS' | 'VENDORS'; createdCount: number; mergedCount: number };

  /** One CSV column an import kind understands (Phase 36). */
  export interface ImportColumnDef {
    key: string;
    /** The template header. Required columns carry a leading '*', Xero-style. */
    header: string;
    label: string;
    required: boolean;
    /** Already-lowercased synonyms; compared through compactHeader. */
    synonyms: readonly string[];
    note: string;
    example: string;
    /** false = accepted on upload but left out of the downloadable template. */
    inTemplate: boolean;
  }

  /** One field the review page lets a user fix on a staged row (a PATCH body key). */
  export interface ImportEditFieldDef {
    key: string;
    label: string;
    input: 'text' | 'money' | 'accountType';
    maxLength: number | null;
    nullable: boolean;
  }

  export interface ImportKindMeta {
    kind: MigrationImportKind;
    label: string;
    /** Plural noun for counts, lowercase: 'accounts', 'customers'. */
    noun: string;
    columns: readonly ImportColumnDef[];
    /** At least one of these key sets must be fully mapped. Empty = no such rule. */
    requiredOneOf: readonly (readonly string[])[];
    /** 422 text per column key when that column cannot be resolved. */
    missingMessages: Readonly<Record<string, string>>;
    editFields: readonly ImportEditFieldDef[];
  }

  export interface MigrationImportInspection {
    kind: MigrationImportKind;
    headers: string[];
    delimiter: string;
    rowCount: number;
    /** First 5 data rows, cells aligned to `headers`. */
    sampleRows: string[][];
    /** Column key -> the file header it resolved to, or null. Every key of the kind is present. */
    suggestedMap: Record<string, string | null>;
    /** Column keys a stage attempt would reject as missing, in rejection order. */
    missingRequired: string[];
    /** True when nothing is missing and every file header is one of the kind's template headers. */
    exactMatch: boolean;
  }
  ```
  To `MigrationImport`, add these after `journalEntryId`:
  - `columnMap: Record<string, string | null> | null;`
  - `result: MigrationCommitResult | null;`

  **(b) `config/constants.ts`.** Next to `MAX_CSV_CHARS`, add `export const MAX_IMPORT_ROWS = 5000;` with a one-line comment: "Phase 36 — one staged import's data-row cap; bounds revalidation and commit time."

  **(c) `migrationImportService.ts`:**
  - Delete the local `CommitResult` union (L885-888) and write `export type CommitResult = MigrationCommitResult;`, importing it from types.
  - Add `column_map` and `result` to `ImportRow` and to `IMPORT_SELECT`, as `i.column_map, i.result`. Map them in `toImport` as `columnMap: row.column_map, result: row.result`.
  - Add these fields to `ImportRow`: `column_map: Record<string, string | null> | null; result: MigrationCommitResult | null;`.
  - In `toImport`, replace the four-way kind check with `if (!isMigrationImportKind(row.kind)) throw new Error(...)`, keeping the same message.
  - `revalidateOnClient`: replace the per-row UPDATE loop (L648-659) with one statement:
    ```sql
    UPDATE migration_import_rows AS r
       SET errors = ARRAY(SELECT jsonb_array_elements_text(v.errors_json::jsonb)),
           status = v.status
      FROM unnest($1::uuid[], $2::text[], $3::text[]) AS v(id, errors_json, status)
     WHERE r.id = v.id AND r.org_id = $4 AND r.import_id = $5
    ```
    Parameters:
    - `$1` = `stagedRows.map(r => r.id)`
    - `$2` = `stagedRows.map(r => JSON.stringify(errorsByRowId.get(r.id) ?? []))`
    - `$3` = the per-row status, `'VALID'` or `'INVALID'`
    - `$4` = orgId, `$5` = importId

    Compute `errorCount` in a plain loop before the statement. Skip the statement when `stagedRows.length === 0`.
  - `commit(orgId, createdBy, importId)`: delete the `getImportById` pre-check before `pool.connect()`. The first statement after `beginTransaction(client)` is:
    ```sql
    SELECT kind, status, error_count FROM migration_imports WHERE id = $1 AND org_id = $2 FOR UPDATE
    ```
    Then:
    - no row → `throw new ApiError(404, 'Migration import not found')`
    - `status === 'COMMITTED'` → `throw new ApiError(409, 'This import has already been committed')`
    - `status !== 'VALIDATED'` → `throw new ApiError(409, \`Fix ${String(error_count)} invalid row(s) before committing\`)`

    Keep the existing if/else dispatch for now; Step 5 replaces it. After the kind's commit, run this before `COMMIT`:
    ```sql
    UPDATE migration_imports SET result = $1::jsonb WHERE id = $2 AND org_id = $3
    ```
    with `$1` = `JSON.stringify(result)`. Keep the existing catch mapping unchanged.
- **Guardrails:**
  - #5: the lock and every read inside the commit use `client`, never `pool`
  - #1: `org_id` in every new statement
  - #4: parameters only
- **Proof:** `npm run typecheck` exits 0, then `npx vitest run src/__tests__/accounting/chartImport.test.ts src/__tests__/accounting/openingBalanceImport.test.ts src/__tests__/accounting/partyImport.test.ts src/__tests__/accounting/migrationImportConstraints.test.ts` passes, all tests, unedited.
- **If it fails:** a legacy test failing means the refactor is wrong. Fix the service.
- **Owes:** the study note, in Step 11 (the `FOR UPDATE` guard, the batched `unnest` update).

### Step 3 — [Haiku] Pure column-resolution util + unit tests

- **Model:** [Haiku]. A pure function whose algorithm is written out below.
- **Depends on:** 2
- **Skill:** none
- **Read first:** `server/src/utils/matchScore.ts` L50-63 for the house style of a small pure util with a doc comment, and `server/src/__tests__/csv.test.ts` for a pure-util test file.
- **Files:** `server/src/utils/importColumns.ts` (new), `server/src/__tests__/importColumns.test.ts` (new)
- **Contract:**
  ```ts
  import { ApiError } from './apiError.js';
  import type { ImportColumnDef } from '../types/accounting.js';

  /** 'Contact Name*', '*ContactName', 'contact_name' all -> 'contactname'. */
  export function compactHeader(value: string): string; // value.toLowerCase().replace(/[^a-z0-9]/g, '')

  /**
   * Column key -> header index (or null). Every key in `columns` appears in the result.
   * Pass 1 (explicit): for each [key, header] in `columnMap` (skip when columnMap is null):
   *   - key not in columns -> ApiError(400, `Unknown column "${key}" for a ${kindLabel} import`)
   *   - header === null -> result[key] = null
   *   - idx = headers.findIndex(h => h.trim() === header.trim()); -1 ->
   *       ApiError(400, `The file has no column named "${header}"`)
   *   - idx already claimed -> ApiError(400, `Column "${header}" is mapped to more than one field`)
   *   - claim idx; result[key] = idx
   * Pass 2 (automatic), in `columns` order, for keys not set in pass 1:
   *   candidates = [compactHeader(col.header), ...col.synonyms.map(compactHeader)]
   *   for each candidate in order: first header index j with compactHeader(headers[j]) === candidate
   *   and j not claimed -> claim j, result[key] = j, stop. None -> result[key] = null.
   */
  export function resolveColumnIndexes(
    headers: readonly string[],
    columns: readonly ImportColumnDef[],
    columnMap: Readonly<Record<string, string | null>> | null,
    kindLabel: string,
  ): Record<string, number | null>;

  /**
   * Keys in rejection order: every `required` column whose index is null, in column order;
   * then, if requiredOneOf is non-empty and no set has every key non-null, the keys of the
   * FIRST set whose index is null.
   */
  export function findMissingRequired(
    columns: readonly ImportColumnDef[],
    requiredOneOf: readonly (readonly string[])[],
    resolved: Readonly<Record<string, number | null>>,
  ): string[];
  ```
  Test cases, with these exact names:
  1. `compactHeader strips the asterisk, spaces and punctuation`: `'*Contact Name'` → `'contactname'`, `'E-mail'` → `'email'`.
  2. `template header wins before synonyms`: the header row `['Name', '*ContactName']` with a column `{header: '*ContactName', synonyms: ['name']}` resolves to index 1.
  3. `a header is claimed once`: two columns both with synonym `'name'` and headers `['Name']` resolve to the first column 0 and the second null.
  4. `explicit map overrides automatic`, `explicit null un-maps`.
  5. The three 400 messages, each exact: unknown key, missing header, duplicate header.
  6. `findMissingRequired reports required columns before one-of sets`.
  7. `a satisfied one-of set reports nothing`.
- **Guardrails:** none bite; this is a pure function.
- **Proof:** `npx vitest run src/__tests__/importColumns.test.ts` passes, and `npm run typecheck` exits 0.
- **If it fails:** fix the function, never the expected values.
- **Owes:** nothing.

### Step 4 — [Sonnet] Move the row parsers out, keyed by column key

- **Model:** [Sonnet]. A behaviour-preserving refactor, guarded by the legacy tests.
- **Depends on:** 3
- **Skill:** none
- **Read first:** `migrationImportService.ts` L182-368.
- **Files:** `server/src/services/accounting/importRowParsers.ts` (new), `migrationImportService.ts` (edit: delete the moved code)
- **Contract:** Move `StagedRowInput`, `NULL_PARTY_FIELDS`, `ACCOUNT_TYPE_ALIASES`, `normalizeAccountType` and the three parsers into the new file, all exported. Add:
  ```ts
  export type ResolvedImportColumns = Readonly<Record<string, number | null>>;
  /** Trimmed cell text for a column key; '' when unmapped or absent. */
  function cellText(cells: readonly string[], columns: ResolvedImportColumns, key: string): string;
  export function parseChartRow(cells: readonly string[], columns: ResolvedImportColumns, rowNumber: number): StagedRowInput;
  export function parseOpeningRow(cells: readonly string[], columns: ResolvedImportColumns, rowNumber: number): StagedRowInput;
  export function parsePartyRow(cells: readonly string[], columns: ResolvedImportColumns, rowNumber: number): StagedRowInput; // renamed from parseCustomerRow
  ```
  Rewrite each parser's index reads to `cellText(cells, columns, '<key>')`. The column keys are:
  - chart: `code`, `name`, `type`, `parent`, `description`
  - opening: `code`, `name`, `debit`, `credit`, `amount`
  - party: `partyName`, `partyEmail`, `partyPhone`, `partyAddress`, `partyTaxNumber`, `partyPaymentTerms`, `partyNotes`

  In `parseOpeningRow`:
  - the amount branch runs when `columns.amount != null`
  - the debit/credit branch runs when both `columns.debit != null && columns.credit != null`

  Keep every `raw` key, every `.slice(0, n)` limit and every null-on-parse-failure exactly as it is today.

  Replace `ACCOUNT_TYPE_ALIASES` with the table below. Keys are lowercase and `normalizeAccountType` is unchanged:

  | Type | Aliases |
  |---|---|
  | Asset | asset, assets, bank, current asset, current assets, fixed asset, fixed assets, non-current asset, non current asset, inventory, prepayment, accounts receivable, accounts receivable (a/r), other current asset, other current assets, other asset, other assets |
  | Liability | liability, liabilities, current liability, current liabilities, non-current liability, non current liability, term liability, long term liability, long term liabilities, accounts payable, accounts payable (a/p), credit card, other current liability, other current liabilities |
  | Equity | equity |
  | Revenue | revenue, income, sales, other income |
  | Expense | expense, expenses, direct costs, overhead, overheads, depreciation, cost of goods sold, cogs, cost of sales, other expense |

  **Temporary bridge in `migrationImportService.ts`,** removed in Step 5: delete `ResolvedColumns`, `nullAccountColumns`, `findColumnBySynonyms`, `resolveColumns` and `parseRows`. Do NOT delete the synonym arrays (L53-75); Step 5 moves them. Until Step 5 lands, `createImport` will not compile. **Steps 4 and 5 therefore share one proof, run at the end of Step 5.** The proof for Step 4 alone is `npx tsc --noEmit -p . 2>&1 | grep importRowParsers` printing nothing.
- **Guardrails:** none new. Behaviour must not change.
- **Proof:** as stated above.
- **If it fails:** fix the new file.
- **Owes:** nothing.

### Step 5 — [Sonnet] The kind registry, and the service rewired onto it

- **Model:** [Sonnet]. It touches the service across all four kinds.
- **Depends on:** 4
- **Skill:** new-module (service layer)
- **Read first:** `types/accounting.ts` `MIGRATION_IMPORT_TRANSITIONS` (the `satisfies Record<…>` idiom to copy), and the three kind services' exported signatures listed under Starting state.
- **Files:** `server/src/services/accounting/importKinds.ts` (new), `migrationImportService.ts` (edit)
- **Contract:**
  ```ts
  export interface ImportKindDef extends ImportKindMeta {
    parseRow(cells: readonly string[], columns: ResolvedImportColumns, rowNumber: number): StagedRowInput;
    validateRows(client: PoolClient, orgId: string, rows: readonly MigrationImportRow[]): Promise<{ rowId: string; errors: string[] }[]>;
    preview(client: PoolClient, orgId: string, importId: string): Promise<MigrationCommitPreview>;
    commitOnClient(client: PoolClient, orgId: string, importId: string, createdBy: string): Promise<MigrationCommitResult>;
  }
  export const IMPORT_KINDS = { CHART_OF_ACCOUNTS: {…}, OPENING_BALANCES: {…}, CUSTOMERS: {…}, VENDORS: {…} }
    satisfies Record<MigrationImportKind, ImportKindDef>;
  export function getImportKind(kind: MigrationImportKind): ImportKindDef; // IMPORT_KINDS[kind]
  /** Metadata only — every function-valued property stripped. Order = MIGRATION_IMPORT_KINDS. */
  export function listImportKindMeta(): ImportKindMeta[];
  ```
  Handler wiring. Each handler adapts a service's result into `MigrationCommitResult`:
  - chart: `parseChartRow`, `chartImportService.validateRows`, `.preview`. `commitOnClient` → `{kind:'CHART_OF_ACCOUNTS', createdCount: created, mergedCount: merged}`.
  - opening: `parseOpeningRow`, `openingBalanceImportService.*`. Its commit passes `createdBy` → `{kind:'OPENING_BALANCES', journalEntryId, plugCents}`.
  - CUSTOMERS and VENDORS: `parsePartyRow`; `validateRows` is `(c, o, rows) => partyImportService.validateRows(c, o, '<KIND>', rows)`; `.preview`; the commit → `{kind:'<KIND>', createdCount, mergedCount}`.

  Metadata, written literally. Synonyms are the service's existing arrays, moved here, plus the additions marked **+**.

  **CHART_OF_ACCOUNTS** — label `Chart of accounts`, noun `accounts`, requiredOneOf `[]`.

  | key | header | label | req | synonyms | note | example |
  |---|---|---|---|---|---|---|
  | code | `*Code` | Account code | ✓ | code, account code, account, account number, gl code | Up to 20 characters. A code that already exists is merged (name and description updated), never duplicated. | 4100 |
  | name | `*Name` | Account name | ✓ | name, account name, description, title | Up to 120 characters. | Product Revenue |
  | type | `*Type` | Account type | ✓ | type, account type, category | Asset, Liability, Equity, Revenue or Expense. Xero and QuickBooks type names such as Bank, Current Asset, Direct Costs or Other Income are converted automatically. | Revenue |
  | parent | `Parent` | Parent account code | | parent, parent code, parent account | The parent account's code. It must exist (or be in this file) and have the same type. | 4000 |
  | description | `Description` | Description | | notes, memo, long description | Up to 500 characters. | Sales of physical goods |

  - missingMessages:
    - `code`: `Could not find an account code column in the file`
    - `name`: `Could not find an account name column in the file`
    - `type`: `Could not find an account type column in the file`
  - editFields:
    - `accountCode` (text, 20, nullable false)
    - `accountName` (text, 120, false)
    - `accountType` (accountType, null, false)
    - `parentCode` (text, 20, true)
  - Labels: Code, Name, Type, Parent.
  - **Deliberate behaviour change:** a chart file with no name column is now a 422 rather than every row INVALID. It is documented in Step 12.

  **OPENING_BALANCES** — label `Opening balances`, noun `balances`, requiredOneOf `[['debit','credit'],['amount']]`.

  | key | header | label | req | synonyms | inTemplate | note | example |
  |---|---|---|---|---|---|---|---|
  | code | `*Code` | Account code | ✓ | (code synonyms) | ✓ | An existing account you can post to. Retained earnings, Accounts Receivable, Accounts Payable and inventory accounts are refused — bring those in as open invoices, bills and opening stock. | 1110 |
  | name | `Name` | Account name | | (name synonyms) | ✓ | For your reference only; the account is matched by code. | Operating bank account |
  | debit | `Debit` | Debit | | debit, dr, debit amount | ✓ | Use Debit and Credit, or a single signed Amount column. | 50000.00 |
  | credit | `Credit` | Credit | | credit, cr, credit amount | ✓ | Leave blank when the row is a debit. | *(empty)* |
  | amount | `Amount` | Signed amount | | amount, balance, opening balance | ✗ | Instead of Debit and Credit: positive is a debit, negative a credit. | 50000.00 |

  - missingMessages:
    - `code`: the code message above
    - `debit`, `credit`, `amount`: all `Could not find an amount column, or a debit/credit pair, in the file`
  - editFields:
    - `accountCode` (text, 20, false, label Code)
    - `debitCents` (money, null, false, label Debit)
    - `creditCents` (money, null, false, label Credit)

  **CUSTOMERS** — label `Customers`, noun `customers`, requiredOneOf `[]`.

  | key | header | label | req | synonyms | note | example |
  |---|---|---|---|---|---|---|
  | partyName | `*ContactName` | Name | ✓ | name, customer, vendor, supplier, company, display name, customer name, vendor name, company name, **+contact name, +contact** | Up to 200 characters. Matched to an existing customer by email, then by name; a match only fills that customer's blank fields. | Northwind Traders |
  | partyEmail | `EmailAddress` | Email | | email, e mail, email address, contact email | Up to 254 characters. | ap@northwind.test |
  | partyPhone | `Phone` | Phone | | phone, telephone, phone number, contact phone, mobile | Up to 40 characters. | 555-0100 |
  | partyAddress | `BillingAddress` | Billing address | | address, billing address, street, postal address, **+po address line 1, +sa address line 1** | Up to 500 characters. | 1 Main St |
  | partyTaxNumber | `TaxNumber` | Tax number | | tax number, tax id, vat, vat number, gst, gstin, abn, ein | Up to 64 characters. | TAX-1 |
  | partyNotes | `Notes` | Notes | | notes, memo, comment, comments | Up to 1000 characters. | Migrated from prior system |

  - missingMessages: `partyName` → `Could not find a name column in the file`
  - editFields:
    - `partyName` (text, 200, false, Name)
    - `partyEmail` (text, 254, true, Email)
    - `partyPhone` (text, 40, true, Phone)
    - `partyTaxNumber` (text, 64, true, Tax number)

  **VENDORS** — the same as CUSTOMERS, with these differences:
  - label `Vendors`, noun `vendors`
  - the partyName note reads "…existing vendor…", example `Acme Supplies`
  - one extra column before `partyNotes`: `partyPaymentTerms`, header `PaymentTerms`, label Payment terms, synonyms `terms, payment terms, payment term`, note `Up to 500 characters.`, example `Net 30`

  Every column not marked otherwise has `inTemplate: true`. `required` false is the default.

  **Rewire `migrationImportService.ts`:**
  - Delete the synonym arrays.
  - `createImport(orgId, createdBy, input: { kind; fileName; content; columnMap: Record<string, string | null> | null })`:
    1. `const def = getImportKind(input.kind); const table = parseCsv(input.content);`
    2. If `table.rows.length > MAX_IMPORT_ROWS`, throw `ApiError(422, \`This file has ${String(table.rows.length)} data rows; one import takes at most ${String(MAX_IMPORT_ROWS)} — split it into smaller files\`)`.
    3. `const columns = resolveColumnIndexes(table.headers, def.columns, input.columnMap, def.label)`.
    4. `const missing = findMissingRequired(def.columns, def.requiredOneOf, columns)`. If it is non-empty, throw `ApiError(422, def.missingMessages[missing[0]] ?? \`Could not find a "${label of missing[0]}" column in the file\`)`.
    5. `parsed = table.rows.map((cells, i) => def.parseRow(cells, columns, i + 2))`.
    6. The `INSERT INTO migration_imports` gains `column_map`, as `$7::jsonb`, set to `input.columnMap === null ? null : JSON.stringify(input.columnMap)`.
  - `revalidateOnClient`: replace the kind if/else with `results = await getImportKind(importKind).validateRows(client, orgId, stagedRows)`. `importKind` must be narrowed with `isMigrationImportKind` first; otherwise throw the existing unknown-kind Error.
  - `preview`: `return withTransaction((client) => getImportKind(imp.kind).preview(client, orgId, importId))`.
  - `commit`: after the `FOR UPDATE` checks from Step 2, narrow `kind` with `isMigrationImportKind`, then `const result = await getImportKind(kind).commitOnClient(client, orgId, importId, createdBy)`.
  - New export:
    ```ts
    export function inspectImport(input: { kind: MigrationImportKind; content: string }): MigrationImportInspection;
    ```
    It runs the same parse and 422 row-cap check, then `resolveColumnIndexes(headers, def.columns, null, def.label)` and `findMissingRequired`. It **does not throw** on a missing required column; it reports it instead. It returns:
    - `suggestedMap`: each key → `headers[idx]`, or null
    - `sampleRows`: `table.rows.slice(0, 5)`
    - `exactMatch`: `missingRequired.length === 0 && table.headers.every(h => templateCompacts.has(compactHeader(h)))`, where `templateCompacts` is the set of `compactHeader(col.header)` over `def.columns`

    It touches no database, so it takes no `orgId`.
  - `listImports`: `ListImportsOptions` gains `status: MigrationImportStatus | null`, added as another `i.status = $n` clause, the same way as `kind`.
  - Update the file's header doc comment: it now mentions `columnMap` and the registry.
- **Guardrails:**
  - #4: column keys never reach SQL (only the frozen PATCH map does)
  - #1: unchanged
  - #16: n/a
- **Proof:** `npm run typecheck` exits 0, then `npx vitest run src/__tests__/accounting/chartImport.test.ts src/__tests__/accounting/openingBalanceImport.test.ts src/__tests__/accounting/partyImport.test.ts src/__tests__/accounting/migrationImportConstraints.test.ts src/__tests__/importColumns.test.ts` passes, with the legacy files unedited.
- **If it fails:** a changed 422 message means fix `missingMessages`. A changed row value means fix the parser.
- **Owes:** the study note on registry and strategy dispatch, and `satisfies`, in Step 11.

### Step 6 — [Haiku] Schema, controller, routes

- **Model:** [Haiku]. Transcription; the contract is below.
- **Depends on:** 5
- **Skill:** new-module (controller/routes)
- **Read first:** `controllers/accounting/migrationImportController.ts` (copy the `create` and `list` handlers) and `routes/accounting/migrationImportRoutes.ts`.
- **Files:** `schemas/accounting/migrationImportSchema.ts`, `controllers/accounting/migrationImportController.ts`, `routes/accounting/migrationImportRoutes.ts` (all edit)
- **Contract:**
  - Schema. Update the doc comment: `columnMap` now exists; `dateFormat` arrives with Step C.
    ```ts
    export const createMigrationImportSchema = z.object({
      kind: z.enum(MIGRATION_IMPORT_KINDS),
      fileName: z.string().trim().min(1).max(200),
      content: z.string().min(1).max(MAX_CSV_CHARS),
      columnMap: z.record(z.string().min(1).max(64), z.string().trim().min(1).max(200).nullable()).nullable().default(null),
    });
    export const inspectMigrationImportSchema = z.object({
      kind: z.enum(MIGRATION_IMPORT_KINDS),
      content: z.string().min(1).max(MAX_CSV_CHARS),
    });
    ```
  - Controller:
    - `kinds`: `res.json({ success: true, kinds: listImportKindMeta() })`
    - `inspect`: `parseBody(inspectMigrationImportSchema, req.body)` → `res.json({ success: true, inspection: migrationImportService.inspectImport(input) })`
    - `list`: the kind error message becomes `kind must be one of ${MIGRATION_IMPORT_KINDS.join(', ')}`. Add a `status` query param, parsed like `kind` with `isMigrationImportStatus`; its error is `status must be DRAFT, VALIDATED or COMMITTED`.
  - Routes. Insert **before** `router.get('/:id', …)`:
    ```ts
    router.get('/kinds', authenticate, migrationImportController.kinds);
    router.post('/inspect', authenticate, requireRole('OWNER', 'ADMIN', 'ACCOUNTANT'), migrationImportController.inspect);
    ```
- **Guardrails:** #2: no SQL and no parsing logic in the controller.
- **Proof:** `npm run typecheck` exits 0, and `npm run lint` exits 0.
- **If it fails:** fix types only.
- **Owes:** `docs/api.md`, in Step 12.

### Step 7 — [Sonnet] Integration tests: mapping, inspect, commit hardening, isolation

- **Model:** [Sonnet]. Integration tests against real PostgreSQL, including concurrency.
- **Depends on:** 6
- **Skill:** isolation-test
- **Read first:** `server/src/__tests__/accounting/partyImport.test.ts` (copy its setup block verbatim) and `__tests__/tenantIsolation.test.ts:137-148` (the VIEWER pattern).
- **Files:** `server/src/__tests__/accounting/importMapping.test.ts` (new), `server/src/__tests__/accounting/migrationImportConstraints.test.ts` (edit: **append** cases only)
- **Contract:** in `importMapping.test.ts`, write these tests with these exact names and assertions:
  1. `GET /kinds lists the four kinds with template metadata`:
     - 200
     - `kinds.map(k => k.kind)` equals `['CHART_OF_ACCOUNTS','OPENING_BALANCES','CUSTOMERS','VENDORS']`
     - the CUSTOMERS first column has `header === '*ContactName'` and `required === true`
     - OPENING `requiredOneOf` equals `[['debit','credit'],['amount']]`
  2. `GET /kinds requires authentication`: a plain `request(app)` gets 401.
  3. `inspect: our own template is an exact match`: CUSTOMERS, content `'*ContactName,EmailAddress\nAcme,a@x.test'` →
     - 200, `exactMatch` true, `missingRequired` `[]`, `rowCount` 1
     - `suggestedMap.partyName` is `'*ContactName'`, `suggestedMap.partyEmail` is `'EmailAddress'`
     - `sampleRows` equals `[['Acme','a@x.test']]`
  4. `inspect: foreign headers resolve by synonym but are not an exact match`: `'Contact Name,Email Address,Mobile\nAcme,a@x.test,555'` → `exactMatch` false; `suggestedMap` has `partyName` 'Contact Name', `partyEmail` 'Email Address', `partyPhone` 'Mobile'.
  5. `inspect: a missing required column is reported, not rejected`: `'Foo,Bar\n1,2'` → 200, `missingRequired` `['partyName']`, `suggestedMap.partyName` null.
  6. `inspect: more than 5000 rows is 422`: 5001 data rows → 422, and the `error` contains `'at most 5000'`.
  7. `inspect is refused to a VIEWER`: 403.
  8. `stage with a column map`: CUSTOMERS content `'Customer Title,Mail\nAcme,a@x.test'` with `columnMap {partyName:'Customer Title', partyEmail:'Mail'}` →
     - 201, `import.columnMap` equals that map
     - `GET /:id/rows` gives `rows[0].partyName` 'Acme' and `partyEmail` 'a@x.test'
  9. `column map: unknown key is 400`: `{bogus:'Name'}` → 400, error `'Unknown column "bogus" for a Customers import'`.
  10. `column map: a header not in the file is 400`: `{partyName:'Nope'}` → 400, error `'The file has no column named "Nope"'`.
  11. `column map: one header mapped twice is 400`: `{partyName:'Name', partyEmail:'Name'}` → 400, error `'Column "Name" is mapped to more than one field'`.
  12. `column map: explicit null wins over automatic`: content `'Name\nAcme'`, map `{partyName:null}` → 422, error `'Could not find a name column in the file'`.
  13. `compact matching accepts starred template headers`: CHART `'*Code,*Name,*Type\n9100,Custom Root,Asset'` → 201, `errorCount` 0.
  14. `Xero account types are converted`: CHART `'Code,Name,Type\n9100,Bank X,Bank\n9200,Overheads X,Overhead'` → the rows' `accountType` values are `['Asset','Expense']`, `errorCount` 0.
  15. `a chart file with no name column is 422`: `'Code,Type\n9100,Asset'` → 422, error `'Could not find an account name column in the file'`.
  16. `commit persists its result`: stage CUSTOMERS `'Name\nAcme'` and commit it; `GET /:id` returns `import.result` equal to `{kind:'CUSTOMERS', createdCount:1, mergedCount:0}`.
  17. `a second commit is 409`: commit again → 409, error `'This import has already been committed'`.
  18. `two concurrent commits: exactly one succeeds`: `Promise.all` of two commits on a fresh VALIDATED import →
      - the sorted statuses equal `[200, 409]`
      - `SELECT count(*) FROM customers WHERE org_id=$1 AND name='Acme'` (through `pool`) returns 1
  19. `list filters by status`: after test 16's setup, `GET /?status=COMMITTED` gives `totalCount` 1; `GET /?status=BOGUS` gives 400.
  20. `cross-tenant: org B cannot read, fix or commit org A's import`: org C's agent gets 404 on `GET /:id`, on `PATCH /:id/rows/:rowId` with `{partyName:'X'}`, and on `POST /:id/commit`.

  Append to `migrationImportConstraints.test.ts`, as raw SQL through `pool`:
  - `the widened kind CHECK admits ITEMS and rejects BOGUS`: the second insert fails with SQLSTATE `23514`.
  - `data must be a JSON object`: an insert of a row with `data = '[]'` gives `23514`.
  - `column_map must be a JSON object`: an update with `column_map = '"x"'` gives `23514`.
- **Guardrails:**
  - #15: the cross-tenant case is test 20
  - #1: fixtures create both orgs through the factories
- **Proof:** `npx vitest run src/__tests__/accounting/importMapping.test.ts src/__tests__/accounting/migrationImportConstraints.test.ts` passes, and the full `npm test` passes, with 2 skipped as before.
- **If it fails:** fix the service. Never change an expected message except to match the Step 3 and Step 5 contract text, which is the spec.
- **Owes:** nothing.

---

## Slice 2 — Client: wizard, mapping, guides, generic review, Import buttons

Outcome: every import starts from a section's Import button or the Imports page and goes Upload → Map columns → Review & fix → Commit. Templates and fields come from `/kinds`, and every screen has a how-to guide beside it.

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| API wrappers (edit `services/fetchServices.ts`) | `getMigrationImportKinds`, `inspectMigrationImport`; types `ImportColumnMeta`, `ImportEditFieldMeta`, `ImportKindMeta`, `MigrationImportInspection` |
| Folder | `client/src/Pages/accounting/imports/` |
| Hook | `imports/useImportKinds.ts` → `useImportKinds()` |
| Guide data | `imports/importGuides.ts` → `IMPORT_GUIDES`, `MIGRATION_STEPS`, `ImportGuide`, `MigrationStep` |
| Components | `imports/ImportSteps.tsx`, `imports/ImportGuidePanel.tsx`, `imports/ColumnMapper.tsx` (+ export `mappingProblems`), `imports/ImportRowsTable.tsx` |
| Button | `client/src/components/imports/ImportButton.tsx` |
| Util | `client/src/utils/safeReturnTo.ts` → `safeReturnTo` |
| Test fixture | `client/src/__tests__/fixtures/importKinds.ts` → `IMPORT_KINDS_FIXTURE` |
| Tests | `client/src/__tests__/importWizard.test.tsx` (new), `importButton.test.tsx` (new), `migrationImport.test.tsx` (edit) |

### Step 8 — [Haiku] API wrappers, hook, return-to util, template helpers

- **Model:** [Haiku]. Transcription of the server types.
- **Depends on:** 6
- **Skill:** none (client)
- **Read first:** `services/fetchServices.ts` L2813-2989, and `Pages/accounting/MigrationImportsPage.tsx` L32-50 (the fetch-in-effect pattern with an `ignore` flag).
- **Files:** `services/fetchServices.ts` (edit), `Pages/accounting/imports/useImportKinds.ts` (new), `utils/safeReturnTo.ts` (new), `Pages/accounting/importTemplates.ts` (rewrite), `Pages/settings/ConversionBalancesPage.tsx` (edit L15, L227)
- **Contract:**
  - `fetchServices.ts`:
    - Mirror the server types exactly, as `ImportColumnMeta` (= server `ImportColumnDef`), `ImportEditFieldMeta`, `ImportKindMeta` and `MigrationImportInspection`. Arrays are mutable: `string[]`, `string[][]`.
    - `MigrationImport` gains `columnMap: Record<string, string | null> | null;` and `result: MigrationCommitResult | null;`.
    - `createMigrationImport` body gains `columnMap?: Record<string, string | null> | null`.
    - `listMigrationImports` params gain `status?: MigrationImportStatus`, set in the query like `kind`.
    - `patchMigrationImportRow`'s body type becomes `Record<string, string | number | null>`, with the comment "keys are ImportEditFieldMeta keys from GET /migration-imports/kinds".
    - Add:
      ```ts
      /** GET /migration-imports/kinds */
      export function getMigrationImportKinds(signal?: AbortSignal): Promise<{ success: boolean; kinds: ImportKindMeta[] }>;
      /** POST /migration-imports/inspect — OWNER, ADMIN or ACCOUNTANT. Persists nothing. */
      export function inspectMigrationImport(body: { kind: MigrationImportKind; content: string }): Promise<{ success: boolean; inspection: MigrationImportInspection }>;
      ```
  - `useImportKinds.ts`: `export function useImportKinds(): { kinds: ImportKindMeta[] | null; error: string | null }`. It fetches once on mount with an `AbortController` and aborts on unmount. The error message is `'Could not load import settings'` when `err` is not an `Error`.
  - `safeReturnTo.ts`: `export function safeReturnTo(value: string | null): string | null`. It returns `value` only when it is a string that starts with `'/'`, does not start with `'//'`, contains no `'\\'` and is at most 200 characters long; otherwise null.
  - `importTemplates.ts` keeps `csvField` unchanged, deletes `ImportTemplate` and `IMPORT_TEMPLATES`, and exports:
    ```ts
    /** Header row = inTemplate columns' `header`; second row = their `example`. Trailing newline. */
    export function templateCsv(meta: ImportKindMeta): string;
    export function templateFileName(kind: MigrationImportKind): string; // `autoledger-${kind.toLowerCase().replace(/_/g, '-')}-template.csv`
    ```
  - `ConversionBalancesPage.tsx`: replace the `IMPORT_TEMPLATES` import and L227 with `const header = '*Code,Debit,Credit';`, and import only `csvField`.
- **Proof:** `npm run typecheck` exits 0. `npx vitest run src/__tests__/conversionBalances*` passes, or reports no test files, which is also acceptable. Typecheck will report errors in `NewMigrationImportPage.tsx` and `MigrationImportDetailPage.tsx` until Steps 10–11; **acceptable only for those two files**. Verify with `npx tsc --noEmit 2>&1 | grep -v "NewMigrationImportPage\|MigrationImportDetailPage" | grep error` printing nothing.
- **If it fails:** fix the types.
- **Owes:** nothing.

### Step 9 — [Haiku] Guide content, step indicator, guide panel, Import button

- **Model:** [Haiku]. The copy and layout are written out below.
- **Depends on:** 8
- **Skill:** none
- **Read first:** `components/ui/EmptyState.tsx` (small presentational component style) and `components/layout/nav.ts` (lucide icon imports).
- **Files:** `Pages/accounting/imports/importGuides.ts`, `imports/ImportSteps.tsx`, `imports/ImportGuidePanel.tsx`, `components/imports/ImportButton.tsx` (all new)
- **Contract:**
  ```ts
  export interface ImportGuide { intro: string; steps: string[]; rules: string[] }
  export interface MigrationStep { key: string; label: string; hint: string; to: string; kind: MigrationImportKind | null }
  export const IMPORT_GUIDES: Record<MigrationImportKind, ImportGuide>;
  export const MIGRATION_STEPS: MigrationStep[];
  ```
  Shared `steps` for every kind (write them into each entry):
  1. `Download the template — keep the column headings exactly as they are. Headings starting with * are required.`
  2. `Fill it in with Excel, Google Sheets or Numbers, one row per record, then save or download it as CSV.`
  3. `Upload the file. If your headings differ (for example an export from another system), match each of our fields to one of your columns.`
  4. `Review the rows. Fix or exclude anything flagged in red — nothing is saved to your books yet.`
  5. `Commit. An owner or admin commits; the import is then final.`

  `intro` and `rules` per kind:

  **CHART_OF_ACCOUNTS**
  - intro: `Bring your own account codes and names, or add accounts in bulk.`
  - rules:
    - `A code that already exists updates that account's name and description; it is never duplicated.`
    - `Type must be Asset, Liability, Equity, Revenue or Expense — common Xero and QuickBooks type names are converted for you.`
    - `A parent must already exist or be in the same file, and have the same type.`
    - `Import your chart before customers, products, balances or documents that refer to account codes.`

  **OPENING_BALANCES**
  - intro: `Your trial balance on the conversion date — the balances you carry over from your old system.`
  - rules:
    - `Balances post as one journal entry on your conversion date (Settings → Conversion balances).`
    - `Any difference between debits and credits is posted to 3400 Opening Balance Equity and shown before you commit.`
    - `Retained earnings, Accounts Receivable, Accounts Payable and inventory accounts are refused — bring those in as open invoices, bills and opening stock so each one is tracked.`
    - `Only one opening-balance import can ever be committed. Prefer typing them in? Use Settings → Conversion balances.`

  **CUSTOMERS**
  - intro: `Add your customer list in one go.`
  - rules:
    - `A customer is matched by email, then by name. A match only fills in details that are blank — it never overwrites what you already have.`
    - `Names and emails must be unique within the file.`
    - `Import customers before open invoices that name them.`

  **VENDORS**: the same as CUSTOMERS, with vendor/vendors wording, `bills` for invoices, and one more rule: `Payment terms are free text, e.g. "Net 30".`

  `MIGRATION_STEPS`, in order:
  1. `{key:'conversion-date', label:'Set your conversion date', hint:'The day your AutoLedger books start. Opening balances post on this date.', to:'/settings/conversion-balances', kind:null}`
  2. `{key:'chart', label:'Chart of accounts', hint:'Your account codes, before anything that refers to them.', to:'/migration-imports/new?kind=CHART_OF_ACCOUNTS', kind:'CHART_OF_ACCOUNTS'}`
  3. `{key:'customers', label:'Customers', hint:'Everyone you invoice.', to:'/migration-imports/new?kind=CUSTOMERS', kind:'CUSTOMERS'}`
  4. `{key:'vendors', label:'Vendors', hint:'Everyone who bills you.', to:'/migration-imports/new?kind=VENDORS', kind:'VENDORS'}`
  5. `{key:'opening', label:'Opening balances', hint:'Your trial balance on the conversion date, without receivables, payables or inventory.', to:'/migration-imports/new?kind=OPENING_BALANCES', kind:'OPENING_BALANCES'}`

  Add a code comment: "Steps B–D insert products, open invoices & bills, and opening stock here."

  **`ImportSteps({ current }: { current: 1 | 2 | 3 | 4 })`**
  - An `<ol aria-label="Import progress" className="flex flex-wrap gap-2 text-xs list-none p-0 m-0">` of the labels `['Upload', 'Map columns', 'Review & fix', 'Commit']`.
  - Each item is `<li>` with a number badge.
  - The current item has `aria-current="step"` and accent styling (`bg-[var(--accent-soft)] text-[var(--accent)]`); earlier items use `text-[var(--text)]`; later items use `text-[var(--muted)]`.

  **`ImportGuidePanel({ kind }: { kind: MigrationImportKind })`**
  - An `<aside aria-label="How to import" className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4 flex flex-col gap-3 text-sm">` containing:
    - an `<h3 className="text-sm font-semibold m-0">How to import</h3>`
    - the intro `<p>`
    - an `<ol>` of the steps
    - an `<h4>` reading `Good to know`, followed by a `<ul>` of the rules
    - a `<details>` whose `<summary>` is `Moving from another system mid-year?`. It holds a `<p>` reading `Import in this order so every reference already exists:` and an `<ol>` of `MIGRATION_STEPS`. Each item is a `<Link to={step.to}>{step.label}</Link>` followed by ` — {step.hint}`.
    - a final `<Link to="/migration-imports">See the migration checklist</Link>`

  **`ImportButton({ kind, returnTo }: { kind: MigrationImportKind; returnTo: string })`**
  - `<Link to={\`/migration-imports/new?kind=${kind}&returnTo=${encodeURIComponent(returnTo)}\`} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium border border-[var(--border)] bg-transparent text-[var(--text)] hover:bg-[var(--panel-2)] transition-colors no-underline">`
  - containing `<Upload size={15} aria-hidden="true" /> Import`
  - **No `useAuth`** (see Starting state). The server enforces roles, the same as the pages' "New …" buttons, which are not role-gated either.
- **Proof:** `npx tsc --noEmit 2>&1 | grep -v "NewMigrationImportPage\|MigrationImportDetailPage" | grep error` prints nothing, and `npm run lint` exits 0.
- **If it fails:** fix the new files.
- **Owes:** nothing.

### Step 10 — [Sonnet] Column mapper + the wizard (NewMigrationImportPage rewrite)

- **Model:** [Sonnet]. Multi-state UI with validation logic.
- **Depends on:** 9
- **Skill:** none
- **Read first:** the current `NewMigrationImportPage.tsx` (keep its FileReader code, its `MAX_CSV_CHARS` check and its Blob download), `components/BackLink.tsx` and `components/ui/formClasses.ts`.
- **Files:** `Pages/accounting/imports/ColumnMapper.tsx` (new), `Pages/accounting/NewMigrationImportPage.tsx` (rewrite)
- **Contract:**
  ```ts
  /** Human-readable blockers; empty = OK to stage. */
  export function mappingProblems(meta: ImportKindMeta, value: Record<string, string | null>): string[];
  export default function ColumnMapper(props: {
    meta: ImportKindMeta;
    inspection: MigrationImportInspection;
    value: Record<string, string | null>;
    onChange: (next: Record<string, string | null>) => void;
  }): JSX.Element;
  ```
  `mappingProblems` returns, in this order:
  - for each required column with `value[key]` null: `` `${label} is required` ``
  - if `requiredOneOf` is non-empty and no set is fully mapped: `` `Map ${sets.map(s => s.map(labelOf).join(' and ')).join(', or ')}` ``, which for opening balances reads `Map Debit and Credit, or Signed amount`
  - for each header chosen by two or more keys: `` `"${header}" is used for more than one field` ``

  `ColumnMapper` renders a `<table>` with the head columns `Our field` · `Column in your file` · `Sample values`, and one row per `meta.columns` entry:
  - **Our field** cell: `label`, plus ` *` in `text-[var(--bad)]` when required, plus the `note` in `text-xs text-[var(--muted)]`.
  - **Column in your file** cell: a `<select aria-label={\`Column for ${label}\`}>`. Its first option is value `""`, text `— Don't import —`, followed by one option per `inspection.headers` entry. Choosing `""` sets null.
  - **Sample values** cell: the first 3 non-empty `inspection.sampleRows[r][headerIndex]` values joined with ` · `, or `—`.

  **Wizard state and flow (`NewMigrationImportPage`)**
  - Parameters:
    - `useSearchParams()`: `kindParam` is valid when it is a known key of the loaded kinds
    - `returnTo = safeReturnTo(params.get('returnTo'))`
    - `useImportKinds()`: render `<LoadingState />` while null, and the error `<p className="status status--bad">` when it errors
  - State:
    - `kind` (initially `kindParam ?? 'CHART_OF_ACCOUNTS'`)
    - `stage: 'upload' | 'map'`, `fileName`, `content`
    - `inspection: MigrationImportInspection | null`
    - `mapping: Record<string, string | null>`
    - `showMapper: boolean`, `error`, `busy`
  - Layout: `BackLink` (`to={returnTo ?? '/migration-imports'}`, `label={returnTo !== null ? 'Back' : 'Back to imports'}`), then `<ImportSteps current={stage === 'upload' ? 1 : 2} />`, then a grid `grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]` holding the main column and `<ImportGuidePanel kind={kind} />`.
  - **Upload stage:**
    - Heading `<h2>`: `Import ${meta.label.toLowerCase()}` when a `kindParam` is present. Otherwise the heading is `New import`, with the existing `<select>` labelled `What are you importing?` whose options are `kinds.map(k => <option value={k.kind}>{k.label}</option>)`.
    - A template card:
      - the heading `` `${meta.label} template` ``
      - a `<button>` named `Download template` that saves `templateCsv(meta)` as `templateFileName(kind)`
      - the columns table with the heads `Column` · `Required` · `Notes`, where each row shows `header`, `Yes`/`No` and `note`
      - the line `Headings starting with * are required. Keep headings unchanged to skip the mapping step.`
    - The file `<input type="file" accept=".csv,text/csv">` is labelled `CSV file`.
    - `onload` calls `inspectMigrationImport({ kind, content })`, then sets `inspection`, `mapping = inspection.suggestedMap`, `showMapper = !inspection.exactMatch` and `stage = 'map'`. An inspect error shows in the error `<p>` and stays on upload.
  - **Map stage:**
    - A summary line: `` `${fileName} · ${rowCount} row(s)` ``.
    - When `!showMapper`, a notice `<p className="status status--good">` reading `` `Every column matches the ${meta.label.toLowerCase()} template.` ``, plus a ghost button `Review column mapping` that sets `showMapper` to true. Otherwise `<ColumnMapper …>`.
    - Problems from `mappingProblems` render as a `<ul className="status status--bad">`.
    - Buttons: `Choose a different file` (ghost; back to upload, clears `content` and `inspection`) and `Stage import` (primary; disabled when there are problems or `busy`).
  - **Stage import** calls `createMigrationImport({ kind, fileName, content, columnMap: showMapper ? mapping : null })`, then `navigate(\`/migration-imports/${id}${returnTo !== null ? \`?returnTo=${encodeURIComponent(returnTo)}\` : ''}\`, { replace: true })`.
- **Guardrails:** client-only; no `useAuth`.
- **Proof:** `npx tsc --noEmit 2>&1 | grep -v "MigrationImportDetailPage" | grep error` prints nothing, and `npm run lint` exits 0.
- **If it fails:** fix the component.
- **Owes:** the study note, in Step 11 (metadata-driven forms).

### Step 11a — [Sonnet] Generic review table + detail page refactor + checklist

- **Model:** [Sonnet]. It replaces 250 lines of per-kind markup with metadata-driven rendering.
- **Depends on:** 10
- **Skill:** none
- **Read first:** the current `MigrationImportDetailPage.tsx` in full (keep its preview panel, both `ConfirmDialog`s, delete and commit handlers), `utils/money.ts` (`formatCents`, `parseCentsInput`) and `components/ui/Pagination.tsx`.
- **Files:** `Pages/accounting/imports/ImportRowsTable.tsx` (new), `Pages/accounting/MigrationImportDetailPage.tsx` (edit), `Pages/accounting/MigrationImportsPage.tsx` (edit)
- **Contract:**
  ```ts
  export default function ImportRowsTable(props: {
    meta: ImportKindMeta;
    rows: MigrationImportRow[];
    readOnly: boolean;
    savingRowId: string | null;
    onSave: (row: MigrationImportRow, body: Record<string, string | number | null>) => void;
    onError: (message: string) => void;
  }): JSX.Element;
  ```
  - Read a field with `const record: Record<string, unknown> = { ...row }; const v = record[field.key];`. No casts.
  - Edit text:
    - money: `typeof v === 'number' && v > 0 ? formatCents(v) : ''`
    - otherwise: `typeof v === 'string' ? v : ''`
  - Inputs:
    - text: `<input type="text">`
    - money: `<input inputMode="decimal">`
    - accountType: a `<select>` with `—` plus the five types
    - every input has `aria-label={\`${field.label}, row ${row.rowNumber}\`}`
  - Save builds `body` per field:
    - money: `parseCentsInput(text)`; null → `onError(\`${field.label} must be a valid amount\`)` and abort
    - accountType: send only when not `''`
    - text: trimmed; `''` → `null` when `nullable`, otherwise omit the key
  - Columns: `Row` · one per `editFields` · `Status` · `Errors` · a Save button, omitted when `readOnly`. In `readOnly` mode cells show the value, or `—`.
  - The Save button's accessible name is `Save row ${rowNumber}`, and its visible text is `Save`, or `Saving…` while saving.

  **Detail page:**
  - `const { kinds } = useImportKinds(); const meta = kinds?.find(k => k.kind === imp.kind)`. Show `<LoadingState />` until both `imp` and `meta` are loaded.
  - The subtitle becomes `` `${meta.label} · ${imp.status} · …` ``, which fixes the L195 label bug.
  - Add `<ImportSteps current={imp.status === 'COMMITTED' ? 4 : 3} />` under the BackLink.
  - `returnTo = safeReturnTo(searchParams.get('returnTo'))`. The BackLink goes to `returnTo ?? '/migration-imports'`, labelled `'Back'` or `'Back to imports'`.
  - Rows are paged: `page` state, `limit: 50`, `<Pagination page totalPages shownCount={rows.length} totalCount noun="rows" onPageChange={setPage} />`. Reset to page 1 when the status filter changes.
  - Replace the table with `<ImportRowsTable>`. Delete `RowEdits`, `toEdits` and the per-kind save branches.
  - When COMMITTED and `imp.result` is non-null and not `OPENING_BALANCES`, show a `.card` containing `` `Committed: ${createdCount} created, ${mergedCount} merged.` ``. Keep the existing journal-entry card for opening balances.
  - Place `<ImportGuidePanel kind={imp.kind} />` beside the main column with the same grid as the wizard.

  **MigrationImportsPage:**
  - Fix the subtitle copy to cover all kinds.
  - Rename the header button to `New import`.
  - Add a **Migration checklist** card above the table:
    - `listMigrationImports({ status: 'COMMITTED', limit: 100 })`, then a `Set` of the committed kinds
    - an `<ol>` of `MIGRATION_STEPS`, where each item shows `✓` (`aria-label="done"`) when `step.kind !== null && committed.has(step.kind)`, then a `<Link to={step.to}>{step.label}</Link>`, then the hint in muted text
  - Replace the local `KIND_LABEL` map with a lookup from `useImportKinds()`, falling back to the raw kind string while loading.
- **Proof:** `npm run typecheck` exits 0 and `npm run lint` exits 0.
- **If it fails:** fix the component.
- **Owes:** nothing.

### Step 11b — [Haiku] Import buttons on Accounts, Customers, Vendors

- **Model:** [Haiku]. The same small edit in three files.
- **Depends on:** 9
- **Skill:** none
- **Read first:** the header blocks at `Pages/accounting/AccountsPage.tsx` ~L221-242, `Pages/sales/CustomersPage.tsx` ~L224-238 and `Pages/purchases/VendorsPage.tsx` ~L237-249.
- **Files:** those three (edit)
- **Contract:**
  - AccountsPage: insert `<ImportButton kind="CHART_OF_ACCOUNTS" returnTo="/accounts" />` inside the existing `div.flex.items-center.gap-3`, immediately before the `New account` button.
  - CustomersPage and VendorsPage: wrap the existing `New …` button in `<div className="flex items-center gap-2">`, and put `<ImportButton kind="CUSTOMERS" returnTo="/customers" />` (or `kind="VENDORS" returnTo="/vendors"`) before it.
  - Import path: `'../../components/imports/ImportButton'`.
- **Proof:** `npx vitest run src/__tests__/accounts.test.tsx src/__tests__/customers.test.tsx src/__tests__/vendors.test.tsx` passes, unedited.
- **If it fails:** a missing Router is not possible (they use `MemoryRouter`); report anything else.
- **Owes:** nothing.

### Step 11c — [Sonnet] Client tests

- **Model:** [Sonnet]. UI tests over async flows.
- **Depends on:** 11a, 11b
- **Skill:** none
- **Read first:** `client/src/__tests__/migrationImport.test.tsx` (the `jsonResponse` helper, `vi.stubGlobal('fetch')`, URL routing in `mockImplementation`).
- **Files:** `__tests__/fixtures/importKinds.ts` (new), `__tests__/importWizard.test.tsx` (new), `__tests__/importButton.test.tsx` (new), `__tests__/migrationImport.test.tsx` (edit)
- **Contract:**
  - `IMPORT_KINDS_FIXTURE: ImportKindMeta[]` holds the four kinds, transcribed from the Step 5 tables. Every mock returns it for URLs ending `/migration-imports/kinds`, checked **before** the `/migration-imports/:id` match.
  - `importWizard.test.tsx`, with these exact names:
    1. `locked kind from the URL shows the section title and hides the kind selector`: route `/migration-imports/new?kind=CUSTOMERS&returnTo=%2Fcustomers` → the heading `Import customers`, `queryByLabelText('What are you importing?')` null, and a BackLink `Back` whose href is `/customers`.
    2. `the template table marks required headers`: the `*ContactName` row contains `Yes`.
    3. `Download template builds the CSV from metadata`: spy on `URL.createObjectURL`; the Blob text's first line equals `*ContactName,EmailAddress,Phone,BillingAddress,TaxNumber,Notes`.
    4. `an exact-match file skips the mapper and stages without a column map`:
       - inspect returns `exactMatch: true`
       - the text `Every column matches` shows
       - clicking `Stage import` posts a body with `columnMap: null`
       - it navigates with `?returnTo=%2Fcustomers`
    5. `a mismatched file shows the mapper pre-filled from suggestions`: inspect returns `exactMatch: false` and `suggestedMap {partyName: 'Contact Name', …}` → `getByLabelText('Column for Name')` has value `Contact Name`.
    6. `a required field left unmapped blocks staging`: choose `— Don't import —` for Name → `Name is required` is visible and `Stage import` is disabled.
    7. `the chosen mapping is sent as columnMap`: select `Mail` for Email → the POST body's `columnMap.partyEmail` is `'Mail'`.
    8. `mappingProblems asks for either debit and credit or an amount`: a unit test against the OPENING fixture with everything null except `code` → the result contains `Map Debit and Credit, or Signed amount`.
    9. `the guide panel is shown with the kind's first rule`: `getByRole('complementary', {name: 'How to import'})` contains `matched by email`.
  - `importButton.test.tsx`: `ImportButton links to the wizard with kind and returnTo`. Render `<ImportButton kind="VENDORS" returnTo="/vendors" />` in a `MemoryRouter` → link `Import` with href `/migration-imports/new?kind=VENDORS&returnTo=%2Fvendors`. Add a second case, `safeReturnTo rejects protocol-relative and absolute URLs`: `'//evil.test'`, `'https://x'` and `'\\x'` → null; `'/customers'` → `'/customers'`.
  - `migrationImport.test.tsx`:
    - Delete the three `NewMigrationImportPage` tests, which importWizard supersedes.
    - In `MigrationImportDetailPage`'s `mockRoutes`, serve the fixture for `/kinds`.
    - Keep every detail assertion. Update only selectors that referenced removed markup: a Save button's name becomes `Save row N`.
    - Add `the header names the kind, not "Opening balances", for a customer import`.
    - Add `a committed party import shows created and merged counts from result`.
- **Proof:** `npm test` passes, all files, and `npm run typecheck` exits 0.
- **If it fails:** fix the component, unless a selector targets deleted markup.
- **Owes:** nothing.

---

## Spine

### Step 12 — [Sonnet] Docs sync

- **Model:** [Sonnet] (docs-sync)
- **Depends on:** 7, 11c
- **Skill:** docs-sync
- **Files:**
  - `docs/api.md` § Migration imports (~L794):
    - add the `/kinds` and `/inspect` rows
    - add `columnMap` on `POST /`, the `status` filter on `GET /`, `columnMap` and `result` on the import object
    - add the 422 row cap and the three column-map 400s
    - add the chart name-column 422 (behaviour change)
    - document the commit's `FOR UPDATE` serialization and its 409s
    - delete "There is no `dateFormat` and no `columnMap`"
    - fix the stale `client/src/Pages/importTemplates.ts` path; templates now come from `/kinds`
  - `docs/schema.md`: a Phase 36 block for migration 078.
  - `docs/accounting.md`: a `### Phase 36 — CSV import throughout (36a foundation)` section.
  - `docs/roadmap.md`: a Phase 36 entry with an "as delivered — 36a" heading, recording 36b–d as planned.
  - `CLAUDE.md`: one bullet for Phase 36a.
- **Proof:** the docs-sync skill reports no drift for these routes and tables.
- **Owes:** —

### Step 13 — [Sonnet] Study notes

- **Model:** [Sonnet] (study-note)
- **Depends on:** 7, 11c
- **Skill:** study-note
- **Files:**
  - extend `study/architecture/staged-import-and-two-phase-commit.md`: registry/strategy dispatch replacing if/else chains; inspect-then-stage with a column map; `SELECT … FOR UPDATE` against a double commit (a check-then-act race)
  - extend `study/typescript/const-assertions-and-satisfies.md`: `satisfies Record<Kind, Def>` exhaustiveness
  - extend `study/postgresql/jsonb-user-defined-attributes.md`: a batched `UPDATE … FROM unnest()`, passing text-array-per-row via JSON
  - extend `study/react/schema-driven-forms-and-print-layouts.md`: a server-metadata-driven mapper and editor
  - update `study/README.md` (index and tracker)
- **Proof:** each note has mechanism depth, rejected alternatives and 4–8 Q&As per `docs/study-notes.md`.

### Step 14 — [Sonnet] Guardrail review + full verification

- **Model:** [Sonnet]
- **Depends on:** 12, 13
- **Skill:** guardrail-review
- **Proof:**
  - `cd server && npm run typecheck && npm run lint && npm test && npm run verify:integrity`
  - `cd client && npm run typecheck && npm run lint && npm test`
  - all green, and guardrail-review reports zero violations
- Then set this file's `Status:` to `done — 36a landed`. Delete the file once the Step B plan supersedes it.

---

## Dispatch manifest

| Batch | Step | Tier | Title | Depends on | Blocks | Status |
|---|---|---|---|---|---|---|
| A | 1 | Sonnet | Migration 078 | — | 2 | done |
| A | 2 | Sonnet | Types, constant, commit hardening | 1 | 3 | done |
| B | 3 | Haiku | `importColumns.ts` + unit tests | 2 | 4 | done |
| C | 4 | Sonnet | Move row parsers | 3 | 5 | done |
| C | 5 | Sonnet | Kind registry + service rewire + `inspectImport` | 4 | 6 | done |
| D | 6 | Haiku | Schema, controller, routes | 5 | 7, 8 | done |
| E | 7 | Sonnet | Server integration tests | 6 | 12 | done |
| F | 8 | Haiku | API wrappers, hook, util, templates | 6 | 9 | done |
| F | 9 | Haiku | Guides, steps, panel, ImportButton | 8 | 10, 11b | done |
| G | 10 | Sonnet | ColumnMapper + wizard | 9 | 11a | done |
| G | 11a | Sonnet | Review table + detail page + checklist | 10 | 11c | done |
| H | 11b | Haiku | Import buttons on 3 pages | 9 | 11c | done |
| I | 11c | Sonnet | Client tests | 11a, 11b | 12 | done |
| I | 12 | Sonnet | Docs sync | 7, 11c | 14 | done |
| I | 13 | Sonnet | Study notes | 7, 11c | 14 | done |
| I | 14 | Sonnet | Guardrail review + verification | 12, 13 | — | done |

**How the batches group:**
- Steps 1–2 are one Sonnet batch; Step 3 is Haiku; Steps 4–5 return to Sonnet.
- Steps 4 and 5 **must run together in one session**, because they share Step 5's proof (the service does not compile between them).
- Step 6 is Haiku. Step 7 is Sonnet.
- Steps 8–9 are one Haiku batch; Steps 10–11a are Sonnet; Step 11b is Haiku; Steps 11c–14 are Sonnet.
- Do not batch Step 2 with anything that edits `commit()`.

**Escalations:** none yet.

**Plan defects found during execution:**
- Step 3 (Haiku): `findMissingRequired` first gated the one-of check on no missing required columns; corrected by the same runner, assertion strengthened to the full array.
- Step 7: one transient `ECONNRESET` in a single full-suite run (file unidentified); not reproduced in 2 further full runs or 3 repeated runs of the new files. Watch for flakiness.
- Steps 8–9 (Haiku): client imports were written with `.js` extensions (server idiom) and one untyped catch; corrected by the same runner. Step 8 also added `columnMap: null, result: null` to the `baseImport` fixture in `migrationImport.test.tsx` (outside its file list, needed to compile; accepted).
- Step 11b: the plan said the three list-page tests pass unedited, but the customers/vendors sort tests collect every link on the page (`screen.getAllByRole('link')`), which now includes the Import link. Amended: scope `names()` to the table via `within(screen.getByRole('table')).getAllByRole('link')`, expected values unchanged (not a weakening — the assertion is about table order). Only customers.test.tsx had the page-wide query; vendors.test.tsx was untouched.
- Step 11c: `settingsTabs.test.tsx` asserted the old conversion-balances header `Code,Debit,Credit`; Step 8 changed it to `*Code,Debit,Credit` by contract. Only that expected string was updated.
- Step 5 (regression, caught at Step 12 review): the plan dropped `partyPaymentTerms` from CUSTOMERS claiming customer terms were "parsed and ignored" — wrong: `partyImportService.notesWithTerms` appends them to the customer's notes. Fix: restore the column on CUSTOMERS with `inTemplate: false` + a regression test (Step 12a).
- Step 5: its proof said `npm run typecheck` exits 0, but Step 5 changes `CreateImportInput` (`columnMap`) and `ListImportsOptions` (`status`) that the controller passes, so two controller errors are expected until Step 6. The runner also added `input.columnMap ?? null` in `parseAndResolve` so legacy tests pass before Step 6's schema default lands (harmless afterwards). Accepted; Step 6's typecheck proof closes it.

## Risks & open questions

- **Deliberate behaviour change:** a chart CSV with no name column now fails with a 422 rather than staging all rows INVALID. Nothing tests the old behaviour; `api.md` documents the new one.
- **Customer imports no longer resolve a payment-terms column.** Customers have no payment-terms field, so it was parsed and ignored. VENDORS keeps it.
- **Automatic resolution no longer lets one file column fill two fields.** No legacy synonym set overlaps in a way the current tests exercise; the legacy tests are the gate.
- **`inspectImport` has no `orgId`.** It reads no data. It is still authenticated and role-gated, so it is not an anonymous CSV-parsing endpoint.
- **Copy duplication:** the client guide copy repeats server rules (merge semantics, refused accounts). The server messages stay authoritative, and Step 12 records the duplication in `accounting.md`.
- **Unknown:** whether `walkthroughReplay.ts`'s answer-key test is part of `npm test`. Step 14's full `npm test` settles it either way.

## Definition of done

- Server and client typecheck, lint and tests are green, with the legacy import tests unedited.
- `verify:integrity` is clean and guardrail-review is clean.
- `api.md`, `schema.md`, `accounting.md`, `roadmap.md` and `CLAUDE.md` are synced.
- The four study notes are extended and `study/README.md` is updated.
- In the running app: the Customers page → Import → Download template → upload the same file → "Every column matches" → Stage → review → Commit → "1 created".
- A file with different headers shows the mapper, pre-filled.
