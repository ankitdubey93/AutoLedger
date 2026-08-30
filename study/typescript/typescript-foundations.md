# TypeScript — Foundations

> A static type layer over JavaScript that is erased entirely at compile time — which means it catches integration bugs across a whole codebase and guarantees absolutely nothing at runtime.

**Category:** TypeScript · Foundations
**Verified against:** TypeScript 5.x

---

## What it is

A superset of JavaScript adding a static type system, from Microsoft (2012). Every valid JS file is a valid TS file. The compiler checks types and then **emits plain JavaScript with all type annotations stripped**.

Two claims define it, and both matter:

- **Structural typing** — compatibility is decided by shape, not by declared name or inheritance. If an object has the required members, it fits.
- **Erasure** — types exist only during compilation. There is no runtime representation, no reflection, no type-based dispatch.

## How it works

### The compiler pipeline

1. **Scanner / Parser** — source to AST
2. **Binder** — builds symbol tables, resolves scopes and declaration merging
3. **Checker** — infers and verifies types; this is where errors come from, and it's a *whole-program* analysis
4. **Emitter** — writes `.js` (annotations removed) and optionally `.d.ts` declaration files

**Checking and transpiling are separable**, which is the most practically important fact here. `esbuild`, `swc`, and Babel strip types *without checking them* — they discard annotations by syntax and never build a type graph. Vite does this, which is why **your dev server can be perfectly happy while `tsc` reports thirty errors**. The consequence: `tsc --noEmit` must run in CI as its own step. A fast dev loop is not a type check.

### Erasure, and the exceptions

Types vanish. So this compiles and then fails at runtime:

```ts
interface User { id: string; email: string }
const u = JSON.parse(body) as User;   // no validation happens. At all.
u.email.toLowerCase();                // TypeError if the field was absent
```

`as` is an *assertion*, not a conversion — you are telling the compiler to stop asking. Any data crossing a runtime boundary (HTTP body, database row, `JSON.parse`, env var) needs a real validator: `zod`, `ajv`, or hand-written guards. **The type system cannot protect a boundary it can't see.**

Three constructs do emit runtime code, which is worth knowing precisely: `enum` (an object), `namespace` (an IIFE), and constructor **parameter properties** (`constructor(private x: T)`). `const enum` inlines instead. Everything else is erased.

### Structural typing

```ts
interface Point { x: number; y: number }
const p = { x: 1, y: 2, z: 3 };
const q: Point = p;              // ✅ has the required members
const r: Point = { x: 1, y: 2, z: 3 };  // ❌ excess property check on a fresh literal
```

That asymmetry surprises people: object *literals* assigned directly get an excess-property check as a bug-catching heuristic, but a variable of a wider type assigns freely. Structural typing is also why `type Cents = number` provides zero safety — it's the same type as `number` — which is what branding solves.

### Inference and narrowing

Inference is aggressive: annotate function parameters and return types at boundaries, and let locals infer. The checker also performs **control-flow analysis**, narrowing a union as it reads your guards:

```ts
function f(x: string | number | null) {
  if (x === null) return;          // x: string | number
  if (typeof x === 'string') {
    x.toUpperCase();               // x: string
  } else {
    x.toFixed(2);                  // x: number
  }
}
```

Narrowing is driven by `typeof`, `instanceof`, `in`, literal comparison, truthiness, and **user-defined type guards** (`function isFoo(x): x is Foo`). Discriminated unions — a union of object types sharing a literal-typed tag — are the idiomatic way to model states, and get you exhaustiveness checking:

```ts
type Result =
  | { ok: true; value: Entry }
  | { ok: false; error: string };

// A switch on `ok` that misses a case fails to compile if the
// function has a declared return type. Add a `never` default
// and adding a new variant becomes a compile error everywhere.
```

This is the pattern for our FSM document states — `DRAFT | APPROVED | RECEIVED | CLOSED` as literal types means an unhandled status is a build failure, not a runtime surprise.

### `any` versus `unknown`

