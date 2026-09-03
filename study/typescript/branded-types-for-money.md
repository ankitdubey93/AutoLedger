# Branded Types (and Why Money Is Never a Float)

> TypeScript's type system is structural, so `Cents` and `Dollars` are the same type and freely interchangeable — branding fakes nominal typing to make that mix-up a compile error, at zero runtime cost.

**Category:** TypeScript
**Introduced by:** Phase 3 — `utils/money.ts`, `BIGINT` cents columns
**Verified against:** TypeScript 7.0.2, Node 24, IEEE 754 double-precision. Code verified: `server/src/utils/money.ts` (Phase 3)

---

## Part 1 — Why floats can't hold money

JavaScript has one number type: IEEE 754 double-precision binary floating point. Binary fractions cannot represent most decimal fractions exactly, in the same way base-10 cannot write ⅓ exactly.

```ts
0.1 + 0.2              // 0.30000000000000004
0.1 + 0.2 === 0.3      // false
1.005 * 100            // 100.49999999999999  → Math.round gives 100, not 101
```

The errors are tiny but they **accumulate and they're order-dependent**, so summing the same ledger in a different row order can produce a different total. For a system whose core invariant is *debits equal credits exactly*, that's fatal — and the failure is intermittent, which makes it far worse than a crash.

The epsilon workaround is the trap:

```ts
if (Math.abs(totalDebit - totalCredit) < 0.01) { /* "balanced" */ }
```

This says a one-cent discrepancy is acceptable. In accounting it isn't — that's the difference between a clean audit and a hunt through ten thousand entries. It also silently widens as row counts grow, because accumulated error scales with the number of additions. The prior build shipped exactly this check, and it's the reason `docs/guardrails.md` rule 3 exists.

**The fix: store and compute in the smallest indivisible unit — integer cents.** Integers are exact in IEEE 754 up to `Number.MAX_SAFE_INTEGER` = 9,007,199,254,740,991 (2⁵³−1), which is roughly $90 trillion in cents. Comparison becomes exact integer equality.

```ts
const toCents = (n: number) => Math.round(Number(n) * 100);
if (totalDebitCents !== totalCreditCents) throw new ApiError(422, 'Entry is unbalanced.');
```

### Why `BIGINT` and not `NUMERIC`

Postgres `NUMERIC` is arbitrary-precision decimal and genuinely exact — it's a legitimate choice, used by plenty of financial systems. We chose `BIGINT` because:

- It's a fixed 8 bytes and faster to aggregate; `NUMERIC` arithmetic is software-implemented
- It forces the integer-cents discipline into the schema, so no code path can reintroduce fractional amounts
- `node-postgres` returns *both* as strings, so there's no ergonomic difference in JS

`NUMERIC` earns its place when you need sub-cent precision — unit prices to four decimals, FX rates, tax rates. Note the asymmetry: **rates and prices may need `NUMERIC`; posted amounts stay `BIGINT` cents.**

### The string boundary

`pg` returns `BIGINT` (`int8`) as a **string**, because a 64-bit integer can exceed `Number.MAX_SAFE_INTEGER` and silent precision loss would be worse than an inconvenience. So money crosses into JS as a string and must be parsed deliberately:

```ts
const cents = Number(row.debit_cents);      // fine below 2^53
// row.debit_cents + 100  →  "5000100"       ← string concatenation, a real bug
```

## Part 2 — Branded types

TypeScript is **structurally** typed: two types with the same shape are the same type. So a plain `number` alias gives you documentation, not safety:

```ts
type Cents = number;
type Dollars = number;

const pay = (amount: Cents) => { ... };
pay(19.99 as Dollars);   // ✅ compiles. Charges 19 cents. No error anywhere.
```

**Branding** attaches a phantom property that exists only in the type system:

```ts
declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

export type Cents   = Brand<number, 'Cents'>;
export type Dollars = Brand<number, 'Dollars'>;

// The only way to make one — a checked constructor
export const cents = (n: number): Cents => {
  if (!Number.isInteger(n)) throw new Error(`Cents must be an integer, got ${n}`);
  return n as Cents;
};

const pay = (amount: Cents) => { ... };
pay(1999);                    // ❌ Argument of type 'number' is not assignable to 'Cents'
pay(19.99 as Dollars);        // ❌ 'Dollars' is not assignable to 'Cents'
pay(cents(1999));             // ✅
```

