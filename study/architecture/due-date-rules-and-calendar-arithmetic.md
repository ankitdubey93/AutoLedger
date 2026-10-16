# Due-date rules and calendar arithmetic

> A payment term is a rule (`20th of next month`), not just "N days"; evaluating it is pure UTC calendar arithmetic that server and client must agree on to the day.

**Category:** Architecture (with TypeScript and PostgreSQL notes)
**Introduced by:** Phase 43a — Xero-style payment-term rule types and default terms
**Verified against:** Node 22 (V8 `Date.UTC`), PostgreSQL 16, TypeScript 7, Vitest 4

---

## Mechanism

**The four rules.** A term is `(rule, n)`. `DAYS_AFTER_DATE` is date + n. `DAYS_AFTER_MONTH_END` is the last day of the document's month + n. `DAY_OF_NEXT_MONTH` is day n of the following month, clamped to that month's length (day 31 in February becomes the 28th/29th). `DAY_OF_CURRENT_MONTH` is day n of this month (clamped), unless that is before the document date, in which case it is day n of next month.

**Why `Date.UTC` and not a date library.** `Date.UTC(year, monthIndex, day)` returns epoch milliseconds for midnight UTC and *normalises overflow*: month index 12 becomes January of the next year, day 0 is the last day of the previous month, day 45 rolls into the next month. That gives two idioms with no branching: `new Date(Date.UTC(y, m + 1, 0)).getUTCDate()` is "days in month m", and `isoOf(y, m + 1, day)` handles December to January. Local-time methods (`new Date('2026-03-01')` then `getDate()`) are the bug to avoid: a `YYYY-MM-DD` string parses as UTC midnight, but `getDate()` reads it in the machine's time zone, so west of UTC it returns the previous day. Every call here is `Date.UTC` or `getUTC*`; dates travel as `YYYY-MM-DD` strings and never as `Date` objects across a boundary.

**Clamping is the whole difficulty.** The naive `setMonth(+1)` on Jan 31 gives March 3 (Feb 31 overflows). Computing `min(n, daysInMonth(target))` first, then constructing the date, is what makes "31st of next month" mean "last day of next month".

**One function, two runtimes, one fixture.** `server/src/utils/dueDate.ts` and `client/src/utils/dueDate.ts` are identical. The server must compute due dates (they are stored); the client previews them as you type. A shared JSON file (`client/src/__tests__/fixtures/dueDateCases.json`, 12 rows covering leap years, year rollover and clamping) is read by both test suites, so the copies cannot drift without a test failing. Same pattern as the placeholder registry (Phase 40).

**Resolution order and snapshotting.** A document with neither `dueDate` nor `paymentTermsCode` falls back to the party's `default_payment_term_id`, then the organization's default, else `422`. The defaults are real composite foreign keys `(org_id, id) → payment_terms` with `ON DELETE RESTRICT` (terms are only deactivated, and `SET NULL` on a composite key would null `org_id`). The *document* however stores a snapshot (`payment_terms_code`, label, the computed `due_date`) rather than an FK, so renaming or deactivating a term can never rewrite a posted document. Defaults are configuration (reference it, keep it live); documents are records (copy it, freeze it).

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| Pure function + shared fixture | Two copies of 30 lines, parity enforced by test | **Chosen** |
| Date library (date-fns, Luxon) | Correct, but a dependency (rule 14) on both sides for four formulas | Rejected |
| Compute only on the server, preview via an API call | One implementation, but a network round trip per keystroke | Rejected |
| Store a SQL expression / cron-like string per term | Flexible, but user-authored code in the data path | Rejected; closed enum + CHECK instead |
| Make `net_days` mean "day of month" with no rule column | No migration, but ambiguous data and no CHECK possible | Rejected |

## Where it lives in this codebase

- `server/src/utils/dueDate.ts`, `client/src/utils/dueDate.ts` — `computeDueDate(rule, n, documentDate)`.
- `server/src/services/accounting/paymentTermService.ts` — `resolveDueDate` (calls it), `resolveDefaultTermCodeOnClient` (party → org default in one query with identifiers from a frozen map), `assertActiveTermOnClient`.
- `server/src/db/migrations/094_ledger-core_payment_term_defaults.sql` — `ck_payment_terms_rule`, `ck_payment_terms_rule_day` (day-of-month rules need 1–31), composite FKs.
- `client/src/Pages/purchases/NewBillPage.tsx`, `client/src/Pages/sales/NewInvoicePage.tsx` — pre-fill that yields once `termTouched` or `dueDateTouched` is set.

## Gotchas

