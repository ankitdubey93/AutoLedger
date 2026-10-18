# Expected results — the answer key

Computed from the same dataset the statements and source documents come from, and verified — in this project's own test suite — against the real AutoLedger reports produced by replaying this exact scenario through the real API. If your numbers disagree with this file, your entries disagree with the scenario, not the other way around.

## Month 1 — as of 2026-03-31

### Trial balance

| Account | Debit | Credit |
|---|---|---|
| 1110 Operating Cash | 147,162.40 | 33,353.00 |
| 1120 Accounts Receivable | 81,150.00 | 72,150.00 |
| 2100 Accounts Payable | 33,270.00 | 33,270.00 |
| 3100 Common Stock / Owner's Capital |  | 75,000.00 |
| 4100 Product Revenue |  | 18,000.00 |
| 4200 Service Revenue |  | 63,150.00 |
| 4300 Interest Income |  | 12.40 |
| 5100 Direct Materials | 12,750.00 |  |
| 5300 Freight & Duty | 2,340.00 |  |
| 6110 Rent & Utilities | 9,100.00 |  |
| 6120 Software & IT Infrastructure | 3,480.00 |  |
| 6200 Professional Fees | 5,600.00 |  |
| 6600 Bank Fees | 83.00 |  |
| **Total** | **294,935.40** | **294,935.40** |

### Profit & loss (cumulative from month 1)

| | Amount |
|---|---|
| 4100 Product Revenue | 18,000.00 |
| 4200 Service Revenue | 63,150.00 |
| 4300 Interest Income | 12.40 |
| **Total revenue** | **81,162.40** |
| 5100 Direct Materials | 12,750.00 |
| 5300 Freight & Duty | 2,340.00 |
| **Total cost of sales** | **15,090.00** |
| **Gross profit** | **66,072.40** |
| 6110 Rent & Utilities | 9,100.00 |
| 6120 Software & IT Infrastructure | 3,480.00 |
| 6200 Professional Fees | 5,600.00 |
| 6600 Bank Fees | 83.00 |
| **Total operating expenses** | **18,263.00** |
| **Net income** | **47,809.40** |

### Balance sheet — as of 2026-03-31

| | Amount |
|---|---|
| 1110 Operating Cash | 113,809.40 |
| 1120 Accounts Receivable | 9,000.00 |
| **Total assets** | **122,809.40** |
| 2100 Accounts Payable | 0.00 |
| **Total liabilities** | **0.00** |
| 3100 Common Stock / Owner's Capital | 75,000.00 |
| Retained/current earnings (derived) | 47,809.40 |
| **Total equity** | **122,809.40** |

Assets 122,809.40 = Liabilities 0.00 + Equity 122,809.40

### Aged receivables

| Bucket | Amount |
|---|---|
| Current | 0.00 |
| 1–30 days | 9,000.00 |
| 31–60 days | 0.00 |
| 61–90 days | 0.00 |
| 90+ days | 0.00 |

### Aged payables

| Bucket | Amount |
|---|---|
| Current | 0.00 |
| 1–30 days | 0.00 |
| 31–60 days | 0.00 |
| 61–90 days | 0.00 |
| 90+ days | 0.00 |

### Bank reconciliation

| | |
|---|---|
| GL balance | 113,809.40 |
| Statement balance | 113,809.40 |
| **Difference** | **0.00** |
| Matched | 15 |
| Unmatched | 0 |
| Ignored | 1 |

### Tax summary

On documents dated in this month alone — **Reports → Tax summary**.

| | Amount |
|---|---|
| Output tax (sales) | 0.00 |
| Input tax (purchases) | 0.00 |
| **Net tax payable** | **0.00** |

### Cash flow — net change

The movement of the cash accounts inside this month — **Reports → Cash flow statement**, net change in cash: **113,809.40**.

---

## Month 2 — as of 2026-04-30

### Trial balance

