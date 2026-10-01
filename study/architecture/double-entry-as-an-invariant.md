# Double-Entry as an Invariant System

> Double-entry bookkeeping is not a convention for recording money — it is a redundancy scheme that makes a whole class of error detectable, and an append-only ledger is what stops that redundancy being edited away.

**Category:** Architecture
**Introduced by:** Phase 3 — LedgerCore's GL core: `journal_entries`, `ledger_lines`, reversing entries, trial balance
**Verified against:** the codebase as of Phase 3 (2026-09-02), PostgreSQL 16

---

## Mechanism

### The accounting model, stated as a data structure

Every financial event is one **journal entry** with two or more **lines**. Each line names an account and puts a positive amount on exactly one side — debit or credit. The entry is valid only if:

```text
SUM(debits) == SUM(credits)      and      COUNT(lines) >= 2
```

Five account types, and only five: `Asset`, `Liability`, `Equity`, `Revenue`, `Expense`. They divide into two halves by which side increases them:

| Half | Types | Increased by |
|---|---|---|
| Debit-balance | Asset, Expense | debits |
| Credit-balance | Liability, Equity, Revenue | credits |

That split is why a trial balance is *type-aware*: reporting a raw `debit − credit` would show every revenue account as negative income. And it is why Cost of Goods Sold is **not** a sixth type — COGS accounts are `Expense`, separated from operating expenses by the `5xxx` code range, not by type.

### Why two entries rather than one

Recording "cash decreased by 450" is one fact and cannot be checked. Recording "cash decreased by 450 **and** software expense increased by 450" is two facts about one event, and they must agree.

That is the redundancy. It buys three things:

1. **A whole error class becomes detectable.** A typo in one line breaks the equality. A single-sided ledger would just be quietly wrong.
2. **A global check exists.** `SUM(debits) − SUM(credits)` across the entire database must be zero. There is no equivalent for a single-sided ledger.
3. **The balance sheet is derivable rather than maintained.** Assets = Liabilities + Equity is a consequence of every entry balancing, not a separate thing to keep true.

Double-entry is, in modern terms, a **checksum on financial data that a human designed in 1494 and that still works**.

### Append-only, and why a counter is the wrong shape

The naive design is `accounts.balance_cents`, updated on every transaction. It fails in three separate ways:

- **Lost updates.** Read-then-write on a hot row. Two concurrent postings both read 1000, both write their own result, one vanishes. Fixing it needs `SELECT … FOR UPDATE` or SERIALIZABLE-with-retry, and now the busiest row in the system is a lock contention point.
- **No history.** The balance is 8,320. Why? A counter cannot answer that.
- **Drift is unfalsifiable.** If the counter and the transactions ever disagree, nothing tells you which one is right.

The append-only alternative stores only the events and derives the balance:

```sql
SELECT SUM(base_debit_cents) - SUM(base_credit_cents)
  FROM ledger_lines WHERE account_id = $1 AND org_id = $2
```

Appending rows never contends the way `UPDATE counter` does — two concurrent inserts touch different rows — so an entire category of concurrency bug is **structurally impossible** rather than defended against. That is the highest-value move available: not fixing a bug, but choosing a shape in which the bug cannot be expressed.

### Correcting the past without editing it

If rows are immutable, a mistake cannot be edited. It is corrected by posting a **reversing entry** — the same lines with debit and credit swapped, linked to the original by `reverses_entry_id`:

| Original | | | Reversal | | |
|---|---|---|---|---|---|
| `6120` Software | Dr 450.00 | | `6120` Software | | Cr 450.00 |
| `2100` Payable | | Cr 450.00 | `2100` Payable | Dr 450.00 | |

Both entries stay in the ledger forever. The net effect is zero, and the *history* records that a mistake was made and corrected — which is exactly what an auditor needs and exactly what an `UPDATE` destroys.

Note the amounts stay **positive** and swap sides. A "negative debit" would balance arithmetically but misstate the account's turnover, and the `CHECK (debit_cents >= 0)` constraint rejects it anyway.

### Derived vs stored: where the line actually falls

Deriving everything is not free — every report re-aggregates. The honest rule:

