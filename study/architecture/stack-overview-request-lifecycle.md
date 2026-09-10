# The Stack End to End — One Request's Life

> How React, TypeScript, Node, Express, and PostgreSQL fit together, traced through a single write: a user saving a journal entry.

**Category:** Architecture · Foundations
**Why this note exists:** "Walk me through your stack" and "what happens when a user clicks save" are near-certain interview questions. The answer that lands is a *trace*, not a list of technologies.

---

## The one-paragraph version

React renders the UI as a function of state in the browser and sends a `fetch` to the API. Express — running on Node, which uses one thread and non-blocking I/O — routes that request through a middleware chain that authenticates it and resolves the caller's organization, then hands plain data to a service. The service opens a PostgreSQL transaction and writes the entry and its lines atomically, with the database enforcing invariants that application bugs can't bypass. TypeScript is not a runtime participant at all: it type-checks both ends at build time against one shared definition of the payload, then compiles away.

That last sentence is the one that distinguishes a real answer from a memorised one.

## The trace

### 1. Browser — React

The user fills the journal entry form. Each keystroke calls a state setter; React schedules a re-render, re-invokes the component, diffs the returned element tree against the previous one, and commits the minimal DOM mutations. Client-side validation runs during render — debits must equal credits — so the Save button is disabled until the entry balances.

On submit, a `fetch` goes out with `credentials: 'include'` so the httpOnly auth cookie is attached. The payload is typed by a shared interface; TypeScript has already verified the object being sent matches it.

### 2. Network — cookies and CORS

The browser attaches the `accessToken` cookie. Because the API is on a different origin in development (`:5173` → `:5000`), this is a cross-origin credentialed request: the server must send `Access-Control-Allow-Origin` with the exact origin (not `*`) and `Access-Control-Allow-Credentials: true`, and a non-simple request triggers a preflight `OPTIONS` first.

The cookie is **httpOnly**, so JavaScript cannot read it — that's the defence against token theft via XSS. The trade is that cookies are sent automatically, which is what CSRF exploits, so `SameSite` matters.

### 3. Node — accepting the connection

The OS hands the socket to the Node process. libuv's event loop is in its poll phase; the socket becomes readable, and the registered callback is queued. Node parses the HTTP request into an `IncomingMessage` and invokes the registered handler — which is the Express `app`, since an Express app is just a function with the `(req, res)` signature.

**Nothing here occupies a thread while waiting.** The connection cost is a file descriptor and a closure, which is the entire reason Node suits an I/O-bound API.

### 4. Express — the middleware chain

Express walks its router stack in registration order:

| Layer | What it does |
|---|---|
| `cors` | Validates origin, sets the CORS headers |
| `cookieParser` | Parses `Cookie` into `req.cookies` |
| `express.json()` | Buffers and parses the body into `req.body` (100kb default limit) |
| `auth` | Verifies the JWT with `ACCESS_TOKEN_SECRET`, attaches `req.user = { id, orgId, role }` |
| `rbac` | Checks `req.user.role` against the route's requirement |
| controller | Validates shape, calls the service, formats the response |

Each layer shares the same `req`/`res` pair and decorates it — that's the whole middleware idea. Order is load-bearing: `rbac` reads what `auth` attached, so reversing them breaks it.

**Where the org scope comes from matters more than anything else on this path.** `orgId` is read from the signed token, never from a header or the body, because anything in the request is attacker-controlled. This is the tenant boundary.

### 5. Controller → service

The controller does three things and stops: pull `date`, `description`, `lines` off the body; call `journalService.createEntry(req.user.orgId, req.user.id, {...})`; respond `201`. No SQL, no business logic. The service receives plain data and has never heard of HTTP — which is why the same function can later be called from a BullMQ worker.

### 6. Service → PostgreSQL

The service converts amounts to integer cents, checks that debits equal credits with integer equality, then:

```
pool.connect()      → checks out one client = one connection = one Postgres backend process
  BEGIN
  INSERT journal_entries ...   (client)
  INSERT ledger_lines ...      (client)
  COMMIT
finally: client.release()
```

Every query uses `client`. A `pool.query` here would run on a *different* connection — a different session — and commit immediately, escaping the transaction silently and leaving lines that don't balance.

### 7. PostgreSQL — the write

The backend process parses, plans, and executes each statement. Row versions are written with the transaction's ID (MVCC), so nothing is overwritten in place and no reader is blocked.

The database independently enforces what the service already checked:

- `chk_exclusive_debit_credit` — a line can't have both sides populated
- `chk_line_nonzero` — a line can't be empty
- FK constraints — `account_id` must exist, `org_id` must be a real organization
- `UNIQUE (org_id, code)` — account codes are unique *per tenant*

On `COMMIT`, the WAL record is `fsync`ed to disk. **That** is the moment the entry is durable — the table pages get written later.

If anything fails, `ROLLBACK` unwinds every statement on that connection. There is no half-posted entry.

### 8. Back up the stack

Postgres returns the rows — with `BIGINT` cents arriving as **strings**, because a 64-bit integer can exceed JavaScript's exact-integer range. The service parses them deliberately. The controller sends `{ success: true, entry }`. Express serialises to JSON and writes to the socket; libuv flushes it.

In the browser, the promise resolves, React updates state, and reconciliation puts the new row in the table. If the request had failed, `errorHandler` — the 4-arity terminal middleware — would have formatted an `ApiError` into a status and a safe message, never leaking a raw Postgres error.

## Where each piece earns its place

