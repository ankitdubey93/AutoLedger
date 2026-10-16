# Month 6 — closing the quarter

## What month 6 is about

The last month finishes what month 5 started and then **closes the books**: the recurring rent arrives as a draft, the rest of August's order is invoiced with the customer's deposit applied, a new vendor is added by form, two files of bills and invoices and a payroll journal are *imported* instead of typed, and August is locked.

## 1. A new vendor, by hand

**Purchases → Vendors → New vendor.** Lakeshore Power & Water is not in `vendors.csv` — it is the one party you add with the form, the way you would for a supplier who turns up mid-year:

| Field | Value |
|---|---|
| Name | Lakeshore Power & Water |
| Email | billing@lakeshorepw.example |
| Phone | +1-555-0488 |
| Billing address | 60 Harbor Utility Way, Sandusky, OH 44870 |
| Tax number | US-34-6620118 |

Leave payment terms and notes blank — the bills below carry explicit due dates. The vendor must exist **before** the bill import in section 3: an import matches its *ContactName* column against existing vendors by name.

## 2. Approve the generated rent — B15

**Accounting → Recurring → Shop rent.** The schedule made in month 5 is due now. If the worker has not already created the draft, press **Run now** — it creates exactly one bill, dated 2026-09-01. Open it from the schedule's run list (or **Purchases → Expenses**) and check three things:

