# Phase 36d — CSV import: invoices and bills (expenses)

Date: 2026-10-01 · **Status: done — 36d landed (uncommitted); Phase 36 complete** · Approved design: `/home/ankit/.claude/plans/csv-importer-throughout-the-abundant-cookie.md` (Phase 36, Step D) · Builds on 36a–c (`d2f04a4`, `68dcd01`, `54e3faa`) on branch `phase-36-csv-import`. The 36c plan (`plans/phase-36c-import-journals.md`) holds that step's defect log.

Step D adds two grouped kinds, `INVOICES` and `BILLS` (shown in the UI as "Expenses"). It covers the three user decisions from the approved design:
1. **The user picks at commit:** "Import as drafts" or "Import and post". Post issues the invoices or approves the bills, and is restricted to OWNER/ADMIN (already true for every commit). The posting date is each document's own date or one chosen date.
2. **Imported invoices keep their original number.** A blank number takes the next one from the sequence. The sequence is advanced past imported numbers so it never collides with them. A bill's number is the vendor's reference.
3. **Conversion mode,** chosen when staging. It is for open items dated on or before the conversion date. Those documents post to **3400 Opening Balance Equity** instead of revenue or expense, with tax forced to 0 and no products, on the conversion date. The opening-balance import's AR/AP plug then nets to zero against them, so year-to-date P&L is not counted twice.

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

## Starting state (verified 2026-10-01, after 36c)

**Import machinery** (`server/src/services/accounting/`)
- `importKinds.ts` holds `ImportKindDef`:
  - `parseRow`, `validateRows(client, orgId, rows)`, `preview(client, orgId, importId)`
  - optional `prepareCommit(orgId) → ImportCommitContext`, which is `{ inventoryProfile: string|null }`
  - `commitOnClient(client, orgId, importId, createdBy, context)`
  - optional `groupKeyOf(values, raw)` and `groupNoun`
- `ImportKindMeta` has `kind`, `label`, `noun`, `storage`, `columns`, `requiredOneOf`, `missingMessages`, `editFields` and `groupHeaderFields`.
- There are seven kinds. Data kinds keep their columns in separate files (`importItemColumns.ts`, `importInventoryItemColumns.ts`, `importJournalColumns.ts`) to avoid an import cycle.
- `migrationImportService.ts`:
  - `createImport` applies `groupKeyOf`, enforces `MAX_IMPORT_DOCUMENTS` (1000), and stores `options = {dateFormat}`.
  - `commit` reads the kind and runs `prepareCommit` before BEGIN, then `FOR UPDATE`, then revalidate-at-commit for data kinds, then `commitOnClient`, then `UPDATE result`.
  - `preview` is `withTransaction(def.preview(client, orgId, importId))`.
  - `setRowsStatus` and `listRows` (group-ordered) exist.
- `importRowStore.ts`: `loadDataRowsOnClient`, `markCommittedOnClient`, `importDateFormatOnClient`, `importDateFormatForRowOnClient(client, orgId, rowId)`, `LegacyCommitPreview`.
- `importAccountLookup.ts`: `loadAccountsByCodeOnClient`, `accountCodeError`.
- `importRowParsers.ts`: `parseDataRow`, `dataRowParseErrors`.
- `utils/importValues.ts`: the cell types `text|money|signedMoney|percent|quantity|date|enum`.
- `journalImportService.ts` is the **closest analogue** for a grouped kind: grouping, group labels, row-level vs group-level errors, and the preview/commit shape.
- Migration 078 already admits `INVOICES` and `BILLS`, and has `migration_imports.commit_options JSONB` (unused so far). **No migration is needed.**
- Schemas (`schemas/accounting/migrationImportSchema.ts`): `createMigrationImportSchema` (`kind`, `fileName`, `content`, `columnMap`, `dateFormat`). There is no commit schema; the commit body is ignored today.
- The controller `commit` handler takes no body. The `preview` handler reads no query.

**Documents**
- `invoiceService.ts`:
  - `createInvoiceOnClient(client, orgId, createdBy, input: CreateInvoiceInput): Promise<string>` (L562):
    - it validates the customer (active), resolves the due date (`paymentTermService.resolveDueDate`: an explicit due date wins, otherwise `paymentTermsCode`, otherwise 422 'Provide a due date or a payment term')
    - it runs `assertRevenueAccounts(client, orgId, ids)` (L414: every account must exist, be postable and be type Revenue)
    - it resolves FX at `issueDate` (422 when there is no rate), inserts the draft with `invoice_number` NULL, and inserts the lines; `prepareStockLinesOnClient` refuses lot/serial items and fixed assets and a location on a non-stock line
  - `issueInvoiceOnClient(client, orgId, userId, id, entryDate: string|null)` (L855):
    - `SELECT … FOR UPDATE`
    - stock issue for INVENTORY lines (409 when short)
    - `invoiceSettingsService.allocateInvoiceNumber`, which always allocates a new number
    - `createEntryOnClient` (period check), then `UPDATE status='ISSUED', invoice_number=…`, then `emitEvent`
  - `CreateInvoiceInput`: `customerId, issueDate, dueDate?, currencyCode?, notes, paymentTerms, paymentTermsCode, lines[{description, quantityMilli, unitPriceCents, revenueAccountId, taxRateBp, itemId, stockLocationId?}]`
- `invoiceSettingsService.ts`: `allocateInvoiceNumber(client, orgId)` (L265) runs `UPDATE ledger_invoice_settings SET next_number = next_number + 1 … RETURNING`, giving `${number_prefix}${String(n).padStart(number_padding,'0')}`. The table has `number_prefix` (≤ 12 characters), `number_padding` (1–12) and `next_number INTEGER > 0`. The unique constraint `ux_invoices_org_number (org_id, invoice_number)` allows many NULLs (drafts).
- `billService.ts`:
  - `createBillOnClient(client, orgId, createdBy, input: CreateBillInput)` (L680), going through `insertBillOnClient`
  - `assertExpenseAccounts` (L427): Expense or Asset only
  - the vendor must be active; the draft lands as `DRAFT`
  - `approveBillOnClient(client, orgId, userId, id, entryDate)` (L990): DRAFT → POSTED is legal, as `recurringService.ts:544-566` already does
  - `CreateBillInput`: `vendorId, vendorReference (1–100), billDate, dueDate?, currencyCode?, notes, paymentTerms, paymentTermsCode, lines[{…, expenseAccountId, …}]`
  - the unique constraint `ux_bills_vendor_reference (org_id, vendor_id, vendor_reference)`
- The precedent for create-then-post in one transaction is `recurringService.ts:505-566`.
- `itemService.ts`:
  - `findItemsByCodesOnClient` returns `{id, itemType, isActive}` only
  - `resolveStockAccountsOnClient(client, orgId, ledgerItemIds) → Map<id, {itemType, assetAccountId, cogsAccountId}>` (L562): the item's own account, then settings, then the default chart
  - the `Item` type carries `name`, `description`, `salePriceCents`, `purchasePriceCents`, `revenueAccountId`, `expenseAccountId`, `saleTaxRateBp`, `purchaseTaxRateBp`, `itemType` and `isActive`
