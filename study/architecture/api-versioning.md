# API Versioning & the Express Router Mount

> `/api/v1` is one string in one file — and the mechanism that makes that possible is Express rewriting `req.url` as a request descends through mounted routers.

**Category:** Architecture
**Introduced by:** Phase 0 — `server/src/config/constants.ts`, `app.ts`, `routes/index.ts`
**Verified against:** Express 5.2.1

---

## Mechanism

### How mounting actually works

A `Router` is not special — it is a middleware function with its own ordered stack of layers. `app.use('/api/v1', apiRouter)` pushes a layer whose path pattern is `/api/v1` and whose handler is that router.

When a request for `/api/v1/health` arrives, Express walks the app's layer stack and finds this layer matches by prefix. Before invoking the router it **rewrites the request's view of the path**:

- `req.url` becomes `/health` — the matched prefix is stripped
- `req.baseUrl` becomes `/api/v1` — where the strip happened
- `req.originalUrl` stays `/api/v1/health`, untouched for the whole request

The router then matches `/health` against *its* stack, finds `apiRouter.use('/health', healthRoutes)`, strips again (`req.url` → `/`, `req.baseUrl` → `/api/v1/health`), and the leaf `router.get('/')` matches. On the way back out, Express restores the previous `req.url` and `req.baseUrl` for each layer it unwinds.

Three consequences fall out of that one mechanism:

1. **A route file never knows where it is mounted.** `routes/health.ts` declares `router.get('/')`. It would work identically at `/api/v2/health` or `/internal/health`. That is what makes the prefix relocatable in one place.
2. **`req.originalUrl` is the only correct thing to log or report.** Our 404 handler uses it — `req.url` there would say `/does-not-exist`, silently dropping the prefix from the message.
3. **Nesting is composition, not configuration.** A second version is a second router beside the first, sharing leaf routers where behaviour is unchanged.

### Where the version string lives

```ts
// config/constants.ts
export const API_VERSION = 'v1';
export const API_BASE_PATH = `/api/${API_VERSION}`;

// app.ts
app.use(API_BASE_PATH, apiRouter);
```

One declaration, one application. Nothing else in the codebase writes `/api/v1` — controllers don't, and route files can't, because they only ever see relative paths.

It lives in `config/constants.ts` rather than in `routes/index.ts` for a concrete reason: `healthController` reports `apiVersion` in its response body. Importing that constant from the router would make controllers and routes circularly dependent (`routes/index` → `routes/health` → `healthController` → `routes/index`). ESM tolerates the cycle, but a `const` read during module evaluation of a cyclic graph can land in the temporal dead zone and throw — a genuinely confusing failure. A leaf module with no imports of its own cannot participate in a cycle.

### The three ways to version, and what each costs

**URI path** — `/api/v1/journals`.
Visible in every log line, curl command and browser address bar. Cacheable by default, because the URL *is* the cache key: two versions are two resources and no proxy needs to understand a header. The purist objection is real — REST says a URI identifies a resource, and journal entry #5 is the same entity under v1 and v2, so encoding a representation version in its identity is a category error.

**Custom header** — `X-API-Version: 1`.
Keeps URIs clean. Costs you discoverability (you cannot paste a URL and get v2) and cache correctness: any intermediary must be told to `Vary` on that header, and one that isn't will serve a v1 response to a v2 client. Debugging becomes "what headers did that client send," which nobody has in their logs.

**Content negotiation** — `Accept: application/vnd.autoledger.v2+json`.
The most theoretically correct: the URI identifies the resource, `Accept` selects the representation, and HTTP already has machinery for exactly this. Also the least ergonomic — hostile to hand-testing, and clients get it wrong.

### What versioning does *not* solve

The database has no version. `/api/v1/journals` and `/api/v2/journals` read the same rows, so v2 can change field names, response shape, or pagination — but it cannot change what a journal entry *is*. A genuine domain change is a migration plus a compatibility layer, and the version prefix is where that layer is exposed, not what implements it.

This is why **additive change is the default and versioning is the exception**. Adding a field is not breaking; a client that ignores unknown keys is unaffected. Removing a field, renaming one, tightening validation, or changing a status code *is* breaking. Most APIs that ship v2 in year one did so because they treated an additive change as breaking.

For this project, the honest expectation is that `v2` never ships. The prefix exists because retrofitting one onto a live API means touching every route file and every client call site at the worst possible moment — it is cheap insurance bought before there is anything to insure.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| No version prefix | Least ceremony now; a painful retrofit across every route and client later | Rejected |
| URI path `/api/v1` | Visible, cacheable, trivially testable with curl; not REST-pure | **Chosen** |
| Custom header | Clean URIs; invisible in logs, needs `Vary`, awkward to test | Rejected |
| `Accept` media type | Most correct; worst ergonomics, clients get it wrong | Rejected |

Deciding factor: an ERP's integration clients are other people's scripts and finance tools. "Change the URL" is a change a client's developer can make in a minute and verify with curl. "Change your `Accept` header to a vendor media type" is a support ticket. Debuggability of a boundary other organisations depend on outweighs REST purity.

Documented in [api.md](../../docs/api.md): all routes prefixed `/api/v1/`, modules mount at `/api/v1/<module>`.

## Where it lives in this codebase

- `server/src/config/constants.ts` — `API_VERSION`, `API_BASE_PATH`; the single source of truth
- `server/src/app.ts` — the one `app.use(API_BASE_PATH, apiRouter)`
- `server/src/routes/index.ts` — the shared `apiRouter`; every module adds one `apiRouter.use()` line here
- `server/src/routes/health.ts` — a leaf router, path-relative, unaware of its mount point
- `server/src/middleware/errorHandler.ts` — `notFoundHandler` uses `req.originalUrl`
- `server/src/__tests__/app.test.ts` — asserts `/health` (unversioned) 404s, so nothing is reachable outside the prefix

