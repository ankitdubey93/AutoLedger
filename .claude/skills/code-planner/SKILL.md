---
name: code-planner
description: Turn an approved plan-mode plan — or a bare description of what to build — into an ordered, file-by-file AutoLedger build plan detailed enough for a smaller model to execute step by step without judgment calls. Every step names its files, its verbatim contract, the skill that executes it, the guardrails it must satisfy, and the command that proves it worked. Use before starting implementation, when a plan needs breaking into modules and steps, or when asked how to build something.
---

# Planning a build

This skill produces **the plan, not the code**.

The plan is written **for an executor that is not in this conversation** — typically a smaller, cheaper model in a fresh session with no memory of the discussion that produced it. That single constraint drives every rule below. The executor cannot ask what you meant, cannot infer the decision you made and did not write down, and when it hits ambiguity it will guess — usually by taking the shortcut that a guardrail exists to prevent.

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
- Does it depend on a gated phase? Phase 7 (background jobs) gates 9 (QuickBooks), 10 (AP-Flow), 15 (BoardDeck Automator), 16 (TaxGuard AI). Phase 12 (FP&A Engine) gates 13 (ForecasterPro). Phase 4 (LedgerCore live statements) gates 12 and 14. Phase 8 (FX engine) gates 11 (AP-Flow posting).

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
### Step 3 — `accountService` with org-scoped list and create

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
  `listAccounts` → `SELECT ... FROM accounts WHERE org_id = $1 ORDER BY code ASC`.
  `createAccount` → single `INSERT`, `org_id` from the `orgId` argument only.
  On duplicate `(org_id, code)` catch Postgres error code `23505` and throw
  `new ApiError(409, 'Account code already exists')`.
- **Guardrails:** #1 `org_id = $1` in every statement · #2 no `req`/`res` in this file ·
  #4 parameterized only · #8 `parent_id` validated against the same org
- **Proof:** `cd server && npm run typecheck` exits 0, and
  `grep -c "org_id" server/src/services/accountService.ts` ≥ one per statement
- **If it fails:** type error → fix the type, never `as any` or `@ts-ignore`.
  Do not proceed to Step 4 until `npm run typecheck` is clean.
- **Owes:** nothing yet — docs land in Step 8
```

Rules for filling it in:

- **Depends on** — the step numbers whose output this one consumes. Lets the executor confirm it is in the right place and stops out-of-order starts.
- **Read first** — one to three real files to open before writing, ideally the closest existing analogue. "Mirror `organizationService.ts`" is worth more to a weaker model than three paragraphs of description, because the repo's conventions are already in that file.
- **Files** — real paths, marked `(new)` or `(edit)`. For `(edit)`, name the function or block to change. A step with no file paths is not a step, it is a wish.
- **Contract** — **write it out literally, copy-pasteable**: the actual signatures, the actual column list, the actual route table with methods and status codes, the actual error message strings. Do not describe the shape and hope. Services take `orgId` first; money fields are `*Cents: number`.
- **Guardrails** — cite the numbered rules from [CLAUDE.md](../../../CLAUDE.md) that actually bite *here*. Not all sixteen — the two or three a tired executor would get wrong in this specific file.
- **Proof** — the exact command plus the expected result. "Tests pass" is not a proof; `npm test -- accounts` with a named cross-tenant 404 assertion is. Every step needs one it can run *before* the next step begins.
- **If it fails** — the sanctioned recovery, and the forbidden ones (see §6). This field is what keeps a stuck executor from routing around a guardrail.
- **Owes** — the doc and study-note obligations this step creates, paid in the same step.

## 5. Leave no decisions in the plan

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

## 6. Failure handling and stop conditions

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

Add a final line the executor can act on: **anything the plan did not anticipate is a stop-and-report, not a judgment call.**

## 7. Route every step to a skill

The plan **names** the skill and stops there. Do not inline a skill's checklist into the plan — the skill is the source of truth and copying it creates a second one that drifts.

| The step touches | Delegate to | Note |
|---|---|---|
| A table, column, index, constraint, trigger, extension | `new-migration` | Always the first step of its slice; nothing proceeds until it applies twice |
| A whole module, resource, or new endpoint | `new-module` | Owns the layer order; a slice is usually one invocation |
| Tests against real PostgreSQL, tenant separation | `isolation-test` | Every module owes a cross-tenant test or it is not done |
| A mechanism, TS/PG feature, React pattern used for the first time | `study-note` | Same change as the feature, never a follow-up |
| Pre-commit audit of the finished diff | `guardrail-review` | Last step of every plan |
| Reconciling `docs/` with what actually landed | `docs-sync` | After the code is green, before the commit |

If a step maps to no skill (client page, refactor, config), say so and give it the same fields anyway.

## 8. Every plan ends with the same spine

Non-negotiable tail, in this order. A plan missing it is incomplete:

1. **Tests** — the invariant, the ROLLBACK path, and cross-tenant isolation ([docs/testing.md](../../../docs/testing.md)), each with named cases and expected values.
2. **`guardrail-review`** over the full diff.
3. **`study-note`** for anything new, plus the index and coverage tracker in [study/README.md](../../../study/README.md). Interview prep is a deliverable here, not a nicety.
4. **`docs-sync`** — [api.md](../../../docs/api.md) for routes, [schema.md](../../../docs/schema.md) for tables, [roadmap.md](../../../docs/roadmap.md) for phase status.

## 9. Decide these at plan time

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

## 10. Output

Emit the plan **inline**, in this order:

1. **Starting state** — verified, from §1.
2. **Gate** — phase, prerequisites, anything blocked.
3. **Execution rules** — the stop condition and forbidden-recovery table from §6, stated once.
4. **Slices** — each with its name registry, then its numbered steps in the §4 shape.
5. **Risks & open questions** — what could invalidate the plan, and every assumption made under a missing answer. Say "unknown" plainly; never invent a path, a table, or a capability to make the plan look complete.
6. **Definition of done** — the concrete end state: tests green, guardrails clean, docs synced, study notes filed.

Write in the imperative, addressed to the executor: "Create `X`. Add `Y`." Not "we could" or "you may want to".

Write the plan to `plans/<slug>.md` when the user asks, when the work spans sessions, or **whenever a different model will execute it** — a handoff needs a file, not a scrollback. Put the date and a `Status:` line at the top, and add a final step to delete or close the file when the work lands. A stale plan file rots into exactly the doc drift that killed the prior build.

When execution begins, mirror the steps into `TodoWrite` one-to-one so progress is visible against the plan.

## 11. Handoff check — run this before delivering

Re-read the finished plan **as the executor**: a fresh session, this conversation unavailable, only the plan and the repo. For each step ask:

- [ ] Do I know **which files** to open before writing, and which file to copy the pattern from?
- [ ] Is the contract **literal** — could I paste the signatures and column names straight in?
- [ ] Is there **any choice** left to me? (Any word from the §5 banned list?)
- [ ] Do I know the **exact command** that proves this step, and what its output should be?
- [ ] If it fails, do I know **what I am not allowed to do**?
- [ ] Does every name I use here appear **verbatim** in the slice's name registry?

Any unchecked box is a defect in the plan, not a gap the executor will fill. Fix it before delivering.

## 12. Out of scope for this skill

- **Do not write implementation code.** Contracts, signatures, and literal SQL for the plan, yes; function bodies, no.
- **Do not re-litigate** decisions already approved in plan mode.
- **Do not plan past a gate**, or plan for a phase whose prerequisites are unbuilt.
- **Do not pad.** Five real steps beat fifteen with three that say "wire it up". If a step has no files and no proof, delete it.
