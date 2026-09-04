# Document Lifecycle FSMs

> A status column is not a free-text field — it is a finite state machine, and the moment two files decide independently whether `DRAFT -> ISSUED` is legal, the two answers eventually disagree.

**Category:** Architecture
**Introduced by:** Phase 3.8 — `invoices.status`, the first lifecycle status in AutoLedger with more than two states; extended Phase 3.9 — `bills.status`, the first four-state document FSM with a recall edge; extended Phase 4 — `fiscal_periods.status`, the first FSM with a genuinely terminal state
**Verified against:** TypeScript 7.0 (`as const satisfies`), PostgreSQL 16

---

## Mechanism

### Why "just check the string" rots

The naive version of a status field is a `TEXT` column and a scatter of `if (invoice.status === 'DRAFT')` checks across however many services touch it. Nothing stops a new code path from writing `status = 'PAID'` — a value the CHECK constraint doesn't even list — or from allowing a transition nobody meant to allow, like `VOID -> ISSUED`, because the check that would have caught it lives in a different file than the one making the change.

The fix used here is the same one `types/auth.ts`'s `ROLES` and `types/ledger-core.ts`'s `ACCOUNT_TYPES` already establish: one array of literal values, `as const`, feeding both the TypeScript union and a runtime predicate. Phase 3.8 extends the pattern one level: not just *which values are valid*, but *which transitions between them are valid*.

```ts
export const INVOICE_STATUSES = ['DRAFT', 'ISSUED', 'VOID'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const INVOICE_TRANSITIONS = {
  DRAFT: ['ISSUED', 'VOID'],
  ISSUED: ['VOID'],
  VOID: [],
} as const satisfies Record<InvoiceStatus, readonly InvoiceStatus[]>;

export function canTransitionInvoice(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return (INVOICE_TRANSITIONS[from] as readonly InvoiceStatus[]).includes(to);
}
```

### `satisfies` as a compile-time exhaustiveness check

`as const satisfies Record<InvoiceStatus, readonly InvoiceStatus[]>` does two jobs at once. `as const` freezes every array to its literal tuple type (`readonly ['ISSUED', 'VOID']`, not `string[]`), which is what lets `INVOICE_TRANSITIONS[from]` narrow correctly. `satisfies Record<InvoiceStatus, ...>` then checks — at compile time, with no runtime cost — that the object has **exactly** one key per status, no more and no fewer. Add a fourth status to `INVOICE_STATUSES` and forget to add its row here, and the file fails to typecheck. There is no way to add a status and silently leave its transitions undefined, which is exactly the class of bug a scattered-`if` design invites.

Using `: Record<...>` instead of `satisfies` would have worked for the completeness check too, but it would widen every array back to `InvoiceStatus[]`, losing the literal-tuple narrowing `canTransitionInvoice` depends on. `satisfies` validates the shape without changing the inferred type — the reason it exists at all (see `study/typescript/const-assertions-and-satisfies.md`).

### The database enforces the same rule independently

The transition table decides whether a *service* accepts a transition; it says nothing about a raw SQL `UPDATE` run by a future migration, a data-fix script, or a bug in a different service. Migration 009's `status` CHECK constraint lists the same three values:

```sql
status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ISSUED', 'VOID'))
```

and a trigger enforces the transition graph itself, not just membership in the value set:

```sql
IF OLD.status = 'DRAFT' THEN
  RETURN NEW;                          -- any edit permitted; nothing posted yet
END IF;

IF NOT (OLD.status = 'ISSUED' AND NEW.status = 'VOID') THEN
  RAISE EXCEPTION '...' USING ERRCODE = '0A000';
END IF;
```

This is the same "the database is the guardrail, not just the application" posture `study/postgresql/deferred-constraint-triggers.md` documents for the balance invariant. Two independent implementations of one rule — the TypeScript table and the SQL CHECK/trigger — must list the *same* three values, and if they ever drift, adding a status to one without the other is caught the moment a test tries to write the missing value.

### Draft mutability vs. posted immutability

