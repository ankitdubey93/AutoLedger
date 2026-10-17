# Phase 46 — System accounts, placeholder previews, history & notes

Date: 2026-10-16 · **Status: done — Phase 46 landed** · Approved design: `/home/ankit/.claude/plans/pasted-content-id-ab2d-system-tender-pascal.md`

This is a direct feature request, numbered like 24/30/32…/45 (the next free number). It has five slices and **one commit per slice**:

| Slice | Outcome |
|---|---|
| **46a** | The accounts the system depends on are named, badged and protected from being retired, and a seeded **6830 Rounding** account exists. |
| **46b** | Every placeholder field shows what its placeholders become, and so does every picker entry and the "next run" of a recurring schedule. |
| **46c** | Every document, payment, contact and bank line has a Xero-style **History & notes** timeline, written by its own service in the same transaction. |
| **46d** | Sign-ins are recorded. Users see their own; managers see each member's activity. |
| **46e** | Unreconciled bank lines can be **deleted** (a soft status) and restored, and a bank account has a reconciliation history. |

**User decisions (fixed — do not reopen):**
1. **System accounts are a lock layer.** The effective system account is *derived* (settings column, else the default code), never stored. Settings keep remapping as today. The ~12 existing resolvers are **not** rewritten.
2. **New accounts:** tag the existing ones, and add **one** new account, **6830 Rounding**. Nothing posts to Rounding automatically, because `allocateCents` leaves no residue today.
3. **History** comes from an **explicit insert-only `document_history` table** that services write on their own transaction. `audit_logs` stays the raw CDC trail.
4. **Deleted bank lines** are soft-deleted to a `DELETED` status and can be restored. The dedupe hash still blocks re-importing them, and the import reports them as "previously deleted".

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

## Starting state (verified 2026-10-16, HEAD `c13c278`, tree clean)

**Schema**
- The last migration is `099_ledger-core_account_cash_flow_category.sql`, so this phase uses **`100`–`103`**.
- `accounts` columns: `id, org_id, code, name, type, parent_id, is_postable, is_active, description, bank_account_kind (097), cash_flow_category (099), created_by, created_at, updated_at`.
  - `UNIQUE (org_id, code)`. There is no system flag.
  - `code` and `type` are never updatable (`accountService.updateAccount` comment).
- System-account settings columns:
  - `ledger_settings`: `payable_account_id`, `tax_input_account_id`, `realized_fx_gain_account_id`, `realized_fx_loss_account_id`, `unrealized_fx_account_id`, `inventory_account_id`, `cogs_account_id`, `inventory_adjustment_account_id`, `stock_opening_account_id`. **`payable_account_id` and `tax_input_account_id` are not in `updateSettings`' `COLUMNS` map, so they cannot be remapped through the API.**
  - `ledger_invoice_settings`: `receivable_account_id`, `tax_payable_account_id`, `customer_deposit_account_id`, `supplier_prepayment_account_id`.
- Fallback codes used by the resolvers:
  - 1120 AR, 2100 AP, 1180 tax input, 2140 tax output
  - 4910 / 6810 / 6820 FX
  - 1140 / 5050 / 5400 / 3400 inventory
  - 2130 / 1150 deposits
  - 3200 (opening-balance import only)
  - 3400 (chart, opening-balance and document imports)
- `bank_transactions` (019 → 057 → 074):
  - `status CHECK IN ('UNMATCHED','MATCHED','IGNORED')`
  - `UNIQUE (org_id, dedupe_hash)` (`ux_bank_transactions_dedupe`)
  - `reject_bank_transaction_mutation()` refuses DELETE and any change outside `status, matched_payment_id, matched_journal_entry_id, matched_rule_id, matched_at, matched_by, updated_at`. Its latest body is in `074_ledger-core_bank_rules.sql` lines 63–79.
- `audit_logs` (017): append-only via `reject_audit_log_mutation()` + `trg_audit_logs_immutable` (017 lines 150–159). It is the template for the new append-only triggers.
- Every one of `invoices, bills, credit_notes, debit_notes, quotes, orders, payments, manual_journals, customers, vendors` has `created_by` and `created_at` (checked against the dev DB). `quotes` and `orders` carry `direction IN ('SALES','PURCHASE')`.
- There is no `document_history`, no `login_events`, no `DELETED` bank status.

**Server** (`server/src/`)
- `services/accounting/accountService.ts`:
  - `ACCOUNT_COLUMNS`, `AccountRow`, `toAccount`
  - `listAccounts`, `listAccountTree`, `getAccountById`, `createAccountOnClient`, `createAccount`
  - `updateAccount` (L296; the `COLUMNS` map; runs its UPDATE in `withTransaction`)
  - `DEFAULT_CHART` (L394, 52 entries including headers), `seedDefaultChart`
- Resolvers that the registry must agree with:
  - `invoiceService.resolvePostingAccounts` (L994)
  - `settingsService.resolveApPostingAccountsOnClient` (L458) and `resolveInventoryPostingAccountsOnClient` (L513)
  - `paymentService.resolveControlAccount` (L436, exported); `resolveFxAccount` (L480, private)
  - `fxRevaluationService.resolveUnrealizedFxAccount` (L211, private)
  - `depositService.resolveDepositAccountsOnClient` (L112, exported)
- `settingsService.updateSettings` (L302) and `invoiceSettingsService.updateInvoiceSettings` (~L220) patch account columns. Today they only check that the account exists (by FK or `assertInventoryAccount`). **Neither refuses a retired account.**
- Bank:
  - `services/accounting/bankMatchService.ts`: `BANK_TXN_SELECT` (L309), `ListBankTransactionsOptions` / `buildFilters` (L435–476), `listTransactions`, `getTransactionById`, `matchTransaction` (~L570), `postJournalForTransactionOnClient` (~L780), `unmatchTransaction` (L858), `setIgnored(orgId, id, ignored)` (L927, **no userId**), `generateSuggestionsOnClient`.
  - `bankImportService.importStatement` → `ImportStatementResult` (L301): `{import, duplicateCount, importedCount, suggestedCount, autoMatchableCount, ruleMatchedCount}`. It inserts with `ON CONFLICT (org_id, dedupe_hash) DO NOTHING`.
  - `bankRuleService.ts` L358 and L407 select only `status = 'UNMATCHED'`, so DELETED lines are excluded automatically.
  - `reportService.ts` ~L419: the bank-reconciliation summary uses `FILTER (WHERE status <> 'IGNORED')`. **That must also exclude `DELETED`.**
- `types/accounting.ts`:
  - `BANK_TRANSACTION_STATUSES` / `BANK_TRANSACTION_TRANSITIONS` / `canTransitionBankTransaction` (L1072–1096)
  - `QUOTE_TRANSITIONS` (L1884), `ORDER_TRANSITIONS` (L2093)
- Central transition helpers:
  - `quoteStatusService.transitionQuoteOnClient(client, orgId, quoteId, to, extras)`: selects `status` only, **not `direction`**.
  - `orderService.transitionOrderOnClient(client, orgId, direction, id, to, extras)` (private, L816).
  - Invoices, bills, notes, payments and manual journals have **no** central helper. Each transition is its own exported function (listed in Step 21–24).
- Controllers and routes: `controllers/accounting/bankTransactionController.ts`, `routes/accounting/bankTransactionRoutes.ts` (`GET /:id` is registered, so new literal paths go **before** it), `bankImportRoutes.ts`, `routes/accounting/accountRoutes.ts` (`GET /:id` at L23), `routes/accounting/index.ts` (mounts at L42–72), `routes/accounting/quoteRoutes.ts` (`buildQuoteRouter(direction)`, the router-factory analogue), `routes/organizations.ts` (`GET /members`, `PATCH|DELETE /members/:userId`), `routes/auth.ts`.
- `services/authService.ts`:
  - `login` (L392): the failure path throws `ApiError(401,'Invalid email or password')` inside the transaction and then ROLLBACKs.
  - `logout(refreshToken)` (L670) uses `pool`.
  - `changePassword` (L713), `revokeSession` (L790), `revokeOtherSessions` (L813), `resetPassword` (L1108).
  - `getRequestContext()` gives `{ip, userAgent, userId, orgId}`.
- Permissions (`config/permissions.ts`): `accounts.view`; `invoices.view/edit`; `bills.view/edit`; `credit_notes.view/edit`; `debit_notes.view/edit`; `quotes.view/edit`; `purchase_quotes.view/edit`; `sales_orders.view/edit`; `purchase_orders.view/edit`; `payments.view/create`; `journals.view/create`; `customers.view/manage`; `vendors.view/manage`; `bank.view/reconcile`; `members.view`; `audit.view`. **No new permission key in this phase.**
- Utils: `utils/money.ts` `formatCents(cents)` → `"450.00"`, `cents()`, `parseCents()`. `utils/requestContext.ts` `getRequestContext()`.
- Tests:
  - `__tests__/helpers/factories.ts`: `resetTables()` (an explicit TRUNCATE list, **new tables must be added**), `createUserWithOrg`, `addMember`, `loginAgent`.
  - `__tests__/helpers/accountingFixtures.ts`: `accountId(orgId, code)`, `createCustomer`, `issueInvoice`, `receivePayment`, `issueCreditNote`, `postBill`.
  - `__tests__/accounting/bankLineJournal.test.ts` L41–60: the `importSingleLine` pattern.
  - `__tests__/platform/routePermissions.test.ts` fails on any ungated route.
  - `__tests__/migrations.test.ts` replays every migration.

**Client** (`client/src/`)
- `components/placeholders/PlaceholderHints.tsx` (previews **only the first** field) and `PlaceholderPicker.tsx` (no preview). `utils/placeholders.ts` (`fillPlaceholders`, `containsPlaceholders`, `PlaceholderContext`). `utils/usePlaceholderTarget.ts`.
- Preview gaps:
  - `Pages/banking/BankRulesPage.tsx` L221: no `preview`
  - `Pages/settings/InvoiceSettingsPage.tsx` L461: no `preview`
  - `Pages/settings/InvoiceTemplatePage.tsx` L370 and `StatementTemplatePage.tsx` L278: no `preview`
  - `Pages/accounting/NewRepeatingJournalPage.tsx` L169: no `occurrence`
  - `Pages/sales/notes/NoteFormPage.tsx` L436: no `invoiceNumber`. `OriginalView.label` is `invoiceNumber` for a credit note (`noteKinds.ts` L242).
  - `Pages/banking/BankTransactionsPage.tsx` L372: post-journal memo `<input>` has no picker and no hints.
  - `Pages/accounting/RecurringScheduleDetailPage.tsx`: no text preview. `RecurringSchedule` has `kind, sourceId, sourceManualJournalId, nextRunDate, nextOccurrenceIndex`.
- `Pages/sales/sampleInvoice.ts`: `SAMPLE_INVOICE` (`invoiceNumber 'INV-000042'`, `issueDate '2026-06-01'`, `dueDate '2026-07-01'`), `SAMPLE_CUSTOMER_NAME`. `Pages/statements/sampleStatement.ts` `sampleStatement(type)`. `context/OrgContext.tsx` `useOrganizationName()`. `context/AuthContext.tsx` `useCan()`.
- `services/fetchServices.ts`: `apiFetch`; `Account` (L499); `listAccounts`, `updateAccount`, `getJournal`, `getManualJournal`, `getInvoice`, `getBill`, `listSessions`, `listMembers`, `listBankImports`, `listBankTransactions`, `unmatchBankTransaction`, `ignoreBankTransaction`, `unignoreBankTransaction` (L3337–3420); `BankTransaction` (L3225).
- Pages:
  - `Pages/accounting/AccountsPage.tsx`, `Pages/settings/ChartSettingsPage.tsx`, `Pages/settings/FinancialSettingsPage.tsx` (route `/settings/financial`), `InvoiceSettingsPage.tsx` (route `/settings/invoicing`)
  - `Pages/settings/AuditLogPage.tsx` (`/settings/audit`), `SettingsHubPage.tsx` (link groups, L32/L97), `Pages/account/SessionsPanel.tsx`
  - `components/AttachmentsPanel.tsx`: the analogue for a panel at the foot of a detail page. Mounted at `InvoiceDetailPage.tsx:491` and `BillDetailPage.tsx:577`.
- Detail pages that get History & notes (the `*DetailPage.tsx` wrappers under `Pages/sales` / `Pages/purchases` are 7-line re-exports; edit the real components):
  - `Pages/sales/InvoiceDetailPage.tsx`
  - `Pages/purchases/BillDetailPage.tsx`
  - `Pages/sales/notes/NoteDetailPage.tsx`
  - `Pages/sales/quotes/QuoteDetailPage.tsx`
  - `Pages/sales/orders/OrderDetailPage.tsx`
  - `Pages/accounting/ManualJournalDetailPage.tsx`
  - `Pages/sales/PartyAccountPage.tsx`
  - Client `orderKinds.path` is `'sales-orders'`, but the **API** path is `/orders`.
- `Pages/banking/BankTransactionsPage.tsx`: `TABS` (L39: All/Unmatched/Matched/Ignored). `Pages/banking/BankImportPage.tsx`.
- `routes/ProductRoutes.tsx` (settings routes L265–283), `utils/pageTitle.ts` (`EXACT_TITLES`).
- Client tests: `__tests__/placeholderUi.test.tsx`, `accounts.test.tsx`, `settingsPage.test.tsx`, `bankTransactions.test.tsx`, `bankImport.test.tsx`, `auditLog.test.tsx`, `AccountPage.test.tsx`, `invoices.test.tsx`.

**Study notes that already exist:** `study/postgresql/append-only-audit-trails.md`, `study/postgresql/audit-triggers-and-session-variables.md`.

## Gate

- Prerequisites are built (verified above): Phase 3 (chart), 5 (audit trail), 6/6.1/34a (bank), 25/35a (control accounts), 38a (sessions), 40 (placeholders), 41–44 (quotes, orders, notes, manual journals).
- Nothing in this phase depends on a gated phase. **No new npm package.**
- Roadmap debt carried in: `docs/schema.md`'s default-chart table is stale. It lacks 1150/2130/5050/5400, says "45 accounts" and names `authService.register` as the seeder (the seeder is `organizationService.ts:234`). Fixed in Step 8.

## Execution rules

> **If a proof command fails twice on the same step, stop and report. Do not improvise around it.**

| Symptom | Forbidden | Correct |
|---|---|---|
| Migration checksum error | Editing the applied migration | A new sequential migration (rule 13) |
| Test fails | Weakening or deleting the assertion | Fix the code; the test is the spec |
| Type error | `as any`, `@ts-ignore`, loosening `tsconfig` | Fix the type |
| Query returns no rows | Dropping the `org_id` predicate | Fix the fixture or the parameters (rule 1) |
| Balance assertion fails | An epsilon comparison, floats, rounding | Integer cents equality (rule 3) |
| Need a helper library | `npm install` something not in the plan | Stop and ask (rule 14) |
| "Delete the bank line" | `DELETE FROM bank_transactions` | `status = 'DELETED'` through the FSM (rule 6/10) |
| "Edit a history row" | UPDATE/DELETE on `document_history` / `login_events` | They are append-only; add a new row |
| Column missing at runtime | Adding it ad hoc in the service | New migration, then update the plan |
| A `[Haiku]` step's proof fails twice | Retrying in a loop, trimming the step, "good enough" | Escalate the step **unchanged** to Sonnet with the failure output; note the escalation in this file |
| The step needs a decision the plan never made | Deciding it | Stop and report — the plan is the defect |

**Database access for proofs:** `psql` is not on the host and there is no `DATABASE_URL`. Use `docker exec autodb_postgres psql -U autodb_user -d autodb -c '...'`.

**Anything the plan did not anticipate is a stop-and-report, not a judgment call.**

---

## Step 0 — [Haiku] Preflight and move this plan into place

- **Model:** [Haiku] — read-only checks
- **Depends on:** —
- **Files:** none
- **Do:** run, from the repo root:
  ```bash
  git status --short
  git log -1 --format=%h
  ls server/src/db/migrations | tail -1
  docker exec autodb_postgres psql -U autodb_user -d autodb -Atc 'SELECT 1'
  ```
- **Proof:** the tree is clean (or only this plan file is untracked), the last migration is `099_ledger-core_account_cash_flow_category.sql`, and the DB prints `1`.
- **If it fails:** a migration ≥ `100` exists → stop and report (the numbers in this plan are wrong). The DB is down → `docker compose up -d postgres redis`, then re-run.

---

