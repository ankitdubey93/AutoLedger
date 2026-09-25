# Discriminated Unions as a Parser's Return Type

> A parser has exactly two things that can happen: it works, or it doesn't. A discriminated union makes the compiler enforce that every caller handles both — a thrown exception makes it optional.

**Category:** TypeScript
**Introduced by:** Phase 28 — `server/src/utils/stockCodePattern.ts`, the item-code pattern tokenizer/parser/renderer
**Verified against:** TypeScript 5.x / 7

---

## Mechanism

### The shape: a tag field plus per-branch payload

```ts
export type ParsedCodePattern = { ok: true; segments: CodeSegment[] } | { ok: false; error: string };
export type RenderedCode = { ok: true; value: string } | { ok: false; error: string };
```

Each is a union of two object types that share one field (`ok`) with a **literal type** (`true` in one branch, `false` in the other) — that shared, literally-typed field is the *discriminant*. TypeScript's control-flow narrowing recognizes this specific shape: once code checks `if (parsed.ok)`, the compiler doesn't just know `parsed.ok === true` inside that branch — it eliminates every union member whose `ok` type isn't compatible with `true`, leaving only `{ ok: true; segments: CodeSegment[] }`. `parsed.segments` becomes accessible with no cast, no `!`, no optional chaining — the compiler has *proven* it exists in that branch, not just been told to trust it does. In the `else` branch (or after an early `return`), the reverse happens: only `{ ok: false; error: string }` survives, and `parsed.error` is the only field the compiler will let you read.

This is exactly the same narrowing mechanism `document-lifecycle-fsm.md` and `runtime-validation-and-zod.md` use for status/result unions elsewhere in this codebase — `stockCodePattern.ts` is simply the first place the pattern is applied to a *parser's own return type*, rather than to a stored database status or a validated request body.

### `CodeSegment`: a discriminated union as an AST

The tokenizer doesn't parse a pattern string directly into a rendered code — it parses it into an intermediate representation, `CodeSegment[]`, once, and `renderCode`/`renderScopeKey` walk that representation repeatedly (once per generation attempt, since a collision retry re-renders with a new sequence number but never re-parses the pattern string):

```ts
export type CodeSegment =
  | { kind: 'LITERAL'; text: string }
  | { kind: 'CAT' }
  | { kind: 'YYYY' }
  | { kind: 'YY' }
  | { kind: 'ATTR'; key: string; length: number }
  | { kind: 'SEQ'; width: number };
```

This is a small, minimal instance of the same idea as a compiler's abstract syntax tree — a fixed vocabulary of node shapes, each carrying exactly the payload its kind needs (`LITERAL` needs `text`; `CAT`/`YYYY`/`YY` need nothing beyond their tag; `ATTR` needs a key and a truncation length; `SEQ` needs a zero-pad width) and nothing else. `render()`'s `switch (seg.kind)` over this union is where the payoff shows up concretely:

```ts
switch (seg.kind) {
  case 'LITERAL': out += seg.text; break;
  case 'CAT': out += ctx.categoryCode; break;
  // ...
  case 'SEQ': /* only here does `seg.width` exist */ break;
}
```

Inside `case 'SEQ':`, `seg`'s type has already narrowed to just `{ kind: 'SEQ'; width: number }` — `seg.width` is directly readable, and `seg.text` (which only `LITERAL` has) is a compile error, not a runtime `undefined`. Reaching for `seg.text` inside the `CAT` case fails to compile, full stop — there's no way to accidentally read a field that branch's data doesn't carry.

### Exhaustiveness: catching a forgotten case at compile time, not at 3am

`CodeSegment` has six members. If a seventh (say, a hypothetical `{LOCATION}` token) were added to the type but the `switch` in `render()` weren't updated, is that a compile error or a silent runtime bug? By default, neither — an un-matched `switch` case simply falls through with no effect, and the missing branch is invisible until someone notices `{LOCATION}` renders as an empty string in production. The standard fix is a `default` arm that assigns the still-unhandled value to a variable typed `never`:

```ts
default: {
  const _exhaustive: never = seg;
  throw new Error(`Unhandled segment kind: ${(_exhaustive as CodeSegment).kind}`);
}
```

If every real case has been handled, TypeScript has narrowed `seg`'s type down to nothing by the time control reaches `default` — the empty union *is* `never`, and assigning a value of type `never` to a `never`-typed variable is always legal (there's nothing to reject). The moment a new segment kind is added to the type without adding a matching `case`, `seg`'s type in the `default` branch is no longer `never` — it's the new, unhandled member — and assigning it to a `never`-typed variable becomes a compile error, flagging the gap before the code ships rather than after a customer reports a blank code. `stockCodePattern.ts`'s actual `render()` doesn't currently have a stray unhandled case to catch (all six kinds are covered), so this is presented here as the general technique this shape is built to support, not a bug that was actually caught by it in this pass.

