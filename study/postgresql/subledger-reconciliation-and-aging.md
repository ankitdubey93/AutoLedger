# Subledger Reconciliation & Aging

> An AR/AP aging report buckets open documents by how far past due they are, and its grand total must equal the GL control account's own balance — two independently derived numbers that are supposed to agree by construction, and checking that they actually do is the report's real job.

**Category:** PostgreSQL
**Introduced by:** Phase 3.9 — `agingService.ts`, the AR/AP aging reports
**Verified against:** PostgreSQL 16

---

## Mechanism

### Date bucketing with a CASE ladder

Aging buckets are fixed, named ranges of "days past due": `CURRENT`, `1–30`, `31–60`, `61–90`, `90+`. The natural-looking approach is Postgres's `age()` function or `CURRENT_DATE - due_date`, but the bucket boundaries here are computed with plain interval arithmetic against a parameter, not `age()`:

```sql
CASE
  WHEN d.due_date >= $2::date                       THEN 'CURRENT'
  WHEN d.due_date >  $2::date - INTERVAL '30 days'  THEN 'D1_30'
  WHEN d.due_date >  $2::date - INTERVAL '60 days'  THEN 'D31_60'
  WHEN d.due_date >  $2::date - INTERVAL '90 days'  THEN 'D61_90'
  ELSE 'D90_PLUS'
END AS bucket
```

Two things matter about this specific shape:

1. **`$2` is the report's `asOf` parameter, not `CURRENT_DATE`.** A report has to be reproducible for a date in the past ("what did AR aging look like at month-end"), which `CURRENT_DATE` can never give you — it's always today. Parameterizing `asOf` and defaulting it to today only at the call site (`agingService.aging`) keeps the query itself pure with respect to time.
2. **`CASE` branches top-to-bottom and stops at the first match**, so the ladder only needs `>` against successively older cutoffs — it doesn't need to also bound the *upper* edge of each bucket (e.g. `due_date > X AND due_date <= Y`), because anything that would have matched an earlier, more specific branch already did. This reads cleanly as "how overdue, worst case first" but it is order-dependent: reordering the `WHEN` clauses silently breaks it.

`width_bucket()` was the other natural candidate — it maps a numeric value into an equal-width bucket index given a range and a count — but it wants a single numeric axis (days overdue) computed once, and it returns an *index*, not a label, so the CASE ladder is actually less code once you account for turning `width_bucket`'s integer back into `'CURRENT' | 'D1_30' | ...`. `width_bucket` would win if the bucket count or width were data-driven (configurable per organization); here they're a fixed five, defined once in `AGING_BUCKETS`, so the ladder's readability wins.

### Gap-filling the buckets, not just the totals

A report with zero overdue invoices in the 61–90 day range should still show that bucket at `$0`, not omit it — the same "a month with no postings is still a row, at zero" rule `dashboardService.loadTrend` applies to the trend chart via `generate_series`. Here the gap-fill is a `VALUES` list joined against the aggregated data:

```sql
SELECT b.bucket, COALESCE(SUM(od.outstanding_cents), 0)::text AS amount_cents, ...
  FROM (VALUES ('CURRENT'), ('D1_30'), ('D31_60'), ('D61_90'), ('D90_PLUS')) AS b(bucket)
  LEFT JOIN open_docs od ON od.bucket = b.bucket AND od.outstanding_cents > 0
 GROUP BY b.bucket
```

The `LEFT JOIN` guarantees exactly 5 output rows regardless of data; `COALESCE` turns the `NULL` sum from an empty bucket into `0`. `generate_series` produces a *sequence* (evenly spaced values); a fixed, small, named enum like these five buckets is better served by a literal `VALUES` list — there's no formula generating `'D31_60'` from `'D1_30'`, so there's nothing for `generate_series` to generate.

### Control-account reconciliation as an integer-equality assertion

The report's `rows` (per-counterparty breakdown) and `buckets` (bucket totals) are both derived from the *subledger* — the `invoices`/`bills` documents themselves, netted against `payment_allocations` (see [derived-vs-stored-state.md](../architecture/derived-vs-stored-state.md)). Separately, `loadControlAccountBalance` sums `ledger_lines` for the org's receivable (or payable) account:

