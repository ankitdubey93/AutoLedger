# Append-Only Audit Trails

> An audit trail that can be edited or deleted isn't an audit trail — it's a log that happens to still be accurate today. What makes `audit_logs` a *trail* rather than a table is a trigger that refuses `UPDATE` and `DELETE` on it, the same way `journal_entries` refuses them on itself.

**Category:** Architecture
**Introduced by:** Phase 5 — the shared CDC (change-data-capture) audit trail, `audit_logs`
**Verified against:** the codebase as of Phase 5 (2026-09-04), PostgreSQL 16

---

## Mechanism

### CDC vs. an application-level activity log

Two different things both get called "audit logging," and they catch different bugs:

- **An application-level activity log** — a service explicitly calls `logActivity('invoice.issued', {...})` at the point in the code where something interesting happens. It's rich and human-readable ("Alice issued invoice INV-0042"), but it only fires from code paths someone remembered to instrument. A migration, a data-fix script, or a bug that skips the logging call leaves no trace.
- **CDC (change-data-capture)**, what this codebase built — a trigger fires on every row change at the *database* level, regardless of what application code path produced it. It's mechanical and less immediately readable ("`invoices` row `abc-123` changed, `status` went from `ISSUED` to `VOID`"), but it cannot be bypassed by forgetting to call a logging function, because there's no logging function to forget — the trigger is unconditional. See [audit-triggers-and-session-variables.md](../postgresql/audit-triggers-and-session-variables.md) for the trigger mechanics themselves.

AutoLedger's `audit_logs` is CDC, deliberately, because the trust model it needs to satisfy is "prove this happened," not "explain this nicely" — the second is a UI/reporting concern layered on top (`AuditLogPage`'s expand-to-diff view), not a property of the storage.

### Why no foreign keys — the one sanctioned exception

Every other table in this codebase gets an FK on every `*_id` column, with an explicit `ON DELETE` (guardrails rule 8). `audit_logs.org_id` and `audit_logs.actor_user_id` are the single deliberate exception, and the reason is structural, not laziness: an audit row's entire job is to outlive the thing it describes. If `org_id` carried `ON DELETE CASCADE`, deleting an organization would delete the very audit trail that should record *that the organization was deleted*. If it carried `ON DELETE RESTRICT`, an organization could never be deleted at all while its history exists — which, for a table whose contents are supposed to keep growing forever, is the same as saying it can never be deleted. Either FK behavior actively defeats the point. `row_id` has an even more direct problem: it's polymorphic across sixteen different tables, so there's no single table a foreign key could even name as its target. The correct model here is that `org_id`, `actor_user_id`, and `row_id` are **historical facts about who/what/where at write time**, denormalized on purpose — snapshots, not live relationships that must always resolve to a current row.

### Why the primary key is a sequence, not a UUID

Every other table's primary key is `UUID PRIMARY KEY DEFAULT gen_random_uuid()`, chosen so ids are generatable client-side and unguessable. `audit_logs.id` is `BIGINT GENERATED ALWAYS AS IDENTITY` instead — a plain, gapless, increasing sequence. This is a log, not a domain entity: the property that actually matters here is *total order of arrival*, and a random UUID carries no ordering information at all, while an identity column gives "which row was written before which" for free, visible directly in the value, and makes a gap in the sequence itself detectable — a useful property for a trail whose entire purpose is being trustworthy.

### `txid`: grouping what one transaction actually did

A single user action often writes to several tables in one transaction — issuing an invoice touches `invoices`, `journal_entries`, and every `ledger_lines` row it posts, all inside one `BEGIN`/`COMMIT`. Each of those writes gets its own `audit_logs` row (the trigger fires per row, per table), but they're one *event* from a human's perspective. `txid` — `pg_current_xact_id()`, PostgreSQL's own transaction identifier, captured as each row's default — is what lets a reader reconstruct that grouping after the fact: every audit row sharing a `txid` happened atomically, in the same `COMMIT`. `created_at` alone can't do this reliably, because it defaults to transaction *start* time in PostgreSQL — every row written by the same transaction genuinely shares the same timestamp, which makes `txid` the only field that disambiguates "these five rows are one event" from "these five rows just happened to land in the same millisecond."

### What this design proves, and what it doesn't

