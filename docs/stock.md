# StockLedger — App Spec & Build Ladder

**Slug:** `stock` · **Domain:** Inventory & Warehousing · **Phase:** 28
**Status: Phase 28 done; Phase 32 (step 1) connects it to LedgerCore.** `config/apps.ts` marks it `'building'`. Every checkbox below is ticked — see [roadmap.md](roadmap.md#phase-28-as-delivered) for what was actually delivered.

StockLedger is perpetual inventory for retail traders, manufacturers, distributors and real-estate developers alike: an industry-chosen starting catalogue, per-organization custom item attributes, a configurable item-code grammar, QR label generation, and quantity/value tracking through an append-only movement ledger with a derived, integrity-checked balance cache. Until Phase 32 it created no journal entry; **from Phase 32 it `requires: ['ledger-core']`**: every stock item is linked to a LedgerCore product (Products & Services), bills receive stock and invoices issue it through `documentStockService`, and the movements of a linked item post journals — see [The rule-16 boundary](#the-rule-16-boundary-in-practice) and [roadmap.md § Phase 32](roadmap.md#phase-32-as-delivered).

**Gated on LedgerCore (Phase 32).** StockLedger reads no other app's tables (it calls LedgerCore's public service functions) and needs no background job, no FX, and no Document Vault. It does share the platform onboarding-state and Document Vault infrastructure other apps use, but doesn't require either to function.

---

## Core technical capabilities

### A. Industry setup

`POST /stock/setup` applies one of ten industry profiles (`config/stockIndustryProfiles.ts`) — `RETAIL`, `WHOLESALE_DISTRIBUTION`, `MANUFACTURING`, `FOOD_BEVERAGE`, `PHARMA_HEALTHCARE`, `APPAREL_FOOTWEAR`, `ELECTRONICS`, `AUTOMOTIVE`, `REAL_ESTATE`, `GENERAL` — by **copying** its units of measure, categories (with their custom-field definitions), code schemes and a default location into the organization's own tables. After that copy, the org owns and can freely edit every row; the profile file is never read again at request time except to render the list and a suggestion. `GET /stock/setup/profiles` returns the full list with each one's `industryKeywords`, used to pre-highlight a likely match against the organization's own business-category text from platform onboarding — a suggestion, never an automatic or forced choice.

| Profile | Example categories |
|---|---|
| Retail store | Merchandise, packaging & bags, store consumables |
| Wholesale & distribution | Trading goods, packaging |
| Manufacturing | Raw materials, components, WIP, finished goods, packaging material, spares, consumables |
| Food & beverage | (perishables — LOT tracking, expiry dates) |
| Pharma & healthcare | (batch/serial tracking, expiry-critical) |
| Apparel & footwear | (style-color-size variant coding) |
| Electronics | (serial-tracked units, IMEI-style codes) |
| Automotive | (parts + serial-tracked vehicles) |
| Real estate | Residential units (SERIAL-tracked, per-unit attributes: tower, floor, carpet area) |
| General | A minimal, industry-agnostic starting point |

### B. Catalogue configuration

Four configuration primitives, each with full CRUD (create/read/update — no `DELETE`, retirement is `isActive: false` via `PATCH`, matching every other app's catalogue-table convention):

- **Units of measure** (`stock_uoms`) — a code, a name, and `decimalPlaces` (0–3), governing how a quantity input is parsed (`client/src/utils/quantity.ts`'s `parseQuantityToMilli`/`formatQuantityMilli`).
- **Categories** (`stock_categories`) — up to 3 levels deep (a recursive-CTE path/depth check), each with an `itemType` (one of nine: `RAW_MATERIAL`, `COMPONENT`, `WORK_IN_PROGRESS`, `FINISHED_GOOD`, `TRADING_GOOD`, `CONSUMABLE`, `PACKAGING`, `SPARE_PART`, `PROPERTY_UNIT`), a `defaultTracking` mode, and a default UoM. A category is frozen once created — code, parent, item type and default tracking never change — which is what makes a parent-cycle check structurally unnecessary rather than merely untested.
- **Custom attribute definitions** (`stock_attribute_definitions`) — per-category, per-scope (`ITEM` or `SERIAL`) field definitions: a key, a label, a `dataType` (`TEXT`/`NUMBER`/`DATE`/`BOOLEAN`/`SELECT`), required-or-not, and (for `SELECT`) an options list. See [attribute rules](#c-user-defined-attributes) below.
- **Locations** (`stock_locations`) — up to 4 levels (`WAREHOUSE`/`STORE`/`SITE` at the top, `ZONE`/`BIN` only nested inside one), a recursive path CTE for display.

### C. User-defined attributes

Every organization's item and serial custom fields are **JSONB**, not a fixed column set and not an entity-attribute-value side table — see [study/postgresql/jsonb-user-defined-attributes.md](../study/postgresql/jsonb-user-defined-attributes.md) for the full reasoning. The database's only check is `jsonb_typeof(attributes) = 'object'`; every per-attribute rule (required, type, `SELECT` options, decimal precision) is enforced in `utils/stockAttributes.ts`'s `validateAttributes`, run against the category's own `stock_attribute_definitions` rows on every item/serial create or attribute edit.

A `NUMBER`-typed value is stored as a **validated decimal string**, never a JSON number — a JSON number parses through a 64-bit float with no precision guarantee, the same reasoning behind this codebase's money-as-integer-cents rule, generalized to any precision-sensitive user field. A `PATCH` to an item's or serial's `attributes` **merges** (`||`) rather than replaces, so editing one field never silently drops the others.

### D. Item-code schemes

An item's code is either typed by hand or generated from an organization-configured **pattern** — a small grammar (`utils/stockCodePattern.ts`, a pure tokenizer/parser/renderer, no database import, never throws — see [study/typescript/discriminated-unions-and-parsers.md](../study/typescript/discriminated-unions-and-parsers.md)):

| Token | Meaning |
|---|---|
| Literal chars | `A`–`Z`, `0`–`9`, `-`, `_`, `/`, `.` (1–60 chars total) |
| `{CAT}` | the item's category code |
| `{YYYY}` / `{YY}` | the 4- or 2-digit UTC year at generation time |
| `{ATTR:key:n}` | an item-level attribute value, sanitized (upper-cased, non-alphanumerics stripped) and truncated to `n` characters (1–10) |
| `{SEQ:n}` | the sequence number, zero-padded to `n` digits (3–8) — **exactly one required per pattern** |

A rendered code must match `^[A-Z0-9][A-Z0-9\-_/.]{0,39}$` (also `stock_items.code`'s CHECK) and be at most 40 characters. Seven ready-made presets (`CODE_SCHEME_PRESETS`) cover the common shapes — `{CAT}-{SEQ:5}`, `{CAT}-{YY}-{SEQ:4}`, a brand-prefixed pattern, a style-color-size variant pattern, and others.

The counter behind `{SEQ:n}` is keyed by `(org_id, scheme_id, scope_key)` — **one counter per distinct rendered scope**, not one per organization — so a pattern keyed by category and year restarts its sequence independently for every category and every year, via the same `UPDATE ... RETURNING` row-lock pattern LedgerCore's invoice numbering established (`study/postgresql/gapless-numbering-and-counters.md`). A hand-typed code that happens to collide with a value the counter would later generate is handled by a bounded 20-attempt retry, not a hard failure.

### E. Tracking modes and valuation

Every item is tracked one of three ways, chosen once at category default and overridable per item, and frozen thereafter:

| Mode | Unit of movement | Valuation |
|---|---|---|
| `QUANTITY` | fractional (milli-precision) | moving average |
| `LOT` | fractional, grouped into lots (`stock_lots`, with an optional expiry) | moving average per (item, location, lot) |
| `SERIAL` | exactly 1 unit per movement | specific identification — each `stock_serials` row carries its own `cost_cents` |

Full reasoning — perpetual vs. periodic, why LIFO is excluded, the full-outflow-takes-remaining-value rounding rule, and the valuation-in-processing-order gap on a back-dated receipt — lives in [study/architecture/inventory-valuation-and-perpetual-stock.md](../study/architecture/inventory-valuation-and-perpetual-stock.md).

### F. Movements and the balance cache

Four movement types — `receive` (→`RECEIPT`), `issue` (→`ISSUE`), `transfer` (→`TRANSFER_OUT`+`TRANSFER_IN`, one `movement_group_id`), `adjust` (→`ADJUSTMENT_IN`/`ADJUSTMENT_OUT`) — each writing one or more rows to the append-only `stock_movements` table (a `BEFORE UPDATE OR DELETE` trigger rejects any mutation, the same posture `journal_entries` has) and updating `stock_balances`, a derived cache, in the same transaction. `db/integrity.ts`'s `stock_balances_match_movements` independently recomputes Σ movements per `(org_id, item_id, location_id, lot_id)` and diffs it against the cached balance — the 5th of the platform's integrity checks.

**Lock ordering rule:** any call locking more than one `stock_balances` (or `stock_serials`) row sorts the complete key set into one canonical order *before* issuing any `SELECT ... FOR UPDATE` — a `transfer`'s two balance rows are always locked in the same relative order regardless of direction, which structurally prevents the opposite-direction deadlock two concurrent transfers would otherwise risk. A row that may not exist yet (the first-ever movement for a key) is seeded via `INSERT ... ON CONFLICT DO NOTHING` before the lock, the same lazy-seed idiom a counter row uses. Full mechanism: [study/postgresql/transactions-isolation-pooling.md](../study/postgresql/transactions-isolation-pooling.md).

Negative stock is refused twice — once in the service (checked against the locked balance before any write) and once by `stock_balances`'s own `CHECK (quantity_milli >= 0)`.

### G. Serial status FSM

A `SERIAL`-tracked unit carries a status, changed either manually (a person books or holds a unit) or as a movement side effect (issuing a unit moves it to `ISSUED`; a later re-receipt moves it back to `AVAILABLE`):

| From | To | Via |
|---|---|---|
| `AVAILABLE` | `ON_HOLD` | MANUAL |
| `AVAILABLE` | `BOOKED` | MANUAL |
| `AVAILABLE` | `ISSUED` | MOVEMENT |
| `ON_HOLD` | `AVAILABLE` | MANUAL |
| `ON_HOLD` | `BOOKED` | MANUAL |
| `BOOKED` | `AVAILABLE` | MANUAL |
| `BOOKED` | `ISSUED` | MOVEMENT |
| `ISSUED` | `AVAILABLE` | MOVEMENT |

One exported transition table (`types/stock.ts`'s `STOCK_SERIAL_TRANSITIONS`, checked by `canTransitionSerial`), declared as a plain `Record<StockSerialStatus, ...>` annotation rather than `as const satisfies` — deliberately, since what this table needs is compiler-enforced exhaustiveness over every status, not literal-value preservation; see [study/typescript/const-assertions-and-satisfies.md](../study/typescript/const-assertions-and-satisfies.md). `ISSUED` serials structurally carry `location_id IS NULL` (`ck_stock_serials_location`), which is why the service checks a serial's status before its location on an outbound movement — checking location first would mask the specific "not in stock" message behind a generic "not at location" one.

### H. Lookup, QR labels

`GET /stock/lookup?code=` resolves an exact-match code (item, lot number, or serial number) via a `UNION ALL`, org-scoped. `POST /stock/labels` generates one QR label per requested target (`ITEM`/`LOT`/`SERIAL`/`LOCATION`), each up to a copies count, capped at 500 labels per request. The QR payload is deliberately minimal — `${FRONTEND_URL}/app/stock/scan/<kind>/<id>`, a route and a UUID, nothing business-identifying — because a printed label is scannable by anyone, permanently, with no way to revoke it; resolving the scan URL into a name, quantity or cost requires the authenticated, org-scoped scan route. Full reasoning, the GTIN checksum, and error-correction-level choice: [study/architecture/barcodes-and-qr-codes.md](../study/architecture/barcodes-and-qr-codes.md).

---

## The rule-16 boundary, in practice

Phase 28 posted nothing to the GL. **Phase 32 adds the bridge, in both directions, through public service functions only** — neither app reads the other's tables:

- **StockLedger → LedgerCore** (`services/stock/stockGlService.ts`, `itemService.ts`): calls `ledger-core/itemService` (`createLinkedItemOnClient`, `syncLinkedItemOnClient`, `resolveStockAccountsOnClient`), `settingsService.resolveInventoryPostingAccountsOnClient` and `journalService.createEntryOnClient` (`sourceType 'stock'`) on its own transaction client. It creates the linked product when an item is created and posts a journal for a linked item's manual movement.
- **LedgerCore → StockLedger**: `invoiceService` and `billService` import exactly one module, `services/stock/documentStockService.ts` (`receiveForDocumentOnClient`, `issueForDocumentOnClient`, `reverseDocumentOnClient`, `validateDocumentLinesOnClient`). LedgerCore builds its own journal from the values it returns; StockLedger writes no journal line for a document.
- The link is `stock_items.ledger_item_id` (no FK — rule 16 over rule 8; unique, frozen once set). Movements carry `source_type`/`source_id`/`gl_account_id`/`reverses_movement_id`.

Verify the boundary with:

```bash
grep -rnE "FROM (items|accounts|ledger_lines|journal_entries|invoices|invoice_lines|customers|vendors|bills|bill_lines|payments|ap_flow_)" server/src/services/stock/ server/src/controllers/stock/
grep -rnE "FROM stock_|JOIN stock_" server/src/services/ledger-core/
```

Both return nothing. (`services/ledger-core/documentStockLines.ts` reads LedgerCore's own `items` table, and the stock services read only `stock_*`.)

`utils/stockCodePattern.ts`, a pure tokenizer/parser/renderer, no database import, never throws — see [study/typescript/discriminated-unions-and-parsers.md](../study/typescript/discriminated-unions-and-parsers.md)):

| Token | Meaning |
|---|---|
| Literal chars | `A`–`Z`, `0`–`9`, `-`, `_`, `/`, `.` (1–60 chars total) |
| `{CAT}` | the item's category code |
| `{YYYY}` / `{YY}` | the 4- or 2-digit UTC year at generation time |
| `{ATTR:key:n}` | an item-level attribute value, sanitized (upper-cased, non-alphanumerics stripped) and truncated to `n` characters (1–10) |
| `{SEQ:n}` | the sequence number, zero-padded to `n` digits (3–8) — **exactly one required per pattern** |

A rendered code must match `^[A-Z0-9][A-Z0-9\-_/.]{0,39}$` (also `stock_items.code`'s CHECK) and be at most 40 characters. Seven ready-made presets (`CODE_SCHEME_PRESETS`) cover the common shapes — `{CAT}-{SEQ:5}`, `{CAT}-{YY}-{SEQ:4}`, a brand-prefixed pattern, a style-color-size variant pattern, and others.

The counter behind `{SEQ:n}` is keyed by `(org_id, scheme_id, scope_key)` — **one counter per distinct rendered scope**, not one per organization — so a pattern keyed by category and year restarts its sequence independently for every category and every year, via the same `UPDATE ... RETURNING` row-lock pattern LedgerCore's invoice numbering established (`study/postgresql/gapless-numbering-and-counters.md`). A hand-typed code that happens to collide with a value the counter would later generate is handled by a bounded 20-attempt retry, not a hard failure.

### E. Tracking modes and valuation

Every item is tracked one of three ways, chosen once at category default and overridable per item, and frozen thereafter:

| Mode | Unit of movement | Valuation |
|---|---|---|
| `QUANTITY` | fractional (milli-precision) | moving average |
| `LOT` | fractional, grouped into lots (`stock_lots`, with an optional expiry) | moving average per (item, location, lot) |
| `SERIAL` | exactly 1 unit per movement | specific identification — each `stock_serials` row carries its own `cost_cents` |

Full reasoning — perpetual vs. periodic, why LIFO is excluded, the full-outflow-takes-remaining-value rounding rule, and the valuation-in-processing-order gap on a back-dated receipt — lives in [study/architecture/inventory-valuation-and-perpetual-stock.md](../study/architecture/inventory-valuation-and-perpetual-stock.md).

### F. Movements and the balance cache

Four movement types — `receive` (→`RECEIPT`), `issue` (→`ISSUE`), `transfer` (→`TRANSFER_OUT`+`TRANSFER_IN`, one `movement_group_id`), `adjust` (→`ADJUSTMENT_IN`/`ADJUSTMENT_OUT`) — each writing one or more rows to the append-only `stock_movements` table (a `BEFORE UPDATE OR DELETE` trigger rejects any mutation, the same posture `journal_entries` has) and updating `stock_balances`, a derived cache, in the same transaction. `db/integrity.ts`'s `stock_balances_match_movements` independently recomputes Σ movements per `(org_id, item_id, location_id, lot_id)` and diffs it against the cached balance — the 5th of the platform's integrity checks.

**Lock ordering rule:** any call locking more than one `stock_balances` (or `stock_serials`) row sorts the complete key set into one canonical order *before* issuing any `SELECT ... FOR UPDATE` — a `transfer`'s two balance rows are always locked in the same relative order regardless of direction, which structurally prevents the opposite-direction deadlock two concurrent transfers would otherwise risk. A row that may not exist yet (the first-ever movement for a key) is seeded via `INSERT ... ON CONFLICT DO NOTHING` before the lock, the same lazy-seed idiom a counter row uses. Full mechanism: [study/postgresql/transactions-isolation-pooling.md](../study/postgresql/transactions-isolation-pooling.md).

Negative stock is refused twice — once in the service (checked against the locked balance before any write) and once by `stock_balances`'s own `CHECK (quantity_milli >= 0)`.

### G. Serial status FSM

A `SERIAL`-tracked unit carries a status, changed either manually (a person books or holds a unit) or as a movement side effect (issuing a unit moves it to `ISSUED`; a later re-receipt moves it back to `AVAILABLE`):

| From | To | Via |
|---|---|---|
| `AVAILABLE` | `ON_HOLD` | MANUAL |
| `AVAILABLE` | `BOOKED` | MANUAL |
| `AVAILABLE` | `ISSUED` | MOVEMENT |
| `ON_HOLD` | `AVAILABLE` | MANUAL |
| `ON_HOLD` | `BOOKED` | MANUAL |
| `BOOKED` | `AVAILABLE` | MANUAL |
| `BOOKED` | `ISSUED` | MOVEMENT |
| `ISSUED` | `AVAILABLE` | MOVEMENT |

One exported transition table (`types/stock.ts`'s `STOCK_SERIAL_TRANSITIONS`, checked by `canTransitionSerial`), declared as a plain `Record<StockSerialStatus, ...>` annotation rather than `as const satisfies` — deliberately, since what this table needs is compiler-enforced exhaustiveness over every status, not literal-value preservation; see [study/typescript/const-assertions-and-satisfies.md](../study/typescript/const-assertions-and-satisfies.md). `ISSUED` serials structurally carry `location_id IS NULL` (`ck_stock_serials_location`), which is why the service checks a serial's status before its location on an outbound movement — checking location first would mask the specific "not in stock" message behind a generic "not at location" one.

### H. Lookup, QR labels

`GET /stock/lookup?code=` resolves an exact-match code (item, lot number, or serial number) via a `UNION ALL`, org-scoped. `POST /stock/labels` generates one QR label per requested target (`ITEM`/`LOT`/`SERIAL`/`LOCATION`), each up to a copies count, capped at 500 labels per request. The QR payload is deliberately minimal — `${FRONTEND_URL}/app/stock/scan/<kind>/<id>`, a route and a UUID, nothing business-identifying — because a printed label is scannable by anyone, permanently, with no way to revoke it; resolving the scan URL into a name, quantity or cost requires the authenticated, org-scoped scan route. Full reasoning, the GTIN checksum, and error-correction-level choice: [study/architecture/barcodes-and-qr-codes.md](../study/architecture/barcodes-and-qr-codes.md).

---

## The rule-16 boundary, in practice

StockLedger reads and writes only its own 12 tables. It posts nothing to LedgerCore's general ledger, so there is no bridge function to name and no `source_type`/`source_id` hook in this phase — `services/stock/` and `controllers/stock/` contain no query against any other app's tables:

```bash
grep -rnE "FROM (accounts|ledger_lines|journal_entries|invoices|invoice_lines|customers|vendors|bills|payments|fpa_|forecaster_|unitecon_|boarddeck_|taxguard_|ap_flow_)" server/src/services/stock/ server/src/controllers/stock/
```

returns nothing. Connecting a stock movement's value to a real journal entry (an inventory-asset debit on receipt, a COGS debit on issue) is the natural rule-16 bridge function this phase deliberately leaves unbuilt — see [Deliberately not built](#deliberately-not-built).

`utils/stockCodePattern.ts`, `utils/stockAttributes.ts`, `utils/stockValuation.ts` and `utils/gtin.ts` are all pure — no `pool`, no `client.query`, no `db/connect` import.

---

## Build ladder

### Phase 28 — industry setup, custom attributes, configurable codes, QR labels, perpetual valuation

- [x] `065_stock_setup.sql` — settings, UoMs, categories, attribute definitions, code schemes + counters, locations
- [x] `066_stock_items.sql` — the item master, JSONB attributes with a `jsonb_path_ops` GIN index
- [x] `067_stock_movements.sql` — lots, serials, the append-only movement ledger, the derived balance cache
- [x] `config/stockIndustryProfiles.ts` — 10 industry profiles, additive-only seeding
- [x] `utils/{stockCodePattern,stockAttributes,stockValuation,gtin}.ts` — four pure calculation modules, zero database imports
- [x] `services/stock/{setupService,catalogueService,codeSchemeService,locationService,itemService,movementService,stockQueryService,serialService,lookupService,labelService}.ts`
- [x] `/api/v1/stock` — 36 routes across setup, UoMs, categories, code schemes, locations, items, movements, serials, lookup and labels
- [x] `db/integrity.ts` — `stock_balances_match_movements`, the 5th integrity check
- [x] Client: `StockSetupPage`, `StockCatalogueSettingsPage`, `StockCodeSchemesPage`, `StockLocationsPage`, `StockItemsPage`/`StockNewItemPage`/`StockItemDetailPage`, `StockMovementPage`, `StockDashboardPage`, `StockLabelsPage`, `StockLookupPage`/`StockScanRedirect`, `AttributeFields` (schema-driven custom fields)
- [x] `qrcode` — server-side SVG QR generation
- [x] Cross-tenant isolation tests across every module
- [x] `movementConcurrency.test.ts` — repeated opposite-direction transfers, asserting zero deadlocks
- [x] `stockConstraints.test.ts` — the database as the guardrail: CHECKs, partial unique indexes, `UNIQUE NULLS NOT DISTINCT`, FKs
- [x] A real end-to-end browser smoke test (register → app picker → setup wizard → real-estate item creation → serial receipt with custom attributes → book/issue FSM → QR label generation → scan-URL lookup) — all 8 milestones passed genuinely against the real dev stack
- [x] A formal guardrail review against all 16 hard rules — zero violations

**Acceptance ✅ — verified.** 1969 server tests (1967 passed, 2 skipped — the same pre-existing gated live-provider cases every prior phase's total carries; 168 of the total are StockLedger's own), plus 338 client tests (30 StockLedger's own), all green. `npm run verify:integrity` passes with 5 checks, including the new balance/movement reconciliation.

**Study notes written for this phase** — 5 new, 4 extended: [inventory-valuation-and-perpetual-stock.md](../study/architecture/inventory-valuation-and-perpetual-stock.md), [jsonb-user-defined-attributes.md](../study/postgresql/jsonb-user-defined-attributes.md), [discriminated-unions-and-parsers.md](../study/typescript/discriminated-unions-and-parsers.md), [barcodes-and-qr-codes.md](../study/architecture/barcodes-and-qr-codes.md), [schema-driven-forms-and-print-layouts.md](../study/react/schema-driven-forms-and-print-layouts.md); extended [gapless-numbering-and-counters.md](../study/postgresql/gapless-numbering-and-counters.md), [partial-unique-indexes.md](../study/postgresql/partial-unique-indexes.md), [transactions-isolation-pooling.md](../study/postgresql/transactions-isolation-pooling.md), [const-assertions-and-satisfies.md](../study/typescript/const-assertions-and-satisfies.md).

---

## Deliberately not built

GL posting is built for `QUANTITY`-tracked items only (Phase 32 step 1): lot- and serial-tracked items on invoice/bill lines are refused (422), fixed assets are not capitalised, depreciation is not built, consumption issues to an expense account are not built, credit/debit notes do not restock or return stock, and inventory is not yet a control account (a manual journal to 1140 can still differ from the stock valuation). Valuation still follows processing order. No FIFO costing — moving average (`QUANTITY`/`LOT`) and specific identification (`SERIAL`) only; FIFO cost layers are the named next build-ladder step. No stock count / cycle-count workflow to detect and post shrinkage. No purchase order or goods-receipt document — a `receive` movement has no upstream PO to reconcile against (no 3-way matching, matching AP-Flow's own stated gap). No reservation/allocation beyond a serial's manual `BOOKED` status — no partial reservation of a `QUANTITY`/`LOT` balance. No barcode label *printing* integration beyond the browser's own print dialog — no direct thermal-printer driver. No multi-currency costing — `value_cents` is always the organization's base currency. No onboarding-state gate on StockLedger's own setup wizard beyond the platform's existing per-app onboarding record. No CSV/bulk item import (LedgerCore's staged importer pattern is not reused here). No webhook event on any stock action, and no background job — every operation is synchronous.

When a phase lands, tick its boxes and update [roadmap.md](roadmap.md), [api.md](api.md), [schema.md](schema.md) and `CLAUDE.md` in the same change.