| Account | Debit | Credit |
|---|---|---|
| 1110 Operating Cash | 194,076.50 | 49,791.00 |
| 1120 Accounts Receivable | 119,050.00 | 119,050.00 |
| 2100 Accounts Payable | 49,670.00 | 49,670.00 |
| 3100 Common Stock / Owner's Capital |  | 75,000.00 |
| 4100 Product Revenue |  | 23,200.00 |
| 4200 Service Revenue |  | 95,850.00 |
| 4300 Interest Income |  | 26.50 |
| 5100 Direct Materials | 12,750.00 |  |
| 5300 Freight & Duty | 2,340.00 |  |
| 6110 Rent & Utilities | 18,200.00 |  |
| 6120 Software & IT Infrastructure | 3,480.00 |  |
| 6200 Professional Fees | 8,800.00 |  |
| 6400 Marketing & Advertising | 4,100.00 |  |
| 6600 Bank Fees | 121.00 |  |
| **Total** | **412,587.50** | **412,587.50** |

### Profit & loss (cumulative from month 1)

| | Amount |
|---|---|
| 4100 Product Revenue | 23,200.00 |
| 4200 Service Revenue | 95,850.00 |
| 4300 Interest Income | 26.50 |
| **Total revenue** | **119,076.50** |
| 5100 Direct Materials | 12,750.00 |
| 5300 Freight & Duty | 2,340.00 |
| **Total cost of sales** | **15,090.00** |
| **Gross profit** | **103,986.50** |
| 6110 Rent & Utilities | 18,200.00 |
| 6120 Software & IT Infrastructure | 3,480.00 |
| 6200 Professional Fees | 8,800.00 |
| 6400 Marketing & Advertising | 4,100.00 |
| 6600 Bank Fees | 121.00 |
| **Total operating expenses** | **34,701.00** |
| **Net income** | **69,285.50** |

### Balance sheet — as of 2026-04-30

| | Amount |
|---|---|
| 1110 Operating Cash | 144,285.50 |
| 1120 Accounts Receivable | 0.00 |
| **Total assets** | **144,285.50** |
| 2100 Accounts Payable | 0.00 |
| **Total liabilities** | **0.00** |
| 3100 Common Stock / Owner's Capital | 75,000.00 |
| Retained/current earnings (derived) | 69,285.50 |
| **Total equity** | **144,285.50** |

Assets 144,285.50 = Liabilities 0.00 + Equity 144,285.50

### Aged receivables

| Bucket | Amount |
|---|---|
| Current | 0.00 |
| 1–30 days | 0.00 |
| 31–60 days | 0.00 |
| 61–90 days | 0.00 |
| 90+ days | 0.00 |

### Aged payables

| Bucket | Amount |
|---|---|
| Current | 0.00 |
| 1–30 days | 0.00 |
| 31–60 days | 0.00 |
| 61–90 days | 0.00 |
| 90+ days | 0.00 |

### Bank reconciliation

| | |
|---|---|
| GL balance | 144,285.50 |
| Statement balance | 144,285.50 |
| **Difference** | **0.00** |
| Matched | 25 |
| Unmatched | 0 |
| Ignored | 2 |

### Tax summary

On documents dated in this month alone — **Reports → Tax summary**.

| | Amount |
|---|---|
| Output tax (sales) | 0.00 |
| Input tax (purchases) | 0.00 |
| **Net tax payable** | **0.00** |

### Cash flow — net change

The movement of the cash accounts inside this month — **Reports → Cash flow statement**, net change in cash: **30,476.10**.

---

## Month 3 — as of 2026-05-31

### Trial balance

| Account | Debit | Credit |
|---|---|---|
| 1110 Operating Cash | 239,092.30 | 65,309.00 |
| 1120 Accounts Receivable | 164,050.00 | 164,050.00 |
| 2100 Accounts Payable | 65,150.00 | 65,150.00 |
| 3100 Common Stock / Owner's Capital |  | 75,000.00 |
| 4100 Product Revenue |  | 32,600.00 |
| 4200 Service Revenue |  | 131,450.00 |
| 4300 Interest Income |  | 42.30 |
| 5100 Direct Materials | 21,650.00 |  |
| 5300 Freight & Duty | 5,440.00 |  |
| 6110 Rent & Utilities | 18,200.00 |  |
| 6120 Software & IT Infrastructure | 6,960.00 |  |
| 6200 Professional Fees | 8,800.00 |  |
| 6400 Marketing & Advertising | 4,100.00 |  |
| 6600 Bank Fees | 159.00 |  |
| **Total** | **533,601.30** | **533,601.30** |

### Profit & loss (cumulative from month 1)

