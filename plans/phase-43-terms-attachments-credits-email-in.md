# Phase 43 — payment-term defaults, attachments, apply-credit on approval, email-in

Date: 2026-10-15 · **Status: done** · Approved design: `/home/ankit/.claude/plans/pasted-content-id-5e9d-there-virtual-blum.md` · Branch: create `phase-43` from `main` before step 1.

Four slices, each one commit: **43a** payment terms (Xero rule types, org + party defaults), **43b** attachments (vault picker, upload while drafting, linked order), **43c** apply open credit when a bill is approved or an invoice is issued, **43d** a per-org email-in address for the bill inbox. **Bank rules were requested too but already exist (Phase 34a) — not in this plan.**

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

## Execution rules

**If a proof command fails twice on the same step, stop and report. Do not improvise around it.**

| Symptom | Forbidden | Correct |
|---|---|---|
| Migration checksum error | Editing the applied migration | A new sequential migration (rule 13) |
| Test fails | Weakening or deleting the assertion | Fix the code; the test is the spec |
| Type error | `as any`, `@ts-ignore`, loosening `tsconfig` | Fix the type |
| Query returns no rows | Dropping the `org_id` predicate | Fix the fixture or the parameters (rule 1) |
| Balance assertion fails | Epsilon, floats, rounding | Integer cents equality (rule 3) |
| Need a helper library | `npm install` anything | Stop and ask (rule 14). **This phase adds no dependency.** |
| "Update the posted record" | `PUT`/`DELETE`, or loosening the immutability trigger | Stop — nothing in this plan edits a posted row |
| Column missing at runtime | Adding it ad hoc | New migration, then update the plan |
| A `[Haiku]` step's proof fails twice | Retrying in a loop, trimming the step | Escalate the same step, unchanged, to Sonnet with the failure output; record "escalated" in the manifest's Status cell |
| The step needs a decision the plan never made | Deciding it | Stop and report — the plan is the defect |

**Anything the plan did not anticipate is a stop-and-report, not a judgment call.**

Commands: server tests `cd server && npx vitest run <path>`; full `cd server && npm test`; `cd server && npm run typecheck && npm run lint`; same three in `client/`. Migrations: `cd server && npm run migrate`. Direct SQL: `docker exec autodb_postgres psql -U autodb_user -d autodb -c '…'` (no host `psql`). Baseline before step 1: **2197 server (2 skipped) + 632 client tests passing** — record the real numbers from a run in step 0's Status cell.

## Starting state (verified 2026-10-15 against `main` @ `82573c7`)

- Last migration `093_ledger-core_deposits.sql`. This plan uses **094** (43a), **095** (43b), **096** (43d). 43c needs no migration.
- **Payment terms** — `payment_terms` (mig 058: `id, org_id, code, name, net_days SMALLINT CHECK 0..365, is_system, is_active, created_by, created_at, updated_at`, `UNIQUE (org_id, id)` as `ux_payment_terms_org_id_id`). No delete route (only list/create/patch, `routes/accounting/paymentTermRoutes.ts`). `services/accounting/paymentTermService.ts`: `addDaysIso`, `resolveDueDate(q, orgId, documentDate, paymentTermsCode, explicitDueDate)` (explicit wins; null code → 422 `'Provide a due date or a payment term'`; looks the term up by code, rejects inactive, returns `{dueDate, paymentTermsCode, paymentTermsLabel}`). Callers: `resolveInvoiceDueDate` (`invoiceService.ts` ~L491, used at create ~L653 and update ~L832) and `resolveBillDueDate` (`billService.ts` ~L514, create ~L862, update ~L1056). Both update paths receive the full input including `customerId`/`vendorId`. `recurringService.ts` passes no `dueDate` when the template has a `paymentTermsCode` (~L520, ~L557), so recurring follows `resolveDueDate`.
- **Org defaults** — only `ledger_invoice_settings.default_due_days` (mig 007, default 30); the client matches it to a term in `NewInvoicePage.tsx` ~L168–173. Bills: nothing. `ledger_settings` (mig 005; row exists only after onboarding; `completeOnboarding` inserts it, `settingsService.ts` ~L213) is served by `GET/PATCH /settings` through `SETTINGS_SELECT`, `toLedgerSettings`, `updateSettings`'s frozen `COLUMNS` map; schema `schemas/accounting/settingsSchema.ts` `updateSettingsSchema`. **Test orgs from `createUserWithOrg` are not onboarded** (no `ledger_settings` row).
- **Parties** — `vendors.payment_terms` free text (mig 011), unused for derivation. `customers` has no terms. `customerService.ts`/`vendorService.ts` use `CUSTOMER_COLUMNS`/`VENDOR_COLUMNS`, `toCustomer`/`toVendor`, frozen `COLUMNS` update map.
- **Document Vault** — `documents` + `document_links` (mig 030; `entity_type` has only a length CHECK, so new entity types need no migration). `documentService.ts`: `uploadDocument`, `listDocuments(orgId, filters: DocumentListFilters)` with `buildFilters`, `attachDocument(orgId, documentId, createdBy, input)` (own `withTransaction`; 404 if the document is not in the org; 409 on duplicate link). `types/documents.ts` `DOCUMENT_ENTITY_TYPES_BY_MODULE[accounting] = ['invoice','bill','journal_entry','payment','customer','vendor','quote']`. Client `components/AttachmentsPanel.tsx` (upload-from-computer only) is mounted on bill, invoice, journal, quote detail pages.
- **Orders** — `orders` (mig 092: `direction 'SALES'|'PURCHASE'`, `customer_id`/`vendor_id`, `order_number`, `status 'DRAFT'|'CONFIRMED'|'CLOSED'|'CANCELLED'`, `UNIQUE (org_id, id)`). Bills/invoices raised from an order are created in `orderService.ts` (~L1040 invoice, ~L1074 bill) via `createInvoiceOnClient`/`createBillOnClient`; lines carry `order_line_id`. No order PDF exists. Client routes `/sales-orders/:orderId`, `/purchase-orders/:orderId`.
- **Credits** — `debitNoteService.applyDebitNote(orgId, userId, id, {billId, amountCents, allocationDate})` and `creditNoteService.applyCreditNote(orgId, userId, id, {invoiceId, amountCents, allocationDate})` each own a transaction. `depositService.applyDeposit(orgId, userId, direction: 'SALES'|'PURCHASE', targetId, {depositDocumentId, amountCents, applicationDate})` owns a transaction, locks both documents via `lockDocumentsOnClient` (`ORDER BY id FOR UPDATE`), requires base currency, same party, and that the target has a line from the deposit's order; posts a journal entry. Bill approve: `approveBillOnClient(client, orgId, userId, id, entryDate, options)` + wrapper `approveBill`; invoice issue: `issueInvoiceOnClient(client, orgId, userId, id, entryDate)` + wrapper `issueInvoice`. Bill open status `POSTED`, invoice `ISSUED`. Bodies parsed by `approveBillSchema` / `issueInvoiceSchema` (`{ entryDate }`).
- **Permissions** (`config/permissions.ts`): `bills.approve`, `invoices.issue`, `debit_notes.issue`, `credit_notes.issue`, `documents.view`, `documents.upload`, `payment_terms.manage`, `settings.manage`, `customers.manage`, `vendors.manage`, `purchase_orders.view`, `sales_orders.view`. `middleware/rbac.ts` exports `loadAccess(req)` → `{ permissions: Set }`.
- **Capture intake** — `services/capture/captureDocumentService.captureFile(orgId, createdBy, {buffer, originalname})` (Drive uses it via `services/integrations/driveIntakeDispatcher.ts`). Mail: `MAIL_TRANSPORT log|mailpit|brevo`, `BREVO_API_KEY` in `config/env.ts`.
- **Parity-fixture pattern** — `client/src/__tests__/fixtures/placeholderCases.json`, read by `server/src/__tests__/placeholders.test.ts` (via `readFileSync(new URL('../../../client/src/__tests__/fixtures/…', import.meta.url))`) and by `client/src/__tests__/placeholders.test.ts` (`?raw` import).

## Gate

All prerequisites built: Phase 24 (terms), 9.5 (vault), 26 (notes), 42 (orders, deposits), 19.3 (intake dispatcher), 38b (Brevo/outbox), 7 (queues). **43d has an external dependency**: a real end-to-end run needs a Brevo account with inbound parsing and MX records on a receiving subdomain — the code and its fake-provider tests do not. Nothing is blocked.

## Decisions fixed at plan time

- **Due-date rules** (pure function, UTC only):
  - `DAYS_AFTER_DATE` n → date + n.
  - `DAYS_AFTER_MONTH_END` n → last day of the document's month + n.
  - `DAY_OF_NEXT_MONTH` n → day n of the following month, clamped to that month's last day.
  - `DAY_OF_CURRENT_MONTH` n → day n of the document's month (clamped); if that is before the document date, day n of the next month (clamped).