```sql
SELECT COALESCE(SUM(l.base_debit_cents - l.base_credit_cents), 0)::text AS balance
  FROM ledger_lines l
  JOIN journal_entries e ON e.id = l.journal_entry_id AND e.org_id = l.org_id
 WHERE l.org_id = $1 AND l.account_id = $2 AND e.entry_date <= $3::date
```

The sign of the subtraction (`debit - credit` for AR, `credit - debit` for AP) follows the account's normal balance side — Asset accounts are debit-normal, Liability accounts are credit-normal, the same `DEBIT_BALANCE_TYPES` rule `reportService.trialBalance` already encodes.

These are **two independently computed numbers from two different table families** — one from the documents (`invoices`, `bills`, `payment_allocations`), one from the ledger (`ledger_lines`) — and by the mechanics of double-entry, they are supposed to be identical: every dollar of receivable that exists as an open invoice was, at issue time, posted as a debit to the same receivable account. The report asserts this with `reconciles = totalOutstandingCents === controlAccount.balanceCents` — **integer equality**, no epsilon, matching the `isBalanced` check in `reportService.trialBalance` and every other money comparison in this codebase (guardrails rule 3).

This is the actual point of an aging report in real accounting practice, not a nicety: if the two disagree, it means a document was issued without a matching journal entry, or a journal entry posted to the receivable account without a corresponding invoice — a bug, a manual `psql` mistake, or a missing migration backfill. The report surfaces `reconciles: false` rather than silently trusting either number.

### Why the subledger is derived from documents and the control account from ledger_lines — and never the other way around

It might look simpler to *define* AR as "whatever the receivable account's ledger balance says" and skip the per-invoice bucketing entirely. That throws away exactly the information an aging report exists to provide: the ledger balance is one number, with no way to say which of it is 15 days overdue versus 95. The subledger (documents) carries the *detail* — which customer, which invoice, which due date — and the control account carries the *total*. Reconciliation is meaningful precisely because the two are computed from different data with different grain, and agreeing anyway is the evidence that both are correct.

### Bank reconciliation: the same integer-equality pattern, a different meaning when it fails

Phase 6's `reportService.bankReconciliation` reuses the exact same shape — two independently computed totals, compared by integer equality, with a `reconciles: boolean` flag — but against a genuinely different pair of sources, and that difference changes what a `false` result actually tells you.

```sql
-- The GL side: the cash account's own posted balance.
SELECT COALESCE(SUM(l.base_debit_cents - l.base_credit_cents), 0)::text AS balance
  FROM ledger_lines l
  JOIN journal_entries e ON e.id = l.journal_entry_id AND e.org_id = l.org_id
 WHERE l.org_id = $1 AND l.account_id = $2 AND e.entry_date <= $3::date

-- The statement side: every imported bank line for the same account, not IGNORED.
SELECT COALESCE(SUM(amount_cents) FILTER (WHERE status <> 'IGNORED'), 0)::text AS statement_balance
  FROM bank_transactions
 WHERE org_id = $1 AND account_id = $2 AND txn_date <= $3::date
```

AR aging's two sides — the subledger and the control account — are both derived from data the organization's *own* system produced end-to-end; a mismatch between them is unambiguous evidence of an internal bug, because both sides describe the same underlying reality by construction. Bank reconciliation's two sides describe two genuinely *different* realities that merely ought to agree: the GL side is everything this system believes was posted to the cash account, and the statement side is everything a **CSV file someone chose to upload** says the bank actually did. `reconciles = differenceCents === 0` is still integer equality with no epsilon, but a `false` here does not, on its own, mean either side is wrong — the far more common cause is simply that the statement import is incomplete (a month was never uploaded, or a transaction the bank shows hasn't been imported yet). AR aging's `reconciles` is a **correctness** claim about this system's own internal consistency; bank reconciliation's `reconciles` is a **completeness** claim about whether the statement history is fully caught up — the same boolean, the same comparison mechanics, a different question depending on whether both inputs originate inside the same system or one of them is an external document a human has to keep feeding in.

