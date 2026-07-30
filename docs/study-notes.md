# Study Notes Convention

The `study/` directory is interview preparation for **Backend / React + Node.js + TypeScript** roles, generated from what this project actually builds. It is not a general tutorial collection — its value is that every note is anchored to code the user wrote and can talk about from memory in an interview.

## The standing obligation

**Whenever a feature lands, ship or update its study note in the same change.** A note is owed for every:

- **Runtime or framework mechanism** used for the first time — event loop behaviour, streams, middleware ordering, connection pooling
- **TypeScript feature** used for the first time — generics, conditional types, branded types, discriminated unions, `satisfies`, declaration merging
- **PostgreSQL feature** used for the first time — a constraint kind, index type, isolation level, lock mode, CTE, trigger, extension
- **React pattern** used for the first time — a hook, context shape, suspense boundary, render-cycle concern
- **Architectural pattern or algorithm** — multi-tenancy scoping, FSM state modelling, idempotency keys, double-entry invariants, recursive tree resolution, FIFO/WAC valuation
- **Data structure** with a non-obvious choice behind it — why a map over an array, why an append-only ledger over a mutable counter

If a change uses something already documented, extend the existing note (add the new angle, a new Q&A) rather than creating a near-duplicate.

## Structure

```text
study/
├── README.md                 ← index + coverage tracker; update when adding a note
├── TEMPLATE.md               ← copy this to start a note
├── node-express/
├── typescript/
├── postgresql/
├── react/
├── architecture/             ← patterns, algorithms, data structures, trade-offs
├── tooling/                  ← build, test and dev tooling; compilers and bundlers
└── security-auth/
```

One topic per file, kebab-case, named for the concept rather than the feature that prompted it — `transactions-isolation-pooling.md`, not `phase-1-notes.md`. Notes outlive the phase that created them.

## Two genres

**Foundations notes** — one per technology (`nodejs-foundations.md`, `postgresql-foundations.md`, …), answering *what is this, how does it work, what is it best at and by what mechanism, where is it weak*. These cover the opening minutes of an interview. Their shape differs from the template:

1. **What it is** — precise, including what it is *not* (Node is a runtime, not a framework; React is a library, not a framework)
2. **How it works** — the real internals: process model, compilation pipeline, storage engine, reconciliation algorithm
3. **What it does best, and how** — never just "it's fast." Name the *mechanism* that makes it good at the thing. Node handles many connections because an idle socket costs a file descriptor rather than a thread stack
4. **Where it's weak** — a note that only praises its stack is useless in an interview and reads as inexperience
5. **Why we chose it for AutoLedger** — with the alternatives rejected, and honest where the rejected option was arguably better
6. **Vocabulary that shows up in interviews** — the terms, so unfamiliar words in a question are recognisable
7. **Interview Q&A** and **Follow-ups** — as below

**Concept notes** — the deep dives on a single mechanism, following [TEMPLATE.md](../study/TEMPLATE.md). A foundations note may mention a topic in passing; the concept note is what makes it interview-proof. The coverage tracker marks that difference with ◐ versus ✅.

## Required sections

Concept notes follow [TEMPLATE.md](../study/TEMPLATE.md):

1. **One-line summary** — what this is, in a sentence.
2. **Mechanism** — how it actually works *underneath*. This is the section that wins interviews. Not "middleware runs in order" but *why* — the `next()` closure chain, what happens to the request object, where errors go. Go a layer deeper than the API surface.
3. **Why we chose it here** — the AutoLedger decision, with the alternatives that were rejected and the reason. Link to the relevant rule in [guardrails.md](guardrails.md) or design in [architecture.md](architecture.md).
4. **Where it lives in this codebase** — file paths, so the note is provably about real code. Omit only if nothing is built yet, and say so explicitly.
5. **Gotchas** — the failure modes, especially ones that bit us or that the guardrails exist to prevent.
6. **Interview Q&A** — 4–8 questions with **full written answers**, not prompts. Mix recall ("what isolation level is Postgres' default?") with judgement ("when would you reach for `SERIALIZABLE`?") and at least one *"tell me about a time"* framing that draws on this project.
7. **Follow-ups they'll dig into** — the second and third questions an interviewer asks after your first answer. This is where candidates get caught.

## Rules for the notes themselves

- **Accuracy above completeness.** A wrong note is worse than a missing one — the user will repeat it in an interview. If you are unsure whether a detail is version-specific (Express 4 vs 5, Node 18 vs 22, Postgres 15 vs 16), state the version you verified it against, or say the behaviour varies.
- **Depth over breadth.** "Why" and "what breaks" beat feature enumeration. Skip anything that is a docs lookup.
- **Concrete numbers where they exist** — default pool sizes, `Number.MAX_SAFE_INTEGER`, default `libuv` thread pool size. Interviewers probe for these.
- **Tie back to the project.** "We hit this when…" is what makes an answer memorable versus recited.
- **No dead scaffolding.** Do not create placeholder notes for topics not yet used. The coverage tracker in `study/README.md` records the gap instead.