The immutability trigger (`reject_audit_log_mutation()`, raising `0A000` on any `UPDATE`/`DELETE`) proves that **no ordinary database write** — through the application, through a bug, through a careless script using the application's own credentials — can alter or erase history after the fact. It does not, and cannot, prove anything against someone with table-owner privileges directly: `ALTER TABLE audit_logs DISABLE TRIGGER ...` followed by a raw `DELETE` would still work for a sufficiently privileged actor, exactly the mechanism `server/src/__tests__/integrity.test.ts` itself relies on to manufacture broken test data. Being honest about that boundary matters: this trail is a very strong guarantee against *application-level* tampering and a much weaker one against a compromised database superuser or a misconfigured production role grant — a distinction worth stating plainly rather than overselling "immutable" as absolute.

---

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Application-level activity log calls | Rich, human-readable messages | Rejected as the *only* mechanism — bypassed by anything that doesn't call the logging function, including future bugs and out-of-band scripts |
| Mutable audit table (ordinary `UPDATE`/`DELETE` allowed) | Simpler, correctable if a mistake is logged | Rejected — a trail someone can quietly edit isn't a trail, it's a table with a misleading name |
| Event sourcing (the audit log *is* the source of truth, current state is derived from replaying it) | Maximal history, natural time-travel queries | Rejected for this codebase specifically — [double-entry-as-an-invariant.md](double-entry-as-an-invariant.md) already covers why AutoLedger keeps current state in normal mutable-until-posted tables rather than going full event-sourced; CDC captures the same history as a side effect, without restructuring every read path around replaying events |
| Logical decoding / WAL streaming (`wal2json`, Debezium) to an external system | Captures literally everything, no trigger overhead, decoupled from the OLTP tables | Deferred — needs an external consumer and infrastructure this project doesn't have yet; the right scope for "prove every write is attributable inside this database," which is what Phase 5 actually needs |
| **Trigger-based CDC into an immutable, FK-light, sequence-keyed table** | A documented exception to two otherwise-universal schema rules (FKs, UUID keys) | **Chosen**, with both exceptions stated explicitly in the migration itself rather than left implicit |

See guardrails rule 6 (posted-document immutability — the same doctrine extended to the trail describing those documents) and rule 8 (FK-on-every-`*_id` — the two named exceptions).

---

## Where it lives in this codebase

- `server/src/db/migrations/017_platform_audit_logs.sql` — the table, its two FK-less columns and the reasoning documented in the migration header, `reject_audit_log_mutation()`
- `server/src/db/migrations/018_platform_audit_triggers.sql` — attaching capture to sixteen tables, and the explicit list of what's deliberately excluded (`users`, `refresh_tokens` — secrets; `schema_migrations` — the runner's own bookkeeping)
- `server/src/services/auditService.ts` — the only read path; no write function exists anywhere in the codebase, by design
- `server/src/__tests__/platform/auditTrail.test.ts` — capture correctness and the immutability guard, asserted directly against the pool
- `server/src/__tests__/integrity.test.ts` — the one place the immutability guard is deliberately, temporarily bypassed, and exactly what that bypass requires (table-owner-level `ALTER TABLE ... DISABLE TRIGGER`)

---

## Gotchas

- **`ON DELETE CASCADE`/`RESTRICT` are both wrong for an audit table's tenant/actor columns**, for opposite reasons — CASCADE destroys the very history it should preserve; RESTRICT makes the referenced row permanently undeletable. The correct answer is no FK at all, documented as a deliberate exception rather than left looking like an oversight.
- **`created_at` is not unique per event when a transaction writes several rows.** Reach for `txid`, not `created_at`, to group what one atomic action actually did.
- **"Immutable" here means "not editable through ordinary privileges," not "physically impossible to alter."** A table-owner role can always disable a trigger. State that boundary explicitly rather than implying a stronger guarantee than the design actually provides.
- **A UUID primary key would have thrown away the one property that makes a log useful as a log** — visible, gapless arrival order. Don't default to UUID everywhere out of habit; ask what the key is actually for.

---

## Interview Q&A

**Q: What's the difference between CDC and an application-level audit log, and why does it matter?**
A: An application-level log is a function call some service remembered to make at the point something interesting happened — it's readable, but only as complete as the code's discipline about calling it. CDC is a database trigger that fires on every row change regardless of which code path produced it, so it can't be silently skipped by a bug or an out-of-band script. I built CDC here because the property I actually needed was "prove this happened, no matter how it happened" — an application log can't make that claim, because there's always a path around it.

