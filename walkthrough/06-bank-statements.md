# Bank statements

Three months, three different banks, three different export formats. Import each one against `1110 Operating Cash` **only after** that month's bills are approved and invoices are issued — suggestions are generated at import time against documents that are open at that moment.

## Statement 1 — Northwind Bank (`statements/month-1-northwind-ISO.csv`)

Comma-delimited, ISO dates (`YYYY-MM-DD`), one signed `Amount` column. Every header is a column the importer recognizes automatically — leave the column-map closed, just pick **date format: ISO**.

## Statement 2 — Meridian Bank (`statements/month-2-meridian-DMY.csv`)

Semicolon-delimited, day-first dates (`DD/MM/YYYY`), separate `Debit`/`Credit` columns instead of one signed amount. Auto-detection still works — pick **date format: DMY**.

## Statement 3 — Cascade Trust (`statements/month-3-cascade-MDY.csv`)

Comma-delimited, month-first dates (`MM/DD/YYYY`), `$` amounts with accounting-style parentheses for a negative. **Auto-detection will fail here** — the headers are `Posted`, `Memo`, `Check No`, `Net`, none of which the importer's synonym list recognizes, so it responds `422 Could not find a date column in the file`. Open the column map and enter it by hand:

| Field | Column |
|---|---|
| Date | `Posted` |
| Description | `Memo` |
| Amount | `Net` |
| Reference | `Check No` |

and pick **date format: MDY**.

---

## Month 1's lines

| Date | Memo | Amount | Expected score | What to do |
|---|---|---|---|---|
| 2026-06-01 | ACH DEBIT NORTHGATE REALTY | -9,100.00 | 100 | Accept the suggestion (auto) — should match B1 |
| 2026-06-01 | OPENING DEPOSIT FOUNDER CAPITAL | 75,000.00 | — | Post journal → 3100 Common Stock / Owner's Capital |
| 2026-06-02 | ACH CREDIT BRIGHTLINE ANALYTICS | 14,500.00 | 100 | Accept the suggestion (auto) — should match I1 |
| 2026-06-05 | ACH DEBIT CLOUDSPAN INFRASTRUCTURE | -3,480.00 | 92 | Accept the suggestion (auto) — should match B2 |
| 2026-06-06 | ACH CREDIT KESTREL LOGISTICS | 8,250.00 | 92 | Accept the suggestion (auto) — should match I2 |
| 2026-06-10 | ACH DEBIT IRONCLAD SUPPLY CO | -12,750.00 | 85 | Accept the suggestion (auto) — should match B3 |
| 2026-06-11 | ACH CREDIT FERROUS WORKS LTD | 22,100.00 | 85 | Accept the suggestion (auto) — should match I3 |
| 2026-06-15 | ACH CREDIT NOVATO HEALTH SYSTEMS | 6,400.00 | 77 | Review the suggestion, then Match — should match I4 |
| 2026-06-17 | SQ *DEP 88241 PAYOUT | 11,900.00 | 70 | Review the suggestion, then Match — should match I5 |
| 2026-06-17 | ACH DEBIT VERITY AUDIT PARTNERS | -5,600.00 | 77 | Review the suggestion, then Match — should match B4 |
| 2026-06-19 | BILL PAY 7734 REF 5590 | -2,340.00 | 70 | Review the suggestion, then Match — should match B5 |
| 2026-06-20 | ACH CREDIT PINNACLE ROBOTICS PARTIAL | 9,000.00 | 60 | Review the suggestion, then Match — should match I6 |
| 2026-06-22 | WIRE FEE INTL | -45.00 | — | Post journal → 6600 Bank Fees |
| 2026-06-24 | TRANSFER TO SAVINGS | -5,000.00 | — | Ignore — no GL entry |
| 2026-06-28 | MONTHLY SERVICE CHARGE | -38.00 | — | Post journal → 6600 Bank Fees |
| 2026-06-28 | INTEREST PAID | 12.40 | — | Post journal → 4300 Interest Income |

Closing balance to type into the import form: **113,809.40**, dated 2026-06-30.

