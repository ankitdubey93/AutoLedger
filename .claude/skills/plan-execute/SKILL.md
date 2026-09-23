---
name: plan-execute
description: Execute an AutoLedger plan file batch by batch, dispatching each batch to a model-pinned runner agent (step-haiku or step-sonnet) according to the plan's own tier tags, re-running every proof command independently before marking a step done. Use to run a plan produced by code-planner without switching models by hand, to resume a half-finished plan, or when asked to execute the next batch.
---

# Executing a tiered plan

The plan already says which model each step needs. This skill is the thing that acts on that: it reads the dispatch manifest, hands each batch to a runner agent pinned to the right model, verifies the work itself, and records progress in the manifest.

**You are the orchestrator, not an executor.** You do not write the step's code — not even a one-line step you could finish faster yourself. The moment you start implementing, the tier discipline is gone and the cost model with it. Your jobs are: dispatch, verify, record, and stop when something is wrong.

## What runs where

| Role | Who | Model |
|---|---|---|
| Orchestration, verification, recording | you, this session | whatever the user is running |
| `[Haiku]` batches | `step-haiku` subagent | pinned `haiku` |
| `[Sonnet]` batches | `step-sonnet` subagent | pinned `sonnet` |

The user never switches model by hand — `Agent`'s `model` parameter pins each runner regardless of the session's own model. Spawn with `subagent_type: "step-haiku"` or `"step-sonnet"`, and pass `model` explicitly as well as relying on the agent definition, so an edited definition cannot silently downgrade a Sonnet batch.

**Verified 2026-09-23:** a subagent spawned with `model: "haiku"` from an Opus session reported `claude-haiku-4-5-20251001` and read the plan file correctly from a cold start. The pin is real.

### If the named runners are not available

Agent definitions load at session start, so `.claude/agents/step-haiku.md` and `step-sonnet.md` are missing from a session that began before they were written — the spawn fails with *"Agent type 'step-haiku' not found"*. Do not treat that as a reason to execute the batch yourself.

Fall back to `subagent_type: "claude"` with the same explicit `model`, and open the prompt with the runner's role inline:

> You are a **[Haiku|Sonnet]-tier step runner**. Read `<plan path>` in full, including its `## Dispatch` block and `## Execution rules`, then execute **only steps N, M** in ascending order. The step `Contract` is literal — paste signatures, column lists, SQL, status codes and error strings exactly. Read the files named in `Read first` before writing. Run each step's `Proof` command and paste its real output; never report a proof you did not run. If a proof fails, try once more, then stop — never weaken a test, add `as any`, drop an `org_id` predicate, edit an applied migration, or `npm install` anything. Touch no file, step or concern outside these steps. Do not update the plan's manifest. Report one block per step: `STEP n: done|failed|blocked`, `FILES`, `PROOF`, `OUTPUT`, `NOTES`.

Mention to the user, once, that restarting the session picks up the named runners and makes the inline role unnecessary.

## 1. Find the plan, read it, find the starting point

The invocation usually names the plan (`plan-execute plans/<slug>.md`, optionally with a batch letter). If it does not: list `plans/*.md`. Exactly one file → use it, and say which. More than one → list them with their `Status:` lines and ask which. None → say so and stop; there is nothing to execute, and a plan is `code-planner`'s job, not this skill's.

Read the whole plan file — the `Dispatch` block, `Execution rules`, `Starting state`, every slice's name registry, and the dispatch manifest.

Then locate the work:

- The **first batch whose steps are all `todo`** is next, unless the user named a batch.
- Before dispatching it, check every `Depends on` step is `done`. If one is not, **stop and report which** — a plan resumed in the wrong place is worse than one not resumed.
- If the manifest has no `Status` column or no `Batch` column, the plan predates this skill. Say so, add both columns from the plan's step tags, and confirm with the user before running anything.

If the plan file disagrees with the repo — a step marked `todo` whose files already exist, or `done` whose files do not — **stop and report the mismatch**. Do not guess which is right.

## 2. Dispatch one batch

One batch, one `Agent` call, run in the foreground — you need its result before the next batch can start, and nothing useful can happen in parallel while it runs.

The prompt you send is not a summary. Give the runner:

1. The **plan file path**, and an instruction to read it in full first.
2. The **step numbers it owns**, and nothing else. Never "steps 4 onward".
3. The line: *"Execute only these steps. Do not touch any other step, file or concern."*
4. For an escalation, the **failing step's real output** from the previous attempt.

Do not paste the steps' text into the prompt. The plan file is the contract; a paraphrase in a prompt is a second source that can drift from it.

**Never dispatch a batch to the wrong tier**, even when a Sonnet batch is one small step and the Haiku runner is already warm. The tag is the plan's decision, made with the whole diff in view.

## 3. Verify independently — this is the point of the skill

A runner's `STEP n: done` is a claim, not evidence. **Re-run the step's `Proof` command yourself** and read the real output before you believe it.

- Proof passes → mark the step `done` in the manifest.
- Proof fails → the step is **not** done, whatever the runner said. Treat it as a failure (§4), and note in your report that the runner misreported, because that is a fact about the run worth surfacing.
- Proof is not independently runnable (a study note, a doc edit) → verify what the step's `Proof` field actually specifies — the `grep` count, the section's existence — not the runner's word for it.

Also check the blast radius: `git status --short` and `git diff --stat`. Files the step did not name are a finding. Report them; do not silently keep them.

Then update the manifest's `Status` column — you own it, the runners do not. Mirror the steps into `TodoWrite` as you go so the user can see progress against the plan.

## 4. When a step fails

Follow the plan's own `Execution rules` table; it outranks anything here.

- **A `[Haiku]` step whose proof failed twice** → re-dispatch **that same step, unchanged**, to `step-sonnet`, with the failure output. That is the sanctioned escalation. Do not rewrite the step to make it easier, and do not do it yourself.
- **A `[Sonnet]` step whose proof failed twice** → stop. Report the step, the command, the real output, and what you think the cause is. Do not escalate to Opus automatically and do not start debugging in the orchestrator — the user decides.
- **An escalated step that passes under Sonnet** → record it in the plan file under a `## Tiering corrections` heading: the step number, and one line on why Haiku could not do it. That is how the tier lists get better; without it the same mistake is planned again next time.
- **A runner reports `blocked` on an ambiguity** → the plan is the defect. Report the two readings to the user. Fixing the plan is a planning decision, not an execution one.

Never mark a step `done` to keep momentum. A plan whose manifest lies is worse than no plan.

## 5. Between batches

Stop and report after **every** batch, with: the batch letter and tier, each step's verified outcome, the proof output that convinced you, anything outside the named files, and the next batch with its tier. Then wait.

Do not chain batches without surfacing results — the user chose a per-batch plan so they can inspect the seams. Continuous unattended execution is only correct when the user explicitly asks for it, and even then every failure still stops the run.

## 6. At the end of the plan

The plan's own `Definition of done` is the checklist; work through it literally. For an AutoLedger plan that means at minimum:

- `cd server && npm test` green, with the cross-tenant isolation case present and passing (rule 15).
- `npm run verify:integrity` — all checks pass.
- `guardrail-review` clean over the full diff, `docs-sync` reporting no drift. Both are `[Sonnet]` steps; dispatch them, do not run them yourself.
- Study notes filed or extended, `study/README.md` updated.
- The plan file deleted in the commit that lands the work, per the plan's last step. A stale plan file is the doc drift that killed the prior build.

Do not commit unless the user asks.

## 7. Honest limits — say these plainly if they come up

- **Tier tags are advisory.** Nothing in the harness refuses a Sonnet-tagged step run under Haiku. This skill's dispatch discipline and the plan's stop rule are the only enforcement.
- **Every runner starts cold.** It re-reads the plan and the analogue files each time, which is why the plan's `Read first` and literal contracts matter more than the runner's cleverness. It also means a batch of one trivial step can cost more to dispatch than to do — that is the price of keeping the tier boundary real, and it is the reason batches exist rather than per-step dispatch.
- **A runner cannot ask you a question mid-step.** It either executes or stops. That is deliberate.
- **You cannot verify a claim you cannot run.** Where a step's proof is a human judgment (a study note's accuracy), say that it was not independently verified rather than implying it was.
