# Wattle & Ash Bakehouse: the Australian walkthrough

A fictional Sydney bakery over two quarters, for testing GST, BAS, tax invoices, pay runs and TPAR by hand. Its ABNs pass the checksum and aren't meant to be anyone's.

**To load it:** `npm run seed:demo -- --region au`, then sign in as `demo-au@autoledger.dev` with password `autoledger-demo`. It uses the last two complete quarters, on a **cash** basis, leaving the first BAS lodged and the second as a draft. To save a pay run it needs `INTEGRATION_ENCRYPTION_KEY`; without one those two bills are paid normally and the figures are the same.

Below, **Q1** and **Q2** are the two quarters, shown as April to June and July to September. Every figure is worked by hand from the transactions, and `server/src/__tests__/accounting/auDemo.test.ts` proves the product reaches the same numbers through its API, on both bases.

> This walkthrough tests the software. It is not tax advice, and a registered BAS agent should review how GST is treated before you rely on it.

## The transactions

Amounts are in dollars. "GST" is the tax in the line.

### Sales

| Ref | Date | Customer | Line | Code | Excl. | GST | Incl. | Paid |
|---|---|---|---|---|---|---|---|---|
| I1 | 10 Apr | Harbour Cafe | Catering | `S_GST` | 1,000 | 100 | 1,100 | 5 May, all |
| I2 | 20 May | Quay Hotel | Pastries (priced inclusive) | `S_GST` | 2,000 | 200 | 2,200 | 15 Jun half, 10 Jul rest |
| | | | Plain bread | `S_FREE` | 500 | 0 | 500 | |
| I3 | 1 Jun | Auckland Deli | Shortbread export | `S_EXPORT` | 800 | 0 | 800 | 3 Aug, all |
| I4 | 25 Jun | Harbour Cafe | Catering | `S_GST` | 400 | 40 | 440 | 20 Jul, all |
| I5 | 10 Aug | Harbour Cafe | Catering | `S_GST` | 1,500 | 150 | 1,650 | 20 Aug $110 by credit, 1 Sep the rest |
| CN | 15 Aug | Harbour Cafe | Credit against I1 | `S_GST` | −100 | −10 | −110 | Applied to I5 on 20 Aug |
| Bank | 10 Sep | | Counter sale | `S_GST` | 50 | 5 | 55 | On the statement |

### Purchases

| Ref | Date | Vendor | Line | Code | Excl. | GST | Incl. | Paid |
|---|---|---|---|---|---|---|---|---|
| B1 | 12 Apr | Flour Mill Co | Flour | `P_FREE` | 600 | 0 | 600 | 28 Apr |
| B2 | 3 May | Packaging Direct | Boxes | `P_GST` | 300 | 30 | 330 | 28 May |
| B3 | 5 Jun | Oven Works | New oven | `P_CAP_GST` | 5,000 | 500 | 5,500 | 20 Jun half, 5 Jul rest |
| B4 | 10 Jun | Sunrise Cleaning | Cleaning | `P_GST` | 200 | 20 | 220 | 28 Jun |
| Bank | 18 Jun | | Telstra | `P_GST` | 100 | 10 | 110 | On the statement |
| B5 | 15 Jul | Flour Mill Co | Flour | `P_FREE` | 700 | 0 | 700 | 15 Aug, pay run |
| B6 | 1 Sep | Packaging Direct | Boxes | `P_GST` | 100 | 10 | 110 | 2 Sep $33 by debit note, 5 Sep the rest |
| B7 | 1 Aug | Sunrise Cleaning | Cleaning | `P_GST` | 200 | 20 | 220 | 15 Aug, pay run |
| DN | 20 Aug | Packaging Direct | Debit against B2 | `P_GST` | −30 | −3 | −33 | Applied to B6 on 2 Sep |
| Bank | 12 Sep | | Fuel, by bank rule | `P_GST` | 60 | 6 | 66 | On the statement |

### Payroll, from payroll software

| | W1 Wages | W2 Withheld | T7 Instalment |
|---|---|---|---|
| Q1 | 3,000 | 450 | 0 |
| Q2 | 3,300 | 500 | 200 |

The owner put in $20,000 of capital on the first day, which has no GST. Wages posted by a manual journal credit `2162 PAYG Withholding Payable`, and the bank line paying the net has no GST code, so neither touches the GST labels.

## The answers

### Accruals basis

GST is reported when the document is posted.

| Label | Q1 | How | Q2 | How |
|---|---|---|---|---|
| G1 | 5,040 | I1 1,100 + I2 2,700 + I3 800 + I4 440 | 1,705 | I5 1,650 + counter 55. CN is against April, so it isn't here |
| G2 | 800 | I3 | 0 | |
| G3 | 500 | Bread | 0 | |
| G5 | 1,300 | | 0 | |
| G6 | 3,740 | G1 − G5 | 1,705 | |
| G7 | 0 | | −110 | CN, a note against an earlier period |
| G8 | 3,740 | | 1,595 | |
| G9 | 340 | G8 ÷ 11 | 145 | |
| G10 | 5,500 | B3 | 0 | |
| G11 | 1,260 | 600 + 330 + 220 + 110 | 1,096 | B5 700 + B6 110 + B7 220 + fuel 66 |
| G12 | 6,760 | | 1,096 | |
| G14 | 600 | B1 | 700 | B5 |
| G16 | 600 | | 700 | |
| G17 | 6,160 | G12 − G16 | 396 | |
| G18 | 0 | | −33 | DN, against an earlier period |
| G19 | 6,160 | | 363 | |
| G20 | 560 | G19 ÷ 11 | 33 | |
| **1A** | **340** | 100 + 200 + 40 | **145** | 150 − 10 + 5 |
| **1B** | **560** | 30 + 500 + 20 + 10 | **33** | 10 + 20 − 3 + 6 |
| **Net** | **$230** | 340 + 450 − 560 | **$812** | 145 + 500 + 200 − 33 |

