# Recursive CTEs & Tree Hierarchies

> `WITH RECURSIVE` is iteration expressed in SQL — a working table that feeds itself until it stops producing rows — and it is the only way to walk an adjacency-list tree of unknown depth in one query.

**Category:** PostgreSQL
**Introduced by:** Phase 3 — the chart of accounts (`accounts.parent_id`), and the cycle check that guards re-parenting
**Verified against:** PostgreSQL 16

---

## Mechanism

### The evaluation model

`WITH RECURSIVE` is misleadingly named: there is no recursion, no stack. It is a fixed-point iteration over a working table.

```sql
WITH RECURSIVE ancestors AS (
  -- non-recursive term: the seed, evaluated once
  SELECT id, parent_id FROM accounts WHERE id = $1 AND org_id = $2
  UNION ALL
  -- recursive term: evaluated repeatedly against the previous result only
  SELECT a.id, a.parent_id
    FROM accounts a
    JOIN ancestors an ON a.id = an.parent_id AND a.org_id = $2
)
SELECT 1 FROM ancestors WHERE id = $3 LIMIT 1
```

What Postgres actually does:

1. Evaluate the **non-recursive term**. Put its rows in the result *and* in the working table.
2. Evaluate the **recursive term**, with `ancestors` bound to *the working table only* — not the whole accumulated result.
3. Append those rows to the result; they become the new working table.
4. Repeat from 2 until the recursive term returns **zero rows**.

Step 2 is the part people get wrong. `ancestors` inside the recursive term refers to the *previous iteration's output*, not everything found so far. That is why the query terminates and why it is efficient — each round only expands the frontier.

### `UNION` vs `UNION ALL`, and cycles

`UNION ALL` keeps duplicates and terminates only when the frontier empties. If the data contains a cycle — A's parent is B, B's parent is A — the frontier never empties and **the query runs forever**.

`UNION` deduplicates against the accumulated result, so a cycle terminates. It is slower (every row is compared) and it silently hides the cycle rather than reporting it.

The robust pattern carries the path and checks it:

```sql
WITH RECURSIVE walk AS (
  SELECT id, parent_id, ARRAY[id] AS path, false AS cycle
    FROM accounts WHERE id = $1
  UNION ALL
  SELECT a.id, a.parent_id, w.path || a.id, a.id = ANY(w.path)
    FROM accounts a JOIN walk w ON a.id = w.parent_id
   WHERE NOT w.cycle
)
SELECT * FROM walk;
```

PostgreSQL 14+ also has `CYCLE id SET is_cycle USING path`, which generates exactly this.

In LedgerCore the cycle question is asked *before* the write, so the walk is over data already known acyclic and `UNION ALL` is safe:

> Would setting X's parent to P create a cycle? Walk up from P. If X appears among P's ancestors, yes.

### The tenancy trap

Both terms need the `org_id` predicate:

```sql
JOIN ancestors an ON a.id = an.parent_id AND a.org_id = $2
                                          -- ^^^^^^^^^^^^^ load-bearing
```

Drop it from the recursive term and the walk climbs out of the tenant as soon as it reaches a row whose parent belongs to another organization. The seed being scoped is not enough — every iteration re-queries the base table.

### Adjacency list vs the alternatives

| Model | Read a subtree | Write / move | Notes |
|---|---|---|---|
| **Adjacency list** (`parent_id`) | Recursive CTE | One `UPDATE` | Simplest; needs a cycle check |
| Path enumeration (`'1000.1100.1110'`) | `LIKE 'prefix%'` | Rewrite every descendant | Fast reads, painful moves |
| Nested set (`lft`/`rgt`) | One range query | Renumber half the table | Read-optimised, write-hostile |
| Closure table | One join | N rows per node | Fast both ways, most storage |
| `ltree` extension | Operators + GiST index | Rewrite descendants | Postgres-specific, genuinely good |

A chart of accounts is tens of nodes, read constantly, restructured rarely, and small enough that the entire tree fits in one query. Adjacency list is the right shape; anything else is optimising a problem this does not have.

---

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Flat accounts, no hierarchy | Trivial | Rejected — real charts roll up, and reports need the rollup |
| **Adjacency list + recursive CTE for the cycle check** | One extra column; needs cycle guarding | **Chosen** |
| Closure table | Fast ancestor queries | Rejected — N² rows to maintain for a tree of ~44 nodes |
| `ltree` | Elegant, indexed | Rejected — an extension for a tree that fits in memory (rule 14) |
| Build the tree in TypeScript for *everything* | No SQL complexity | Rejected for the **write** path: the cycle check has to run inside the transaction that does the re-parent, or a concurrent write slips through |

**The split we actually landed on is the interesting part.** Reads build the tree in TypeScript — `listAccountTree` fetches the flat list, already indexed and ordered by code, and assembles it in one pass over a `Map`. Writes use the recursive CTE. The reasoning: for reads the whole tree is coming back anyway, so a second query buys nothing; for writes the check must be atomic with the update, and doing it in the database is what makes that true.

