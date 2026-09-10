# Realized and Unrealized FX: One Subtraction, No Sign Branch

> Accounting textbooks describe realized and unrealized FX gain/loss as four separate cases — a receivable settled high, a receivable settled low, a payable settled high, a payable settled low — each with its own debit/credit direction to memorize. The engineering version is one subtraction: `imbalance = Σ(base debits) − Σ(base credits)` over the lines already built for other reasons. The sign of that one number, not four rules, decides everything.

**Category:** Architecture
**Introduced by:** Phase 8 — realized FX on payment settlement (`paymentService.createPaymentOnClient`) and period-end unrealized revaluation (`fxRevaluationService.runRevaluation`).
**Verified against:** PostgreSQL 16, TypeScript 5.x.

---

## Mechanism

### The worked example, mechanically

An invoice for $1,000 USD is issued when USD/INR is 83.00 (frozen into the invoice at issue: `documentRate`). It is paid ten days later when USD/INR is 83.50 (resolved fresh at settlement: `paymentRate`). Two lines get built for entirely separate reasons:

- **The cash line** — native $1,000, at the *settlement*-date rate (83.50), because that is genuinely what arrived in the bank today.
- **The control line** (the receivable) — native $1,000, at the document's *own frozen* rate (83.00), because that is the value the receivable was carried on the books at since the day it was raised.

Converting both to base currency: cash is ₹83,500; the receivable being cleared is ₹83,000. The ₹500 gap between them is not a bug to reconcile away — it is the entire economic fact a realized-gain account exists to record. The plug line computes it directly:

```ts
const baseDebitTotal  = sumCents(glLines.map((l) => convertToBase(cents(l.debitCents),  l.fxRate)));
const baseCreditTotal = sumCents(glLines.map((l) => convertToBase(cents(l.creditCents), l.fxRate)));
const imbalance = baseDebitTotal - baseCreditTotal;

if (imbalance > 0)      { /* credit 4910 Realized FX Gain for imbalance */ }
else if (imbalance < 0) { /* debit  6810 Realized FX Loss for -imbalance */ }
```

For the receivable: cash is a **debit** of ₹83,500 (money coming into an asset account), the receivable is a **credit** of ₹83,000 (clearing what was owed). `imbalance = 83,500 − 83,000 = +500` → credit `4910`. The entry now has three lines — cash debit 83,500, receivable credit 83,000, gain credit 500 — and `83,500 = 83,000 + 500`, so it balances in base currency exactly as [multi-currency-and-functional-currency.md](../postgresql/multi-currency-and-functional-currency.md)'s invariant requires.

### The mirror case falls out for free

A $1,000 USD *payable* under the identical rate movement produces the opposite journal shape without a single line of sign-specific code. Paying a payable **credits** cash (money leaving) and **debits** the payable (clearing an obligation): cash credit ₹83,500, payable debit ₹83,000. `imbalance = baseDebitTotal (83,000) − baseCreditTotal (83,500) = −500` → **debit** `6810 Realized FX Loss` for 500. A liability that got more expensive to clear is a loss; a receivable that turned out to be worth more is a gain — and the reason the same `imbalance` formula produces the correct sign for both, with no `if (direction === 'PAY')` branch anywhere near the plug logic, is that the RECEIVE/PAY asymmetry is already fully expressed in *which side of the ledger* the cash and control lines were built on **before** the plug ever runs. The plug is direction-agnostic by construction, not by coincidence.

### One control line per allocation, each at its own document's rate

A single payment can settle several documents in one transaction (`paymentService.createPaymentOnClient` accepts an array of allocations). Each allocation targets a document that may have been frozen at a *different* rate — an invoice issued in January at 82.00 and one issued in February at 83.00, both settled today at 83.50. The naive approach — one aggregate control line for the whole payment — cannot work here, because there is no single rate that correctly converts a $2,000 payment split across two documents carried at two different rates. The fix is structural: **one control line per allocation**, each converted at *that allocation's own target document's* frozen rate, never the payment's settlement rate:

```ts
const controlLines = input.allocations.map((allocation) => {
  const target = targets.get(allocation.invoiceId ?? allocation.billId);
  return { accountId: controlAccount.id, /* debit or credit */: allocation.amountCents,
           currencyCode, fxRate: target.fxRate };  // the DOCUMENT's rate, not the payment's
});
```

This is also what keeps every individual line satisfying the CHECK constraint from [multi-currency-and-functional-currency.md](../postgresql/multi-currency-and-functional-currency.md) (`base_amount = round(native_amount × fx_rate)`, per line) — a single blended control line could never carry one `fx_rate` that made that arithmetic true for two documents at once. Splitting by allocation is not a nicety; it is what makes the per-line invariant possible at all when a payment spans documents with different frozen rates.

### Unrealized revaluation: the same plug, one account instead of two

