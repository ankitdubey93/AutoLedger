# Orders, partial billing and deposits

> A confirmed order that invoices/bills draw down line by line (never beyond the ordered quantity), and a deposit modelled as a contract liability that is later applied against the final document — all without storing a "remaining" or "balance" counter anywhere.

**Category:** Architecture · PostgreSQL
**Introduced by:** Phase 42, Slices F and G — turning an accepted quote into a sales/purchase order, invoicing it in instalments, and taking an advance payment first
**Verified against:** PostgreSQL 16, Node 22, TypeScript strict. Accounting references: IFRS 15 (contract liability), IAS 1 (current assets/liabilities). Not tax advice — see Gotchas on GST.

---

## Mechanism

### 1. Fulfilment quantity is derived, not stored

`order_lines.quantity_milli` is the only stored fact about quantity. "Billed" is computed on every read:

```
billed = Σ invoice_lines.quantity_milli (invoice.status <> 'VOID')
       + Σ bill_lines.quantity_milli    (bill.status    <> 'VOID')
         WHERE order_line_id = <this line>
remaining = ordered − billed
```

An invoice or bill line carries an optional `order_line_id` (composite FK `(org_id, order_line_id)`, `ON DELETE RESTRICT`). Voiding an invoice, or deleting a draft, restores the remaining quantity with no code at all, because the rows simply stop matching the predicate. A stored `billed_quantity` column would have to be incremented on create, decremented on void, delete, and quantity edit, and every one of those paths is a place to forget. This is the same reasoning as settlement (see [derived-vs-stored-state.md](derived-vs-stored-state.md)).

An order's `billingStatus` (`NOT_BILLED` / `PARTIALLY_BILLED` / `FULLY_BILLED`) is derived the same way and is deliberately **not** part of the order FSM. The FSM (`DRAFT → CONFIRMED → CLOSED | CANCELLED`, `CLOSED → CONFIRMED`) says what a human decided; billing status says what the documents say.

### 2. The cap is enforced twice

1. **Service layer, under a lock.** `assertOrderLineLinksOnClient` selects the order rows `FOR UPDATE OF o`, so two requests billing the same order serialise, and it checks status (`CONFIRMED`), party and currency. `convertOrder` also computes `remaining` and returns a readable 422 ("Line 1 has only 3 left to bill").
2. **Database, at COMMIT.** `check_order_line_billing()` is attached as `CREATE CONSTRAINT TRIGGER … AFTER INSERT OR UPDATE ON invoice_lines / bill_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW`. It re-sums the non-VOID linked lines and raises `P0001` if the sum exceeds the ordered quantity.

Why deferred: an edit of a draft invoice deletes its lines and re-inserts them in one transaction. An immediate trigger would see the transient state mid-way (and could falsely reject or falsely allow). A deferred constraint trigger queues one event per modified row and fires them at COMMIT, when the transaction's final state is visible. Why also the service check: the trigger gives a correct but ugly error and only at the very end; the service gives the friendly message and the lock that makes the check meaningful under concurrency. The trigger is the backstop for any other writer.

Subtlety worth knowing: the trigger reads other transactions' committed state under READ COMMITTED. Two concurrent transactions could each see "room for 3" and both insert 3 — the `FOR UPDATE OF o` row lock on the order in the service path is what stops that; the trigger alone does not serialise writers. It is a guard against bugs, not a lock. (Same two-layer reasoning as the credit-note cap in [credit-and-debit-notes.md](credit-and-debit-notes.md).)

Constraint triggers have no `CREATE OR REPLACE`/`IF NOT EXISTS`, so the migration wraps each in a `pg_trigger` existence check to stay idempotent (guardrail 13: the migrations are replayed by a test).

### 3. A deposit is a liability, not revenue

When a customer pays before delivery you owe them goods or services. Under IFRS 15 that is a **contract liability**; revenue is recognised when you perform. The flow, on a base-currency order:

| Event | Sales (customer deposit) | Purchase (supplier prepayment) |
|---|---|---|
| Deposit document issued/approved | DR Accounts receivable / CR `2130 Customer Deposits` | DR `1150 Supplier Prepayments` / CR Accounts payable |
| Cash paid | normal payment (DR bank / CR AR) | normal payment (DR AP / CR bank) |
| Applied to the final document | DR `2130` / CR Accounts receivable | DR Accounts payable / CR `1150` |

