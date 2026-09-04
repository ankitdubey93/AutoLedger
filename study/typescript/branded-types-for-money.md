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

## Part 3 — Scaling money by a rational factor

`addCents`/`sumCents` cover the arithmetic a journal entry needs: amounts that are already in cents, added together. Phase 3.8's invoice line totals need a different operation — multiplying a cents amount by a *ratio* expressed as two plain integers, because neither an invoice quantity nor a tax rate is itself money:

- a quantity is stored as **thousandths of a unit** (`quantityMilli`: `2500` means `2.5`), never a float, for the same reason cents themselves aren't floats
- a tax rate is stored as **basis points** (`taxRateBp`: `1850` means `18.5%`)

`netCents = unitPriceCents × quantityMilli ÷ 1000` and `taxCents = netCents × taxRateBp ÷ 10000` are both "cents times an integer, divided by an integer," which is exactly the shape `scaleCents` exists for:

```ts
export function scaleCents(amount: Cents, numerator: number, denominator: number): Cents {
  if (!Number.isInteger(denominator) || denominator <= 0) throw new ApiError(400, '...');
  if (!Number.isInteger(numerator) || numerator < 0) throw new ApiError(400, '...');

  const n = BigInt(numerator);
  const d = BigInt(denominator);
  const result = (BigInt(amount) * n + d / 2n) / d;

  return cents(Number(result));
}
```

### Why `BigInt`, not `Math.round(amount * numerator / denominator)`

The obvious one-liner does the multiplication in native `number` arithmetic first and rounds after. For an invoice priced at, say, `$999,999,999.99` (99,999,999,999 cents — well inside the columns' permitted range) times a quantity of a million thousandths, `amount * numerator` overflows `Number.MAX_SAFE_INTEGER` (2⁵³−1) *before* the division ever runs, and IEEE-754 double-precision arithmetic doesn't throw when a computation loses precision — it silently returns the nearest representable double. The bug wouldn't show up in a unit test with small, textbook numbers; it would show up on the one invoice with an unusually large line total, and it would show up as a wrong number, not an error. This is precisely the machine-representation problem Part 1 of this note opens with, one level removed: the input columns are safe integers individually, but their *product* isn't guaranteed to be.

`BigInt` arithmetic in JavaScript is arbitrary-precision and exact — no representable range to overflow within the calculation — so multiplying two large safe integers together is exact even when the intermediate product itself exceeds `Number.MAX_SAFE_INTEGER`. Only the *final* result, after dividing back down, gets converted back to a `number` via `cents()`, whose existing safe-integer check (Part 2) is what catches the case where even the final answer is too large to represent exactly — the same checked-constructor discipline this whole module is built around, applied to a new call site rather than invented for it.

### Rounding half up, and why it has to be documented

`(BigInt(amount) * n + d / 2n) / d` is integer division after adding half the denominator — the standard trick for "round to nearest" using only integer operations (no `Math.round`, which operates on floats and reintroduces the precision question this function exists to avoid). `d / 2n` is itself an integer division, so for an odd denominator it truncates toward zero, which biases the rounding boundary very slightly for the exact halfway case on an odd `d`; every actual use of this function passes an even denominator (`1000` for quantity, `10000` for basis points), so the bias never surfaces in practice, but it's a property of the formula worth being explicit about rather than assuming "rounds half up" holds for every possible input. Which direction a rounding rule goes is a business decision every payments and accounting system has to make explicitly and consistently — round-half-up here, matching `toCents`' documented "rounds half away from zero" for the sign-symmetric case — because two different rounding rules applied inconsistently across a codebase is a subtle source of penny-level reconciliation drift over thousands of transactions.

### Why tax is computed per line, then summed — never on the subtotal

`invoiceService.computeLineTotals` calls `scaleCents` twice per line — once for the net amount, once for that line's tax on top of its own net — and only *then* sums every line's net and every line's tax separately into the invoice header's `subtotalCents` and `taxCents`. Computing tax once on the pre-summed subtotal instead (`scaleCents(subtotalCents, taxRateBp, 10000)`) would give the wrong answer the moment two lines carry *different* tax rates, and even for a single uniform rate, summing several already-rounded per-line taxes is not always bit-for-bit identical to rounding the tax on the pre-summed total — the two operations don't commute once rounding is involved. Storing each line's own `netCents`/`taxCents` and requiring the header to equal their sums (`chk_invoices_total` in migration 009) is what keeps the stored numbers self-consistent regardless of how many distinct tax rates an invoice mixes.

## Part 4 — Parsing money from untrusted text

Phase 6's bank statement import is the first place this codebase turns free-text into money rather than a structured number the client already validated (`toCents`'s `major: number` argument) or a `BIGINT` the database already guarantees is well-formed (`parseCents`). A CSV amount column is a raw string a bank export tool formatted however it pleased — `"1,234.56"`, `"1.234,56"`, `"(1,234.56)"`, `"1234.56 CR"` — and `parseMoneyText` has to turn any of those into exact `Cents` without ever constructing an intermediate float, the same discipline `toCents`'s header comment argues for at the textual boundary in the first place.

