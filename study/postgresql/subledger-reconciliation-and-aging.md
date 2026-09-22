# Subledger Reconciliation & Aging

> An AR/AP aging report buckets open documents by how far past due they are, and its grand total must equal the GL control account's own balance — two independently derived numbers that are supposed to agree by construction, and checking that they actually do is the report's real job.

**Category:** PostgreSQL
**Introduced by:** Phase 3.9 — `agingService.ts`, the AR/AP aging reports. Phase 19 supplies the concrete bug this reconciliation exists to catch — see below. Phase 25 adds per-party accounts (a customer's/vendor's own ledger) and the rule that journals may not post to a control account
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

### A real example of `reconciles` going false — and the fix that was rerouting, not adjusting the check

Phase 11 gave AP-Flow a one-click "post to LedgerCore" button. Its first implementation posted a raw journal entry — a debit to an expense account, a credit to the AP control account (`2100`) — directly, with no `bills` row behind it. That is exactly the bug this file's own reconciliation is designed to catch: `apAging`'s subledger side sums open **bills**, but the money AP-Flow moved never became a bill, so the control-account side (`ledger_lines` summed for `2100`) grew while the subledger side didn't. `reconciles` would go `false` the moment AP-Flow posted anything — not because the check was wrong, but because the posting path had quietly created the exact kind of drift this report exists to surface. A symptom noticed only because the reconciliation was already there to notice it.

**The fix was never to weaken or special-case the check.** Loosening `reconciles` to ignore AP-Flow-sourced postings, or excluding `2100` credits with `source_type = 'ap_flow'` from the control-account sum, would have hidden the drift instead of closing it — and it would have meant AP-Flow's payables could never be paid through `/payments`, since that flow works against `bills`, not raw journal entries. The real fix (Phase 19) was to reroute the posting itself: `postingService.ts` now calls `billService.createCapturedBillOnClient` + `approveBillOnClient` on its own transaction, so every AP-Flow posting **is** a bill from the moment it exists, and the two reconciliation sides are back to describing the same underlying reality by construction — exactly the property this file's "Why the subledger is derived from documents..." section above says the whole check depends on.

This is the general lesson a reconciliation check earns its keep by teaching: when an independently-derived cross-check starts failing, the question is never "how do I make the check pass" — it's "what part of the system stopped producing the invariant the check assumes." Here that was a service writing to the ledger without writing to the subledger it claims to be part of.

### Control accounts vs. party sub-accounts, and who may post to them (Phase 25)

**The accounting model.** A business with 2,000 customers does not have 2,000 receivable accounts in its chart. It has **one control account** (`1120 Accounts Receivable`) whose balance is the total owed, and a **subsidiary ledger** ("subledger") per customer that breaks that total down. The trial balance, P&L and balance sheet show only the control account; per-party detail lives on its own reports (customer statement, open items, aging). The invariant tying them together is

```
Σ over customers (customer balance)  =  balance of the AR control account
```

and the same for vendors against AP. QuickBooks, Xero and SAP all work this way; a GL account per party would make the chart and every financial statement unreadable, and every new customer would be a chart-of-accounts change.

**How a "customer account" is built here without a party column on `ledger_lines`.** `ledger_lines` has no `customer_id`/`vendor_id`. Instead a control-account line is *attributed* to a party through the document that posted it: every `invoices`, `bills` and `payments` row carries `journal_entry_id` (the posting) and `void_journal_entry_id` (its reversal), both FK-constrained. `partyLedgerService.buildPartyRowsCte` unions those four `(kind, document, entry)` sources for one party, joins them to `journal_entries` and to `ledger_lines` **filtered to the control account**, and groups per `(entry, document)`:

```sql
party_entries AS (
  SELECT 'INVOICE', d.id, d.invoice_number, d.journal_entry_id      FROM invoices d WHERE d.org_id = $1 AND d.customer_id = $2 AND d.journal_entry_id IS NOT NULL
  UNION ALL SELECT 'INVOICE_VOID', d.id, d.invoice_number, d.void_journal_entry_id FROM invoices d WHERE ... AND d.void_journal_entry_id IS NOT NULL
  UNION ALL SELECT 'PAYMENT',      p.id, p.reference, p.journal_entry_id      FROM payments p WHERE p.org_id = $1 AND p.customer_id = $2
  UNION ALL SELECT 'PAYMENT_VOID', p.id, p.reference, p.void_journal_entry_id FROM payments p WHERE ... AND p.void_journal_entry_id IS NOT NULL
),
party_rows AS (
  SELECT pe.kind, pe.document_id, e.id, e.entry_date,
         SUM(l.base_debit_cents) AS debit_cents, SUM(l.base_credit_cents) AS credit_cents
    FROM party_entries pe
    JOIN journal_entries e ON e.id = pe.entry_id AND e.org_id = $1
    JOIN ledger_lines l    ON l.journal_entry_id = e.id AND l.org_id = $1 AND l.account_id = $3  -- the control account
   GROUP BY ...
)
```