| | Amount |
|---|---|
| 4100 Product Revenue | 32,600.00 |
| 4200 Service Revenue | 131,450.00 |
| 4300 Interest Income | 42.30 |
| **Total revenue** | **164,092.30** |
| 5100 Direct Materials | 21,650.00 |
| 5300 Freight & Duty | 5,440.00 |
| **Total cost of sales** | **27,090.00** |
| **Gross profit** | **137,002.30** |
| 6110 Rent & Utilities | 18,200.00 |
| 6120 Software & IT Infrastructure | 6,960.00 |
| 6200 Professional Fees | 8,800.00 |
| 6400 Marketing & Advertising | 4,100.00 |
| 6600 Bank Fees | 159.00 |
| **Total operating expenses** | **38,219.00** |
| **Net income** | **98,783.30** |

### Balance sheet — as of 2026-05-31

| | Amount |
|---|---|
| 1110 Operating Cash | 173,783.30 |
| 1120 Accounts Receivable | 0.00 |
| **Total assets** | **173,783.30** |
| 2100 Accounts Payable | 0.00 |
| **Total liabilities** | **0.00** |
| 3100 Common Stock / Owner's Capital | 75,000.00 |
| Retained/current earnings (derived) | 98,783.30 |
| **Total equity** | **173,783.30** |

Assets 173,783.30 = Liabilities 0.00 + Equity 173,783.30

### Aged receivables

| Bucket | Amount |
|---|---|
| Current | 0.00 |
| 1–30 days | 0.00 |
| 31–60 days | 0.00 |
| 61–90 days | 0.00 |
| 90+ days | 0.00 |

### Aged payables

| Bucket | Amount |
|---|---|
| Current | 0.00 |
| 1–30 days | 0.00 |
| 31–60 days | 0.00 |
| 61–90 days | 0.00 |
| 90+ days | 0.00 |

### Bank reconciliation

| | |
|---|---|
| GL balance | 173,783.30 |
| Statement balance | 173,783.30 |
| **Difference** | **0.00** |
| Matched | 34 |
| Unmatched | 0 |
| Ignored | 3 |

### Tax summary

On documents dated in this month alone — **Reports → Tax summary**.

| | Amount |
|---|---|
| Output tax (sales) | 0.00 |
| Input tax (purchases) | 0.00 |
| **Net tax payable** | **0.00** |

### Cash flow — net change

The movement of the cash accounts inside this month — **Reports → Cash flow statement**, net change in cash: **29,497.80**.

---

## Month 4 — as of 2026-06-30

### Trial balance

| Account | Debit | Credit |
|---|---|---|
| 1110 Operating Cash | 255,008.50 | 75,847.00 |
| 1120 Accounts Receivable | 182,250.00 | 182,250.00 |
| 2100 Accounts Payable | 77,150.00 | 77,150.00 |
| 3100 Common Stock / Owner's Capital |  | 75,000.00 |
| 4100 Product Revenue |  | 44,600.00 |
| 4200 Service Revenue |  | 137,650.00 |
| 4300 Interest Income |  | 58.50 |
| 4800 Sales Returns & Allowances | 2,300.00 |  |
| 5100 Direct Materials | 33,650.00 | 1,500.00 |
| 5300 Freight & Duty | 5,440.00 |  |
| 6110 Rent & Utilities | 18,200.00 |  |
| 6120 Software & IT Infrastructure | 6,960.00 |  |
| 6200 Professional Fees | 8,800.00 |  |
| 6400 Marketing & Advertising | 4,100.00 |  |
| 6600 Bank Fees | 197.00 |  |
| **Total** | **594,055.50** | **594,055.50** |

### Profit & loss (cumulative from month 1)

| | Amount |
|---|---|
| 4100 Product Revenue | 44,600.00 |
| 4200 Service Revenue | 137,650.00 |
| 4300 Interest Income | 58.50 |
| 4800 Sales Returns & Allowances | -2,300.00 |
| **Total revenue** | **180,008.50** |
| 5100 Direct Materials | 32,150.00 |
| 5300 Freight & Duty | 5,440.00 |
| **Total cost of sales** | **37,590.00** |
| **Gross profit** | **142,418.50** |
| 6110 Rent & Utilities | 18,200.00 |
| 6120 Software & IT Infrastructure | 6,960.00 |
| 6200 Professional Fees | 8,800.00 |
| 6400 Marketing & Advertising | 4,100.00 |
| 6600 Bank Fees | 197.00 |
| **Total operating expenses** | **38,257.00** |
| **Net income** | **104,161.50** |

