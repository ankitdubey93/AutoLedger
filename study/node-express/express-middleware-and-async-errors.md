# Express Middleware Chain & Async Error Handling

> Express is a linked list of functions sharing one `req`/`res` pair; the single most common production bug is an `async` handler whose rejection never reaches the error middleware.

**Category:** Node/Express
**Introduced by:** Phase 0–1 — `errorHandler.ts`, `auth.ts`, `rbac.ts`
**Verified against:** Express 4.19 (behaviour differs in Express 5 — noted below)

---

## Mechanism

### The router is a stack of layers

`app.use(path, fn)` and `app.get(path, fn)` push a **Layer** onto the router's stack. Each layer holds a compiled path pattern and a handle function. On each request Express walks the stack from index 0, and for every layer whose pattern matches the URL it calls the handle with `(req, res, next)`.

`next` is a closure over the current index. Calling it advances to the next matching layer. Nothing is automatic:

- If a handler neither sends a response nor calls `next()`, **the request hangs** until the client times out. There's no supervisor.
- If a handler sends a response *and* calls `next()`, you get `ERR_HTTP_HEADERS_SENT` when something downstream tries to write again.

`req` and `res` are the same two objects for the whole chain, which is why middleware can decorate them — our auth middleware attaching `req.user = { id, orgId, role }` is exactly this. It's also why the augmentation has to be declared to TypeScript in `types/express.d.ts` via declaration merging on the `Express.Request` interface.

### Error handling is detected by function arity

`next(err)` with any truthy argument switches the walk into error mode: Express skips every remaining normal layer and looks for a layer whose handle takes **four** parameters.

```ts
// This IS error middleware — 4 params
app.use((err, req, res, next) => { ... });

// This is NOT — 3 params. Express treats it as ordinary middleware
// and it will never see an error.
app.use((err, req, res) => { ... });
```

Arity is checked with `fn.length`. Two consequences that bite people:

- A default parameter or a rest parameter changes `fn.length` and silently breaks error-middleware detection.
- Error middleware must be registered **after** the routes, because the stack is walked in registration order.

### The Express 4 async trap

Express 4 predates promises. It calls your handler and ignores the return value. So:

```ts
// Express 4: the error NEVER reaches errorHandler.
app.get('/journals', async (req, res) => {
  throw new ApiError(400, 'boom');   // → unhandled rejection, request hangs
});
```

The throw rejects the async function's promise. Nobody is awaiting it, so it becomes an unhandled rejection — which on Node ≥15 **crashes the process by default** — and the client gets nothing until timeout.

Three fixes:

```ts
// 1. try/catch in every handler — correct, verbose, easy to forget once
export const list = async (req, res, next) => {
  try { ... } catch (e) { next(e); }
};

// 2. A wrapper (preferred) — one place, impossible to forget
const asyncHandler = (fn: RequestHandler): RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/', asyncHandler(journalController.list));

// 3. Upgrade to Express 5, which forwards a returned promise's rejection to next()
```

**Express 5** (stable since 2024) fixes this: if a handler returns a promise that rejects, the rejection is routed to `next()` automatically. Since `CLAUDE.md` pins Express **4**, option 2 is the one to implement — a single `asyncHandler` in `utils/`, applied at the route layer.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| `try/catch` in every controller | No abstraction, but one forgotten `catch` is a hung request and a possible process crash | Rejected as the primary mechanism |
| `asyncHandler` wrapper at the route layer | One implementation, applied uniformly, visible at the route definition | **Choose this** in Phase 0 |
| `express-async-errors` (monkey-patches Express) | Zero code changes, but patches the framework at import time — invisible magic | Rejected; we'd rather the seam be explicit |
| Express 5 | Fixes it natively | Not pinned; revisit as a deliberate upgrade |

This is also why `docs/guardrails.md` rule 1 keeps controllers thin: a controller that only validates, delegates, and formats has one obvious failure path to route to `next()`. Business logic in the controller multiplies the places an error can escape.

## Where it lives in this codebase

Nothing is built yet (Phase 0 pending). Planned:

- `server/src/middleware/errorHandler.ts` — the 4-arg terminal handler; formats `ApiError` vs unknown errors
- `server/src/middleware/auth.ts` — verifies the JWT, attaches `req.user = { id, orgId, role }`
- `server/src/middleware/rbac.ts` — `requireRole(...)`, runs *after* `auth`
- `server/src/middleware/idempotency.ts` — Phase 9
- `server/src/utils/apiError.ts` — `ApiError(status, message)`

