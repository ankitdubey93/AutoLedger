# Month 4 — returns & adjustments (credit notes and debit notes)

Months 1–3 only ever *added* documents. Real businesses also have to *correct* them: a customer sends goods back, a supplier overcharges, a job is delivered late and you give a discount after the fact. This month shows the two documents that do that job without touching the original.

## What these documents are

| Document | Issued by | Sent to | What it does in **our** books | Called elsewhere |
|---|---|---|---|---|
| **Credit note** | us (the seller) | a customer | Reduces what the customer owes us (AR ↓) | QuickBooks "credit memo", Xero "sales credit note", Zoho "credit note" |
| **Debit note** | us (the buyer) | a vendor | Reduces what we owe the vendor (AP ↓) | QuickBooks "vendor credit", Xero "purchase credit note", Zoho "vendor credit" |

The names describe what the document does to the *other party's* account in your books: a credit note **credits** the customer's (receivable) account; a debit note **debits** the vendor's (payable) account. When you send a vendor a debit note, they usually answer with their own credit note — AutoLedger lets you record its number as the *vendor's credit note no.*

## When you need one

**Credit note** — the customer returned goods; you agreed a price allowance or an after-the-sale discount; goods arrived damaged; part of an invoice should never have been charged.

**Debit note** — you returned goods to a vendor; the vendor overcharged you; they delivered less than they billed.

**When you don't:**

- The whole invoice was wrong and nothing has been paid on it → **void** the invoice and re-issue it.
- The customer will simply never pay → that is a bad-debt write-off, a different document (not built in AutoLedger yet).
- The customer owes you **more** than you invoiced → issue another invoice. (Some tax regimes call a seller's document that *increases* an invoice a "debit note" too — e.g. India's GST. AutoLedger does not build that variant; a supplementary invoice does the same job in the books.)

> For background (verify for your jurisdiction): returns and allowances reduce revenue under IFRS 15 / ASC 606; India's CGST Act s.34 and the EU VAT Directive (art. 219) treat a document that amends an invoice as part of the invoice record, which is why it references the original and carries its own number series.

## Why a separate document instead of editing or voiding the original

- **The original stays intact.** An issued invoice is immutable in AutoLedger (and in any audited set of books); tax records and the customer both hold a copy of it.
- **Partial corrections.** Returning 3 kits out of 20 is not a reason to cancel the other 17.
- **Closed periods stay closed.** The note is dated when the return happens, so last month's reports never change.
- **Its own number series** (`CN-000001`, `DN-000001`), so auditors can see every correction in order.

## What they do to the books

Every note posts one journal entry when it is **issued** — the mirror image of the original document:

**CN1** — 3 bracket kits returned — weld porosity

| Account | Debit | Credit |
|---|---|---|
| 4800 Sales Returns & Allowances | 1,800.00 | |
| 1120 Accounts Receivable | | 1,800.00 |

**DN1** — 10 bars returned — mill-scale defects

| Account | Debit | Credit |
|---|---|---|
| 2100 Accounts Payable | 1,500.00 | |
| 5100 Direct Materials | | 1,500.00 |

**CN2** — Price allowance — run 13 delivered two days late

| Account | Debit | Credit |
|---|---|---|
| 4800 Sales Returns & Allowances | 500.00 | |
| 1120 Accounts Receivable | | 500.00 |

With sales tax (not part of this dataset, for illustration): returning goods worth 1,000.00 plus 10% tax posts DR 4800 Sales Returns & Allowances 1,000.00, DR 2140 Sales Tax Payable 100.00 / CR 1120 Accounts Receivable 1,100.00 — the tax you had collected is given back too.

**Applying** a note to an invoice or bill posts **no** journal entry at all. The note already credited 1120 and the invoice already debited it, so both are sitting inside the same Accounts Receivable balance; applying one to the other only matches them up on the customer's account.

4800 Sales Returns & Allowances is a *Revenue* account with a debit balance — a "contra-revenue" account. On the P&L it shows as a negative line under Revenue, so gross sales and returns stay visible separately. The debit note, by contrast, credits the original expense account (5100) directly: the steel you sent back simply never became a cost.