### Balance sheet — as of 2026-06-30

| | Amount |
|---|---|
| 1110 Operating Cash | 179,161.50 |
| 1120 Accounts Receivable | 0.00 |
| **Total assets** | **179,161.50** |
| 2100 Accounts Payable | 0.00 |
| **Total liabilities** | **0.00** |
| 3100 Common Stock / Owner's Capital | 75,000.00 |
| Retained/current earnings (derived) | 104,161.50 |
| **Total equity** | **179,161.50** |

Assets 179,161.50 = Liabilities 0.00 + Equity 179,161.50

### Aged receivables

| Bucket | Amount |
|---|---|
| Current | 0.00 |
| 1–30 days | 0.00 |
| 31–60 days | 0.00 |
| 61–90 days | 0.00 |
| 90+ days | 0.00 |

### Aged payables

| Bucket | Amount |
|---|---|
| Current | 0.00 |
| 1–30 days | 0.00 |
| 31–60 days | 0.00 |
| 61–90 days | 0.00 |
| 90+ days | 0.00 |

### Bank reconciliation

| | |
|---|---|
| GL balance | 179,161.50 |
| Statement balance | 179,161.50 |
| **Difference** | **0.00** |
| Matched | 39 |
| Unmatched | 0 |
| Ignored | 4 |

### Tax summary

On documents dated in this month alone — **Reports → Tax summary**.

| | Amount |
|---|---|
| Output tax (sales) | 0.00 |
| Input tax (purchases) | 0.00 |
| **Net tax payable** | **0.00** |

### Cash flow — net change

The movement of the cash accounts inside this month — **Reports → Cash flow statement**, net change in cash: **5,378.20**.

---

## Month 5 — as of 2026-07-31

### Trial balance

| Account | Debit | Credit |
|---|---|---|
| 1110 Operating Cash | 266,615.80 | 98,935.00 |
| 1120 Accounts Receivable | 193,840.00 | 193,840.00 |
| 1140 Inventory | 13,950.00 | 3,260.00 |
| 2100 Accounts Payable | 100,200.00 | 100,200.00 |
| 2120 Accrued Liabilities |  | 850.00 |
| 2130 Customer Deposits |  | 4,090.00 |
| 3100 Common Stock / Owner's Capital |  | 75,000.00 |
| 4100 Product Revenue |  | 52,100.00 |
| 4200 Service Revenue |  | 137,650.00 |
| 4300 Interest Income |  | 75.80 |
| 4800 Sales Returns & Allowances | 2,300.00 |  |
| 5050 Cost of Sales — Inventory | 3,260.00 |  |
| 5100 Direct Materials | 33,650.00 | 1,500.00 |
| 5300 Freight & Duty | 5,440.00 |  |
| 6110 Rent & Utilities | 28,150.00 |  |
| 6120 Software & IT Infrastructure | 6,960.00 |  |
| 6200 Professional Fees | 8,800.00 |  |
| 6400 Marketing & Advertising | 4,100.00 |  |
| 6600 Bank Fees | 235.00 |  |
| **Total** | **667,500.80** | **667,500.80** |

### Profit & loss (cumulative from month 1)

| | Amount |
|---|---|
| 4100 Product Revenue | 52,100.00 |
| 4200 Service Revenue | 137,650.00 |
| 4300 Interest Income | 75.80 |
| 4800 Sales Returns & Allowances | -2,300.00 |
| **Total revenue** | **187,525.80** |
| 5050 Cost of Sales — Inventory | 3,260.00 |
| 5100 Direct Materials | 32,150.00 |
| 5300 Freight & Duty | 5,440.00 |
| **Total cost of sales** | **40,850.00** |
| **Gross profit** | **146,675.80** |
| 6110 Rent & Utilities | 28,150.00 |
| 6120 Software & IT Infrastructure | 6,960.00 |
| 6200 Professional Fees | 8,800.00 |
| 6400 Marketing & Advertising | 4,100.00 |
| 6600 Bank Fees | 235.00 |
| **Total operating expenses** | **48,245.00** |
| **Net income** | **98,430.80** |

