---
name: code-planner
description: Turn an approved plan-mode plan — or a bare description of what to build — into an ordered, file-by-file AutoLedger build plan detailed enough for a smaller model to execute step by step without judgment calls. Every step names its files, its verbatim contract, the skill that executes it, the guardrails it must satisfy, the command that proves it worked, and the model tier ([Haiku] or [Sonnet]) that should execute it, with a dispatch manifest batching the steps by tier. Use before starting implementation, when a plan needs breaking into modules and steps, or when asked how to build something.
---

# Planning a build

This skill produces **the plan, not the code**.

The plan is written **for an executor that is not in this conversation** — a smaller, cheaper model in a fresh session with no memory of the discussion that produced it, and in practice a *mix* of models: each step is tagged with the tier that should run it (§5). That single constraint drives every rule below. The executor cannot ask what you meant, cannot infer the decision you made and did not write down, and when it hits ambiguity it will guess — usually by taking the shortcut that a guardrail exists to prevent.

So the bar is not "a competent engineer could follow this". The bar is: **every step is executable with no decisions left in it**, and a step that fails loudly is better than a step that invites improvisation.

A plan that says "implement journal entries" is worthless — that is the input, not the output.

## Two entry points

**After plan mode.** The approved plan is already in context. The product decisions are settled — do **not** reopen them. Your job is conversion: plan-mode output describes *what and why*, this skill produces *in what order, in which files, under which rules*. If the approved plan violates a hard rule in [CLAUDE.md](../../../CLAUDE.md), say so in one line and plan the compliant version.

**From a description.** No plan exists yet. Before planning, restate the ask in one sentence, list the assumptions you are making, and ask **at most one** blocking question — only if two readings would produce materially different plans. Then plan under stated assumptions rather than stalling.

Either way, **you** do the thinking now so the executor does none of it later. Every decision you defer becomes a coin flip at execution time.

## 1. Ground the plan in what exists

Docs describe target state. The filesystem is the only authority on what is built — [CLAUDE.md](../../../CLAUDE.md) says to assume nothing in `docs/` exists unless verified.

```bash
ls server/src/db/migrations/ server/src/services/ server/src/routes/ server/src/__tests__/
ls server/src/config/apps.ts client/src/apps/ 2>/dev/null
ls client/src/Pages/ client/src/context/ 2>/dev/null
ls study/*/
git status --short
```

Check `server/src/config/apps.ts` for the app's slug and `status` — a plan for an app still `'planned'` is a plan to flip that to `'building'` as part of its own scope, not an assumption that it already is.

Then **read the closest existing analogue in full** — `authService.ts` and `organizationService.ts` for a service, `routes/organizations.ts` for routes, `001_organizations_and_users.sql` for a migration. You are about to tell the executor to copy these patterns, so you must know what they actually contain.

Open the plan with a short **Starting state** — what exists that this work builds on, and what it does not. Every later step may assume only what appears there.

## 2. Gate check — before decomposing anything

Read [docs/roadmap.md](../../../docs/roadmap.md).

- Which phase — and which app — does this work belong to?
- Are its prerequisite phases actually built, verified in step 1?
- Does it depend on a gated phase? Phase 7 (background jobs) gates 10 (AP-Flow), 15 (BoardDeck Automator), 16 (TaxGuard AI), 17 (QuickBooks). Phase 12 (FP&A Engine) gates 13 (ForecasterPro). Phase 4 (LedgerCore live statements) gates 9, 12 and 14. Phase 8 (FX engine) gates 11 (AP-Flow posting). Phase 9.5 (Document Vault) gates 10.

If a prerequisite is missing, **stop and say so**. Then offer the largest slice that *is* legal today, and name the blocked remainder as a separate future plan. Do not plan across a gate and leave the reader to discover it.

Also carry forward any debt the roadmap assigns to this phase — e.g. Phase 3 owes the default chart of accounts **and a backfill** for organizations registered during Phases 1–2. Unpaid roadmap debt is a step in the plan, not a footnote.

## 3. Decompose into slices

A slice is a **vertical** cut that ends green: migration through route through test, shippable on its own. Never a horizontal one ("all migrations", then "all services", then "tests at the end") — that is how a module reaches step 7 with SQL in a controller.

