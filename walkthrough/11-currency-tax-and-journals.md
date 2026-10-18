# Month 7 — currency, tax and journals

## What month 7 is about

Months 1–6 were in one currency and tax-free. September adds the three things a growing business meets next: **a customer who pays in euros**, **sales tax** on some of what Harbor Point sells and buys, and **manual journals** for entries that have no document behind them. It ends by revaluing the euro balance and closing August.

Do the sections in order — each builds on the one before. The statement is imported in section 8, after the documents it matches.

## 1. Two new accounts, by form

**Accounting → Chart of accounts → New account**, then **Create account**. Two accounts the default chart does not have:

| Field | Account 1 | Account 2 |
|---|---|---|
| Code | `1115` | `6150` |
| Name | EUR Receipts Account | Insurance |
| Type | Asset | Expense |
| Parent | `1100 Current Assets` | `6000 Operating Expenses` |
| Bank account | **Bank account** | — |

`1115` is where euros will land, so it is a *bank account*; a bank account takes receipts and payments, never a manual journal. `6150` is an ordinary expense account for the insurance amortisation in section 9. Nothing posts: an account is a place, not a transaction.

## 2. A euro customer

**Sales → Customers → New customer**, then **Create customer**:

| Field | Value |
|---|---|
| Name | Rheinwerk Maschinenbau GmbH |
| Email | ap@rheinwerk.example |
| Phone | +49-211-555-0190 |
| Billing address | Königsallee 92, 40212 Düsseldorf, Germany |
| Tax number | DE-814552907 |

A customer has no currency of their own; the currency is chosen on each invoice (section 5).

## 3. Exchange rates

**Accounting → Exchange rates → New rate**, then **Save rate**. Rates are always foreign → base, so **From currency** is `EUR` and **To currency** is `USD` (fixed). Enter all three **before** any euro invoice:

| Rate date | Rate | Why |
|---|---|---|
| 2026-09-01 | `1.08000000` | the rate on the first euro invoice |
| 2026-09-16 | `1.10000000` | the rate when the euro receipt arrives and the second invoice is raised |
| 2026-09-30 | `1.09000000` | the month-end rate used for the revaluation |

> **Hint:** a euro invoice or receipt uses the **latest rate on or before its own date**. Raise an invoice dated before the first rate and AutoLedger refuses it with "No exchange rate for EUR to USD on or before <date>".

## 4. Manual journals — post, delete, void

A **manual journal** is a posting with no invoice or bill behind it. **Accounting → Manual journals → New journal**; each has a date, a **Narration** and balanced lines (debits equal credits).

### MJ1 — post it

The owner contributes a plasma cutter. Date 2026-09-03, narration "Owner contributes plasma cutter":

| # | Description | Account | Debit | Credit |
|---|---|---|---|---|
| 1 | Plasma cutter — contributed | 1500 Fixed Assets / Equipment | 6,000.00 |  |
| 2 |  | 3100 Common Stock / Owner's Capital |  | 6,000.00 |

Click **Post**.

| Account | Debit | Credit |
|---|---|---|
| 1500 Fixed Assets / Equipment | 6,000.00 |  |
| 3100 Common Stock / Owner's Capital |  | 6,000.00 |

Equipment in, owner's capital up — no cash moves.

### MJ2 — save a draft, then delete it

The same entry typed a second time by mistake. Date 2026-09-10, narration "Plasma cutter contribution (duplicate)", the same two lines. Click **Save draft**, open the draft and click **Delete**, then **Delete draft** to confirm. A draft posts nothing, so deleting it leaves no trace in the ledger; it is gone from the list.

### MJ3 — post it, then void it

A bonus accrual posted in error. Date 2026-09-15, narration "Bonus accrual — posted in error":

| # | Description | Account | Debit | Credit |
|---|---|---|---|---|
| 1 |  | 6100 Salaries & Wages | 1,200.00 |  |
| 2 |  | 2120 Accrued Liabilities |  | 1,200.00 |

**Post** it. Then open the posted journal and click **Void**; set **Void date** to 2026-09-18, then **Void journal**. A posted journal is never edited or deleted — a void posts the opposite entry:

*On 2026-09-15:*

| Account | Debit | Credit |
|---|---|---|
| 6100 Salaries & Wages | 1,200.00 |  |
| 2120 Accrued Liabilities |  | 1,200.00 |

*On 2026-09-18:*

| Account | Debit | Credit |
|---|---|---|
| 6100 Salaries & Wages |  | 1,200.00 |
| 2120 Accrued Liabilities | 1,200.00 |  |

Both entries stay in the ledger, so 6100 Salaries & Wages and 2120 Accrued Liabilities each net to zero. The journal now reads **Voided**.

## 5. Invoices — a euro one, and tax

**Sales → Invoices → New invoice**, **Save draft**, then **Issue** (confirm with **Issue invoice**). Enter them in this order. The **Tax %** column on each line is new this month; every earlier invoice was 0%.

### I21 · Rheinwerk Maschinenbau GmbH

Issue date 2026-09-03, due 2026-10-03, currency EUR.

| # | Description | Qty | Unit price | Tax % | Account |
|---|---|---|---|---|---|
| 1 | Export — press guard assemblies, run 4 | 1 | 10,000.00 | 0% | 4100 Product Revenue |

**Total: EUR 10,000.00 (USD 10,800.00 at 1.08)**. Raise it in **EUR**: set **Currency** to `EUR`; below the date the form shows the rate it will freeze ("1 EUR = 1.08000000 USD"), and the invoice stays in euros. Tax 0% — an export.

Issuing posts (in USD):

| Account | Debit | Credit |
|---|---|---|
| 1120 Accounts Receivable | 10,800.00 |  |
| 4100 Product Revenue |  | 10,800.00 |

### I23 · Brightline Analytics

Issue date 2026-09-06, due 2026-09-06, currency USD.

| # | Item code | Description | Qty | Unit price | Tax % | Account |
|---|---|---|---|---|---|---|
| 1 | `SVC-DES` | Design & drafting — guard retrofit | 20 | 110.00 | 7.5% | 4200 Service Revenue |
| 2 | — | Fabricated mounting brackets | 1 | 4,800.00 | 7.5% | 4100 Product Revenue |

**Total: USD 7,525.00** — of which tax 525.00. A normal US invoice with **Tax %** `7.5` on both lines. Tax is worked out per line and rounded half-up.

Issuing posts (in USD):

| Account | Debit | Credit |
|---|---|---|
| 1120 Accounts Receivable | 7,525.00 |  |
| 4200 Service Revenue |  | 2,200.00 |
| 4100 Product Revenue |  | 4,800.00 |
| 2140 GST/VAT Output Payable |  | 525.00 |

### I24 · Novato Health Systems

Issue date 2026-09-13, due 2026-09-13, currency USD.

| # | Description | Qty | Unit price | Tax % | Account |
|---|---|---|---|---|---|
| 1 | Fabrication — cart frame retrofit | 1 | 3,600.00 | 7.5% | 4200 Service Revenue |

**Total: USD 3,870.00** — of which tax 270.00. Tax **7.5%** on its single line.

Issuing posts (in USD):

| Account | Debit | Credit |
|---|---|---|
| 1120 Accounts Receivable | 3,870.00 |  |
| 4200 Service Revenue |  | 3,600.00 |
| 2140 GST/VAT Output Payable |  | 270.00 |

### I22 · Rheinwerk Maschinenbau GmbH

Issue date 2026-09-21, due 2026-10-21, currency EUR.

| # | Description | Qty | Unit price | Tax % | Account |
|---|---|---|---|---|---|
| 1 | Export — guard panels, run 5 | 1 | 6,500.00 | 0% | 4100 Product Revenue |

**Total: EUR 6,500.00 (USD 7,150.00 at 1.10)**. Another euro invoice. The rate in force on 2026-09-21 is the one entered for 2026-09-16 — rates carry forward until a newer one is entered.

Issuing posts (in USD):

| Account | Debit | Credit |
|---|---|---|
| 1120 Accounts Receivable | 7,150.00 |  |
| 4100 Product Revenue |  | 7,150.00 |

