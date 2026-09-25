# JSONB for User-Defined Attributes

> When the *set* of fields a row needs is decided by each tenant, not by the schema author, `JSONB` moves the variability into a column instead of into the schema — at the cost of every guarantee a real column would have given for free.

**Category:** PostgreSQL
**Introduced by:** Phase 28 — StockLedger's `stock_attribute_definitions` (per-org, per-category custom fields) and `stock_items.attributes`/`stock_serials.attributes` (the values)
**Verified against:** PostgreSQL 16

---

## Mechanism

### The problem a fixed schema can't solve

A real-estate org needs `tower`, `floor`, `carpet_area_sqft` on every unit. A textile manufacturer needs `fabric_type`, `gsm`, `color`. A pharmacy needs `batch_expiry`, `schedule_class`. These aren't different *apps* — they're the same `stock_items` table, but each org's rows need a different, self-chosen set of extra columns, and StockLedger doesn't know that set at migration-authoring time (it's chosen per org, per category, in the setup wizard or catalogue page, at runtime). A relational schema wants columns fixed at `CREATE TABLE` time; this requirement wants them fixed at *row insert* time, per tenant. Three ways to reconcile that:

- **EAV (entity-attribute-value)**: a side table `(item_id, attribute_key, value)`, one row per field per item. Fully relational, fully queryable, and a genuine anti-pattern for exactly this volume: every item read becomes an N-row join instead of a single-row fetch, every value is an untyped `TEXT` needing app-side coercion, and a `NOT NULL`/type CHECK per attribute is nearly impossible to express in SQL.
- **A wide table with `custom_1`...`custom_20` generic columns**: keeps single-row reads, but the column names carry no meaning in the schema (`custom_7` means "carpet area" only by convention recorded elsewhere), wastes space for orgs using few fields, and hard-caps the field count.
- **`JSONB` on the row itself**: one column, `attributes JSONB NOT NULL DEFAULT '{}'`, holding an arbitrary object. Single-row reads, no join, no fixed cap, and the shape is genuinely dynamic. This is what StockLedger uses.

### What the database actually checks, and what it can't

Postgres's role here is deliberately thin — `jsonb_typeof(attributes) = 'object'` in the CHECK constraint (migration `066_stock_items.sql`), confirming the column holds a JSON *object*, not an array, string, or scalar. That's the entire database-side contract. The database has no idea that a "Real estate" item is supposed to carry `tower`; it stores whatever object shape it's handed, subject only to being valid JSON and being an object at the top level.

All of the actual meaning — which keys exist for a category, whether `carpet_area_sqft` is required, whether it's a `NUMBER` or `TEXT`, whether it applies to the item or to each individual serial — lives in `stock_attribute_definitions`, a normal relational table with real columns (`key`, `label`, `data_type`, `scope`, `required`, `category_id`), and is enforced entirely in the service layer (`utils/stockAttributes.ts`'s `validateAttributes`). This is the deliberate split: JSONB holds *values whose shape the database is agnostic to*; a normal table holds the *definitions that give those values meaning*, because definitions have exactly the properties JSONB is bad at guaranteeing (referential integrity to a category, a fixed enum of `data_type`, uniqueness of `key` within a category) and values have exactly the property JSONB is good at (an open-ended, per-tenant-chosen shape).

### `jsonb` vs `json`, and why `jsonb_path_ops`

Postgres has had two JSON types since 9.4: `json` stores the exact input text verbatim and re-parses it on every access; `jsonb` decomposes it into a binary tree at write time, so keys are de-duplicated (last value for a repeated key wins, unlike `json` which preserves duplicates), whitespace is discarded, and every read skips re-parsing. `jsonb` also supports GIN indexing and the containment operator `@>`, which `json` cannot — those two together are the entire reason this codebase, like nearly every real system, defaults to `jsonb` and never uses plain `json`.

`stock_items.attributes` carries `USING gin (attributes jsonb_path_ops)` rather than the default GIN opclass. Default GIN JSONB indexing supports `@>`, `?`, `?|`, `?&` — containment and *any-key-exists* queries — at the cost of one index entry per key **and** per value, since it indexes both independently to support the key-existence operators. `jsonb_path_ops` indexes only `@>` (containment) by hashing each path-value pair into a single entry, which is meaningfully smaller and faster for lookups that are always containment-shaped — and StockLedger's only JSONB query pattern is "does this item's attributes contain `{"tower": "A"}`," never "does this item have *any* attribute named tower regardless of value." Choosing `jsonb_path_ops` over the default opclass is a real, deliberate trade of the `?`/`?|`/`?&` operators (never used here) for a smaller, faster index on the one operator (`@>`) actually used.

### Numbers as strings, a JSON gotcha that has nothing to do with this codebase's usual money rule

