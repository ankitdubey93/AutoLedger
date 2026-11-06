# Phase 48 — Get invoices out and get paid

Date: 2026-11-06
Status: delivered. Outcome recorded in `docs/roadmap.md` under Phase 48, as delivered.

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

## 1. Starting state (verified 2026-11-06)

**Exists and is reused:**
- `services/mail/emailOutboxService.ts`: `enqueueEmailOnClient`, `drainEmailOutbox({transport, batchSize})`. The drain claims rows without `org_id`. There is **no attachment support** anywhere: not in the table, `OutgoingEmail` (`types/email.ts`) or `services/mail/transports.ts`.
- `services/mail/templates.ts`: `renderEmail(template, data, link)`, a switch over `EMAIL_TEMPLATES`. The outbox CHECK `ck_email_outbox_template` was last replaced by migration `091`.
- `services/accounting/quotePdfRenderer.ts`: `renderQuotePdf`, with private `money`, `quantity`, `rate`. `quoteService.ts` holds the private `readLogoBytes` and the pattern `buildQuotePdf`. `quoteController.ts` lines 175–184 hold the PDF response headers.
- `services/accounting/statementEmailService.ts`: the send pattern (hashed token, `randomUrlToken`/`sha256Hex` from `utils/pkce.ts`, one transaction for send row + outbox row) and `formatMoney`.
- `services/accounting/statementLinkService.ts`: `resolveLiveSend`. `publicStatementService.ts`: `addressLines`, `openPublicLogo`.
- `services/accounting/onlinePaymentService.ts`: `startPayment`, `settleIntent`, `confirmFromLink`, `handleWebhook`. Stripe is injected through `deps` (`StripeDeps`); the tests use a fake. **`online_payments.statement_send_id` is `NOT NULL`** and `settleIntent` reads the acting user from `statement_sends.sent_by`, so an invoice link cannot use it without a migration.
- `services/accounting/recurringService.ts`: `generateOccurrence` issues when `mode === 'POST'`, on the worker's transaction client, with `userId = schedule.created_by`.
- `services/historyService.ts`: `recordEventOnClient(q, orgId, {entityType, entityId, action, summary, details?})`. `INVOICE` is already an entity type.
- `queue/worker.ts`, `types/jobs.ts`, `queue/handlers/quoteExpirySweepHandler.ts`: the sweep pattern.
- Client: `Pages/public/PublicStatementPage.tsx`, `StripePayPanel.tsx`, `Pages/sales/InvoiceDetailPage.tsx` (Print button at line ~336), `InvoicesPage.tsx`, `components/MakeRecurringDialog.tsx`, `Pages/settings/InvoiceSettingsPage.tsx`, and all API calls in `services/fetchServices.ts`.

**Does not exist:** an invoice PDF, invoice emails, a public invoice page, reminders, recurring auto-send. Also, `invoices` has a row-level immutability trigger once issued, so **sent/viewed state cannot be columns on `invoices`**; it is derived from a new table.

Last migration on disk: `104`. Next number: `105`.

## 2. Gate

No gated prerequisites: background jobs (Phase 7), outbox (38b), statements and Stripe (39), and PDFs (42) are all built. There is no roadmap debt assigned to this phase. Unit of work: accounting module, plus a generic attachment capability in the platform mail service.

## 3. Decisions made (do not reopen)

| Topic | Decision |
|---|---|
| Module tag | Migration file `105_ledger-core_invoice_delivery.sql`; platform columns on `email_outbox` go in the same file because they ship together |
| Attachments in the outbox | Store a **reference**, not bytes: `email_outbox.attachment_kind`, `attachment_ref_id`. The PDF is rendered at drain time. An issued invoice is immutable, so re-rendering on a retry gives the same document; the amount-due line shows the position when sent |
| Mail → accounting dependency | Platform mail must not import accounting. `drainEmailOutbox` takes an injected `resolveAttachment`; `emailDrainHandler` supplies it. A row with an attachment and no resolver fails **permanently**: an invoice email never goes out without its PDF |
| Send row | New `invoice_sends` table, one row per email; token stored only as a SHA-256 hash |
| `sent_by` | `NOT NULL`. Manual: the sender. Reminder: `invoices.created_by`. Recurring: `schedule.created_by`. This is also the user recorded on a card receipt. `send_kind` says which |
| Sent/viewed display | Derived: `lastSentAt` ignores sends whose outbox row is `FAILED`. A failed email must not show as sent |
| Link lifetime | `INVOICE_LINK_TTL_MS = 60 days`, same as statements. Revocable |
| Card payment | Always the invoice's whole outstanding amount, priced by the server. The browser sends no amount and no invoice id |
| `online_payments` | `statement_send_id` becomes nullable, new nullable `invoice_send_id`, CHECK exactly one |
| Voided or paid invoice on the public page | The page still opens and shows the status; payment is refused `422` |
| PDF layout | One layout (Helvetica, WinAnsi, same limit as quotes). It honours `showLogo`, `showOrgAddress`, `showPaymentTerms`, `showDueDate`, `bankDetails`. It does **not** reproduce the classic/modern/compact browser layouts |
| Credit notes | PDF download only; no email or public page in this phase |
| Email wording | Built-in wording plus an optional sender message. No editable invoice email templates in this phase |
| Reminder settings | Columns on `ledger_invoice_settings`: `reminders_enabled` default `false`, `reminder_offsets_days INTEGER[]` default `{7,14,30}` (days after due; negative = before due) |
| Reminder eligibility | `ISSUED`, amount due > 0, customer email present, and **at least one earlier non-failed send**. The last rule stops turning reminders on from emailing every old or imported invoice |
| Catch-up | One reminder per invoice per tick, at the largest passed offset; never send smaller missed ones |
| Exactly-once reminders | `UNIQUE (org_id, invoice_id, offset_days)` on `invoice_reminders`. `INSERT … ON CONFLICT DO NOTHING RETURNING`, and enqueue only if a row returned, same transaction |
| Dates | UTC `todayIso()`, like every document except quotes |
| Recurring | `recurring_schedules.auto_send` default `false`; valid only for `kind = 'INVOICE'` and `mode = 'POST'` (`422` otherwise). A customer with no email: the invoice still issues, no send, history event `SEND_SKIPPED`. Issuing must never fail because of email |
| Permissions | New `invoices.send`, tier `A`, requires `['invoices.view']`. PDFs: `invoices.view` / `credit_notes.view`. Reminder settings: existing `settings.manage` |
| Dependencies | None added. `pdfkit` and `@stripe/*` are already installed |

## 4. Execution rules

> **If a proof command fails twice on the same step, stop and report. Do not improvise around it.**

| Symptom | Forbidden | Correct |
|---|---|---|
| Migration checksum error | Editing the applied migration | A new sequential migration (rule 13) |
| Test fails | Weakening or deleting the assertion | Fix the code; the test is the spec |
| Type error | `as any`, `@ts-ignore`, loosening `tsconfig` | Fix the type |
| Query returns no rows | Dropping the `org_id` predicate | Fix the fixture or the parameters (rule 1) |
| Money assertion fails | Epsilon comparison, floats, rounding | Integer cents equality (rule 3) |
| Need a helper library | `npm install` anything | Stop and ask (rule 14) |
| Wish to mark an invoice as sent | Adding a column to or updating `invoices` | Derive from `invoice_sends` (rule 6) |
| Column missing at runtime | Adding it ad hoc in the service | New migration, then update this plan |
| A `[Haiku]` step's proof fails twice | Retrying in a loop, trimming the step | Escalate the step unchanged to Sonnet, and note it here |
| The step needs a decision the plan never made | Deciding it | Stop and report: the plan is the defect |

**Anything this plan did not anticipate is a stop-and-report, not a judgment call.**

All commands run from the repo root. Direct SQL: `docker exec autodb_postgres psql -U autodb_user -d autodb -c '…'`. All server imports carry `.js`.

## 5. Name registry — use exactly these, do not rename

