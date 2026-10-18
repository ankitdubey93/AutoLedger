# Currency and tax

Month 7 of the walkthrough (`11-currency-tax-and-journals.md` in the parent folder) walks the euro customer, the
rates, the realized gain and the month-end revaluation as a scored scenario. This guide covers the screens around
it. The demo already holds the month-7 rates ({{date:7:1}} `1.08`, {{date:7:16}} `1.10`, month end `1.09`), the euro
invoices {{doc:I21}} and {{doc:I22}}, and one posted revaluation. Anything that posts changes the answer key, so do
the posting steps in a scratch organization.

## 1. Exchange rates

**Where:** **Accounting** → **Exchange rates** (`/fx-rates`)

**Do this:**
1. In the demo open **Exchange rates** and read the table: **From**, **To**, **Date**, **Rate**, **Source**.
2. **⚠ scratch org** — click **New rate**, choose **From currency** `EUR` and **To currency** your base currency,
   set **Rate date** and **Rate** (for example `1.08000000`), and click **Save rate**.
3. Click **Delete** on a rate and confirm with **Delete**.

**You should see:** the rate in the list with its source; deleting says that documents and payments already posted
keep the rate they used.

**Try to break it:**
- Enter `0` or `abc` as **Rate** → `Rate must be a positive number no greater than 1,000,000`.
- Choose the same currency for **From currency** and **To currency** → `A currency cannot have a rate against itself`.
- Create a euro invoice dated before the first rate → `No exchange rate for EUR to USD on or before …` followed by the date.

- [ ] Done

## 2. A euro document and its receipt

**Where:** **Sales** → **Invoices** (`/invoices`)

**Do this:**
1. **⚠ scratch org** — enter the rates from section 1, then create a customer and a euro invoice (set **Currency**
   to `EUR`) and issue it (guide 06 section 6).
2. Open a bank account for euros: **Accounting** → **Chart of accounts** → add `1115`, with the bank field set to
   `Bank account` (guide 04).
3. On the invoice click **Record payment**, choose that account under **Cash / bank account**, set **Amount** and
   click **Record**, with the **Date** on a day whose rate differs from the invoice date's.

**You should see:** the receipt is in euros; the difference between the invoice's frozen rate and the receipt-day
rate posts to {{account:4910}} (gain) or {{account:6810}} (loss).

**Try to break it:**
- Pay the euro invoice into a dollar account → `A USD payment cannot settle a document in EUR`.
- Look for a bank-line suggestion for a euro invoice (guide 09) → none is offered, because statements are in the
  base currency.
- Request a deposit on a euro sales order → there is no `Request deposit` button; the server says `Deposits are available on base-currency orders only`.

- [ ] Done

## 3. FX exposure and revaluation

**Where:** **Accounting** → **FX exposure** (`/fx-exposure`)

**Do this:**
1. In the demo open **FX exposure** and set **As of** to the last day of {{month:7}}.
2. Read the currency totals (**Outstanding**, **Carrying value**, **Revalued value**, **Delta**) and the document
   rows (**Document rate**, **Revaluation rate**).
3. **⚠ scratch org** — with an open euro invoice, set **As of** to the month end and click **Post revaluation**,
   then confirm with **Post revaluation**.
4. Open **Revaluations** and expand the row; follow **Entry** and **Reversal**.

**You should see:** in the demo `This date has already been revalued.` with a link to **Revaluations**, whose single
row has a **Total delta** of `-65.00`. In your scratch org an entry dated the as-of date moves the open euro
balance through {{account:6820}} and an automatic reversal posts the next day. The aged receivables total then
differs from {{account:1120}} by that amount until the reversal (guide 14 section 9).

**Try to break it:**
- Revalue the same date twice → the button is gone; the server says `A revaluation already exists for this date`.
- Revalue a date with no open foreign balance → `There is no open foreign-currency balance to revalue on this date`.
- Look for a way to edit or delete a revaluation → none; the dialog says `There is no undo — a wrong revaluation is corrected by posting the next one, not by editing this one.`

- [ ] Done

## 4. Accounts and tax settings

**Where:** **Settings** → **Accounting** → **Financial** (`/settings/financial`)

**Do this:**
1. **⚠ scratch org** — open **Settings**, then **Financial** in the **Accounting** card.
2. Under `Default posting accounts` find **Realized FX gain account**, **Realized FX loss account** and
   **Unrealized FX account**; change one and click **Save**.
3. Open **Invoicing** in the **Sales** card; set **Default tax rate %** and **Tax label**, then **Save**.
4. Create an invoice and read the **Tax %** column default.

**You should see:** `Saved.` after each save, and new invoice lines starting at the default tax rate.

**Try to break it:**
- Give a line a tax rate above `100` → `Tax rates must be a percentage between 0 and 100` on the product form.
- Pick a header account as a posting account → `Account … is a header account and cannot be posted to`.

- [ ] Done

## 5. Tax summary

**Where:** **Reports** → **Tax summary** (`/reports/tax-summary`)

**Do this:**
1. In the demo open **Reports** and then **Tax summary**.
2. Set **From** {{date:7:1}} and **To** {{date:7:28}}.
3. Read `Output (sales)`, `Input (purchases)` and **Net tax payable**, and the line `Reconciles to the general ledger` under each.

**You should see:** output tax `795.00`, input tax `240.00` and net tax payable `555.00`; each direction shows its
control account ({{account:2140}} and {{account:1180}}) with **Difference** `0.00`.

**Try to break it:**
- Set **To** before **From** → `from must not be after to`.
- Pick a month with no tax-bearing documents → both sections are empty and the difference is still `0.00`.

- [ ] Done
