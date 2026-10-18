# Reports

Every report is computed from ledger lines on each request, and every report except the general journal has an
**Export** menu with `PDF`, `Excel (.xlsx)` and `CSV`. Reading reports changes nothing, so do this guide on the demo
organization. For each report, export all three formats once and open the files: the totals must equal the screen.
Dates below use the demo, whose months run March to September.

## 1. Reports index and business snapshot

**Where:** **Reports** → **Reports** (`/reports`)

**Do this:**
1. Open **Reports** and read the groups `Overview`, `Financial statements`, `Receivables & payables`,
   `Sales & purchases`, `Tax` and `Ledger`.
2. Open **Business snapshot** and choose **Period** `This month`, `This quarter`, `Year to date` or `Custom`
   (then **From** and **To**).
3. Read **Revenue**, **Cost of sales**, **Gross profit**, **Gross margin**, **Net worth** and **Working capital**, the
   `Ratios` table (**Current** against **Prior period**) and the 12-month trend.
4. Click **Export** and choose each format.

**You should see:** every figure beside the prior period; a ratio whose denominator is zero or negative shows no
value and says why on hover, instead of a misleading number.

**Try to break it:**
- Set **To** before **From** → `from must not be after to`.
- Choose `Custom` with an empty **From** → no report loads until both dates are set.

- [ ] Done

## 2. Profit and loss

**Where:** **Reports** → **Profit & loss** (`/reports/profit-and-loss`)

**Do this:**
1. Set **From** 2026-09-01 and **To** 2026-09-28.
2. Choose **Compare** `Previous periods` and set **Periods**; then try `Same period last year`.
3. Export.

**You should see:** `Revenue`, `Cost of sales`, `Gross profit`, `Operating expenses` and `Net income`, with
**Change** and **Change %** columns when comparing. September's net income alone is `22,236.60`.

**Try to break it:**
- Set **To** before **From** → `from must not be after to`.
- Compare against a year with no data → the earlier columns show zeros, not an error.

- [ ] Done

## 3. Balance sheet and trial balance

**Where:** **Reports** → **Balance sheet** (`/reports/balance-sheet`)

**Do this:**
1. Set **As at** to 2026-09-28 on the balance sheet.
2. Read `Retained earnings (prior years)` and `Current period earnings`.
3. Open **Trial balance** (`/trial-balance`), tick `Hide accounts with no activity`, and click an account type to
   filter; then `Clear filter`.
4. Export both.

**You should see:** `Assets equal liabilities plus equity exactly.` and `Debits equal credits exactly.`; the
trial balance shows `1115 EUR Receipts Account` `11,000.00` and `2140 GST/VAT Output Payable` `795.00` for September.

**Try to break it:**
- Set **As at** before the books start → every balance is `0.00`, and the equation still holds.

- [ ] Done

## 4. Cash flow statement

**Where:** **Reports** → **Cash flow statement** (`/reports/cash-flow`)

**Do this:**
1. Set **From** 2026-09-01 and **To** 2026-09-28.
2. Read `Operating activities`, `Investing activities`, `Financing activities`, `Net change in cash`,
   `Cash at beginning of period` and `Cash at end of period`, then the `Cash accounts` table.
3. Export.

**You should see:** net cash from operating `13,656.60`, investing `-6,000.00` and financing `6,000.00` for
September; the net change equals the change in `1110 Operating Cash` plus `1115 EUR Receipts Account` over the same dates.

**Try to break it:**
- Set **To** before **From** → `from must not be after to`.
- Compare the net change with the **Cash accounts** table → they agree to the cent.

- [ ] Done

## 5. Aged receivables and payables

**Where:** **Reports** → **Aged receivables** (`/reports/aged-receivables`)

**Do this:**
1. Open **Aged receivables**, then **Aged payables** (`/reports/aged-payables`); set **As at** to 2026-09-28.
2. Read the buckets `Current`, `1–30`, `31–60`, `61–90` and `90+` per customer or vendor, and the **Total**.
3. Read the banner above the table.
4. Export.

**You should see:** `Agrees with 1120 Accounts Receivable` when the subledger ties to the control account. After the
month-7 revaluation the receivables total can differ from `1120 Accounts Receivable` by the revaluation amount (`65.00`):
aging values open invoices at their own frozen rate, and the revaluation reverses on 2026-10-01. That gap is
expected (guide 11 section 3).

**Try to break it:**
- Move **As at** before an invoice's date → the invoice drops out of the buckets.
- Compare the **Total** with the sum of every customer's balance (guide 06 section 2) → they agree.

- [ ] Done

## 6. Sales and purchases reports

**Where:** **Reports** → **Sales by customer** (`/reports/sales-by-customer`)

**Do this:**
1. Open **Sales by customer**, **Sales by item**, **Purchases by vendor** and **Purchases by item** from **Reports**.
2. Set **From** and **To**, and choose **Compare** `Previous period` or `Same period last year`.
3. Read **Net**, **Tax**, **Gross**, **Documents** and **Change**; on item reports also **Code** and **Quantity**.
4. Export.

**You should see:** item reports note that item totals are allocated per line and can differ from the ledger by
rounding cents, and that credit and debit notes appear under `No item`.

**Try to break it:**
- Set **To** before **From** → `from must not be after to`.

- [ ] Done

## 7. Account transactions and the general journal

**Where:** **Reports** → **Account transactions** (`/reports/account-transactions`)

**Do this:**
1. Open **Account transactions**; click a preset such as `This month`, or set **From** and **To**.
2. Open the account picker (`All accounts`), tick `1110 Operating Cash` and use `Clear` to reset.
3. Choose **Group by** `Account`, `Source` or `Contact`, switch `Detail` and `Summary`, and open **Columns** to tick
   `Balance`, `Reference`, `Contact` and the foreign-currency columns.
4. Export, then open **Reports** → **General journal** (`/reports/general-journal`), filter by **Account** and
   **Search description**, and click `Clear filters`.

**You should see:** an `Opening balance` row per group and a running balance; the general journal lists every
posting from every source with `Posted`, `Reversed` and `Reversal` pills and a link to each entry.

**Try to break it:**
- Pick a range with no postings → `No transactions in this range`.
- Set **To** before **From** → `from must not be after to`.

- [ ] Done

## 8. Ledger exceptions

**Where:** **Reports** → **Ledger exceptions** (`/reports/exceptions`)

**Do this:**
1. **⚠ scratch org** for the review steps — open **Ledger exceptions** and set **From** and **To**.
2. Toggle the checks `Unusual amount`, `Unexpected debit or credit`, `Non-default tax rate` and `Possible duplicate`;
   each shows its open count.
3. Click **Mark reviewed** on a row, type a **Note** and click **Save**.
4. Tick `Show reviewed`, then click **Reopen** on the reviewed row.
5. Export.

**You should see:** each exception with **Date**, **Check**, **Account**, **Document**, **Expected**, **Actual** and
**Reason**; a reviewed one reads `Reviewed by` and the reviewer's name and stays hidden until you tick `Show reviewed`.

**Try to break it:**
- Set a range of 400 days → `The exception report covers at most 366 days`.
- Untick every check → `Select at least one check`.
- Set **To** before **From** → `from must not be after to`.

- [ ] Done
