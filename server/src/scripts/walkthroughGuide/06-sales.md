# Sales

Customers, quotes, sales orders, invoices, credit notes, payments and statements. Everything that issues, pays or
voids changes the demo's answer key, so do those steps in a scratch organization (create a customer and a service in
it first, or import the demo's customers in guide 12).

## 1. Customers

**Where:** **Sales** → **Customers** (`/customers`)

**Do this:**
1. **⚠ scratch org** — open **Customers** and click **New customer**.
2. Fill **Name**, **Email**, **Phone**, **Tax number**, **Billing address**, **Notes** and optionally
   **Default payment terms**, then click **Create customer**.
3. Type part of a name into **Search**; click the **Balance due** header to sort.
4. Click **Deactivate** on the new customer, then **Reactivate**.

**You should see:** the customer in the list with `Active`; after **Deactivate** it shows `Inactive`. The demo has
seven customers (for example {{customer:kestrel-logistics}} and {{customer:rheinwerk}}), each with a **Balance due**.

**Try to break it:**
- Open a customer address with a made-up id → `Customer not found`.
- Look for a **Delete** action on a customer → none; a customer with history can only be deactivated.

- [ ] Done

## 2. A customer's account

**Where:** **Sales** → **Customers** → a customer (`/customers`)

**Do this:**
1. In the demo open {{customer:ferrous-works}} from the list.
2. Read the **Receivable** and **Overdue** tiles, then **Open items** and **Account ledger**.
3. Set **From** and **To** on the ledger, then **Clear**.
4. Open `History & notes` at the bottom, type into the note box and click **Add note**.

**You should see:** **Open items** lists each unpaid invoice with **Number**, **Date**, **Due**, **Days overdue** and
**Outstanding**; the **Account ledger** ends in a **Closing balance** that equals the open-items total and the
**Receivable** tile. A **Statement** button opens the customer's statement (section 10).

**Try to break it:**
- Pick a ledger range with no postings → `No activity in this period.`
- Check the maths: the sum of every customer's **Receivable** equals {{account:1120}} on the trial balance.

- [ ] Done

## 3. Quotes

**Where:** **Sales** → **Quotes** (`/quotes`)

**Do this:**
1. **⚠ scratch org** — open the top-bar **New** menu and choose **Quote**.
2. Choose the customer, add a line, and save the draft; the quote opens at its own page.
3. Click **Send**, choose `Mark as sent — I’ll print or send it myself` (or email it), then click `Mark as sent`.
4. Click **Download PDF** and open the file.
5. Click **Record acceptance**, type **Accepted by (full name)** and confirm with **Record acceptance**.
6. On a second quote, after sending, click **Record decline** (optional **Reason (optional)**) instead.
7. On a sent quote click **Revise**, change a line, then **Send** again.
8. On a sent quote click **Void**, give a **Reason**, and confirm with **Void quote**.

**You should see:** the status pill moving `Draft` → `Sent` → `Accepted`; **Send** allocates the quote number and freezes
this version; an acceptance shows a **Response** panel with **When**, **How**, **Signed by**, **IP address**,
**Browser** and **Content fingerprint**. A revision keeps the number; the older version says `This version was
replaced by a later revision.` An emailed quote lists a link under **Review links** with **Sent to**, **Last viewed**
and **State**; **Revoke** kills it.

**Try to break it:**
- Edit a sent quote → there is no **Edit** after sending; the server refuses with `Only a draft quote can be edited —
  create a revision instead`.
- Delete a sent quote → no **Delete**; the server says `Only a draft quote can be deleted — void it instead`.
- Create a second revision while one is open → `A draft revision of this quote already exists`.
- Send a quote whose valid-until date has passed → `This quote’s validity date has passed — change it before sending`.
- On a quote with a deposit request, click `Convert to invoice` → `This quote asks for a deposit — convert it to an order`.

- [ ] Done

## 4. The customer's review page

**Where:** the emailed review link (`/quote/:token`)

**Needs:** `MAIL_TRANSPORT=mailpit` (or read the link from the worker log) so you can open the emailed link.

**Do this:**
1. **⚠ scratch org** — on a draft quote click **Send**, keep the email option, enter **Email to** and click `Send email`.
2. Open the link from Mailpit (or the worker log) in a private window.
3. On the page choose **Accept**, type **Your full name**, tick the agreement, and click the acceptance button.
4. On another quote, choose **Decline**, add a **Reason (optional)**, and decline.

**You should see:** the quote with the merchant's branding; after acceptance the page shows it answered and the
staff side moves to `Accepted` with a **Response** panel recording your name, time, IP address and browser.

**Try to break it:**
- Reload the accepted link and try to respond again → the page no longer offers **Accept** or **Decline**; the
  server refuses a repeat with `This quote is no longer open for a response`.
