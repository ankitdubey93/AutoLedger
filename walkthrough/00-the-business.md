# Harbor Point Fabrication

A small metal-fabrication shop. It bills project work — brackets, mounts, custom runs — to commercial customers, and buys the materials, freight, software, rent and professional services a shop like that actually needs. Every document here is tax-exempt, so every figure in the answer key is checkable by hand without a tax split getting in the way.

**Period:** six consecutive months, entered one at a time — the fourth is about returns and adjustments (credit and debit notes), and the fifth and sixth add stock, orders and deposits, a recurring bill and an accrual, a payroll journal, and closing the periods. **Currency:** USD throughout.

**Scope.** Months 1–4 cover the accounts-receivable / accounts-payable / cash cycle — invoicing, billing, and bank reconciliation. Months 5–6 add stock items (moving-average cost of sales), purchase and sales orders with partial invoicing, a customer deposit, bank rules, a recurring rent bill, an accrual that reverses itself, a payroll journal, and period close. It does not include fixed assets or depreciation, foreign currency, a year-end close, or sales tax. One bank account, one currency.

## Accounts this scenario touches

| Account | Why |
|---|---|
| 1110 Operating Cash | Every deposit and withdrawal |
| 1120 Accounts Receivable | What customers owe between invoice and payment |
| 1140 Inventory | Stock on hand, valued at moving average (months 5–6) |
| 2100 Accounts Payable | What's owed to vendors between bill approval and payment |
| 2120 Accrued Liabilities | The utilities accrual, reversed the following month (month 5) |
| 2130 Customer Deposits | A deposit received before the order is invoiced (month 5) |
| 2160 Payroll Liabilities | Net pay owed to employees until the bank pays it out (month 6) |
| 3100 Common Stock / Owner's Capital | The founder's opening deposit |
| 4100 Product Revenue, 4200 Service Revenue | The two ways Harbor Point bills customers |
| 4300 Interest Income | Bank interest — the one account added to the default chart; it arrives through `accounts.csv` (or by hand), see 01-setup.md |
| 4800 Sales Returns & Allowances | Month 4's credit notes — a contra-revenue account |
| 5050 Cost of Sales — Inventory | What the stock sold to customers cost us (months 5–6) |
| 5100 Direct Materials, 5300 Freight & Duty | Cost of sales |
| 5200 Direct Labor | Shop-floor payroll (month 6) |
| 6100 Salaries & Wages | Office and salaried payroll (month 6) |
| 6110, 6120, 6200, 6400 | Rent, software, professional fees, marketing |
| 6600 Bank Fees | Wire fees and monthly service charges |