`any` disables checking and **propagates silently** through every expression it touches — one `any` at an API boundary can void safety across a whole call path. `unknown` is the safe top type: it accepts anything but permits nothing until narrowed. Use `unknown` for genuinely unknown input, then validate.

### `strict` — what the flags actually buy

`"strict": true` turns on a family of checks. The two that matter most:

- **`strictNullChecks`** — `null`/`undefined` stop being members of every type, so possibly-absent values must be handled. This single flag eliminates most "cannot read property of undefined" errors.
- **`noImplicitAny`** — an un-inferrable parameter is an error rather than a silent `any`.

Also worth enabling beyond `strict`: `noUncheckedIndexedAccess` (makes `arr[i]` yield `T | undefined`, which is honest), and `exactOptionalPropertyTypes`.

### Generics

Type-level parameters, so a function or type works over many types without losing information:

```ts
const first = <T>(xs: T[]): T | undefined => xs[0];
// constrained: T must have the shape we use
const byId = <T extends { id: string }>(xs: T[], id: string) => xs.find(x => x.id === id);
```

Plus the utility types built on mapped and conditional types: `Partial`, `Pick`, `Omit`, `Record`, `Readonly`, `ReturnType`, `Awaited`.

### `satisfies`

Validates a value against a type *without widening it* — you keep the literal inference and still get checked:

```ts
const ROLES = ['OWNER', 'ADMIN', 'ACCOUNTANT', 'VIEWER'] as const;
type Role = typeof ROLES[number];   // 'OWNER' | 'ADMIN' | 'ACCOUNTANT' | 'VIEWER'

const TRANSITIONS = {
  DRAFT: ['APPROVED', 'CANCELLED'],
  APPROVED: ['RECEIVED'],
} satisfies Partial<Record<Status, Status[]>>;
// checked against the type, but the exact keys and values stay known
```

`as const` then `typeof X[number]` is the standard way to derive a union from a runtime array — one source of truth for both, which is exactly what you want for roles and account types.

### Declaration merging — how `req.user` gets typed

Express's `Request` is defined in `@types/express`, which we do not control, yet the auth middleware needs to attach `req.user`. **Declaration merging** is the mechanism: two declarations of the same interface in the same scope are combined rather than one shadowing the other. It is the type-level counterpart of "interfaces are open".

```ts
// server/src/types/express.d.ts
import type { AuthUser } from './auth.js';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
```

Three things here are easy to get wrong, and each fails differently:

1. **The `import` makes this file a *module*.** A `.d.ts` with no top-level import/export is a *script*, and its declarations are already global. Add an import and everything inside becomes module-local — so the augmentation silently does nothing and `req.user` still errors. `declare global` re-opens the global scope from inside a module. This is the classic failure, and the symptom (no error, just no effect) gives no hint of the cause.
2. **The specifier ends in `.js`.** NodeNext resolution applies to `.d.ts` files too.
3. **The file must be in `include`.** Ambient declarations are picked up by the *program*, not by imports — nothing imports `express.d.ts`. Our `tsconfig.json` has `include: ["src"]`, so it is covered.

Note `user?:` is genuinely optional, because it really is absent on public routes. The temptation is then `req.user!` in every protected controller — an assertion the compiler cannot verify, which turns a route accidentally mounted without the auth middleware into a runtime `TypeError` instead of a clean 401. `requireUser(req)` narrows it in one place and throws `ApiError(401)` instead.

### `exactOptionalPropertyTypes` and the `| null` rule

Under this flag, `{ a?: string }` and `{ a: string | undefined }` are different types: the first means "may be absent", the second "is present and may be undefined". Assigning an explicit `undefined` to an optional property is an error.

It is correct, and it is friction — every object built from a database row needs conditional spreads:

```ts
...(latencyMs !== null ? { latencyMs } : {})
```

The simplest way out is a convention rather than a workaround: **type nullable database columns as `T | null`, never `field?: T`.** `null` is a value, so it assigns freely; it also matches what the `pg` driver actually returns, and it removes the "absent vs present-but-undefined" question entirely. Applied throughout `types/auth.ts`, that single decision eliminated essentially all of the flag's friction.