A `NUMBER`-typed attribute (`carpet_area_sqft`) is stored **as a JSON string**, `"1180.50"`, not a JSON number `1180.50`. This looks like it contradicts guardrail 3 (money is integer cents, never a float) but it's actually the same discipline applied one level up: JSON's `number` type is defined by the spec as an IEEE-754-adjacent textual grammar with no guaranteed precision on parse — JavaScript's `JSON.parse` turns any JSON number into a 64-bit float, so `1180.50` round-trips fine but a value like `123456789012345.67` would silently lose precision the moment it crossed a `JSON.parse` boundary, exactly the float problem this codebase's money-as-cents rule exists to prevent (`study/typescript/branded-types-for-money.md`). Since carpet area isn't money and doesn't need cents-precision, the fix here isn't `BIGINT` cents — it's simpler: `validateAttributes` requires every `NUMBER`-typed value to arrive as a numeric-looking *string*, parses it once server-side with `Number()` to confirm it's finite and in range, and stores the original string back into the JSONB object. The stored representation is never a JSON number, so there is never a re-parse of untrusted JSON-number text anywhere in the pipeline.

### PATCH semantics: merge, not replace

`updateItem`'s attribute-patch path merges the incoming partial object into the existing `attributes` JSONB with the `||` concatenation operator (`attributes || $1::jsonb`) rather than overwriting the whole column. `a || b` on two JSONB objects is a shallow merge: every top-level key in `b` overwrites the same key in `a`; every key present only in `a` survives untouched. This was a deliberate ruling, not an accident of the operator's default behavior — a `PATCH` request updating just `floor` must never silently erase `tower` and `carpet_area_sqft` just because the client's request body didn't mention them. A `PUT`-style full replace would need the client to resend every attribute on every edit, which is exactly the brittleness JSONB's per-tenant dynamism is supposed to avoid.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| EAV (`item_id, key, value` side table) | Fully relational and queryable per-attribute | Rejected — an item read becomes an N-row join; every value is untyped `TEXT`; per-attribute type/required checks are painful in SQL |
| Wide table, `custom_1..custom_20` | Single-row reads, no join | Rejected — column names carry no schema-level meaning, hard field-count cap, wasted space for orgs using few fields |
| `JSONB` column + a separate relational definitions table | Single-row reads, open-ended shape, but the DB can't enforce per-attribute rules | **Chosen** — DB checks the column is an object; the service layer enforces every attribute-level rule against the definitions table |
| Default GIN JSONB opclass | Supports `@>`, `?`, `?|`, `?&` | Rejected in favor of `jsonb_path_ops` — nothing here ever queries key-existence independent of value, and the narrower opclass is smaller/faster for the one operator actually used |
| JSON number for `NUMBER`-typed values | Terser | Rejected — JSON numbers parse to 64-bit floats with no precision guarantee; stored as a validated string instead |

## Where it lives in this codebase

- `server/src/db/migrations/065_stock_setup.sql` — `stock_attribute_definitions` (the normal relational table: `key`, `label`, `data_type`, `scope`, `required`, per-category)
- `server/src/db/migrations/066_stock_items.sql` — `stock_items.attributes JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(attributes) = 'object')`, the `GIN (attributes jsonb_path_ops)` index
- `server/src/db/migrations/067_stock_movements.sql` — `stock_serials.attributes`, the same column shape, scoped `SERIAL` rather than `ITEM`
- `server/src/utils/stockAttributes.ts` — `validateAttributes(definitions, input)`, the entire enforcement layer: required-field check, per-`data_type` coercion/validation, unknown-key rejection
- `server/src/services/inventory/itemService.ts`, `server/src/services/inventory/serialService.ts` — the `||` merge-patch on update

## Gotchas

- The CHECK constraint (`jsonb_typeof = 'object'`) stops `attributes` from ever being an array or a bare string, but it says nothing about which keys are present or what type each value is — every one of those checks is in `validateAttributes`, and skipping that call (writing `attributes` directly from a controller, say) would bypass every rule silently.
- `jsonb_path_ops` cannot serve a query for "does this item have an attribute named `tower`, regardless of value" — only exact-value containment. If a future feature needs "any item with a `tower` field set to anything," the index would need to be rebuilt with the default opclass (or a second index added).
- `||`'s shallow merge means a `NUMBER`-typed attribute value stored as a string still needs re-validating on every patch — merging doesn't type-check what it's merging in.
- Removing an attribute definition doesn't retroactively strip that key from every existing item's `attributes` JSONB — old rows keep the now-undefined key until they're next updated, which is a deliberate non-destructive choice (data isn't silently deleted by a schema change) but means a query relying on "every item's attributes only has defined keys" would be wrong for stale rows.

