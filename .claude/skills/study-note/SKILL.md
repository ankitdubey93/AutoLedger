---
name: study-note
description: Write or extend an interview-prep note in study/ for a mechanism, PostgreSQL feature, TypeScript feature, React pattern, or architectural decision used in AutoLedger for the first time. Use after a feature lands, when a new technique is introduced, or on request to explain how something works for interview preparation.
---

# Writing a study note

`study/` is interview prep for Backend / React + Node + TypeScript roles, generated from what this project actually builds. Its whole value is that every note is anchored to code the user wrote and can talk about from memory. A generic tutorial is worthless here; a wrong note is worse than a missing one, because it will be repeated in an interview.

Read [docs/study-notes.md](../../../docs/study-notes.md) for the convention and [study/TEMPLATE.md](../../../study/TEMPLATE.md) for the structure.

## 1. Is a note owed?

One is owed the **first time** the project uses:

- a runtime/framework mechanism — event loop behaviour, streams, middleware ordering, connection pooling
- a TypeScript feature — generics, conditional types, branded types, discriminated unions, `satisfies`, declaration merging
- a PostgreSQL feature — a constraint kind, index type, isolation level, lock mode, CTE, trigger, extension
- a React pattern — a hook, context shape, suspense boundary, render-cycle concern
- an architectural pattern or algorithm — tenancy scoping, FSM modelling, idempotency keys, double-entry invariants, recursive tree resolution, FIFO/WAC
- a data structure with a non-obvious choice behind it — a map over an array, an append-only ledger over a mutable counter

## 2. Which genre?

`study/` holds two deliberately distinct shapes — check [study/README.md](../../../study/README.md) for the current split:

- **Foundations** (`<tech>-foundations.md`) — one per technology. *What it is · How it works · What it does best · Where it's weak · Why we chose it for AutoLedger · Vocabulary · Q&A.* Answers the opening five minutes of an interview. One per technology, so extend rather than add a second.
- **Concept** — a deep-dive on one mechanism, following [TEMPLATE.md](../../../study/TEMPLATE.md). Named for the concept, several per technology.

A topic touched in a foundations note is **not** closed. Foundations coverage is tracked as ◐ ("deep-dive still owed"); the concept note is still owed when the phase that uses it lands.

## 3. New note or extend?

```bash
ls -R study/
grep -ril "<concept>" study/
```

If the concept is already covered, **extend that note** — add the new angle and new Q&A. Do not create a near-duplicate. One topic per file, kebab-case, named for the concept and not the feature that prompted it: `transactions-isolation-pooling.md`, never `phase-2-notes.md`. Notes outlive their phase.

Categories: `node-express/`, `typescript/`, `postgresql/`, `react/`, `architecture/`, `security-auth/`, `tooling/`.

## 3. Write it

Copy [study/TEMPLATE.md](../../../study/TEMPLATE.md) and fill every section. Where the effort goes:

**Mechanism** — the section that wins interviews. One layer deeper than the API surface: what the runtime, engine, or database is doing, in what order, and what state changes. Not "middleware runs in order" but the `next()` closure chain, what happens to the request object, where a thrown error actually goes. Not "transactions isolate" but MVCC snapshots, what a row lock blocks and what it doesn't.

**Why we chose it here** — the AutoLedger decision, the alternatives rejected, and the reason. Fill the trade-off table with real options. Link the relevant rule in [docs/guardrails.md](../../../docs/guardrails.md) or design in [docs/architecture.md](../../../docs/architecture.md).

**Where it lives in this codebase** — real file paths. Verify them:

```bash
ls server/src/services/ server/src/middleware/ 2>/dev/null
```

If nothing is built yet, say so explicitly in the note rather than inventing a path.

**Gotchas** — the failure modes, especially the ones a guardrail exists to prevent. The discarded build's mistakes are documented in the guardrails appendix and make excellent, true gotchas.

**Interview Q&A** — 4–8 questions with **full written answers**, never bare prompts. Mix:
- recall — "what is Postgres' default isolation level?"
- judgement — "when would you reach for `SERIALIZABLE`?"
- at least one *"tell me about a time you dealt with this"* answered with a specific, true story from this project

**Follow-ups they'll dig into** — the second and third questions after your first answer lands. Usually "what if it fails / scales / runs concurrently". This is where candidates get caught.

## 4. Accuracy bar

- State the versions you verified against — Node 22, Express 4.19, PostgreSQL 16. If behaviour differs across versions (Express 4 vs 5 async error handling, Postgres 15 vs 16), say so rather than picking one silently.
- Concrete numbers where they exist: default `pg` pool size (10), default libuv thread pool size (4), `Number.MAX_SAFE_INTEGER` (2^53−1, and why `BIGINT` cents still fits comfortably for money). Interviewers probe for these.
- Depth over breadth. Skip anything that is a docs lookup.
- If you are not certain of a mechanism detail, verify it or leave it out. Do not smooth over a gap with confident phrasing.

## 5. Update the index

[study/README.md](../../../study/README.md) is the index plus coverage tracker. In the same pass:

- Add a row to the index table for the note's genre and category.
- Update every coverage row the note touches: **✅** dedicated coverage · **◐** foundations-level only, deep-dive still owed · **⬜** untouched. Be strict — a passing mention is ◐, not ✅.

Notes are sometimes added by other sessions. Before editing, `ls */*.md` under `study/` and confirm every note on disk appears in the index — reconcile any that don't, rather than assuming the index is current.

The tracker records **gaps**; never create a placeholder note for one.