- Other tables and helpers:
  - `payment_terms`: `code ^[A-Z0-9_]{2,30}$`, `name`, `net_days`, `is_active`
  - customers and vendors have `name`, `email` and `is_active`; names are not unique
  - `config/currencies.ts`: `SUPPORTED_CURRENCIES`, `CurrencyCode`
  - `fxRateService.requireRateOnClient(client, orgId, from, to, onDate)` throws ApiError 422 when there is no rate. It runs a SELECT and then throws in JS, so catching it does not abort the transaction.
  - the 3400 account is resolved by code, as `openingBalanceImportService.loadCommitConfig` (L144) does: `SELECT id FROM accounts WHERE org_id=$1 AND code='3400'`
  - `ledger_settings.books_start_date` is the conversion date

**Client**
- `client/src/Pages/sales/InvoicesPage.tsx` (header ~L178-193): a lone `New invoice` link.
- `client/src/Pages/purchases/BillsPage.tsx` (~L180-195): a lone `New expense` link, served at `/expenses` and `/bills`.
- Their tests, `invoices.test.tsx` and `bills.test.tsx`, have no page-wide link query.
- `client/src/Pages/accounting/MigrationImportDetailPage.tsx`: the preview panel, a `ConfirmDialog` commit, summary rendering and committed cards.
- `client/src/Pages/accounting/NewMigrationImportPage.tsx`: the wizard, with the date-format select on the map stage.
- `client/src/Pages/accounting/imports/importGuides.ts`: `MIGRATION_STEPS` holds conversion-date, chart, customers, vendors, products, opening, stock, journals. A comment says Step D inserts invoices and bills before `stock`.
- `client/src/services/fetchServices.ts`: the migration-import block.

**Test counts:** 1834 server tests passed (2 skipped); 520 client tests passed.

## Gate

- Phase 36, step D. 36a–c are committed.
- Phases 3.8, 3.9, 8, 24, 32 and 34b (invoices, bills, FX, payment terms, inventory lines, the create+post precedent) are built.
- No migration, no dependency.

## Execution rules

**If a proof command fails twice on the same step, stop and report. Do not improvise around it.**

| Symptom | Forbidden | Correct |
|---|---|---|
| Test fails | Weakening the assertion | Fix the code |
| An existing invoice/bill/credit-note/recurring/import test fails | Editing it | Fix the change. Normal issue and approve must behave **byte-identically** |
| Type error | `as any`, `@ts-ignore` | Fix the type |
| Query returns no rows | Dropping `org_id` | Fix the fixture (rule 1) |
| An amount mismatch | Floats or rounding hacks | `scaleCents`/`sumCents`, integers (rule 3) |
| Wanting to edit a posted invoice or bill | `UPDATE` on a posted row | Never; import only creates (rule 6) |
| Need a library | `npm install` | Stop (rule 14) |
| An undecided choice | Deciding it | Stop and report |

Docker services come up with `docker compose up -d postgres postgres-test redis`. Run server vitest **sequentially**. Server imports use `.js`; client imports are extensionless.

**Anything the plan did not anticipate is a stop-and-report, not a judgment call.**

---

## Slice 1 — Server plumbing: commit modes, conversion mode, document-service hooks

**Names:**

| Kind | Name |
|---|---|
| Types (`types/accounting.ts`) | `ImportCommitMode = 'DRAFT' \| 'POST'`; `ImportPreviewOptions = { mode: ImportCommitMode \| null; postingDate: string \| null }`; `ImportCommitContext` gains `mode` and `postingDate`; `ImportKindMeta` gains `commitModes: readonly ImportCommitMode[]` and `supportsConversionMode: boolean`; `MigrationImport` gains `conversionMode: boolean` and `commitOptions: { mode: ImportCommitMode; postingDate: string \| null } \| null` |
| Row store | `importOptionsForRowOnClient(client, orgId, rowId): Promise<{ dateFormat: DateFormat; conversionMode: boolean }>`, `importOptionsOnClient(client, orgId, importId)` (the same shape) |
| Schemas | `commitMigrationImportSchema`; `createMigrationImportSchema` gains `conversionMode` |
| invoiceService | `CreateInvoiceOptions = { invoiceNumber?: string; equityAccountId?: string }`; `createInvoiceOnClient(…, input, options?)`; `findExistingInvoiceNumbersOnClient` |
| invoiceSettingsService | `advancePastImportedNumbersOnClient(client, orgId, numbers)` |
| billService | `CreateBillOptions = { equityAccountId?: string }`; `createBillOnClient(…, input, options?)`; `findExistingBillReferencesOnClient` |
| itemService | `findItemDefaultsByCodesOnClient` |

### Step 1 — [Sonnet] Commit modes, conversion option, preview options

- **Model:** [Sonnet]. Commit transaction flow and API contract.
- **Depends on:** —
- **Read first:** `migrationImportService.ts` (`createImport`, `preview`, `commit`, `toImport`, `IMPORT_SELECT`), `importKinds.ts`, `importRowStore.ts`, and the migration-import controller and schema.
- **Files:**
  - `types/accounting.ts`
  - `services/accounting/importKinds.ts`
  - `services/accounting/importRowStore.ts`
  - `services/accounting/migrationImportService.ts`
  - `schemas/accounting/migrationImportSchema.ts`
  - `controllers/accounting/migrationImportController.ts`
- **Contract:**
  - **`ImportKindDef`:**
    - `preview(client, orgId, importId, opts: ImportPreviewOptions)`; the existing seven wrappers accept and ignore `opts`
    - optional `commitModes?: readonly ImportCommitMode[]` and `supportsConversionMode?: boolean`
    - `listImportKindMeta` emits `commitModes: def.commitModes ?? []` and `supportsConversionMode: def.supportsConversionMode ?? false`
  - **`ImportCommitContext`:** `{ inventoryProfile: string | null; mode: ImportCommitMode | null; postingDate: string | null }`. Set `mode` and `postingDate` in `commit`, after `prepareCommit`; the existing kinds ignore them.
  - **`createImport`:**
    - its input gains `conversionMode: boolean`
    - `conversionMode && !def.supportsConversionMode` → `ApiError(400, 'conversionMode applies only to invoice and bill imports')`
    - `options = jsonb_build_object('dateFormat', $x::text, 'conversionMode', $y::boolean)`
  - **`IMPORT_SELECT`** adds:
    - `COALESCE((i.options->>'conversionMode')::boolean, false) AS conversion_mode`
    - `i.commit_options`

    Map both in `toImport`; `commitOptions` comes from `commit_options`.
  - **`importOptionsOnClient` / `importOptionsForRowOnClient`:** the same SELECT shape as the existing date-format helpers, returning `{dateFormat, conversionMode}`. Keep the existing date-format helpers.
  - **`preview(orgId, importId, opts)`:** passes `opts` through.
  - **`commit(orgId, createdBy, importId, body: { mode?: ImportCommitMode; postingDate?: string | null })`:**
    - Before BEGIN, after reading the kind (`kindRow`):
      - `def.commitModes` undefined and (`body.mode` or `body.postingDate`) set → `ApiError(400, 'This import kind has no commit options')`
      - `kindRow.conversionMode`:
        - `body.mode === 'DRAFT'` → `ApiError(400, 'Conversion-mode imports are always posted')`
        - a non-null `body.postingDate` → `ApiError(400, 'Conversion-mode imports post on your conversion date')`
        - otherwise `mode = 'POST'`, `postingDate = null` (the kind resolves the conversion date itself)
      - otherwise, for kinds with `commitModes`: `mode = body.mode ?? 'DRAFT'`, `postingDate = mode === 'POST' ? (body.postingDate ?? null) : null`
      - `body.postingDate` set with `mode === 'DRAFT'` → `ApiError(400, 'A posting date applies only when posting')`
    - After the kind's commit, in the same UPDATE that sets `result`, also set `commit_options = $n::jsonb` (`{mode, postingDate}`) for kinds with `commitModes`, else NULL.
  - **Schemas:**
    - `createMigrationImportSchema` gains `conversionMode: z.boolean().default(false)`
    - `commitMigrationImportSchema = z.object({ mode: z.enum(['DRAFT','POST']).optional(), postingDate: z.iso.date().nullable().optional() })`
  - **Controller:**
    - `commit` parses `commitMigrationImportSchema` from `req.body ?? {}` and passes it
    - `preview` reads `req.query.mode`: absent → null; `'DRAFT'`/`'POST'` → the value; anything else → `ApiError(400, 'mode must be DRAFT or POST')`
    - `preview` reads `postingDate` through the existing `optionalIsoDate(req, 'postingDate')` (`utils/queryParam.ts`)
