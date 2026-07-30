# Multi-Tenancy: Row-Level Scoping

> Three ways to isolate tenants in one system — shared rows, separate schemas, separate databases — and why a shared schema with a mandatory `org_id` predicate is the cheapest to operate and the easiest to get catastrophically wrong.

**Category:** Architecture
**Introduced by:** Phase 1 — the foundational data model
**Verified against:** PostgreSQL 16

---

## Mechanism

"Multi-tenant" means one deployment serving many independent customers who must never see each other's data. There are three standard isolation strategies, and the choice is a trade of operational cost against blast radius.

### 1. Shared schema, discriminator column (row-level)

Every table has an `org_id`; every query filters on it.

- **Isolation:** weakest — enforced by application code
- **Ops cost:** lowest — one schema, one migration run, one connection pool
- **Blast radius of a bug:** a single missing `WHERE` clause exposes every tenant
- **Scales to:** very many small tenants comfortably

### 2. Schema-per-tenant

Each tenant gets a Postgres schema; the app sets `search_path` per request.

- **Isolation:** medium — a missing predicate hits only the active schema
- **Ops cost:** high — migrations run N times and can partially fail, leaving tenants on different versions. Thousands of schemas bloat `pg_catalog` and slow planning. Connection pooling is awkward because `search_path` is session state, so a pooled connection carries the previous tenant's path unless reset every time — a leak vector by itself
- **Scales to:** tens to low hundreds of tenants

### 3. Database-per-tenant

- **Isolation:** strongest — a cross-tenant query is not expressible
- **Ops cost:** highest — N backups, N migrations, N connection pools against a fixed `max_connections` (default 100)
- **Scales to:** few large tenants; also the answer when a customer contractually requires physical separation or data residency

### Defence in depth: Postgres Row-Level Security

Row-level scoping's weakness is that correctness rests entirely on developers remembering a predicate. RLS moves enforcement into the database:

```sql
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON accounts
  USING (org_id = current_setting('app.current_org')::uuid);
```

The app then sets the variable per transaction:

```sql
SET LOCAL app.current_org = '...';   -- SET LOCAL, so it resets at COMMIT
```

Now a query that forgets `WHERE org_id = $1` returns zero rows instead of everyone's data — the failure mode flips from silent breach to visible bug.

Two caveats worth knowing, because interviewers probe them:

- **The table owner bypasses RLS** unless you use `FORCE ROW LEVEL SECURITY`. If your app connects as the owner, your policies do nothing. You need a separate, non-owner application role.
- **`SET LOCAL` is session state**, so it interacts with pooling exactly like `search_path` does. It must be set inside the transaction that uses it — which is fine with `pg`'s `pool.connect()`, and broken under PgBouncer in statement mode.

## Why we chose it here

AutoLedger uses **row-level scoping with `org_id`**, application-enforced.

| Option | Trade-off | Verdict |
|---|---|---|
| Row-level `org_id` | Cheapest ops, single migration path, one pool; correctness depends on discipline | **Chosen** |
| Schema-per-tenant | Better isolation, but N migration runs and `search_path`-vs-pooling hazards | Rejected — migration risk is worse than the predicate risk we can test for |
| Database-per-tenant | Strongest isolation; unworkable for many small businesses | Rejected — the target user is a small business, so tenant count is high and per-tenant revenue is low |
| Row-level + RLS | Row-level with a database-level backstop | **Worth adding later** — not in the roadmap yet; a genuine hardening opportunity |

Given the choice, the risk is one forgotten predicate. Three things contain it:

1. **`docs/guardrails.md` rule 1** — a query without an `org_id` predicate is a bug, not a style issue.
2. **`org_id` comes only from the verified access token** — never from a header, query param, or body. Reading it from the request is a *trivially forgeable* tenant boundary: the attacker just edits their own request.
3. **Every module needs a cross-tenant isolation test** — a user in org A attempting every endpoint against org B's row IDs. Without it, the module isn't done (`docs/testing.md`).

### Why `user_id` was the wrong boundary

The predecessor scoped everything by `user_id`, which cannot express the thing an ERP is *for*: a company where a warehouse clerk, an accountant, and an owner all act on the same purchase order with different permissions. Retrofitting would have meant creating `organizations`, adding a nullable `org_id` to every table, backfilling from `user_id`, making it `NOT NULL`, and rewriting every query and test — across a schema that was about to grow by fifteen modules. Doing it before the second table exists costs nothing; doing it after costs a migration per table.

The residual role for `user_id` is `created_by` — an audit field. Keeping it as an *access* check alongside `org_id` would be actively harmful: it would break the core requirement that a colleague can see the invoice you raised.

## Where it lives in this codebase

Nothing is built yet (Phase 1 pending). Planned:

- `server/src/db/migrations/001_organizations_and_users.sql` — `organizations`, `users`, `organization_members`
- `server/src/middleware/auth.ts` — resolves `{ id, orgId, role }` onto `req.user`
- `server/src/middleware/rbac.ts` — `requireRole(...)`
- `server/src/routes/auth.ts` — `POST /auth/switch-org`

Full model: `docs/architecture.md`. Table definitions: `docs/schema.md`.

## Gotchas

