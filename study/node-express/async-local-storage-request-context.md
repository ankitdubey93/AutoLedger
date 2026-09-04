# AsyncLocalStorage & Request Context

> `AsyncLocalStorage` gives a value that is implicitly visible to every `await` inside one request's call chain without being passed as a parameter — the mechanism that lets a database trigger three layers away learn who made a request, with nothing threaded through any function signature in between.

**Category:** Node/Express
**Introduced by:** Phase 5 — `utils/requestContext.ts`, carrying the authenticated user id and client IP from `authenticate` down to `db/transaction.ts`, for the audit trail to attribute a write
**Verified against:** Node 22 (`node:async_hooks`, stable since Node 16)

---

## Mechanism

### The problem it solves

Express's request-handling model is: one incoming request runs through a chain of middleware and a controller, and from there into services and eventually SQL. `req.user` — the caller's identity — is available at the top of that chain, in the middleware. The audit trigger needs that identity three layers down, inside a raw SQL statement issued from `db/transaction.ts`, which has never seen `req` and structurally should not — it's a database-layer module, not an HTTP-layer one.

The naive fix is to pass the user id as an explicit parameter through every function call between the controller and the query — `createEntry(orgId, userId, input)` already does exactly this for `createdBy`. That works for a handful of call sites. It does not work for something that needs to reach *every* write path, present and future, without editing every service function's signature to add one more trailing parameter that most of them will never otherwise need.

### What `AsyncLocalStorage` actually is

`AsyncLocalStorage` (from `node:async_hooks`, no dependency to add — it is Node core) is a container that associates a value with an **async execution context**, not with a variable binding. The API surface is small:

```ts
const requestContextStorage = new AsyncLocalStorage<RequestContext>();

requestContextStorage.run(context, () => {
  // context is available via requestContextStorage.getStore()
  // in this callback, and in anything it calls, and in anything
  // *that* calls, transitively, through any number of awaits —
  // as long as the call chain descends from this .run().
});

// Anywhere inside that chain:
const context = requestContextStorage.getStore(); // the same object
```

