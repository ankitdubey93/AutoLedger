# `as const satisfies` — Deriving a Type From Data

> Two independent tools that solve one recurring problem together: keep exactly one array as the source of truth for both a runtime list and the type that describes it, with the compiler checking the array's *shape* while still remembering its *exact values*.

**Category:** TypeScript
**Introduced by:** Phase 2 — `server/src/config/apps.ts`, the app registry
**Verified against:** TypeScript 5.x / 7 (type-checking behaviour is unchanged across the JS→Go compiler rewrite; only speed changes)

---

## Mechanism

Three separate compiler behaviours stack to make `config/apps.ts` work, and each is worth pulling apart on its own.

### 1. Without anything special: type widening

TypeScript infers the *general* type of a literal by default, not the literal itself, because that is almost always what you want for a mutable variable:

```ts
let status = 'building';        // inferred as `string`, not `'building'`
const status2 = 'building';     // inferred as `'building'` — const can't be reassigned
```

`const` alone narrows a primitive binding, but it does **not** reach inside an object or array:

```ts
const app = { slug: 'ledger-core', status: 'building' };
// inferred as { slug: string; status: string }  — both widened
```

The object's own properties widen because, structurally, nothing stops someone from writing `app.status = 'anything'` later — TypeScript infers the type a **mutable** object would need, even though this particular object is never reassigned.

### 2. `as const` — freeze to literals, recursively

`as const` is a type assertion that tells the compiler: treat every property as `readonly`, and infer the **narrowest possible literal type** for every value, recursively through nested objects and arrays.

```ts
const app = { slug: 'ledger-core', status: 'building' } as const;
// { readonly slug: 'ledger-core'; readonly status: 'building' }

export const APPS = [
  { slug: 'ledger-core', status: 'building' },
  { slug: 'taxguard', status: 'planned' },
] as const;
// readonly [{ readonly slug: 'ledger-core'; ... }, { readonly slug: 'taxguard'; ... }]
```

This is what makes deriving a union possible at all — without it, `slug` is `string` everywhere and there is no finite set of values to extract.

### 3. Deriving a union: `(typeof X)[number]`

Once `APPS` is a `readonly` tuple of literal-typed objects, indexing its type by `number` (the type of "any array index") produces the union of every element type, and `['slug']` projects that down to just the slug field:

```ts
export type AppSlug = (typeof APPS)[number]['slug'];
// 'ledger-core' | 'taxguard' | 'ap-flow' | 'fpa-engine' | 'unitecon' | 'boarddeck' | 'forecaster'
```