- **Guardrails:**
  - #5: prepareCommit is still the only pre-BEGIN pool read; option checks are pure
  - #1
  - #2: parsing only in the controller
- **Proof:** `npm run typecheck` exits 0, `npm run lint` exits 0, then `npx vitest run $(ls src/__tests__/accounting/*mport*.test.ts) src/__tests__/importValues.test.ts src/__tests__/importColumns.test.ts` passes unedited. The existing commit callers send `{}`, which must still work.
- **Owes:** docs, in Step 9.

### Step 2 — [Sonnet] Document-service hooks: reserved numbers, the equity allowance, lookups

- **Model:** [Sonnet]. It touches the live invoice-issue and bill-create paths.
- **Depends on:** 1
- **Read first:**
  - `invoiceService.ts` L400-450 and L555-645, and L855-1052
  - `invoiceSettingsService.ts` L255-290
  - `billService.ts` L420-450 and L585-710
  - `itemService.ts` (`findItemsByCodesOnClient`, `toItem`)
- **Files:** `services/accounting/invoiceService.ts`, `services/accounting/invoiceSettingsService.ts`, `services/accounting/billService.ts`, `services/accounting/itemService.ts`
- **Contract:**
  ```ts
  // invoiceService.ts
  export interface CreateInvoiceOptions {
    /** Import only: stored on the draft; issue uses it instead of allocating. Never exposed in invoiceSchema. */
    invoiceNumber?: string;
    /** Import conversion mode only: this one account id (3400) is accepted by assertRevenueAccounts as if it were Revenue. */
    equityAccountId?: string;
  }
  export async function createInvoiceOnClient(client, orgId, createdBy, input: CreateInvoiceInput, options: CreateInvoiceOptions = {}): Promise<string>;
  export async function assertRevenueAccounts(client, orgId, accountIds: string[], allowAccountId: string | null = null): Promise<void>;
  /** SELECT invoice_number FROM invoices WHERE org_id = $1 AND invoice_number = ANY($2::text[]) */
  export async function findExistingInvoiceNumbersOnClient(client: PoolClient, orgId: string, numbers: readonly string[]): Promise<Set<string>>;
  ```
  - `assertRevenueAccounts`: the existence and postability checks are unchanged. The type check skips the row whose `id === allowAccountId`.
  - `createInvoiceOnClient` passes `options.equityAccountId ?? null` through, and adds `invoice_number` to the INSERT with the value `options.invoiceNumber ?? null`.
  - `issueInvoiceOnClient`:
    - add `invoice_number` to the `FOR UPDATE` SELECT
    - replace `const invoiceNumber = await invoiceSettingsService.allocateInvoiceNumber(client, orgId);` with `const invoiceNumber = invoiceRow.invoice_number ?? await invoiceSettingsService.allocateInvoiceNumber(client, orgId);`
    - **nothing else changes.** A normal draft has a NULL number, so its behaviour is byte-identical.
  - `updateInvoice` must not touch `invoice_number`. Verify that it doesn't; if it does, stop and report.
  ```ts
  // invoiceSettingsService.ts
  /** Locks the settings row (INSERT … ON CONFLICT DO NOTHING, then SELECT … FOR UPDATE). For each number that is
   *  `${number_prefix}` followed by only digits, n = that integer (ignore n > 2_000_000_000); then
   *  UPDATE … SET next_number = GREATEST(next_number, $max + 1). No-op when none parse. */
  export async function advancePastImportedNumbersOnClient(client: Queryable, orgId: string, numbers: readonly string[]): Promise<void>;
  ```
  ```ts
  // billService.ts
  export interface CreateBillOptions { /** Import conversion mode only: 3400 accepted by assertExpenseAccounts. */ equityAccountId?: string }
  export async function createBillOnClient(client, orgId, createdBy, input: CreateBillInput, options: CreateBillOptions = {}): Promise<string>;
  export async function assertExpenseAccounts(client, orgId, accountIds: string[], allowAccountId: string | null = null): Promise<void>;
  /** Pairs that already exist: SELECT vendor_id, vendor_reference FROM bills WHERE org_id=$1 AND vendor_id = ANY($2::uuid[]) AND vendor_reference = ANY($3::text[]); key `${vendorId}|${reference}`. */
  export async function findExistingBillReferencesOnClient(client: PoolClient, orgId: string, pairs: readonly { vendorId: string; reference: string }[]): Promise<Set<string>>;
  ```
  - `insertBillOnClient` threads `allowAccountId` through to `assertExpenseAccounts`.
  - Every other caller of either assert keeps its two-argument call shape. The default `null` means no change.
  ```ts
  // itemService.ts
  /** Full defaults for document lines: SELECT ${ITEM_COLUMNS} FROM items WHERE org_id = $1 AND code = ANY($2::text[]) → Map<code, Item>. */
  export async function findItemDefaultsByCodesOnClient(client: PoolClient, orgId: string, codes: readonly string[]): Promise<Map<string, Item>>;
  ```
- **Guardrails:**
  - #6: issue and approve still go only through their FSMs
  - #1 and #4: parameterized `ANY`
  - #5: on `client`
- **Proof:** `npm run typecheck` exits 0, then `npx vitest run $(ls src/__tests__/accounting/*.test.ts | grep -iE "invoice|bill|creditNote|debitNote|recurring|item")` passes unedited. Print the list first.
- **Owes:** the study note, in Step 10 (advancing a counter past imported numbers).

---

## Slice 2 — Server: the `INVOICES` and `BILLS` kinds

**Names:**

