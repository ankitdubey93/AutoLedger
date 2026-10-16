# Feature tour (optional, unscored)

Do this **after month 6**. Nothing here changes `07-expected-results.md` — **except** where a step is flagged **⚠ changes the answer key**; those you either skip, undo, or do in the second organization from section 11. Each section says what to do, what you should see, and — where it needs something outside the app — what it needs. Sections marked *optional* need credentials or services you may not have.

The sidebar groups are named as they appear in the app: Overview, Sales, Purchases, Products & inventory, Banking, Accounting, Reports, Workspace. **Settings** (bottom of the sidebar) is a hub of cards; its card names are used below.

---

## 1. Organization profile and logo

**Do this:** **Settings → Organization → Profile**. Fill in the postal address and tax numbers and upload a logo (any small PNG or JPEG).

**You should see:** the details on the page after saving, and — in section 2 — the logo and address on the invoice preview. The logo is stored in the Document Vault (**Workspace → Documents**).

## 2. The invoice template

**Do this:** **Settings → Sales → Invoice template**. Switch between **Classic**, **Modern** and **Compact**; change the document title, font, density, accent colour, bank details and footer notes; try `[Month]` in the footer notes — placeholders in template text are filled as a document renders.

**You should see:** a live preview beside the form that is the *same component* your real invoices print with. Open any invoice (**Sales → Invoices**, e.g. one for Kestrel Logistics) and compare. Layouts are a fixed set of three — there is no free-form template editor.

## 3. Payment terms

**Do this:** **Settings → Sales → Payment terms**. Add a term whose rule is **Day of month … of the following month** with day **20** ("20th of next month"). Then **Settings → Accounting → Financial** and choose it under **Default terms — sales** (or bills).

**You should see:** a new draft invoice (**Sales → Invoices → New**) start with that term and compute the due date for you — an invoice dated the 10th falls due the 20th of the *next* month. **⚠ changes the answer key** only if you create and issue documents afterwards; a draft you never issue changes nothing. Setting the default back afterwards is tidy.

## 4. Quotes: settings, emails, PDF, public acceptance *(optional)*

**Needs:** Mailpit, a local inbox. From the repo root `docker compose --profile mail up -d mailpit`, put `MAIL_TRANSPORT=mailpit` in `server/.env`, restart the server **and the worker** (the worker sends), then open http://localhost:8025.

**Do this:** **Settings → Sales → Invoicing**: set the quote prefix, default validity and default terms. **Settings → Sales → Quote emails**: edit the template. Create a quote (**Sales → Quotes → New**) for Kestrel Logistics with *your* email address, **Send → Email a review link**, then **Download PDF** from the quote page.

**You should see:** the email in Mailpit; open its link in a private window — the public `/quote/…` page, no sign-in — type a name, tick the terms, **Accept**. Back in the app the quote shows the acceptance with the time, IP and a content hash. With **Invoicing → require an emailed code** ticked, accepting also asks for a 6-digit code mailed to the recipient. (That proves control of an email address — it is not a qualified electronic signature.) A quote never posts; **⚠ converting it does create a draft** — delete it.

## 5. A purchase quote becomes a bill

**Do this:** **Purchases → Purchase quotes → New** for any vendor with one line; **Send → Mark as sent**, **Record acceptance**, then **Convert to expense**.

**You should see:** a *draft* expense in **Purchases → Expenses** — and nothing in the trial balance. **⚠ changes the answer key if you approve it. Delete the draft afterwards.**

## 6. Customer statements

**Do this:** **Sales → Statements**. Open Kestrel Logistics: switch between **Outstanding** and **Activity**, pick an "as at" date. Back on the list, tick several customers and use **Print** (bulk print) and **Email**. Edit the layout under **Settings → Sales → Statement template** and the email wording under **Settings → Sales → Statement emails**.

**You should see:** Outstanding equals the customer's ledger balance on that date. With Mailpit running, the email carries a **Review and pay** link to a public `/statement/…` page. *Optional:* with Stripe **test** keys in `server/.env` (`STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`; the server refuses live keys outside production) that page offers card payment — use Stripe's test card 4242 4242 4242 4242. **⚠ a completed payment records a receipt and changes the answer key.** Stop at the form.

