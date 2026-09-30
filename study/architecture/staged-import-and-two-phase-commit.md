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

## Phase 36a additions — one registry, inspect-then-stage, and a lock on commit

Phase 36a rebuilt the four existing import kinds (chart of accounts, opening balances, customers, vendors) on shared machinery. **Verified against:** PostgreSQL 16 (`READ COMMITTED`, the `pg` default), Node 22, TypeScript 5.x `satisfies`; the code paths below were read, and the concurrent-commit behaviour is proven by a real test, not just reasoned about.

### Registry / strategy dispatch replacing if/else chains

Before 36a, `migrationImportService.ts` had the same four-way `if (kind === 'CHART_OF_ACCOUNTS') … else if …` in three places (revalidate, preview, commit), plus per-kind synonym arrays and a `resolveColumns` function that knew every kind. Adding a fifth kind meant finding and editing every chain, and the compiler could not tell you that you had missed one.

The replacement is a **strategy registry**: `IMPORT_KINDS` in `server/src/services/accounting/importKinds.ts` maps each kind to one `ImportKindDef`, which bundles two things that used to live apart:

- **Data** (`ImportKindMeta`): label, noun, the column definitions (key, template header, synonyms, required, example), `requiredOneOf`, per-column 422 messages, and the `editFields` a reviewer may correct.
- **Strategy functions**: `parseRow`, `validateRows`, `preview`, `commitOnClient`, each taking the checked-out `PoolClient`.

The generic service then contains no kind knowledge at all: `getImportKind(kind).validateRows(client, orgId, rows)`, `.preview(...)`, `.commitOnClient(...)`. The per-kind services (`chartImportService`, `openingBalanceImportService`, `partyImportService`) keep their own signatures; the registry only adapts them. The adapter's real job is normalising return shapes — chart returns `{created, merged}`, opening balances return `{journalEntryId, plugCents}` — into one discriminated `MigrationCommitResult` that is persisted as `migration_imports.result` (JSONB) so a detail page can show what a commit did without a polymorphic id column (which would break rule 8, every `*_id` needs a real FK).

Customers and vendors differ only in a kind string, so `partyDef(kind)` is a small factory returning the four functions with `kind` closed over, and the two entries spread it. That is the same strategy idea one level down: a function that *builds* a strategy.

### Inspect, then stage, with a column map

Earlier the file was parsed once, at stage time, and a header the synonym list did not recognise was a 422 after the user had already committed to the upload. 36a splits it in two:

1. `POST /migration-imports/inspect` (`inspectImport`, pure — it takes no `orgId` and touches no table) parses the CSV, resolves headers, and returns `headers`, `sampleRows` (first 5), `suggestedMap` (column key → the file header it matched, or `null`), `missingRequired`, and `exactMatch`. It deliberately **does not throw** on a missing required column; it reports it, because the next screen is where the user fixes it.
2. `POST /migration-imports` (stage) takes an optional `columnMap` and runs the *same* resolver, so what the user saw is what is applied. The map is stored in `migration_imports.column_map` for audit of what was actually used.