## What it does best, and how

**Making large-scale refactoring safe.** The mechanism is that the checker is a whole-program analysis: change a function signature or rename a field and *every* call site that no longer fits becomes a compile error. In plain JavaScript the same change is a grep and a hope. This compounds — it's why TypeScript's value grows with codebase size and team size, and why it's near-mandatory for a fifteen-module ERP.

**Catching errors at boundaries between units.** Most real bugs aren't wrong algorithms, they're mismatched contracts: a field renamed on one side, an argument order swapped, a nullable treated as present. Those are exactly what a structural type checker catches for free.

**Encoding domain invariants in types.** This is where it goes from useful to powerful. Branded types make `Cents` and `Dollars` incompatible; branded `OrgId` and `UserId` make a tenant-scoping mix-up a compile error. Discriminated unions make an unhandled document state unbuildable. `as const` unions keep roles defined once. Each of these converts a class of runtime bug into a build failure.

**Serving as always-accurate documentation and tooling.** Autocomplete, go-to-definition, and inline signatures are all downstream of the type graph, and unlike comments the types cannot drift from the code.

## Where it's weak

- **Zero runtime guarantees.** The biggest and most misunderstood limitation. Types don't validate API input, DB rows, or env vars.
- **`any` and `as` are escape hatches** that silently void safety, and they accumulate under deadline pressure.
- **Third-party types can be wrong.** `@types/*` packages are community-maintained and may lag or misdescribe the library.
- **Build step and cold-start cost.** `tsc` on a large project is slow; incremental builds and project references help.
- **Type-level programming gets unreadable.** Conditional and recursive types can express a great deal, and past a point nobody can maintain them. Error messages for deep generics are notoriously bad.
- **Structural typing allows accidental compatibility** — two unrelated concepts with the same shape are interchangeable unless you brand them.

## Why we chose it for AutoLedger

| Requirement | Why TypeScript |
|---|---|
| 15 modules, schema growing continuously | Refactors surface every affected call site |
| Shared contracts between Express and React | One definition, checked at both ends |
| Financial invariants (cents, tenant IDs) | Branded types make unit and scope mix-ups compile errors |
| Document lifecycles | Discriminated unions + exhaustiveness checking |
| `strict` mandated in `CLAUDE.md` | `strictNullChecks` alone removes a whole bug family |

**Versus plain JavaScript:** faster to start, unsustainable at this scale — the ERP roadmap means constant schema change, and each change is a refactor.

**The gap to close:** because types are erased, `strict` mode does nothing for a malformed request body. Runtime validation at the HTTP boundary — a schema validator on every route input — is a real hole in the current plan and should land with Phase 1 rather than be retrofitted. Note that `ajv` is already approved for Phase 12's QMS forms; using it (or `zod`) at the API boundary from Phase 1 would be a defensible early decision.

## Vocabulary that shows up in interviews

**structural vs nominal typing** · **type erasure** · **inference** · **narrowing / control-flow analysis** · **type guard** · **discriminated union** · **exhaustiveness checking** · **generic / constraint** · **`unknown` vs `any` vs `never`** · **declaration merging** · **`.d.ts`** · **mapped / conditional types** · **`satisfies`** · **branded type**

## Interview Q&A

**Q: What does TypeScript give you, and what does it explicitly not give you?**
A: It gives compile-time checking of contracts across a whole program, so a signature change surfaces every call site that breaks, plus tooling — autocomplete and refactoring — that follows from the type graph. What it does not give you is any runtime guarantee. Types are erased in the emitted JavaScript, so an `as User` on a parsed request body is an assertion that the compiler should stop asking, not a validation. Anything crossing a runtime boundary still needs a real validator like `zod` or `ajv`. That's the single most common misconception I see.