### Result union vs throwing: why the pure module never imports `ApiError`

Every other service in this codebase signals failure by throwing `ApiError(status, message)`, caught centrally by Express's error-handling middleware. `stockCodePattern.ts` deliberately does neither — `parseCodePattern`, `renderCode`, and `renderScopeKey` never throw at all, and the file has no import of `ApiError` or anything HTTP-shaped. The module's own header comment states this explicitly: "a pure function of its arguments: no database import, no `ApiError`, no I/O... It returns results and never throws" — mirroring two other pure calculation modules that once lived in this codebase, `utils/uniteconPvm.ts` and `utils/forecasterBuild.ts` (UnitEcon and ForecasterPro, both removed in Phase 29).

The reason is what the caller needs to do with a failure. An HTTP request handler failing on invalid input genuinely wants "stop everything, return 422" — throwing and letting a catch-all middleware translate the exception into a response is the right shape there, because there's exactly one thing to do with the error (report it and abort). `parseCodePattern` has callers with *different* needs for the same failure: `itemService.createItem` calling `renderCode` inside a 20-attempt collision-retry loop needs to distinguish "this specific sequence value collided, try the next one" from "this pattern can never succeed, stop retrying" — a thrown exception collapses both into the same `catch` block and loses that distinction, while a discriminated-union return makes the caller's `if (result.ok)` branch and its `else` branch two genuinely different pieces of logic, each explicit about what it's reacting to. A second caller — `previewPattern`, live-rendering an example as a user types a scheme into a settings form — wants to show the error message inline next to the input field, never as a thrown exception bubbling to a global error boundary. One pure function, two callers, two different reactions to failure: that's exactly the case a result union serves better than an exception, because the *type itself* documents that failure is an ordinary, expected outcome the caller must handle, not an exceptional interruption of control flow.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Throw `ApiError` on invalid pattern/render failure | Matches the rest of the codebase's convention; simple call sites | Rejected — collapses distinct failure reasons (retryable vs. not) into one `catch`, and forces a pure calculation module to import HTTP-shaped error machinery it has no business knowing about |
| Return `null`/`undefined` on failure | Cheap, no new type needed | Rejected — carries no error message for the UI to show, and `T | undefined` doesn't stop a caller from reading a property off `undefined` without a narrowing check first (weaker than a proper discriminant) |
| A discriminated-union result (`{ok:true,...} \| {ok:false,error}`) | Caller must explicitly branch; slightly more ceremony at each call site | **Chosen** — the compiler forces every caller to handle both outcomes, the failure branch carries a real message, and the module stays free of any HTTP/DB dependency |
| A generic `Result<T, E>` type (Rust-style) | Reusable across every parser in the codebase, not just this one | Considered, not built — would require introducing a shared generic type and combinator helpers (`map`, `andThen`) this codebase doesn't otherwise use; the inline two-branch shape was judged sufficient for the number of pure-calculation modules that exist so far |

## Where it lives in this codebase

- `server/src/utils/stockCodePattern.ts` — `ParsedCodePattern`, `RenderedCode`, `CodeSegment`, and every function operating on them
- `server/src/utils/uniteconPvm.ts`, `server/src/utils/forecasterBuild.ts` — the two earlier pure-calculation modules that followed the same no-throw convention (pre-dating this note); both removed in Phase 29 along with UnitEcon and ForecasterPro
- `server/src/services/inventory/itemService.ts` — `createItem`'s retry loop branching on `renderCode`'s `ok` field to decide "retry" vs. "surface a 422"
- `server/src/services/inventory/codeSchemeService.ts` — `previewPattern`, returning `parseCodePattern`'s failure message directly to a settings-form field
- `server/src/__tests__/stockCodePattern.test.ts` — 19 tests exercising both branches of every function, including the exhaustiveness-relevant "every declared token kind renders" cases

## Gotchas

- **A discriminant only narrows if TypeScript can prove the field's type is a distinct literal per branch.** `{ ok: boolean; segments?: CodeSegment[] }` (one type, an optional field) does *not* narrow the same way — `ok: true` doesn't tell the compiler `segments` is present, because there's no structural link between the two; only a genuine union of separate object types narrows.
- **Forgetting to check `.ok` before reading a payload field is still a possible mistake** — TypeScript doesn't force you to check; it only rewards you when you do, by refusing to compile a direct read of `.segments` on the *unchecked* union type. `parsed.segments` on an un-narrowed `ParsedCodePattern` is a compile error precisely because the compiler can't know which branch you're in — that error is the safety net, not an inconvenience.
- **The exhaustiveness `never` trick only fires if `strict` (specifically, no implicit `any` on the `default` fallthrough) is on**, and only if every branch before `default` actually narrows the type correctly — a `case` that doesn't match a real discriminant value (a typo'd string literal) won't narrow anything away, and the `never` check will silently fail to catch what looks like it should be an exhaustive switch.
- **A `Result`-style return type composes badly with `async`/`await` error semantics** if mixed carelessly with code that *does* throw — a function returning `RenderedCode` that internally calls something which throws will still propagate that throw normally; the discipline only holds as long as every function in the pure-calculation module genuinely never throws, which is why the header comment states it as an invariant of the whole file, not a per-function choice.