Realized FX fires on settlement — a cash event actually happened. **Unrealized** FX is different: at a period boundary, an organization wants to see (and optionally book) the paper gain or loss on foreign-currency balances that are *still open* — nothing settled, nothing changed hands, only the exchange rate moved. `fxRevaluationService.runRevaluation` restates every open foreign-currency invoice and bill at the as-of date's rate, using the identical imbalance-as-plug technique:

```ts
// AR delta > 0 (asset now worth more) -> debit AR; < 0 -> credit AR
// AP delta > 0 (liability now costs more) -> credit AP; < 0 -> debit AP
const imbalance = baseDebitTotal - baseCreditTotal;   // over just the AR/AP restatement lines
if (imbalance > 0) { /* credit 6820 */ } else if (imbalance < 0) { /* debit 6820 */ }
```

The one structural difference from realized FX: **`6820 Unrealized FX Gain/Loss` is a single account for both directions**, where realized FX uses a pair (`4910`/`6810`). This is a deliberate accounting distinction, not an oversight — a realized gain and a realized loss are different *kinds* of event (one is genuinely revenue, the other genuinely expense, and a P&L reader benefits from seeing them apart), while an unrealized revaluation is one continuous economic estimate that happens to be positive or negative this period and negative or positive next period as rates move back and forth; collapsing it to one account matches how the figure is actually used (a single "mark to market" line), and avoids implying more precision than a paper estimate has earned.

### Why the reversal is not optional

Revaluation posts one entry restating balances *and*, in the same transaction, an automatic reversal dated the calendar day after `asOfDate`, via `journalService.reverseEntryOnClient`. Without it, the very next realized settlement of one of those documents would compute its gain/loss against the *revalued* carrying value rather than the document's original frozen rate — silently double-counting the revaluation's effect the moment the document actually settles. The reversal is what guarantees `paymentService`'s realized-FX calculation can always trust `target.fxRate` (the document's own, permanently frozen rate) as ground truth, indefinitely, regardless of how many period-end revaluations happened in between. This is the same reasoning that makes a reversing entry — rather than an edit — the only correction path for any posted document in this codebase (rule 6): the original fact stays intact and query-able forever, and a later fact supersedes it without erasing it.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Four explicit branches (`if (direction === 'RECEIVE' && imbalance > 0) ... else if (direction === 'RECEIVE' && imbalance < 0) ...`) | Correct, but duplicates the sign logic accounting textbooks already encode implicitly in which side of the ledger a receivable vs a payable normally sits — four paths to test and four places for a sign typo | Rejected — the single `imbalance` computation makes the branch count independent of direction, and a wrong sign shows up as an unbalanced entry immediately, not a silent misclassification |
| One blended control line per payment, converted at the payment's own settlement rate | Cannot satisfy the per-line `base = native × rate` CHECK when one payment settles documents frozen at different rates, and silently misstates which document's realized gain/loss is which when a partial settlement only touches one of several allocations | Rejected |
| Compute realized/unrealized gain/loss in the application and write a single pre-computed adjustment line, skip the plug pattern | Loses the "prove it balances independently of the code that computed it" property the deferred constraint trigger gives every other entry in this system; a bug in the gain/loss math could post a plausible-looking but actually-unbalanced entry that the trigger would still (correctly) reject at `COMMIT` under the plug approach, but might not under a manually-summed one | Rejected — same doctrine as [multi-currency-and-functional-currency.md](../postgresql/multi-currency-and-functional-currency.md): the invariant should never depend on the plug logic being correct, only on the database re-checking it |
| Skip the automatic reversal; let a revaluation stand permanently until the next one supersedes it | Realized settlement math would need to know whether the document it is settling has ever been revalued, and by how much, turning a two-line rate comparison into a query across every prior revaluation | Rejected — the reversal keeps "the document's frozen rate" a single, permanent number, at the cost of one extra journal entry per revaluation |

## Where it lives in this codebase

- `server/src/services/ledger-core/paymentService.ts`'s `createPaymentOnClient` — the realized-FX plug, resolved lazily (only when `imbalance !== 0`, via `resolveFxAccount`) so an organization that removed `4910`/`6810` from its chart can still take base-currency payments without error
- `server/src/services/ledger-core/fxRevaluationService.ts`'s `runRevaluation` — the unrealized plug, the automatic next-day reversal, and `computeExposure` (the identical computation, read-only, backing the `GET /reports/fx-exposure` preview)
- `docs/ledger-core.md § 3` — the worked example this note's mechanics reproduce to the paisa, and the acceptance criterion for the phase
- `server/src/__tests__/ledger-core/fxRealized.test.ts` — the named test `"reproduces docs/ledger-core.md's worked example to the paisa"`, plus the mirror-case (payable) test proving the sign falls out correctly
- `server/src/__tests__/ledger-core/fxRevaluation.test.ts` — the next-day-reversal proof and the balance-sheet-still-balances-after-a-revaluation integration case

