# Credit and debit notes — correcting a posted document without touching it

> A credit note (sales) and a debit note (purchases) are separate posted documents that reduce what a customer owes us or what we owe a vendor. They reference the original, post their own journal entry, and settle the original the same way a payment does — through an allocation row, never an edit.

**Category:** Architecture (accounting domain + data modelling)
**Introduced by:** Phase 26 — LedgerCore credit & debit notes
**Verified against:** PostgreSQL 16.15, Node 22, TypeScript strict. Accounting-standard and tax-law references are background only — **verify for your jurisdiction** before repeating them as fact.

---

## Mechanism

### What the two documents are

| Document | Issued by | To | Effect in **our** books | Journal entry on issue |
|---|---|---|---|---|
| Credit note | us (seller) | customer | AR ↓ | DR revenue (usually `4800 Sales Returns & Allowances`) + DR output tax / CR `1120` Accounts Receivable |
| Debit note | us (buyer) | vendor | AP ↓ | DR `2100` Accounts Payable / CR expense (or asset) + CR input tax |

The names describe what the document does to the **other party's account in your books**: a credit note credits the customer's receivable; a debit note debits the vendor's payable. This is the textbook/commercial sense (goods-return practice in India, the UK and most of the Commonwealth). Software naming differs — QuickBooks calls them *credit memo* and *vendor credit*, Xero *sales/purchase credit note*, Zoho *credit note / vendor credit*. India's GST law also uses "debit note" for a **seller's** document that *increases* an invoice; that variant is **not built** here (a supplementary invoice does the same job in the books).

### A note is a mirror image of its original, at the original's rate

Issuing a credit note builds exactly the invoice's posting with the sides swapped: one debit per distinct revenue account (lines on the same account merge), one debit for the tax being given back, one credit to AR for the total. It posts at the **invoice's frozen `fx_rate`**, copied onto the note at draft time — never re-resolved. That is the property that makes the note FX-neutral against its own invoice: the invoice put `total × rate` into AR in base currency, and the note takes `total × rate` back out at the same rate, so there is no realized FX difference to book.

### Settlement has two sources now, and one definition

Before Phase 26, "how much of an invoice is settled" was `Σ POSTED payment_allocations`, derived on every read and never stored ([derived-vs-stored-state.md](derived-vs-stored-state.md)). A note settles an invoice the same way — through an insert-only `credit_note_allocations` row — so settlement became:

```
settled = Σ payment_allocations (payment POSTED) + Σ credit_note_allocations (note ISSUED)
amount due = total − settled
```

The status predicate does the same job in both halves: voiding a payment *or* a note leaves its allocation rows in place (they are immutable) and they simply stop counting. `server/src/services/ledger-core/settlementSql.ts` is the one place this is defined (`settledCentsSubquery`); every amount-due site — invoice/bill lists, bank-match candidates, FX revaluation exposure, aging, party open items, payment validation — was switched to it in one pass. That was the riskiest part of the phase: a single site left on the payments-only subquery would let a payment over-settle a credited invoice, or have the bank matcher score against the wrong amount due.

### Applying a note posts no journal entry

When a note is applied to an invoice, the note has already credited 1120 and the invoice already debited it. Both balances are *inside the same control account*. Applying only changes which open items the customer's subledger shows — it matches two items, it doesn't move money between accounts. So `applyCreditNote` inserts an allocation row and nothing else. This is the same reason a payment's GL entry touches only cash and the control account: the per-document split lives in the subledger, not the GL.

### Unapplied credit is a negative open item

On issue, a note auto-applies to its original up to what is still due: `min(note total, total − paid − already credited)`. If the invoice was already paid in full, nothing applies and the whole note is **unapplied credit** — the customer's account now owes *them*. AR aging and party open items therefore `UNION ALL` the unapplied remainder of every ISSUED note as a **negative** open item (always bucketed `CURRENT`), and every `outstanding_cents > 0` filter became `<> 0`. Without that, the control account would move by the note while the subledger showed nothing, and Phase 25's `reconciles` check would go false.

### Caps, enforced twice

