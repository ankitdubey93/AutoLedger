# Recursive CTEs & Tree Hierarchies

> `WITH RECURSIVE` is iteration expressed in SQL — a working table that feeds itself until it stops producing rows — and it is the only way to walk an adjacency-list tree of unknown depth in one query.

**Category:** PostgreSQL
**Introduced by:** Phase 3 — the chart of accounts (`accounts.parent_id`), and the cycle check that guards re-parenting. Extended by Phase 3.6 — `accountLedgerService.accountBalances`, which walks the same tree in the opposite direction to roll a header account's balance up from its subtree.
**Verified against:** PostgreSQL 16.14

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

### Subtree rollups — walking down instead of up

`wouldCreateCycle` walks **up**: from a candidate parent, follow `parent_id` toward the root, asking "is the node I'm about to move among these ancestors?" `accountBalances` needs the mirror-image walk — **down**, from every account to its entire set of descendants — because a header account like `6000 Operating Expenses` has no ledger postings of its own; its balance is the sum of every leaf beneath it.

```sql
WITH RECURSIVE subtree AS (
  -- anchor: every account is its own first "descendant" — id, id
  SELECT a.id AS ancestor_id, a.id AS descendant_id
    FROM accounts a
   WHERE a.org_id = $1
  UNION ALL
  SELECT s.ancestor_id, c.id
    FROM subtree s
    JOIN accounts c
      ON c.parent_id = s.descendant_id
     AND c.org_id = $1
)
SELECT ancestor_id, descendant_id FROM subtree;
```

The anchor term is the detail worth pausing on: `SELECT a.id AS ancestor_id, a.id AS descendant_id` pairs every account with *itself* before the recursion adds anything. Without that self-pair, a leaf account with no children would produce **zero** rows in `subtree` for itself — it has no descendants under `c.parent_id = s.descendant_id` — and its own balance would silently vanish from what should be a rollup that includes it. With the self-pair, every account starts as a one-row "subtree" (itself), and the recursive term only ever *adds* rows for accounts that actually have children. This is the same idea as `own AS (id, id)` at the anchor of `wouldCreateCycle` conceptually, but there the ancestors-walk anchor is a single row for the *starting* node; here it has to be a self-pair for **every** node simultaneously, because the query computes the rollup for the whole chart in one pass rather than for one account at a time.

`subtree` is a **transitive closure**: one `(ancestor_id, descendant_id)` row for every pair where `descendant_id` is reachable from `ancestor_id` by following `parent_id` downward, including the trivial `(x, x)` pair. Joining it back against a per-account aggregate (`own`, computed separately) and grouping by `ancestor_id` turns "sum every descendant's own balance" into an ordinary join-and-`SUM`:

```sql
SELECT a.id, SUM(own.debit_cents) AS rollup_debit_cents, ...
  FROM accounts a
  JOIN subtree s ON s.ancestor_id = a.id
  JOIN own       ON own.id = s.descendant_id
 GROUP BY a.id
```

For a leaf, `subtree` contains only its own self-pair, so its rollup equals its own balance — exactly the invariant `accountLedger.test.ts` and `accounts.test.ts` both assert (`rollupBalanceCents === ownBalanceCents` for a leaf, `SEEDED_TOTAL` accounts every one of which appears in the output regardless of postings).

**The recursive term still needs the tenancy predicate**, for the identical reason the ancestor walk does: `c.org_id = $1` alongside `c.parent_id = s.descendant_id`. Drop it and a corrupted or maliciously-crafted `parent_id` pointing across a tenant boundary — which nothing else in this schema prevents at the column level — would let the rollup walk into another organization's accounts.

**No cycle guard is needed here**, and that absence is itself worth explaining rather than assuming: this query is safe from infinite recursion only because `wouldCreateCycle` already refused, at write time, any `parent_id` update that would introduce one. The read side inherits acyclicity from a write-side guarantee; it does not re-derive it. A defensive read-side `UNION` or path-array cycle check would be redundant *given that guarantee holds*, but would be the correct addition the moment any code path could write a `parent_id` without going through `accountService.updateAccount`.

---

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Flat accounts, no hierarchy | Trivial | Rejected — real charts roll up, and reports need the rollup |
| **Adjacency list + recursive CTE for the cycle check** | One extra column; needs cycle guarding | **Chosen** |
| Closure table | Fast ancestor queries | Rejected — N² rows to maintain for a tree of ~44 nodes |
| `ltree` | Elegant, indexed | Rejected — an extension for a tree that fits in memory (rule 14) |
| Build the tree in TypeScript for *everything* | No SQL complexity | Rejected for the **write** path: the cycle check has to run inside the transaction that does the re-parent, or a concurrent write slips through |
| Recurse over the already-fetched flat chart in TypeScript, for the balance rollup too | Viable at 44 accounts; no second SQL shape to reason about | Rejected — the balance figures already come from an aggregate query over `ledger_lines`; computing the rollup in SQL keeps one aggregation, in one language, rather than splitting the same computation across a database query and application code where the two can drift apart |