### Balance sheet — as of 2026-07-31

| | Amount |
|---|---|
| 1110 Operating Cash | 167,680.80 |
| 1120 Accounts Receivable | 0.00 |
| 1140 Inventory | 10,690.00 |
| **Total assets** | **178,370.80** |
| 2100 Accounts Payable | 0.00 |
| 2120 Accrued Liabilities | 850.00 |
| 2130 Customer Deposits | 4,090.00 |
| **Total liabilities** | **4,940.00** |
| 3100 Common Stock / Owner's Capital | 75,000.00 |
| Retained/current earnings (derived) | 98,430.80 |
| **Total equity** | **173,430.80** |

Assets 178,370.80 = Liabilities 4,940.00 + Equity 173,430.80

### Aged receivables

| Bucket | Amount |
|---|---|
| Current | 0.00 |
| 1–30 days | 0.00 |
| 31–60 days | 0.00 |
| 61–90 days | 0.00 |
| 90+ days | 0.00 |

### Aged payables

| Bucket | Amount |
|---|---|
| Current | 0.00 |
| 1–30 days | 0.00 |
| 31–60 days | 0.00 |
| 61–90 days | 0.00 |
| 90+ days | 0.00 |

### Bank reconciliation

| | |
|---|---|
| GL balance | 167,680.80 |
| Statement balance | 167,680.80 |
| **Difference** | **0.00** |
| Matched | 45 |
| Unmatched | 0 |
| Ignored | 5 |

### Tax summary

On documents dated in this month alone — **Reports → Tax summary**.

| | Amount |
|---|---|
| Output tax (sales) | 0.00 |
| Input tax (purchases) | 0.00 |
| **Net tax payable** | **0.00** |

### Cash flow — net change

The movement of the cash accounts inside this month — **Reports → Cash flow statement**, net change in cash: **-11,480.70**.

---

## Month 6 — as of 2026-08-31

### Trial balance

| Account | Debit | Credit |
|---|---|---|
| 1110 Operating Cash | 272,674.20 | 125,043.00 |
| 1120 Accounts Receivable | 208,740.00 | 203,970.00 |
| 1140 Inventory | 13,950.00 | 6,520.00 |
| 2100 Accounts Payable | 114,870.00 | 114,870.00 |
| 2120 Accrued Liabilities | 850.00 | 1,700.00 |
| 2130 Customer Deposits | 4,090.00 | 4,090.00 |
| 2160 Payroll Liabilities | 11,400.00 | 13,000.00 |
| 3100 Common Stock / Owner's Capital |  | 75,000.00 |
| 4100 Product Revenue |  | 59,600.00 |
| 4200 Service Revenue |  | 145,050.00 |
| 4300 Interest Income |  | 94.20 |
| 4800 Sales Returns & Allowances | 2,300.00 |  |
| 5050 Cost of Sales — Inventory | 6,520.00 |  |
| 5100 Direct Materials | 33,650.00 | 1,500.00 |
| 5200 Direct Labor | 9,800.00 |  |
| 5300 Freight & Duty | 6,680.00 |  |
| 6100 Salaries & Wages | 3,200.00 |  |
| 6110 Rent & Utilities | 38,950.00 | 850.00 |
| 6120 Software & IT Infrastructure | 10,440.00 |  |
| 6200 Professional Fees | 8,800.00 |  |
| 6400 Marketing & Advertising | 4,100.00 |  |
| 6600 Bank Fees | 273.00 |  |
| **Total** | **751,287.20** | **751,287.20** |

### Profit & loss (cumulative from month 1)

| | Amount |
|---|---|
| 4100 Product Revenue | 59,600.00 |
| 4200 Service Revenue | 145,050.00 |
| 4300 Interest Income | 94.20 |
| 4800 Sales Returns & Allowances | -2,300.00 |
| **Total revenue** | **202,444.20** |
| 5050 Cost of Sales — Inventory | 6,520.00 |
| 5100 Direct Materials | 32,150.00 |
| 5200 Direct Labor | 9,800.00 |
| 5300 Freight & Duty | 6,680.00 |
| **Total cost of sales** | **55,150.00** |
| **Gross profit** | **147,294.20** |
| 6100 Salaries & Wages | 3,200.00 |
| 6110 Rent & Utilities | 38,100.00 |
| 6120 Software & IT Infrastructure | 10,440.00 |
| 6200 Professional Fees | 8,800.00 |
| 6400 Marketing & Advertising | 4,100.00 |
| 6600 Bank Fees | 273.00 |
| **Total operating expenses** | **64,913.00** |
| **Net income** | **82,381.20** |

