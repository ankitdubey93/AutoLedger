# Bank statements

Six months, three different banks, three different export formats (Northwind Bank for months 1, 4 and 5, Meridian Bank for months 2 and 6, Cascade Trust for month 3). Import each one against `1110 Operating Cash` **only after** that month's bills are approved and invoices are issued — suggestions are generated at import time against documents that are open at that moment.

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

## Statement 4 — Northwind Bank again (`statements/month-4-northwind-ISO.csv`)

Statement 1's format — comma-delimited, ISO dates, one signed `Amount` column; pick **date format: ISO**. Two deposits and one withdrawal this month are for **less** than the document total: the matcher scores each line against the amount still due *after* credit and debit notes, which is why you issue the notes in `08-returns-and-adjustments.md` **before** importing this statement.

## Statement 5 — Northwind Bank (`statements/month-5-northwind-ISO.csv`)

The same format as statement 1 — comma-delimited, ISO dates, one signed `Amount` column; pick **date format: ISO**. Import it **after** the two bank rules in `09-products-orders-and-stock.md` exist: the service charge and the interest line are then settled on import, and their rows below read "Settled by your bank rule". The deposit line is for the invoice `D1` raised from a sales order.

## Statement 6 — Meridian Bank (`statements/month-6-meridian-DMY.csv`)

The same format as statement 2 — semicolon-delimited, day-first dates, separate `Debit`/`Credit` columns; pick **date format: DMY**. Import it after `10-closing-the-quarter.md`'s documents, the payroll journal and the second invoice are in.

---

## Month 1's lines

| Date | Memo | Amount | Expected score | What to do |
|---|---|---|---|---|
| 2026-04-01 | ACH DEBIT NORTHGATE REALTY | -9,100.00 | 100 | Accept the suggestion (auto) — should match B1 |
| 2026-04-01 | OPENING DEPOSIT FOUNDER CAPITAL | 75,000.00 | — | Post journal → 3100 Common Stock / Owner's Capital |
| 2026-04-02 | ACH CREDIT BRIGHTLINE ANALYTICS | 14,500.00 | 100 | Accept the suggestion (auto) — should match I1 |
| 2026-04-05 | ACH DEBIT CLOUDSPAN INFRASTRUCTURE | -3,480.00 | 92 | Accept the suggestion (auto) — should match B2 |
| 2026-04-06 | ACH CREDIT KESTREL LOGISTICS | 8,250.00 | 92 | Accept the suggestion (auto) — should match I2 |
| 2026-04-10 | ACH DEBIT IRONCLAD SUPPLY CO | -12,750.00 | 85 | Accept the suggestion (auto) — should match B3 |
| 2026-04-11 | ACH CREDIT FERROUS WORKS LTD | 22,100.00 | 85 | Accept the suggestion (auto) — should match I3 |
| 2026-04-15 | ACH CREDIT NOVATO HEALTH SYSTEMS | 6,400.00 | 77 | Review the suggestion, then Match — should match I4 |
| 2026-04-17 | SQ *DEP 88241 PAYOUT | 11,900.00 | 70 | Review the suggestion, then Match — should match I5 |
| 2026-04-17 | ACH DEBIT VERITY AUDIT PARTNERS | -5,600.00 | 77 | Review the suggestion, then Match — should match B4 |
| 2026-04-19 | BILL PAY 7734 REF 5590 | -2,340.00 | 70 | Review the suggestion, then Match — should match B5 |
| 2026-04-20 | ACH CREDIT PINNACLE ROBOTICS PARTIAL | 9,000.00 | 60 | Review the suggestion, then Match — should match I6 |
| 2026-04-22 | WIRE FEE INTL | -45.00 | — | Post journal → 6600 Bank Fees |
| 2026-04-24 | TRANSFER TO SAVINGS | -5,000.00 | — | Ignore — no GL entry |
| 2026-04-28 | MONTHLY SERVICE CHARGE | -38.00 | — | Post journal → 6600 Bank Fees |
| 2026-04-28 | INTEREST PAID | 12.40 | — | Post journal → 4300 Interest Income |

Closing balance to type into the import form: **113,809.40**, dated 2026-04-30.

