# Purchases

Vendors, purchase quotes and orders, expenses and debit notes. The product calls a vendor bill an **Expense**; the
address `/bills/…` still works as an alias. Anything that approves, pays or voids changes the demo's answer key, so
do those steps in a scratch organization (create a vendor and an expense account in it first, or import the demo's
vendors in guide 12).

## 1. Vendors

**Where:** **Purchases** → **Vendors** (`/vendors`)

**Do this:**
1. **⚠ scratch org** — open **Vendors** and click **New vendor**.
2. Fill **Name**, **Email**, **Phone**, **Tax number**, **Default payment terms**, **Payment notes**,
   **Billing address** and **Notes**, then click **Create vendor**.
3. Type part of a name into **Search**; click the **Balance due** header to sort.
4. Click **Deactivate** on the new vendor, then **Reactivate**.
5. In the demo open Ironclad Supply Co from the list to see its open items and account ledger (the same
   page layout as a customer, guide 06 section 2).

**You should see:** the vendor in the list with `Active`; after **Deactivate** it shows `Inactive`. The **Balance due**
column adds up to `2100 Accounts Payable` on the trial balance.

**Try to break it:**
- Open a vendor address with a made-up id → the page says `Vendor not found`.
- Look for a delete action on a vendor → none; a vendor with history can only be deactivated.

- [ ] Done

## 2. Purchase quotes

**Where:** **Purchases** → **Purchase quotes** (`/purchase-quotes`)

A purchase quote is a vendor's offer you have recorded. It behaves like a sales quote (guide 06 section 3) except that
converting it creates an expense or a purchase order. A quote never posts to the ledger.

**Do this:**
1. **⚠ scratch org** — click `New purchase quote`, choose the vendor, add a line and save the draft.
2. Click **Send**, choose `Mark as sent — I’ll print or send it myself`, then click `Mark as sent`.
3. Click **Record acceptance**, type the name, and confirm with **Record acceptance**.
4. Click `Convert to expense`. The dialog offers `Create a draft expense` and `Create a purchase order`.
5. With `Create a draft expense` chosen, set **Expense date** and **Vendor’s invoice no.**, then click
   `Create draft expense`.
6. On another accepted purchase quote repeat steps 4 and 5 but choose `Create a purchase order` and click
   `Create purchase order`.

**You should see:** the draft expense opens with `From quote` and the quote number under its heading; the
purchase order opens already confirmed, with the same lines. The quote cannot be converted a second time.

**Try to break it:**
- Click `Create draft expense` with **Vendor’s invoice no.** empty → the button stays disabled.
- Convert to an expense using a vendor reference you already used for that vendor → `A bill with this vendor reference already exists — enter the vendor’s invoice number`.
- Edit a sent quote → there is no **Edit**; the server refuses with `Only a draft quote can be edited — create a revision instead`.

- [ ] Done

## 3. Purchase orders and prepayments

**Where:** **Purchases** → **Purchase orders** (`/purchase-orders`)

**Do this:**
1. **⚠ scratch org** — click `New purchase order`, choose the vendor, add a line of quantity `10`, and save.
2. Click **Confirm** and confirm with **Confirm order**.
3. Click `Record prepayment`, choose **Percentage** or **Amount**, set the figure, and click
   `Create draft prepayment bill`. Approve that expense from its page.
4. Click `Create expense`, set the first line's quantity to `4`, and click `Create draft expense`.
5. Click **Close**, then **Reopen**.
6. On another confirmed order click **Cancel order**, give a reason, and confirm with **Cancel order**.

**You should see:** the **Lines** table shows **Ordered**, **Billed** and **Remaining** (`10`, `4`, `6` after step 4); the
prepayment expense carries a `Deposit` badge. An order posts nothing to the ledger; only the approved expense does.
`Record prepayment` is offered only on orders in your base currency.

**Try to break it:**
- In step 4 enter a quantity above **Remaining** → `A quantity is more than what remains on its line.`
- Edit a confirmed order → no **Edit**; the server says `Only a draft order can be edited`.
- Cancel an order that still has live expenses → `Void the invoices raised against this order first`.
- Edit a prepayment expense → the server says `A prepayment bill cannot be edited. Delete it and record a new prepayment from the order.`