Note what the middle line demonstrates and also what it costs: `19.99 as Dollars` is an *unchecked* cast, and casting is the one thing that can forge a brand. The type system stops you passing dollars where cents belong, but it cannot stop you asserting that a number is dollars in the first place. That is why the shipped `utils/money.ts` gives every branded value a checked constructor and exports no way to make one without it.

The brand is erased at compile time — a `Cents` **is** a `number` at runtime, so arithmetic and JSON serialisation work with no wrapper allocation and no performance cost.

The trade-off is honest: arithmetic loses the brand, because `Cents + Cents` widens to `number`. Either re-brand at the boundary or provide operators:

```ts
const addCents = (a: Cents, b: Cents): Cents => (a + b) as Cents;
const sumCents = (xs: Cents[]): Cents => xs.reduce(addCents, cents(0));
```

Using `unique symbol` for the brand key rather than a string property (`{ __brand: 'Cents' }`) keeps the marker unforgeable and un-collidable, and stops it appearing in autocomplete.

### Where this generalises

The same pattern applies to every ID in a multi-tenant system, and it's arguably even more valuable there:

```ts
type OrgId = Brand<string, 'OrgId'>;
type UserId = Brand<string, 'UserId'>;
type AccountId = Brand<string, 'AccountId'>;

const getAccounts = (orgId: OrgId) => { ... };
getAccounts(user.id);   // ❌ caught at compile time
```

Every ID in this schema is a UUID string, so structurally they're identical and interchangeable. Passing a `userId` where `orgId` belongs is the exact shape of a tenant-isolation bug — and branding turns it from a runtime data leak into a compile error.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| `number` floats for money | Natural to write, silently wrong, intermittently | Rejected — rule 3 |
| Integer cents as plain `number` | Exact arithmetic; nothing stops mixing units or scales | Baseline requirement |
| Integer cents as branded `Cents` | Compile-time unit safety, zero runtime cost; arithmetic needs helpers | **Target** |
| A `Money` class / `decimal.js` | Full precision and unit tracking; allocation per value, serialisation boundary, ORM friction | Overkill for integer cents |

Conversion lives in exactly one module, `utils/money.ts`, so the parse-from-string and round-from-decimal rules have a single implementation to test.

## Where it lives in this codebase

Built in Phase 3:

- `server/src/utils/money.ts` — `Cents`, and the only functions permitted to produce one: `cents()` (checked constructor), `toCents()` (major units → cents), `parseCents()` (the `pg` `BIGINT` string parser), `formatCents()`, `addCents()`, `sumCents()`
- `server/src/__tests__/money.test.ts` — unit tier, no database

**One deliberate departure from the sketch above:** `toCents` takes a plain `number`, not a branded `Dollars`. At an HTTP boundary the value arrives from `JSON.parse` as a `number`, so requiring `Dollars` would force callers to write `body.amount as Dollars` — an unchecked cast at precisely the point the check matters most, which is the first gotcha below. `Dollars` remains a good illustration of the pattern and a genuinely useful type *inside* a calculation where both units are in play; it is not exported, because nothing in the codebase currently has that shape.

Not yet applied: `Cents` does not appear on the `ledger_lines` DTOs in `types/ledger-core.ts`, which use plain `number`. Branding the transport types would mean re-validating on every `JSON.parse` boundary crossing for a value the database CHECK constraints already guarantee. The brand earns its keep in the calculation path — `sumCents` over an entry's lines — which is where it is used.

## Gotchas

- **`as Cents` on unvalidated input defeats the whole thing.** Only the checked constructor should produce a branded value; the cast belongs inside it and nowhere else.
- **Arithmetic silently widens to `number`.** Re-brand deliberately.
- **`Math.round` on a float that's already wrong doesn't save you.** `1.005 * 100` is `100.49999999999999`, so rounding gives `100`. If input arrives as a decimal string, parse the string rather than routing through a float.
- **`BIGINT` comes back as a string.** `Number(row.debit_cents)`, never `row.debit_cents + x`.
- **Beyond 2⁵³ cents, `Number` loses precision.** Not a concern at ~$90 trillion, but if it ever were, the answer is `BigInt` — and then JSON serialisation needs a custom replacer, since `JSON.stringify` throws on `BigInt`.
- **Branding doesn't survive `JSON.parse`.** Data crossing the wire re-enters as plain `number`; re-validate at the boundary with the constructor.
- **Division breaks the model.** Splitting 100 cents three ways can't be exact — you must decide where the remainder lands (largest-remainder allocation) rather than letting rounding scatter it.

