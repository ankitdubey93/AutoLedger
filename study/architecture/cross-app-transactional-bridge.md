# The Cross-App Transactional Bridge

> Two modules that own different tables must still commit one business event atomically — the pattern is a public `*OnClient` service function that runs on the *caller's* transaction, plus a fixed lock order, plus a pointer that lives on the dependent side.

**Category:** Architecture
**Introduced by:** Phase 32 — a bill or invoice line for a stock item moves inventory and posts to the ledger in one transaction, across the LedgerCore and StockLedger apps. Extended 2026-09-30 (one product form) — one user action ("save product, track inventory, 10 on hand") fanning out across three steps and two modules on one client, and a forward-only type transition that crosses the module boundary
**Verified against:** PostgreSQL 16.15, Node 22 (behaviour verified by integration tests, including a repeated concurrent-issue test)

---

## Mechanism

A modular monolith keeps each app's tables private (guardrails rule 16) but still needs one atomic business event across them: approving a bill must add stock (StockLedger's tables) *and* post a journal (LedgerCore's tables), or do neither.

The mechanism is a **shared transaction handed through a function argument**:

1. The owner of the business event (LedgerCore's `approveBillOnClient`) already holds a checked-out `pg` client inside `BEGIN … COMMIT`.
2. It calls the other app's *public service function* — `documentStockService.receiveForDocumentOnClient(client, orgId, userId, input)` — passing that same client. The callee runs every statement on it and opens no transaction of its own (rule 5: a stray `pool.query` would silently use a *different* connection and escape the transaction).
3. The callee returns plain values (per-line base-currency cents), not rows. The caller builds its own journal from them, so each app writes only to its own tables.
4. If anything throws — short stock (409), a closed fiscal period (422), a database CHECK — the caller's `ROLLBACK` undoes the stock movements, balance updates and code-counter bumps together, because they were all on one connection in one transaction.

The reverse direction works identically: StockLedger's `createItem` calls LedgerCore's `createLinkedItemOnClient(client, …)` so a product-code collision (409) rolls back the stock item *and* its item-code counter bump.

**Lock ordering keeps two apps from deadlocking.** Two transactions each hold a lock the other wants and wait forever — unless every path takes locks in one global order. The order here: **document row (`FOR UPDATE`) → all of the document's stock balances in one sorted pass → invoice-number counter → journal inserts**. A document that touches several items and locations locks every balance up front in `(item, location, lot)` order (the same comparator manual multi-line movements use), so no two paths can each hold a balance the other needs. This is why `issueInvoice` allocates the invoice number *after* the stock issue.

**Where the pointer lives.** The stock item points at its product (`stock_items.ledger_item_id`), not the reverse. StockLedger *requires* LedgerCore, so the dependent app holds the reference; LedgerCore only ever passes its own `items.id` across and never stores an id it cannot check. The column has **no `REFERENCES`** — rule 8 (every `*_id` gets an FK) collides with rule 16 (no app reads another app's tables) and rule 16 wins, the same ruling made for AP-Flow's account ids. The database still enforces what it can: the id is unique per org and a trigger freezes it once set; the service validates it and items are never deleted.


**One form, many steps, one transaction (2026-09-30).** Products & Services has a Xero-style "Track inventory" box. Saving a tracked product with opening stock is one click for the user and five steps for the server, all on one client inside `inventory/itemService.createItem`:

1. Set inventory up if it never was (`setupService.ensureInventoryReadyOnClient`).
2. Insert the stock item.
3. Create the accounting product (`accounting/itemService.createLinkedItemOnClient`).
4. Link the two.
5. Receive the opening stock and post its journal (`movementService.receiveManualOnClient`).

Any failure rolls back all five: a bad opening location, a future date, or a product-code collision. The orchestrator lives in **inventory** because inventory is the module that depends on accounting (it holds the pointer). Putting it in accounting would have made accounting import inventory's item service, a second import direction beyond the one sanctioned seam (`documentStockService`). The HTTP shape follows from this. The client's product form calls `POST /inventory/items` when the box is ticked, and `POST /items` when it isn't.

**A type change that crosses the boundary: turning tracking on later.** The route is `POST /inventory/items/from-product/:id`. The product row lives in accounting and the new stock item lives in inventory, so inventory's `createFromProduct` does three things on one client:
1. It calls accounting's `convertToInventoryOnClient`, which locks the product `FOR UPDATE`, checks the transition, and flips `item_type` while clearing the now-meaningless expense account.
2. It inserts the stock item pointing at that product.
3. It optionally posts opening stock.

Three decisions shape it:
- **The transition is a one-row FSM in accounting's code** (`ITEM_TYPE_TRANSITIONS`: `NON_INVENTORY → INVENTORY` only). The module that owns the column owns the rule (rule 10), and inventory only asks.
- **It is forward-only.** Nothing rewrites history, because posted invoice and bill lines hold *copies* of the item's defaults (migration 060), not references that read through. Past bills stay expensed, and past invoices carry no COGS. Only documents posted afterwards move stock. The alternative, back-filling stock from old bills, would have had to re-cost every later sale, so it was rejected.
- **Switching tracking back off is refused by design.** It would leave stock movements and their GL value pointing at a product that no longer claims to be stock, which would break the inventory-equals-subledger integrity check.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Public `*OnClient` function on the caller's transaction | Atomic; simple; the callee needs no knowledge of the caller. Couples deploy units (same process, same DB) | **Chosen** — the AP-Flow → `billService.createCapturedBillOnClient` precedent already does this |
| Callee opens its own transaction | Strong module isolation | Rejected — two transactions cannot be atomic; a failure between them leaves stock moved and no journal (or vice versa) |
| Outbox / async event ("bill approved" → stock listener) | Decoupled, retryable | Rejected for *this* case — the invoice needs the COGS value **before** it can build its journal, and short stock must fail the sale; eventual consistency cannot do either. (The outbox is right for webhooks.) |
| A "port" interface LedgerCore defines and StockLedger registers into | Cleaner dependency direction | Rejected — needs registration in both the API and worker processes; a missed registration in the worker (which approves bills through AP-Flow auto-post) would fail at runtime |
| One shared product table owned by neither app (Odoo-style) | Purest model | Rejected for this phase — migrates two existing tables; the chosen master (LedgerCore `items`) already had the accounting identity |

## Where it lives in this codebase

- `server/src/services/inventory/documentStockService.ts` — the only StockLedger module LedgerCore imports
- `server/src/services/accounting/billService.ts` (`approveBillOnClient`, `voidBill`) and `invoiceService.ts` (`issueInvoice`, `voidInvoice`) — callers
- `server/src/services/accounting/itemService.ts` (`createLinkedItemOnClient`, `syncLinkedItemOnClient`, `resolveStockAccountsOnClient`) — StockLedger calling back the other way
- `server/src/services/inventory/movementService.ts` — the `*OnClient` cores behind thin `withTransaction` wrappers
- `server/src/__tests__/inventory/documentConcurrency.test.ts` — a last-unit race and opposite line orders, run repeatedly
- `server/src/services/inventory/itemService.ts` (`createItem`, `createFromProduct`) and `accounting/itemService.ts` (`convertToInventoryOnClient`, `ITEM_TYPE_TRANSITIONS`) — the one-form fan-out and the cross-module type transition; `__tests__/inventory/productTracking.test.ts` covers rollback, forward-only conversion and cross-tenant refusal

## Gotchas

- **Import cycles.** LedgerCore imports `documentStockService`; StockLedger imports LedgerCore's `itemService`/`settingsService`/`journalService`. It only works because none of *those* import `billService`/`invoiceService`. Keep the seam narrow and one-way per call chain.
- **`pool.query` inside the callee.** The most damaging mistake: it works in a test with one org and then breaks atomicity in production. Every function in the seam takes `client` first.
- **Post-commit work.** Nothing that must be atomic may happen after `COMMIT`; anything else is a queued job.
- **Validating at save *and* at posting.** A draft can sit for days while an item changes tracking or a location is deactivated, so the tracking/precision/location rules run at draft-save (early feedback) and again at posting (definitive).
- **A multi-currency journal mixes currencies.** COGS/inventory lines are base currency next to foreign-currency receivable/revenue lines; the native-currency balance check must run *before* the base lines are appended.

## Interview Q&A

**Q: How do you keep an operation atomic across two modules that own separate tables?**
A: Give the callee a function that runs on the caller's transaction client rather than its own connection. The caller opens the transaction, calls the other module's public `*OnClient` function with that client, and commits once. Any failure rolls back everything both modules wrote. The callee returns plain values and writes only its own tables, so module boundaries hold (no cross-module table reads) while atomicity comes from the single connection.

**Q: Why not publish an event and let the other module react?**
A: Because the first module needs the answer to finish its own work — an invoice cannot build its cost-of-sales journal line until stock says what the units cost, and a sale with insufficient stock must fail, not succeed and be corrected later. Events give eventual consistency and cannot veto. I use the transactional outbox for what genuinely is fire-and-forget, like webhooks.

**Q: Two requests each issue two different items, listed in opposite order. How do you prevent a deadlock?**
A: A global lock order. Every path locks its rows in the same sequence — document row, then all stock balances sorted by (item, location, lot), then the number counter, then journal inserts. If each transaction acquires locks in the same order, neither can hold something the other is waiting for. The important detail is locking *all* balances in one sorted pass up front instead of as each line is processed, and I test it with concurrent invoices in opposite order, repeated.

**Q: Where does the foreign key between the two apps' tables live, and why isn't it a real FK?**
A: On the dependent app's row (`stock_items.ledger_item_id`), because StockLedger requires LedgerCore and the referenced app should never store an id it can't check. It has no `REFERENCES` because a rule forbidding one app's tables from depending on another's overrides the general "every id is an FK" rule; I compensate with a unique index, a trigger that freezes the value once set, service-level validation, and the fact that products are deactivated, never deleted.

**Q: Tell me about a design decision you rejected in this work.**
A: Voiding a bill for stock by removing the units at the *current* moving average. It looks natural but is wrong in the simplest case — 10 @ $5, then a receipt of 10 @ $10, void the second: it should leave $50, the average leaves $75. I remove the original receipt's value instead, clamped to what the balance can hold, refuse if the units are already gone, and post any clamped difference as a variance entry so stock and ledger stay equal.

**Q: A user turns "track inventory" on for a product they have already bought and sold. What happens to the history?**
A: Nothing. The change is forward-only by design. Posted invoice and bill lines copy the product's price and accounts when they are saved, so they never read through to the product afterwards. The earlier bills stay as expenses and the earlier sales carry no cost of goods sold. From that moment, bills add stock and invoices book COGS at the moving average. The conversion itself is atomic across two modules. Inventory locks the accounting product, and accounting's one-entry transition table decides whether `NON_INVENTORY → INVENTORY` is allowed. The product flips type, the linked stock item is created, and any opening stock is posted, all on the same transaction client. Back-filling stock from past bills was rejected because it would mean re-costing every later sale. Turning tracking off again is refused, because it would orphan the stock ledger's value in the GL.

## Follow-ups they'll dig into

- "What if you later split these into two services?" — the `*OnClient` seam becomes a saga or an outbox with compensation; the atomicity you had for free goes away, which is why the seam is one module wide and easy to find.
- "How do you know the two ledgers agree?" — a reconciliation query in the integrity script, per document, run after every test scenario.
- "What about the worker process?" — bill approval also runs there (AP-Flow auto-post); because the seam is an ordinary import rather than a runtime registration, both processes get it.

## See also

- [inventory-valuation-and-perpetual-stock.md](inventory-valuation-and-perpetual-stock.md)
- [modular-monolith-app-namespacing.md](modular-monolith-app-namespacing.md)
- [transactional-outbox.md](transactional-outbox.md)
- [multi-tenancy-row-level-scoping.md](multi-tenancy-row-level-scoping.md)
- [../postgresql/transactions-isolation-pooling.md](../postgresql/transactions-isolation-pooling.md)