> **Hint:** I21 and I22 keep their euro amounts on the invoice — the customer is asked for euros — while the ledger holds the dollar value at the rate when each was issued.

## 6. The euro receipt — RC1

On 2026-09-17 Rheinwerk pays I21 in full. It arrives in a euro account, **not** in your dollar bank statement, so there is no bank line to match: you record it from the invoice. Open I21 → **Record payment**. In the **Record a receipt** dialog:

| Field | Value |
|---|---|
| Cash / bank account | `1115` · EUR Receipts Account |
| Date | 2026-09-17 |
| Amount | 10,000.00 |
| Reference | RC1 |

The dialog estimates the exchange difference before you save ("Estimated realized gain: 200.00 USD (at 1.10000000, vs 1.08000000 when posted)"). Click **Record**:

| Account | Debit | Credit |
|---|---|---|
| 1115 EUR Receipts Account | 11,000.00 |  |
| 1120 Accounts Receivable |  | 10,800.00 |
| 4910 Realized FX Gain |  | 200.00 |

€10,000.00 was worth USD 10,800.00 when invoiced and USD 11,000.00 when the money arrived. The difference, 200.00, is a **realized** gain: the exchange rate moved in your favour on money you have now actually received.

## 7. Two bills — one with tax

**Purchases → Expenses → New expense**, **Save draft**, **Submit for review → Approve**, as in earlier months.

### B19 · Ironclad Supply Co

Bill date 2026-09-08, their bill number `INV-IC-9702`, due on receipt.

| # | Description | Qty | Unit price | Tax % | Account |
|---|---|---|---|---|---|
| 1 | Steel plate, 10mm — mill order | 1 | 3,200.00 | 7.5% | 5100 Direct Materials |

**Total: 3,440.00** — of which tax 240.00, which you can claim back.

Approving posts:

| Account | Debit | Credit |
|---|---|---|
| 5100 Direct Materials | 3,200.00 |  |
| 1180 GST/VAT Input Credit | 240.00 |  |
| 2100 Accounts Payable |  | 3,440.00 |

### B20 · Cloudspan Infrastructure

Bill date 2026-09-10, their bill number `CS-46790`, due on receipt.

| # | Description | Qty | Unit price | Tax % | Account |
|---|---|---|---|---|---|
| 1 | ERP hosting — [Month] | 1 | 3,480.00 | 0% | 6120 Software & IT Infrastructure |

**Total: 3,480.00**. Type `[Month]` literally in the description; it becomes the month name when you approve.

Approving posts:

| Account | Debit | Credit |
|---|---|---|
| 6120 Software & IT Infrastructure | 3,480.00 |  |
| 2100 Accounts Payable |  | 3,480.00 |

Tax paid on a purchase is not an expense: it sits in `1180 GST/VAT Input Credit`, an asset, until it is netted against the tax you collected (section 12).

## 8. Import statement 7

`statements/month-7-northwind-ISO.csv` (date format **ISO**) against `1110 Operating Cash` — see `06-bank-statements.md` for every line. The service-charge and interest lines are settled by your month 5 bank rules on import. The one line to post by hand is the insurance premium, `HARBOR MUTUAL INS PREMIUM` -1,800.00: **Post journal → 1130 Prepaid Expenses**:

| Account | Debit | Credit |
|---|---|---|
| 1130 Prepaid Expenses | 1,800.00 |  |
| 1110 Operating Cash |  | 1,800.00 |

Insurance paid in advance is an asset, not this month's expense. The transfer to savings is **Ignore**, as in every earlier month. Closing balance to enter: **150,287.80**. Then **Banking → Reconciliation** for `1110 Operating Cash` as of 2026-09-30 must show Difference **0.00** and Unmatched **0**.

## 9. A repeating journal — insurance amortisation

The premium covers several months, so each month a slice of the prepaid asset becomes an expense. **Accounting → Manual journals → New repeating journal**, then **Save repeating journal**:

| Field | Value |
|---|---|
| Name | Insurance amortisation |
| Narration | Insurance amortisation — [Month] |
| First date | 2026-09-28 |
| Repeats | Monthly |
| Every (count) | 1 |
| End date (optional) | 2026-11-28 |
| Reverse on the 1st of the next month | unticked |