| | Derive | Store |
|---|---|---|
| **When** | The source rows are the truth and can be aggregated fast enough | Aggregation is genuinely too slow, and staleness is acceptable |
| **Cost** | CPU per read | A second source of truth that can drift |
| **Escape hatch** | — | A materialized view with an explicit refresh, never a hand-maintained column |

LedgerCore derives, and Phase 4's statements will too. When that stops being fast enough the answer is a materialized view — still derived, just cached, with the derivation still the definition.

---

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Single-sided transaction log + balance column | Simplest to write and query | Rejected — no error detection, lost updates, drift |
| **Double-entry, append-only, balances derived** | Every write is ≥ 2 rows; reports aggregate | **Chosen** |
| Event sourcing with a projection store | Full replay, temporal queries | Rejected — we already have the event log; a separate projection store is a second source of truth and Phase 3 does not need replay |
| Double-entry with mutable entries | Familiar CRUD | Rejected — destroys the audit trail, and rule 6 forbids it |

**Where we sit relative to event sourcing** is worth being precise about, because it is a common interview follow-up. `ledger_lines` *is* an append-only event log, and balances are a fold over it — that is the event-sourcing core idea. What we do not have is a separate projection store, event versioning, or replay-to-rebuild machinery. So: event-sourced in shape, CRUD in operational complexity. The accounting domain got there 500 years early.

---

## Where it lives in this codebase

- `server/src/db/migrations/004_ledger-core_journals.sql` — the tables, the CHECK constraints for the per-line rule, and the deferred constraint triggers for the per-entry rule
- `server/src/services/accounting/journalService.ts` — `createEntry` (one transaction), `reverseEntry` (the only correction path)
- `server/src/services/accounting/reportService.ts` — the trial balance, aggregated from raw lines with no summary table
- `server/src/types/accounting.ts` — `ACCOUNT_TYPES`, exactly five
- `server/src/__tests__/accounting/ledgerConstraints.test.ts` — the global `SUM(debits) − SUM(credits) = 0` assertion

---

## Gotchas

- **Debit does not mean "decrease".** Debit is the left side; whether it increases or decreases an account depends on the account's type. The names are positional, not directional.
- **A reversal swaps sides; it never negates.** Negative amounts balance arithmetically and misstate turnover.
- **COGS is not a sixth account type.** The temptation is constant. It is an `Expense`, distinguished by code range.
- **"Balanced" must be integer equality.** An epsilon on money is the bug that sank the prior build.
- **Report in one currency.** Summing native amounts across currencies produces a number that means nothing — every report aggregates the `base_*` columns.
- **Header accounts take no postings.** `1000 Assets` is a rollup for reporting; posting to both it and its children would double-count.
- **Zero-line entries are vacuously balanced.** Guard the count as well as the sum.

---

## Interview Q&A

**Q: Explain double-entry bookkeeping to an engineer who has never seen it.**
A: Every financial event is recorded as at least two lines that must sum to zero — one or more debits and one or more credits, equal in total. Buying a $450 server on credit is a $450 debit to a software expense account and a $450 credit to accounts payable. The reason it's two entries rather than one is that a single number can't be checked against anything, whereas two numbers describing the same event can disagree — so a typo becomes detectable. It's a checksum on financial data. The system-wide consequence is that total debits across the whole database must always equal total credits, which gives you a one-line integrity test over the entire dataset.

**Q: Why an append-only ledger rather than a balance column you update?**
A: Three reasons, and the third is the one I care most about. First, a mutable counter is read-then-write on a hot row, so concurrent postings lose updates unless you take a row lock — which makes the busiest row in the system a contention point. Second, a counter has no history: it says the balance is 8,320 and can't say why. Third, and most important, appending rows and deriving the balance makes the lost-update bug *structurally impossible* rather than defended against — two inserts touch different rows, so there's nothing to contend. I'd rather choose a shape where a bug can't be expressed than write a lock that has to be right every time. The cost is that reads aggregate, which for tens of thousands of rows is single-digit milliseconds.

