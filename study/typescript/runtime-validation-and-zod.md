# Runtime Validation & Parse, Don't Validate

> TypeScript's types are erased at compile time, so a request body is `unknown` no matter what the signature claims — and a *parser* that narrows the type is strictly better than a *validator* that returns a boolean and leaves you holding the same `unknown`.

**Category:** TypeScript
**Introduced by:** Phase 3 — `POST /ledger-core/journals`, whose body is a nested `lines[]` array with a cross-field rule per element
**Verified against:** TypeScript 7.0.2, zod 4.5.4, Node 24

---

## Mechanism

### Why `strict` mode buys nothing at the boundary

TypeScript erases types. `tsc` emits JavaScript with every annotation stripped, so this compiles and lies:

```ts
const body = req.body as CreateEntryInput;   // a promise, not a check
body.lines.map(...)                          // TypeError at runtime on a malformed body
```

`strict: true` catches nothing here, because nothing about `req.body` was ever known. Express types it `any` by default; even typed as `unknown`, a cast reintroduces the lie. **The type system's guarantees end wherever data enters the process** — HTTP bodies, query strings, environment variables, database rows, files, third-party API responses.

### Parse, don't validate

The phrase is Alexis King's, and the distinction is about what the function *returns*.

```ts
// validate — returns a boolean; the caller still holds `unknown`
function isValid(body: unknown): boolean

// parse — returns the narrowed value, or throws
function parseBody<T>(schema: ZodType<T>, body: unknown): T
```

A validator lets the knowledge it gained escape: you check, then still have to cast, and the cast can drift from the check. A parser makes the knowledge *the return type*, so there is nothing to cast and no way to forget. Every downstream function receives a value whose shape the compiler knows.

The general principle: **push a value into its most precise representation as early as possible, and make illegal states unrepresentable afterwards.** A TypeScript type predicate (`x is T`) is the middle ground — it narrows, but you still write the runtime check by hand and nothing verifies the two agree.

### What zod actually does

A zod schema is a runtime object describing a shape, plus a static type derivable from it:

```ts
const lineSchema = z.object({
  accountId: z.uuid(),
  debitCents: z.int().nonnegative().default(0),
  creditCents: z.int().nonnegative().default(0),
}).refine((l) => (l.debitCents > 0) !== (l.creditCents > 0), {
  message: 'A line must have exactly one of debitCents or creditCents greater than zero',
});

type Line = z.infer<typeof lineSchema>;   // { accountId: string; debitCents: number; creditCents: number }
```

`z.infer` is a conditional/mapped type walking the schema's own type parameters. The consequence that matters: **the schema and the type are one artifact.** There is no second declaration to drift.

`safeParse` returns a discriminated union — `{ success: true, data: T } | { success: false, error: ZodError }` — so narrowing on `.success` is checked by the compiler. `.parse` throws instead. Neither mutates the input; zod builds a new value, which is why `.default()` and coercion work.

`.refine()` is where cross-field rules live, because they cannot be expressed per property. It runs *after* the base shape parses, so it can assume the fields exist.

### The `exactOptionalPropertyTypes` collision

Worth knowing, because it produced a real type error here. Under `exactOptionalPropertyTypes: true`:

```ts
{ name?: string }              // absent, or a string. NOT explicitly undefined.
{ name?: string | undefined }  // absent, a string, or explicitly undefined.
```

zod infers an optional key as the second form. A service signature written as the first form rejects it. The honest fix is widening the service signature — the two types genuinely differ, and the flag is telling the truth.

---

## Why we chose it here