### Separator ambiguity is resolved asymmetrically, on purpose

`"1,234.56"` (US/UK) and `"1.234,56"` (much of continental Europe) mean the same amount with the two punctuation marks swapped. When both `.` and `,` appear, the *later* one in the string is the decimal point and every occurrence of the other is a thousands separator — unambiguous, since a decimal point can only appear once and always comes after every thousands grouping. When only one of the two appears, the rule is deliberately **not** symmetric: a lone comma is decimal only if it appears exactly once and is followed by exactly one or two digits (`"1,23"` → 1.23), otherwise every comma is treated as a thousands separator (`"1,234"` → 1234.00, not 1.234). A lone dot, by contrast, is *always* presumed a decimal point — never reinterpreted as a thousands separator — so a dot followed by anything other than one or two digits (three digits, or none) is rejected outright rather than guessed at (`"1234.567"` throws; it does not silently become 1,234,567 cents worth of guesswork). The asymmetry reflects which punctuation mark is overwhelmingly the "safe default" in English-language bank exports: a comma is far more often thousands grouping, a dot is far more often the decimal point, and treating them identically would silently misparse the common case for one of them.

### A third decimal digit is a rejection, not a rounding

`toCents` rounds a `number` because the caller already has one and half-cent handling is the whole point of that function. `parseMoneyText` never rounds — a string carrying three or more fraction digits (`"1234.567"`) fails the final validation pattern (`/^\d+(\.\d{1,2})?$/`) and throws `ApiError(400, ...)` instead of silently discarding the extra precision. Rounding here would hide a formatting bug in whatever produced the source file — a genuine three-decimal amount in a bank export usually means the wrong column was selected, or the file uses a currency with a different minor-unit exponent than assumed — and a loud rejection at import time is far cheaper to fix than a quietly wrong cents value discovered during reconciliation weeks later.

### Accounting notation, not just numeric notation