The resolver, `resolveColumnIndexes` in `server/src/utils/importColumns.ts`, is **two-pass**: pass 1 applies the explicit map (an unknown key, a header not in the file, or one header claimed twice are 400s — the client sent something the UI can't produce); pass 2 fills every still-unset key automatically. The automatic pass tries the template header first (`compactHeader('*ContactName')` → `contactname`) and only then the synonyms, and skips any header index already claimed. Order matters in both directions: explicit-first means a user's choice always beats a guess, including an explicit `null` ("don't import this field"), which blocks the automatic pass from re-claiming a column; claim-tracking means a header like `Name` cannot silently feed two fields. `compactHeader` lowercases and strips everything except `[a-z0-9]`, so `*Contact Name`, `Contact_Name` and `contact name` are one header — Xero's starred template headers match without a synonym for each punctuation variant. `findMissingRequired` then reports required keys in rejection order, plus the first unsatisfied `requiredOneOf` set (opening balances accept either Debit+Credit or a signed Amount).

`exactMatch` (nothing missing *and* every file header is one of the kind's own template headers) is the only signal the client uses to skip the mapping screen. When it is true the client sends `columnMap: null` and pure automatic resolution runs.

### `SELECT … FOR UPDATE` against a double commit (a check-then-act race)

The old `commit` read the import's status through `pool` **before** `BEGIN`, then opened a transaction and committed. That is a textbook check-then-act race: two requests both read `VALIDATED`, both begin, both run `commitOnClient`. For customers that would create the party twice; for opening balances the partial unique index `ux_migration_imports_one_committed_opening` would catch it, but only *after* a whole journal entry was built, and only for that kind.

The fix is to make the check and the act one critical section. `commit` now opens the transaction first, and its first statement is

```sql
SELECT kind, status, error_count FROM migration_imports WHERE id = $1 AND org_id = $2 FOR UPDATE
```

**Mechanism.** `FOR UPDATE` takes a row-level lock on that one `migration_imports` tuple (it writes the locker's transaction id into the tuple header's `xmax` with a lock-only flag; no table lock, no other rows affected, plain reads are never blocked). The second transaction's identical `SELECT … FOR UPDATE` finds the row locked and **waits** for the first to finish. Under `READ COMMITTED`, when the first commits, the waiter does not proceed with the stale version it saw: Postgres follows the update chain to the newest row version and **re-evaluates the `WHERE` clause against it** (this is the `EvalPlanQual` recheck), then returns the current row. The waiter therefore reads `status = 'COMMITTED'` and throws 409 `This import has already been committed` — before it runs a single row of `commitOnClient`. If the first transaction rolls back instead, the waiter gets the still-`VALIDATED` row and proceeds, so a failed commit never locks the import out.

Three consequences are worth being able to say aloud. The lock is released at `COMMIT`/`ROLLBACK`, so the `catch` path's `ROLLBACK` releases it on any thrown `ApiError`. The lock and the `org_id` predicate share the statement, so a wrong-tenant id locks nothing and returns no row → 404 (rule 1). And everything inside — the lock, the kind's commit, the `UPDATE … SET result` — runs on the same `client` (rule 5); a stray `pool.query` would be a *different connection* that does not hold or see the lock.

### The stale-error hazard in the PATCH path

`revalidateOnClient` (used by both stage and `PATCH`) needs to write every row's new status and errors in one go. See [../postgresql/jsonb-user-defined-attributes.md](../postgresql/jsonb-user-defined-attributes.md#batched-update--from-unnest-and-passing-an-array-per-row-as-json) for the single batched `UPDATE … FROM unnest()` that replaced one UPDATE per row.

### Rejected alternatives (36a)

| Option | Why rejected |
|---|---|
| Keep the if/else chains, add a fifth branch per step | Every new kind edits three chains; nothing forces you to remember one. Steps B–D add five more kinds. |
| A class hierarchy (`abstract class ImportKind`) | Nothing here has per-instance state; a plain object of functions is the same polymorphism without `this`, `new`, or an inheritance tree, and `satisfies` gives the exhaustiveness a class registry would need a test for. |
| A registry in the database | The strategies are code. Only the *kind names* are in the DB (the `chk_migration_imports_kind` CHECK), and migration 078 already admits all nine now so later steps need no kind migration. |
| Client hand-syncs templates and synonyms | This was the old `IMPORT_TEMPLATES`, which drifted from the server synonyms. Served by `GET /kinds`, there is one source of truth. |
| Optimistic check: `UPDATE … SET status='COMMITTED' WHERE status='VALIDATED'` and inspect the row count | Would also work, but the commit must run the kind's writes *first* (they need `status = VALIDATED` to still hold and they produce the result we record); a row lock lets check, act and record be plain sequential code. |
| `SERIALIZABLE` isolation | Would detect the conflict by aborting one transaction with a `40001` the caller must retry; a pessimistic lock on one known row gives a clean 409 instead, with no retry loop. |
| A `pg_advisory_xact_lock` keyed by import id | Also correct, but it locks a number by convention; `FOR UPDATE` locks the actual row the decision is about, so the lock's scope is the thing being decided (row locks live in the tuple header, not in `pg_locks`, so they are not something you would query to debug this). |

## Where it lives in this codebase

- `server/src/db/migrations/029_ledger-core_migration_imports.sql` — `migration_imports` (the import, with its own `DRAFT/VALIDATED/COMMITTED` lifecycle) and `migration_import_rows` (one row per staged CSV line, `errors text[]` plus a `VALID/INVALID/EXCLUDED` status).
- `server/src/services/accounting/migrationImportService.ts` — `createImport` (parse + stage + initial validate), `patchRow` (apply a fix, then re-validate the whole import), `revalidateOnClient` (the shared validate-and-recompute-status routine both paths call), `commit` (the all-or-nothing dispatch to the per-kind committer).
- `server/src/services/accounting/chartImportService.ts` / `openingBalanceImportService.ts` — the per-kind `validateRows`/`preview`/`commitOnClient` halves.
- `server/src/services/accounting/bankImportService.ts` (Phase 6) — the contrasted abort-on-first-error shape this note measures against.
- `server/src/__tests__/accounting/chartImport.test.ts` — `"a chart CSV with two deliberately corrupt rows stages the rest as VALID and commits only after both are fixed"`, the named acceptance test proving the shape end to end.

- `server/src/services/accounting/importKinds.ts` — `ImportKindDef`, `IMPORT_KINDS` (`satisfies Record<MigrationImportKind, ImportKindDef>`), `getImportKind`, `listImportKindMeta`
- `server/src/utils/importColumns.ts` — `compactHeader`, `resolveColumnIndexes`, `findMissingRequired`; unit-tested in `server/src/__tests__/importColumns.test.ts`
- `server/src/services/accounting/migrationImportService.ts` — `inspectImport`, `createImport` (resolves through the registry), `commit` (the `FOR UPDATE` guard, `result` persisted before `COMMIT`)
- `server/src/db/migrations/078_ledger-core_migration_import_kinds.sql` — `column_map`, `options`, `commit_options`, `result`, `data`, `group_key`
- `server/src/__tests__/accounting/importMapping.test.ts` — `'two concurrent commits: exactly one succeeds'`, `'a second commit is 409'`, the column-map 400s, and the cross-tenant case

## Gotchas

- **Re-validating on every `PATCH` means one fix can change other rows' errors.** Fixing row A's duplicate-code error can turn row B (which shared that code) from `INVALID` to `VALID` in the same call — the client must re-read the whole row list after a patch, not just optimistically update the one row it touched. `MigrationImportDetailPage`'s `saveRow` calls a full `refresh()` rather than patching local state, for exactly this reason.
- **Staged rows are audited at the parent level only.** `migration_import_rows` carries no audit trigger — it's staging data, rewritten wholesale on every re-validate, and what it ultimately *produces* (real accounts, a real journal entry) is itself audited. Auditing every intermediate row-fix would be noise, not signal — the same call this codebase already made for `bank_match_suggestions` and `fx_revaluation_lines`.
- **A parse failure and a validation failure are different things staged identically.** A cell that fails `parseMoneyText` becomes a row with `debit_cents = NULL`, which then fails validation with the generic "row has no amount" — the raw, unparseable text is preserved in the row's `raw` JSONB for the user to see, but the distinction ("we couldn't read this" vs "we read it and it's wrong") collapses into one error message. That's a deliberate simplification for this phase, not an oversight — see the plan's Risks section.
- **`VALIDATED → DRAFT` is a real, expected backward transition**, not a bug — it's what makes "fix a row, and if it introduces a new problem, the import correctly stops being commit-eligible again" work. A transition table that only ever moved forward would be wrong for this shape.

- **A lock only serializes code that takes it.** `commit` is safe because every path to `COMMITTED` goes through that `SELECT … FOR UPDATE`. `patchRow` is a different writer of the same row; it is protected by the `409` for a `COMMITTED` import in `revalidateOnClient`, not by this lock — worth knowing which guarantee covers which writer.
- **Do the check inside the transaction, on the same client.** Moving the status read back to `pool.query` "for speed" reintroduces the race silently: the test still passes on a single request.
- **`FOR UPDATE` does not make a *missing* row safe.** A `SELECT … FOR UPDATE` that matches nothing locks nothing. That is fine here (404), but it is why "insert if absent" races need a unique constraint, not a lock.
- **`suggestedMap` is a suggestion, not authority.** The stage call re-resolves on the server; the client's `mappingProblems` is only a UX pre-check that duplicates `findMissingRequired` and the duplicate-header rule. If they ever disagree, the server wins with a 400/422.
- **A behaviour change worth stating plainly:** a chart file with no name column used to stage every row as INVALID; through the registry's `required` flags it is now a 422 at upload. `missingMessages` keeps the exact text of the old messages so the legacy tests stayed unedited.

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

**Q: You replaced three if/else chains with a registry. What do you actually gain, and what do you pay?**
A: The gain is that a kind becomes one object in one file, and the generic importer never names a kind. Adding a kind is adding an entry; the compiler, through `satisfies Record<MigrationImportKind, ImportKindDef>`, refuses to build until every kind in the `MIGRATION_IMPORT_KINDS` tuple has an entry with every strategy function. The cost is indirection (you follow `getImportKind(kind)` to find the code) and that the per-kind services now have an adapter layer whose only job is shape-normalising results. I would not do it for two kinds with stable logic; at four now and nine planned, the chains were the bug magnet.

**Q: Explain the race in the old commit and how `FOR UPDATE` fixes it. What exactly does the second request do?**
A: The old code checked the status with a plain read before `BEGIN`, so two concurrent requests could both see `VALIDATED` and both run the commit. Now the first statement after `BEGIN` is `SELECT … FOR UPDATE` on the import row. The first transaction holds the row lock; the second blocks on its own lock attempt. When the first commits, the second does not use its old snapshot of the row — under `READ COMMITTED` Postgres follows the update chain to the latest version and re-checks the `WHERE` clause against it, so the waiter reads `COMMITTED` and throws a 409 without touching any customer row. If the first had rolled back, the waiter would see `VALIDATED` and proceed. Our integration test fires two commits with `Promise.all` and asserts the sorted statuses are `[200, 409]` and exactly one `Acme` customer exists.

**Q: Why is that a *check-then-act* problem and not a transaction-isolation problem? Wouldn't wrapping the whole thing in a transaction be enough?**
A: Wrapping was not the flaw — the read was outside the transaction, but even inside one, under `READ COMMITTED` two transactions can both read `VALIDATED` from their own snapshots before either commits. A transaction gives atomicity of *your* writes, not exclusion between two readers deciding on the same fact. You need either a lock that makes the read exclusive (`FOR UPDATE`), a conditional write whose row count you check, a unique constraint, or `SERIALIZABLE` with retry. We chose the lock because the decision is about one known row and we want a clean 409, not a retry.

**Q: How does the two-pass column resolver behave when the user maps a column and the file also has a header that the synonyms would have claimed?**
A: Pass 1 runs first and claims the user's chosen header indexes, so the explicit choice always wins. Pass 2 then runs only for keys left unset, skipping indexes already claimed, so an explicit choice can never be stolen by a synonym match and a header can never feed two fields. An explicit `null` counts as "set", so the user can say "don't import this field" even when a synonym header exists. A header not in the file is a 400, because the UI only offers real headers — that would be a stale or hand-built request.

**Q: Why does `inspect` return `exactMatch` instead of the client deciding whether to show the mapping screen?**
A: Because the definition of "matches" lives with the registry and the resolver. The client would have to re-implement header compaction, required rules and the one-of sets, and could disagree with what stage actually does. The server computes it with the same code path (`resolveColumnIndexes` + `findMissingRequired` + the set of compacted template headers) and the client just skips the screen when it is true. The same reasoning is why templates come from `GET /kinds` rather than a hand-copied constant.

**Q: Tell me about a time a check was in the wrong place.**
A: The staged importer's commit. It read `status` via `pool` before opening its transaction, which is fine on a single request and broken under a double-click or a retrying client. It was spotted while planning the 36a rewrite (the plan's starting-state audit listed "checks VALIDATED via pool before BEGIN, with no row lock"); we moved the status check to a `SELECT … FOR UPDATE` as the transaction's first statement, and added a `Promise.all` concurrent-commit test. The test is the regression guard: without the lock both requests would run the kind's commit (I have not run that experiment, so I will not claim exactly what the duplicate looks like — customer import merges by email/name, so the visible symptom may be a double-counted `mergedCount` rather than two rows).

**Q: Why store the commit's outcome in a `result` JSONB column instead of a foreign key to whatever the commit created?**
A: The outcome has a different shape per kind — chart and parties produce counts, opening balances produce a journal entry id and a plug amount, later kinds will produce other things. A single FK column would have to point at different tables depending on `kind` (polymorphic), which rule 8 forbids because it cannot have a `REFERENCES`. A JSONB object with a `kind` discriminator keeps the schema stable across kinds and mirrors the TypeScript `MigrationCommitResult` union, at the price that the journal id inside it is not FK-checked; the real journal entry has its own `source_type`/`source_id` link.

## Follow-ups they'll dig into

- "What if `commitOnClient` fails halfway through creating ten new accounts?" The whole transaction rolls back — no account created in that pass persists, `migration_imports.status` is untouched (still `VALIDATED`), and the user can retry the commit once whatever caused the failure (a race with another writer, say) is resolved.
- "How is the chart importer's parent-before-child ordering different from `accountService.seedDefaultChart`'s?" `seedDefaultChart` resolves depth from one fixed, known-acyclic seed list; the chart importer's ordering resolves depth over a *mixed* set of already-existing org accounts and newly-staged file rows via repeated passes, converging because `validateRows` already proved there's no cycle and no dangling parent among `VALID` rows before commit is ever attempted.
- "Would this shape make sense for something with real-time collaborators, like a shared spreadsheet?" No — this design assumes one operator working through a queue of fixes serially, not concurrent editors; a genuinely collaborative version would need per-row optimistic locking or CRDTs, which is a different problem.

- "Does `FOR UPDATE` block the `GET` endpoints?" No. Plain `SELECT` takes no row lock and reads the last committed version under MVCC, so a list page never waits on a commit. Only other `FOR UPDATE`/`FOR SHARE` lockers and writers of that row wait.
- "What if the commit takes a minute and the client times out?" The transaction continues on the server; the client's retry blocks on the lock and then gets the 409, and the persisted `result` tells the detail page what happened. There is no partial state to clean up.
- "Why a 409 and not a 200 for the loser, since the work was done?" The loser did not do it, and the caller cannot tell from a 200 which request caused the effect. A 409 is honest, and the `COMMITTED` import's `result` is one `GET` away.

## See also

- [partial-unique-indexes.md](../postgresql/partial-unique-indexes.md) — the constraint that makes a second commit of an opening-balance import physically impossible.
- [document-lifecycle-fsm.md](document-lifecycle-fsm.md) — `MIGRATION_IMPORT_TRANSITIONS`, where `VALIDATED → DRAFT` is a deliberate backward edge.
- [idempotent-ingestion-and-dedupe-hashes.md](../postgresql/idempotent-ingestion-and-dedupe-hashes.md) — the bank importer's own idempotency mechanism, contrasted against this one's staged-fix loop.
- [../postgresql/transactions-isolation-pooling.md](../postgresql/transactions-isolation-pooling.md) — `READ COMMITTED`, row locks and the pooled-client rule the `commit` function depends on
- [../typescript/const-assertions-and-satisfies.md](../typescript/const-assertions-and-satisfies.md#phase-36a-additions--satisfies-recordkind-def-as-an-exhaustive-registry) — how the registry's exhaustiveness is enforced
- [../react/schema-driven-forms-and-print-layouts.md](../react/schema-driven-forms-and-print-layouts.md#phase-36a-additions--a-server-metadata-driven-mapper-and-row-editor) — the client that renders from this registry's metadata
