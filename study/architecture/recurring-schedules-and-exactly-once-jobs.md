# Recurring Schedules and Exactly-Once Background Generation

> A cron job that "runs every hour" is not the same promise as "generates each due invoice exactly once" — the gap between those two is a row lock, a unique constraint, and a decision about where to compute a date from.

**Category:** Architecture
**Introduced by:** Phase 34b — recurring documents. An invoice, bill or manual journal entry becomes a template (`recurring_schedules`); a background sweep (`recurringService.runDueOccurrences`) generates the next occurrence on schedule, as a draft or posted document, in one transaction with its own history row (`recurring_runs`). A recurring journal can additionally post its own reversal dated the first day of the next month.
**Verified against:** PostgreSQL 16.15, BullMQ (this codebase's Phase 7 queue layer), Node 22.

---

## Mechanism

### Anchor-based date arithmetic, and why a previous-date chain drifts

There are two ways to compute "the next occurrence" of a recurring schedule. The naive one is a chain: occurrence 5's date is occurrence 4's date plus one interval. The correct one is an anchor: occurrence 5's date is the **start date** plus five intervals, computed fresh every time.

The chain approach silently corrupts a monthly schedule anchored on the 31st. January 31 + 1 month has no 31st in February, so it clamps to February 28 (or 29). If the *next* computation adds a month to that clamped date — February 28 + 1 month — you land on March 28, not March 31. The schedule has permanently drifted off its anchor day, and nothing about the drift is visible in any single step; it only shows up months later when a user asks "why did my rent invoice move from the 31st to the 28th."

`utils/recurrence.ts`'s `occurrenceDate(startDate, frequency, intervalCount, occurrenceIndex)` never reads a previous occurrence. Every call recomputes from `startDate`:

```ts
// MONTHLY/QUARTERLY/YEARLY: compute months-to-add from the anchor, then clamp
let targetMonth = startMonth + monthsToAdd;
while (targetMonth > 12) { targetMonth -= 12; targetYear += 1; }
const lastDayOfMonth = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
const targetDay = Math.min(startDay, lastDayOfMonth);
```

`Date.UTC(year, month, 0)` is the standard "day 0 of month `month`" trick for getting the last day of the *previous* month index — since `month` here is already 1-based-plus-nothing (JS `Date.UTC` takes 0-based months, so passing the 1-based `targetMonth` as the month argument with day `0` returns the last day of `targetMonth - 1` in JS's indexing, i.e. the actual last day of the 1-based `targetMonth`). Every occurrence therefore clamps independently against the anchor day (31), not against whatever the previous occurrence clamped to. January 31 → February 28 → March 31 → April 30 → May 31, forever, never drifting off the 31st.

WEEKLY is simpler and needs no clamping — `addDays(startDate, 7 * intervalCount * occurrenceIndex)` — but it follows the same anchor discipline: it always adds from `startDate`, never from the previous week's date, so the day-of-week never drifts either (not that weekly arithmetic could drift in the first place, but the uniform rule is what makes the function easy to reason about and test without a special case per frequency).

All arithmetic is `Date.UTC`-based and dates are plain `YYYY-MM-DD` strings end to end — never a JS `Date` crossing a service boundary — for the same reason `postgresql/transactions-isolation-pooling.md`'s `DATE`-arrives-as-a-`Date` gotcha exists: a calendar date has no timezone, and representing it as an instant is lossy by definition. `occurrenceDate` reads and returns strings only; the one place a `Date` object appears is transiently, inside `Date.UTC(...).getUTCDate()`, purely to ask "how many days are in this month."

### Sweep plus per-entity job

The scheduler is two BullMQ jobs, not one, mirroring the pattern `integrationDriveSweepHandler.ts` (Phase 19.3) already established for Drive folder polling:

```
worker.ts: upsertJobScheduler('recurring-sweep-tick', { every: RECURRING_SWEEP_INTERVAL_MS }, ...)
  -> handleRecurringSweep()
       due = recurringService.listDueSchedules()   // cross-org, ids only
       for each due schedule: enqueue('recurring-generate', { orgId, scheduleId }, { jobId: bucketed })
            -> handleRecurringGenerate({ orgId, scheduleId })
                 recurringService.runDueOccurrences(orgId, scheduleId)
```

The sweep job runs on a fixed interval (`RECURRING_SWEEP_INTERVAL_MS`, 15 minutes) and does almost no work itself — one unscoped `SELECT` returning `{ orgId, scheduleId }` pairs, then a fan-out `enqueue` per due schedule. The actual generation — creating a draft invoice, posting a bill, writing a journal entry — happens in a **separate** job per schedule.

This split exists for the same reason the Drive sweep is split: **isolation of failure and latency**. If schedule A's generation throws (a closed fiscal period, an unexpected error) or simply takes a long time (three document-posting transactions with their own lock waits), that failure or delay is scoped to schedule A's own job. It cannot block the sweep from finishing its scan of every other org's due schedules, and it cannot delay schedule B's generation, which runs as its own independently-retried job. A single monolithic "scan and generate everything in one job" would turn one org's slow or failing schedule into a availability problem for every other org sharing the worker.

The `jobId` on the generate enqueue is time-bucketed (`recurring-generate-${scheduleId}-${bucket}`, where `bucket = Math.floor(Date.now() / RECURRING_SWEEP_INTERVAL_MS)`). BullMQ silently drops a second `add()` with a `jobId` that already exists in the queue (see `background-jobs-and-queues.md`'s `jobId` dedup discussion) — so if the sweep somehow ran twice inside the same interval bucket, the second enqueue for the same schedule is a no-op. This is explicitly a second, belt-and-braces guard: `listDueSchedules`'s own `next_run_date <= current_date` filter and `runDueOccurrences`'s row lock (below) are what actually make double-generation impossible, not this dedup key. The comment in `recurringSweepHandler.ts` says exactly this.

### `FOR UPDATE SKIP LOCKED` + advance-in-the-same-transaction + `UNIQUE (schedule_id, run_date)` — defence in depth

Exactly-once generation is not one mechanism; it's three, layered so that if the strongest one were ever bypassed by a bug, a weaker one still catches it.

**Layer 1 — the row lock.** `runDueOccurrences` reads the schedule twice: once *before* opening a transaction (a plain, unlocked read purely to decide whether to bother loading the template and opening a transaction at all), and once *inside* the transaction with the actual lock:

```sql
SELECT next_run_date, next_occurrence_index, ...
  FROM recurring_schedules
 WHERE id = $1 AND org_id = $2 AND status = 'ACTIVE' AND next_run_date <= current_date
 FOR UPDATE SKIP LOCKED
```

`SKIP LOCKED` means a second worker racing on the *same* schedule (two sweep ticks landing close together, or a manual "Run now" click racing the sweep) doesn't block — it finds zero rows and stops, rather than waiting for the first worker's transaction to finish and then re-reading a `next_run_date` that has already moved past due. This is the general `SKIP LOCKED` queue-claim shape from `postgresql/transactions-isolation-pooling.md`, applied to a single schedule row instead of a batch: "claim this unit of work, and if someone already has it, walk away instead of waiting."

**Layer 2 — advance the counter in the same transaction as the write.** Once the row is locked, `runDueOccurrences` creates the document (`createInvoiceOnClient`/`createBillOnClient`/`journalService.createEntryOnClient`), inserts the `recurring_runs` history row, and updates `next_run_date`/`next_occurrence_index` forward — all on the same client, inside the same `BEGIN…COMMIT`. Advancing the counter is not a follow-up step; it's part of the atomic unit. If any part of this fails, `ROLLBACK` undoes the document *and* leaves `next_run_date` exactly where it was, so the schedule is still due and will be picked up again — no occurrence is silently skipped, and no occurrence is silently double-counted.

**Layer 3 — the constraint as a backstop.** `ux_recurring_runs_schedule_date UNIQUE (schedule_id, run_date)` makes a second `recurring_runs` row for the same schedule and date a `23505` constraint violation, even if the lock discipline above were somehow bypassed — a bug in a future refactor, a direct SQL script run by mistake, anything. This is the same "belt and braces" reasoning rule 7's CHECK constraints get alongside service-level validation everywhere else in this codebase: the service is supposed to be correct, and the database is supposed to make "supposed to" into "provably can't be wrong" for the one property that actually matters (never posting the same occurrence twice).

None of the three layers is redundant in the sense of being removable — they defend against different failure classes (concurrent access, partial failure, a future bug bypassing the service entirely) — but they're deliberately overlapping so that no single mistake produces a duplicate financial document.

### Skip-missed on resume, versus catch-up

There are two different questions a paused-then-resumed schedule can answer, and this codebase deliberately picks different answers for the two situations it actually has:

- **`transitionSchedule('ACTIVE')` (an explicit user action — clicking Resume on a paused schedule)**: *skip* every occurrence that would have fallen due while paused. The loop in `transitionSchedule` advances `idx` from the stored `next_occurrence_index` while `occurrenceDate(...) < today`, without generating anything for the skipped dates, then stores the first date that is `>= today`. A schedule paused for three months and resumed does not generate three months of backdated invoices — it picks up from today going forward.
- **The sweep's own catch-up (`RECURRING_MAX_CATCHUP_PER_RUN = 12`)**: if a schedule stayed `ACTIVE` the whole time but the worker itself was down (deployment, crash, Redis outage), `runDueOccurrences` *does* generate the missed occurrences — up to 12 per invocation — because those occurrences were never explicitly deferred by a person; they were just late because infrastructure was unavailable, and the correct behaviour is to catch up, bounded so a schedule that's been broken for a year doesn't try to generate 365 invoices in one job.

The distinction is *intent*. Pausing is a deliberate "don't generate these" signal from a human, so resuming honours that by skipping. Worker downtime is not anyone's decision, so the sweep's job is to make the outage as invisible as it reasonably can — within a 12-occurrence cap, past which a real gap (a schedule stuck for over a year, or a persistently failing template) needs a human to look at `lastError`/`lastErrorAt` rather than the sweep quietly working through an unbounded backlog.

### Why the template is read before `BEGIN`

`runDueOccurrences` loads the invoice/bill/journal-entry template through each document's own public getter (`invoiceService.getInvoiceById`, `billService.getBillById`, `journalService.getEntryById`) **before** opening the generation transaction, not inside it:

```ts
// Step 1 — outside any transaction
const template = await loadTemplate(orgId, kind, pre);
// Step 2 — pool.connect(), beginTransaction, FOR UPDATE, generate, COMMIT
```

This looks at first glance like it violates "every query inside a transaction uses the checked-out client" — but it isn't inside a transaction at all, which is the point. The template is read-only data: nothing in `runDueOccurrences` mutates an invoice, bill, or journal entry — it only reads one to copy its lines, party, currency and payment terms onto a *new* document. Reading a value that will not be written to does not need transactional isolation from the write that follows; it only needs the write itself (the row lock in Layer 1 above) to guarantee the schedule wasn't already advanced or paused between the read and the write.

Two things make this safe rather than merely convenient:
- **The template cannot vanish.** Invoice/bill deletion is draft-only in this codebase, and `recurring_schedules`' FK to its source is `ON DELETE RESTRICT` — the database physically refuses to delete a template that a schedule still points at.
- **A template edited between the read and the lock is an accepted, documented gap**, not an oversight. If someone edits a draft invoice's line items between `loadTemplate`'s read and the transaction's row lock a moment later, the generated occurrence reflects the version that was read. This is acceptable because it's the same "read a value, then act" gap every non-locking read carries, and closing it would mean locking the *template* on every generation too — a template read far more often (every schedule pointing at it, every occurrence) than it's written, so locking it defensively for an edit window measured in milliseconds isn't worth the extra contention.

The practical payoff of reading outside the transaction: the transaction that actually holds locks and writes rows stays as short as possible — open the transaction, lock, generate, commit, release — rather than holding a connection (and its row locks) open across three extra read round-trips to load the template first.

### Rejected alternatives

| Alternative | Why it was rejected |
|---|---|
| **A JSON snapshot template**, copying the invoice/bill/journal's line items into the `recurring_schedules` row itself at creation time, instead of pointing at the live document | Would need its own currency/account/party validity re-checked at generation time anyway (an account could be deactivated between schedule creation and a generation two years later) — the live-document approach gets that validation for free by routing through the same `createInvoiceOnClient`/`createBillOnClient` validation every ordinary document creation already runs. A snapshot also duplicates data that can drift from the real chart of accounts, and gives no natural place to point a `*_id` foreign key at (rule 8) — it would be exactly the "polymorphic blob referencing nothing checkable" shape rule 8 exists to prevent. |
| **Cron per schedule in Redis** (a separate BullMQ repeatable job per `recurring_schedules` row, each with its own cron expression) | BullMQ's `upsertJobScheduler` state is Redis-resident and per-job — thousands of orgs each with several schedules would mean thousands of individually-registered repeatable jobs to create, update (every pause/resume/edit), and clean up on delete, all as Redis writes outside any Postgres transaction. The sweep-plus-generate shape needs exactly one scheduler entry (`recurring-sweep-tick`) regardless of how many schedules exist, and every schedule's due-ness is a plain SQL predicate (`next_run_date <= current_date`) the sweep already has to evaluate for the batch — no per-schedule Redis state to keep in sync with a schedule's Postgres row at all. |
| **A polymorphic `source_id` column** (one nullable UUID meaning "invoice id, bill id, or journal entry id depending on `kind`") | Rejected for the same reason rule 8 rejects it everywhere else in this codebase: a single `*_id` column can only carry one real `REFERENCES` constraint, so a polymorphic id either points at nothing checkable by the database, or needs a deferred/conditional FK trick that most engines (Postgres included, without extra machinery) don't support cleanly. `recurring_schedules` instead has three separate nullable columns (`source_invoice_id`, `source_bill_id`, `source_journal_entry_id`), each a real FK to its own table, with `chk_recurring_source_matches_kind` enforcing that exactly the one matching `kind` is non-null and the other two are null. The API surface presents this as one field (`sourceId = COALESCE(...)`), so the caller never sees the three-column shape — only the schema does. |

---

## Why we chose it here

| Decision | Reasoning |
|---|---|
| Anchor-based `occurrenceDate`, never chained from the previous occurrence | Prevents calendar drift on a 31st/29th anchor; every date is independently reproducible from `(startDate, frequency, intervalCount, index)` alone, which also makes it trivially unit-testable without any stateful setup |
| Sweep job + separate per-schedule generate job | One slow or failing schedule can't delay or break every other org's generation; matches the Drive-intake sweep precedent (Phase 19.3) |
| Row lock (`FOR UPDATE SKIP LOCKED`) + advance-in-transaction + a unique constraint, three layers | Each defends a different failure mode (concurrent claim, partial failure, a bug bypassing the service); none alone is sufficient for a guarantee this codebase treats as load-bearing (never double-posting a document) |
| Skip-missed on explicit resume, catch-up (capped at 12) on worker downtime | Different intents deserve different behaviour: a human's pause is a deliberate "don't generate these," infrastructure downtime is not anyone's decision and should be made up within a bound |
| Read the template before `BEGIN` | It's read-only, its source can't be deleted (`ON DELETE RESTRICT`), and keeping the transaction short (lock → write → commit) reduces how long any row lock is held |
| Three nullable FK columns instead of one polymorphic `source_id` | Rule 8 — every `*_id` needs a real, checkable `REFERENCES`; a polymorphic id can't have one |

## Where it lives in this codebase

- `server/src/utils/recurrence.ts` — `occurrenceDate`, `addDays`, `firstDayOfNextMonth`; `server/src/__tests__/recurrence.test.ts` — the anchor-drift cases (a 31st clamped by February, then returning to the 31st in March)
- `server/src/services/accounting/recurringService.ts` — `runDueOccurrences` (the lock-generate-advance loop), `listDueSchedules` (the documented rule-1 exception), `transitionSchedule` (the resume skip-missed loop)
- `server/src/db/migrations/075_ledger-core_recurring_schedules.sql` — `recurring_schedules`, `recurring_runs`, `ux_recurring_runs_schedule_date`, the three-FK `chk_recurring_source_matches_kind` shape
- `server/src/queue/handlers/recurringSweepHandler.ts`, `recurringGenerateHandler.ts` — the sweep/generate split, the bucketed `jobId`
- `server/src/config/constants.ts` — `RECURRING_SWEEP_INTERVAL_MS` (15 minutes), `RECURRING_MAX_CATCHUP_PER_RUN` (12)
- `server/src/__tests__/accounting/recurringSchedules.test.ts` — the exactly-once ("running twice on the same day generates exactly one document"), rollback, and skip-missed-on-resume integration cases
- `server/src/__tests__/accounting/recurringConstraints.test.ts` — `ux_recurring_runs_schedule_date` rejecting a second row as `23505`

## Gotchas

- **Chaining `occurrenceDate` calls (computing occurrence N+1 from occurrence N's own return value) silently reintroduces drift** — the function's entire correctness argument depends on every call starting from the real `startDate`, never from a previously-clamped result.
- **The pre-transaction template read is only safe because the template is provably read-only here.** Copying this pattern to a case where the "template" *can* be mutated by the same code path would reintroduce the exact stale-read race this file's own comment calls out as intentional and bounded.
- **`RECURRING_MAX_CATCHUP_PER_RUN` is a per-invocation cap, not a total cap** — a schedule that's been down long enough to need more than 12 catch-up occurrences will need `runDueOccurrences` invoked again (the next sweep tick, 15 minutes later) to make further progress; it does not error out or lose the excess occurrences, it just generates 12 per pass until it catches up entirely.
- **`listDueSchedules` is unscoped by `org_id` by design** — it is the one place in `recurringService.ts` that reads across every organization, exactly mirroring `driveSyncService.listFoldersDueForSync`'s documented rule-1 exception: it returns ids only, and every downstream call (`runDueOccurrences`) re-scopes by that row's own `orgId` immediately.
- **A recurring journal always posts (`chk_recurring_journal_posts`)** — `mode = 'DRAFT'` is refused at creation for `kind = 'JOURNAL'` (`422 'A recurring journal always posts'`), because an unposted journal entry has no accounting meaning to generate on a schedule; a draft invoice or bill is still a real (if unissued) document, but a draft journal entry is nothing at all.

## Interview Q&A

**Q: Why does computing "the 5th occurrence of a monthly schedule" from the *anchor* start date avoid a bug that computing it from "the 4th occurrence's date + 1 month" would have?**
A: Because months have different lengths, so adding "1 month" to a clamped date compounds the clamp. A schedule anchored on the 31st hits February and clamps to the 28th (there's no 31st). If the *next* computation adds a month to that already-clamped February 28th, you get March 28th — the schedule has now permanently drifted off the 31st, and nothing about that step looked wrong in isolation. Computing every occurrence from the original anchor date instead means each occurrence clamps independently against the same anchor day, so January 31 → February 28 → March 31 → April 30 → May 31 forever, with the 31st preserved every time it's available. The fix isn't a smarter clamp — it's never letting a clamped value become the input to the next calculation.

**Q: You have a sweep job that finds due schedules and a separate job that generates each one. Why not do it all in one job?**
A: Blast radius. If generation for one schedule is slow (multiple posting transactions with their own lock waits) or throws (a closed fiscal period, an unexpected error), that failure needs to be scoped to that one schedule — it shouldn't delay the sweep from finishing its scan of every other organization's due schedules, and it shouldn't block or slow down generation for a completely unrelated schedule. Splitting them into a scan job and a per-entity job means each schedule's generation is retried, delayed, or failed independently, with BullMQ's own retry/backoff machinery applying per job, not per sweep run.

**Q: How do you guarantee a recurring schedule generates each due occurrence exactly once, even with two workers or two sweep ticks racing?**
A: Three layers, deliberately redundant. First, the schedule row is claimed with `SELECT ... FOR UPDATE SKIP LOCKED` inside the generation transaction — a second worker racing on the same schedule finds zero rows and simply walks away rather than blocking and re-processing a stale due date. Second, advancing `next_run_date`/`next_occurrence_index` happens in the *same* transaction as creating the document and its history row, so a rollback undoes both together — no occurrence is half-generated. Third, a unique constraint on `(schedule_id, run_date)` on the history table makes a second row for the same occurrence a hard constraint violation even if the first two layers were somehow bypassed by a bug. None of the three is individually sufficient to trust on its own for something this consequential — together they are.

**Q: A schedule was paused for three months and then resumed. Does it generate three months of backdated invoices?**
A: No — resuming explicitly skips every occurrence that fell due while paused and picks up from today forward. That's different from what happens if the *worker itself* goes down while a schedule stays active: in that case the sweep does catch up missed occurrences, bounded to a fixed number per run. The distinction is intent — a pause is a deliberate human decision not to generate those occurrences, so resuming honours that by skipping them; worker downtime isn't anyone's decision, so the system's job is to make the outage as invisible as it reasonably can, within a bound that keeps a very stale schedule from generating an unbounded backlog in one shot.

**Q: Why read the invoice/bill/journal template before opening the generation transaction, instead of inside it?**
A: Because the template is provably read-only in this flow — nothing in the generation path ever mutates the source document, it only copies fields off it onto a new one. Reading something that won't be written doesn't need to share a transaction with the write that follows; it only needs the write's own lock to guarantee the schedule wasn't paused or already advanced between the read and the lock. Two things make this genuinely safe rather than just convenient: the template can't be deleted out from under the schedule (an `ON DELETE RESTRICT` foreign key), and a template edited in the gap between the read and the lock is an accepted, documented trade-off — closing that gap would mean locking a document that's read constantly and written rarely, for the sake of a window measured in milliseconds.

**Q: Why does `recurring_schedules` have three separate nullable foreign-key columns (`source_invoice_id`, `source_bill_id`, `source_journal_entry_id`) instead of one `source_id` plus a `source_type` discriminator?**
A: Because a single `source_id` column can only carry one real foreign key, and this schedule's template might be in any of three different tables depending on `kind`. A polymorphic id either points at nothing the database can actually check, or needs extra machinery most engines don't give you for free. Three columns, each a genuine `REFERENCES` to its own table, plus a CHECK constraint (`chk_recurring_source_matches_kind`) enforcing that exactly the column matching `kind` is populated and the other two are null, makes "the wrong source for this kind" something the database itself refuses to store — not just something the service layer is supposed to remember to validate. The API still exposes a single `sourceId` field to callers; only the schema underneath has three columns.

**Q: What's the actual difference between recording a failure with `pool.query` after a rolled-back transaction, versus just retrying the whole job?**
A: The two aren't substitutes — recording `lastError` happens *in addition to*, not instead of, the decision about whether to retry. After a rollback, the code distinguishes a known, business-level failure (an `ApiError`, or Postgres raising `P0001` — a closed fiscal period, for instance) from an unexpected one. For the known case, it records the message on the schedule via a fresh `pool.query` call — deliberately not inside the just-rolled-back transaction, since that transaction's client can't be reused for new work — and returns normally rather than throwing, because a closed period isn't going to fix itself if BullMQ retries in thirty seconds. For an unexpected error, it still records what it can, but then rethrows, so BullMQ's normal retry-and-eventually-dead-letter behaviour applies. The rollback having already undone everything is what makes the rethrow safe — there's nothing left behind for a retry to duplicate.

## Follow-ups they'll dig into

- *"What if the sweep interval and the catch-up cap interact badly — a schedule that's been down for a year?"* It needs `ceil(missed / 12)` separate sweep ticks to fully catch up, each one 15 minutes apart by default — at 12 per tick that's a real but bounded amount of wall-clock time, and `lastError`/`lastErrorAt` gives an operator visibility into a schedule that's stuck rather than merely catching up slowly (a stuck schedule keeps failing the same way every tick; a catching-up one keeps succeeding and advancing).
- *"Could two different schedules ever deadlock against each other the way StockLedger's balance rows can?"* No — each `runDueOccurrences` call only ever locks its own single schedule row (never more than one schedule per transaction), so there's no multi-row lock ordering problem here the way there is for a transfer touching two balance rows.
- *"What happens if `RECURRING_SWEEP_INTERVAL_MS` is lowered a lot — say to 10 seconds?"* The bucketed `jobId` dedup key changes bucket every 10 seconds instead of every 15 minutes, so a schedule already being processed by a still-running generate job could get a second, differently-bucketed job enqueued for it — but the row lock (`FOR UPDATE SKIP LOCKED`) is what actually prevents double-processing in that case, not the dedup key; the second job would simply find the row already locked or already advanced and exit immediately with `generated: 0`.

## See also

- [../postgresql/transactions-isolation-pooling.md](../postgresql/transactions-isolation-pooling.md) — `FOR UPDATE SKIP LOCKED` as a general queue-claim primitive, and the `DATE`-as-string discipline this file's date arithmetic depends on
- [background-jobs-and-queues.md](background-jobs-and-queues.md) — BullMQ fundamentals, `jobId` dedup, `upsertJobScheduler`, the Drive-intake sweep precedent this design copies
- [cross-app-transactional-bridge.md](cross-app-transactional-bridge.md) — the `*OnClient` pattern this service uses to create invoices/bills/journal entries on its own transaction client
- [document-lifecycle-fsm.md](document-lifecycle-fsm.md) — `RECURRING_STATUS_TRANSITIONS`, one more FSM transition table in the same style
