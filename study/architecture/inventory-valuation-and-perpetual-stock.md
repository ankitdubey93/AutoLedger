# Inventory Valuation and Perpetual Stock

> A perpetual inventory system updates quantity and value on every movement, not at period end — which means "what is this worth right now" is always a query away, and the price paid is which costing method the movement math actually uses.

**Category:** Architecture
**Introduced by:** Phase 28 — StockLedger's movement engine: receive, issue, transfer, adjust, each pricing what it moves. Extended in Phase 32 — perpetual inventory *posting to the general ledger*: receipt on a bill, COGS on an invoice, voids, and a stock-to-GL reconciliation check
**Verified against:** PostgreSQL 16.15, Node 22 (the Phase 32 section was verified by integration tests against a real database)

---

## Mechanism

### Perpetual vs periodic

A **periodic** system only knows inventory value at the moments someone counts it: purchases go to an expense/purchases account all period, and a physical count at period end derives cost of goods sold as a plug (`opening + purchases − closing = COGS`). It's cheap to run and was the only realistic option before computers, but it means the books are wrong about on-hand value every day that isn't a count day, and shrinkage is invisible — it's silently baked into COGS with no distinguishing trail. A **perpetual** system, StockLedger's design, posts a value change on every single movement — a receipt raises `stock_balances.value_cents`, an issue lowers it — so on-hand value is correct at every instant, and a stock count is a *reconciliation* against a running number, not the only source of it. The cost is that every movement needs an actual costing decision, not just a period-end average.

### Moving average, FIFO, specific identification

Three ways to answer "what did the unit I'm shipping actually cost," in increasing precision and bookkeeping weight:

- **Moving (weighted) average.** One blended cost per (item, location, lot) balance, recomputed on every receipt. StockLedger's `stock_balances` row *is* this: `quantity_milli` and `value_cents` together imply `averageUnitCostCents = value / quantity`. An issue doesn't ask which specific units are leaving — it takes a proportional slice of the blended value (`utils/stockValuation.ts`'s `outflowValueCents`). Cheap: one row per balance key, no per-unit cost history to retain.
- **FIFO (first-in, first-out).** Cost layers, one per receipt, consumed in receipt order — an issue draws from the oldest layer(s) first, at *that* layer's original cost, until the quantity is satisfied. Needs a `stock_cost_layers` table and a `stock_layer_consumptions` join table recording which layers an issue drew from and how much of each. Materially different from moving average whenever costs are trending (inflation, a price change) — FIFO best matches physical flow for a shelf where the oldest stock genuinely ships first, and it's the master-plan's named next step for StockLedger, not built in Phase 28.
- **Specific identification.** Each unit tracks its *own* cost — no averaging or layering at all, because each unit is individually distinguishable. StockLedger uses this for every SERIAL-tracked item (`stock_serials.cost_cents`): a real-estate unit, a vehicle, a device by IMEI. Issuing serial `A-1205` takes exactly `A-1205`'s own recorded cost (movementService.ts's SERIAL branch), never a blend with `A-1204`'s. This is required, not a choice, the moment units aren't fungible — two flats in the same tower are not interchangeable the way two kilograms of the same steel grade are (Ind AS 2 ¶23: "the cost of inventories of items that are not ordinarily interchangeable... shall be assigned by using specific identification").