The FSM also encodes *which states are mutable at all*. `DRAFT` is not a posted financial document — nothing has reached the general ledger yet — so `UPDATE`/`DELETE` are legal on it, matching ordinary CRUD. The instant an invoice becomes `ISSUED`, migration 004's precedent (`journal_entries` is immutable from the moment it exists) applies: the trigger permits nothing except the single `ISSUED -> VOID` transition, and even that transition may touch only `status`, `voided_at`, `void_journal_entry_id` — enforced with a row-diff, not just a status check:

```sql
IF to_jsonb(NEW) - 'status' - 'voided_at' - 'void_journal_entry_id' - 'updated_at'
   IS DISTINCT FROM
   to_jsonb(OLD) - 'status' - 'voided_at' - 'void_journal_entry_id' - 'updated_at' THEN
  RAISE EXCEPTION 'Voiding invoice % may not change any other field', OLD.id
    USING ERRCODE = '0A000';
END IF;
```

`to_jsonb(row) - 'col'` subtracts a key from the JSONB object the row casts to; comparing two such subtractions with `IS DISTINCT FROM` (NULL-safe, unlike `<>`) says "every column except these three must be identical between OLD and NEW." This is a generic technique for "this transition may move only these fields" that does not need to be rewritten if the table grows a new column later — a new column is automatically covered by the diff and automatically frozen once issued, which is the safer default for a posted financial document.

### Correction is reversal, never edit

Rule 6 says a posted document is corrected by reversal, not mutation. The FSM is what makes that concrete for invoices: there is no `ISSUED -> ISSUED` self-transition that "updates in place," and the only way out of `ISSUED` is `VOID`, which in `invoiceService.voidInvoice` posts a reversing journal entry through `journalService.reverseEntryOnClient` before flipping the status. The state machine and the correction model are the same design decision viewed from two angles: a state you cannot re-enter is a state you cannot silently edit.

### The four-state extension: bills and a recall edge

Invoices have three states because AutoLedger doesn't (yet) model who *approves* a sales invoice before it goes out — issuing one is a single authorized action. A bill is different: entering a vendor's bill and *approving* it for posting are two separate acts of trust, on purpose — a segregation-of-duties control real accounting departments actually run, not a modeling nicety. `BillStatus` has four states instead of three:

```ts
export const BILL_STATUSES = ['DRAFT', 'AWAITING_APPROVAL', 'POSTED', 'VOID'] as const;

export const BILL_TRANSITIONS = {
  DRAFT:             ['AWAITING_APPROVAL', 'POSTED', 'VOID'],
  AWAITING_APPROVAL: ['DRAFT', 'POSTED', 'VOID'],
  POSTED:            ['VOID'],
  VOID:              [],
} as const satisfies Record<BillStatus, readonly BillStatus[]>;
```

Two things are new here relative to the invoice FSM:

**A recall edge, `AWAITING_APPROVAL -> DRAFT`.** This is the only *backward* transition anywhere in either FSM. It exists because a reviewer rejecting a submitted bill needs a way to send it back for correction rather than voiding it outright (which would discard it) or being stuck unable to edit it (since only `DRAFT`/`AWAITING_APPROVAL` are mutable at all — see below). The edge is deliberate, not an oversight the compiler happened to allow: nothing in the codebase actually calls it as a distinct "reject" action yet — the recall reuses the same `updateBill` a correction would use, which is legal in both `DRAFT` and `AWAITING_APPROVAL` — but the transition table names it explicitly so a future "Send back for changes" button has an edge to use rather than needing a migration first.

**Two mutable states, not one.** `updateBill`/`deleteBill` check `status IN ('DRAFT', 'AWAITING_APPROVAL')`, and migration 013's trigger (`reject_locked_bill_line_mutation`) enforces the identical set at the database level for `bill_lines`. This is the direct four-state analogue of the invoice FSM's "DRAFT is mutable, everything else isn't" — just with the mutable region widened from one state to two, because entry and review are both pre-commitment stages; nothing has posted to the ledger until `POSTED`.