**Q: How do you correct a mistake in an immutable ledger?**
A: A reversing entry — the same lines with debits and credits swapped, linked to the original with a `reverses_entry_id` foreign key. Both entries stay in the ledger permanently; the net effect is zero and the history records that a mistake was made and corrected. That's precisely what an auditor wants to see and precisely what an `UPDATE` would destroy. In my implementation there's no route that can update or delete a posted entry, and a database trigger rejects the write even if someone added one — so the only reachable correction path is the reversal endpoint.

**Q: Is this event sourcing?**
A: In shape, largely yes — `ledger_lines` is an append-only event log and every balance is a fold over it. What it doesn't have is the operational machinery people usually mean: no separate projection store, no event versioning, no replay-to-rebuild. I deliberately didn't add those, because a projection store is a second source of truth that can drift, which is the exact problem I was avoiding. The interesting observation is that accounting arrived at the event-sourcing insight about five centuries before software did.

**Q: Tell me about a design decision you made here that you'd defend.**
A: Enforcing the balance invariant in the database as well as the service. The service checks it before writing, but that only protects writes going through the service — a migration, a data-fix script, or one `psql` session bypasses it. So there's a deferred constraint trigger that recomputes the sum at commit. It fires at `COMMIT` rather than per statement, because a two-line entry is legitimately unbalanced after the first insert. The result is that an unbalanced entry can't exist in the database regardless of what wrote it. It cost a trigger and some care in the tests, and it turned a rule into an invariant.

---

## Follow-ups they'll dig into

- *"How do you handle multi-currency?"* Each line stores its native amount, the base-currency amount, and the rate used at the transaction date. Reports sum the base columns. When a foreign-currency receivable settles at a different rate, the difference is posted to a realized FX gain/loss account — which is what makes the entry balance.
- *"How would you close a period?"* A `fiscal_periods` table with an `EXCLUDE USING GIST` constraint so periods cannot overlap, and a trigger rejecting postings into a closed one.
- *"What if the trial balance is slow at 10 million rows?"* Index on `(org_id, account_id)`, then a materialized view refreshed on a schedule — still derived, just cached. A hand-maintained column stays off the table.
- *"What's a suspense account?"* Where you post a difference you can't yet explain so the entry balances; the outstanding balance is itself the to-do list.

---

---

## Phase 36c additions — balance checked before posting, and one refusal map for two paths

**Verified against:** PostgreSQL 16; `journalService.ts` (`createEntryOnClient`, `assertNotControlAccountsOnClient`, `listControlAccountsOnClient`), `journalImportService.ts`, `fiscalPeriodService.periodStatusOnClient`.

### Validating balance before posting vs relying on the deferred trigger

The deferred constraint trigger is the **backstop**: it fires at `COMMIT`, sees the final set of lines and aborts the whole transaction on imbalance. As a *user-facing* error it is poor — it fires late, names no row, and rolls back everything. A staged import of 300 journal lines needs the opposite: find every unbalanced entry up front and say which one. So the importer checks balance itself, in integer cents (`d !== c`, never an epsilon), at three layers that do different jobs:

| Layer | Job | What the user sees |
|---|---|---|
| `journalImportService.validateRows` | Find problems before commit, per group | `The journal J-2 does not balance: debits 1.00, credits 0.99` on every row of J-2 |
| `createEntryOnClient` | Assert the same invariant at the service boundary for every caller | A 422 with the entry's label (wrapped as `The journal J-2 (rows 4–5): …`) |
| Deferred trigger | Make it impossible for any code path, incl. a bug in the two above, to persist an imbalance | A raw DB exception; in normal operation it never fires |

Redundant on purpose: the first is UX, the second is the contract, the third is the guarantee. A bug in layer 1 (say, it mis-signs an `Amount`) produces a row that validated but fails at commit as a clean 422 from layer 2 — not a corrupt ledger.

**One side per line.** The signed `Amount` column is translated into the same `{debitCents, creditCents}` pair the database requires (rule 7): positive → debit, negative → credit of `-amount`; zero is rejected (`A line needs a non-zero amount`), as are a row with both Debit and Credit set or neither. The import never invents a shape the table's CHECK does not allow.

**Only the validator reports "does not balance" when every line resolved.** If one amount failed to parse, the sum is meaningless, so the check is withheld rather than reporting a misleading total.