Ind AS 2 (and IFRS's IAS 2) permit FIFO and weighted average for fungible inventory and *require* specific identification for non-fungible inventory; **LIFO (last-in, first-out) is prohibited** under both — it was dropped from IAS 2 in 2003 specifically because it tends to understate inventory value on the balance sheet during inflation (matching the newest, priciest units to COGS while carrying the oldest, cheapest units on the books). US GAAP still permits it, which is a genuine standard divergence, not an oversight — this system targets Ind AS/IFRS and leaves LIFO out on purpose.

### Append-only movement ledger + a derived, checked cache

`stock_movements` is append-only by trigger (`reject_stock_movement_mutation`, `BEFORE UPDATE OR DELETE`) — the exact posture `journal_entries`/`ledger_lines` already have (`study/architecture/double-entry-as-an-invariant.md`). A correction is a new movement (an adjustment), never an edit. `stock_balances` is the derived, mutable *cache* of "what does Σ movements currently say" — one row per (item, location, lot), updated in the same transaction as the movement that changed it. The two must always agree, because the balance is arithmetically nothing but a running sum of the movements, so the checker (`db/integrity.ts`'s `stock_balances_match_movements`) recomputes Σ quantity/value per key straight from `stock_movements` and diffs it against `stock_balances` — the same "recompute from the append-only source and compare" discipline the ledger's own integrity checks use.

### Full outflow takes the whole value — never a proportional calculation

`outflowValueCents(balanceQty, balanceValue, outQty)` special-cases `outQty === balanceQty`: it returns `balanceValue` directly, not a computed proportion. This matters because half-up rounding on a proportional split can strand a cent. A balance of (3000 milli, 1000 cents) issued in two steps of 1000 milli each: the first takes `round(1000 × 1000 / 3000) = 333`, leaving (2000, 667); the second takes `round(667 × 1000 / 2000) = 334` (proportional), leaving (1000, 333) — and only the *third* issue, which empties the balance, is allowed to just take what's left (333) rather than recompute `round(333 × 1000 / 1000)`, which happens to still equal 333 here but is not guaranteed to in general. Taking "whatever remains" on the emptying movement is what guarantees the three outflows sum to exactly 1000 — the original value — with nothing left over and nothing double-counted, regardless of how rounding fell on the intermediate steps.

### The valuation-order gap

Every movement is valued in **processing order**, using whatever the balance says *at that moment* — never re-ordered by `occurred_on`. Post a receipt dated last week, after three issues have already happened this week: those three issues were valued against the balance as it stood before the late receipt existed, and they are not retroactively re-priced. This is a deliberate, named gap (not silently wrong — the header comment in `movementService.ts` and `docs/inventory.md` both say so): a fully correct system would need to replay every movement after the earliest back-dated one in date order, recomputing every downstream balance and value — expensive, and StockLedger doesn't do it. A user who consistently back-dates receipts after issuing against them will see a small, understood distortion in valuation, not a crash or a silently wrong invariant (the balance quantity is still exactly right; only which value each *historical* movement carries can drift from what a perfectly-ordered replay would have produced).

### Negative stock, refused twice

The service checks `balance.quantityMilli < requested` before ever computing a value or writing a row, and returns 409. The database checks it too — `stock_balances.quantity_milli BIGINT ... CHECK (quantity_milli >= 0)` — so even a hand-run `UPDATE stock_balances SET quantity_milli = -1` from outside the service is rejected by Postgres itself. The same "guardrail in the service, backstop in the schema" pattern the whole codebase uses for its other invariants (a ledger line's one-side-populated rule, a posted document's immutability).

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Periodic (period-end plug) | Simple, no per-movement costing | On-hand value wrong all period; shrinkage invisible; rejected — this is an ERP module demonstrating perpetual costing, not a bookkeeping shortcut |
| Moving average for everything, including serials | One formula everywhere | Wrong the moment units aren't fungible — averaging two flats' costs together is meaningless. Specific identification for SERIAL items instead |
| FIFO for everything | Textbook-correct cost flow matching | Needs cost-layer tracking (`stock_cost_layers`) this phase doesn't build; named as the next build-ladder step, not Phase 28 |
| Proportional split on every outflow, including the last unit | One formula, no special case | Can strand a cent via compounding rounding; the emptying-movement special case guarantees the value sums exactly |
| Replay/re-cost on a back-dated movement | Fully correct at all times | Expensive (cascading recompute); accepted as a named, documented gap instead |

## Phase 32 — making the perpetual system post to the general ledger

Phase 28 valued stock but posted nothing. A *perpetual* inventory system has two ledgers that must agree: the stock ledger (quantity and value per item) and the GL's inventory asset account. Phase 32 makes every stock movement of a linked item also a journal line, in the **same transaction**, so they cannot drift.

**The three accounting events.**

| Event | Stock ledger | GL |
|---|---|---|
| Purchase (bill approved) | `RECEIPT` at the line's base-currency net value | Dr Inventory (1140) instead of an expense account |
| Sale (invoice issued) | `ISSUE` at the current moving average | same entry as the sale: Dr COGS (5050) / Cr Inventory — revenue is recognised and cost of sales matched in one entry |
| Adjustment / shrinkage | `ADJUSTMENT_OUT` | Dr Inventory Adjustments (5400) / Cr Inventory |

COGS is unknowable until the stock ledger says what the units cost, so the **order matters**: the invoice's stock is issued first, the value it returns is added to the journal, and only then is the invoice number allocated — a 409 for short stock rolls back with nothing consumed.

**Base currency, always.** Inventory is carried in the organization's base currency. A foreign-currency bill converts each inventory account's net total once (exactly as the journal will convert that debit line), then splits it across lines with largest-remainder (`allocateCents`) so the receipts sum to the GL debit to the cent. Converting line by line and summing would drift by cents — that is the failure `allocateCents` exists to prevent.

**Voids are new rows, never edits.** Movements are append-only, so a void appends `ISSUE_REVERSAL` / `RECEIPT_REVERSAL` rows that point at what they undo (`reverses_movement_id`, with a partial unique index so one movement is undone once). Voiding an *invoice* returns stock at the exact value it left at, so no balance constraint can break. Voiding a *bill* is harder because the average may have moved since: if less than the received quantity is on hand it is refused (409); otherwise the original value is removed, clamped to what the balance still holds (`quantity > 0 OR value = 0` and `value >= 0` are CHECKs), and the clamped difference is posted as a variance entry so the two ledgers stay equal. **Rejected: removing at the current moving average** — with 10 @ $5 on hand and a later receipt of 10 @ $10, voiding the second must leave $50, and the average leaves $75, which is simply wrong in the simplest case.

**Reconciliation is a database check, not a hope.** `stock_movements_reconcile_with_gl` groups GL-linked movements by (source document, inventory account), sums their value, and compares it with the net debit on that account across the document's journal entries — including reversing entries, which copy `source_type` but not `source_id` and so are joined back through `reverses_entry_id`. It reconciles *documents*, not the whole account (a manual journal straight to 1140 can still differ); making inventory a control account is the named next step.

## Where it lives in this codebase

- `server/src/utils/stockValuation.ts` — `receiptValueCents`, `outflowValueCents`, `averageUnitCostCents`
- `server/src/services/inventory/movementService.ts` — the four movement-type handlers, each deciding which valuation applies
- `server/src/db/migrations/067_stock_movements.sql` — the append-only trigger, the `quantity_milli >= 0` CHECK, `stock_balances`
- `server/src/db/integrity.ts` — `checkStockBalancesMatchMovements` and (Phase 32) `checkStockMovementsReconcileWithGl`
- `server/src/services/inventory/documentStockService.ts` — receive/issue/reverse for invoice and bill lines; `stockGlService.ts` — journals for manual movements; `movementService.reverseMovementsOnClient` — the void value rules
- `server/src/db/migrations/072_stock_ledger_link.sql` — provenance columns, reversal types, single-reversal index

## Gotchas

- Forgetting the full-outflow special case and always computing proportionally can strand or duplicate a cent across a sequence of partial issues that happens to empty a balance.
- Comparing `stock_balances` to Σ `stock_movements` requires folding `NULL` lot IDs to a sentinel, because SQL `NULL = NULL` is `NULL`, not `TRUE` — a `FULL JOIN` on a raw nullable column silently drops rows that should have matched (see `study/postgresql/transactions-isolation-pooling.md`'s note on `FULL JOIN` conditions).
- A negative-quantity CHECK alone doesn't stop a *negative value with positive quantity* or vice versa — `stock_balances` also has `ck_stock_balances_empty_has_no_value`, because "zero units worth $50" is exactly the kind of drift an incomplete outflow calculation would produce.
- Specific identification means an item's *tracking mode* decides its costing method, not a separate configuration switch — get an item's tracking wrong at creation and it's the wrong valuation forever (tracking is frozen).

## Interview Q&A

**Q: What's the difference between periodic and perpetual inventory?**
A: Periodic inventory only knows on-hand value at count time — purchases go to an expense account all period, and a period-end physical count derives COGS as a plug: opening plus purchases minus closing. Perpetual inventory updates quantity and value on every single movement (receipt, issue, transfer, adjustment), so on-hand value is correct at any instant and a physical count becomes a reconciliation against a running number rather than the only source of the number. StockLedger is perpetual: every movement writes to an append-only ledger and updates a derived balance cache in the same transaction.

**Q: Why can't you use one costing method (say, moving average) for every kind of inventory?**
A: Moving average blends the cost of interchangeable units — it's the right model for a kilogram of steel where any kilogram is as good as any other. But the moment units aren't fungible — a specific apartment, a specific car by chassis number — averaging their costs together is meaningless: unit A-1204 and A-1205 in the same building can have genuinely different construction costs and certainly different sale prices. Ind AS 2 requires specific identification for non-interchangeable inventory. In this system, an item's tracking mode (SERIAL vs LOT/QUANTITY) decides which valuation method applies automatically.

**Q: Why is LIFO excluded?**
A: LIFO is prohibited under IAS 2/Ind AS 2 — it was removed specifically because during inflation it matches the newest, most expensive units to COGS while leaving the oldest, cheapest units on the balance sheet, understating inventory value. US GAAP still permits it, which is a real, current divergence between the two standards, not a historical footnote — worth naming precisely if asked, since it's easy to say "LIFO is banned everywhere," which is wrong.

**Q: How do you guarantee a sequence of partial issues against one balance never loses or fabricates a cent?**
A: The valuation function special-cases the outflow that exactly empties the balance: instead of computing a proportional share (which involves rounding), it returns the entire remaining value. Every issue before that point takes a proportionally-rounded share; the last one takes whatever is left. That guarantees the sum of all the outflows equals the original balance value exactly, regardless of how rounding fell on the intermediate steps — the alternative, always computing proportionally, can strand a cent through compounding rounding.

**Q: What happens if someone posts a receipt dated last week, after issues have already happened this week?**
A: Movements are valued in processing order, not `occurred_on` order — the late receipt does not retroactively re-cost the issues that already happened against the balance as it stood at the time. This is a deliberate, documented gap: a fully correct implementation would replay every movement from the earliest back-dated one forward, recomputing every downstream value, which is expensive and this system doesn't do it. The balance *quantity* stays exactly right either way; only the *value* assigned to already-posted movements can diverge slightly from a perfectly date-ordered replay.

**Q: How do you stop stock from going negative?**
A: Twice — the service checks the locked balance quantity against the requested outflow before computing any value or writing any row, returning a 409 if insufficient; and the database has a `CHECK (quantity_milli >= 0)` constraint on the balance table itself, so even a raw SQL statement bypassing the application can't push it negative. That's the same "guardrail in the service, backstop in the schema" pattern used for the ledger's own invariants.

**Q: What's an append-only ledger buying you here versus just updating a balance column directly?**
A: An append-only movement ledger is the source of truth; the balance is a cache computed from it. If you only ever updated a balance column, a bug or a bad manual fix could silently drift the number with no way to detect or explain it. With the movement ledger, an integrity check can independently recompute Σ movements and compare it against the cached balance at any time — the same "recompute from source and diff" discipline the general ledger's own integrity checks use for debits-equal-credits.

**Q: A bill for stock is approved, then voided after some of it was sold. What should happen?**
A: Refuse if less than the received quantity is still on hand — you cannot un-buy units that left. If enough is left, remove the *original* value of that receipt, not the current average, clamped to what the balance still holds so the CHECK constraints stay true, and post any clamped difference as a variance entry so the stock ledger and the GL still agree. Removing at the current average is wrong even in the simplest case: hold 10 @ $5, receive 10 @ $10, void the second — the correct result is $50, the average leaves $75.

**Q: Why is COGS posted in the same journal entry as the sale, and why is the invoice number allocated after the stock issue?**
A: COGS depends on the cost the stock ledger assigns at the moment of issue, so the stock must be issued before the journal can be built; putting cost of sales in the sale's own entry means revenue and its matching cost are recognised together or not at all, and a void reverses both with one reversing entry. The invoice number comes from a counter row that is locked while a transaction holds it — allocating it *after* the stock issue means a 409 for insufficient stock burns no number, and keeps a single lock order (document → stock balances → number → journal) across every path, which is what prevents deadlocks.

**Q: How do you know the stock ledger and the general ledger agree?**
A: An integrity check compares them per source document: the sum of a document's GL-linked movement values equals the net debit on the inventory account across that document's journal entries and their reversals. It is a query, run by `npm run verify:integrity` and after every scenario in the tests — and it is honest about its scope (per document, not the whole account).

## Follow-ups they'll dig into

- "How would you add FIFO on top of this?" — a `stock_cost_layers` table (one row per receipt, tracking remaining quantity/value) and a `stock_layer_consumptions` join recording which layers an issue drew from; the balance table stays the summary, layers become the detail.
- "What if two people issue the last unit at the same instant?" — pessimistic row locking on the balance, in a deterministic sort order across the whole call, covered in the concurrency note (`study/postgresql/transactions-isolation-pooling.md`).
- "How would you detect and price shrinkage?" — a stock count comparing physical count to the balance cache, posting the difference as an `ADJUSTMENT_OUT`/`ADJUSTMENT_IN` movement — the same movement primitive already built, just triggered by a count workflow rather than a manual entry (not built in Phase 28).

## See also

- [cross-app-transactional-bridge.md](cross-app-transactional-bridge.md)
- [double-entry-as-an-invariant.md](double-entry-as-an-invariant.md)
- [derived-vs-stored-state.md](derived-vs-stored-state.md)
- [../postgresql/transactions-isolation-pooling.md](../postgresql/transactions-isolation-pooling.md)
- [../postgresql/integrity-checking-a-ledger.md](../postgresql/integrity-checking-a-ledger.md)
