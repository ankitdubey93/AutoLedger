# Month 5 — products, stock, orders and automation

## What month 5 is about

Months 1–4 sold services and expensed everything. Month 5 gives Harbor Point something to **stock**: Heavy-duty caster, 6 in (`CAST-6`) and Hydraulic fitting kit (`HFK-12`). It buys them on a purchase order, sells them on a quote that becomes a sales order, takes a customer deposit before shipping, invoices the order in two deliveries, and lets AutoLedger do the repetitive bookkeeping for it — a bank rule for the monthly fee and interest, a recurring rent bill, and a utilities accrual that reverses itself.

Several steps this month post **nothing**: a purchase order, a quote and a sales order are all promises, not transactions. A bill or an invoice posts; stock and cost of sales follow the document. Work through the sections in order — each one builds on the one before.

## 1. Import the catalogue

**Accounting → Imports → New import.** Two files, in this order.

**Products & services** — `products.csv`: the two services Harbor Point bills by the hour. Kind **Products & services**. Both rows should stage as `VALID`; commit reads "Committed: 2 created, 0 filled in."

```csv
*ItemCode,*ItemName,Type,Description,SalesUnitPrice,SalesAccount,SalesTaxRate,PurchasesUnitPrice,PurchasesAccount,PurchasesTaxRate
SVC-FAB,Fabrication labour (per hour),Service,Shop-floor fabrication labour,85.00,4200,0,,,
SVC-DES,Design & drafting (per hour),Service,CAD design and drafting,110.00,4200,0,,,
```

**Set inventory up first.** The stock items below carry the category `SPR` (Stores & spares), which is created by the **Manufacturing** industry template. If you did not choose it in the setup wizard, do it now: **Settings → Inventory → Industry template** (the `/inventory/setup` page) → **Manufacturing**. The importer refuses a category that does not exist yet.

**Inventory items** — `stock-items.csv`: kind **Inventory items**. These are Products & Services that are *tracked* — each is created together with its stock record. There is no opening stock (the last four columns are blank): the shelves start empty and the first purchase fills them. Commit reads "Committed: 2 items created, opening stock posted for 0."

```csv
ItemCode,*ItemName,Description,Category,Unit,Barcode,ReorderPoint,SalesUnitPrice,SalesAccount,SalesTaxRate,PurchasesUnitPrice,PurchasesTaxRate,InventoryAssetAccount,CostOfGoodsSoldAccount,OpeningQuantity,OpeningUnitCost,OpeningLocation,OpeningDate
CAST-6,"Heavy-duty caster, 6 in",Swivel caster with brake,SPR,,,50,95.00,4100,0,42.00,0,1140,5050,,,,
HFK-12,Hydraulic fitting kit,12-piece fitting kit,SPR,,,40,45.00,4100,0,18.50,0,1140,5050,,,,
```

The asset account (`1140 Inventory`) is where the stock sits on the balance sheet; the cost-of-goods-sold account (`5050 Cost of Sales — Inventory`) is where it goes when sold. Check them under **Products & inventory → Products & services** — all four codes should be listed. Nothing has posted: importing a catalogue creates records, not journal entries.

## 2. Create the bank rules

**Banking → Bank rules → New rule.** A bank rule settles a bank line you would otherwise post by hand, using the same "Post journal" path as months 1–4. It is applied automatically as a statement is imported (and on demand with **Apply to unmatched lines**). Two rules:

| Name | Priority | Direction | Memo contains | Max amount | Bank account | Post to | Journal description |
|---|---|---|---|---|---|---|---|
| Monthly bank service charge | 100 | Money out | `SERVICE CHARGE` | 100.00 | 1110 Operating Cash | 6600 Bank Fees | Bank service charge |
| Interest on operating account | 110 | Money in | `INTEREST PAID` | — | 1110 Operating Cash | 4300 Interest Income | Bank interest |

Create them **before** importing statement 5. Two things worth knowing: a rule never overrides a document match — if a line has a document suggestion at or above the auto-match threshold, the suggestion wins; the rule only takes lines that would otherwise stay unmatched. And the *maximum amount* (100.00) on the fee rule is a safety limit — a large withdrawal that merely mentions "service charge" is left for a human.

## 3. Buy the stock — PO1 → B13

**Purchases → Purchase orders → New.** Vendor **Ironclad Supply Co**, order date 2026-08-03. Pick each line from the item picker (type the code):

| # | Item code | Description | Qty | Unit price | Account |
|---|---|---|---|---|---|
| 1 | `CAST-6` | Heavy-duty caster, 6 in | 200 | 42.00 | 1140 Inventory |
| 2 | `HFK-12` | Hydraulic fitting kit | 300 | 18.50 | 1140 Inventory |

Total 13,950.00. **Save**, then **Confirm**. A purchase order is a *commitment*, not a debt: it posts **nothing**. Nothing is owed until the goods are invoiced.