Phase 1 deliberately shipped a hand-rolled `utils/validate.ts` and recorded a **revisit trigger** in [development.md](../../docs/development.md#dependency-policy): "LedgerCore's journal entries take a nested `lines[]` array, and hand-rolling nested-array validation is where a schema library starts paying for itself." Phase 3 is that trigger firing.

| Option | Trade-off | Verdict |
|---|---|---|
| `as CreateEntryInput` | Zero code | Rejected — a cast is a lie; the body is attacker-controlled |
| Hand-rolled validators (Phase 1's approach) | No dependency, fully understood, unit-tested | **Kept for the auth routes** — flat objects of five scalars. Rejected for `lines[]`: nested arrays with cross-field rules is where it stops being readable |
| **zod** | Nested shapes, cross-field `.refine`, `z.infer` unifies schema and type | **Chosen for LedgerCore** |
| JSON Schema + Ajv | Standard, language-agnostic | Rejected — no type inference; the TS type is a second declaration that drifts |
| `class-validator` + decorators | Familiar from NestJS | Rejected — needs `experimentalDecorators` and a class per DTO |

Both coexist on purpose. This was an addition, not a rewrite: rewriting Phase 1's working, tested auth validation would have been churn with no user-visible benefit and a real chance of regression.

---

## Where it lives in this codebase

- `server/src/utils/parseBody.ts` — the bridge: `safeParse`, and on failure an `ApiError(400)` listing **every** failed path, not just the first
- `server/src/schemas/ledger-core/journalSchema.ts` — the nested `lines[]` schema, `.min(2)`, and the per-line `.refine`
- `server/src/schemas/ledger-core/accountSchema.ts` — `z.enum(ACCOUNT_TYPES)`, reusing the same `as const` array that derives the TS union and mirrors the migration's CHECK constraint
- `server/src/utils/validate.ts` — the Phase 1 hand-rolled validators, still serving `/auth`

Note what the journal schema deliberately omits: `sourceType` and `sourceId`. A client-posted entry is always `'manual'`; another app passes those service-to-service. Making a field *unparseable* is a cleaner defence than validating it, because there is nothing to get wrong.

---

## Gotchas

- **A cast is not a check.** `as T` on request data is the single most common way typed codebases ship runtime errors.
- **Report every failure at once.** Returning only the first means a client with three bad fields makes three round trips.
- **`z.infer` on a schema with `.default()` gives the *output* type** (the field is required). `z.input` is the pre-parse type where it is optional. Mixing them up produces confusing errors.
- **`.refine` runs after the base parse**, so it never sees a partially-parsed object — but it also does not run if the base shape failed.
- **`exactOptionalPropertyTypes` disagrees with zod's optionals.** Widen the consuming signature to `| undefined`; do not disable the flag.
- **Validation is not authorization.** A well-formed `accountId` belonging to another tenant parses perfectly. Scope checks are a separate layer (rule 1).
- **Don't validate money as a float.** `z.int()` rejects `450.5`; accepting it and rounding later reintroduces exactly the precision bug integer cents exist to prevent.
- **Zod is a runtime dependency**, not a dev one. It executes on every request.

---

## Interview Q&A

**Q: If TypeScript is strictly typed, why do you need runtime validation at all?**
A: Because types are erased at compile time. `tsc` emits JavaScript with every annotation stripped, so at runtime there is no type information and nothing checks that an incoming request body matches the interface you declared. Writing `req.body as CreateEntryInput` compiles cleanly and tells you nothing — it's an assertion, not a check, and the body is attacker-controlled. The type system's guarantees hold *inside* the process; they end at every boundary where data arrives — HTTP, environment variables, database rows, third-party responses. Runtime validation is what re-establishes them at the edge.

**Q: What does "parse, don't validate" mean in practice?**
A: It's about what the function returns. A validator returns a boolean: you check, and you're still holding an `unknown`, so you cast — and the cast can drift from the check. A parser returns the narrowed value or throws, so the knowledge it gained becomes the return type. There's nothing to cast and no way to forget. Concretely, my `parseBody(schema, req.body)` returns a typed value, so every function downstream receives something the compiler knows the shape of. The broader principle is to push data into its most precise representation as early as possible and make illegal states unrepresentable after that point.

**Q: You wrote validators by hand in Phase 1 and adopted zod in Phase 3. Why the change?**
A: Phase 1's bodies were flat objects of about five scalars — an email, a password, an org name. A hand-rolled validator for that is short, obvious, and unit-tested, and it avoided a dependency. I recorded the revisit trigger in the dependency doc at the time: journal entries take a nested `lines[]` array where each element has a cross-field rule — exactly one of debit or credit must be positive — and the array itself has a minimum length. Hand-rolling nested-array validation with per-element cross-field rules is where it stops being readable and starts being a source of bugs. So the trigger fired and I adopted zod for LedgerCore, and deliberately left the auth routes alone. Rewriting working, tested validation would have been churn with a real regression risk and no benefit anyone could see.

**Q: What's the advantage of zod over JSON Schema?**
A: Type inference. With zod the schema is the single artifact and `z.infer` derives the TypeScript type from it, so they cannot drift. With JSON Schema plus Ajv you write the schema *and* a TypeScript interface, and nothing enforces that they agree — which means the failure mode is a schema that validates something the type says is impossible. JSON Schema wins when the contract has to be language-agnostic or published to consumers, which is a real reason to choose it; it just isn't this codebase's situation.

---

## Follow-ups they'll dig into

- *"Where else would you validate?"* Environment variables at boot (this codebase already does, fail-fast), and any third-party API response — a provider changing a field shape is the same class of problem as a malformed request.
- *"What about performance?"* Zod parses per request. For a hot path you'd compile the schema once at module scope (which this does — schemas are module-level constants, not built per call), and if it ever mattered, TypeBox with Ajv compiles to a JIT'd function.
- *"How do you avoid duplicating the enum three times?"* One `as const` array feeds the TypeScript union, the zod enum, and mirrors the database CHECK — see `types/ledger-core.ts`.
- *"Does validation replace authorization?"* No. A well-formed UUID belonging to another tenant validates perfectly. Different layer.

---

## See also

- [typescript-foundations.md](typescript-foundations.md) — type erasure
- [const-assertions-and-satisfies.md](const-assertions-and-satisfies.md) — the `as const` array feeding the zod enum
- [branded-types-for-money.md](branded-types-for-money.md) — the other half of making illegal states unrepresentable
- [express-middleware-and-async-errors.md](../node-express/express-middleware-and-async-errors.md) — how the thrown `ApiError` reaches the client