### Cash basis

GST is reported as money is received or paid. The demo uses this one.

| Label | Q1 | How | Q2 | How |
|---|---|---|---|---|
| G1 | 2,450 | I1 1,100 + half of I2 1,350 | 4,185 | Rest of I2 1,350 + I3 800 + I4 440 + I5 1,650 − CN 110 + counter 55 |
| G2 | 0 | I3 is unpaid | 800 | |
| G3 | 250 | Half the bread | 250 | The other half |
| G5 | 250 | | 1,050 | |
| G6 | 2,200 | | 3,135 | |
| G9 | 200 | | 285 | |
| G10 | 2,750 | Half of B3 | 2,750 | The other half |
| G11 | 1,260 | 600 + 330 + 220 + 110 | 1,063 | B5 700 + B6 110 + B7 220 − DN 33 + fuel 66 |
| G12 | 4,010 | | 3,813 | |
| G14 | 600 | | 700 | |
| G17 | 3,410 | | 3,113 | |
| G20 | 310 | | 283 | |
| **1A** | **200** | 100 + half of 200 | **285** | 100 + 40 + 150 − 10 + 5 |
| **1B** | **310** | 30 + 250 + 20 + 10 | **283** | 250 + 10 + 20 − 3 + 6 |
| **Net** | **$340** | 200 + 450 − 310 | **$702** | 285 + 500 + 200 − 283 |

### The cross-check

With everything paid by the end of Q2, both bases must report the same GST overall:

| | Accruals | Cash |
|---|---|---|
| 1A, both quarters | 340 + 145 = **485** | 200 + 285 = **485** |
| 1B, both quarters | 560 + 33 = **593** | 310 + 283 = **593** |

### After lodging both

`2140 GST Collected`, `1180 GST Paid` and `2162 PAYG Withholding Payable` are all **zero**. `1185 PAYG Instalments Paid` is **$200**. `2150 ATO Clearing` holds what is owed: **$1,042** on accruals or cash, since 230 + 812 = 340 + 702.

### TPAR, for Sunrise Cleaning

| Year ending June | Gross paid | GST |
|---|---|---|
| 2026 (B4) | $220 | $20 |
| 2027 (B7) | $220 | $20 |

## Things to try

Each of these should work as described. If one doesn't, that's a bug worth reporting.

**GST codes**
1. On a new invoice choose **GST-free sales** and type a rate through the API: the line stays at 0%.
2. Switch **Amounts are** to **Inclusive of GST** and enter $110: the total stays $110, with $10 GST.
3. Make a credit note from an inclusive invoice: the mode carries over, and the amounts match.

**Dates**
4. With the browser in another country, dates still read DD/MM/YYYY.

**BAS**
5. Click any figure on the BAS: it opens the transactions behind it, each linking to its document.
6. Finalise the draft, then try to issue an invoice dated inside it: refused, because the month closed.
7. Try to apply a credit note with an allocation date inside it: refused too, though no journal is involved.
8. Reopen it: the months open again and the figures move if you change something.
9. Record it as lodged: it can't be reopened, and `2150 ATO Clearing` holds what you owe.
10. Post a manual journal straight to `2140`: the BAS warns that it doesn't reconcile.

**Tax invoices**
11. Download an invoice as a PDF: it says **TAX INVOICE** with the ABN and "Total includes GST".
12. Change the organization's ABN, and download it again: the old invoice keeps the ABN it was issued with.
13. In Settings → Country & GST, untick **Registered for GST**, and issue a new invoice: it says **INVOICE**, with no GST.

**ABN**
14. Enter `90 123 400 161` on a vendor: refused as a mistyped ABN.
15. Enter `GB123456789`: accepted as a foreign tax number.
16. Create a bill for a vendor with no ABN: the form warns about withholding.

**Bill inbox** (needs a vision-model key)
17. Upload a receipt mixing GST and GST-free items without per-line GST: it won't post until you choose a code per line.
18. Turn on auto-post and upload the same: it stops for you, with the reason recorded.

**Pay runs** (needs `INTEGRATION_ENCRYPTION_KEY`)
19. Select a bill whose vendor has no bank details: the form asks for them before you can pay.
20. Change a vendor's bank details and pay them: a fraud warning appears.
21. Void a payment from a pay run, and download the file again: that payment has gone.
22. Open the `.aba` file in a text editor: every line is 120 characters.

**Existing organizations**
23. In a USD organization with postings, try **Switch to Australia** on Settings → Country & GST: refused, and nothing changes.