| # | Description | Account | Debit | Credit |
|---|---|---|---|---|
| 1 |  | 6150 Insurance | 600.00 |  |
| 2 |  | 1130 Prepaid Expenses |  | 600.00 |

Open it under **Accounting → Recurring** and click **Run now**. It creates every occurrence due up to today. The first, dated 2026-09-28, belongs to month 7:

| Account | Debit | Credit |
|---|---|---|
| 6150 Insurance | 600.00 |  |
| 1130 Prepaid Expenses |  | 600.00 |

`[Month]` in the narration is replaced as each journal posts. Later occurrences (2 more, one a month up to 2026-11-28) are created by the background job once their dates have passed; the reports "as of" 2026-09-30 ignore them.

## 10. Month-end revaluation

I21 is settled. I22 (€6,500.00) is still owed in euros, and the euro has moved since it was raised. **Accounting → FX exposure**, set **As of** to 2026-09-30:

| Invoice | Owed | Carried at | Revalued at | Difference |
|---|---|---|---|---|
| I22 | €6,500.00 | USD 7,150.00 (1.10) | USD 7,085.00 (1.09) | -65.00 |

Click **Post revaluation** and confirm. It posts an **unrealized** loss on 2026-09-30:

| Account | Debit | Credit |
|---|---|---|
| 6820 Unrealized FX Gain/Loss | 65.00 |  |
| 1120 Accounts Receivable |  | 65.00 |

and the opposite entry on 2026-10-01, because nothing has been settled yet:

| Account | Debit | Credit |
|---|---|---|
| 1120 Accounts Receivable | 65.00 |  |
| 6820 Unrealized FX Gain/Loss |  | 65.00 |

*Unrealized* means paper only: no euro has changed hands. It is reversed so that when I22 is paid, the realized difference is measured from its original rate. The page now reads "This date has already been revalued." and the button is gone — post once, at month end.

## 11. Close August

**Accounting → Fiscal periods**: if September's period is not listed, **Generate periods for this fiscal year**. Then **Close** the August period. Try to break it: **Accounting → Manual journals → New journal** dated 2026-08-15, any two balanced lines, **Post** — AutoLedger refuses, because the period is closed. Nothing is saved (delete any draft left behind). **Reopen** undoes a close; a *locked* period cannot be reopened, and this scenario only closes.

## 12. Checkpoints

Compare with `07-expected-results.md` → Month 7. The hand-checked figures at 2026-09-30:

| Account / report | Amount |
|---|---|
| 1115 EUR Receipts Account | 11,000.00 |
| 1120 Accounts Receivable | 11,855.00 |
| 1130 Prepaid Expenses | 1,200.00 |
| 1180 GST/VAT Input Credit | 240.00 |
| 1500 Fixed Assets / Equipment | 6,000.00 |
| 2120 Accrued Liabilities | 0.00 |
| 2140 GST/VAT Output Payable | 795.00 |
| 3100 Common Stock / Owner's Capital | 81,000.00 |
| 4910 Realized FX Gain (credit) | 200.00 |
| 6820 Unrealized FX Gain/Loss (debit) | 65.00 |
| Net income, month 7 alone | 22,236.60 |

**Tax summary.** *Reports → Tax summary*, from 2026-09-01 to 2026-09-30: output tax **795.00**, input tax **240.00**, net tax payable **555.00**. The page also checks its own totals against the ledger; both differences read 0.00.

**Cash flow.** *Reports → Cash flow statement*, same dates: operating **13,656.60**, investing **-6,000.00**, financing **6,000.00**, net change in cash **13,656.60**. The plasma cutter (MJ1) moved no cash, but the statement shows it as a purchase of equipment financed by the owner, and the two cancel.

**Aged receivables versus the ledger.** *Reports → Aged receivables* totals **11,920.00** while `1120` is **11,855.00**. Aging values each open invoice at its own frozen rate; the **65.00** gap is the month-end revaluation, which reverses on 2026-10-01. This is expected, not an error.
