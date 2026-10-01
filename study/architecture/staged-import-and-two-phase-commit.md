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

## Phase 36b additions — typed cells in JSONB, revalidate-at-commit, a pre-transaction hook, merge vs create-only

Phase 36b added the first two **JSONB-staged** kinds (`ITEMS` — Products & Services; `INVENTORY_ITEMS` — tracked stock with opening stock) and the generic machinery every later kind reuses. **Verified against:** PostgreSQL 16 (`READ COMMITTED`), Node 22, `pg` 8; every claim below was read in the named file, and the behaviours are pinned by `itemImport.test.ts` and `inventoryItemImport.test.ts`. One number is unmeasured: only the 2-row case was timed (about 111 ms end to end); a 1000-row import, which posts 1000 opening journal entries in one transaction, has not been.

### `storage: 'typed' | 'data'` and keeping the raw text next to the parsed value

The four 36a kinds stage into **typed columns** (`account_code`, `debit_cents`, …) because their shape is fixed and the columns carry CHECKs. A kind with thirty optional columns would need thirty nullable columns that mostly stay empty, so a kind declares `storage: 'data'` and its row goes into two JSONB columns that migration 078 had already added:

- `raw` — `{ key: trimmed cell text }`, exactly what the user typed.
- `data` — `{ key: parsed value }`, produced by `parseImportCell` (`utils/importValues.ts`): money becomes integer cents, a percentage basis points, a quantity milli-units, a date an ISO string, an enum its canonical value (`SERVICE`). An empty cell and an **unparseable cell are both `null`** in `data`.

Keeping `raw` is what makes that second case recoverable. The row's error list says `Sale price "abc" is not an amount`, the edit box shows `abc` (`raw`), and the validator regenerates the error from `raw` every time (`dataRowParseErrors(columns, row.raw, dateFormat)`), so a parse error is never a value that silently became `null`. This is the 36a gotcha "a parse failure and a validation failure are staged identically" fixed for the data kinds: the distinction is now `raw` non-empty with `data` null.

`parseDataRow` (`importRowParsers.ts`) is the one generic parser; a data kind's `parseRow` is a one-liner over its column list. `migrationImportService.createImport` passes `{ dateFormat }` in and inserts `data`/`group_key` through two more `unnest` arrays (each row's object travels as a JSON string and is cast per element with `v.data::jsonb`, the same array-per-row trick as `errors`).

### Partial edits: `PATCH { values }`