- Click **Revoke** under **Review links**, then open the old link → `This quote link is not valid or has expired`.
- Edit the link's token in the address bar → the same `This quote link is not valid or has expired`.

- [ ] Done

## 5. Sales orders

**Where:** **Sales** → **Sales orders** (`/sales-orders`)

**Do this:**
1. **⚠ scratch org** — open the top-bar **New** menu and choose **Sales order**; add a line of quantity `10` and save.
2. Click **Confirm** and confirm with **Confirm order**.
3. Click `Request deposit`, choose **Percentage** or **Amount**, set the figure, and click `Create draft deposit invoice`.
4. Click `Create invoice`, set the first line's quantity to `4`, and click `Create draft invoice`.
5. Click **Close**, then **Reopen**.
6. On another confirmed order click **Cancel order**, give a **Reason**, and confirm with **Cancel order**.

**You should see:** the **Lines** table shows **Ordered**, **Billed** and **Remaining** (`10`, `4`, `6` after step 4);
a **Documents** section lists the deposit and the invoice. An order posts nothing to the ledger; only the invoice
does once issued.

**Try to break it:**
- In step 4 enter a quantity above **Remaining** → `A quantity is more than what remains on its line.` and the
  button stays disabled (the server says `Everything on this order has been billed` once nothing is left).
- Edit a confirmed order → no **Edit**; the server says `Only a draft order can be edited`.
- Cancel an order that still has live invoices → `Void the invoices raised against this order first`.
- Click **Cancel order** without a reason → `A reason is required`.

- [ ] Done

## 6. Invoices from draft to void

**Where:** **Sales** → **Invoices** (`/invoices`)

**Do this:**
1. **⚠ scratch org** — click **New invoice**, choose **Customer**, set **Issue date**, pick **Payment terms** (or enter a
   **Due date**), and add a line with **Description**, **Qty**, **Unit price**, **Account** and **Tax %**.
2. Click **Save draft**.
3. On the draft click **Issue** and confirm with **Issue invoice**.
4. Click **Record payment** (section 9), then try **Void**.
5. After voiding the payment, click **Void** and confirm with **Void invoice**.
6. On an issued invoice click **Make recurring** and complete the dialog.

**You should see:** the draft has no number; issuing allocates one and posts DR {{account:1120}} / CR revenue (plus
tax to {{account:2140}}); the **Journal entry** row links to the posting; **Void** posts a reversing entry shown as
**Void entry**.

**Try to break it:**
- Look for **Edit** on an issued invoice → absent; the server says `Only a draft invoice can be edited`.
- Void an invoice that has a payment → `This document has payments applied. Void the payments first.`
- Void an invoice that has credit notes → `This invoice has credit notes. Void the credit notes first.`
- Void it twice → the button is gone; the server says `This invoice has already been voided`.
- Set **Due date** before **Issue date** → `Due date cannot be before the issue date`.
- Issue a draft with no lines → `An invoice needs at least one line before it can be issued`.

- [ ] Done

## 7. The invoice list

**Where:** **Sales** → **Invoices** (`/invoices`)

**Do this:**
1. In the demo click the tabs **All**, **Draft**, **Awaiting payment**, **Overdue**, **Paid**, **Void**.
2. Set **From** and **To**, type an invoice number into **Search**, then click **Clear filters**.
3. Click the **Total** header twice to sort ascending then descending.
4. Page through the list with the pagination controls under it.

**You should see:** the tab and date filters combine; sorting is done by the server so it covers every page, not just
the visible one; {{doc:I16}} appears under the right tabs for its status.

**Try to break it:**
- Combine **Overdue** with a **From** date in the future → no rows.
- Click **Awaiting payment** and compare its total with the dashboard's `Awaiting payment` figure (guide 03).

- [ ] Done

## 8. Credit notes

**Where:** **Sales** → **Credit notes** (`/credit-notes`)

**Do this:**
1. **⚠ scratch org** — on an issued invoice click **Create credit note**.
2. Reduce a line, save the draft, then click **Issue**.
3. Click **Apply credit**, choose **Apply to**, enter **Amount to apply** (field **Amount**) and click **Apply**.
4. Click **Void** on the credit note and confirm.

**You should see:** issuing posts DR revenue / CR {{account:1120}}; the credit applies automatically to the original
invoice and any remainder shows as **Unapplied credit**; applied amounts list under the note with **Document**,
**Date** and **Amount**.

**Try to break it:**
- Credit more than the invoice total → `Credit notes against this invoice would exceed the invoice total`.
- Apply more than the note has left → `Amount exceeds the credit still available on this credit note`.
- Apply more than the invoice still owes → `Amount exceeds the amount still due on this invoice`.
- Create a credit note against a draft invoice → `Only an issued invoice can be credited`.
- Edit an issued note → no **Edit**; the server says `Only a draft credit note can be edited`.

