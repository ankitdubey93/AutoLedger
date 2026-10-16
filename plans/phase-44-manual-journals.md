# Phase 44 — Manual Journals (Xero-style)

Date: 2026-10-15 · **Status: done — Phase 44 landed** · Approved design: `/home/ankit/.claude/plans/pasted-content-id-6326-manual-rustling-kitten.md`

This phase turns manual journal entries into Xero-style **Manual Journals**:
- a document with **Draft / Posted / Voided** states, owning its immutable GL posting
- line descriptions
- a mandatory narration that takes placeholders
- **Save draft**, **Save & add another** and **Post**
- **repeating journals** created directly, without posting one first: a first date, a frequency, an optional end date, and optional auto-reverse
- refusal of **system accounts**: AR, AP and inventory control as today, plus a new **bank / credit card** account flag

**User decisions (fixed — do not reopen):**
1. Bank and credit-card accounts are marked by a new nullable flag, `accounts.bank_account_kind` (`BANK` | `CREDIT_CARD`). It is **not** a sixth account type (rule 12).
2. The Manual Journals list shows **manual journals only**. The all-postings register becomes a **General journal** report page.

**Deviation from the approved plan's URLs (forced by the codebase):**
- Every invoice, bill, payment and account-ledger row links to `/journals/:entryId`, so that URL keeps showing a GL entry.
- Manual journals therefore live at `/manual-journals/*`.
- `/journals` and `/journals/new` redirect there. The register moves to `/reports/general-journal`.

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

## Starting state (verified 2026-10-15, HEAD `1db4bbf`, tree clean)

**Schema**
- The last migration is `096_platform_inbound_mail.sql`, so this phase's migration is **`097`**.
- `journal_entries` (004):
  - columns `id, org_id, created_by, entry_date, description TEXT (≤500), source_type TEXT DEFAULT 'manual', source_id UUID, reverses_entry_id, created_at`, plus `description_template` (087)
  - **no status column**
  - `UNIQUE (org_id, id)` (009)
  - a partial unique index on `reverses_entry_id`
- `ledger_lines` (004): `id, org_id, journal_entry_id, account_id, debit_cents, credit_cents, currency_code, fx_rate, base_debit_cents, base_credit_cents, created_at`. It has **no description column**.
- Both tables are immutable: `reject_mutation()` rejects UPDATE/DELETE with SQLSTATE `0A000`. There are also the deferred balance trigger, the postable-account trigger and the period-lock trigger (016).
- `accounts` columns: `id, org_id, code, name, type, parent_id, is_postable, is_active, description, created_by, created_at, updated_at`. **There is no bank or credit-card concept.**
- `recurring_schedules` / `recurring_runs` (075):
  - a JOURNAL schedule's source is `source_journal_entry_id`, an already-posted entry with `source_type='manual'`
  - `chk_recurring_source_matches_kind` enforces one source column per kind
  - `chk_recurring_journal_posts` (JOURNAL ⇒ `mode='POST'`)
  - `chk_recurring_auto_reverse_journal_only`
- Bank and cash accounts are referenced by:
  - `bank_statement_imports.account_id` (019)
  - `bank_transactions.account_id` (019)
  - `bank_rules.bank_account_id` (074)
  - `ledger_settings.cash_account_id` (005)
  - `payments.cash_account_id` (014)
- `009_ledger-core_invoices.sql` lines 120–191 hold the **exact trigger template** this phase copies: `reject_issued_invoice_mutation` and `reject_non_draft_invoice_line_mutation`.

**Server** (`server/src/`)
- `services/accounting/journalService.ts`:
  - `createEntryOnClient(client, orgId, createdBy, CreateEntryInput)` (~459)
  - `fillJournalDescriptionOnClient(client, orgId, description, entryDate, surface='JOURNAL', occurrence=null) → {description, descriptionTemplate}` (~594)
  - `createEntry` (~626): the manual path, used by `journalController.create`, `__tests__/integrity.test.ts:69` and `__tests__/platform/auditActor.test.ts:180`
  - `reverseEntryOnClient(client, orgId, createdBy, id, entryDate)` (~672): used by 8 document services, so **never add a guard inside it**
  - `reverseEntry` (~752): used only by `journalController.reverse`
  - `assertNotControlAccountsOnClient` (~368), `listControlAccountsOnClient` (~394) and the private `loadControlAccountsOnClient`
  - `ENTRY_SELECT`, `loadLines`, `toLine`, `toEntry`, `getEntryById`, `listEntries`
- `services/accounting/recurringService.ts`:
  - `createSchedule` (~236)
  - `SCHEDULE_SELECT` (~83)
  - `PreReadRow` / `Template` / `loadTemplate` (~442–489)
  - `generateOccurrence` (~507; its JOURNAL branch is ~600–631)
  - `runDueOccurrences` (~650)
- `services/accounting/journalImportService.ts`: uses `listControlAccountsOnClient` (L123) and `createEntryOnClient` with `sourceType 'migration_import', sourceId: importId` (L329).
- `services/accounting/accountService.ts`: `ACCOUNT_COLUMNS`, `toAccount`, `createAccountOnClient`, `updateAccount` (`COLUMNS` map), `DEFAULT_CHART` (1110 Operating Cash is at L346), `seedDefaultChart`.
- `routes/accounting/journalRoutes.ts` (mounted at `/journals` in `routes/accounting/index.ts:62`), `controllers/accounting/journalController.ts`, `schemas/accounting/journalSchema.ts`.
- Permissions (`config/permissions.ts`):
  - `journals.view` (tier V) and `journals.create` (tier A, labelled "Post and reverse journal entries")
  - `recurring.view` (V) and `recurring.manage` (A)
  - **No new permission key is added in this phase.**
- Analogues:
  - The draft-editable document pattern: `billService.ts` / `billController.ts` / `billRoutes.ts`. These have PATCH on a draft and `DELETE → 204` (`billController.ts:106`).
  - The FSM pattern: `RECURRING_STATUS_TRANSITIONS` + `canTransitionRecurring` in `types/accounting.ts` (~1630–1648).
- Test helpers:
  - `__tests__/helpers/factories.ts` `resetTables()` holds an explicit TRUNCATE list. New tables must be added to it.
  - `__tests__/helpers/accountingFixtures.ts`: `accountId(orgId, code)`, `issueInvoice`, `receivePayment`.

**Client** (`client/src/`)
- `Pages/accounting/JournalsPage.tsx` (347 lines): the all-postings register with View, Duplicate, Reverse and Import.
- `Pages/accounting/NewJournalEntryPage.tsx` (340 lines): posts immediately, supports `?copyFrom=<entryId>`, and has the `PlaceholderPicker`/`PlaceholderHints` with `surface="JOURNAL"`.
- `Pages/accounting/JournalDetailPage.tsx`: Reverse; "Make recurring" through `components/MakeRecurringDialog.tsx`, whose props are `{kind, sourceId, defaultName, onClose, onCreated}`.
- `Pages/accounting/RecurringSchedulesPage.tsx` and `RecurringScheduleDetailPage.tsx`.
- `routes/ProductRoutes.tsx:216-220`, `components/layout/nav.ts:105-106`, `utils/pageTitle.ts` (`EXACT_TITLES`), `Pages/reports/ReportsPage.tsx` (a `{name, path}` list).
- `components/ui/TabBar.tsx` (`variant: 'buttons'`, with `active` and `onChange`), `components/imports/ImportButton.tsx`, `components/ConfirmDialog.tsx`, `components/ui/Pagination.tsx`, `components/ui/LoadingState.tsx`.
- `services/fetchServices.ts`: `apiFetch`, `Account` (L491), `LedgerLine`, `JournalEntry` (L521), `createJournal`, `getJournal`, `listJournals`, `reverseJournal`, `RecurringSchedule` (L1109).
- `Pages/accounting/NewAccountForm.tsx` and `Pages/settings/ChartSettingsPage.tsx` (which uses `updateAccount`).
- Client tests: `__tests__/journals.test.tsx` (17 cases) and `__tests__/recurringSchedules.test.tsx`.

**Not present:** a draft journal; voiding a journal; line descriptions; a standalone "new repeating journal"; a bank flag; a source-type guard on `POST /journals/:id/reverse`. On that last one: today it can reverse an invoice's posting directly and bypass the invoice's own void. That is a real bug, fixed in Step 7.

## Gate

- This is a direct feature request, numbered **Phase 44** like 24/30/32/34/41–43.
- Its prerequisites are built and verified above: Phase 3 (GL), 25 (control-account guard), 34b (recurring), 36c (journal import) and 40 (placeholders).
- No gated dependency and **no new npm package**.

## Execution rules

> **If a proof command fails twice on the same step, stop and report. Do not improvise around it.**

| Symptom | Forbidden | Correct |
|---|---|---|
| Migration checksum error | Editing the applied migration | A new sequential migration (rule 13) |
| Test fails | Weakening or deleting the assertion | Fix the code; the test is the spec (the only sanctioned test edits are in Step 10 and Step 18, under their stated rules) |
| Type error | `as any`, `@ts-ignore`, loosening `tsconfig` | Fix the type |
| Query returns no rows | Dropping the `org_id` predicate | Fix the fixture or the parameters (rule 1) |
| Balance assertion fails | An epsilon comparison, floats, rounding | Integer cents equality (rule 3) |
| Need a helper library | `npm install` something not in the plan | Stop and ask (rule 14) |
| "Update the posted journal" | An UPDATE on `journal_entries`/`ledger_lines`, or editing a POSTED manual journal | Void the manual journal (posts a reversal — rule 6) |
| Column missing at runtime | Adding it ad hoc in the service | A new migration, then update the plan |
| Circular import between services | Lazy `await import()` or merging files | Stop and report — the dependency direction below is fixed |
| A `[Haiku]` step's proof fails twice | Retrying in a loop, trimming the step, "good enough" | Escalate the step unchanged to Sonnet with the failure output, and note the escalation in this file |
| The step needs a decision the plan never made | Deciding it | Stop and report — the plan is the defect |

**Fixed service dependency direction (no cycles):**
- `recurringService` → `manualJournalService` → `journalService`
- `journalImportService` → `manualJournalService`
- `journalController` → `manualJournalService` + `journalService`
- `journalService` imports **neither** `manualJournalService` nor `recurringService`.

**Anything this plan did not anticipate is a stop-and-report, not a judgment call.**

---

## Slice 1 — Schema, bank-account flag, system-account guard

Outcome: the schema exists and is backfilled. Accounts carry `bankAccountKind`. One function refuses every system account for manual journals.

**Names — use exactly these, do not rename:**
| Kind | Name |
|---|---|
| Migration | `server/src/db/migrations/097_ledger-core_manual_journals.sql` |
| Tables | `manual_journals`, `manual_journal_lines` |
| New columns | `accounts.bank_account_kind`, `ledger_lines.description`, `recurring_schedules.source_manual_journal_id` |
| Constraints | `ck_accounts_bank_account_kind`, `ck_ledger_lines_description_length`, `chk_recurring_source_matches_kind_v2`, `fk_recurring_source_manual_journal` |
| Trigger functions | `reject_posted_manual_journal_mutation()`, `reject_non_draft_manual_journal_line_mutation()` |
| Types (server) | `ManualJournalStatus`, `MANUAL_JOURNAL_STATUSES`, `MANUAL_JOURNAL_STATUS_TRANSITIONS`, `isManualJournalStatus`, `canTransitionManualJournal`, `ManualJournalOrigin`, `MANUAL_JOURNAL_ORIGINS`, `BankAccountKind`, `BANK_ACCOUNT_KINDS`, `ManualJournalLine`, `ManualJournal`, `ManualJournalSummary` in `server/src/types/accounting.ts` |
| journalService new exports | `assertManualJournalAccountsOnClient`, `listManualJournalBlockedAccountsOnClient`, `REVERSIBLE_SOURCE_TYPES` |
| API fields | `Account.bankAccountKind`, `LedgerLine.description`, `JournalEntry.manualJournalId`, `RecurringSchedule.sourceManualJournalId` |

### Step 1 — [Sonnet] Migration 097

