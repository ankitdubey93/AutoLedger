# Tutorial: run the whole scenario

You are Harbor Point Fabrication's bookkeeper for seven months. Everything you need to type is in this folder; everything you should end up seeing is in this file, month by month, with a hint at each step that tends to trip people up.

Read `00-the-business.md` first if you have not already — it is one page and tells you what the company does and which accounts you'll touch.

---

## Step 0 — set up the organization

Follow `01-setup.md`: register a fresh org (base currency USD), complete the setup wizard (its optional inventory step can be done now with the **Manufacturing** profile, or later at the start of month 5), then add one account, `4300 Interest Income` — import `accounts.csv` or create it by hand. Registration already seeds the other 47 accounts, so this is the only one you add.

> **Hint:** if you skip creating 4300 and hit an interest line in the bank statement later, "Post journal" will have no account to offer for it — come back here and add it. (From month 5 the interest line is settled by a bank rule, which needs the account too.)

## Step 1 — import the master records

Go to **Accounting → Imports → New import**. Kind **Vendors**, upload `vendors.csv` (its contents are also shown in `02-vendors.md` if you'd rather copy-paste). It stages 6 rows, all `VALID`; Preview shows `6 will be created, 0 will be merged`; Commit. Repeat with kind **Customers** and `customers.csv`. (The **Customers** and **Vendors** pages have an **Import** button that opens the same wizard.) Do this now, before entering any document — every one of the 12 is used at least once across the six months. A thirteenth vendor, Lakeshore Power & Water, is added by hand in month 6, and a seventh customer, Rheinwerk Maschinenbau GmbH (a euro customer), is added by form in month 7.

> **Hint:** payment terms for every vendor are "Due on receipt" — there's no net-30 anywhere in this scenario, which keeps every bank line's date close to its document's date.

> **Hint:** if a staged row comes back `INVALID`, the importer is telling you something is genuinely wrong with that row (a blank name, a malformed email) — these two files are clean, so seeing one means the upload got corrupted somewhere, not that you should force a commit past it.

---

## Month 1

**Enter the documents.** From `04-bills-received.md` and `05-invoices-to-raise.md`, find this month's section and enter every bill and every invoice listed there — bills through Submit → Approve, invoices through Issue.

> **Hint:** a document you forget to advance out of DRAFT will never get a suggestion when you import the statement below — if a bank line comes up with zero suggestions and you expected one, check the document's status first.

**Import the statement.** From `06-bank-statements.md`, import `statements/month-1-northwind-ISO.csv` against `1110 Operating Cash`, using the date format `06-bank-statements.md` gives you. Enter the closing balance it names too — it's optional, but it's what lets the import screen tell you immediately if a total is off.

**Resolve every line.** Work down `06-bank-statements.md`'s table for this month. A line at or above 85 can be accepted with one click; below that, open its suggestions, read the score breakdown, and match it by hand if it's right. A fee, a service charge or interest has no suggestion at all — use **Post journal** and pick the account the table names. The one line marked **Ignore** is a transfer to another of the organization's own accounts — it never touches the GL at all.

> **Hint:** "Post journal" and "Ignore" look like similar ways to clear a line, but they are opposites in the reconciliation report — Ignore drops a line from the statement total entirely, Post journal moves the GL and counts it. Using the wrong one is the single most common way this month's Difference comes out non-zero.

**Check the reconciliation.** Banking → Reconciliation, account `1110 Operating Cash`, as of `2026-03-31`. You should see:

- Difference: **0.00**
- Unmatched: **0**
- Ignored: **1**

**Check the answer key.** Open `07-expected-results.md`'s "Month 1" section and compare, figure by figure: trial balance (Reports → Trial balance), P&L, balance sheet, aged receivables and aged payables. The headline numbers for this month:

| | |
|---|---|
| Net income (cumulative) | 47,809.40 |
| Total assets | 122,809.40 |
| Cash | 113,809.40 |
| Accounts receivable | 9,000.00 — this is Pinnacle Robotics' partial payment, the one open item this whole pack carries |

> **Hint:** do not move on to month 2 until Difference is 0.00 — every later month assumes month 1 reconciled cleanly.

---

## Month 2

**Enter the documents.** From `04-bills-received.md` and `05-invoices-to-raise.md`, find this month's section and enter every bill and every invoice listed there — bills through Submit → Approve, invoices through Issue.

> **Hint:** a document you forget to advance out of DRAFT will never get a suggestion when you import the statement below — if a bank line comes up with zero suggestions and you expected one, check the document's status first.

**Import the statement.** From `06-bank-statements.md`, import `statements/month-2-meridian-DMY.csv` against `1110 Operating Cash`, using the date format `06-bank-statements.md` gives you. Enter the closing balance it names too — it's optional, but it's what lets the import screen tell you immediately if a total is off.

**Resolve every line.** Work down `06-bank-statements.md`'s table for this month. A line at or above 85 can be accepted with one click; below that, open its suggestions, read the score breakdown, and match it by hand if it's right. A fee, a service charge or interest has no suggestion at all — use **Post journal** and pick the account the table names. The one line marked **Ignore** is a transfer to another of the organization's own accounts — it never touches the GL at all.

> **Hint:** "Post journal" and "Ignore" look like similar ways to clear a line, but they are opposites in the reconciliation report — Ignore drops a line from the statement total entirely, Post journal moves the GL and counts it. Using the wrong one is the single most common way this month's Difference comes out non-zero.

**Check the reconciliation.** Banking → Reconciliation, account `1110 Operating Cash`, as of `2026-04-30`. You should see:

- Difference: **0.00**
- Unmatched: **0**
- Ignored: **2**

**Check the answer key.** Open `07-expected-results.md`'s "Month 2" section and compare, figure by figure: trial balance (Reports → Trial balance), P&L, balance sheet, aged receivables and aged payables. The headline numbers for this month:

| | |
|---|---|
| Net income (cumulative) | 69,285.50 |
| Total assets | 144,285.50 |
| Cash | 144,285.50 |
| Accounts receivable | 0.00 |

---

## Month 3

**Enter the documents.** From `04-bills-received.md` and `05-invoices-to-raise.md`, find this month's section and enter every bill and every invoice listed there — bills through Submit → Approve, invoices through Issue.

> **Hint:** a document you forget to advance out of DRAFT will never get a suggestion when you import the statement below — if a bank line comes up with zero suggestions and you expected one, check the document's status first.

**Import the statement.** From `06-bank-statements.md`, import `statements/month-3-cascade-MDY.csv` against `1110 Operating Cash`, using the date format `06-bank-statements.md` gives you. Enter the closing balance it names too — it's optional, but it's what lets the import screen tell you immediately if a total is off.

> **Hint:** this statement's headers — `Posted`, `Memo`, `Check No`, `Net` — won't auto-detect. That's deliberate: open the column map and type in the four mappings `06-bank-statements.md` gives you.

**Resolve every line.** Work down `06-bank-statements.md`'s table for this month. A line at or above 85 can be accepted with one click; below that, open its suggestions, read the score breakdown, and match it by hand if it's right. A fee, a service charge or interest has no suggestion at all — use **Post journal** and pick the account the table names. The one line marked **Ignore** is a transfer to another of the organization's own accounts — it never touches the GL at all.

> **Hint:** "Post journal" and "Ignore" look like similar ways to clear a line, but they are opposites in the reconciliation report — Ignore drops a line from the statement total entirely, Post journal moves the GL and counts it. Using the wrong one is the single most common way this month's Difference comes out non-zero.

**Check the reconciliation.** Banking → Reconciliation, account `1110 Operating Cash`, as of `2026-05-31`. You should see:

- Difference: **0.00**
- Unmatched: **0**
- Ignored: **3**

**Check the answer key.** Open `07-expected-results.md`'s "Month 3" section and compare, figure by figure: trial balance (Reports → Trial balance), P&L, balance sheet, aged receivables and aged payables. The headline numbers for this month:

| | |
|---|---|
| Net income (cumulative) | 98,783.30 |
| Total assets | 173,783.30 |
| Cash | 173,783.30 |
| Accounts receivable | 0.00 |

---

## Month 4

**Enter the documents.** From `04-bills-received.md` and `05-invoices-to-raise.md`, find this month's section and enter every bill and every invoice listed there — bills through Submit → Approve, invoices through Issue.

> **Hint:** a document you forget to advance out of DRAFT will never get a suggestion when you import the statement below — if a bank line comes up with zero suggestions and you expected one, check the document's status first.

**Issue the notes.** This is the month about corrections — read `08-returns-and-adjustments.md` (what credit and debit notes are, when you need one, and the journal entry each posts), then work through its "Enter these" section in order: CN1, DN1, CN2, then apply CN2 to I16. Checkpoints:

- after CN1 → invoice I15 shows amount due **10,200.00**
- after DN1 → expense B12 shows amount due **10,500.00**
- after CN2 → **Customers → Ferrous Works Ltd**'s open items show CN2 as its own line at **−500.00** (unapplied credit) next to I16's 6,200.00, and **Reports → Aged receivables** still says it reconciles
- after applying CN2 → invoice I16 shows amount due **5,700.00**

> **Hint:** issue the notes **before** importing the statement. Suggestions are scored at import time against the amount still due; imported first, the 10,200.00 deposit would be scored against I15's full 12,000.00 and come up short on the amount points.

> **Hint:** a credit note posts to **4800 Sales Returns & Allowances**, not back to 4100 — change the account on the line copied from the invoice. The debit note stays on 5100, the account the steel was originally expensed to.

**Import the statement.** From `06-bank-statements.md`, import `statements/month-4-northwind-ISO.csv` against `1110 Operating Cash`, using the date format `06-bank-statements.md` gives you. Enter the closing balance it names too — it's optional, but it's what lets the import screen tell you immediately if a total is off.

**Resolve every line.** Work down `06-bank-statements.md`'s table for this month. A line at or above 85 can be accepted with one click; below that, open its suggestions, read the score breakdown, and match it by hand if it's right. A fee, a service charge or interest has no suggestion at all — use **Post journal** and pick the account the table names. The one line marked **Ignore** is a transfer to another of the organization's own accounts — it never touches the GL at all.

> **Hint:** "Post journal" and "Ignore" look like similar ways to clear a line, but they are opposites in the reconciliation report — Ignore drops a line from the statement total entirely, Post journal moves the GL and counts it. Using the wrong one is the single most common way this month's Difference comes out non-zero.

**Check the reconciliation.** Banking → Reconciliation, account `1110 Operating Cash`, as of `2026-06-30`. You should see:

- Difference: **0.00**
- Unmatched: **0**
- Ignored: **4**

**Check the answer key.** Open `07-expected-results.md`'s "Month 4" section and compare, figure by figure: trial balance (Reports → Trial balance), P&L, balance sheet, aged receivables and aged payables. The headline numbers for this month:

| | |
|---|---|
| Net income (cumulative) | 104,161.50 |
| Total assets | 179,161.50 |
| Cash | 179,161.50 |
| Accounts receivable | 0.00 |

---

## Month 5

**Enter the documents.** This month's documents are not all typed in the same way — some are raised from orders, imported from files, or generated by a schedule. `09-products-orders-and-stock.md` walks through them **in the order to do them** (`04-bills-received.md` and `05-invoices-to-raise.md` list the same documents with their figures and say where each comes from). Sections 1 to 5 come before the statement; section 6 imports it and locks the first four months.

> **Hint:** a document you forget to advance out of DRAFT will never get a suggestion when you import the statement below — if a bank line comes up with zero suggestions and you expected one, check the document's status first.

**Import the statement.** From `06-bank-statements.md`, import `statements/month-5-northwind-ISO.csv` against `1110 Operating Cash`, using the date format `06-bank-statements.md` gives you. Enter the closing balance it names too — it's optional, but it's what lets the import screen tell you immediately if a total is off.

> **Hint:** some lines are already `MATCHED` the moment the import finishes — the service charge and the interest, settled by your bank rules. Leave them; only resolve what is still unmatched.

**Resolve every line.** Work down `06-bank-statements.md`'s table for this month. A line at or above 85 can be accepted with one click; below that, open its suggestions, read the score breakdown, and match it by hand if it's right. A fee, a service charge or interest has no suggestion at all — use **Post journal** and pick the account the table names. The one line marked **Ignore** is a transfer to another of the organization's own accounts — it never touches the GL at all.

> **Hint:** "Post journal" and "Ignore" look like similar ways to clear a line, but they are opposites in the reconciliation report — Ignore drops a line from the statement total entirely, Post journal moves the GL and counts it. Using the wrong one is the single most common way this month's Difference comes out non-zero.

**Check the reconciliation.** Banking → Reconciliation, account `1110 Operating Cash`, as of `2026-07-31`. You should see:

- Difference: **0.00**
- Unmatched: **0**
- Ignored: **5**

Month 5 checkpoints:

- Ignored: **5** (cumulative — one transfer to savings per month)
- `1140 Inventory` after the first delivery: **10,690.00**
- `SO1` billing status: **Partly billed**

**Check the answer key.** Open `07-expected-results.md`'s "Month 5" section and compare, figure by figure: trial balance (Reports → Trial balance), P&L, balance sheet, aged receivables and aged payables. The headline numbers for this month:

| | |
|---|---|
| Net income (cumulative) | 98,430.80 |
| Total assets | 178,370.80 |
| Cash | 167,680.80 |
| Accounts receivable | 0.00 |

---

## Month 6

**Enter the documents.** This month's documents are not all typed in the same way — some are raised from orders, imported from files, or generated by a schedule. `10-closing-the-quarter.md` walks through them **in the order to do them** (`04-bills-received.md` and `05-invoices-to-raise.md` list the same documents with their figures and say where each comes from). Sections 1 to 4 come before the statement; 6 and 7 after it.

> **Hint:** a document you forget to advance out of DRAFT will never get a suggestion when you import the statement below — if a bank line comes up with zero suggestions and you expected one, check the document's status first.

**Import the statement.** From `06-bank-statements.md`, import `statements/month-6-meridian-DMY.csv` against `1110 Operating Cash`, using the date format `06-bank-statements.md` gives you. Enter the closing balance it names too — it's optional, but it's what lets the import screen tell you immediately if a total is off.

> **Hint:** some lines are already `MATCHED` the moment the import finishes — the service charge and the interest, settled by your bank rules. Leave them; only resolve what is still unmatched.

**Resolve every line.** Work down `06-bank-statements.md`'s table for this month. A line at or above 85 can be accepted with one click; below that, open its suggestions, read the score breakdown, and match it by hand if it's right. A fee, a service charge or interest has no suggestion at all — use **Post journal** and pick the account the table names. The one line marked **Ignore** is a transfer to another of the organization's own accounts — it never touches the GL at all.

> **Hint:** "Post journal" and "Ignore" look like similar ways to clear a line, but they are opposites in the reconciliation report — Ignore drops a line from the statement total entirely, Post journal moves the GL and counts it. Using the wrong one is the single most common way this month's Difference comes out non-zero.

**Check the reconciliation.** Banking → Reconciliation, account `1110 Operating Cash`, as of `2026-08-31`. You should see:

- Difference: **0.00**
- Unmatched: **0**
- Ignored: **6**

Month 6 checkpoints (the hand-checked balances):

| | |
|---|---|
| 1140 Inventory | 7,430.00 |
| 2130 Customer Deposits | 0.00 |
| 2120 Accrued Liabilities | 850.00 |
| 2160 Payroll Liabilities | 1,600.00 |
| 1120 Accounts Receivable | 4,770.00 |
| 2100 Accounts Payable | 0.00 |
| 5050 Cost of Sales — Inventory (cumulative) | 6,520.00 |

**Check the answer key.** Open `07-expected-results.md`'s "Month 6" section and compare, figure by figure: trial balance (Reports → Trial balance), P&L, balance sheet, aged receivables and aged payables. The headline numbers for this month:

| | |
|---|---|
| Net income (cumulative) | 82,381.20 |
| Total assets | 159,831.20 |
| Cash | 147,631.20 |
| Accounts receivable | 4,770.00 |

---

## Month 7

**Enter the documents.** Month 7 is different in kind again: it brings foreign currency, sales tax and manual journals. `11-currency-tax-and-journals.md` walks through it **in the order to do things** — two accounts and a customer by form, three exchange rates, the manual journals, the invoices and the euro receipt, the bills, then the statement, the repeating insurance journal, the month-end revaluation and closing a period (`04-bills-received.md` and `05-invoices-to-raise.md` list the same documents with their figures).

> **Hint:** enter the exchange rates **before** the euro invoices. An invoice dated before any rate is refused with "No exchange rate for EUR to USD on or before <date>".

> **Hint:** a euro receipt never appears as a bank-line suggestion — statements here are base-currency only. Record it from the invoice with **Record payment**, paid into `1115 EUR Receipts Account`.

> **Hint:** **Post revaluation** only once, at month end — after it, the FX exposure page reads "This date has already been revalued." and the button is gone.

> **Hint:** **Delete** removes a draft manual journal; **Void** reverses a posted one — the void appears on both sides of the trial balance, so its two lines cancel and the original stays visible.

> **Hint:** a document you forget to advance out of DRAFT will never get a suggestion when you import the statement below — if a bank line comes up with zero suggestions and you expected one, check the document's status first.

**Import the statement.** From `06-bank-statements.md`, import `statements/month-7-northwind-ISO.csv` against `1110 Operating Cash`, using the date format `06-bank-statements.md` gives you. Enter the closing balance it names too — it's optional, but it's what lets the import screen tell you immediately if a total is off.

> **Hint:** some lines are already `MATCHED` the moment the import finishes — the service charge and the interest, settled by your bank rules. Leave them; only resolve what is still unmatched.

**Resolve every line.** Work down `06-bank-statements.md`'s table for this month. A line at or above 85 can be accepted with one click; below that, open its suggestions, read the score breakdown, and match it by hand if it's right. A fee, a service charge or interest has no suggestion at all — use **Post journal** and pick the account the table names. The one line marked **Ignore** is a transfer to another of the organization's own accounts — it never touches the GL at all.

> **Hint:** "Post journal" and "Ignore" look like similar ways to clear a line, but they are opposites in the reconciliation report — Ignore drops a line from the statement total entirely, Post journal moves the GL and counts it. Using the wrong one is the single most common way this month's Difference comes out non-zero.

**Check the reconciliation.** Banking → Reconciliation, account `1110 Operating Cash`, as of `2026-09-30`. You should see:

- Difference: **0.00**
- Unmatched: **0**
- Ignored: **7**

Month 7 checkpoints (the hand-checked figures):

| | |
|---|---|
| 1115 EUR Receipts Account | 11,000.00 |
| 1120 Accounts Receivable | 11,855.00 |
| 1130 Prepaid Expenses | 1,200.00 |
| 1180 GST/VAT Input Credit | 240.00 |
| 1500 Fixed Assets / Equipment | 6,000.00 |
| 2140 GST/VAT Output Payable | 795.00 |
| 3100 Common Stock / Owner's Capital | 81,000.00 |
| Net tax payable (output 795.00 less input 240.00) | 555.00 |
| Net change in cash | 13,656.60 |
| Month-end revaluation | -65.00 |

> **Hint:** aged receivables will not equal `1120` this month — the gap is the revaluation, which reverses on 2026-10-01. `07-expected-results.md` explains it.

**Check the answer key.** Open `07-expected-results.md`'s "Month 7" section and compare, figure by figure: trial balance (Reports → Trial balance), P&L, balance sheet, aged receivables and aged payables. The headline numbers for this month:

| | |
|---|---|
| Net income (cumulative) | 104,617.80 |
| Total assets | 188,012.80 |
| Cash | 150,287.80 |
| Accounts receivable | 11,855.00 |

---

## You're done

Seven months entered, seven statements reconciled, seven months of financial statements that tie back to a source document for every dollar — including three corrections made the way an auditor expects them, by separate documents that leave the originals untouched, stock bought and sold at moving average, a deposit that became revenue, an accrual that cancelled itself, and a euro customer whose exchange gain was realized and whose balance was revalued at month end. `guide/README.md` is the optional extra: a module-by-module test guide that exercises every other feature, each section ending in "Try to break it" checks. If you want to see the finished books without typing them, `npm run seed:demo` (in `server/`) replays this exact scenario through the API into a demo organization — see `docs/development.md`.
