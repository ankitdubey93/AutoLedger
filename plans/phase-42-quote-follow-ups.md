# Phase 42 — quote follow-ups: the Phase 41 "not built" list

**Date:** 2026-10-10 · **Status:** planned, not started · **Owner of decisions:** this file (no decisions are left to the executor)

Source: Phase 41's "Deliberately not built" list ([docs/roadmap.md § Phase 41, as delivered](../docs/roadmap.md#phase-41-as-delivered)):

1. a settings UI for quote prefixes, default validity and default terms → **Slice A**
2. organization-timezone expiry → **Slice B**
3. editable quote email templates → **Slice C**
4. signer email verification (the buildable part of "qualified e-signature") → **Slice D**
5. PDF output → **Slice E**
6. sales and purchase orders **and** partial conversion → **Slice F** (partial conversion is delivered *through* orders)
7. deposits / prepayments on acceptance → **Slice G** (needs F)

Auto-conversion on acceptance stays out: the user declined it in Phase 41.

---

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

---

## Starting state (verified 2026-10-10)

- **Phase 41 is implemented but uncommitted** on branch `feat/quotes` (67 changed files). Migration `089_ledger-core_quotes.sql` is the newest migration; it has been applied to the **test** template database only (`autodb_test` on port 5433), not to the dev database.
- Quotes exist end to end: `quotes`, `quote_lines`, `quote_links`, `quote_responses`; `server/src/services/accounting/{quoteService,quoteStatusService,publicQuoteService}.ts`; `controllers/accounting/{quoteController,publicQuoteController}.ts`; `routes/accounting/{quoteRoutes,publicQuoteRoutes}.ts`; client `client/src/Pages/sales/quotes/*` and `client/src/Pages/public/PublicQuotePage.tsx`; tests `server/src/__tests__/accounting/{quotes,quoteConstraints,quotePublicLink}.test.ts`, `server/src/__tests__/quoteDocuments.test.ts`, `client/src/__tests__/quotes.test.tsx`.
- `ledger_invoice_settings` already has `quote_prefix`, `quote_next_number`, `purchase_quote_prefix`, `purchase_quote_next_number`, `default_quote_validity_days`, `default_quote_terms` (migration 089) — **no API or UI exposes them**.
- `invoiceSettingsService.SERIES_COUNTER` (constant map) allocates gapless series; `getQuoteDefaultsOnClient` reads quote defaults.
- `ledger_settings.timezone TEXT NOT NULL DEFAULT 'UTC'` exists (migration 005), is written by `PATCH /settings` (`schemas/accounting/settingsSchema.ts`, `z.string().trim().max(64)`, unvalidated), and is **read by nothing**. Every "today" is UTC.
- Statement email templates (`statement_email_templates`, migration 085; `statementEmailService.ts`; routes in `routes/accounting/settingsRoutes.ts` lines 39–42 using `statements.send` for GET and `settings.manage` for writes; client `Pages/settings/EmailTemplatesPage.tsx`) are the analogue for quote templates. Placeholders: `server/src/utils/placeholders.ts` (`PlaceholderSurface`, `PlaceholderKey`, `PLACEHOLDERS` registry, `PlaceholderContext`), mirrored in `client/src/utils/placeholders.ts`, kept in parity by `client/src/__tests__/fixtures/placeholderCases.json`.
- **No PDF-writing library** is installed (`pdfjs-dist` only *reads* PDFs). Printing is `window.print()`.
- **No orders** of any kind exist. `invoice_lines` / `bill_lines` have no link to any upstream document line.
- **No on-account / unapplied payments** (`payments` must allocate fully — roadmap Phase 25 note). Settlement is defined once in `services/accounting/settlementSql.ts` (payments + credit/debit note allocations).
- Default chart (`accountService.DEFAULT_CHART`): `1130 Prepaid Expenses`, `1140 Inventory` (taken), `2120 Accrued Liabilities`, `2140 GST/VAT Output Payable` (taken). **`1150` and `2130` are free.** Migration 071 is the analogue for backfilling new default accounts into existing orgs.
- `invoiceService.assertRevenueAccounts(client, orgId, ids, allowAccountId)` already accepts one extra non-Revenue account id. `billService.assertExpenseAccounts` already accepts `Asset` accounts.

## Gate