**Q: Why does the audit table have no foreign keys, when every other table in this project does?**
A: Because an audit row's job is to outlive what it describes. If `org_id` had `ON DELETE CASCADE`, deleting an organization would delete the very record that should say the organization was deleted — the FK would defeat the table's purpose. `RESTRICT` has the opposite problem: it would make an organization with any history undeletable forever. And `row_id` is polymorphic across sixteen tables, so there isn't even a single table an FK could name. The right model is that these columns are historical facts captured at write time, not live relationships — which is exactly the kind of exception that should be written down in the migration, not left for someone to rediscover and assume was a mistake.

**Q: Why an integer identity column for the primary key instead of the UUIDs you use everywhere else?**
A: Because a log's defining property is arrival order, and a UUID carries none — it's random by design. A `BIGINT GENERATED ALWAYS AS IDENTITY` gives me total order for free, visible directly in the value, and makes a gap in the sequence something I could notice. UUIDs earn their place elsewhere in this schema because unpredictability and client-side generation matter for those tables; neither matters here, and the ordering property does.

**Q: How does "immutable" actually hold up — could someone with database access still tamper with this?**
A: The immutability trigger stops any ordinary `UPDATE` or `DELETE` — through the application, through a bug, through anyone using the application's own database credentials. It does not stop someone with table-owner privileges from running `ALTER TABLE audit_logs DISABLE TRIGGER ...` first. I know that because my own integrity-checker test does exactly that, deliberately, to manufacture broken data to test against. I think it's important to state that boundary honestly rather than claim the trail is tamper-proof in an absolute sense — it's a very strong guarantee against application-level tampering, and a much weaker one against a compromised superuser role, and those are genuinely different claims.

**Q: How would you reconstruct "what did issuing this invoice actually do," given the trail records one row per table per line?**
A: Group by `txid`. Every row the same transaction wrote — the `invoices` update, the `journal_entries` insert, every `ledger_lines` insert — shares that value, because it's PostgreSQL's own transaction identifier, captured as each row's default. `created_at` can't do this reliably by itself, since it defaults to transaction start time and every row in the same transaction genuinely shares that timestamp.

---

## Follow-ups they'll dig into

- *"What happens to `audit_logs` at real scale — millions of rows a year?"* This design doesn't attempt retention or partitioning yet — stated explicitly as a known gap in the roadmap entry. At real volume you'd want time-based partitioning (a new partition per month, say) so old data can be detached/archived cheaply, and probably a retention policy driven by actual compliance requirements rather than a technical default.
- *"Could you prove the trail itself hasn't been tampered with, beyond trusting the trigger?"* Not with what's built here — that would need something like a hash chain (each row's hash incorporating the previous row's hash) or write-once storage outside the database entirely, so tampering would break a chain an attacker with table access can't easily repair. Worth naming as the next layer if the compliance bar rose.
- *"Why not just use PostgreSQL's built-in logical replication / WAL for this instead of triggers?"* WAL-based CDC (via `wal2json` or similar) captures everything with less per-write overhead and no trigger to maintain, but it needs an external consumer process reading the replication stream — infrastructure this project doesn't have until background jobs land. Trigger-based CDC was the right scope for "guarantee this inside the same transaction, with nothing else to stand up."
- *"What's the cost of this on write throughput?"* Every audited write now does one extra `INSERT` per row changed, in the same transaction — a 20-line journal entry writes 21 audit rows for one document. Accepted and stated explicitly rather than hidden; a genuinely high-throughput table would need to weigh that against a lower-fidelity capture strategy.

---

## See also

- [audit-triggers-and-session-variables.md](../postgresql/audit-triggers-and-session-variables.md) — how the capture actually works, mechanism-level
- [integrity-checking-a-ledger.md](../postgresql/integrity-checking-a-ledger.md) — Phase 5's other half, and the one place this trail's immutability is deliberately bypassed, for testing
- [double-entry-as-an-invariant.md](double-entry-as-an-invariant.md) — the other append-only, immutable-by-trigger design in this codebase, and why derived state beats stored+corrected state
- [document-lifecycle-fsm.md](document-lifecycle-fsm.md) — "correct by reversal, never by edit" as the same underlying philosophy applied to business documents rather than to the trail describing them