After resolving every line above, **Reports → Bank reconciliation** for `1110 Operating Cash` as of `2026-04-30` must show **Difference = 0.00** and **Unmatched = 0**.

---

## Month 2's lines

| Date | Memo | Amount | Expected score | What to do |
|---|---|---|---|---|
| 2026-05-02 | ACH DEBIT NORTHGATE REALTY | -9,100.00 | 92 | Accept the suggestion (auto) — should match B7 |
| 2026-05-03 | ACH CREDIT FERROUS WORKS LTD | 9,800.00 | 100 | Accept the suggestion (auto) — should match I7 |
| 2026-05-05 | ACH DEBIT BEACON MEDIA BUYING | -4,100.00 | 100 | Accept the suggestion (auto) — should match B6 |
| 2026-05-08 | ACH CREDIT PINNACLE ROBOTICS | 9,000.00 | 70 | Review the suggestion, then Match — should match I6 |
| 2026-05-08 | ACH CREDIT NOVATO HEALTH SYSTEMS | 5,200.00 | 92 | Accept the suggestion (auto) — should match I8 |
| 2026-05-14 | ACH CREDIT KESTREL LOGISTICS | 15,600.00 | 77 | Review the suggestion, then Match — should match I9 |
| 2026-05-15 | PYMT PROCESSOR REF 44219 | 7,300.00 | 70 | Review the suggestion, then Match — should match I10 |
| 2026-05-20 | MONTHLY SERVICE CHARGE | -38.00 | — | Post journal → 6600 Bank Fees |
| 2026-05-21 | ACH DEBIT VERITY AUDIT PARTNERS | -3,200.00 | 77 | Review the suggestion, then Match — should match B8 |
| 2026-05-25 | TRANSFER TO SAVINGS | -3,000.00 | — | Ignore — no GL entry |
| 2026-05-28 | INTEREST PAID | 14.10 | — | Post journal → 4300 Interest Income |

Closing balance to type into the import form: **144,285.50**, dated 2026-05-31.

After resolving every line above, **Reports → Bank reconciliation** for `1110 Operating Cash` as of `2026-05-31` must show **Difference = 0.00** and **Unmatched = 0**.

---

## Month 3's lines

| Date | Memo | Amount | Expected score | What to do |
|---|---|---|---|---|
| 2026-06-02 | MONTHLY SERVICE CHARGE | -38.00 | — | Post journal → 6600 Bank Fees |
| 2026-06-04 | ACH CREDIT BRIGHTLINE ANALYTICS | 16,800.00 | 100 | Accept the suggestion (auto) — should match I11 |
| 2026-06-07 | ACH DEBIT IRONCLAD SUPPLY CO | -8,900.00 | 92 | Accept the suggestion (auto) — should match B9 |
| 2026-06-11 | ACH CREDIT PINNACLE ROBOTICS | 9,400.00 | 85 | Accept the suggestion (auto) — should match I12 |
| 2026-06-12 | ACH DEBIT CLOUDSPAN INFRASTRUCTURE | -3,480.00 | 85 | Accept the suggestion (auto) — should match B10 |
| 2026-06-16 | ACH CREDIT FERROUS WORKS LTD | 12,100.00 | 77 | Review the suggestion, then Match — should match I13 |
| 2026-06-18 | ACH TRANSFER REF 90312 | 6,700.00 | 70 | Review the suggestion, then Match — should match I14 |
| 2026-06-19 | ACH DEBIT CROSSWIND FREIGHT | -3,100.00 | 77 | Review the suggestion, then Match — should match B11 |
| 2026-06-19 | TRANSFER TO SAVINGS | -4,000.00 | — | Ignore — no GL entry |
| 2026-06-27 | INTEREST PAID | 15.80 | — | Post journal → 4300 Interest Income |

Closing balance to type into the import form: **173,783.30**, dated 2026-06-30.

After resolving every line above, **Reports → Bank reconciliation** for `1110 Operating Cash` as of `2026-06-30` must show **Difference = 0.00** and **Unmatched = 0**.

---

## Month 4's lines