- the line reads "Shop rent — [Month]" — the placeholder is still there, because a draft keeps the text as written;
- the amount is 9,100.00 to 6110 Rent & Utilities, due the same day;
- its vendor reference carries the run date (the schedule adds it to B14's reference so the two bills cannot clash). Replace it with `NR-RENT-September`, the number on the landlord's September invoice — it is a draft, so it is editable.

**Submit for approval → Approve.** Now open the posted bill: the line reads **"Shop rent — September"**. `[Month]` was replaced with the month of the *document date* at the moment of approval — which is why a recurring bill can be written once and read correctly every month. Nothing is replaced in a draft, and nothing placeholder-shaped can reach a posted document.

## 3. Import the documents — and the payroll journal

Three more imports through **Accounting → Imports → New import**. The two document imports offer a choice on the preview screen: **Import as drafts** or **Import and post**. Choose **Import and post** with **Each document's own date** — the files arrive as finished, dated documents, exactly like the ones you typed in months 1–5. (To review before anything posts, import as drafts instead and issue them yourself.)

### Invoices — `invoices-month-6.csv` (kind **Invoices**)

Creates and issues I18 and I19. Only the item code, description and quantity are given: the **unit price and revenue account come from the Products & services record** (`SVC-DES` 110.00, `SVC-FAB` 85.00, both to 4200). That is the practical reason to import products first.

```csv
*ContactName,*InvoiceDate,DueDate,ItemCode,*Description,Quantity,UnitAmount,AccountCode
Brightline Analytics,2026-09-04,2026-09-04,SVC-DES,Design & drafting — conveyor retrofit,24,,
Orchid Media Group,2026-09-11,2026-09-11,SVC-FAB,Fabrication labour — studio set build,40,,
```

Expect I18 2,640.00 and I19 3,400.00.

### Expenses — `bills-month-6.csv` (kind **Expenses (bills)**)

Creates and approves B16, B17, B18. Unlike the invoices these carry their own unit amount and account, because a supplier's bill has no catalogue price behind it. Text in an imported document is taken **literally** — the file already says "September" where the typed bills said `[Month]`; a placeholder in an imported file would not be replaced.

```csv
*ContactName,*InvoiceNumber,*InvoiceDate,DueDate,*Description,Quantity,UnitAmount,AccountCode
Lakeshore Power & Water,LPW-88120,2026-09-08,2026-09-08,Electricity & water — August usage,1,850.00,6110
Cloudspan Infrastructure,CS-46102,2026-09-10,2026-09-10,ERP hosting — September,1,3480.00,6120
Crosswind Freight,CWF-1187,2026-09-15,2026-09-15,Outbound freight — September runs,1,1240.00,5300
```

### Payroll — `payroll-month-6.csv` (kind **Journal entries**)

Three rows with the same journal number are **one** entry; it posts immediately and cannot be edited (correct it with a reversal, as always):

```csv
JournalNumber,*Date,*Narration,*AccountCode,Debit,Credit
PR-M6,2026-09-25,Payroll — September 2026,5200,9800.00,
PR-M6,2026-09-25,Payroll — September 2026,6100,3200.00,
PR-M6,2026-09-25,Payroll — September 2026,2160,,13000.00
```

| Account | Debit | Credit |
|---|---|---|
| 5200 Direct Labor | 9,800.00 |  |
| 6100 Salaries & Wages | 3,200.00 |  |
| 2160 Payroll Liabilities |  | 13,000.00 |

The wages are expensed (shop-floor labour to cost of sales, the rest to operating expenses) and the whole 13,000.00 is owed — to employees and, for the part withheld from their pay, to tax authorities — until it is paid. When the bank line for net pay arrives (section 5) it clears only 11,400.00 of that liability; the remaining **1,600.00** stays in `2160 Payroll Liabilities` until it is remitted. (A simplification: real payroll also has employer-side taxes and benefits, which are out of scope here.)

## 4. Invoice the rest of the order — I20, with the deposit applied

Open **Sales → Sales orders → SO1**: billing reads **Partly billed**. **Create invoice** — leave every quantity at what remains (CAST-6 60, HFK-12 40, SVC-FAB 16), document date 2026-09-22, due date **2026-10-22** (30 days). Open the draft and **Issue** it. Because Kestrel Logistics has an open deposit, the dialog **offers it**: choose D1 and apply **4,090.00**, then confirm. (If you issued without applying it, the invoice page has an **Apply deposit** button.)

Issuing posts the sale and the cost of the stock sold, exactly as for I17:

| Account | Debit | Credit |
|---|---|---|
| 1120 Accounts Receivable | 8,860.00 |  |
| 4100 Product Revenue |  | 7,500.00 |
| 4200 Service Revenue |  | 1,360.00 |

| Account | Debit | Credit |
|---|---|---|
| 5050 Cost of Sales — Inventory | 3,260.00 |  |
| 1140 Inventory |  | 3,260.00 |

Applying the deposit posts one more entry — the liability is settled against the receivable:

| Account | Debit | Credit |
|---|---|---|
| 2130 Customer Deposits | 4,090.00 |  |
| 1120 Accounts Receivable |  | 4,090.00 |

This is where the deposit *stops being a liability*: revenue is recognised on the invoice, for the full 8,860.00 above, and the 4,090.00 the customer already paid now settles that much of it. `2130 Customer Deposits` returns to zero, and the invoice shows amount due **4,770.00**. This invoice stays open: it is not paid inside the scenario, and it is not yet due (2026-10-22), so it sits in the **Current** aging bucket.

> **Hint:** the stock was already costed at the moving average when I17 was issued and nothing was bought since, so I20's cost of sales is the same unit costs again.

## 5. Import statement 6

`statements/month-6-meridian-DMY.csv` (date format **DMY**) — see `06-bank-statements.md` for every line. The fee and interest lines are settled by your month 5 bank rules on import. The net-pay line, `PAYROLL NET PAY` -11,400.00, has no document behind it: **Post journal → 2160 Payroll Liabilities**, which clears the net pay against the liability the payroll journal created. I19 (Orchid Media Group) is paid through a card processor and shows as `STRIPE PAYOUT 7731`: the memo carries no customer name, so the matcher can only suggest on the amount (3,400.00) — check it, then match it yourself.

## 6. Check your work

**Inventory.** *Products & inventory → Valuation*, as of 2026-09-30: the stock subledger and `1140 Inventory` both read **7,430.00**, the page says they tie out. Two different records — what the warehouse says it holds and what the ledger says it is worth — agreeing is the whole point of perpetual inventory.

**The customer.** *Sales → Statements → Kestrel Logistics* → **Outstanding**, as at 2026-09-30: **4,770.00**, which is I20 (8,860.00) less the applied deposit (4,090.00).

**The numbers the answer key insists on:**

| Account / report | At 2026-09-30 |
|---|---|
| 1140 Inventory | 7,430.00 |
| 2130 Customer Deposits | 0.00 |
| 2120 Accrued Liabilities | 850.00 |
| 2160 Payroll Liabilities | 1,600.00 |
| 1120 Accounts Receivable (all of it I20) | 4,770.00 |
| 2100 Accounts Payable | 0.00 |
| 5050 Cost of Sales — Inventory (cumulative) | 6,520.00 |

Compare the rest with `07-expected-results.md` → Month 6.

## 7. Close August and try to break it

**Accounting → Fiscal periods → Close** on the August period. Now try to post something into it: **Accounting → Manual journals → New**, dated 2026-08-15, any two balanced lines, **Post**. AutoLedger refuses — the period is closed. (The Reports are now stable too: a late entry can no longer change a month you have already reported.) Nothing should be saved; if a draft is left behind, delete it. Closing is reversible — **Reopen** exists — whereas a *locked* period is not; this scenario only closes.

That is the quarter: six months, every ledger figure agreeing with `07-expected-results.md`.
