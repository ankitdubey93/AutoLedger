# Staged Import and Two-Phase Commit: Stage Everything, Commit Once

> Two CSV importers live in this codebase, and they're deliberate opposites. One aborts a whole file on the first bad row and writes live rows immediately. The other stages every row — good and bad — and separates "is this valid" from "make it real" into two distinct steps. The interesting part is knowing *which* shape a given import deserves, and why getting it backwards is a real production annoyance, not just a style preference.

**Category:** Architecture
**Introduced by:** Phase 9b — `migrationImportService.ts`, the staged chart-of-accounts and opening-balance importer, contrasted against Phase 6's `bankImportService.ts`.
**Verified against:** this codebase's own two implementations, PostgreSQL 16.

---

## Mechanism

**The abort-on-first-error shape** (`bankImportService.ts`, Phase 6): parse the whole file in memory, and if *any* row fails to parse, throw a `422` before a single row is written. If parsing succeeds, insert every row in one bulk `INSERT ... SELECT ... FROM unnest(...)` inside one transaction, deduplicated against prior imports by a content-addressed hash. There is no intermediate state — a bank statement either imports cleanly or it doesn't import at all, and there is nothing to "fix" afterward except re-uploading a corrected file.

**The stage-everything shape** (`migrationImportService.ts`, Phase 9b): parse the whole file, but never reject a row for being invalid — every row, good and bad, is bulk-inserted into `migration_import_rows` with whatever it parsed to (`account_code`, `account_type`, etc., each nullable) plus an `errors: text[]` column and a `status` of `VALID`/`INVALID`/`EXCLUDED`. A **separate** validation pass (`validateRows`, delegated per-kind to `chartImportService`/`openingBalanceImportService`) computes each row's errors by checking it against both the organization's existing state (does this account code already exist, with a different type?) and the *other rows in the same file* (is this code duplicated, does its parent form a cycle?). The import itself gets a `status` of `DRAFT` (some row is `INVALID`) or `VALIDATED` (zero `INVALID` rows) — never quite "correct" until a human looks at it. A user can `PATCH` one row's fields, which triggers the identical validator to re-run over the whole file, updating that row's status and the import's aggregate status together. Only once the import reads `VALIDATED` does `POST /:id/commit` become legal, and commit is **all-or-nothing** inside one transaction: for a chart import it walks the union of existing accounts and file rows in parent-before-child order, creating or merging each; for an opening-balance import it builds one journal entry through `journalService.createEntryOnClient` and posts it once.

The two pieces — "what does each row say" and "make it permanent" — are structurally separate function calls (`validateRows` vs `commitOnClient`), and the database enforces the separation too: `migration_imports.status` has a `CHECK` restricting it to `DRAFT | VALIDATED | COMMITTED`, and `chk_migration_rows_valid_has_no_errors` makes it physically impossible to mark a row `VALID` while it still carries errors — the two facts (validity, and the recorded reason for invalidity) can never drift apart in the stored data, only in a stale value some earlier read handed back to a client.

## Why we chose it here

**A bank statement is machine-generated.** It comes from one bank's own export tool, its column layout is consistent across every statement that bank produces, and a parse failure on row 40 almost always means the *column mapping itself* is wrong — which means every other row is equally suspect. Aborting the whole file and asking the user to fix the mapping (or supply an explicit `columnMap`) and re-upload is the fast path to a correct import; staging 40 good rows next to a systematically-wrong assumption would just be confusing.

**A first chart-of-accounts export from another system is not like that.** It's frequently hand-edited, merged from multiple sources, or exported by a tool with inconsistent conventions — a typo in one account's type, a parent code that was renamed three years ago and never updated everywhere. In that setting, "the whole file is rejected because of one typo, go fix your CSV and re-upload the entire thing" is a genuinely bad workflow: the user re-uploads, discovers the *next* error, and repeats — turning a five-minute task into fifteen round trips. Staging every row and surfacing every error **at once**, with an inline fix-and-revalidate loop, turns that into one pass.

