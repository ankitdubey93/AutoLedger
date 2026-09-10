# Multi-Currency and Functional Currency: What "Balanced" Means When Units Differ

> A journal entry with a $1,000 USD line and a ₹500 INR line has debits of "1000 + 500" in no unit that exists. "Balanced" cannot mean equal native sums once more than one currency is on the same entry — it can only mean equal sums *in one chosen currency*. That currency is the organization's **functional currency**, and Phase 8's central engineering move is teaching the balance invariant to check that currency and only that currency.

**Category:** PostgreSQL
**Introduced by:** Phase 8 — the multi-currency FX engine: `fx_rates`, foreign-currency invoices/bills/payments, realized settlement gain/loss, and period-end unrealized revaluation.
**Verified against:** PostgreSQL 16, `pg` (node-postgres) 8.x.

---

## Mechanism

### Every line already carried the columns it would need

Phase 3's `ledger_lines` table was over-built on purpose: `currency_code`, `fx_rate NUMERIC(18,8)`, `base_debit_cents`, `base_credit_cents` existed from the very first migration, years (in project time) before Phase 8 gave them a reason to differ from the native `debit_cents`/`credit_cents`. The reasoning, recorded in migration 004's own comments: once a line is written without its native amount and the rate used to convert it, that information cannot be reconstructed by a later migration — a backfill can compute a *plausible* base amount from today's rate table, but not the rate that was actually in force the day the line posted. So Phase 3 paid the schema cost immediately and left the *engine* — the code that makes `fx_rate` anything other than `1` — for Phase 8. Every line between Phase 3 and Phase 8 has `currency_code = base_currency`, `fx_rate = 1.00000000`, and `base_* = native *` by simple arithmetic identity, which is what let Phase 8 land with zero backfill and zero observable change to any base-currency posting.

### Redefining an invariant without editing the migration that created it

Migration 004's `assert_journal_entry_balanced()` is a `DEFERRABLE INITIALLY DEFERRED` constraint trigger (see [deferred-constraint-triggers.md](deferred-constraint-triggers.md)) that fires once at `COMMIT` and checks `SUM(debit_cents) = SUM(credit_cents)` across every line of an entry. Phase 8 needed to change that check's *meaning* without touching a file this codebase's own rule forbids editing once applied ([migrations-and-schema-evolution.md](migrations-and-schema-evolution.md)). The fix is `CREATE OR REPLACE FUNCTION` in a brand-new migration (023), naming the exact same function `assert_journal_entry_balanced()`:

```sql
CREATE OR REPLACE FUNCTION assert_journal_entry_balanced() RETURNS trigger AS $$
...
$$ LANGUAGE plpgsql;
```

`004`'s two `CREATE CONSTRAINT TRIGGER` statements reference the function *by name*, not by a frozen definition — Postgres resolves the function body at fire time, not at trigger-creation time — so redefining the function is enough. Re-issuing `CREATE CONSTRAINT TRIGGER` for the same trigger name would be a second, redundant definition (and `CONSTRAINT TRIGGER` supports neither `IF NOT EXISTS` nor `OR REPLACE`, unlike a plain trigger); the correct move is *only* the function, and `004`'s own checksum on disk is untouched, so the migration runner's edit-detection ([migrations-and-schema-evolution.md](migrations-and-schema-evolution.md)) never fires.

### The two-sum rule

The redefined function now computes a `currency_count` alongside the existing debit/credit sums:

```sql
SELECT COALESCE(SUM(debit_cents), 0), COALESCE(SUM(credit_cents), 0),
       COALESCE(SUM(base_debit_cents), 0), COALESCE(SUM(base_credit_cents), 0),
       COUNT(*), COUNT(DISTINCT currency_code)
  INTO total_debit, total_credit, total_base_debit, total_base_credit, line_count, currency_count
  FROM ledger_lines
 WHERE journal_entry_id = target_entry;

IF currency_count = 1 AND total_debit <> total_credit THEN
  RAISE EXCEPTION 'journal entry % is unbalanced (debits=%, credits=%)', ...;
END IF;

IF total_base_debit <> total_base_credit THEN
  RAISE EXCEPTION 'journal entry % is unbalanced in base currency (debits=%, credits=%)', ...;
END IF;
```