- [ ] Done

## 9. Payments

**Where:** **Sales** → **Payments** (`/payments`)

**Do this:**
1. **⚠ scratch org** — on an issued invoice click **Record payment**; the dialog is titled `Record a receipt`.
2. Choose **Cash / bank account**, **Date**, **Amount**, optionally **Method** and **Reference**, and click **Record**.
3. Open **Payments**, set **Direction** to `Receipts`, then **Status** to `Posted`.
4. Click **Void** on the payment and confirm with **Void payment**.

**You should see:** the invoice's due amount drops by the payment, or to `Paid`; **Direction** `Both` shows receipts
and payments together; a voided payment shows `Void` and the invoice is open again.

**Try to break it:**
- Pay more than the amount due → `Allocation exceeds the amount still due on this document`.
- Choose a header account as **Cash / bank account** → `Account … is a header account and cannot be posted to`.
- Void the same payment twice → the button is gone; the server says `This payment has already been voided`.
- Pay a euro invoice into a dollar account → `A USD payment cannot settle a document in EUR`; record it into
  {{account:1115}} instead (guide 11).

- [ ] Done

## 10. Statements

**Where:** **Sales** → **Statements** (`/statements/customers`)

**Do this:**
1. In the demo open **Statements** in the **Sales** group.
2. Tick `Select all` and click **Print** (it shows `Print (n)`); close the print view.
3. Open one customer's statement; switch the radio between **Outstanding** and **Activity**; change **As at**.
4. Click **Email**, choose an **Email template**, read the preview and click **Send**.
5. Open **Vendor statements** in the **Purchases** group and repeat steps 2–3.

**You should see:** the list shows each customer's **Outstanding**, **Overdue** and **Last sent**; the **Outstanding**
statement lists open items as at the date and its total equals the customer's ledger closing balance; **Activity**
lists every movement in the period. Sent emails appear under **Emailed** with a **Revoke** button for the link.

**Try to break it:**
- Click **Revoke** on an emailed link, then open it → the customer sees a link that is no longer valid.
- Toggle `Show zero balances` → customers with nothing owing appear or disappear.
- Send as a member without the statements permission → **Email** is not offered at all.

- [ ] Done

## 11. Templates, terms and emails

**Where:** **Settings** → **Sales** (`/settings`)

**Do this:**
1. Open **Settings**, then **Invoicing** in the **Sales** card; read **Numbering** (**Prefix**, **Digits**, **Next**),
   **Quotes**, **Defaults** (**Default due days**, **Default tax rate %**, **Tax label**) and the account selects.
2. Open **Invoice template**: choose `Classic`, `Modern` or `Compact`, change **Document title**, **Accent colour**,
   tick or untick **Show on invoice** options, edit **Bank details** and **Footer notes**, and watch the live preview.
   Click **Save**, or **Discard changes**.
3. Open **Statement template** and do the same.
4. Open **Payment terms**, click **New payment term**, enter **Code** `NET_21`, **Name** `Net 21` and a **Rule**.
5. Open **Quote emails** and **Statement emails**; click **Customize a copy** on a built-in template, edit **Subject**
   and **Message**, and read the `Preview`.

**You should see:** `Saved.` after each save; an `Unsaved changes` marker while editing; the preview changes as you
type; built-in templates are marked `Built-in` and cannot be edited, only copied.

**Try to break it:**
- Blank the **Document title** on a template → `Document title cannot be blank.`
- Type a made-up name wrapped in double curly braces into an email template and save → `Unknown placeholder: …`
  followed by the name you typed.
- Un-default the only default email template → `Make another template the default instead of un-defaulting this one`.

- [ ] Done

## 12. Online payments (optional)

**Where:** **Settings** → **Sales** → **Online payments** (`/settings/online-payments`)

**Needs:** Stripe test keys `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` and `STRIPE_WEBHOOK_SECRET` in
`server/.env`, and the server and worker restarted.

**Do this:**
1. Open **Online payments** and tick `Offer card payment on emailed customer statements`.
2. Choose the account for **Deposit card payments into** and save.
3. Email a statement to yourself (section 10) and open its link.
4. Tick the invoices to pay, click `Pay by card`, and pay with test card `4242 4242 4242 4242`, any future expiry and
   any CVC.

**You should see:** a receipt recorded against the chosen invoices and the invoice marked `Paid`; the page warns
`Card payments are not configured on this server (Stripe keys are missing)` when the keys are absent.

**Try to break it:**
- Pay with the declining test card `4000 0000 0000 0002` → Stripe refuses it and nothing is recorded.
- A payment that cannot be applied cleanly lands under **Online payments to review** on the statement page instead of
  being lost.

- [ ] Done
