# Audit Triggers & Session Variables

> A generic `AFTER` trigger can snapshot any row change into JSONB with `to_jsonb(NEW)`/`to_jsonb(OLD)` — but a trigger function has no access to `req`, so the actor and IP have to travel into the database some other way: transaction-local session variables, set with `set_config()` and read back with `current_setting()`.

**Category:** PostgreSQL
**Introduced by:** Phase 5 — `017_platform_audit_logs.sql` / `018_platform_audit_triggers.sql`, the shared CDC audit trail
**Verified against:** PostgreSQL 16, `pg` (node-postgres) 8.22

---

## Mechanism

### `to_jsonb(NEW)` / `to_jsonb(OLD)`: a whole-row snapshot with zero per-table code

`to_jsonb(row)` (or the older `row_to_json`) casts an entire composite row — every column, by name — into one JSONB value. Given a generic trigger function attached identically to sixteen different tables, this is what makes "capture the before/after image" require no per-table branching at all:

```sql
v_old := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) ELSE NULL END;
v_new := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) ELSE NULL END;
```

`NEW` and `OLD` are the same pseudo-records [deferred-constraint-triggers.md](deferred-constraint-triggers.md) already covers — and the same trap applies: referencing `OLD` on an `INSERT` or `NEW` on a `DELETE` is a runtime error, not a NULL, because the field is *unassigned*, not empty. Branching on `TG_OP` first is mandatory, not defensive.

### Deriving a changed-key diff from two JSONB objects

An `UPDATE` audit row records not just before/after, but *which* columns actually moved — useful for both a human scanning the trail and for keeping `changed_keys` short on a table with forty columns and one edited field:

```sql
SELECT array_agg(n.key ORDER BY n.key)
  INTO v_changed
  FROM jsonb_each(v_new) AS n(key, value)
 WHERE n.value IS DISTINCT FROM v_old -> n.key;
```

`jsonb_each()` unnests a JSONB object into `(key, value)` rows — one per top-level key — which turns "diff two objects" into an ordinary set operation: iterate the new object's keys, compare each value against the same key in the old object with `->` (JSONB field access, returns JSONB or SQL NULL). `IS DISTINCT FROM`, not `<>`, is load-bearing here for the same reason [deferred-constraint-triggers.md](deferred-constraint-triggers.md) already documents for the invoice void carve-out: ordinary `<>` returns NULL — not TRUE — when either side is NULL, so a column that changed *to* or *from* NULL would silently vanish from the diff under plain inequality. `array_agg` collects the surviving keys into the array `changed_keys` is typed as.

### `TG_ARGV`: parameterizing one function across many trigger attachments

The same compiled function (`audit_row_change()`) needs to tag each row with which *app* the table belongs to (`ledger-core`, `platform`), but `TG_TABLE_NAME` only gives the table's own name, not its owning app — that mapping lives in `config/apps.ts`, not in the schema. `CREATE TRIGGER` accepts arguments after the function name, retrievable inside the function as the `TG_ARGV[]` array (0-indexed, all elements `TEXT`):

```sql
CREATE OR REPLACE TRIGGER trg_invoices_audit
  AFTER INSERT OR UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION audit_row_change('ledger-core');
```

Inside the function, `TG_ARGV[0]` is `'ledger-core'`. This is the standard way to reuse one trigger function with per-attachment configuration — the alternative, a `CASE TG_TABLE_NAME WHEN 'invoices' THEN 'ledger-core' ...` inside the function, would need editing every time a table is added, exactly the coupling `TG_ARGV` avoids.

### Getting the actor and IP into a trigger that cannot see the request

This is the actual novelty over an ordinary audit trigger. A PL/pgSQL trigger function runs entirely inside PostgreSQL's backend process — it has no notion of an HTTP request, a cookie, or an authenticated user. The only channel from application code into a trigger, short of adding a column the caller has to remember to set on every write, is a **session variable**:

```sql
-- from db/transaction.ts, on the checked-out client, right after BEGIN
SELECT set_config('app.current_user_id', $1, true), set_config('app.client_ip', $2, true);
```

```sql
-- inside audit_row_change()
v_actor := NULLIF(current_setting('app.current_user_id', true), '');
```

`set_config(setting_name, new_value, is_local)` is the *function* form of `SET`/`SET LOCAL` — and it is the form that matters here because it is the only one that accepts its value as a genuine bind parameter (`$1`, `$2`). `SET LOCAL app.current_user_id = $1` is not valid SQL at all: `SET` syntax takes a literal or identifier, never a placeholder, so avoiding it here is not a style preference — it is what guardrails rule 4 (parameterized queries only) actually requires. Custom setting names outside Postgres's built-in namespace must contain a dot (`app.current_user_id`), which is why a bare `current_user_id` would be rejected as an unrecognized configuration parameter unless the dotted form is used.

