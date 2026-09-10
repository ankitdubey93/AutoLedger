# Derived vs. Stored State

> Settlement — how much of an invoice or bill has been paid — is never written to a column. It is computed from `payment_allocations` on every read, the same way a trial balance is computed from `ledger_lines` on every read.

**Category:** Architecture
**Introduced by:** Phase 3.9 — LedgerCore payments, deciding whether an invoice/bill needed a `PAID` status or an `amount_paid_cents` column
**Verified against:** PostgreSQL 16

---

## Mechanism

### The two ways to answer "is this paid?"

Given an invoice and a set of payments applied to it, there are exactly two ways to answer "how much is still owed":

1. **Store it.** Add `amount_paid_cents` to `invoices`, and update it every time a payment is recorded or voided.
2. **Derive it.** Sum `payment_allocations.amount_cents` for that invoice, filtered to allocations whose payment is still `POSTED`, computed at read time.

AutoLedger does the second, everywhere in the codebase, for the same reason `reportService.trialBalance` and `dashboardService` compute from raw `ledger_lines` instead of a summary table: **a cached number and the rows that determine it are two sources of truth, and they will disagree eventually.** The question is never "will they drift," it's "who finds out first" — and the honest answer for a stored balance is usually "the auditor."

### What "derive" looks like as SQL

`allocatedCentsSubquery` (`server/src/services/ledger-core/paymentService.ts`) is a correlated scalar subquery embedded in `invoiceService.INVOICE_SELECT` and `billService.BILL_SELECT`:

```sql
COALESCE((SELECT SUM(pa.amount_cents)
            FROM payment_allocations pa
            JOIN payments p ON p.id = pa.payment_id AND p.org_id = pa.org_id
           WHERE pa.org_id = i.org_id
             AND pa.invoice_id = i.id
             AND p.status = 'POSTED'), 0)::text
```

For every row `i` the outer query produces, Postgres executes this subquery once, correlated on `i.id`. The result — `allocated_cents` — becomes an ordinary output column, and `toInvoice()` turns it into `allocatedCents`, `amountDueCents = totalCents - allocatedCents`, and `settlementStatus` via a pure function (`settlementStatusOf`). None of the three is ever written back to `invoices`.