- Mixing `new Date('2026-03-01')` with local getters shifts days in negative-offset zones; CI in UTC will not catch it. Use only UTC methods.
- "Day 31 of the current month, document dated 30 April" clamps to April 30 which is not before the document date, so it is due the same day. The rule is "before", not "on or before".
- The CHECK `rule NOT IN (...) OR net_days BETWEEN 1 AND 31` must be paired with a zod `superRefine`, or the user sees a raw constraint failure; the service also maps `ck_payment_terms_rule_day` to a 422.
- An inactive default term is skipped silently (the join includes `is_active`) so a deactivated term degrades to the next level, not an error.
- Removing a zod `.refine` ("dueDate or code required") moved the check into the service, which changed the status from 400 to 422. Moving validation changes error contracts.

## Interview Q&A

**Q: Why does `setMonth(getMonth() + 1)` on 31 January give a wrong "next month" date?**
A: February 31 does not exist, so JavaScript normalises it forward to 3 March (or 2 March in a leap year). The fix is to compute the target month's length first and clamp the day (`min(day, daysInMonth)`) before constructing the date.

**Q: How does `Date.UTC` help you compute the last day of a month?**
A: It normalises out-of-range arguments. `Date.UTC(y, m + 1, 0)` is "day 0 of next month", i.e. the last day of month m; `getUTCDate()` of that gives the month length, leap years included, without a lookup table.

**Q: Why use only UTC methods for a date-only value?**
A: A calendar date has no time zone, but `Date` is an instant. Parsing `YYYY-MM-DD` yields UTC midnight; reading it with local getters in a negative-offset zone returns the previous day. Staying in UTC end to end removes the zone from the calculation.

**Q: The server and the browser both compute due dates. How do you stop them disagreeing?**
A: Same algorithm in both, and a language-neutral JSON fixture of input/expected rows consumed by both test suites. A change to either implementation that alters any row fails one of the suites.

**Q: Why are default terms foreign keys but a document's term a snapshot?**
A: A default is live configuration, so referential integrity is the right tool and `RESTRICT` prevents orphaning it. A document is a historical record; if it referenced the term, editing the term would change what was agreed with the customer. The document copies the code and computed date.

**Q: Why `ON DELETE RESTRICT` on a composite `(org_id, id)` FK rather than `SET NULL`?**
A: `SET NULL` would null every referencing column, including `org_id`, which is NOT NULL and the tenancy key. PostgreSQL 15+ allows `SET NULL (column)`, but terms are never deleted, so `RESTRICT` states the invariant and never fires.

## Follow-ups they'll dig into

- What if the organization's time zone differs from UTC? (Document dates are already date-only strings chosen by the user; only "today" defaults are zone-sensitive. Quotes use the org zone via `Intl.DateTimeFormat`; invoices still default to UTC today.)
- How would you add "2/10 Net 30" discount terms? (A second term kind and a GL posting for the discount; not date arithmetic.)

## Phase 45 additions — comparative periods

The P&L comparison picks prior periods by one of two rules. **Month-aligned** ranges (first to last day of a month or run of months) shift by whole months: "previous period" moves back `k × span` months, "same period last year" `12 × k`, and the end is re-clamped to the last day of the target month. A range that is not month-aligned shifts by its **day count**, so a 10-day window is compared with the 10 days before it. Shifting a month-aligned range by day count would compare 28 February days with 31 January days (a drift the labels would hide); shifting an arbitrary range by months would change its length.

`addMonthsClamped('2026-03-31', -1)` is `2026-02-28`, and `'2024-02-29'` back twelve months is `2023-02-28`: the day is `min(day, lastDayOfMonth)`. Month arithmetic is done on an integer month index (`year*12 + month-1`) with `Math.floor` for negatives, avoiding `Date` setMonth rollover (`Jan 31 + 1 month` = `Mar 3`). The variance is `current − prior` in cents and, in basis points of `|prior|`, rounded half away from zero; `null` when prior is zero.

### Interview Q&A (Phase 45)

**Q: How do you shift 31 March back one month?**
A: Clamp the day to the target month's length — 28 or 29 February. `Date.setMonth` would roll over into March, which is the bug to name.

**Q: Why two shifting rules for comparison periods?**
A: Month-aligned ranges mean "whole months", so shift by months; arbitrary ranges mean "this many days", so shift by days. Mixing them produces periods of different length.

**Q: How do you express a percentage change when the base is zero?**
A: Return null and display an em dash — it is undefined, not 0 or infinity.

## See also

- [user-authored-templates-and-bearer-links.md](../security-auth/user-authored-templates-and-bearer-links.md) — the same client/server fixture-parity pattern
- [multi-tenancy-row-level-scoping.md](multi-tenancy-row-level-scoping.md)