`(typeof APPS)[number]` is the same trick as the more commonly seen `typeof ROLES[number]` for a plain string array (see `types/auth.ts`'s `Role`) — it just also works through an object shape because `as const` froze the object's properties too, not only the array's elements.

### 4. `satisfies` — check the shape without widening it

The remaining problem: how do you get the compiler to *verify* that every entry actually has the right shape — a valid `status`, all required fields — while still keeping the literal types from step 2? A plain type annotation would do the check but destroy the literals:

```ts
const APPS: AppDefinition[] = [ ... ];
// APPS[0].status is now AppStatus ('building' | 'planned'), not 'building'
// — the union derivation above no longer produces individual slugs
```

`satisfies` checks the expression against a type as a **validation pass that runs and discards**, without assigning that type to the variable. The variable keeps whatever type it would have inferred anyway:

```ts
export const APPS = [
  { slug: 'ledger-core', name: 'LedgerCore', /* ... */ status: 'building' },
  // ...
] as const satisfies readonly AppDefinition[];
```

Read right to left: "this array, as const, must satisfy `readonly AppDefinition[]` — but keep inferring its own (narrower) type regardless." If an entry is missing a field, has a typo'd key, or sets `status` to something outside `'building' | 'planned'`, this line fails to compile. If it's valid, `APPS`'s inferred type is still the fully literal tuple from step 2 — `satisfies` contributes nothing to the final type, only a checkpoint during inference.

## Why we chose it here

The alternative to `satisfies` is a plain annotation (`const APPS: AppDefinition[] = [...]`), which type-checks the same array but widens every field to its declared type. That's a real loss here: `AppSlug` is derived *from* `APPS`, so if `APPS` were annotated as `AppDefinition[]`, `slug` would already be `string` by the time `AppSlug` tries to extract from it, and the extraction would just produce `string` — a union with no members worth having.

| Option | Trade-off | Verdict |
|---|---|---|
| No type at all | Correct at runtime, zero compile-time protection against a typo'd slug or route param | Rejected |
| `const APPS: AppDefinition[] = [...]` | Checked, but widens every field — `AppSlug` degrades to `string` | Rejected |
| `as const` only, no `satisfies` | Keeps literals, but a malformed entry (wrong field name, `status: 'buildingg'`) is caught only where it's *used*, far from the mistake | Partial |
| `as const satisfies AppDefinition[]` | Checked **and** literal — the target | **Chosen** |
| A `zod` schema + `z.infer` | Also validates untrusted *runtime* input, which `config/apps.ts` never receives — it's a static list, not a request body | Overkill; the dependency policy (guardrail 14) defers `zod` until there's an actual runtime boundary to validate |

The same pattern already existed in this codebase before Phase 2: `types/auth.ts`'s `ROLES = [...] as const` deriving `Role`, and the FSM transition-table example in `docs/guardrails.md` rule 10 uses `satisfies Partial<Record<Status, Status[]>>`. `config/apps.ts` is the first place both techniques compose on the same declaration.

## Where it lives in this codebase

- `server/src/config/apps.ts` — `APPS` (`as const satisfies readonly AppDefinition[]`), `AppSlug` (derived union), `isAppSlug` (the type predicate that narrows a runtime string back down to `AppSlug`)
- `server/src/types/auth.ts` — `ROLES` / `Role`, the earlier instance of the `as const` → `typeof X[number]` half of the pattern (no `satisfies` there, because `ROLES` is a flat string array with nothing to validate a shape against)

## Gotchas

- **`satisfies` without `as const` still widens.** `{ status: 'building' } satisfies AppDefinition` alone infers `status: AppStatus`, not `status: 'building'`, because nothing told the object literal to freeze to literals first. The two annotations do different jobs and you usually want both together.
- **The union comes from the *type*, not the array.** `AppSlug` is computed once, at the type level, from `typeof APPS`. Pushing a new object into `APPS` at runtime does not add a member to `AppSlug` — the array is also `readonly`, so `APPS.push(...)` is a compile error, which is the intended guardrail: the registry is edited by adding a line to the literal, not by mutation.
- **`isAppSlug` is still required, not optional.** The union type only helps *inside* the program, where the compiler can track values. The moment a slug comes from `req.params.appSlug`, it's an untyped `string` again — TypeScript erases at runtime, so there is no way to "check the type" of a string against a union without a hand-written predicate function that actually compares it to the known values.
- **`(typeof X)[number]` needs `X` to be an array or tuple type.** Indexing a plain object type by `number` doesn't do this — it only works because `APPS` is an array literal.
- **Mixing `as const` with a spread can re-widen.** `[...APPS]` (used in `appService.listApps()` to avoid handing out the frozen array by reference) has type `AppDefinition[]`, not the literal tuple — which is fine there, since the function's return type is deliberately the wider `AppSummary[]`, but it's worth noticing that widening happened.

## Interview Q&A

**Q: What does `as const` actually do?**
A: It's a type assertion that changes how the compiler infers a literal's type: instead of widening string/number/boolean literals to their general type (`string`, `number`) and array/object properties to mutable, it infers the narrowest literal type for every value, marks object properties `readonly`, and infers array literals as `readonly` tuples rather than mutable arrays. It's purely a compile-time instruction — there's no runtime `Object.freeze` unless you add one separately.

**Q: What's the difference between a type annotation and `satisfies`?**
A: An annotation (`const x: T = ...`) assigns `T` as the variable's type going forward, which means the variable's inferred type is discarded in favor of the declared one — you get checking, but you lose any literal precision the initializer had. `satisfies` checks the initializer against `T` as a one-time validation and then throws that check away, leaving the variable's own inferred type intact. So `satisfies` is for when you want both: proof the value conforms to a shape, and to keep using the value's actual, narrower type afterward.

**Q: How do you derive a union type from an array of string literals?**
A: `as const` on the array to get a `readonly` tuple of literal types, then `(typeof arr)[number]` to index the tuple type by its element type, which produces the union of every element. It's the same mechanism whether the array holds bare strings (`ROLES` → `Role`) or objects you then project a field out of (`APPS` → `AppSlug` via `['slug']`) — `as const` has to freeze the object properties too in the second case, or the projected field is just `string`.

**Q: Why not just use a `zod` schema and `z.infer` instead?**
A: `zod` earns its place when you're validating something that crosses a runtime boundary — a request body, a config file read from disk — because there the shape genuinely isn't known until the program runs, and you need a runtime check that also produces a type. `config/apps.ts` is a static literal written directly in TypeScript source; the compiler already sees its exact shape at compile time, so a `satisfies` check does the same validation for free, with no dependency and no runtime cost. Reaching for `zod` here would be validating a value the type checker can already fully see.

**Q: You have a union type `AppSlug`. A route handler receives `req.params.appSlug` as a plain `string`. How do you get back to `AppSlug` safely?**
A: You can't cast your way there safely — `as AppSlug` compiles but proves nothing, since the compiler trusts the assertion instead of checking it, and a caller could hit the route with any string. You need a type predicate function: `function isAppSlug(v: string): v is AppSlug`, whose body actually compares `v` against the known slugs (iterating `APPS`, or a `Set`). Calling it inside an `if` narrows the type in that branch — the compiler trusts the *function's control flow*, not the mere claim of the return type, because the function's implementation is what got checked.

**Q: Tell me about a time a widened type caused a bug, or would have.**
A: On AutoLedger, the app registry (`APPS`) needs a derived `AppSlug` union so that route params and the client's app-chooser routing can be checked against exactly the seven real slugs, not an arbitrary string. If `APPS` were given a plain `AppDefinition[]` annotation instead of `as const satisfies AppDefinition[]`, every field — including `slug` — would widen to its declared type, `string`. `AppSlug` derived from that would just be `string`, and `isAppSlug`, route matching, and the client-side `useActiveApp` hook would all lose the compile-time guarantee that a slug is one of the seven — a typo'd slug anywhere in the app would compile cleanly and fail only at runtime, as a silent no-match instead of a caught error.

## Follow-ups they'll dig into

- "Does `as const` have any runtime cost?" (None — it's erased entirely, same as every other TypeScript type annotation. The `readonly` it implies is a compile-time-only restriction; nothing stops a `as any as MutableType` bypass, same as any TS immutability.)
- "What if two array elements need different shapes — how does `satisfies` handle a union of object shapes?" (Same mechanism; the target type would be a union, and each element gets checked against `AppDefinition | OtherShape` while keeping its own narrower inferred type — `satisfies` doesn't care whether the target is a single interface or a union.)
- "Could you use an enum instead of a string-literal union for `AppStatus`?" (Could, but TypeScript enums have runtime footprint and are a common interview trap — string literal unions plus `as const` give the same exhaustiveness checking with zero emitted JS and a value that's already the string you want to send over JSON.)

## See also

- [typescript-foundations.md](typescript-foundations.md) — `satisfies` and `as const` at the foundations level, plus `typeof ROLES[number]`
- [branded-types-for-money.md](branded-types-for-money.md) — a different technique (nominal-typing simulation) solving an adjacent problem (unit safety, not exhaustiveness)
- `docs/architecture.md#suite-structure` — why the registry is a static list rather than a database table in this phase