---

## Where it lives in this codebase

- `server/src/services/ledger-core/accountService.ts` — `wouldCreateCycle()` (the recursive CTE), and `listAccountTree()` (the `Map`-based assembly)
- `server/src/db/migrations/002_ledger-core_accounts.sql` — `parent_id` self-FK with `ON DELETE RESTRICT`, `chk_account_not_own_parent`, and `idx_accounts_parent_id` so the join has an index
- `server/src/__tests__/ledger-core/accounts.test.ts` — re-parenting an account under its own descendant returns 422

---

## Gotchas

- **`UNION ALL` on cyclic data loops forever.** Use `UNION`, or carry a path array, or guarantee acyclicity on write.
- **The recursive term sees the previous iteration only**, not the full accumulated result. Queries written assuming otherwise are subtly wrong.
- **Scope every term.** An `org_id` predicate on the seed alone lets the walk escape the tenant.
- **A CHECK constraint cannot prevent a cycle** — it sees one row. `parent_id <> id` catches only the trivial self-parent case; the real check is the walk.
- **`ON DELETE CASCADE` on a self-FK is a foot-gun.** Deleting a parent silently deletes the whole subtree. `RESTRICT` forces the caller to be explicit.
- **A child must match its parent's type and organization.** Neither is expressible as a single-row CHECK; both are service checks with tests.
- **Index the FK.** The recursive join hits `parent_id` on every iteration.

---

## Interview Q&A

**Q: How does `WITH RECURSIVE` actually execute?**
A: It isn't recursion — there's no stack. It's fixed-point iteration over a working table. The non-recursive term runs once and seeds both the result and the working table. Then the recursive term runs repeatedly, but the CTE name inside it refers only to the *previous* iteration's rows, not everything accumulated. Each round's output becomes the next working table, and it stops when an iteration produces zero rows. That "previous iteration only" detail is the key one: it's what makes the thing terminate and what makes it efficient, because each round only expands the frontier rather than rescanning everything found so far.

**Q: How do you stop a recursive CTE looping forever?**
A: A cycle in the data with `UNION ALL` never empties the frontier, so it runs until something kills it. Three options. `UNION` instead of `UNION ALL` deduplicates against the accumulated result so a cycle terminates — but it's slower and it hides the cycle rather than reporting it. Carrying a path array and stopping when a node reappears is the explicit version, and PostgreSQL 14+ generates it for you with the `CYCLE` clause. Best of all is preventing cycles on write, which is what I did: before accepting a re-parent, walk up from the proposed parent and reject if the account being moved is among its ancestors. Then the read path is walking data that's known acyclic.

**Q: Why an adjacency list rather than a closure table or nested sets?**
A: Scale and write pattern. A chart of accounts is a few dozen nodes, read constantly and restructured rarely. Adjacency list is one nullable column and a move is one `UPDATE`. A closure table gives O(1) ancestor lookups but stores a row per ancestor-descendant pair and has to be maintained transactionally on every move — that's a lot of machinery for 44 rows. Nested sets make reads a single range query but a single insert renumbers half the table. I'd reach for a closure table if the tree were large, deep, and queried for ancestry constantly — an org chart with permission inheritance, say.

**Q: Tell me about a bug this pattern nearly caused.**
A: The tenancy predicate in the recursive term. My first instinct was to scope the seed — `WHERE id = $1 AND org_id = $2` — and leave the recursive join as `JOIN ancestors ON a.id = an.parent_id`. That looks fine, because the walk starts inside the right tenant. But the recursive term re-queries the base table every iteration, so the moment it reached a row whose parent belonged to another organization it would happily climb into that tenant's tree. Scoping the seed is not scoping the query. I now read every term of a recursive CTE as a separate query that needs its own predicate.

---

## Follow-ups they'll dig into

- *"How would you compute a rollup balance for a header account?"* Recursive CTE to collect the subtree, then aggregate ledger lines over those account ids — or in this codebase, derive it from the flat list already in memory.
- *"What if the tree were 100,000 nodes?"* Materialize the paths, or move to `ltree` with a GiST index, and stop shipping the whole tree to the client.
- *"How do you order a tree in SQL?"* Carry a sort path array and `ORDER BY` it; the codebase sidesteps this by ordering by account code, which is designed to sort hierarchically.
- *"What's the difference between a CTE and a subquery?"* Since PostgreSQL 12, a non-recursive CTE is inlined by default and behaves like a subquery unless you write `MATERIALIZED`. A recursive CTE is always materialized.

---

## See also

- [postgresql-foundations.md](postgresql-foundations.md)
- [deferred-constraint-triggers.md](deferred-constraint-triggers.md) — the other rule a single-row CHECK cannot express
- [double-entry-as-an-invariant.md](../architecture/double-entry-as-an-invariant.md) — what the chart of accounts is for