- **Resolution order** when a create/update carries neither `dueDate` nor `paymentTermsCode`: party default → org default (sales or purchase) → 422 `'Provide a due date or a payment term'` (unchanged). An inactive default is skipped.
- **Onboarding** sets both org defaults to the org's `NET_30` term. Existing orgs: the sales default is backfilled from `default_due_days`; the purchase default stays NULL. `default_due_days` and `vendors.payment_terms` stay on disk (rule 13). The client keeps `defaultDueDays` only as a fallback when `defaultSalesPaymentTermId` is null.
- **FKs**: composite `(org_id, x) → payment_terms (org_id, id) ON DELETE RESTRICT`. Terms are never deleted (deactivated only), so RESTRICT never fires.
- **Attachments while drafting**: files go to the vault at once (unlinked); `attachmentDocumentIds` on create/update links them **in the document's transaction**.
- **Linked order**: `bills.purchase_order_id`, `invoices.sales_order_id`. Settable while the document is editable (bill DRAFT/AWAITING_APPROVAL, invoice DRAFT). Same party required; status `CONFIRMED` or `CLOSED`. Set automatically when raised from an order.
- **Apply-credit**: `GET /bills/:id/available-credits`, `GET /invoices/:id/available-credits` compute legality against **this** document. `applyCredits` on approve/issue applies in the **same transaction**. Lock order: the document row (already locked by approve/issue) → each note (ascending id) → each deposit (via `lockDocumentsOnClient`, ascending id). A deadlock (`40P01`) maps to 409 `'Another change to these documents was in progress — try again'`. Applying notes additionally needs `debit_notes.issue` / `credit_notes.issue`; deposits need nothing beyond the route permission (matches today's `apply-prepayment` / `apply-deposit` gates).
- **Email-in**: address `<token>@<INBOUND_MAIL_DOMAIN>`, token 16 lowercase base32 chars from `crypto.randomBytes`. Webhook `POST /api/v1/public/inbound-mail/brevo/:secret` — the secret in the path is compared with `crypto.timingSafeEqual` against `INBOUND_MAIL_WEBHOOK_SECRET` (Brevo's docs describe no signature for inbound). Attachments download from `GET https://api.brevo.com/v3/inbound/attachments/{DownloadToken}` with header `api-key: BREVO_API_KEY` (verified 2026-10-15 at developers.brevo.com/reference/get-inbound-email-attachment; the page also lists an OAuth bearer — see Risks).

---

## Step 0 — [Sonnet] Baseline

- **Model:** [Sonnet] — establishes the regression baseline every later proof compares to.
- **Depends on:** —
- **Files:** none. `git checkout -b phase-43`.
- **Proof:** `cd server && npm test` and `cd client && npm test` both green; write the pass/skip counts into this step's Status cell.
- **If it fails:** stop — the baseline is broken before any change.

---

## Slice 43a — Payment terms: rule types, org and party defaults

Outcome: a bill or invoice with no due date and no term gets one from the party's default term, else the organization's, and terms can be "20th of next month".

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| Migration | `server/src/db/migrations/094_ledger-core_payment_term_defaults.sql` |
| New columns | `payment_terms.rule TEXT`, `ledger_settings.default_sales_payment_term_id UUID`, `ledger_settings.default_purchase_payment_term_id UUID`, `customers.default_payment_term_id UUID`, `vendors.default_payment_term_id UUID` |
| Constraints | `ck_payment_terms_rule`, `ck_payment_terms_rule_day`, `fk_ledger_settings_default_sales_term`, `fk_ledger_settings_default_purchase_term`, `fk_customers_default_payment_term`, `fk_vendors_default_payment_term` |
| Indexes | `idx_ledger_settings_default_sales_term`, `idx_ledger_settings_default_purchase_term`, `idx_customers_default_payment_term`, `idx_vendors_default_payment_term` |
| TS type | `PaymentTermRule` = `'DAYS_AFTER_DATE' \| 'DAYS_AFTER_MONTH_END' \| 'DAY_OF_NEXT_MONTH' \| 'DAY_OF_CURRENT_MONTH'`, const `PAYMENT_TERM_RULES` (in `server/src/types/accounting.ts`, next to `PaymentTerm`) |
| Field names (API) | `PaymentTerm.rule`, `LedgerSettings.defaultSalesPaymentTermId`, `LedgerSettings.defaultPurchasePaymentTermId`, `Customer.defaultPaymentTermId`, `Vendor.defaultPaymentTermId` |
| Pure util (server) | `server/src/utils/dueDate.ts` → `computeDueDate(rule: PaymentTermRule, n: number, documentDate: string): string` |
| Pure util (client) | `client/src/utils/dueDate.ts` → same signature, same name |
| Parity fixture | `client/src/__tests__/fixtures/dueDateCases.json` |
| Service export | `paymentTermService.resolveDefaultTermCodeOnClient(q, orgId, side: 'SALES' \| 'PURCHASE', partyId: string): Promise<string \| null>` |
| Tests | `server/src/__tests__/dueDate.test.ts`, `server/src/__tests__/accounting/paymentTermDefaults.test.ts`, `client/src/__tests__/dueDate.test.ts`, `client/src/__tests__/paymentTermDefaults.test.tsx` |

### Step 1 — [Sonnet] Migration 094

- **Model:** [Sonnet] — migration (rule 13), composite tenancy FKs, backfills.
- **Depends on:** 0
- **Skill:** new-migration
- **Read first:** `server/src/db/migrations/058_ledger-core_payment_terms.sql` (header style, idempotency), `005_ledger-core_settings.sql` L62–76 (composite FK + RESTRICT comment).
- **Files:** `server/src/db/migrations/094_ledger-core_payment_term_defaults.sql` (new)
- **Contract — the file contains, in this order:**
  ```sql
  ALTER TABLE payment_terms ADD COLUMN IF NOT EXISTS rule TEXT NOT NULL DEFAULT 'DAYS_AFTER_DATE';
  -- ck_payment_terms_rule: rule IN ('DAYS_AFTER_DATE','DAYS_AFTER_MONTH_END','DAY_OF_NEXT_MONTH','DAY_OF_CURRENT_MONTH')
  -- ck_payment_terms_rule_day: rule NOT IN ('DAY_OF_NEXT_MONTH','DAY_OF_CURRENT_MONTH') OR net_days BETWEEN 1 AND 31
  --   (both added with DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT)
  ALTER TABLE ledger_settings ADD COLUMN IF NOT EXISTS default_sales_payment_term_id UUID;
  ALTER TABLE ledger_settings ADD COLUMN IF NOT EXISTS default_purchase_payment_term_id UUID;
  ALTER TABLE customers ADD COLUMN IF NOT EXISTS default_payment_term_id UUID;
  ALTER TABLE vendors   ADD COLUMN IF NOT EXISTS default_payment_term_id UUID;
  -- each: DROP CONSTRAINT IF EXISTS <name>; ADD CONSTRAINT <name>
  --   FOREIGN KEY (org_id, <col>) REFERENCES payment_terms (org_id, id) ON DELETE RESTRICT;
  -- each: CREATE INDEX IF NOT EXISTS <idx> ON <table> (<col>);
  -- backfill 1 (sales default from default_due_days):
  UPDATE ledger_settings s SET default_sales_payment_term_id = t.id
    FROM ledger_invoice_settings i
    JOIN payment_terms t ON t.org_id = i.org_id AND t.is_system AND t.is_active
                        AND t.rule = 'DAYS_AFTER_DATE' AND t.net_days = i.default_due_days
   WHERE s.org_id = i.org_id AND s.default_sales_payment_term_id IS NULL;
  -- backfill 2 (vendor default from free text, exact case-insensitive match on code or name):
  UPDATE vendors v SET default_payment_term_id = t.id
    FROM payment_terms t
   WHERE t.org_id = v.org_id AND t.is_active AND v.default_payment_term_id IS NULL
     AND v.payment_terms IS NOT NULL
     AND (upper(btrim(v.payment_terms)) = t.code OR lower(btrim(v.payment_terms)) = lower(t.name));
  ```
  Header comment states: `default_due_days` and `vendors.payment_terms` are retained (rule 13); purchase default intentionally not backfilled.
- **Guardrails:** #8 composite FK + index on every new `*_id` · #13 idempotent, applies twice.
- **Proof:** `cd server && npm run migrate && npm run migrate` exits 0 both times; `npx vitest run src/__tests__/migrations.test.ts` green; `docker exec autodb_postgres psql -U autodb_user -d autodb -c "\d vendors"` shows `fk_vendors_default_payment_term`.
- **If it fails:** a migration that has been applied once is never edited — if it applied wrongly, write 095 to fix and renumber this plan's later migrations. Stop and report.
- **Owes:** `docs/schema.md` block (Step 8).

### Step 2 — [Haiku] Types + pure `computeDueDate` + parity fixture

- **Model:** [Haiku] — the algorithm and every test value are given below.
- **Depends on:** 0
- **Read first:** `server/src/services/accounting/paymentTermService.ts` `addDaysIso` (UTC-only style); `server/src/__tests__/placeholders.test.ts` (fixture loading); `client/src/__tests__/placeholders.test.ts` (`?raw` loading).
- **Files:** `server/src/types/accounting.ts` (edit: add `PAYMENT_TERM_RULES`, `PaymentTermRule`, `rule: PaymentTermRule` on `PaymentTerm`; add `defaultSalesPaymentTermId: string | null` and `defaultPurchasePaymentTermId: string | null` on `LedgerSettings`; `defaultPaymentTermId: string | null` on `Customer` and `Vendor`), `server/src/utils/dueDate.ts` (new), `client/src/utils/dueDate.ts` (new, identical body, client-local `PaymentTermRule` type), `client/src/__tests__/fixtures/dueDateCases.json` (new), `server/src/__tests__/dueDate.test.ts` (new), `client/src/__tests__/dueDate.test.ts` (new).
- **Contract:**
  ```ts
  export const PAYMENT_TERM_RULES = ['DAYS_AFTER_DATE', 'DAYS_AFTER_MONTH_END', 'DAY_OF_NEXT_MONTH', 'DAY_OF_CURRENT_MONTH'] as const;
  export type PaymentTermRule = (typeof PAYMENT_TERM_RULES)[number];
  /** documentDate and the result are 'YYYY-MM-DD'. Only Date.UTC / getUTC* / setUTC* — never local-time methods. */
  export function computeDueDate(rule: PaymentTermRule, n: number, documentDate: string): string;
  ```
  Fixture: a JSON array of `{ "rule", "n", "date", "expected" }`, exactly these 12 rows:
  | rule | n | date | expected |
  |---|---|---|---|
  | DAYS_AFTER_DATE | 30 | 2026-01-15 | 2026-02-14 |
  | DAYS_AFTER_DATE | 0 | 2026-03-01 | 2026-03-01 |
  | DAYS_AFTER_MONTH_END | 0 | 2026-02-10 | 2026-02-28 |
  | DAYS_AFTER_MONTH_END | 20 | 2026-01-31 | 2026-02-20 |
  | DAYS_AFTER_MONTH_END | 0 | 2028-02-03 | 2028-02-29 |
  | DAY_OF_NEXT_MONTH | 20 | 2026-10-15 | 2026-11-20 |
  | DAY_OF_NEXT_MONTH | 31 | 2026-01-10 | 2026-02-28 |
  | DAY_OF_NEXT_MONTH | 5 | 2026-12-31 | 2027-01-05 |
  | DAY_OF_CURRENT_MONTH | 25 | 2026-10-15 | 2026-10-25 |
  | DAY_OF_CURRENT_MONTH | 10 | 2026-10-15 | 2026-11-10 |
  | DAY_OF_CURRENT_MONTH | 31 | 2026-04-02 | 2026-04-30 |
  | DAY_OF_CURRENT_MONTH | 15 | 2026-10-15 | 2026-10-15 |
  Both test files iterate the fixture with `it.each` and assert `computeDueDate(rule, n, date) === expected`. The server test reads the client fixture exactly as `placeholders.test.ts` does.
- **Guardrails:** none on DB; no Date library (rule 14).
- **Proof:** `cd server && npx vitest run src/__tests__/dueDate.test.ts` → 12 passed; `cd client && npx vitest run src/__tests__/dueDate.test.ts` → 12 passed; `cd server && npm run typecheck` may fail **only** with "missing property rule / defaultSalesPaymentTermId / defaultPaymentTermId" in services that Step 3/4 fix — record and proceed; any other error is a stop.
- **If it fails:** fix the function, never the fixture values (they are the spec).

### Step 3 — [Sonnet] Payment-term service: `rule`, default resolution, document fallback

- **Model:** [Sonnet] — changes how every invoice and bill gets its due date.
- **Depends on:** 1, 2
- **Read first:** `paymentTermService.ts` (whole), `invoiceService.ts` `resolveInvoiceDueDate`, `billService.ts` `resolveBillDueDate`.
- **Files:** `server/src/services/accounting/paymentTermService.ts` (edit), `server/src/schemas/accounting/paymentTermSchema.ts` (edit), `server/src/services/accounting/invoiceService.ts` (edit `resolveInvoiceDueDate` + its 2 call sites), `server/src/services/accounting/billService.ts` (edit `resolveBillDueDate` + its 2 call sites).
- **Contract:**
  - `PAYMENT_TERM_COLUMNS` gains `rule`; `PaymentTermRow.rule: PaymentTermRule`; `toPaymentTerm` maps it. `CreatePaymentTermInput.rule: PaymentTermRule`; `UpdatePaymentTermInput.rule?: PaymentTermRule`. INSERT adds `rule` as `$6`. Update `COLUMNS` map adds `rule: 'rule'`. System-term guard extends to `input.rule !== undefined` (same 409 message). Map `PG_CHECK_VIOLATION` with `constraint === 'ck_payment_terms_rule_day'` → `ApiError(422, 'Day of month must be between 1 and 31')` in create and update.
  - Schema: `createPaymentTermSchema` adds `rule: z.enum(PAYMENT_TERM_RULES).default('DAYS_AFTER_DATE')` and a `.superRefine`: when rule starts with `DAY_OF_` and `netDays` not in 1..31 → issue on `netDays`, message `'Day of month must be between 1 and 31'`. `updatePaymentTermSchema` adds `rule: z.enum(PAYMENT_TERM_RULES).optional()`.
  - `resolveDueDate` body: replace `addDaysIso(documentDate, term.netDays)` with `computeDueDate(term.rule, term.netDays, documentDate)`. `addDaysIso` stays exported (other callers).
  - New:
    ```ts
    export async function resolveDefaultTermCodeOnClient(
      q: Queryable, orgId: string, side: 'SALES' | 'PURCHASE', partyId: string,
    ): Promise<string | null>;
    ```
    One query:
    ```sql
    SELECT COALESCE(pt.code, ot.code) AS code
      FROM (SELECT 1) one
      LEFT JOIN <customers|vendors> p ON p.org_id = $1 AND p.id = $2
      LEFT JOIN payment_terms pt ON pt.org_id = $1 AND pt.id = p.default_payment_term_id AND pt.is_active
      LEFT JOIN ledger_settings s ON s.org_id = $1
      LEFT JOIN payment_terms ot ON ot.org_id = $1 AND ot.is_active
            AND ot.id = <s.default_sales_payment_term_id | s.default_purchase_payment_term_id>
    ```
    The table and column names come from a frozen `const SIDE = { SALES: {...}, PURCHASE: {...} } as const` map (rule 4).
  - `resolveInvoiceDueDate(client, orgId, input)`: input type adds `customerId`. Before calling `resolveDueDate`, if `input.dueDate === undefined && input.paymentTermsCode === null`, set `code = await paymentTermService.resolveDefaultTermCodeOnClient(client, orgId, 'SALES', input.customerId)` and pass `code` instead. Same in `resolveBillDueDate` with `'PURCHASE'`, `input.vendorId`. The 422 message is unchanged when `code` is still null.
- **Guardrails:** #1 `org_id = $1` on every join · #4 identifiers from the frozen map only · #5 `q`/`client` only, never `pool`.
- **Proof:** `cd server && npm run typecheck` clean except errors in `settingsService.ts`, `customerService.ts`, `vendorService.ts` (Step 4); `npx vitest run src/__tests__/accounting/paymentTerms.test.ts src/__tests__/accounting/invoices.test.ts src/__tests__/accounting/bills.test.ts src/__tests__/accounting/recurringSchedules.test.ts` green (no regressions; file name for recurring: `ls src/__tests__/accounting | grep -i recurr`).
- **If it fails:** a regression in an existing test is a bug here, not in the test.

### Step 4 — [Sonnet] Settings, customer, vendor services + schemas + onboarding default

- **Model:** [Sonnet] — tenancy-checked FK writes in three services; onboarding seed.
- **Depends on:** 3
- **Read first:** `settingsService.ts` `updateSettings` (the `INVENTORY_ACCOUNT_FIELDS` pre-validation pattern), `customerService.ts`, `vendorService.ts`.
- **Files:** `settingsService.ts`, `customerService.ts`, `vendorService.ts`, `schemas/accounting/settingsSchema.ts`, `schemas/accounting/customerSchema.ts`, `schemas/accounting/vendorSchema.ts` (all edit); `paymentTermService.ts` (edit: add the assert below).
- **Contract:**
  - `paymentTermService.assertActiveTermOnClient(q: Queryable, orgId: string, termId: string): Promise<void>` — `SELECT 1 FROM payment_terms WHERE org_id = $1 AND id = $2 AND is_active`; none → `ApiError(422, 'Payment term not found or inactive')`. Malformed uuid never reaches it (zod `z.uuid()`).
  - Settings: `SETTINGS_SELECT` adds `s.default_sales_payment_term_id, s.default_purchase_payment_term_id`; `SettingsRow` + `toLedgerSettings` map them; `UpdateSettingsInput` + `COLUMNS` add `defaultSalesPaymentTermId: 'default_sales_payment_term_id'`, `defaultPurchasePaymentTermId: 'default_purchase_payment_term_id'`; inside the transaction, before any write, call `assertActiveTermOnClient` for each non-null value. `updateSettingsSchema` adds both as `z.uuid().nullable().optional()`.
  - Onboarding: the `INSERT INTO ledger_settings` column list gains both columns with the value `(SELECT id FROM payment_terms WHERE org_id = $1 AND code = 'NET_30' AND is_active)` for each; the `ON CONFLICT DO UPDATE SET` list does **not** touch them.
  - Customers/vendors: `*_COLUMNS` add `default_payment_term_id`; row type + mapper `defaultPaymentTermId`; create input + INSERT add it (default `null`); update `COLUMNS` add `defaultPaymentTermId: 'default_payment_term_id'`. Create and update run `assertActiveTermOnClient` when non-null — `createCustomer`/`updateCustomer` already use `withTransaction`; call it on that client before the write. Schemas add `defaultPaymentTermId: z.uuid().nullable().optional()` (create: `.default(null)`).
  - Also map `PG_FOREIGN_KEY_VIOLATION` (`23503`) on any of the four new constraint names → `ApiError(422, 'Payment term not found or inactive')` (defence in depth for a race with nothing).
- **Guardrails:** #1 · #2 (controllers unchanged — they already pass `parseBody` output through; verify with `grep -n "defaultPaymentTermId" server/src/controllers -r` = 0 lines needed) · #5.
- **Proof:** `cd server && npm run typecheck && npm run lint` clean; `npx vitest run src/__tests__/accounting/customers.test.ts src/__tests__/accounting/vendors.test.ts src/__tests__/accounting/settings*.test.ts src/__tests__/onboarding*.test.ts` green (use `ls` to resolve exact names; missing files are skipped, not invented).
- **If it fails:** do not add a controller branch for the new field — the service is the only place it is validated.

### Step 5 — [Sonnet] Integration tests 43a

- **Model:** [Sonnet] — real-PostgreSQL tenancy and resolution-order tests.
- **Depends on:** 4
- **Skill:** isolation-test
- **Read first:** `server/src/__tests__/accounting/paymentTerms.test.ts` (fixtures: `createUserWithOrg`, `loginAgent`, `resetTables`, `revenueAccountId`, `vendorAndExpenseAccount`).
- **Files:** `server/src/__tests__/accounting/paymentTermDefaults.test.ts` (new)
- **Contract — these named cases, these expectations:**
  1. `POST /payment-terms {code:'NEXT20', name:'20th next month', netDays:20, rule:'DAY_OF_NEXT_MONTH'}` → 201, `paymentTerm.rule === 'DAY_OF_NEXT_MONTH'`.
  2. Same with `netDays: 0` → 400 (zod) mentioning `Day of month must be between 1 and 31`.
  3. `PATCH /payment-terms/:NET_30id {rule:'DAY_OF_NEXT_MONTH'}` → 409 (system term).
  4. Vendor with `defaultPaymentTermId` = NEXT20; `POST /bills` with `billDate:'2026-10-15'`, no `dueDate`, `paymentTermsCode:null` → 201, `bill.dueDate === '2026-11-20'`, `bill.paymentTermsCode === 'NEXT20'`.
  5. Vendor with no default, org `PATCH /settings {defaultPurchasePaymentTermId: NET_15 id}` (onboard the org first with the same helper `onboarding*.test.ts` uses) → bill dated 2026-10-15 → `dueDate === '2026-10-30'`.
  6. Explicit `dueDate` beats both defaults.
  7. Invoice side: customer default NET_7 → `dueDate` = issue + 7.
  8. Neither default, neither field → 422 `'Provide a due date or a payment term'`.
  9. Party default is deactivated → falls through to the org default.
  10. **Cross-tenant:** org A `PATCH /customers/:id {defaultPaymentTermId: <org B's NET_30 id>}` → 422 `'Payment term not found or inactive'`; org A `PATCH /settings {defaultSalesPaymentTermId: <org B id>}` → 422.
  11. Onboarding sets both org defaults to the NET_30 id (`GET /settings`).
- **Proof:** `cd server && npx vitest run src/__tests__/accounting/paymentTermDefaults.test.ts` → 11 passed.
- **If it fails:** fix the service; never relax an expected date.

### Step 6 — [Haiku] Client API types + fetch functions

- **Model:** [Haiku] — field transcription.
- **Depends on:** 4
- **Read first:** `client/src/services/fetchServices.ts` `PaymentTerm` (~L1040), `LedgerSettings` (~L773), `LedgerSettingsPatch`, `Customer` (~L986), `Vendor` (~L1583), `createCustomer`/`updateCustomer`/`createVendor`/`updateVendor`/`createPaymentTerm`/`updatePaymentTerm`.
- **Files:** `client/src/services/fetchServices.ts` (edit)
- **Contract:** `PaymentTerm.rule: PaymentTermRule` (import the type from `../utils/dueDate`); `LedgerSettings.defaultSalesPaymentTermId: string | null`, `defaultPurchasePaymentTermId: string | null`; `LedgerSettingsPatch` gains both as optional `string | null`; `Customer.defaultPaymentTermId` / `Vendor.defaultPaymentTermId: string | null`; the create/update body types for customer, vendor gain `defaultPaymentTermId?: string | null`; `createPaymentTerm` body gains `rule?: PaymentTermRule`; `updatePaymentTerm` body gains `rule?: PaymentTermRule`. Update every test fixture object that builds these types (`grep -rln "netDays:" client/src/__tests__`) to add `rule: 'DAYS_AFTER_DATE'`; for customers/vendors/settings fixtures add the new keys as `null`.
- **Proof:** `cd client && npm run typecheck` clean; `npm test` green.
- **If it fails:** type errors in pages are expected to be zero — the fields are additive. Any page error → stop.

### Step 7 — [Sonnet] Client forms: rule picker, party default, org defaults, pre-fill

- **Model:** [Sonnet] — four pages, pre-fill interplay with the existing `dueDateTouched` logic.
- **Depends on:** 6
- **Read first:** `client/src/Pages/purchases/NewBillPage.tsx` L120–240 (term → due-date effect, `dueDateTouched`), `client/src/Pages/sales/NewInvoicePage.tsx` L150–245, `client/src/Pages/settings/PaymentTermsSettingsPage.tsx`, `client/src/Pages/settings/FinancialSettingsPage.tsx` (how an `AccountSelect` is wired to `updateLedgerSettings`).
- **Files:** `NewBillPage.tsx`, `NewInvoicePage.tsx`, `PaymentTermsSettingsPage.tsx`, `FinancialSettingsPage.tsx`, `client/src/Pages/purchases/VendorsPage.tsx`, `client/src/Pages/sales/CustomersPage.tsx` (all edit); `client/src/__tests__/paymentTermDefaults.test.tsx` (new).
- **Contract:**
  - Both new-document pages: the term → due-date effect uses `computeDueDate(term.rule, term.netDays, date)` instead of `addDays(date, term.netDays)`. Add `const [termTouched, setTermTouched] = useState(false)`, set true in the term `<select>`'s `onChange`. On a **new** document (no id, no copy source): after load, set the term code from the org default (`getLedgerSettings()` added to the `Promise.all`; invoice falls back to today's `defaultDueDays` match when `defaultSalesPaymentTermId` is null). An effect on `vendorId`/`customerId`: if `!termTouched && !dueDateTouched` and the party has `defaultPaymentTermId` → set the code to that term's code; else if the party has none → the org default's code.
  - `PaymentTermsSettingsPage`: a "Rule" select with labels `days after the date` / `days after the end of the month` / `of the following month` / `of the current month`; the number input label switches to "Day of month" for the two `DAY_OF_*` rules (min 1, max 31); one example line `Example: a document dated <today> is due <computeDueDate(...)>.` Rule select disabled for `isSystem` rows.
  - `FinancialSettingsPage`: a "Payment terms" section with two selects, `Default terms — sales` and `Default terms — bills`, options = active terms plus `None`; saving calls `updateLedgerSettings({ defaultSalesPaymentTermId, defaultPurchasePaymentTermId })`.
  - `CustomersPage` / `VendorsPage` forms: `Default payment terms` select (active terms + `Organization default`), sending `defaultPaymentTermId` (`null` for org default). VendorsPage relabels the existing free-text field `Payment notes`.
  - Test file cases: (a) a new bill pre-fills the org default term; (b) choosing a vendor with a default switches the term and due date; (c) after the user picks a term manually, choosing another vendor does not change it; (d) the payment-term form shows "Day of month" for `DAY_OF_NEXT_MONTH`. Mock `fetchServices` the way `client/src/__tests__/paymentTerms.test.tsx` does.
- **Proof:** `cd client && npm run typecheck && npm run lint && npx vitest run src/__tests__/paymentTermDefaults.test.tsx src/__tests__/paymentTerms.test.tsx src/__tests__/bills.test.tsx src/__tests__/invoices.test.tsx` green.
- **If it fails:** existing bill/invoice tests that assert a specific due date are a spec — make the pre-fill not fire when the mocked settings have null defaults.

### Step 8 — [Sonnet] 43a docs, study note, guardrail review, commit

- **Model:** [Sonnet] — accuracy tasks.
- **Depends on:** 5, 7
- **Skills:** guardrail-review → study-note → docs-sync
- **Files:** `docs/schema.md` (migration 094 block), `docs/api.md` (payment-term `rule`; settings, customer, vendor fields; the default-resolution rule on POST/PATCH invoices/bills), `docs/accounting.md` (payment-terms section), `docs/roadmap.md` (`### Phase 43 — as delivered` with a 43a sub-bullet), `CLAUDE.md` (one Phase 43 line, extended per slice), `study/architecture/due-date-rules-and-calendar-arithmetic.md` (new: UTC-only date math, month-end clamping, why a pure function + shared fixture beats a date library here, the snapshot-not-FK choice on documents vs FK on defaults; 4–8 Q&A), `study/README.md` index + tracker.
- **Proof:** guardrail-review reports zero violations; `cd server && npm test` and `cd client && npm test` green with counts ≥ baseline + new; commit `Phase 43a: payment-term rule types and org/party default terms` with the attribution trailer.
- **If it fails:** a guardrail violation goes back to the step that introduced it.

---

## Slice 43b — Attachments: vault picker, attach while drafting, linked order

Outcome: a bill can carry files picked from the Documents vault or uploaded while still a draft, and can reference a purchase order; invoices likewise with sales orders.

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| Migration | `server/src/db/migrations/095_ledger-core_document_order_links.sql` |
| Columns | `bills.purchase_order_id UUID NULL`, `invoices.sales_order_id UUID NULL` |
| Constraints / indexes | `fk_bills_purchase_order`, `fk_invoices_sales_order`, `idx_bills_purchase_order`, `idx_invoices_sales_order` |
| Entity types added | `'credit_note'`, `'debit_note'`, `'order'` |
| Filters | `DocumentListFilters.q: string \| null`, `DocumentListFilters.unattached: boolean` |
| Service export | `documentService.attachDocumentsOnClient(client: PoolClient, orgId: string, createdBy: string, documentIds: string[], link: { module: string; entityType: string; entityId: string }): Promise<void>` |
| Input fields | `CreateBillInput.attachmentDocumentIds?: string[]`, `CreateBillInput.purchaseOrderId?: string \| null`, `CreateInvoiceInput.attachmentDocumentIds?: string[]`, `CreateInvoiceInput.salesOrderId?: string \| null` (also on the update inputs) |
| API fields | `Bill.purchaseOrderId`, `Bill.purchaseOrderNumber`, `Invoice.salesOrderId`, `Invoice.salesOrderNumber` |
| Client | `client/src/components/DocumentPickerDialog.tsx`, `client/src/components/PendingAttachments.tsx` |
| Tests | `server/src/__tests__/accounting/documentAttachments.test.ts`, `client/src/__tests__/documentPicker.test.tsx` |

### Step 9 — [Sonnet] Migration 095

- **Model:** [Sonnet] — migration, composite tenancy FK.
- **Depends on:** 8
- **Skill:** new-migration
- **Read first:** `092_ledger-core_orders.sql` (`ux_orders_org_id_id`).
- **Files:** `server/src/db/migrations/095_ledger-core_document_order_links.sql` (new)
- **Contract:** `ALTER TABLE bills ADD COLUMN IF NOT EXISTS purchase_order_id UUID;` `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sales_order_id UUID;` each with `FOREIGN KEY (org_id, <col>) REFERENCES orders (org_id, id) ON DELETE RESTRICT` (drop-if-exists then add) and an index. Backfill (idempotent): set `bills.purchase_order_id` to the single distinct `orders.id` reachable through `bill_lines.order_line_id → order_lines.order_id` when exactly one exists and the column is NULL; same for invoices via `invoice_lines`. **Before writing the backfill, check the posted-row immutability trigger on `bills`/`invoices`** (`grep -n "BEFORE UPDATE" server/src/db/migrations/*bills* server/src/db/migrations/*invoices*`): if it blocks updating any column of a POSTED row, restrict the backfill to `status IN ('DRAFT','AWAITING_APPROVAL')` (bills) / `status = 'DRAFT'` (invoices) and state that in the header. Never disable the trigger.
- **Guardrails:** #6 trigger untouched · #8 · #13.
- **Proof:** `npm run migrate` twice; `npx vitest run src/__tests__/migrations.test.ts` green.
- **If it fails:** stop; do not edit after first apply.

### Step 10 — [Sonnet] Vault: entity types, list filters, `attachDocumentsOnClient`

- **Model:** [Sonnet] — tenancy check on a caller's transaction.
- **Depends on:** 0
- **Read first:** `documentService.ts` `buildFilters`, `attachDocument`; `controllers/documentController.ts` `list`.
- **Files:** `server/src/types/documents.ts`, `server/src/services/documentService.ts`, `server/src/controllers/documentController.ts` (all edit).
- **Contract:**
  - Append `'credit_note', 'debit_note', 'order'` to the accounting list.
  - `DocumentListFilters` gains `q`, `unattached`. In `buildFilters`: `q` → `values.push('%' + escapeLike(q) + '%')` and `d.original_filename ILIKE $n` (escape `%`, `_`, `\` with a local `escapeLike`); `unattached` → `NOT EXISTS (SELECT 1 FROM document_links l WHERE l.org_id = d.org_id AND l.document_id = d.id)`. Controller reads `q` (trimmed, max 100, empty → null) and `unattached` (`'true'` → true) using the same query helpers it uses for `entityType`.
  - `attachDocumentsOnClient`: validates module/entityType exactly as `attachDocument`; dedupes `documentIds`; `SELECT id FROM documents WHERE org_id = $1 AND id = ANY($2::uuid[])` — count mismatch → `ApiError(404, 'Document not found')`; then one `INSERT … SELECT unnest($3::uuid[]) … ON CONFLICT ON CONSTRAINT <the existing link unique constraint name — read it from 030> DO NOTHING`. No `withTransaction` inside.
  - Refactor `attachDocument` to call `attachDocumentsOnClient` inside its `withTransaction`, keeping its 409 on an existing link (check existence first, since the bulk path uses DO NOTHING).
- **Guardrails:** #1 · #4 (`ILIKE` value parameterized) · #5 · #16 (no query against bills/invoices here).
- **Proof:** `cd server && npm run typecheck`; `npx vitest run src/__tests__/platform` green (vault tests live there — `ls src/__tests__/platform`).
- **If it fails:** an existing vault test asserting a message is the spec.

### Step 11 — [Sonnet] Bills/invoices: attachments on create/update, linked order

- **Model:** [Sonnet] — writes inside the document transaction; cross-entity validation.
- **Depends on:** 9, 10
- **Read first:** `billService.ts` `createBillOnClient`, `updateBill`, `getBillById` + its row mapper; `invoiceService.ts` equivalents; `orderService.ts` ~L1040 and ~L1074.
- **Files:** `billService.ts`, `invoiceService.ts`, `orderService.ts`, `schemas/accounting/billSchema.ts`, `schemas/accounting/invoiceSchema.ts`, `server/src/types/accounting.ts` (all edit).
- **Contract:**
  - Schemas (create and update): `attachmentDocumentIds: z.array(z.uuid()).max(20).optional()`, `purchaseOrderId` / `salesOrderId: z.uuid().nullable().optional()`.
  - After the document row is inserted/updated in `createBillOnClient` / `updateBill`, when `attachmentDocumentIds?.length`: `documentService.attachDocumentsOnClient(client, orgId, userId, ids, { module: MODULE_TAGS.accounting, entityType: 'bill', entityId: billId })`. Invoices: `'invoice'`.
  - `purchaseOrderId` non-null → `SELECT vendor_id, status FROM orders WHERE org_id = $1 AND id = $2 AND direction = 'PURCHASE'`; missing → 422 `'Purchase order not found'`; `vendor_id !== input.vendorId` → 422 `'That purchase order belongs to a different vendor'`; status not in `CONFIRMED`,`CLOSED` → 422 `'Only a confirmed or closed purchase order can be referenced'`. Write `purchase_order_id`. Sales mirror: `'Sales order not found'`, `'That sales order belongs to a different customer'`, `'Only a confirmed or closed sales order can be referenced'`.
  - `orderService` conversion calls pass `purchaseOrderId: order.id` / `salesOrderId: order.id`.
  - Reads: bill SELECT adds `b.purchase_order_id` and `(SELECT o.order_number FROM orders o WHERE o.org_id = b.org_id AND o.id = b.purchase_order_id) AS purchase_order_number`; map to `purchaseOrderId`, `purchaseOrderNumber`. Invoice mirror. Types updated.
- **Guardrails:** #1 on the orders lookup · #5 same `client` · #6 update path keeps its existing editable-status guard.
- **Proof:** `cd server && npm run typecheck`; `npx vitest run src/__tests__/accounting/bills.test.ts src/__tests__/accounting/invoices.test.ts src/__tests__/accounting/orders.test.ts` green.

### Step 12 — [Sonnet] Integration tests 43b

- **Model:** [Sonnet] — isolation + rollback.
- **Depends on:** 11
- **Skill:** isolation-test
- **Read first:** vault tests under `server/src/__tests__/platform/`, `server/src/__tests__/helpers/depositFixtures.ts` (`confirmedOrder`, `createVendor`).
- **Files:** `server/src/__tests__/accounting/documentAttachments.test.ts` (new)
- **Contract — cases:**
  1. Upload a PDF, `POST /bills` with `attachmentDocumentIds:[id]` → 201; `GET /documents?module=ledger-core&entityType=bill&entityId=<bill>` → 1 document.
  2. Same with one valid id and one org-B id → 404 `'Document not found'`, and `GET /bills` count unchanged (rollback).
  3. `GET /documents?unattached=true` lists an uploaded, unlinked doc and not a linked one; `?q=inv` matches `invoice-1.pdf` only.
  4. `POST /bills` with a confirmed PO of the same vendor → `bill.purchaseOrderNumber` equals the order's number.
  5. PO of another vendor → 422 `'That purchase order belongs to a different vendor'`.
  6. Org B's PO id under org A → 422 `'Purchase order not found'`.
  7. Converting a confirmed PO to a bill sets `purchaseOrderId`.
  8. `POST /documents/:id/links` with `entityType:'debit_note'` → 201.
- **Proof:** `npx vitest run src/__tests__/accounting/documentAttachments.test.ts` → 8 passed.

### Step 13 — [Haiku] Client fetch layer for 43b

- **Model:** [Haiku] — field transcription.
- **Depends on:** 11
- **Read first:** `fetchServices.ts` `listDocuments` (~L3817), `BillInput`, `InvoiceInput`, `Bill`, `Invoice`.
- **Files:** `client/src/services/fetchServices.ts` (edit)
- **Contract:** `listDocuments` params gain `q?: string`, `unattached?: boolean` (sent as `unattached=true` only when true). `BillInput.attachmentDocumentIds?: string[]`, `BillInput.purchaseOrderId?: string | null`; `InvoiceInput` mirror with `salesOrderId`. `Bill.purchaseOrderId: string | null`, `Bill.purchaseOrderNumber: string | null`; `Invoice.salesOrderId`, `Invoice.salesOrderNumber`. Update test fixtures that build `Bill`/`Invoice` objects with the new keys as `null`.
- **Proof:** `cd client && npm run typecheck && npm test` green.

### Step 14 — [Sonnet] Client: picker, pending attachments, order select, panels on more pages

- **Model:** [Sonnet] — dialog accessibility, form-state wiring across four pages.
- **Depends on:** 13
- **Read first:** `client/src/components/AttachmentsPanel.tsx`, `client/src/components/ConfirmDialog.tsx` (dialog/focus pattern), `client/src/Pages/purchases/BillDetailPage.tsx` `ApplyPrepaymentDialog` (~L610).
- **Files:** `components/DocumentPickerDialog.tsx` (new), `components/PendingAttachments.tsx` (new), `components/AttachmentsPanel.tsx`, `Pages/purchases/NewBillPage.tsx`, `Pages/sales/NewInvoicePage.tsx`, `Pages/purchases/BillDetailPage.tsx`, `Pages/sales/InvoiceDetailPage.tsx`, `Pages/purchases/DebitNoteDetailPage.tsx`, `Pages/sales/CreditNoteDetailPage.tsx`, `Pages/purchases/PurchaseOrderDetailPage.tsx`, `Pages/sales/SalesOrderDetailPage.tsx` (edit), `client/src/__tests__/documentPicker.test.tsx` (new).
- **Contract:**
  - `DocumentPickerDialog({ open, onClose, onPick(ids: string[]), excludeIds: string[] })`: `role="dialog"`, `aria-label="Choose from Documents"`; search box (debounced with the existing debounce hook used by list pages — `grep -rn "useDebounced" client/src/hooks`), a `Not yet attached` checkbox (default on → `unattached: true`), rows with checkbox, filename, size, upload date; `Attach` button disabled until one is checked.
  - `AttachmentsPanel`: add a `Choose from Documents` button beside upload (hidden when `readOnly`) → picker → `attachDocument` per id → reload. Add drag-and-drop on the panel container (`onDragOver` preventDefault; `onDrop` → same upload path as the file input).
  - `PendingAttachments({ value: VaultDocument[], onChange })`: the same two entry points (upload → `uploadDocument`, picker) but holds documents in state; renders removable chips. Both new-document pages render it under the lines and send `attachmentDocumentIds: pending.map(d => d.id)` in create/update.
  - `NewBillPage`: `Purchase order` select, loaded from `listOrders({ direction: 'PURCHASE', vendorId, status: 'CONFIRMED' })` when a vendor is chosen (check `listOrders`'s actual param names at ~L6032 and use them), option `None`. `NewInvoicePage` mirror with sales orders.
  - Detail pages: bill shows `Purchase order <Link to={/purchase-orders/:id}>PO number</Link>` when set; invoice shows the sales order. Mount `AttachmentsPanel` on debit note (`entityType="debit_note"`), credit note (`"credit_note"`), both order pages (`"order"`).
  - Tests: picker lists only unattached by default; attaching calls `attachDocument` for each picked id; a new bill sends `attachmentDocumentIds` from pending uploads.
- **Proof:** `cd client && npm run typecheck && npm run lint && npx vitest run src/__tests__/documentPicker.test.tsx src/__tests__/AttachmentsPanel.test.tsx src/__tests__/bills.test.tsx src/__tests__/invoices.test.tsx` green.

### Step 15 — [Sonnet] 43b docs, study note, review, commit

- **Model:** [Sonnet]
- **Depends on:** 12, 14
- **Skills:** guardrail-review → study-note → docs-sync
- **Files:** `docs/schema.md` (095), `docs/api.md` (documents `q`/`unattached`; bill/invoice new fields; new entity types), `docs/accounting.md`, `docs/roadmap.md` (43b), `CLAUDE.md`, extend `study/architecture/file-storage-and-streaming.md` (linking inside the owning document's transaction; unlinked uploads as a staging area) and `study/postgresql/composite-foreign-keys-for-tenancy.md` (FK to `orders`), `study/README.md`.
- **Proof:** zero guardrail violations; full server + client suites green; commit `Phase 43b: attach from the vault or while drafting, link orders to bills and invoices`.

---

## Slice 43c — Apply open credit on bill approval / invoice issue

Outcome: approving a bill (issuing an invoice) offers the party's open debit notes and prepayments (credit notes and deposits), and applies the chosen ones atomically with the approval.

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| New file | `server/src/services/accounting/availableCreditsService.ts` → `listAvailableCredits(orgId: string, direction: 'SALES' \| 'PURCHASE', documentId: string): Promise<AvailableCredits>` |
| Type | `AvailableCredit = { kind: 'NOTE' \| 'DEPOSIT'; id: string; number: string \| null; date: string; currencyCode: string; availableCents: number }`; `AvailableCredits = { credits: AvailableCredit[] }` in `server/src/types/accounting.ts` |
| OnClient cores | `debitNoteService.applyDebitNoteOnClient(client, orgId, userId, id, input)`, `creditNoteService.applyCreditNoteOnClient(client, orgId, userId, id, input)`, `depositService.applyDepositOnClient(client, orgId, userId, direction, targetId, input)` |
| Body field | `applyCredits: { kind: 'NOTE' \| 'DEPOSIT'; id: string; amountCents: number }[]` (max 20) on `approveBillSchema` and `issueInvoiceSchema` |
| Routes | `GET /api/v1/bills/:id/available-credits` (`bills.approve`), `GET /api/v1/invoices/:id/available-credits` (`invoices.issue`) |
| Client | `client/src/components/ApplyCreditsDialog.tsx`; fetch `getAvailableCredits(direction, id)` |
| Tests | `server/src/__tests__/accounting/applyCreditsOnApproval.test.ts`, `client/src/__tests__/applyCreditsDialog.test.tsx` |

### Step 16 — [Sonnet] Split the three apply functions into `*OnClient` cores

- **Model:** [Sonnet] — transaction boundaries in money code.
- **Depends on:** 15
- **Read first:** `debitNoteService.ts` `applyDebitNote` (L941–), `creditNoteService.ts` `applyCreditNote` (L920–), `depositService.ts` `applyDeposit` (L390–562); `services/inventory/movementService.ts` for the existing `*OnClient` split style.
- **Files:** those three services (edit).
- **Contract:** move everything between `beginTransaction` and `COMMIT` into the new `*OnClient` function (same parameters plus `client` first, same return value **except** it returns the id/record without re-reading via `pool` — `applyDebitNoteOnClient`/`applyCreditNoteOnClient` return `Promise<void>`; `applyDepositOnClient` returns `Promise<DepositApplication>` using the existing `getApplicationOnClient`). The public functions become: connect → `beginTransaction` → core → `COMMIT` → (existing re-read) with their existing catch/ROLLBACK/error mapping unchanged.
- **Guardrails:** #5 — no `pool` inside a core · behaviour identical.
- **Proof:** `cd server && npm run typecheck`; `npx vitest run src/__tests__/accounting/debitNotes.test.ts src/__tests__/accounting/creditNotes.test.ts src/__tests__/accounting/deposits.test.ts src/__tests__/accounting/noteSettlement.test.ts` green with the **same** pass count as before the edit.
- **If it fails:** any behaviour change is a defect — revert to a byte-for-byte move.

### Step 17 — [Sonnet] `availableCreditsService`

- **Model:** [Sonnet] — settlement arithmetic and legality rules.
- **Depends on:** 16
- **Read first:** `debitNoteService.ts` L975–990 (unapplied calc), `depositService.ts` L425–466 (order-link check, received-and-unapplied calc), `settlementSql.ts` `settledCentsOnClient`.
- **Files:** `server/src/services/accounting/availableCreditsService.ts` (new), `server/src/types/accounting.ts` (edit).
- **Contract:** inside `withTransaction` (read-only, for one snapshot):
  1. Load the target: `SELECT id, status, kind, <party> AS party_id, currency_code FROM <bills|invoices> WHERE org_id = $1 AND id = $2` (table/columns from a frozen `SIDE` map). Missing → 404 `'Bill not found'` / `'Invoice not found'`. `kind <> 'STANDARD'` or status not in (bills: `DRAFT`,`AWAITING_APPROVAL`; invoices: `DRAFT`) → `{ credits: [] }`.
  2. Notes: `SELECT n.id, n.<number> AS number, n.issue_date::text AS date, n.currency_code, n.total_cents - COALESCE(SUM(a.amount_cents),0) AS available FROM <debit_notes|credit_notes> n LEFT JOIN <…_allocations> a ON a.org_id = n.org_id AND a.<note_fk> = n.id WHERE n.org_id = $1 AND n.<party> = $2 AND n.status = 'ISSUED' AND n.currency_code = $3 GROUP BY n.id HAVING n.total_cents - COALESCE(SUM(a.amount_cents),0) > 0 ORDER BY n.issue_date, n.id`. When the target currency ≠ base currency, return no notes (a foreign-currency note applies only to its own original, which is already posted and cannot be this draft).
  3. Deposits (only when target currency = base): DEPOSIT-kind documents of the same party, open status (`POSTED`/`ISSUED`), same currency, whose `deposit_for_order_id` is the `order_id` of some `order_lines` row referenced by the target's lines; `availableCents` = `settledCentsOnClient(...).paidCents` − Σ POSTED `deposit_applications` for it; keep > 0. Order by document date, id.
  4. Return `{ credits: [...notes as kind 'NOTE', ...deposits as kind 'DEPOSIT'] }`. All amounts integer cents via `parseCents`.
- **Guardrails:** #1 on every statement · #3 integers only · #4 frozen map.
- **Proof:** `cd server && npm run typecheck && npm run lint` clean.

### Step 18 — [Sonnet] `applyCredits` on approve/issue + available-credits routes

- **Model:** [Sonnet] — one transaction spanning posting and allocations; lock order; extra permission check.
- **Depends on:** 17
- **Read first:** `billService.ts` `approveBill` (L1502), `invoiceService.ts` `issueInvoice` (L1235), `billController.approve`, `invoiceController.issue`, `middleware/rbac.ts` `loadAccess`.
- **Files:** `billService.ts`, `invoiceService.ts`, `controllers/accounting/billController.ts`, `controllers/accounting/invoiceController.ts`, `routes/accounting/billRoutes.ts`, `routes/accounting/invoiceRoutes.ts`, `schemas/accounting/billSchema.ts`, `schemas/accounting/invoiceSchema.ts` (edit).
- **Contract:**
  - Schema: `applyCredits: z.array(z.object({ kind: z.enum(['NOTE','DEPOSIT']), id: z.uuid(), amountCents: z.int().positive() })).max(20).default([])`. Duplicate `id` → refine error `'Each credit can be listed once'`.
  - `approveBill(orgId, userId, id, entryDate, applyCredits: ApplyCreditInput[] = [])` and `issueInvoice(…same)`. After `approveBillOnClient`/`issueInvoiceOnClient`, inside the same transaction:
    - `allocationDate` = the later of the document date and the credit's date (read the document date from the row the posting just locked; credit date is enforced by the cores, which already reject an earlier date — pass the later of the two).
    - Process `NOTE` entries sorted by id ascending, then `DEPOSIT` entries sorted by id ascending. NOTE → `applyDebitNoteOnClient(client, orgId, userId, credit.id, { billId: id, amountCents, allocationDate })` (invoice: `applyCreditNoteOnClient` with `invoiceId`). DEPOSIT → `applyDepositOnClient(client, orgId, userId, 'PURCHASE' | 'SALES', id, { depositDocumentId: credit.id, amountCents, applicationDate: allocationDate })`.
    - The cores' own 422s (exceeds due, different party, currency) propagate and roll back the approval.
    - In the catch, add: `pgErrorCode(err) === '40P01'` → `ApiError(409, 'Another change to these documents was in progress — try again')`.
  - Controllers: parse `{ entryDate, applyCredits }`; if any `kind === 'NOTE'`, `const access = await loadAccess(req)` and require `debit_notes.issue` (bill) / `credit_notes.issue` (invoice), else `ApiError(403, 'Applying a debit note needs the "Issue and apply debit notes" permission.')` / `'Applying a credit note needs the "Issue and apply credit notes" permission.'`. Pass through to the service.
  - New handlers `availableCredits` in both controllers → `res.json({ success: true, ...await availableCreditsService.listAvailableCredits(user.orgId, 'PURCHASE'|'SALES', id) })`. Routes: `router.get('/:id/available-credits', authenticate, requirePermission('bills.approve'), billController.availableCredits)`; invoice with `invoices.issue`. Place before any `/:id` catch-all GET if ordering matters.
  - Capture auto-post, recurring sweep, imports and order conversion call the `*OnClient` posting functions directly and never pass credits — no change there (verify with `grep -rn "approveBill(\|issueInvoice(" server/src/services` that only controllers call the wrappers).
- **Guardrails:** #2 the permission check uses `loadAccess` only, no SQL in controllers · #5 one client end to end · #7 every core posts balanced entries through `journalService` (unchanged) · router-walking permission test must stay green (`src/__tests__/rbac.test.ts`).
- **Proof:** `cd server && npm run typecheck && npm run lint`; `npx vitest run src/__tests__/rbac.test.ts src/__tests__/accounting/bills.test.ts src/__tests__/accounting/invoices.test.ts` green.

### Step 19 — [Sonnet] Integration tests 43c

- **Model:** [Sonnet]
- **Depends on:** 18
- **Skill:** isolation-test
- **Read first:** `server/src/__tests__/accounting/debitNotes.test.ts`, `deposits.test.ts`, `helpers/depositFixtures.ts`, `src/__tests__/integrity.test.ts` (how integrity checks are invoked).
- **Files:** `server/src/__tests__/accounting/applyCreditsOnApproval.test.ts` (new)
- **Contract — cases (amounts in cents):**
  1. Vendor V: bill B1 10000 approved; debit note DN 3000 on B1 issued — auto-applies to B1 (Phase 26 behaviour), so first pay B1 fully, then issue DN → DN unapplied 3000. New bill B2 15000 → `GET /bills/B2/available-credits` lists DN with `availableCents: 3000`.
  2. `POST /bills/B2/approve {applyCredits:[{kind:'NOTE', id: DN, amountCents: 3000}]}` → 200; B2 amount due 12000; DN unapplied 0; vendor ledger closing = open items outstanding (`GET /vendors/V/ledger` vs `/open-items`).
  3. Over-application 20000 → 422 `'Amount exceeds the amount still due on this bill'`; B2 still `AWAITING_APPROVAL`/`DRAFT` (whatever it was) and DN unchanged.
  4. Another vendor's note → 422 `'That bill belongs to a different vendor'`; approval rolled back.
  5. Org B's note id → 404 or 422 (the core's existing not-found status — assert the exact value it returns today), approval rolled back.
  6. Prepayment: confirmed PO → prepayment bill paid 5000 → final bill from the PO → available-credits lists the prepayment 5000 → approve applying it → amount due reduced by 5000; journal shows Dr AP / Cr 1150.
  7. Invoice side: customer credit note unapplied 2000 → `POST /invoices/:id/issue` with it → amount due reduced.
  8. A member whose role has `bills.approve` but not `debit_notes.issue` (create the custom role via `/settings/roles` as `customRoles` tests do) → 403 with the permission message; with `applyCredits: []` → 200.
  9. `applyCredits` with the same id twice → 400.
  10. After cases 2, 6, 7: run the integrity verifier the way `integrity.test.ts` does → zero failures.
- **Proof:** `npx vitest run src/__tests__/accounting/applyCreditsOnApproval.test.ts` → 10 passed.

### Step 20 — [Haiku] Client fetch layer for 43c

- **Model:** [Haiku]
- **Depends on:** 18
- **Read first:** `fetchServices.ts` `approveBill` (~L2364), `issueInvoice` (~L1486).
- **Files:** `client/src/services/fetchServices.ts` (edit)
- **Contract:** `export interface AvailableCredit { kind: 'NOTE' | 'DEPOSIT'; id: string; number: string | null; date: string; currencyCode: string; availableCents: number }`; `export function getAvailableCredits(direction: 'PURCHASE' | 'SALES', id: string): Promise<{ success: boolean; credits: AvailableCredit[] }>` → `GET /bills/:id/available-credits` or `/invoices/:id/available-credits`. `approveBill` and `issueInvoice` gain an optional `applyCredits?: { kind: 'NOTE' | 'DEPOSIT'; id: string; amountCents: number }[]` sent in the body.
- **Proof:** `cd client && npm run typecheck` clean.

### Step 21 — [Sonnet] `ApplyCreditsDialog` on bill approve and invoice issue

- **Model:** [Sonnet] — money input parsing, allocation pre-fill, two pages.
- **Depends on:** 20
- **Read first:** `BillDetailPage.tsx` approve flow (`confirmAction === 'approve'` ~L527) and `ApplyPrepaymentDialog` (~L610); `InvoiceDetailPage.tsx` issue flow; `client/src/utils/money.ts` (parse/format helpers).
- **Files:** `client/src/components/ApplyCreditsDialog.tsx` (new), `BillDetailPage.tsx`, `InvoiceDetailPage.tsx` (edit), `client/src/__tests__/applyCreditsDialog.test.tsx` (new).
- **Contract:**
  - Approve/Issue click → `getAvailableCredits`. Empty list → the existing `ConfirmDialog` path, unchanged. Non-empty → `ApplyCreditsDialog({ title, documentTotalCents, amountDueCents, credits, busy, onConfirm(applyCredits), onSkip(), onCancel() })`.
  - Dialog: `role="dialog"`, heading `Apply available credit?`; one row per credit: checkbox, `Debit note DN-0003` / `Credit note CN-0003` / `Prepayment <number>` / `Deposit <number>`, date, available (formatted), amount input. Pre-fill: oldest first, each checked with `min(available, remaining)` until remaining is 0; later rows unchecked. Footer: `Remaining due: <formatted>`. Buttons: `Approve and apply` (`Issue and apply` on invoices) — disabled when any amount > its available or the total > due; `Approve only` / `Issue only` → `onSkip`; `Cancel`.
  - Confirm → `approveBill(id, { entryDate, applyCredits })` / `issueInvoice(...)`; on error show the server message in the dialog.
  - Tests: (a) no credits → plain confirm dialog; (b) two credits, total 10000, credits 6000 and 7000 → pre-filled 6000 + 4000, remaining 0; (c) "Approve only" sends `applyCredits` empty or absent; (d) editing an amount above available disables the primary button.
- **Proof:** `cd client && npm run typecheck && npm run lint && npx vitest run src/__tests__/applyCreditsDialog.test.tsx src/__tests__/bills.test.tsx src/__tests__/invoices.test.tsx` green.

### Step 22 — [Sonnet] 43c docs, study note, review, commit

- **Model:** [Sonnet]
- **Depends on:** 19, 21
- **Skills:** guardrail-review → study-note → docs-sync
- **Files:** `docs/api.md` (two GET routes; `applyCredits` on approve/issue with every error), `docs/accounting.md` (lock order: document → notes → deposits; atomicity), `docs/roadmap.md` (43c), `CLAUDE.md`, extend `study/architecture/credit-and-debit-notes.md` (applying several allocations atomically with the posting; deterministic lock order; `40P01` and why the database detects rather than prevents a cross-path deadlock), `study/README.md`.
- **Proof:** zero violations; full suites green; `cd server && npm run verify:integrity` clean on the dev DB; commit `Phase 43c: offer open credits and prepayments when approving a bill or issuing an invoice`.

---

## Slice 43d — Email-in address for the bill inbox

Outcome: each organization has an address; a forwarded email's PDF/PNG/JPEG attachments land in the bill inbox exactly like a direct upload.

**Names — use exactly these, do not rename:**

| Kind | Name |
|---|---|
| Migration | `server/src/db/migrations/096_platform_inbound_mail.sql` |
| Tables | `inbound_mail_addresses (id, org_id, token, purpose, is_active, created_by, created_at, rotated_at)`, `inbound_messages (id, org_id, address_id, provider, provider_message_id, from_address, subject, received_at, status, attachment_count, imported_count, error, created_at)` |
| Constraints | `ux_inbound_mail_addresses_token UNIQUE (token)`, `ux_inbound_mail_addresses_org_active` partial unique `(org_id, purpose) WHERE is_active`, `ux_inbound_messages_provider_msg UNIQUE (org_id, provider, provider_message_id)`, status CHECK `('RECEIVED','IMPORTED','PARTIAL','REJECTED','FAILED')`, purpose CHECK `('VENDOR_BILL')`, token CHECK `token ~ '^[a-z2-7]{16}$'` |
| Env | `INBOUND_MAIL = off \| brevo` (default `off`), `INBOUND_MAIL_DOMAIN` (required when brevo), `INBOUND_MAIL_WEBHOOK_SECRET` (≥ 32 chars when brevo) in `config/env.ts` |
| Services | `server/src/services/integrations/inboundMailService.ts` (address CRUD, `recordInboundBatch`, `processInboundMessage`), `server/src/services/integrations/brevoInbound.ts` (payload parsing + `downloadAttachment(token): Promise<Buffer>` via `fetch`) |
| Routes | `GET /api/v1/integrations/inbound-mail` (`capture.view`), `POST /api/v1/integrations/inbound-mail/rotate` (`capture.process`), `GET /api/v1/integrations/inbound-mail/messages` (`capture.view`), `POST /api/v1/public/inbound-mail/brevo/:secret` (no auth; mounted with the other `/public` routes) |
| Queue job | `inbound-mail-process` on the existing worker queue, payload `{ orgId, messageId }` |
| Client | `client/src/Pages/inbox/InboxEmailInCard.tsx` (verify the inbox folder name with `ls client/src/Pages`) |
| Tests | `server/src/__tests__/integrations/inboundMail.test.ts`, `client/src/__tests__/inboxEmailIn.test.tsx` |

### Step 23 — [Sonnet] Migration 096

- **Model:** [Sonnet]
- **Depends on:** 22
- **Skill:** new-migration
- **Read first:** the Drive integration migration (`ls server/src/db/migrations | grep -i drive`) for platform-integration conventions; `082` email outbox for status CHECK style.
- **Files:** `096_platform_inbound_mail.sql` (new) — the tables and constraints in the registry; `org_id … REFERENCES organizations(id) ON DELETE CASCADE`; `created_by … REFERENCES users(id) ON DELETE RESTRICT`; `inbound_messages.(org_id, address_id) → inbound_mail_addresses (org_id, id) ON DELETE CASCADE` (add `UNIQUE (org_id, id)` on addresses); indexes on `(org_id, received_at DESC)` and every FK column.
- **Proof:** migrate twice; `migrations.test.ts` green; `resetTables()` in `__tests__/helpers/factories.ts` gains both tables (edit, in this step) — `npx vitest run src/__tests__/organizations.test.ts` green.

### Step 24 — [Sonnet] Env, Brevo client, inbound service

- **Model:** [Sonnet] — untrusted input, external HTTP, secrets.
- **Depends on:** 23
- **Read first:** `services/integrations/driveIntakeDispatcher.ts` (dispatch + outcome mapping), the Brevo mail transport under `services/mail/` (fetch + `api-key` header style), `config/env.ts` L195–250.
- **Files:** `config/env.ts`, `services/integrations/brevoInbound.ts`, `services/integrations/inboundMailService.ts` (new/edit).
- **Contract:**
  - Env validation: `INBOUND_MAIL=brevo` requires `BREVO_API_KEY`, `INBOUND_MAIL_DOMAIN`, and `INBOUND_MAIL_WEBHOOK_SECRET` length ≥ 32, else boot fails with a named problem line (same style as the existing ones).
  - `brevoInbound.parseBatch(body: unknown): ParsedInboundEmail[]` — zod: `{ items: [{ MessageId: string, From: { Address: string }, Recipients: string[], Subject?: string, Attachments?: [{ Name: string, ContentType: string, ContentLength: number, DownloadToken: string }] }] }`, unknown keys ignored. `downloadAttachment(token)`: `fetch('https://api.brevo.com/v3/inbound/attachments/' + encodeURIComponent(token), { headers: { 'api-key': env.BREVO_API_KEY } })` with an `AbortSignal.timeout(15_000)`; non-200 → throw; body capped at `MAX_UPLOAD_BYTES` (stream read with a running byte count; over → throw `'Attachment too large'`).
  - `inboundMailService`:
    - `getOrCreateAddress(orgId, userId)`, `rotateAddress(orgId, userId)` (deactivate current, insert new token `base32(randomBytes(10))` lowercased, 16 chars) — return `{ address: token + '@' + env.INBOUND_MAIL_DOMAIN, rotatedAt }`.
    - `recordInboundBatch(emails)`: for each email, for each recipient whose domain equals `INBOUND_MAIL_DOMAIN` (case-insensitive), look up the active address by `token` (local part, lowercased) — **the only query in this phase without an `org_id` predicate, because the token is how the org is discovered; document this in the file header** — then `INSERT … ON CONFLICT ON CONSTRAINT ux_inbound_messages_provider_msg DO NOTHING RETURNING id`; for a new row enqueue `inbound-mail-process`. Unknown token → skipped silently (no oracle). Store attachment metadata needed for processing in the job payload (`DownloadToken`, `Name`, `ContentType`), never in logs.
    - `processInboundMessage(orgId, messageId, attachments)`: for each attachment with `ContentType` in `application/pdf`, `image/png`, `image/jpeg` and `ContentLength ≤ MAX_UPLOAD_BYTES`: download → `captureDocumentService.captureFile(orgId, address.created_by, { buffer, originalname: Name })`. Final status: all imported → `IMPORTED`; some → `PARTIAL`; none eligible → `REJECTED` with `error 'No PDF, PNG or JPEG attachment'`; exception → `FAILED` with the message truncated to 500 chars. Every update `WHERE org_id = $1 AND id = $2`.
- **Guardrails:** #1 (one documented exception) · #4 · #11 never log tokens or payload bodies · #14 no new package (zod, fetch, crypto only) · #16 capture reached through `captureDocumentService` only.
- **Proof:** `cd server && npm run typecheck && npm run lint` clean.

### Step 25 — [Sonnet] Controller, routes, worker handler

- **Model:** [Sonnet] — a public unauthenticated endpoint.
- **Depends on:** 24
- **Read first:** the Stripe public webhook controller/route (`grep -rn "stripe/webhook" server/src/routes`) for public-route mounting, raw-body handling and rate limiting; the worker's queue handler registry (`grep -rn "recurring-sweep" server/src`).
- **Files:** `controllers/integrations/inboundMailController.ts` (new), `routes/integrations/inboundMail.ts` (new), the public router file (edit), the worker handler registry (edit), `app.ts` mount (edit).
- **Contract:** Public handler: `crypto.timingSafeEqual` on equal-length buffers of `req.params.secret` and the env secret (length mismatch → 404, not 401 — no oracle); `INBOUND_MAIL=off` → 404; parse → `recordInboundBatch` → `200 { success: true }` always after a valid secret, even if zero recipients matched (so Brevo does not retry). JSON body limit 1 MB on this route. Authenticated routes per the registry, response keys `{ success, address, rotatedAt }` and `{ success, messages, totalCount, currentPage, totalPages }` (pagination per `docs/api.md`). Worker: `inbound-mail-process` → `processInboundMessage`, 3 attempts with the queue's existing backoff.
- **Guardrails:** #2 · router-walking permission test: the public route must be registered the same way the Stripe webhook is exempted (read how that test exempts it).
- **Proof:** `npx vitest run src/__tests__/rbac.test.ts src/__tests__/app.test.ts` green.

### Step 26 — [Sonnet] Integration tests 43d (fake Brevo)

- **Model:** [Sonnet]
- **Depends on:** 25
- **Skill:** isolation-test
- **Read first:** `server/src/__tests__/integrations/` (how Drive tests stub `fetch` and run queue handlers inline).
- **Files:** `server/src/__tests__/integrations/inboundMail.test.ts` (new)
- **Contract — cases:** (1) `GET /integrations/inbound-mail` creates and returns an address ending `@<domain>`; (2) rotate → new token, old one no longer routes; (3) webhook with wrong secret → 404, nothing stored; (4) valid batch with one PDF attachment (stub `fetch` to return a fixture PDF from the existing capture test fixtures) → after running the job, one capture document exists for org A, message `IMPORTED`; (5) same `MessageId` again → no second message, no second capture document; (6) a `.docx` only → `REJECTED`; (7) org B's address in `Recipients` creates nothing in org A, and org A's `GET /integrations/inbound-mail/messages` never lists org B messages (cross-tenant); (8) `INBOUND_MAIL=off` → 404.
- **Proof:** `npx vitest run src/__tests__/integrations/inboundMail.test.ts` → 8 passed.

### Step 27 — [Haiku] Client: email-in card

- **Model:** [Haiku] — response shapes are fixed above; mirror an existing settings card.
- **Depends on:** 25
- **Read first:** `client/src/Pages/settings/InboxSettingsPage.tsx`, `client/src/Pages/settings/ConnectionsPage.tsx` (copy-to-clipboard + list pattern).
- **Files:** `client/src/services/fetchServices.ts` (add `getInboundMailAddress()`, `rotateInboundMailAddress()`, `listInboundMessages({page})`), `InboxEmailInCard.tsx` (new), `InboxSettingsPage.tsx` (edit: render the card), `client/src/__tests__/inboxEmailIn.test.tsx` (new).
- **Contract:** card titled `Email bills in`; shows the address with a `Copy` button (`navigator.clipboard.writeText`), a `Generate new address` button behind `ConfirmDialog` (`The current address will stop working.`), and a table of recent messages: received, from, subject, status, imported/attachments. When `GET` returns 404 (feature off), render nothing. Tests: renders address; copy calls clipboard; rotate confirms then calls `rotateInboundMailAddress`.
- **Proof:** `cd client && npm run typecheck && npm run lint && npx vitest run src/__tests__/inboxEmailIn.test.tsx` green.

### Step 28 — [Sonnet] 43d docs, study note, review, commit; close the plan

- **Model:** [Sonnet]
- **Depends on:** 26, 27
- **Skills:** guardrail-review → study-note → docs-sync
- **Files:** `docs/schema.md` (096), `docs/api.md` (four routes), `docs/capture.md` (email-in intake), `docs/development.md` (env vars; Brevo inbound setup: two MX records on a receiving subdomain — priority 10 `inbound1.sendinblue.com.`, 20 `inbound2.sendinblue.com.` — and `POST https://api.brevo.com/v3/webhooks {type:'inbound', events:['inboundEmailProcessed'], domain, url}`), `server/.env.example`, `docs/roadmap.md` (Phase 43 complete, with "Deliberately not built"), `CLAUDE.md`, `study/architecture/inbound-email-webhooks.md` (new: MX → provider → webhook; secret-in-path vs signatures; idempotency by provider message id; why processing is queued; untrusted attachments), `study/README.md`. Set this file's `Status:` to done.
- **Proof:** zero violations; full suites green; commit `Phase 43d: email-in address for the bill inbox`.

---

## Dispatch manifest

| Batch | Step | Tier | Title | Depends on | Blocks | Status |
|---|---|---|---|---|---|---|
| A | 0 | Sonnet | Baseline | — | all | done — 2197 server (2 skipped) + 632 client |
| A | 1 | Sonnet | Migration 094 | 0 | 3 | done |
| B | 2 | Haiku | Types + `computeDueDate` + fixture | 0 | 3 | done |
| C | 3 | Sonnet | Term service, default resolution | 1,2 | 4 | done (amended — see Plan amendments) |
| C | 4 | Sonnet | Settings/customer/vendor defaults | 3 | 5,6 | done |
| C | 5 | Sonnet | 43a integration tests | 4 | 8 | done |
| D | 6 | Haiku | Client types 43a | 4 | 7 | done |
| E | 7 | Sonnet | Client forms 43a | 6 | 8 | done |
| E | 8 | Sonnet | 43a docs/review/commit | 5,7 | 9 | done — commit 37f21d6 (2220 server + 648 client) |
| E | 9 | Sonnet | Migration 095 | 8 | 11 | done |
| E | 10 | Sonnet | Vault filters + `attachDocumentsOnClient` | 0 | 11 | done |
| E | 11 | Sonnet | Bill/invoice attachments + order link | 9,10 | 12,13 | done |
| E | 12 | Sonnet | 43b integration tests | 11 | 15 | done |
| F | 13 | Haiku | Client fetch 43b | 11 | 14 | done |
| G | 14 | Sonnet | Picker, pending attachments, order select | 13 | 15 | done |
| G | 15 | Sonnet | 43b docs/review/commit | 12,14 | 16 | done — commit 5936986 (2229 server + 651 client) |
| G | 16 | Sonnet | `*OnClient` apply cores | 15 | 17 | done |
| G | 17 | Sonnet | `availableCreditsService` | 16 | 18 | done |
| G | 18 | Sonnet | `applyCredits` on approve/issue + routes | 17 | 19,20 | done |
| G | 19 | Sonnet | 43c integration tests | 18 | 22 | done |
| H | 20 | Haiku | Client fetch 43c | 18 | 21 | done |
| I | 21 | Sonnet | `ApplyCreditsDialog` | 20 | 22 | done |
| I | 22 | Sonnet | 43c docs/review/commit | 19,21 | 23 | done — commit 9bcb461 (2239 server + 656 client, integrity clean) |
| I | 23 | Sonnet | Migration 096 | 22 | 24 | done |
| I | 24 | Sonnet | Env, Brevo client, inbound service | 23 | 25 | done |
| I | 25 | Sonnet | Controller, routes, worker | 24 | 26,27 | done |
| I | 26 | Sonnet | 43d integration tests | 25 | 28 | done |
| J | 27 | Haiku | Email-in card | 25 | 28 | done |
| K | 28 | Sonnet | 43d docs/review/commit; close plan | 26,27 | — | done — commit 695fffa (2249 server + 660 client, integrity clean) |

Batches: A (Sonnet 0–1) → B (Haiku 2) → C (Sonnet 3–5) → D (Haiku 6) → E (Sonnet 7–12) → F (Haiku 13) → G (Sonnet 14–19) → H (Haiku 20) → I (Sonnet 21–26) → J (Haiku 27) → K (Sonnet 28). Step 10 depends only on 0 and may run early inside a Sonnet batch, but keep manifest order unless the user says otherwise.

Do **not** split: step 18 (posting + allocations share one transaction); steps 3–4 must land before any 43a test; each slice's last step is its commit — never commit two slices together.

## Plan amendments

- **Step 3 (2026-10-15, found at step 5):** `createBillSchema` / `createInvoiceSchema` (and their `update*` aliases) ended with a `.refine` rejecting "no `dueDate` and `paymentTermsCode: null`" as 400, which made the default-term fallback unreachable through the API. Resolved per *Decisions fixed at plan time* (the 422 is the service's, unchanged): the `.refine` is removed from both schemas; `resolveDueDate` remains the only place that rule is enforced. Step 3's files gain `schemas/accounting/billSchema.ts` and `invoiceSchema.ts`; `paymentTerms.test.ts`'s one "neither field" assertion moves from 400 to 422 + message.
- **Step 7:** org defaults read from the existing `useLedgerSettings()` context, not a second `getLedgerSettings()` fetch. Customer/vendor pages have only a create form, so the default-terms select is on create only.
- **Step 11:** `updateBill`/`updateInvoice` gain a trailing `userId` (needed as `createdBy` for `attachDocumentsOnClient`; controllers are the only callers). On update, an omitted `purchaseOrderId`/`salesOrderId` leaves the link unchanged; `null` clears it. Order validation lives in `orderLineLinks.assertOrderReferenceOnClient`, shared by both sides.
- **Step 12:** 9 cases (case 3 split in two, plus a literal `q=%` case for `escapeLike`).
- **Step 14:** the debit/credit-note and PO/SO detail pages are one-line wrappers; `AttachmentsPanel` is mounted in the shared `sales/notes/NoteDetailPage.tsx` and `sales/orders/OrderDetailPage.tsx`. `DocumentPickerDialog.onPick(ids, documents)` also passes the documents (chips need filenames).
- **Step 17:** the available-credits read runs at READ COMMITTED (not a REPEATABLE READ snapshot) — `withTransaction` issues audit-context queries after `BEGIN`, so the isolation level can no longer be set; the cores re-check every rule at apply time.
- **Step 18:** the shared zod array lives in a new `schemas/accounting/applyCreditsSchema.ts`; orchestration in `availableCreditsService.applyCreditsOnClient`.
- **Step 19:** case 3 as planned was wrong — a 20000 application of a 3000 note hits the note-balance check first (`'Amount exceeds the credit still available on this debit note'`); the test asserts both messages with two inputs. Case 5 returns 404 `'Debit note not found'`. Case 10's integrity run covers cases 2 and 6 (debit note + prepayment) but not the invoice-side case 7.
- **Step 21:** `ApplyCreditsDialog` also takes `direction` and `error`; a failed available-credits lookup falls back to the plain `ConfirmDialog`.
- **Step 24:** the `inbound-mail-process` payload is `{ orgId, messageId, attachments[] }` (the registry's `{ orgId, messageId }` could not carry the DownloadTokens the contract requires); queue type + worker registration landed here. A message whose eligible attachments all fail capture ends `REJECTED` with `'No attachment could be read as a bill'`.
- **Step 25:** the router-walking test is `platform/routePermissions.test.ts`; it only inspects routes carrying `authenticate`, so the public webhook needs no exemption. No `app.ts` change (global JSON limit is already 1 MB). No rate limiter on the webhook (mirrors Stripe).
- **Step 28 (orchestrator, 2026-10-15):** `middleware/requestContext.ts` logs `req.originalUrl`'s path verbatim, so every webhook call would log `INBOUND_MAIL_WEBHOOK_SECRET` (rule 11). The same was already true for invitation, quote and statement `:token` links. Step 28 replaces the value of any matched route param named `token` or `secret` with `[redacted]` in the `request completed` log line, with a test.

## Risks & open questions

- **Brevo attachment auth**: the reference page lists `api-key` and an OAuth bearer as required. The transactional-mail API in this repo works with `api-key` alone; if inbound downloads return 401 with it, step 24 stops and reports — do not add an OAuth flow without a plan update.
- **Brevo inbound webhook authentication** is not documented; the secret path segment is our own control. Brevo may log the URL — rotate `INBOUND_MAIL_WEBHOOK_SECRET` if exposed.
- **`Spam.Score` vs `SpamScore`** naming differs in Brevo's docs; this plan does not use spam scores.
- **Posted-row trigger** may forbid the 095 backfill on posted bills/invoices — handled in step 9 by restricting scope; the link then shows only for documents converted after 43b or still editable.
- **Deposit lock order**: approve locks the target first, then `lockDocumentsOnClient` locks `[target, deposit]` by id; a concurrent `apply-prepayment` on the same pair can deadlock — Postgres aborts one with `40P01`, mapped to 409. Accepted, not prevented.
- **Unknown file names** resolved at execution with the `ls`/`grep` named in each step (settings/onboarding/recurring test files, the inbox page folder, `listOrders` params). If the command finds nothing, stop and report.

## Definition of done

All 29 steps `done`; server and client suites green with counts above the baseline and zero skipped beyond the 2 pre-existing; `npm run verify:integrity` clean; guardrail-review zero violations per slice; docs (`schema`, `api`, `accounting`, `capture`, `development`, `roadmap`, `CLAUDE.md`) match the code; three study notes written/extended and indexed; four commits on `phase-43`; this file's `Status:` set to done.