After resolving every line above, **Reports → Bank reconciliation** for `1110 Operating Cash` as of `2026-06-30` must show **Difference = 0.00** and **Unmatched = 0**.

---

## Month 2's lines

| Date | Memo | Amount | Expected score | What to do |
|---|---|---|---|---|
| 2026-07-02 | ACH DEBIT NORTHGATE REALTY | -9,100.00 | 92 | Accept the suggestion (auto) — should match B7 |
| 2026-07-03 | ACH CREDIT FERROUS WORKS LTD | 9,800.00 | 100 | Accept the suggestion (auto) — should match I7 |
| 2026-07-05 | ACH DEBIT BEACON MEDIA BUYING | -4,100.00 | 100 | Accept the suggestion (auto) — should match B6 |
| 2026-07-08 | ACH CREDIT PINNACLE ROBOTICS | 9,000.00 | 70 | Review the suggestion, then Match — should match I6 |
| 2026-07-08 | ACH CREDIT NOVATO HEALTH SYSTEMS | 5,200.00 | 92 | Accept the suggestion (auto) — should match I8 |
| 2026-07-14 | ACH CREDIT KESTREL LOGISTICS | 15,600.00 | 77 | Review the suggestion, then Match — should match I9 |
| 2026-07-15 | PYMT PROCESSOR REF 44219 | 7,300.00 | 70 | Review the suggestion, then Match — should match I10 |
| 2026-07-20 | MONTHLY SERVICE CHARGE | -38.00 | — | Post journal → 6600 Bank Fees |
| 2026-07-21 | ACH DEBIT VERITY AUDIT PARTNERS | -3,200.00 | 77 | Review the suggestion, then Match — should match B8 |
| 2026-07-25 | TRANSFER TO SAVINGS | -3,000.00 | — | Ignore — no GL entry |
| 2026-07-28 | INTEREST PAID | 14.10 | — | Post journal → 4300 Interest Income |

Closing balance to type into the import form: **144,285.50**, dated 2026-07-31.

After resolving every line above, **Reports → Bank reconciliation** for `1110 Operating Cash` as of `2026-07-31` must show **Difference = 0.00** and **Unmatched = 0**.

---

## Month 3's lines

| Date | Memo | Amount | Expected score | What to do |
|---|---|---|---|---|
| 2026-08-02 | MONTHLY SERVICE CHARGE | -38.00 | — | Post journal → 6600 Bank Fees |
| 2026-08-04 | ACH CREDIT BRIGHTLINE ANALYTICS | 16,800.00 | 100 | Accept the suggestion (auto) — should match I11 |
| 2026-08-07 | ACH DEBIT IRONCLAD SUPPLY CO | -8,900.00 | 92 | Accept the suggestion (auto) — should match B9 |
| 2026-08-11 | ACH CREDIT PINNACLE ROBOTICS | 9,400.00 | 85 | Accept the suggestion (auto) — should match I12 |
| 2026-08-12 | ACH DEBIT CLOUDSPAN INFRASTRUCTURE | -3,480.00 | 85 | Accept the suggestion (auto) — should match B10 |
| 2026-08-16 | ACH CREDIT FERROUS WORKS LTD | 12,100.00 | 77 | Review the suggestion, then Match — should match I13 |
| 2026-08-18 | ACH TRANSFER REF 90312 | 6,700.00 | 70 | Review the suggestion, then Match — should match I14 |
| 2026-08-19 | ACH DEBIT CROSSWIND FREIGHT | -3,100.00 | 77 | Review the suggestion, then Match — should match B11 |
| 2026-08-19 | TRANSFER TO SAVINGS | -4,000.00 | — | Ignore — no GL entry |
| 2026-08-27 | INTEREST PAID | 15.80 | — | Post journal → 4300 Interest Income |

Closing balance to type into the import form: **173,783.30**, dated 2026-08-31.

After resolving every line above, **Reports → Bank reconciliation** for `1110 Operating Cash` as of `2026-08-31` must show **Difference = 0.00** and **Unmatched = 0**.

---