**Approval is gated by a different role than entry.** `POST /bills/:id/submit` (the `DRAFT -> AWAITING_APPROVAL` edge) requires `ACCOUNTANT` or above; `POST /bills/:id/approve` (`AWAITING_APPROVAL -> POSTED`) requires `OWNER` or `ADMIN` — an `ACCOUNTANT` who can enter and submit a bill cannot approve their own entry. This is the actual reason a review queue exists at all: the FSM's states model *who did what*, and the role gate on each transition's route (not the FSM itself, which is state-graph-only and role-agnostic) is what turns "AWAITING_APPROVAL" from a label into a real control. The FSM answers "can this bill legally move from state A to state B"; the route's `requireRole(...)` answers "is *this caller* allowed to be the one who moves it" — two independent questions, deliberately checked in two different places.

The CHECK constraint and the transition table stay in lockstep the same way the invoice pair does — migration 013's `status CHECK (status IN ('DRAFT', 'AWAITING_APPROVAL', 'POSTED', 'VOID'))` lists exactly `BILL_TRANSITIONS`'s four keys, and `billConstraints.test.ts` proves the database side independently of the service, mirroring `invoiceConstraints.test.ts`'s approach.

### A genuinely terminal state: `LOCKED` has no outbound edge at all

Every FSM above eventually reaches `VOID`, and `VOID: []` looks the same shape as `LOCKED: []` on `FiscalPeriodStatus`:

```ts
export const FISCAL_PERIOD_TRANSITIONS = {
  OPEN:   ['CLOSED'],
  CLOSED: ['OPEN', 'LOCKED'],
  LOCKED: [],
} as const satisfies Record<FiscalPeriodStatus, readonly FiscalPeriodStatus[]>;
```

but the two empty arrays mean something different. `VOID` is terminal because *voiding is itself the correction* — an invoice or bill in `VOID` has already had its reversing entry posted, so there is nothing left to walk backward *to*; the object's job in the ledger is finished. `LOCKED` is terminal for the opposite reason: nothing has happened to the period except a promise. Closing a period (`OPEN -> CLOSED`) is reversible on purpose — a bookkeeper closes January a day early, realizes a late invoice needs to land inside it, and reopens it, no different in kind from any other draft correction. Locking (`CLOSED -> LOCKED`) is the FSM's way of saying "this promise is now permanent" — an auditor-facing guarantee that January's books will never again change, which is only true if there genuinely is no edge back out. A `LOCKED -> CLOSED` edge, even one gated behind a stricter role, would make every "these books are locked" claim conditional on nobody with the right permission changing their mind later — which is not a stronger lock, it's a slower-to-reach `CLOSED`.

This is the first FSM in the codebase where a state's *entire reason for existing* is to have zero outbound edges — `VOID`'s emptiness is incidental to what voiding means; `LOCKED`'s emptiness *is* what locking means. Correcting a locked period is impossible by construction: the fix is a reversing entry in a later, still-open period, which is exactly the same "correction, never mutation" discipline rule 6 applies everywhere else — just with the additional twist that here, there isn't even a route that could attempt the disallowed edge, because the migration's CHECK constraint on `status` and the transition table both stop at three values with no path back from the third.

The two-step climb (`OPEN -> CLOSED -> LOCKED`, never `OPEN -> LOCKED` directly) also encodes a real-world control: a period must be closed — reviewed, reconciled, deliberately shut to new postings — before it can be locked at all. `canTransitionFiscalPeriod('OPEN', 'LOCKED')` returns `false`, so "lock this period" is only ever offered to a period someone already decided was ready to close, never as a single click from a still-open month.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Scattered `if (status === 'X')` checks per service | Cheapest to write for one status field | Rejected — exactly the failure mode this note opens with; no single place to audit "is this transition legal" |
| A `status_transitions` table in the database, joined at write time | Fully data-driven, editable without a deploy | Rejected for now — no requirement to change transitions without a code change, and it adds a query to every status write for a rule that is currently fixed at three states |
| A state-machine library (e.g. XState) | Handles guards, side effects, hierarchical states | Overkill — three states and a handful of one-way edges do not need a general-purpose SMC; `INVOICE_TRANSITIONS` is five lines and the compiler checks it |
| Boolean flags (`isIssued`, `isVoided`) | Looks simpler at a glance | Rejected — booleans can represent illegal combinations (`isIssued && isVoided` both true) that an enum-typed status column cannot |

## Where it lives in this codebase