| Kind | Name |
|---|---|
| Migration | `server/src/db/migrations/105_ledger-core_invoice_delivery.sql` |
| New tables | `invoice_sends`, `invoice_reminders` |
| New columns | `email_outbox.attachment_kind`, `email_outbox.attachment_ref_id`; `online_payments.invoice_send_id`; `ledger_invoice_settings.reminders_enabled`, `.reminder_offsets_days`; `recurring_schedules.auto_send` |
| Email templates | `invoice_sent`, `invoice_reminder` |
| Attachment kind | `INVOICE_PDF` |
| Constants (`config/constants.ts`) | `INVOICE_LINK_TTL_MS`, `INVOICE_REMINDER_SWEEP_INTERVAL_MS` (1 hour), `INVOICE_REMINDER_BATCH` (500) |
| Job | `invoice-reminder-sweep`; handler `queue/handlers/invoiceReminderSweepHandler.ts` → `handleInvoiceReminderSweep` |
| Renderer | `services/accounting/invoicePdfRenderer.ts` → `renderSalesDocumentPdf`, `SalesDocumentPdfInput` |
| PDF service | `services/accounting/invoicePdfService.ts` → `getInvoicePdf`, `getCreditNotePdf`, `buildInvoicePdf`, `resolveInvoiceAttachment` |
| Send service | `services/accounting/invoiceSendService.ts` → `sendInvoice`, `sendInvoiceOnClient`, `listInvoiceSends`, `revokeInvoiceSend` |
| Link service | `services/accounting/invoiceLinkService.ts` → `resolveLiveInvoiceSend`, `LiveInvoiceSend` |
| Public service | `services/accounting/publicInvoiceService.ts` → `getPublicInvoice`, `openPublicInvoiceLogo`, `getPublicInvoicePdf`, `PublicInvoiceView` |
| Reminder service | `services/accounting/invoiceReminderService.ts` → `listOrgsWithReminders`, `sendDueRemindersForOrg` |
| Pure util | `server/src/utils/invoiceReminders.ts` → `reminderOffsetDue` |
| Payment exports | `onlinePaymentService.ts` → `onlineCardAvailableOnClient`, `startInvoicePayment`, `confirmFromInvoiceLink` |
| Types (`types/accounting.ts`) | `InvoiceSend`, `InvoiceSendKind`, `INVOICE_SEND_KINDS` |
| Controllers | `controllers/accounting/invoiceSendController.ts`, `controllers/accounting/publicInvoiceController.ts` |
| Schema | `schemas/accounting/invoiceSendSchema.ts` → `sendInvoiceSchema` |
| Public route file | `routes/accounting/publicInvoiceRoutes.ts`, mounted `/public/invoices` |
| Client page | `client/src/Pages/public/PublicInvoicePage.tsx`, route `/invoice/:token` |
| Client dialog | `client/src/Pages/sales/SendInvoiceDialog.tsx` |
| Test files | `server/src/__tests__/accounting/invoicePdf.test.ts`, `invoiceSend.test.ts`, `publicInvoice.test.ts`, `invoiceReminders.test.ts`, `recurringAutoSend.test.ts`; `server/src/__tests__/platform/emailAttachments.test.ts`; `client/src/__tests__/invoiceDelivery.test.tsx` |

## 6. Slices

- **A** PDF: a staff user downloads an invoice or credit note as a PDF.
- **B** Mail attachments: the outbox can send a PDF through all three transports.
- **C** Send: a staff user emails an issued invoice with its PDF and a link, and sees sent status.
- **D** Public page and payment: the customer opens the link and pays by card, settling exactly once.
- **E** Reminders: an overdue, already-sent invoice triggers exactly one reminder.
- **F** Recurring auto-send: a generated invoice is emailed automatically.
- **G** Client UI, then the closing spine.

The migration comes first because slices C–F share one file.

---

### Step 1 — [Sonnet] Migration 105

- **Model:** [Sonnet] — migrations are unrepairable in place (rule 13)
- **Depends on:** —
- **Skill:** new-migration
- **Read first:** `085_ledger-core_statement_email.sql`, `086_ledger-core_online_payments.sql`, `091_ledger-core_quote_signer_verification.sql` (the full current template IN list, lines ~49+)
- **Files:** `server/src/db/migrations/105_ledger-core_invoice_delivery.sql` (new)
- **Contract:**
  ```sql
  -- email_outbox
  ADD COLUMN IF NOT EXISTS attachment_kind TEXT NULL,
  ADD COLUMN IF NOT EXISTS attachment_ref_id UUID NULL;
  -- ck_email_outbox_attachment (DROP IF EXISTS, then ADD):
  CHECK ((attachment_kind IS NULL AND attachment_ref_id IS NULL)
      OR (attachment_kind IN ('INVOICE_PDF') AND attachment_ref_id IS NOT NULL AND org_id IS NOT NULL))
  -- ck_email_outbox_template: DROP IF EXISTS, ADD with 091's full list + 'invoice_sent', 'invoice_reminder'

  CREATE TABLE IF NOT EXISTS invoice_sends (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    invoice_id UUID NOT NULL,
    send_kind TEXT NOT NULL CHECK (send_kind IN ('MANUAL', 'REMINDER', 'RECURRING')),
    to_email TEXT NOT NULL CHECK (to_email = LOWER(to_email) AND length(to_email) BETWEEN 3 AND 254),
    email_id UUID NULL REFERENCES email_outbox(id) ON DELETE SET NULL,
    sent_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ NULL,
    last_viewed_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ux_invoice_sends_token_hash UNIQUE (token_hash),
    CONSTRAINT ux_invoice_sends_org_id_id UNIQUE (org_id, id),
    CONSTRAINT ck_invoice_sends_expiry CHECK (expires_at > created_at),
    CONSTRAINT fk_invoice_sends_invoice FOREIGN KEY (org_id, invoice_id)
      REFERENCES invoices (org_id, id) ON DELETE RESTRICT
  );
  -- indexes: idx_invoice_sends_org_invoice (org_id, invoice_id, created_at DESC),
  --          idx_invoice_sends_email (email_id), idx_invoice_sends_sent_by (sent_by)
  -- Not audited: the row carries the token hash (same reasoning as statement_sends).

  CREATE TABLE IF NOT EXISTS invoice_reminders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    invoice_id UUID NOT NULL,
    offset_days INTEGER NOT NULL CHECK (offset_days BETWEEN -60 AND 365),
    invoice_send_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ux_invoice_reminders_offset UNIQUE (org_id, invoice_id, offset_days),
    CONSTRAINT fk_invoice_reminders_invoice FOREIGN KEY (org_id, invoice_id)
      REFERENCES invoices (org_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_invoice_reminders_send FOREIGN KEY (org_id, invoice_send_id)
      REFERENCES invoice_sends (org_id, id) ON DELETE RESTRICT
  );
  -- index: idx_invoice_reminders_send (org_id, invoice_send_id)

  -- online_payments
  ALTER COLUMN statement_send_id DROP NOT NULL;
  ADD COLUMN IF NOT EXISTS invoice_send_id UUID NULL;
  -- fk_online_payments_invoice_send (guarded by pg_constraint check):
  --   FOREIGN KEY (org_id, invoice_send_id) REFERENCES invoice_sends (org_id, id) ON DELETE RESTRICT
  -- ck_online_payments_source: CHECK ((statement_send_id IS NULL) <> (invoice_send_id IS NULL))
  -- index idx_online_payments_invoice_send (org_id, invoice_send_id)

  -- ledger_invoice_settings
  ADD COLUMN IF NOT EXISTS reminders_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reminder_offsets_days INTEGER[] NOT NULL DEFAULT '{7,14,30}';

  -- recurring_schedules
  ADD COLUMN IF NOT EXISTS auto_send BOOLEAN NOT NULL DEFAULT false;
  -- ck_recurring_auto_send: CHECK (NOT auto_send OR (kind = 'INVOICE' AND mode = 'POST'))
  ```
  Every `ADD CONSTRAINT` is guarded so the file replays. Confirm `invoices` has `UNIQUE (org_id, id)`; `fk_online_payment_invoices_invoice` in `086` already relies on it.
- **Guardrails:** #8 explicit `ON DELETE` · #13 idempotent, additive · #3 no money columns here
- **Proof:** `cd server && npm run migrate && npm run migrate` exits 0 twice; `cd server && npx vitest run src/__tests__/migrations.test.ts` passes (locate with `find server/src/__tests__ -name 'migrations.test.ts'` and use that path).
- **If it fails:** a replay failure means a missing guard. Fix the unapplied file only if it never applied; otherwise a new migration.
- **Owes:** `docs/schema.md` block (Step 26 pays it)

---

## Slice A — PDF

### Step 2 — [Sonnet] Renderer

- **Model:** [Sonnet] — pdfkit layout has no literal contract to transcribe
- **Depends on:** —
- **Skill:** none
- **Read first:** `services/accounting/quotePdfRenderer.ts`, `__tests__/quotePdf.test.ts`
- **Files:** `services/accounting/quotePdfRenderer.ts` (edit: add `export` to `money`, `quantity`, `rate`); `services/accounting/invoicePdfRenderer.ts` (new); `__tests__/accounting/invoicePdf.test.ts` (new)
- **Contract:**
  ```ts
  export interface SalesDocumentPdfInput {
    kind: 'INVOICE' | 'CREDIT_NOTE';
    merchantName: string; merchantAddressLines: string[]; logo: Buffer | null;
    number: string | null;           // null renders "DRAFT"
    status: string;                  // 'VOID' prints "VOID" under the heading
    partyName: string; partyAddress: string | null; partyTaxNumber: string | null;
    issueDate: string; dueDate: string | null;
    relatedNumber: string | null;    // credit note: "Against invoice INV-…"
    currencyCode: string; paymentTerms: string | null;
    notes: string | null; bankDetails: string | null;
    lines: { description: string; quantityMilli: number; unitPriceCents: number; taxRateBp: number; netCents: number }[];
    subtotalCents: number; taxCents: number; totalCents: number;
    paidCents: number | null; amountDueCents: number | null; // null hides both rows
  }
  export function renderSalesDocumentPdf(input: SalesDocumentPdfInput, options?: { compress?: boolean }): Promise<Buffer>;
  ```
  Headings `INVOICE` / `CREDIT NOTE`. Layout copies `renderQuotePdf`; the totals block adds `Paid` and `Amount due` when not null; section `PAYMENT DETAILS` for `bankDetails`, section `NOTES` for `notes`.