The deposit is an ordinary invoice/bill with `kind = 'DEPOSIT'` (and a `deposit_for_order_id`), so it reuses issuing, payment, aging, statements and party ledgers unchanged. An application is a separate insert-only row (`deposit_applications`, `POSTED → VOID` only, DELETE refused by trigger) that posts its own two-line journal with `source_type 'deposit_application'`.

### 4. A third settlement source behind one SQL definition

"How much of this invoice is still due?" is defined once in `settlementSql.ts`. Payments came first, credit/debit-note allocations second (Phase 26), applied deposits third. `settledCentsSubquery` and `settledAsOfCentsSubquery` simply gained one more term (`depositAppliedCentsSubquery`, correlated on `org_id` and the target column, `status = 'POSTED'`; the as-of variant also honours the application date and a later void). Aging, party open items, statements, payment validation, bank matching and FX revaluation all call those fragments, so none needed editing. A caller that did *not* use the shared fragment would silently disagree with the rest of the product; the Phase 25 invariant test (AR control = Σ party open items = aging total) is what catches that.

A deposit's "available to apply" is **paid minus already applied**, where paid counts payment allocations only (not note allocations, not other deposit applications) — you cannot apply money you have not received. That invariant can be broken after the fact by voiding the funding payment, so the payment-void path refuses (409) while applications on that deposit exist, and the deposit-document void refuses while any POSTED application touches it.

### 5. Why base-currency only