| Kind | Name |
|---|---|
| Kinds | `INVOICES`, `BILLS` (append to `MIGRATION_IMPORT_KINDS`, in that order) |
| Columns file | `server/src/services/accounting/importDocumentColumns.ts` → `INVOICE_COLUMNS`, `INVOICE_EDIT_FIELDS`, `BILL_COLUMNS`, `BILL_EDIT_FIELDS`, `invoiceGroupKey`, `billGroupKey` |
| Shared core | `server/src/services/accounting/documentImportCore.ts` → `DocumentSide`, `ResolvedDocLine`, `ResolvedDocument`, `resolveDocumentsOnClient` |
| Services | `invoiceImportService.ts`, `billImportService.ts` → `validateRows`, `preview`, `commitOnClient` |
| Results | `{ kind: 'INVOICES' \| 'BILLS'; documentCount: number; lineCount: number; mode: 'DRAFT' \| 'POST' }` |
| Tests | `server/src/__tests__/accounting/invoiceImport.test.ts`, `billImport.test.ts` |

### Step 3 — [Sonnet] Columns + shared resolution core

- **Model:** [Sonnet]. Document-building logic shared by validation, preview and commit.
- **Depends on:** 2
- **Read first:** `journalImportService.ts` and `importJournalColumns.ts` (the grouped analogue), and `itemImportService.ts` (lookups).
- **Files:** `services/accounting/importDocumentColumns.ts` (new), `services/accounting/documentImportCore.ts` (new)
- **Contract — columns.** Invoices and bills share their shape, except where the "Bills" column says otherwise. Every column has `inTemplate: true`, `enumAliases: null` and `enumLabels: null`.

  | key | header (Invoices) | header (Bills) | label | req | type | maxLength | synonyms | note (Invoices; Bills in brackets where it differs) | example |
  |---|---|---|---|---|---|---|---|---|---|
  | contactName | `*ContactName` | same | Customer [Vendor] | ✓ | text | 200 | contact name, contact, customer, customer name, client, vendor, vendor name, supplier, name | An existing customer [vendor], matched by name. Import customers [vendors] first. | Northwind Traders |
  | emailAddress | `EmailAddress` | same | Email | | text | 254 | email address, email | Only needed when two customers [vendors] share a name. | |
  | invoiceNumber | `InvoiceNumber` | `*InvoiceNumber` | Invoice number [Vendor's invoice number] | inv ✗ / bill ✓ | text | 40 / 100 | invoice number, invoice no, invoice #, number, invoice, reference [+ bill number, vendor reference, supplier invoice number] | Rows with the same number form one invoice, and the invoice keeps this number. Blank: each row is its own invoice, numbered from your sequence when posted. [The vendor's own invoice number. Rows with the same vendor and number form one expense.] | INV-0042 [SUP-881] |
  | invoiceDate | `*InvoiceDate` | same | Date | ✓ | date | null | invoice date, date, issue date [+ bill date] | | 2026-06-15 |
  | dueDate | `DueDate` | same | Due date | | date | null | due date, due | Blank: worked out from PaymentTerms. | 2026-07-15 |
  | paymentTerms | `PaymentTerms` | same | Payment terms | | text | 60 | payment terms, terms | A payment term's code or name, such as NET30 or "Net 30". Needed when DueDate is blank. | |
  | currency | `Currency` | same | Currency | | text | 3 | currency, currency code | Blank: your base currency. | |
  | notes | `Reference` | same | Reference | | text | 1000 | reference, notes, memo | Stored as the invoice's [expense's] notes. | PO 7781 |
  | itemCode | `ItemCode` | same | Item code | | text | 40 | item code, inventory item code, product code, sku, item | Optional. Fills a blank description, price, account and tax rate from the product. | |
  | description | `*Description` | same | Description | ✓ | text | 500 | description, line description, details | Blank allowed when ItemCode is set. | Consulting, June |
  | quantity | `Quantity` | same | Quantity | | quantity | null | quantity, qty | Blank: 1. | 10 |
  | unitAmount | `UnitAmount` | same | Unit price | | money | null | unit amount, unit price, price, rate | Excluding tax. Blank: the product's sale [purchase] price. | 150.00 |
  | accountCode | `AccountCode` | same | Account | | text | 20 | account code, account, revenue account, sales account [expense account, purchases account] | A Revenue account [an Expense or Asset account]. Blank: the product's account. Not needed in conversion mode. | 4100 [6100] |
  | taxRate | `TaxRate` | same | Tax % | | percent | null | tax rate, tax, tax type, gst, vat | A percentage. Blank: the product's rate, else 0. Must be 0 or blank in conversion mode. | 10 |
  | location | `Location` | same | Stock location | | text | 100 | location, warehouse, stock location | For inventory products only. Blank: your default location. | |

  - missingMessages:
    - `contactName` → `Could not find a customer or vendor name column in the file`
    - `invoiceDate` → `Could not find an invoice date column in the file`
    - `description` → `Could not find a description column in the file`
    - bills only, `invoiceNumber` → `Could not find an invoice number column in the file`
  - Edit fields: every column, `text` input, `options: null`, `maxLength` copied, `nullable` true except `contactName`, `invoiceDate` and `description`, plus `invoiceNumber` for bills.
  - Group keys:
    - `invoiceGroupKey(values, raw)`: when `invoiceNumber` is non-null → `'N:' + upper(invoiceNumber)`; otherwise `null`, meaning each row is its own invoice
    - `billGroupKey`: `'B:' + lower(contactName ?? raw.contactName ?? '') + '|' + upper(invoiceNumber ?? raw.invoiceNumber ?? '')`, truncated to 220; `null` only when both are blank

  **Contract — the core.** Write it with literal types; this is the one place the rules live.
  ```ts
  export type DocumentSide = 'SALES' | 'PURCHASES';
  export interface ResolvedDocLine { rowId: string; rowNumber: number; description: string; quantityMilli: number; unitPriceCents: number; accountId: string; taxRateBp: number; itemId: string | null; stockLocationId: string | null; netCents: number; taxCents: number }
  export interface ResolvedDocument {
    groupKey: string | null; label: string; rowIds: string[]; firstRow: number; lastRow: number;
    contactId: string; number: string | null; date: string; dueDate: string | null; paymentTermsCode: string | null;
    currencyCode: string; notes: string | null; lines: ResolvedDocLine[]; totalCents: number;
  }
  /** Resolves every non-EXCLUDED data row into documents. Rows with errors get them in `rowErrors`; a document
   *  with ANY row error is omitted from `docs`. Never throws for user data. */
  export async function resolveDocumentsOnClient(client: PoolClient, orgId: string, side: DocumentSide,
    rows: readonly { id: string; rowNumber: number; values: Readonly<Record<string, string | number | null>>; raw: Readonly<Record<string, string>>; groupKey: string | null }[],
    opts: { dateFormat: DateFormat; conversionMode: boolean }): Promise<{ docs: ResolvedDocument[]; rowErrors: Map<string, string[]>; booksStartDate: string | null; baseCurrency: string }>;
  ```
  **Load once:**
  - `base_currency` (organizations)
  - `books_start_date` (`ledger_settings`, `to_char(…,'YYYY-MM-DD')`)
  - the 3400 id, only in conversion mode
  - contacts: `SELECT id, name, email FROM customers|vendors WHERE org_id=$1 AND is_active AND LOWER(name) = ANY($2::text[])`. The table name comes from a constant chosen by `side`.
  - `loadAccountsByCodeOnClient`
  - `findItemDefaultsByCodesOnClient`
  - `resolveStockAccountsOnClient`, for INVENTORY items on the PURCHASES side
  - payment terms: `SELECT code, name FROM payment_terms WHERE org_id=$1 AND is_active`
  - stock locations through `documentStockService.loadImportReferencesOnClient(client, orgId, [])`, only when any `location` is set (rule 16 seam)
  - `invoiceService.findExistingInvoiceNumbersOnClient` (SALES) or `billService.findExistingBillReferencesOnClient` (PURCHASES)

  **Row rules, in this order:**
  1. `dataRowParseErrors`
  2. `contactName`:
     - no match → `` `Customer "${name}" not found — import customers first (Customers → Import)` `` (Vendor/Vendors wording on PURCHASES)
     - more than one match:
       - with `emailAddress` → pick the one whose lowercased email matches, or error `` `Customer "${name}" with email ${email} not found` ``
       - without an email → `` `"${name}" matches ${n} customers — add EmailAddress to choose one` ``
  3. `itemCode` set:
     - in conversion mode → `Conversion mode imports balances, not products — leave ItemCode blank`
     - unknown → `` `Item "${code}" was not found` ``
     - inactive → `` `Item "${code}" is inactive` ``
     - type `FIXED_ASSET` → `` `Item "${code}" is a fixed asset and cannot go on an invoice [expense]` ``
  4. Defaults: `description ?? item.name`; `quantity ?? 1000`; `unitAmount ?? (SALES ? item.salePriceCents : item.purchasePriceCents)`; `taxRate ?? item rate ?? 0`. Then:
     - description still null → `Description is required (or an ItemCode)`
     - unit price null → `Unit price is required (or an ItemCode with a sale [purchase] price)`
     - `quantity === 0` → `Quantity must be more than zero`
  5. Account:
     - conversion mode: the 3400 id; when missing → `Account 3400 Opening Balance Equity is missing`
     - `accountCode` set: `accountCodeError('AccountCode', code, account, SALES ? ['Revenue'] : ['Expense','Asset'])`
     - otherwise SALES: `item?.revenueAccountId`
     - otherwise PURCHASES: an INVENTORY item gives `stockAccounts.get(item.id).assetAccountId`; any other item gives `item?.expenseAccountId`
     - none → `Account is required (or an ItemCode with a default account)`
  6. Conversion mode and `taxRate > 0` → `Tax must be 0 in conversion mode — import the amount outstanding including tax`.
  7. `location` set:
     - the item is not INVENTORY → `Location applies only to inventory products`
     - else resolve `UPPER(text)` then `LOWER(text)` in `refs.locations`; missing → `` `Stock location "${text}" was not found` ``
  8. `currency` set and not in `SUPPORTED_CURRENCIES` → `` `Currency "${c}" is not supported` ``

  **Group rules** (group = same `groupKey`; a null key is its own group):
  - **Label:**
    - SALES: `` `invoice ${number}` `` when numbered, else `` `invoice on row ${rowNumber}` ``
    - PURCHASES: `` `expense ${number} from ${contactName}` ``
  - **Header agreement:** every row's `contactName` (case-insensitive), `emailAddress`, `invoiceDate`, `dueDate`, `paymentTerms`, `currency` and `notes` (raw text, trimmed) must equal the group's first row. A differing row gets `` `${Label} differs from row ${first} ("${firstRaw}") — every line of the ${label} must match` ``, using the column's label.
  - **Due date:**
    - `dueDate` set → it must be ≥ `invoiceDate`, otherwise `Due date cannot be before the invoice date`
    - else `paymentTerms`: match `UPPER(text)` against a code, then `LOWER(text)` against a name; not found → `` `Payment term "${t}" was not found` ``
    - neither → `Enter a DueDate or PaymentTerms`
    - these errors attach to every row of the group
  - **Number:**
    - SALES: an existing number → every row gets `` `Invoice number ${n} already exists` ``
    - PURCHASES: an existing (vendor, reference) → `` `Expense ${ref} from ${vendor} already exists` ``
  - **Conversion mode:**
    - `booksStartDate` null → `Set your conversion date first (Settings → Conversion balances)`
    - `invoiceDate > booksStartDate` → `` `In conversion mode the date must be on or before your conversion date (${booksStartDate})` ``
  - **FX:** the currency is not the base currency → try `fxRateService.requireRateOnClient(client, orgId, currency, base, invoiceDate)`; catch `ApiError` → `` `No ${currency} exchange rate on or before ${invoiceDate} — add one under Settings → Exchange rates` ``. Cache per (currency, date).

  **Totals per line:** `netCents = scaleCents(cents(unitPrice), quantityMilli, 1000)`, `taxCents = scaleCents(netCents, taxRateBp, 10000)`; `totalCents = Σ(net + tax)`. This is the same arithmetic as `computeLineTotals`, so import it if it is exported. Otherwise duplicate these two lines **verbatim** with a comment naming the source.