---

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| `age()` / `CURRENT_DATE - due_date` | Idiomatic, reads naturally | Rejected as the sole mechanism — not parameterizable against a historical `asOf` without extra rewriting, and the report needs a specific `asOf`, not "today," to be reproducible |
| `width_bucket()` | Built for exactly this "which bucket" problem | Rejected here — wants a single numeric axis and a bucket count/width, more code than the CASE ladder for a fixed 5-bucket enum with named boundaries |
| **`CASE` ladder against a parameterized `asOf`** | Order-dependent; must stay top-to-bottom-specific | **Chosen** — reads as "how overdue, worst first," reproducible for any date |
| Trust the GL control-account balance as "the" AR number, skip the subledger detail | Simpler, one source | Rejected — loses the age breakdown per document, which is the entire deliverable of an aging report |
| Trust the subledger sum as "the" AR number, skip control-account reconciliation | Simpler, one query | Rejected — removes the one check that catches documents and postings drifting apart, which is the report's actual value to an accountant |
| **Compute both, assert equality** | Two queries instead of one | **Chosen** — the assertion is the report's job |

---

## Where it lives in this codebase

- `server/src/services/ledger-core/agingService.ts` — `buildOpenDocsCte`, `loadBuckets`, `loadCounterpartyRows`, `resolveControlAccount`, `loadControlAccountBalance`
- `server/src/types/ledger-core.ts` — `AGING_BUCKETS`, `AGING_BUCKET_LABELS`, `AgingReport`
- `server/src/__tests__/ledger-core/aging.test.ts` — the bucket-boundary tests (15/51/86/far-past days overdue land in the right bucket) and the `reconciles === true` assertions for both AR and AP
- `server/src/services/ledger-core/reportService.ts` — `trialBalance`, the sibling report this one borrows its debit-normal/credit-normal convention and its "no summary table" discipline from; `bankReconciliation` (Phase 6), the completeness-flavored sibling of this file's correctness-flavored `reconciles`
- `server/src/__tests__/ledger-core/bankReconciliation.test.ts` — `'does not reconcile when a cash movement was never imported'`, the direct proof that a `false` here means an incomplete import, not a books error

---

## Gotchas

- **`CASE` branch order is the whole algorithm.** Swap two `WHEN` clauses and every bucket boundary silently shifts, with no error — the query still runs, it just answers a different question. There's no constraint that can catch this; only a boundary-exact test (15/51/86/far-past days, per bucket) can.
- **`asOf` must flow through as a bind parameter, never string-concatenated.** It already does (`$2::date`), but it's worth naming: a report endpoint accepting a client-supplied date is exactly the kind of value that must never be interpolated (guardrails rule 4).
- **The `VALUES`-list gap-fill only works because the bucket set is small and fixed.** If buckets ever became configurable per organization, this pattern would need to generate the `VALUES` rows from `AGING_BUCKETS` in application code, not hand-type five literals in SQL.
- **Reconciliation can be `null`, not just `true`/`false`.** No configured (and no fallback) control account means there's nothing to compare against — the report says so explicitly (`controlAccount: null`, `reconciles: null`) rather than defaulting to `true`, which would silently claim a clean bill of health for a check that never ran.
- **The sign convention has to match the account type, not be hardcoded.** AR sums `debit - credit` (Asset, debit-normal); AP sums `credit - debit` (Liability, credit-normal). Getting this backwards makes `reconciles` false for entirely correct data — a wrong-sign bug looks identical to a real reconciliation break until you check the account type.

---

## Interview Q&A

**Q: Why not use `age()` or `EXTRACT(DAY FROM ...)` for the bucketing?**
A: Because the report needs to be evaluated as of an arbitrary date, not "now" — you want to be able to ask what AR aging looked like at last month's close, not only today. `age()` implicitly anchors to `CURRENT_DATE` unless you pass it two explicit dates, at which point it's really just doing the interval subtraction I wrote directly. I bind `asOf` as a query parameter and compare `due_date` against `asOf - INTERVAL 'N days'` in a `CASE` ladder, which stays correct for any date you ask about.

**Q: Walk me through what "the aging report reconciles" actually means.**
A: I compute the total outstanding AR two completely different ways. One: sum every open invoice's `total - allocated` — that's document-level, subledger data. Two: sum the receivable control account's debit balance from `ledger_lines` — that's ledger-level, posting data. In a correct double-entry system these have to be the same number, because issuing an invoice both creates the document *and* posts the debit to that account in the same transaction. So I assert they're equal, with integer equality — no tolerance — and if they're not, the report says `reconciles: false` instead of picking one number and hoping.