- Each slice gets a one-sentence outcome. If you cannot write that sentence, it is two slices.
- Order slices by hard dependency only: a table before the service that reads it, an API before the page that calls it.
- A slice that touches money, tenancy, or posting to the GL is its own slice — never bundled into a CRUD slice.
- Slices that could run in parallel: say so explicitly.

Within a slice, step order is fixed by the `new-module` skill:

**migration → types → service → controller → routes → mount → tests → docs → client**

**Size each step to one sitting:** one file, or a tight group of files that share a single proof command. If a step touches more than about three files, or needs two unrelated commands to verify, split it. A large step is where a weaker executor loses the thread and starts inventing.

### Every slice opens with a name registry

The single highest-value thing you can give the executor. Fix every identifier **once**, and every later step uses it verbatim:

```markdown
**Names — use exactly these, do not rename:**
| Kind | Name |
|---|---|
| App slug | `ledger-core` (from `server/src/config/apps.ts`) |
| Table | `accounts` |
| Columns | `id, org_id, code, name, type, parent_id, is_active, created_by, created_at, updated_at` |
| Type | `Account`, `AccountType` in `server/src/types/ledger-core.ts` |
| Service file / exports | `services/ledger-core/accountService.ts` → `listAccounts`, `createAccount`, `getAccountById` |
| Controller exports | `controllers/ledger-core/accountController.ts` → `list`, `create`, `getOne` |
| Route base | `/api/v1/ledger-core/accounts` |
| Test file | `server/src/__tests__/ledger-core/accounts.test.ts` |
```

Without this, step 4's controller imports `getAccount` while step 3's service exported `getAccountById`, and the executor "fixes" it by writing a second function.

## 4. Write each step in this shape

This is the deliverable. Every step, no exceptions:

```markdown
### Step 3 — [Sonnet] `accountService` with org-scoped list and create

- **Model:** [Sonnet] — tenant-scoped SQL the whole module's isolation depends on (§5)
- **Depends on:** Step 1 (migration applied), Step 2 (types)
- **Skill:** new-module (service layer)
- **Read first:** `server/src/services/organizationService.ts` — copy its structure,
  its `ApiError` usage, and its `pool.query<T>()` row typing exactly.
  Imports carry the `.js` extension (`../utils/apiError.js`) — this is ESM, it will not build without it
- **Files:** `server/src/services/accountService.ts` (new)
- **Contract — write these signatures literally:**
  ```ts
  export async function listAccounts(orgId: string): Promise<Account[]>;
  export async function createAccount(
    orgId: string,
    createdBy: string,
    input: { code: string; name: string; type: AccountType; parentId: string | null }
  ): Promise<Account>;
  ```
  `listAccounts` → `SELECT ... FROM accounts WHERE org_id = ${1} ORDER BY code ASC`.
  `createAccount` → single `INSERT`, `org_id` from the `orgId` argument only.
  On duplicate `(org_id, code)` catch Postgres error code `23505` and throw
  `new ApiError(409, 'Account code already exists')`.
- **Guardrails:** #1 `org_id = ${1}` in every statement · #2 no `req`/`res` in this file ·
  #4 parameterized only · #8 `parent_id` validated against the same org
- **Proof:** `cd server && npm run typecheck` exits 0, and
  `grep -c "org_id" server/src/services/accountService.ts` ≥ one per statement
- **If it fails:** type error → fix the type, never `as any` or `@ts-ignore`.
  Do not proceed to Step 4 until `npm run typecheck` is clean.
- **Owes:** nothing yet — docs land in Step 8
```

> **Why `${1}` and not `$1` above:** skill arguments are substituted into this file as plain text before you read it, so a literal `$1` gets overwritten by the first word of the invocation — a SQL example that silently reads `WHERE org_id = bravo`. `${1}` survives. **In the plan you write, use the real `$1`, `$2`** — the plan file is not argument-substituted.

Rules for filling it in:

- **Model** — `[Haiku]` or `[Sonnet]`, per §5, in **both** the step heading and the field. The heading tag is what a dispatcher greps for; the field carries the one-clause reason so a reviewer can challenge it.
- **Depends on** — the step numbers whose output this one consumes. Lets the executor confirm it is in the right place and stops out-of-order starts.
- **Read first** — one to three real files to open before writing, ideally the closest existing analogue. "Mirror `organizationService.ts`" is worth more to a weaker model than three paragraphs of description, because the repo's conventions are already in that file.
- **Files** — real paths, marked `(new)` or `(edit)`. For `(edit)`, name the function or block to change. A step with no file paths is not a step, it is a wish.
- **Contract** — **write it out literally, copy-pasteable**: the actual signatures, the actual column list, the actual route table with methods and status codes, the actual error message strings. Do not describe the shape and hope. Services take `orgId` first; money fields are `*Cents: number`.
- **Guardrails** — cite the numbered rules from [CLAUDE.md](../../../CLAUDE.md) that actually bite *here*. Not all sixteen — the two or three a tired executor would get wrong in this specific file.
- **Proof** — the exact command plus the expected result. "Tests pass" is not a proof; `npm test -- accounts` with a named cross-tenant 404 assertion is. Every step needs one it can run *before* the next step begins.
- **If it fails** — the sanctioned recovery, and the forbidden ones (see §7). This field is what keeps a stuck executor from routing around a guardrail.
- **Owes** — the doc and study-note obligations this step creates, paid in the same step.

## 5. Assign a model tier to every step

Steps are dispatched to different models: cheap-and-fast for transcription, stronger for judgment. Tag **every** step `[Haiku]` or `[Sonnet]` so the work can be batched by tier and run under the right model without re-reading the step to decide.

The tier is not a difficulty rating. It answers one question: **has this step's thinking already been done in the plan, or does it still have to happen at execution time?** A step Haiku can run is one where the plan already contains the signatures, the SQL, the column list, the status codes and the file to copy — the executor is transcribing a decision, not making one.

**Use `[Haiku]` for:**

- One new isolated file whose contract is written out literally and whose analogue file is named — a `types/` module, an FSM transition table transcribed from the plan, a controller that only validates input and calls a service, a `routes/` file, the mount edit in `app.ts`.
- Unit tests for a function whose behaviour the plan states, with the case names and expected values already listed.
- Docs, type definitions, schema-doc blocks, env templates, `apps.ts` registry rows — transcription of facts already decided (an `api.md` route row, a `schema.md` table block, a `roadmap.md` status line).
- Routine boilerplate: a CRUD service whose queries appear verbatim in the plan, a client component rendering a response whose shape the plan gives.
- Mechanical repetition across many files: a rename, adding `.js` to imports, the same small edit in N places.

**Use `[Sonnet]` for:**

- Interconnected changes across 3+ modules, or crossing a directory or app boundary.
- **Migrations** — always. Rule #13 makes them unrepairable in place; a wrong one costs a second migration and a doc correction.
- Auth, RBAC, sessions, tokens, encryption, and any step that decides or changes how `org_id` is derived or enforced.
- Money arithmetic: FX, settlement, allocations, valuation, aging, balance invariants, rounding.
- Double-entry posting, GL side effects through `source_type`/`source_id`, transaction boundaries, lock ordering, concurrency.
- Integration tests against real PostgreSQL — cross-tenant isolation, trigger firing, constraint enforcement, migration idempotency, ROLLBACK paths.
- Debugging: any step whose real input is "whatever the previous step produced and why its proof failed".
- `guardrail-review`, `docs-sync`, and `study-note` — each is a verification or accuracy task, not a transcription one. A study note needs mechanism-level depth and must be right; a synced doc is worthless if it is confidently wrong.
- Any step whose contract you could **not** write out literally. That is a Sonnet step *and* a defect in the plan — try to fix the plan first.

**Tie-breaks, in order:**

1. A step matching both lists is `[Sonnet]`.
2. A step whose mistakes are irreversible or silent — a migration, a money column, a tenancy predicate — is `[Sonnet]` even if it touches one file.
3. If you cannot name the exact file to copy the pattern from, it is `[Sonnet]`.
4. Unsure → `[Sonnet]`. Haiku is an optimisation; a Haiku step that goes wrong costs more to unpick than it saved.

**Two rules that shape the decomposition, not just the labels:**

- **Split before escalating.** If a step is `[Sonnet]` only because one part of it needs judgment, split that part out and let the rest be `[Haiku]`. Prefer splitting over one large mixed step.
- **Never split a transaction boundary or an invariant across tiers.** Work that must commit together, or a service and the constraint that proves it, stays one step under one model. §3's slice rules still win: a step is still sized to one sitting with one proof command.

