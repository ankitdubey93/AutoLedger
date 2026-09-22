# Expected results — the answer key

Computed from the same dataset the statements and source documents come from, and verified — in this project's own test suite — against the real LedgerCore reports produced by replaying this exact scenario through the real API. If your numbers disagree with this file, your entries disagree with the scenario, not the other way around.

## Month 1 — as of 2026-06-30

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

### Balance sheet — as of 2026-06-30

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

### AR aging

| Bucket | Amount |
|---|---|
| Current | 0.00 |
| 1–30 days | 9,000.00 |
| 31–60 days | 0.00 |
| 61–90 days | 0.00 |
| 90+ days | 0.00 |

### AP aging

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

---

## Month 2 — as of 2026-07-31

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

### Balance sheet — as of 2026-07-31

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

### AR aging

| Bucket | Amount |
|---|---|
| Current | 0.00 |
| 1–30 days | 0.00 |
| 31–60 days | 0.00 |
| 61–90 days | 0.00 |
| 90+ days | 0.00 |

### AP aging

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

---

## Month 3 — as of 2026-08-31

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

### Balance sheet — as of 2026-08-31

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

### AR aging

| Bucket | Amount |
|---|---|
| Current | 0.00 |
| 1–30 days | 0.00 |
| 31–60 days | 0.00 |
| 61–90 days | 0.00 |
| 90+ days | 0.00 |

### AP aging

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

---

## Month 4 — as of 2026-09-30

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

### Balance sheet — as of 2026-09-30

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

### AR aging

| Bucket | Amount |
|---|---|
| Current | 0.00 |
| 1–30 days | 0.00 |
| 31–60 days | 0.00 |
| 61–90 days | 0.00 |
| 90+ days | 0.00 |

### AP aging

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

---

If any figure above differs, see "If a number does not match" in `README.md`.
