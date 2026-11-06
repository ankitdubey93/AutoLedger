# Cash-basis tax attribution and filed-return snapshots

> How to report tax when money arrives in pieces, without rounding drift, and how to keep a filed return from moving afterwards.

**Category:** Architecture
**Introduced by:** Phase 49d, the Business Activity Statement
**Verified against:** PostgreSQL 16, Node 22. Australian tax rules come from ATO search summaries and need checking against the live pages.

---

## Mechanism

**Two bases, one ledger.** The general ledger always records GST when a document is issued. On an accruals basis the BAS reports the same thing. On a cash basis it reports GST as money is received or paid, so the BAS and the GL deliberately disagree by the GST on unpaid documents.

**Attributing by cumulative difference.** For each line, with `s(d)` the amount settled as at date `d`:

```
attributed(d) = round(lineTax × s(d) / total)
in period     = attributed(to) − attributed(day before from)
```

Summing over consecutive periods telescopes:

```
(a(p1) − a(p0)) + (a(p2) − a(p1)) + ... = a(last) − a(start)
```

Since `a(start) = 0` and a fully settled line has `a(last) = round(lineTax × 1) = lineTax`, the periods always sum to exactly the tax.

Example: $333.33 of tax, paid in three equal parts.

| Approach | Period 1 | Period 2 | Period 3 | Total |
|---|---|---|---|---|
| Round each payment's share | 111.11 | 111.11 | 111.11 | 333.33 here, but off by a cent for other amounts |
| Cumulative difference | 111.11 | 111.11 | 111.11 | Always exact, by construction |

**Voids need no special case.** The settled-as-at helpers stop counting a payment from its void date. So `s(to)` falls below `s(before)` and the difference comes out negative, on the right date, automatically.

**Notes mirror what they settle.** A credit note counts by its applied amount with a negative sign, using the same date as the allocation that settles the invoice. An invoice cleared entirely by a note reports `+tax` and `−tax` in the same period and nets to nil, with no branch for it.

**Reversals are linked, not copied.** A journal's GST detail is written once. A reversal is found through `journal_entries.reverses_entry_id` and produces the opposite event on its own date. There's no second row that could disagree.

**Snapshot on finalise.** A draft computes live. Finalising stores the labels and contributing events. Reads then come from the stored rows, never recomputed, so a later rule change or bug fix can't alter what was reported.

**Closing the window.** Finalising closes the fiscal months covered, so the posting trigger refuses anything dated inside them. Credit note allocations post no journal and that trigger never sees them, yet they change a cash-basis return, so they have their own guard.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Cumulative difference per line | Exact over time, stateless, and handles voids. Needs an as-at query per document | **Chosen** |
| Store each payment's GST share at payment time | Fast to read, but a void or a change in a note means correcting stored rows, and rounding accumulates | Rejected |
| Post GST to a suspense account until paid | The GL would match the cash BAS, but it changes postings for every document | Rejected: the GL stays accrual, and the gap is reconciled and shown |
| Recompute a filed return on demand | Always current, but a filed tax return must not change | Rejected: snapshot |
| Reuse fiscal-period close for the lock | No new lock, and months already have an FSM and a trigger | **Chosen**, plus a guard for allocations |

## Where it lives in this codebase

- `server/src/services/accounting/gstEventService.ts`: the event stream, both bases
- `server/src/utils/basWorksheet.ts`: events to labels, pure
- `server/src/utils/basPeriods.ts`: periods and due dates, pure
- `server/src/services/accounting/basService.ts`: the lifecycle, reconciliation, clearing journal
- `server/src/db/migrations/109_ledger-core_bas_returns.sql`: tables and immutability triggers

## Gotchas

- **Only money that hits the GL can clear it.** A manual BAS adjustment has no posting behind it. If the clearing journal debited the GST account for it, that account would stay wrong forever, so an adjustment names its own account for the other side.
- **Whole-dollar reporting leaves cents.** The BAS reports dollars and the GL holds cents. The clearing journal credits the ATO with what was reported and sends the difference to Rounding, so the entry balances to the cent.
- **The clearing journal can't use the period's date,** because finalising closed that period. It's dated at lodgment.
- **Other reports read those accounts.** The Tax summary's GL check had to learn to skip clearing journals, or every lodged BAS would have looked like a discrepancy.
- **A check-then-write race remains.** A posting that passed the period trigger but hadn't committed when the close committed can still land. The fix would be a stronger lock around every posting, which wasn't worth it for this window, and the fiscal-period close has always had the same race.

## Interview Q&A

**Q: You need to split an amount over several payments. How do you avoid rounding drift?**
Don't round each payment's share independently. Compute the cumulative amount due at each point, and take the difference between consecutive points. The sum telescopes to the last cumulative value, and when fully paid that's the exact total. It's the same idea as Bresenham's line algorithm or `allocateCents`: error can't accumulate because each step is measured from the running total rather than from the previous step's rounded value.

**Q: Why is the ledger accrual when the tax report is cash?**
Because the ledger answers "what happened", and a tax basis is one way of reporting it. Changing postings by basis would mean a business switching basis has a different ledger, and every other report would have to care. Keeping one ledger means the difference between the two bases is a number you can compute and display, which is the GST on unpaid documents.

**Q: How would you test that a tax return is right?**
Work expected figures by hand from the transactions, and never read them back from the engine, or the test only proves the code agrees with itself. Add an invariant test: over random partial payments, periods sum to exactly the tax. And reconcile to an independent source, here the GL movement on the GST accounts, which comes from a completely different code path.

**Q: Why store a snapshot rather than recompute a finalised return?**
A return is a statement made to a regulator on a date. It must stay what was said, even if a bug is fixed or a rule changes later. Recomputing would silently rewrite history. The contributing events are stored too, so you can still show which transactions produced a figure years later, even if those documents' classifications would be computed differently now.

**Q: How do you enforce that a filed document can't change?**
In two layers. The service's state machine has no transition out of `LODGED`, which gives a good error message. A database trigger refuses UPDATE and DELETE on the row and its children, which protects against a bug, a script, or a future developer who didn't know. The trigger is what makes it a guarantee rather than a convention.

**Q: Your state machine allows reopening a finalised return. Why not make that immutable too?**
Because finalised means "ready to lodge", and people find mistakes at that point. Nothing has legally happened yet. The point of no return is lodgment, when a statement has been made to the ATO. After that a correction belongs on a later return, which is how the real process works.

## Follow-ups

- "What about partial use, or GST on deposits?" Not built. The return warns about deposits and offers a manual adjustment, because a silently wrong number is worse than a visible gap.
- "How would direct lodgment fit?" A filing adapter replaces the manual step at `FINALISED → LODGED`, with the ATO receipt coming from the response. Registering as a Digital Service Provider is mostly not a coding problem.