## Gotchas

- **The imbalance must be captured *before* the plug line is appended to the same array it was computed from** — recomputing the sum after pushing the plug always yields zero, because the plug exists specifically to zero it out. `paymentService.createPaymentOnClient` captures `realizedFxCents` into a variable at the moment of computation, before any mutation, for exactly this reason.
- **A control line's rate is the target document's rate, never the payment's settlement rate** — using the payment's rate for every control line would make the plug's imbalance always equal zero for a single-document payment (both lines would convert at the same rate), silently hiding every realized gain or loss.
- **The unrealized-revaluation reversal must be dated the *next calendar day*, computed via `Date.UTC` arithmetic, never a plain `new Date(isoString)` parse** — the latter is a documented codebase-wide trap (a `DATE` is a calendar fact, not an instant; parsing it as local time can shift it by a day at certain UTC offsets).
- **`6820` is one account for both directions; `4910`/`6810` are two.** Reusing the realized pattern (two accounts) for unrealized, or collapsing the realized pair into one account, would both be defensible accounting choices in isolation — but they'd be *different* choices than this codebase actually made, and mixing them up produces a P&L that groups realized and unrealized movements together when the point of the split was to keep them apart.

## Interview Q&A

**Q: Walk me through what happens, accounting-wise, when a foreign-currency invoice is paid at a different exchange rate than it was issued at.**
A: The invoice's own line was frozen at issue time — native amount, currency, and the exchange rate in force that day, all stored permanently on the ledger line. At settlement, I build a cash line at today's rate and a control (receivable) line at the *invoice's* frozen rate, not today's rate. Converting both to the base currency, they won't match — the gap between what came in and what was owed is the realized gain or loss, and I post it as a third line so the entry still balances in base currency. Which account it hits and which side depends only on the sign of that gap, computed the same way regardless of whether it's a receivable or a payable.

**Q: How do you avoid writing separate gain/loss logic for receivables versus payables?**
A: I don't special-case direction at all in the plug computation. The direction is already baked into which side of the ledger the cash and control lines were built on before I ever compute the imbalance — a receivable's control line is a credit on settlement, a payable's is a debit. Once those lines exist, `imbalance = total base debits − total base credits` and its sign alone decides gain versus loss and which account to hit. The four-case mental model from accounting theory collapses into one subtraction because the sign convention accounting already uses is exactly what "debit minus credit" encodes.

**Q: A single payment settles two invoices that were issued at different exchange rates. What breaks if you use one blended exchange rate for the whole payment?**
A: The database has a CHECK constraint on every ledger line requiring its base amount to equal its native amount times its own stated rate. A blended control line covering two allocations at different original rates can't satisfy that constraint for both allocations simultaneously — there's no single rate that's correct for both. The fix is one control line per allocation, each carrying its own target document's frozen rate. That's also what keeps the realized-gain calculation honest per-document rather than averaged across the whole payment.

**Q: Why does a period-end revaluation post an automatic reversing entry the next day instead of just leaving the restated balance in place?**
A: Because the point of an unrealized revaluation is a paper estimate at a point in time, not a change to what the document is actually worth. If I left it in place, the next real settlement of that document would compute its realized gain or loss against the *revalued* carrying value instead of the rate the document actually posted at — double-counting the same movement once as unrealized and again as realized. The reversal keeps the document's originally frozen rate as the permanent, single source of truth for what "the original carrying value" means, no matter how many period-end revaluations happen in between.

## Follow-ups they'll dig into

- "What if the exchange rate didn't move between issue and settlement?" — the imbalance is exactly zero, no plug line is posted at all, and the entry is the same two lines it would have been for a base-currency payment; the mechanism degrades to "no FX event" rather than posting a zero-value line.
- "What stops someone from revaluing the same date twice?" — a `UNIQUE (org_id, as_of_date)` constraint on `fx_revaluations`, turned into a readable `409` by the service before the database even has to reject it.
- "What accounts does this actually resolve, and what if they've been deleted from the chart?" — resolution is lazy (only when a gain/loss actually needs posting) and falls back from a configured `ledger_settings` column to a hardcoded chart code (`4910`/`6810`/`6820`, seeded for every organization since Phase 3 for exactly this reason); if neither exists, the whole transaction rolls back with a `422` naming the missing configuration, never a partial post.

## See also

- [../postgresql/multi-currency-and-functional-currency.md](../postgresql/multi-currency-and-functional-currency.md) — the balance invariant this note's entries have to satisfy, and why base currency is what "balanced" means
- [document-lifecycle-fsm.md](document-lifecycle-fsm.md) — why correction is reversal, not edit, and how that same doctrine motivates the revaluation's automatic reversal
- [derived-vs-stored-state.md](derived-vs-stored-state.md) — `payment_allocations.base_amount_cents`, the one deliberate exception to "derive, never store" this phase introduces, and why
