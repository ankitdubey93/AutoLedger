# Robust outlier detection in SQL

> Flag a ledger amount that is far outside its account's usual range using the median and MAD, computed with ordered-set aggregates in one query. No ML, no extension.

**Category:** PostgreSQL · Architecture
**Introduced by:** Phase 45 — the GL exception report (`UNUSUAL_AMOUNT`, `UNEXPECTED_SIDE`, `NON_DEFAULT_TAX`, `POSSIBLE_DUPLICATE`)
**Verified against:** PostgreSQL 16 docs for `percentile_cont`/`percentile_disc` and `row_number`; the modified z-score constants are from Iglewicz & Hoaglin (1993), "How to Detect and Handle Outliers" — quoted from memory of the standard presentation (flag: confirm the 0.6745 and 3.5 against the source before quoting them as exact).

---

## Mechanism

### Why not mean and standard deviation

A mean and standard deviation are themselves moved by the outliers you are hunting. One 12,000.00 line in a history of ~4,000s inflates the stddev so that the same line scores a modest z and hides. The **median** and **MAD** (median absolute deviation) have a 50% breakdown point: up to half the data can be wild and they barely move.

### The modified z-score

`M = 0.6745 × (x − median) / MAD`. The 0.6745 factor makes MAD comparable to a standard deviation for normally distributed data (MAD ≈ 0.6745 σ). Iglewicz and Hoaglin recommend flagging `|M| > 3.5`. We flag only the **upward** direction for a line larger than usual (the SQL tests `0.6745 * (x - median) / mad > 3.5`).

```sql
percentile_cont(0.5) WITHIN GROUP (ORDER BY amount)               AS median
percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(h.amount - m.median)) AS mad
```

Two aggregation levels: first the median per (account, side), then a join back to the history rows to take the median of absolute deviations.

### `percentile_cont` vs `percentile_disc`

These are **ordered-set aggregates** (`WITHIN GROUP (ORDER BY …)`), not window functions: they sort the group's input and read a position. `percentile_cont(0.5)` **interpolates** between the two middle values for an even count and returns `double precision`; `percentile_disc(0.5)` returns an **actual input value** (the first whose cumulative position reaches the fraction) and keeps the input type. For a median used as a statistic, `cont` is conventional. For a value that must exist in the data (the "usual" amount you quote), `disc` is better. We use `cont` and cast to `numeric` before `round(…, 1)` — `round(double precision, integer)` does **not exist**, and the failure was found by the integration test, not by the type checker (SQL is a string to TypeScript).

### MAD = 0

If more than half the history is the same amount (rent, a subscription), MAD is 0 and the division is undefined. The score is then meaningless, so we fall back to a rule that stays honest: flag if `x > 2 × median`. The edge case is real data, not a corner: recurring documents produce it constantly.

### Thin baselines

An account with fewer than 10 prior lines in the 12-month baseline is **not judged**. A median of three points is noise. The honest consequence: a demo organization with six months of history has thin baselines and produces few amount flags. That is the intended behaviour; the report says what it compared against ("Modified z-score 3.6 against 11 lines in the prior 12 months").

### Contra-account detection by side share

`UNEXPECTED_SIDE` flags a revenue credit-normal account posted on the debit side (or an expense account credited). But a refund account is legitimately contra. We compute per-account the share of historical lines on the opposite side; at ≥ 80% (basis points, integers — no float ratio) the account is treated as contra and its expected side flips. Credit/debit notes, FX revaluation, stock, opening-balance and import entries are exempt, and reversal entries (`reverses_entry_id IS NOT NULL`) are excluded.

### The usual tax rate by mode

`NON_DEFAULT_TAX`: the *usual* tax rate per account is the **mode** of its history. SQL has `mode() WITHIN GROUP`, but we need a deterministic tie-break, so we use `row_number() OVER (PARTITION BY account ORDER BY count(*) DESC, tax_rate_bp ASC)` over a grouped count and keep rank 1 — ties go to the lower rate, always.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| mean ± 3σ | Masked by the outliers themselves; assumes normality | Rejected |
| Percentile cutoffs (e.g. top 1%) | Flags a fixed share even when nothing is wrong | Rejected |
| Modified z-score on median/MAD | Robust, one SQL statement, explainable in the UI | **Chosen** |
| ML anomaly detection | New dependency (rule 14), unexplainable to an accountant | Rejected |
| Computing in Node | Pulls every historical line over the wire | Rejected — aggregates belong in the database |

## Where it lives in this codebase

- `server/src/services/accounting/glExceptionService.ts` — the four rule queries
- `server/src/config/constants.ts` — `GL_EXCEPTION_*` thresholds (12 months, 10 lines, 3.5, 8000 bp, 5 lines)
- `server/src/__tests__/accounting/glExceptions.test.ts`

## Gotchas

- `percentile_cont` returns `double precision`; `round(x, n)` needs `numeric`.
- MAD = 0 needs an explicit branch.
- The bill's own AP credit line is a genuine outlier against AP's own history; tests must filter by account.
- The baseline window must end before `from` and exclude the period being judged.
- Money stays integer cents; only the z-score is fractional, and it is displayed, never posted.

## What this does not catch

Collusion, correctly-sized fraud, a new account with no history, split transactions below the threshold, seasonality (a December spike is flagged every year), and anything the books do not record. It is a review prompt, not an audit.

## Interview Q&A

**Q: Why median and MAD rather than mean and standard deviation?**
A: Mean and stddev are sensitive to the outliers themselves — a single extreme value inflates stddev and masks itself. Median and MAD have a 50% breakdown point, so they describe the typical behaviour even when the history is contaminated.

**Q: What is the modified z-score and where do 0.6745 and 3.5 come from?**
A: `0.6745 (x − median)/MAD`. 0.6745 rescales MAD to be consistent with σ under normality; 3.5 is Iglewicz and Hoaglin's suggested cutoff. (I would cite the paper for the exact figures.)

**Q: `percentile_cont` or `percentile_disc`?**
A: `cont` interpolates and returns double — right for a statistic. `disc` returns an actual row value — right when you must quote a value that exists. Both are ordered-set aggregates that sort their group.

**Q: What happens when MAD is zero?**
A: More than half the values are identical, so every deviation score divides by zero. Branch on it: use a simple rule such as `> 2 × median`, or skip the account.

**Q: A query worked in psql and failed from the app. Why might `round()` bite?**
A: `round(double precision, integer)` does not exist; only `round(numeric, integer)` does. Cast first. SQL is opaque to the TypeScript compiler, so only an integration test catches it.

**Q: How do you pick the mode with a deterministic tie-break in SQL?**
A: `row_number() OVER (PARTITION BY key ORDER BY count(*) DESC, value ASC)` over a grouped count and filter `rk = 1`. Built-in `mode()` gives no say in ties.

**Q: How do you avoid flagging legitimately unusual accounts?**
A: Minimum history, exemption of source types that legitimately post the other way, and contra-account detection by observed side share.

## Follow-ups they'll dig into

- "How do you handle seasonality?" Compare against the same month of prior years — more history required.
- "Why remember dismissals?" So a reviewed flag stays hidden; the review row is keyed by `(org, rule, subject)`, and reopening deletes it.
- "Cost at scale?" An index on `(org_id, account_id)` plus a bounded 12-month window; the percentile sort is per account.

## See also

- [window-functions-and-running-totals.md](window-functions-and-running-totals.md) — `row_number` and `PARTITION BY`
- [aggregating-a-ledger.md](aggregating-a-ledger.md) — `FILTER` aggregates