### Balance sheet — as of 2026-08-31

| | Amount |
|---|---|
| 1110 Operating Cash | 147,631.20 |
| 1120 Accounts Receivable | 4,770.00 |
| 1140 Inventory | 7,430.00 |
| **Total assets** | **159,831.20** |
| 2100 Accounts Payable | 0.00 |
| 2120 Accrued Liabilities | 850.00 |
| 2130 Customer Deposits | 0.00 |
| 2160 Payroll Liabilities | 1,600.00 |
| **Total liabilities** | **2,450.00** |
| 3100 Common Stock / Owner's Capital | 75,000.00 |
| Retained/current earnings (derived) | 82,381.20 |
| **Total equity** | **157,381.20** |

Assets 159,831.20 = Liabilities 2,450.00 + Equity 157,381.20

### Aged receivables

| Bucket | Amount |
|---|---|
| Current | 4,770.00 |
| 1–30 days | 0.00 |
| 31–60 days | 0.00 |
| 61–90 days | 0.00 |
| 90+ days | 0.00 |

### Aged payables

| Bucket | Amount |
|---|---|
| Current | 0.00 |
| 1–30 days | 0.00 |
| 31–60 days | 0.00 |
| 61–90 days | 0.00 |
| 90+ days | 0.00 |

### Bank reconciliation

| | |
|---|---|
| GL balance | 147,631.20 |
| Statement balance | 147,631.20 |
| **Difference** | **0.00** |
| Matched | 54 |
| Unmatched | 0 |
| Ignored | 6 |

### Tax summary

On documents dated in this month alone — **Reports → Tax summary**.

| | Amount |
|---|---|
| Output tax (sales) | 0.00 |
| Input tax (purchases) | 0.00 |
| **Net tax payable** | **0.00** |

### Cash flow — net change

The movement of the cash accounts inside this month — **Reports → Cash flow statement**, net change in cash: **-20,049.60**.

---

## Month 7 — as of 2026-09-30

### Trial balance

| Account | Debit | Credit |
|---|---|---|
| 1110 Operating Cash | 284,088.80 | 133,801.00 |
| 1115 EUR Receipts Account | 11,000.00 |  |
| 1120 Accounts Receivable | 238,085.00 | 226,230.00 |
| 1130 Prepaid Expenses | 1,800.00 | 600.00 |
| 1140 Inventory | 13,950.00 | 6,520.00 |
| 1180 GST/VAT Input Credit | 240.00 |  |
| 1500 Fixed Assets / Equipment | 6,000.00 |  |
| 2100 Accounts Payable | 121,790.00 | 121,790.00 |
| 2120 Accrued Liabilities | 2,900.00 | 2,900.00 |
| 2130 Customer Deposits | 4,090.00 | 4,090.00 |
| 2140 GST/VAT Output Payable |  | 795.00 |
| 2160 Payroll Liabilities | 11,400.00 | 13,000.00 |
| 3100 Common Stock / Owner's Capital |  | 81,000.00 |
| 4100 Product Revenue |  | 82,350.00 |
| 4200 Service Revenue |  | 150,850.00 |
| 4300 Interest Income |  | 113.80 |
| 4800 Sales Returns & Allowances | 2,300.00 |  |
| 4910 Realized FX Gain |  | 200.00 |
| 5050 Cost of Sales — Inventory | 6,520.00 |  |
| 5100 Direct Materials | 36,850.00 | 1,500.00 |
| 5200 Direct Labor | 9,800.00 |  |
| 5300 Freight & Duty | 6,680.00 |  |
| 6100 Salaries & Wages | 4,400.00 | 1,200.00 |
| 6110 Rent & Utilities | 38,950.00 | 1,700.00 |
| 6120 Software & IT Infrastructure | 13,920.00 |  |
| 6150 Insurance | 600.00 |  |
| 6200 Professional Fees | 8,800.00 |  |
| 6400 Marketing & Advertising | 4,100.00 |  |
| 6600 Bank Fees | 311.00 |  |
| 6820 Unrealized FX Gain/Loss | 65.00 |  |
| **Total** | **828,639.80** | **828,639.80** |