| Layer | Job | Why this technology |
|---|---|---|
| **React** | UI as a function of state | Removes manual DOM synchronisation; ecosystem for forms and tables |
| **TypeScript** | Compile-time contracts on both sides | One payload definition checked at both ends; branded types make unit and tenant mix-ups compile errors |
| **Node** | Concurrent I/O | An idle connection costs an fd, not a thread — right for a DB-bound API |
| **Express** | Routing and middleware | Minimal, transparent; we supply the layering it doesn't |
| **PostgreSQL** | Source of truth | Transactions, constraints, and durability that application bugs can't bypass |

## The layering rule that ties it together

Each layer knows only about the one below, and the framework is confined to the edge:

```
React  →  routes  →  controller  →  service  →  pool  →  PostgreSQL
                     ↑ HTTP stops here
```

Controllers are the last place `req`/`res` appear; services take plain arguments. The test of whether the boundary is real: **could you call `journalService.createEntry` from a queue worker with no HTTP involved?** If yes, the layering holds. That's not architectural purity for its own sake — Phase 5 onward genuinely does call services from BullMQ workers, and Phase 9.5's document handling and Phase 15's deck generation depend on it.

## Interview Q&A

**Q: Walk me through your stack.**
A: React on the client renders UI as a function of state and talks to a REST API over `fetch`. The API is Express on Node — one thread, non-blocking I/O, which suits a workload that's almost entirely waiting on the database. Requests pass through a middleware chain that authenticates a JWT from an httpOnly cookie and resolves the caller's organization and role onto the request. Controllers are thin: validate, delegate, respond. All database access lives in services, which open explicit transactions against PostgreSQL, where the double-entry invariants are enforced by constraints as well as by application code. TypeScript spans both ends — one shared definition of each payload, checked at build time on the client and the server, then erased.

**Q: What happens when a user clicks save?**
A: *(the trace above — the key beats: React state → `fetch` with the cookie → CORS → libuv accepts the socket → Express middleware chain authenticates and resolves the org → controller delegates to a service → service converts to cents, validates balance, opens a transaction on one checked-out client → Postgres writes MVCC row versions and checks constraints → WAL fsync on commit → response back up, React re-renders.)*

**Q: Which layer is responsible for correctness?**
A: Deliberately more than one, because the failure modes differ. The client validates for fast feedback but is untrusted — a user can bypass it entirely. The service is the real gate: it converts to integer cents and rejects an unbalanced entry before touching the database. The database is the backstop, with CHECK and FK constraints that hold even if a service has a bug or someone writes a script against the DB directly. Belt and braces is the right posture for financial data: application validation gives good error messages, database constraints give guarantees.

**Q: Where does TypeScript run in production?**
A: Nowhere. It's compiled away — the emitted JavaScript has no type annotations and no runtime type information. That's the thing people get wrong: `strict` mode does nothing whatsoever for a malformed request body, because by then the types don't exist. So a typed API still needs runtime validation at every boundary where data enters — request bodies, database rows, environment variables — with something like `zod` or `ajv`.

**Q: If this got slow, where would you look first?**
A: I'd measure before guessing, but I'd look in a specific order. First the database, because it's a DB-bound app: `EXPLAIN ANALYZE` on the slow query, checking whether the plan uses the index and whether estimated rows diverge from actual. Then N+1 patterns — fetching entries and then querying lines per entry. Then event loop delay, because the signature of a blocked loop is that *every* endpoint slows simultaneously, including trivial ones, which distinguishes it from a slow dependency. Then connection pool saturation, since a leaked client permanently shrinks a pool of ten. Only after those would I look at React, and there the profiler tells you whether it's render work or waiting on the network.

**Q: What would you change about this stack?**
A: Three things, in order of conviction. Runtime request validation at the API boundary from day one rather than relying on TypeScript, which guarantees nothing at runtime — that's a genuine gap. Second, native `bcrypt` or `crypto.scrypt` instead of `bcryptjs`, which is pure JavaScript and so hashes on the main thread rather than the libuv thread pool. Third, I'd at least seriously weigh Fastify over Express, for schema-driven validation and serialisation and because it handles async errors natively, where Express 4 silently drops a rejection from an async handler.

## Follow-ups they'll dig into

- "How does the client know the token expired?" (A 401 triggers a refresh-and-retry against the refresh cookie; the retry must be single-flighted or a burst of parallel 401s causes a refresh stampede.)
- "What happens if the DB connection dies mid-transaction?" (The backend process is gone, so the transaction is aborted and rolled back — but the client sees a connection error, not a clean failure, so the caller can't assume which side of the commit it landed on. That's exactly what idempotency keys exist for.)
- "Where would you add caching, and what breaks?" (Read-heavy reports; invalidation on any write to the underlying accounts, and every cache key must include `org_id` or you serve one tenant's data to another.)
- "How do you keep the client and server types in sync?" (A shared package, or generate types from the OpenAPI spec. Duplicating an interface in two places is a drift waiting to happen.)

## See also

- [../node-express/nodejs-foundations.md](../node-express/nodejs-foundations.md)
- [../node-express/express-foundations.md](../node-express/express-foundations.md)
- [../postgresql/postgresql-foundations.md](../postgresql/postgresql-foundations.md)
- [../typescript/typescript-foundations.md](../typescript/typescript-foundations.md)
- [../react/react-foundations.md](../react/react-foundations.md)
- [multi-tenancy-row-level-scoping.md](multi-tenancy-row-level-scoping.md)