Bank and accounting software write negative amounts several ways beyond a leading `-`: wrapped in parentheses (`"(1,234.56)"`, the standard accounting convention for a negative number), or suffixed `CR`/`DR` (credit/debit, where `DR` specifically means negative regardless of the number's own sign). `parseMoneyText` strips currency symbols and thousands-separator spaces first, then checks for parentheses, then a leading minus, then a trailing `CR`/`DR` suffix, before any separator-ambiguity resolution runs — sign detection has to happen before decimal-point resolution because a wrapped `"(1,234.56)"`'s content, once the parentheses are stripped, is exactly the same ambiguous-separator string `"1,234.56"` the rest of the function already knows how to handle.

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

- `server/src/utils/money.ts` — `Cents`, and the only functions permitted to produce one: `cents()` (checked constructor), `toCents()` (major units → cents), `parseCents()` (the `pg` `BIGINT` string parser), `formatCents()`, `addCents()`, `sumCents()`, `scaleCents()` (Phase 3.8, money × a rational factor, `BigInt`-exact), and — added in Phase 6 — `parseMoneyText()` (untrusted bank-statement text → cents, no intermediate float)
- `server/src/services/ledger-core/invoiceService.ts` — `computeLineTotals`, the only caller of `scaleCents`
- `server/src/services/ledger-core/bankImportService.ts` — the only caller of `parseMoneyText`, once per amount (or per debit/credit pair) column cell during CSV import
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
- **`amount * numerator` in native `number` arithmetic can overflow before you ever get to divide.** `scaleCents` exists because `Math.round((amount * numerator) / denominator)` computes the multiplication in floating point *first* — for large-but-individually-valid inputs, the product alone can exceed `Number.MAX_SAFE_INTEGER` and silently lose precision, with no exception raised. `BigInt` the operands before multiplying, divide in `BigInt`, convert back to `number` only at the end.
- **Summed per-line rounding isn't always identical to rounding the sum.** `scaleCents` is applied per invoice line and the results are summed, never applied once to a pre-summed total — the two are not guaranteed to agree once any rounding is involved, and only the per-line version is correct when lines carry different rates.
- **A lone dot and a lone comma are resolved by different default rules, on purpose.** `parseMoneyText` presumes a lone dot is always the decimal point (rejecting anything but one or two trailing digits, rather than reinterpreting it as thousands grouping), while a lone comma defaults to thousands grouping unless followed by exactly one or two digits. Applying the same rule to both would silently misparse whichever one is *not* the common case in English-language bank exports.

## Interview Q&A

**Q: Why can't you use a float for money?**
A: IEEE 754 doubles are binary, and most decimal fractions have no exact binary representation — `0.1 + 0.2` is `0.30000000000000004`. Individually negligible, but errors accumulate and are order-dependent, so summing the same set of rows in a different order can give a different total. For a double-entry ledger whose invariant is that debits exactly equal credits, that produces intermittent failures that are far harder to diagnose than a crash. The fix is to store the smallest indivisible unit as an integer — cents — because integers are exact in IEEE 754 up to 2⁵³−1, and equality comparison becomes exact.

**Q: Someone writes `if (Math.abs(debits - credits) < 0.01)` for a balance check. What's wrong with it?**
A: It declares a one-cent discrepancy acceptable, which in accounting it isn't — that's the difference between a clean audit and reconciling ten thousand entries by hand. It's also not a stable threshold: accumulated float error grows with the number of additions, so a tolerance that passes at a hundred lines can fail at a hundred thousand, or worse, mask a genuine one-cent bug. The correct version converts to integer cents and uses `!==`.

**Q: How do you multiply a `Cents` value by a percentage — say, computing tax on an invoice line — without reintroducing the float problem you just solved?**
A: The rate has to be stored as an integer too — basis points, not a decimal — so the whole operation is "integer times integer, divided by integer," never a float multiplication. Even then, doing that multiplication in native JS `number` arithmetic can silently overflow: `Number.MAX_SAFE_INTEGER` bounds any *individual* value safely, but the *product* of two safe integers can exceed it, and IEEE-754 doesn't throw on that, it just returns an imprecise result. The fix is to cast both operands to `BigInt`, which is arbitrary-precision, do the multiply-then-divide-with-rounding entirely in `BigInt`, and only convert back to `number` at the very end — where the existing checked constructor catches the case where even the final answer doesn't fit.

**Q: TypeScript is structurally typed. What problem does that cause, and how do you work around it?**
A: Two types with the same shape are interchangeable, so `type Cents = number` and `type Dollars = number` are the same type — you can pass dollars where cents are expected and get no error at all. The workaround is branding: intersect the primitive with a phantom property, ideally keyed by a `unique symbol` so it can't be forged or collide. That simulates nominal typing. The brand is erased at compile time, so there's no runtime cost — a `Cents` is still just a `number`. The cost is that arithmetic widens back to `number`, so you either re-brand at boundaries or write small operators.

**Q: Where else would you use branded types in this codebase?**
A: IDs, and arguably more valuably than money. Every ID here is a UUID string, so `OrgId`, `UserId`, and `AccountId` are structurally identical and freely swappable. Passing a `userId` where `orgId` is expected is precisely the shape of a tenant-isolation bug — the query runs, returns nothing or the wrong thing, and no type error fires. Branding turns a potential cross-tenant data leak into a compile error, which is a very high return for a one-line type definition.

**Q: `BIGINT` versus `NUMERIC` for a money column — which and why?**
A: Either is defensible; both are exact. `BIGINT` cents is fixed-width at 8 bytes, faster to aggregate, and it pushes the integer discipline into the schema so no code path can reintroduce a fractional amount. `NUMERIC` is arbitrary-precision decimal and is what you want when you genuinely need sub-cent precision — unit prices at four decimal places, FX rates, tax rates. We use `BIGINT` for posted amounts and would reach for `NUMERIC` for rates. Worth knowing that node-postgres returns both as strings, so the JS-side ergonomics are identical.

**Q: You're parsing money from a bank CSV where you don't know if it uses "1,234.56" or "1.234,56" notation. How do you resolve that without a locale setting?**
A: When both `.` and `,` appear in the same amount, whichever one occurs *last* in the string is the decimal point — unambiguous, because a decimal point can only appear once and always comes after every thousands-grouping separator. When only one of the two appears, the rule can't be fully symmetric: a lone comma is treated as decimal only if it's followed by exactly one or two digits (otherwise it's thousands grouping), while a lone dot is always presumed decimal and rejected outright if it's followed by anything else, rather than being reinterpreted as a thousands separator. The asymmetry matches which punctuation mark is the safe default in the data you're actually likely to see — a dot is overwhelmingly a decimal point in English-language exports, a comma is overwhelmingly thousands grouping.

**Q: Why does parsing a bank amount reject a value like `"1234.567"` instead of just rounding it to `"1234.57"`?**
A: Because a third decimal digit almost always means something went wrong upstream — the wrong column was selected, or the export uses a currency with a different minor-unit exponent than assumed — and silently rounding would hide that bug behind a plausible-looking-but-wrong cents value that might not surface until a reconciliation weeks later. A loud rejection at import time, with the row number and the actual offending text in the error message, is far cheaper to fix than a quiet precision loss discovered downstream.

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