Two details matter. **The grouping:** a payment that settles three invoices posts three control-account lines (one per allocation, each at its own document's frozen FX rate — see [realized-and-unrealized-fx.md](../architecture/realized-and-unrealized-fx.md)); grouping by entry gives the customer one "Payment" row, with the split recovered from `payment_allocations` as `allocations`. **The running balance** is then the same explicit-`ROWS`-frame window function as the account ledger, evaluated over `party_rows` *after* the grouping, so it steps once per document event, not once per line (see [window-functions-and-running-totals.md](window-functions-and-running-totals.md)).

Because it reads the *GL lines* rather than the documents, the party ledger is a GL-side view, while `/open-items` (and the aging report) are document-side views. They are independently derived, so the per-party version of this note's central check holds: **ledger closing balance = open-items outstanding** for every party, and `partyLedger.test.ts` asserts it, then asserts their sum equals `/reports/ar-aging`'s total and control balance. It holds exactly because an invoice/bill with payments applied cannot be voided (409 "Void the payments first") — without that rule, a voided-but-paid invoice would leave a payment credit on the GL side that no open document explains.

**Who may post to a control account.** A manual journal line on `1120` names no customer, so no party ledger can ever claim it and `reconciles` goes `false` permanently. Mainstream packages solve this one of two ways:

- **QuickBooks Online** requires a *Name* (customer/vendor) on any journal line that hits A/R or A/P — the party is carried on the line itself.
- **SAP** marks AR/AP as *reconciliation accounts* that refuse direct posting entirely (message F5354, "Account … cannot be directly posted to"); you post to the customer/vendor subledger and SAP posts the reconciliation account for you.

This codebase takes SAP's route: `journalService.assertNotControlAccountsOnClient` makes `POST /journals` and `POST /bank-transactions/:id/post-journal` return **422** for any line on the configured (or default `1120`/`2100`) control account, while `createEntryOnClient` — the path invoices, bills, payments and FX revaluation use — is deliberately left unguarded. Reversals stay allowed: a reversal of a legacy manual AR entry can only move the books back toward agreement. (Sources: SAP KB 3091350 for F5354; QuickBooks Community threads for the Name requirement — product behavior as documented in September 2026, not independently tested against either product.)

### Negative open items: when a subledger item can owe the other way (Phase 26)

Until Phase 26 every open item was a document with something still owed on it, so every aging query filtered `outstanding_cents > 0` and that was correct. Credit and debit notes broke the assumption. A credit note issued against an invoice that was already paid in full has nothing to apply to, so it posts DR revenue / CR AR for its whole amount and the customer's account now shows a **credit balance**.

The control account moved; if the subledger doesn't move too, `reconciles` goes false by exactly the note amount. So the open-documents CTE in both `agingService` and `partyLedgerService.openItems` now `UNION ALL`s one row per ISSUED note:

```sql
SELECT n.id, n.issue_date AS due_date, n.customer_id AS counterparty_id, cp.name,
       -(n.base_total_cents - <Σ this note's own allocations, base>) AS outstanding_cents,
       'CURRENT' AS bucket
  FROM credit_notes n JOIN customers cp ON …
 WHERE n.org_id = $1 AND n.status = 'ISSUED'
```

Three decisions are in there:

- **Sign.** The unapplied remainder enters *negated*, so a customer with a 6,200.00 invoice and a 500.00 unapplied credit shows 5,700.00. That's what the control account holds for them.
- **Bucket.** An unapplied credit is never overdue, so it is always CURRENT. `overdueCents` stays a sum of genuinely late receivables.
- **Filters.** Every `outstanding_cents > 0` (the bucket `LEFT JOIN`, each per-counterparty `FILTER`, the `HAVING`) became `<> 0`. That is behaviour-preserving for documents, because a document can never be over-settled (deferred triggers enforce payments + notes ≤ total), so only notes are ever negative. The walkthrough and `noteSettlement.test.ts` both assert `reconciles: true` with an unapplied credit on the books.

The *applied* part of a note is handled on the document side instead: each invoice's outstanding subtracts `settledCentsSubquery` (payments **and** ISSUED note allocations). Every note amount is therefore counted exactly once: applied, it reduces its invoice; unapplied, it appears as its own negative item.

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
| One GL account per customer/vendor (sub-accounts of AR/AP) | Balance per party "for free" from the trial balance | Rejected (Phase 25) — thousands of chart rows, every new customer is a chart change, statements unreadable; not how any mainstream package models it |
| `customer_id`/`vendor_id` column on `ledger_lines` (the QuickBooks model) | Journals could carry a party; the party ledger becomes a plain `WHERE` | Rejected for now — needs a migration, a backfill, per-party FX revaluation lines, and aging (which sums *documents*) still wouldn't see a party-tagged journal line, so `reconciles` would still break |
| **Attribute control-account lines via the owning document's `journal_entry_id`; refuse journals to the control account (the SAP model)** | Adjustments (e.g. bad-debt write-offs) now need a document — credit notes are unbuilt | **Chosen** (Phase 25) — no migration, every existing FK already carries the link, and the subledger stays provably equal to the GL |

---

## Where it lives in this codebase

- `server/src/services/ledger-core/agingService.ts` — `buildOpenDocsCte`, `loadBuckets`, `loadCounterpartyRows`, `resolveControlAccount`, `loadControlAccountBalance`
- `server/src/types/ledger-core.ts` — `AGING_BUCKETS`, `AGING_BUCKET_LABELS`, `AgingReport`
- `server/src/__tests__/ledger-core/aging.test.ts` — the bucket-boundary tests (15/51/86/far-past days overdue land in the right bucket) and the `reconciles === true` assertions for both AR and AP
- `server/src/services/ledger-core/reportService.ts` — `trialBalance`, the sibling report this one borrows its debit-normal/credit-normal convention and its "no summary table" discipline from; `bankReconciliation` (Phase 6), the completeness-flavored sibling of this file's correctness-flavored `reconciles`
- `server/src/services/ledger-core/partyLedgerService.ts` (Phase 25) — `buildPartyRowsCte` (attribution), `customerLedger`/`vendorLedger`, `customerOpenItems`/`vendorOpenItems`; `GET /customers/:id/ledger|open-items`, `GET /vendors/:id/ledger|open-items`
- `server/src/services/ledger-core/journalService.ts` — `assertNotControlAccountsOnClient`, called from `createEntry` and `bankMatchService.postJournalForTransaction`, never from `createEntryOnClient`
- `server/src/__tests__/ledger-core/partyLedger.test.ts` — `'per customer, ledger closing === open-items outstanding; their sum === ar-aging total === control balance'`; `controlAccountGuard.test.ts` — the 422s, the rollback, and that documents still post
- `server/src/__tests__/ledger-core/bankReconciliation.test.ts` — `'does not reconcile when a cash movement was never imported'`, the direct proof that a `false` here means an incomplete import, not a books error

---

## Gotchas

- **`CASE` branch order is the whole algorithm.** Swap two `WHEN` clauses and every bucket boundary silently shifts, with no error — the query still runs, it just answers a different question. There's no constraint that can catch this; only a boundary-exact test (15/51/86/far-past days, per bucket) can.
- **`asOf` must flow through as a bind parameter, never string-concatenated.** It already does (`$2::date`), but it's worth naming: a report endpoint accepting a client-supplied date is exactly the kind of value that must never be interpolated (guardrails rule 4).
- **The `VALUES`-list gap-fill only works because the bucket set is small and fixed.** If buckets ever became configurable per organization, this pattern would need to generate the `VALUES` rows from `AGING_BUCKETS` in application code, not hand-type five literals in SQL.
- **Reconciliation can be `null`, not just `true`/`false`.** No configured (and no fallback) control account means there's nothing to compare against — the report says so explicitly (`controlAccount: null`, `reconciles: null`) rather than defaulting to `true`, which would silently claim a clean bill of health for a check that never ran.
- **Changing the configured control account mid-life orphans history from the party view.** The party ledger (and aging) read lines on the *currently* configured control account; lines posted to the old one drop out. Moving AR to a new account should be done with a transfer through documents, or not at all.
- **Some control-account lines belong to no party — by design.** FX revaluation posts one aggregate AR line (reversed the next day), and legacy manual journals from before the guard exist. Neither appears in any customer's ledger; `reconciles` is what surfaces them.
- **Guard the manual path, not the shared posting primitive.** Putting the control-account check inside `createEntryOnClient` would have broken invoice issue, payments and FX revaluation, which are *supposed* to post there. The rule is about *who* posts, so it lives at the entry points humans use.
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

**Q: Should each customer be its own account in the chart of accounts?**
A: No. The chart has one Accounts Receivable control account, and each customer has a subsidiary ledger underneath it. The financial statements show only the control account; the per-customer detail lives on a customer statement, open-items list and aging report. The invariant is that the sum of every customer's balance equals the control account — that's what an auditor checks. Sub-accounts per customer would put thousands of rows in the chart, make every new customer a chart change, and make the balance sheet unreadable; no mainstream package works that way.

**Q: How do you build a per-customer ledger if your journal lines don't have a customer column?**
A: By attribution through the documents. Every invoice and payment row already stores the id of the journal entry it posted and the one that voided it. I union those four sources for a customer, join to `journal_entries` and to `ledger_lines` filtered to the AR control account, and group by entry — so a payment covering three invoices is one row, with the split pulled from `payment_allocations`. Then a window function gives the running balance. No migration, and every link is an existing foreign key.

**Q: Why forbid manual journal entries to Accounts Receivable?**
A: Because a journal line on AR says nothing about *which* customer it belongs to, so after one of those, the customer balances can never add up to the AR balance again — the subledger and the GL permanently disagree. There are two industry answers: QuickBooks makes you name a customer on any AR journal line, and SAP refuses direct postings to AR/AP entirely (its reconciliation accounts). My subledger is built from documents, so I took SAP's route: the manual journal endpoint and the bank-line journal endpoint return 422 for the control accounts, while the document posting path is untouched. Reversals are still allowed, since they can only restore agreement.

**Q: How do you prove the customer ledgers tie to the general ledger?**
A: Two independently-derived numbers per customer. The ledger reads GL lines on the control account attributed to that customer; open items reads the customer's open invoices minus their allocations. The test asserts those are equal for each customer, that their sum equals the aging report's total, and that that equals the control account's GL balance — all integer equality. It holds because a document with payments applied can't be voided, so there's never a payment on the GL side without an open document explaining it.

**Q: If you later needed write-offs or party-tagged journals, what would you change?**
A: Write-offs are a document problem — the right fix is a credit note that posts to AR through the same document path, so it shows up on the customer's ledger and in aging. (Credit notes were built in Phase 26 — see [credit-and-debit-notes.md](../architecture/credit-and-debit-notes.md); a dedicated bad-debt write-off document, posting to bad-debt expense rather than contra-revenue, is still not built.) If party-tagged journals became a requirement, I'd add nullable `customer_id`/`vendor_id` columns to `ledger_lines` with a CHECK that at most one is set and a trigger requiring one when the account is a control account, backfill them from the documents via the same attribution join, and make aging read party balances from the GL instead of documents — at that point the GL is the subledger and the document-vs-GL check changes meaning.

**Q: Your aging report filtered `outstanding > 0`. What broke when credit notes arrived, and how did you fix it?**
A: A credit note against an already-paid invoice has nothing to apply to, so it sits on the customer's account as a credit balance. The GL control account reflected it immediately, but the aging report only listed documents with a positive balance, so the two independently-computed totals disagreed by exactly the note amount and `reconciles` would have gone false. The fix was to make the note an open item in its own right: the unapplied remainder of every issued note is `UNION ALL`-ed into the open-documents CTE as a negative amount in the CURRENT bucket, and the `> 0` filters became `<> 0`. That was safe for existing documents because the database already guarantees they can't be over-settled, so only notes are ever negative.

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