- `server/src/types/ledger-core.ts` — `INVOICE_STATUSES`, `InvoiceStatus`, `isInvoiceStatus`, `INVOICE_TRANSITIONS`, `canTransitionInvoice`
- `server/src/db/migrations/009_ledger-core_invoices.sql` — the `status` CHECK and `reject_issued_invoice_mutation()` trigger
- `server/src/services/ledger-core/invoiceService.ts` — `issueInvoice`/`voidInvoice` call `canTransitionInvoice` before writing, never an inline string comparison
- `server/src/__tests__/ledger-core/invoiceConstraints.test.ts` — proves the trigger holds via raw SQL, bypassing the service entirely (same technique as `ledgerConstraints.test.ts`)
- `server/src/types/ledger-core.ts` — `BILL_STATUSES`, `BillStatus`, `isBillStatus`, `BILL_TRANSITIONS`, `canTransitionBill`, the four-state extension with the `AWAITING_APPROVAL -> DRAFT` recall edge
- `server/src/db/migrations/013_ledger-core_bills.sql` — the four-value `status` CHECK, `reject_posted_bill_mutation()` (the `POSTED -> VOID` row-diff carve-out), `reject_locked_bill_line_mutation()` (lines editable in both `DRAFT` and `AWAITING_APPROVAL`)
- `server/src/routes/ledger-core/billRoutes.ts` — `requireRole('OWNER', 'ADMIN', 'ACCOUNTANT')` on submit, `requireRole('OWNER', 'ADMIN')` on approve — the segregation-of-duties gate, kept separate from the FSM itself
- `server/src/__tests__/ledger-core/billConstraints.test.ts` — the bill half of the raw-SQL trigger proof, including the `AWAITING_APPROVAL`-editable case
- `server/src/types/ledger-core.ts` — `FISCAL_PERIOD_STATUSES`, `FiscalPeriodStatus`, `FISCAL_PERIOD_TRANSITIONS`, `canTransitionFiscalPeriod` — the first FSM with a state whose entire purpose is having no outbound edge
- `server/src/db/migrations/015_ledger-core_fiscal_periods.sql` — the three-value `status` CHECK, plus `chk_fiscal_periods_locked_complete` requiring `locked_by`/`locked_at` whenever `status = 'LOCKED'` (the same "posted-complete" CHECK idiom `chk_bills_posted_complete` uses)
- `server/src/services/ledger-core/fiscalPeriodService.ts` — `transition()`, the one function backing `closePeriod`/`reopenPeriod`/`lockPeriod`, all three routed through `canTransitionFiscalPeriod`
- `server/src/__tests__/ledger-core/fiscalPeriods.test.ts` — asserts `LOCKED -> OPEN` (reopen) is rejected with `409`, the direct proof the terminal state has no path back

## Gotchas

- `INVOICE_TRANSITIONS` and the migration's CHECK list must be edited together. Nothing enforces this at build time across the two files — only a test that tries to write a status neither list expects would catch drift, which is why `invoiceConstraints.test.ts` exists.
- `canTransitionInvoice(from, to)` answers "is this edge in the graph," not "is this write otherwise valid." `issueInvoice` still needs its own checks (an invoice needs at least one line, a receivable account must be configured) — the FSM only gates the state change, not the business rules attached to it.
- The row-diff trigger technique (`to_jsonb(NEW) - 'col' IS DISTINCT FROM ...`) silently permits a change to *any* column not in the exclusion list. Adding a mutable field to `invoices` later (say, an internal reference number editable after issue) requires deliberately adding it to the exclusion list — it will not "just work," and forgetting it means that field becomes frozen at issue by default, which is the safe failure direction but still worth knowing.
- `DELETE` and `UPDATE` share one trigger function here (`FOR EACH ROW`, both operations), branching on `TG_OP`. `NEW` is unassigned on `DELETE` — the same trap `study/postgresql/deferred-constraint-triggers.md` documents for the balance trigger — so the function checks `TG_OP = 'DELETE'` before touching `NEW` at all.
- The recall edge (`AWAITING_APPROVAL -> DRAFT`) is legal in the FSM but has no dedicated route or button yet — `updateBill` reaching that state is a side effect of it being mutable in both directions, not a named "reject" action. A reviewer today rejects a bill by editing it back to something wrong on purpose, or by voiding it; a real "Send back for correction" feature would still just call the existing PATCH, since the FSM already permits it.
- A role gate on a route is not part of the FSM and cannot be recovered from `BILL_TRANSITIONS` alone — the transition table says `DRAFT -> AWAITING_APPROVAL -> POSTED` is a legal *path*, but nothing in `types/ledger-core.ts` says who may walk which edge. Reading only the FSM would miss that approval is deliberately harder to reach than submission.
- `VOID: []` and `LOCKED: []` look identical in the transition table but mean different things — one is terminal because the correction already happened (a reversing entry was posted), the other is terminal because the whole point of the state is to promise nothing will happen again. Reading the shape of the table alone won't tell you which; you need the domain context.
- `canTransitionFiscalPeriod('OPEN', 'LOCKED')` is `false` by design — locking requires passing through `CLOSED` first. A UI that tries to offer a "Lock" action directly from an `OPEN` period's page will get a `409` from every attempt, not a working shortcut.