**Why a correlated subquery and not a `JOIN` + `GROUP BY`:** the outer query is already producing one row per invoice (via `INVOICE_SELECT`'s own joins to `customers` and `users`). Joining `payment_allocations` directly would multiply each invoice row by its allocation count — a two-payment invoice becomes two rows — and then every other column in `INVOICE_SELECT` would need to be wrapped in an aggregate or a `GROUP BY` clause it doesn't need. A correlated subquery keeps the row shape 1:1 and pushes only the one aggregate that actually needs grouping into its own scope.

### Why voiding a payment "just works"

The subquery filters `p.status = 'POSTED'`. `payments` has exactly two states — `POSTED` and `VOID` — and `payment_allocations` rows are immutable and insert-only (`trg_allocations_immutable` in migration `014` rejects every `UPDATE`/`DELETE`, unconditionally). So voiding a payment:

```sql
UPDATE payments SET status = 'VOID', voided_at = now(), void_journal_entry_id = $1 WHERE id = $2
```

...changes nothing in `payment_allocations`. The rows that recorded "this payment covered $400 of this invoice" are still there, forever, as history. But the very next read of the invoice re-runs the subquery, and this time `p.status = 'POSTED'` excludes them — so `allocatedCents` drops back to what it was before the payment existed, with zero additional writes. **The un-settlement is a side effect of the query, not a second mutation the code has to remember to perform.** If settlement were a stored column, voiding a payment would need an explicit `UPDATE invoices SET amount_paid_cents = amount_paid_cents - $1` in the same transaction — a second place the invariant can be gotten wrong, and a genuine risk of drift if any future code path voids a payment without going through this exact service function.

### The precedence function

`settlementStatusOf` (`server/src/types/ledger-core.ts`) is a pure function, no I/O:

```ts
export function settlementStatusOf(args: {
  isOpen: boolean; totalCents: number; allocatedCents: number;
  dueDate: string; asOf: string;
}): SettlementStatus {
  if (!args.isOpen) return 'NOT_APPLICABLE';
  if (args.allocatedCents >= args.totalCents) return 'PAID';
  if (args.dueDate < args.asOf) return 'OVERDUE';
  if (args.allocatedCents > 0) return 'PARTIALLY_PAID';
  return 'UNPAID';
}
```

The precedence is deliberate: `OVERDUE` is checked *before* `PARTIALLY_PAID`, so a part-paid invoice past its due date reports `OVERDUE`, not `PARTIALLY_PAID` — because from a collections point of view, "we got some money but it's still late" is a more urgent fact than "we got some money." A stored-column design would have to keep this precedence in sync with every write path that could change either input (a payment, a void, the clock ticking past the due date — which no write touches at all). As a pure function evaluated at read time, the third input (`asOf`, effectively "today") is automatically current without anyone writing anything.

### Reconciliation: the same idea, one layer up

`agingService.aging()` computes AR/AP totals per counterparty (the same `payment_allocations`-derived arithmetic, aggregated by customer/vendor instead of per-invoice) and separately computes the GL control account's balance by summing `ledger_lines` for the receivable or payable account. It then asserts:

```ts
reconciles = totalOutstandingCents === controlAccount.balanceCents;
```

This is the same derived-state principle applied as a *cross-check* rather than a display value: two independently derived numbers — one from the subledger documents, one from the general ledger postings — should agree, by the double-entry construction of the system. If they don't, that is not a UI bug to swallow; it means a payment posted a journal entry without recording an allocation, or vice versa, and the report says so in plain terms (`reconciles: false`) rather than silently showing whichever number happened to be cached.

### Phase 8's exception: `payment_allocations.base_amount_cents` is stored, not derived

Everything above this line follows one rule without exception through Phase 7. Phase 8 introduces the one deliberate departure from it in this codebase: `payment_allocations` gains a `base_amount_cents` column, computed once at write time (`convertToBase(amountCents, targetDocumentRate)`) and stored permanently, even though it is arithmetically derivable from `amount_cents` and the target document's `fx_rate` on every read, exactly the way `allocatedCentsSubquery` already derives `amount_cents`-based totals for the non-FX case.

The reasoning is the same "does the source data ever change under the derived value" test this note applies everywhere else — it just resolves differently here. `amount_cents` is safe to leave undertived because *nothing about it can drift*: the allocation row is immutable by trigger, and `amount_cents` alone is the whole fact. `base_amount_cents`, by contrast, is a *function of two facts stored in two different tables* — the allocation's `amount_cents` and the target document's `fx_rate` — and while neither can change after the fact (both are frozen by their own immutability guarantees), recomputing the conversion at read time would mean re-running `convertToBase`'s rounding on every read rather than once, and a subledger total built that way is only guaranteed to tie to the general ledger's own `base_debit_cents`/`base_credit_cents` (computed once, at post time, by the identical conversion call) if the two computations are provably byte-identical forever — including across any future change to the rounding function itself. Storing the value once, at the moment it was actually posted, makes that tie permanent and independent of what the conversion code does next; deriving it on every read would make the subledger's agreement with the GL contingent on `convertToBase` never changing behavior, which is a much weaker guarantee than "it's the same number because it's literally the same write."

This is not a retreat from the derived-state principle — it is the principle applied one level up. The *rule* being enforced is "reconciles to the cent, permanently." For `amount_cents`, deriving on read achieves that. For `base_amount_cents`, only storing it does, because the value being reconciled against (the GL's own base-currency lines) is itself a frozen historical fact, not a live aggregate — and two frozen facts can only be guaranteed to agree if at least one of them was computed from the other at the moment both existed, not independently re-derived from a shared formula that could theoretically diverge.

---

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| `status: 'PAID'` added to `invoices`/`bills` | Cheap reads, matches how a spreadsheet "feels" | Rejected — would require altering `chk_invoices_issued_complete` and rewriting `trg_invoices_immutable`'s `to_jsonb` row-diff carve-out (migration 009) for a fourth status value that has nothing to do with the document's own lifecycle |
| `amount_paid_cents` maintained by application code | Fast reads, one extra column | Rejected — a second write path per payment/void, and the exact "cached balance drifts from its source rows" failure this codebase's `reportService`/`dashboardService` already refuse to repeat |
| `amount_paid_cents` maintained by a trigger on `payment_allocations` | Removes the app-code risk | Rejected — still a stored duplicate of derivable data; adds trigger complexity to save one `SUM()` that Postgres already computes in single-digit milliseconds at this data volume |
| A materialized view, refreshed periodically | Handles very large data volumes well | Rejected for now — correct answer *when* per-request aggregation stops being fast enough, which it demonstrably still is; premature here (see Follow-ups) |
| **Correlated subquery, computed on every read** | O(rows × allocations) per query; needs the right indexes | **Chosen** — no second source of truth, voiding a payment un-settles for free, and it is the same architectural rule the rest of LedgerCore's reporting already follows |

Guardrails rule: this is the same "no summary table" discipline stated in `reportService.trialBalance` and `dashboardService`'s file-level comments — this note generalizes it into a named principle rather than repeating the reasoning per file.

---

## Where it lives in this codebase

- `server/src/services/ledger-core/paymentService.ts` — `allocatedCentsSubquery(alias, column)`, the one place "how much of a document is paid" is defined in SQL
- `server/src/services/ledger-core/invoiceService.ts` / `billService.ts` — consume the subquery in `INVOICE_SELECT`/`BILL_SELECT`; `toInvoice`/`toBill` call `settlementStatusOf`
- `server/src/types/ledger-core.ts` — `SettlementStatus`, `settlementStatusOf`
- `server/src/services/ledger-core/agingService.ts` — the same subquery reused for aging buckets, and the control-account `reconciles` cross-check
- `server/src/__tests__/ledger-core/payments.test.ts` — `'un-settles the invoice it paid'` asserts the void-and-reread behavior directly
- `server/src/db/migrations/014_ledger-core_payments.sql` — `trg_allocations_immutable`, the trigger that makes "allocations are permanent history" a database guarantee, not a convention

---

## Gotchas

- **The read cost is real, not free.** A correlated subquery runs once per outer row. At portfolio scale it's invisible; at very large data volumes it needs `idx_allocations_invoice`/`idx_allocations_bill` to stay index-only (both exist from migration 014) or a `LATERAL` join. This is a known, accepted trade — see Follow-ups.
- **A derived value is only as current as the query.** If a caller reads a cached `Invoice` object across an `await`, its `allocatedCents` can go stale the instant another request records a payment. This is no different from any other read-then-use race, but it means "cache the invoice object client-side and trust its settlement fields indefinitely" is a bug waiting to happen.
- **Filtering on `p.status = 'POSTED'` is load-bearing, not decorative.** Drop that predicate and a voided payment silently keeps settling its documents — exactly the bug this design exists to make impossible by construction.
- **Derived state composes badly with `ORDER BY`/`WHERE` on the derived value** unless you re-derive in the filter too. `invoiceService`'s `settlement` filter (`OUTSTANDING`/`OVERDUE`/`PAID`) repeats the subquery inline in the `WHERE` clause rather than filtering in application code after the fact, for exactly this reason — filtering post-hoc would break pagination's `totalCount`.
- **Not every stored/derived choice in this codebase is settlement.** `journal_entries.reversed_by_entry_id` genuinely is looked up with a `LEFT JOIN`, not stored, for the identical reason. But `invoices.total_cents` *is* stored — because it's an immutable snapshot of what was invoiced, not a live aggregate of anything. The rule isn't "never store a number that could be computed," it's "never store a number whose *source rows can still change* without a corresponding update to the stored copy."
- **`payment_allocations.base_amount_cents` looks like a rule violation and isn't one — but only because it's computed from two things that are each individually frozen.** If either the allocation's `amount_cents` or the target document's `fx_rate` could still change after the allocation posted, storing the product would be exactly the stale-cache bug this whole note argues against. It's safe here specifically because both immutability guarantees (the allocation trigger, the document's frozen-at-post rate) already hold independently.

---

## Interview Q&A

**Q: Why doesn't an invoice have a `PAID` status?**
A: Because payment isn't part of the invoice's own lifecycle — it's a relationship between the invoice and however many payments get applied to it, possibly none, possibly several partial ones, possibly one that later gets voided. I compute the paid amount from `payment_allocations` on every read instead of storing it, the same way this codebase already computes the trial balance from raw ledger lines instead of a cached balance column. A stored `PAID` status would be a second source of truth that has to be kept in sync with every payment and every void, and the two will eventually disagree — that's not a hypothetical, it's the standard failure mode of denormalized state.

**Q: Doesn't that make every invoice read slower?**
A: It's one correlated subquery per row, backed by an index on `(payment_id, invoice_id)`-shaped lookups, and at the data volumes a system like this actually runs at, that's milliseconds. I'm trading a small, bounded, well-indexed read cost for eliminating an entire class of bug — a stale cached balance — that has no fix except "recompute it anyway to check," at which point you've paid the cost twice.

**Q: What happens when a payment gets voided?**
A: Nothing happens to the invoice — that's the point. Voiding sets the payment's own status to `VOID`; the allocation rows that recorded which invoices it covered are untouched, because they're immutable by trigger. The next time anyone reads the invoice, the settlement subquery re-runs and its `WHERE p.status = 'POSTED'` clause now excludes that payment's allocations, so the paid amount drops back down automatically. There's no second write to "undo" — un-settlement is a read-time consequence, not a write-time action.

**Q: When would you *not* do this — when would you store a derived value instead?**
A: When the read cost actually becomes a measured problem, or when the source rows are effectively append-only at a scale where a live aggregate gets expensive — that's the textbook case for a materialized view with a scheduled or triggered refresh. I'd reach for that before I'd reach for a hand-maintained column, because a materialized view still has exactly one place the aggregation logic lives; a column updated by scattered application code has as many places to get it wrong as there are call sites.

**Q: How is this different from the dashboard's `equationHolds` check?**
A: It's the same principle, used as a cross-check instead of a display value. `agingService` computes the AR total from invoices/payments, and separately computes the receivable *control account's* balance from `ledger_lines`, and asserts they're numerically equal. If they're not, that's not "pick whichever one to show" — it's a real integrity signal that something posted a document without a matching journal entry, or vice versa. Deriving both sides independently is what makes the check meaningful; if one side were just read back from the other, "reconciles" would be trivially true and would catch nothing.

**Q: This codebase's rule is "derive, never store." Is there anywhere it stores a value it could have derived?**
A: One place, deliberately: `payment_allocations.base_amount_cents`, added in the multi-currency phase. Every other derived value in this system is safe to recompute because its source is one immutable row. That column is different — it's the conversion of an allocation's amount by a *document's* exchange rate, two facts living in two different tables. Both are individually frozen, but "frozen and derivable" isn't the same guarantee as "provably tied to the general ledger forever," because the GL's own base-currency figure was computed by the same conversion function at a specific moment in the past. If I derived the subledger's version fresh on every read instead, the two would only be guaranteed to agree as long as the conversion function's behavior never changes — which is a weaker promise than "it's the same number because it's the same write." So I paid the one-column cost to make a permanent tie permanent, rather than contingent.

**Q: Doesn't the subquery duplicate logic between the invoice and bill services?**
A: No — that's why it's a single exported function, `allocatedCentsSubquery(alias, column)`, parameterized only by the table alias and which FK column to join on (`invoice_id` or `bill_id`), both compile-time constants supplied by our own code, never by request input. `invoiceService` and `billService` both call it rather than each writing their own version of "sum posted allocations." One definition of "how much is paid" for the whole app.

---

## Follow-ups they'll dig into

- *"What's the actual query plan cost?"* A correlated subquery with an equality predicate on an indexed FK is an index scan per outer row — `O(rows × log(allocations))`, not a full scan. `EXPLAIN ANALYZE` on a realistic dataset would confirm the planner is using `idx_allocations_invoice`/`idx_allocations_bill` rather than falling back to a sequential scan.
- *"At what point would you switch to a materialized view?"* When the outstanding-balance report itself — not a single invoice lookup — needs to scan and sum across tens of thousands of open documents on every dashboard load. A view refreshed on a schedule (or `REFRESH MATERIALIZED VIEW CONCURRENTLY` triggered by the payment-posting transaction, once background jobs exist) trades read latency for a bounded staleness window instead of trading it for "the wrong number, cached indefinitely."
- *"Could a trigger maintain a cached column safely?"* More safely than application code, since it can't be bypassed by a new call site — but it still duplicates the source of truth and adds write-path complexity (the trigger has to run on insert into `payment_allocations` *and* on status change on `payments`) to save a `SUM()` that isn't currently the bottleneck. I'd want a profiled reason before adding it.
- *"What if two payments race to allocate the last cent of an invoice?"* That's handled elsewhere — the `assert_no_overallocation` deferred constraint trigger (see `deferred-constraint-triggers.md`) locks and re-sums at `COMMIT`, so it's a database-level guarantee, not something the derived-read pattern has to solve on its own.

---

## See also

- [deferred-constraint-triggers.md](../postgresql/deferred-constraint-triggers.md) — the write-side guarantee (no overallocation) that makes the read-side derivation trustworthy
- [aggregating-a-ledger.md](../postgresql/aggregating-a-ledger.md) — the correlated-subquery-vs-JOIN+GROUP-BY trade-off, and the no-summary-table rule stated for `reportService`
- [document-lifecycle-fsm.md](document-lifecycle-fsm.md) — why settlement is not a lifecycle state, and how the bill FSM stays separate from it
- [realized-and-unrealized-fx.md](realized-and-unrealized-fx.md) — the FX engine this note's one stored-not-derived exception belongs to
- [../postgresql/multi-currency-and-functional-currency.md](../postgresql/multi-currency-and-functional-currency.md) — why the GL's own `base_*` columns are the fixed point `base_amount_cents` is permanently tied to