**Escalation is the sanctioned recovery.** Add this to the plan's execution rules: if a `[Haiku]` step fails its proof twice, stop per §7 and re-dispatch **that same step, unchanged** to Sonnet with the failure output — do not loosen the step, the test or the guardrail to get it through. Note the escalation in the plan file so the tiering can be corrected next time.

## 6. Leave no decisions in the plan

Read each step back and ask: *is there any point where the executor must choose?* If yes, choose it now and write the choice down.

These words are a bug in a plan. Each one is a decision you failed to make:

> "appropriate", "as needed", "handle errors", "etc.", "and so on", "similar to the others", "if applicable", "consider", "make sure to", "proper validation", "the usual pattern"

Replace each with the literal thing: the exact status code, the exact error message, the exact column list, the exact file to copy.

Specifically, never leave these implicit — a weaker model will invent them, and the inventions will not match:

- **HTTP status codes** for success and every failure path, per [docs/api.md](../../../docs/api.md).
- **Response JSON shape**, including the `success` envelope and the key each resource sits under.
- **Validation rules** per field — required, type, length, allowed values — and the message on failure.
- **Role sets** per route: `requireRole('OWNER', 'ADMIN')`, written out.
- **Test case names and their expected values**, not "test isolation" but "`GET /accounts/:id` with org B's id under org A's token → `404`".
- **Exact column names and types** in the migration, and the same names again wherever a query touches them.

## 7. Failure handling and stop conditions

State this once at the top of the plan, so it governs every step:

> **If a proof command fails twice on the same step, stop and report. Do not improvise around it.**

And name the forbidden recoveries explicitly. These are the shortcuts a smaller model reaches for under pressure, and each one silently converts a failing build into a shipped bug:

| Symptom | Forbidden | Correct |
|---|---|---|
| Migration checksum error | Editing the applied migration | A new sequential migration (rule #13) |
| Test fails | Weakening or deleting the assertion | Fix the code; the test is the spec |
| Type error | `as any`, `@ts-ignore`, loosening `tsconfig` | Fix the type |
| Query returns no rows | Dropping the `org_id` predicate | Fix the fixture or the parameters (rule #1) |
| Balance assertion fails | An epsilon comparison, floats, rounding | Integer cents equality (rule #3) |
| Need a helper library | `npm install` something not in the plan | Stop and ask (rule #14) |
| "Update the posted record" | Adding `PUT`/`DELETE` | `POST /:id/reverse` (rule #6) |
| Column missing at runtime | Adding it ad hoc in the service | New migration, then update the plan |
| A `[Haiku]` step's proof fails twice | Retrying in a loop, trimming the step, "good enough" | Escalate the step unchanged to Sonnet (§5) |
| The step needs a decision the plan never made | Deciding it | Stop and report — the plan is the defect |

Add a final line the executor can act on: **anything the plan did not anticipate is a stop-and-report, not a judgment call.**

## 8. Route every step to a skill

The plan **names** the skill and stops there. Do not inline a skill's checklist into the plan — the skill is the source of truth and copying it creates a second one that drifts.

| The step touches | Delegate to | Tier | Note |
|---|---|---|---|
| A table, column, index, constraint, trigger, extension | `new-migration` | Sonnet | Always the first step of its slice; nothing proceeds until it applies twice |
| A whole module, resource, or new endpoint | `new-module` | split | One invocation per slice, but tier its steps individually — service Sonnet, controller/routes/mount usually Haiku |
| Tests against real PostgreSQL, tenant separation | `isolation-test` | Sonnet | Every module owes a cross-tenant test or it is not done |
| A mechanism, TS/PG feature, React pattern used for the first time | `study-note` | Sonnet | Same change as the feature, never a follow-up; the accuracy bar is the reason |
| Pre-commit audit of the finished diff | `guardrail-review` | Sonnet | Last step of every plan |
| Reconciling `docs/` with what actually landed | `docs-sync` | Sonnet | After the code is green, before the commit. A mechanical row-for-row doc edit the plan spells out can still be its own Haiku step |

If a step maps to no skill (client page, refactor, config), say so and give it the same fields anyway — including its tier.

## 9. Every plan ends with the same spine

Non-negotiable tail, in this order. A plan missing it is incomplete:

1. **Tests** — the invariant, the ROLLBACK path, and cross-tenant isolation ([docs/testing.md](../../../docs/testing.md)), each with named cases and expected values.
2. **`guardrail-review`** over the full diff.
3. **`study-note`** for anything new, plus the index and coverage tracker in [study/README.md](../../../study/README.md). Interview prep is a deliverable here, not a nicety.
4. **`docs-sync`** — [api.md](../../../docs/api.md) for routes, [schema.md](../../../docs/schema.md) for tables, [roadmap.md](../../../docs/roadmap.md) for phase status.

## 10. Decide these at plan time

Each is cheap to choose now and expensive to retrofit. State the decision in the plan; never leave it to be improvised mid-implementation.

- **Scoping** — every new table carries `org_id`; every query in the plan has an `org_id` predicate. Name the one or two tables that legitimately do not, with the reason.
- **Money** — which columns are `BIGINT *_cents`. If this is the first money column in the project, `utils/money.ts` is a step.
- **Transaction boundary** — state what commits together. A document and its journal entry commit together or not at all. Anything owed after `COMMIT` is a queued job (Phase 7), which means it is gated.
- **Lifecycle** — if the module has statuses, the FSM transition table is a step in `types/`, and the status CHECK constraint in the migration must match it exactly.
- **Immutability** — posted documents get `POST /:id/reverse`. If the plan contains a `PUT` or `DELETE` on a posted document, it is wrong; replan that step.
- **Roles** — the `requireRole(...)` set per route, decided deliberately. Do not plan everything as ADMIN.
- **FKs** — `ON DELETE CASCADE` for children of the org or parent document, `RESTRICT` for audit references like `created_by`.
- **App boundary** — confirm no step reads or writes another app's tables directly; a cross-app effect is a step that calls LedgerCore's `journalService` with `source_type`/`source_id`, never a direct query (rule #16).
- **Dependencies** — any new package, and the phase that entitles it ([docs/development.md](../../../docs/development.md)). No ORM, ever. No `ioredis`/`bullmq` before Phase 7. No LLM/embeddings SDK outside Phase 10 (AP-Flow vision) and Phase 16 (TaxGuard AI).

## 11. Output

Emit the plan **inline**, in this order:

1. **Starting state** — verified, from §1.
2. **Gate** — phase, prerequisites, anything blocked.
3. **Execution rules** — the stop condition and forbidden-recovery table from §7, plus the Haiku→Sonnet escalation rule from §5, stated once.
4. **Slices** — each with its name registry, then its numbered steps in the §4 shape.
5. **Dispatch manifest** — one table over the whole plan, so the tiers can be batched without re-reading the steps:

   ```markdown
   | Batch | Step | Tier | Title | Depends on | Blocks | Status |
   |---|---|---|---|---|---|---|
   | A | 1 | Sonnet | Migration 068 — `stock_bins` | — | 2,3 | todo |
   | B | 2 | Haiku | Types + FSM table | 1 | 3 | todo |
   | C | 3 | Sonnet | `binService` | 1,2 | 4,7 | todo |
   | D | 4 | Haiku | Controller + routes + mount | 3 | 7 | todo |
   ```

   **Batch** letters a contiguous run of same-tier steps, so the user can dispatch one request per batch ("run batch D") instead of naming step numbers. Batches always run in letter order; they are a label over the dependency order, never a re-ordering of it.

   `Status` starts `todo` on every row and is the **single place** progress lives — the executor sets it to `done` only after that step's proof command passes. A session running one tier reads this column to find where to start; without it, a fresh Haiku session cannot tell step 2 from step 12.

   Follow it with a line naming the **runs of same-tier steps that can be dispatched as one batch** (e.g. "Steps 4–6 are one Haiku batch; 7 returns to Sonnet"), and a line on what must **not** be batched — steps sharing a transaction boundary or an invariant (§5).
6. **Risks & open questions** — what could invalidate the plan, and every assumption made under a missing answer. Say "unknown" plainly; never invent a path, a table, or a capability to make the plan look complete.
7. **Definition of done** — the concrete end state: tests green, guardrails clean, docs synced, study notes filed.

Write in the imperative, addressed to the executor: "Create `X`. Add `Y`." Not "we could" or "you may want to".

Write the plan to `plans/<slug>.md` when the user asks, when the work spans sessions, or **whenever a different model will execute it** — a handoff needs a file, not a scrollback. Put the date and a `Status:` line at the top, and add a final step to delete or close the file when the work lands. A stale plan file rots into exactly the doc drift that killed the prior build.

When execution begins, mirror the steps into `TodoWrite` one-to-one so progress is visible against the plan.

## 12. Make the plan runnable one tier at a time

The user switches model themselves and says "execute the `[Haiku]` steps in `plans/<slug>.md`". The plan must survive that, which takes three things beyond the tags.

**Tier batches run in plan order, never in tier order.** "All Haiku steps first" is wrong and will fail: the Haiku controller in step 4 needs the Sonnet service from step 3. A batch is a *contiguous* run of same-tier steps whose dependencies are already `done`. Execution alternates tiers down the manifest; the step numbers never get reordered to group models.

**Every plan gets a `plans/<slug>.md` file.** A tier handoff is by definition a different model in a different session, so the §11 file is mandatory here, not optional — scrollback does not cross a `/model` switch.

**Put this dispatch block near the top of the plan file, verbatim,** so whichever tier is running knows its own rules:

```markdown
## Dispatch — read this before executing anything

You are executing this plan as **one tier only**. Your tier is the one named in the request
(`[Haiku]` or `[Sonnet]`). Then:

1. Work **down the dispatch manifest in step order**. If the request names a batch, run only
   that batch's steps. Do not reorder steps to group tiers.
2. Run a step only if its tier matches yours **and** every step in its `Depends on`
   is marked `done` in the manifest. Otherwise stop and report the blocking step.
3. When the next `todo` step carries the **other** tier, stop and report:
   "Step N is [other tier] — switch model and resume." Do not run it because it looks small.
4. After a step's proof command passes, set its `Status` to `done` in the manifest in the
   same edit session. That column is the only record of progress.
5. If a proof fails twice, stop and report per Execution rules. Never weaken a test,
   a type, an assertion or a guardrail to get a step through, and never `npm install`
   anything the step did not name.
6. Anything this plan did not anticipate is a stop-and-report, not a judgment call.
```

**Who runs it.** The user can execute the plan by hand, switching model per batch, or hand the whole file to the `plan-execute` skill, which dispatches each batch to a model-pinned runner agent and re-runs every proof itself. Either way the plan is the same artifact — write it for the cold-start reader, not for a session that remembers this conversation.

Two things to tell the user when you deliver the plan: the **first batch and its tier** ("Steps 1–3 are Sonnet; switch to Haiku for 4–6"), and that tags are advisory — nothing in the harness enforces the tier, so a Sonnet-tagged step run under Haiku will be attempted, not refused. The manifest's stop rule is the only guard, which is why it is written into the plan file rather than left to the dispatch prompt.

## 13. Handoff check — run this before delivering

Re-read the finished plan **as the executor**: a fresh session, this conversation unavailable, only the plan and the repo. For each step ask:

- [ ] Do I know **which files** to open before writing, and which file to copy the pattern from?
- [ ] Is the contract **literal** — could I paste the signatures and column names straight in?
- [ ] Is there **any choice** left to me? (Any word from the §6 banned list?)
- [ ] Do I know the **exact command** that proves this step, and what its output should be?
- [ ] If it fails, do I know **what I am not allowed to do**?
- [ ] Does every name I use here appear **verbatim** in the slice's name registry?
- [ ] Does the step carry a tier in its heading **and** its `Model:` field, and does the dispatch manifest agree with both?
- [ ] For each `[Haiku]` step: is there genuinely **nothing left to decide** — contract literal, analogue file named, proof command exact? If I had to think to place it in that tier, it is `[Sonnet]`.
- [ ] If I am handed only this file and one tier, can I tell **which step to start on and where to stop**? (Manifest `Status` column present, dispatch block from §12 at the top.)

Any unchecked box is a defect in the plan, not a gap the executor will fill. Fix it before delivering.

## 14. Out of scope for this skill

- **Do not write implementation code.** Contracts, signatures, and literal SQL for the plan, yes; function bodies, no.
- **Do not re-litigate** decisions already approved in plan mode.
- **Do not plan past a gate**, or plan for a phase whose prerequisites are unbuilt.
- **Do not pad.** Five real steps beat fifteen with three that say "wire it up". If a step has no files and no proof, delete it.