- Phase 42 builds only on Phases 3.8, 3.9, 8, 24, 25, 26, 38b, 39b, 40, 41 — all built.
- **Blocking precondition (Step 0):** Phase 41 must be committed before any Phase 42 file is touched. The executor never commits — the user does.
- **Not buildable, out of this plan:** a *qualified* electronic signature (eIDAS QES / equivalent) requires a contract with a qualified trust-service provider and its SDK — a product and legal decision, not a code task. Slice D delivers **verified-email acceptance** (a one-time code to the signer's inbox), which is the strongest evidence available without a provider. A QES integration is a separate future plan.
- **New dependency (rule 14):** Slice E adds `pdfkit` (runtime) and `@types/pdfkit` (dev). This phase is the phase that needs it. No other package may be added.

## Decisions fixed by this plan (do not reopen)

| Topic | Decision |
|---|---|
| Timezone | Only quote dates move to the organization's timezone (`ledger_settings.timezone`). Every other document keeps UTC "today". An invalid stored zone falls back to `UTC` silently; `PATCH /settings` rejects a new invalid zone with `400 Unknown time zone`. |
| Quote number collisions | `quote_next_number` is freely settable (like the invoice `next_number`). A collision at send maps `23505 ux_quotes_number` → `409 That quote number is already in use — raise the next quote number in Settings → Invoices`. |
| Email templates | New table `quote_email_templates`, one default per direction. New placeholder surface `QUOTE` with four new keys: `quoteNumber`, `quoteTotal`, `validUntil`, `quoteTitle`. Built-in templates live in code. Templates are filled with mode `final` at send. |
| Signer verification | Org setting `quote_acceptance_requires_code` (default `false`). A 6-digit code, 10-minute TTL, 5 attempts per code, at most 5 codes per link per hour. Stored as `sha256Hex(`${linkId}:${code}`)` only. Evidence column `quote_responses.signer_email_verified`. |
| PDF | `pdfkit`, A4, built-in Helvetica (WinAnsi — non-Latin text is a known limitation), currency **code** not symbol, logo only if PNG/JPEG. Not attached to emails (the outbox has no attachments). |
| Orders | One `orders` table with `direction` (`SALES` = sales order `SO-`, `PURCHASE` = purchase order `PO-`). Statuses `DRAFT → CONFIRMED → CLOSED`, `CONFIRMED → CANCELLED`, `CLOSED → CONFIRMED` (reopen). No goods-receipt / delivery-note documents; stock still moves on the invoice/bill. |
| Partial conversion | Delivered by orders: an invoice/bill line may carry `order_line_id`; invoiced quantity is **derived** (Σ non-VOID linked lines). Cap enforced in the service under `FOR UPDATE` **and** by a deferred constraint trigger. A quote converts (once) to either an invoice (`target: 'INVOICE'`, unchanged) or an order (`target: 'ORDER'`). |
| Deposits | IFRS 15 contract liability. A **deposit invoice** (`invoices.kind = 'DEPOSIT'`) posts DR AR / CR `2130 Customer Deposits`; a **deposit bill** (`bills.kind = 'DEPOSIT'`) posts DR `1150 Supplier Prepayments` / CR AP. A **deposit application** later posts DR 2130 / CR AR (sales) or DR AP / CR 1150 (purchase) and settles the final document — a third settlement source in `settlementSql.ts`. **Base currency only**, tax rate 0 on the deposit line, only from a CONFIRMED order, application only to an invoice/bill with ≥ 1 line linked to the same order, amount ≤ what the deposit document has been **paid** (payment allocations only) minus earlier applications. No cash refund of an unapplied deposit (refunds are not built anywhere). |
| Quote deposits | `quotes.deposit_percent_bp` (1–10000, nullable), shown on the quote and in its content hash. Converting such a quote must use `target: 'ORDER'`; the order conversion then creates the DRAFT deposit document in the same transaction. |

---

## Execution rules

> **If a proof command fails twice on the same step, stop and report. Do not improvise around it.**

| Symptom | Forbidden | Correct |
|---|---|---|
| Migration checksum error | Editing an applied migration | A new sequential migration (rule #13) |
| Test fails | Weakening or deleting the assertion | Fix the code; the test is the spec |
| Type error | `as any`, `@ts-ignore`, loosening `tsconfig` | Fix the type |
| Query returns no rows | Dropping the `org_id` predicate | Fix the fixture or the parameters (rule #1) |
| Balance/settlement assertion fails | Epsilon comparison, floats, rounding | Integer cents equality (rule #3) |
| Need a helper library | `npm install` anything not named in a step | Stop and ask (rule #14) |
| "Update the posted record" | Adding `PUT`/`DELETE` | A voiding/reversing `POST` (rule #6) |
| Column missing at runtime | Adding it ad hoc | New migration, then update this plan |
| A `[Haiku]` step's proof fails twice | Retrying in a loop, trimming the step | Escalate the step **unchanged** to Sonnet with the failure output; note the escalation under "Escalations" at the bottom of this file |
| The step needs a decision the plan never made | Deciding it | Stop and report — the plan is the defect |

**Anything the plan did not anticipate is a stop-and-report, not a judgment call.**

Environment facts every proof relies on:
- Test services: `docker compose up -d postgres-test redis` (if ports 5433/6379 are already bound, they are already up — run a test to confirm).
- Server tests: `cd server && npx vitest run <path>`; the global setup migrates the test template automatically.
- Migration replay proof: `cd server && npx vitest run src/__tests__/migrations.test.ts` (applies every file, then replays them).
- `psql` is not on the host; direct SQL is `docker exec autodb_postgres psql -U autodb_user -d autodb -c '…'` (dev DB) — not needed by any proof below.
- All server imports carry `.js` (ESM). Client imports carry no extension.

---

## Step 0 — [Sonnet] Confirm the starting point

- **Model:** [Sonnet] — a gate check whose failure must stop the plan.
- **Depends on:** —
- **Files:** none.
- **Do:** run `git status --short` and `git log --oneline -3` in the repo root.
- **Proof:** `git status --short | grep -c "089_ledger-core_quotes.sql"` prints `0` **and** `git log --oneline -1` mentions Phase 41. Then `cd server && npx vitest run src/__tests__/accounting/quotes.test.ts` → `29 passed`.
- **If it fails:** Phase 41 is uncommitted → STOP and report "Phase 41 must be committed by the user before Phase 42 starts." Never commit it yourself.
- **Owes:** nothing.

---

## Slice A — quote settings exposed (no migration)

**Outcome:** an admin edits the quote prefixes, next numbers, default validity and default terms in Settings → Invoices, and new quotes use them.

**Names — use exactly these, do not rename:**
| Kind | Name |
|---|---|
| API fields (camelCase) ↔ columns | `quotePrefix`↔`quote_prefix`, `quoteNextNumber`↔`quote_next_number`, `purchaseQuotePrefix`↔`purchase_quote_prefix`, `purchaseQuoteNextNumber`↔`purchase_quote_next_number`, `defaultQuoteValidityDays`↔`default_quote_validity_days`, `defaultQuoteTerms`↔`default_quote_terms` |
| Defaults | `'QU-'`, `1`, `'PQ-'`, `1`, `30`, `null` |
| Server files | `server/src/types/accounting.ts` (`InvoiceSettings`), `server/src/services/accounting/invoiceSettingsService.ts`, `server/src/schemas/accounting/invoiceSettingsSchema.ts` |
| Client files | `client/src/services/fetchServices.ts` (`InvoiceSettings`), `client/src/Pages/settings/InvoiceSettingsPage.tsx` |
| Test | `server/src/__tests__/accounting/quoteSettings.test.ts` (new) |

### Step A1 — [Haiku] Expose the six quote settings on `GET/PATCH /settings/invoicing`

- **Model:** [Haiku] — transcription into an existing column map whose pattern is in the same file.
- **Depends on:** Step 0
- **Skill:** none (edit of an existing endpoint)
- **Read first:** `server/src/services/accounting/invoiceSettingsService.ts` — `INVOICE_SETTINGS_DEFAULTS`, the row interface, the `SELECT` in `getInvoiceSettings`, the row→object mapping, `UpdateInvoiceSettingsInput`, and the `COLUMNS` map inside `updateInvoiceSettings`. Copy how `numberPrefix`/`nextNumber` flow through each of those six places.
- **Files:** `server/src/types/accounting.ts` (edit `InvoiceSettings`), `server/src/services/accounting/invoiceSettingsService.ts` (edit the six places above), `server/src/schemas/accounting/invoiceSettingsSchema.ts` (edit `updateInvoiceSettingsSchema`).
- **Contract:**
  ```ts
  // InvoiceSettings gains:
  quotePrefix: string;
  quoteNextNumber: number;
  purchaseQuotePrefix: string;
  purchaseQuoteNextNumber: number;
  defaultQuoteValidityDays: number;
  defaultQuoteTerms: string | null;
  // updateInvoiceSettingsSchema gains (inside the existing z.object):
  quotePrefix: z.string().trim().max(12).optional(),
  quoteNextNumber: z.int().min(1).max(9_999_999).optional(),
  purchaseQuotePrefix: z.string().trim().max(12).optional(),
  purchaseQuoteNextNumber: z.int().min(1).max(9_999_999).optional(),
  defaultQuoteValidityDays: z.int().min(1).max(365).optional(),
  defaultQuoteTerms: z.string().trim().max(5000).nullable().optional(),
  ```
  The `COLUMNS` map gains the six column names from the registry. `UpdateInvoiceSettingsInput` gains the six fields as `?: … | undefined`.
- **Guardrails:** #4 the column names enter SQL only through `COLUMNS`.
- **Proof:** `cd server && npx tsc --noEmit` exits 0, then `npx vitest run src/__tests__/accounting/invoiceSettings.test.ts` (or `ls src/__tests__/accounting | grep -i invoiceSetting` to find the file) passes unchanged.
- **If it fails:** a test expecting an exact settings object fails → add the six default values to that expectation (it is asserting the response shape, which this step changed deliberately); never remove fields from the response.
- **Owes:** api.md row in Step S3.

### Step A2 — [Sonnet] Map number collisions and test the settings end to end

- **Model:** [Sonnet] — integration tests against real PostgreSQL.
- **Depends on:** A1
- **Skill:** isolation-test
- **Read first:** `server/src/__tests__/accounting/quotes.test.ts` (fixtures `salesPayload`, `sentQuote`, `isoDaysFromNow`).
- **Files:** `server/src/services/accounting/quoteService.ts` (edit `mapWriteError`), `server/src/__tests__/accounting/quoteSettings.test.ts` (new).
- **Contract:** in `mapWriteError`, inside the `PG_UNIQUE_VIOLATION` branch, before the generic 409, add: constraint `ux_quotes_number` → `throw new ApiError(409, 'That quote number is already in use — raise the next quote number in Settings → Invoices')`.
  Test cases (names verbatim):
  1. `PATCH /settings/invoicing quotePrefix "EST-" → the next sent quote is EST-000001`
  2. `purchaseQuotePrefix "RFQ-" → the next sent purchase quote is RFQ-000001`
  3. `defaultQuoteValidityDays 14 → a quote created without validUntil is valid until quoteDate + 14`
  4. `defaultQuoteTerms set → a new quote without terms gets them; one with terms: null keeps null`
  5. `quoteNextNumber reset to 1 after QU-000001 was sent → sending another quote is 409 with the collision message`
  6. `a VIEWER cannot PATCH the quote settings → 403`
  7. `org B's PATCH does not change org A's quote prefix` (cross-tenant)
- **Guardrails:** #1 each test asserts on its own org only.
- **Proof:** `cd server && npx vitest run src/__tests__/accounting/quoteSettings.test.ts` → `7 passed`.
- **If it fails:** case 5 returns the generic 409 → the constraint name check is wrong; read `pgConstraint(err)` in a debugger line, never loosen the assertion.
- **Owes:** nothing extra.

### Step A3 — [Haiku] Client: quote settings section

- **Model:** [Haiku] — form fields copied from neighbours on the same page.
- **Depends on:** A1
- **Skill:** none (client page)
- **Read first:** `client/src/Pages/settings/InvoiceSettingsPage.tsx` — how `numberPrefix` and `nextNumber` are held in state, rendered, and sent in the PATCH body.
- **Files:** `client/src/services/fetchServices.ts` (edit `InvoiceSettings` interface: add the six fields with the same types as A1), `client/src/Pages/settings/InvoiceSettingsPage.tsx` (edit), every client test fixture typed `InvoiceSettings` (find with `grep -rln "InvoiceSettings = {" client/src`; add the six default values).
- **Contract:** add a section with heading text `Quotes` after the numbering section, containing six labelled inputs, labels verbatim: `Sales quote prefix`, `Next sales quote number`, `Purchase quote prefix`, `Next purchase quote number`, `Quotes are valid for (days)`, `Default quote terms` (a `<textarea rows={4} maxLength={5000}>`). Save with the page's existing save button, in the same PATCH body. Blank `Default quote terms` sends `null`.
- **Proof:** `cd client && npx tsc --noEmit -p . && npm run lint && npx vitest run` → all pass (616+).
- **If it fails:** a fixture type error → add the missing fields to that fixture; never make the fields optional.
- **Owes:** nothing extra.

### Step A4 — [Haiku] Client test for the quote settings section

- **Model:** [Haiku] — the cases and values are listed.
- **Depends on:** A3
- **Read first:** the existing InvoiceSettingsPage test (find with `grep -rln "InvoiceSettingsPage" client/src/__tests__`).
- **Files:** that test file (edit) — add one `it`.
- **Contract:** `it('saves the quote prefixes, validity and default terms')` — render with mocked `GET /settings/invoicing`, type `EST-` into `Sales quote prefix`, `14` into `Quotes are valid for (days)`, click save; assert the PATCH body contains `quotePrefix: 'EST-'` and `defaultQuoteValidityDays: 14`.
- **Proof:** `cd client && npx vitest run <that file>` → passes.
- **If it fails:** escalate per Execution rules.
- **Owes:** nothing.

---

## Slice B — quote dates in the organization's timezone (no migration)

**Outcome:** a quote's "today" (validity, expiry, revision date, conversion default date) is the calendar date in `ledger_settings.timezone`; tested at a fixed instant across UTC+14 and UTC−11.

**Names:**
| Kind | Name |
|---|---|
| Pure util | `server/src/utils/orgDate.ts` → `export function todayInZone(timeZone: string, now?: Date): string` and `export function isValidTimeZone(timeZone: string): boolean` |
| Service fn | `server/src/services/accounting/settingsService.ts` → `export async function orgTodayOnClient(q: Pick<PoolClient,'query'>, orgId: string): Promise<string>` |
| Unit test | `server/src/__tests__/orgDate.test.ts` (new) |
| Integration test | `server/src/__tests__/accounting/quoteTimezone.test.ts` (new) |

### Step B1 — [Haiku] `todayInZone` and `isValidTimeZone`

- **Model:** [Haiku] — a pure function with a literal implementation and listed test values.
- **Depends on:** Step 0
- **Read first:** `server/src/utils/fxRate.ts` (style of a small pure util with a header comment).
- **Files:** `server/src/utils/orgDate.ts` (new), `server/src/__tests__/orgDate.test.ts` (new).
- **Contract:**
  ```ts
  /** The calendar date (YYYY-MM-DD) at `now` in IANA `timeZone`; UTC when the zone is invalid. */
  export function todayInZone(timeZone: string, now: Date = new Date()): string {
    // new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    //   .formatToParts(now) → pick type 'year' | 'month' | 'day' → `${y}-${m}-${d}`.
    // catch RangeError → return now.toISOString().slice(0, 10)
  }
  export function isValidTimeZone(timeZone: string): boolean {
    // try { new Intl.DateTimeFormat('en-US', { timeZone }); return true } catch { return false }
  }
  ```
  Test cases (instant `new Date('2026-10-10T12:00:00Z')`): `UTC → 2026-10-10`; `Pacific/Kiritimati → 2026-10-11`; `Pacific/Pago_Pago → 2026-10-10`; `America/Los_Angeles → 2026-10-10`; `Asia/Kolkata → 2026-10-10`; instant `2026-10-10T20:00:00Z` + `Asia/Kolkata → 2026-10-11`; `Not/AZone → 2026-10-10` (fallback); `isValidTimeZone('Asia/Kolkata') → true`; `isValidTimeZone('Not/AZone') → false`.
- **Proof:** `cd server && npx vitest run src/__tests__/orgDate.test.ts` → `9 passed`.
- **If it fails:** escalate per Execution rules.
- **Owes:** study note section in Step S2.

### Step B2 — [Sonnet] Use the org's date for every quote rule

- **Model:** [Sonnet] — touches the expiry invariant in several functions and the cross-tenant sweep.
- **Depends on:** B1
- **Read first:** `server/src/services/accounting/quoteService.ts` — every call of `today()`; `server/src/services/accounting/settingsService.ts` (its existing `ledger_settings` read).
- **Files:** `server/src/services/accounting/settingsService.ts` (add `orgTodayOnClient`), `server/src/schemas/accounting/settingsSchema.ts` (edit both `timezone` fields), `server/src/services/accounting/quoteService.ts` (edit).
- **Contract:**
  - `orgTodayOnClient(q, orgId)`: `SELECT timezone FROM ledger_settings WHERE org_id = $1`; no row → `'UTC'`; return `todayInZone(row.timezone)`.
  - Both `timezone` schema fields gain `.refine(isValidTimeZone, { message: 'Unknown time zone' })`.
  - In `quoteService.ts`, replace each UTC `today()` used for a **quote rule** with `await orgTodayOnClient(<client or pool>, orgId)`: `loadQuote` (asOf for `toSummary`), `buildFilters` (SENT/EXPIRED filters — compute once in `listQuotes` and pass in), `finalizeOnClient` (validity check), `sendQuote` (re-send expiry check), `reviseQuote` (new `quoteDate`), `respondOnClient` (expiry check), `convertQuote` (default `documentDate`), `expireQuotesForOrg` (`$2`). Keep `today()` exported for nothing else; delete it if unused (`tsc` will tell).
  - `listOrgsWithExpiredSentQuotes`: change the predicate to `valid_until < ($1::date + 1)` with `$1` = UTC date — a superset (any zone is at most +14h ahead); `expireQuotesForOrg` then applies the org's own date.
- **Guardrails:** #1 `orgTodayOnClient` is `WHERE org_id = $1` · #5 inside a transaction, pass the transaction `client`, never `pool`.
- **Proof:** `cd server && npx tsc --noEmit && npx vitest run src/__tests__/accounting/quotes.test.ts src/__tests__/accounting/quotePublicLink.test.ts` → all pass unchanged (orgs default to UTC).
- **If it fails:** an existing expiry test fails → the substitution changed UTC behaviour for a UTC org; fix the call, never the test.
- **Owes:** api.md note in S3 (timezone now validated; quote dates use it).

### Step B3 — [Sonnet] Integration test across timezones

- **Model:** [Sonnet] — fake time + real DB.
- **Depends on:** B2
- **Skill:** isolation-test
- **Read first:** `server/src/__tests__/accounting/quotes.test.ts` (the `vi.useFakeTimers({ toFake: ['Date'] })` expiry test and its re-login after the jump).
- **Files:** `server/src/__tests__/accounting/quoteTimezone.test.ts` (new).
- **Contract:** before signing in, `vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-10T12:00:00Z'))`. Org A `PATCH /api/v1/settings` `{ timezone: 'Pacific/Kiritimati' }`, org B `{ timezone: 'Pacific/Pago_Pago' }`. Cases:
  1. `a quote valid until 2026-10-10 reads EXPIRED in Kiritimati and SENT in Pago Pago` — create both with `quoteDate: '2026-10-09', validUntil: '2026-10-10'`; send **before** setting the zone (or send at `2026-10-10T00:30:00Z`, then jump to 12:00) so sending is legal; assert `effectiveStatus`.
  2. `accepting in Kiritimati is 409; in Pago Pago it succeeds`
  3. `the sweep expires the Kiritimati quote only` — call `expireQuotesForOrg` for both orgs → `1` and `0`.
  4. `PATCH /settings with timezone "Not/AZone" → 400 Unknown time zone`
- **Proof:** `cd server && npx vitest run src/__tests__/accounting/quoteTimezone.test.ts` → `4 passed`.
- **If it fails:** escalate is already Sonnet → stop and report with output.
- **Owes:** nothing extra.

---

## Slice C — editable quote email templates

**Outcome:** an admin writes the subject and body of the quote email (per direction) with placeholders; the send dialog picks a template and previews it.

**Names:**
| Kind | Name |
|---|---|
| Migration | `server/src/db/migrations/090_ledger-core_quote_email_templates.sql` |
| Table | `quote_email_templates (id, org_id, direction, name, subject, body, is_default, created_by, created_at, updated_at)` |
| Placeholder surface / keys | `'QUOTE'`; keys `quoteNumber` (label `Quote Number`), `quoteTotal` (`Quote Total`), `validUntil` (`Valid Until`), `quoteTitle` (`Quote Title`) |
| Context fields | `PlaceholderContext.quoteNumber?`, `.quoteTotal?` (pre-formatted money), `.validUntil?` (YYYY-MM-DD, rendered like `dueDate`), `.quoteTitle?` |
| Service | `server/src/services/accounting/quoteEmailTemplateService.ts` → `listQuoteTemplates`, `createQuoteTemplate`, `updateQuoteTemplate`, `deleteQuoteTemplate`, `BUILT_IN_QUOTE_TEMPLATES`, `renderQuoteEmailOnClient` |
| Controller | `server/src/controllers/accounting/quoteEmailTemplateController.ts` → `list`, `create`, `update`, `remove` |
| Routes | `GET/POST /api/v1/settings/quote-email-templates`, `PATCH/DELETE /api/v1/settings/quote-email-templates/:id` (in `routes/accounting/settingsRoutes.ts`); `POST /api/v1/quotes/:id/email-preview` and `/purchase-quotes/:id/email-preview` (in `quoteRoutes.ts`) |
| Schemas | `server/src/schemas/accounting/quoteEmailTemplateSchema.ts` → `createQuoteTemplateSchema`, `updateQuoteTemplateSchema`; `sendQuoteSchema` gains `templateId` |
| Client | `client/src/Pages/settings/QuoteEmailTemplatesPage.tsx` (new), route `/settings/quote-email-templates`, settings hub link |
| Tests | `server/src/__tests__/accounting/quoteEmailTemplates.test.ts` (new); fixture cases appended to `client/src/__tests__/fixtures/placeholderCases.json`; `client/src/__tests__/quoteEmailTemplates.test.tsx` (new) |

### Step C1 — [Sonnet] Migration 090

- **Model:** [Sonnet] — migration (rule #13).
- **Depends on:** Step 0
- **Skill:** new-migration
- **Read first:** `server/src/db/migrations/085_ledger-core_statement_email.sql` — copy `statement_email_templates` exactly, replacing `party_kind` with `direction`.
- **Files:** `server/src/db/migrations/090_ledger-core_quote_email_templates.sql` (new).
- **Contract:**
  ```sql
  CREATE TABLE IF NOT EXISTS quote_email_templates (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    direction   TEXT NOT NULL CHECK (direction IN ('SALES', 'PURCHASE')),
    name        TEXT NOT NULL CHECK (length(btrim(name)) > 0 AND length(name) <= 100),
    subject     TEXT NOT NULL CHECK (length(btrim(subject)) > 0 AND length(subject) <= 200),
    body        TEXT NOT NULL CHECK (length(btrim(body)) > 0 AND length(body) <= 5000),
    is_default  BOOLEAN NOT NULL DEFAULT false,
    created_by  UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ux_quote_email_templates_org_id_id UNIQUE (org_id, id)
  );
  -- indexes: idx_quote_email_templates_org_direction (org_id, direction); idx_quote_email_templates_created_by (created_by);
  -- partial unique ux_quote_email_templates_default ON (org_id, direction) WHERE is_default
  -- triggers: trg_quote_email_templates_updated_at (set_updated_at), trg_quote_email_templates_audit (audit_row_change('ledger-core'))
  ```
- **Guardrails:** #8 every FK has `ON DELETE`; #13 idempotent (`IF NOT EXISTS`, `CREATE OR REPLACE TRIGGER`).
- **Proof:** `cd server && npx vitest run src/__tests__/migrations.test.ts` → passes (applies 090, replays all).
- **If it fails:** checksum error on 089 → stop (someone edited 089). Never edit 089.
- **Owes:** schema.md block in S3.

### Step C2 — [Sonnet] Placeholder surface `QUOTE` (server + client + fixture)

- **Model:** [Sonnet] — the Phase 40 engine and a cross-package parity fixture.
- **Depends on:** C1
- **Read first:** `server/src/utils/placeholders.ts` (registry, `PlaceholderSurface`, `PlaceholderKey`, `PlaceholderContext`, how `invoiceNumber` and `dueDate` are resolved), `client/src/utils/placeholders.ts`, `client/src/__tests__/fixtures/placeholderCases.json`, `server/src/__tests__/placeholders.test.ts`.
- **Files:** `server/src/utils/placeholders.ts` (edit), `client/src/utils/placeholders.ts` (edit, identical additions), `client/src/__tests__/fixtures/placeholderCases.json` (append cases).
- **Contract:** add `'QUOTE'` to `PlaceholderSurface`; add `'QUOTE'` to the `ALL` list and to the `CONTACT` list (so `contactName`, `organisationName` and the date family work on quotes); add four keys with `offset: false`, `legacy: null`, `aliases: []`, `surfaces: ['QUOTE']`:
  `quoteNumber` "The quote number, e.g. QU-000012" · `quoteTotal` "The quote total, e.g. USD 1,250.00" · `validUntil` "The validity date, e.g. 9 Nov 2026" (rendered with the same date formatting as `dueDate`) · `quoteTitle` "The quote title".
  `PlaceholderContext` gains `quoteNumber?: string | null; quoteTotal?: string | null; validUntil?: string | null; quoteTitle?: string | null`.
  Fixture: append 4 cases (surface `QUOTE`, mode `final`) — `"Quote [Quote Number] for [Contact Name]"` with `{quoteNumber:'QU-000012', contactName:'Acme'}` → `"Quote QU-000012 for Acme"`; `"Total [Quote Total]"` → `"Total USD 1,250.00"`; `"Valid until [Valid Until]"` with `validUntil:'2026-11-09'` → `"Valid until 9 Nov 2026"`; `"[Invoice Number]"` on `QUOTE` → left unchanged (not on this surface). Match the fixture's existing JSON field names exactly.
- **Proof:** `cd server && npx vitest run src/__tests__/placeholders.test.ts` and `cd client && npx vitest run src/__tests__/placeholders.test.ts` → both pass, including the new cases.
- **If it fails:** a parity case passes on one side only → the two registries differ; diff them, never special-case the fixture.
- **Owes:** study-note extension in S2.

### Step C3 — [Sonnet] `quoteEmailTemplateService` and send-time rendering

- **Model:** [Sonnet] — service with tenant SQL and a change to the send transaction.
- **Depends on:** C2
- **Skill:** new-module (service layer)
- **Read first:** `server/src/services/accounting/statementEmailService.ts` — `BUILT_IN_TEMPLATES`, `listTemplates`, `createTemplate`, `updateTemplate`, `deleteTemplate` (copy their structure, default-switching and 404/409 messages, replacing *statement* with *quote* and `partyKind` with `direction`), and how `sendStatements` fills `subject`/`body` and passes them in `template_data`.
- **Files:** `server/src/services/accounting/quoteEmailTemplateService.ts` (new), `server/src/services/accounting/quoteService.ts` (edit `sendQuote`), `server/src/services/mail/templates.ts` (edit `case 'quote_sent'`), `server/src/types/accounting.ts` (add `QuoteEmailTemplate`).
- **Contract:**
  ```ts
  export interface QuoteEmailTemplate { id: string | null; direction: QuoteDirection; name: string; subject: string; body: string; isDefault: boolean; builtIn: boolean; updatedAt: string | null }
  export const BUILT_IN_QUOTE_TEMPLATES: Record<QuoteDirection, Omit<QuoteEmailTemplate, 'direction'>>;
  //  SALES:    name 'Standard quote', subject 'Quote [Quote Number] from [Organisation Name]',
  //            body 'Hi [Contact Name],\n\nPlease find our quote [Quote Number] for [Quote Total], valid until [Valid Until].\n\nYou can review and accept it online using the button below.\n\nThank you,\n[Organisation Name]'
  //  PURCHASE: name 'Standard price confirmation', subject 'Price confirmation [Quote Number] from [Organisation Name]',
  //            body 'Hi [Contact Name],\n\nPlease confirm the prices in [Quote Number] ([Quote Total]) by [Valid Until].\n\nThank you,\n[Organisation Name]'
  export async function listQuoteTemplates(orgId: string, direction: QuoteDirection | null): Promise<QuoteEmailTemplate[]>; // built-in first when no stored default
  export async function createQuoteTemplate(orgId: string, userId: string, input: { direction: QuoteDirection; name: string; subject: string; body: string; isDefault: boolean }): Promise<QuoteEmailTemplate>;
  export async function updateQuoteTemplate(orgId: string, id: string, input: Partial<{ name: string; subject: string; body: string; isDefault: boolean }>): Promise<QuoteEmailTemplate>;
  export async function deleteQuoteTemplate(orgId: string, id: string): Promise<void>;
  export async function renderQuoteEmailOnClient(client: Queryable, orgId: string, direction: QuoteDirection, templateId: string | null, ctx: PlaceholderContext): Promise<{ subject: string; body: string }>;
  //  templateId null → the stored default for the direction, else the built-in. Unknown id → ApiError(422, 'Email template not found').
  //  Fill subject and body with surface 'QUOTE', mode 'final'; an unknown [Name] is a 422 exactly as statementEmailService does.
  ```
  `sendQuote`: `SendQuoteInput` and `sendQuoteSchema` gain `templateId: z.uuid().nullable().default(null)`. For `EMAIL`, build ctx `{ date: quote.quoteDate, contactName: quote.partyNameSnapshot, organisationName, quoteNumber, quoteTotal: formatMoney(totalCents, currency), validUntil, quoteTitle: quote.title }`, call `renderQuoteEmailOnClient`, put `subject` and `body` into `template_data` (alongside the existing fields).
  `templates.ts` `quote_sent`: when `data.subject` and `data.body` are non-empty strings, render exactly like `party_statement` (subject from data; body split into escaped paragraphs; the optional `message` paragraphs first; the action button unchanged); otherwise keep today's wording (old outbox rows).
  Add `export async function previewQuoteEmail(orgId, direction, id, templateId): Promise<{ subject: string; body: string }>` to `quoteService.ts` (read-only, same ctx).
- **Guardrails:** #1 every template query `WHERE org_id = $n`; #5 `renderQuoteEmailOnClient` runs on the send transaction's `client`; #4 no interpolation.
- **Proof:** `cd server && npx tsc --noEmit && npx vitest run src/__tests__/quoteDocuments.test.ts src/__tests__/accounting/quotes.test.ts` → all pass (old-wording path still covered).
- **If it fails:** stop and report with output.
- **Owes:** api.md in S3.

### Step C4 — [Haiku] Controller, routes, permissions wiring for templates and preview

- **Model:** [Haiku] — thin adapters with a named analogue.
- **Depends on:** C3
- **Read first:** `server/src/controllers/accounting/statementEmailController.ts` (`listTemplates`, `createTemplate`, `updateTemplate`, `deleteTemplate`), `server/src/routes/accounting/settingsRoutes.ts` lines 39–42, `server/src/controllers/accounting/quoteController.ts`.
- **Files:** `server/src/schemas/accounting/quoteEmailTemplateSchema.ts` (new), `server/src/controllers/accounting/quoteEmailTemplateController.ts` (new), `server/src/routes/accounting/settingsRoutes.ts` (edit), `server/src/controllers/accounting/quoteController.ts` + `server/src/routes/accounting/quoteRoutes.ts` (edit: `emailPreview`).
- **Contract:**
  - Schemas: `createQuoteTemplateSchema = z.object({ direction: z.enum(['SALES','PURCHASE']), name: z.string().trim().min(1).max(100), subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(5000), isDefault: z.boolean().default(false) })`; `updateQuoteTemplateSchema` = the same without `direction`, every field `.optional()`.
  - Routes (append after line 42): `router.get('/quote-email-templates', authenticate, requirePermission('quotes.view'), c.list)` (query `?direction=SALES|PURCHASE`, else `400 direction must be SALES or PURCHASE`); `post` → `settings.manage` → `201 { success, template }`; `patch('/:id')` → `settings.manage` → `200 { success, template }`; `delete('/:id')` → `settings.manage` → `204`. List → `200 { success, templates }`.
  - Quote preview: `router.post('/:id/email-preview', authenticate, requirePermission(key.send), c.emailPreview)` body `{ templateId: uuid | null }` → `200 { success, subject, body }`.
- **Guardrails:** #2 no SQL in controllers.
- **Proof:** `cd server && npx tsc --noEmit && npm run lint && npx vitest run src/__tests__/platform/routePermissions.test.ts` → passes (every new route gated).
- **If it fails:** escalate per Execution rules.
- **Owes:** api.md in S3.

### Step C5 — [Sonnet] Server tests for quote templates

- **Model:** [Sonnet] — integration + isolation.
- **Depends on:** C4
- **Skill:** isolation-test
- **Files:** `server/src/__tests__/accounting/quoteEmailTemplates.test.ts` (new); add `quote_email_templates` to `resetTables()` in `server/src/__tests__/helpers/factories.ts`.
- **Contract — cases:** 1 `GET ?direction=SALES with nothing stored returns the built-in`; 2 `create a default SALES template; sending a quote uses it — outbox template_data.subject is filled ("Quote QU-000001 from Org Alpha")`; 3 `templateId on send picks a non-default template`; 4 `an unknown placeholder in a template body → 422 on create`; 5 `email-preview returns the filled subject and body without sending (outbox empty)`; 6 `making a second default unsets the first (one default per direction)`; 7 `org B cannot read, patch or delete org A's template → 404`; 8 `org B's templateId on org A's send → 422 Email template not found`.
- **Proof:** `cd server && npx vitest run src/__tests__/accounting/quoteEmailTemplates.test.ts` → `8 passed`.
- **If it fails:** stop and report.
- **Owes:** nothing extra.

### Step C6 — [Haiku] Client: template settings page and send-dialog picker

- **Model:** [Haiku] — copies `EmailTemplatesPage` with renamed calls; dialog fields are listed.
- **Depends on:** C4
- **Read first:** `client/src/Pages/settings/EmailTemplatesPage.tsx` (whole file), `client/src/Pages/sales/quotes/QuoteDetailPage.tsx` (send dialog), `client/src/routes/ProductRoutes.tsx` (settings routes), `client/src/Pages/settings/SettingsHubPage.tsx`.
- **Files:** `client/src/services/fetchServices.ts` (add `QuoteEmailTemplate` type and `listQuoteEmailTemplates(direction)`, `createQuoteEmailTemplate`, `updateQuoteEmailTemplate`, `deleteQuoteEmailTemplate`, `previewQuoteEmail(direction, id, templateId)`; `sendQuote` body gains `templateId: string | null`), `client/src/Pages/settings/QuoteEmailTemplatesPage.tsx` (new — a copy of `EmailTemplatesPage` with tabs `Sales quotes` / `Purchase quotes` instead of customer/vendor and `PlaceholderPicker surface="QUOTE"`), `client/src/routes/ProductRoutes.tsx` (route `/settings/quote-email-templates`), `client/src/Pages/settings/SettingsHubPage.tsx` (link text `Quote emails`), `QuoteDetailPage.tsx` (send dialog: a `<select aria-label="Email template">` listing templates — first option the default — and a `Preview` button showing subject/body from `previewQuoteEmail`; send passes `templateId`).
- **Proof:** `cd client && npx tsc --noEmit -p . && npm run lint && npx vitest run` → all pass.
- **If it fails:** escalate per Execution rules.
- **Owes:** nothing.

### Step C7 — [Haiku] Client tests for quote templates

- **Model:** [Haiku] — cases listed.
- **Depends on:** C6
- **Read first:** `client/src/__tests__/statementEmail.test.tsx` (the EmailTemplatesPage test).
- **Files:** `client/src/__tests__/quoteEmailTemplates.test.tsx` (new).
- **Contract — cases:** `previews the built-in sales template with sample values`; `the send dialog sends the chosen templateId`.
- **Proof:** `cd client && npx vitest run src/__tests__/quoteEmailTemplates.test.tsx` → `2 passed`.
- **Owes:** nothing.

---

## Slice D — verified-email acceptance

**Outcome:** when the org turns it on, a signer must enter a 6-digit code sent to the email they type before acceptance is recorded, and the evidence says the email was verified.

**Names:**
| Kind | Name |
|---|---|
| Migration | `server/src/db/migrations/091_ledger-core_quote_signer_verification.sql` |
| Setting | `ledger_invoice_settings.quote_acceptance_requires_code BOOLEAN NOT NULL DEFAULT false` ↔ `quoteAcceptanceRequiresCode` |
| Table | `quote_acceptance_codes (id, org_id, link_id, signer_email, code_hash, expires_at, attempts, consumed_at, created_at)` |
| Evidence column | `quote_responses.signer_email_verified BOOLEAN NOT NULL DEFAULT false` ↔ `signerEmailVerified` |
| Email template | `'quote_acceptance_code'` |
| Constants (`config/constants.ts`) | `QUOTE_ACCEPTANCE_CODE_TTL_MS = 10 * 60 * 1000`, `QUOTE_ACCEPTANCE_CODE_MAX_ATTEMPTS = 5`, `QUOTE_ACCEPTANCE_CODES_PER_HOUR = 5` |
| Public route | `POST /api/v1/public/quotes/:token/verify-email` |
| Service fns (`publicQuoteService.ts`) | `requestAcceptanceCode(token, signerEmail)`, `verifyAcceptanceCodeOnClient(client, link, signerEmail, code)` |
| Test | `server/src/__tests__/accounting/quoteSignerVerification.test.ts` (new) |

### Step D1 — [Sonnet] Migration 091

- **Model:** [Sonnet] — migration.
- **Depends on:** C1 (sequential numbering)
- **Skill:** new-migration
- **Read first:** `server/src/db/migrations/089_ledger-core_quotes.sql` (`quote_links`, `quote_responses`, the outbox CHECK block at the end).
- **Files:** `server/src/db/migrations/091_ledger-core_quote_signer_verification.sql` (new).
- **Contract:**
  ```sql
  ALTER TABLE ledger_invoice_settings ADD COLUMN IF NOT EXISTS quote_acceptance_requires_code BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE quote_responses ADD COLUMN IF NOT EXISTS signer_email_verified BOOLEAN NOT NULL DEFAULT false;
  -- named CHECK in a pg_constraint-guarded DO block:
  --   ck_quote_responses_email_verified CHECK (NOT signer_email_verified OR signer_email IS NOT NULL)
  CREATE TABLE IF NOT EXISTS quote_acceptance_codes (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    link_id       UUID NOT NULL,
    signer_email  TEXT NOT NULL CHECK (signer_email = LOWER(signer_email) AND length(signer_email) BETWEEN 3 AND 254),
    code_hash     TEXT NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
    expires_at    TIMESTAMPTZ NOT NULL,
    attempts      SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
    consumed_at   TIMESTAMPTZ NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_quote_acceptance_codes_expiry CHECK (expires_at > created_at),
    CONSTRAINT fk_quote_acceptance_codes_link FOREIGN KEY (org_id, link_id) REFERENCES quote_links (org_id, id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_quote_acceptance_codes_link ON quote_acceptance_codes (org_id, link_id, created_at DESC);
  -- Not audited: it carries a code hash (same reasoning as quote_links).
  -- Recreate ck_email_outbox_template with the 089 list + 'quote_acceptance_code'.
  ```
  `ADD COLUMN … DEFAULT false` on `quote_responses` does not fire its `reject_mutation()` row trigger (DDL, not UPDATE) — say so in a comment.
- **Proof:** `cd server && npx vitest run src/__tests__/migrations.test.ts src/__tests__/accounting/quoteConstraints.test.ts` → pass.
- **If it fails:** stop and report.
- **Owes:** schema.md in S3.

### Step D2 — [Sonnet] Code request and verification in the public flow

- **Model:** [Sonnet] — security-sensitive token handling.
- **Depends on:** D1
- **Read first:** `server/src/services/accounting/publicQuoteService.ts`, `server/src/services/invitationService.ts` (how a token hash is compared), `server/src/utils/pkce.ts` (`sha256Hex`), `server/src/services/mail/templates.ts` (`verify_email` case).
- **Files:** `server/src/services/accounting/publicQuoteService.ts` (edit), `server/src/services/accounting/quoteService.ts` (edit `ResponseEvidence` + insert), `server/src/types/accounting.ts` (edit `PublicQuoteView`, `QuoteResponse`, `InvoiceSettings`), `server/src/types/email.ts` (`EMAIL_TEMPLATES` + `'quote_acceptance_code'`), `server/src/services/mail/templates.ts` (new case), `server/src/config/constants.ts` (three constants), `server/src/services/accounting/invoiceSettingsService.ts` + `server/src/schemas/accounting/invoiceSettingsSchema.ts` (expose `quoteAcceptanceRequiresCode: z.boolean().optional()` exactly like Slice A), `server/src/schemas/accounting/quoteSchema.ts` (`publicAcceptQuoteSchema` gains `code: z.string().regex(/^\d{6}$/).nullable().default(null)`; new `publicVerifyEmailSchema = z.object({ signerEmail: z.email().trim().toLowerCase().max(254) })`).
- **Contract:**
  - `requestAcceptanceCode(token, signerEmail): Promise<{ expiresAt: string }>`: resolve link; the quote must be effectively SENT (`409 This quote is no longer open for a response`); count codes for this link created in the last hour — `>= QUOTE_ACCEPTANCE_CODES_PER_HOUR` → `ApiError(429, 'Too many codes requested — try again later')`; `code = String(randomInt(0, 1_000_000)).padStart(6, '0')` (`node:crypto`); insert with `code_hash = sha256Hex(`${link.id}:${code}`)`, `expires_at = now + TTL`; enqueue `quote_acceptance_code` to `signerEmail` with `data: { organizationName, quoteNumber, code, minutes: 10 }` (the code goes in `data`, the email has **no** link). All in one `withTransaction`.
  - `verifyAcceptanceCodeOnClient(client, link, signerEmail, code)`: select the newest row `WHERE org_id = $1 AND link_id = $2 AND signer_email = $3 AND consumed_at IS NULL AND expires_at > now() FOR UPDATE`; none → `422 Request a new verification code`; `attempts >= 5` → `422 Too many attempts — request a new code`; increment `attempts`; compare `sha256Hex(`${link.id}:${code}`)` with `timingSafeEqual` on equal-length buffers; mismatch → `422 That code is not correct`; match → `consumed_at = now()`.
  - Wrong-code attempts must persist even though the request fails: run the increment in its **own** `withTransaction` before the accept transaction, then verify-and-consume again inside the accept transaction. (Write it as: `bumpAttemptOnClient` in transaction 1, return early with the 422 on mismatch; on match, `consumeOnClient` inside the accept transaction.)
  - `acceptPublicQuote`: read `quote_acceptance_requires_code` for `link.orgId`. If true: `signerEmail === null` → `422 Enter your email to receive a verification code`; `code === null` → `422 Enter the verification code we emailed you`. If true **or** a code was supplied: verify; `ResponseEvidence.signerEmailVerified = true`. The `quote_responses` INSERT writes `signer_email_verified`.
  - `PublicQuoteView` gains `requiresEmailCode: boolean`; `QuoteResponse` gains `signerEmailVerified: boolean`.
  - Email `quote_acceptance_code`: subject `Your code to accept quote <quoteNumber>`; body lines `Your verification code is <code>.`, `It expires in 10 minutes. If you did not ask for it, ignore this email.`; `esc()` every value.
- **Guardrails:** #1 every code query has `org_id = $1` from the resolved link · #11 the code and its hash never reach a log · #9 emails lowercased.
- **Proof:** `cd server && npx tsc --noEmit && npx vitest run src/__tests__/accounting/quotePublicLink.test.ts` → passes unchanged (setting defaults to false).
- **If it fails:** stop and report.
- **Owes:** study note in S2.

### Step D3 — [Haiku] Public route

- **Model:** [Haiku] — one route + one adapter copied from `accept`.
- **Depends on:** D2
- **Read first:** `server/src/controllers/accounting/publicQuoteController.ts`, `server/src/routes/accounting/publicQuoteRoutes.ts`.
- **Files:** both (edit).
- **Contract:** `router.post('/:token/verify-email', publicLinkLimiter, publicQuoteController.verifyEmail)`; handler parses `publicVerifyEmailSchema`, calls `requestAcceptanceCode`, sets `Cache-Control: no-store`, responds `202 { success: true, expiresAt }`.
- **Proof:** `cd server && npx tsc --noEmit && npm run lint` → clean.
- **Owes:** api.md in S3.

### Step D4 — [Sonnet] Tests for verified acceptance

- **Model:** [Sonnet] — security tests against real PostgreSQL.
- **Depends on:** D3
- **Skill:** isolation-test
- **Read first:** `server/src/__tests__/accounting/quotePublicLink.test.ts`, `server/src/__tests__/helpers/email.ts` (`outboxFor`).
- **Files:** `server/src/__tests__/accounting/quoteSignerVerification.test.ts` (new); add `quote_acceptance_codes` to `resetTables()`.
- **Contract — cases** (org setting turned on via `PATCH /settings/invoicing { quoteAcceptanceRequiresCode: true }` unless stated):
  1. `the public view says requiresEmailCode: true`
  2. `accept without a code → 422 Enter the verification code we emailed you`
  3. `verify-email sends a quote_acceptance_code email whose template_data.code is 6 digits; accept with it → 200 and signerEmailVerified: true in the internal response`
  4. `a wrong code → 422; after 5 wrong codes the right one → 422 Too many attempts`
  5. `a code for jane@x is not valid for bob@x → 422 Request a new verification code`
  6. `an expired code (fake time + 11 minutes) → 422 Request a new verification code`
  7. `the 6th code request within an hour → 429`
  8. `setting off: accept without a code still works and records signerEmailVerified: false`
  9. `the code table stores only a 64-hex hash — the plain code is absent from quote_acceptance_codes`
- **Proof:** `cd server && npx vitest run src/__tests__/accounting/quoteSignerVerification.test.ts` → `9 passed`.
- **If it fails:** stop and report.
- **Owes:** nothing extra.

### Step D5 — [Haiku] Client: code entry on the public page, setting toggle, evidence row

- **Model:** [Haiku] — UI fields and labels listed.
- **Depends on:** D3
- **Read first:** `client/src/Pages/public/PublicQuotePage.tsx`, `client/src/Pages/settings/InvoiceSettingsPage.tsx` (the Slice A section), `client/src/Pages/sales/quotes/QuoteDetailPage.tsx` (evidence `<dl>`).
- **Files:** `client/src/services/fetchServices.ts` (`PublicQuoteView.requiresEmailCode`, `QuoteResponse.signerEmailVerified`, `InvoiceSettings.quoteAcceptanceRequiresCode`, `acceptPublicQuote` body gains `code: string | null`, new `requestPublicQuoteCode(token, signerEmail): Promise<{ success: boolean; expiresAt: string }>` with `credentials: 'omit'` and `NO_AUTO_REFRESH`), `PublicQuotePage.tsx`, `InvoiceSettingsPage.tsx` (checkbox label `Require customers to verify their email with a code before accepting`), `QuoteDetailPage.tsx` (after "Signed by": ` — email verified` when `signerEmailVerified`).
- **Contract (public page, only when `requiresEmailCode`):** the email input is required (label `Your email`); a button `Send code` calls `requestPublicQuoteCode` and shows `We emailed a 6-digit code to <email>.`; an input labelled `Verification code` (`inputMode="numeric"`, `maxLength={6}`); the accept button stays disabled until name, tick, email and a 6-digit code are present; the code is sent in the accept body.
- **Proof:** `cd client && npx tsc --noEmit -p . && npm run lint && npx vitest run` → all pass.
- **Owes:** nothing.

### Step D6 — [Haiku] Client test for code entry

- **Model:** [Haiku]
- **Depends on:** D5
- **Files:** `client/src/__tests__/quotes.test.tsx` (edit — append one `it`).
- **Contract:** `it('requires an emailed code when the organization asks for one')` — view with `requiresEmailCode: true`; accept disabled after name + tick; click `Send code` (mock `POST …/verify-email` → `202`); type `123456`; accept enabled; the accept body contains `code: '123456'`.
- **Proof:** `cd client && npx vitest run src/__tests__/quotes.test.tsx` → `10 passed`.
- **Owes:** nothing.

---

## Slice E — PDF output

**Outcome:** staff download a quote as PDF from the quote page; the recipient downloads the same PDF from the public page.

**Names:**
| Kind | Name |
|---|---|
| Dependencies | `pdfkit` (server `dependencies`), `@types/pdfkit` (server `devDependencies`) |
| Pure renderer | `server/src/services/accounting/quotePdfRenderer.ts` → `export interface QuotePdfInput`, `export function renderQuotePdf(input: QuotePdfInput, options?: { compress?: boolean }): Promise<Buffer>` |
| Service fns | `quoteService.getQuotePdf(orgId, direction, id): Promise<{ filename: string; pdf: Buffer }>`; `publicQuoteService.getPublicQuotePdf(token): Promise<{ filename: string; pdf: Buffer }>` |
| Routes | `GET /api/v1/quotes/:id/pdf`, `GET /api/v1/purchase-quotes/:id/pdf` (`…view`), `GET /api/v1/public/quotes/:token/pdf` |
| Tests | `server/src/__tests__/quotePdf.test.ts` (pure), cases appended to `quotes.test.ts` and `quotePublicLink.test.ts` |

### Step E1 — [Sonnet] Add the dependency and record it

- **Model:** [Sonnet] — a dependency decision under rule #14.
- **Depends on:** Step 0
- **Files:** `server/package.json`, `server/package-lock.json` (via npm), `docs/development.md` (dependency table).
- **Do:** `cd server && npm install pdfkit && npm install -D @types/pdfkit`. Record the **resolved** versions from `package.json`. Add a row to the dependency table in `docs/development.md` after the `pdfjs-dist` row: `` | `pdfkit` | server | Writing quote PDFs (Phase 42) — pure JavaScript, built-in standard fonts, no native binding | ``.
- **Proof:** `cd server && npx tsc --noEmit && node -e "require('pdfkit')"` exits 0; `npm ls pdfkit` shows one version.
- **If it fails:** the install pulls a native build step or fails → STOP and report; do not substitute another library.
- **Owes:** the development.md row (done here).

### Step E2 — [Sonnet] Pure renderer + unit test

- **Model:** [Sonnet] — a new library whose API the executor must use correctly; layout correctness.
- **Depends on:** E1
- **Read first:** `client/src/Pages/sales/quotes/QuoteDocument.tsx` (the layout to reproduce: header, party block, title, lines table, totals, notes, terms).
- **Files:** `server/src/services/accounting/quotePdfRenderer.ts` (new), `server/src/__tests__/quotePdf.test.ts` (new).
- **Contract:**
  ```ts
  export interface QuotePdfInput {
    merchantName: string; merchantAddressLines: string[]; logo: Buffer | null; // PNG or JPEG bytes only
    direction: QuoteDirection; quoteNumber: string | null; revision: number;
    partyName: string; partyAddress: string | null; partyTaxNumber: string | null; partyReference: string | null;
    quoteDate: string; validUntil: string; currencyCode: string; title: string | null;
    notes: string | null; terms: string | null; paymentTerms: string | null;
    depositPercentBp: number | null; // null until Slice G; render nothing when null
    lines: { description: string; quantityMilli: number; unitPriceCents: number; taxRateBp: number; netCents: number }[];
    subtotalCents: number; taxCents: number; totalCents: number;
  }
  export function renderQuotePdf(input: QuotePdfInput, options: { compress?: boolean } = {}): Promise<Buffer>;
  ```
  `new PDFDocument({ size: 'A4', margin: 50, compress: options.compress ?? true, info: { Title: <heading + number>, Producer: 'AutoLedger' } })`; collect `data` chunks into one `Buffer` on `end`. Fonts `Helvetica` / `Helvetica-Bold` only. Heading `QUOTE` or `PURCHASE QUOTE`. Money via a local `money(cents)` = integer arithmetic as in `statementEmailService.formatMoney` without the currency (import `formatMoney` and use it for totals). Quantity `quantityMilli / 1000` formatted with up to 3 decimals by integer division (no floats in money; quantity display only). A new page when `doc.y > doc.page.height - 120` before each line. Date strings printed as given (YYYY-MM-DD).
  Tests (compress false; read `buffer.toString('latin1')`): `starts with %PDF-`; `contains the quote number and total ("QU-000012", "230.00")`; `a purchase quote is headed PURCHASE QUOTE`; `200 lines produce more than one page ("/Type /Page" count > 1)`; `a draft (null number) renders "DRAFT"`.
- **Proof:** `cd server && npx vitest run src/__tests__/quotePdf.test.ts` → `5 passed`.
- **If it fails:** stop and report.
- **Owes:** study note in S2.

### Step E3 — [Sonnet] Load data, routes, and API tests

- **Model:** [Sonnet] — logo bytes from the Document Vault (tenant-scoped), public token route.
- **Depends on:** E2
- **Read first:** `server/src/services/accounting/publicQuoteService.ts` (`openPublicQuoteLogo`), `server/src/services/documentService.ts` (`openDocumentStream`).
- **Files:** `server/src/services/accounting/quoteService.ts` (add `getQuotePdf`), `server/src/services/accounting/publicQuoteService.ts` (add `getPublicQuotePdf`), `server/src/controllers/accounting/quoteController.ts` + `publicQuoteController.ts` (add `pdf`), `server/src/routes/accounting/quoteRoutes.ts` + `publicQuoteRoutes.ts` (add routes), `server/src/__tests__/accounting/quotes.test.ts` + `quotePublicLink.test.ts` (append cases).
- **Contract:** logo: only when `profile.logoDocumentId !== null` and mime is `image/png` or `image/jpeg`; read the stream fully into a Buffer; any other mime → `logo: null`. `filename` = `${quoteNumber}${revision > 1 ? `-rev${revision}` : ''}.pdf`, or `quote-draft.pdf` for a draft. Response headers: `Content-Type: application/pdf`, `Content-Disposition: attachment; filename="<filename>"`, `Content-Length`, `Cache-Control: no-store` (both routes), `X-Content-Type-Options: nosniff`. Routes: `router.get('/:id/pdf', authenticate, requirePermission(key.view), c.pdf)`; `router.get('/:token/pdf', publicLinkLimiter, publicQuoteController.pdf)`.
  Cases: `GET /quotes/:id/pdf → 200 application/pdf, body starts %PDF-, filename QU-000001.pdf`; `org B → 404`; `GET /public/quotes/:token/pdf → 200 without a session`; `revoked token → 404`.
- **Proof:** `cd server && npx tsc --noEmit && npm run lint && npx vitest run src/__tests__/accounting/quotes.test.ts src/__tests__/accounting/quotePublicLink.test.ts src/__tests__/platform/routePermissions.test.ts` → all pass.
- **Owes:** api.md in S3.

### Step E4 — [Haiku] Client download buttons

- **Model:** [Haiku] — copies the existing logo blob fetch.
- **Depends on:** E3
- **Read first:** `getPublicQuoteLogo` in `client/src/services/fetchServices.ts`.
- **Files:** `client/src/services/fetchServices.ts` (add `downloadQuotePdf(direction, id): Promise<Blob>` using `credentials: 'include'` and `downloadPublicQuotePdf(token): Promise<Blob>` using `credentials: 'omit'`; both throw `ApiRequestError(status, 'Could not download the PDF')` when not ok), `QuoteDetailPage.tsx` (button `Download PDF` next to `Print`), `PublicQuotePage.tsx` (button `Download PDF` above `Print`). Download = `URL.createObjectURL(blob)`, a temporary `<a download="<number>.pdf">` click, then `URL.revokeObjectURL`.
- **Proof:** `cd client && npx tsc --noEmit -p . && npm run lint && npx vitest run` → all pass.
- **Owes:** nothing.

---

## Slice F — sales and purchase orders, with partial invoicing/billing

**Outcome:** an accepted quote (or a hand-made order) becomes a confirmed sales/purchase order; invoices/bills are raised against it for part of each line's quantity, never more than ordered, with remaining quantities shown.

**Names:**
| Kind | Name |
|---|---|
| Migration | `server/src/db/migrations/092_ledger-core_orders.sql` |
| Tables | `orders`, `order_lines`; columns `invoice_lines.order_line_id`, `bill_lines.order_line_id` |
| Counters | `ledger_invoice_settings.order_prefix ('SO-')`, `order_next_number`, `purchase_order_prefix ('PO-')`, `purchase_order_next_number`; `SERIES_COUNTER.SALES_ORDER`, `.PURCHASE_ORDER`; `allocateOrderNumber(client, orgId, direction)` |
| FSM (`types/accounting.ts`) | `ORDER_STATUSES = ['DRAFT','CONFIRMED','CLOSED','CANCELLED']`; `ORDER_TRANSITIONS = { DRAFT: ['CONFIRMED'], CONFIRMED: ['CLOSED','CANCELLED'], CLOSED: ['CONFIRMED'], CANCELLED: [] }`; `canTransitionOrder`; `OrderBillingStatus = 'NOT_BILLED' \| 'PARTIALLY_BILLED' \| 'FULLY_BILLED'` |
| Types | `Order`, `OrderLine` (with `orderedQuantityMilli`, `billedQuantityMilli`, `remainingQuantityMilli`), `OrderSummary` |
| Services | `services/accounting/orderService.ts` → `listOrders`, `getOrderById`, `createOrder`, `updateOrder`, `deleteOrder`, `confirmOrder`, `closeOrder`, `reopenOrder`, `cancelOrder`, `createOrderFromQuoteOnClient`, `convertOrder`; `services/accounting/orderLineLinks.ts` → `assertOrderLineLinksOnClient` |
| Schemas | `schemas/accounting/orderSchema.ts` → `createOrderSchema`, `updateOrderSchema`, `cancelOrderSchema`, `convertOrderSchema` |
| Controller / routes | `controllers/accounting/orderController.ts` → `makeOrderController(direction)`; `routes/accounting/orderRoutes.ts` → `buildOrderRouter(direction)`; mounts `/orders` (SALES), `/purchase-orders` (PURCHASE) |
| Permissions | `sales_orders.view` (V, requires `customers.view`), `sales_orders.edit` (A, requires `sales_orders.view`, `customers.view`, `products.view`, `accounts.view`), `sales_orders.convert` (A, requires `sales_orders.view`, `invoices.edit`); `purchase_orders.view/edit/convert` mirrored with `vendors.view` and `bills.edit` |
| Events | `'order.confirmed'`, `'order.cancelled'` in `OUTBOX_EVENT_TYPES` |
| Tests | `server/src/__tests__/accounting/{orderConstraints,orders}.test.ts`; `client/src/__tests__/orders.test.tsx` |
| Client | `client/src/Pages/sales/orders/{orderKinds.ts,OrderListPage.tsx,OrderFormPage.tsx,OrderDetailPage.tsx}`; wrappers `Pages/sales/{SalesOrdersPage,NewSalesOrderPage,SalesOrderDetailPage}.tsx`, `Pages/purchases/{PurchaseOrdersPage,NewPurchaseOrderPage,PurchaseOrderDetailPage}.tsx`; routes `/sales-orders[/new|/:orderId|/:orderId/edit]`, `/purchase-orders[…]` |

> Client route base for sales orders is `/sales-orders` (not `/orders`) so the UI never collides with a future generic path; the API base stays `/api/v1/orders`.

### Step F1 — [Sonnet] Migration 092

- **Model:** [Sonnet] — migration with a deferred cap trigger.
- **Depends on:** D1 (sequential numbering)
- **Skill:** new-migration
- **Read first:** `server/src/db/migrations/089_ledger-core_quotes.sql` (copy its structure: party XOR, completeness CHECKs, composite FKs, immutability trigger, back-link FK on `(org_id, id, direction)`), `server/src/db/migrations/063_ledger-core_credit_debit_notes.sql` (its deferred cap trigger — copy that technique).
- **Files:** `server/src/db/migrations/092_ledger-core_orders.sql` (new).
- **Contract:**
  - Settings counters: four `ADD COLUMN IF NOT EXISTS` lines mirroring 089's quote counters (`order_prefix TEXT NOT NULL DEFAULT 'SO-' CHECK (length(order_prefix) <= 12)`, `order_next_number INTEGER NOT NULL DEFAULT 1 CHECK (order_next_number > 0)`, same for `purchase_order_*` with `'PO-'`).
  - `orders`: `id`, `org_id` RESTRICT, `direction` (`SALES`/`PURCHASE`), `customer_id`, `vendor_id` (`ck_orders_party` as `ck_quotes_party`), `order_number TEXT NULL`, `status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','CONFIRMED','CLOSED','CANCELLED'))`, `order_date DATE NOT NULL`, `expected_date DATE NULL CHECK (expected_date IS NULL OR expected_date >= order_date)`, `currency_code CHAR(3) NOT NULL`, `party_name_snapshot TEXT NOT NULL`, `party_address_snapshot`, `party_tax_number_snapshot`, `party_reference TEXT NULL ≤100`, `notes ≤1000`, `terms ≤5000`, `payment_terms`, `payment_terms_code`, `subtotal_cents`/`tax_cents`/`total_cents BIGINT ≥0` + `chk_orders_total`, `source_quote_id UUID NULL`, `source_quote_direction TEXT NULL`, `confirmed_at`, `confirmed_by` (users RESTRICT), `closed_at`, `cancelled_at`, `cancel_reason ≤500`, `created_by` (users RESTRICT), `created_at`, `updated_at`.
    Constraints: `ux_orders_org_id_id UNIQUE (org_id, id)`, `ux_orders_org_id_id_direction UNIQUE (org_id, id, direction)`, `ux_orders_number UNIQUE (org_id, direction, order_number)`, `ck_orders_source_quote CHECK ((source_quote_id IS NULL AND source_quote_direction IS NULL) OR (source_quote_id IS NOT NULL AND source_quote_direction = direction))`, `fk_orders_source_quote FOREIGN KEY (org_id, source_quote_id, source_quote_direction) REFERENCES quotes (org_id, id, direction) ON DELETE RESTRICT`, partial unique `ux_orders_source_quote ON orders (org_id, source_quote_id) WHERE source_quote_id IS NOT NULL`, `ck_orders_confirmed_complete CHECK (status = 'DRAFT' OR (order_number IS NOT NULL AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL))`, `ck_orders_closed_complete CHECK (status <> 'CLOSED' OR closed_at IS NOT NULL)`, `ck_orders_cancelled_complete CHECK (status <> 'CANCELLED' OR (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL))`, composite FKs to customers/vendors RESTRICT. Indexes: `(org_id, direction, status, order_date DESC)`, customer, vendor, `created_by`, `confirmed_by`.
  - `order_lines`: as `quote_lines` (089) plus `CONSTRAINT ux_order_lines_org_id_id UNIQUE (org_id, id)`; FK to orders CASCADE; `trg_order_lines_draft_only` (copy 089's line trigger, table names changed).
  - `invoice_lines.order_line_id UUID NULL` and `bill_lines.order_line_id UUID NULL`, each with `FOREIGN KEY (org_id, order_line_id) REFERENCES order_lines (org_id, id) ON DELETE RESTRICT` (named `fk_invoice_lines_order_line`, `fk_bill_lines_order_line`, in guarded DO blocks) and a partial index `WHERE order_line_id IS NOT NULL`.
  - `reject_confirmed_order_mutation()`: copy `reject_sent_quote_mutation()` — DRAFT may change freely but only become `DRAFT`/`CONFIRMED`; DELETE only while DRAFT; otherwise allowed pairs exactly `CONFIRMED→CLOSED`, `CONFIRMED→CANCELLED`, `CLOSED→CONFIRMED`; changeable columns exactly `status, updated_at, closed_at, cancelled_at, cancel_reason` (on `CLOSED→CONFIRMED` the service sets `closed_at = NULL`). `trg_orders_immutable`, `trg_orders_updated_at`, `trg_orders_audit`.
  - Over-billing guard: `check_order_line_billing() RETURNS trigger` — for `NEW.order_line_id` (or `OLD` on delete, skip when NULL): `SELECT ol.quantity_milli` and `SUM(x.quantity_milli)` over `invoice_lines` joined to non-VOID `invoices` **plus** `bill_lines` joined to non-VOID `bills` with that `order_line_id`; if the sum exceeds the ordered quantity → `RAISE EXCEPTION 'Order line % would be billed beyond its ordered quantity', ol.id USING ERRCODE = 'P0001'`. Attach as `CREATE CONSTRAINT TRIGGER trg_invoice_lines_order_cap AFTER INSERT OR UPDATE ON invoice_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_order_line_billing()` and the same `trg_bill_lines_order_cap` on `bill_lines`. Constraint triggers are not `CREATE OR REPLACE`-able: wrap each in `IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = …)`.
  - Recreate `ck_email_outbox_template`? **No** — orders send no email in this phase.
- **Proof:** `cd server && npx vitest run src/__tests__/migrations.test.ts` → passes.
- **If it fails:** stop and report.
- **Owes:** schema.md in S3.

### Step F2 — [Haiku] Types, FSM table, permissions, events, counters

- **Model:** [Haiku] — transcription of the registry.
- **Depends on:** F1
- **Read first:** the `QUOTE_*` block at the end of `server/src/types/accounting.ts`; `SERIES_COUNTER` / `allocateQuoteNumber` in `invoiceSettingsService.ts`; the `quotes.*` rows in `config/permissions.ts`.
- **Files:** `server/src/types/accounting.ts` (append order types + FSM), `server/src/services/accounting/invoiceSettingsService.ts` (two `SERIES_COUNTER` entries + `allocateOrderNumber`), `server/src/config/permissions.ts` (six rows: sales ones after the `quotes.*` rows, purchase ones after `purchase_quotes.*`), `server/src/types/webhooks.ts` (two events).
- **Contract:**
  ```ts
  export interface OrderLine { id: string; lineNumber: number; description: string; quantityMilli: number; unitPriceCents: number; accountId: string; accountCode: string; accountName: string; taxRateBp: number; netCents: number; taxCents: number; itemId: string | null; billedQuantityMilli: number; remainingQuantityMilli: number }
  export interface OrderSummary { id: string; direction: QuoteDirection; orderNumber: string | null; status: OrderStatus; billingStatus: OrderBillingStatus; partyId: string; partyName: string; orderDate: string; expectedDate: string | null; currencyCode: string; totalCents: number; createdAt: string }
  export interface Order extends OrderSummary { partyNameSnapshot: string; partyAddressSnapshot: string | null; partyTaxNumberSnapshot: string | null; partyReference: string | null; notes: string | null; terms: string | null; paymentTerms: string | null; paymentTermsCode: string | null; subtotalCents: number; taxCents: number; sourceQuote: SourceQuoteRef | null; confirmedAt: string | null; closedAt: string | null; cancelledAt: string | null; cancelReason: string | null; createdBy: string; createdByName: string | null; updatedAt: string; lines: OrderLine[]; documents: { kind: 'INVOICE' | 'BILL'; id: string; number: string | null; status: string; totalCents: number }[] }
  export async function allocateOrderNumber(client: Queryable, orgId: string, direction: 'SALES' | 'PURCHASE'): Promise<string>;
  ```
  `QuoteConvertedDocument.kind` widens to `'INVOICE' | 'BILL' | 'ORDER'`.
- **Proof:** `cd server && npx tsc --noEmit && npx vitest run src/__tests__/platform/customRoles.test.ts src/__tests__/platform/routePermissions.test.ts` → pass (if a test counts catalogue keys, update its expected count by +6 — it asserts the catalogue size, which this step changed deliberately).
- **Owes:** nothing extra.

### Step F3 — [Sonnet] `orderService` — CRUD and lifecycle

- **Model:** [Sonnet] — tenant SQL, FSM writes, derived billing quantities.
- **Depends on:** F2
- **Skill:** new-module (service layer)
- **Read first:** `server/src/services/accounting/quoteService.ts` (copy `prepareOnClient`, `insertLinesOnClient`, `lockQuoteOnClient`, `mapWriteError`/`runQuoteWrite`, list filters and sort map), `server/src/services/accounting/quoteStatusService.ts`.
- **Files:** `server/src/services/accounting/orderService.ts` (new), `server/src/schemas/accounting/orderSchema.ts` (new).
- **Contract:**
  - Schemas: `createOrderSchema` = `createQuoteSchema` with `quoteDate`→`orderDate`, `validUntil`→`expectedDate: z.iso.date().nullable().default(null)`, and no `terms` default behaviour (plain `nullable().default(null)`); `updateOrderSchema = createOrderSchema`; `cancelOrderSchema = z.object({ reason: z.string().trim().min(1).max(500) })`; `convertOrderSchema = z.object({ documentDate: z.iso.date().nullable().default(null), dueDate: z.iso.date().nullable().default(null), vendorReference: z.string().trim().min(1).max(100).nullable().default(null), lines: z.array(z.object({ orderLineId: z.uuid(), quantityMilli: z.int().min(1).max(1_000_000_000) })).min(1).nullable().default(null) })`.
  - `billedQuantityMilli` per line = `COALESCE(SUM(il.quantity_milli) FILTER over non-VOID invoices, 0) + same for bills`, one grouped query per order (`WHERE ol.org_id = $1 AND ol.order_id = $2`). `remaining = ordered − billed`. `billingStatus`: all billed 0 → `NOT_BILLED`; all remaining 0 → `FULLY_BILLED`; else `PARTIALLY_BILLED`.
  - `confirmOrder(orgId, userId, direction, id)`: DRAFT only (409 `Only a draft order can be confirmed`); `canTransitionOrder`; allocate number; re-snapshot party; `UPDATE … status='CONFIRMED', order_number, confirmed_at=now(), confirmed_by`; `emitEvent('order.confirmed', { orderId, direction, orderNumber, totalCents, currencyCode })`.
  - `closeOrder` CONFIRMED→CLOSED (`closed_at=now()`); `reopenOrder` CLOSED→CONFIRMED (`closed_at=NULL`); `cancelOrder(…, reason)` CONFIRMED→CANCELLED only when no non-VOID invoice/bill line links to it (`409 Void the invoices raised against this order first`), `emitEvent('order.cancelled', …)`. Every transition goes through one private `transitionOrderOnClient` that checks `canTransitionOrder` (409 `A <status> order cannot become <to>`).
  - `deleteOrder`: DRAFT only (404 / 409 `Only a draft order can be deleted — cancel it instead`).
  - Error messages for create/update mirror quotes (`Customer not found`, `Vendor not found`, account-type 422s, `Only a draft order can be edited`).
- **Guardrails:** #1 every statement `org_id` + `direction` · #10 one transition writer · #5 client inside transactions.
- **Proof:** `cd server && npx tsc --noEmit && npm run lint` → clean.
- **Owes:** nothing extra.

### Step F4 — [Sonnet] Invoice/bill lines carry `orderLineId`

- **Model:** [Sonnet] — edits the invoice and bill cores (posting-adjacent), cross-document validation.
- **Depends on:** F3
- **Read first:** `invoiceService.insertInvoiceLines`, `createInvoiceOnClient`, `updateInvoice`, `toLine`, `loadLines`; the bill equivalents; `schemas/accounting/invoiceSchema.ts` and `billSchema.ts`.
- **Files:** `server/src/services/accounting/orderLineLinks.ts` (new), `server/src/services/accounting/invoiceService.ts`, `server/src/services/accounting/billService.ts`, `server/src/schemas/accounting/invoiceSchema.ts`, `server/src/schemas/accounting/billSchema.ts`, `server/src/types/accounting.ts` (`InvoiceLine.orderLineId: string | null`, `BillLine.orderLineId: string | null`).
- **Contract:**
  - Both line schemas gain `orderLineId: z.uuid().nullable().default(null)`; both `*LineInput` interfaces gain `orderLineId?: string | null | undefined`.
  - `assertOrderLineLinksOnClient(client, orgId, direction: QuoteDirection, partyId: string, currencyCode: string, orderLineIds: string[]): Promise<void>` — no-op for an empty list; otherwise one query joining `order_lines` → `orders` `WHERE ol.org_id = $1 AND ol.id = ANY($2::uuid[])` locking the orders `FOR UPDATE OF o`; each id must exist (`422 Order line not found`), belong to `direction`, an order in status `CONFIRMED` (`422 Only a confirmed order can be invoiced`), the same party (`422 That order belongs to a different customer|vendor`) and currency (`422 An order can only be billed in its own currency`).
  - Call it in `createInvoiceOnClient` / `updateInvoice` / the bill equivalents before inserting lines; the INSERTs write `order_line_id`; `loadLines` selects it; `toLine` maps it.
  - The deferred trigger enforces the quantity cap at COMMIT; map its `P0001` message through the existing `PG_RAISE_EXCEPTION → 422` branches (already present in `createInvoice`/`updateInvoice`/bill equivalents — verify each wrapper has one).
- **Guardrails:** #1 · #5 · #6 (issued invoices untouched — the column is set only while DRAFT, and 009's trigger already forbids changes after issue).
- **Proof:** `cd server && npx tsc --noEmit && npx vitest run src/__tests__/accounting/invoices.test.ts src/__tests__/accounting/bills.test.ts src/__tests__/accounting/recurringSchedules.test.ts` → all pass unchanged.
- **If it fails:** an existing test breaks because a line object gained `orderLineId` → update only that equality expectation to include `orderLineId: null`.
- **Owes:** nothing extra.

### Step F5 — [Sonnet] Converting orders, and quote → order

- **Model:** [Sonnet] — multi-document transaction.
- **Depends on:** F4
- **Read first:** `quoteService.convertQuote`.
- **Files:** `server/src/services/accounting/orderService.ts` (add `convertOrder`, `createOrderFromQuoteOnClient`), `server/src/services/accounting/quoteService.ts` (edit `convertQuote` + `loadConvertedDocument`), `server/src/schemas/accounting/quoteSchema.ts` (`convertQuoteSchema` gains `target: z.enum(['INVOICE','ORDER']).default('INVOICE')`).
- **Contract:**
  - `convertOrder(orgId, userId, direction, id, input): Promise<{ kind: 'INVOICE' | 'BILL'; id: string }>`: lock order `FOR UPDATE`; must be CONFIRMED (`409 Only a confirmed order can be invoiced`); `input.lines === null` → every line with `remaining > 0` at its remaining quantity; else each requested quantity must be `≤ remaining` (`422 Line <n> has only <remaining as decimal> left to bill`); none left → `409 Everything on this order has been billed`. Build lines copying description/unit price/account/tax/item from the order line, `quantityMilli` = requested, `orderLineId` = the order line. SALES → `invoiceService.createInvoiceOnClient(…)`; PURCHASE → `billService.createBillOnClient(…)` with `vendorReference = input.vendorReference ?? `${orderNumber}-${n}`` where `n` = 1 + count of existing bills linked to this order. Due date rule identical to `convertQuote`.
  - `createOrderFromQuoteOnClient(client, orgId, userId, quote: Quote): Promise<string>` — inserts a CONFIRMED order directly (number allocated, `source_quote_id`, `confirmed_at`, `confirmed_by`), copying party snapshot, currency, terms, payment terms, notes, party reference and lines; emits `order.confirmed`.
  - `convertQuote` with `target: 'ORDER'` calls it instead of creating an invoice/bill, then transitions the quote to CONVERTED as today; `loadConvertedDocument` also checks `orders.source_quote_id` → `{ kind: 'ORDER', id, number: order_number, status }`. Deleting is impossible for a confirmed order, so there is no revert path; cancelling the order does **not** revert the quote (documented, tested).
- **Proof:** `cd server && npx tsc --noEmit && npx vitest run src/__tests__/accounting/quotes.test.ts` → passes unchanged.
- **Owes:** nothing extra.

### Step F6 — [Haiku] Controller, routes, mounts

- **Model:** [Haiku] — copies `quoteController`/`quoteRoutes`.
- **Depends on:** F5
- **Read first:** `server/src/controllers/accounting/quoteController.ts`, `server/src/routes/accounting/quoteRoutes.ts`, `server/src/routes/accounting/index.ts` (quote mounts).
- **Files:** `server/src/controllers/accounting/orderController.ts` (new), `server/src/routes/accounting/orderRoutes.ts` (new), `server/src/routes/accounting/index.ts` (mount `/orders` → `buildOrderRouter('SALES')`, `/purchase-orders` → `buildOrderRouter('PURCHASE')`).
- **Contract — routes (`K` = `sales_orders` | `purchase_orders`):**
  | Method / path | Permission | Success |
  |---|---|---|
  | GET `/` | `K.view` | `200 { success, count, totalCount, currentPage, totalPages, orders }` (filters `status`, `partyId`, `from`, `to`, `q`, `sort` ∈ `orderDate,number,party,total,status`, `dir`) |
  | GET `/:id` | `K.view` | `200 { success, order }` |
  | POST `/` | `K.edit` | `201 { success, order }` |
  | PATCH `/:id` | `K.edit` | `200 { success, order }` |
  | DELETE `/:id` | `K.edit` | `204` |
  | POST `/:id/confirm` | `K.edit` | `200 { success, order }` |
  | POST `/:id/close` · `/:id/reopen` | `K.edit` | `200 { success, order }` |
  | POST `/:id/cancel` | `K.edit` | `200 { success, order }` (body `{ reason }`) |
  | POST `/:id/convert` | `K.convert` | `201 { success, document: { kind, id } }` |
- **Proof:** `cd server && npx tsc --noEmit && npm run lint && npx vitest run src/__tests__/platform/routePermissions.test.ts` → pass.
- **Owes:** api.md in S3.

### Step F7 — [Sonnet] Order constraint tests

- **Model:** [Sonnet]
- **Depends on:** F6
- **Skill:** isolation-test
- **Read first:** `server/src/__tests__/accounting/quoteConstraints.test.ts` (raw-insert fixture + parity walk).
- **Files:** `server/src/__tests__/accounting/orderConstraints.test.ts` (new); add `orders`, `order_lines` to `resetTables()`.
- **Contract — cases:** `party XOR per direction`; `a confirmed order needs number, confirmed_at, confirmed_by`; `a confirmed order's money and lines cannot change`; `the trigger allows exactly ORDER_TRANSITIONS (4×4 parity walk)`; `an invoice line linked beyond the ordered quantity fails at COMMIT (deferred) with P0001`; `a VOID invoice's lines stop counting toward the cap`; `a purchase order's line cannot be linked from an invoice of another org (composite FK)`; `a sales quote cannot be the source of a purchase order (direction FK)`.
- **Proof:** `cd server && npx vitest run src/__tests__/accounting/orderConstraints.test.ts` → `8 passed`.
- **Owes:** nothing extra.

### Step F8 — [Sonnet] Order API tests (partial billing, isolation)

- **Model:** [Sonnet]
- **Depends on:** F7
- **Skill:** isolation-test
- **Read first:** `server/src/__tests__/accounting/quotes.test.ts`.
- **Files:** `server/src/__tests__/accounting/orders.test.ts` (new).
- **Contract — cases:** 1 `create → confirm numbers SO-000001 (PO-000001 for purchase)`; 2 `convert 2 of 5 units → DRAFT invoice with orderLineId; order PARTIALLY_BILLED, remaining 3`; 3 `convert with lines null bills the remaining 3 → FULLY_BILLED`; 4 `asking for more than remaining → 422 Line 1 has only 3 left to bill`; 5 `editing the draft invoice to 6 units → 422 from the deferred cap`; 6 `deleting the draft invoice restores remaining`; 7 `voiding an issued invoice restores remaining`; 8 `cancel with a live invoice → 409; after voiding it → 200 CANCELLED`; 9 `close then reopen`; 10 `quote with target ORDER → CONFIRMED order with sourceQuote; quote CONVERTED; convertedDocument kind ORDER`; 11 `purchase order → two partial bills get vendor references PO-000001-1 and PO-000001-2`; 12 `no journal rows are written by any order action (count before/after)`; 13 `a VIEWER can read, not create or convert → 403`; 14 `cross-tenant: org B gets 404 on every order route for org A's order, and 422 Order line not found linking A's order line from B's invoice`.
- **Proof:** `cd server && npx vitest run src/__tests__/accounting/orders.test.ts` → `14 passed`.
- **Owes:** nothing extra.

### Step F9 — [Haiku] Client API layer for orders

- **Model:** [Haiku] — copies the quote block.
- **Depends on:** F6
- **Read first:** the `/* quotes (Phase 41) */` block at the end of `client/src/services/fetchServices.ts`.
- **Files:** `client/src/services/fetchServices.ts` (append an orders block: types mirroring F2's `Order`/`OrderLine`/`OrderSummary`; `listOrders(direction, filters)`, `getOrder`, `createOrder`, `updateOrder`, `deleteOrder`, `confirmOrder`, `closeOrder`, `reopenOrder`, `cancelOrder(direction, id, reason)`, `convertOrder(direction, id, body)`; base `/orders` vs `/purchase-orders`; `InvoiceLine`/`BillLine` and the invoice/bill line inputs gain `orderLineId: string | null`; `convertQuote` body gains `target: 'INVOICE' | 'ORDER'`; `Quote.convertedDocument.kind` widens), every client fixture that builds an `InvoiceLine`/`BillLine` (add `orderLineId: null`).
- **Proof:** `cd client && npx tsc --noEmit -p . && npx vitest run` → all pass.
- **Owes:** nothing.

### Step F10 — [Haiku] Client order pages

- **Model:** [Haiku] — the quote pages are the template; differences are listed.
- **Depends on:** F9
- **Read first:** `client/src/Pages/sales/quotes/*` (all five files), the quote wrappers, `client/src/routes/ProductRoutes.tsx`, `client/src/components/layout/nav.ts`, `client/src/components/layout/CreateMenu.tsx`.
- **Files:** `client/src/Pages/sales/orders/{orderKinds.ts,OrderListPage.tsx,OrderFormPage.tsx,OrderDetailPage.tsx}` (new), six wrappers (new), `ProductRoutes.tsx`, `nav.ts` (Sales: `Sales orders` → `/sales-orders`, permission `sales_orders.view`, icon `ClipboardList`, placed after Quotes; Purchases: `Purchase orders` → `/purchase-orders`, `purchase_orders.view`, after Purchase quotes), `CreateMenu.tsx` (`Sales order` → `/sales-orders/new` `sales_orders.edit`; `Purchase order` → `/purchase-orders/new` `purchase_orders.edit`).
- **Contract — differences from quotes:** no send/accept/revise/public link; list tabs `All`, `Draft`, `Confirmed`, `Closed`, `Cancelled` and a `Billing` column showing `Not billed` / `Partly billed` / `Fully billed`; form date fields `Order date`, `Expected date (optional)`; detail actions: DRAFT → `Edit`, `Confirm`, `Delete`; CONFIRMED → `Create invoice` (sales) / `Create expense` (purchase), `Close`, `Cancel`; CLOSED → `Reopen`. The lines table shows columns `Ordered`, `Billed`, `Remaining`. The create dialog lists every line with remaining > 0 and a quantity input per line (default = remaining; `0` excludes the line), plus document date, due date and, for purchase, `Vendor’s invoice no.`; on success navigate to `/invoices/:id` or `/expenses/:id`. A `Documents` section lists the linked invoices/bills.
  Quote detail convert dialog gains a radio `Create a draft invoice` / `Create a sales order` (purchase: `draft expense` / `purchase order`) sending `target`; on `ORDER` navigate to `/sales-orders/:id` or `/purchase-orders/:id`.
- **Proof:** `cd client && npx tsc --noEmit -p . && npm run lint && npx vitest run` → all pass.
- **Owes:** nothing.

### Step F11 — [Haiku] Invoice/expense forms keep the order link

- **Model:** [Haiku] — carry one field through two forms.
- **Depends on:** F9
- **Read first:** `client/src/Pages/sales/NewInvoicePage.tsx` (`DraftLine`, the load effect, `handleSubmit`), `client/src/Pages/purchases/NewBillPage.tsx` (same).
- **Files:** both forms; `InvoiceDetailPage.tsx`, `BillDetailPage.tsx`.
- **Contract:** `DraftLine` gains `orderLineId: string`; loading a draft copies `line.orderLineId ?? ''`; new lines start `''`; submit sends `orderLineId: line.orderLineId === '' ? null : line.orderLineId`. Detail pages: when any line has `orderLineId`, show `Raised against an order` under the status line (no link — the API does not return the order id on the invoice in this phase).
- **Proof:** `cd client && npx tsc --noEmit -p . && npx vitest run` → all pass.
- **Owes:** nothing.

### Step F12 — [Haiku] Client order tests

- **Model:** [Haiku]
- **Depends on:** F10, F11
- **Read first:** `client/src/__tests__/quotes.test.tsx` (mock helpers).
- **Files:** `client/src/__tests__/orders.test.tsx` (new).
- **Contract — cases:** `lists orders with billing status`; `a confirmed order offers Create invoice and sends per-line quantities` (assert body `lines: [{ orderLineId: 'ol1', quantityMilli: 2000 }]`); `a line set to 0 is excluded`; `the quote convert dialog sends target ORDER`.
- **Proof:** `cd client && npx vitest run src/__tests__/orders.test.tsx` → `4 passed`.
- **Owes:** nothing.

---

## Slice G — deposits and prepayments

**Outcome:** a confirmed order raises a deposit invoice (or deposit bill); once paid, the deposit is applied to the order's final invoice (or bill), clearing the contract liability (or prepayment asset) with a balanced journal; AR/AP aging, statements and party ledgers stay reconciled.

**Names:**
| Kind | Name |
|---|---|
| Migration | `server/src/db/migrations/093_ledger-core_deposits.sql` |
| Accounts | `2130 Customer Deposits` (Liability, postable, parent `2010`), `1150 Supplier Prepayments` (Asset, postable, parent `1100`) |
| Settings | `ledger_invoice_settings.customer_deposit_account_id`, `.supplier_prepayment_account_id` (nullable, composite FK → accounts, `ON DELETE SET NULL (column)`) ↔ `customerDepositAccountId`, `supplierPrepaymentAccountId` |
| Document kind | `invoices.kind`, `bills.kind` ∈ `'STANDARD','DEPOSIT'`; `invoices.deposit_for_order_id`, `bills.deposit_for_order_id` |
| Quote field | `quotes.deposit_percent_bp INTEGER NULL CHECK (deposit_percent_bp BETWEEN 1 AND 10000)` ↔ `depositPercentBp` |
| Table | `deposit_applications (id, org_id, direction, deposit_invoice_id, target_invoice_id, deposit_bill_id, target_bill_id, amount_cents, base_amount_cents, application_date, journal_entry_id, status, void_journal_entry_id, voided_at, created_by, created_at)` |
| FSM | `DEPOSIT_APPLICATION_STATUSES = ['POSTED','VOID']`, `DEPOSIT_APPLICATION_TRANSITIONS = { POSTED: ['VOID'], VOID: [] }` |
| Journal source types | `'deposit_application'`, `'deposit_application_void'` |
| Settlement SQL (`settlementSql.ts`) | `depositAppliedCentsSubquery(alias, column, amountColumn?)`, `depositAppliedAsOfCentsSubquery(alias, column, asOfParam, amountColumn?)` |
| Service | `services/accounting/depositService.ts` → `createDepositDocument`, `applyDeposit`, `voidDepositApplication`, `listDepositApplications`, `resolveDepositAccountsOnClient` |
| Routes | `POST /orders/:id/deposit` (`sales_orders.convert`), `POST /purchase-orders/:id/deposit` (`purchase_orders.convert`), `POST /invoices/:id/apply-deposit` (`invoices.issue`), `POST /bills/:id/apply-prepayment` (`bills.approve`), `POST /deposit-applications/:id/void` (`invoices.void` for SALES, `bills.void` for PURCHASE — checked in the service against the row's direction after a `requirePermission('invoices.view')` gate… **no**: see Step G5 for the exact gating) |
| Tests | `server/src/__tests__/accounting/{depositConstraints,deposits}.test.ts`; `client/src/__tests__/deposits.test.tsx` |

### Step G1 — [Sonnet] Migration 093

- **Model:** [Sonnet] — migration with a chart backfill and a new settlement table.
- **Depends on:** F1 (sequential numbering, `orders` FK target)
- **Skill:** new-migration
- **Read first:** `071_ledger-core_item_types_and_inventory_accounts.sql` (backfill block lines 125–140), `063_ledger-core_credit_debit_notes.sql` (allocation tables + void trigger), `089` (outbox CHECK style).
- **Files:** `server/src/db/migrations/093_ledger-core_deposits.sql` (new).
- **Contract:**
  - Backfill (copy 071's shape): `INSERT INTO accounts (org_id, code, name, type, is_postable, parent_id) SELECT o.id, '2130', 'Customer Deposits', 'Liability', true, (SELECT p.id FROM accounts p WHERE p.org_id = o.id AND p.code = '2010') FROM organizations o WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.org_id = o.id AND a.code = '2010') ON CONFLICT (org_id, code) DO NOTHING;` and the same for `'1150', 'Supplier Prepayments', 'Asset'` under `'1100'`.
  - Settings columns (guarded DO blocks for the FKs `fk_ledger_invoice_settings_customer_deposit_account`, `fk_ledger_invoice_settings_supplier_prepayment_account` → `accounts (org_id, id) ON DELETE SET NULL (customer_deposit_account_id)` / `(supplier_prepayment_account_id)`).
  - `invoices.kind TEXT NOT NULL DEFAULT 'STANDARD'`, `bills.kind` same, each with a named CHECK `IN ('STANDARD','DEPOSIT')`; `deposit_for_order_id UUID NULL` on both; CHECKs `ck_invoices_deposit_order CHECK ((kind = 'DEPOSIT') = (deposit_for_order_id IS NOT NULL))` (same for bills); composite FKs `(org_id, deposit_for_order_id) → orders (org_id, id) ON DELETE RESTRICT`; partial indexes `WHERE deposit_for_order_id IS NOT NULL`. 009/013 triggers allow these columns because they are set only at INSERT of a DRAFT.
  - `quotes.deposit_percent_bp` (nullable, CHECK 1..10000). 089's trigger already freezes it after send (whole-row diff) — say so in a comment.
  - `deposit_applications`: columns from the registry; `direction` (`SALES`/`PURCHASE`); `ck_deposit_applications_shape CHECK ((direction = 'SALES' AND deposit_invoice_id IS NOT NULL AND target_invoice_id IS NOT NULL AND deposit_bill_id IS NULL AND target_bill_id IS NULL) OR (direction = 'PURCHASE' AND deposit_bill_id IS NOT NULL AND target_bill_id IS NOT NULL AND deposit_invoice_id IS NULL AND target_invoice_id IS NULL))`; `amount_cents BIGINT NOT NULL CHECK (amount_cents > 0)`; `base_amount_cents BIGINT NOT NULL CHECK (base_amount_cents = amount_cents)` (base currency only this phase); `status TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED','VOID'))`; `ck_deposit_applications_void CHECK ((status = 'VOID') = (voided_at IS NOT NULL AND void_journal_entry_id IS NOT NULL))`; composite FKs to invoices/bills/journal_entries RESTRICT; `UNIQUE (org_id, id)`; indexes on each FK column. Trigger `reject_deposit_application_mutation()`: DELETE always refused; UPDATE only `POSTED→VOID` changing only `status, voided_at, void_journal_entry_id` (copy 009's `to_jsonb` diff). Audited.
  - `accountService.DEFAULT_CHART` gets the same two rows in Step G2 (code, not migration).
- **Proof:** `cd server && npx vitest run src/__tests__/migrations.test.ts src/__tests__/accounting/invoiceConstraints.test.ts` → pass.
- **Owes:** schema.md in S3.

### Step G2 — [Haiku] Types, default chart, settings fields

- **Model:** [Haiku] — transcription.
- **Depends on:** G1
- **Read first:** `accountService.DEFAULT_CHART`, Slice A's settings edits, `types/accounting.ts` invoice/bill/quote types.
- **Files:** `server/src/services/accounting/accountService.ts` (two `DEFAULT_CHART` rows: `{ code: '1150', name: 'Supplier Prepayments', type: 'Asset', parent: '1100', postable: true }` after `1140`; `{ code: '2130', name: 'Customer Deposits', type: 'Liability', parent: '2010', postable: true }` after `2120`), `server/src/types/accounting.ts` (`Invoice.kind`, `Invoice.depositForOrderId`, `Bill.kind`, `Bill.depositForOrderId`, `Quote.depositPercentBp`, `PublicQuoteView.depositPercentBp`, `InvoiceSettings.customerDepositAccountId`, `.supplierPrepaymentAccountId`, `DepositApplication` type + FSM table), `invoiceSettingsService.ts` + `invoiceSettingsSchema.ts` (two settings, `z.uuid().nullable().optional()`), `invoiceService`/`billService` SELECT + row mapping for `kind`, `deposit_for_order_id`.
- **Contract:** `export interface DepositApplication { id: string; direction: QuoteDirection; depositDocumentId: string; depositDocumentNumber: string | null; targetDocumentId: string; targetDocumentNumber: string | null; amountCents: number; applicationDate: string; status: 'POSTED' | 'VOID'; journalEntryId: string; voidJournalEntryId: string | null; createdAt: string }`.
- **Proof:** `cd server && npx tsc --noEmit && npx vitest run src/__tests__/accounting/accounts.test.ts` (find with `ls src/__tests__/accounting | grep -i account`) → passes; if it asserts the default chart count, update the expected count by +2 (deliberate).
- **Owes:** nothing extra.

### Step G3 — [Sonnet] Settlement: the third source

- **Model:** [Sonnet] — the single definition of "amount due" across the product.
- **Depends on:** G2
- **Read first:** `server/src/services/accounting/settlementSql.ts` (whole file), every caller (`grep -rn "settledCentsSubquery\|noteAppliedCentsSubquery\|settledAsOfCentsSubquery" server/src/services`).
- **Files:** `server/src/services/accounting/settlementSql.ts` (edit), `invoiceService.ts` / `billService.ts` (INVOICE_SELECT/BILL_SELECT add `deposit_applied_cents`; `amountDueCents = total − allocated − credited − depositApplied`), `types/accounting.ts` (`Invoice.depositAppliedCents`, `Bill.depositAppliedCents`).
- **Contract:**
  ```ts
  export function depositAppliedCentsSubquery(alias: string, column: SettlementColumn, amountColumn: SettlementAmountColumn = 'amount_cents'): string;
  //  (SELECT COALESCE(SUM(da.<amountColumn>), 0) FROM deposit_applications da
  //    WHERE da.org_id = <alias>.org_id AND da.<'target_invoice_id'|'target_bill_id'> = <alias>.id AND da.status = 'POSTED')
  export function depositAppliedAsOfCentsSubquery(alias: string, column: SettlementColumn, asOfParam: string, amountColumn?: SettlementAmountColumn): string;
  //  same + AND da.application_date <= <asOfParam>::date AND (da.voided_at IS NULL OR da.voided_at::date > <asOfParam>::date)
  //  — mirror exactly how noteAppliedAsOfCentsSubquery treats a void after the as-of date.
  ```
  `settledCentsSubquery` and `settledAsOfCentsSubquery` add the new term, so every existing caller (aging, party open items, statements, payment validation, bank-match candidates, FX revaluation) picks it up without edits. `column` maps `'invoice_id' → 'target_invoice_id'`, `'bill_id' → 'target_bill_id'` through a constant map.
- **Guardrails:** #1 the fragment correlates on `org_id` · #3 integer sums · #4 identifiers from constant maps only.
- **Proof:** `cd server && npx tsc --noEmit && npx vitest run src/__tests__/accounting` → every existing accounting test passes unchanged (no deposits exist, so every term is 0).
- **If it fails:** an existing test changes value → the new term is not zero-safe; fix the SQL, never the test.
- **Owes:** study note in S2.

### Step G4 — [Sonnet] `depositService`

- **Model:** [Sonnet] — GL posting, caps under lock, FSM.
- **Depends on:** G3
- **Read first:** `creditNoteService.ts` (apply flow under `FOR UPDATE`, posting through `journalService.createEntryOnClient`, voiding through `reverseEntryOnClient`), `invoiceService.resolvePostingAccounts` (fallback-by-code pattern), `orderService.ts`.
- **Files:** `server/src/services/accounting/depositService.ts` (new), `server/src/schemas/accounting/depositSchema.ts` (new), `invoiceService.ts` (`CreateInvoiceOptions.depositForOrderId?: string` → writes `kind='DEPOSIT'`, `deposit_for_order_id`, and passes the deposit account as `assertRevenueAccounts`' `allowAccountId`), `billService.ts` (`CreateBillOptions.depositForOrderId?: string`), `invoiceService.voidInvoice` / `billService.voidBill` (refuse when a POSTED application uses the document as deposit **or** target: `409 Void the deposit applications on this invoice first` / `…bill first`).
- **Contract:**
  - `depositSchema.ts`: `createDepositSchema = z.object({ percentBp: z.int().min(1).max(10_000).nullable().default(null), amountCents: z.int().min(1).max(1_000_000_000_000).nullable().default(null), documentDate: z.iso.date().nullable().default(null), dueDate: z.iso.date().nullable().default(null), vendorReference: z.string().trim().min(1).max(100).nullable().default(null) }).refine(v => (v.percentBp === null) !== (v.amountCents === null), { message: 'Give a percentage or an amount' })`; `applyDepositSchema = z.object({ depositDocumentId: z.uuid(), amountCents: z.int().min(1).max(1_000_000_000_000), applicationDate: z.iso.date() })`.
  - `resolveDepositAccountsOnClient(client, orgId, direction)`: setting id else code `2130` (SALES) / `1150` (PURCHASE); missing → `422 No customer deposit account is configured. Set one in invoice settings.` / `…supplier prepayment…`; wrong type → `422 Account <code> must be a Liability account` / `…an Asset account`.
  - `createDepositDocument(orgId, userId, direction, orderId, input): Promise<{ kind: 'INVOICE' | 'BILL'; id: string }>`: lock order; CONFIRMED (`409 Only a confirmed order can take a deposit`); `order.currency_code` must equal the org base currency (`422 Deposits are available on base-currency orders only`); amount = `input.amountCents ?? scaleCents(order.total, percentBp, 10000)`; `amount + Σ(non-VOID deposit documents for the order) ≤ order.total` (`422 Deposits on this order would exceed its total`); one line: description `Deposit on <orderNumber>` (purchase: `Prepayment on <orderNumber>`), `quantityMilli 1000`, `unitPriceCents amount`, account = deposit account, `taxRateBp 0`, `itemId null`; SALES → `createInvoiceOnClient(…, { depositForOrderId })`; PURCHASE → `createBillOnClient(…, { depositForOrderId })` with `vendorReference = input.vendorReference ?? `${orderNumber}-DEP-${n}``.
  - `applyDeposit(orgId, userId, direction, targetId, input): Promise<DepositApplication>`: one transaction; lock the target and the deposit document `FOR UPDATE` **in id order**; target must be `kind='STANDARD'` and ISSUED (invoice) / POSTED (bill) (`409 Only an issued invoice can take a deposit` / `…approved bill…`); deposit must be `kind='DEPOSIT'`, ISSUED/POSTED, same party, same currency; target must have ≥ 1 line whose `order_line_id` belongs to `deposit_for_order_id` (`422 This deposit belongs to a different order`); `available = paidOnDeposit − Σ POSTED applications from this deposit` where `paidOnDeposit` = POSTED **payment** allocations only (`allocatedCentsSubquery`); `amount ≤ available` (`422 Only <available> of this deposit has been received and not yet applied`); `amount ≤ target amount due` (`422 Amount exceeds the amount still due`); `applicationDate ≥` both documents' dates (`422 A deposit cannot be applied before either document is dated`); fiscal-period guard exactly as credit notes use; journal via `journalService.createEntryOnClient(client, orgId, userId, { entryDate: applicationDate, description: `Deposit <depositNo> applied to <targetNo>`, sourceType: 'deposit_application', sourceId: <application id>, lines })` — SALES: DR deposit account / CR receivable account (`resolvePostingAccounts`), PURCHASE: DR payable account / CR prepayment account; insert the application with `journal_entry_id`.
  - `voidDepositApplication(orgId, userId, id, entryDate: string | null)`: POSTED only (`409 This deposit application has already been voided`); `reverseEntryOnClient`, `sourceType: 'deposit_application_void'`; status VOID through the FSM table.
  - `listDepositApplications(orgId, filter: { documentId: string })` — applications where the document is deposit or target.
  - Invoice/Bill reads gain `depositApplications: DepositApplication[]` (loaded for the one-document read only; `[]` in lists).
- **Guardrails:** #1 · #3 `scaleCents` only · #5 one client · #6 correction by void+reversal · #7 the journal has two lines, one side each · #16 GL through `journalService` only.
- **Proof:** `cd server && npx tsc --noEmit && npm run lint` → clean.
- **Owes:** nothing extra.

### Step G5 — [Sonnet] Party ledgers, integrity, and quote deposits

- **Model:** [Sonnet] — subledger reconciliation (Phase 25 invariant) and content-hash change.
- **Depends on:** G4
- **Read first:** `server/src/services/accounting/partyLedgerService.ts` (how `CREDIT_NOTE`/`CREDIT_NOTE_VOID` rows are attributed — grep `CREDIT_NOTE`), `scripts/verifyIntegrity.ts` checks that reconcile AR/AP, `quoteService.canonicalContent` and `createQuote`/`updateQuote`/`reviseQuote`, `publicQuoteService.getPublicQuote`.
- **Files:** `partyLedgerService.ts` (add `DEPOSIT_APPLICATION` / `DEPOSIT_APPLICATION_VOID` row kinds attributed through `deposit_applications.journal_entry_id` / `void_journal_entry_id` to the **target** document's party), the party-ledger row-kind union in `types/accounting.ts`, `quoteService.ts` (`depositPercentBp` in create/update input and schema `z.int().min(1).max(10_000).nullable().default(null)`, insert/update/revise copy, `canonicalContent` gains `depositPercentBp` **after** `paymentTerms`), `publicQuoteService.ts` (view field), `orderService.createOrderFromQuoteOnClient` (when `quote.depositPercentBp !== null`, call `createDepositDocument` on the same client with `percentBp`), `quoteService.convertQuote` (`target: 'INVOICE'` with a deposit → `422 This quote asks for a deposit — convert it to an order`), `quotePdfRenderer` input (`depositPercentBp` from the quote).
- **Contract:** the deposit document created at quote→order conversion is DRAFT; the order detail shows it. The content-hash change applies to quotes sent after this step; already-sent quotes keep their stored hash (never recomputed).
- **Proof:** `cd server && npx tsc --noEmit && npx vitest run src/__tests__/accounting/partyLedger*.test.ts src/__tests__/integrity.test.ts src/__tests__/accounting/quotes.test.ts src/__tests__/accounting/quotePublicLink.test.ts` → pass unchanged.
- **Owes:** nothing extra.

### Step G6 — [Haiku] Deposit routes

- **Model:** [Haiku] — adapters; the gating is listed.
- **Depends on:** G5
- **Read first:** `orderController.ts`, `invoiceController.ts`, `billController.ts`, `invoiceRoutes.ts`, `billRoutes.ts`.
- **Files:** `orderController.ts` + `orderRoutes.ts` (`POST /:id/deposit`, permission `K.convert`, body `createDepositSchema`, `201 { success, document }`), `invoiceController.ts` + `invoiceRoutes.ts` (`POST /:id/apply-deposit`, `invoices.issue`, body `applyDepositSchema`, `201 { success, application }`), `billController.ts` + `billRoutes.ts` (`POST /:id/apply-prepayment`, `bills.approve`, same body, `201`), new `controllers/accounting/depositController.ts` + `routes/accounting/depositRoutes.ts` mounted at `/deposit-applications` with two routes: `POST /sales/:id/void` (`invoices.void`) and `POST /purchase/:id/void` (`bills.void`), each calling `voidDepositApplication` with the matching direction (the service 404s a row of the other direction), body `{ entryDate: iso date | null }`, `200 { success, application }`.
- **Proof:** `cd server && npx tsc --noEmit && npm run lint && npx vitest run src/__tests__/platform/routePermissions.test.ts` → pass.
- **Owes:** api.md in S3.

### Step G7 — [Sonnet] Deposit tests

- **Model:** [Sonnet] — GL and subledger invariants against real PostgreSQL.
- **Depends on:** G6
- **Skill:** isolation-test
- **Read first:** `server/src/__tests__/accounting/creditNotes.test.ts`, the Phase 26 settlement reconciliation test (`grep -rln "noteSettlement" server/src/__tests__`).
- **Files:** `server/src/__tests__/accounting/depositConstraints.test.ts` (new), `server/src/__tests__/accounting/deposits.test.ts` (new); add `deposit_applications` to `resetTables()`.
- **Contract — constraint cases:** `shape CHECK per direction`; `base_amount_cents must equal amount_cents`; `a POSTED application cannot be edited or deleted; POSTED→VOID changes only the void columns`; `a DEPOSIT invoice needs deposit_for_order_id`.
- **Contract — API cases** (base currency INR; order total 1,000.00):
  1. `30% deposit on a confirmed order → DRAFT DEPOSIT invoice of 300.00 on 2130, tax 0`
  2. `issuing it posts DR 1120 300.00 / CR 2130 300.00`
  3. `a second deposit pushing the total over the order → 422`
  4. `applying before any payment → 422 Only 0.00 of this deposit has been received…`
  5. `after a 300.00 payment, applying 300.00 to the final invoice posts DR 2130 / CR 1120 and the final invoice's amountDue drops by 300.00`
  6. `2130 balance returns to 0.00; AR control balance = Σ party open items = aging total` (the Phase 25 invariant)
  7. `the customer statement (Outstanding, as at today) shows the final invoice net of the deposit`
  8. `voiding the application reverses the journal and restores amountDue`
  9. `the deposit invoice cannot be voided while an application is POSTED → 409`
  10. `applying to an invoice not linked to the order → 422 This deposit belongs to a different order`
  11. `a foreign-currency order → 422 Deposits are available on base-currency orders only`
  12. `purchase: prepayment bill on 1150, applied to the final bill → DR 2100 / CR 1150`
  13. `a quote with depositPercentBp 2500 converted to ORDER creates the DRAFT deposit invoice of 25%; converting it to INVOICE → 422`
  14. `cross-tenant: org B applying org A's deposit → 404; org B cannot void org A's application → 404`
  15. `npm run verify:integrity equivalent: the integrity service's reconciliation checks all pass after the full flow` (call the integrity service function the `integrity.test.ts` file calls)
- **Proof:** `cd server && npx vitest run src/__tests__/accounting/depositConstraints.test.ts src/__tests__/accounting/deposits.test.ts` → `4 passed` and `15 passed`.
- **If it fails:** a reconciliation case fails → stop and report; never adjust balances in the test.
- **Owes:** nothing extra.

### Step G8 — [Haiku] Client: deposit settings, order deposit, apply dialog, quote field

- **Model:** [Haiku] — fields and labels listed; API shapes fixed by G4/G6.
- **Depends on:** G6, F10
- **Read first:** `NoteDetailPage.tsx` `ApplyDialog` (the dialog to copy), `OrderDetailPage.tsx`, `InvoiceDetailPage.tsx`, `BillDetailPage.tsx`, `QuoteFormPage.tsx`, `QuoteDocument.tsx`, `FinancialSettingsPage.tsx` (an `AccountSelect` field).
- **Files:** `fetchServices.ts` (types + `createOrderDeposit(direction, orderId, body)`, `applyDeposit(invoiceId, body)`, `applyPrepayment(billId, body)`, `voidDepositApplication(direction, id)`; `Invoice`/`Bill` gain `kind`, `depositForOrderId`, `depositAppliedCents`, `depositApplications`; `Quote`/`PublicQuoteView`/`QuoteInput` gain `depositPercentBp`), the pages above, `InvoiceSettingsPage.tsx` (two account selects labelled `Customer deposits account` (Liability accounts) and `Supplier prepayments account` (Asset accounts)), client fixtures (add the new fields with `kind: 'STANDARD'`, `depositForOrderId: null`, `depositAppliedCents: 0`, `depositApplications: []`).
- **Contract:** Order detail (CONFIRMED, base currency): button `Request deposit` (purchase: `Record prepayment`) → dialog with `Percentage` or `Amount`, document date, due date, (purchase) `Vendor’s invoice no.` → navigate to the new document. Invoice detail (ISSUED, STANDARD): button `Apply deposit` → dialog listing the customer's ISSUED DEPOSIT invoices (fetch with `listInvoices({ customerId })` filtered client-side by `kind === 'DEPOSIT'`), amount, date. Bill detail mirrors with `Apply prepayment`. A `Deposits applied` table lists applications with a `Void` button. A DEPOSIT document shows the badge text `Deposit`. Quote form: input `Deposit on acceptance (%)` (blank = none); `QuoteDocument` and the public page show `A deposit of <pct>% (<amount>) is due on acceptance.` when set.
- **Proof:** `cd client && npx tsc --noEmit -p . && npm run lint && npx vitest run` → all pass.
- **Owes:** nothing.

### Step G9 — [Haiku] Client deposit tests

- **Model:** [Haiku]
- **Depends on:** G8
- **Files:** `client/src/__tests__/deposits.test.tsx` (new).
- **Contract — cases:** `an order requests a 30% deposit (body percentBp 3000)`; `an issued invoice applies a deposit (body depositDocumentId, amountCents)`; `the quote form sends depositPercentBp 2500 for "25"`; `QuoteDocument shows the deposit sentence`.
- **Proof:** `cd client && npx vitest run src/__tests__/deposits.test.tsx` → `4 passed`.
- **Owes:** nothing.

---

## Spine — finish

### Step S1 — [Sonnet] `guardrail-review` over the whole Phase 42 diff

- **Model:** [Sonnet] · **Depends on:** every slice step · **Skill:** guardrail-review
- **Proof:** the review reports no unresolved finding; every finding it raises is fixed and the affected test file re-run green.

### Step S2 — [Sonnet] Study notes

- **Model:** [Sonnet] · **Depends on:** S1 · **Skill:** study-note
- **Files:** new `study/architecture/orders-partial-billing-and-deposits.md` (derived fulfilment quantity vs a stored counter; deferred constraint trigger as the over-billing cap; IFRS 15 contract liability for customer deposits and prepayments as an asset; a third settlement source added behind one SQL definition; why base-currency-only; 4–8 Q&As); extend `study/architecture/quotes-acceptance-evidence-and-revisions.md` (verified-email codes: hashing a 6-digit code with a per-link salt, attempt counters that must survive a failed request, rate limits; org-timezone "today" with `Intl.DateTimeFormat.formatToParts`; server-side PDF generation and why `pdfkit` over headless Chromium); extend `study/security-auth/user-authored-templates-and-bearer-links.md` (a new placeholder surface). Update `study/README.md` index + coverage tracker.
- **Proof:** `ls study/architecture/orders-partial-billing-and-deposits.md` exists; `grep -c "orders-partial-billing-and-deposits" study/README.md` ≥ 1.

### Step S3 — [Sonnet] `docs-sync`

- **Model:** [Sonnet] · **Depends on:** S2 · **Skill:** docs-sync
- **Files:** `docs/api.md` (invoice settings fields, quote-email-templates, email-preview, verify-email, PDF routes, orders, deposits, `templateId`/`target`/`code` bodies, new webhook events, timezone validation), `docs/schema.md` (Phase 42 section: migrations 090–093), `docs/accounting.md` (Phase 42 section with the deposit journal entries and the order lifecycle; update the Phase 41 "Not built" bullet to point at Phase 42 and state QES remains unbuilt), `docs/roadmap.md` (`## Phase 42, as delivered` with test counts from S4), `CLAUDE.md` (one Phase 42 bullet).
- **Proof:** the docs-sync skill reports no drift between `docs/api.md` and the mounted routes, and between `docs/schema.md` and migrations 090–093.

### Step S4 — [Sonnet] Full suites

- **Model:** [Sonnet] · **Depends on:** S3
- **Proof:** `cd server && npx tsc --noEmit && npm run lint && npx vitest run` → 0 failed (record the passed/skipped counts into roadmap.md); `cd client && npx tsc --noEmit -p . && npm run lint && npx vitest run` → 0 failed (record count).

### Step S5 — [Haiku] Close this plan

- **Model:** [Haiku] · **Depends on:** S4
- **Do:** set `**Status:** done` at the top of this file and delete it (`git rm plans/phase-42-quote-follow-ups.md` is the user's call at commit time — the executor only edits the status line and reports).
- **Proof:** the first lines of this file read `**Status:** done`.

---

## Dispatch manifest

| Batch | Step | Tier | Title | Depends on | Blocks | Status |
|---|---|---|---|---|---|---|
| A | 0 | Sonnet | Confirm Phase 41 committed | — | all | todo |
| B | A1 | Haiku | Expose quote settings | 0 | A2,A3 | todo |
| C | A2 | Sonnet | Collision mapping + settings tests | A1 | — | todo |
| D | A3 | Haiku | Client quote settings section | A1 | A4 | todo |
| D | A4 | Haiku | Client settings test | A3 | — | todo |
| D | B1 | Haiku | `todayInZone` + unit tests | 0 | B2 | todo |
| E | B2 | Sonnet | Org date in quote rules | B1 | B3 | todo |
| E | B3 | Sonnet | Timezone integration tests | B2 | — | todo |
| E | C1 | Sonnet | Migration 090 | 0 | C2,D1 | todo |
| E | C2 | Sonnet | Placeholder surface QUOTE | C1 | C3 | todo |
| E | C3 | Sonnet | Quote template service + send rendering | C2 | C4 | todo |
| F | C4 | Haiku | Template/preview routes | C3 | C5,C6 | todo |
| G | C5 | Sonnet | Template server tests | C4 | — | todo |
| G | D1 | Sonnet | Migration 091 | C1 | D2 | todo |
| G | D2 | Sonnet | Code request + verification | D1 | D3 | todo |
| H | C6 | Haiku | Client template page + picker | C4 | C7 | todo |
| H | C7 | Haiku | Client template tests | C6 | — | todo |
| H | D3 | Haiku | verify-email route | D2 | D4,D5 | todo |
| I | D4 | Sonnet | Verification tests | D3 | — | todo |
| J | D5 | Haiku | Client code entry + toggle | D3 | D6 | todo |
| J | D6 | Haiku | Client code test | D5 | — | todo |
| K | E1 | Sonnet | Add pdfkit | 0 | E2 | todo |
| K | E2 | Sonnet | PDF renderer + unit tests | E1 | E3 | todo |
| K | E3 | Sonnet | PDF routes + API tests | E2 | E4 | todo |
| L | E4 | Haiku | Client PDF buttons | E3 | — | todo |
| M | F1 | Sonnet | Migration 092 | D1 | F2 | todo |
| N | F2 | Haiku | Order types/FSM/permissions/counters | F1 | F3 | todo |
| O | F3 | Sonnet | `orderService` lifecycle | F2 | F4 | todo |
| O | F4 | Sonnet | Line `orderLineId` in invoices/bills | F3 | F5 | todo |
| O | F5 | Sonnet | Convert order; quote → order | F4 | F6 | todo |
| P | F6 | Haiku | Order controller/routes/mounts | F5 | F7,F9 | todo |
| Q | F7 | Sonnet | Order constraint tests | F6 | F8 | todo |
| Q | F8 | Sonnet | Order API tests | F7 | — | todo |
| R | F9 | Haiku | Client order API layer | F6 | F10,F11 | todo |
| R | F10 | Haiku | Client order pages | F9 | F12,G8 | todo |
| R | F11 | Haiku | Forms keep order link | F9 | F12 | todo |
| R | F12 | Haiku | Client order tests | F10,F11 | — | todo |
| S | G1 | Sonnet | Migration 093 | F1 | G2 | todo |
| T | G2 | Haiku | Deposit types/chart/settings | G1 | G3 | todo |
| U | G3 | Sonnet | Settlement third source | G2 | G4 | todo |
| U | G4 | Sonnet | `depositService` | G3 | G5 | todo |
| U | G5 | Sonnet | Party ledgers + quote deposits | G4 | G6 | todo |
| V | G6 | Haiku | Deposit routes | G5 | G7,G8 | todo |
| W | G7 | Sonnet | Deposit tests | G6 | — | todo |
| X | G8 | Haiku | Client deposit UI | G6,F10 | G9 | todo |
| X | G9 | Haiku | Client deposit tests | G8 | — | todo |
| Y | S1 | Sonnet | guardrail-review | all | S2 | todo |
| Y | S2 | Sonnet | Study notes | S1 | S3 | todo |
| Y | S3 | Sonnet | docs-sync | S2 | S4 | todo |
| Y | S4 | Sonnet | Full suites | S3 | S5 | todo |
| Z | S5 | Haiku | Close plan | S4 | — | todo |

**Batching:** each lettered batch is one dispatch. Batches D, H, J, R and X are the large Haiku runs; E, O, U and Y are the long Sonnet runs. **Do not batch across** F3–F5 (one invariant: billed quantity ≤ ordered) or G3–G5 (one invariant: settlement + reconciliation) with any other tier — they stay together under Sonnet. Migrations C1 → D1 → F1 → G1 must land in that numeric order even though slices C–G are otherwise independent of A/B/E.

**Parallelism:** Slices A, B, E are independent of each other and of C/D/F/G (E1 needs only Step 0). Within the migration chain, C → D → F → G is strictly sequential.

## Risks & open questions

- **Phase 41 uncommitted** — the plan cannot start until the user commits it (Step 0).
- **`pdfkit` version** — unknown until installed; Step E1 records the resolved version. If the user rejects a new dependency, drop Slice E entirely (no substitute library).
- **Non-Latin text in PDFs** — built-in Helvetica is WinAnsi; names in Devanagari, CJK, etc. will not render. Embedding a Unicode font needs a font file in the repo — not in this plan.
- **GST/VAT on advances** — deposits carry 0% tax. Jurisdictions that tax advances (e.g. India GST on advances for services) need a tax line on the deposit invoice; out of scope and must be flagged to the user before Slice G ships to such an org.
- **Foreign-currency deposits** — refused (422). Supporting them needs FX gain/loss on application.
- **Refund of an unapplied deposit** — impossible until cash refunds exist (not built anywhere); a cancelled order with a paid deposit leaves a 2130 balance to be cleared by a manual journal — and 2130 is not a control account, so that journal is allowed. Documented in accounting.md (Step S3).
- **QES** — not buildable without a trust-service provider; verified-email codes are the substitute.
- **Timezone scope** — only quotes move to the org's timezone; invoices, bills, statements stay UTC. A product-wide move is its own phase.
- **Test counts in permission/chart tests** — Steps F2 and G2 may need an expected count bumped; that is the only test edit pre-authorised.
- **Unknown:** whether `src/__tests__/accounting` has a dedicated invoice-settings test and a default-chart count test — Steps A1/G2 tell the executor how to find them; if absent, the proof is `npx tsc --noEmit` plus the full accounting folder run.

## Definition of done

- Every manifest row `done`.
- Server: `npx tsc --noEmit`, `npm run lint`, `npx vitest run` clean, including `quoteSettings`, `quoteTimezone`, `orgDate`, `quoteEmailTemplates`, `quoteSignerVerification`, `quotePdf`, `orderConstraints`, `orders`, `depositConstraints`, `deposits` test files.
- Client: typecheck, lint, tests clean, including `quoteEmailTemplates`, `orders`, `deposits` test files and the new cases in `quotes.test.tsx`.
- Migrations 090–093 apply and replay (`migrations.test.ts`).
- `guardrail-review` clean; study notes filed and indexed; `docs-sync` reports no drift; roadmap has `Phase 42, as delivered` with counts; CLAUDE.md has the Phase 42 bullet.
- This plan file's status line reads `done`.

## Escalations

_(Record any Haiku → Sonnet escalation here: step, failure, outcome.)_
