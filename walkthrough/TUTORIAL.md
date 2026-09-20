# Tutorial: run the whole scenario

You are Harbor Point Fabrication's bookkeeper for three months. Everything you need to type is in this folder; everything you should end up seeing is in this file, month by month, with a hint at each step that tends to trip people up.

Read `00-the-business.md` first if you have not already — it is one page and tells you what the company does and which accounts you'll touch.

---

## Step 0 — set up the organization

Follow `01-setup.md`: register a fresh org (base currency USD), then create one account by hand, `4300 Interest Income`. Registration already seeds the other 45 accounts, so this is the only one you create yourself.

> **Hint:** if you skip creating 4300 and hit an interest line in the bank statement later, "Post journal" will have no account to offer for it — come back here and add it.

## Step 1 — enter the master records

From `02-vendors.md` and `03-customers.md`, create all 6 vendors and all 6 customers now, before entering any document. Every one of them is used at least once across the three months.

> **Hint:** payment terms for every vendor are "Due on receipt" — there's no net-30 anywhere in this scenario, which keeps every bank line's date close to its document's date.

---

## Month 1

**Enter the documents.** From `04-bills-received.md` and `05-invoices-to-raise.md`, find this month's section and enter every bill and every invoice listed there — bills through Submit → Approve, invoices through Issue.

> **Hint:** a document you forget to advance out of DRAFT will never get a suggestion when you import the statement below — if a bank line comes up with zero suggestions and you expected one, check the document's status first.

**Import the statement.** From `06-bank-statements.md`, import `statements/month-1-northwind-ISO.csv` against `1110 Operating Cash`, using the date format `06-bank-statements.md` gives you. Enter the closing balance it names too — it's optional, but it's what lets the import screen tell you immediately if a total is off.

**Resolve every line.** Work down `06-bank-statements.md`'s table for this month. A line at or above 85 can be accepted with one click; below that, open its suggestions, read the score breakdown, and match it by hand if it's right. A fee, a service charge or interest has no suggestion at all — use **Post journal** and pick the account the table names. The one line marked **Ignore** is a transfer to another of the organization's own accounts — it never touches the GL at all.

> **Hint:** "Post journal" and "Ignore" look like similar ways to clear a line, but they are opposites in the reconciliation report — Ignore drops a line from the statement total entirely, Post journal moves the GL and counts it. Using the wrong one is the single most common way this month's Difference comes out non-zero.

**Check the reconciliation.** Reports → Bank reconciliation, account `1110 Operating Cash`, as of `2026-06-30`. You should see:

- Difference: **0.00**
- Unmatched: **0**
- Ignored: **1**

**Check the answer key.** Open `07-expected-results.md`'s "Month 1" section and compare, figure by figure: trial balance (Reports → Trial balance), P&L, balance sheet, and AR/AP aging. The headline numbers for this month:

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

**Check the reconciliation.** Reports → Bank reconciliation, account `1110 Operating Cash`, as of `2026-07-31`. You should see:

- Difference: **0.00**
- Unmatched: **0**
- Ignored: **2**

**Check the answer key.** Open `07-expected-results.md`'s "Month 2" section and compare, figure by figure: trial balance (Reports → Trial balance), P&L, balance sheet, and AR/AP aging. The headline numbers for this month:

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

**Check the reconciliation.** Reports → Bank reconciliation, account `1110 Operating Cash`, as of `2026-08-31`. You should see:

- Difference: **0.00**
- Unmatched: **0**
- Ignored: **3**

**Check the answer key.** Open `07-expected-results.md`'s "Month 3" section and compare, figure by figure: trial balance (Reports → Trial balance), P&L, balance sheet, and AR/AP aging. The headline numbers for this month:

| | |
|---|---|
| Net income (cumulative) | 98,783.30 |
| Total assets | 173,783.30 |
| Cash | 173,783.30 |
| Accounts receivable | 0.00 |

---

## You're done

Three months entered, three statements reconciled, three months of financial statements that tie back to a hand-typed source document for every dollar. If you want to see the same scenario built a different way, `sandbox/` runs a 24-month version of a different business through the seeder instead of by hand — see `sandbox/README.md`.