- [ ] Done

## 4. Entering an expense

**Where:** **Purchases** → **Expenses** (`/expenses`)

**Do this:**
1. **⚠ scratch org** — click `New expense`.
2. Choose **Vendor**, optionally **Purchase order**, type **Vendor reference**, set **Expense date**, **Payment terms**
   (or **Due date**) and **Currency**.
3. Add a line: **Item** (optional), **Description**, **Qty**, **Unit price**, **Account** and **Tax %**.
4. Under **Attachments** click `Choose from Documents` and pick a file from the vault (guide 16), or upload one.
5. Click **Save draft**.
6. In the list, click **Duplicate** on any row; the form opens pre-filled.

**You should see:** the new expense under **Draft** (the form header says it is saved as a draft until you approve it); the list tabs are **All**, **Draft**,
**To review**, **Awaiting payment**, **Overdue**, **Paid** and **Void**, with sortable headers and **Search**.

**Try to break it:**
- Save with no lines → `A bill needs at least one line`.
- Set **Due date** before **Expense date** → `Due date cannot be before the bill date`.
- Save a second expense with the same **Vendor reference** for the same vendor → `This vendor reference has already been entered for this vendor`.
- Use a reference such as `RENT-[Month]` on two drafts → both save, because the placeholder is filled only when
  the expense is approved.

- [ ] Done

## 5. Review, approve, pay and void

**Where:** **Purchases** → **Expenses** → an expense (`/expenses`)

**Do this:**
1. **⚠ scratch org** — on a draft click **Submit for review**; the status becomes `Awaiting approval`.
2. Click **Approve**. If the vendor has open debit notes or prepayments, a dialog titled
   `Approving posts this expense.` lists them; click **Approve and apply** (or **Approve only**). Otherwise confirm
   with **Approve expense**.
3. Click **Record payment**, fill the dialog and save (the same dialog as guide 06 section 9, titled for a payment).
4. On another posted expense with an amount due click **Apply prepayment**, choose the **Prepayment bill**, set
   **Amount to apply** and **Application date**, and save.
5. Click **Make recurring** on a draft and complete the dialog (guide 05 section 5 shows the schedule).
6. Void a posted expense with **Void** and confirm with **Void expense** — after voiding its payments first.

**You should see:** approving posts a balanced entry against `2100 Accounts Payable` and shows a **Journal entry** link;
**Paid** and **Amount due** update after payment; a void shows a **Void entry** link and the status `Void`.

**Try to break it:**
- Look for **Approve** on a draft that was never submitted → absent; the server refuses with `A bill that is DRAFT cannot be approved`.
- Void an expense that has a payment → `This document has payments applied. Void the payments first.`
- Void an expense that has debit notes → `This bill has debit notes. Void the debit notes first.`
- Void a bill whose received stock has since been sold (guide 10 section 2) → `Stock received on this bill has since been issued: only … remain at location …`.
- Void twice → the button is gone; the server says `This bill has already been voided`.
- Look for **Edit** on a posted expense → absent; the server says `Only a draft or in-review bill can be edited`.

- [ ] Done

## 6. Debit notes

**Where:** **Purchases** → **Debit notes** (`/debit-notes`)

**Do this:**
1. **⚠ scratch org** — on a posted expense click **Create debit note**.
2. Reduce a line, save the draft, then click **Issue** and confirm with `Issue debit note`.
3. Click **Apply credit**, choose **Apply to**, enter **Amount** and click **Apply**.
4. Click **Void** and confirm with `Void debit note`.

**You should see:** issuing posts DR `2100 Accounts Payable` / CR expense (and tax); the debit applies automatically to the
original expense, and any remainder is unapplied credit. The expense page lists the note under `Debit notes`.

**Try to break it:**
- Debit more than the expense total → `Debit notes against this bill would exceed the bill total`.
- Apply more than the note has left → `Amount exceeds the credit still available on this debit note`.
- Apply more than the expense still owes → `Amount exceeds the amount still due on this bill`.
- Create a debit note against a draft expense → `Only an approved bill can be debited`.
- Edit an issued note → no **Edit**; the server says `Only a draft debit note can be edited`.

- [ ] Done