With a foreign-currency deposit, the liability is booked at the deposit-date rate, the cash arrives at another rate, and the application happens at a third. That produces realised FX differences on a *non-monetary* contract liability (IFRIC 22 / IAS 21: advance consideration recognised as a non-monetary contract liability uses the receipt-date rate and is not remeasured — I am confident of the principle but have not re-checked the standard's wording, so verify before quoting it). Getting that right needs its own design; refusing with a 422 is honest, silently using the wrong rate is not.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Stored `billed_quantity` on order lines | Fast reads; drifts on void/delete/edit, needs its own reconciliation | Rejected — derive it |
| Immediate (non-deferred) row trigger for the cap | Simpler | Rejected — fires on the transient state inside delete-and-reinsert edits |
| Service-only cap | Friendly | Rejected — any other writer bypasses it; guardrail 7's "enforce in the service and the DB" |
| Deposit as unapplied payment ("on account") | Familiar UX | Rejected — payments in this product must allocate fully; adding on-account money would touch every settlement path |
| Deposit as a revenue invoice reversed later | No new account | Rejected — books revenue that is not earned (IFRS 15) |
| Deposit via a dedicated contra document table | Isolated | Rejected — a `kind` on invoices/bills reuses issue, aging, statements, ledgers |
| One `orders` table with `direction` | Mirrors `quotes` | Chosen — one FSM, one trigger, direction-safe composite FKs |

## Where it lives in this codebase

- `server/src/db/migrations/092_ledger-core_orders.sql` — `orders`, `order_lines`, `order_line_id` columns, the immutability trigger and the deferred cap trigger.
- `server/src/db/migrations/093_ledger-core_deposits.sql` — accounts 2130/1150 backfill, `kind`, `deposit_applications`, its mutation trigger.
- `server/src/services/accounting/orderService.ts`, `orderLineLinks.ts` — lifecycle, derived quantities, lock-and-validate.
- `server/src/services/accounting/depositService.ts` — create, apply, void.
- `server/src/services/accounting/settlementSql.ts` — the third settlement term.
- `server/src/__tests__/accounting/{orderConstraints,orders,depositConstraints,deposits}.test.ts` — including the cross-tenant cases and the ledger-reconciliation case.

## Gotchas

- **Voiding must keep working through the cap trigger.** The cap sums `status <> 'VOID'`; if the trigger summed all rows, a voided invoice would keep consuming the order forever.
- **Lock order.** Document row → order row; apply locks both documents in id order so two applications cannot deadlock.
- **Deposits are 0% tax.** In jurisdictions that tax advances (e.g. India GST on advances for services) that is wrong; it is flagged, not built.
- **Cancelling an order with a paid deposit** leaves a balance in 2130; there are no cash refunds in the product, so it is cleared by a manual journal (2130 is not a control account).
- **A voided application's reversal journal keeps `source_type 'deposit_application'`** because the reversal helper copies the original's source; do not assert on a `_void` source type.
- **DEPOSIT documents are locked against draft edits (409)** — the amount is derived from the order.

## Interview Q&A

**Q: Why not store a `remaining_quantity` on the order line?**
A: Because every way a document can stop counting — void, draft delete, quantity edit — would have to update it, and a missed path is a silent over- or under-billing bug. Computing `ordered − Σ non-void linked lines` makes the invariant structural: voiding an invoice un-bills the order because the row no longer matches the predicate. The cost is a grouped query per order read, which is cheap with a partial index on `order_line_id IS NOT NULL`.

**Q: What does `DEFERRABLE INITIALLY DEFERRED` do, and why use it here?**
A: A constraint trigger can be deferred so its queued events fire at COMMIT (or at `SET CONSTRAINTS … IMMEDIATE`) rather than after each statement. Editing a draft invoice deletes and re-inserts its lines in one transaction; checking after each statement would evaluate intermediate states. Deferred, the trigger sees the final state once. Only `CONSTRAINT TRIGGER`s can be deferred, and they must be `AFTER … FOR EACH ROW`.

**Q: Two users invoice the last 3 units of an order line at the same instant. What stops over-billing?**
A: The service locks the order row `FOR UPDATE` while validating links, so the second transaction waits, then re-reads and sees nothing remaining (422). Without that lock, under READ COMMITTED both would pass a check and both commit; the deferred trigger is a second line of defence but is not itself a lock. I would say that plainly rather than claim the trigger alone is safe.

**Q: Walk me through the accounting for a customer deposit.**
A: Issuing the deposit invoice debits receivables and credits a liability account, "Customer Deposits" — it is a contract liability, not revenue. The customer's payment clears the receivable as usual. When we raise the final invoice (revenue recognised then), we apply the deposit: debit the liability, credit receivables, and the final invoice's amount due drops by that amount. The liability returns to zero. The point of an application row rather than an edit is that posted documents are immutable; a mistake is voided with a reversing journal.

**Q: How did you add a new way to settle a document without touching every report?**
A: Settlement is defined once as SQL fragments in `settlementSql.ts`, and all consumers embed them. Adding deposit applications meant adding one term to those fragments (correlated on `org_id`, POSTED only, as-of aware). A reconciliation test asserts AR control balance equals Σ party open items equals aging total after a full deposit flow; that is what proves no consumer bypassed the fragment.

**Q: Tell me about a time a rule you wrote had a hole you only found by testing the whole flow.**
A: The deposit cap says an application can't exceed what has been paid minus what has been applied. Testing the flow showed that voiding the payment *after* applying the deposit would leave the application unfunded, and nothing checked it. I added a guard in the payment-void path (409 until the applications are voided), under the same lock the application takes, and a test for it. The lesson: an "at write time" invariant is only as strong as every later operation that can change its inputs.

**Q: Why refuse foreign-currency deposits instead of converting?**
A: A customer advance is a non-monetary item under IAS 21: it is booked at the rate on the receipt date and not remeasured. Applying it later against an invoice at a different rate would create an FX difference I have no correct place to post without a design for it. A clear 422 beats a plausible wrong number.

## Follow-ups they'll dig into

- How would you do refunds of an unapplied deposit? (A cash-refund document debiting the liability and crediting bank; the product has no cash refunds anywhere yet.)
- How would you add tax on advances? (A tax line on the deposit invoice and a reversal on application; jurisdiction-specific.)
- What if the order is edited after a deposit was taken? (A confirmed order is immutable; changes mean cancel and re-create, which is why cancel is blocked while live documents exist.)

## See also

- [derived-vs-stored-state.md](derived-vs-stored-state.md)
- [deferred-constraint-triggers.md](../postgresql/deferred-constraint-triggers.md)
- [credit-and-debit-notes.md](credit-and-debit-notes.md)
- [quotes-acceptance-evidence-and-revisions.md](quotes-acceptance-evidence-and-revisions.md)
- [document-lifecycle-fsm.md](document-lifecycle-fsm.md)
- [double-entry-as-an-invariant.md](double-entry-as-an-invariant.md)