## Interview Q&A

**Q: What makes a union of object types a "discriminated" union specifically?**
A: A shared field, present in every member, whose type is a distinct literal (or otherwise non-overlapping value) per branch — here, `ok: true` in one member and `ok: false` in the other. TypeScript's control-flow analysis recognizes checks against that field (`if (x.ok)`) and uses them to eliminate union members whose discriminant value is incompatible with the check, narrowing the type in each branch to exactly the member(s) still possible. Without a shared, distinctly-typed field to check against, a union of object types doesn't narrow this way — you'd need a manual type guard function instead.

**Q: Why does this parser module return a result object instead of throwing, when the rest of the codebase throws `ApiError` everywhere?**
A: Because this module has multiple callers that need to react to a failure differently, and a thrown exception collapses all of that into one `catch` block regardless. The item-creation service, inside a bounded retry loop over sequence collisions, needs to tell "this specific value collided, try the next one" apart from "this pattern is structurally broken, stop retrying" — a discriminated-union return makes each of those an explicit, typed branch. A settings-page live preview needs the error message to display inline, never to trigger a thrown-exception code path. The module itself also has no business importing an HTTP-shaped error class — it has no database access and no I/O, and staying pure is part of what makes it trivially unit-testable without mocking anything.

**Q: How do you get the compiler to catch a forgotten `switch` case when a union gains a new member later?**
A: Add a `default` branch that assigns the still-unhandled value to a `never`-typed variable. If every real member has been matched by an earlier `case`, the type remaining by the time control reaches `default` is the empty union, which *is* `never`, so the assignment compiles cleanly. The moment a new union member is added without a corresponding `case`, that member survives into the `default` branch, its type is no longer `never`, and the assignment becomes a compile error — you find out at build time, not from a support ticket about a token silently rendering as nothing.

**Q: What's the actual runtime cost of a discriminated union compared to throwing an exception?**
A: Effectively none either way at the language level — a discriminated union is an ordinary object at runtime with no special representation, and `throw`/`catch` in V8 is not meaningfully slower for the volumes involved here. The real difference is at the type level and in what the compiler will let a caller ignore: an exception can be silently un-caught and crash or bubble somewhere unintended, while a result union's failure branch has to be explicitly read out of the return value, so the compiler at least forces acknowledgment that failure is possible, even if it can't force *correct handling* of it.

**Q: Tell me about a design decision where you deliberately avoided this codebase's usual error-handling convention.**
A: The item-code pattern engine (`stockCodePattern.ts`) breaks from the "throw `ApiError`, let middleware translate it" convention every other service module follows, on purpose. The header comment states the reasoning directly: this is a pure function of its arguments, with no database import and no I/O, meant to be called from more than one place with genuinely different reactions to a failure — a retry loop that needs to distinguish retryable from fatal failures, and a UI preview that needs an inline message, not a thrown exception. Using the same discriminated-union pattern the codebase already uses for FSM status types and parsed request bodies, applied here to a function's own return value instead, made both call sites simpler and kept a module with zero I/O dependencies free of an HTTP-shaped error class it had no reason to know about.

## Follow-ups they'll dig into

- "Would you ever mix this with throwing in the same function?" — generally no; mixing means callers can no longer trust the type signature alone to know whether they need a `try/catch` *and* an `if (result.ok)` check, which defeats most of the benefit.
- "How would you build a generic `Result<T, E>` type instead of one-off unions per function?" — a shared `type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E }` plus small combinators (`map`, `andThen`) — not built here because the number of pure-calculation modules didn't yet justify the shared abstraction, but it's the natural next step if a third or fourth one appears.
- "Does `zod`'s `.safeParse()` use the same pattern?" — yes, `{ success: true; data } | { success: false; error }` is the same discriminated-union-result shape, applied to schema validation rather than a hand-written parser; see `runtime-validation-and-zod.md`.

## See also

- [../postgresql/jsonb-user-defined-attributes.md](../postgresql/jsonb-user-defined-attributes.md) — the attribute definitions this parser's `{ATTR:key:n}` token reads its values from
- [../postgresql/gapless-numbering-and-counters.md](../postgresql/gapless-numbering-and-counters.md) — the counter-collision retry loop that is this parser's main caller
- [runtime-validation-and-zod.md](runtime-validation-and-zod.md) — `zod`'s own `safeParse` result union, the same shape applied to schema validation
- [../architecture/document-lifecycle-fsm.md](../architecture/document-lifecycle-fsm.md) — discriminated unions used for stored FSM status, rather than a function's return value