## Interview Q&A

**Q: Why can't you use a float for money?**
A: IEEE 754 doubles are binary, and most decimal fractions have no exact binary representation — `0.1 + 0.2` is `0.30000000000000004`. Individually negligible, but errors accumulate and are order-dependent, so summing the same set of rows in a different order can give a different total. For a double-entry ledger whose invariant is that debits exactly equal credits, that produces intermittent failures that are far harder to diagnose than a crash. The fix is to store the smallest indivisible unit as an integer — cents — because integers are exact in IEEE 754 up to 2⁵³−1, and equality comparison becomes exact.

**Q: Someone writes `if (Math.abs(debits - credits) < 0.01)` for a balance check. What's wrong with it?**
A: It declares a one-cent discrepancy acceptable, which in accounting it isn't — that's the difference between a clean audit and reconciling ten thousand entries by hand. It's also not a stable threshold: accumulated float error grows with the number of additions, so a tolerance that passes at a hundred lines can fail at a hundred thousand, or worse, mask a genuine one-cent bug. The correct version converts to integer cents and uses `!==`.

**Q: TypeScript is structurally typed. What problem does that cause, and how do you work around it?**
A: Two types with the same shape are interchangeable, so `type Cents = number` and `type Dollars = number` are the same type — you can pass dollars where cents are expected and get no error at all. The workaround is branding: intersect the primitive with a phantom property, ideally keyed by a `unique symbol` so it can't be forged or collide. That simulates nominal typing. The brand is erased at compile time, so there's no runtime cost — a `Cents` is still just a `number`. The cost is that arithmetic widens back to `number`, so you either re-brand at boundaries or write small operators.

**Q: Where else would you use branded types in this codebase?**
A: IDs, and arguably more valuably than money. Every ID here is a UUID string, so `OrgId`, `UserId`, and `AccountId` are structurally identical and freely swappable. Passing a `userId` where `orgId` is expected is precisely the shape of a tenant-isolation bug — the query runs, returns nothing or the wrong thing, and no type error fires. Branding turns a potential cross-tenant data leak into a compile error, which is a very high return for a one-line type definition.

**Q: `BIGINT` versus `NUMERIC` for a money column — which and why?**
A: Either is defensible; both are exact. `BIGINT` cents is fixed-width at 8 bytes, faster to aggregate, and it pushes the integer discipline into the schema so no code path can reintroduce a fractional amount. `NUMERIC` is arbitrary-precision decimal and is what you want when you genuinely need sub-cent precision — unit prices at four decimal places, FX rates, tax rates. We use `BIGINT` for posted amounts and would reach for `NUMERIC` for rates. Worth knowing that node-postgres returns both as strings, so the JS-side ergonomics are identical.

**Q: Tell me about a type-level decision that prevented a class of bug.**
A: On AutoLedger, money is integer cents end to end, and the type is branded rather than a bare `number`. The motivation was concrete: the previous version validated balance in cents but stored `DECIMAL`, and computed its `isBalanced` flag with a `< 0.01` epsilon. So the system's central invariant was checked with a tolerance that would drift as data grew. Making `Cents` a distinct type with a checked constructor means a raw number can't reach a function expecting cents, and having exactly one conversion module means the rounding rule has one implementation and one set of tests. It's a small amount of type machinery bought against the single most expensive bug class in the domain.

## Follow-ups they'll dig into

- "How do you split 100 cents three ways?" (You can't exactly — pick an allocation strategy, usually largest-remainder, and make it explicit rather than letting rounding decide.)
- "What about currencies without cents, like JPY, or three-decimal ones like KWD?" (The "minor unit" exponent varies; hardcoding ×100 is a bug. ISO 4217 carries the exponent — store it per currency, which matters once the Phase 8 FX engine lands.)
- "What's `unique symbol` and why use it for the brand?" (A type-level-unique symbol; it makes the marker unforgeable and keeps it out of autocomplete, unlike a string-keyed property.)
- "Difference between `as const`, `satisfies`, and a type annotation?" (Common follow-up once branding shows you know the type system — `satisfies` validates without widening or discarding literal inference.)

## See also

- [../postgresql/transactions-isolation-pooling.md](../postgresql/transactions-isolation-pooling.md) — the `BIGINT`-as-string boundary
- `docs/guardrails.md` rule 3