# Slice 46a — System accounts

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| Migration | `server/src/db/migrations/100_ledger-core_rounding_account.sql` |
| New account | code `6830`, name `Rounding`, type `Expense`, parent `6000`, postable |
| Registry | `server/src/config/systemAccounts.ts` → `SYSTEM_ACCOUNT_ROLES`, `SystemAccountRole`, `SystemAccountRoleDef`, `SystemAccountSettingColumn` |
| Service | `server/src/services/accounting/systemAccountService.ts` → `resolveSystemAccountsOnClient`, `rolesForAccountsOnClient`, `listSystemAccounts`, `assertActiveAccountsOnClient` |
| Types | `server/src/types/accounting.ts` → `SystemRoleRef { role: SystemAccountRole; label: string }`, `SystemAccountView`; `Account.systemRoles: SystemRoleRef[]` |
| Controller | `accountController.listSystem` |
| Route | `GET /api/v1/accounts/system` (`accounts.view`) |
| Server test | `server/src/__tests__/accounting/systemAccounts.test.ts` |
| Client | `fetchServices.ts` → `SystemRoleRef`, `SystemAccountView`, `listSystemAccounts()`; `Account.systemRoles?: SystemRoleRef[]`; `components/ui/SystemAccountBadge.tsx` |
| Client test | `client/src/__tests__/systemAccounts.test.tsx` |

### Step 1 — [Sonnet] Migration 100 and `DEFAULT_CHART` gain 6830 Rounding

- **Model:** [Sonnet] — a migration (rule 13 makes it unrepairable in place), and the seed must match it exactly
- **Depends on:** 0
- **Skill:** new-migration
- **Read first:** `server/src/db/migrations/093_ledger-core_deposits.sql` lines 1–30 (the account backfill idiom); `accountService.ts` `DEFAULT_CHART` (L394–456).
- **Files:** `server/src/db/migrations/100_ledger-core_rounding_account.sql` (new); `server/src/services/accounting/accountService.ts` (edit `DEFAULT_CHART` and the comment above it)
- **Contract — the migration, literally:**
  ```sql
  -- Phase 46a — the Rounding system account (Xero's 860 equivalent). Seeded
  -- and tagged by systemAccounts.ts; nothing posts to it automatically yet
  -- (allocateCents leaves no residue). ON CONFLICT skips an org whose
  -- imported chart already uses 6830. accountService.DEFAULT_CHART gains the
  -- same row.
  INSERT INTO accounts (org_id, code, name, type, is_postable, parent_id)
  SELECT o.id, '6830', 'Rounding', 'Expense', true,
         (SELECT p.id FROM accounts p WHERE p.org_id = o.id AND p.code = '6000')
    FROM organizations o
   WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.org_id = o.id AND a.code = '6000')
  ON CONFLICT (org_id, code) DO NOTHING;
  ```
  In `DEFAULT_CHART`, add this line directly after the `6820` entry:
  ```ts
  { code: '6830', name: 'Rounding', type: 'Expense', parent: '6000', postable: true },
  ```
  Extend the block comment's bullet list with: ` *   - 6830 Rounding — a system account (Phase 46a); no automatic postings yet`.
- **Guardrails:** #13 additive and idempotent (`ON CONFLICT DO NOTHING`); #1 every row carries its own `org_id`.
- **Proof:**
  ```bash
  cd server && npm run migrate && npm run migrate
  docker exec autodb_postgres psql -U autodb_user -d autodb -Atc "SELECT count(*) FROM organizations o WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.org_id=o.id AND a.code='6830') AND EXISTS (SELECT 1 FROM accounts a WHERE a.org_id=o.id AND a.code='6000')"
  npm test -- migrations accounts
  ```
  `migrate` succeeds twice, the count prints `0`, and both test files pass. If an `accounts.test.ts` assertion counts the seeded chart, it must now expect one more account. That is the only sanctioned test edit; change the number only.
- **If it fails:** a replay error → fix the SQL in this unapplied-to-prod file only if `schema_migrations` does not yet list `100`; otherwise write `101` and renumber this plan's later migrations (stop and report first).
- **Owes:** schema.md (Step 8).

### Step 2 — [Haiku] The system-account registry and its types