### One refusal map shared by the manual path and the import path

Manual journals may not post to the receivable, payable or inventory control accounts (Phases 25, 35a): those balances must equal their subledgers. Two callers now need that rule — the manual journal route (throw on the first hit) and the importer's validator (flag every row, all at once). Copying the rule would let the two drift, which is exactly the class of bug the rule exists to prevent. So `loadControlAccountsOnClient` builds a `Map<accountId, message>` once, `listControlAccountsOnClient` exposes it, and `assertNotControlAccountsOnClient` is rewritten on top of the same map. The message text is byte-identical to the pre-refactor text; the import test `control accounts are refused at validation with the manual-journal message` asserts the row error equals what the manual path throws.

**Precedence gotcha.** The map's insertion order is receivable, payable, inventory. The plan said to throw the first map entry present in the journal's lines; that would change which inventory account is named when a journal has several (map order instead of line order). The implementation keeps the old behaviour exactly — receivable, then payable, then remaining ids in **line order** — by checking those two ids explicitly and then iterating `accountIds`. Refactors that "share a map" quietly change tie-breaking unless a test pins it; the existing manual-journal tests were the gate and ran unedited.

**Enforced twice.** The import rejects control accounts at validation, and commit revalidates (36b's revalidate-at-commit), because `createEntryOnClient` does *not* call the assertion (the manual `createEntry` path and the recurring/bank-rule callers do, explicitly): without the commit-time recheck, an org changing its receivable setting between validate and commit could let an import post to a control account.

**Period status, same idea.** `assertPeriodOpenOnClient` *throws*; a validator needs a value. `periodStatusOnClient` returns the status or `null` (no period covers the date, posting allowed) and never throws; the assertion is rebuilt on it with its message unchanged. The importer caches it per date and appends `…is closed; reopen it or change the date` to the group's rows. `null` means "no period row", not "open" — a date outside generated periods posts.

### Interview Q&A (36c)

**Q: You have a deferred balance trigger. Why also check balance in application code before posting?**
A: The trigger guarantees no code path can persist an unbalanced entry, but it reports too late and too coarsely: at commit, for the whole transaction, without saying which entry. For a bulk import I want every bad entry named before anything is written, so the validator computes integer debit and credit sums per group and reports them on the rows. The service-level check gives every caller a readable 422, and the trigger remains the guarantee if either check has a bug. They are different layers with different audiences, not duplicates.

**Q: Two code paths need the same business rule, one throwing on the first violation and one collecting all of them. How do you avoid duplicating it?**
A: Extract the rule as data rather than as a throwing function: here, a map from account id to refusal message. The throwing path looks ids up and throws on the first; the collecting path looks up every row. The hazard is that extracting changes tie-breaking — the old code had a fixed precedence among the three control-account kinds — so I preserved that explicitly and relied on the unedited existing tests to prove the messages and precedence did not move.

**Q: A row's validation passed yesterday. What can make the commit fail today even though you did not touch the file?**
A: Anything the validation read: a fiscal period closed, an account deactivated, or the control-account setting changed. Commit revalidates under the import row lock, so the user gets a 409 `became invalid since validation` with nothing posted, rather than a half-written batch. The test closes the period after validation and asserts the 409 and zero entries.

### Follow-ups (36c)

- "Why not let the trigger be the only check?" It cannot produce a per-row message and it aborts the whole batch at the very end; it is a guarantee, not a UX.
- "Why is `null` period status allowed?" Periods are generated ranges; a date with no period row has nothing to be closed, and the existing `assertPeriodOpenOnClient` already allowed it.

## See also

- [deferred-constraint-triggers.md](../postgresql/deferred-constraint-triggers.md) — how the invariant is enforced by the database
- [branded-types-for-money.md](../typescript/branded-types-for-money.md) — why the balance comparison is exact
- [multi-tenancy-row-level-scoping.md](multi-tenancy-row-level-scoping.md) — the `org_id` boundary every ledger query carries
- [transactions-isolation-pooling.md](../postgresql/transactions-isolation-pooling.md) — the transaction an entry and its lines commit inside