Two rules, in order:

1. **The native-currency sum is checked only when every line in the entry shares one `currency_code`.** This is the branch every entry from Phase 3 through Phase 7 falls into — one currency, always — so it is checked exactly as strictly as before. Nothing about this branch changed; it is *guarded*, not weakened.
2. **The base-currency sum is checked unconditionally, on every entry, always.** This is the invariant that actually protects the books once a second currency exists in the system. A realized-FX settlement entry (see [study/architecture/realized-and-unrealized-fx.md](../architecture/realized-and-unrealized-fx.md)) legitimately posts a USD receivable line, a USD cash line, and an INR gain line in the same entry — three native amounts in two units, with no meaningful sum. The base-currency amounts, by contrast, are all in the same unit by construction, and *that* sum is what "balanced" now means.

Order matters for a subtler reason than readability: a single-currency entry that is unbalanced natively is *also* unbalanced in base currency (base is a scalar multiple of native at a constant rate within one currency), so checking native first produces the more specific, more useful error message — `debits=1000, credits=900` rather than `debits in base currency=83000, credits=74700` — for the overwhelmingly common case.

### A CHECK constraint closes the other half

The trigger proves an *entry* balances in base currency. It says nothing about whether an individual *line*'s `base_debit_cents` actually equals its own `debit_cents × fx_rate` — a service bug (or a hand-typed `INSERT`) could write a debit of $100 at a rate of 83 with a base amount of ₹1 and the entry-level trigger would never notice, because it only sums what is already there. That is a single-row property, which is exactly what a `CHECK` constraint — not a trigger — is for (see [deferred-constraint-triggers.md](deferred-constraint-triggers.md) on the CHECK/trigger boundary):

```sql
ALTER TABLE ledger_lines ADD CONSTRAINT chk_ledger_lines_base_matches_rate
  CHECK (base_debit_cents  = round(debit_cents  * fx_rate)
     AND base_credit_cents = round(credit_cents * fx_rate));
```

This validates against the whole pre-existing table with **no backfill**, because every row ever written has `fx_rate = 1`, and `base_* = round(native * 1) = native` is true by arithmetic, not by migration effort.

### Why `round()` and `scaleCents()` are provably the same function

`round(numeric)` in Postgres rounds half away from zero. `utils/money.ts`'s `scaleCents` — the function every rate conversion in the TypeScript service layer goes through — rounds half up, in exact `BigInt` arithmetic, never a float. For every value these columns ever hold (a ledger line's `debit_cents`/`credit_cents` are non-negative by `CHECK (debit_cents >= 0)`), *half away from zero* and *half up* are the identical rule: rounding a non-negative number away from zero is indistinguishable from rounding it up. That identity is not a coincidence to be careful about — it is the specific reason the database's CHECK and the service's `convertToBase` (a one-line wrapper: `scaleCents(nativeCents, rateNumerator(rate), RATE_SCALE)`) can be trusted to agree to the cent without a single shared line of code between PL/pgSQL and TypeScript. If a negative money value ever reached this path, the identity would break silently — which is exactly why it never can: `chk_line_nonzero` and the `>= 0` CHECKs on `debit_cents`/`credit_cents` make it structurally impossible.

### A rate is a ratio, not an amount, and it is parsed exactly once