## Rules AutoLedger enforces

- A note must reference its original invoice (credit note) or approved bill (debit note), and takes that document's customer/vendor, currency and exchange rate — you never pick them.
- All notes against one document together can never exceed that document's total.
- On **Issue**, the note is applied to its original automatically, up to what is still owed. If the original is already paid, nothing applies and the whole note sits on the party's account as **unapplied credit** — a *negative* open item — until you apply it to another of their open documents.
- The original can't be voided while a note is issued against it; void the note first. Voiding a note reverses its journal entry and re-opens whatever it had been applied to.
- A draft note can be edited or deleted; an issued one can only be voided.

## Enter these

Enter all of month 4's invoices and bills first (`04-…` and `05-…`), then these three notes **in this order**, then import month 4's statement. The notes must exist before the statement: the matcher scores each bank line against the amount still due, and two of this month's payments are for the *net* amount.

### CN1 · Credit note · Brightline Analytics

Open invoice I15 (Product sale — bracket kits, 20 × 600.00, 12,000.00) → **Create credit note**.

| | |
|---|---|
| **Date** | 2026-09-03 |
| **Reason** | RETURN |

| # | Description | Qty | Unit price | Account |
|---|---|---|---|---|
| 1 | 3 bracket kits returned — weld porosity | 1 | 1,800.00 | 4800 Sales Returns & Allowances |

Replace the lines copied from the original with this one line, **Save**, then **Issue**.

> Issuing applies 1,800.00 to I15 automatically — nothing more to do.

### DN1 · Debit note · Ironclad Supply Co

Open bill B12 (their no. `INV-IC-9120`, 12,000.00) → **Create debit note**.

| | |
|---|---|
| **Date** | 2026-09-05 |
| **Reason** | RETURN |
| **Vendor's credit note no.** | `IC-CR-0231` |

| # | Description | Qty | Unit price | Account |
|---|---|---|---|---|
| 1 | 10 bars returned — mill-scale defects | 1 | 1,500.00 | 5100 Direct Materials |

Replace the lines copied from the original with this one line, **Save**, then **Issue**.

> Issuing applies 1,500.00 to B12 automatically — nothing more to do.

### CN2 · Credit note · Ferrous Works Ltd

Open invoice I13 (Fabrication — structural brace set, run 13, 12,100.00) → **Create credit note**.

| | |
|---|---|
| **Date** | 2026-09-06 |
| **Reason** | PRICE_ADJUSTMENT |

| # | Description | Qty | Unit price | Account |
|---|---|---|---|---|
| 1 | Price allowance — run 13 delivered two days late | 1 | 500.00 | 4800 Sales Returns & Allowances |

Replace the lines copied from the original with this one line, **Save**, then **Issue**.

> I13 was already paid in full, so issuing applies **nothing** — the whole 500.00 becomes unapplied credit on Ferrous Works Ltd's account. Then, on the note, **Apply credit** → I16, amount 500.00, date 2026-09-10.

## What to check

| After | Where | You should see |
|---|---|---|
| CN1 | Invoice I15 | Credits applied 1,800.00 · Amount due **10,200.00** |
| DN1 | Expense B12 | Debits applied 1,500.00 · Amount due **10,500.00** |
| CN2 (before applying) | Customers → Ferrous Works Ltd → open items | Two open items: I16 **6,200.00** and CN2 **−500.00** (unapplied credit) — balance 5,700.00 |
| CN2 (before applying) | Reports → AR aging | Ferrous Works 5,700.00, and "Reconciles" still ✓ |
| CN2 applied | Invoice I16 | Credits applied 500.00 · Amount due **5,700.00** |
| Statement 4 imported | Bank lines | 10,200.00, −10,500.00 and 5,700.00 each suggest I15, B12 and I16 |

By month end every one of these is settled, so AR and AP are both **0.00** again — but the P&L now shows **4800 Sales Returns & Allowances −2,300.00** under Revenue, and 5100 Direct Materials is 1,500.00 lower than the steel bill alone.
