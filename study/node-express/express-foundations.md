# Express — Foundations

> A thin routing and middleware layer over Node's `http` module that imposes almost no structure — which is simultaneously why it won and why every Express codebase needs an architecture the framework doesn't supply.

**Category:** Node/Express · Foundations
**Verified against:** Express 4.19 (differences in Express 5 flagged)

---

## What it is

A minimal, unopinionated web framework for Node, released 2010, inspired by Sinatra. It provides three things and deliberately not much else:

1. **Routing** — map method + path patterns to handlers
2. **Middleware** — a composable pipeline of functions sharing one request/response pair
3. **Convenience helpers** on `req`/`res` — `res.json()`, `req.params`, `res.status()`, content negotiation

It does **not** provide: an ORM, request validation, dependency injection, a project structure, authentication, or a testing framework. Everything beyond routing is a package you choose.

For scale: without Express you'd write `http.createServer((req, res) => ...)` and hand-parse `req.url`, hand-route, hand-parse bodies, and hand-manage headers. Express is that boilerplate, generalised.

## How it works

### It wraps `http`, it doesn't replace it

`app` is a function with the signature `(req, res)` — the exact shape `http.createServer` wants. `app.listen()` is a one-line convenience that creates an `http.Server` and passes `app` as its handler. So Express is a *request handler*, not a server, which is why the same app object can be mounted under another app or handed to a test harness without a real socket.

`req` and `res` are Node's own `IncomingMessage` and `ServerResponse`, with Express's helpers added via prototype extension. That's why `res.socket` and `req.headers` are still there — you never lose access to the underlying objects.

### The router is an ordered stack of layers

`app.use()` and `app.get()` push a **Layer** onto the router's stack. Each layer holds a compiled path pattern and a handler. On each request Express walks the stack from index 0; for every layer whose pattern matches, it calls the handler with `(req, res, next)`.

`next` is a closure over the current position. Nothing is automatic:

- Neither respond nor call `next()` → **the request hangs** until the client times out.
- Respond *and* call `next()` → `ERR_HTTP_HEADERS_SENT` when something downstream writes.
- Order is registration order, always.

Because `req` and `res` are the same objects across the whole chain, middleware composes by **decorating** them — `express.json()` sets `req.body`, `cookieParser()` sets `req.cookies`, our auth middleware sets `req.user`. This is the framework's central idea, and the reason middleware is so reusable.

### Error handling is detected by arity

`next(err)` with a truthy argument switches the walk into error mode: Express skips normal layers and looks for a handler declared with **four** parameters, checked via `fn.length`. Consequences: error middleware must be registered *after* routes, and a default or rest parameter changes `length` and silently breaks detection.

### The Express 4 async gap

Express 4 predates promises and ignores a handler's return value, so a `throw` inside an `async` handler never reaches your error middleware — it becomes an unhandled rejection that terminates the process on modern Node, while the client hangs. Express 5 forwards rejected returned promises to `next()`; on 4 you need a wrapper. Full treatment: [express-middleware-and-async-errors.md](express-middleware-and-async-errors.md).

### Routers compose

`express.Router()` creates a mini-app with its own stack, mountable at a path prefix. This is the mechanism behind our module layout — each module gets a router, mounted at `/api/v1/<module>`, so route definitions stay next to the module they serve rather than in one growing file.

## What it does best, and how

**Getting out of the way.** The mechanism is that the middleware signature `(req, res, next)` is the entire contract. There's no plugin lifecycle, no DI container, no decorator metadata — so any function matching that shape composes with anything else, and you can read the full request path top to bottom. When something misbehaves you can follow it without understanding a framework's internals. For a long-lived codebase with a small team, that transparency has real value.

**Ecosystem reach.** Because the contract is so small, the middleware ecosystem is enormous and mostly interoperable — `helmet`, `cors`, `morgan`, `express-rate-limit`, Passport's several hundred auth strategies. Fifteen years of Stack Overflow answers assume Express, which genuinely lowers the cost of unusual problems.

**Incremental adoption and mounting.** An Express app *is* a request handler, so it mounts inside another app, sits behind a proxy, or runs in a serverless adapter unchanged.

## Where it's weak

- **It imposes no architecture.** Express will happily let you put SQL in a route handler. Our layered controller/service split and `docs/guardrails.md` exist precisely because the framework won't enforce them.
- **Async error handling is broken in v4** (above).
- **No built-in validation or serialisation.** Bring `zod`/`joi`/`ajv`. By contrast Fastify treats JSON Schema as a first-class input *and* uses it to compile a fast serialiser.
- **Types are bolted on.** `@types/express` is community-maintained, and typing `req.user` requires declaration merging rather than being a first-class generic.
- **Slower than modern alternatives.** Fastify's benchmark lead comes mostly from schema-compiled JSON serialisation and a more efficient router. In a database-bound API this rarely dominates, but it's real.
- **Maintenance cadence.** Express 4 was the de facto standard for a decade with slow releases; Express 5 took years to land.

## Why we chose it for AutoLedger