**The split we actually landed on is the interesting part.** Reads build the tree in TypeScript — `listAccountTree` fetches the flat list, already indexed and ordered by code, and assembles it in one pass over a `Map`. Writes use the recursive CTE. The reasoning: for reads the whole tree is coming back anyway, so a second query buys nothing; for writes the check must be atomic with the update, and doing it in the database is what makes that true.

---

## Where it lives in this codebase

- `server/src/services/ledger-core/accountService.ts` — `wouldCreateCycle()` (the recursive CTE), and `listAccountTree()` (the `Map`-based assembly)
- `server/src/db/migrations/002_ledger-core_accounts.sql` — `parent_id` self-FK with `ON DELETE RESTRICT`, `chk_account_not_own_parent`, and `idx_accounts_parent_id` so the join has an index
- `server/src/__tests__/ledger-core/accounts.test.ts` — re-parenting an account under its own descendant returns 422; `describe('account balances')` for the rollup query
- `server/src/services/ledger-core/accountLedgerService.ts` — `accountBalances()`, the descendant-walking `subtree` CTE and its `(id, id)` self-pair anchor

---

## Gotchas

- **`UNION ALL` on cyclic data loops forever.** Use `UNION`, or carry a path array, or guarantee acyclicity on write.
- **The recursive term sees the previous iteration only**, not the full accumulated result. Queries written assuming otherwise are subtly wrong.
- **Scope every term.** An `org_id` predicate on the seed alone lets the walk escape the tenant.
- **A CHECK constraint cannot prevent a cycle** — it sees one row. `parent_id <> id` catches only the trivial self-parent case; the real check is the walk.
- **`ON DELETE CASCADE` on a self-FK is a foot-gun.** Deleting a parent silently deletes the whole subtree. `RESTRICT` forces the caller to be explicit.
- **A child must match its parent's type and organization.** Neither is expressible as a single-row CHECK; both are service checks with tests.
- **Index the FK.** The recursive join hits `parent_id` on every iteration.
- **A descendant-walking anchor without a self-pair silently drops leaf nodes from their own rollup.** `SELECT id, id` at the anchor (not just `SELECT id, parent_id` or similar) is what makes every account — including one with no children — appear as its own one-row subtree before the recursive term adds anything.
- **A read-side recursive query can safely skip its own cycle guard only when a write-side guarantee already makes the data acyclic** — and that's a fact about the *system*, not about the query. If any code path could ever write a `parent_id` without going through the guarded update, the read-side query would need its own defense too.

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

**Q: You just told me how to walk *up* a tree to check for cycles. How would you walk *down* to roll up a value — say, every account's balance summed into its header?**
A: Flip the join direction and change what the anchor seeds. The ancestor walk starts at one node and repeatedly joins to *its* `parent_id`. A descendant rollup instead starts every node at once, each paired with itself (`SELECT id AS ancestor_id, id AS descendant_id`), and the recursive term joins forward — `child.parent_id = previous.descendant_id` — collecting every node reachable downward from each starting ancestor. The result is a transitive closure table you can join against a per-node aggregate and `GROUP BY` the ancestor to get every node's rollup in one query.

**Q: Why does the anchor need to pair every node with itself, rather than just seeding the roots?**
A: Because a leaf account has no children, so if the anchor only seeded roots (or otherwise didn't give every node a self-pair), a leaf would never appear as anyone's descendant of itself, and its own balance would be missing from what should be its own rollup — a leaf's rollup is supposed to equal its own balance. Pairing every node with itself up front guarantees every account starts as a valid one-row "subtree," and the recursive term can only ever add more descendants on top of that, never fewer.

**Q: This rollup query has no explicit cycle check, but the ancestor-walk one you described earlier does (or at least could). Why the difference?**
A: Because by the time the rollup query runs, the data is already known to be acyclic — `wouldCreateCycle` refuses, at write time, any `parent_id` change that would introduce a cycle. The rollup query is a read over data whose acyclicity was already enforced elsewhere; it inherits that guarantee rather than re-deriving it. That's a legitimate optimization, but it's contingent — it only holds as long as every write to `parent_id` genuinely goes through that guarded path. If some other code (a migration, a bulk import, a bug) could set `parent_id` directly, this query would need its own cycle protection too.

---

## Follow-ups they'll dig into

- *"How would you compute a rollup balance for a header account?"* Exactly what Phase 3.6 built: a descendant-walking recursive CTE producing a transitive closure, joined against a per-account aggregate over `ledger_lines`, grouped by ancestor — see "Subtree rollups" above.
- *"What if the tree were 100,000 nodes?"* Materialize the paths, or move to `ltree` with a GiST index, and stop shipping the whole tree to the client.
- *"How do you order a tree in SQL?"* Carry a sort path array and `ORDER BY` it; the codebase sidesteps this by ordering by account code, which is designed to sort hierarchically.
- *"What's the difference between a CTE and a subquery?"* Since PostgreSQL 12, a non-recursive CTE is inlined by default and behaves like a subquery unless you write `MATERIALIZED`. A recursive CTE is always materialized.

---

## See also

- [postgresql-foundations.md](postgresql-foundations.md)
- [deferred-constraint-triggers.md](deferred-constraint-triggers.md) — the other rule a single-row CHECK cannot express
- [double-entry-as-an-invariant.md](../architecture/double-entry-as-an-invariant.md) — what the chart of accounts is for