- **Any query missing `org_id`** is a cross-tenant read or write.
- **Trusting an ID from the request to imply ownership.** `GET /journals/:id` must filter `WHERE id = $1 AND org_id = $2`. Fetching by ID and *then* comparing `org_id` in JavaScript is a weaker pattern — it works, but it leaks existence through timing and is easy to forget, and it can't be enforced by a database policy later.
- **Reading the active org from a header or body.** Forgeable. Token only.
- **Org switching that doesn't re-validate membership.** `POST /auth/switch-org` must confirm the user is still in `organization_members` for that org *at switch time* — membership can be revoked while a session is live.
- **Uniqueness constraints that forget the tenant.** `UNIQUE (code)` on accounts would mean one org taking code `1000` blocks every other org. It must be `UNIQUE (org_id, code)`. This bug class is easy to ship and painful to migrate out of.
- **Indexes that omit the scope column.** Every hot query filters on `org_id`, so it belongs as the *leading* column of composite indexes — `(org_id, entry_date)`, not `(entry_date, org_id)`. A leading-column mismatch means the index can't be used for the equality-then-range access pattern.
- **Aggregate reports.** A trial balance summing across orgs is both a data breach and a wrong number. Report queries need the predicate as much as row reads do.

## Interview Q&A

**Q: What are the ways to implement multi-tenancy, and how would you choose?**
A: Shared schema with a tenant discriminator column, schema-per-tenant, or database-per-tenant. The axis is isolation strength versus operational cost. Row-level is cheapest to run — one migration path, one pool — but correctness lives in application code, so one missing predicate exposes everyone. Database-per-tenant makes cross-tenant access unexpressible but multiplies backups, migrations, and connections against a fixed `max_connections`. Schema-per-tenant sits in the middle and in my view is the worst of the three at scale, because migrations run N times and can leave tenants on different schema versions. I'd pick row-level for many small tenants, database-per-tenant when a customer contractually requires physical separation, and I'd reach for row-level plus Postgres RLS when I want the cheap option with a real backstop.

**Q: Row-level scoping depends on every developer remembering a `WHERE` clause. How do you make that safe?**
A: You don't rely on memory. Four layers. The scope comes from the verified token, never the request, so it can't be forged. Repository or service functions take `orgId` as a mandatory first argument, so omitting it is a type error rather than a silent default. Every module ships a cross-tenant isolation test that tries each endpoint with org A's credentials against org B's IDs. And for a real backstop, Postgres RLS with a policy on `current_setting`, so a forgotten predicate returns zero rows instead of everyone's — that converts a security breach into an obvious bug. On AutoLedger the first three are mandated; RLS is the hardening step I'd add next.

**Q: Why not scope by `user_id` if each account belongs to one person?**
A: Because it can't model the domain. An ERP's unit of ownership is a company, and multiple users with different roles act on the same purchase order or payroll run. `user_id` scoping means a warehouse clerk literally cannot see the PO the buyer raised. It's also a very expensive mistake to fix later — you're adding a column to every table, backfilling, and rewriting every query and test. The predecessor to this project made exactly that choice, and it was a significant part of why rebuilding was cheaper than retrofitting. The lesson I took is that the tenancy boundary is a foundational decision, not a feature — it goes in migration 001.

**Q: How does the active organization get resolved on each request, and why does the mechanism matter?**
A: It's a claim inside the signed access token. Auth middleware verifies the signature, reads the org ID and role, and attaches them to the request. Switching orgs is an explicit endpoint that re-checks membership and issues a new token. The reason it can't come from a header or a query param is that those are attacker-controlled — a tenant boundary you can change by editing your own request isn't a boundary. The subtle part is that re-validating at switch time matters too, because membership can be revoked while a session is live, and a 15-minute access token means a revoked user keeps the old org claim until it expires. That's the trade you accept with stateless tokens; if it's unacceptable you need a revocation check on each request.

**Q: What does a cross-tenant isolation test actually look like?**
A: Set up two orgs with real data. Authenticate as a user in org A. Then, for every endpoint, attempt it with org B's resource IDs — read, update, delete, and any list endpoint. Every one should return 404 or 403, and critically the *list* endpoints should return only org A's rows, which catches the aggregate-report case that per-row checks miss. I'd assert on 404 rather than 403 for reads by ID, because 403 confirms the resource exists and leaks information across the boundary. It has to be an integration test against a real database — a mocked pool will happily return whatever you told it to, so it proves nothing about the predicate.

**Q: Tell me about a time you had to make a foundational data-model decision.**
A: On AutoLedger I made org-level tenancy foundational rather than a later phase, and the reasoning was explicitly about cost of change. The prior version scoped by `user_id`, and the retrofit would have been a nullable column plus backfill plus `NOT NULL` plus a full query rewrite on every table — against a schema roadmapped to grow by fifteen modules. Doing it at migration 001 costs a day. Doing it at migration 40 costs a migration per table and a re-audit of every query. So the rule became: `org_id NOT NULL` on every domain table from creation, `user_id` demoted to a `created_by` audit field, and scope resolved only from the token. It's the clearest example I have of paying a small cost early to avoid a compounding one.

## Follow-ups they'll dig into

- "How do you handle a user who belongs to many orgs, in the UI?" (An org switcher backed by the switch-org endpoint; the client must clear cached queries on switch or it'll render org A's data under org B.)
- "What about noisy-neighbour problems — one huge tenant degrading others?" (Partitioning by `org_id`, per-tenant rate limits, or eventually promoting that tenant to its own database.)
- "How would you migrate a single tenant out to its own database later?" (`org_id` gives you a clean extraction predicate — arguably the strongest practical argument for row-level as a *starting* point.)
- "Does RLS hurt query performance?" (The policy becomes an extra predicate; if `org_id` leads your indexes it's usually free, but it can defeat some plan shapes and complicate partition pruning.)

## See also

- [../postgresql/transactions-isolation-pooling.md](../postgresql/transactions-isolation-pooling.md)
- `docs/architecture.md` — the tenancy model as implemented
- `docs/guardrails.md` rule 1