- **Cumulative:** Σ totals of ISSUED notes against one invoice ≤ the invoice total. The service checks this under a `FOR UPDATE` lock on the invoice; a `DEFERRABLE INITIALLY DEFERRED` constraint trigger re-checks it at COMMIT.
- **Settlement:** payments + applied notes ≤ document total. The replaced `assert_no_overallocation()` (payments) and the new `assert_note_allocation_within_limits()` (notes) both sum *both* sources.
- **Foreign currency:** a foreign-currency note may not exceed the invoice's amount still due, so it is always fully auto-applied and never leaves a remainder that would need applying to a *different* invoice at a *different* rate (which would create an FX difference with nowhere to go).

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Separate note document + allocation table | Original stays immutable; partial corrections; own number series; subledger stays reconcilable | **Chosen** |
| Negative lines on a new invoice | Breaks `unit_price_cents >= 0` and every "an invoice is money owed to us" assumption; the correction hides in the invoice series | Rejected |
| Void and re-issue | Loses the audit trail of the original, can't express a partial return, and reopens the original's (possibly closed) period | Rejected — still available for "the whole invoice was wrong and unpaid" |
| Manual journal DR 4800 / CR 1120 | Refused since Phase 25 (no manual postings to a control account): the subledger could never attribute the line to a customer, so `reconciles` breaks | Rejected |
| Cash refund of unapplied credit in this phase | Needs a bank-matchable refund document so the reconciliation still ties | Deferred |

Rules in play: [guardrails](../../docs/guardrails.md) rule 6 (posted documents are immutable — corrected by a new document), rule 10 (one FSM table, `NOTE_TRANSITIONS`, shared by both note types), rule 3 (integer cents throughout, `convertToBase` for base amounts), rule 16 (GL only via `journalService`).

## Where it lives in this codebase

- `server/src/db/migrations/063_ledger-core_credit_debit_notes.sql` — six tables, immutability and insert-only triggers, the deferred cap triggers, and the replaced `assert_no_overallocation()`
- `server/src/services/ledger-core/settlementSql.ts` — `allocatedCentsSubquery`, `noteAppliedCentsSubquery`, `settledCentsSubquery`, `noteOwnAppliedCentsSubquery`, `settledCentsOnClient`
- `server/src/services/ledger-core/creditNoteService.ts`, `debitNoteService.ts` — draft/issue/void/apply
- `server/src/services/ledger-core/agingService.ts`, `partyLedgerService.ts` — negative open items, `CREDIT_NOTE`/`DEBIT_NOTE` ledger rows
- `server/src/__tests__/ledger-core/noteSettlement.test.ts` — the reconciliation claim with an unapplied credit
- `walkthrough/08-returns-and-adjustments.md` — month 4 of the hand-entered scenario, replayed through the real API by `walkthrough.test.ts`

## Gotchas

- **Missing one amount-due site.** Settlement is derived in ~15 SQL fragments across eight files. Any one of them left on payments-only silently disagrees with the others. Centralising the definition first (Slice A, behaviour-preserving, full suite green before any note existed) is what made the switch safe.
- **`> 0` filters hide credit balances.** Aging had always filtered `outstanding_cents > 0` because a document could never be negative. The first negative open item turns that filter into a reconciliation bug.
- **Voiding the original out from under a note.** `voidInvoice` must refuse while an ISSUED note references the invoice or is applied to it, or the note would reduce AR for a document that no longer exists.
- **Stale bank suggestions.** Match suggestions are scored at import time. A note issued *after* a statement import leaves suggestions scored against the pre-credit amount due. The walkthrough orders notes before the import for this reason; re-scoring on note issue is not built.
- **Aging's open-document set is today's state.** It does not filter documents by their own date (pre-existing behaviour), so an as-of date *before* a document that already exists shows the document but not its GL line. The walkthrough's replay test hit this and moved its checkpoint to the later date.

## Interview Q&A

**Q: What does a credit note do to the trial balance?**
A: It posts one balanced entry: debit revenue (a contra-revenue account like Sales Returns & Allowances) and debit output tax, credit Accounts Receivable, for the note total. Revenue goes down, the tax liability goes down, AR goes down, and debits still equal credits. Applying it to an invoice afterwards changes nothing in the trial balance — it only matches two open items inside the AR control account.