| Option | Trade-off | Verdict |
|---|---|---|
| Abort-on-first-error (bank import's shape) | Simple, no intermediate state to reason about; catastrophic for a file that's mostly right with a few real mistakes | Right for bank statements; wrong for a first chart export — rejected for 9b |
| Streaming commit with a `SAVEPOINT` per row | Lets good rows commit immediately while bad ones roll back individually; leaves the books in a half-migrated state if the user never returns to fix the rest, and a chart with 80% of its accounts present is worse than none, since reports would look plausible while being wrong | Rejected |
| Client-side validation only, then commit everything the server accepts | The server cannot trust a client's validation — rule 4's parameterization discipline exists because untrusted input reaches SQL, and the same distrust applies to "is this row valid" | Rejected |
| A temp table for staging | Dies with the connection — a user who starts an import, gets distracted, and comes back tomorrow finds nothing there; this phase explicitly wants a resumable multi-day workflow | Rejected |
| Stage everything in a real table, validate as a separate pass, commit once (chosen) | Costs one extra table and one extra round trip per fix; buys a resumable, all-at-once-visible-errors workflow and a commit that is genuinely all-or-nothing | **Chosen** |

The general principle this generalizes to, worth stating for an interview: **when the input source is untrusted-but-structured and likely to be a "mostly right, a few real mistakes" document** (a human-assembled export, a form with many fields, a multi-step wizard someone might abandon and resume), staging beats aborting. **When the input source is trusted-format-but-individual-rows-can-be-garbage** (a machine-generated feed where a bad row is an anomaly, not a systemic issue), aborting on the first bad row and asking for a clean resubmission is simpler and just as correct.

## Where it lives in this codebase

- `server/src/db/migrations/029_ledger-core_migration_imports.sql` — `migration_imports` (the import, with its own `DRAFT/VALIDATED/COMMITTED` lifecycle) and `migration_import_rows` (one row per staged CSV line, `errors text[]` plus a `VALID/INVALID/EXCLUDED` status).
- `server/src/services/ledger-core/migrationImportService.ts` — `createImport` (parse + stage + initial validate), `patchRow` (apply a fix, then re-validate the whole import), `revalidateOnClient` (the shared validate-and-recompute-status routine both paths call), `commit` (the all-or-nothing dispatch to the per-kind committer).
- `server/src/services/ledger-core/chartImportService.ts` / `openingBalanceImportService.ts` — the per-kind `validateRows`/`preview`/`commitOnClient` halves.
- `server/src/services/ledger-core/bankImportService.ts` (Phase 6) — the contrasted abort-on-first-error shape this note measures against.
- `server/src/__tests__/ledger-core/chartImport.test.ts` — `"a chart CSV with two deliberately corrupt rows stages the rest as VALID and commits only after both are fixed"`, the named acceptance test proving the shape end to end.

## Gotchas

- **Re-validating on every `PATCH` means one fix can change other rows' errors.** Fixing row A's duplicate-code error can turn row B (which shared that code) from `INVALID` to `VALID` in the same call — the client must re-read the whole row list after a patch, not just optimistically update the one row it touched. `MigrationImportDetailPage`'s `saveRow` calls a full `refresh()` rather than patching local state, for exactly this reason.
- **Staged rows are audited at the parent level only.** `migration_import_rows` carries no audit trigger — it's staging data, rewritten wholesale on every re-validate, and what it ultimately *produces* (real accounts, a real journal entry) is itself audited. Auditing every intermediate row-fix would be noise, not signal — the same call this codebase already made for `bank_match_suggestions` and `fx_revaluation_lines`.
- **A parse failure and a validation failure are different things staged identically.** A cell that fails `parseMoneyText` becomes a row with `debit_cents = NULL`, which then fails validation with the generic "row has no amount" — the raw, unparseable text is preserved in the row's `raw` JSONB for the user to see, but the distinction ("we couldn't read this" vs "we read it and it's wrong") collapses into one error message. That's a deliberate simplification for this phase, not an oversight — see the plan's Risks section.
- **`VALIDATED → DRAFT` is a real, expected backward transition**, not a bug — it's what makes "fix a row, and if it introduces a new problem, the import correctly stops being commit-eligible again" work. A transition table that only ever moved forward would be wrong for this shape.

## Interview Q&A

**Q: Why does the import need its own `status` field at all — why not just derive "can this be committed" from whether any row has errors?**
A: You could compute it on every read (`SELECT count(*) FROM migration_import_rows WHERE import_id = $1 AND status = 'INVALID'`), and in fact the design does exactly that computation whenever it *changes* the status — but storing the derived value gives two things a pure computation doesn't: an explicit place for the "already committed, don't re-run me" check to live without a special-cased query, and a value the database's own `CHECK` constraints can reference (`chk_migration_imports_committed` ties `status = 'COMMITTED'` to `committed_at IS NOT NULL` in one constraint). It's the same "derived vs. stored" tradeoff this codebase makes deliberately elsewhere (see `derived-vs-stored-state.md`) — here the answer is "store it," because the FSM needs a concrete value to transition, not just a computed boolean.

**Q: What happens if two people fix different rows of the same import at the same time?**
A: Each `PATCH` runs inside its own transaction (`withTransaction`), and `revalidateOnClient` re-reads every row fresh from the database at the start of its pass — so the second `PATCH` to land sees the first one's already-applied fix. There's a real last-write-wins outcome if two people edit the *same* row concurrently (no optimistic locking on individual rows), which is an accepted gap for what is, in practice, a single operator's onboarding task — not a concurrent multi-editor document.

**Q: Why is commit itself all-or-nothing, when staging deliberately wasn't?**
A: Staging is provisional by definition — a `DRAFT` import hasn't touched the real chart of accounts or the ledger yet, so partial staging costs nothing. Commit is the opposite: it creates real accounts and, for an opening-balance import, posts one real journal entry that the balance-invariant triggers will check. A partial commit would mean "some of this business's opening balances are recorded and some aren't," which is a books-are-lying state — worse than not having imported at all, because it looks plausible on a report. So commit runs inside one transaction and either every row's effect lands or none does.

**Q: Doesn't re-validating the entire import on every single-row `PATCH` get expensive for a large chart?**
A: It's O(n) per patch (one query for existing org accounts, one for the file's own rows, then an O(n) or O(n²)-worst-case pass for cycle detection among just the rows sharing a parent chain) against a chart that's realistically dozens to low hundreds of rows — cheap enough that correctness (never showing a stale error after a fix) is worth far more than the cost of a full re-scan. If this needed to scale to a chart import with tens of thousands of rows, the next step would be incremental re-validation of only the rows whose duplicate-code or parent-chain group changed — not implemented here because the input size doesn't warrant it.