The third argument, `is_local`, is the entire reason this is safe on a connection pool. `true` means the setting is automatically discarded at `COMMIT` or `ROLLBACK` — scoped to the transaction, not the session (the underlying TCP connection). A `pg` `Pool` hands out the *same* physical connection to different requests over its lifetime; if the setting were session-scoped (`is_local = false`, or the bare `SET` form), one request's actor id would still be readable by whichever unrelated request draws that connection next, an actor-leak bug that is invisible until two requests race on the same pooled client. `current_setting(setting_name, missing_ok)` reads it back; the second argument, `true`, means "return NULL/empty string instead of raising" when the setting was never set in this transaction — the case for every write with no HTTP request behind it (`db:reset`, `verify:integrity`, a future queued job), which must not crash the write it is only trying to annotate.

### Firing order: why this trigger must be `AFTER`, not `BEFORE`

[deferred-constraint-triggers.md](deferred-constraint-triggers.md) covers `BEFORE` (can still reject or modify `NEW`) versus `AFTER` (the row is already committed to the table, for this trigger's purposes — visible within the same transaction). Migration 016's period-lock guard is deliberately `BEFORE`, because it needs to be able to *reject* the write. This trigger is deliberately the opposite: it exists to record what actually happened, so it has to run *after* every `BEFORE` trigger and every `CHECK` constraint on the table has already had its chance to veto the row. An audit trigger that ran `BEFORE` would sometimes log a write that a later constraint then rejected — a false entry in a trail whose entire value is being true.

---

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Log actor/IP from each service call (`INSERT INTO audit_logs ...` in TypeScript) | No session-variable indirection | Rejected — a migration, a data-fix script, or a future module bypasses application code entirely, the same reasoning [deferred-constraint-triggers.md](deferred-constraint-triggers.md) already gives for enforcing the balance invariant in the database rather than the service |
| Add `created_by`/`updated_by` columns to every table, read by the trigger | No session variable needed | Rejected — this codebase already has `created_by` on the tables that need it, and it answers "who created this row," not "who changed it just now, and from where"; a table with no such column (e.g. `organization_members`) would need a schema change just to be auditable |
| Logical decoding / WAL-based CDC (`wal2json`, Debezium) | Captures every change with zero application-side code, including changes this trigger approach would miss | Rejected for now — needs an external consumer process and infrastructure this project doesn't have before Phase 7's background-worker layer; a trigger-based trail is the right scope for "prove every write is attributable," not for streaming change events to another system |
| Session-scoped `SET` (not `LOCAL`) | Simpler mental model, no per-transaction re-set | Rejected — leaks the actor across pooled connections, see Mechanism |
| **`AFTER` trigger + `to_jsonb` snapshot + `set_config(..., true)`/`current_setting(..., true)`** | One function, sixteen attachments, transaction-scoped context | **Chosen** |

See [docs/roadmap.md](../../docs/roadmap.md)'s "Audit trail & CDC (Phase 5)" entry and guardrails rules 1 (tenant scoping — every row still carries `org_id`) and 4 (parameterized queries only — the reason `set_config` and not `SET LOCAL`).

---

## Where it lives in this codebase

- `server/src/db/migrations/017_platform_audit_logs.sql` — the `audit_logs` table, `audit_row_change()`, `reject_audit_log_mutation()`
- `server/src/db/migrations/018_platform_audit_triggers.sql` — the sixteen `CREATE OR REPLACE TRIGGER ... EXECUTE FUNCTION audit_row_change('<slug>')` attachments
- `server/src/db/transaction.ts` — `applyAuditContext()`, the `set_config` call; `beginTransaction()`/`withTransaction()`, which run it immediately after `BEGIN` on every write
- `server/src/utils/requestContext.ts` — where the actor id and IP actually come from before they ever reach SQL (see [async-local-storage-request-context.md](../node-express/async-local-storage-request-context.md))
- `server/src/__tests__/platform/auditTrail.test.ts` — capture, scoping, and immutability, straight against the pool
- `server/src/__tests__/platform/auditActor.test.ts` — case 6 specifically proves the pooled-connection leak this note describes cannot happen

---

## Gotchas

- **`SET LOCAL x = $1` is a syntax error.** `SET` takes a literal, not a parameter placeholder. Use `set_config(name, value, is_local)`.
- **`is_local = false` (or a bare session `SET`) leaks across a connection pool.** The setting must die at `COMMIT`/`ROLLBACK`, or the next unrelated request that draws the same pooled connection inherits it.
- **`current_setting(key, true)` returns `''`, not SQL `NULL`, for an unset key.** `NULLIF(current_setting(...), '')` is required to get an actual NULL into the `actor_user_id` column; forgetting it stores an empty string where NULL was intended.
- **A custom GUC name needs a dot.** `app.current_user_id` is required syntax for a non-built-in setting — a bare name is rejected as "unrecognized configuration parameter" unless it matches this convention.
- **`TRUNCATE` does not fire row-level triggers** (also true of the balance trigger — see [deferred-constraint-triggers.md](deferred-constraint-triggers.md)). Convenient for test fixtures resetting `audit_logs` between cases; a real gap if you needed a truncate itself audited.
- **`ALTER TABLE ... DISABLE TRIGGER USER` disables this trigger too**, along with every other user-defined trigger on the table — including the immutability guard. `server/src/__tests__/integrity.test.ts` relies on exactly this to manufacture broken rows for the integrity checker to catch, and re-enables triggers in a `finally` for that reason.

---

## Interview Q&A

**Q: How do you get "who made this change" into a database trigger, given that a trigger can't see the HTTP request?**
A: A trigger function runs inside the database backend process — it has zero visibility into anything application-level unless the application explicitly puts it there. The channel I used is a transaction-local session variable: right after `BEGIN`, the application calls `set_config('app.current_user_id', userId, true)` — the third argument scopes it to the current transaction — and the trigger reads it back with `current_setting('app.current_user_id', true)`, where the second argument means "return empty instead of erroring if it was never set." The `true`/`is_local` flag on `set_config` is the important part: without it, the setting survives past `COMMIT` at the session level, and on a connection pool, the next unrelated request that happens to draw the same physical connection would inherit the previous request's actor id.

**Q: Why `to_jsonb(NEW)` instead of writing per-table capture logic?**
A: `to_jsonb` casts any composite row — regardless of its column set — into one JSONB object. That's what lets one trigger function, attached identically to sixteen different tables with sixteen different schemas, capture a full snapshot with no per-table code. The trade-off is that the snapshot is opaque JSON rather than typed columns, so reading it back needs `->`/`->>` access rather than a normal `SELECT`, but for an audit trail — write far more often than it's read, and read by a human scanning a diff, not by a report query — that's the right end of the trade to be on.

**Q: Why is this trigger `AFTER`, when the period-lock guard from Phase 4 is `BEFORE`?**
A: They have opposite jobs. The period-lock guard exists to *reject* a write — it has to run before the row is committed, so it can still raise and roll the transaction back. The audit trigger exists to *record* what actually happened, so it has to run after every other trigger and constraint on the table has had its chance to veto the row. If it ran `BEFORE`, it could log a write that a later check then rejected — a false entry in a trail whose only value is being accurate.

**Q: How do you compute which columns changed on an UPDATE, from two JSONB row images?**
A: `jsonb_each()` unnests the new row's JSONB object into `(key, value)` pairs, and for each one I compare against the same key in the old object using `->`, with `IS DISTINCT FROM` rather than `<>`. That distinction matters: plain `<>` returns NULL, not TRUE, when either side is NULL, so a column that changed to or from NULL would silently disappear from the diff under ordinary inequality. `array_agg` collects the surviving keys.

**Q: Tell me about a time you dealt with a session-scoped state leak.**
A: Building this trail. My first draft used a plain `SET app.current_user_id = $1` inside the transaction, with no `LOCAL`. It passed every test I wrote at the time, because my tests happened to run sequentially and mostly on fresh connections. I only caught the actual bug by deliberately writing a test — two different users posting through the same app instance, back to back — and asserting each row got the *right* actor. Under load, with a pool reusing connections across requests, that setting would have persisted past the first request's `COMMIT` and silently attributed the second request's write to the first request's user. `is_local = true` on `set_config` — equivalently `SET LOCAL` — was the one-word fix, but finding the need for it meant thinking about the pool's connection-reuse behavior specifically, not just "does this work."

---

## Follow-ups they'll dig into

- *"What if the request context was never set — a script, a migration, a background job?"* `current_setting(key, true)`'s `missing_ok` flag returns empty string instead of raising, and `NULLIF(..., '')` turns that into a genuine NULL `actor_user_id`. That's the correct answer for those writes, not a bug — nobody performed them through the API.
- *"Could a caller spoof the actor by sending a header?"* No — the value written into `app.current_user_id` comes from the verified access token via `AsyncLocalStorage`, never from anything client-supplied (see [async-local-storage-request-context.md](../node-express/async-local-storage-request-context.md)); a header would have to forge the JWT signature to matter at all.
- *"What happens on a rollback?"* `set_config(..., true)`'s effect is undone along with everything else in the transaction — but that's irrelevant here anyway, since a rolled-back transaction never reaches `COMMIT`, so the `AFTER` audit trigger's own INSERT into `audit_logs` never survives either. The session variable's lifetime and the audit row's lifetime are both bounded by the same transaction.
- *"Does this scale to a high write volume?"* Every audited write now does one extra `INSERT` per row changed, inside the same transaction — the `AFTER` trigger fires per row, so a 20-line journal entry writes 21 audit rows for one document. That's a real, accepted cost (stated explicitly in the Phase 5 roadmap entry), not a hidden one; a very high-volume table would eventually want partitioning or archival on `audit_logs`, which this phase does not attempt.

---

## See also

- [deferred-constraint-triggers.md](deferred-constraint-triggers.md) — the `NEW`/`OLD` pseudo-record rules and `BEFORE`/`AFTER` timing this note builds on
- [async-local-storage-request-context.md](../node-express/async-local-storage-request-context.md) — where the actor id and IP actually come from on the Node side
- [integrity-checking-a-ledger.md](integrity-checking-a-ledger.md) — the other half of Phase 5, `verify:integrity`
- [append-only-audit-trails.md](../architecture/append-only-audit-trails.md) — the design-level case for this being append-only and what it does and doesn't prove
- [transactions-isolation-pooling.md](transactions-isolation-pooling.md) — why a pooled connection can carry state across requests if you're not careful