The mechanism underneath is Node's async resource graph — the same bookkeeping the runtime already does to know which `Promise` continuation belongs to which original async operation, so `unhandledRejection` and `async_hooks`' own diagnostics can trace causality across `await` boundaries. `AsyncLocalStorage.run()` attaches a store to the *current* async resource; every child resource created inside the callback (a `Promise` continuation, a `setTimeout`, a database query's callback) inherits a link back to it, so `getStore()` from any of those descendants walks that link and finds the same store. Critically, this happens **without the store being an argument or a closure variable** at any of the intermediate call sites — `db/transaction.ts` calls `getRequestContext()` and gets the right object back despite never having been handed it, and despite two concurrent requests each seeing their own value simultaneously on the same running process.

### Why concurrent requests don't collide

Node is single-threaded for JavaScript execution, but many requests are genuinely in flight at once, interleaved at every `await`. `AsyncLocalStorage` context is not global mutable state — each call to `.run(context, fn)` creates an independent association scoped to that call's descendant executions. Two requests, each wrapped in their own `attachRequestContext` middleware invocation, each get their own `context` object, and `getStore()` inside request A's chain never sees request B's context, even though both are executing "at the same time" from the event loop's perspective. This is the property that makes it safe to use for per-request state at all — a plain module-level `let currentUser` would be overwritten by the second request before the first one finished.

### Why the context object is mutable

`attachRequestContext` runs as the very first middleware, before `cors`, before `authenticate` — deliberately, so even a request that never reaches an authenticated route (a CORS rejection, a 404) still has a context available to any code that might run. At that point the caller's identity is not known yet; `authenticate` hasn't verified the token. Rather than opening a second, later context once the identity *is* known — which `AsyncLocalStorage` doesn't straightforwardly support mid-chain without re-wrapping the remaining middleware — `authenticate` mutates the fields on the same context object `attachRequestContext` created:

```ts
const context = getRequestContext();
if (context !== undefined) {
  context.userId = req.user.id;
  context.orgId = req.user.orgId;
}
```

Every later `await` in the request sees the identity once it exists, because they're all reading the same object reference, not a snapshot taken at context-creation time.

---

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Explicit parameter threading (`userId` on every service function) | No hidden state, fully visible in every signature | Rejected as the *general* solution — works for the few functions that already need `createdBy`; does not scale to "every write, everywhere, present and future," without touching dozens of signatures for a concern orthogonal to what each function is actually doing |
| Module-level mutable variable (`let currentUser`) | Trivial to implement | Rejected — broken under concurrency the instant two requests are in flight; the second request's assignment overwrites the first mid-request |
| `cls-hooked` (community continuation-local-storage library, pre-dates `AsyncLocalStorage`) | Same idea, existed before Node shipped a native version | Rejected — an unnecessary dependency (guardrails rule 14) for something Node's standard library now does natively, and with correctness Node itself guarantees rather than a userland shim |
| A `WeakMap` keyed by `req` | No new API to learn | Rejected — still has to be threaded to every function that needs it (they'd all need `req` passed in), which is the exact problem being solved |
| **`AsyncLocalStorage`** | Implicit propagation across `await`; a small, easy-to-miss gotcha about mutation timing | **Chosen** |

The actual driver was Phase 5's constraint: the audit trigger needs the actor id and client IP, and the only channel into a trigger is a transaction-local session variable set by `db/transaction.ts` (see [audit-triggers-and-session-variables.md](../postgresql/audit-triggers-and-session-variables.md)) — a module several layers removed from anything that has ever seen `req`.

---

## Where it lives in this codebase

- `server/src/utils/requestContext.ts` — `RequestContext`, `requestContextStorage`, `getRequestContext()`, `runWithRequestContext()`
- `server/src/middleware/requestContext.ts` — `attachRequestContext`, mounted first in `app.ts`, before `cors`
- `server/src/middleware/auth.ts` — `authenticate` fills in `userId`/`orgId` on the existing context, once the access token verifies
- `server/src/db/transaction.ts` — `applyAuditContext()` reads `getRequestContext()` and publishes it into PostgreSQL via `set_config`
- `server/src/__tests__/platform/auditActor.test.ts` — case 5 proves a direct service call with no HTTP request behind it (no context) still succeeds, with a null actor; case 6 proves two requests on the same pool never see each other's context

---

## Gotchas

- **`getStore()` returns `undefined` outside any `.run()` call.** Every consumer (`applyAuditContext`) has to handle the missing case — a script, a migration, or a direct service call in a test has no request context, and that's correct, not an error to throw on.
- **Context set up before identity is known has to be mutated, not replaced**, if later middleware needs to add fields once they become available. Replacing it with a fresh `.run()` mid-chain would need re-wrapping every subsequent handler in the new context, which Express's middleware model doesn't make easy.
- **The context does not survive a process boundary.** A background job picked up by a worker process (Phase 7) starts with no context — the actor has to be re-established explicitly if the job needs to attribute a database write, e.g. by storing it as an ordinary column on the job payload.
- **It is easy to reach for this as a general-purpose "avoid passing arguments" tool**, which trades explicit data flow for implicit — worth doing for something that genuinely needs to reach every layer (request identity, a trace id), not as a substitute for an ordinary function parameter.

---

## Interview Q&A

**Q: What is `AsyncLocalStorage` and what problem does it solve?**
A: It's a Node core API that associates a value with an asynchronous execution context, so any code running "underneath" a `.run()` call — including through any number of `await`s, callbacks, and function calls in between — can read that value back with `getStore()`, without it being passed as an explicit argument anywhere in the chain. I used it to carry the authenticated user's id and IP from Express's auth middleware down into a database transaction helper several layers away, so a trigger could attribute a write to the person who made the request, without adding a `userId` parameter to every service function in the codebase.

**Q: How is this different from just using a global variable?**
A: A global is one shared slot — under concurrency, whichever request wrote to it last wins, and Node genuinely does run many requests concurrently even though JavaScript itself is single-threaded, because they interleave at `await` points. `AsyncLocalStorage` isn't global state; each `.run()` call creates an association scoped to that call's own descendant executions, tracked through Node's async resource graph — the same bookkeeping that lets `unhandledRejection` trace a rejection back to where it originated. Two concurrent requests each get their own store, and neither can observe the other's.

**Q: Why did you make the context object mutable instead of creating a new one once the user's identity is known?**
A: The context has to exist from the very first middleware — before `cors`, before authentication — so that even a request that never authenticates (a CORS rejection, a 404) has *something* for downstream code to safely call `getStore()` on. But identity isn't known at that point. `AsyncLocalStorage` doesn't have an easy way to swap in a richer context partway through a chain without re-wrapping every remaining handler in a new `.run()`. So instead, `authenticate` mutates fields on the same object `attachRequestContext` created — `userId`, `orgId` — and everything downstream, since it holds a reference to that same object, sees the identity once it's filled in.

**Q: What happens to a write that has no request context at all — a script, a test calling a service directly?**
A: `getStore()` returns `undefined`, and every consumer has to handle that explicitly. In my case, `applyAuditContext` does `ctx?.userId ?? ''` — an unset context degrades to an empty string, which the SQL side treats as a NULL actor. That's the correct outcome, not a bug: nobody made that write through the API, so there's no actor to record.

**Q: Tell me about a bug or non-obvious behavior you hit using this.**
A: The mutation timing. My first instinct was to create the context once, fully populated, in one place — but the middleware order genuinely doesn't allow that, since `attachRequestContext` has to run before `authenticate` to guarantee every code path has a context, including ones that error out before authentication succeeds. I had to explicitly design the object as something that starts partially filled and gets completed in place, rather than something constructed once and handed down — which is a different mental model from how I'd normally think about passing data through a request, closer to a mutable accumulator than an immutable value.

---

## Follow-ups they'll dig into

- *"Does this work across `setTimeout` or `setImmediate`?"* Yes — `AsyncLocalStorage` tracks the async resource graph generally, not just Promise chains, so a callback scheduled from inside a `.run()` still sees the same store.
- *"What about worker threads or a queue-based background job?"* No — those are separate execution contexts (a new thread, or a job picked up by an entirely different process later), so the association doesn't cross that boundary. Anything a background job needs has to be captured explicitly into the job's own payload before the context that created it disappears.
- *"Is there a performance cost?"* A small one — Node has to do extra bookkeeping to propagate the association across async boundaries, which `async_hooks` has historically had measurable overhead for. For a handful of fields read once or twice per request, it's not a bottleneck; it would be worth benchmarking before using it on a genuinely hot path with many context reads per request.
- *"How would you test this?"* Directly — assert that two concurrent requests, driven through the actual app (not the service layer directly, since the middleware chain is what populates the context), each produce database rows attributed to the correct actor. `auditActor.test.ts`'s "does not leak an actor between pooled requests" case is exactly this.

---

## See also

- [audit-triggers-and-session-variables.md](../postgresql/audit-triggers-and-session-variables.md) — where the value this note describes actually ends up: a PostgreSQL session variable, read back by a trigger
- [express-middleware-and-async-errors.md](express-middleware-and-async-errors.md) — the middleware chain and `next()` mechanics this context rides on top of
- [event-loop-and-blocking.md](event-loop-and-blocking.md) — why concurrent requests interleave at `await` points in the first place