## Gotchas

- **`req.url` inside a mounted router is not the URL the client asked for.** It's been stripped. Use `req.originalUrl` for logging, error messages and audit records. A 404 message built from `req.url` is actively misleading.
- **Building links from `req.baseUrl` couples a route to its mount point.** For a `Location` header, use `req.originalUrl` or construct from `API_BASE_PATH`.
- **Order still decides everything.** `notFoundHandler` must be registered after all routers, and `errorHandler` after that. Mount a router *after* the 404 handler and its routes are unreachable — with no error, because the 404 handler legitimately matched first.
- **Express 5 changed path-pattern syntax.** Wildcards must be named (`/*splat`, not the bare `/*` that worked in Express 4), and optional-character syntax like `/:id?` is gone in favour of `{/:id}`. A copy-pasted Express 4 route with a bare `*` throws at startup in Express 5.
- **Versioning the URL doesn't version the schema.** A v2 that needs a genuinely different data model needs a migration, not a prefix.
- **Health checks live outside auth, and should stay outside the version too if an ops team consumes them.** We chose `/api/v1/health` for consistency; a `/health` at the root, unversioned and never breaking, is the defensible alternative, and our test asserts we deliberately did *not* do that.

## Interview Q&A

**Q: How does Express know which router handles a request, and what does it do to the request on the way?**
A: A router is middleware with its own ordered layer stack. `app.use('/api/v1', router)` registers a layer that matches by prefix. When it matches, Express strips the matched prefix from `req.url` and records it in `req.baseUrl`, then hands off to the router, which matches against the remainder. `req.originalUrl` is preserved unchanged throughout, and Express restores the previous values as it unwinds. That rewriting is precisely why a route file can declare `router.get('/')` and not care where it's mounted.

**Q: Where would you put the API version, and why?**
A: In the URI path — `/api/v1/…`. It's visible in logs and curl, and it's cacheable without any intermediary needing to understand a custom header, because the URL is the cache key. The counterargument is that it's not REST-pure: a URI should identify a resource, and journal entry #5 is the same entity in v1 and v2, so a version in the path conflates identity with representation. I take that trade knowingly. For an ERP whose clients are other teams' scripts, being able to say "change the URL and re-run your curl" beats "set a vendor media type in your Accept header."

**Q: What actually counts as a breaking change?**
A: Removing or renaming a field, tightening validation, changing a status code or an error shape, changing pagination defaults, or changing the meaning of an existing field. *Adding* a field is not breaking, provided clients ignore unknown keys. That distinction matters because most APIs that ship a v2 in their first year did so for a change that was additive all along, and then carry two versions forever. The default should be additive evolution; a version bump is the last resort.

**Q: You need to version — how do you run two versions without duplicating everything?**
A: Version at the boundary, not in the core. `v2` is a second router that shares the same services; only the controllers differ, because the change is in serialization or request shape, not in what a journal entry is. If the *domain* changed, that's a migration plus a compatibility layer that maps old requests onto the new model, and the v1 router becomes an adapter. What you never do is fork the service layer, because then a fix to the double-entry balance check has to land twice — and one of those copies will be missed.

**Q: When would you not add a version prefix at all?**
A: When you control every client — an internal service, or a frontend deployed atomically with its backend. Then a breaking change is one coordinated deploy and the prefix is dead weight. We added one because an ERP's integration surface is other organisations' scripts, and by the time you *need* a version you can no longer add one cheaply: retrofitting means touching every route file and every existing client at the exact moment you're already making a breaking change.

**Q: Tell me about a design decision you made on this that wasn't obvious.**
A: Where to put the version constant. It started in `routes/index.ts`, which reads naturally — the router owns the prefix. But the health controller reports the API version in its response body, so importing it there created a cycle: `routes/index` → `routes/health` → `healthController` → `routes/index`. ESM permits cycles, but a `const` read during evaluation of a cyclic graph can hit the temporal dead zone and throw a confusing `ReferenceError`. I moved it to `config/constants.ts` — a leaf module with no imports, which structurally cannot be part of a cycle. The general rule I took from it: shared constants belong in a module that imports nothing.

## Follow-ups they'll dig into

- "How do you deprecate v1?" — `Deprecation` and `Sunset` headers (RFC 8594), per-version usage metrics so you know who's still on it, a dated end-of-life, then removal. Not "we'll turn it off when nobody's using it," because you'll never be able to prove that.
- "Where does the version live if you add an API gateway?" — the gateway can route by prefix to different deployments, which lets you retire v1 as a whole service rather than as code inside one. That's the payoff for versioning at the boundary.
- "How do clients discover what changed?" — a changelog per version, and machine-readable schemas (OpenAPI) so a client can diff. Not built here.
- "Why is `/health` inside the version?" — consistency, and it's a defensible-either-way call: an ops-consumed probe arguably belongs at an unversioned root so it can never break.
- "What breaks if you mount a router after the 404 handler?" — its routes become unreachable, silently, because the 404 handler matched first and legitimately terminated the chain.

## See also

- [../node-express/express-middleware-and-async-errors.md](../node-express/express-middleware-and-async-errors.md) — the layer stack and `next()` closure this builds on
- [../node-express/express-foundations.md](../node-express/express-foundations.md) — the router as an ordered layer stack
- [stack-overview-request-lifecycle.md](stack-overview-request-lifecycle.md) — the full path a request takes