`fx_rates.rate` and `ledger_lines.fx_rate` are both `NUMERIC(18,8)` — the one place in this schema `NUMERIC` is correct rather than a guardrail violation, because a rate needs sub-cent precision a `BIGINT` cannot express and is never itself money (rule 3 governs *amounts*, not *ratios*). `pg` returns `NUMERIC` as a JS string by default, for the same reason it returns `BIGINT` as a string: an arbitrary-precision decimal cannot round-trip through IEEE-754 without risking silent drift (see [branded-types-for-money.md](../typescript/branded-types-for-money.md)). `utils/fxRate.ts`'s `rateNumerator` is the *only* place that string is ever turned into a `number` — it right-pads the fractional part to 8 digits and parses the whole thing as one integer (`8350000000` for `"83.50000000"`), which is then fed to `scaleCents` as an exact-integer numerator over a fixed `RATE_SCALE` (`1e8`) denominator. `Number(rate) * cents` — a direct float multiplication — never appears anywhere in the codebase; it is the specific bug this module exists to make structurally unreachable.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Redefine the balance check to always sum native amounts, converting on the fly inside the trigger | The trigger would need to resolve an exchange rate itself — a network-adjacent lookup with no natural transaction-time semantics inside `COMMIT`-time trigger execution — and would duplicate `utils/fxRate.ts`'s conversion logic in PL/pgSQL | Rejected — conversion belongs in the service, where the rate was already resolved and frozen before the row was ever written |
| A second `journal_entries.reporting_currency` column, with every line's native amount cast to it in the query | Still requires per-line rate storage to convert correctly, so it buys nothing over the `base_*` columns already on `ledger_lines`, while adding a second source of truth for "what currency is this entry in" (a mixed-currency entry has no single answer) | Rejected |
| Per-account currency (an account itself is "a USD account") | A cash account may legitimately receive lines in several currencies over its life; forcing one currency per account would either reject valid multi-currency cash receipts or require a second account per currency, multiplying the chart of accounts | Rejected — out of scope, recorded as a deliberate limit in `docs/ledger-core.md` |
| Store only the base amount, discard the native amount and rate | Makes a foreign-currency document's own presentation (an invoice shown to a USD customer) impossible to reconstruct, and destroys the information a later audit or dispute needs | Rejected — this is exactly the information Phase 3 refused to let go unrecorded |

## Where it lives in this codebase