**Q: Structural versus nominal typing — what's the practical consequence?**
A: TypeScript compares shapes, not names, so any object with the required members satisfies an interface, and two identically-shaped types are fully interchangeable. That's flexible — you don't need to declare that a type implements an interface — but it means semantically distinct concepts with the same shape are silently swappable. `type Cents = number` and `type Dollars = number` are the same type. Every UUID-based ID in a system is the same type. The workaround is branding: intersect with a phantom property so the compiler treats them as distinct, which costs nothing at runtime since it's erased.

**Q: `any` versus `unknown` versus `never`?**
A: `any` opts out of checking and propagates — anything derived from an `any` is also unchecked, so one at a boundary can void safety along a whole path. `unknown` is the safe top type: everything is assignable *to* it, nothing is assignable *from* it until you narrow, so it forces you to prove what you have. `never` is the bottom type, inhabited by nothing — it's the return type of a function that always throws, and it's the tool for exhaustiveness checking, because assigning a leftover union member to `never` in a `default` branch fails to compile when someone adds a variant.

**Q: How would you model a document with a lifecycle?**
A: A discriminated union with the status as a literal-typed tag, plus a single transition table. The union gets you exhaustiveness — a `switch` on the tag that misses a case fails to compile, so adding a new state surfaces every place that needs updating. If different states carry different data, the union also makes fields available only where they're valid, so you can't read an `approvedBy` on a draft. Then the legal transitions live in one `Record<Status, Status[]>` validated with `satisfies`, rather than status strings assigned ad hoc across services. That's the pattern for our purchase orders — draft, approved, received, closed.

**Q: What does `strict` actually turn on, and which flag matters most?**
A: A family of checks, but `strictNullChecks` is the one that changes how you write code. Without it, `null` and `undefined` are assignable to every type, so the compiler can't tell you a value might be absent. With it they're distinct, so possibly-missing values must be narrowed before use — which eliminates most "cannot read property of undefined" crashes. `noImplicitAny` is second: it turns silent `any` parameters into errors. Beyond `strict`, I'd add `noUncheckedIndexedAccess`, because `arr[i]` returning `T` rather than `T | undefined` is simply a lie the default settings tell you.

**Q: Your dev server runs fine but CI fails on types. How is that possible?**
A: Because checking and transpiling are separate jobs. Vite, esbuild, and swc strip type annotations syntactically without ever building a type graph — that's why they're so fast. They'll happily emit JavaScript from a file with type errors. So the dev server proves your code *runs*, not that it *typechecks*. The fix is running `tsc --noEmit` as an explicit CI step and ideally a pre-commit hook, and understanding that a green dev server is not a signal about type correctness at all.

**Q: Tell me about a time you used the type system to prevent a bug rather than just describe code.**
A: On AutoLedger, money and IDs are both branded types. Money is integer cents, and `Cents` is a distinct branded type with a checked constructor, so a raw number or a dollar amount can't reach a function expecting cents — the previous version of the project stored `DECIMAL` and compared balances with a floating-point epsilon, so this was a known-expensive bug class. The ID case is arguably stronger: it's a multi-tenant system where every ID is a UUID string, so `OrgId` and `UserId` are structurally identical. Passing a user ID where an org ID belongs is exactly the shape of a cross-tenant data leak, and branding turns that from a silent security bug into a compile error for one line of type definition.

## Follow-ups they'll dig into

- "How do you type a function that returns different shapes based on an argument?" (Overloads, or conditional types with generic inference — and know when the honest answer is "split it into two functions".)
- "What is declaration merging and when is it the right tool?" (Reopening an interface — how `req.user` gets typed on Express's `Request`.)
- "Interface versus type alias?" (Interfaces merge and are marginally better in errors; type aliases handle unions, tuples, and mapped types. Most style guides say interface for object shapes, type for everything else.)
- "How do you handle an untyped npm package?" (`declare module` shim, contribute to DefinitelyTyped, or a local `.d.ts` — and never a blanket `any`.)
- "What's the difference between `as const` and `satisfies`?" (`as const` freezes to literals and makes it readonly; `satisfies` checks against a type without widening or discarding inference. They compose.)

## See also

- [branded-types-for-money.md](branded-types-for-money.md) — the deep dive
- `docs/guardrails.md` rule 3