- **Guardrails:**
  - #1: every lookup
  - #4: the customers/vendors table name comes from a constant map
  - #16: stock locations only through `documentStockService.ts`
  - #3: integer cents via `scaleCents`
- **Proof:** `npm run typecheck` exits 0, and `npm run lint` exits 0. The core is exercised in Steps 5–6.
- **Owes:** nothing.

### Step 4 — [Sonnet] `invoiceImportService`, `billImportService`, registry entries

- **Model:** [Sonnet]. Posting, numbering and conversion, all in one transaction.
- **Depends on:** 3
- **Read first:** `journalImportService.ts` (the service shape), and `recurringService.ts` L505-566 (create then post).
- **Files:**
  - `types/accounting.ts` (append the kinds and result members)
  - `services/accounting/invoiceImportService.ts` (new)
  - `services/accounting/billImportService.ts` (new)
  - `services/accounting/importKinds.ts` (two entries)
- **Contract:**
  - **Registry entries:**
    - `INVOICES`: label `Invoices`, noun `invoice lines`, storage `data`, requiredOneOf `[]`, `groupHeaderFields: ['invoiceNumber','contactName','invoiceDate']`, `groupKeyOf: invoiceGroupKey`, `groupNoun: 'invoices'`, `commitModes: ['DRAFT','POST']`, `supportsConversionMode: true`
    - `BILLS`: label `Expenses (bills)`, noun `expense lines`, `groupHeaderFields: ['contactName','invoiceNumber','invoiceDate']`, `groupKeyOf: billGroupKey`, `groupNoun: 'expenses'`, otherwise the same
  - **`validateRows`:** `opts = importOptionsForRowOnClient(client, orgId, rows[0].id)` (or the defaults when there are no rows), then `resolveDocumentsOnClient`, then return `rowErrors`.
  - **`preview(client, orgId, importId, popts)`.** Load the rows (`loadDataRowsOnClient` plus each row's `groupKey`; extend `DataRow` with `groupKey` if absent), get the options, resolve.
    - `summary`:
      - `{label:'Invoices' | 'Expenses', value:docs, format:'count'}`
      - `{label:'Lines', value:lines, format:'count'}`
      - `{label:'Total (base-currency documents)', value: Σ totalCents of base-currency docs, format:'money'}`
    - `warnings`:
      - not conversion mode, `booksStartDate` set and any doc dated before it → `` `${n} document(s) are dated before your conversion date (${d}). If they are balances carried over from your old system, delete this import and re-stage the file with conversion mode on — otherwise their revenue [expense] is counted a second time.` ``
      - conversion mode → `` `Conversion mode: every document posts on ${booksStartDate} to 3400 Opening Balance Equity, tax-free, keeping its own date and due date for ageing.` ``
      - effective mode POST (conversion, or `popts.mode === 'POST'`) → for each doc, run `periodStatusOnClient` on the posting date (conversion: `booksStartDate`; else `popts.postingDate ?? doc.date`); a status of CLOSED or LOCKED → `` `${label}: the period covering ${postingDate} is ${status} — choose another posting date` ``. Any such warning sets `canCommit = false`.
    - `canCommit` / `blockingErrorCount`: as in journals.
    - legacy fields: 0, `''`, `null`.
  - **`commitOnClient(client, orgId, importId, createdBy, context)`:**
    1. Get the options; resolve the documents. Revalidate-at-commit already guaranteed no errors; if `docs` is shorter than the groups, throw `Error('unresolved documents at commit')`.
    2. `mode = context.mode ?? 'DRAFT'`.
    3. Posting date: conversion → `booksStartDate`; else `context.postingDate` (null = each doc's own date).
    4. **SALES only, before creating anything:** `invoiceSettingsService.advancePastImportedNumbersOnClient(client, orgId, docs.flatMap(d => d.number ? [d.number] : []))`.
    5. For each doc, in first-row order:
       - SALES: `createInvoiceOnClient(client, orgId, createdBy, { customerId: contactId, issueDate: date, ...(dueDate ? { dueDate } : {}), currencyCode, notes, paymentTerms: null, paymentTermsCode, lines }, { ...(number ? { invoiceNumber: number } : {}), ...(conversion ? { equityAccountId: id3400 } : {}) })`; in POST, then `issueInvoiceOnClient(client, orgId, createdBy, id, postingDate)`
       - PURCHASES: `createBillOnClient(…, { vendorId, vendorReference: number, billDate: date, … }, conversion ? { equityAccountId } : {})`; in POST, then `approveBillOnClient(client, orgId, createdBy, id, postingDate)`
    6. Wrap errors: an `ApiError` → `` new ApiError(err.status, `${capitalised label} (rows ${first}–${last}): ${err.message}`) ``. A pg 23505 with constraint `ux_invoices_org_number` → 409 `` `Invoice ${number} (rows …): that invoice number already exists` ``; `ux_bills_vendor_reference` → 409 the same, for an expense.
    7. `markCommittedOnClient`; return `{ kind, documentCount, lineCount, mode }`.
- **Guardrails:**
  - #6: only create, issue and approve, through the existing FSMs
  - #3
  - #5: everything on `client`, all or nothing
  - #1
  - the receivable/payable control accounts are only ever hit by the document services' own posting, never by an import line (lines are Revenue/Expense/Asset or the 3400 allowance)
- **Proof:** `npm run typecheck` exits 0; the Step 1 and Step 2 proof lists pass.
- **Owes:** docs, in Step 9.

### Step 5 — [Sonnet] `INVOICES` integration tests

- **Model:** [Sonnet]
- **Depends on:** 4
- **Skill:** isolation-test
- **Read first:** `journalImport.test.ts` (setup: onboarding, conversion date, periods), and the existing invoice tests for creating customers and issuing.
- **Files:** `server/src/__tests__/accounting/invoiceImport.test.ts` (new)
- **Contract:** write these tests, with these exact names:
  1. `rows sharing an InvoiceNumber stage as one invoice with item defaults applied`: two lines, one with `ItemCode` and blank price/account/description → VALID; the preview gives Invoices 1, Lines 2.
  2. `a blank InvoiceNumber makes each row its own invoice`.
  3. `unknown customer, duplicate-name customer, and email disambiguation`.
  4. `header fields must agree across an invoice's rows`: a differing `InvoiceDate` on row 3 → only that row is flagged.
  5. `an existing invoice number is refused`.
  6. `missing DueDate and PaymentTerms is an error; PaymentTerms by name resolves`.
  7. `import as drafts keeps the file's number on the draft`: the result has `mode 'DRAFT'`; `GET /api/v1/invoices/:id` gives `status 'DRAFT'`, `invoiceNumber 'INV-9001'`.
  8. `a reserved number survives a later manual issue of that draft`: issue the imported draft through `POST /api/v1/invoices/:id/issue` → its number is still `INV-9001`.
  9. `the sequence skips imported numbers`:
     - with prefix `INV-` and padding 6, import `INV-000005`
     - then create and issue a normal invoice: it gets `INV-000006` or later
     - a fresh org's sequence starts below 5; seed it so `next_number` ≤ 5 (prefix and padding come from settings; read `GET /api/v1/settings/invoicing` to build the number)
  10. `import and post issues every invoice with the file's numbers`: mode POST → each invoice is `ISSUED`, AR ageing includes them, the trial balance balances.
  11. `post with a posting date in a closed period: preview blocks, commit rolls back everything`:
      - close the period
      - `GET /:id/preview?mode=POST&postingDate=<closed date>` → `canCommit` false, with the warning
      - commit `{mode:'POST', postingDate:…}` → 422 or 409, no invoice exists, and the import is still `VALIDATED`
  12. `conversion mode posts to 3400 on the conversion date and nets the opening plug`:
      - set the conversion date to D
      - commit an OPENING_BALANCES import that leaves AR out (debit cash 1000, credit 3100 1000)
      - stage INVOICES with `conversionMode:true`, one invoice dated D-10, total 500.00 → commit `{}`
      - the invoice is `ISSUED`, its journal `entryDate` is D, and AR ageing shows 500.00 with the **original** due date
      - P&L revenue for the period is unchanged (0)
      - account 3400's balance is a credit of 500.00, i.e. the AR the opening import would have plugged
  13. `conversion mode rules: ItemCode, non-zero tax, and dates after the conversion date are refused`.
  14. `conversion mode refuses mode DRAFT and an explicit posting date with 400`.
  15. `conversionMode on a non-document kind is 400`.
  16. `an ACCOUNTANT cannot commit`: 403, using the `tenantIsolation.test.ts` VIEWER pattern with role ACCOUNTANT.
  17. `cross-tenant: org B's customers and items don't resolve; org B cannot read or commit org A's import`.
- **Proof:** `npx vitest run src/__tests__/accounting/invoiceImport.test.ts` passes.

### Step 6 — [Sonnet] `BILLS` integration tests + full suite

- **Depends on:** 5
- **Skill:** isolation-test
- **Files:** `server/src/__tests__/accounting/billImport.test.ts` (new)
- **Contract:** write these tests, with these exact names:
  1. `rows sharing vendor and InvoiceNumber stage as one expense`.
  2. `the same reference from two vendors stays two expenses`.
  3. `an existing vendor reference is refused`.
  4. `an Asset account is accepted on an expense line; a Revenue account is refused`.
  5. `an inventory product line defaults to its inventory account and receives stock when posted`: set up inventory with one tracked item; bill line `ItemCode` and `Quantity 5` with no account; mode POST → the item's quantity on hand rises by 5, and the integrity checks pass (`runIntegrityChecks` from `server/src/db/integrity.ts`).
  6. `import as drafts lands bills in DRAFT`.
  7. `import and post approves bills on a chosen posting date`: each bill's journal `entryDate` is the chosen date.
  8. `conversion mode posts bills to 3400 and AP ageing shows them`.
  9. `cross-tenant: org B's vendors don't resolve; org B cannot commit org A's import`.
- **Proof:** `npx vitest run src/__tests__/accounting/billImport.test.ts`, then the full `npm test`, with 2 skipped.

---

## Slice 3 — Client

### Step 7 — [Sonnet] Client: types, conversion toggle, commit options, buttons, guides, fixture

- **Depends on:** 4
- **Read first:** `NewMigrationImportPage.tsx`, `MigrationImportDetailPage.tsx`, `imports/importGuides.ts`, `services/fetchServices.ts` (the migration-import block), `__tests__/fixtures/importKinds.ts`, `InvoicesPage.tsx` and `BillsPage.tsx`.
- **Contract:**
  - **`fetchServices.ts`:**
    - `MigrationImportKind` adds `'INVOICES' | 'BILLS'`
    - `ImportKindMeta` gains `commitModes: ('DRAFT'|'POST')[]` and `supportsConversionMode: boolean`
    - `MigrationImport` gains `conversionMode: boolean` and `commitOptions: { mode: 'DRAFT'|'POST'; postingDate: string|null } | null`
    - `MigrationCommitResult` adds the two members
    - `createMigrationImport` body gains `conversionMode?: boolean`
    - `previewMigrationImport(id, signal?, params?: { mode?: 'DRAFT'|'POST'; postingDate?: string })` sets the query
    - `commitMigrationImport(id, body: { mode?: 'DRAFT'|'POST'; postingDate?: string | null } = {})` sends the body
  - **Wizard, map stage:** when `meta.supportsConversionMode`, render a checkbox labelled `These are open items from before my conversion date (conversion mode)`, followed by `<p className="text-xs text-[var(--muted)]">Use this for unpaid invoices or bills you are bringing over at your conversion date. They post to 3400 Opening Balance Equity on that date instead of revenue or expense, so your opening balances aren't counted twice. Tax must be 0 and products can't be used.</p>`. Default unchecked; sent as `conversionMode`.
  - **Detail page, kinds with `meta.commitModes.length > 0`:**
    - When `imp.conversionMode`: show `Conversion mode — documents post on your conversion date to 3400 Opening Balance Equity.` and no options; commit sends `{}`.
    - Otherwise, a radio group `aria-label="How to import"` with `Import as drafts` (value `DRAFT`, the default) and `Import and post` (value `POST`). The second has the hint `Issues the invoices` or `Approves the expenses`, by kind.
    - With POST selected, a second radio group `aria-label="Posting date"`: `Each document's own date` (default) and `On this date` with an `<input type="date" aria-label="Posting date">`.
    - Changing either option re-fetches the preview with `{mode, postingDate}`.
    - Commit sends `{ mode, ...(mode === 'POST' && postingDate ? { postingDate } : {}) }`.
    - The ConfirmDialog body becomes `` `This creates ${n} ${draft ? 'draft' : 'posted'} document(s).` `` plus the existing irreversibility sentence when posting.
  - **Committed card:** `` `Committed: ${documentCount} ${INVOICES ? 'invoices' : 'expenses'} ${mode === 'DRAFT' ? 'created as drafts' : 'posted'} (${lineCount} lines).` ``
  - **Import buttons:** `InvoicesPage` gets `<ImportButton kind="INVOICES" returnTo="/invoices" />`; `BillsPage` gets `<ImportButton kind="BILLS" returnTo="/expenses" />`. Wrap the existing link in `<div className="flex items-center gap-2">` the way JournalsPage does.
  - **`IMPORT_GUIDES.INVOICES`**
    - intro: `Bring in invoices — open ones you're still owed when you switch, or history you want to see here.`
    - steps: the shared five
    - rules:
      - `Rows with the same InvoiceNumber form one invoice and it keeps that number. Leave the number blank and each row becomes its own invoice, numbered from your sequence.`
      - `Customers must exist first (Customers → Import). If two customers share a name, add EmailAddress.`
      - `ItemCode is optional — it fills a blank description, price, account and tax rate from the product.`
      - `Choose at commit: import as drafts to review them, or import and post to issue them straight away.`
      - `Switching mid-year? Turn on conversion mode for invoices still unpaid at your conversion date and import only the amount outstanding — they post to Opening Balance Equity so your opening balances aren't counted twice.`
  - **`IMPORT_GUIDES.BILLS`**
    - intro: `Bring in expenses (bills) — ones you still owe when you switch, or history you want to see here.`
    - steps: the shared five
    - rules:
      - `Rows with the same vendor and InvoiceNumber (the vendor's own invoice number) form one expense.`
      - `Vendors must exist first (Vendors → Import). If two vendors share a name, add EmailAddress.`
      - `Lines can use Expense or Asset accounts. An inventory product line receives stock when posted.`
      - `Choose at commit: import as drafts to review them, or import and post to approve them straight away.`
      - `Switching mid-year? Turn on conversion mode for bills still unpaid at your conversion date and import only the amount outstanding.`
  - **`MIGRATION_STEPS`:** insert before `stock`:
    - `{key:'invoices', label:'Open invoices', hint:'Unpaid customer invoices at your conversion date — use conversion mode.', to:'/migration-imports/new?kind=INVOICES', kind:'INVOICES'}`
    - `{key:'bills', label:'Open expenses (bills)', hint:'Unpaid vendor bills at your conversion date — use conversion mode.', to:'/migration-imports/new?kind=BILLS', kind:'BILLS'}`
    - remove the "Step D inserts…" comment
  - **Fixture:**
    - add `commitModes: []` and `supportsConversionMode: false` to the seven existing entries
    - append `INVOICES` and `BILLS`, transcribed from `server/src/services/accounting/importDocumentColumns.ts` and their `importKinds.ts` entries
    - **byte-for-byte**
- **Proof:** `npm run typecheck` exits 0; `npm run lint` exits 0; `npx vitest run src/__tests__/invoices.test.tsx src/__tests__/bills.test.tsx src/__tests__/importWizard.test.tsx src/__tests__/migrationImport.test.tsx` passes, unedited except the fixture and factory defaults for new required fields. Then the 36c `node -e` byte-comparison run against `importDocumentColumns.ts`, handling single- and double-quoted notes, prints nothing.

### Step 8 — [Sonnet] Client tests

- **Depends on:** 7
- **Files:** `__tests__/migrationImport.test.tsx`, `__tests__/importWizard.test.tsx` (append only)
- **Contract:** append these tests, with these exact names:
  1. `the wizard shows the conversion-mode checkbox for invoices and sends it`
  2. `document imports offer draft or post, and posting sends mode and date`
  3. `changing the commit options re-fetches the preview with them`
  4. `a conversion-mode import shows the fixed posting note and commits with an empty body`
  5. `a committed invoice import reports drafts or posted with counts`
  6. `Invoices and Expenses pages link to their import wizards`
- **Proof:** `npm test` passes, and `npm run typecheck` exits 0.

---

## Spine

### Step 9 — [Sonnet] Docs sync

- **Depends on:** 6, 8
- **Skill:** docs-sync
- **Files:**
  - `docs/api.md`:
    - the `INVOICES`/`BILLS` kinds: columns, grouping, rules, failure paths
    - `conversionMode`, `commitModes`, `supportsConversionMode`
    - the commit body and its 400s
    - preview `?mode=&postingDate=`
    - `commitOptions` and `conversionMode` on the import
    - the results
    - under invoices: a draft may carry a reserved number, and issue keeps it
  - `docs/accounting.md`: 36d as delivered; how conversion mode keeps P&L whole
  - `docs/roadmap.md`: 36d and **Phase 36 complete**, with the defect log and "deliberately not built": discounts, negative lines and credit-note import, automatic contact creation, partial commit, line-level lot/serial pre-checks, and the pre-existing `parseMoneyText`/`assertAccount` gaps
  - `CLAUDE.md`: the bullet becomes "Phase 36" (complete), kept short

### Step 10 — [Sonnet] Study notes

- **Depends on:** 6, 8
- **Skill:** study-note
- **Files:**
  - extend `study/postgresql/gapless-numbering-and-counters.md`: reserving externally-supplied numbers, advancing a counter with `GREATEST`, why the advance happens before any allocation in the same transaction
  - extend `study/architecture/staged-import-and-two-phase-commit.md`: commit modes (draft vs post) as one transaction; conversion mode as an accounting design (historical open items vs the opening trial balance, and why 3400 nets out)
  - extend `study/architecture/subledger-reconciliation-and-aging.md`: ageing keeps the document's own dates while the GL posts on the conversion date
  - update `study/README.md`

### Step 11 — [Sonnet] Guardrail review + full verification

- **Depends on:** 9, 10
- **Skill:** guardrail-review
- **Proof:** `cd server && npm run typecheck && npm run lint && npm test && npm run verify:integrity`; `cd client && npm run typecheck && npm run lint && npm test`. All green, zero violations. Check especially rule 6 (no posted-row update), rule 16 (locations only through the seam), and that `issueInvoiceOnClient` changed only in its number line. Then set `Status: done`.

---

## Dispatch manifest

| Batch | Step | Tier | Title | Depends on | Blocks | Status |
|---|---|---|---|---|---|---|
| A | 1 | Sonnet | Commit modes, conversion option, preview options | — | 2 | done |
| A | 2 | Sonnet | Document-service hooks | 1 | 3 | done |
| A | 3 | Sonnet | Columns + shared resolution core | 2 | 4 | done |
| A | 4 | Sonnet | Invoice/bill import services + registry | 3 | 5, 7 | done |
| A | 5 | Sonnet | `INVOICES` integration tests | 4 | 6 | done |
| A | 6 | Sonnet | `BILLS` tests + full suite | 5 | 9, 10 | done |
| A | 7 | Sonnet | Client: options, toggle, buttons, guides, fixture | 4 | 8 | done |
| A | 8 | Sonnet | Client tests | 7 | 9, 10 | done |
| A | 9 | Sonnet | Docs sync | 6, 8 | 11 | done |
| A | 10 | Sonnet | Study notes | 6, 8 | 11 | done |
| A | 11 | Sonnet | Guardrail review + verification | 9, 10 | — | done |

**Tiers and parallel runs:**
- Every step is Sonnet: posting, numbering and conversion are judgment, and the copy and fixture follow the 36b tiering correction.
- Steps 5–6 (server tests) and Steps 7–8 (client) may run in parallel once Step 4 is done, because their test runs are in different packages.
- Steps 9 and 10 may run in parallel.

**Escalations:** none yet.

**Plan defects found during execution:**
- Step 11 verification: 1 of 6 full server runs failed one test that did not recur in 5 further runs (the failing test was not captured); same shape as the one-off ECONNRESET in 36a. Watch for flakiness.
- Step 10 (found while writing notes): a posting import takes the invoice-number counter and later another document's stock-balance locks — the reverse of the documented order (document → stock → counter). A concurrent manual issue of an inventory invoice can deadlock with it; Postgres aborts one side (40P01) and the import rolls back whole — safe, but surfaced as a 500. Step 11 maps 40P01/40001 on commit to a 409 "commit again" message and documents it; restructuring the lock order across a multi-document transaction is not attempted. Also noted: ageing `reconciles` can be false for an `asOf` before the conversion date (documents keep their own dates; the GL posts on the conversion date) — documented, not changed.
- Step 6 (found by its tests): `importAccountLookup.accountCodeError` (36b contract) produced "must be a Expense or Asset account" / "a Asset". Fixed to choose a/an from the type text; only `billImport.test.ts` quoted it. The non-import message "Inventory account must be a Asset account" (Phase 35a settings) has the same bug — pre-existing, out of scope, reported to the user.
- Step 3: `reference` was a synonym of both INVOICES `invoiceNumber` and `notes` — a file with a Reference column but no InvoiceNumber would have turned PO references into invoice numbers. Removed from INVOICES `invoiceNumber`; kept on BILLS (the vendor's reference is the bill number; the template header `InvoiceNumber` wins first, so a Xero bill export still maps Reference to notes). `computeLineTotals` is private — duplicated verbatim with a source comment. Added row messages the plan omitted (`Customer/Vendor name is required`, `Date is required`, `Vendor's invoice number is required`).
- Step 1: `ImportKindDef` extends `Omit<ImportKindMeta, 'commitModes'|'supportsConversionMode'>` (optional on the def, required on meta); `inventoryItemImportService.prepareCommit` returns `mode/postingDate: null`. Accepted.

## Risks & open questions

- **The FX rate for a posted foreign-currency document is taken at the posting date,** as `issueInvoiceOnClient` does today. In conversion mode that is the conversion date. Documented, not changed.
- **Stock problems surface at commit, not at validate:** a lot- or serial-tracked product, a short stock issue, or an invalid location precision. They give one wrapped error and a full rollback, the same trade-off 36b accepted for barcodes.
- **One large posted import holds the invoice-number row lock** from the first issue until COMMIT, blocking other users' issuing for that time. The 1000-document cap bounds it. It has not been timed.
- **A Xero TaxType** like "Tax on Sales" has no percentage and fails with the percent error. The user remaps or edits the cell. Documented.
- **Discounts and negative lines** (credit notes) are refused by the existing money and quantity rules. They are documented as not built.

## Definition of done

- Server and client typecheck, lint and tests are green; `verify:integrity` is clean; guardrail-review is clean; every earlier test is unedited except the approved fixture and factory defaults.
- Docs and study notes are updated; Phase 36 is marked complete.
- In the running app:
  - Invoices → Import → a file with numbered multi-line invoices previews correctly.
  - "Import as drafts" keeps the numbers.
  - A mid-year file in conversion mode posts to 3400, with AR ageing matching and P&L unchanged.
