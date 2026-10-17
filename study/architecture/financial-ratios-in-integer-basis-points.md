# Financial ratios in integer basis points

> Seven balance-sheet and margin ratios computed with BigInt integer arithmetic, stored and shipped as basis points, and reported as "unavailable, with a reason" rather than `Infinity` or `NaN` when the denominator is not positive.

**Category:** Architecture
**Introduced by:** Phase 47 — `GET /reports/business-snapshot`
**Verified against:** Node 22 (BigInt), PostgreSQL 16 (`unnest ... WITH ORDINALITY`). Ratio definitions are the common textbook/lender forms; there is no single standard, so other analysts may define "debt ratio" or "working capital" slightly differently. Flag: not checked against any specific lender's covenant definitions.

---

## Mechanism

### The seven ratios

Performance figures come from the P&L over a period; position figures are balances **as at** a date (point in time). The two kinds are never mixed in a ratio except gross margin, which is P&L only.

| Ratio | Formula | Kind | What it tells you |
|---|---|---|---|
| Gross margin | gross profit / revenue | % | How much of each sale survives direct costs |
| Current ratio | current assets / current liabilities | x | Can short-term assets cover short-term debts (a lender's first look) |
| Debt ratio | total liabilities / total assets | % | Share of the business financed by creditors |
| Debt to equity | total liabilities / net worth | x | Leverage relative to the owners' stake |
| Working capital to total assets | (CA − CL) / total assets | % | How much of the asset base is free liquidity |
| Fixed assets to net worth | non-current assets / net worth | x | How much of the owners' money is locked in long-lived assets |
| Current liabilities to net worth | CL / net worth | % | Short-term claims relative to the owners' stake |

Net worth = total assets − total liabilities. It equals the balance sheet's equity total, because that total includes derived retained and current earnings; an integration test asserts the identity.

### Why integer basis points

A ratio of 5.8333x is stored as `58333` (1 bp = 0.01%, and "x" ratios use the same scale: 1.0x = 10000). Rule 3 forbids floats for money; a ratio is derived from money, and a float quotient would make `0.1 + 0.2`-style disagreement possible between the server, the CSV export and the client. An integer survives JSON, never drifts, and can be compared with `===` in a test.

The rounding is exact BigInt, half away from zero:

```ts
const n = BigInt(num) * 10000n;
const d = BigInt(den);                       // den > 0 here
const mag = (2n * (n < 0n ? -n : n) + d) / (2n * d);
```

`(2|n| + d) / 2d` with truncating integer division equals `floor(|n|/d + 1/2)`, which is round-half-up on the magnitude; applying the sign afterwards makes it half **away from zero**, so -0.5 bp becomes -1 and +0.5 bp becomes +1 (symmetric, unlike `Math.round`, which rounds -0.5 to -0). Multiplying by `10000n` before dividing keeps the whole thing exact: cents are `number` (safe up to 2^53-1, ~9e15 cents) but the product with 10000 could exceed that for very large ledgers, which is why the multiply happens in BigInt.

### `-0` normalisation

BigInt has no negative zero: `-0n` is `0n`, and the code applies the sign in BigInt (`n < 0n ? -mag : mag`) before converting with `Number(...)`, so the current code **cannot** produce `-0`. The trailing `+ 0` (`-0 + 0 === +0`) is belt-and-braces: if someone later moved the negation after the `Number(...)` conversion (`-Number(mag)` with `mag === 0n` gives `-0`), it would still normalise. The test asserts `Object.is(ratioBp(0, 5).valueBp, 0)`. It matters because `JSON.stringify(-0)` is `"0"` but `Object.is(-0, 0)` is false (and Vitest's `toBe`/`toEqual` use `Object.is` semantics), so an equality test would fail confusingly.

### null with a reason, not Infinity or NaN

`x / 0` in JS is `Infinity` or `NaN`, and JSON cannot carry either (they serialise as `null` silently). A denominator that is `<= 0` makes the ratio **undefined**, not extreme:

- Zero denominator: no revenue, no liabilities, no assets: nothing to divide by (`DENOMINATOR_ZERO`).
- Negative denominator: negative net worth makes debt-to-equity negative, which would read as "very low leverage" when the truth is the opposite: the business is insolvent on paper. So the value is `null` with `DENOMINATOR_NEGATIVE`, and the UI can say why.

### Contra accounts

`1590 Accumulated Depreciation` is an Asset under `1400` with a credit-normal balance. Non-current assets are the **signed sum** of every account under that class, so the contra nets inside it automatically (equipment 10,000 + accumulated depreciation -4,000 = 6,000). No special case.

### Classification: derived with override

Current vs non-current is derived from the chart tree: an Asset under ancestor `1400` or a Liability under `2500` is NON_CURRENT, everything else is CURRENT; Equity/Revenue/Expense have no class. A nullable `accounts.balance_sheet_class` column (CHECK: only Asset/Liability) overrides it. It is a report attribute, not a sixth account type (rule 12), the same pattern as `cash_flow_category` in Phase 45. A chart that keeps its long-term debt elsewhere than `2500` gets it classed current until the override is set; the page says so.

### One query for 13 as-at balances

The snapshot needs balances at 12 month-ends plus the prior period's end. Instead of 13 round trips:

```sql
FROM unnest($2::date[]) WITH ORDINALITY AS p(as_of, idx)
JOIN journal_entries e ON e.org_id = $1 AND e.entry_date <= p.as_of
JOIN ledger_lines l ON l.journal_entry_id = e.id AND l.org_id = $1
...
GROUP BY l.account_id, p.idx
```

`unnest(array) WITH ORDINALITY` turns the parameter array into rows with a 1-based `idx`, and the join fans each ledger line out once per date it falls before. The date array is one bound parameter (rule 4), not interpolated. The trade-off, flagged in the plan: ledger lines are scanned up to 13 times inside the one statement; fine at demo scale, a large org would want a cumulative window sum (`SUM(...) OVER (ORDER BY month)`) over per-month totals.

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| JS floats (`a / b`) | Rounding differs across layers; `NaN`/`Infinity` leak | Rejected (rule 3) |
| `DECIMAL`/`NUMERIC` ratios | Exact, but a string at the driver, and a second numeric type to carry | Rejected |
| Integer basis points via BigInt | Exact, comparable, JSON-safe | **Chosen** |
| Stored snapshot table | Goes stale when a back-dated entry posts; needs invalidation | Rejected: computed on read from the ledger |
| 13 queries, one per date | Simple, 13 round trips | Rejected for one `unnest ... WITH ORDINALITY` |
| Sixth account type for current/non-current | Violates rule 12 | Rejected: override column |

## Where it lives in this codebase

- `server/src/utils/financialRatios.ts` — `ratioBp`, `computeRatioValues`, `buildRatios`
- `server/src/utils/balanceSheetClass.ts` — `deriveBalanceSheetClass`
- `server/src/services/accounting/businessSnapshotService.ts` — the three queries and the assembly
- `server/src/db/migrations/104_ledger-core_account_balance_sheet_class.sql`
- `server/src/__tests__/financialRatios.test.ts`, `balanceSheetClass.test.ts`, `accounting/businessSnapshot.test.ts`
- `client/src/utils/ratio.ts` — formatting only (`formatRatio`)

## Gotchas

- The prior period must be the *second* element of `comparisonPeriods(from, to, 'previousPeriod', 1)`, which returns `[current, prior]` (count + 1 entries). The plan assumed it returned only the prior; a destructuring `const [prior]` silently used the current period for every prior figure, and two integration tests caught it. Fixed to `const [, prior]`.
- A ratio's display (`5.83x`) is rounding of display only; never feed the displayed string back into arithmetic.
- Net income, revenue etc. are for the **period**; position values are **as at the last day**. Comparing a period figure to a balance (e.g. revenue / total assets, asset turnover) needs an average balance; we do not build those.
- The trend's final point uses the period's `to`, not the month end, so a mid-month `to` is reflected.

## Interview Q&A

**Q: Why store ratios as integer basis points?**
A: Rule 3 keeps money off floats, and a ratio of two money values inherits that. Basis points are exact integers, safe through JSON, comparable with `===`, and formatted only at the edge. 5.8333x is `58333`.

**Q: Walk me through your rounding.**
A: Multiply the numerator by 10,000 in BigInt, then compute `(2|n| + d) / 2d` with truncating division, which equals round-half-up on the magnitude, and restore the sign. That is half away from zero, symmetric around zero. Using BigInt avoids overflow past 2^53 and floating error.

**Q: Why not return `Infinity` or `NaN` for a zero or negative denominator?**
A: JSON cannot represent them (they become `null` silently), and a negative denominator is not "a big number": negative net worth makes debt-to-equity negative, which would look healthy. So the value is `null` with an explicit reason the UI can explain.

**Q: What is the difference between a point-in-time and a period figure, and why does it matter here?**
A: Balance-sheet items (assets, liabilities) are balances at a date; P&L items accumulate over a range. Ratios like current ratio use balances at `to`; gross margin uses period flows. The "prior" column recomputes both as at the prior period's end.

**Q: How did you decide current vs non-current without a sixth account type?**
A: Derive it from the chart tree (an ancestor code) and allow a nullable CHECK-constrained override column, exactly like the cash-flow category. Account types stay at five.

**Q: Why one `unnest ... WITH ORDINALITY` query rather than a loop?**
A: One round trip, one parameterised date array, and the database does the fan-out. The cost is rescanning ledger lines per date; for large tenants I would pre-aggregate per month and use a cumulative window sum.

**Q: Tell me about a time a test caught an assumption in your own plan.**
A: In Phase 47 the plan said `comparisonPeriods(..., 'previousPeriod', 1)` returns just the prior period. It returns the current and prior. Using the first element computed every "prior" figure for the current period, so the prior column equalled the current one. Two integration cases failed; the fix was a one-character destructuring change, and the lesson is to read the helper's return shape rather than trust a plan's description of it.

## Follow-ups they'll dig into

- "Why not days sales outstanding or inventory turnover?" They need averages over time and aging/COGS definitions; deliberately not built.
- "What if an org's chart differs from the default?" The override column; the page footnote warns about non-default charts.
- "Does a back-dated entry change history?" Yes: the snapshot is computed from the ledger on every request, so it is always consistent with posted entries.

## See also

- [cash-flow-statement-indirect-method.md](cash-flow-statement-indirect-method.md)
- [recursive-ctes-and-hierarchies.md](../postgresql/recursive-ctes-and-hierarchies.md)
- [charts-with-recharts.md](../react/charts-with-recharts.md)