**Q: How would you extend this to support a bad row's fix being wrong *again* — i.e., is there a limit on the fix loop?**
A: No limit by design — `PATCH` → `revalidateOnClient` is idempotent and can run any number of times; the loop only terminates because the *user* eventually gets every row to `VALID` (or excludes the ones they don't want). The only hard stop is `COMMITTED`: once an import reaches that terminal state, `revalidateOnClient` itself refuses with a `409` rather than silently re-validating rows behind an already-posted journal entry.

## Follow-ups they'll dig into

- "What if `commitOnClient` fails halfway through creating ten new accounts?" The whole transaction rolls back — no account created in that pass persists, `migration_imports.status` is untouched (still `VALIDATED`), and the user can retry the commit once whatever caused the failure (a race with another writer, say) is resolved.
- "How is the chart importer's parent-before-child ordering different from `accountService.seedDefaultChart`'s?" `seedDefaultChart` resolves depth from one fixed, known-acyclic seed list; the chart importer's ordering resolves depth over a *mixed* set of already-existing org accounts and newly-staged file rows via repeated passes, converging because `validateRows` already proved there's no cycle and no dangling parent among `VALID` rows before commit is ever attempted.
- "Would this shape make sense for something with real-time collaborators, like a shared spreadsheet?" No — this design assumes one operator working through a queue of fixes serially, not concurrent editors; a genuinely collaborative version would need per-row optimistic locking or CRDTs, which is a different problem.

## See also

- [partial-unique-indexes.md](../postgresql/partial-unique-indexes.md) — the constraint that makes a second commit of an opening-balance import physically impossible.
- [document-lifecycle-fsm.md](document-lifecycle-fsm.md) — `MIGRATION_IMPORT_TRANSITIONS`, where `VALIDATED → DRAFT` is a deliberate backward edge.
- [idempotent-ingestion-and-dedupe-hashes.md](../postgresql/idempotent-ingestion-and-dedupe-hashes.md) — the bank importer's own idempotency mechanism, contrasted against this one's staged-fix loop.