- **Model:** [Sonnet]. A migration with a set-based backfill and a replaced CHECK; this is irreversible (rule 13).
- **Depends on:** nothing.
- **Skill:** `new-migration`.
- **Read first:** `009_ledger-core_invoices.sql` lines 20–191 (table, FK and trigger template); `075_ledger-core_recurring_schedules.sql` (constraint names, audit trigger usage); `087_ledger-core_placeholder_templates.sql` (the `DO $$ … pg_constraint` guard idiom).
- **Files:** `server/src/db/migrations/097_ledger-core_manual_journals.sql` (new).
- **Contract — the file contains these sections in this order. Every statement is idempotent.**
  1. **A header comment** explaining:
     - why manual journals are a document owning an immutable posting (the invoice pattern)
     - why the bank flag is a column and not a sixth type (rule 12)
     - that the backfill is idempotent through `NOT EXISTS`
     - that replaying the backfill UPDATE re-flags 1110 (acceptable: replay runs only on the test DB)
  2. **Bank flag:**
     ```sql
     ALTER TABLE accounts ADD COLUMN IF NOT EXISTS bank_account_kind TEXT NULL;
     -- guarded DO block adding:
     CONSTRAINT ck_accounts_bank_account_kind CHECK (
          bank_account_kind IS NULL
       OR (bank_account_kind = 'BANK'        AND type = 'Asset')
       OR (bank_account_kind = 'CREDIT_CARD' AND type = 'Liability'))
     UPDATE accounts a SET bank_account_kind = 'BANK'
      WHERE a.bank_account_kind IS NULL AND a.type = 'Asset' AND (
            a.code = '1110'
         OR EXISTS (SELECT 1 FROM bank_statement_imports i WHERE i.org_id = a.org_id AND i.account_id = a.id)
         OR EXISTS (SELECT 1 FROM bank_transactions t WHERE t.org_id = a.org_id AND t.account_id = a.id)
         OR EXISTS (SELECT 1 FROM bank_rules r WHERE r.org_id = a.org_id AND r.bank_account_id = a.id)
         OR EXISTS (SELECT 1 FROM ledger_settings s WHERE s.org_id = a.org_id AND s.cash_account_id = a.id)
         OR EXISTS (SELECT 1 FROM payments p WHERE p.org_id = a.org_id AND p.cash_account_id = a.id));
     UPDATE accounts a SET bank_account_kind = 'CREDIT_CARD'
      WHERE a.bank_account_kind IS NULL AND a.type = 'Liability' AND (
            EXISTS (SELECT 1 FROM bank_statement_imports i WHERE i.org_id = a.org_id AND i.account_id = a.id)
         OR EXISTS (SELECT 1 FROM bank_transactions t WHERE t.org_id = a.org_id AND t.account_id = a.id)
         OR EXISTS (SELECT 1 FROM bank_rules r WHERE r.org_id = a.org_id AND r.bank_account_id = a.id));
     CREATE INDEX IF NOT EXISTS idx_accounts_org_bank_kind ON accounts (org_id) WHERE bank_account_kind IS NOT NULL;
     ```
  3. **Line description:** `ALTER TABLE ledger_lines ADD COLUMN IF NOT EXISTS description TEXT NULL;` plus a guarded `ck_ledger_lines_description_length CHECK (description IS NULL OR char_length(description) <= 500)`. Do **not** touch `reject_mutation`. ADD COLUMN fires no row trigger.
  4. **`manual_journals`:**
     ```sql
     CREATE TABLE IF NOT EXISTS manual_journals (
       id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       org_id                 UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
       status                 TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','TEMPLATE','POSTED','VOIDED')),
       origin                 TEXT NOT NULL DEFAULT 'MANUAL' CHECK (origin IN ('MANUAL','RECURRING','IMPORT')),
       narration              TEXT NOT NULL CHECK (length(btrim(narration)) > 0 AND char_length(narration) <= 500),
       narration_template     TEXT NULL CHECK (narration_template IS NULL OR char_length(narration_template) <= 500),
       entry_date             DATE NOT NULL,
       journal_entry_id       UUID NULL,
       void_journal_entry_id  UUID NULL,
       recurring_schedule_id  UUID NULL,
       posted_at              TIMESTAMPTZ NULL,
       voided_at              TIMESTAMPTZ NULL,
       created_by             UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
       created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
       updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
       CONSTRAINT ux_manual_journals_org_id_id UNIQUE (org_id, id),
       CONSTRAINT chk_manual_journals_posted_complete CHECK (
         status NOT IN ('POSTED','VOIDED') OR (journal_entry_id IS NOT NULL AND posted_at IS NOT NULL)),
       CONSTRAINT chk_manual_journals_unposted_has_no_entry CHECK (
         status NOT IN ('DRAFT','TEMPLATE') OR (journal_entry_id IS NULL AND posted_at IS NULL)),
       CONSTRAINT chk_manual_journals_voided_complete CHECK (
         (status = 'VOIDED') = (void_journal_entry_id IS NOT NULL AND voided_at IS NOT NULL)),
       CONSTRAINT chk_manual_journals_template_origin CHECK (status <> 'TEMPLATE' OR origin = 'MANUAL'),
       CONSTRAINT fk_manual_journals_journal_entry FOREIGN KEY (org_id, journal_entry_id) REFERENCES journal_entries (org_id, id) ON DELETE RESTRICT,
       CONSTRAINT fk_manual_journals_void_journal_entry FOREIGN KEY (org_id, void_journal_entry_id) REFERENCES journal_entries (org_id, id) ON DELETE RESTRICT,
       CONSTRAINT fk_manual_journals_recurring_schedule FOREIGN KEY (org_id, recurring_schedule_id) REFERENCES recurring_schedules (org_id, id) ON DELETE RESTRICT
     );
     CREATE UNIQUE INDEX IF NOT EXISTS ux_manual_journals_journal_entry ON manual_journals (journal_entry_id) WHERE journal_entry_id IS NOT NULL;
     CREATE INDEX IF NOT EXISTS idx_manual_journals_org_status_date ON manual_journals (org_id, status, entry_date DESC);
     CREATE INDEX IF NOT EXISTS idx_manual_journals_void_journal_entry ON manual_journals (void_journal_entry_id);
     CREATE INDEX IF NOT EXISTS idx_manual_journals_recurring_schedule ON manual_journals (recurring_schedule_id);
     CREATE INDEX IF NOT EXISTS idx_manual_journals_created_by ON manual_journals (created_by);
     ```
  5. **`manual_journal_lines`:**
     ```sql
     CREATE TABLE IF NOT EXISTS manual_journal_lines (
       id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       org_id             UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
       manual_journal_id  UUID NOT NULL,
       line_number        SMALLINT NOT NULL CHECK (line_number > 0),
       account_id         UUID NULL,
       description        TEXT NULL CHECK (description IS NULL OR char_length(description) <= 500),
       debit_cents        BIGINT NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
       credit_cents       BIGINT NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
       created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
       CONSTRAINT ux_manual_journal_lines_line UNIQUE (manual_journal_id, line_number),
       CONSTRAINT chk_manual_journal_lines_one_side CHECK (NOT (debit_cents > 0 AND credit_cents > 0)),
       CONSTRAINT fk_manual_journal_lines_journal FOREIGN KEY (org_id, manual_journal_id) REFERENCES manual_journals (org_id, id) ON DELETE CASCADE,
       CONSTRAINT fk_manual_journal_lines_account FOREIGN KEY (org_id, account_id) REFERENCES accounts (org_id, id) ON DELETE RESTRICT
     );
     CREATE INDEX IF NOT EXISTS idx_manual_journal_lines_journal ON manual_journal_lines (manual_journal_id);
     CREATE INDEX IF NOT EXISTS idx_manual_journal_lines_account ON manual_journal_lines (account_id);
     CREATE INDEX IF NOT EXISTS idx_manual_journal_lines_org ON manual_journal_lines (org_id);
     ```
     A comment must state the following. A draft line may have both sides zero and no account (a half-typed row). Rule 7's "exactly one side" is enforced when the line is posted, by the service and by `ledger_lines`' own CHECKs.
  6. **Triggers:** copy 009's two functions.
     - `reject_posted_manual_journal_mutation()`:
       - DELETE is allowed only when `OLD.status IN ('DRAFT','TEMPLATE')`.
       - UPDATE is allowed when `OLD.status IN ('DRAFT','TEMPLATE')`.
       - Otherwise only `OLD.status='POSTED' AND NEW.status='VOIDED'` is allowed, with the `to_jsonb(NEW) - 'status' - 'void_journal_entry_id' - 'voided_at' - 'updated_at'` comparison against OLD.
       - It raises with `ERRCODE '0A000'` and the messages `'Manual journal % is % and cannot be deleted'`, `'Manual journal % is % and is immutable'` and `'Voiding manual journal % may not change any other field'`.
     - `reject_non_draft_manual_journal_line_mutation()`: BEFORE INSERT OR UPDATE OR DELETE. The parent status must be NULL (the cascade case), `'DRAFT'` or `'TEMPLATE'`. Otherwise it raises `'Manual journal % is % — its lines cannot be changed'` with `0A000`.
     - Triggers: `trg_manual_journals_immutable` (BEFORE UPDATE OR DELETE), `trg_manual_journal_lines_draft_only`, `trg_manual_journals_updated_at` (`set_updated_at()`), `trg_manual_journals_audit` and `trg_manual_journal_lines_audit` (AFTER INSERT OR UPDATE OR DELETE, `audit_row_change('ledger-core')`). Use `CREATE OR REPLACE TRIGGER`, as 075 does.
  7. **Recurring source:**
     ```sql
     ALTER TABLE recurring_schedules ADD COLUMN IF NOT EXISTS source_manual_journal_id UUID NULL;
     -- guarded DO: ADD CONSTRAINT fk_recurring_source_manual_journal FOREIGN KEY (org_id, source_manual_journal_id)
     --   REFERENCES manual_journals (org_id, id) ON DELETE RESTRICT
     CREATE INDEX IF NOT EXISTS idx_recurring_schedules_source_manual_journal ON recurring_schedules (source_manual_journal_id);
     ALTER TABLE recurring_schedules DROP CONSTRAINT IF EXISTS chk_recurring_source_matches_kind;
     -- guarded DO: ADD CONSTRAINT chk_recurring_source_matches_kind_v2 CHECK (
     --      (kind = 'INVOICE' AND source_invoice_id IS NOT NULL AND source_bill_id IS NULL AND source_journal_entry_id IS NULL AND source_manual_journal_id IS NULL)
     --   OR (kind = 'BILL'    AND source_bill_id IS NOT NULL AND source_invoice_id IS NULL AND source_journal_entry_id IS NULL AND source_manual_journal_id IS NULL)
     --   OR (kind = 'JOURNAL' AND source_invoice_id IS NULL AND source_bill_id IS NULL
     --                        AND num_nonnulls(source_journal_entry_id, source_manual_journal_id) = 1))
     ```
     A comment must say the old constraint is replaced by a strictly wider one (signed off in the approved plan). Replaying 075 cannot re-add it, because its `CREATE TABLE IF NOT EXISTS` is a no-op.
  8. **Backfill.** Use a temp mapping table so headers can be inserted as DRAFT, have their lines added, then be promoted. The line trigger refuses lines on a POSTED parent.
     ```sql
     CREATE TEMP TABLE _mj_backfill ON COMMIT DROP AS
       SELECT gen_random_uuid() AS mj_id, e.id AS entry_id, e.org_id, e.entry_date, e.created_by, e.created_at,
              e.source_type, e.source_id, e.description, e.description_template,
              r.id AS reversal_id, r.created_at AS reversal_created_at
         FROM journal_entries e
         LEFT JOIN journal_entries r ON r.org_id = e.org_id AND r.reverses_entry_id = e.id
                                    AND NOT EXISTS (SELECT 1 FROM recurring_runs rr WHERE rr.org_id = r.org_id AND rr.reversal_entry_id = r.id)
        WHERE e.source_type IN ('manual','recurring','migration_import')
          AND e.reverses_entry_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM manual_journals m WHERE m.journal_entry_id = e.id);
     INSERT INTO manual_journals (id, org_id, status, origin, narration, narration_template, entry_date,
                                  recurring_schedule_id, created_by, created_at)
       SELECT mj_id, org_id, 'DRAFT',
              CASE source_type WHEN 'manual' THEN 'MANUAL' WHEN 'recurring' THEN 'RECURRING' ELSE 'IMPORT' END,
              COALESCE(NULLIF(btrim(description), ''), 'Manual journal'), description_template, entry_date,
              CASE WHEN source_type = 'recurring' THEN source_id ELSE NULL END,
              created_by, created_at
         FROM _mj_backfill;
     INSERT INTO manual_journal_lines (org_id, manual_journal_id, line_number, account_id, debit_cents, credit_cents, created_at)
       SELECT b.org_id, b.mj_id,
              row_number() OVER (PARTITION BY l.journal_entry_id ORDER BY l.created_at, l.id),
              l.account_id, l.debit_cents, l.credit_cents, l.created_at
         FROM _mj_backfill b JOIN ledger_lines l ON l.org_id = b.org_id AND l.journal_entry_id = b.entry_id;
     UPDATE manual_journals m
        SET status = CASE WHEN b.reversal_id IS NULL THEN 'POSTED' ELSE 'VOIDED' END,
            journal_entry_id = b.entry_id, posted_at = b.created_at,
            void_journal_entry_id = b.reversal_id, voided_at = b.reversal_created_at
       FROM _mj_backfill b
      WHERE m.id = b.mj_id AND m.org_id = b.org_id;
     ```
     A recurring entry's `source_id` is the schedule id, as `generateOccurrence` writes it. If any `source_id` for `source_type='recurring'` does not match a schedule, the FK fails. **Stop and report** in that case; do not drop the FK.
- **Guardrails:**
  - rule 8: every `*_id` has a composite FK with explicit ON DELETE, and every FK/scope column is indexed
  - rule 13: idempotent, never edit 075/087
  - rule 3: BIGINT cents
  - rule 6: posted rows are immutable by trigger
- **Proof (all must pass):**
  1. `cd server && npm run migrate && npm run migrate`: both exit 0, and the second applies nothing.
  2. `cd server && npx vitest run src/__tests__/migrations.test.ts`: green (the replay test).
  3. `docker exec autodb_postgres psql -U autodb_user -d autodb -c "SELECT count(*) FROM journal_entries e WHERE e.source_type IN ('manual','recurring','migration_import') AND e.reverses_entry_id IS NULL AND NOT EXISTS (SELECT 1 FROM manual_journals m WHERE m.journal_entry_id = e.id)"` returns `0`.
  4. `docker exec autodb_postgres psql -U autodb_user -d autodb -c "SELECT count(*) FROM accounts WHERE code='1110' AND bank_account_kind IS DISTINCT FROM 'BANK' AND type='Asset'"` returns `0`.