## Interview Q&A

**Q: Why JSONB instead of a normal EAV side table for per-tenant custom fields?**
A: EAV keeps everything relational but pays for it on every read — fetching one item with N custom attributes means an N-row join instead of a single-row fetch, and every stored value is untyped text, so type checking has to happen in application code anyway. JSONB gets you the same practical outcome — arbitrary per-tenant shape — while keeping the read a single row. The trade is that the database can no longer enforce per-field rules (required, type, uniqueness of key), so those move entirely into the service layer, backed by a genuinely relational table of attribute *definitions* that the database still fully understands and can enforce referential integrity and type constraints on.

**Q: What does the database actually check about a JSONB column here, and what doesn't it check?**
A: Just that the column's top-level value is a JSON object, via `jsonb_typeof(attributes) = 'object'` in a CHECK constraint. It has no idea what keys should exist, whether a key is required, or what type a value should be — none of that is expressible as a table-level Postgres constraint for a genuinely dynamic shape. All of it is enforced by a service-layer validator that reads the tenant's attribute definitions from a real relational table and checks the JSONB payload against them before it's ever written.

**Q: Why `jsonb_path_ops` instead of the default GIN opclass for a JSONB index?**
A: The default opclass indexes each key and each value as separate entries so it can support `?`/`?|`/`?&` (key-existence) queries in addition to `@>` (containment). `jsonb_path_ops` only supports `@>`, but does it by hashing each path-value pair into one entry, which produces a smaller, faster index. Since the only query shape actually used here is containment — "find items whose attributes contain this key-value pair" — there's no reason to pay for the key-existence operators' extra index entries.

**Q: A JSON number and a decimal-string attribute both hold "1180.50" conceptually. Why store it as a string?**
A: JSON's number grammar has no precision guarantee across a `JSON.parse` boundary — JavaScript parses every JSON number into a 64-bit float, so very large or very precise decimal values can lose precision silently on the way through. That's the same category of problem this codebase avoids for money by using integer cents rather than a float; here the fix is simpler since these aren't money values needing arithmetic — the value is validated as a well-formed, in-range number server-side and then stored as the original string, so nothing downstream ever has to trust a JSON-number round-trip.

**Q: Why does a PATCH to an item's attributes merge instead of replace?**
A: Because the whole point of letting a tenant define their own fields is that a client editing one field (say, just `floor`) shouldn't have to resend every other field it isn't touching, and definitely shouldn't silently erase them if it doesn't. Postgres's `||` operator on two JSONB objects does exactly a shallow top-level merge — keys in the patch overwrite the same key in the stored object, everything else is untouched — which matches that requirement precisely without any manual read-merge-write round trip in the service.

**Q: What's a concrete failure mode of this design you'd want a reviewer to check for?**
A: Deleting or renaming an attribute definition doesn't touch existing rows' JSONB — a "removed" custom field silently lingers in every item that already had it set, since JSONB storage isn't tied to the definitions table by any foreign key (it can't be; JSONB keys aren't rows). That's a deliberate choice — you don't want a schema change to destructively rewrite tenant data — but it does mean any code reading `attributes` should treat unknown keys as ignorable rather than assuming every key present corresponds to a currently-defined attribute.

## Follow-ups they'll dig into

- "How would you query 'every item missing a required attribute for its category'?" — would need to join items to their category's required-attribute-definitions and check `NOT (attributes ? key)` per key, which is exactly the key-existence operator `jsonb_path_ops` doesn't support — a case for the default GIN opclass, or (better) enforcing this at write time instead of querying for violations after the fact, which is what this codebase actually does.
- "What if two attribute definitions needed the same key name in different categories?" — `stock_attribute_definitions` scopes `key` uniqueness per category, so this is allowed by design; the JSONB itself has no idea which category's definition a key belongs to, that mapping only exists by joining through the item's `category_id`.
- "How would this change if attributes needed to be searched full-text, not just exact-match?" — JSONB's GIN indexing is containment/existence only; a text-search need would call for `pg_trgm` or `tsvector` on specific extracted values, a genuinely different indexing strategy layered on top.

## See also

- [../typescript/branded-types-for-money.md](../typescript/branded-types-for-money.md) — the same "don't trust a JSON number for a precision-sensitive value" reasoning, applied to money
- [../typescript/discriminated-unions-and-parsers.md](../typescript/discriminated-unions-and-parsers.md) — the code-pattern parser that consumes these same attribute definitions when rendering an item code
- [audit-triggers-and-session-variables.md](audit-triggers-and-session-variables.md) — the other place this codebase stores a JSONB blob (a `to_jsonb(NEW)` audit snapshot) whose shape the database is deliberately agnostic to