**Q: Why not just edit the invoice?**
A: An issued invoice is a posted financial document: the customer has a copy, it's in the tax records, and it may sit in a closed period. Editing it would silently change history and every report derived from it. A note records the correction as a new dated fact that references the original, so both the original and the correction survive for audit, and a partial return (3 of 20 items) is expressible — voiding can only do all-or-nothing.

**Q: A customer paid in full, then returned goods. What's on their account?**
A: A credit balance. The note can't apply to the paid invoice (nothing is due), so the whole amount is unapplied credit — a negative open item on the customer's account and in AR aging. It stays there until it's applied to their next invoice or refunded. In our aging report it's bucketed CURRENT and the report still reconciles to the control account, because the note already credited 1120.

**Q: How do you keep AR aging reconciled to the GL once credits exist?**
A: The aging total is derived from documents, the control balance from ledger lines, and we assert integer equality between them. Notes had to join the document side in two ways: applied amounts reduce each invoice's outstanding (the settlement subquery sums payments *and* notes), and unapplied amounts appear as negative open items. Miss either and the two independently-computed totals diverge by exactly the note amount.

**Q: What stops two concurrent credit notes from over-crediting one invoice?**
A: Issuing locks the invoice row `FOR UPDATE` before summing the already-issued notes, so two issues against the same invoice serialize. As a backstop, a deferred constraint trigger re-sums at COMMIT. The lock is what makes it race-free — a deferred trigger alone runs in each transaction's own snapshot and would not see the other's uncommitted note. Lock order is note first, then invoice; payments only ever lock invoices, so the two paths can't deadlock.

**Q: Why does a foreign-currency credit note post at the invoice's rate rather than today's rate?**
A: Because it's reversing part of the invoice. The invoice put `amount × invoice rate` into AR in base currency; taking it out at a different rate would leave a residue in AR that no document owns. At the invoice's own rate, the note removes exactly what the invoice added, so applying it to that invoice is FX-neutral. That's also why a foreign note can't be applied to a *different* invoice here — that invoice was booked at a different rate.

**Q: Tell me about a time a change had to be behaviour-preserving before it could be useful.**
A: Adding credit notes meant changing what "amount due" means everywhere it was computed. I first moved the definition into one module and switched every call site to it while notes still didn't exist, with the requirement that the full 1,702-test suite stay green with an unchanged count. Only then did I add the note tables and services. The extension itself then had nothing left to break except the new behaviour, and the end-to-end walkthrough replay — four months entered through the real API and checked cent for cent against a computed answer key — was the final proof.

## Follow-ups they'll dig into

- *How would you refund unapplied credit?* A refund document paying cash out against the note (DR AR / CR bank for a customer), matchable by the bank reconciliation so the statement still ties.
- *What about bad debts?* Different document: a write-off to bad-debt expense (or against an allowance for doubtful accounts), not a credit note — nothing was returned or allowed.
- *Why is 4800 a Revenue account with a debit balance and not an Expense?* It's contra-revenue: it reduces gross sales so the P&L shows gross sales, returns, and net sales separately. Only five account types exist (rule 12), so the contra nature is expressed by its balance, not a sixth type.

## See also

- [derived-vs-stored-state.md](derived-vs-stored-state.md) — settlement as a derived read
- [../postgresql/subledger-reconciliation-and-aging.md](../postgresql/subledger-reconciliation-and-aging.md) — negative open items
- [../postgresql/deferred-constraint-triggers.md](../postgresql/deferred-constraint-triggers.md) — two-source settlement triggers
- [../postgresql/gapless-numbering-and-counters.md](../postgresql/gapless-numbering-and-counters.md) — separate CN/DN series
- [document-lifecycle-fsm.md](document-lifecycle-fsm.md) — `NOTE_TRANSITIONS`
- [realized-and-unrealized-fx.md](realized-and-unrealized-fx.md) — why posting at the original rate avoids an FX plug