## 7. Attachments

**Do this:** upload a PDF or image under **Workspace → Documents**. Open the expense for Crosswind Freight (B18, **Purchases → Expenses**) and, in its **Attachments** panel, attach it from the Vault. While *drafting* a new bill or invoice you can attach files before it is saved.

**You should see:** the file listed on the document, downloadable, with the Vault page showing where it is used. Attaching changes no figure — it is a link, and posted documents stay immutable.

## 8. Credits offered on approval

**Do this:** you have already met it — issuing month 6's last invoice offered the customer's deposit. The same dialog appears when you **Approve** a bill and the vendor has an open debit note or prepayment. To see the purchase side without touching this organization, use the second organization from section 11: approve and pay a bill, issue a debit note against it (the whole note becomes unapplied credit because the bill is already paid), then approve a second bill for the same vendor.

**You should see:** the dialog listing the credit with an amount to apply; applying it happens in the same step as approval and reduces the new bill's amount due.

## 9. Members, invitations and roles

**Do this:** **Settings → Organization → Members & invitations → Invite someone**: an email address and a role. The invitation is a **copyable link** (and, with Mailpit, an email). Then **Settings → Organization → Roles & permissions → New role**: build a read-only role from the `… view` permissions only. Invite a second email with that role, open the link in a private window and sign in (or register) **as that exact email** — accepting needs both the link and the matching signed-in email.

**You should see:** the invitee's sidebar shrink to the pages their role can view, and the server refuse anything else. Back as owner, change the invitee's role on the Members page — it applies on their next request, no re-login. An organization can never be left without an owner.

## 10. Email settings, notifications and sessions

**Do this:** **Settings → Organization → Email**: the sender name and reply-to for mail the app sends. Then the user menu (top right) → **Account settings**: the **Notifications** tab (a bill awaiting approval, an invitation accepted), **Sessions** (every device you are signed in on; sign out the others), **Password**.

**You should see:** preferences saved per user, not per organization; sessions listed with the current one marked.

## 11. A second organization

**Do this:** the organization name in the top bar → **Add organization**. It has its own setup wizard and its own chart of accounts. Switch between the two from the same menu; **Account settings → Organizations** lists them and lets you leave one.

**You should see:** complete separation — different data, different members, different numbering. This is the same tenant boundary every query in the server is filtered by. Use this organization for anything flagged **⚠** above.

## 12. Bill inbox and email-in *(optional)*

**Needs:** a vision-model key — `ANTHROPIC_API_KEY`, or `CAPTURE_AI_PROVIDER=gemini` plus `GEMINI_API_KEY` — in `server/.env`. Email-in additionally needs `INBOUND_MAIL=brevo` and a Brevo inbound domain (see `docs/development.md`); without it that card says so.

**Do this:** **Purchases → Bill inbox**: upload a photo or PDF of a supplier bill. **Purchases → Review queue** shows what needs a human. **Settings → Bill inbox** has auto-post and the email-in address; **AI usage** shows tokens and cost per call.

**You should see:** a draft expense with the extracted fields; faces and ID numbers are masked in the page image *before* anything leaves your machine. **⚠ posting it changes the answer key** — leave it unposted or use the second organization. Uploading the same file twice lands a visible duplicate that is not re-extracted until you confirm.

## 13. Inventory: labels, QR lookup, movements

**Do this:** **Products & inventory → Stock movements** (the receipts and sales from months 5–6, with cost) and **Stock on hand** (open an item for its history). **Labels**: pick an item and print its QR label. **Lookup**: paste the QR's text, or scan it with a keyboard-wedge scanner.

**You should see:** a label whose QR contains only a route and an id — nothing business-identifying — and Lookup resolving it to the item.

## 14. Reports, theme and the command palette

**Do this:** **Reports → General journal** lists every posting from every source (invoices, bills, bank lines, imports, the accrual) — the ledger as a journal; open any row to its source document. Use the theme button in the top bar (light / dark / system). Press **⌘K** (Ctrl+K elsewhere) and type "trial".

**You should see:** the journal reconcile to the trial balance, the theme switch without a flash, and the palette jump straight to any page you have permission for.
