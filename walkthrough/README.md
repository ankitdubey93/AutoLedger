# Walkthrough: Harbor Point Fabrication

A complete, four-month accounting scenario for AutoLedger — a vendor and a customer CSV to import, source documents to enter by hand, four bank statements to import, credit and debit notes in the fourth month, and a computed answer key to check your work against.

**Start with `TUTORIAL.md`** — it walks the whole thing start to finish with hints. The files below are its reference material, useful to come back to on their own:

- `00-the-business.md` — who Harbor Point Fabrication is
- `01-setup.md` — organization registration, the one account to create by hand
- `02-vendors.md`, `03-customers.md` — the CSV import steps, with the CSV shown inline
- `04-bills-received.md`, `05-invoices-to-raise.md` — the source documents, in order
- `06-bank-statements.md` — what each statement is and the per-line action to take
- `07-expected-results.md` — the answer key
- `08-returns-and-adjustments.md` — month 4: what credit and debit notes are, when you need one, their journal entries, and the three notes to enter
- `vendors.csv`, `customers.csv` — the two files to import via Data migration → Imports
- `statements/` — the four CSV files to import via Bank Imports

**Run order:** import all 6 vendors and all 6 customers once, up front, via **Data migration → Imports** in the left sidebar. Then, one month at a time — enter that month's bills (submit + approve), enter that month's invoices (issue), import that month's statement, resolve every line, check the reconciliation report, check that month's figures against `07-expected-results.md` — before moving to the next month. In month 4, issue the notes in `08-returns-and-adjustments.md` after entering that month's documents and **before** importing its statement. Suggestions are generated at import time against documents that are open right then, so a month's documents must exist before its statement is imported.

**Do not hand-edit anything in this folder.** It is generated output — change `server/src/scripts/walkthroughDataset.ts` and run `npm run walkthrough` again.

## If a number does not match

1. Check every bill was taken through Submit → Approve, and every invoice through Issue. A document still in DRAFT is invisible to the matcher and won't appear as a suggestion.
2. Check the bank line list for anything still `UNMATCHED` — it counts toward the statement total but never moved the GL, which is the single most common way to throw the reconciliation off.
3. Check that no `IGNORED` line was also posted as a journal entry (or vice versa) — a line is one or the other, never both, and getting this backwards moves the GL and the statement in opposite directions.
