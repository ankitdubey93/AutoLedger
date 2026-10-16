# Walkthrough: Harbor Point Fabrication

A complete, six-month accounting scenario for AutoLedger — vendor, customer, product and stock-item CSVs to import, source documents to enter by hand (or raise from quotes and orders), six bank statements to import, credit and debit notes in month 4, stock, a deposit, recurring bills and an accrual in month 5, a month-end close in month 6, and a computed answer key — verified against the real application — to check your work against. A separate, unscored feature tour covers what does not touch the ledger.

**Start with `TUTORIAL.md`** — it walks the whole thing start to finish with hints. The files below are its reference material, useful to come back to on their own:

- `00-the-business.md` — who Harbor Point Fabrication is
- `01-setup.md` — organization registration, the one account to add (`4300`)
- `02-vendors.md`, `03-customers.md` — the CSV import steps, with the CSV shown inline
- `04-bills-received.md`, `05-invoices-to-raise.md` — the source documents, in order
- `06-bank-statements.md` — what each statement is and the per-line action to take
- `07-expected-results.md` — the answer key
- `08-returns-and-adjustments.md` — month 4: what credit and debit notes are, when you need one, their journal entries, and the three notes to enter
- `09-products-orders-and-stock.md` — month 5: products and stock items, bank rules, purchase order → bill, quote → sales order → deposit → invoice, a recurring bill and a self-reversing accrual
- `10-closing-the-quarter.md` — month 6: the generated rent, imported invoices/bills/payroll, applying the deposit, closing a period
- `11-feature-tour.md` — an optional, **unscored** tour of features that do not change the answer key
- `vendors.csv`, `customers.csv`, `accounts.csv`, `products.csv`, `stock-items.csv` — master data to import via **Accounting → Imports**
- `invoices-month-6.csv`, `bills-month-6.csv`, `payroll-month-6.csv` — month 6's document and journal imports
- `statements/` — the six CSV files to import via **Banking → Import statement**

**Run order:** import all 6 vendors and all 6 customers once, up front, via **Accounting → Imports** in the left sidebar (and `accounts.csv`, per `01-setup.md`). Then, one month at a time — enter that month's bills (submit + approve), enter that month's invoices (issue), import that month's statement, resolve every line, check the reconciliation report, check that month's figures against `07-expected-results.md` — before moving to the next month. In month 4, issue the notes in `08-returns-and-adjustments.md` after entering that month's documents and **before** importing its statement. Suggestions are generated at import time against documents that are open right then, so a month's documents must exist before its statement is imported.

Months 5 and 6 are different in kind: follow `09-products-orders-and-stock.md` for month 5 and `10-closing-the-quarter.md` for month 6 — they say what to do in what order (imports, bank rules, orders, a deposit, a schedule), and the document sheets `04`/`05` then serve as reference. The scenario's dates end in the past on purpose: a recurring schedule only creates occurrences up to today.

**Do not hand-edit anything in this folder.** It is generated output — change `server/src/scripts/walkthroughDataset.ts` and run `npm run walkthrough` again.

## If a number does not match

1. Check every bill was taken through Submit → Approve, and every invoice through Issue. A document still in DRAFT is invisible to the matcher and won't appear as a suggestion.
2. Check the bank line list for anything still `UNMATCHED` — it counts toward the statement total but never moved the GL, which is the single most common way to throw the reconciliation off.
3. Check that no `IGNORED` line was also posted as a journal entry (or vice versa) — a line is one or the other, never both, and getting this backwards moves the GL and the statement in opposite directions.