- **If it fails:** a constraint violation in the backfill is a data finding. Report the offending rows; never loosen a CHECK to admit them. A checksum error means the file was already applied, so fix forward in `098`.
- **Owes:** the `docs/schema.md` block (paid in Step 22).

### Step 2 — [Haiku] Server types

- **Model:** [Haiku]. Transcription of literal types into one file, following the existing FSM idiom.
- **Depends on:** 1.
- **Skill:** none (types layer).
- **Read first:** `server/src/types/accounting.ts`, the `RECURRING_*` block (~1630–1648) and the `Account`, `LedgerLine`, `JournalEntry` and `RecurringSchedule` interfaces.
- **Files:** `server/src/types/accounting.ts` (edit).
- **Contract — add verbatim** (new block titled `// ------------------------------- Phase 44 — manual journals`):
  ```ts
  export const BANK_ACCOUNT_KINDS = ['BANK', 'CREDIT_CARD'] as const;
  export type BankAccountKind = (typeof BANK_ACCOUNT_KINDS)[number];
  export function isBankAccountKind(value: string): value is BankAccountKind {
    return (BANK_ACCOUNT_KINDS as readonly string[]).includes(value);
  }

  export const MANUAL_JOURNAL_STATUSES = ['DRAFT', 'TEMPLATE', 'POSTED', 'VOIDED'] as const;
  export type ManualJournalStatus = (typeof MANUAL_JOURNAL_STATUSES)[number];
  export const MANUAL_JOURNAL_STATUS_TRANSITIONS = {
    DRAFT: ['POSTED'],
    TEMPLATE: [],
    POSTED: ['VOIDED'],
    VOIDED: [],
  } as const satisfies Record<ManualJournalStatus, readonly ManualJournalStatus[]>;
  export function isManualJournalStatus(value: string): value is ManualJournalStatus {
    return (MANUAL_JOURNAL_STATUSES as readonly string[]).includes(value);
  }
  export function canTransitionManualJournal(from: ManualJournalStatus, to: ManualJournalStatus): boolean {
    return (MANUAL_JOURNAL_STATUS_TRANSITIONS[from] as readonly ManualJournalStatus[]).includes(to);
  }
  export const MANUAL_JOURNAL_ORIGINS = ['MANUAL', 'RECURRING', 'IMPORT'] as const;
  export type ManualJournalOrigin = (typeof MANUAL_JOURNAL_ORIGINS)[number];

  export interface ManualJournalLine {
    id: string;
    lineNumber: number;
    accountId: string | null;
    accountCode: string | null;
    accountName: string | null;
    description: string | null;
    debitCents: number;
    creditCents: number;
  }
  export interface ManualJournalSummary {
    id: string;
    status: ManualJournalStatus;
    origin: ManualJournalOrigin;
    narration: string;
    narrationTemplate: string | null;
    entryDate: string;
    journalEntryId: string | null;
    voidJournalEntryId: string | null;
    recurringScheduleId: string | null;
    /** Set on a TEMPLATE: the schedule that runs it. */
    templateScheduleId: string | null;
    postedAt: string | null;
    voidedAt: string | null;
    createdBy: string;
    createdByName: string | null;
    createdAt: string;
    updatedAt: string;
    totalDebitCents: number;
    totalCreditCents: number;
  }
  export interface ManualJournal extends ManualJournalSummary {
    lines: ManualJournalLine[];
  }
  ```
  Then also:
  - add `bankAccountKind: BankAccountKind | null;` to `Account`
  - add `description: string | null;` to `LedgerLine`
  - add `manualJournalId: string | null;` to `JournalEntry` (doc comment: "Phase 44 — the manual journal that owns this posting, if any")
  - add `sourceManualJournalId: string | null;` to `RecurringSchedule`