- `server/src/db/migrations/004_ledger-core_journals.sql` — the original `ledger_lines` columns and `assert_journal_entry_balanced()`, at rate 1 for every row it will ever see before Phase 8
- `server/src/db/migrations/023_ledger-core_base_currency_balance.sql` — the `CREATE OR REPLACE FUNCTION` redefinition and `chk_ledger_lines_base_matches_rate`
- `server/src/utils/fxRate.ts` — `RATE_SCALE`, `rateNumerator`, `convertToBase`, `ONE_RATE`; the only place a rate string becomes a number
- `server/src/services/ledger-core/journalService.ts`'s `createEntryOnClient` — resolves each line's currency/rate (defaulting to base currency at `ONE_RATE` when omitted), converts every line, and pre-checks both the conditional native sum and the unconditional base sum before the row ever reaches the database
- `server/src/__tests__/ledger-core/fxLedgerConstraints.test.ts` — raw-SQL proof that both checks hold independently of `journalService`, bypassing the service entirely (mirroring `ledgerConstraints.test.ts`'s doctrine: "these prove that a data-fix script... cannot write an unbalanced ledger either")

## Gotchas

- **Editing `004` to add the base-check would have been the wrong fix**, even though it is the file that "owns" the invariant conceptually — this codebase's rule 13 (never edit an applied migration) exists precisely so that two environments running the same migration set never diverge on what that migration actually did. `CREATE OR REPLACE FUNCTION` in a new file is the sanctioned tool for "the rule this migration enforces needs to change."
- **A single-currency entry's native check must run *before* the base check**, not after — reversing the order would still catch the same unbalanced entries, but every error message would report the less specific, less immediately useful base-currency totals even for the overwhelmingly common single-currency case.
- **`round()` and `scaleCents` only agree because every value is non-negative.** Introducing a negative money value anywhere near this conversion path (there is currently no such value — `debit_cents`/`credit_cents` are both `>= 0` by CHECK) would silently break the database/service agreement, because "round half away from zero" and "round half up" diverge for negative numbers.
- **A rate is not money and must never touch `utils/money.ts`'s cents helpers directly** — `parseCents` would reject a `NUMERIC(18,8)` string like `"83.50000000"` outright (it only accepts a bare integer string), which is a deliberate compile-time-adjacent guard against accidentally treating a ratio as an amount.

## Interview Q&A

**Q: You have a database trigger that checks `SUM(debits) = SUM(credits)`. A new requirement means an entry can now mix currencies. Walk me through how you'd change the invariant.**
A: The check has to become conditional on whether the entry is actually single-currency. I'd add a `COUNT(DISTINCT currency_code)` alongside the existing sums, keep the native-currency check but guard it with `currency_count = 1`, and add a second, unconditional check on the base-currency columns — the amounts converted to the organization's functional currency at the rate each line was posted at. The base check is the one that actually protects the books once more than one currency exists; the native check is now just a stricter, better-error-message version of it for the common single-currency case.

**Q: Why can't you just edit the trigger function's SQL in the migration file that originally created it?**
A: Because this codebase treats an applied migration's checksum as load-bearing — the runner compares the recorded checksum against the file on disk every time it runs, specifically to catch exactly this kind of silent post-hoc edit, which is how two environments end up running "the same" migration set that actually did different things. The fix is `CREATE OR REPLACE FUNCTION` for the same function name, shipped in a brand-new, sequentially-numbered migration. Postgres resolves a trigger's function body by name at fire time, not at trigger-creation time, so the existing `CONSTRAINT TRIGGER` picks up the new definition automatically — I never touch the trigger declaration itself.

**Q: A ledger line stores both a native amount and a "base" amount, plus a rate. Why store all three when base = native × rate?**
A: Because the rate isn't recoverable later. If I only stored the base amount, I'd lose the ability to ever show the document in its own currency again — an invoice to a USD customer needs to display $1,000, not a converted rupee figure. If I only stored native and rate, I'd have to recompute the conversion on every read, which is fine arithmetically but means the "what did this actually post as" figure isn't a stored fact you can point to — and worse, if the conversion function's rounding rule ever changed, historical reports would silently change retroactively. Storing all three makes the base amount a frozen historical fact, independent of whatever the conversion code does next.

**Q: How do you know the database's rounding and the application's rounding will always agree?**
A: They're proven to agree for the actual domain of values involved, not by convention. Postgres's `round(numeric)` rounds half away from zero; the application's `scaleCents` rounds half up, in exact `BigInt` arithmetic. Those are literally the same rule for any non-negative input, and every ledger line's debit and credit columns are constrained to be non-negative by a CHECK constraint. So the two implementations don't need to share code — they're mathematically identical on the only inputs that can ever reach them. If a negative money value could ever appear there, that guarantee would break, which is one more reason the non-negative CHECK on those columns matters beyond just "sanity".

## Follow-ups they'll dig into

- "What happens if two lines in the same entry are in different foreign currencies, neither of which is the base currency?" — the mechanism doesn't care; every line converts independently to base currency via its own `fx_rate`, and the base-currency sum is what balances regardless of how many distinct currencies (foreign or not) are represented.
- "Where does the rate actually come from, and what happens if none exists for a given date?" — see [realized-and-unrealized-fx.md](../architecture/realized-and-unrealized-fx.md) for the latest-on-or-before lookup and the `422` it returns when a currency has no rate on file yet.
- "What if the CHECK constraint and the trigger disagreed — could that happen?" — no: the CHECK is single-row (does this line's base amount match its own rate) and the trigger is multi-row (does this entry's base sum balance); they check different things and a violation of either is caught independently, which is exactly the layering [deferred-constraint-triggers.md](deferred-constraint-triggers.md) describes for CHECK vs constraint trigger in general.

## See also

- [deferred-constraint-triggers.md](deferred-constraint-triggers.md) — the CHECK-vs-trigger boundary this note's CHECK/trigger split is a direct application of
- [migrations-and-schema-evolution.md](migrations-and-schema-evolution.md) — why the checksum guard exists and what "never edit an applied migration" actually protects
- [../architecture/realized-and-unrealized-fx.md](../architecture/realized-and-unrealized-fx.md) — what actually gets posted once a mixed-currency entry is legal: the realized-gain/loss plug and period-end revaluation
- [../typescript/branded-types-for-money.md](../typescript/branded-types-for-money.md) — why a rate is deliberately *not* branded the same way `Cents` is