**Q: Why integer equality and not "close enough"?**
A: Because the amounts are integer cents throughout this codebase, never floats — there's no rounding noise that would need a tolerance to absorb. If the two numbers differ by even one cent, that's not floating-point error, it's a real data problem: a document without a matching posting, or a posting without a matching document. An epsilon comparison would paper over exactly the bug this check exists to catch.

**Q: Bank reconciliation uses the exact same "two totals, integer equality" pattern as AR aging. If `reconciles` comes back `false` for a bank account, does that mean the same kind of bug as it would for AR aging?**
A: No, and that distinction matters a lot in practice. AR aging's two sides — the subledger and the receivable control account — are both produced entirely by this system; if they disagree, it's an internal bug, full stop, because both numbers describe the same underlying reality by construction (issuing an invoice posts to both at once, in the same transaction). Bank reconciliation's two sides describe genuinely different realities: the GL side is what this system believes it posted to the cash account, and the statement side is whatever a CSV file someone chose to upload says the bank actually did. A `false` there is far more often "the statement for this month hasn't been imported yet" than "something is broken" — it's a completeness signal about the *import*, not a correctness signal about the *books*. Same boolean, same comparison, different question, because one check compares two internally-generated numbers and the other compares an internal number against an external, human-fed one.

**Q: How did you gap-fill empty aging buckets?**
A: A `LEFT JOIN` from a literal five-row `VALUES` list of the bucket names against the aggregated document data, `GROUP BY` the bucket name from the `VALUES` side. Any bucket with no matching documents still produces a row, with `COALESCE(SUM(...), 0)` turning the `NULL` from the join into an explicit zero. It's the same shape `dashboardService` uses with `generate_series` to gap-fill empty months in the trend chart — the general rule is "the report's shape shouldn't depend on which slices of it happen to have data."

**Q: What would break this reconciliation in practice, and how would you debug it?**
A: Anything that posts a journal entry to the receivable account outside `invoiceService`'s issue/void paths, or anything that creates an invoice row without going through the service that posts its journal entry — a raw SQL fix-up script being the classic case. To debug it I'd start from the discrepancy amount and search `ledger_lines` for postings to that account with no corresponding `invoices.journal_entry_id`, or invoices whose `journal_entry_id` points at an entry with the wrong amount.

**Q: Why derive AR from documents at all — why not just report the control account balance directly?**
A: Because the control account balance is one number with no structure — it can't tell you which customer owes what, or how overdue any of it is, which is the entire point of an aging report. The subledger (the invoices themselves) carries that detail; the control account is there specifically to be reconciled *against* the subledger, as a cross-check that the detail and the total agree.

---

## Follow-ups they'll dig into

- *"What if `width_bucket` had been the better choice?"* If the number of buckets or their width became a per-organization setting rather than a fixed five, `width_bucket(days_overdue, 0, 120, 4)` (say) would compute the index directly from a formula instead of a hand-written ladder — better when the boundaries are data, worse when they're a small fixed enum you want named, not indexed.
- *"How would this scale to millions of open documents?"* The `open_docs` CTE re-runs the correlated `allocatedCentsSubquery` per document; at scale you'd want to confirm the planner is using `idx_allocations_invoice`/`idx_allocations_bill` (it should be, both exist) or consider a materialized rollup refreshed on a schedule.
- *"What's the failure mode if reconciliation breaks in production?"* This report is the detection mechanism, not the fix — the fix is a targeted data investigation, possibly a corrective journal entry (never a raw `UPDATE` on an immutable posted row). Phase 5's `verify:integrity` script generalizes this same idea to the whole ledger, not just AR/AP.
- *"Could you compute both sides in one query instead of two?"* Yes, with a lateral join or a CTE combining both aggregates — but keeping them as genuinely separate queries makes it obvious in the code (and to a reader of the diff) that they're independently derived, which is the property the whole check depends on for its meaning.

---

## See also

- [derived-vs-stored-state.md](../architecture/derived-vs-stored-state.md) — why settlement (`allocatedCents`) is computed, never stored, which is what this report's subledger side is built from
- [aggregating-a-ledger.md](aggregating-a-ledger.md) — `FILTER` vs `CASE`, gap-filling with `generate_series`, and the no-summary-table rule this report also follows
- [deferred-constraint-triggers.md](deferred-constraint-triggers.md) — why overallocation is structurally impossible, which is part of why this reconciliation is expected to hold