- **Model:** [Haiku] — one new file transcribed verbatim, plus type additions
- **Depends on:** 1
- **Read first:** `server/src/config/modules.ts` (a `config/` file's style; `as const` registry)
- **Files:** `server/src/config/systemAccounts.ts` (new); `server/src/types/accounting.ts` (edit: append after the `Account` interface)
- **Contract — `config/systemAccounts.ts`, literally:**
  ```ts
  /**
   * Phase 46a — the accounts the system itself posts to or reasons about.
   * A role is DERIVED, never stored: the effective account is the settings
   * column when set, else the account with `defaultCode`. This mirrors what
   * the posting resolvers do (systemAccountService parity test), so the lock
   * protects exactly the account postings would use.
   */
  export type SystemAccountSettingColumn =
    | 'ledger_settings.payable_account_id'
    | 'ledger_settings.tax_input_account_id'
    | 'ledger_settings.stock_opening_account_id'
    | 'ledger_settings.realized_fx_gain_account_id'
    | 'ledger_settings.realized_fx_loss_account_id'
    | 'ledger_settings.unrealized_fx_account_id'
    | 'ledger_settings.inventory_account_id'
    | 'ledger_settings.cogs_account_id'
    | 'ledger_settings.inventory_adjustment_account_id'
    | 'ledger_invoice_settings.receivable_account_id'
    | 'ledger_invoice_settings.tax_payable_account_id'
    | 'ledger_invoice_settings.customer_deposit_account_id'
    | 'ledger_invoice_settings.supplier_prepayment_account_id';

  export interface SystemAccountRoleDef {
    role: string;
    label: string;
    defaultCode: string;
    setting: SystemAccountSettingColumn | null;
    /** True when a settings page can point the role at another account. */
    remappable: boolean;
  }

  export const SYSTEM_ACCOUNT_ROLES = [
    { role: 'RECEIVABLE', label: 'Accounts Receivable', defaultCode: '1120', setting: 'ledger_invoice_settings.receivable_account_id', remappable: true },
    { role: 'PAYABLE', label: 'Accounts Payable', defaultCode: '2100', setting: 'ledger_settings.payable_account_id', remappable: false },
    { role: 'TAX_INPUT', label: 'Tax on purchases', defaultCode: '1180', setting: 'ledger_settings.tax_input_account_id', remappable: false },
    { role: 'TAX_OUTPUT', label: 'Tax on sales', defaultCode: '2140', setting: 'ledger_invoice_settings.tax_payable_account_id', remappable: true },
    { role: 'RETAINED_EARNINGS', label: 'Retained Earnings', defaultCode: '3200', setting: null, remappable: false },
    { role: 'OPENING_BALANCE', label: 'Historical adjustment', defaultCode: '3400', setting: null, remappable: false },
    { role: 'STOCK_OPENING', label: 'Opening stock', defaultCode: '3400', setting: 'ledger_settings.stock_opening_account_id', remappable: true },
    { role: 'REALIZED_FX_GAIN', label: 'Realized currency gains', defaultCode: '4910', setting: 'ledger_settings.realized_fx_gain_account_id', remappable: true },
    { role: 'REALIZED_FX_LOSS', label: 'Realized currency losses', defaultCode: '6810', setting: 'ledger_settings.realized_fx_loss_account_id', remappable: true },
    { role: 'UNREALIZED_FX', label: 'Unrealized currency gains', defaultCode: '6820', setting: 'ledger_settings.unrealized_fx_account_id', remappable: true },
    { role: 'INVENTORY', label: 'Inventory', defaultCode: '1140', setting: 'ledger_settings.inventory_account_id', remappable: true },
    { role: 'COGS', label: 'Cost of sales — inventory', defaultCode: '5050', setting: 'ledger_settings.cogs_account_id', remappable: true },
    { role: 'INVENTORY_ADJUSTMENT', label: 'Inventory adjustments', defaultCode: '5400', setting: 'ledger_settings.inventory_adjustment_account_id', remappable: true },
    { role: 'CUSTOMER_DEPOSITS', label: 'Customer deposits', defaultCode: '2130', setting: 'ledger_invoice_settings.customer_deposit_account_id', remappable: true },
    { role: 'SUPPLIER_PREPAYMENTS', label: 'Supplier prepayments', defaultCode: '1150', setting: 'ledger_invoice_settings.supplier_prepayment_account_id', remappable: true },
    { role: 'ROUNDING', label: 'Rounding', defaultCode: '6830', setting: null, remappable: false },
  ] as const satisfies readonly SystemAccountRoleDef[];

  export type SystemAccountRole = (typeof SYSTEM_ACCOUNT_ROLES)[number]['role'];
  ```
  Append to `types/accounting.ts` (import `SystemAccountRole` with `import type { SystemAccountRole } from '../config/systemAccounts.js';` at the top of the file):
  ```ts
  /** Phase 46a — a system role an account currently holds (derived, see config/systemAccounts.ts). */
  export interface SystemRoleRef {
    role: SystemAccountRole;
    label: string;
  }

  /** Phase 46a — one row of GET /accounts/system. */
  export interface SystemAccountView {
    role: SystemAccountRole;
    label: string;
    defaultCode: string;
    remappable: boolean;
    /** Null when neither the setting nor the default code resolves to an account. */
    accountId: string | null;
    code: string | null;
    name: string | null;
    isActive: boolean | null;
  }
  ```
  Add `systemRoles: SystemRoleRef[];` as the last field of the existing `Account` interface in `types/accounting.ts`.
- **Guardrails:** #12. The registry is *roles*, never a new account type.
- **Proof:** `cd server && npm run typecheck` reports errors **only** where an `Account` object literal is now missing `systemRoles` (expected in `accountService.toAccount`). Fix that one site by returning `systemRoles: []` from `toAccount`, then `npm run typecheck` exits 0.
- **If it fails:** an error anywhere else → stop and report.
- **Owes:** nothing yet.

### Step 3 — [Sonnet] `systemAccountService` and the resolver parity test

- **Model:** [Sonnet] — tenant-scoped SQL that every lock depends on, plus a parity proof against 6 resolvers
- **Depends on:** 2
- **Skill:** new-module (service layer), isolation-test
- **Read first:** `settingsService.ts` L493–561 (`resolveInventoryPostingAccountsOnClient`: one settings read plus one batched account read); `paymentService.ts` L436–501.
- **Files:** `server/src/services/accounting/systemAccountService.ts` (new); `server/src/__tests__/accounting/systemAccounts.test.ts` (new, parity block only)
- **Contract:**
  ```ts
  type Queryable = Pick<PoolClient, 'query'>;
  export interface ResolvedSystemAccount { accountId: string; code: string; name: string; isActive: boolean }
  /** role → its effective account, or null. Two queries, both org-scoped. */
  export async function resolveSystemAccountsOnClient(
    q: Queryable, orgId: string,
  ): Promise<Map<SystemAccountRole, ResolvedSystemAccount | null>>;
  /** accountId → the roles it holds (only ids that hold ≥1 role appear). */
  export async function rolesForAccountsOnClient(
    q: Queryable, orgId: string,
  ): Promise<Map<string, SystemRoleRef[]>>;
  export async function listSystemAccounts(orgId: string): Promise<SystemAccountView[]>;
  /** 422 `Account ${code} is retired — activate it before using it here` for the first retired id. Ignores null. */
  export async function assertActiveAccountsOnClient(
    q: Queryable, orgId: string, accountIds: readonly (string | null | undefined)[],
  ): Promise<void>;
  ```
  - Query 1, literally:
    ```sql
    SELECT ls.payable_account_id, ls.tax_input_account_id, ls.stock_opening_account_id,
           ls.realized_fx_gain_account_id, ls.realized_fx_loss_account_id, ls.unrealized_fx_account_id,
           ls.inventory_account_id, ls.cogs_account_id, ls.inventory_adjustment_account_id,
           lis.receivable_account_id, lis.tax_payable_account_id,
           lis.customer_deposit_account_id, lis.supplier_prepayment_account_id
      FROM organizations o
      LEFT JOIN ledger_settings ls ON ls.org_id = o.id
      LEFT JOIN ledger_invoice_settings lis ON lis.org_id = o.id
     WHERE o.id = $1
    ```
    Map each `SystemAccountSettingColumn` to its row key by the part after the dot. Use a typed `Record<SystemAccountSettingColumn, keyof Row>`, not string splitting at runtime.
  - Query 2: `SELECT id, code, name, is_active FROM accounts WHERE org_id = $1 AND (id = ANY($2::uuid[]) OR code = ANY($3::text[]))`.
  - Resolution per role:
    - If the setting is non-null, use that id.
    - Otherwise use the account whose code is `defaultCode`.
    - If neither exists, the role resolves to null.
    - No type or postable check. This matches 5 of the 6 resolvers. The inventory resolver also returns null on a type mismatch; the parity test only uses valid accounts.
  - `rolesForAccountsOnClient` inverts the map, preserving `SYSTEM_ACCOUNT_ROLES` order.
  - `listSystemAccounts` uses `pool`. It returns one `SystemAccountView` per role, in registry order.
- **Tests (in `systemAccounts.test.ts`, `describe('system account resolution')`):**
  1. `fresh org resolves every role to its default code`: for each role, `code === defaultCode`.
  2. `the registry agrees with every posting resolver (default chart)`, inside `withTransaction` on one client:
     - `invoiceService.resolvePostingAccounts(client, orgId, true)` → `{receivableAccountId, taxAccountId}` equal RECEIVABLE / TAX_OUTPUT
     - `settingsService.resolveApPostingAccountsOnClient(client, orgId, true)` equal PAYABLE / TAX_INPUT
     - `settingsService.resolveInventoryPostingAccountsOnClient` equal INVENTORY / COGS / INVENTORY_ADJUSTMENT / STOCK_OPENING
     - `paymentService.resolveControlAccount(client, orgId, 'RECEIVE'|'PAY')` equal RECEIVABLE / PAYABLE
     - `depositService.resolveDepositAccountsOnClient(client, orgId, 'SALES'|'PURCHASE')` equal CUSTOMER_DEPOSITS / SUPPLIER_PREPAYMENTS
  3. `…and after remapping`:
     - Create a postable Asset `1125` and a postable Expense `6825` via `POST /api/v1/accounts`.
     - `PATCH /api/v1/settings/invoicing` with `receivableAccountId` = 1125.
     - `PATCH /api/v1/settings` with `unrealizedFxAccountId` = 6825.
     - RECEIVABLE now resolves to 1125, and 1120 holds no role.
     - UNREALIZED_FX resolves to 6825.
     - `resolveControlAccount(..., 'RECEIVE')` agrees.
  4. `cross-tenant`: `resolveSystemAccountsOnClient(pool, orgB)` never returns an account id belonging to org A.
  5. `OPENING_BALANCE and STOCK_OPENING share 3400`: `rolesForAccountsOnClient` lists both roles for 3400, in registry order.
- **Guardrails:** #1 `org_id = $1` / `o.id = $1` in both queries; #4 no identifier interpolation (the column map is a typed constant, the SQL is literal); #5 the `*OnClient` functions use only `q`.
- **Proof:** `cd server && npm run typecheck && npm test -- systemAccounts` shows 5 passing tests.
- **If it fails:** a parity mismatch is a real finding. Stop and report which resolver disagrees; never change the registry to match a resolver bug.
- **Owes:** study note (Step 9).

### Step 4 — [Sonnet] Lock the system accounts and decorate `Account` with `systemRoles`

- **Model:** [Sonnet] — guards on shared write paths, across 3 services
- **Depends on:** 3
- **Read first:** `accountService.ts` L101–170 and L296–364; `settingsService.updateSettings` (L302–440); `invoiceSettingsService.updateInvoiceSettings` (~L215–300).
- **Files:** `services/accounting/accountService.ts`, `services/accounting/settingsService.ts`, `services/accounting/invoiceSettingsService.ts` (all edit); `__tests__/accounting/systemAccounts.test.ts` (edit: add a block)
- **Contract:**
  - Add `async function withSystemRoles(q: Queryable, orgId: string, accounts: Account[]): Promise<Account[]>`, which sets `systemRoles` from `rolesForAccountsOnClient` (default `[]`).
    - Apply it to the return value of `listAccounts`, `getAccountById`, `createAccount` and `updateAccount`, and to every node of `listAccountTree` (recursively).
    - `createAccountOnClient` returns `systemRoles: []` unchanged; it runs inside other callers' transactions and needs no decoration.
  - In `updateAccount`, before the `COLUMNS` loop: `const roles = (await rolesForAccountsOnClient(pool, orgId)).get(id) ?? [];` and `const labels = roles.map((r) => r.label).join(' and ');`. Then, when `roles.length > 0`:
    - `input.isActive === false` → `throw new ApiError(422, `${labels} is a system account and cannot be retired`)`
    - `input.bankAccountKind !== undefined && input.bankAccountKind !== null` → `throw new ApiError(422, `${labels} is a system account and cannot be a bank or credit card account`)`
    - Rename, description, `parentId` and `cashFlowCategory` stay allowed.
  - In `updateSettings` and `updateInvoiceSettings`, collect every account-id field present in the input. That is:
    - `cashAccountId`, `realizedFxGainAccountId`, `realizedFxLossAccountId`, `unrealizedFxAccountId`, `inventoryAccountId`, `cogsAccountId`, `inventoryAdjustmentAccountId`, `stockOpeningAccountId`
    - `receivableAccountId`, `defaultRevenueAccountId`, `taxPayableAccountId`, `customerDepositAccountId`, `supplierPrepaymentAccountId`
    - Call `assertActiveAccountsOnClient(<the function's client or pool>, orgId, ids)` **before** the UPDATE/UPSERT runs. Use the transaction client if the function already holds one at that point; otherwise use `pool` before the transaction opens.
- **Tests (append to `systemAccounts.test.ts`, `describe('system account locks')`):**
  1. `PATCH /accounts/:id {isActive:false}` on 1120 → `422`, body message `Accounts Receivable is a system account and cannot be retired`.
  2. The same on 3400 → `422`, message `Historical adjustment and Opening stock is a system account and cannot be retired`.
  3. `PATCH {bankAccountKind:'BANK'}` on 1140 → `422`.
  4. `PATCH {name:'Debtors'}` on 1120 → `200`, and `systemRoles[0].role === 'RECEIVABLE'`.
  5. After remapping RECEIVABLE to 1125 (as in Step 3 test 3), `PATCH {isActive:false}` on 1120 → `200`.
  6. Retire 6100, then `PATCH /settings {realizedFxLossAccountId: <6100 id>}` → `422`, message `Account 6100 is retired — activate it before using it here`.
  7. `GET /accounts` includes `systemRoles` on every row: 6830 has `[{role:'ROUNDING',label:'Rounding'}]` and 6100 has `[]`.
  8. Cross-tenant: org A's `PATCH /accounts/<org B 1120 id>` → `404`, as today.
- **Guardrails:** #1; #2 (all of this is in services, not controllers); #5 nothing inside `withTransaction` uses `pool`.
- **Proof:** `cd server && npm run typecheck && npm test -- systemAccounts accounts settings` passes (13 tests in `systemAccounts`).
- **If it fails:** an existing test retires a system account (e.g. retires 1120 in a fixture) → stop and report. Do not loosen the guard.
- **Owes:** api.md (Step 8).

### Step 5 — [Haiku] `GET /accounts/system`

- **Model:** [Haiku] — controller + route over a finished service
- **Depends on:** 4
- **Read first:** `controllers/accounting/accountController.ts` (`list`), `routes/accounting/accountRoutes.ts`
- **Files:** `controllers/accounting/accountController.ts` (edit), `routes/accounting/accountRoutes.ts` (edit)
- **Contract:**
  ```ts
  /** GET /accounts/system — Phase 46a. */
  export const listSystem: RequestHandler = async (req, res) => {
    const user = requireUser(req);
    const systemAccounts = await systemAccountService.listSystemAccounts(user.orgId);
    res.json({ success: true, count: systemAccounts.length, systemAccounts });
  };
  ```
  Route, inserted **immediately before** `router.get('/:id', …)` (L23):
  `router.get('/system', authenticate, requirePermission('accounts.view'), accountController.listSystem);`
- **Tests (append to `systemAccounts.test.ts`):** `GET /api/v1/accounts/system` → `200`, `count === 16`, and the row with `role:'ROUNDING'` has `code:'6830'`, `remappable:false`.
- **Proof:** `cd server && npm test -- systemAccounts routePermissions` passes.
- **If it fails:** a 404 on `/system` means it was registered after `/:id`. Move the line up.
- **Owes:** api.md (Step 8).

### Step 6 — [Haiku] Client: badges, locked controls and the System accounts panel

- **Model:** [Haiku] — client rendering of a response whose shape is fixed above
- **Depends on:** 5
- **Read first:** `client/src/Pages/settings/ChartSettingsPage.tsx` (row rendering, the Retire button, the bank toggle); `client/src/Pages/accounting/AccountsPage.tsx` (`TYPE_STYLES` badge); `client/src/Pages/settings/FinancialSettingsPage.tsx`.
- **Files:**
  - `client/src/services/fetchServices.ts` (edit)
  - `client/src/components/ui/SystemAccountBadge.tsx` (new)
  - `AccountsPage.tsx`, `ChartSettingsPage.tsx`, `FinancialSettingsPage.tsx` (edit)
  - `client/src/__tests__/systemAccounts.test.tsx` (new)
- **Contract:**
  - `fetchServices.ts`:
    - Add `export interface SystemRoleRef { role: string; label: string }`.
    - Add `export interface SystemAccountView { role: string; label: string; defaultCode: string; remappable: boolean; accountId: string | null; code: string | null; name: string | null; isActive: boolean | null }`.
    - Add `systemRoles?: SystemRoleRef[];` to `Account` (optional, so older fixtures still typecheck).
    - Add `export function listSystemAccounts(signal?: AbortSignal): Promise<{ success: boolean; count: number; systemAccounts: SystemAccountView[] }> { return apiFetch('/accounts/system', { signal: signal ?? null }); }`.
  - `SystemAccountBadge({ roles }: { roles: SystemRoleRef[] })`:
    - Renders nothing when `roles.length === 0`.
    - Otherwise renders `<span title={`System account: ${labels}. It can be renamed but not retired.`} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs bg-[var(--panel-2)] text-[var(--muted)]"><Lock size={11} aria-hidden="true" />System</span>` (with `Lock` from `lucide-react`).
  - `AccountsPage.tsx`: render `<SystemAccountBadge roles={node.systemRoles ?? []} />` next to the type badge.
  - `ChartSettingsPage.tsx`:
    - The same badge on each row.
    - When `(account.systemRoles ?? []).length > 0`, disable the Retire button and the bank toggle, each with `title="System accounts cannot be retired or flagged as bank accounts"`.
  - `FinancialSettingsPage.tsx`:
    - A new section headed `System accounts`, loading `listSystemAccounts()`.
    - A table with columns Role · Account (`code name`, or `Not set up` when `accountId === null`) · `Change` (only when `remappable`, a link to `/settings/financial` for `ledger_settings.*` roles and `/settings/invoicing` for `RECEIVABLE`, `TAX_OUTPUT`, `CUSTOMER_DEPOSITS`, `SUPPLIER_PREPAYMENTS`).
- **Tests (`systemAccounts.test.tsx`, mocking `fetchServices` like `accounts.test.tsx` does):**
  1. A 1120 row with `systemRoles:[{role:'RECEIVABLE',label:'Accounts Receivable'}]` shows the text `System`.
  2. On the chart settings page its Retire button is disabled.
  3. The Financial settings page lists `Rounding` with `6830 Rounding`.
- **Proof:** `cd client && npm run typecheck && npm test -- systemAccounts accounts settingsPage` passes.
- **If it fails:** a page test that renders an `Account` without `systemRoles` must still pass, because the field is optional. Do not make it required.
- **Owes:** nothing.

### Step 7 — [Sonnet] Study note: derived vs stored designations

- **Model:** [Sonnet] — accuracy task
- **Depends on:** 4
- **Skill:** study-note
- **Files:** `study/architecture/derived-system-account-roles.md` (new, from `study/TEMPLATE.md`); `study/README.md` (index + coverage tracker)
- **Contract:** the topic is *a role derived from configuration vs a stored flag*. Cover:
  - Why a stored `system_role` column drifts once a setting remaps.
  - The parity test as the proof that the derived view matches the posting path.
  - Why the lock is enforced in the service, not by a trigger. A trigger would need to replicate the settings resolution in plpgsql.
  - Xero's fixed system accounts compared with our remappable ones.
  - 4–6 interview questions with full answers.
- **Proof:** `ls study/architecture/derived-system-account-roles.md && grep -c "derived-system-account-roles" study/README.md` ≥ 1.
- **Owes:** —

### Step 8 — [Haiku] Docs for 46a

- **Model:** [Haiku] — transcription of facts fixed above
- **Depends on:** 6
- **Files:** `docs/schema.md`, `docs/api.md`, `docs/accounting.md` (all edit)
- **Contract:**
  - `docs/schema.md` § "Default chart of accounts":
    - Add rows 1150 Supplier Prepayments (Asset), 2130 Customer Deposits (Liability), 5050 Cost of Sales — Inventory (Expense), 5400 Inventory Adjustments & Shrinkage (Expense) and 6830 Rounding (Expense).
    - Change the count sentence to the real number: run `grep -c "{ code: '" server/src/services/accounting/accountService.ts`.
    - Change "seeded by `authService.register`" to "seeded by `seedDefaultChart` from `organizationService.ts` inside the org-creation transaction".
    - Add a migration-100 entry in the per-phase section, in the same style as the 099 entry.
  - `docs/api.md`, under the accounts routes:
    - A row for `GET /accounts/system` (`accounts.view`, `200 {success,count,systemAccounts}`).
    - Note `systemRoles` on every account response.
    - The two new 422 messages from Step 4.
  - `docs/accounting.md`: a new `### System accounts (Phase 46a)` subsection after the "System-account rule" paragraph (~L608). It holds the 16-role table (role, label, default code, remappable), the derived-not-stored rule, what is locked (retire, bank flag), and "Rounding: seeded, no automatic postings yet".
- **Proof:** `grep -c "6830" docs/schema.md docs/accounting.md` gives ≥1 for each, and `grep -c "accounts/system" docs/api.md` ≥ 1.
- **Owes:** —

### Step 9 — [Sonnet] Close 46a: full suites, guardrail review, commit

- **Model:** [Sonnet] — verification
- **Depends on:** 5, 6, 7, 8
- **Skill:** guardrail-review
- **Do:**
  - `cd server && npm run typecheck && npm run lint && npm test`
  - `cd client && npm run typecheck && npm run lint && npm test`
  - Run `guardrail-review` over `git diff`.
  - Commit with message `Phase 46a: system accounts (lock layer) and 6830 Rounding`, ending with the attribution line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Proof:** both suites are green (server totals = 2409 + new, 2 skipped), the guardrail review shows zero violations, and `git log -1 --format=%s` prints the message.
- **If it fails:** a pre-existing test now fails → stop and report. Do not edit unrelated tests.

---

# Slice 46b — Placeholder previews everywhere (client only)

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| Hints prop | `PlaceholderHints` gains `labels?: readonly string[]` (parallel to `text`) |
| Picker prop | `PlaceholderPicker` gains `preview?: PlaceholderContext` |
| Recurring helper | `client/src/Pages/accounting/recurringPreview.ts` → `templateTextsFor(schedule, source)` |
| Client test | `client/src/__tests__/placeholderUi.test.tsx` (extend) and `client/src/__tests__/recurringSchedules.test.tsx` (extend) |

### Step 10 — [Haiku] `PlaceholderHints` previews every field; `PlaceholderPicker` shows resolved values

- **Model:** [Haiku] — two small components, behaviour fully specified
- **Depends on:** 9
- **Read first:** both component files (quoted in Starting state); `client/src/__tests__/placeholderUi.test.tsx`
- **Files:** `client/src/components/placeholders/PlaceholderHints.tsx`, `PlaceholderPicker.tsx` (edit); `client/src/__tests__/placeholderUi.test.tsx` (edit)
- **Contract:**
  - `PlaceholderHints`:
    - Replace `first` with `const filled = texts.map((t, i) => ({ t, i })).filter(({ t }) => containsPlaceholders(t, surface));`.
    - Render one `<p data-testid="placeholder-preview">` per entry in `filled`.
      - Its prefix is `${labels?.[i] ?? 'Preview'}: ` when there is more than one entry in `filled`, and `Preview: ` when there is exactly one.
      - The value is `fillPlaceholders(t, surface, context, 'partial')`.
      - Cap the list at 5 previews, then append `<p>…and N more</p>`.
    - Hints and the null-return rule are unchanged.
  - `PlaceholderPicker`: when `preview` is given and `/^\d{4}-\d{2}-\d{2}$/.test(preview.date)`, each item's `shortcut` becomes `` `[${def.label}] → ${fillPlaceholders(`[${def.label}]`, surface, preview, 'partial')}` ``, and the same for each date preset. Without `preview` the output is unchanged.
- **Tests (add):**
  1. Two fields with placeholders and `labels=['Notes','Line 1']` render two previews, starting `Notes:` and `Line 1:`.
  2. With one field, the prefix is `Preview:` (the existing behaviour is kept).
  3. A picker with `preview={{date:'2026-10-16'}}` opened on surface `JOURNAL` shows `[Month] → October`.
- **Proof:** `cd client && npm run typecheck && npm test -- placeholderUi` passes, and all existing cases in that file still pass.
- **If it fails:** an existing assertion on a single "Preview:" line fails → your single-entry prefix rule is wrong. Fix the component, not the test.
- **Owes:** —

### Step 11 — [Haiku] Fill the preview gaps on six pages

- **Model:** [Haiku] — the same edit (pass a `preview` context) at named lines
- **Depends on:** 10
- **Files (all edit):** `Pages/banking/BankRulesPage.tsx`, `Pages/settings/InvoiceSettingsPage.tsx`, `Pages/settings/InvoiceTemplatePage.tsx`, `Pages/settings/StatementTemplatePage.tsx`, `Pages/accounting/NewRepeatingJournalPage.tsx`, `Pages/sales/notes/NoteFormPage.tsx`
- **Contract (one edit per page):**
  - **BankRulesPage L221:** `preview={{ date: new Date().toISOString().slice(0, 10), organisationName }}`, with `const organisationName = useOrganizationName();` from `../../context/OrgContext`. Also pass the same object as `preview` to the `PlaceholderPicker` at L209.
  - **InvoiceSettingsPage L461:** `preview={{ date: SAMPLE_INVOICE.issueDate, dueDate: SAMPLE_INVOICE.dueDate, contactName: SAMPLE_CUSTOMER_NAME, organisationName, invoiceNumber: SAMPLE_INVOICE.invoiceNumber }}`, importing from `../sales/sampleInvoice`, and pass it to the picker at L451.
  - **InvoiceTemplatePage L370:** the same context as InvoiceSettingsPage. Add `labels={['Title', 'Bank details', 'Footer']}`. Pass the context to the picker at L346.
  - **StatementTemplatePage L278:** `preview={{ date: previewStatement.statementDate, contactName: previewStatement.party.name, organisationName, statementDate: previewStatement.statementDate, periodFrom: previewStatement.from, periodTo: previewStatement.statementDate }}` (`previewStatement` is already defined at L130). Add `labels={['Title', 'Footer']}`. Pass the context to the picker at L265.
  - **NewRepeatingJournalPage L169:** add `occurrence: 1` to the existing preview object, and pass it to the picker at L149.
  - **NoteFormPage L436:** add `invoiceNumber: config.kind === 'CREDIT_NOTE' ? original?.label : undefined` to the existing preview object. Under `exactOptionalPropertyTypes`, build it with a conditional spread `...(config.kind === 'CREDIT_NOTE' && original ? { invoiceNumber: original.label } : {})`. Pass the object to the picker at L422.
  - For every page that already passes `preview` to `PlaceholderHints` but not to the picker (`NewInvoicePage`, `NewBillPage`, `ManualJournalFormPage`), pass the same object to the picker as well.
- **Tests (add to `placeholderUi.test.tsx`, rendering each page with the mocks its existing test file uses):**
  1. BankRulesPage: type `Fee [Month]` → a `placeholder-preview` element whose text starts `Preview: Fee ` followed by the current month name.
  2. InvoiceSettingsPage: footer `Thanks [Contact Name]` → `Preview: Thanks Harbor Point Fabrication`.
  3. NewRepeatingJournalPage: narration `Run [Occurrence]` → `Preview: Run 1`.
- **Proof:** `cd client && npm run typecheck && npm test -- placeholderUi invoiceSettingsPage invoiceTemplate bankRules manualJournals creditNotes` passes.
- **If it fails:** a mock is missing `useOrganizationName` → mock it the way `manualJournals.test.tsx` does. Do not remove the preview.
- **Owes:** —

### Step 12 — [Haiku] Bank-line journal memo gets a picker, hints and a preview

- **Model:** [Haiku] — copy the pattern from `BankRulesPage.tsx` L46/L209/L221 onto one input
- **Depends on:** 11
- **Read first:** `Pages/banking/BankRulesPage.tsx` (how `usePlaceholderTarget` binds an input); `Pages/banking/BankTransactionsPage.tsx` L340–395
- **Files:** `client/src/Pages/banking/BankTransactionsPage.tsx` (edit); `client/src/__tests__/bankTransactions.test.tsx` (edit)
- **Contract:**
  - Add `const placeholderTarget = usePlaceholderTarget('postJournalDescription');`.
  - Bind the memo `<input>` with `{...placeholderTarget.bind('postJournalDescription', setPostJournalDescription)}`, keeping its `value` and `onChange`.
  - Add `<PlaceholderPicker surface="BANK_LINE" onInsert={placeholderTarget.insert} preview={memoPreview} />` beside it.
  - Below the row, add `<PlaceholderHints text={postJournalDescription} surface="BANK_LINE" preview={memoPreview} />`.
  - `memoPreview` is `{ date: txn.txnDate, organisationName }`.
- **Tests:** open post-journal on a line dated `2026-06-01`, type `Fees [Month]` → `Preview: Fees June`.
- **Proof:** `cd client && npm test -- bankTransactions` passes.
- **If it fails:** a `bind` signature mismatch → read `utils/usePlaceholderTarget.ts` and match its `bind(key, set)` exactly.
- **Owes:** —

### Step 13 — [Haiku] "Next run will read" on a recurring schedule

- **Model:** [Haiku] — a pure helper plus one render block; sources are fetched with existing helpers
- **Depends on:** 10
- **Read first:** `Pages/accounting/RecurringScheduleDetailPage.tsx` (the `documentLink` and the `useEffect` load); `fetchServices.ts` `Invoice` (notesTemplate L1544, line `descriptionTemplate`), `Bill` (L2445–2456), the `ManualJournal` `narration`/`narrationTemplate` (L798), `JournalEntry.descriptionTemplate` (L540).
- **Files:** `client/src/Pages/accounting/recurringPreview.ts` (new); `RecurringScheduleDetailPage.tsx` (edit); `client/src/__tests__/recurringSchedules.test.tsx` (edit)
- **Contract — `recurringPreview.ts`:**
  ```ts
  import type { Bill, Invoice, JournalEntry, ManualJournal, RecurringSchedule } from '../../services/fetchServices';
  import type { PlaceholderContext, PlaceholderSurface } from '../../utils/placeholders';
  export type RecurringSource =
    | { kind: 'INVOICE'; invoice: Invoice }
    | { kind: 'BILL'; bill: Bill }
    | { kind: 'MANUAL_JOURNAL'; journal: ManualJournal }
    | { kind: 'JOURNAL'; entry: JournalEntry };
  export interface TemplatePreview { surface: PlaceholderSurface; labels: string[]; texts: string[]; context: PlaceholderContext | null }
  export function templateTextsFor(schedule: RecurringSchedule, source: RecurringSource, organisationName: string | null): TemplatePreview;
  ```
  - INVOICE:
    - labels `['Notes', 'Line 1', …]`
    - texts `[inv.notesTemplate ?? inv.notes ?? '', ...inv.lines.map(l => l.descriptionTemplate ?? l.description)]`
    - surface `INVOICE`
    - context `{date: schedule.nextRunDate, contactName: inv.customerNameSnapshot, organisationName, occurrence: schedule.nextOccurrenceIndex}`
  - BILL: labels `['Reference', 'Notes', 'Line 1', …]` from `vendorReferenceTemplate ?? vendorReference`, `notesTemplate ?? notes` and the lines; `contactName: bill.vendorNameSnapshot`; surface `BILL`.
  - MANUAL_JOURNAL: `['Narration']`, `[journal.narrationTemplate ?? journal.narration]`, surface `JOURNAL`.
  - JOURNAL: `['Narration']`, `[entry.descriptionTemplate ?? entry.description ?? '']`, surface `JOURNAL`.
  - `context` is `null` when `schedule.nextRunDate === null`.
  - Use the field names exactly as they exist on these types. If a name differs from this contract (e.g. `nextOccurrenceIndex` is 0-based), stop and report rather than guess.
  - `RecurringScheduleDetailPage`:
    - After the schedule loads, fetch its source with `getInvoice` / `getBill` / `getManualJournal(schedule.sourceManualJournalId)` / `getJournal(schedule.sourceId)`, picking by `kind` and `sourceManualJournalId` the same way `documentLink` does.
    - Below the details `<dl>`, render a section headed `Next run will read`, containing `<PlaceholderHints text={p.texts} labels={p.labels} surface={p.surface} preview={p.context} />`, only when `p.context !== null`.
    - A source-load failure hides the section; it never shows an error.
- **Tests:** an INVOICE schedule with `nextRunDate '2026-11-01'` whose source invoice notes are `Retainer [Month]` renders `Retainer November`.
- **Proof:** `cd client && npm run typecheck && npm test -- recurringSchedules` passes.
- **If it fails:** see the contract's stop rule on field names.
- **Owes:** —

### Step 14 — [Sonnet] Close 46b: suites, review, docs line, commit

- **Model:** [Sonnet] — verification
- **Depends on:** 12, 13
- **Skill:** guardrail-review
- **Files:** `docs/accounting.md` (edit the Phase 40 placeholders section: one paragraph "Phase 46b — every placeholder field previews each field, pickers show resolved values, bank-line memos and recurring schedules preview their text")
- **Do:** run the client suite (`typecheck`, `lint`, `test`), then the guardrail review (client-only, so check that no `server/` file changed). Commit `Phase 46b: placeholder previews everywhere` with the attribution line.
- **Proof:** the client suite is green, `git diff HEAD~1 --stat -- server` is empty, and the commit exists.
- **Owes:** no study note. Nothing new is introduced, only an extension of the Phase 40 pattern. State this in the commit body.

---

# Slice 46c — Document history & notes

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| Migration | `server/src/db/migrations/101_platform_document_history.sql` |
| Table | `document_history` (`id, org_id, entity_type, entity_id, kind, action, summary, details, actor_user_id, created_at`) |
| Trigger | `reject_document_history_mutation()` / `trg_document_history_immutable` |
| Types file | `server/src/types/history.ts` → `HISTORY_ENTITY_TYPES`, `HistoryEntityType`, `HISTORY_ACTIONS`, `HistoryAction`, `HistoryEntry`, `RecordHistoryInput` |
| Service | `server/src/services/historyService.ts` → `recordEventOnClient`, `recordEventsOnClient`, `listHistory`, `addNote`, `assertEntityExistsOnClient`, `formatMoney` |
| Controller | `server/src/controllers/historyController.ts` → `makeHistoryController(entityType)` → `{ list, addNote }` |
| Router factory | `server/src/routes/historyRoutes.ts` → `buildHistoryRouter(entityType, keys: { view: string; note: string })` |
| Schema | `server/src/schemas/historySchema.ts` → `addHistoryNoteSchema` |
| Server tests | `server/src/__tests__/platform/documentHistory.test.ts` |
| Client | `fetchServices.ts` → `HistoryEntry`, `listHistory(basePath, id)`, `addHistoryNote(basePath, id, text)`; `components/history/HistoryAndNotes.tsx` |
| Client test | `client/src/__tests__/historyAndNotes.test.tsx` |

**Routes (each mounted under its resource prefix):**

| Prefix | entityType | view key | note key |
|---|---|---|---|
| `/invoices` | `INVOICE` | `invoices.view` | `invoices.edit` |
| `/bills` | `BILL` | `bills.view` | `bills.edit` |
| `/credit-notes` | `CREDIT_NOTE` | `credit_notes.view` | `credit_notes.edit` |
| `/debit-notes` | `DEBIT_NOTE` | `debit_notes.view` | `debit_notes.edit` |
| `/quotes` | `QUOTE` | `quotes.view` | `quotes.edit` |
| `/purchase-quotes` | `PURCHASE_QUOTE` | `purchase_quotes.view` | `purchase_quotes.edit` |
| `/orders` | `SALES_ORDER` | `sales_orders.view` | `sales_orders.edit` |
| `/purchase-orders` | `PURCHASE_ORDER` | `purchase_orders.view` | `purchase_orders.edit` |
| `/payments` | `PAYMENT` | `payments.view` | `payments.create` |
| `/manual-journals` | `MANUAL_JOURNAL` | `journals.view` | `journals.create` |
| `/customers` | `CUSTOMER` | `customers.view` | `customers.manage` |
| `/vendors` | `VENDOR` | `vendors.view` | `vendors.manage` |
| `/bank-transactions` | `BANK_TRANSACTION` | `bank.view` | `bank.reconcile` |

`GET <prefix>/:id/history` → `200 { success: true, count, history: HistoryEntry[] }`, newest first. `POST <prefix>/:id/notes` with body `{ text }` → `201 { success: true, entry: HistoryEntry }`. An unknown or another tenant's id → `404` with the entity's not-found message (table in Step 17).

### Step 15 — [Sonnet] Migration 101 — `document_history`

- **Model:** [Sonnet] — migration with a polymorphic key, an append-only trigger and a backfill
- **Depends on:** 14
- **Skill:** new-migration
- **Read first:** `017_platform_audit_logs.sql` L150–159; `089_ledger-core_quotes.sql` header style.
- **Files:** `server/src/db/migrations/101_platform_document_history.sql` (new); `server/src/__tests__/helpers/factories.ts` (edit: add `document_history` to the TRUNCATE list, after `audit_logs`)
- **Contract, literally:**
  ```sql
  -- Phase 46c — Xero-style "History & notes": one human-readable timeline per
  -- document, payment, contact and bank line. Written by each service on its
  -- own transaction (never derived from audit_logs, which stays the raw CDC
  -- trail). entity_id is polymorphic — no FK, like audit_logs.row_id — so the
  -- service checks the entity exists in the org before writing a note.
  -- created_at uses clock_timestamp(): now() is fixed per transaction, so two
  -- events in one transaction (issue + auto-applied credit) would tie.
  CREATE TABLE IF NOT EXISTS document_history (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    entity_type   TEXT NOT NULL CHECK (entity_type IN (
                    'INVOICE','BILL','CREDIT_NOTE','DEBIT_NOTE','QUOTE','PURCHASE_QUOTE',
                    'SALES_ORDER','PURCHASE_ORDER','PAYMENT','MANUAL_JOURNAL',
                    'CUSTOMER','VENDOR','BANK_TRANSACTION')),
    entity_id     UUID NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('EVENT','NOTE')),
    action        TEXT NOT NULL CHECK (action ~ '^[A-Z_]{1,40}$'),
    summary       TEXT NOT NULL CHECK (length(btrim(summary)) > 0 AND char_length(summary) <= 1000),
    details       JSONB NULL,
    actor_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_document_history_note_action CHECK ((kind = 'NOTE') = (action = 'NOTE'))
  );
  CREATE INDEX IF NOT EXISTS idx_document_history_entity
    ON document_history (org_id, entity_type, entity_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_document_history_actor ON document_history (actor_user_id);

  CREATE OR REPLACE FUNCTION reject_document_history_mutation() RETURNS trigger AS $$
  BEGIN
    RAISE EXCEPTION 'document_history is append-only; % is not permitted', TG_OP
      USING ERRCODE = '0A000';
  END;
  $$ LANGUAGE plpgsql;

  CREATE OR REPLACE TRIGGER trg_document_history_immutable
    BEFORE UPDATE OR DELETE ON document_history
    FOR EACH ROW EXECUTE FUNCTION reject_document_history_mutation();
  ```
  - Then the backfill: one `INSERT … SELECT … WHERE NOT EXISTS` per source. It must be idempotent, because the replay test re-runs it.
  - The template for invoices:
    ```sql
    INSERT INTO document_history (org_id, entity_type, entity_id, kind, action, summary, actor_user_id, created_at)
    SELECT t.org_id, 'INVOICE', t.id, 'EVENT', 'CREATED', 'Created', t.created_by, t.created_at
      FROM invoices t
     WHERE NOT EXISTS (SELECT 1 FROM document_history h
                        WHERE h.org_id = t.org_id AND h.entity_type = 'INVOICE'
                          AND h.entity_id = t.id AND h.action = 'CREATED');
    ```
  - Repeat with the table and entity type swapped: `bills→BILL`, `credit_notes→CREDIT_NOTE`, `debit_notes→DEBIT_NOTE`, `payments→PAYMENT`, `manual_journals→MANUAL_JOURNAL`, `customers→CUSTOMER`, `vendors→VENDOR`.
  - For `quotes`, the entity type is `CASE t.direction WHEN 'SALES' THEN 'QUOTE' ELSE 'PURCHASE_QUOTE' END`, used in both the SELECT and the NOT EXISTS.
  - For `orders`, the entity type is `CASE t.direction WHEN 'SALES' THEN 'SALES_ORDER' ELSE 'PURCHASE_ORDER' END`.
  - For bank lines: `SELECT bt.org_id, 'BANK_TRANSACTION', bt.id, 'EVENT', 'IMPORTED', 'Imported from ' || i.file_name, i.created_by, bt.created_at FROM bank_transactions bt JOIN bank_statement_imports i ON i.id = bt.import_id AND i.org_id = bt.org_id`, with the same NOT EXISTS on action `IMPORTED`.
  - Do **not** attach `audit_row_change` to this table. It is itself a history.
- **Guardrails:** #13 idempotent (`IF NOT EXISTS`, `CREATE OR REPLACE`, `NOT EXISTS` backfill); #8 `org_id` and `actor_user_id` have FKs, and `entity_id` is the single documented exception; #1 `org_id NOT NULL`.
- **Proof:**
  ```bash
  cd server && npm run migrate && npm run migrate
  docker exec autodb_postgres psql -U autodb_user -d autodb -Atc "SELECT (SELECT count(*) FROM invoices) = (SELECT count(*) FROM document_history WHERE entity_type='INVOICE' AND action='CREATED')"
  docker exec autodb_postgres psql -U autodb_user -d autodb -Atc "UPDATE document_history SET summary='x' WHERE false" ; echo ok
  npm test -- migrations
  ```
  The second command prints `t`, and the migrations test passes.
- **If it fails:** a backfill column is missing on a table → stop and report. Do not guess another column.
- **Owes:** schema.md (Step 25), study note (Step 25).

### Step 16 — [Haiku] `types/history.ts`

- **Model:** [Haiku] — transcription
- **Depends on:** 15
- **Files:** `server/src/types/history.ts` (new)
- **Contract, literally:**
  ```ts
  export const HISTORY_ENTITY_TYPES = [
    'INVOICE', 'BILL', 'CREDIT_NOTE', 'DEBIT_NOTE', 'QUOTE', 'PURCHASE_QUOTE',
    'SALES_ORDER', 'PURCHASE_ORDER', 'PAYMENT', 'MANUAL_JOURNAL',
    'CUSTOMER', 'VENDOR', 'BANK_TRANSACTION',
  ] as const;
  export type HistoryEntityType = (typeof HISTORY_ENTITY_TYPES)[number];

  /** The closed set of actions. Must stay in step with the CHECK pattern in migration 101 (A–Z and _ only, ≤ 40). */
  export const HISTORY_ACTIONS = [
    'CREATED', 'UPDATED', 'SUBMITTED', 'APPROVED', 'ISSUED', 'POSTED', 'VOIDED',
    'SENT', 'REVISED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'SUPERSEDED', 'CONVERTED',
    'CONFIRMED', 'CLOSED', 'REOPENED', 'CANCELLED',
    'PAYMENT_RECEIVED', 'PAYMENT_MADE', 'PAYMENT_VOIDED', 'CREDIT_APPLIED',
    'IMPORTED', 'MATCHED', 'UNMATCHED', 'IGNORED', 'UNIGNORED', 'DELETED', 'RESTORED',
    'NOTE',
  ] as const;
  export type HistoryAction = (typeof HISTORY_ACTIONS)[number];

  export interface HistoryEntry {
    id: string;
    kind: 'EVENT' | 'NOTE';
    action: HistoryAction;
    summary: string;
    details: Record<string, unknown> | null;
    actorUserId: string | null;
    /** users.name, else users.email; null for a system action or a deleted user. */
    actorName: string | null;
    createdAt: string;
  }

  export interface RecordHistoryInput {
    entityType: HistoryEntityType;
    entityId: string;
    action: Exclude<HistoryAction, 'NOTE'>;
    summary: string;
    details?: Record<string, unknown>;
  }
  ```
- **Proof:** `cd server && npm run typecheck` exits 0.
- **Owes:** —

### Step 17 — [Sonnet] `historyService`

- **Model:** [Sonnet] — the tenant check behind a polymorphic key
- **Depends on:** 16
- **Skill:** new-module (service layer)
- **Read first:** `services/auditService.ts` (the users join for `actor_email`); `utils/requestContext.ts`.
- **Files:** `server/src/services/historyService.ts` (new)
- **Contract:**
  ```ts
  type Queryable = Pick<PoolClient, 'query'>;
  /** Writes one EVENT on the caller's transaction. Actor = getRequestContext()?.userId ?? null. */
  export async function recordEventOnClient(q: Queryable, orgId: string, input: RecordHistoryInput): Promise<void>;
  /** One INSERT … SELECT FROM unnest for several events (e.g. a payment's allocations). No-op on []. */
  export async function recordEventsOnClient(q: Queryable, orgId: string, inputs: readonly RecordHistoryInput[]): Promise<void>;
  /** 404 with the entity's message when the id is not in the org. */
  export async function assertEntityExistsOnClient(q: Queryable, orgId: string, entityType: HistoryEntityType, entityId: string): Promise<void>;
  export async function listHistory(orgId: string, entityType: HistoryEntityType, entityId: string): Promise<HistoryEntry[]>;
  export async function addNote(orgId: string, userId: string, entityType: HistoryEntityType, entityId: string, text: string): Promise<HistoryEntry>;
  /** `${currencyCode} ${formatCents(cents(amountCents))}`, e.g. "USD 1200.00". */
  export function formatMoney(amountCents: number, currencyCode: string): string;
  ```
  - `summary` is trimmed and truncated to 1000 characters before insert. The actor comes **only** from the request context; a background sweep therefore writes `null`.
  - `assertEntityExistsOnClient`: a `switch` over the entity type with one **literal** SQL string per case, and no identifier interpolation (rule 4):

    | entityType | SQL | 404 message |
    |---|---|---|
    | INVOICE | `SELECT 1 FROM invoices WHERE id = $1 AND org_id = $2` | `Invoice not found` |
    | BILL | `… FROM bills …` | `Bill not found` |
    | CREDIT_NOTE | `… FROM credit_notes …` | `Credit note not found` |
    | DEBIT_NOTE | `… FROM debit_notes …` | `Debit note not found` |
    | QUOTE | `SELECT 1 FROM quotes WHERE id = $1 AND org_id = $2 AND direction = 'SALES'` | `Quote not found` |
    | PURCHASE_QUOTE | `… quotes … direction = 'PURCHASE'` | `Quote not found` |
    | SALES_ORDER | `… orders … direction = 'SALES'` | `Order not found` |
    | PURCHASE_ORDER | `… orders … direction = 'PURCHASE'` | `Order not found` |
    | PAYMENT | `… FROM payments …` | `Payment not found` |
    | MANUAL_JOURNAL | `… FROM manual_journals …` | `Manual journal not found` |
    | CUSTOMER | `… FROM customers …` | `Customer not found` |
    | VENDOR | `… FROM vendors …` | `Vendor not found` |
    | BANK_TRANSACTION | `… FROM bank_transactions …` | `Bank transaction not found` |

    Use `const _exhaustive: never = entityType;` in `default`.
  - `listHistory`:
    - Call `assertEntityExistsOnClient(pool, …)` first.
    - Then `SELECT h.id, h.kind, h.action, h.summary, h.details, h.actor_user_id, COALESCE(u.name, u.email) AS actor_name, h.created_at FROM document_history h LEFT JOIN users u ON u.id = h.actor_user_id WHERE h.org_id = $1 AND h.entity_type = $2 AND h.entity_id = $3 ORDER BY h.created_at DESC, h.id DESC LIMIT 500`.
    - Re-validate `action` against `HISTORY_ACTIONS` (throw `Error` on an unknown value, as `toAccount` does).
  - `addNote`:
    - Run in `withTransaction`: `assertEntityExistsOnClient(client, …)`, then `INSERT … (kind 'NOTE', action 'NOTE', summary text, actor_user_id userId) RETURNING`, then return the mapped entry. `actorName` comes from a follow-up `SELECT COALESCE(name,email) FROM users WHERE id = $1` on the same client.
    - The schema has already validated `text`.
- **Guardrails:** #1 every statement has `org_id`; #4 literal SQL per case; #5 `*OnClient` functions use only `q`; #2 no `req`.
- **Proof:** `cd server && npm run typecheck && npm run lint` exits 0. Behaviour is tested in Step 24.
- **Owes:** —

### Step 18 — [Haiku] Schema, controller, router factory, mounting

- **Model:** [Haiku] — thin adapters over Step 17, the route table above, and an existing router-factory analogue
- **Depends on:** 17
- **Read first:** `routes/accounting/quoteRoutes.ts` (factory shape); `controllers/accounting/bankTransactionController.ts` (`requireUser`, `requireParam`, `parseBody`); `schemas/accounting/bankSchema.ts` (zod style).
- **Files:** `server/src/schemas/historySchema.ts`, `server/src/controllers/historyController.ts`, `server/src/routes/historyRoutes.ts` (new); `server/src/routes/accounting/index.ts` (edit)
- **Contract:**
  - `historySchema.ts`: `export const addHistoryNoteSchema = z.object({ text: z.string().trim().min(1, 'Write a note first').max(1000, 'A note can be at most 1000 characters') }).strict();`
  - The controller:
    ```ts
    export function makeHistoryController(entityType: HistoryEntityType) {
      return {
        list: (async (req, res) => {
          const user = requireUser(req);
          const history = await historyService.listHistory(user.orgId, entityType, requireParam(req, 'id'));
          res.json({ success: true, count: history.length, history });
        }) satisfies RequestHandler,
        addNote: (async (req, res) => {
          const user = requireUser(req);
          const { text } = parseBody(addHistoryNoteSchema, req.body);
          const entry = await historyService.addNote(user.orgId, user.id, entityType, requireParam(req, 'id'), text);
          res.status(201).json({ success: true, entry });
        }) satisfies RequestHandler,
      };
    }
    ```
  - The router:
    ```ts
    export function buildHistoryRouter(entityType: HistoryEntityType, keys: { view: string; note: string }): Router {
      const router = Router();
      const c = makeHistoryController(entityType);
      router.get('/:id/history', authenticate, requirePermission(keys.view), c.list);
      router.post('/:id/notes', authenticate, requirePermission(keys.note), c.addNote);
      return router;
    }
    ```
  - In `routes/accounting/index.ts`, add one `router.use(prefix, buildHistoryRouter(type, {view, note}))` per row of the route table, each placed **immediately before** the existing `router.use(prefix, …)` for that prefix.
- **Proof:** `cd server && npm run typecheck && npm test -- routePermissions` passes. The test fails on an ungated route, and these are all gated.
- **If it fails:** `requirePermission` rejects a key as unknown → the key in the table is misspelled against `config/permissions.ts`. Fix the spelling and nothing else.
- **Owes:** api.md (Step 25).

### Step 19 — [Sonnet] History events: invoices and credit notes

- **Model:** [Sonnet] — writes inside existing document transactions, including `*OnClient` cores shared with recurring and imports
- **Depends on:** 18
- **Read first:** each function named below, in full, before editing it.
- **Files:** `services/accounting/invoiceService.ts`, `services/accounting/creditNoteService.ts` (edit)
- **Contract:**
  - Every call is `historyService.recordEventOnClient(<the function's own transaction client>, orgId, {…})`, placed after the status-changing statement and before the transaction ends. Money uses `historyService.formatMoney(totalCents, currencyCode)`.
  - Where a function has **no** transaction client (a single `pool.query` write), wrap its existing write and the event in `withTransaction` from `db/transaction.js`. Report each such function in the step summary.

  | Function | entityType | action | summary (literal; `{}` = value) |
  |---|---|---|---|
  | `createInvoiceOnClient` | INVOICE | CREATED | `Draft created` |
  | `updateInvoice` | INVOICE | UPDATED | `Draft edited` |
  | `issueInvoiceOnClient` | INVOICE | ISSUED | `Issued as {invoiceNumber} for {money(total)}` |
  | `voidInvoice` | INVOICE | VOIDED | `Voided` (append `: {reason}` if the function receives a reason) |
  | `createCreditNote` | CREDIT_NOTE | CREATED | `Draft created` |
  | `updateCreditNote` | CREDIT_NOTE | UPDATED | `Draft edited` |
  | `issueCreditNote` | CREDIT_NOTE | ISSUED | `Issued as {creditNoteNumber} for {money(total)}` |
  | `voidCreditNote` | CREDIT_NOTE | VOIDED | `Voided` |
  | `applyCreditNoteOnClient` (and the issue-time auto-apply, wherever its allocation INSERT lives) | CREDIT_NOTE **and** INVOICE (two events, via `recordEventsOnClient`) | CREDIT_APPLIED | note: `Applied {money(amount)} to invoice {invoiceNumber}` · invoice: `Credit note {creditNoteNumber} applied: {money(amount)}` |

  The rule for the table's last row: one pair of events **per allocation row inserted**, wherever `credit_note_allocations` is inserted in `creditNoteService.ts`.
- **Guardrails:** #5 the event uses the same client as the document write, never `pool`; #6 nothing here updates a posted row; #1.
- **Proof:** `cd server && npm run typecheck && npm test -- invoices creditNotes recurring invoiceImport` passes. Existing behaviour is unchanged; the new assertions land in Step 23.
- **If it fails:** an existing test now sees a 0A000 or a FK error → the event was written on `pool` or before the entity row exists. Move it, and never drop it.
- **Owes:** —

### Step 20 — [Sonnet] History events: bills and debit notes

- **Model:** [Sonnet] — same reasons as Step 19
- **Depends on:** 19
- **Files:** `services/accounting/billService.ts`, `services/accounting/debitNoteService.ts` (edit)
- **Contract (same placement rules as Step 19):**

  | Function | entityType | action | summary |
  |---|---|---|---|
  | `createBillOnClient` | BILL | CREATED | `Draft created` |
  | `createCapturedBillOnClient` | BILL | CREATED | `Created from the bill inbox` |
  | `updateBill` | BILL | UPDATED | `Draft edited` |
  | `submitBill` | BILL | SUBMITTED | `Submitted for approval` |
  | `approveBillOnClient` | BILL | APPROVED | `Approved for {money(total)}` |
  | `voidBill` | BILL | VOIDED | `Voided` |
  | `createDebitNote` / `updateDebitNote` / `issueDebitNote` / `voidDebitNote` | DEBIT_NOTE | CREATED / UPDATED / ISSUED / VOIDED | `Draft created` / `Draft edited` / `Issued as {debitNoteNumber} for {money(total)}` / `Voided` |
  | every `debit_note_allocations` INSERT | DEBIT_NOTE **and** BILL | CREDIT_APPLIED | note: `Applied {money(amount)} to bill {vendorReference}` · bill: `Debit note {debitNoteNumber} applied: {money(amount)}` |
- **Proof:** `cd server && npm run typecheck && npm test -- bills debitNotes capturedBills billImport applyCreditsOnApproval` passes.
- **If it fails:** as Step 19.
- **Owes:** —

### Step 21 — [Sonnet] History events: payments

- **Model:** [Sonnet] — one payment fans out to several documents' timelines
- **Depends on:** 20
- **Read first:** `paymentService.createPaymentOnClient` (L512) and `voidPaymentOnClient` (L829) in full.
- **Files:** `services/accounting/paymentService.ts` (edit)
- **Contract:**
  - `createPaymentOnClient` makes one `recordEventsOnClient` call with:
    - PAYMENT `CREATED`, summary `{RECEIVE ? 'Payment received' : 'Payment made'}: {money(amount)} on {paymentDate}`
    - per allocation to an invoice, INVOICE `PAYMENT_RECEIVED`, summary `Payment of {money(allocated)} received on {paymentDate}`
    - per allocation to a bill, BILL `PAYMENT_MADE`, summary `Payment of {money(allocated)} made on {paymentDate}`
  - `voidPaymentOnClient` loads the payment's allocations (it already does or must, on the same client), then writes PAYMENT `VOIDED` with summary `Voided`, plus INVOICE/BILL `PAYMENT_VOIDED` with summary `Payment of {money(allocated)} on {paymentDate} voided` per allocation.
- **Guardrails:** #5; #3 amounts are integer cents formatted only at the string boundary.
- **Proof:** `cd server && npm run typecheck && npm test -- payments bankMatching bankLineJournal onlinePayments` passes. Read `__tests__/accounting/` for the exact test file names before running, and include every file whose name contains `payment`.
- **Owes:** —

### Step 22 — [Sonnet] History events: quotes, orders, manual journals, customers, vendors

- **Model:** [Sonnet] — the central quote/order helpers serve public responses and sweeps (no actor)
- **Depends on:** 21
- **Files:** `services/accounting/quoteStatusService.ts`, `quoteService.ts`, `orderService.ts`, `manualJournalService.ts`, `customerService.ts`, `vendorService.ts` (edit)
- **Contract:**
  - `transitionQuoteOnClient`:
    - Change its first SELECT to `SELECT status, direction FROM quotes WHERE id = $1 AND org_id = $2 FOR UPDATE`.
    - After the `switch`, record entityType `direction === 'SALES' ? 'QUOTE' : 'PURCHASE_QUOTE'`.
    - The action comes from `{ ACCEPTED:'ACCEPTED', DECLINED:'DECLINED', EXPIRED:'EXPIRED', VOID:'VOIDED', SUPERSEDED:'SUPERSEDED', CONVERTED:'CONVERTED' }[to]`.
    - The summary is `` `Marked ${to.toLowerCase()}` ``, except `Conversion undone` when `current === 'CONVERTED'`, and `` `Voided: ${extras.reason}` `` for VOID with a reason.
  - `quoteService`:
    - `createQuote` → CREATED `Draft created`
    - `updateQuote` → UPDATED `Draft edited`
    - `sendQuote` → SENT `Sent to {recipient email}`
    - `reviseQuote` → REVISED `Revised (revision {n})`, on the **new** revision's id
  - `transitionOrderOnClient`: after the switch, record entityType `direction === 'SALES' ? 'SALES_ORDER' : 'PURCHASE_ORDER'`. The action is `CONFIRMED` / `CLOSED` / `CANCELLED`, and `REOPENED` when `from === 'CLOSED' && to === 'CONFIRMED'`. The summary is `Confirmed`, `Closed`, `Reopened`, or `Cancelled: {reason}`.
  - `orderService`:
    - `createOrder` → CREATED `Draft created`
    - `updateOrder` → UPDATED `Draft edited`
    - `convertOrder` → CONVERTED `Converted to a draft {invoice|bill}`
  - `manualJournalService`:
    - `createManualJournal` → CREATED `Draft created`
    - `updateManualJournal` → UPDATED `Draft edited`
    - `postManualJournal` and `postNewManualJournalOnClient` → POSTED `Posted`
    - `voidManualJournal` → VOIDED `Voided`
  - `customerService` / `vendorService`:
    - `create*` → CREATED `Contact created`
    - `update*` → UPDATED `Details edited`
    - `findOrCreateVendorByNameOnClient` → CREATED `Contact created from the bill inbox`, only on the create branch
- **Proof:** `cd server && npm run typecheck && npm test -- quotes orders manualJournals customers vendors recurring` passes. Read `__tests__/accounting/` for the exact quote/order/journal test file names and include each.
- **Owes:** —

### Step 23 — [Sonnet] Integration tests for history & notes

- **Model:** [Sonnet] — real-Postgres tests: isolation, trigger, rollback
- **Depends on:** 22
- **Skill:** isolation-test
- **Read first:** `__tests__/helpers/accountingFixtures.ts`; `__tests__/accounting/bankLineJournal.test.ts` L28–75.
- **Files:** `server/src/__tests__/platform/documentHistory.test.ts` (new)
- **Contract — named cases and expected values:**
  1. `invoice timeline`: create a draft, edit it, issue it, receive a payment (`receivePayment`), then void the payment. `GET /invoices/:id/history` returns `200`, with the actions newest first: `PAYMENT_VOIDED, PAYMENT_RECEIVED, ISSUED, UPDATED, CREATED`. Every event has `actorName` equal to the user's name.
  2. `credit note application appears on both timelines`: `issueCreditNote` against an issued invoice. The invoice history contains `CREDIT_APPLIED` and the credit-note history contains `CREDIT_APPLIED`.
  3. `bill approval`: `postBill` gives `APPROVED` with summary `Approved for USD …` (match the currency the fixture uses).
  4. `notes`:
     - `POST /invoices/:id/notes {text:'Called the customer'}` → `201`, with `entry.kind === 'NOTE'`.
     - `{text:'   '}` → `400`.
     - 1001 characters → `400`.
     - A VIEWER (via `addMember(orgId, viewerId, 'VIEWER')`) → `403`.
  5. `cross-tenant`: org A `GET /invoices/<org B invoice>/history` → `404 'Invoice not found'`, and `POST …/notes` → `404`. The `count(*)` of `document_history` rows for org B's invoice is unchanged.
  6. `append-only`: `UPDATE document_history SET summary = 'x'` through `pool` rejects with code `0A000`, and `DELETE` rejects with `0A000`.
  7. `rollback`: issuing an invoice whose revenue account is a header (forced `422`) leaves **no** `ISSUED` row for that invoice.
  8. `quote public acceptance has no actor`: send a quote, accept it through the public flow the existing quote tests use. The history has `ACCEPTED` with `actorUserId === null`.
  9. `recurring run`: run a recurring invoice schedule via the service. The generated invoice has `CREATED` with `actorUserId === null`.
- **Proof:** `cd server && npm test -- documentHistory` shows 9 passing tests.
- **If it fails:** a missing event is a Step 19–22 defect. Fix it there and never relax the expected action list.
- **Owes:** —

### Step 24 — [Haiku] Client: `HistoryAndNotes` and its mounts

- **Model:** [Haiku] — one component plus mechanical mounts with fixed props
- **Depends on:** 23
- **Read first:** `components/AttachmentsPanel.tsx` (load/error/busy pattern, `LoadingState`); `context/AuthContext.tsx` `useCan`.
- **Files:**
  - `client/src/services/fetchServices.ts` (edit)
  - `client/src/components/history/HistoryAndNotes.tsx` (new)
  - The seven detail pages listed in Starting state (edit)
  - `client/src/__tests__/historyAndNotes.test.tsx` (new)
- **Contract:**
  - `fetchServices.ts`:
    ```ts
    export interface HistoryEntry { id: string; kind: 'EVENT' | 'NOTE'; action: string; summary: string; details: Record<string, unknown> | null; actorUserId: string | null; actorName: string | null; createdAt: string }
    export function listHistory(basePath: string, id: string, signal?: AbortSignal): Promise<{ success: boolean; count: number; history: HistoryEntry[] }> { return apiFetch(`${basePath}/${id}/history`, { signal: signal ?? null }); }
    export function addHistoryNote(basePath: string, id: string, text: string): Promise<{ success: boolean; entry: HistoryEntry }> { return apiFetch(`${basePath}/${id}/notes`, { method: 'POST', body: JSON.stringify({ text }) }); }
    ```
  - `HistoryAndNotes({ basePath, entityId, notePermission, reloadKey }: { basePath: string; entityId: string; notePermission: string; reloadKey?: unknown })`:
    - A `<section aria-label="History and notes">` with a heading `History & notes` and a collapse toggle (collapsed by default, like Xero), showing the count in the heading.
    - Each entry is one row: `actorName ?? 'System'` · local date-time · summary. NOTE rows have a note icon (`StickyNote` from `lucide-react`).
    - When `useCan()(notePermission)`: a textarea (`maxLength={1000}`) and an `Add note` button. On success, prepend the returned entry and clear the textarea.
    - Re-fetch when `reloadKey` changes.
  - Mounts. Put each directly after the page's `AttachmentsPanel`, or at the end of the page's main column where there is none. Pass the page's existing reload counter as `reloadKey` if it has one.

    | Page | `basePath` | `notePermission` |
    |---|---|---|
    | `InvoiceDetailPage` | `/invoices` | `invoices.edit` |
    | `BillDetailPage` | `/bills` | `bills.edit` |
    | `notes/NoteDetailPage` | `config.kind === 'CREDIT_NOTE' ? '/credit-notes' : '/debit-notes'` | `credit_notes.edit` / `debit_notes.edit` |
    | `quotes/QuoteDetailPage` | `` `/${config.path}` `` | `config.permissions.edit` |
    | `orders/OrderDetailPage` | `config.path === 'sales-orders' ? '/orders' : '/purchase-orders'` | `config.permissions.edit` |
    | `ManualJournalDetailPage` | `/manual-journals` | `journals.create` |
    | `PartyAccountPage` | `kind === 'CUSTOMER' ? '/customers' : '/vendors'` | `customers.manage` / `vendors.manage` |
- **Tests (`historyAndNotes.test.tsx`):**
  1. It renders two entries from a mocked `listHistory` after expanding.
  2. A null actor renders `System`.
  3. Typing a note and clicking `Add note` calls `addHistoryNote('/invoices', 'inv-1', 'Hello')` and prepends the entry.
  4. Without the permission there is no textarea.
- **Proof:** `cd client && npm run typecheck && npm test -- historyAndNotes invoices bills quotes orders manualJournals partyAccount creditNotes debitNotes` passes. Page tests that do not mock `listHistory` must still pass: the panel is collapsed and fetches only on expand. **Fetch on expand**, so existing page tests need no new mocks.
- **If it fails:** a page test breaks because of an unmocked fetch → the panel is fetching before expand. Fix the component.
- **Owes:** —

### Step 25 — [Sonnet] Close 46c: study note, docs, suites, review, commit

- **Model:** [Sonnet] — accuracy and verification
- **Depends on:** 24
- **Skill:** study-note, guardrail-review
- **Files:**
  - `study/postgresql/polymorphic-references-and-history-tables.md` (new): no-FK vs per-type tables vs exclusive-arc FKs; why `clock_timestamp()` and not `now()`; append-only by trigger and TRUNCATE's exemption; writing history in the business transaction vs deriving it from CDC; 5–7 Q&As.
  - `study/README.md`
  - `docs/schema.md` (the `document_history` block plus migration 101)
  - `docs/api.md` (the history route table and notes body/limits)
  - `docs/accounting.md` (a `### History & notes (Phase 46c)` subsection: entity types, action list, actor rule, the "fetch on expand" UI)
- **Do:** run both suites in full, then the guardrail review over `git diff`. Commit `Phase 46c: document history & notes` with the attribution line.
- **Proof:** both suites are green, the guardrail review shows zero violations (rule 8's `entity_id` exception is documented in the migration header and in schema.md), and the commit exists.

---

# Slice 46d — User activity

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| Migration | `server/src/db/migrations/102_platform_login_events.sql` |
| Table | `login_events` (`id, user_id, org_id, email, outcome, ip, user_agent, created_at`) |
| Types | `server/src/types/auth.ts` (append) → `LOGIN_OUTCOMES`, `LoginOutcome`, `LoginEvent`, `MemberActivity` |
| Service | `server/src/services/loginEventService.ts` → `recordLoginEventOnClient`, `recordLoginEvent`, `listMyLoginEvents`, `listMemberActivity` |
| Routes | `GET /api/v1/auth/login-events` (`authenticate` only, exactly like `GET /auth/sessions` at `routes/auth.ts:50`) · `GET /api/v1/organizations/members/activity` (`audit.view`) |
| Server test | `server/src/__tests__/platform/loginEvents.test.ts` |
| Client | `fetchServices.ts` → `LoginEvent`, `MemberActivity`, `listMyLoginEvents()`, `listMemberActivity()`; `Pages/settings/UserActivityPage.tsx` (route `/settings/user-activity`) |
| Client test | `client/src/__tests__/userActivity.test.tsx` |

### Step 26 — [Sonnet] Migration 102 — `login_events`

- **Model:** [Sonnet] — migration
- **Depends on:** 25
- **Skill:** new-migration
- **Files:** `server/src/db/migrations/102_platform_login_events.sql` (new); `__tests__/helpers/factories.ts` (add `login_events` to TRUNCATE)
- **Contract, literally:**
  ```sql
  -- Phase 46d — sign-in history. Not in audit_logs: users and refresh_tokens
  -- are deliberately unaudited (017/018), and a FAILED sign-in must survive
  -- the login transaction's ROLLBACK, so it is written outside it.
  -- user_id is NULL for an unknown email; email is stored lowercased (rule 9).
  CREATE TABLE IF NOT EXISTS login_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id      UUID NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email       TEXT NOT NULL CHECK (email = lower(email) AND char_length(email) <= 320),
    outcome     TEXT NOT NULL CHECK (outcome IN
                  ('SUCCESS','FAILED','LOGOUT','PASSWORD_CHANGED','PASSWORD_RESET','SESSION_REVOKED')),
    ip          TEXT NULL CHECK (ip IS NULL OR char_length(ip) <= 45),
    user_agent  TEXT NULL CHECK (user_agent IS NULL OR char_length(user_agent) <= 500),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
  );
  CREATE INDEX IF NOT EXISTS idx_login_events_user ON login_events (user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_login_events_org ON login_events (org_id, created_at DESC);

  CREATE OR REPLACE FUNCTION reject_login_event_mutation() RETURNS trigger AS $$
  BEGIN
    RAISE EXCEPTION 'login_events is append-only; % is not permitted', TG_OP
      USING ERRCODE = '0A000';
  END;
  $$ LANGUAGE plpgsql;

  -- UPDATE only: DELETE must stay possible so ON DELETE CASCADE from users /
  -- organizations works (a BEFORE DELETE trigger would block the cascade).
  CREATE OR REPLACE TRIGGER trg_login_events_immutable
    BEFORE UPDATE ON login_events
    FOR EACH ROW EXECUTE FUNCTION reject_login_event_mutation();
  ```
- **Guardrails:** #9 lowercase CHECK; #8 FKs with explicit `ON DELETE`; #11 never store a token or password.
- **Proof:** `cd server && npm run migrate && npm run migrate && npm test -- migrations` passes.
- **Owes:** schema.md (Step 30).

### Step 27 — [Sonnet] `loginEventService` and the `authService` hooks

- **Model:** [Sonnet] — auth paths; one write must deliberately escape a ROLLBACK
- **Depends on:** 26
- **Read first:** `authService.ts` `login` (L392–440), `logout` (L670), `changePassword` (L713), `revokeSession` (L790), `revokeOtherSessions` (L813), `resetPassword` (L1108); `issueSession` (L252) for how `ctx.ip`/`ctx.userAgent` are read.
- **Files:** `server/src/services/loginEventService.ts` (new); types (per the registry); `server/src/services/authService.ts` (edit)
- **Contract:**
  ```ts
  export const LOGIN_OUTCOMES = ['SUCCESS','FAILED','LOGOUT','PASSWORD_CHANGED','PASSWORD_RESET','SESSION_REVOKED'] as const;
  export type LoginOutcome = (typeof LOGIN_OUTCOMES)[number];
  export interface LoginEvent { id: string; outcome: LoginOutcome; ip: string | null; userAgent: string | null; createdAt: string }
  export interface MemberActivity { userId: string; name: string | null; email: string; role: string; lastSignInAt: string | null; failedSignInsLast30Days: number; changesLast30Days: number }

  export async function recordLoginEventOnClient(q: Queryable, e: { userId: string | null; orgId: string | null; email: string; outcome: LoginOutcome }): Promise<void>;
  /** Uses pool — for FAILED (after ROLLBACK) and for pool-only callers. Never throws: a logging failure is logged with the request logger and swallowed, so it can never turn a 401 into a 500. */
  export async function recordLoginEvent(e: { userId: string | null; orgId: string | null; email: string; outcome: LoginOutcome }): Promise<void>;
  export async function listMyLoginEvents(userId: string, limit = 20): Promise<LoginEvent[]>;
  export async function listMemberActivity(orgId: string): Promise<MemberActivity[]>;
  ```
  - `ip` and `user_agent` come from `getRequestContext()`, truncated to 45 and 500 characters. `email` is `.toLowerCase()`.
  - Hooks in `authService`:
    - `login`:
      - On success, `recordLoginEventOnClient(client, {userId: row.id, orgId, email, outcome:'SUCCESS'})` before `COMMIT`.
      - In the `catch`, after `ROLLBACK`, when `err instanceof ApiError && err.status === 401`, `await recordLoginEvent({userId: <row?.id if found, else null>, orgId: null, email, outcome:'FAILED'})`.
      - Hoist `let failedUserId: string | null = null;` above `try`, and set it from `row?.id ?? null` before the throw.
      - Then rethrow.
    - `logout`: change the DELETE to `DELETE FROM refresh_tokens WHERE token_hash = $1 RETURNING user_id, org_id`. When a row returns, call `recordLoginEvent` with outcome `LOGOUT`, email from `SELECT email FROM users WHERE id = $1`.
    - `changePassword`: `PASSWORD_CHANGED` on the transaction client before `COMMIT` (orgId `null`).
    - `resetPassword`: `PASSWORD_RESET` on the client in the `outcome = 'reset'` branch.
    - `revokeSession` and `revokeOtherSessions`: `SESSION_REVOKED` via `recordLoginEvent` after the UPDATE. `revokeOtherSessions` records it only when `rowCount > 0`.
  - `listMyLoginEvents`: `SELECT id, outcome, ip, user_agent, created_at FROM login_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`. This is self-scoped by the token's user id, so it has no org predicate. That is legitimate, because a user's own sign-ins are not tenant data. Say so in a comment.
  - `listMemberActivity`, literally:
    ```sql
    SELECT m.user_id, u.name, u.email, m.role,
           (SELECT max(le.created_at) FROM login_events le
             WHERE le.user_id = m.user_id AND le.org_id = $1 AND le.outcome = 'SUCCESS') AS last_sign_in_at,
           (SELECT count(*) FROM login_events le
             WHERE le.user_id = m.user_id AND le.outcome = 'FAILED'
               AND le.created_at > now() - interval '30 days') AS failed_last_30,
           (SELECT count(*) FROM audit_logs al
             WHERE al.org_id = $1 AND al.actor_user_id = m.user_id
               AND al.created_at > now() - interval '30 days') AS changes_last_30
      FROM organization_members m
      JOIN users u ON u.id = m.user_id
     WHERE m.org_id = $1
     ORDER BY lower(u.email)
    ```
    `role` is whatever `organization_members` stores. If the column is named differently, or custom roles live elsewhere (migration 083), use the same expression `listMembers` in `organizationService.ts` uses, and report it.
- **Tests (`loginEvents.test.ts`):**
  1. A successful login writes one `SUCCESS` with `org_id = user.orgId`.
  2. A wrong password → `401`, and one `FAILED` row for that user with `org_id` null. This proves the write survives the rollback.
  3. An unknown email → `401`, and one `FAILED` row with `user_id` null and the email lowercased (`login` with `MiXeD@Example.com`).
  4. Logout writes `LOGOUT`.
  5. `GET /auth/login-events` returns only the caller's events.
  6. `GET /organizations/members/activity` as OWNER → `200`, listing both members with `lastSignInAt` set for the one who logged in. As VIEWER → `403`.
  7. Cross-tenant: user X (a member of orgs A and B, logged into A) has their B sign-in excluded from A's `lastSignInAt`. Use `addMember` and `POST /auth/switch` the way `multiOrg` tests do.
  8. `UPDATE login_events SET outcome='SUCCESS'` → `0A000`.
- **Guardrails:** #1 (the org-scoped query); #5 (the `SUCCESS` write uses the transaction client); #11 (no token or password in any row or log); #9.
- **Proof:** `cd server && npm run typecheck && npm test -- loginEvents auth passwordReset tenantIsolation` passes.
- **If it fails:** an auth test asserts an exact row count in a table → stop and report. Do not change auth behaviour.
- **Owes:** study note (Step 30).

### Step 28 — [Haiku] Controllers and routes for activity

- **Model:** [Haiku] — adapters over Step 27
- **Depends on:** 27
- **Read first:** `routes/auth.ts` L50–52 (`/sessions`), `controllers/authController.ts` `listSessions`; `routes/organizations.ts` L20–25.
- **Files:** `controllers/authController.ts`, `routes/auth.ts`, `controllers/organizationController.ts`, `routes/organizations.ts` (edit)
- **Contract:**
  - `authController.listLoginEvents`: `res.json({ success: true, count, events })` from `listMyLoginEvents(user.id)`. The route is `router.get('/login-events', authenticate, authController.listLoginEvents);`, placed after the `/sessions` routes.
  - `organizationController.memberActivity`: `res.json({ success: true, count, members })` from `listMemberActivity(user.orgId)`. The route goes **before** `'/members/:userId'`: `router.get('/members/activity', authenticate, requirePermission('audit.view'), organizationController.memberActivity);`.
- **Proof:** `cd server && npm test -- loginEvents routePermissions` passes.
- **Owes:** api.md (Step 30).

### Step 29 — [Haiku] Client: recent sign-ins, User activity page, audit filters

- **Model:** [Haiku] — rendering with fixed shapes
- **Depends on:** 28
- **Read first:** `Pages/account/SessionsPanel.tsx`; `Pages/settings/AuditLogPage.tsx` (its filter bar and the `listAuditLogs` params); `Pages/settings/MembersSettingsPage.tsx` (table style).
- **Files:**
  - `fetchServices.ts`
  - `Pages/account/SessionsPanel.tsx`
  - `Pages/settings/UserActivityPage.tsx` (new)
  - `Pages/settings/AuditLogPage.tsx`
  - `Pages/settings/SettingsHubPage.tsx`
  - `routes/ProductRoutes.tsx`
  - `utils/pageTitle.ts`
  - `__tests__/userActivity.test.tsx` (new)
  - (all edit unless marked new)
- **Contract:**
  - `fetchServices.ts`:
    - `LoginEvent` and `MemberActivity`, mirroring Step 27.
    - `listMyLoginEvents()` → `apiFetch('/auth/login-events')`.
    - `listMemberActivity()` → `apiFetch('/organizations/members/activity')`.
    - Extend the `listAuditLogs` params type with `actorUserId?: string` and `rowId?: string`, if it does not already accept them.
  - `SessionsPanel`: a `Recent sign-ins` list below the sessions. Each event shows its outcome, labelled `Signed in` / `Failed sign-in` / `Signed out` / `Password changed` / `Password reset` / `Session revoked`, with the date-time, IP and user agent.
  - `UserActivityPage` (`/settings/user-activity`):
    - A table with columns Member · Role · Last sign-in · Failed sign-ins (30 days) · Changes (30 days).
    - Each row links to `/settings/audit?actor=<userId>`.
  - `AuditLogPage`:
    - Read `actor` and `rowId` from `useSearchParams`, and pass them as `actorUserId` / `rowId`.
    - A member `<select>` (from `listMembers()`) sets `actor`.
    - A visible `Clear` resets both.
  - `SettingsHubPage`: add `{ to: '/settings/user-activity', label: 'User activity' }` to the group at L97, next to `Audit trail`.
  - `ProductRoutes.tsx`: `<Route path="/settings/user-activity" element={<UserActivityPage />} />` after `/settings/audit`.
  - `pageTitle.ts`: `'/settings/user-activity': 'User activity'`.
- **Tests:**
  1. `UserActivityPage` renders two members from a mock, with links to `/settings/audit?actor=u1`.
  2. `AuditLogPage` at `?actor=u1` calls `listAuditLogs` with `actorUserId: 'u1'`.
  3. `SessionsPanel` renders `Failed sign-in`.
- **Proof:** `cd client && npm run typecheck && npm test -- userActivity auditLog AccountPage settingsPage pageTitle` passes.
- **Owes:** —

### Step 30 — [Sonnet] Close 46d: study note, docs, suites, review, commit

- **Model:** [Sonnet]
- **Depends on:** 29
- **Skill:** study-note, guardrail-review
- **Files:**
  - `study/security-auth/recording-failed-logins.md` (new). It covers:
    - Why the failure write must sit outside the rolled-back transaction, and the swallow-don't-throw rule.
    - Timing-equal paths (the existing dummy bcrypt compare).
    - Why the append-only trigger is UPDATE-only here: a BEFORE DELETE trigger blocks `ON DELETE CASCADE`.
    - Enumeration risk in what a user may see.
    - 5–6 Q&As.
  - `study/README.md`, `docs/schema.md`, `docs/api.md`, and `docs/architecture.md` (§ auth/sessions: one paragraph on sign-in history).
- **Do:** run both full suites and the guardrail review, then commit `Phase 46d: user activity and sign-in history` with the attribution line.
- **Proof:** green, zero violations, commit exists.

---

# Slice 46e — Bank statement lines: delete, restore, reconciliation history

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| Migration | `server/src/db/migrations/103_ledger-core_bank_transaction_delete.sql` |
| New columns | `bank_transactions.deleted_at TIMESTAMPTZ`, `deleted_by UUID`, `delete_reason TEXT` |
| Status | `DELETED` added to `BANK_TRANSACTION_STATUSES` |
| Service functions (`bankMatchService.ts`) | `deleteTransactions(orgId, userId, ids, reason)`, `restoreTransaction(orgId, id)`, `listBankHistory(orgId, options)`; (`bankImportService.ts`) `deleteImport(orgId, userId, importId, reason)` |
| Result field | `ImportStatementResult.previouslyDeletedCount: number` |
| Routes | `POST /bank-transactions/delete` · `POST /bank-transactions/:id/restore` · `GET /bank-transactions/history` · `POST /bank-imports/:id/delete` |
| Schema | `schemas/accounting/bankSchema.ts` → `deleteBankTransactionsSchema`, `deleteBankImportSchema` |
| Server test | `server/src/__tests__/accounting/bankLineDelete.test.ts` |
| Client | `fetchServices.ts` → `deleteBankTransactions`, `restoreBankTransaction`, `deleteBankImport`, `listBankHistory`, `BankHistoryEntry`; `BankTransactionStatus` gains `'DELETED'` |
| Client test | `client/src/__tests__/bankLineDelete.test.tsx` |

### Step 31 — [Sonnet] Migration 103 — DELETED status and the trigger carve-out

- **Model:** [Sonnet] — changes an immutability trigger and a CHECK on a financial table
- **Depends on:** 30
- **Skill:** new-migration
- **Read first:** `074_ledger-core_bank_rules.sql` L59–80; `019_ledger-core_bank_reconciliation.sql` L60–102; `057_ledger-core_bank_line_journal.sql` (the DROP/ADD CONSTRAINT idiom for a CHECK).
- **Files:** `server/src/db/migrations/103_ledger-core_bank_transaction_delete.sql` (new)
- **Contract:**
  - `ALTER TABLE bank_transactions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL, ADD COLUMN IF NOT EXISTS deleted_by UUID NULL, ADD COLUMN IF NOT EXISTS delete_reason TEXT NULL;`
  - FK `fk_bank_txn_deleted_by FOREIGN KEY (deleted_by) REFERENCES users(id) ON DELETE SET NULL` (guarded by `IF NOT EXISTS … pg_constraint`), plus `CREATE INDEX IF NOT EXISTS idx_bank_txn_deleted_by ON bank_transactions (deleted_by);`.
  - Find the status CHECK's real name with `docker exec autodb_postgres psql -U autodb_user -d autodb -Atc "SELECT conname FROM pg_constraint WHERE conrelid='bank_transactions'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%UNMATCHED%'"`. Then `DROP CONSTRAINT IF EXISTS <that name>` and `ADD CONSTRAINT chk_bank_txn_status CHECK (status IN ('UNMATCHED','MATCHED','IGNORED','DELETED'))`. Write the discovered name into the migration literally, and also `DROP CONSTRAINT IF EXISTS chk_bank_txn_status` first, so the migration replays.
  - `chk_bank_txn_deleted_fields` (DROP IF EXISTS, then ADD): `CHECK ((status = 'DELETED') = (deleted_at IS NOT NULL AND deleted_by IS NOT NULL) AND (status = 'DELETED' OR delete_reason IS NULL))`.
  - `CREATE OR REPLACE FUNCTION reject_bank_transaction_mutation()` with the 074 body. The only change is that the exempt list in **both** `to_jsonb(...) - …` chains gains `- 'deleted_at' - 'deleted_by' - 'delete_reason'`. The DELETE refusal stays word for word.
  - Header comment: soft delete only; the dedupe UNIQUE stays, so a deleted line still blocks re-import (user decision 4).
- **Guardrails:** #6 hard DELETE still refused; #13 replay-safe; #8.
- **Proof:**
  ```bash
  cd server && npm run migrate && npm run migrate
  npm test -- migrations bankConstraints
  ```
  Both pass. The existing `bankConstraints.test.ts` L344 DELETE refusal test still passes, unchanged.
- **Owes:** schema.md (Step 36).

### Step 32 — [Haiku] Types: status, FSM, line fields

- **Model:** [Haiku] — transcription
- **Depends on:** 31
- **Files:** `server/src/types/accounting.ts` (edit L1072–1096 and the `BankTransaction` interface); `server/src/controllers/accounting/bankTransactionController.ts` (edit the `optionalStatus` message)
- **Contract:**
  - `BANK_TRANSACTION_STATUSES = ['UNMATCHED', 'MATCHED', 'IGNORED', 'DELETED'] as const;`
  - `BANK_TRANSACTION_TRANSITIONS = { UNMATCHED: ['MATCHED', 'IGNORED', 'DELETED'], MATCHED: ['UNMATCHED'], IGNORED: ['UNMATCHED'], DELETED: ['UNMATCHED'] }`
  - Extend the doc comment with: `DELETED (Phase 46e) is a soft delete of an unreconciled line; DELETED → UNMATCHED is "restore". A matched line must be unmatched first.`
  - `BankTransaction` gains `deletedAt: string | null; deletedBy: string | null; deletedByName: string | null; deleteReason: string | null;`.
  - The controller message becomes `'status must be UNMATCHED, MATCHED, IGNORED or DELETED'`.
- **Proof:** `cd server && npm run typecheck` fails only in `bankMatchService.ts` `toTransaction` (the missing new fields). Those are fixed in Step 33. Record the error count; there must be no error in any other file.
- **Owes:** —

### Step 33 — [Sonnet] Bank service: delete, restore, import delete, exclusions, `previouslyDeletedCount`

- **Model:** [Sonnet] — FSM edges, a report total, and import counting on a financial table
- **Depends on:** 32
- **Read first:** `bankMatchService.ts` L290–500 and L858–950; `bankImportService.ts` L301–440; `reportService.ts` L410–430.
- **Files:** `services/accounting/bankMatchService.ts`, `services/accounting/bankImportService.ts`, `services/accounting/reportService.ts` (edit)
- **Contract:**
  - `BANK_TXN_SELECT` and `BankTxnRow` gain `bt.deleted_at, bt.deleted_by, du.name AS deleted_by_name, bt.delete_reason` with `LEFT JOIN users du ON du.id = bt.deleted_by`. `toTransaction` maps them.
  - `buildFilters`: when `options.status === null`, add `bt.status <> 'DELETED'`. The default list hides deleted lines, and `status=DELETED` shows them.
  - `setIgnored`: after the FSM check, add the narrower rule `if (!ignored && row.status !== 'IGNORED') throw new ApiError(409, 'This bank line is not ignored');`. This is needed because the FSM now also allows DELETED → UNMATCHED.
  - New function:
    ```ts
    export async function deleteTransactions(orgId: string, userId: string, ids: string[], reason: string | null): Promise<{ deletedCount: number }>;
    ```
    - `withTransaction`.
    - `SELECT id, status FROM bank_transactions WHERE org_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`. Sorted lock order, so concurrent deletes cannot deadlock.
    - Fewer rows than distinct ids → `404 'Bank transaction not found'`.
    - Any row where `!canTransitionBankTransaction(status, 'DELETED')` → `409 'Only unreconciled lines can be deleted — unmatch or unignore first'`.
    - `UPDATE bank_transactions SET status = 'DELETED', deleted_at = now(), deleted_by = $3, delete_reason = $4 WHERE org_id = $1 AND id = ANY($2::uuid[])`.
    - `DELETE FROM bank_match_suggestions WHERE org_id = $1 AND bank_transaction_id = ANY($2::uuid[])`. The suggestions are derived data, as in `postJournalForTransactionOnClient`.
  - New function:
    ```ts
    export async function restoreTransaction(orgId: string, id: string): Promise<BankTransaction>;
    ```
    - `withTransaction`, `FOR UPDATE`.
    - Not DELETED → `409 'This bank line is not deleted'`, checked after the FSM check.
    - `UPDATE … SET status='UNMATCHED', deleted_at=NULL, deleted_by=NULL, delete_reason=NULL`.
    - `generateSuggestionsOnClient(client, orgId, [id])`.
  - `bankImportService.deleteImport(orgId, userId, importId, reason)`:
    - Verify the import exists in the org (`404 'Bank import not found'`).
    - Collect its line ids that are not already DELETED.
    - Any MATCHED or IGNORED line → `409 'This statement has reconciled or ignored lines — unmatch or unignore them first'`.
    - Otherwise delete the UNMATCHED ones through the same SQL as `deleteTransactions`. Extract the shared part as `deleteTransactionsOnClient(client, orgId, userId, ids, reason)` in `bankMatchService.ts` and call it from both.
    - Returns `{ deletedCount }`.
    - The import row itself is never deleted (rule 6 / no DELETE on imports).
  - `importStatement`: after the INSERT, `SELECT count(*) FROM bank_transactions WHERE org_id = $1 AND status = 'DELETED' AND dedupe_hash = ANY($2::text[])` on `client`, returned as `previouslyDeletedCount`. `duplicateCount` keeps its meaning (all skipped rows); `previouslyDeletedCount` is the subset of them.
  - `reportService` bank-reconciliation summary:
    - `statement_balance` filter becomes `status NOT IN ('IGNORED','DELETED')`.
    - Add `COUNT(*) FILTER (WHERE status = 'DELETED')::text AS deleted_count`, surfaced as `deletedCount` on the report object.
    - Add the field to its type and docs.
- **Guardrails:** #10 every status change goes through `canTransitionBankTransaction`; #6 no row deleted; #1; #5 one client per transaction; #3 the report stays integer cents.
- **Proof:** `cd server && npm run typecheck && npm test -- bankMatching bankImports bankReconciliation bankRules bankLineJournal bankConstraints` passes.
- **If it fails:** an existing test lists lines with no status filter and now counts fewer → that is only valid if the fixture deleted a line, which none does today. Stop and report.
- **Owes:** —

### Step 34 — [Sonnet] Bank history events on every match-state change

- **Model:** [Sonnet] — writes inside existing GL-posting transactions
- **Depends on:** 33
- **Files:** `services/accounting/bankMatchService.ts`, `services/accounting/bankRuleService.ts`, `services/accounting/bankImportService.ts` (edit)
- **Contract:** each event is `historyService.recordEventOnClient(client, orgId, { entityType: 'BANK_TRANSACTION', entityId, action, summary, details })` on the function's own client, after its UPDATE.

  | Where | action | summary | details |
  |---|---|---|---|
  | `matchTransaction` (payment created) | MATCHED | `Reconciled to {invoice|bill} {number}: {money(amount)}` | `{ paymentId }` |
  | `postJournalForTransactionOnClient` (no rule) | MATCHED | `Reconciled by journal to {accountCode} {accountName}` | `{ journalEntryId }` |
  | `postJournalForTransactionOnClient` with a `ruleId` | MATCHED | `Reconciled by bank rule "{ruleName}"` | `{ journalEntryId, ruleId }` |
  | `unmatchTransaction` | UNMATCHED | `Unreconciled — payment voided` or `Unreconciled — journal reversed` | `{ previousPaymentId, previousJournalEntryId, previousRuleId }` (read **before** the UPDATE clears them) |
  | `setIgnored(true)` / `(false)` | IGNORED / UNIGNORED | `Ignored` / `Unignored` | — |
  | `deleteTransactionsOnClient` | DELETED | `Deleted` + `: {reason}` when given | — |
  | `restoreTransaction` | RESTORED | `Restored` | — |
  | `importStatement`, per inserted line (one `recordEventsOnClient` call) | IMPORTED | `Imported from {fileName}` | `{ importId }` |

  Add `listBankHistory`:
  ```ts
  export interface BankHistoryEntry extends HistoryEntry { bankTransactionId: string; txnDate: string; description: string; amountCents: number; currencyCode: string }
  export async function listBankHistory(orgId: string, options: { accountId: string | null; page: number; limit: number }): Promise<{ entries: BankHistoryEntry[]; totalCount: number }>;
  ```
  SQL:
  ```sql
  FROM document_history h
  JOIN bank_transactions bt ON bt.id = h.entity_id AND bt.org_id = h.org_id
  LEFT JOIN users u ON u.id = h.actor_user_id
  WHERE h.org_id = $1 AND h.entity_type = 'BANK_TRANSACTION'
    AND h.action <> 'IMPORTED'
    AND ($2::uuid IS NULL OR bt.account_id = $2)
  ORDER BY h.created_at DESC, h.id DESC
  ```
  Paginated with a separate count query. `IMPORTED` is excluded so the account history shows only actions taken on lines.
- **Guardrails:** #5; #1 (`h.org_id` and `bt.org_id` both constrained by the join).
- **Proof:** `cd server && npm run typecheck && npm test -- bankMatching bankImports bankRules bankLineJournal` passes.
- **Owes:** —

### Step 35 — [Haiku] Bank controllers, schemas, routes

- **Model:** [Haiku] — adapters; route order is specified
- **Depends on:** 34
- **Files:** `schemas/accounting/bankSchema.ts`, `controllers/accounting/bankTransactionController.ts`, `controllers/accounting/bankImportController.ts`, `routes/accounting/bankTransactionRoutes.ts`, `routes/accounting/bankImportRoutes.ts` (edit)
- **Contract:**
  - Schemas:
    ```ts
    export const deleteBankTransactionsSchema = z.object({
      ids: z.array(z.string().uuid()).min(1, 'Choose at least one line').max(500, 'Delete at most 500 lines at once'),
      reason: z.string().trim().max(200, 'A reason can be at most 200 characters').nullable().default(null),
    }).strict();
    export const deleteBankImportSchema = z.object({
      reason: z.string().trim().max(200, 'A reason can be at most 200 characters').nullable().default(null),
    }).strict();
    ```
  - Controllers:
    - `remove` → `200 { success: true, deletedCount }`.
    - `restore` → `200 { success: true, transaction }`.
    - `history` → `200 { success: true, count, totalCount, currentPage, totalPages, entries }` (with `readPagination`, `optionalUuid(req,'accountId')`).
    - `bankImportController.remove` → `200 { success: true, deletedCount }`.
    - `ignore` and `unignore` are unchanged.
  - Routes in `bankTransactionRoutes.ts`. Place these **before** `router.get('/:id', …)`:
    ```ts
    router.get('/history', authenticate, requirePermission('bank.view'), bankTransactionController.history);
    router.post('/delete', authenticate, requirePermission('bank.reconcile'), bankTransactionController.remove);
    ```
    And after `/:id/unignore`:
    ```ts
    router.post('/:id/restore', authenticate, requirePermission('bank.reconcile'), bankTransactionController.restore);
    ```
    In `bankImportRoutes.ts`: `router.post('/:id/delete', authenticate, requirePermission('bank.reconcile'), bankImportController.remove);`.
    Update both files' header comments: "There is no PATCH and no DELETE verb — deletion is a soft status (Phase 46e)".
- **Proof:** `cd server && npm run typecheck && npm test -- routePermissions` passes.
- **Owes:** api.md (Step 36).

### Step 36 — [Sonnet] Integration tests for bank deletion and history

- **Model:** [Sonnet] — real-Postgres: FSM, isolation, report totals, re-import
- **Depends on:** 35
- **Skill:** isolation-test
- **Read first:** `__tests__/accounting/bankLineJournal.test.ts` L28–75 (`importSingleLine`); `__tests__/accounting/bankReconciliation.test.ts` (report call shape).
- **Files:** `server/src/__tests__/accounting/bankLineDelete.test.ts` (new)
- **Contract — named cases:**
  1. `deletes an unmatched line`: `POST /bank-transactions/delete {ids:[id], reason:'Duplicate'}` → `200 {deletedCount:1}`. `GET /:id` → `status 'DELETED'`, `deleteReason 'Duplicate'`, `deletedByName` set.
  2. `hidden from the default list, shown under DELETED`: `GET ?accountId=` excludes it, and `GET ?status=DELETED` includes it.
  3. `refuses a matched line`: post-journal a line, then delete it → `409` with the exact message, and the line is still `MATCHED`.
  4. `restore`: `POST /:id/restore` → `200 status 'UNMATCHED'` with the delete fields null. Restoring again → `409 'This bank line is not deleted'`.
  5. `unignore cannot restore`: `POST /:id/unignore` on a DELETED line → `409 'This bank line is not ignored'`.
  6. `re-import reports previously deleted`: import the same CSV again → `201`, `importedCount 0`, `duplicateCount 1`, `previouslyDeletedCount 1`.
  7. `reconciliation excludes deleted`: a −3800 line then deleted. The `statementBalanceCents` from `GET /reports/bank-reconciliation` equals the balance before the import, and `deletedCount === 1`.
  8. `delete import`: a 3-line import → `POST /bank-imports/:id/delete` → `deletedCount 3`. After matching one line, a second import's delete → `409`.
  9. `history`: delete, restore, then post-journal. `GET /bank-transactions/history?accountId=` returns actions `MATCHED, RESTORED, DELETED` (newest first). `GET /bank-transactions/:id/history` additionally ends with `IMPORTED`.
  10. `unmatch keeps what it was matched to`: the UNMATCHED event's `details.previousJournalEntryId` equals the reversed entry's id.
  11. `cross-tenant`: org A deleting, restoring or reading the history of an org B line → `404`, and org B's line status is unchanged.
  12. `hard delete still refused`: `pool.query('DELETE FROM bank_transactions WHERE id = $1')` rejects with `0A000`.
  13. `trigger carve-out is narrow`: `UPDATE bank_transactions SET description = 'x'` still rejects with `0A000`.
- **Proof:** `cd server && npm test -- bankLineDelete` shows 13 passing tests.
- **Owes:** —

### Step 37 — [Haiku] Client: tabs, delete/restore, import delete, account history

- **Model:** [Haiku] — client UI over fixed endpoints
- **Depends on:** 36
- **Read first:** `Pages/banking/BankTransactionsPage.tsx` (`TABS`, the row actions at L259–330, the `ConfirmDialog` usage); `Pages/banking/BankImportPage.tsx`.
- **Files:** `fetchServices.ts`, `BankTransactionsPage.tsx`, `BankImportPage.tsx` (edit); `__tests__/bankLineDelete.test.tsx` (new)
- **Contract:**
  - `fetchServices.ts`:
    - `BankTransactionStatus` gains `'DELETED'`.
    - `BankTransaction` gains `deletedAt`, `deletedByName` and `deleteReason` (all `string | null`).
    - `deleteBankTransactions(ids: string[], reason: string | null)` → `POST /bank-transactions/delete`.
    - `restoreBankTransaction(id)` → `POST /bank-transactions/${id}/restore`.
    - `deleteBankImport(id, reason)` → `POST /bank-imports/${id}/delete`.
    - `BankHistoryEntry`.
    - `listBankHistory({ accountId, page })` → `GET /bank-transactions/history?…`.
    - `ImportStatementResult` (or whatever the client calls it) gains `previouslyDeletedCount: number`.
  - `BankTransactionsPage`:
    - `TABS` becomes All · Unreconciled (`UNMATCHED`) · Reconciled (`MATCHED`) · Ignored · Deleted (`DELETED`) · History (`'HISTORY'`, a client-only value that renders the history list instead of lines).
    - On UNMATCHED rows, a row checkbox, plus a toolbar `Delete selected` button. It opens a `ConfirmDialog` with an optional reason input and calls `deleteBankTransactions`.
    - On DELETED rows: show `Deleted by {deletedByName} · {reason}` and a `Restore` button.
    - The History tab is a paginated list showing date, actor, summary, and the line's date, description and amount. It filters by the page's current `accountId` param.
  - `BankImportPage`:
    - The import result shows `N previously deleted lines were skipped — restore them from the Deleted tab` when `previouslyDeletedCount > 0`.
    - Each listed import gets `Delete statement` (`ConfirmDialog` → `deleteBankImport`); a `409` message is shown inline.
- **Tests:**
  1. Selecting two unmatched lines and confirming calls `deleteBankTransactions(['a','b'], null)`.
  2. The Deleted tab shows `Restore`, which calls `restoreBankTransaction('a')`.
  3. The History tab renders a mocked entry's summary.
  4. An import result with `previouslyDeletedCount: 2` shows the message.
- **Proof:** `cd client && npm run typecheck && npm test -- bankLineDelete bankTransactions bankImport` passes.
- **Owes:** —

### Step 38 — [Sonnet] Close 46e: study note, docs, suites, review, commit

- **Model:** [Sonnet]
- **Depends on:** 37
- **Skill:** study-note, guardrail-review
- **Files:**
  - `study/postgresql/soft-delete-under-an-immutability-trigger.md` (new). It covers:
    - Status-as-delete vs `deleted_at` vs a hard delete.
    - Widening a jsonb-diff trigger's carve-out.
    - Why the dedupe UNIQUE stays whole (vs a partial index `WHERE status <> 'DELETED'`) and what that means for re-import.
    - The sorted `FOR UPDATE` lock order for multi-row deletes.
    - Why `DELETED → UNMATCHED` forced a narrower rule in `setIgnored`.
    - 5–7 Q&As.
  - `study/README.md`, `docs/schema.md` (103), `docs/api.md` (4 routes + `previouslyDeletedCount` + `deletedCount` on the report), `docs/accounting.md` (bank reconciliation: deleting and restoring lines, account history).
- **Do:** run both full suites and the guardrail review, then commit `Phase 46e: delete and restore bank statement lines; reconciliation history` with the attribution line.
- **Proof:** green, zero violations, commit exists.

---

## Step 39 — [Sonnet] Phase close: docs-sync, roadmap, CLAUDE.md, retire this plan

- **Model:** [Sonnet] — verification of docs against the filesystem
- **Depends on:** 38
- **Skill:** docs-sync
- **Files:** `docs/roadmap.md`, `CLAUDE.md`, this plan file (all edit)
- **Contract:**
  - `docs/roadmap.md`: a `### Phase 46 (as delivered)` section with the five slices, migrations `100`–`103`, and the final test totals (from the Step 38 run).
    - Its **Not built** list:
      - automatic postings to Rounding
      - deposit applications and online payments on document timelines
      - history backfill beyond CREATED/IMPORTED
      - a payment detail page (its history is API-only)
      - sign-in lockout and alerting
      - hard deletion of a statement import
      - editing or deleting notes
  - `CLAUDE.md`: one bullet after Phase 45, in the existing style. Keep it to 3 lines and include the test totals.
  - This plan: set `Status: done — Phase 46 landed` and mark every manifest row `done`.
- **Do:** run `docs-sync`, then commit `Phase 46: docs and roadmap` with the attribution line.
- **Proof:** `docs-sync` reports no drift, and `grep -c "Phase 46" CLAUDE.md docs/roadmap.md` is ≥ 1 for each.

---

## Dispatch manifest

| Batch | Step | Tier | Title | Depends on | Blocks | Status |
|---|---|---|---|---|---|---|
| A | 0 | Haiku | Preflight | — | 1 | done |
| B | 1 | Sonnet | Migration 100 + DEFAULT_CHART 6830 | 0 | 2 | done |
| C | 2 | Haiku | System-account registry + types | 1 | 3 | done |
| D | 3 | Sonnet | systemAccountService + parity test | 2 | 4 | done |
| D | 4 | Sonnet | Locks + `systemRoles` decoration | 3 | 5,7 | done |
| E | 5 | Haiku | `GET /accounts/system` | 4 | 6 | done |
| E | 6 | Haiku | Client badges + System accounts panel | 5 | 8 | done |
| F | 7 | Sonnet | Study note: derived roles | 4 | 9 | done |
| G | 8 | Haiku | Docs 46a | 6 | 9 | done |
| H | 9 | Sonnet | Close 46a + commit | 5,6,7,8 | 10 | done |
| I | 10 | Haiku | Hints per field + picker values | 9 | 11,13 | done |
| I | 11 | Haiku | Six preview gaps | 10 | 12 | done |
| I | 12 | Haiku | Bank-line memo picker | 11 | 14 | done |
| I | 13 | Haiku | Recurring "next run will read" | 10 | 14 | done |
| J | 14 | Sonnet | Close 46b + commit | 12,13 | 15 | done |
| J | 15 | Sonnet | Migration 101 `document_history` | 14 | 16 | done |
| K | 16 | Haiku | `types/history.ts` | 15 | 17 | done |
| L | 17 | Sonnet | `historyService` | 16 | 18 | done |
| M | 18 | Haiku | History schema/controller/router/mount | 17 | 19 | done |
| N | 19 | Sonnet | Events: invoices, credit notes | 18 | 20 | done |
| N | 20 | Sonnet | Events: bills, debit notes | 19 | 21 | done |
| N | 21 | Sonnet | Events: payments | 20 | 22 | done |
| N | 22 | Sonnet | Events: quotes, orders, journals, contacts | 21 | 23 | done |
| N | 23 | Sonnet | History integration tests | 22 | 24 | done |
| O | 24 | Haiku | Client `HistoryAndNotes` + mounts | 23 | 25 | done |
| P | 25 | Sonnet | Close 46c + commit | 24 | 26 | done |
| P | 26 | Sonnet | Migration 102 `login_events` | 25 | 27 | done |
| P | 27 | Sonnet | loginEventService + auth hooks | 26 | 28 | done |
| Q | 28 | Haiku | Activity controllers + routes | 27 | 29 | done |
| Q | 29 | Haiku | Client sign-ins, User activity, audit filters | 28 | 30 | done |
| R | 30 | Sonnet | Close 46d + commit | 29 | 31 | done |
| R | 31 | Sonnet | Migration 103 bank DELETED | 30 | 32 | done |
| S | 32 | Haiku | Bank types + FSM | 31 | 33 | done |
| T | 33 | Sonnet | Bank delete/restore/exclusions | 32 | 34 | done |
| T | 34 | Sonnet | Bank history events + `listBankHistory` | 33 | 35 | done |
| U | 35 | Haiku | Bank controllers + routes | 34 | 36 | done |
| V | 36 | Sonnet | Bank integration tests | 35 | 37 | done |
| W | 37 | Haiku | Client bank tabs + delete/restore/history | 36 | 38 | done |
| X | 38 | Sonnet | Close 46e + commit | 37 | 39 | done |
| X | 39 | Sonnet | Phase close: docs-sync, roadmap, CLAUDE.md | 38 | — | done |

**Same-tier runs that dispatch as one batch:**
- D (3–4), E (5–6), I (10–13), N (19–23), P (25–27), Q (28–29), R (30–31), T (33–34), X (38–39).
- Steps 7 and 8 could run in either order (7 needs 4; 8 needs 6). They are kept as separate batches F/G because their tiers differ.

**Never batch across these boundaries:**
- Step 32 (Haiku) leaves the server typecheck red until Step 33 (Sonnet) runs. Run 33 immediately after 32 and never commit between them.
- Each "Close" step (9, 14, 25, 30, 38) is a commit boundary. Do not start the next slice's migration in the same session before its close step is `done`.
- Steps 19–22 share one invariant (every event on the document's own client). Run them in one Sonnet session if possible.

## Plan corrections

- **Step 4 (2026-10-16, user decision):** two existing fixtures retired 1140, which now holds the INVENTORY role. `accounts.test.ts` ("retires an account with isActive…") and `reports.test.ts` ("excludes a retired account…") now retire **6100**, a non-system account. `reports.test.ts`'s trial-balance counts go up by one for 6830 (39→40, 39→40, 38→39). Step 1's proof should have included `reports`. The lock is unchanged.
- **Step 9 (orchestrator note):** client `onboarding.test.tsx` / `dashboard.test.tsx` time out intermittently (`findBy` 1 s) under CPU load. The same failure reproduces at `c13c278` (3 of 4 isolated runs), so it predates this phase. A close step whose only client failure is one of these two passes on a re-run. 46a was committed as `c04a03e`.
- **Step 13 (orchestrator, from code):** `nextOccurrenceIndex` is 0-based, and the sweep fills `[Occurrence]` with `next_occurrence_index + 1` (`recurringService.ts` L783). So `templateTextsFor`'s context uses `occurrence: schedule.nextOccurrenceIndex + 1`.
- **Step 18 (orchestrator, from the Execution rules):** `buildHistoryRouter`'s `keys` are typed `{ view: Permission; note: Permission }`, with `import type { Permission }` from `config/permissions.js`. That is how `requirePermission` is typed, and no cast is used.
- **Steps 19–22 (runner judgment calls, accepted):** no transition function needed `withTransaction` wrapping. `sendQuote` records "Sent to <email>" or "Marked as sent". Manual-journal CREATED is written in `insertHeaderOnClient` (templates read "Repeating template created"), and POSTED in `postDraftOnClient`. Quote/order events are written inside the transition helpers. Quote→order records CONFIRMED but no CREATED on the order. Contact UPDATED is written only when a row matched.
- **Step 24 (orchestrator):** `HistoryAndNotes` keeps `useCan()`, as the contract says. `creditNotes.test.tsx`, `debitNotes.test.tsx` and `partyAccount.test.tsx` rendered their pages without an `AuthProvider`. They now wrap them the way `invoices.test.tsx` does, with no assertion changed. "No new mocks" in the proof referred to `listHistory` fetches.
- **Step 25 (finding, not fixed):** `trg_document_history_immutable` also refuses FK actions on its table. `DELETE FROM organizations` cascades into it, and `ON DELETE SET NULL` on `actor_user_id` is an UPDATE. So an org or user with history can no longer be hard-deleted. No production path does that today; a future account-deletion feature must anonymise or carve out an exception. Recorded in the study note. `navigation.test.tsx` is a third load-timeout flake (it passes in isolation). `LIMIT` became `$4` (rule 4). 46c was committed as `1087e7d`.
- **Step 27:** tests 5–7 are covered at the service seam, because the HTTP routes arrive in Step 28. The VIEWER→403 check on `/organizations/members/activity` moves to Step 28's tests. `listMemberActivity`'s 30-day FAILED count is keyed by `user_id` with no org predicate (the contract's SQL, since failed sign-ins carry no org). Step 30's guardrail review must rule on it.
- **Step 29 (orchestrator, same ruling as Step 24):** `AuditLogPage` keeps `useSearchParams`, as the contract says. `auditLog.test.tsx` wraps its renders in a `MemoryRouter`, harness only, with no assertion changed. The client function is `getAuditLogs(AuditLogFilters)`, not `listAuditLogs`.
- **Step 31 (finding, not fixed):** `chk_bank_txn_deleted_fields` requires `deleted_by` when the status is DELETED, but `fk_bank_txn_deleted_by` is `ON DELETE SET NULL`. So hard-deleting a user who deleted a bank line fails the CHECK. This is the same class as the Step 25 finding, and no production path deletes users. The contract was followed literally.
- **Step 33:** matching or posting a journal on a DELETED line returns the existing 409 "ignored — un-ignore it first". The wording is slightly off but the status is correct; this is a possible polish item.
- **Step 37 (orchestrator, narrowest reading; flagged to the user):** `BankImportPage` had no list of imports. It gains a small "Recent statements" section over the existing `listBankImports()`, and each row carries `Delete statement`. `BankTransactionsPage` had no account filter, so the History tab reads `accountId` from the URL query with no new picker; when it is absent the history covers all accounts.
- **Step 3:** `PATCH /settings` returns 409 until onboarding has run, so `systemAccounts.test.ts` has a local `onboard()` helper. Error bodies carry `error`, not `message`.

## Risks & open questions

- **Unknown exact transaction shape** of a few transition functions (`voidInvoice`, `updateCreditNote`, `sendQuote`, …). Steps 19–22 direct the executor to wrap a pool-only write in `withTransaction` and report each one. If a function's write happens inside a *caller's* transaction that it cannot reach, stop and report.
- **Field names on client types** (`nextOccurrenceIndex` base, `ManualJournal.narrationTemplate`, `Bill.vendorNameSnapshot`) were read from `fetchServices.ts` but not exercised. Step 13 stops on any mismatch.
- **`organization_members.role` vs custom roles (083):** Step 27 falls back to `listMembers`' expression and reports it.
- **Seeded-chart count assertions** may exist in more tests than `accounts.test.ts`. Step 1 sanctions only the number change.
- **Volume of IMPORTED events:** one history row per imported bank line, with a 5000-row cap per import (36a). That is acceptable; it is noted in the study note.
- **Assumption:** the "detailed activity log" the user asked for is satisfied by sign-in history, member activity, per-document timelines and the existing audit log with actor filters. No separate "activity feed" page is built.

## Definition of done

- Migrations `100`–`103` apply twice cleanly, and the replay test passes.
- Server and client suites are fully green (2 server tests skipped, as before), typecheck and lint are clean in both packages, and the integrity checks pass (`npm run verify:integrity`).
- Each slice is its own commit (46a–46e), plus the docs commit, each with a guardrail review showing zero violations.
- Study notes: `derived-system-account-roles`, `polymorphic-references-and-history-tables`, `recording-failed-logins`, `soft-delete-under-an-immutability-trigger`, indexed in `study/README.md`.
- `docs/schema.md`, `api.md`, `accounting.md`, `architecture.md`, `roadmap.md` and `CLAUDE.md` describe what landed, confirmed by `docs-sync`.
- This file's Status reads `done — Phase 46 landed` and every manifest row is `done`.