When the supplier's invoice arrives, open the order and choose **Create bill**: bill date 2026-08-05, due date 2026-08-05, vendor's invoice no. `INV-IC-9455`, all lines at the ordered quantities. Open the new draft expense (**Purchases → Expenses**) and take it through **Submit for approval → Approve**. This is **B13** in `04-bills-received.md`.

Approving posts the bill — and, because both lines are stock items, it also **receives the stock**:

| Account | Debit | Credit |
|---|---|---|
| 1140 Inventory | 13,950.00 |  |
| 2100 Accounts Payable |  | 13,950.00 |

The debit goes to `1140 Inventory` (an asset), not to an expense: buying stock is swapping cash for something you still own. Look under **Products & inventory → Stock movements** — one receipt per line, at its purchase cost.

## 4. Sell the stock — QU1 → SO1 → D1 → I17

**Sales → Quotes → New.** Customer **Kestrel Logistics**, quote date 2026-08-06, **Valid until 2027-09-10**, title "Caster and fitting supply with installation". Lines:

| # | Item code | Description | Qty | Unit price | Account |
|---|---|---|---|---|---|
| 1 | `CAST-6` | Heavy-duty caster, 6 in | 120 | 95.00 | 4100 Product Revenue |
| 2 | `HFK-12` | Hydraulic fitting kit | 80 | 45.00 | 4100 Product Revenue |
| 3 | `SVC-FAB` | Fabrication labour (per hour) | 16 | 85.00 | 4200 Service Revenue |

Total 16,360.00. Leave "Deposit on acceptance" **blank** — this tutorial raises the deposit from the order instead (a deposit set on the quote would be dated today and locked against edits).

> **Hint:** *Valid until* is deliberately far in the future (a year and a bit). A quote's validity is checked against **today's real date**, not the date you typed as the quote date — and this scenario's dates are in the past. A normal 30-day quote would already have expired and could not be accepted.

Save, then **Send** → choose **Mark as sent — I'll print or send it myself** (nobody is being emailed here; the feature tour covers the email path). Then **Record acceptance**: accepted by `Morgan Reyes`. Then **Convert to…** → **Create a sales order**. A quote posts nothing, and neither does the order it becomes: **no revenue is recognised until the invoice** (IFRS 15 / ASC 606 — there is no contract performance to record until goods ship or work is done). The order is **SO1**.

### The deposit — D1

Open SO1 → **Request deposit** → basis: **25%** of the order, document date 2026-08-08, due date 2026-08-08. It creates a draft deposit invoice for **4,090.00**; **Issue** it. Posting:

| Account | Debit | Credit |
|---|---|---|
| 1120 Accounts Receivable | 4,090.00 |  |
| 2130 Customer Deposits |  | 4,090.00 |

The credit is to a **liability**, `2130 Customer Deposits`, not to revenue. Money (or a right to it) has arrived before Harbor Point has delivered anything, so it owes the customer either the goods or the money back — IFRS 15 calls this a *contract liability*. It leaves the balance sheet only when the order is invoiced and the deposit is applied against that invoice (month 6); the revenue itself is recognised on the invoice.

### The first delivery — I17

Open SO1 → **Create invoice**. Bill only part of the order: CAST-6 **60**, HFK-12 **40**, and set the SVC-FAB line to **0** (it is billed with the second delivery). Document date 2026-08-12, due date 2026-08-12. Then open the draft invoice and **Issue** it. This is **I17** in `05-invoices-to-raise.md`. Issuing posts **two** things at once:

*The sale:*

| Account | Debit | Credit |
|---|---|---|
| 1120 Accounts Receivable | 7,500.00 |  |
| 4100 Product Revenue |  | 7,500.00 |

*The cost of what was sold — at moving average:*

| Account | Debit | Credit |
|---|---|---|
| 5050 Cost of Sales — Inventory | 3,260.00 |  |
| 1140 Inventory |  | 3,260.00 |

**Moving-average cost** means each item carries one running unit cost: after every purchase it is recalculated as (value of stock on hand) ÷ (quantity on hand), and a sale takes stock out at whatever that average is *at that moment* without changing it. Here each item was bought once, so its average is simply its purchase price (CAST-6 42.00, HFK-12 18.50) — 60 × 42.00 + 40 × 18.50 = 3,260.00. The point of the second entry is the **matching principle**: the 3,260.00 was an asset on the day it was bought; it becomes an expense on the day the revenue it earned is recognised, in the same period, so gross profit is not distorted.

## 5. Let AutoLedger repeat itself

### Rent — B14, made recurring

Enter B14 like any bill from `04-bills-received.md`: **Northgate Realty**, 2026-08-01, due the same day, vendor reference `NR-RENT-August`, one line "Shop rent — [Month]" 9,100.00 to 6110 Rent & Utilities. Note `[Month]` in the description: type it literally. A placeholder is replaced with the **document's month** when the bill is approved, so this one reads "Shop rent — August" and next month's copy will read "Shop rent — September". Submit and approve B14, then on its page choose **Make recurring**:

| Field | Value |
|---|---|
| Name | Shop rent |
| Frequency | Monthly |
| Every | 1 |
| Start date | 2026-09-01 |
| End date | 2026-09-01 |
| Mode | Draft |

The end date equals the start date so the schedule makes exactly **one** more bill — month 6's rent — and stops. Mode **Draft** means each occurrence is created for you to approve, not posted by itself. Month 6 picks the draft up (`10-closing-the-quarter.md`).

> **Hint:** a schedule's occurrences are created by a background job that runs every 15 minutes, for dates up to today. Because this scenario's dates are in the past, the worker (if it is running) may create month 6's rent draft within minutes of your saving the schedule. That is fine — it is the same draft **Run now** would create; month 6 just opens it from the schedule's run list.

### Utilities — an accrual that reverses itself

Harbor Point's electricity and water for August will not be invoiced until early September. Left alone, August's profit would be overstated and September's understated. Accrual accounting records the cost in the month it was **incurred**, so on the last working days of August you book an *estimate* — and cancel it the day after, so the real invoice does not count the cost twice.

**Accounting → Manual journals → Repeating tab → New repeating journal:**

| Field | Value |
|---|---|
| Name | Utilities accrual |
| Narration | Utilities accrual — [Month] |
| First date | 2026-08-28 |
| Repeats | Monthly, every 1 |
| End date | 2026-09-28 |
| Reverse on the 1st of the next month | **ticked** |

| # | Account | Description | Debit | Credit |
|---|---|---|---|---|
| 1 | 6110 Rent & Utilities | Estimated electricity & water | 850.00 |  |
| 2 | 2120 Accrued Liabilities | Accrued utilities |  | 850.00 |

Save it, then open it under **Accounting → Recurring** and press **Run now**. Both occurrences are in the past, so both are created, each with its automatic reversal:

| Date | What | Debit | Credit |
|---|---|---|---|
| 2026-08-28 | Accrue August's utilities | 6110 Rent & Utilities 850.00 | 2120 Accrued Liabilities 850.00 |
| 2026-09-01 | Reverse it | 2120 Accrued Liabilities 850.00 | 6110 Rent & Utilities 850.00 |
| 2026-09-28 | Accrue September's utilities | 6110 Rent & Utilities 850.00 | 2120 Accrued Liabilities 850.00 |
| 2026-10-01 | Reverse that one | 2120 Accrued Liabilities 850.00 | 6110 Rent & Utilities 850.00 |

Only the first row belongs to month 5. The next two land in month 6 (don't worry that they appear already — reports "as of" the end of month 5 ignore them), and the last is dated after the scenario ends, so `2120 Accrued Liabilities` closes month 6 still holding 850.00: September's estimate. In month 6 the supplier's real August bill arrives and is expensed again; the reversal cancels it out, so August's cost is counted once, in August.

> The estimate is a manual journal, which is why it works: AutoLedger refuses manual postings to the receivable, payable, inventory, bank and credit-card accounts, but `2120 Accrued Liabilities` is an ordinary liability account.

## 6. Import statement 5 and lock the first four months

Now import `statements/month-5-northwind-ISO.csv` as in the tutorial (`06-bank-statements.md` lists every line). The service-charge and interest lines will already be **MATCHED** — your rules settled them on import; there is nothing to click. Resolve the rest as before.

Once August reconciles, **lock the books behind you**: **Accounting → Fiscal periods → Generate periods for this fiscal year** (if your six months cross a fiscal-year boundary, generate for both years), then **Close** the periods for April, May, June, July. A closed period refuses new postings; it can be reopened, so closing is a safety catch rather than a lock. Month 6 shows what the refusal looks like.

## What to check

| After | Where | You should see |
|---|---|---|
| B13 approved | Products & inventory → Stock on hand | CAST-6 **200**, HFK-12 **300** |
| I17 issued | Products & inventory → Stock on hand | CAST-6 **140**, HFK-12 **260** |
| I17 issued | Products & inventory → Valuation | Subledger and `1140 Inventory` both **10,690.00**, ties out |
| D1 issued | Reports → Trial balance (as of 2026-08-31) | `2130 Customer Deposits` **4,090.00** credit |
| ACC1 run | Reports → Trial balance (as of 2026-08-31) | `2120 Accrued Liabilities` **850.00** credit |
| I17 issued | Sales → Sales orders → SO1 | Billing: **Partly billed** |
| Statement 5 resolved | Banking → Reconciliation | Difference **0.00**, Unmatched **0**, Ignored **5** |

Then compare `07-expected-results.md` → Month 5. When it ties, continue with `10-closing-the-quarter.md`.