## Interview Q&A

**Q: Why not just use a `TEXT` column and check the value in application code?**
A: A `TEXT` column with ad-hoc `if` checks scattered across services has two failure modes: nothing stops a typo or a new value from being written (no membership check), and nothing stops an illegal *transition* even among valid values (no edge check). A CHECK constraint fixes the first. A finite-state-machine table — one exported object mapping each state to its legal next states, validated at every write site — fixes the second, and putting it in one file means there is exactly one place to audit "can X become Y."

**Q: Why does the FSM live in TypeScript *and* get re-enforced by a database trigger? Isn't that duplication?**
A: It is duplication of the same *rule*, not the same *code*, and each layer defends against a different mistake. The TypeScript table gives the service a readable, testable, single source of truth and a good error message. The database trigger is what stops a bug in a different service, a hand-run migration, or a future `psql` session from writing an illegal transition — the same "belt and braces" reasoning behind the ledger's balance invariant being both service-checked and trigger-enforced.

**Q: What does `as const satisfies Record<InvoiceStatus, readonly InvoiceStatus[]>` buy you that a plain type annotation wouldn't?**
A: `as const` freezes each transition array to its literal tuple so lookups narrow correctly (`INVOICE_TRANSITIONS['DRAFT']` has type `readonly ['ISSUED', 'VOID']`, not `string[]`). `satisfies Record<InvoiceStatus, ...>` checks — without widening the inferred type, unlike a `: Record<...>` annotation — that every status has exactly one entry. Add a status and forget its row, and the file fails to compile.

**Q: How would you allow an invoice to move from `ISSUED` back to `DRAFT` for correction, if the business asked for it?**
A: I wouldn't add that edge — it would mean an invoice that already posted a journal entry could silently un-post and be edited, which breaks the immutable-once-posted rule and would need the journal entry retroactively reversed with no record of why. The existing correction path is right: void the issued invoice (which posts a reversing entry) and create a fresh draft. If the business specifically wanted "un-issue this invoice I just issued by mistake," that's a *new*, narrowly-scoped transition (`ISSUED -> DRAFT`, allowed only within some short window and only if unpaid) — not a reopening of the general edge, and it would need its own trigger carve-out and its own test.

**Q: What happens if `invoice_lines` gets a new mutable column later — does the immutability trigger need to change?**
A: For `invoice_lines`, yes — a separate trigger (`reject_non_draft_invoice_line_mutation`) blocks *any* write to a line once its parent invoice leaves `DRAFT`, with no carve-out, so a new column is automatically frozen too. For `invoices` itself, the row-diff trigger only compares the *header* row's columns against an exclusion list (`status`, `voided_at`, `void_journal_entry_id`), so a new header column is automatically frozen at issue unless someone deliberately adds it to the exclusion list — the safe direction to fail in, but worth calling out explicitly in review.

**Q: Bills have a state invoices don't — `AWAITING_APPROVAL` — and a backward edge. Why?**
A: Because entering a bill and approving it for posting are two different acts of trust that a real accounts-payable process keeps separate — the person who types in a vendor's invoice usually isn't the person authorized to commit the company to paying it. `DRAFT -> AWAITING_APPROVAL` is submission; `AWAITING_APPROVAL -> POSTED` is approval, and I gate that second edge's route to `OWNER`/`ADMIN` only, while submission just needs `ACCOUNTANT`. The backward edge, `AWAITING_APPROVAL -> DRAFT`, exists so a reviewer can send a bill back for correction instead of either voiding it (which discards it) or being unable to touch it at all — both `DRAFT` and `AWAITING_APPROVAL` stay mutable for exactly that reason.