**Ordering matters:** `cors` → `cookieParser` → `express.json` → routes (`auth` → `rbac` → controller) → 404 handler → `errorHandler` last.

## Gotchas

- **Never leak an unknown error's message to the client.** `errorHandler` should surface `ApiError.message` for known 4xx and a generic string for anything else, logging the real error server-side. A raw Postgres error can reveal table and column names.
- **Never log the decoded JWT payload** (`docs/guardrails.md` rule 11).
- **Sending a response and calling `next()`** double-writes. Always `return res.json(...)`.
- **`express.json()` has a 100kb default body limit.** A large journal batch or bulk import will 413 until raised deliberately.
- **A 404 is not an error until you make it one.** If no layer matches, Express falls through to its default handler. Add an explicit catch-all before `errorHandler`.
- **Error middleware registered before the routes never fires.** Order is registration order.

## Interview Q&A

**Q: Walk me through what happens when a request hits an Express app.**
A: Express matches the request against its router stack — an ordered list of layers, each with a path pattern and a handler. It walks from the top, and for each matching layer invokes the handler with `req`, `res`, and a `next` closure bound to the current position. Handlers mutate the shared `req`/`res` or call `next()` to pass control. The chain ends when something writes a response. If nothing does and nothing calls `next()`, the request just hangs. If `next(err)` is called, Express switches to error mode and skips ahead to the first handler declared with four parameters.

**Q: How does Express know a function is error-handling middleware?**
A: Function arity — it checks `fn.length === 4`. That's a genuine footgun: adding a default value to a parameter changes `length` and your error handler silently degrades into ordinary middleware that never receives errors. It also has to be registered after the routes, since the stack is walked in order.

**Q: You throw inside an `async` route handler in Express 4. What happens?**
A: The error does not reach your error middleware. Express 4 ignores the handler's return value, so the rejected promise has nobody awaiting it — it becomes an unhandled rejection, which on modern Node terminates the process by default, and the client hangs until it times out. The fixes are a `try/catch` in every handler, a wrapper that does `Promise.resolve(fn(...)).catch(next)`, or Express 5, which forwards returned-promise rejections to `next()` for you.

**Q: How do you type `req.user` in a TypeScript Express app?**
A: Declaration merging. Express's types expose a global `Express.Request` interface, so in a `.d.ts` you reopen it and add the property. In our case `req.user?: { id: string; orgId: string; role: Role }`. Marking it optional is more honest — it's only populated after the auth middleware runs, and the optionality forces call sites to acknowledge routes where it may be absent. The alternative is a narrowed `AuthedRequest` type asserted after the middleware, which is more type-safe but noisier at every handler signature.

**Q: Where would you put rate limiting, and why there?**
A: Before authentication, at the edge of the chain. Rate limiting exists partly to protect expensive operations, and JWT verification plus a bcrypt compare on a login route *is* the expensive operation — limiting after auth means an attacker still gets to spend your CPU. Login especially wants a stricter per-IP-and-per-account limit than the global default. Ideally it lives in front of the app entirely (reverse proxy or gateway) so the Node process never sees the traffic.

**Q: Tell me about a time middleware ordering caused a bug.**
A: The class of bug I design against is RBAC before authentication. `requireRole` reads `req.user.role`, which only exists because the auth middleware put it there — mount them in the wrong order and `req.user` is `undefined`. Depending on how the role check is written, that either throws a `TypeError` surfaced as a 500 (bad, but loud) or evaluates falsy and returns 403 (worse, because it looks like correct behaviour while actually meaning "auth never ran"). On AutoLedger the mitigation is that `rbac.ts` treats a missing `req.user` as a programming error distinct from a failed permission check, so the two can never be confused in logs.

## Follow-ups they'll dig into

- "What if the error handler itself throws?" (Express falls back to its default handler; in production that's a bare 500 with no body. Keep `errorHandler` trivially safe and never let it do I/O that can fail.)
- "How do you handle errors in a stream or an event emitter inside a handler?" (`next` is out of scope by then — attach an `error` listener; an unhandled `error` event throws.)
- "How would you propagate a request ID through the chain for logging?" (Middleware assigns one to `req`, or `AsyncLocalStorage` for implicit propagation into services without threading it through every signature.)

## See also

- [event-loop-and-blocking.md](event-loop-and-blocking.md)
- `docs/guardrails.md` rules 1 and 2 — thin controllers, services own DB logic