| Option | Trade-off | Verdict |
|---|---|---|
| **Express 4** | Ubiquitous, transparent, vast middleware ecosystem; no structure, async-error gap, slower | **Chosen** — we supply the structure via guardrails |
| Fastify | Faster, schema-first validation and serialisation, native async errors, first-class TS | Genuinely defensible; rejected for ecosystem familiarity |
| NestJS | Batteries-included: DI, modules, decorators — real structure for a 15-module ERP | Rejected: heavy abstraction, steeper onboarding, and it hides the seams we want visible |
| Koa | Cleaner async middleware via composition | Smaller ecosystem |
| Bare `http` | Zero dependencies, total control | Reinventing routing and body parsing |

The honest assessment: **NestJS is arguably the better fit for a fifteen-module ERP**, since dependency injection and module boundaries are exactly what large domains need, and it solves the structure problem the framework way instead of the documentation way. We chose Express with explicit hand-written layering because the seams stay visible and there's no framework magic to debug — but that's a preference, not a slam dunk, and it puts the burden of consistency on review discipline. Fastify's schema-first validation is the other thing genuinely worth wanting.

## Vocabulary that shows up in interviews

**middleware** · **the middleware chain / pipeline** · **`next()`** · **layer** · **router / mounting** · **error-handling middleware (4-arity)** · **route parameters vs query vs body** · **`app` as a request handler** · **unopinionated**

## Interview Q&A

**Q: What is Express, and what does it actually add over Node's `http` module?**
A: Routing, a middleware pipeline, and helpers on the request and response objects. It doesn't replace `http` — an Express app is literally a function with the `(req, res)` signature that `http.createServer` accepts, and `req`/`res` are Node's own objects with methods added to their prototypes. So Express is the boilerplate you'd otherwise write by hand — URL matching, body parsing wiring, header and status helpers — generalised into a composable pipeline.

**Q: What is middleware, conceptually?**
A: A function receiving the request, the response, and a `next` callback, which either responds or passes control along. The key insight is that all middleware shares the *same* `req` and `res` objects, so they compose by decoration — body parsers attach `req.body`, auth attaches `req.user`, loggers read what earlier layers set. Because the contract is just that three-argument shape, any function matching it plugs into any Express app, which is why the ecosystem is so large.

**Q: Express is "unopinionated." Is that good?**
A: It's a trade, and which side you want depends on the project. The upside is transparency — no hidden lifecycle, no DI container, you can trace a request end to end. The downside is that the framework won't stop you putting SQL in a route handler, so consistency depends entirely on convention and review. On AutoLedger we compensate with written guardrails: controllers are thin adapters, all database access lives in services. Honestly, for a fifteen-module ERP something like NestJS — which enforces module boundaries and injection structurally — is a legitimate alternative. We chose to keep the seams visible and pay for it in review discipline.

**Q: How would you structure a large Express application?**
A: Layer-first, with the framework confined to the outermost layer. Routes declare paths and attach middleware. Controllers do nothing but validate input, call a service, and shape the response — no SQL, no business logic. Services own all data access and take plain arguments, never `req`/`res`, so they're testable without HTTP and reusable from a queue worker. One `express.Router()` per module, mounted under a versioned prefix. The test of whether you've got it right: if you had to swap Express for Fastify, only the routes and controllers should change.

**Q: Where does Express fall short, and what would you reach for instead?**
A: Three things. Async error handling is broken in v4 — a throw in an `async` handler doesn't reach the error middleware — so you need a wrapper or v5. There's no built-in validation or schema-driven serialisation, which is Fastify's strongest argument: it uses JSON Schema for both input validation and compiling a fast serialiser, and that's most of its benchmark advantage. And TypeScript support is community types plus declaration merging rather than first-class. If I were starting fresh with no ecosystem constraint, Fastify would be my default; Express earns its place on ubiquity and the sheer depth of available answers.

**Q: How do you test an Express app?**
A: The layers make this easy if you've kept them clean. Services get unit-tested directly with plain arguments and no HTTP involved. Controllers can be tested with mock `req`/`res` objects, though there's usually little logic left in them worth testing. For the HTTP surface, `supertest` drives the app object without binding a real port — because `app` is just a request handler — which gives you real routing, real middleware ordering, and real status codes. That last part matters: middleware ordering bugs, like RBAC running before authentication, only surface when the actual chain executes.

## Follow-ups they'll dig into

- "How does `express.static` work, and why put it behind a CDN?" (Reads from disk per request through the event loop; a CDN or nginx does it without touching Node.)
- "What does `app.set('trust proxy')` change?" (How `req.ip` and `req.protocol` are derived from `X-Forwarded-*` — get it wrong and rate limiting keys on the proxy's IP.)
- "Difference between `app.use` and `app.all`?" (`use` matches path prefixes and ignores method; `all` matches the exact route pattern for every method.)
- "How do route parameters get parsed, and what's the risk with wildcards?" (Path patterns compiled to regexes; over-broad patterns can shadow later routes, and complex ones raise ReDoS concerns.)

## See also

- [express-middleware-and-async-errors.md](express-middleware-and-async-errors.md) — the deep dive
- [nodejs-foundations.md](nodejs-foundations.md)
- `docs/guardrails.md` rules 1–2 — the structure Express doesn't give us