- **Guardrails:** rule 10 (one FSM table, mirroring the migration's CHECK exactly).
- **Proof:** `cd server && npm run typecheck`. This step **expects type errors** only in `accountService.ts`, `journalService.ts` and `recurringService.ts`, about the missing new fields. Steps 3, 4 and 8 fix them. Record the error count, and stop if errors appear in any other file.
- **If it fails:** an error outside those three files means a field name differs from this contract, so fix the name.
- **Owes:** nothing.

### Step 3 — [Sonnet] Accounts: `bankAccountKind` read, write and seed

- **Model:** [Sonnet]. It changes the default chart every new org gets, and validates against the account type.
- **Depends on:** 2.
- **Skill:** `new-module` (service layer edit).
- **Read first:** `server/src/services/accounting/accountService.ts` (all of it), `server/src/schemas/accounting/accountSchema.ts`, `server/src/controllers/accounting/accountController.ts`.
- **Files:** `accountService.ts` (edit), `schemas/accounting/accountSchema.ts` (edit), `controllers/accounting/accountController.ts` (edit only if it maps fields explicitly; if it passes the parsed body through, leave it alone).
- **Contract:**
  - In `AccountRow`, add `bank_account_kind: string | null`. In `ACCOUNT_COLUMNS`, add `bank_account_kind`. In `toAccount`, map `bankAccountKind`, re-validating with `isBankAccountKind`; an unknown value throws `Error('Unknown bank account kind "<v>" on account <id>')`.
  - Schema: `createAccountSchema` gains `bankAccountKind: z.enum(BANK_ACCOUNT_KINDS).nullable().default(null)`, and `updateAccountSchema` gains `bankAccountKind: z.enum(BANK_ACCOUNT_KINDS).nullable().optional()`.
  - Add a private helper `assertBankKindMatchesType(kind: BankAccountKind | null, type: AccountType): void`:
    - `BANK` on a non-Asset → `ApiError(422, 'Only an Asset account can be a bank account')`
    - `CREDIT_CARD` on a non-Liability → `ApiError(422, 'Only a Liability account can be a credit card account')`
  - `createAccountOnClient`: its input gains `bankAccountKind: BankAccountKind | null`. Call the helper, and add the column to the INSERT. `createAccount`'s input type gains the same field. Every other caller of `createAccountOnClient` (grep: chart import, item setup) passes `bankAccountKind: null`.
  - `updateAccount`: its input gains `bankAccountKind?: BankAccountKind | null | undefined`. When it is defined, call the helper with `existing.type`. Add `bankAccountKind: 'bank_account_kind'` to the `COLUMNS` map.
  - Seed: `SeedAccount` gains `bankAccountKind?: BankAccountKind`. In `DEFAULT_CHART`, the 1110 row gains `bankAccountKind: 'BANK'`. `seedDefaultChart` adds a 7th unnest array `$7::text[]` (`level.map((a) => a.bankAccountKind ?? null)`) and inserts it into `bank_account_kind`.
- **Guardrails:** rule 1 (every statement keeps `org_id`); rule 4 (the column name comes from the frozen `COLUMNS` map); rule 12 (no new type).
- **Proof:** `cd server && npm run typecheck` shows no errors in `accountService.ts` and no new errors elsewhere. Then `cd server && npx vitest run src/__tests__/accounting/accounts.test.ts` must not fail on the response shape. Failures caused **only** by a manual journal to 1110 are expected, and are fixed in Step 10.
- **If it fails:** do not make the column optional in the type to silence a caller; pass `null` at that caller.
- **Owes:** `docs/api.md` accounts rows (Step 22).

### Step 4 — [Sonnet] `journalService`: line descriptions, owner link, system-account guard

- **Model:** [Sonnet]. GL posting primitives and the guard every manual path depends on.
- **Depends on:** 2.
- **Skill:** `new-module` (service layer edit).
- **Read first:** `server/src/services/accounting/journalService.ts` lines 1–460 and 540–780.
- **Files:** `server/src/services/accounting/journalService.ts` (edit).
- **Contract:**
  - `JournalLineInput` gains `description?: string | null;`. `createEntryOnClient` adds `description` to its `ledger_lines` INSERT as a 10th unnest array (`$10::text[]`, `line.description ?? null`).
  - `reverseEntryOnClient`'s line copy adds `description` to both column lists (copied verbatim).
  - `LineRow` gains `description: string | null`. The `loadLines` SELECT adds `l.description`, and `toLine` maps it.
  - `EntryRow` gains `manual_journal_id: string | null`. `ENTRY_SELECT` adds `mj.id AS manual_journal_id` and `LEFT JOIN manual_journals mj ON mj.journal_entry_id = e.id AND mj.org_id = e.org_id`. Keep the org predicate inside the join condition, for the reason the existing comment gives. `toEntry` maps `manualJournalId`.
  - New exports:
    ```ts
    /** Phase 44 — entries the GL register may reverse directly (no owning document). */
    export const REVERSIBLE_SOURCE_TYPES: readonly string[] = ['manual', 'recurring', 'migration_import', 'opening_balance'];

    /**
     * Phase 44 — every account a manual journal may not touch, mapped to the 422
     * message for it: the control accounts (listControlAccountsOnClient, same
     * messages) plus every account flagged bank_account_kind.
     */
    export async function listManualJournalBlockedAccountsOnClient(
      client: Queryable,
      orgId: string,
    ): Promise<Map<string, string>>;

    /** Throws ApiError(422, <message>) for the first blocked account, in line order. */
    export async function assertManualJournalAccountsOnClient(
      client: Queryable,
      orgId: string,
      accountIds: string[],
    ): Promise<void>;
    ```
    - `listManualJournalBlockedAccountsOnClient` starts from `loadControlAccountsOnClient(...).map`. It then runs `SELECT id, code, bank_account_kind FROM accounts WHERE org_id = $1 AND bank_account_kind IS NOT NULL ORDER BY code` and adds each id that is not already present, with these messages:
      - BANK: `` `Account ${code} is a bank account — record money in or out of it through Banking (a bank-line journal or a payment), not a manual journal` ``
      - CREDIT_CARD: `` `Account ${code} is a credit card account — record money in or out of it through Banking (a bank-line journal or a payment), not a manual journal` ``
    - `assertManualJournalAccountsOnClient` first calls `assertNotControlAccountsOnClient` (keeping its precedence), then walks `accountIds` in order against the bank entries of the map.
  - **Do not** change `assertNotControlAccountsOnClient` or `listControlAccountsOnClient`. Bank-line journals and bank rules keep using them.
  - **Do not** touch `createEntry` / `reverseEntry` here. Step 7 removes them.
- **Guardrails:** rule 1 (`org_id` in the new query and in the join condition); rule 5 (`client` only); rule 7 (unchanged CHECKs still enforce one side).
- **Proof:** `cd server && npm run typecheck` shows no errors in `journalService.ts`. `cd server && npx vitest run src/__tests__/accounting/journals.test.ts src/__tests__/accounting/ledgerConstraints.test.ts` stays green, because nothing calls the new guard yet.
- **If it fails:** a fan-out (duplicate entries in the register) means the LEFT JOIN is matching more than one row. The `ux_manual_journals_journal_entry` partial unique index guarantees at most one, so check the join keys; never add `DISTINCT`.
- **Owes:** nothing (docs in Step 22).

---

## Slice 2 — Manual journal service, routes, recurring and import integration

Outcome: `/api/v1/manual-journals` supports draft, edit, delete, post and void. `POST /journals` and the recurring and import paths all create manual journals. The GL reverse route is guarded.

**Names — use exactly these, do not rename:**
| Kind | Name |
|---|---|
| Service | `server/src/services/accounting/manualJournalService.ts` |
| Service exports | `listManualJournals`, `getManualJournalById`, `createManualJournal`, `updateManualJournal`, `deleteManualJournal`, `postManualJournal`, `voidManualJournal`, `postNewManualJournalOnClient`, `createTemplateOnClient`, `reverseOrVoidEntry` |
| Schema file / exports | `server/src/schemas/accounting/manualJournalSchema.ts` → `manualJournalBodySchema`, `createManualJournalSchema`, `voidManualJournalSchema`, `createRepeatingJournalSchema`, `listManualJournalsQuerySchema` |
| Controller / exports | `server/src/controllers/accounting/manualJournalController.ts` → `list`, `getOne`, `create`, `update`, `remove`, `post`, `voidJournal`, `createRepeating` |
| Routes | `server/src/routes/accounting/manualJournalRoutes.ts`, mounted at `/manual-journals` in `routes/accounting/index.ts` |
| Recurring export | `recurringService.createRepeatingJournal` |
| Tests | `server/src/__tests__/accounting/manualJournals.test.ts`, `server/src/__tests__/accounting/manualJournalIsolation.test.ts` |

**Route table (base `/api/v1/manual-journals`; every route `authenticate` first):**
| Method | Path | Permission(s) | Body / query | Success | Failures |
|---|---|---|---|---|---|
| GET | `/` | `journals.view` | `?status=all\|draft\|posted\|voided` (default `all`), `q` (≤200), `from`, `to`, `page`, `limit` | `200 {success, count, totalCount, currentPage, totalPages, counts:{all,draft,posted,voided}, journals: ManualJournalSummary[]}` | `400` bad query |
| GET | `/:id` | `journals.view` | — | `200 {success, journal}` | `404 'Manual journal not found'` |
| POST | `/` | `journals.create` | `{narration, entryDate, lines, action: 'draft'\|'post'}` | `201 {success, journal}` | `400` validation; `422` post-time rules |
| PATCH | `/:id` | `journals.create` | `{narration, entryDate, lines}` (full replacement) | `200 {success, journal}` | `404`; `409 'Only a draft or a repeating template can be edited'`; `422` template rules |
| DELETE | `/:id` | `journals.create` | — | `204` | `404`; `409 'Only a draft can be deleted'` |
| POST | `/:id/post` | `journals.create` | — | `200 {success, journal}` | `404`; `409 'Only a draft can be posted'`; `422` post-time rules |
| POST | `/:id/void` | `journals.create` | `{voidDate?: date\|null}` | `200 {success, journal}` | `404`; `409 'Only a posted journal can be voided'`; `409 'Entry has already been reversed'`; `422` closed period |
| POST | `/repeating` | `journals.create`, then `recurring.manage` | see Step 6 schema | `201 {success, journal, schedule}` | `400`; `422` template rules |

Register `/repeating` **before** `/:id` routes.

**Post-time rules — exact 422 messages, checked in this order, 1-based line numbers:**
1. Fewer than 2 lines → `'A journal needs at least two lines'`
2. A line with `accountId === null` → `` `Line ${n} has no account` ``
3. A line with both sides 0 → `` `Line ${n} needs a debit or a credit` ``. (Both sides > 0 is already a 400 from the schema and a CHECK.)
4. Debits ≠ credits (integer equality) → `` `Journal is unbalanced: debits ${d}, credits ${c}` ``
5. `assertManualJournalAccountsOnClient` (its own messages)
6. The placeholder fill and `createEntryOnClient` (period closed, non-postable account: their own messages)

### Step 5 — [Sonnet] `manualJournalService.ts`

- **Model:** [Sonnet]. Posting to the GL, the document/entry transaction boundary, lock order, and the FSM.
- **Depends on:** 1, 2, 4.
- **Skill:** `new-module` (service layer).
- **Read first:** `server/src/services/accounting/billService.ts` (draft create, update and delete; `FOR UPDATE`; pg error mapping); `journalService.ts` `createEntry` (~626, the error mapping to copy) and `buildFilters`/`listEntries` (~236–300, the filter and ILIKE idiom to copy); `server/src/db/transaction.ts` (`withTransaction`, `beginTransaction`).
- **Files:** `server/src/services/accounting/manualJournalService.ts` (new).
- **Contract — signatures, written literally:**
  ```ts
  export interface ManualJournalLineInput { accountId: string | null; description: string | null; debitCents: number; creditCents: number; }
  export interface ManualJournalInput { narration: string; entryDate: string; lines: ManualJournalLineInput[]; }
  export type ManualJournalListStatus = 'all' | 'draft' | 'posted' | 'voided';
  export interface ListManualJournalsOptions { status: ManualJournalListStatus; q: string | null; from: string | null; to: string | null; page: number; limit: number; }

  export async function listManualJournals(orgId: string, opts: ListManualJournalsOptions):
    Promise<{ journals: ManualJournalSummary[]; totalCount: number; counts: { all: number; draft: number; posted: number; voided: number } }>;
  export async function getManualJournalById(orgId: string, id: string): Promise<ManualJournal>;
  export async function createManualJournal(orgId: string, createdBy: string, input: ManualJournalInput, action: 'draft' | 'post'): Promise<ManualJournal>;
  export async function updateManualJournal(orgId: string, id: string, input: ManualJournalInput): Promise<ManualJournal>;
  export async function deleteManualJournal(orgId: string, id: string): Promise<void>;
  export async function postManualJournal(orgId: string, userId: string, id: string): Promise<ManualJournal>;
  export async function voidManualJournal(orgId: string, userId: string, id: string, voidDate: string | null): Promise<ManualJournal>;

  /** Insert a DRAFT with its lines, then post it — on the caller's transaction. */
  export async function postNewManualJournalOnClient(
    client: PoolClient, orgId: string, createdBy: string,
    input: ManualJournalInput & {
      origin: ManualJournalOrigin;
      recurringScheduleId: string | null;
      sourceType: 'manual' | 'recurring' | 'migration_import';
      sourceId: string | null;
      occurrence: number | null;
    },
  ): Promise<{ manualJournalId: string; journalEntryId: string }>;

  /** Insert a TEMPLATE (validated by post-time rules 1–5) — on the caller's transaction. */
  export async function createTemplateOnClient(client: PoolClient, orgId: string, createdBy: string, input: ManualJournalInput): Promise<string>;

  /** The GL register's POST /journals/:id/reverse. Returns the reversal entry id. */
  export async function reverseOrVoidEntry(orgId: string, userId: string, entryId: string, entryDate: string | null): Promise<string>;
  ```
- **Behaviour (literal):**
  - **Reads.**
    - One shared `SELECT` fragment: `m.*` columns, `u.name AS created_by_name` (`LEFT JOIN users u ON u.id = m.created_by`), totals from `LEFT JOIN LATERAL (SELECT sum(debit_cents) AS d, sum(credit_cents) AS c FROM manual_journal_lines l WHERE l.org_id = m.org_id AND l.manual_journal_id = m.id) t ON true`, and `(SELECT s.id FROM recurring_schedules s WHERE s.org_id = m.org_id AND s.source_manual_journal_id = m.id LIMIT 1) AS template_schedule_id`.
    - Totals go through `parseCents(String(x ?? '0'))`.
    - Status filter map (constant, rule 4): `all → m.status <> 'TEMPLATE'`, `draft → m.status = 'DRAFT'`, `posted → m.status = 'POSTED'`, `voided → m.status = 'VOIDED'`.
    - `q` is an ILIKE on `m.narration`, copying `journalService`'s escaping idiom.
    - Order: `m.entry_date DESC, m.created_at DESC`. Use LIMIT/OFFSET.
    - `counts` is one query with `count(*) FILTER (WHERE …)` using the same q/from/to predicates and **no** status predicate.
    - Lines: one query for all ids (`ORDER BY line_number`), joined to `accounts a ON a.id = l.account_id AND a.org_id = l.org_id` as a **LEFT** join, because a draft line may have no account.
    - Status and origin are re-validated with `isManualJournalStatus` and a literal origin check (throw `Error` on an unknown value, like `toSchedule`).
  - **Validation shared by create and update:** `entryDate` and `narration` are already validated by the schema. `lines.length` must be 1–200, otherwise `ApiError(422, 'A journal has between 1 and 200 lines')`. Every non-null `accountId` must exist in this org (`SELECT id FROM accounts WHERE org_id=$1 AND id = ANY($2)`), otherwise `ApiError(422, 'Account not found')`.
  - **`createManualJournal`** runs in `withTransaction`:
    - Insert the header with status `'DRAFT'`, origin `'MANUAL'`, narration as typed, `narration_template NULL`.
    - Insert lines via one `unnest` INSERT, `line_number` = index+1.
    - If `action==='post'`, call the private `postDraftOnClient(client, orgId, createdBy, id, {sourceType:'manual', sourceId:null, occurrence:null})`.
    - Return `getManualJournalById` **after** commit.
  - **`updateManualJournal`** runs in `withTransaction`:
    - `SELECT status FROM manual_journals WHERE id=$1 AND org_id=$2 FOR UPDATE`. Missing → 404. Status not in DRAFT/TEMPLATE → 409.
    - If TEMPLATE, run post-time rules 1–5 on the input (the private `assertPostableOnClient`).
    - `UPDATE` narration and entry_date; `DELETE FROM manual_journal_lines WHERE org_id=$1 AND manual_journal_id=$2`; re-insert the lines.
  - **`deleteManualJournal`**: lock as above. Status ≠ DRAFT → 409 `'Only a draft can be deleted'`. Then `DELETE FROM manual_journals WHERE id=$1 AND org_id=$2` (lines cascade).
  - **Private `postDraftOnClient(client, orgId, userId, id, ctx)`:**
    1. `SELECT narration, entry_date, status FROM manual_journals WHERE id=$1 AND org_id=$2 FOR UPDATE`. Status must satisfy `canTransitionManualJournal(status,'POSTED')`, otherwise `409 'Only a draft can be posted'`.
    2. Load the lines and apply post-time rules 1–5 in order.
    3. `const filled = await journalService.fillJournalDescriptionOnClient(client, orgId, narration, entryDate, 'JOURNAL', ctx.occurrence);`
    4. `const entryId = await journalService.createEntryOnClient(client, orgId, userId, { entryDate, description: filled.description, descriptionTemplate: filled.descriptionTemplate, sourceType: ctx.sourceType, sourceId: ctx.sourceId, lines: lines.map(l => ({ accountId: l.accountId!, description: l.description, debitCents: l.debitCents, creditCents: l.creditCents })) });`. Use a narrowed local after rule 2, not a `!` assertion.
    5. `UPDATE manual_journals SET status='POSTED', journal_entry_id=$3, posted_at=now(), narration=$4, narration_template=$5 WHERE id=$1 AND org_id=$2` with `filled.description` and `filled.descriptionTemplate`.
  - **`postManualJournal`**: `withTransaction` → `postDraftOnClient(..., {sourceType:'manual', sourceId:null, occurrence:null})`.
  - **`postNewManualJournalOnClient`**:
    - Insert the header with `status 'DRAFT'`, the given `origin` and `recurring_schedule_id`, and narration as typed.
    - Insert the lines.
    - `postDraftOnClient` with the ctx from the input.
    - Return `{manualJournalId, journalEntryId}`.
  - **`createTemplateOnClient`**: validate the line count and accounts as in create, run post-time rules 1–5, then insert with `status 'TEMPLATE'`, `origin 'MANUAL'`, and insert the lines.
  - **Private `voidOnClient(client, orgId, userId, id, voidDate)`:**
    - Lock the row; status must allow `→ VOIDED`, otherwise `409 'Only a posted journal can be voided'`.
    - `const reversalId = await journalService.reverseEntryOnClient(client, orgId, userId, journalEntryId, voidDate);`
    - `UPDATE manual_journals SET status='VOIDED', void_journal_entry_id=$3, voided_at=now() WHERE id=$1 AND org_id=$2`.
    - Return `reversalId`.
  - **`voidManualJournal`**: `withTransaction` → `voidOnClient`, then `getManualJournalById`.
  - **`reverseOrVoidEntry`** runs in `withTransaction`:
    1. `SELECT id FROM manual_journals WHERE org_id=$1 AND journal_entry_id=$2 FOR UPDATE`. If found → return `voidOnClient(...)`.
    2. Otherwise `SELECT source_type FROM journal_entries WHERE id=$1 AND org_id=$2`. Missing → `404 'Journal entry not found'`.
    3. If `!journalService.REVERSIBLE_SOURCE_TYPES.includes(source_type)` → `` 409 `This entry was posted by a ${source_type} document — correct it from that document instead` ``.
    4. Otherwise return `journalService.reverseEntryOnClient(client, orgId, userId, entryId, entryDate)`.
  - **Error mapping**, around every public write: copy `journalService.createEntry`'s catch.
    - `P0001` → `ApiError(422, message)`
    - `23505` on the reversal index → `ApiError(409, 'Entry has already been reversed')`
    - `0A000` → `ApiError(409, message)`
- **Lock order** (state it in the file's header comment): manual_journals row → (inside `createEntryOnClient`) period/settings reads → journal_entries insert. For recurring, the schedule row comes first (Step 8).
- **Guardrails:**
  - rule 1: every statement has `org_id`
  - rule 5: everything inside a transaction uses `client`, with no `pool.query` there
  - rule 6: no UPDATE of a POSTED row other than the void transition
  - rule 10: transitions are checked only via `canTransitionManualJournal`
  - rule 3: integer sums via `sumCents`
- **Proof:** `cd server && npm run typecheck` shows no errors in this file. `grep -c "org_id" server/src/services/accounting/manualJournalService.ts` should be ≥ the number of SQL statements, and `grep -n "pool.query" server/src/services/accounting/manualJournalService.ts` should show only read functions (`listManualJournals` and `getManualJournalById`).
- **If it fails:** a cycle error means this file imported `recurringService`. It must not.
- **Owes:** nothing (tests in Step 11).

### Step 6 — [Haiku] Schema, controller, routes and mount for `/manual-journals`

- **Model:** [Haiku]. Thin layers whose contracts are fully specified above; the analogues are the bill files.
- **Depends on:** 5. (The `createRepeating` handler compiles against Step 8's export. Write it now, and expect one typecheck error naming `createRepeatingJournal` until Step 8 lands.)
- **Skill:** `new-module` (controller, routes, mount).
- **Read first:** `server/src/schemas/accounting/journalSchema.ts`, `server/src/controllers/accounting/billController.ts` (list, remove → 204), `server/src/routes/accounting/billRoutes.ts`, `server/src/routes/accounting/index.ts`, `server/src/utils/queryParam.ts`.
- **Files:** `schemas/accounting/manualJournalSchema.ts` (new), `controllers/accounting/manualJournalController.ts` (new), `routes/accounting/manualJournalRoutes.ts` (new), `routes/accounting/index.ts` (edit: `router.use('/manual-journals', manualJournalRoutes)` next to the `/journals` mount).
- **Contract — the schema, verbatim:**
  ```ts
  const lineSchema = z.object({
    accountId: z.uuid().nullable().default(null),
    description: z.string().trim().max(500).nullable().default(null),
    debitCents: z.int().nonnegative().default(0),
    creditCents: z.int().nonnegative().default(0),
  }).refine((l) => !(l.debitCents > 0 && l.creditCents > 0), { message: 'A line cannot have both a debit and a credit' });

  export const manualJournalBodySchema = z.object({
    narration: z.string().trim().min(1, 'Narration is required').max(500),
    entryDate: z.iso.date(),
    lines: z.array(lineSchema).min(1).max(200),
  });
  export const createManualJournalSchema = manualJournalBodySchema.extend({ action: z.enum(['draft', 'post']) });
  export const voidManualJournalSchema = z.object({ voidDate: z.iso.date().nullable().default(null) });
  export const createRepeatingJournalSchema = manualJournalBodySchema.extend({
    name: z.string().trim().min(1).max(80),
    frequency: z.enum(['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY']),
    intervalCount: z.int().min(1).max(12).default(1),
    startDate: z.iso.date(),
    endDate: z.iso.date().nullable().default(null),
    autoReverse: z.boolean().default(false),
  }).refine((v) => v.endDate === null || v.endDate >= v.startDate, { message: 'endDate must not be before startDate' });
  export const listManualJournalsQuerySchema = z.object({ status: z.enum(['all', 'draft', 'posted', 'voided']).default('all') });
  ```
  Controller handlers follow the route table exactly.
  - `list`: `readPagination`, `optionalIsoDate(req,'from'|'to')`, `optionalText(req,'q',200)`, and `parseBody(listManualJournalsQuerySchema, req.query)` for status. Response keys are as in the table; `totalPages = Math.max(1, Math.ceil(totalCount / limit))`.
  - `remove`: `res.status(204).end()`.
  - `voidJournal`: body `req.body ?? {}`.
  - `createRepeating`:
    - call `recurringService.createRepeatingJournal(user.orgId, user.id, input)`
    - respond `201 {success:true, journal, schedule}`
  - The routes file header comment says: no PUT; PATCH and DELETE apply to drafts only, which the service and the trigger enforce (rule 6).
- **Guardrails:** rule 2 (no SQL in the controller); rule 1 (`orgId` only from `requireUser(req)`).
- **Proof:** `cd server && npm run typecheck`. The only allowed error is the missing `recurringService.createRepeatingJournal` (until Step 8). `cd server && npx vitest run src/__tests__/platform` stays green, including the router-walking "every route is gated" test (`grep -rln "allowAnyMember" src/__tests__` locates it if the folder differs).
- **If it fails:** an ungated-route failure means a route is missing `requirePermission`. Add it; never `allowAnyMember`.
- **Owes:** `docs/api.md` (Step 22).

### Step 7 — [Sonnet] Rewire `POST /journals` and `POST /journals/:id/reverse`; remove `createEntry`/`reverseEntry`

- **Model:** [Sonnet]. Changes the existing public GL routes, and fixes the direct-reverse bug.
- **Depends on:** 5.
- **Skill:** none (refactor).
- **Read first:** `server/src/controllers/accounting/journalController.ts`, `server/src/__tests__/integrity.test.ts` lines 55–90, `server/src/__tests__/platform/auditActor.test.ts` lines 170–200.
- **Files:** `controllers/accounting/journalController.ts` (edit), `services/accounting/journalService.ts` (edit: delete `createEntry` and `reverseEntry`, and update the file header comment), `__tests__/integrity.test.ts` (edit), `__tests__/platform/auditActor.test.ts` (edit), `schemas/accounting/journalSchema.ts` (edit: header comment only).
- **Contract:**
  - `journalController.create`:
    - parse `createJournalSchema` (unchanged)
    - call `manualJournalService.createManualJournal(user.orgId, user.id, { narration: input.description ?? 'Manual journal', entryDate: input.entryDate, lines: input.lines.map(l => ({ accountId: l.accountId, description: null, debitCents: l.debitCents, creditCents: l.creditCents })) }, 'post')`
    - then `const entry = await journalService.getEntryById(user.orgId, journal.journalEntryId as string)`. Narrow with an `if (journal.journalEntryId === null) throw new Error('Posted manual journal has no entry')`, not `as`.
    - respond `201 {success, entry}` (shape unchanged)
  - `journalController.reverse`: `const reversalId = await manualJournalService.reverseOrVoidEntry(user.orgId, user.id, id, entryDate);`, then `getEntryById(orgId, reversalId)`, then `201 {success, entry}` (unchanged).
  - The two tests call `manualJournalService.createManualJournal(orgA, userA.id, { narration: <the description they used, or 'Manual journal' if null>, entryDate, lines: <same lines, with description: null> }, 'post')` instead of `journalService.createEntry`. Keep every assertion. If an assertion depends on the audit rows for `journal_entries` only, it still holds, because a journal entry is still inserted.
  - `grep -rn "journalService.createEntry\b\|journalService.reverseEntry\b" server/src` must return only comments. Update those comments (`db/transaction.ts:49`, `invoiceService.ts:44`, `journalSchema.ts:12`) to name `manualJournalService`.
- **Guardrails:** rule 6 (the reverse path for owned entries is now a void, keeping document and entry consistent); rule 16 (a document-owned entry is corrected through its document).
- **Proof:** `cd server && npm run typecheck` (only the Step 6 allowance remains). Then `cd server && npx vitest run src/__tests__/accounting/journals.test.ts src/__tests__/accounting/periodLock.test.ts src/__tests__/accounting/accountLedger.test.ts src/__tests__/integrity.test.ts src/__tests__/platform/auditActor.test.ts`. Failures caused **only** by the new bank-account refusal of 1110 are deferred to Step 10. List them in the step report. Any other failure stops the step.
- **If it fails:** a test asserting `entry.description === null` after `POST /journals` with no description is a real contract change. Stop and report; do not edit it here.
- **Owes:** nothing.

### Step 8 — [Sonnet] Recurring: template schedules, runs through manual journals

- **Model:** [Sonnet]. Exactly-once job generation, a transaction boundary that crosses two services, and a replaced CHECK.
- **Depends on:** 5, 6.
- **Skill:** none (service change). The `isolation-test` skill applies in Step 11.
- **Read first:** `server/src/services/accounting/recurringService.ts` (all of it); `075_ledger-core_recurring_schedules.sql`.
- **Files:** `services/accounting/recurringService.ts` (edit), `schemas/accounting/recurringScheduleSchema.ts` (no change; confirm only).
- **Contract:**
  - `SCHEDULE_SELECT`:
    - `COALESCE(s.source_invoice_id, s.source_bill_id, s.source_journal_entry_id, s.source_manual_journal_id) AS source_id`
    - plus `s.source_manual_journal_id`
    - `ScheduleRow` and `toSchedule` gain `sourceManualJournalId`
  - `createSchedule`, legacy JOURNAL branch: replace `journalService.assertNotControlAccountsOnClient` with `journalService.assertManualJournalAccountsOnClient`. Nothing else changes.
  - New export:
    ```ts
    export interface CreateRepeatingJournalInput {
      name: string; narration: string; lines: ManualJournalLineInput[];
      frequency: RecurringFrequency; intervalCount: number; startDate: string; endDate: string | null; autoReverse: boolean;
    }
    export async function createRepeatingJournal(orgId: string, createdBy: string, input: CreateRepeatingJournalInput):
      Promise<{ journal: ManualJournal; schedule: RecurringSchedule }>;
    ```
    - The controller (Step 6) passes the parsed body as-is: its extra `entryDate` key is structurally allowed (TypeScript rejects excess properties only on object literals). The template's `entry_date` is `input.startDate`.
    - The body runs in one `withTransaction`:
      - `const templateId = await manualJournalService.createTemplateOnClient(client, orgId, createdBy, { narration, entryDate: startDate, lines });`
      - then `INSERT INTO recurring_schedules (org_id, kind, name, source_manual_journal_id, frequency, interval_count, start_date, end_date, next_run_date, next_occurrence_index, mode, auto_reverse, created_by) VALUES ($1,'JOURNAL',$2,$3,$4,$5,$6,$7,$6,0,'POST',$8,$9) RETURNING id`
    - After commit, return `{ journal: await manualJournalService.getManualJournalById(orgId, templateId), schedule: <SCHEDULE_SELECT row via pool> }`.
  - `PreReadRow` and its SELECT gain `source_manual_journal_id`.
  - `Template` gains a variant `{ kind: 'JOURNAL_TEMPLATE'; journal: ManualJournal }`. In `loadTemplate`, kind `JOURNAL`: when `pre.source_manual_journal_id !== null`, return `{kind:'JOURNAL_TEMPLATE', journal: await manualJournalService.getManualJournalById(orgId, pre.source_manual_journal_id)}`; otherwise use the existing entry path.
  - `generateOccurrence`, JOURNAL and JOURNAL_TEMPLATE branches: replace the `fillJournalDescriptionOnClient` + `createEntryOnClient` pair with
    ```ts
    const narration = template.kind === 'JOURNAL_TEMPLATE'
      ? template.journal.narration
      : (template.entry.descriptionTemplate ?? template.entry.description ?? 'Manual journal');
    const lines = template.kind === 'JOURNAL_TEMPLATE'
      ? template.journal.lines.map((l) => ({ accountId: l.accountId, description: l.description, debitCents: l.debitCents, creditCents: l.creditCents }))
      : template.entry.lines.map((l) => ({ accountId: l.accountId, description: l.description, debitCents: l.debitCents, creditCents: l.creditCents }));
    const { journalEntryId } = await manualJournalService.postNewManualJournalOnClient(client, orgId, userId, {
      narration, entryDate: runDate, lines, origin: 'RECURRING', recurringScheduleId: scheduleId,
      sourceType: 'recurring', sourceId: scheduleId, occurrence,
    });
    ```
    - Keep the auto-reverse block unchanged (`reverseEntryOnClient(..., journalEntryId, firstDayOfNextMonth(runDate))`). The manual journal stays POSTED, because an auto-reversal is not a void. This is why the migration backfill excludes `recurring_runs.reversal_entry_id`.
  - A run whose template now touches a bank or control account fails through the existing `runDueOccurrences` error path. It records `last_error`, and the schedule stays ACTIVE. Do not special-case this.
- **Guardrails:**
  - rule 5: the template and the schedule commit together, and a run's manual journal, entry, reversal and `recurring_runs` row commit together
  - rule 10: `canTransitionRecurring` is unchanged
  - rule 1
- **Proof:** `cd server && npm run typecheck` exits 0, with no remaining allowances. `cd server && npx vitest run src/__tests__/accounting/recurringSchedules.test.ts src/__tests__/accounting/recurringConstraints.test.ts src/__tests__/accounting/documentPlaceholders.test.ts`: green, except failures caused only by the 1110 refusal (deferred to Step 10, and listed).
- **If it fails:** a duplicate `recurring_runs` row or a deadlock means the lock order changed. The schedule row (`FOR UPDATE SKIP LOCKED`) must be taken before `postNewManualJournalOnClient`. Restore that order; never add retries.
- **Owes:** nothing.

### Step 9 — [Sonnet] Journal import posts manual journals and refuses bank accounts

- **Model:** [Sonnet]. Import commit inside a transaction, with a changed validation source.
- **Depends on:** 5.
- **Skill:** none.
- **Read first:** `server/src/services/accounting/journalImportService.ts` (all of it).
- **Files:** `services/accounting/journalImportService.ts` (edit).
- **Contract:**
  - `validateRows`: `listControlAccountsOnClient` → `listManualJournalBlockedAccountsOnClient` (same `Map<string,string>` contract, so row errors carry the new bank messages unchanged).
  - In commit, replace the `createEntryOnClient({... sourceType:'migration_import', sourceId: importId ...})` call with `manualJournalService.postNewManualJournalOnClient(client, orgId, createdBy, { narration, entryDate: date, lines: lines.map(l => ({ ...l, description: null })), origin: 'IMPORT', recurringScheduleId: null, sourceType: 'migration_import', sourceId: importId, occurrence: null })`.
  - Keep the existing `try/catch` that prefixes `The ${label} (${rowSpan}): `.
  - Import placeholders: `postDraftOnClient` now fills placeholders in imported narrations. This is intended: the import is a manual journal, and Phase 40 says no placeholder reaches a posted row.
- **Guardrails:** rule 5; rule 16 (no direct SQL into another service's tables; the manual journal service owns its own).
- **Proof:** `cd server && npx vitest run src/__tests__/accounting/journalImport.test.ts`: green, except the 1110-only failures (deferred to Step 10, listed).
- **If it fails:** stop and report. Do not revert to `createEntryOnClient`.
- **Owes:** nothing.

### Step 10 — [Sonnet] Existing-test sweep for the bank-account refusal

- **Model:** [Sonnet]. Judgment about what each test is asserting; this is the only sanctioned edit of existing assertions.
- **Depends on:** 3, 7, 8, 9.
- **Skill:** none.
- **Read first:** `server/src/__tests__/helpers/accountingFixtures.ts`. Then each failing test file in full before editing it.
- **Files:** only `server/src/__tests__/**` files that fail with one of the two Step 4 bank messages (about 23 candidates use 1110; most use it for payments and will not fail). Also `server/src/__tests__/helpers/factories.ts` (edit: add `manual_journals, manual_journal_lines` to the `resetTables` TRUNCATE list, right after `recurring_schedules, recurring_runs`).
- **Contract — the replacement rule, applied per failing call, in order:**
  1. If the test's purpose is the journal mechanics, a report total or a non-cash balance, change that journal line's account code from `1110` to `1130` (Prepaid Expenses, Asset, postable). Update **only** the assertions that read that line's balance, to the identical numbers on 1130.
  2. If the test asserts a **cash** figure (the dashboard cash tile, the cash account balance, or a balance-sheet cash row), seed the cash with `issueInvoice` + `receivePayment` from `accountingFixtures.ts` instead of the journal. Update the dependent revenue and AR expectations to the new, hand-computed integer values. Write the arithmetic in a one-line comment.
  3. If neither fits, **stop and report the file and test name.**
  - Never change a production file in this step, and never relax a status-code assertion.
- **Proof:** `cd server && npm test` is green, with exactly 2 skipped (the pre-existing gated live-provider cases). Record the passing count in this file under Step 10.
- **If it fails:** a failure unrelated to the refusal means an earlier step regressed. Stop and report it with the step it points to.
- **Owes:** nothing.
- **Result (executed):** `cd server && npm test` → 181 files passed, **2261 passed | 2 skipped (2263)**. Files edited (1110 → 1130 per rule 1, except where noted): `periodLock`, `journalImport`, `reports`, `settings`, `statements`, `organizations`; `dashboard` (helper → 1130; the cash-tile test seeds cash with `createCustomer`+`issueInvoice`+`receivePayment`, rule 2); `bankReconciliation` (the "never imported" cash movement is now an invoice + `receivePayment`, rule 2); `helpers/factories.ts` (TRUNCATE list). One production fix made during Step 7: `voidOnClient` throws `409 'Entry has already been reversed'` for an already-VOIDED journal (the route table lists it, and `journals.test.ts` asserts it through `POST /journals/:id/reverse`).

### Step 11 — [Sonnet] New integration tests

- **Model:** [Sonnet]. Real-Postgres tests covering triggers, rollback, the FSM, recurring and isolation.
- **Depends on:** 10.
- **Skill:** `isolation-test`.
- **Read first:** `server/src/__tests__/accounting/journals.test.ts` (setup and agent idiom), `server/src/__tests__/accounting/recurringSchedules.test.ts` (how a run is forced: `POST /recurring-schedules/:id/run`), `server/src/__tests__/accounting/controlAccountGuard.test.ts`.
- **Files:** `server/src/__tests__/accounting/manualJournals.test.ts` (new), `server/src/__tests__/accounting/manualJournalIsolation.test.ts` (new), `server/src/__tests__/accounting/accounts.test.ts` (edit: append the bank-kind cases).
- **Contract — exact cases.** `M` = `/api/v1/manual-journals`. Accounts come from `accountId(orgId, code)`. "Balanced pair" = DR 6100-or-any-postable-Expense 10000 / CR 2120 10000. Look the codes up in `DEFAULT_CHART` and use real codes.

  `manualJournals.test.ts`:
  - `POST M action=draft with one unbalanced line → 201, status DRAFT, journalEntryId null`
  - `POST M action=draft with an empty line (no account, 0/0) → 201`
  - `PATCH M/:id on a draft replaces narration and lines → 200, lines.length equals the new count`
  - `DELETE M/:id on a draft → 204, then GET → 404`
  - `POST M/:id/post on an unbalanced draft → 422 'Journal is unbalanced: debits 10000, credits 5000'`, and the draft is still DRAFT
  - `POST M/:id/post on a draft with a line missing an account → 422 'Line 2 has no account'`
  - `POST M action=post balanced → 201, status POSTED, GET /journals/:journalEntryId shows manualJournalId = journal id and line descriptions`
  - `narration 'Accrual [Month]' dated 2026-03-15 posts as 'Accrual March' with narrationTemplate 'Accrual [Month]'`
  - `PATCH and DELETE on a POSTED journal → 409`
  - `POST M/:id/void → 200, VOIDED, voidJournalEntryId set, trial balance nets to zero for both accounts`
  - `void twice → 409`
  - `posting to 1110 → 422` with the BANK message; `posting to an account flagged CREDIT_CARD → 422` with the CREDIT_CARD message; `posting to 1120 → 422` with the receivable message (unchanged text)
  - `posting into a locked period → 422`, and the draft stays DRAFT (rollback)
  - `SQL UPDATE manual_journals SET narration='x' on a POSTED row → rejects with code 0A000` (via `pool.query`, assert `rejects.toMatchObject({ code: '0A000' })`)
  - `SQL INSERT into manual_journal_lines for a POSTED journal → 0A000`
  - `GET M?status=draft returns only drafts; counts.all excludes TEMPLATE rows`
  - `POST /journals/:entryId/reverse on a manual journal's entry → 201, and the manual journal is VOIDED`
  - `POST /journals/:invoiceEntryId/reverse on an issued invoice's entry → 409` (use `issueInvoice`)
  - `POST /journals (legacy shorthand) → 201 and a POSTED manual journal exists for the entry`
  - `POST M/repeating (monthly, startDate today, autoReverse true) → 201; journal.status TEMPLATE; schedule.sourceManualJournalId = journal.id`
  - `running that schedule → a POSTED manual journal with origin RECURRING and recurringScheduleId set; its reversal dated the 1st of next month; the manual journal stays POSTED`
  - `PATCH on the TEMPLATE with an unbalanced body → 422; a balanced body → 200, and the next run uses the new lines`
  - `POST M/repeating whose lines include 1110 → 422`, and no schedule row exists (rollback)

  `manualJournalIsolation.test.ts`: org A creates a draft and a posted journal. Under org B's token, each of these returns `404` and does not appear in org B's `GET M`:
  - `GET M/:id`
  - `PATCH M/:id`
  - `DELETE M/:id`
  - `POST M/:id/post`
  - `POST M/:id/void`

  `accounts.test.ts` additions:
  - `new org: 1110 has bankAccountKind 'BANK'`
  - `PATCH an Expense account bankAccountKind BANK → 422 'Only an Asset account can be a bank account'`
  - `create a Liability with CREDIT_CARD → 201`
  - `PATCH bankAccountKind null on 1110 → 200, and a manual journal to 1110 then posts`
- **Guardrails:** rule 15 (the cross-tenant test exists for this module).
- **Proof:** `cd server && npx vitest run src/__tests__/accounting/manualJournals.test.ts src/__tests__/accounting/manualJournalIsolation.test.ts src/__tests__/accounting/accounts.test.ts` is green, then `cd server && npm test` is green (2 skipped).
- **If it fails:** the test is the spec; fix the code in the step it points to (5, 7 or 8) under that step's rules.
- **Owes:** nothing.

---

## Slice 3 — Client

Outcome: the Manual Journals page with tabs, the draft/post form with Save & add another, the detail page with post/void, the new-repeating-journal page, the General journal report, and the bank-account toggle.

**Names — use exactly these, do not rename:**
| Kind | Name |
|---|---|
| fetchServices types | `BankAccountKind`, `ManualJournalStatus`, `ManualJournalOrigin`, `ManualJournalLine`, `ManualJournalSummary`, `ManualJournal`, `ManualJournalInput`, `ManualJournalListParams`, `CreateRepeatingJournalInput` |
| fetchServices functions | `listManualJournals`, `getManualJournal`, `createManualJournal`, `updateManualJournal`, `deleteManualJournal`, `postManualJournal`, `voidManualJournal`, `createRepeatingJournal` |
| Component | `client/src/components/ManualJournalLinesEditor.tsx` (default export `ManualJournalLinesEditor`, plus named `type EditorLine`, `emptyLine`, `toInputLines`, `editorTotals`) |
| Pages | `client/src/Pages/accounting/ManualJournalsPage.tsx`, `ManualJournalFormPage.tsx`, `ManualJournalDetailPage.tsx`, `NewRepeatingJournalPage.tsx` |
| Routes | `/manual-journals`, `/manual-journals/new`, `/manual-journals/repeating/new`, `/manual-journals/:journalId`, `/manual-journals/:journalId/edit`, `/reports/general-journal` |
| Tests | `client/src/__tests__/manualJournals.test.tsx` (new), `client/src/__tests__/journals.test.tsx` (edit) |

### Step 12 — [Haiku] `fetchServices` types and functions

- **Model:** [Haiku]. Transcription of the server contract.
- **Depends on:** 11.
- **Skill:** none (client).
- **Read first:** `client/src/services/fetchServices.ts`, lines 485–745 (Account, journals) and 1100–1215 (recurring), plus any existing `method: 'DELETE'` function (e.g. L415).
- **Files:** `client/src/services/fetchServices.ts` (edit).
- **Contract:**
  - Mirror Step 2's types exactly. Add `bankAccountKind: BankAccountKind | null` to `Account`, `description: string | null` to `LedgerLine`, `manualJournalId: string | null` to `JournalEntry`, and `sourceManualJournalId: string | null` to `RecurringSchedule`.
  - `createAccount`'s body type gains `bankAccountKind?: BankAccountKind | null`, and so does `updateAccount`'s patch type.
  - Add:
    ```ts
    export interface ManualJournalInput { narration: string; entryDate: string; lines: Array<{ accountId: string | null; description: string | null; debitCents: number; creditCents: number }> }
    export interface ManualJournalListParams { status?: 'all' | 'draft' | 'posted' | 'voided'; q?: string; from?: string; to?: string; page?: number }
    export interface CreateRepeatingJournalInput extends ManualJournalInput { name: string; frequency: RecurringFrequency; intervalCount: number; startDate: string; endDate: string | null; autoReverse: boolean }
    export function listManualJournals(params: ManualJournalListParams = {}, signal?: AbortSignal): Promise<{ success: boolean; count: number; totalCount: number; currentPage: number; totalPages: number; counts: { all: number; draft: number; posted: number; voided: number }; journals: ManualJournalSummary[] }>;
    export function getManualJournal(id: string, signal?: AbortSignal): Promise<{ success: boolean; journal: ManualJournal }>;
    export function createManualJournal(body: ManualJournalInput & { action: 'draft' | 'post' }): Promise<{ success: boolean; journal: ManualJournal }>;
    export function updateManualJournal(id: string, body: ManualJournalInput): Promise<{ success: boolean; journal: ManualJournal }>;
    export function deleteManualJournal(id: string): Promise<void>;
    export function postManualJournal(id: string): Promise<{ success: boolean; journal: ManualJournal }>;
    export function voidManualJournal(id: string, body: { voidDate: string | null }): Promise<{ success: boolean; journal: ManualJournal }>;
    export function createRepeatingJournal(body: CreateRepeatingJournalInput): Promise<{ success: boolean; journal: ManualJournal; schedule: RecurringSchedule }>;
    ```
  - Build the list query string the way `listJournals` does. Use `RecurringFrequency` if it exists in the file; otherwise inline `'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY'`.
- **Proof:** `cd client && npm run typecheck`. Errors are allowed only in test fixtures that build `Account`/`JournalEntry` literals; list them, and Step 18 fixes them.
- **If it fails:** fix the type names to match this table.
- **Owes:** nothing.

### Step 13 — [Sonnet] Lines editor and the new/edit form page

- **Model:** [Sonnet]. Three submit paths with distinct post-submit behaviour, plus edit-mode loading, in one stateful form.
- **Depends on:** 12.
- **Skill:** none (client).
- **Read first:** `client/src/Pages/accounting/NewJournalEntryPage.tsx` (all of it: the money parsing, `PlaceholderPicker`/`PlaceholderHints`, `usePlaceholderTarget`, `today()`, styling classes).
- **Files:** `client/src/components/ManualJournalLinesEditor.tsx` (new), `client/src/Pages/accounting/ManualJournalFormPage.tsx` (new).
- **Contract:**
  - **Editor** props: `{ lines: EditorLine[]; onChange: (lines: EditorLine[]) => void; accounts: Account[] }`.
    - `EditorLine = { description: string; accountId: string; debit: string; credit: string }`, and `emptyLine(): EditorLine`.
    - Columns: Description (text, max 500), Account (select), Debit, Credit, and remove.
    - Typing a debit clears the credit and vice versa, as the existing page does.
    - Removal is disabled at 1 line. "Add line" is in the footer, with debit/credit totals and either `Out of balance by X` or `Balanced`.
    - `editorTotals(lines) → {debits, credits, malformed, balanced}` uses `parseCentsInput`.
    - `toInputLines(lines)` maps to the API lines: `accountId: '' → null`, `description: '' → null`, cents via `parseCentsInput(...) ?? 0`. It drops lines that are fully empty (no account, no description, 0/0).
    - Account options: `accounts.filter(a => a.isPostable && a.isActive && a.bankAccountKind === null)`.
    - Under the table, a muted hint: `Bank, credit card, receivable, payable and inventory accounts can't take manual journals — use Banking, invoices, bills or Inventory.`
  - **Page.**
    - `const { journalId } = useParams()`. Edit mode when `journalId` is defined; `?copyFrom=<manualJournalId>` seeds from `getManualJournal`, using `narrationTemplate ?? narration`. Edit mode loads via `getManualJournal`. If its status is not DRAFT/TEMPLATE, show `This journal is <status> and can't be edited.` and no form.
    - Fields: **Narration** (required, max 500, with `PlaceholderPicker surface="JOURNAL"` + `PlaceholderHints`, label "Narration", placeholder `Accrued rent [Month]`), **Date**, and the editor.
    - Starts with 2 empty lines.
    - Buttons (new mode): `Save draft`, `Save & add another`, `Post`.
      - Save draft → `createManualJournal({..., action:'draft'})`, then `navigate('/manual-journals/' + id)`.
      - Post → `action:'post'`, then navigate to the detail page.
      - Save & add another → `action:'post'`. On success, reset narration and lines to 2 empty lines, **keep the date**, and show `<p className="status status--good">Posted “{narration}”.</p>` with a link to it. Stay on the page.
    - Buttons (edit mode): `Save draft` → `updateManualJournal`, then the detail page. For a DRAFT, also `Post` → `updateManualJournal`, then `postManualJournal`, then the detail page. A TEMPLATE has only `Save` (label "Save template").
    - Post-type buttons are disabled unless `balanced && debits > 0 && narration.trim() !== ''` and every non-empty line has an account and exactly one side. Save draft needs only a narration and a date.
    - Errors show in `<p className="status status--bad">`.
    - BackLink: to `/manual-journals`, "Back to manual journals".
- **Proof:** `cd client && npm run typecheck && npm run lint`, then `cd client && npx vitest run` with no new failures beyond Step 12's listed fixture errors.
- **If it fails:** fix the component; do not loosen `parseCentsInput` usage.
- **Owes:** nothing.

### Step 14 — [Haiku] `ManualJournalsPage` (list + tabs + repeating tab)

- **Model:** [Haiku]. List rendering against a specified response, copying `JournalsPage`'s list idiom.
- **Depends on:** 12.
- **Read first:** `client/src/Pages/accounting/JournalsPage.tsx` (URL-param filters, `useDebouncedInput`, `Pagination`, `LoadingState`, `ImportButton`), `client/src/Pages/accounting/RecurringSchedulesPage.tsx` (the schedule table to reuse for the Repeating tab), `client/src/components/ui/TabBar.tsx`.
- **Files:** `client/src/Pages/accounting/ManualJournalsPage.tsx` (new).
- **Contract:**
  - **Header:** h2 "Manual journals". Actions (right): `ImportButton kind="JOURNALS" returnTo="/manual-journals"`; a Link "New repeating journal" → `/manual-journals/repeating/new`; a Link "New journal" → `/manual-journals/new` (primary style).
  - **Tabs:** `TabBar variant="buttons"` with ids `all`, `draft`, `posted`, `voided`, `repeating`. Labels are `All (n)`, `Draft (n)`, `Posted (n)`, `Voided (n)` from `counts`, and `Repeating`. The active tab is in the `?status=` param (default `all`). Changing tab resets `page`.
  - **Journal tabs:**
    - a search input (narration, debounced → `q`); From/To dates
    - table columns: Date (`formatDate`), Narration (Link → `/manual-journals/:id`), Status (pill: DRAFT amber, POSTED neutral, VOIDED muted strike), Origin (`MANUAL`→"Manual", `RECURRING`→"Repeating", `IMPORT`→"Imported"), Amount (`formatCents(totalDebitCents)`, right-aligned, tabular)
    - `Pagination`; empty state text `No manual journals yet.`
  - **Repeating tab:**
    - `listRecurringSchedules({ kind: 'JOURNAL', ...(activeOnly ? { status: 'ACTIVE' } : {}) })` with a checkbox "Active only" (default checked)
    - columns: Name (Link → `/recurring/:id`), Frequency (`MONTHLY ×1` style, copied from `RecurringSchedulesPage`), Next run, Status, Auto-reverse (Yes/No)
    - empty text `No repeating journals.`
- **Proof:** `cd client && npm run typecheck && npm run lint` exits 0.
- **If it fails:** if `listRecurringSchedules`' param shape differs from what is written here, match the existing function signature exactly; do not change it.
- **Owes:** nothing.

### Step 15 — [Haiku] `ManualJournalDetailPage`

- **Model:** [Haiku]. Status-driven rendering, with every action and message specified.
- **Depends on:** 12.
- **Read first:** `client/src/Pages/accounting/JournalDetailPage.tsx` (layout, ConfirmDialog usage, MakeRecurringDialog usage at ~270).
- **Files:** `client/src/Pages/accounting/ManualJournalDetailPage.tsx` (new).
- **Contract:**
  - Load with `getManualJournal(journalId)`; a 404 shows `Manual journal not found.`
  - Header: narration (h2), status pill, date, origin, and "Created by <name>".
  - Lines table: Description, Account (`code · name`, or `—`), Debit, Credit, with totals in the footer.
  - Actions by status:
    - `DRAFT`: "Edit" (Link → `/manual-journals/:id/edit`), "Post" (→ `postManualJournal`, then reload), "Delete" (ConfirmDialog, title `Delete this draft?`; then `deleteManualJournal` and `navigate('/manual-journals')`).
    - `POSTED`:
      - "Void" (ConfirmDialog, title `Void this journal?`, body `A reversing entry is posted. The original stays in the ledger.`, with a date input defaulting to empty = the original date; → `voidManualJournal(id, {voidDate: value === '' ? null : value})`)
      - "Copy" (Link → `/manual-journals/new?copyFrom=:id`)
      - "Make recurring" (`MakeRecurringDialog kind="JOURNAL" sourceId={journal.journalEntryId} defaultName={journal.narration}`; on created → `navigate('/recurring/' + scheduleId)`)
      - Link "View ledger entry" → `/journals/:journalEntryId`
    - `VOIDED`: links "View ledger entry" and "View reversal" → `/journals/:voidJournalEntryId`; "Copy".
    - `TEMPLATE`: "Edit template" → `/manual-journals/:id/edit`; Link "View schedule" → `/recurring/:templateScheduleId` (when non-null).
  - Every action is wrapped in `useCan('journals.create')`, copying how `JournalDetailPage` gates its buttons. Action errors show in `status status--bad`.
- **Proof:** `cd client && npm run typecheck && npm run lint` exits 0.
- **Owes:** nothing.

### Step 16 — [Haiku] `NewRepeatingJournalPage`

- **Model:** [Haiku]. A form over Step 13's editor with a fully specified body.
- **Depends on:** 13.
- **Read first:** `client/src/components/MakeRecurringDialog.tsx` (frequency/interval/end-date inputs and labels to copy); `client/src/Pages/accounting/ManualJournalFormPage.tsx` (Step 13).
- **Files:** `client/src/Pages/accounting/NewRepeatingJournalPage.tsx` (new).
- **Contract:**
  - h2 "New repeating journal".
  - Fields:
    - Name (required, max 80; defaults to the narration on narration blur if still empty)
    - Narration (required, `PlaceholderPicker surface="JOURNAL"` + `PlaceholderHints` previewing against the first date)
    - First date (`startDate`, default today)
    - Repeats (`WEEKLY | MONTHLY | QUARTERLY | YEARLY`, default MONTHLY)
    - Every (`intervalCount` 1–12, default 1)
    - End date (optional)
    - checkbox "Reverse on the 1st of the next month" (`autoReverse`), with the hint `For accruals: each journal is reversed automatically at the start of the next month.`
    - `ManualJournalLinesEditor`
  - Submit "Save repeating journal" is disabled unless balanced, debits > 0, and name and narration are non-empty. It calls `createRepeatingJournal({ name, narration, entryDate: startDate, lines: toInputLines(lines), frequency, intervalCount, startDate, endDate: endDate === '' ? null : endDate, autoReverse })`. The server ignores the extra `entryDate` key, because zod strips it. Then `navigate('/recurring/' + res.schedule.id)`.
  - BackLink → `/manual-journals?status=repeating`, "Back to manual journals".
- **Proof:** `cd client && npm run typecheck && npm run lint` exits 0.
- **Owes:** nothing.

### Step 17 — [Haiku] Routing, nav, titles, General journal, detail links, bank-kind toggle

- **Model:** [Haiku]. Small, enumerated edits across known files.
- **Depends on:** 13, 14, 15, 16.
- **Read first:** `client/src/routes/ProductRoutes.tsx` (around 61–63 and 216–232), `client/src/components/layout/nav.ts` (around 95–120), `client/src/utils/pageTitle.ts`, `client/src/Pages/reports/ReportsPage.tsx`, `client/src/Pages/accounting/NewAccountForm.tsx`, `client/src/Pages/settings/ChartSettingsPage.tsx`, `client/src/Pages/accounting/RecurringScheduleDetailPage.tsx`.
- **Files and exact edits:**
  - `routes/ProductRoutes.tsx`:
    - Import the four new pages. Remove the `NewJournalEntryPage` import.
    - `<Route path="/journals" element={<Navigate to="/manual-journals" replace />} />` and `<Route path="/journals/new" element={<Navigate to="/manual-journals/new" replace />} />`. Keep `/journals/:entryId` → `JournalDetailPage`.
    - Add `/manual-journals` → `ManualJournalsPage`, `/manual-journals/new` → `ManualJournalFormPage`, `/manual-journals/repeating/new` → `NewRepeatingJournalPage`, `/manual-journals/:journalId` → `ManualJournalDetailPage`, `/manual-journals/:journalId/edit` → `ManualJournalFormPage`, `/reports/general-journal` → `JournalsPage`.
  - Delete `client/src/Pages/accounting/NewJournalEntryPage.tsx`.
  - `components/layout/nav.ts`: the `/journals` entry becomes `{ to: '/manual-journals', label: 'Manual journals', icon: BookOpen, end: false, permission: 'journals.view' }`. In the Reports group, after Trial balance, add `{ to: '/reports/general-journal', label: 'General journal', icon: BookOpen, end: false, permission: 'journals.view' }`.
  - `utils/pageTitle.ts`: replace `'/journals/new': 'New journal entry'` with `'/manual-journals/new': 'New manual journal'` and `'/manual-journals/repeating/new': 'New repeating journal'`.
  - `Pages/reports/ReportsPage.tsx`: append `{ name: 'General journal', …, path: 'reports/general-journal' }`, copying the neighbouring entries' other fields with the description `Every posting in date order, from every source.`
  - `JournalsPage.tsx`:
    - The heading text becomes "General journal", with an explanatory line `Every posting from every source. Manual journals are created under Accounting → Manual journals.`
    - **Remove** the Duplicate and Reverse row actions, their ConfirmDialog/state, and the `ImportButton`. Keep View.
    - Update the file's doc comment to say it is the read-only register.
  - `JournalDetailPage.tsx`:
    - `canReverse` becomes `entry.reversesEntryId === null && entry.reversedByEntryId === null && ['manual','recurring','migration_import','opening_balance'].includes(entry.sourceType)`.
    - When `entry.manualJournalId !== null`, render a Link "Open manual journal" → `/manual-journals/:manualJournalId`, and relabel the Reverse button "Void journal".
    - Remove its "Make recurring" button when `entry.manualJournalId !== null` (the manual journal page owns it).
    - Show line descriptions in a Description column when any line has one.
  - `RecurringScheduleDetailPage.tsx`: where it links a JOURNAL schedule's source to `/journals/:sourceId`, link to `/manual-journals/:sourceManualJournalId` when that is non-null.
  - `NewAccountForm.tsx`:
    - add a select "Bank account" (shown only when type is Asset: options `None`/`Bank account`) or "Credit card" (shown only when type is Liability: options `None`/`Credit card`)
    - state `bankAccountKind: BankAccountKind | null`, reset to null when the type changes
    - send it in `createAccount`
  - `ChartSettingsPage.tsx`: next to Retire/Activate, a small toggle "Mark as bank" / "Unmark bank" for Asset postable accounts (or "Mark as credit card" / "Unmark credit card" for Liability) → `updateAccount(id, { bankAccountKind: node.bankAccountKind === null ? ('BANK' | 'CREDIT_CARD' by type) : null })`, showing a `Bank`/`Card` badge when flagged.
- **Proof:** `cd client && npm run typecheck && npm run lint` exits 0, and `grep -rn "NewJournalEntryPage" client/src` returns nothing.
- **If it fails:** keep the existing gating hooks; do not remove permission checks to fix a type.
- **Owes:** nothing.

### Step 18 — [Sonnet] Client tests

- **Model:** [Sonnet]. Rewriting existing assertions whose contract changed, plus new behavioural tests.
- **Depends on:** 17.
- **Read first:** `client/src/__tests__/journals.test.tsx` (the mock setup idiom) and `client/src/__tests__/recurringSchedules.test.tsx`.
- **Files:** `client/src/__tests__/journals.test.tsx` (edit), `client/src/__tests__/manualJournals.test.tsx` (new), and any fixture flagged in Step 12 (edit: add the new fields with `null`).
- **Contract:**
  - In `journals.test.tsx`:
    - **Delete**: `offers Reverse only on…`, `clicking Reverse opens a confirmation…`, `confirming the dialog reverses…`, `cancelling the dialog…`, `Duplicate links to the post form…`, the whole `NewJournalEntryPage — ?copyFrom=` describe, and `the Journals page has an Import button…`. Each was a contract this phase removed deliberately.
    - Add `the General journal register offers no Reverse or Duplicate action` and `JournalDetailPage links to the owning manual journal when manualJournalId is set`. Keep every other case.
  - New `manualJournals.test.tsx` cases:
    - `tabs show counts and switching to Draft sets ?status=draft`
    - `a draft row links to /manual-journals/:id`
    - `Save & add another posts, clears narration and lines, keeps the date, and shows the posted message`
    - `Post is disabled until balanced and a narration is entered`
    - `Save draft is enabled with an unbalanced form`
    - `the account picker omits accounts with bankAccountKind`
    - `detail page: DRAFT shows Edit/Post/Delete; POSTED shows Void/Copy; VOIDED shows View reversal`
    - `voiding sends voidDate null when the date is left blank`
    - `New repeating journal submits frequency, startDate, endDate null and autoReverse`
    - `Repeating tab lists JOURNAL schedules with Active only checked by default`
- **Proof:** `cd client && npm run typecheck && npm run lint && npm test` is green. Record the passing count here.
- **Result (2026-10-15):** typecheck clean, lint clean, **664 client tests passing in 95 files** (0 skipped). `grep -rn NewJournalEntryPage client/src` returns nothing. Beyond the listed edits, four stale assertions were updated to Step 17's contract: `pageTitle.test.ts` (`/manual-journals/` title), `customRoles.test.tsx` and `navigation.test.tsx` (sidebar label/path 'Manual journals' `/manual-journals`), and `accounts.test.tsx` (create body now carries `bankAccountKind: null`).
- **If it fails:** fix the component (Steps 13–17) under its own rules; never delete a case outside the list above.
- **Owes:** nothing.

---

## Spine

### Step 19 — [Sonnet] Full verification

- **Model:** [Sonnet]. Interpreting results across the whole stack.
- **Depends on:** 18.
- **Commands (all must pass):**
  1. `cd server && npm run typecheck && npm run lint && npm test` is green (2 skipped).
  2. `cd client && npm run typecheck && npm run lint && npm test` is green.
  3. `cd server && npm run verify:integrity` reports all checks OK.
  4. `cd server && npm run walkthrough`, then `git diff --stat walkthrough/` shows no change to the answer key. (The walkthrough posts only bank-line journals, so it should be unaffected.)
  5. Manual check: run `./dev.sh`, sign in to the demo org (`npm run seed:demo` first if it is absent), then:
     - create a draft accrual, edit it, and post it
     - void it
     - try 1110: refused, with the bank message
     - create a monthly repeating "Prepaid insurance release [Month]" with auto-reverse off, and run it from `/recurring/:id`
     - confirm the posted journal appears under Posted with origin "Repeating"
- **Proof:** record each command's result line in this file under Step 19.
- **Result (2026-10-15):**
  1. server: typecheck clean, lint clean, `Test Files 183 passed`, `Tests 2297 passed | 2 skipped (2299)`.
  2. client: typecheck clean, lint clean, `Tests 664 passed (664)`.
  3. `verify:integrity`: all 7 checks PASS, `Integrity check passed.`
  4. `npm run walkthrough` completed; `git diff --stat walkthrough/` empty (answer key unchanged).
  5. Manual `./dev.sh` browser check: NOT performed by the runner (no interactive browser); the same flows (draft, edit, post, void, bank-account refusal, repeating run) are covered by the Step 11 server integration tests.
- **If it fails:** stop and report with the failing command's output.

### Step 20 — [Sonnet] Guardrail review

- **Skill:** `guardrail-review` over `git diff main...HEAD` (or the working tree diff).
- **Depends on:** 19.
- **Focus:**
  - rule 1: every new query
  - rule 2: controllers
  - rule 5: `manualJournalService` and `recurringService`
  - rule 6: the PATCH/DELETE routes must refuse non-drafts in both service and trigger
  - rule 8: the 097 FKs and indexes
  - rule 10: `canTransitionManualJournal` is the only status gate
  - rule 13
  - rule 16: no cross-service table reads; `journalService` does not import `manualJournalService`
- **Proof:** the review reports zero unresolved violations. Fixes are applied under the owning step's rules.

### Step 21 — [Sonnet] Study notes

- **Skill:** `study-note`.
- **Depends on:** 20.
- **Files:**
  - Extend `study/architecture/document-lifecycle-fsm.md` with a section "A draft document that owns an immutable posting". Cover:
    - why manual journals moved from 'the entry is the document' to a document row (drafts need mutability; `journal_entries` cannot have it)
    - the state-dependent trigger (`to_jsonb(NEW) - … IS DISTINCT FROM …`)
    - why lines are guarded by a parent-status trigger
    - void as a reversal, not a delete
    - the rejected alternatives: a status column on `journal_entries` (it would weaken rule 6's trigger for every posting), and a separate drafts table deleted on post (it would lose the draft → posted identity)
  - Extend `study/postgresql/migrations-and-schema-evolution.md` with:
    - a set-based backfill through a `TEMP TABLE … ON COMMIT DROP` id map, and why (the parent must be DRAFT while its lines are inserted)
    - replacing a CHECK idempotently (DROP IF EXISTS old + guarded ADD v2) under a replay test
    - flagging accounts from usage
  - Each extension adds **4 interview questions with full answers**, and states the PostgreSQL version verified against (`docker exec autodb_postgres psql -U autodb_user -d autodb -c 'SHOW server_version'`).
  - Update `study/README.md`: the index and coverage tracker rows for Phase 44.
- **Proof:** both files contain a `Phase 44` heading, `study/README.md` mentions Phase 44, and every new interview question has an answer paragraph.

### Step 22 — [Sonnet] Docs sync

- **Skill:** `docs-sync`.
- **Depends on:** 21.
- **Files:**
  - `docs/api.md`: the `/manual-journals` route table above. `/journals` POST and reverse now say: creates a manual journal; reverse voids an owning manual journal; `409` for document-owned entries. Accounts gain `bankAccountKind`. `LedgerLine.description` and `JournalEntry.manualJournalId`. Recurring gains `sourceManualJournalId`.
  - `docs/schema.md`: a migration 097 block (both tables, triggers, the three new columns, the v2 CHECK, the backfill).
  - `docs/accounting.md`: a Manual journals section (states, system-account rule including bank and credit card, repeating, import).
  - `docs/roadmap.md`: `## Phase 44 — as delivered`, with test totals from Steps 10/11/18, migration 097, and **Deliberately not built**:
    - tracking categories and tax on journal lines
    - foreign-currency manual journals
    - auto-flagging a newly imported bank account (the flag is manual after the backfill)
    - an integrity check tying manual-journal line totals to their entry
    - per-line placeholders
    - attaching files to a manual journal
  - `CLAUDE.md`: one Phase 44 bullet in the Built list, at the same density as its neighbours.
- **Proof:** the `docs-sync` skill reports no drift for the files above.

### Step 23 — [Haiku] Close the plan

- **Depends on:** 22.
- **Files:** this file.
- **Contract:** set the top `Status:` to `done — Phase 44 landed`, and every manifest row's Status to `done`. Do not delete the file; prior phase plans are kept in `plans/`.
- **Proof:** `grep -c "| todo |" plans/phase-44-manual-journals.md` returns `0`.

---

## Dispatch manifest

| Batch | Step | Tier | Title | Depends on | Blocks | Status |
|---|---|---|---|---|---|---|
| A | 1 | Sonnet | Migration 097 | — | 2 | done |
| B | 2 | Haiku | Server types | 1 | 3,4 | done |
| C | 3 | Sonnet | Accounts bankAccountKind + seed | 2 | 10 | done |
| C | 4 | Sonnet | journalService: descriptions, owner link, guard | 2 | 5 | done |
| C | 5 | Sonnet | manualJournalService | 1,2,4 | 6,7,8,9 | done |
| D | 6 | Haiku | Schema/controller/routes/mount | 5 | 8 | done |
| E | 7 | Sonnet | Rewire /journals create + reverse | 5 | 10 | done |
| E | 8 | Sonnet | Recurring template schedules | 5,6 | 10 | done |
| E | 9 | Sonnet | Journal import → manual journals | 5 | 10 | done |
| E | 10 | Sonnet | Existing-test sweep | 3,7,8,9 | 11 | done |
| E | 11 | Sonnet | New integration + isolation tests | 10 | 12 | done |
| F | 12 | Haiku | fetchServices | 11 | 13,14,15 | done |
| G | 13 | Sonnet | Lines editor + form page | 12 | 16,17 | done |
| H | 14 | Haiku | ManualJournalsPage | 12 | 17 | done |
| H | 15 | Haiku | ManualJournalDetailPage | 12 | 17 | done |
| H | 16 | Haiku | NewRepeatingJournalPage | 13 | 17 | done |
| H | 17 | Haiku | Routing/nav/GL register/links/bank toggle | 13,14,15,16 | 18 | done |
| I | 18 | Sonnet | Client tests | 17 | 19 | done |
| I | 19 | Sonnet | Full verification | 18 | 20 | done |
| I | 20 | Sonnet | guardrail-review | 19 | 21 | done |
| I | 21 | Sonnet | study-note | 20 | 22 | done |
| I | 22 | Sonnet | docs-sync | 21 | 23 | done |
| J | 23 | Haiku | Close the plan | 22 | — | done |

**Batching:**
- Batch A (Step 1) is Sonnet. B (Step 2) is Haiku. C (Steps 3–5) is one Sonnet batch. D (Step 6) is Haiku. E (Steps 7–11) is one Sonnet batch. F (Step 12) is Haiku. G (Step 13) is Sonnet. H (Steps 14–17) is one Haiku batch. I (Steps 18–22) is one Sonnet batch. J (Step 23) is Haiku.
- Step 6 leaves one sanctioned typecheck error, which Step 8 clears. Do not "fix" it in Step 6 by stubbing `createRepeatingJournal`.

**Do not split:**
- Step 5's `postDraftOnClient` / `voidOnClient` and their header UPDATEs. The document and its entry commit together.
- Step 8's template + schedule insert, and a run's manual journal + entry + reversal + `recurring_runs` row.
- Step 1 is one file and is never applied in parts.

## Plan amendments (execution)

- **Step 17 proof ordering (orchestrator, 2026-10-15).** Step 17's `grep -rn "NewJournalEntryPage" client/src` cannot return nothing until Step 18 deletes the `?copyFrom=` describe and import in `journals.test.tsx`. Two stale comments also named the deleted page and were owned by no step: `client/src/__tests__/invoices.test.tsx:18` and `client/src/Pages/home/OnboardingPage.tsx:114`. Step 18 rewords both, comment-only. Step 17 is marked `done` only after its grep is re-run clean following Step 18.
- **Step 23 proof self-match (orchestrator).** `grep -c "| todo |"` matches the Proof line's own text, so it returns 1 even when every row is done. Verified instead with the anchored `grep -c "^| .* | todo |$"`, which returns 0.

## Risks & open questions

- **Test churn (Step 10).** Flagging 1110 as BANK refuses every manual journal that used cash in a test. The candidate set is the 23 files that mention 1110 and `/journals`, but the real failure set is unknown until Step 7–9 runs. The replacement rule is fixed, and anything outside it is a stop.
- **`POST /journals` with no description** now produces an entry described `Manual journal` rather than `null`. No existing journal test asserts `null` (checked: `journals.test.ts` has no `description).toBeNull`). Another file might, and Step 7 stops if one does.
- **Legacy recurring schedules** whose source entry touches a now-flagged bank account will fail at their next run with `last_error` set. That is correct under the new rule, but it is a behaviour change for existing demo or user data. The demo seed posts only bank-line journals, so it is unaffected.
- **The backfill's recurring FK:**
  - It assumes every `source_type='recurring'` entry's `source_id` is a live schedule id. That holds for 34b's code: schedules are never deleted (RESTRICT).
  - If the dev DB has hand-made rows that break this, Step 1 stops.
- **Imported narrations now fill placeholders** (Step 9). An imported narration containing a literal `[Month]` becomes the month name. This is consistent with Phase 40's "no placeholder reaches a posted row", but it is new for imports. `[[Month]]` escapes it.
- **URL deviation:** manual journals are at `/manual-journals`, not `/journals`. The reason is above; `/journals` redirects.
- **Bank flag on new bank accounts:** an account first used for a statement import after this phase is not flagged automatically. The user flags it in Chart settings. This is listed as not built.
- **Unknown:** the exact column list of `bank_rules`/`payments` beyond `bank_account_id`/`cash_account_id` is not needed. Those two names were verified in 074 and 014.

## Definition of done

- Migration 097 is applied and replay-safe. Every existing manual, recurring and imported journal is listed as POSTED or VOIDED.
- In the UI, a user can:
  - create, edit and delete a draft
  - post it, or Save & add another
  - void a posted journal
  - create a repeating journal with first date, frequency, optional end date and auto-reverse, and see its runs under Posted
  - import journals into the same list
- Manual journals refuse AR, AP, inventory control, bank and credit-card accounts, with readable 422s. Bank-line journals are unaffected.
- `POST /journals/:id/reverse` can no longer reverse a document-owned posting.
- Server tests are green (2 skipped), client tests are green, `verify:integrity` is OK, and the walkthrough answer key is unchanged.
- `guardrail-review` is clean, the study notes are extended, and `docs/` plus `CLAUDE.md` are synced.
- This file's Status is `done`.