**Q: Doesn't the FSM already tell you who can approve a bill?**
A: No, and that's a distinction worth being precise about. `BILL_TRANSITIONS` answers "is `AWAITING_APPROVAL -> POSTED` a legal edge in the graph" — a state-machine question. `requireRole('OWNER', 'ADMIN')` on the `/approve` route answers "is *this specific caller* allowed to walk that edge" — an authorization question. They're independent by design: the FSM is role-agnostic on purpose, because the graph shape (which states, which edges) doesn't change based on who's asking, while the authorization rule very much does. Conflating the two would mean the FSM couldn't be read on its own to understand the document's lifecycle.

**Q: Fiscal periods have a `LOCKED` state with no way out, same as `VOID` on invoices and bills. Are those the same kind of terminal state?**
A: No, and the difference matters. `VOID` is terminal because the correction has already happened — voiding an invoice posts the reversing entry right then, so there's nothing left to walk back to; the document's job is done. `LOCKED` is terminal for the opposite reason: nothing irreversible happens *at* the lock itself, it's a promise about the future — "no entry will ever post into this period again, and it will never reopen." If `LOCKED` had an edge back to `CLOSED`, even behind a stricter role check, the promise would only ever be conditionally true, which isn't a lock at all, just a slower `CLOSED`. Two empty arrays in the transition table, two different reasons for being empty.

**Q: Why does locking require going through `CLOSED` first instead of allowing `OPEN -> LOCKED` directly?**
A: Because closing and locking answer different questions. Closing says "stop new postings here, this period looks done" — a routine, reversible bookkeeping act that might get undone if something was missed. Locking says "this is now permanently final" and should only be offered to a period someone already decided was ready to close. Requiring the intermediate state means the FSM itself enforces that review happened before permanence — `canTransitionFiscalPeriod('OPEN', 'LOCKED')` returning `false` isn't a missing feature, it's the control.

## Follow-ups they'll dig into

- What if two requests try to issue the same invoice concurrently? (Answered by the `SELECT ... FOR UPDATE` row lock in `issueInvoice` before the transition check — the second request blocks until the first commits, then sees `ISSUED` and gets the FSM's `409`.)
- How would this generalize to a workflow with parallel states (e.g. "approved" and "paid" as independent axes rather than one linear chain)? (A single `status` enum can't express two independent axes cleanly — that needs two columns, or a proper state chart, which is where a library like XState starts earning its keep. Bills already hint at this: "paid" is deliberately *not* a fifth state — see [derived-vs-stored-state.md](../architecture/derived-vs-stored-state.md) — because settlement really is an independent axis from approval, and modeling it as a state would have needed exactly the two-column split this follow-up describes.)
- Why does only the bill FSM get a backward edge, and not the invoice FSM? (Because invoices have no review stage to recall *from* — issuing an invoice is a single authorized action with no intermediate "submitted for approval" state. A backward edge only makes sense where there's a state worth stepping back out of.)

## See also

- [postgresql/deferred-constraint-triggers.md](../postgresql/deferred-constraint-triggers.md) — the same "database enforces it independently of the service" posture, for the ledger's balance invariant
- [typescript/const-assertions-and-satisfies.md](../typescript/const-assertions-and-satisfies.md) — the `as const` / `satisfies` mechanics this note builds on
- [architecture/double-entry-as-an-invariant.md](../architecture/double-entry-as-an-invariant.md) — another "central rule enforced twice" case study
- [architecture/derived-vs-stored-state.md](../architecture/derived-vs-stored-state.md) — why "paid" is not a fifth bill/invoice status, and how settlement stays a genuinely separate axis from approval
- [postgresql/exclusion-constraints-and-gist.md](../postgresql/exclusion-constraints-and-gist.md) — fiscal periods' other Phase 4 invariant, that no two periods in one organization may overlap, enforced by a constraint rather than an FSM because it spans rows, not states