A fix sends `{ values: { salePrice: '99.50' } }` — text, never a parsed number, so the server stays the only parser. `patchRow` re-parses each key with the same `parseImportCell`, then runs one UPDATE that **merges** both columns: `data = COALESCE(data, '{}'::jsonb) || $n::jsonb` and `raw = raw || $m::jsonb` (see [the JSONB note](../postgresql/jsonb-user-defined-attributes.md#phase-36b-additions--coalescedata--patch-for-partial-row-edits)). Three guards come first: a data kind refuses the legacy typed keys (`400 Edit this import with "values"`), a typed kind refuses `values`, and a key that is not one of the kind's columns is a `400 Unknown field` — the key is looked up in `def.columns` and only then placed in a JSON *parameter*, never in SQL text (rule 4). Then the normal `revalidateOnClient` runs over the whole import, exactly as for typed kinds.

### Revalidate-at-commit: a time-of-check/time-of-use gap between validate and commit

Validation happens at stage time and after every patch. The user may commit an hour later. In between, **other tables change**: an account the row names is deactivated, a product code is taken by another user, a stock item is created through the normal form. The `FOR UPDATE` lock on the import row (36a) serializes two commits of *this import*; it does nothing about the `accounts` or `items` rows the validation read. So the import's stored `VALIDATED` status is a cache of a judgement about the past.

`migrationImportService.commit` therefore, for `storage === 'data'` kinds, loads the non-EXCLUDED rows **after taking the lock and on the same client** and runs `def.validateRows` again. If any row now has errors it throws `409 N row(s) became invalid since validation — re-validate to see them`; the transaction rolls back, the import stays `VALIDATED`, and nothing has been created. The named test is `commit revalidates: an account deactivated after validation blocks commit` — it deactivates the Revenue account directly through `pool` between validate and commit and asserts the 409 and that no item exists.

This is not decoration: `itemService.assertAccount` (the domain check `createItemOnClient` runs) verifies existence, type and `is_postable` but **not `is_active`**, so without the re-run a deactivated account would pass straight through the commit. Be precise about what it does not do: it narrows the window to "between the re-validate statement and the last INSERT of this transaction" rather than closing it. A concurrent writer in that interval is caught only by whatever the domain function and the database constraints enforce (the item code's unique constraint surfaces as a 23505 that `itemImportService` maps to `409 Row N (CODE): Item code already exists`). Closing it fully would take row locks on every referenced account, which was judged not worth it for an import operated by one person.

The legacy typed kinds are not re-validated at commit: the plan scoped the re-run to `storage === 'data'` kinds so their behaviour would not move, and the `chartImport`/`openingBalanceImport`/`partyImport` tests were the regression gate and stayed unedited. Whether they deserve the same re-run is an open question, not something verified here.

### A pre-transaction hook for pool reads (rule 5)

Some commits need a value that comes from a **pool** read — inventory's suggested industry profile (`setupService.suggestedProfileFor`, which reads organisation and settings data through `pool` and accounting's `settingsService`). Doing that inside the transaction would be a stray `pool.query` inside a transaction (rule 5): it runs on a different connection, cannot see the transaction's uncommitted writes, and survives a rollback. Doing it *after* `COMMIT` is forbidden too (no post-commit work). So `ImportKindDef` gained an optional `prepareCommit?: (orgId) => Promise<ImportCommitContext>`, and `commit` does, in order:

1. `getImportById` (a pool read) to learn the kind,
2. `def.prepareCommit?.(orgId)` — the **only** pool read in the commit flow — producing `{ inventoryProfile }`,
3. `pool.connect()`, `BEGIN`, `SELECT … FOR UPDATE`,
4. `if (locked.kind !== kindRow.kind) throw new Error('import kind changed')`,
5. revalidate (data kinds), `def.commitOnClient(client, orgId, importId, createdBy, context)`.

Step 4 exists because step 1 read the kind *before* the lock. The kind column is immutable, so the check is unreachable today; it is there so a future change that makes it reachable fails loudly instead of running kind A's strategy against kind B's rows. `inventoryItemImportService.commitOnClient` throws `prepareCommit did not run` if the context is empty, and narrows the string with `isStockIndustryKey` rather than a cast.

The cost of the pattern: the profile is read once, before the lock, so it could in principle differ from what a concurrent settings change would produce by the time the first item is created. That is harmless here (it is only a *suggestion* used the first time inventory is silently set up) but it is a real property: a pre-transaction value is a snapshot, not part of the transaction's consistent view.

### Fill-blanks merge (`ITEMS`) vs create-only (`INVENTORY_ITEMS`)

Two different answers to "what if the code already exists", each chosen for what a wrong answer costs:

- **`ITEMS` merges by filling blanks.** `fillMissingItemFieldsOnClient` runs `SET col = COALESCE(col, $n)` for exactly five columns (description, both prices, both accounts). It never touches name, type or tax rates. Why those last three are excluded: a blank `SalesTaxRate` cell is indistinguishable from "0%", so "fill if blank" cannot be applied to a rate without either overwriting a real 10% with 0 or never filling anything; and a name or type change on a product already used by posted documents is exactly the kind of edit a migration import should not make silently. Re-importing the same file is therefore idempotent and safe. The test `commit fills only blank fields of an existing product` creates a product with a price but no description, imports a different name, a different price and a description, and asserts the name and price are unchanged and only the description is set.
- **`INVENTORY_ITEMS` is create-only.** An existing code is a row error pointing at the product form's Track inventory tick. Creating a stock item does more than fill a field — it creates stock-side rows, the linked product and an opening journal entry — so "merge" would mean retro-fitting inventory onto a product with history, which the product form already does deliberately and forward-only (`POST /inventory/items/from-product/:id`). The importer refuses rather than duplicate that decision.

Duplicate codes inside the file are a row error on *every* row that shares the code (`appears more than once in this file (rows 2, 5)`), because the importer, unlike a person, cannot tell which of two rows was meant.

### Where the new code lives

- `server/src/utils/importValues.ts` — `parseImportCell`, `parsePercentBp`, `parseQuantityMilli`, `suggestDateFormat`; `server/src/__tests__/importValues.test.ts`
- `server/src/services/accounting/importRowStore.ts` — `loadDataRowsOnClient`, `markCommittedOnClient`, `importDateFormatOnClient`, `importDateFormatForRowOnClient`
- `server/src/services/accounting/importRowParsers.ts` — `parseDataRow`, `dataRowParseErrors`
- `server/src/services/accounting/importAccountLookup.ts` — one `code = ANY($2::text[])` query per import, `accountCodeError`
- `server/src/services/accounting/itemImportService.ts`, `inventoryItemImportService.ts`, and their column lists `importItemColumns.ts` / `importInventoryItemColumns.ts` (split out to avoid an `importKinds` ↔ service import cycle)
- `server/src/services/accounting/migrationImportService.ts` — `patchRow`, `commit`, `inspectImport`
- `server/src/__tests__/accounting/itemImport.test.ts`, `inventoryItemImport.test.ts`

### Gotchas (36b)

- **`validateRows` receives rows, not an import id**, so a validator that needs the import's `dateFormat` cannot call `importDateFormatOnClient(importId)`. The plan assumed it could; the implementation added `importDateFormatForRowOnClient(client, orgId, rowId)` (an org-scoped join from a row to its import). The `ITEMS` validator passes `'ISO'` because it has no date column.
- **Validation is deliberately weaker than commit for some rules.** Barcode *uniqueness against existing stock* and the lot/serial opening-stock check when the Category cell is blank (the seam exposes no "default category") are only caught at commit, as a 409/422 that rolls the whole transaction back. The test `all-or-nothing: a bad barcode caught at commit rolls back every row` stages two rows, the second colliding with an existing item's barcode, and asserts the commit is 409, *neither* item exists, and the import is still `VALIDATED`. A rule checked only at commit means the user hears about it late — a real UX trade against a cross-module lookup.
- **Every thrown row error is re-wrapped with `Row N (CODE):`**, preserving the `ApiError` status, so a 422 from deep inside inventory still names the line in the file.
- **A dated column needs the format before it parses.** The same text `01/02/2026` is two dates. `dateFormat` is stored in `migration_imports.options` and read by both the parser and the patch path, and `inspect` returns `suggestedDateFormat` (see the integer-parsing note for the algorithm) so the wizard can preselect it — and refuse to stage while it is ambiguous.
- **A pre-existing bug was found:** `parseMoneyText` turned a digit-free word like `abc` into 0 (it strips a trailing three-letter currency code), and the legacy opening-balance and bank importers shared it. It was first guarded in `parseImportCell` for data kinds only, then fixed in the shared function after Phase 36 landed: letters-only text now throws, and every caller already maps that throw to a row error.

### Interview Q&A (36b)

**Q: A row was valid when you staged it. Why validate it again at commit?**
A: Because the validation read other tables, and nothing holds those rows still between "validated" and "commit". The import's stored `VALIDATED` status is a cached judgement about the past — the user may commit hours later, after someone deactivated an account the row names or created the product through the normal form. The `FOR UPDATE` on the import row only serializes commits of that import; it cannot protect rows in `accounts` or `items`. So commit re-runs `validateRows` after taking the lock, on the same client, and rolls back with a 409 if anything went stale. It is a classic time-of-check/time-of-use gap. It matters concretely here because the domain function the commit calls (`assertAccount`) checks type and postability but not `is_active`, so without the re-run a deactivated account would be accepted. It narrows the window rather than closing it; the residue is covered by domain checks and unique constraints.

**Q: Where do you do a read that needs the pool when the rest of the operation is a transaction?**
A: Before it. The rule is that inside a transaction every query uses the checked-out client, because a `pool.query` is another connection: it cannot see uncommitted work and it survives a rollback. After `COMMIT` is not allowed either, since follow-up work is queued rather than done inline. So the strategy interface has an optional `prepareCommit(orgId)` that the generic `commit` calls before `pool.connect()`, and whatever it returns is passed into `commitOnClient` as a context object. The price is that the value is a snapshot taken outside the transaction's consistent view, which is fine for a suggestion like a default industry profile and would not be fine for something the commit must agree with, such as a balance.

**Q: Why store both `raw` and `data` for each staged row?**
A: `data` is what commit uses, parsed into integers and canonical enums; `raw` is what the user typed. When parsing fails, `data` holds `null` and `raw` holds `abc`, so the UI can show the text in the edit box and the validator can regenerate `Sale price "abc" is not an amount` from it. With only the parsed value, "the user left it blank" and "the user typed something I couldn't read" would look identical. It also means a `PATCH` sends text and the server remains the only place that parses.

**Q: When should an import merge into an existing record and when should it refuse?**
A: Decide by what a wrong guess costs and whether the target field can distinguish "unset" from "zero". Products can be filled in safely — `COALESCE(col, $n)` on five columns is idempotent, and I exclude name, type and tax rates because a blank rate is indistinguishable from 0% and changing a name or type under posted documents is not something an import should do silently. Tracked inventory items are create-only because creating one has side effects (stock rows, a linked product, an opening journal) that would amount to retro-fitting inventory onto a product with history; the product form already does that as a deliberate, forward-only action, so the importer points the user there.

**Q: Tell me about a time a plan's contract was wrong and how you handled it.**
A: In 36b the plan had `validateRows` call `importDateFormatOnClient(client, orgId, importId)`, but the strategy signature receives rows, not an import id, so it could not. I did not change the interface for every kind; I added a small org-scoped helper that finds an import's date format from a row id and recorded the deviation in the plan's defect log. Two other findings went the same way: the `parseMoneyText("abc") === 0` bug, which I guarded in the new path and reported as a pre-existing defect in other importers rather than changing shared behaviour mid-step, and a hard-coded "four kinds" assertion in a 36a test that I replaced with one that tracks the exported kinds tuple, with the orchestrator's approval.

**Q: Why is the all-or-nothing commit still right when one row in a thousand fails?**
A: Because commit here writes real products, stock and journal entries, and a half-imported catalogue is worse than none: the user cannot tell which rows landed, and re-running creates duplicates or hits "already exists". Staging is where partial success is useful — bad rows sit as `INVALID` and can be fixed or excluded. Once `VALIDATED`, commit either does everything in one transaction or nothing, and a failure names the row (`Row 7 (WIDGET-02): …`). The bad-barcode test proves the atomicity: the first row is perfectly valid and still does not exist after the second fails.

### Follow-ups they'll dig into (36b)

- "Could you take row locks on the referenced accounts to close the revalidate window fully?" Yes — `SELECT … FOR SHARE` on the distinct account ids inside the transaction would block a concurrent deactivation. It was not done because an import is a one-operator action and the cost is a lock per referenced account; it would be the next step if imports ever run concurrently with heavy editing.
- "What happens to a 5000-row inventory import?" It is one transaction and each opening receipt is its own journal entry, so the cost is linear and held under one connection; the row cap (5000) is the bound. Measured only for two rows so far.
- "Why not commit in batches and resume?" Because that reintroduces partial state for exactly the data (GL entries) where partial state is hardest to reason about; you would need per-row idempotency keys and a resumable cursor, a different design.

---

## Phase 36c additions — grouped documents from flat rows (`JOURNALS`)

**Verified against:** this codebase at Phase 36c, PostgreSQL 16, Node 22. Code: `journalImportService.ts`, `importJournalColumns.ts`, `migrationImportService.ts` (`createImport`, `listRows`, `patchRow`, `setRowsStatus`), tests in `server/src/__tests__/accounting/journalImport.test.ts`.

### Mechanism: a CSV is flat, a journal is not

A journal entry is a header (date, narration) plus N lines; a CSV journal export has one row per line with the header repeated. The import has to rebuild the document from the rows. The design decision is that **the staging table stays flat** (one `migration_import_rows` row per CSV line, unchanged from 36a/36b) and the document is only a *derived grouping*, carried as one nullable column, `group_key` (migration 078, `<= 220` chars, partial index `idx_migration_rows_group`). No "documents" table was added, because a second table would need its own edit, exclude and revalidate paths and a way to keep the two in sync; a key column is a view of the rows that cannot disagree with them.

**How the key is derived.** `journalGroupKey(values, raw)` returns `'N:' + upper(journalNumber)` when a number is present, else `'D:' + date + '|' + lower(narration).slice(0, 200)`, else `null` (all three blank). The two prefixes keep the namespaces apart: a number `2026-06-30|rent` cannot collide with a Date+Narration key. It prefers the parsed `values` but falls back to the `raw` text (date truncated to 15 chars), so a row whose date *failed* to parse still lands in a sensible group and its error message names the right entry instead of vanishing into a singleton.

**Where it is computed.** The registry entry declares an optional `groupKeyOf` hook (and a `groupNoun`). `createImport` calls it for every parsed row before the `unnest` insert, counts distinct non-null keys and refuses above `MAX_IMPORT_DOCUMENTS` (1000) with a 422. `patchRow` **re-derives the key on every edit that sends `values`**: after the `data || patch` UPDATE it re-reads the row's `data`/`raw` *on the same client* and writes `group_key` back with `WHERE id AND org_id AND import_id`, before `revalidateOnClient`. The order matters — revalidation groups rows by the stored `group_key`, so a stale key would validate the wrong documents. It skips the recompute when only `status` is patched, since status cannot change a key (an accepted plan defect: the contract said "always", the code does "when values is sent").

**Validation has two levels, and both report on rows.** The staging table has no document rows, so an entry-level problem must be attached to the rows the user can see. `validateRows` runs per-row checks first (parse errors, required cells, one side per line, account exists/postable, control-account refusal), then per-group checks whose message is pushed onto **every** row of the group: fewer than two lines, debits ≠ credits (integer sums of cents), closed or locked period. One group check is deliberately per-row instead: in a *numbered* journal, a row whose date or narration differs from the first row's gets the error itself (`Date differs from row 4 (…)`), because blaming all five lines for one typo'd date would hide which line to fix. In a Date+Narration group the check is skipped — equal date and narration are the key, so they cannot differ. The balance check is only run when *every* row in the group has a resolved side; otherwise one unparseable amount would produce a bogus "does not balance" on top of the real error.

**Commit re-groups from storage, not from memory.** `commitOnClient` reloads the rows with `loadDataRowsOnClient`, recomputes keys with the same function and groups in first-row order, then posts one `createEntryOnClient` call per group on the locked transaction client with `sourceType 'migration_import'` and `sourceId` = the import id. A thrown `ApiError` is re-wrapped as `The <label> (rows a–b): <message>` with its status preserved. Everything — all entries and the `COMMITTED` mark — commits or rolls back together; the period-closed-after-validation case is covered by the revalidate-at-commit guard from 36b (test: `revalidate at commit: a period closed after validation blocks commit`).

**Bulk status.** Exclude/include a whole journal is `POST /:id/rows/status` with `rowIds`. It takes the import row lock (`SELECT … FOR UPDATE`, same guard as commit, so a bulk edit cannot interleave with a commit), runs one `UPDATE … WHERE id = ANY($4::uuid[])` with `org_id` and `import_id` in the predicate, and compares `rowCount` against `new Set(rowIds).size`. That comparison *is* the tenancy and membership check: an id from another import or org simply does not match the predicate, the count falls short, and the request is a 404 — no per-id existence queries. Then it calls `revalidateOnClient`, because excluding an unbalanced journal should flip the import to `VALIDATED` and because setting `VALID` only puts the row back in the queue; the validator assigns its real status.

### Xero's Date+Narration grouping: an implicit key and its collision risk

Xero's manual-journal CSV has no journal number; rows belong together because they share Date and Narration. That is a **natural key with no uniqueness guarantee**: two genuinely different entries on 30 June both narrated "Accrual" are indistinguishable from one entry, and the importer merges them. Worse, the merged group often still *balances* (two balanced entries sum to a balanced one), so nothing flags it — the user just gets one entry with four-plus lines instead of two. Mitigations chosen: the guide recommends `JournalNumber` and says why; the number, when present, always wins; and the preview shows "Journal entries to post: N", so a wrong count is visible before commit. Not chosen: adding a positional rule ("a new group starts when a balanced run closes"), which would be smarter but makes the grouping depend on row order and on arithmetic — an edit to one amount would silently re-split groups. The narration is lowercased and cut at 200 characters in the key (two narrations identical for 200 chars on the same date merge; accepted).

### Why a document cap exists (`MAX_IMPORT_DOCUMENTS = 1000`)

Commit is one transaction: for each entry it checks the control accounts, the period, inserts the header and lines, and the deferred balance trigger fires at `COMMIT` for every entry at once. Row count (`MAX_IMPORT_ROWS = 5000`) does not bound that work, because one row can be one document (single-line "journals" are all invalid, but invoices in 36d are many lines per document with heavier side effects). The cap is on *documents* so the transaction's size, lock hold time and the pooled connection it pins are bounded by the thing that costs. It is enforced at staging, before any row is written, with the user's own noun ("1001 journals"). Measured: 200 two-line journals committed inside a 60 s test limit; 1000 has **not** been timed — the number is a bound chosen conservatively, not a measured limit.

### Rejected alternatives (36c)

| Option | Why not |
|---|---|
| A `migration_import_documents` table | A second source of truth to keep in sync with rows on every edit and exclude |
| Group in the client | Validation, preview counts and commit all need the grouping server-side |
| Recompute the key at read time only (no column) | `listRows` orders and pages by it in SQL; it would need the derivation in SQL too |
| Post journals as they validate (per-document commit) | Reintroduces partial state for GL entries (see 36b follow-ups) |
| Reject a file whose groups collide | Cannot be detected — the collision is the ambiguity |

### Gotchas (36c)

- A stale `group_key` after an edit is a silent wrong-document bug, not an error. The regrouping test (`editing a JournalNumber regroups the row`) checks the key *and* the listing order.
- The key must be computed by exactly one function shared by staging, patching, validation and commit; `journalImportService` calls `journalGroupKey` again from `values`/`raw` on commit rather than trusting the stored column, which keeps commit correct even for a row staged before a future key change.
- `setRowsStatus` with `VALID` does **not** make a row valid; a row with errors comes straight back as `INVALID` after the revalidate. "Include" means "stop excluding".
- Error text interpolates user cell values (journal number, narration). The UI renders it as React text, so it is escaped; do not ever render it as HTML.

### Interview Q&A (36c)

**Q: A CSV has one row per journal line, but you post one entry per journal. Where does the document come from, and why is it not a table?**
A: It is derived. Each staged row carries a nullable `group_key` computed by a per-kind hook: the journal number if present, otherwise date plus lowercased narration. Validation, listing, preview counts and commit all group by that one column. I kept staging flat because a documents table would need its own edit, exclude and revalidate paths and could drift from the rows; a key column can only ever be a function of the rows. The cost is that the key must be recomputed whenever a row's inputs change, which is why `patchRow` rewrites it on every edit that sends values and does so before revalidating.

**Q: Where should an error about a whole entry, such as "does not balance", be shown when the UI shows rows?**
A: On every row in the group, so whichever line the user looks at shows it and the import's error count is nonzero until the group is fixed. The exception is an error that identifies a specific offending row, like a date that differs from the entry's first line: that goes only on the differing row, otherwise the user has to diff five lines to find the typo. I also skip the balance check when any row's amount failed to parse, because the real error is already shown and a computed "does not balance" would be noise.

**Q: Xero exports journals with no ID, grouped by date and narration. What is the failure mode of importing that?**
A: It is an implicit natural key with no uniqueness guarantee. Two distinct entries with the same date and narration merge into one, and since each balanced entry balances, the merged one balances too, so no validation fails. The defences are to prefer an explicit journal number when one exists, to recommend it in the guide, and to show the entry count in the preview so a count of 1 when the user expects 2 is visible before posting. I rejected a "new group when the running total returns to zero" heuristic because it makes grouping depend on row order and arithmetic, so editing one amount could silently change the grouping.

**Q: Why cap documents instead of rows?**
A: Commit is a single transaction whose cost scales with documents: per-document period and account checks, inserts, and a deferred balance trigger firing at commit. A row cap does not bound that, because rows per document vary. The cap is checked at staging so nothing is written, and the error names the noun the user sees. I have not measured the 1000-document commit (200 was fine); I would say so rather than call the number tuned.

### Follow-ups they'll dig into (36c)

- "What if the entry count makes the transaction too long?" Split into smaller imports (the error message says so) or, as a redesign, per-document idempotency keys plus a resumable cursor; that trades the atomicity you want for GL data.
- "Why does bulk exclude lock the import row?" So it serialises with commit, which takes the same `FOR UPDATE`; otherwise a status flip could land between commit's revalidate and its post.
- "Can the group key contain user input safely in SQL?" It is only ever a bound parameter or an array element in `unnest`; it is never interpolated (rule 4).

## Phase 36d additions — one transaction for draft-or-post, and conversion mode

**Verified against:** this codebase at Phase 36d, PostgreSQL 16 (`READ COMMITTED`), Node 22. Code read: `migrationImportService.ts` (`commit`, `createImport`), `documentImportCore.ts`, `invoiceImportService.ts`, `billImportService.ts`, `invoiceService.ts`; behaviour pinned by `invoiceImport.test.ts` and `billImport.test.ts`. Not verified: a 1000-document posting import has not been timed, and a stock-short or lot/serial failure is caught only at commit (one wrapped error, full rollback).

### Which choices belong at staging and which at commit

The user makes two separate decisions, and they live in different places for a reason.

- **Conversion mode is a staging option** (`options.conversionMode` in `migration_imports.options`, set by `createImport`, read back by `importOptionsOnClient`). It changes **what is valid**: line accounts resolve to 3400 instead of a revenue/expense account, tax must be 0, `ItemCode` is refused, and every document must be dated on or before the conversion date. Anything that changes validation has to be known when rows are validated, so it cannot wait for commit. It is refused with a 400 for a kind with `supportsConversionMode: false`.
- **Draft vs post is a commit option** (`POST /:id/commit` body `{ mode, postingDate }`, recorded in `migration_imports.commit_options`). It does **not** change which rows are valid; it changes what the commit does with valid ones, so the same staged file can be committed either way. The one validation-like consequence — "the period covering the posting date is closed" — is computed by the **preview**, which accepts `?mode=POST&postingDate=…`, so the UI can show it and set `canCommit = false` before the user presses the button.

`commit` validates the options **before `BEGIN`**, with pure checks on values it already has (no reads, so rule 5 holds): a kind with no `commitModes` and any option → 400 `This import kind has no commit options`; conversion mode with `DRAFT` → 400 `Conversion-mode imports are always posted`; conversion mode with a `postingDate` → 400 (it posts on the conversion date); `DRAFT` with a `postingDate` → 400 `A posting date applies only when posting`. Otherwise `mode = body.mode ?? 'DRAFT'` — **drafts are the default**, so an omitted body (every pre-existing caller sent `{}`) cannot post anything by accident. The effective `{mode, postingDate}` is written to `commit_options` in the **same `UPDATE`** that stores `result`, inside the transaction, so the record of "how was this committed" can never disagree with what was committed.

### Draft vs post is one transaction either way

`commitOnClient` resolves every document with `resolveDocumentsOnClient` (the same function validation and preview use, so a document that previews clean is the one that commits; a mismatch between group count and resolved-document count throws as a backstop), then for each document in first-row order calls the **existing document services on the transaction client**: `createInvoiceOnClient`, and in POST mode `issueInvoiceOnClient` (bills: `createBillOnClient`, `approveBillOnClient`). Both modes run the same function; POST is just one more call per document. That reuse is the point: issue and approve already own the FX rate, the stock receipt/issue and COGS, the number, the period check, the journal entry and the webhook event, and already pass through their lifecycle transition tables (rules 6 and 10). The importer never writes a status or a journal line itself, so there is no second implementation of "what posting an invoice means" to drift.

The consequence is all-or-nothing across the whole file: if document 37 of 40 fails — a closed period, a missing FX rate for its date, a short stock issue — the transaction rolls back the 36 invoices already issued, their journals, their stock movements, the advanced invoice counter and the import's own `COMMITTED` mark. The test `post with a posting date in a closed period: preview blocks, commit rolls back everything` asserts exactly that: preview says `canCommit: false` with the period warning, a forced commit is refused, **no invoice exists** and the import is still `VALIDATED`. An `ApiError` thrown from inside is re-wrapped with the document and the file rows (`Invoice INV-9001 (rows 4–6): …`), preserving its status; a `23505` on `ux_invoices_org_number` / `ux_bills_vendor_reference` becomes a 409 naming the same rows.

Order inside a posted invoice import: the **counter advance first** (see [the numbering note](../postgresql/gapless-numbering-and-counters.md#reserving-numbers-someone-else-already-chose-and-advancing-the-counter-past-them-phase-36d)), then the create/issue loop.

### Conversion mode: historical open items vs the opening trial balance

**The accounting problem.** A business switching systems mid-year has two kinds of history. The *opening trial balance* at the conversion date already contains the cumulative effect of everything before it — including the revenue earned on invoices the customer has not yet paid. But the new system also needs the **individual open invoices** (who owes what, due when) so it can chase them, apply payments to them and age them. If those invoices are imported as ordinary posted invoices they post **DR Accounts Receivable / CR Revenue**, and the revenue is counted twice: once inside the opening balances, once as new year-to-date revenue.

**The design.** A conversion-mode document posts **DR Accounts Receivable / CR 3400 Opening Balance Equity** (bills: **DR 3400 / CR Accounts Payable**), dated on the conversion date (`books_start_date`), tax 0, no products. That creates the receivable the payment-application machinery needs without touching any P&L account, so year-to-date revenue stays whole (test: P&L revenue 0 after the import). 3400 is the account the opening-balance importer already uses for its balancing line: it posts `plug = Σdebits − Σcredits` of the uploaded trial balance to 3400. If the user's trial balance **omits** the AR/AP lines (because the documents will carry them), the file is short by exactly that amount, the plug debits 3400 for it, the document import credits 3400 by the same amount, and **the two net to zero**. That is the property to be able to explain: 3400 is a holding account whose balance after both imports should be nil.

What the test actually pins, honestly: `conversion mode posts to 3400 on the conversion date and nets the opening plug` commits a balanced trial balance (cash 1000 / equity 1000, so the plug is 0), imports a 500.00 invoice dated 2025-12-22 and asserts the invoice is `ISSUED`, its journal `entryDate` is 2026-01-01, revenue is 0 and 3400's net is a credit of 500.00 — the invoice's half of the netting. It does not run an opening import that omits AR and then assert 3400 = 0; that composition follows from the arithmetic above and the plug code but is **my reading, not a test**.

**Why the document keeps its own dates.** The invoice's issue and due dates are the file's (2025-12-22, 2026-01-21); only the *journal* is dated on the conversion date, because the books before the conversion date are not this system's and a journal there would either hit a closed period or restate history. See [the ageing note](../postgresql/subledger-reconciliation-and-aging.md#a-document-keeps-its-own-dates-while-the-gl-posts-on-the-conversion-date-phase-36d) for why this does not break reconciliation.

**Guards that make the mode safe.** Tax must be 0 (`import the amount outstanding including tax`) because splitting tax would post a liability that is also inside the opening balances; `ItemCode` is refused because a product line would receive or issue stock, double-counting what the stock import already brought in; documents dated *after* the conversion date are refused because they are not opening items. The reverse mistake — a user importing carried-over balances in *normal* mode — cannot be detected from the data, so the preview warns when any document is dated before the conversion date and tells the user to restage with conversion mode on. The FX rate for a foreign-currency document is taken at the posting date (the conversion date), as `issueInvoiceOnClient` always does; documented, not changed.

### Rejected alternatives (36d)

| Option | Why not |
|---|---|
| Separate "create drafts" and "post them" endpoints | Two transactions: a failure on the second leaves a half-posted set and the user has to work out which. One transaction makes failure atomic |
| Write the journal lines directly in the importer | A second implementation of posting (FX, stock, COGS, numbering, periods, events) that must be kept in step with the real one; reusing issue/approve costs a call |
| Make mode a staging option like conversion mode | Mode does not affect validity; it would force a re-stage to change one's mind |
| Default mode `POST` | A forgotten option would post to the ledger irreversibly (rule 6: posted documents can only be reversed) |
| Post conversion documents to revenue and add a correcting entry | Revenue is wrong in every interim report, and the correction has to be reconstructed |
| Auto-detect "this is an opening item" from the date | A pre-conversion date can also be legitimate history the user wants counted; guessing silently alters the P&L, so the user chooses and the preview warns |

### Gotchas (36d)

- **Option checks before `BEGIN`, rollback after.** The 400s for bad option combinations never open a transaction; everything else shares one.
- **An omitted body must mean DRAFT.** Existing callers send `{}`; the default is the safe one.
- **The preview's period check and the commit's are two looks at the same fact.** A period closed between them is caught at commit (the issue fails, everything rolls back); the preview only helps the user avoid it.
- **The conversion-mode 3400 line is accepted by an allowance, not by weakening the check.** `assertRevenueAccounts`/`assertExpenseAccounts` take an optional `allowAccountId`; only the importer passes it, and only the id of 3400. Every other caller keeps the two-argument form.
- **Stock problems surface at commit, not at validate** (lot/serial items, a short issue): one wrapped error, full rollback — the same trade 36b accepted for barcodes.

### Interview Q&A (36d)

**Q: The same staged file can be committed as drafts or posted. Where do you put that choice, and why not at staging?**
A: At commit, because it does not change which rows are valid — only what happens to them — and putting it at staging would force a re-stage to change one's mind. Conversion mode is the opposite: it changes validation (accounts, tax, items, dates), so it has to be a staging option. The commit options are validated before `BEGIN` with pure checks, the default is drafts so an empty body cannot post, and the chosen options are stored with the result in the same UPDATE.

**Q: How do you make "post forty invoices" atomic without reimplementing posting?**
A: One transaction on one checked-out client, calling the existing `createInvoiceOnClient` and `issueInvoiceOnClient` per document. They already own FX, stock, numbering, the period check and the journal, and they enforce the lifecycle, so the importer has no posting logic of its own. A failure anywhere rolls back every earlier invoice, journal, stock movement and the counter advance together; I test that with a closed period and assert no invoice exists and the import is still validated.

**Q: A user is moving to your system mid-year with unpaid invoices. Why would importing them normally be wrong, and what does conversion mode do?**
A: Their opening trial balance already includes the revenue those invoices represent, so a normal import posts it again as year-to-date revenue. In conversion mode each invoice posts DR AR / CR 3400 Opening Balance Equity on the conversion date instead of CR Revenue, with its own issue and due dates, tax 0 and no product lines. That gives the receivable for payment application and ageing without touching the P&L. 3400 is the account the opening-balance import plugs into, so when the trial balance omits AR the plug and the invoice entries offset. My tests pin the invoice half of that offset; the omitted-AR composition is arithmetic, not a test.

**Q: Why can't the importer detect that an invoice is an opening item because it predates the conversion date?**
A: Because a pre-conversion date is equally what legitimate history looks like, and guessing wrong silently changes the P&L or double-counts it. So the user chooses, and the preview warns — "N documents are dated before your conversion date; if they are balances carried over, restage with conversion mode on" — which makes the mistake visible without guessing.

**Q: Tell me about a design where you reused existing services instead of writing new SQL, and what it cost you.**
A: The invoice and bill importer. Posting goes through `issueInvoiceOnClient` and `approveBillOnClient`, so FX, stock, numbering and period rules came for free and cannot drift. The costs were a small number of hooks into those live paths — an optional reserved invoice number, and an allow-one-account parameter so 3400 passes the revenue/expense type check — each written so the default is byte-identical for every other caller, with the existing tests running unedited as the proof. The other cost is that some failures (stock short, a lot-tracked product) only show at commit.

### Follow-ups they'll dig into (36d)

- "What if a 1000-document posting import is too slow?" It holds a connection and the invoice-number row lock for the whole transaction; the 1000-document cap bounds it, and I have not timed it. The redesign would be per-document idempotency and a resumable cursor, which gives up atomicity for GL data.
- "Why not validate the closed period at staging?" The posting date is chosen at commit, so there is nothing to check yet; the preview takes it as a parameter.
- "What stops a user from committing a conversion import twice?" The same `FOR UPDATE` on the import row as every kind; the second request sees `COMMITTED` and gets a 409.

## See also

- [partial-unique-indexes.md](../postgresql/partial-unique-indexes.md) — the constraint that makes a second commit of an opening-balance import physically impossible.
- [document-lifecycle-fsm.md](document-lifecycle-fsm.md) — `MIGRATION_IMPORT_TRANSITIONS`, where `VALIDATED → DRAFT` is a deliberate backward edge.
- [idempotent-ingestion-and-dedupe-hashes.md](../postgresql/idempotent-ingestion-and-dedupe-hashes.md) — the bank importer's own idempotency mechanism, contrasted against this one's staged-fix loop.
- [../postgresql/transactions-isolation-pooling.md](../postgresql/transactions-isolation-pooling.md) — `READ COMMITTED`, row locks and the pooled-client rule the `commit` function depends on
- [../typescript/const-assertions-and-satisfies.md](../typescript/const-assertions-and-satisfies.md#phase-36a-additions--satisfies-recordkind-def-as-an-exhaustive-registry) — how the registry's exhaustiveness is enforced
- [../react/schema-driven-forms-and-print-layouts.md](../react/schema-driven-forms-and-print-layouts.md#phase-36a-additions--a-server-metadata-driven-mapper-and-row-editor) — the client that renders from this registry's metadata
- [../postgresql/gapless-numbering-and-counters.md](../postgresql/gapless-numbering-and-counters.md#reserving-numbers-someone-else-already-chose-and-advancing-the-counter-past-them-phase-36d) — reserving an imported invoice number and advancing the counter with `GREATEST` before the create/issue loop.
- [../postgresql/subledger-reconciliation-and-aging.md](../postgresql/subledger-reconciliation-and-aging.md#a-document-keeps-its-own-dates-while-the-gl-posts-on-the-conversion-date-phase-36d) — why conversion-mode documents still age and reconcile.
- [double-entry-as-an-invariant.md](double-entry-as-an-invariant.md) — validating balance before the deferred trigger, and the shared control-account refusal map the journal import reuses.
- [../postgresql/window-functions-and-running-totals.md](../postgresql/window-functions-and-running-totals.md) — the `MIN(row_number) OVER (PARTITION BY …)` ordering that keeps a group's rows together.