### Profit & loss (cumulative from month 1)

| | Amount |
|---|---|
| 4100 Product Revenue | 82,350.00 |
| 4200 Service Revenue | 150,850.00 |
| 4300 Interest Income | 113.80 |
| 4800 Sales Returns & Allowances | -2,300.00 |
| 4910 Realized FX Gain | 200.00 |
| **Total revenue** | **231,213.80** |
| 5050 Cost of Sales — Inventory | 6,520.00 |
| 5100 Direct Materials | 35,350.00 |
| 5200 Direct Labor | 9,800.00 |
| 5300 Freight & Duty | 6,680.00 |
| **Total cost of sales** | **58,350.00** |
| **Gross profit** | **172,863.80** |
| 6100 Salaries & Wages | 3,200.00 |
| 6110 Rent & Utilities | 37,250.00 |
| 6120 Software & IT Infrastructure | 13,920.00 |
| 6150 Insurance | 600.00 |
| 6200 Professional Fees | 8,800.00 |
| 6400 Marketing & Advertising | 4,100.00 |
| 6600 Bank Fees | 311.00 |
| 6820 Unrealized FX Gain/Loss | 65.00 |
| **Total operating expenses** | **68,246.00** |
| **Net income** | **104,617.80** |

### Balance sheet — as of 2026-09-30

| | Amount |
|---|---|
| 1110 Operating Cash | 150,287.80 |
| 1115 EUR Receipts Account | 11,000.00 |
| 1120 Accounts Receivable | 11,855.00 |
| 1130 Prepaid Expenses | 1,200.00 |
| 1140 Inventory | 7,430.00 |
| 1180 GST/VAT Input Credit | 240.00 |
| 1500 Fixed Assets / Equipment | 6,000.00 |
| **Total assets** | **188,012.80** |
| 2100 Accounts Payable | 0.00 |
| 2120 Accrued Liabilities | 0.00 |
| 2130 Customer Deposits | 0.00 |
| 2140 GST/VAT Output Payable | 795.00 |
| 2160 Payroll Liabilities | 1,600.00 |
| **Total liabilities** | **2,395.00** |
| 3100 Common Stock / Owner's Capital | 81,000.00 |
| Retained/current earnings (derived) | 104,617.80 |
| **Total equity** | **185,617.80** |

Assets 188,012.80 = Liabilities 2,395.00 + Equity 185,617.80

### Aged receivables

| Bucket | Amount |
|---|---|
| Current | 7,150.00 |
| 1–30 days | 4,770.00 |
| 31–60 days | 0.00 |
| 61–90 days | 0.00 |
| 90+ days | 0.00 |

### Aged payables

| Bucket | Amount |
|---|---|
| Current | 0.00 |
| 1–30 days | 0.00 |
| 31–60 days | 0.00 |
| 61–90 days | 0.00 |
| 90+ days | 0.00 |

### Bank reconciliation

| | |
|---|---|
| GL balance | 150,287.80 |
| Statement balance | 150,287.80 |
| **Difference** | **0.00** |
| Matched | 61 |
| Unmatched | 0 |
| Ignored | 7 |

### Tax summary

On documents dated in this month alone — **Reports → Tax summary**.

| | Amount |
|---|---|
| Output tax (sales) | 795.00 |
| Input tax (purchases) | 240.00 |
| **Net tax payable** | **555.00** |

### Cash flow — net change

The movement of the cash accounts inside this month — **Reports → Cash flow statement**, net change in cash: **13,656.60**.

### Currency

| | Amount |
|---|---|
| Realized FX gain on the euro receipt (`4910`) | 200.00 |
| Month-end revaluation (`6820`) | -65.00 |
| I22 carried at | 7,150.00 → 7,085.00 |

Aged receivables totals `11,920.00` while `1120` is `11,855.00`: aging values open invoices at their own frozen rate; the `65.00` gap is the month-end revaluation, which reverses on 2026-10-01. This is expected.

---

If any figure above differs, see "If a number does not match" in `README.md`.