| Date | Memo | Amount | Expected score | What to do |
|---|---|---|---|---|
| 2026-07-02 | MONTHLY SERVICE CHARGE | -38.00 | — | Post journal → 6600 Bank Fees |
| 2026-07-05 | ACH CREDIT BRIGHTLINE ANALYTICS | 10,200.00 | 77 | Review the suggestion, then Match — should match I15 |
| 2026-07-07 | ACH DEBIT IRONCLAD SUPPLY CO | -10,500.00 | 77 | Review the suggestion, then Match — should match B12 |
| 2026-07-12 | ACH CREDIT FERROUS WORKS LTD | 5,700.00 | 85 | Accept the suggestion (auto) — should match I16 |
| 2026-07-20 | TRANSFER TO SAVINGS | -2,500.00 | — | Ignore — no GL entry |
| 2026-07-28 | INTEREST PAID | 16.20 | — | Post journal → 4300 Interest Income |

Closing balance to type into the import form: **179,161.50**, dated 2026-07-31.

After resolving every line above, **Reports → Bank reconciliation** for `1110 Operating Cash` as of `2026-07-31` must show **Difference = 0.00** and **Unmatched = 0**.

---

## Month 5's lines

| Date | Memo | Amount | Expected score | What to do |
|---|---|---|---|---|
| 2026-08-01 | ACH DEBIT NORTHGATE REALTY | -9,100.00 | 100 | Accept the suggestion (auto) — should match B14 |
| 2026-08-02 | MONTHLY SERVICE CHARGE | -38.00 | — | Settled by your bank rule on import — nothing to do |
| 2026-08-06 | ACH DEBIT IRONCLAD SUPPLY CO | -13,950.00 | 92 | Accept the suggestion (auto) — should match B13 |
| 2026-08-08 | ACH CREDIT KESTREL LOGISTICS | 4,090.00 | 100 | Accept the suggestion (auto) — should match D1 |
| 2026-08-14 | ACH CREDIT KESTREL LOGISTICS | 7,500.00 | 85 | Accept the suggestion (auto) — should match I17 |
| 2026-08-20 | TRANSFER TO SAVINGS | -2,000.00 | — | Ignore — no GL entry |
| 2026-08-28 | INTEREST PAID | 17.30 | — | Settled by your bank rule on import — nothing to do |

Closing balance to type into the import form: **167,680.80**, dated 2026-08-31.

After resolving every line above, **Reports → Bank reconciliation** for `1110 Operating Cash` as of `2026-08-31` must show **Difference = 0.00** and **Unmatched = 0**.

---

## Month 6's lines

| Date | Memo | Amount | Expected score | What to do |
|---|---|---|---|---|
| 2026-09-01 | ACH DEBIT NORTHGATE REALTY | -9,100.00 | 100 | Accept the suggestion (auto) — should match B15 |
| 2026-09-02 | MONTHLY SERVICE CHARGE | -38.00 | — | Settled by your bank rule on import — nothing to do |
| 2026-09-04 | ACH CREDIT BRIGHTLINE ANALYTICS | 2,640.00 | 100 | Accept the suggestion (auto) — should match I18 |
| 2026-09-09 | ACH DEBIT LAKESHORE POWER & WATER | -850.00 | 92 | Accept the suggestion (auto) — should match B16 |
| 2026-09-11 | STRIPE PAYOUT 7731 | 3,400.00 | 70 | Review the suggestion, then Match — should match I19 |
| 2026-09-12 | ACH DEBIT CLOUDSPAN INFRASTRUCTURE | -3,480.00 | 85 | Accept the suggestion (auto) — should match B17 |
| 2026-09-18 | ACH DEBIT CROSSWIND FREIGHT | -1,240.00 | 77 | Review the suggestion, then Match — should match B18 |
| 2026-09-26 | PAYROLL NET PAY | -11,400.00 | — | Post journal → 2160 Payroll Liabilities |
| 2026-09-27 | TRANSFER TO SAVINGS | -1,500.00 | — | Ignore — no GL entry |
| 2026-09-28 | INTEREST PAID | 18.40 | — | Settled by your bank rule on import — nothing to do |

Closing balance to type into the import form: **147,631.20**, dated 2026-09-30.

After resolving every line above, **Reports → Bank reconciliation** for `1110 Operating Cash` as of `2026-09-30` must show **Difference = 0.00** and **Unmatched = 0**.

---