- **Tests (`compress: false`, assert on bytes as `quotePdf.test.ts` does):** starts `%PDF-`; 100-line invoice paginates without throwing; `number: null` contains `DRAFT`; `status: 'VOID'` contains `VOID`; `kind: 'CREDIT_NOTE'` contains `CREDIT NOTE`; `amountDueCents: 12345` contains `123.45`; corrupt logo bytes do not throw.
- **Guardrails:** #3 integer cents only, no division except the shared `money`
- **Proof:** `cd server && npx vitest run src/__tests__/accounting/invoicePdf.test.ts src/__tests__/quotePdf.test.ts` passes; `npm run typecheck` exits 0.
- **If it fails:** fix the renderer; do not relax byte assertions.
- **Owes:** study note in Step 25

### Step 3 — [Sonnet] PDF service, routes, isolation

- **Model:** [Sonnet] — tenant-scoped reads and an isolation test
- **Depends on:** 2
- **Skill:** new-module, isolation-test
- **Read first:** `quoteService.ts` lines 1250–1316, `quoteController.ts` lines 174–184, `routes/accounting/invoiceRoutes.ts`, `routes/accounting/creditNoteRoutes.ts`
- **Files:** `services/accounting/quoteService.ts` (edit: `export` `readLogoBytes`); `services/accounting/invoicePdfService.ts` (new); `controllers/accounting/invoiceController.ts`, `creditNoteController.ts` (edit: add `pdf`); `routes/accounting/invoiceRoutes.ts`, `creditNoteRoutes.ts` (edit); test file from Step 2 (edit)
- **Contract:**
  ```ts
  export async function buildInvoicePdf(orgId: string, invoice: Invoice): Promise<{ filename: string; pdf: Buffer }>;
  export async function getInvoicePdf(orgId: string, id: string): Promise<{ filename: string; pdf: Buffer }>;
  export async function getCreditNotePdf(orgId: string, id: string): Promise<{ filename: string; pdf: Buffer }>;
  /** Passed to drainEmailOutbox by the worker. */
  export async function resolveInvoiceAttachment(orgId: string, invoiceId: string): Promise<{ filename: string; contentType: 'application/pdf'; content: Buffer }>;
  ```
  Reads settings via `invoiceSettingsService.getInvoiceSettings`, identity via `organizationService.getById` and `organizationProfileService.getProfile`, `addressLines` from `publicStatementService`. `showLogo=false` → `logo: null`; `showOrgAddress=false` → `[]`; `showDueDate=false` → `dueDate: null`; `showPaymentTerms=false` → `paymentTerms: null`. `notes` is the invoice's filled `notes`. For `paidCents`, sum `allocatedCents + creditedCents + depositAppliedCents`, shown only when `status === 'ISSUED'`. Filename: `${number}.pdf`, or `invoice-draft.pdf` / `credit-note-draft.pdf`.

  Routes, both declared before any conflicting `/:id/...` sibling: `GET /invoices/:id/pdf` `requirePermission('invoices.view')`; `GET /credit-notes/:id/pdf` `requirePermission('credit_notes.view')`. Copy the header block from `quoteController.pdf` (`Content-Type`, `Content-Disposition`, `Content-Length`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`).
- **Tests:** `GET /invoices/:id/pdf` → `200`, `application/pdf`, body starts `%PDF-`; org B's id under org A's token → `404`; `GET /credit-notes/:id/pdf` org B → `404`; VIEWER on invoice → `200`.
- **Guardrails:** #1 every read through `orgId` · #2 no SQL in the controller
- **Proof:** `cd server && npx vitest run src/__tests__/accounting/invoicePdf.test.ts` passes; the router-walking permission test passes (`find server/src/__tests__ -iname '*permission*'`, run those files).
- **If it fails:** a `404` on your own org is a fixture problem; do not touch the predicate.
- **Owes:** `docs/api.md` (Step 26)

---

## Slice B — Mail attachments

### Step 4 — [Sonnet] Outbox and transports carry attachments

- **Model:** [Sonnet] — crosses the outbox retry semantics
- **Depends on:** 1, 3
- **Skill:** none
- **Read first:** `emailOutboxService.ts`, `transports.ts`, `__tests__/platform/email.test.ts`
- **Files:** `types/email.ts`, `services/mail/emailOutboxService.ts`, `services/mail/transports.ts`, `queue/handlers/emailDrainHandler.ts` (all edit); `__tests__/platform/emailAttachments.test.ts` (new)
- **Contract:**
  ```ts
  // types/email.ts
  export const EMAIL_ATTACHMENT_KINDS = ['INVOICE_PDF'] as const;
  export type EmailAttachmentKind = (typeof EMAIL_ATTACHMENT_KINDS)[number];
  export interface EmailAttachment { filename: string; contentType: string; content: Buffer }
  // OutgoingEmail gains: attachments?: EmailAttachment[];
  // EMAIL_TEMPLATES gains 'invoice_sent', 'invoice_reminder' (renderEmail's cases land in Step 6)

  // emailOutboxService.ts
  export type AttachmentResolver = (kind: EmailAttachmentKind, orgId: string, refId: string) => Promise<EmailAttachment>;
  // EnqueueEmailInput gains: attachment?: { kind: EmailAttachmentKind; refId: string } | null;
  // drainEmailOutbox options gain: resolveAttachment?: AttachmentResolver;
  ```
  Claim `RETURNING` adds `o.org_id, o.attachment_kind, o.attachment_ref_id`. Before `transport.send`, when `attachment_kind` is not null:
  - no resolver → `throw new MailSendError('No attachment resolver is configured', true)`;
  - resolver throws `ApiError` with status 404 → `throw new MailSendError('Attachment source no longer exists', true)`;
  - any other resolver error propagates to the existing retry path.

  Transport wire formats (verified 2026-11-06 against each provider's docs):
  - Mailpit `POST /api/v1/send`: `Attachments: [{ Content: <base64>, Filename, ContentType }]`
  - Brevo `POST /v3/smtp/email`: `attachment: [{ content: <base64>, name }]`
  - Log: log `attachments: filenames` only, never the content.

  Omit the key entirely when there are no attachments. `emailDrainHandler` passes `resolveAttachment: (kind, orgId, refId) => resolveInvoiceAttachment(orgId, refId)` — switch on `kind`, with an exhaustive `never` default.
- **Tests:** enqueue with attachment + fake transport + fake resolver → transport receives a `Buffer` and filename; no resolver → row `FAILED`, transport not called; resolver throws plain `Error` → row back to `PENDING`, `attempts = 1`; resolver throws `ApiError(404)` → `FAILED`; Mailpit transport with fake `fetch` → body `Attachments[0].Content` equals base64 of the buffer; Brevo transport with fake `fetch` → `attachment[0].name` and `.content`; no-attachment message → neither key present; CHECK rejects `attachment_kind` with `org_id` null (raw insert → `23514`).
- **Guardrails:** #5 no transaction across the send · logs never contain content or links
- **Proof:** `cd server && npx vitest run src/__tests__/platform/emailAttachments.test.ts src/__tests__/platform/email.test.ts` passes. Because `renderEmail` is an exhaustive switch, **write both template cases exactly as specified in Step 6's contract in this step**, so the server compiles. Step 6 then adds their tests.
- **If it fails:** do not make attachments best-effort. A silent email without the PDF is the bug this step prevents.
- **Owes:** extend `study/architecture/transactional-outbox.md` (Step 25)

---

## Slice C — Send

### Step 5 — [Haiku] Types, constants, schema

- **Model:** [Haiku] — transcription
- **Depends on:** 1
- **Skill:** none
- **Read first:** `schemas/accounting/statementEmailSchema.ts`
- **Files:** `types/accounting.ts`, `config/constants.ts`, `schemas/accounting/invoiceSendSchema.ts` (new)
- **Contract:**
  ```ts
  // types/accounting.ts
  export const INVOICE_SEND_KINDS = ['MANUAL', 'REMINDER', 'RECURRING'] as const;
  export type InvoiceSendKind = (typeof INVOICE_SEND_KINDS)[number];
  export interface InvoiceSend {
    id: string; invoiceId: string; sendKind: InvoiceSendKind; toEmail: string;
    sentByName: string | null; createdAt: string; expiresAt: string;
    revokedAt: string | null; lastViewedAt: string | null;
    deliveryStatus: 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | null;
  }
  // Invoice gains: lastSentAt: string | null; lastViewedAt: string | null;
  // InvoiceSettings gains: remindersEnabled: boolean; reminderOffsetsDays: number[];
  // RecurringSchedule gains: autoSend: boolean;

  // constants.ts
  export const INVOICE_LINK_TTL_MS = 60 * 24 * 60 * 60 * 1000;
  export const INVOICE_REMINDER_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
  export const INVOICE_REMINDER_BATCH = 500;

  // invoiceSendSchema.ts
  export const sendInvoiceSchema = z.object({
    toEmail: z.string().trim().toLowerCase().pipe(z.email()).nullable().default(null),
    message: z.string().trim().max(2000).nullable().default(null),
  });
  ```
- **Guardrails:** #9 lowercase email
- **Proof:** run each file from `find server/src/__tests__ -iname '*permission*'` with `cd server && npx vitest run <path>`; all pass. `npm run typecheck` is expected to report only `Invoice`/`InvoiceSettings`/`RecurringSchedule` missing-property errors, closed in Steps 7, 14, 18. List them and confirm no others.
- **If it fails:** stop per execution rules; do not edit the test.
- **Owes:** —

### Step 6 — [Sonnet] Email templates

- **Model:** [Sonnet] — HTML escaping of user text
- **Depends on:** 4, 5
- **Skill:** none
- **Read first:** `services/mail/templates.ts` `party_statement` and `quote_sent` cases
- **Files:** `__tests__/platform/emailAttachments.test.ts` (edit); `services/mail/templates.ts` (written in Step 4 from this contract; edit only if a test below exposes a defect)
- **Contract:** `template_data` keys for both: `organizationName, customerName, invoiceNumber, total, amountDue, dueDate, message, canPayOnline`; `invoice_reminder` adds `overdue: boolean`.
  - `invoice_sent` subject: `Invoice ${invoiceNumber} from ${org}`.
  - `invoice_reminder` subject: overdue → `Reminder: invoice ${invoiceNumber} is overdue`; else `Reminder: invoice ${invoiceNumber} is due on ${dueDate}`.
  - Paragraphs: sender `message` split on blank lines, then `${org} has sent you invoice ${number} for ${total}.` (reminder: `This is a reminder about invoice ${number} from ${org}.`), then `Amount due: ${amountDue}, due ${dueDate}.`, then `The invoice is attached as a PDF.`
  - Action label: `canPayOnline === true` → `View and pay`, otherwise `View invoice`.
  - Every value goes through `esc` in `html`, as `quote_sent` does.
- **Tests:** a `<script>` in `message` is escaped in `html`; subject for each of the three cases; label for both values of `canPayOnline`.
- **Guardrails:** escaping is mandatory on every value
- **Proof:** `cd server && npx vitest run src/__tests__/platform/emailAttachments.test.ts` passes.
- **If it fails:** fix the template.
- **Owes:** —

### Step 7 — [Sonnet] Send service, derived sent status, history

- **Model:** [Sonnet] — one transaction across send row, outbox and history; used inside the recurring and reminder transactions
- **Depends on:** 3, 4, 5, 6
- **Skill:** new-module
- **Read first:** `statementEmailService.ts` lines 372–457, 496–531; `invoiceService.ts` `INVOICE_SELECT`, `toInvoice`; `onlinePaymentService.ts` `readSettings`
- **Files:** `services/accounting/invoiceSendService.ts` (new); `services/accounting/invoiceService.ts` (edit); `services/accounting/onlinePaymentService.ts` (edit: add `onlineCardAvailableOnClient`)
- **Contract:**
  ```ts
  // onlinePaymentService.ts
  export async function onlineCardAvailableOnClient(q: Queryable, orgId: string, deps?: StripeDeps): Promise<boolean>;
  // true when stripeConfig(deps) !== null && settings.enabled && settings.deposit_account_id !== null

  // invoiceSendService.ts
  export interface SendInvoiceOnClientInput {
    invoiceId: string; sendKind: InvoiceSendKind; toEmail: string | null; message: string | null;
    overdue?: boolean; // invoice_reminder only; selects template invoice_reminder when sendKind === 'REMINDER'
  }
  /** Returns null only when no address exists and the caller asked to tolerate that. */
  export async function sendInvoiceOnClient(
    client: PoolClient, orgId: string, userId: string, input: SendInvoiceOnClientInput,
  ): Promise<InvoiceSend | null>;
  export async function sendInvoice(orgId: string, userId: string, invoiceId: string,
    input: { toEmail: string | null; message: string | null }): Promise<InvoiceSend>;
  export async function listInvoiceSends(orgId: string, invoiceId: string): Promise<InvoiceSend[]>;
  export async function revokeInvoiceSend(orgId: string, invoiceId: string, sendId: string): Promise<InvoiceSend>;
  ```
  `sendInvoiceOnClient`, entirely on `client`:
  1. `SELECT` number, status, due date, currency, total, `customer_id`, customer name, customer email, and the three settlement subqueries (`allocatedCentsSubquery`, `noteAppliedCentsSubquery`, `depositAppliedCentsSubquery` from `settlementSql.ts`) `WHERE i.org_id = $1 AND i.id = $2`. No row → `ApiError(404, 'Invoice not found')`.
  2. `status <> 'ISSUED'` → `ApiError(422, 'Only an issued invoice can be sent')`.
  3. Address = `(input.toEmail ?? customer email)`, trimmed and lowercased. Empty → return `null`.
  4. Org name from `organizations` on `client`; `randomUrlToken()`; insert `invoice_sends` with `token_hash = sha256Hex(token)`, `expires_at = now + INVOICE_LINK_TTL_MS`.
  5. `enqueueEmailOnClient` with template `invoice_sent` or `invoice_reminder`, `attachment: { kind: 'INVOICE_PDF', refId: invoiceId }`, link `${origin(env.FRONTEND_URL)}/invoice/${encodeURIComponent(token)}`. Money via `formatMoney` from `statementEmailService`.
  6. `UPDATE invoice_sends SET email_id = $1 WHERE org_id = $2 AND id = $3`.
  7. `historyService.recordEventOnClient`: `{ entityType: 'INVOICE', entityId, action: 'SENT', summary }`, with summary `Emailed to <address>` or, for a reminder, `Reminder emailed to <address>`.

  `sendInvoice`: `withTransaction`; a `null` result → `ApiError(422, 'This customer has no email address. Enter one to send the invoice')`.
  `listInvoiceSends`: `getInvoiceById` first (404), newest first, `LIMIT 50`, `LEFT JOIN email_outbox e ON e.id = s.email_id` for `deliveryStatus`, `LEFT JOIN users u` for name, both predicates include `s.org_id = $1`.
  `revokeInvoiceSend`: `SET revoked_at = COALESCE(revoked_at, now()) WHERE org_id AND invoice_id AND id`; none → `404 'Invoice link not found'`.

  `invoiceService`: add to `INVOICE_SELECT`:
  ```sql
  (SELECT max(s.created_at) FROM invoice_sends s LEFT JOIN email_outbox e ON e.id = s.email_id
    WHERE s.org_id = i.org_id AND s.invoice_id = i.id AND COALESCE(e.status, 'SENT') <> 'FAILED') AS last_sent_at,
  (SELECT max(s.last_viewed_at) FROM invoice_sends s
    WHERE s.org_id = i.org_id AND s.invoice_id = i.id) AS last_viewed_at
  ```
  Map both on `InvoiceRow`/`toInvoice` to ISO strings or null.
- **Guardrails:** #1 · #5 every query on `client` inside `sendInvoiceOnClient`, no `pool` · #6 nothing updates `invoices` · never log the token
- **Proof:** `cd server && npm run typecheck` reports nothing from these files; tests in Step 9.
- **If it fails:** an immutability trigger error means something wrote to `invoices`. Remove that write.
- **Owes:** —

### Step 8 — [Haiku] Send controller and routes

- **Model:** [Haiku] — thin adapter with a literal route table
- **Depends on:** 7
- **Skill:** new-module (controller, routes)
- **Read first:** `controllers/accounting/statementEmailController.ts`, `routes/accounting/invoiceRoutes.ts`, `config/permissions.ts` (`invoices.void`)
- **Files:** `controllers/accounting/invoiceSendController.ts` (new), `routes/accounting/invoiceRoutes.ts` (edit), `config/permissions.ts` (edit)
- **Contract:** in `config/permissions.ts`, directly after `invoices.void`, add
  `{ key: 'invoices.send', area: 'Sales', label: 'Email invoices', tier: 'A', requires: ['invoices.view'] },`
  It lands here, with its route, because `routePermissions.test.ts` fails on any catalogue key no route uses.
  | Method, path | Permission | Success |
  |---|---|---|
  | `POST /invoices/:id/send` | `invoices.send` | `201 { success: true, send }` |
  | `GET /invoices/:id/sends` | `invoices.view` | `200 { success: true, sends }` |
  | `POST /invoices/:id/sends/:sendId/revoke` | `invoices.send` | `200 { success: true, send }` |

  Body parsed with `parseBody(sendInvoiceSchema, req.body ?? {})`. `requireUser`, `requireParam` as the analogue does. Zero SQL.
- **Guardrails:** #2
- **Proof:** `cd server && npm run typecheck` shows no errors from these two files; the router-walking permission test passes.
- **If it fails:** stop per execution rules.
- **Owes:** —

### Step 9 — [Sonnet] Send tests

- **Model:** [Sonnet] — integration tests against real PostgreSQL
- **Depends on:** 8
- **Skill:** isolation-test
- **Read first:** `__tests__/accounting/statementEmail.test.ts`, `__tests__/helpers/email.ts`, `__tests__/helpers/accountingFixtures.ts`
- **Files:** `__tests__/accounting/invoiceSend.test.ts` (new)
- **Cases:**
  - Issued invoice → `201`; outbox row has template `invoice_sent`, `attachment_kind 'INVOICE_PDF'`, `attachment_ref_id` = invoice id; `invoice_sends.token_hash` ≠ raw token; `invoice.lastSentAt` not null.
  - Draft → `422 'Only an issued invoice can be sent'`, no rows written. Void → same.
  - Customer with no email and no `toEmail` → `422`; with `toEmail: 'X@Example.COM'` → stored `x@example.com`.
  - Outbox row marked `FAILED` → `lastSentAt` null, `sends[0].deliveryStatus = 'FAILED'`.
  - Drain with a fake transport and `resolveInvoiceAttachment` → transport receives a buffer starting `%PDF-`, named `INV-….pdf`.
  - Org B token, org A's invoice: `POST /send` → `404`, `GET /sends` → `404`, revoke → `404`; no outbox row created.
  - VIEWER `POST /send` → `403`.
  - Rollback: force the history insert to fail (spy on `historyService.recordEventOnClient`) → no `invoice_sends` and no outbox row remain.
  - The issued invoice's `updated_at` is unchanged after a send.
- **Guardrails:** #15
- **Proof:** `cd server && npx vitest run src/__tests__/accounting/invoiceSend.test.ts` passes.
- **If it fails:** fix the code. Do not drop the rollback case.
- **Owes:** —

---

## Slice D — Public page and payment

### Step 10 — [Sonnet] Link service and online payment for an invoice

- **Model:** [Sonnet] — money, locks, org-less token resolution, idempotent settlement
- **Depends on:** 7
- **Skill:** none
- **Read first:** `statementLinkService.ts`, the whole of `onlinePaymentService.ts`, `__tests__/accounting/onlinePayments.test.ts`
- **Files:** `services/accounting/invoiceLinkService.ts` (new); `services/accounting/onlinePaymentService.ts` (edit)
- **Contract:**
  ```ts
  // invoiceLinkService.ts — same shape and messages discipline as resolveLiveSend
  export interface LiveInvoiceSend { id: string; orgId: string; invoiceId: string; sentBy: string; expiresAt: string }
  export async function resolveLiveInvoiceSend(token: string): Promise<LiveInvoiceSend>;
  // token length guard 20..200; SELECT … FROM invoice_sends WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
  // failure: ApiError(404, 'This invoice link is not valid or has expired')

  // onlinePaymentService.ts
  export async function startInvoicePayment(token: string, deps?: StripeDeps): Promise<StartedPayment>;
  export async function confirmFromInvoiceLink(token: string, intentId: string, deps?: StripeDeps): Promise<SettleResult>;
  ```
  Refactor without behaviour change: extract from `startPayment` everything after the options check into
  ```ts
  async function startPaymentCore(
    source: { orgId: string; customerId: string; statementSendId: string | null; invoiceSendId: string | null },
    invoiceIds: string[], publishableKey: string, description: string, deps?: StripeDeps,
  ): Promise<StartedPayment>
  ```
  The INSERT writes both source columns; the customer check uses `source.customerId`.

  `startInvoicePayment`: resolve the link; read the invoice's `customer_id` scoped by `send.orgId` (`404` if none); `onlineCardAvailableOnClient(pool, send.orgId, deps)` false → `ApiError(409, 'Online payment is not available for this invoice')`; then the core with `[send.invoiceId]`. Existing `422`s (not issued, already paid, unsupported currency) come from the core.

  `settleIntent`: add `invoice_send_id` to `PaymentRow` and the locking SELECT; `statement_send_id` becomes `string | null`. Resolve the acting user with:
  ```ts
  row.statement_send_id !== null ? (SELECT sent_by FROM statement_sends …) : (SELECT sent_by FROM invoice_sends WHERE org_id = $1 AND id = $2)
  ```
  Both on `client`. Notes: `'Paid online from an emailed invoice'` for the invoice path, the existing text otherwise.

  `confirmFromInvoiceLink`: same as `confirmFromLink`, matching `invoice_send_id`.
- **Guardrails:** #3 · #5 Stripe call stays after COMMIT · lock order unchanged (`ORDER BY id FOR UPDATE`) · the browser never supplies an amount or invoice id · #10 status only through `transition`
- **Proof:** `cd server && npx vitest run src/__tests__/accounting/onlinePayments.test.ts` passes **unchanged**. A refactor that needs that file edited is wrong; stop.
- **If it fails:** restore behaviour; do not alter the existing tests.
- **Owes:** —

### Step 11 — [Sonnet] Public invoice service

- **Model:** [Sonnet] — public surface scoped only by a token-derived org
- **Depends on:** 10
- **Skill:** none
- **Read first:** `publicStatementService.ts`
- **Files:** `services/accounting/publicInvoiceService.ts` (new)
- **Contract:**
  ```ts
  export interface PublicInvoiceView {
    merchant: { name: string; addressLines: string[]; hasLogo: boolean };
    invoice: {
      number: string | null; status: string; settlementStatus: SettlementStatus;
      issueDate: string; dueDate: string; currencyCode: string; customerName: string;
      notes: string | null; paymentTerms: string | null;
      lines: { description: string; quantityMilli: number; unitPriceCents: number; taxRateBp: number; netCents: number }[];
      subtotalCents: number; taxCents: number; totalCents: number; paidCents: number; amountDueCents: number;
    };
    bankDetails: string | null;
    payment: PublicPaymentOptions;
    expiresAt: string;
  }
  export async function getPublicInvoice(token: string): Promise<PublicInvoiceView>;
  export async function openPublicInvoiceLogo(token: string): Promise<{ mimeType: string; byteSize: number; stream: Readable }>;
  export async function getPublicInvoicePdf(token: string): Promise<{ filename: string; pdf: Buffer }>;
  ```
  The view deliberately omits account ids and codes, `journalEntryId`, `createdBy`, FX rate and base-currency amounts: **map field by field, never spread an `Invoice`**. `payment.enabled` is `onlineCardAvailableOnClient(pool, …)` AND `invoice.amountDueCents > 0`, with `publishableKey` from `stripeClient.stripeConfig()`. `getPublicInvoice` then runs `UPDATE invoice_sends SET last_viewed_at = now() WHERE org_id = $1 AND id = $2`. Logo: copy `openPublicLogo`'s `LOGO_TYPES` guard (export the constant from `publicStatementService.ts`) and honour `showLogo`. A `DRAFT` cannot occur (send requires ISSUED); a void invoice returns `status: 'VOID'` and `amountDueCents: 0`.
- **Guardrails:** #1 all reads use `send.orgId` · no internal ids in the response
- **Proof:** `cd server && npm run typecheck` shows no errors from this file; behaviour proven in Step 13.
- **If it fails:** stop per execution rules.
- **Owes:** —

### Step 12 — [Haiku] Public controller, routes, mount

- **Model:** [Haiku] — copy of the statement adapter with a literal route table
- **Depends on:** 11
- **Skill:** new-module (controller, routes, mount)
- **Read first:** `controllers/accounting/publicStatementController.ts`, `routes/accounting/publicStatementRoutes.ts`, `routes/accounting/index.ts` lines 87–91
- **Files:** `controllers/accounting/publicInvoiceController.ts` (new), `routes/accounting/publicInvoiceRoutes.ts` (new), `routes/accounting/index.ts` (edit)
- **Contract:** all routes use `publicLinkLimiter`, no `authenticate`, `Cache-Control: no-store` on every response.
  | Method, path | Success |
  |---|---|
  | `GET /public/invoices/:token` | `200 { success: true, ...view }` |
  | `GET /public/invoices/:token/logo` | `200` image stream (headers as statement `logo`) |
  | `GET /public/invoices/:token/pdf` | `200` PDF (headers as `quoteController.pdf`) |
  | `POST /public/invoices/:token/payments` | `201 { success: true, payment }` (no body read) |
  | `POST /public/invoices/:token/payments/:intentId/confirm` | `200 { success: true, ...result }` |

  Mount: `router.use('/public/invoices', publicInvoiceRoutes);` beside `/public/quotes`.
- **Guardrails:** #2
- **Proof:** `cd server && npm run typecheck` shows no errors from these files; `curl` not required, Step 13 proves it.
- **If it fails:** stop per execution rules.
- **Owes:** —

### Step 13 — [Sonnet] Public and payment tests

- **Model:** [Sonnet] — settlement invariants against real PostgreSQL
- **Depends on:** 12
- **Skill:** isolation-test
- **Read first:** `__tests__/accounting/onlinePayments.test.ts` (copy its Stripe fake and setup)
- **Files:** `__tests__/accounting/publicInvoice.test.ts` (new)
- **Cases:**
  - View: `200`; `Cache-Control: no-store`; `lastViewedAt` then set on the staff read; the JSON string contains no `journalEntryId`, `revenueAccountId` or `createdBy`.
  - Unknown, revoked and expired tokens → the same `404` message.
  - PDF via token → `%PDF-`. Logo with SVG in the vault → `404`.
  - Pay: invoice total 11000 with a 1000 partial receipt → intent amount exactly `10000`; a body with `{amountCents: 1}` or another invoice id is ignored.
  - **Exactly once:** succeeded intent; call webhook, confirm, webhook → one `payments` row, `method 'CARD'`, `amountDueCents = 0`, ledger balanced by integer equality, `online_payments.status = 'RECORDED'`, created by `sent_by`.
  - Reversed order (confirm first) → still one payment.
  - Invoice voided after intent start, then success → `NEEDS_REVIEW`, no payment.
  - Disabled online payments → `409`; view shows `payment.enabled = false`.
  - Fully paid → `POST /payments` `422`; view `amountDueCents = 0`, `payment.enabled = false`. Void → view status `VOID`, `POST /payments` `422`.
  - **Cross-tenant:** org B's token cannot confirm org A's intent → `404`. A statement token at `/public/invoices/:token` → `404`, and an invoice token at `/public/statements/:token` → `404`.
  - DB: an `online_payments` insert with both source ids → `23514`; with neither → `23514`.
- **Guardrails:** #3 · #7 · #15
- **Proof:** `cd server && npx vitest run src/__tests__/accounting/publicInvoice.test.ts src/__tests__/accounting/onlinePayments.test.ts` passes.
- **If it fails:** a double payment is a stop-and-report, never a test edit.
- **Owes:** —

---

## Slice E — Reminders

### Step 14 — [Sonnet] Settings fields

- **Model:** [Sonnet] — array column through a dynamic-update map
- **Depends on:** 1, 5
- **Skill:** none
- **Read first:** `invoiceSettingsService.ts` lines 60–110, 130–260; `schemas/accounting/invoiceSettingsSchema.ts`
- **Files:** `services/accounting/invoiceSettingsService.ts`, `schemas/accounting/invoiceSettingsSchema.ts` (both edit); `__tests__/accounting/invoiceReminders.test.ts` (new, settings cases)
- **Contract:** defaults `remindersEnabled: false`, `reminderOffsetsDays: [7, 14, 30]`. SELECT and row mapping add both columns; the update map adds `remindersEnabled: 'reminders_enabled'`, `reminderOffsetsDays: 'reminder_offsets_days'`. Schema:
  ```ts
  remindersEnabled: z.boolean().optional(),
  reminderOffsetsDays: z.array(z.int().min(-60).max(365)).min(1).max(5)
    .refine((a) => new Set(a).size === a.length, { message: 'Reminder days must be different from each other' })
    .optional(),
  ```
  The service stores the array sorted ascending.
- **Tests:** `PATCH /settings/invoicing { reminderOffsetsDays: [14, 7] }` → read back `[7, 14]`; `[]` → `400`; `[7,7]` → `400`; `[400]` → `400`; org A's change does not alter org B's values; VIEWER → `403`.
- **Guardrails:** #4 column names only from the constant map
- **Proof:** `cd server && npx vitest run src/__tests__/accounting/invoiceReminders.test.ts` passes.
- **If it fails:** stop per execution rules.
- **Owes:** —

### Step 15 — [Haiku] Pure reminder decision

- **Model:** [Haiku] — pure function with the cases listed
- **Depends on:** —
- **Skill:** none
- **Read first:** any pure function in `server/src/utils/` with date handling, e.g. the `computeDueDate` file (`grep -rl computeDueDate server/src/utils`)
- **Files:** `server/src/utils/invoiceReminders.ts` (new), `server/src/__tests__/invoiceReminders.unit.test.ts` (new)
- **Contract:**
  ```ts
  /** The offset to send for now, or null. UTC dates as YYYY-MM-DD. */
  export function reminderOffsetDue(dueDate: string, today: string, offsets: readonly number[], alreadySent: readonly number[]): number | null;
  ```
  Passed = offsets where `dueDate + offset days <= today`. Take the largest passed. Return null if none passed, or if `max(alreadySent) >= largest`. Otherwise return it. UTC arithmetic via `Date.UTC`.
- **Cases (due `2026-03-01`, offsets `[7,14,30]`):** today `2026-03-07`, none sent → `null`; `2026-03-08` → `7`; `2026-03-08`, sent `[7]` → `null`; `2026-03-15`, sent `[7]` → `14`; `2026-04-15`, none sent → `30` (no back-fill); `2026-04-15`, sent `[30]` → `null`; offsets `[-3]`, today `2026-02-26` → `-3`; `2026-02-25` → `null`; crossing a leap day: due `2028-02-28`, offsets `[1]`, today `2028-02-29` → `1`.
- **Guardrails:** no `new Date()` inside; `today` is an argument
- **Proof:** `cd server && npx vitest run src/__tests__/invoiceReminders.unit.test.ts` passes.
- **If it fails:** escalate per rules.
- **Owes:** —

### Step 16 — [Sonnet] Reminder service, job, worker

- **Model:** [Sonnet] — exactly-once under concurrency, per-invoice transactions
- **Depends on:** 7, 14, 15
- **Skill:** none
- **Read first:** `queue/handlers/quoteExpirySweepHandler.ts`, `queue/worker.ts` lines 14–45, 146–160, `types/jobs.ts`, `quoteService.listOrgsWithExpiredSentQuotes`
- **Files:** `services/accounting/invoiceReminderService.ts` (new), `queue/handlers/invoiceReminderSweepHandler.ts` (new), `types/jobs.ts`, `queue/worker.ts` (edit)
- **Contract:**
  ```ts
  export async function listOrgsWithReminders(): Promise<string[]>;
  // SELECT org_id FROM ledger_invoice_settings WHERE reminders_enabled — a platform sweep, the one org-less query, commented as such
  export async function sendDueRemindersForOrg(orgId: string, today: string): Promise<{ sent: number; failed: number }>;
  ```
  `sendDueRemindersForOrg`:
  1. Read settings; not enabled → `{0,0}`.
  2. Candidates, `org_id = $1`, `status = 'ISSUED'`, `customers.email` non-empty, `total_cents - settled > 0` (the three settlement subqueries), `EXISTS` a non-failed `invoice_sends` row, `array_agg` of existing `invoice_reminders.offset_days`, `ORDER BY due_date, id LIMIT INVOICE_REMINDER_BATCH`.
  3. For each: `reminderOffsetDue`; null → skip.
  4. `withTransaction` per invoice, in `try/catch` (log `{ err, orgId, invoiceId }`, `failed += 1`, continue):
     - Reserve first: since `invoice_send_id` is `NOT NULL`, take a transaction-scoped claim with `SELECT pg_advisory_xact_lock(hashtextextended($orgId || ':' || $invoiceId, 0))`, then `SELECT 1 FROM invoice_reminders WHERE org_id AND invoice_id AND offset_days`; present → return without sending.
     - `sendInvoiceOnClient(client, orgId, invoice.created_by, { invoiceId, sendKind: 'REMINDER', toEmail: null, message: null, overdue: dueDate < today })`.
     - `INSERT INTO invoice_reminders … ` with the returned send id. The unique constraint is the final guard: a `23505` rolls back the send and email together, counted as neither sent nor failed.

  Handler: `todayIso()`; loop orgs with per-org `try/catch`, as the quote sweep does. Worker: `'invoice-reminder-sweep': handleInvoiceReminderSweep`, scheduler `invoice-reminder-sweep-tick` every `INVOICE_REMINDER_SWEEP_INTERVAL_MS`, `attempts: 1`.
- **Guardrails:** #1 · #5 per-invoice transaction, everything on `client` · no lock on `invoices`: this is not a money path and a payment in flight must not wait on it
- **Proof:** `cd server && npm run typecheck` shows no errors from these files; `grep -n "invoice-reminder-sweep" server/src/types/jobs.ts server/src/queue/worker.ts` shows both.
- **If it fails:** stop per execution rules.
- **Owes:** study note in Step 25

### Step 17 — [Sonnet] Reminder integration tests

- **Model:** [Sonnet] — concurrency and isolation against real PostgreSQL
- **Depends on:** 16
- **Skill:** isolation-test
- **Read first:** `__tests__/accounting/invoiceSend.test.ts` (Step 9)
- **Files:** `__tests__/accounting/invoiceReminders.test.ts` (edit)
- **Cases:** (invoice due `2026-03-01`, previously sent, reminders on, offsets `[7,14,30]`, `today` passed explicitly)
  - `2026-03-08` → one `invoice_reminder` outbox row with `overdue: true` and the PDF attachment; a second run the same day → still one.
  - **Concurrent:** `Promise.all` of two `sendDueRemindersForOrg` → exactly one row.
  - `2026-04-15` with none sent → one reminder at offset 30; rerun → none.
  - Reminders disabled → none. Never sent → none. Fully paid → none. Void → none. Customer email removed → none.
  - The earlier send has a `FAILED` outbox row and no other → none.
  - Rollback: failure inside the transaction (spy) → neither the reminder row, the send nor the outbox row remains; the next invoice still gets its reminder.
  - Cross-tenant: org B enabled, org A's invoice unaffected by `sendDueRemindersForOrg(orgB, …)`.
  - Reminder token opens the public page.
- **Guardrails:** #15
- **Proof:** `cd server && npx vitest run src/__tests__/accounting/invoiceReminders.test.ts` passes.
- **If it fails:** a second email is a stop-and-report, never a test edit.
- **Owes:** —

---

## Slice F — Recurring auto-send

### Step 18 — [Sonnet] Auto-send on a schedule

- **Model:** [Sonnet] — inside the recurring worker's transaction; a failure must not break issuing
- **Depends on:** 7
- **Skill:** none
- **Read first:** `recurringService.ts` lines 88–140, 232–345, 570–625, 745–830; `schemas/accounting/recurringScheduleSchema.ts`
- **Files:** `services/accounting/recurringService.ts`, `schemas/accounting/recurringScheduleSchema.ts`, `types/history.ts` (edit)
- **Contract:**
  - Schema adds `autoSend: z.boolean().default(false)`.
  - `CreateRecurringScheduleInput.autoSend: boolean`; `INSERT` writes `auto_send`; `SCHEDULE_SELECT`, `ScheduleRow`, `toSchedule` map `autoSend`.
  - `createSchedule`: `input.autoSend && (input.kind !== 'INVOICE' || input.mode !== 'POST')` → `ApiError(422, 'Only an invoice that is issued automatically can be emailed automatically')`.
  - `LockedRow` and the locking SELECT add `auto_send`; `generateOccurrence` gains parameter `autoSend: boolean` after `autoReverse`.
  - In the `INVOICE` branch, inside `if (mode === 'POST')`, after issuing and only if `autoSend`:
    ```ts
    const send = await sendInvoiceOnClient(client, orgId, userId, { invoiceId, sendKind: 'RECURRING', toEmail: null, message: null });
    if (send === null) await historyService.recordEventOnClient(client, orgId, {
      entityType: 'INVOICE', entityId: invoiceId, action: 'SEND_SKIPPED', summary: 'Not emailed: the customer has no email address',
    });
    ```
  - Add `'SEND_SKIPPED'` to `HISTORY_ACTIONS` in `types/history.ts`. Migration 101's CHECK pattern already admits it, so no migration.
  Update every other `generateOccurrence` caller to pass the value.
- **Guardrails:** #5 all on `client` · outbox on the same transaction, so a rolled-back occurrence sends nothing
- **Proof:** `cd server && npm run typecheck` exits 0 (all `RecurringSchedule`, `Invoice`, `InvoiceSettings` errors closed); existing recurring tests pass: `cd server && npx vitest run src/__tests__/accounting/ -t recurring`.
- **If it fails:** do not move the send after COMMIT.
- **Owes:** —

### Step 19 — [Sonnet] Auto-send tests

- **Model:** [Sonnet] — integration tier
- **Depends on:** 18
- **Skill:** isolation-test
- **Read first:** the existing recurring test (`grep -rl "recurring-generate\|generateDue\|recurring_runs" server/src/__tests__`)
- **Files:** `__tests__/accounting/recurringAutoSend.test.ts` (new)
- **Cases:** `autoSend` + POST + due → issued invoice, one `invoice_sent` outbox row, `invoice_sends.send_kind = 'RECURRING'`, `sent_by` = schedule creator; `autoSend` false → no outbox row; re-run for the same date → still one; customer with no email → invoice issued, no send, history `SEND_SKIPPED`; DRAFT + `autoSend` → `422`; BILL + `autoSend` → `422`; DB insert violating `ck_recurring_auto_send` → `23514`; failure during issue → no outbox row; org B cannot read org A's schedule (`404`).
- **Guardrails:** #15
- **Proof:** `cd server && npx vitest run src/__tests__/accounting/recurringAutoSend.test.ts` passes.
- **If it fails:** fix the code.
- **Owes:** —

---

## Slice G — Client

### Step 20 — [Haiku] Client API functions and types

- **Model:** [Haiku] — transcription of the shapes above
- **Depends on:** 8, 12, 14, 18
- **Skill:** none
- **Read first:** `fetchServices.ts` lines 2350–2370 (public statement), 6530–6540 and 6737–6745 (PDF blobs)
- **Files:** `client/src/services/fetchServices.ts` (edit)
- **Contract:** mirror `InvoiceSend`, `PublicInvoiceView`; `Invoice` gains `lastSentAt`, `lastViewedAt`; `InvoiceSettings` gains `remindersEnabled`, `reminderOffsetsDays`; `RecurringSchedule` gains `autoSend`; create-schedule input gains `autoSend?: boolean`. Add: `getInvoicePdf(id)`, `getCreditNotePdf(id)`, `sendInvoice(id, {toEmail, message})`, `listInvoiceSends(id)`, `revokeInvoiceSend(id, sendId)`, `getPublicInvoice(token, signal)`, `getPublicInvoiceLogo(token)`, `getPublicInvoicePdf(token)`, `startInvoicePayment(token)`, `confirmInvoicePayment(token, intentId)`. Public functions send no cookies, as the statement ones do.
- **Guardrails:** —
- **Proof:** `cd client && npm run typecheck` reports only missing fields in `sampleInvoice.ts` and test fixtures. Add `lastSentAt: null, lastViewedAt: null` there and to the fixtures named by the compiler, then it exits 0.
- **If it fails:** escalate per rules.
- **Owes:** —

### Step 21 — [Sonnet] Staff UI

- **Model:** [Sonnet] — several pages and permission-gated actions
- **Depends on:** 20
- **Skill:** none
- **Read first:** `Pages/sales/InvoiceDetailPage.tsx`, `Pages/sales/quotes/QuoteDetailPage.tsx` (PDF, send), `Pages/sales/InvoicesPage.tsx`, `Pages/sales/notes/` credit note detail, `components/MakeRecurringDialog.tsx`, `Pages/settings/InvoiceSettingsPage.tsx`
- **Files:** `Pages/sales/SendInvoiceDialog.tsx` (new), `InvoiceDetailPage.tsx`, `InvoicesPage.tsx`, `CreditNoteDetailPage.tsx`, `components/MakeRecurringDialog.tsx`, `Pages/settings/InvoiceSettingsPage.tsx`
- **Contract:**
  - **InvoiceDetailPage:** a **Download PDF** button beside Print (`invoices.view`), saved with `saveBlob` as `QuoteDetailPage` does. When `status === 'ISSUED'` and `useCan('invoices.send')`: an **Email** button opening `SendInvoiceDialog`. A "Sent" panel listing sends: address, kind, date, `Viewed <date>` or `Not viewed`, `Failed` when `deliveryStatus === 'FAILED'`, with a Revoke action.
  - **SendInvoiceDialog:** To (prefilled from the customer's email), Message (optional, 2000 max), Send, Cancel; server errors inline; on success close and reload. Use the existing dialog components the quote send uses.
  - **InvoicesPage:** beside the settlement label, `Viewed` if `lastViewedAt`, else `Sent` if `lastSentAt`, else nothing.
  - **CreditNoteDetailPage:** **Download PDF** (`credit_notes.view`).
  - **MakeRecurringDialog:** when `kind === 'INVOICE'` and mode is POST, a checkbox "Email each invoice to the customer" → `autoSend`. It resets to false if mode changes to DRAFT.
  - **InvoiceSettingsPage:** section "Payment reminders": on/off toggle, a text input of comma-separated days with helper text "Days after the due date. Use a negative number for days before." Parse to integers; show the server's validation message.
- **Guardrails:** all existing UI components (`formClasses`, `ConfirmDialog` for revoke)
- **Proof:** `cd client && npm run typecheck && npm run lint` exit 0.
- **If it fails:** stop per execution rules.
- **Owes:** —

### Step 22 — [Sonnet] Public invoice page

- **Model:** [Sonnet] — Stripe panel reuse without regressing the statement page
- **Depends on:** 20
- **Skill:** none
- **Read first:** `Pages/public/PublicStatementPage.tsx`, `Pages/public/StripePayPanel.tsx`, `App.tsx` lines 50–66
- **Files:** `Pages/public/PublicInvoicePage.tsx` (new), `Pages/public/StripePayPanel.tsx` (edit), `App.tsx` (edit)
- **Contract:** Route `<Route path="/invoice/:token" element={<PublicInvoicePage />} />` next to `/quote/:token`, outside `ProtectedRoute`. Page: merchant name and logo; number, status, issue and due dates; lines; subtotal, tax, total, paid, amount due; bank details; Download PDF. Invalid link text: "This invoice link is not valid or has expired. Please contact the sender for a new one." `VOID` shows "This invoice has been voided." with no pay panel. `amountDueCents === 0` and not void shows "Paid in full. Thank you."

  `StripePayPanel`: replace the direct calls with props `start: () => Promise<StartedStatementPayment>` and `confirm: (intentId: string) => Promise<…>`, plus `publishableKey`-independent behaviour unchanged. The statement route passes closures over `startStatementPayment`/`confirmStatementPayment` with the selection. The invoice page passes `startInvoicePayment`/`confirmInvoicePayment`. After `onPaid`, the page reloads the view. The 3-D Secure `?payment_intent=` return path keeps working on both pages.
- **Guardrails:** the amount shown comes from the server only
- **Proof:** `cd client && npm run typecheck && npm test` exit 0; existing statement page tests pass unedited except for the prop change where they render `StripePayPanel` directly.
- **If it fails:** fix the panel; do not fork a second copy.
- **Owes:** —

### Step 23 — [Sonnet] Client tests

- **Model:** [Sonnet] — behaviour tests over several components
- **Depends on:** 21, 22
- **Skill:** none
- **Read first:** an existing test for `PublicStatementPage` (`grep -rl PublicStatementPage client/src/__tests__`)
- **Files:** `client/src/__tests__/invoiceDelivery.test.tsx` (new)
- **Cases:** Email button hidden on a draft and without `invoices.send`; the dialog prefills and posts `{toEmail, message}`; server `422` shows inline; list shows `Viewed` over `Sent`; failed send shows `Failed`; the recurring checkbox appears only for invoice + POST; the reminder input turns `"14, 7"` into `[14, 7]`; public page renders totals and pay panel; void shows no panel; paid shows the thank-you; `404` shows the invalid-link text.
- **Guardrails:** —
- **Proof:** `cd client && npx vitest run src/__tests__/invoiceDelivery.test.tsx` passes.
- **If it fails:** fix the component.
- **Owes:** —

---

## Closing spine

### Step 24 — [Sonnet] Full suites, then guardrail review

- **Model:** [Sonnet] — verification
- **Depends on:** 13, 17, 19, 23
- **Skill:** guardrail-review
- **Files:** none unless the review finds a defect
- **Proof:** `cd server && npm run typecheck && npm run lint && npm test` and `cd client && npm run typecheck && npm run lint && npm test` all exit 0. Record the totals. `guardrail-review` over the full diff reports no unresolved violation. Check specifically: no SQL in the two controllers, no internal ids in `PublicInvoiceView`, no `pool` inside `sendInvoiceOnClient`, every new query has `org_id` except the three commented org-less ones (`resolveLiveInvoiceSend`, `listOrgsWithReminders`, and the existing `settleIntent` reads).
- **If it fails:** fix and re-run. Report any test you believe is wrong rather than editing it.
- **Owes:** —

### Step 25 — [Sonnet] Study notes

- **Model:** [Sonnet] — accuracy task
- **Depends on:** 24
- **Skill:** study-note
- **Files:** extend `study/architecture/transactional-outbox.md` (attachment reference vs bytes, render at drain, dependency injection to keep mail free of accounting, permanent vs retryable); extend `study/architecture/user-authored-templates-and-bearer-links.md` (a second bearer-link type, field-by-field mapping on a public view); new `study/architecture/exactly-once-reminders.md` (unique constraint as the guard, advisory transaction lock, why sends and reminders share a transaction, at-least-once delivery after commit, why "exactly once" holds for the decision rather than the network); update `study/README.md`.
- **Proof:** each note has 4–8 interview questions with full answers and states the versions it verified; `study/README.md` index links resolve (`grep` each new path).
- **If it fails:** state uncertainty in the note rather than inventing.
- **Owes:** —

### Step 26 — [Sonnet] Docs sync

- **Model:** [Sonnet] — accuracy task
- **Depends on:** 24
- **Skill:** docs-sync
- **Files:** `docs/api.md` (all routes in Steps 3, 8, 12; settings and recurring fields), `docs/schema.md` (migration 105), `docs/accounting.md`, `docs/development.md` (none needed unless env changes: state that), `docs/roadmap.md` (`## Phase 48, as delivered`, with **Deliberately not built:** editable invoice email templates; credit note email and public page; per-customer reminder opt-out; partial online payment; the classic/modern/compact layouts in PDF; non-Latin PDF text; statement-style bulk send; a real Stripe and real Brevo run unless Step 27 did it), `CLAUDE.md` (one bullet; `EMAIL_TEMPLATES` comment reflects `105`).
- **Proof:** `docs-sync` reports no drift for these files.
- **If it fails:** correct the doc to what shipped.
- **Owes:** —

### Step 27 — [Sonnet] End-to-end check, close the plan

- **Model:** [Sonnet] — real services, judgment on results
- **Depends on:** 25, 26
- **Skill:** run
- **Steps:** `docker compose --profile mail up -d mailpit`; in `server/.env` use `MAIL_TRANSPORT=mailpit`; `cd server && npm run seed:demo`; run `./dev.sh`.
- **Proof, all five:**
  1. Email an issued invoice from the UI. Mailpit at http://localhost:8025 shows it **with a PDF attachment that opens**: `curl -s http://localhost:8025/api/v1/messages` lists it with `Attachments: 1`.
  2. The emailed link opens `/invoice/<token>` in a logged-out browser and the staff page then shows `Viewed`.
  3. Card payment **only if `STRIPE_*` test keys are available**: card `4242 4242 4242 4242` settles; the invoice shows paid, with exactly one receipt under Payments. Without keys, report this item as **not run**; the fake-Stripe tests in Step 13 remain the only proof, and say so in the roadmap.
  4. With reminders on and an overdue, already-sent invoice, run the sweep once (let the hourly job fire, or invoke `sendDueRemindersForOrg` through a temporary `npx tsx` one-liner not committed). Exactly one reminder arrives; a second run adds none.
  5. Signed in to a second organization, `GET /api/v1/invoices/<id>` and `POST /api/v1/invoices/<id>/send` → `404`.

  Then restore `server/.env`, record results in the roadmap entry, delete this plan's "not started" status, and set `Status: delivered`. Leave `plans/phase-48-invoice-delivery.md` in place, matching the repo's other plan files, with a final section "Executed: corrections to this plan". Do not commit unless the user asks.
- **If it fails:** a failed item is reported with its output, never reworded as passing.
- **Owes:** —

---

## 7. Dispatch manifest

| Batch | Step | Tier | Title | Depends on | Blocks | Status |
|---|---|---|---|---|---|---|
| A | 1 | Sonnet | Migration 105 | — | 4,5,14 | done |
| A | 2 | Sonnet | PDF renderer | — | 3 | done |
| A | 3 | Sonnet | PDF service, routes | 2 | 4,7 | done |
| A | 4 | Sonnet | Outbox + transport attachments | 1,3 | 6,7 | done |
| B | 5 | Haiku | Types, constants, schema | 1 | 6,7,14 | done |
| C | 6 | Sonnet | Email templates | 4,5 | 7 | done |
| C | 7 | Sonnet | Send service, sent status | 3,4,5,6 | 8,10,16,18 | done |
| D | 8 | Haiku | Send controller, routes, permission | 7 | 9,20 | done |
| E | 9 | Sonnet | Send tests | 8 | 24 | done |
| E | 10 | Sonnet | Link service, invoice payment | 7 | 11 | done |
| E | 11 | Sonnet | Public invoice service | 10 | 12 | done |
| F | 12 | Haiku | Public controller, routes | 11 | 13,20 | done |
| G | 13 | Sonnet | Public + payment tests | 12 | 24 | done |
| G | 14 | Sonnet | Reminder settings | 1,5 | 16,20 | done |
| H | 15 | Haiku | Pure reminder decision | — | 16 | done |
| I | 16 | Sonnet | Reminder service, job | 7,14,15 | 17 | done |
| I | 17 | Sonnet | Reminder tests | 16 | 24 | done |
| I | 18 | Sonnet | Recurring auto-send | 7 | 19,20 | done |
| I | 19 | Sonnet | Auto-send tests | 18 | 24 | done |
| J | 20 | Haiku | Client API + types | 8,12,14,18 | 21,22 | done |
| K | 21 | Sonnet | Staff UI | 20 | 23 | done |
| K | 22 | Sonnet | Public invoice page | 20 | 23 | done |
| K | 23 | Sonnet | Client tests | 21,22 | 24 | done |
| K | 24 | Sonnet | Full suites, guardrail review | 13,17,19,23 | 25,26 | done |
| K | 25 | Sonnet | Study notes | 24 | 27 | done |
| K | 26 | Sonnet | Docs sync | 24 | 27 | done |
| K | 27 | Sonnet | End-to-end, close plan | 25,26 | — | done (card payment item NOT RUN: no Stripe keys; UI not clicked) |

Batches alternate tiers: A (Sonnet 1–4), B (Haiku 5), C (Sonnet 6–7), D (Haiku 8), E (Sonnet 9–11), F (Haiku 12), G (Sonnet 13–14), H (Haiku 15), I (Sonnet 16–19), J (Haiku 20), K (Sonnet 21–27).

**Do not split:** Step 7's send row, outbox row and history event share one transaction, and Steps 16 and 18 call it inside theirs. Step 4 and the template cases of Step 6 must land together for the server to compile.

## 8. Risks and open questions

- **Stripe has only been tested against a fake** since Phase 39. Step 27 item 3 needs test keys. If none are available, "a Stripe test payment settles the invoice exactly once" is proven only against the fake, and the roadmap must say so.
- **Brevo attachments:** the wire format is confirmed from Brevo's reference, but no real Brevo send is in this plan. Mailpit is the real-delivery proof.
- **Mail size:** a large logo inflates each PDF. Neither provider's limit was found to matter here, and Brevo's docs state none for a single attachment. Unknown beyond that.
- **Rendering at drain:** the amount-due line reflects the position at drain, normally seconds after sending. Accepted.
- **Reminder wording is fixed** and there is **no per-customer opt-out**, so an organization with a disputed invoice can only void it or turn reminders off for everyone. Named as not built; a likely fast follow.
- **`invoices.send` on existing custom roles:** custom roles do not gain the new key automatically; built-ins do through their tier. An org's custom role must be edited to send. This matches how every later permission landed.
- **Step 4's compile ordering** is handled by the decision recorded in that step.

## Executed: corrections to this plan

- **Step 5 → Step 8, `invoices.send`.** `routePermissions.test.ts` fails on a catalogue key no route uses, so the key could not land before its route. The user chose to move it to Step 8. No test changed. Not a tiering problem: the Haiku runner reported it correctly.
- **Steps 7, 18, 19, history actions.** The plan named lowercase actions, but `HISTORY_ACTIONS` is a closed uppercase set backed by a CHECK. Step 7 uses the existing `SENT`, with the reminder distinguished by its summary. Step 18 adds `SEND_SKIPPED`.
- **Step 24, log redaction (a real gap).** No step added `/public/invoices/` to `SECRET_PATH_PREFIXES`, so invoice bearer tokens would have reached the access log in plain text. `logRedaction.test.ts` caught it on the first full run; the prefix, a redaction case and the route count were added as that test's comment instructs. Future plans adding a `:token` route must name this.
- **Step 27, run without a browser and without Stripe.** The check was driven through the HTTP API (no UI click-through), `seed:demo` was skipped because the demo organization already existed, and item 3 (card payment) was not run for lack of test keys. Results are in the roadmap entry.
- **Step 25, note path.** The bearer-links note lives in `study/security-auth/`, not `study/architecture/`.

## 9. Definition of done

- Server and client typecheck, lint and tests all green, with totals recorded.
- Migration `105` applies twice and replays in the migration test.
- Cross-tenant tests pass for PDF, send, list, revoke, public token, payment confirm, reminders and recurring.
- A card payment produces exactly one receipt under any ordering of webhook and browser.
- One reminder per offset under concurrent sweeps.
- `guardrail-review` clean. Study notes filed. `docs/` synced. Roadmap entry written with "deliberately not built".
- Step 27's five checks reported honestly, including anything not run.
