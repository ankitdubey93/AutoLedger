# Parsing Untrusted CSV: Why a Regex Split Can't Do It

> `line.split(',')` works on every CSV file you write by hand and fails on the first one your bank actually exports — a quoted memo containing a comma, an embedded newline inside an address field, a doubled quote escaping a literal `"`. A real parser needs a tiny state machine, not a smarter regex.

**Category:** Node/Express
**Introduced by:** Phase 6 — LedgerCore bank statement import, the first place this codebase parses an arbitrary user-supplied text format rather than JSON.
**Verified against:** Node 24, TypeScript 7.0.2.

---

## Mechanism

### Why `split(',')` is not a CSV parser

CSV looks like a delimited format and is actually a mini-grammar with one escape mechanism: a field wrapped in `"..."` can contain the delimiter, a line break, or a literal `"` (written as `""`) without any of those characters ending the field. `"Smith, John",5` is two fields, not three — `split(',')` cannot know that, because it has no concept of "inside a quoted region" versus "outside one." Any regex built to fix this by trying to match balanced quotes runs into the same wall: regular expressions describe regular languages, and "a quote that isn't the *n*-th quote from the start" is not expressible as a regular language once newlines and escaped quotes are both in play. The fix is a state machine that tracks one bit of state — `inQuotes` — while walking the string one character at a time.

### The two-pass structure `utils/csv.ts` uses

Rather than one pass that both splits records and splits fields, the parser does it in two:

1. **`splitRecords`** walks the whole input once, tracking `inQuotes`, and treats `\r`, `\n`, and `\r\n` as record separators **only when not inside a quoted field**. Inside quotes, all three are literal characters copied straight into the accumulating record text — this is what lets an address field spanning two physical lines survive as one logical CSV row. Escaped quotes (`""` inside a quoted field) are collapsed to one `"` right here, and an unterminated quote at end-of-input is a parse error, not a truncated record.
2. **`splitFields`** takes one already-delineated record and splits it on the detected delimiter, with the same quote-tracking logic applied at field granularity — a quote is only meaningful as the *first* character of a field (`fieldStarted` guards this), so a literal `"` appearing mid-field without being the opening character is just data.

Splitting these into two passes rather than one combined walk keeps each function answering exactly one question — "where do records end" and "where do fields end" — which is what makes the quote-tracking logic independently testable and easy to reason about, rather than one function juggling two levels of nested state at once.

### Delimiter sniffing before any parsing happens

A bank export might use `,`, `;` (common outside the US, where `,` is the decimal separator), or `\t`. `detectDelimiter` counts occurrences of each candidate **outside quotes only** in the first physical line — counting inside quotes would let a quoted memo like `"a, b"` masquerade as evidence for a comma delimiter it isn't actually using. The candidate with the highest count wins, defaulting to `,` on a tie or an all-zero line (a single-column file has no delimiter to detect at all).

### The BOM and the header-row asymmetry

A UTF-8 byte-order-mark (`U+FEFF`) is legal-but-optional at the start of a file many spreadsheet tools insist on writing. As a JavaScript `string`, it survives decoding as a single character (`text.charCodeAt(0) === 0xfeff`), stripped before any other processing — left in place, it would silently glue itself onto the first header name (`"﻿Date"` !== `"Date"`), breaking every synonym-based column lookup downstream in `bankImportService`. Blank-row filtering (`fields.every((cell) => cell === '')`) happens after field-splitting, not before, since a genuinely blank line and a line of empty-but-present cells (`,,`) both parse to the same all-empty-fields shape and both mean "nothing here" for a bank statement.

### Row-length validation, not silent truncation

A data row with **fewer** cells than the header is padded with `''` — a trailing empty column some exports simply omit is not an error. A row with **more** cells than the header is rejected outright with the offending row number, because that shape usually means a delimiter inside an unquoted field (a memo containing a comma the export tool forgot to quote) — silently truncating extra cells would drop real transaction data with no visible sign anything went wrong.

---

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| `line.split(',')` per physical line | Trivial, zero code | Rejected — breaks on the first quoted comma or embedded newline, which real bank exports contain routinely |
| A CSV parsing library (`csv-parse`, `papaparse`) | Battle-tested, handles edge cases already | Rejected — no new dependency before the phase that needs it (guardrails rule 14); a hand-written parser is also the more interesting interview story for a whiteboard-derivable algorithm |
| **A hand-written two-pass state machine** | ~200 lines, must be tested against the messy cases by hand | **Chosen** — no dependency, full control over error messages tied to row numbers, and the state machine is small enough to actually explain in an interview |
| A regex-based "smart split" | Looks clever, breaks on nested edge cases (escaped quotes inside quoted fields spanning a line break) | Rejected — regular expressions cannot correctly track unbounded nested quote/newline state |

---

## Where it lives in this codebase

- `server/src/utils/csv.ts` — `parseCsv`, `detectDelimiter`, `splitRecords`, `splitFields`
- `server/src/__tests__/csv.test.ts` — BOM stripping, quoted commas, embedded newlines, doubled-quote escaping, CRLF/bare-CR line endings, delimiter detection (including "don't detect inside quotes"), short-row padding, long-row rejection, unterminated-quote rejection, empty-file rejection, blank-row skipping
- `server/src/services/accounting/bankImportService.ts` — the only caller; feeds `parseCsv`'s output into column resolution and per-row parsing

---

## Gotchas

- **A quote is only special as the very first character of a field.** `splitFields`'s `fieldStarted` flag is what prevents a literal `"` appearing mid-field (not at the true start) from flipping the parser into quoted mode by accident — get this wrong and a memo like `Payment for "Q1" services` breaks silently.
- **Blank-row detection must run after field splitting, not on the raw record text**, because a line of bare delimiters (`,,`) and a truly empty line both need to collapse to "skip this row," and only the field-level view sees them as equivalent.
- **Delimiter sniffing on the wrong line is a real failure mode** if a file has a title row before the real header — this parser assumes the first physical line is the header, matching what every bank export in the fixture set actually does; a file with a preamble would need a different entry point, not a change to the state machine itself.
- **The BOM check inspects `text.charCodeAt(0)`, not a byte sequence** — this only works because the caller already has a decoded JS `string`, not a raw byte buffer. Anything reading a `Buffer` from disk would need to strip the BOM before decoding, at the byte level.

---

## Interview Q&A

**Q: Why can't `split(',')` parse CSV correctly?**
A: CSV is not a delimiter-only format — a field wrapped in double quotes can contain the delimiter itself, a literal newline, or an escaped `""` representing one literal quote character. `split` has no concept of "am I currently inside a quoted region," so it splits on every comma unconditionally, breaking a field like `"Smith, John"` into two pieces instead of one. Any correct parser has to track that one bit of state while walking the input, which is exactly what a small state machine does and a single `split` call structurally cannot.

**Q: Why does this parser do two passes — records, then fields — instead of one combined walk?**
A: Splitting the "where does a record end" question from the "where does a field end" question keeps the quote-tracking logic in each pass answering exactly one thing. A record boundary is a line break outside quotes; a field boundary is a delimiter outside quotes. Combining both into one function means juggling two independent notions of "outside quotes" at once (record-level and field-level), which is harder to get right and harder to test in isolation — with two passes, `splitRecords` can be reasoned about, and tested, entirely separately from `splitFields`.

**Q: How do you detect which delimiter a file uses without a config option?**
A: Count occurrences of each candidate delimiter (`,`, `;`, `\t`) in the first physical line, **excluding anything inside quotes** — a quoted memo containing a comma must not count as evidence the file is comma-delimited if it's actually semicolon-delimited. The candidate with the most occurrences wins; ties or an all-zero line default to comma, since a single-column file has nothing to detect either way.

**Q: What happens with a row that has more cells than the header, and why not just truncate it?**
A: It's rejected outright with the specific row number in the error message, rather than silently dropping the extra cells. In practice this shape almost always means an unquoted delimiter accidentally split what should have been one field — silently truncating would drop real data (often the transaction amount, if it's the last column) with no visible sign anything went wrong. A row with *fewer* cells than the header, by contrast, is padded with empty strings, since that usually just means an optional trailing column the export omitted.

**Q: How does this handle a file exported from Excel with a byte-order-mark at the start?**
A: `text.charCodeAt(0) === 0xfeff` strips a leading BOM before any other processing, because as a JavaScript string a UTF-8 BOM decodes to exactly one character at that codepoint. Left in place it would silently attach itself to the first header's name — `"﻿Date"` no longer string-equals `"Date"` — breaking every downstream header lookup that expects an exact or normalized match.

**Q: How would you extend this to a genuinely enormous file without holding it all in memory?**
A: The current parser is whole-string, in-memory — fine for a CSV under `MAX_CSV_CHARS` (900,000 characters, comfortably under the JSON body limit). A streaming version would need the same state machine, but driven by a stream's `data` chunks instead of a fixed string, carrying `inQuotes` (and a partial trailing record) across chunk boundaries — the state machine's design doesn't change, only what feeds it characters one at a time.

---

## Follow-ups they'll dig into

- *"What if a chunk boundary splits a `""` escaped-quote pair in half, in a streaming version?"* The state machine would need to buffer at least one character of lookahead across chunk boundaries rather than assuming the next character is always immediately available — the same class of problem UTF-8 decoding across chunk boundaries has.
- *"Why not just use a well-known library and save the code?"* Guardrails rule 14 (no dependency before the phase that needs it) is the stated reason, but the practical one is that a hand-written parser gives exact control over error messages tied to a specific row number — a library's generic parse error wouldn't say "row 3: unterminated quote" in the vocabulary `bankImportService`'s all-or-nothing import failure message needs.
- *"How would you test that the delimiter detection doesn't get fooled by a quoted field?"* Exactly the case `csv.test.ts`'s `'does not detect a delimiter that only appears inside quotes'` covers — a header like `"a;b",c` must detect comma, not semicolon, proving the quote-tracking in `detectDelimiter` actually excludes quoted content rather than just counting raw character occurrences.

## Phase 36b additions — parsing human decimals to integers: percent → basis points, quantity → milli-units, and the date-format guess

`parseCsv` (above) turns bytes into cells of text. The next layer turns a cell into a **typed value**, and for a money-adjacent number that layer must not go through a float. **Verified against:** Node 22 / V8 (IEEE-754 doubles); the code is `server/src/utils/importValues.ts` and its unit tests in `server/src/__tests__/importValues.test.ts`. This section is here rather than in a new note because it is the second half of the same pipeline (text → cells → typed cells); the sibling `parseMoneyText` (text → cents) is covered in [branded-types-for-money.md](../typescript/branded-types-for-money.md).

### Why not `Math.round(parseFloat(x) * 100)`

A double cannot represent most decimal fractions, so scaling can land a hair off an integer boundary — `1.005 * 100` is `100.49999999999999` in JavaScript, and `0.07 * 100` is `7.000000000000001`. `Math.round` papers over some of those and gets others wrong; which ones depends on the value, which is the worst property a money/tax path can have. The project's rule (guardrail 3) is integers only, and the importer applies it to *inputs*, not just storage.

### The technique: split the digit string, scale with integers

`parsePercentBp` and `parseQuantityMilli` never convert the decimal to a double. They match the text with an anchored regex that captures the **integer digits** and the **fraction digits** separately, pad the fraction to a fixed width, and combine with integer arithmetic:

- **Percent → basis points (1 bp = 0.01%), 2 decimals max.** `bp = Number(int) * 100 + Number(frac.padEnd(2, '0'))`. So `12.5%` → int `12`, frac `5` → `'50'` → `1250`. Range `0..10000`; above that is `null`. The pad is the trick: `.5` means `.50`, not `.05`, which is exactly the bug `Number(frac)` alone would have.
- **Quantity → milli-units, 3 decimals max.** `milli = Number(int) * 1000 + Number(frac.padEnd(3, '0'))`. `1,250.125` → `1250125`. Range `0..1_000_000_000`. This matches how the stock engine stores quantity (integer milli-units) and what `stock_uoms.decimal_places` (0–3) can express.

Every `Number(...)` there is applied to a string of digits, and the result is range-checked **after** the multiplication — a 25-digit integer part loses precision as a double but is then rejected by the bound, so it can never reach the database as a wrong-but-plausible number. The `bp` and `milli` maxima are far below 2^53−1 (9 007 199 254 740 991).

### What the parsers deliberately accept, and what they refuse

- **Percent accepts human export shapes:** `10`, `10%`, `12.5 %`, and Xero-style labels such as `GST on Income (15%)` (a `%`-suffixed number found *anywhere* in the text), plus zero words (`exempt`, `tax exempt`, `no tax`, `none`, `zero rated`, `n/a`, or any text containing `exempt`) → `0`. More than 2 decimals on a bare number (`10.125`) is `null`, not rounded: silently changing a tax rate is worse than asking.
- **Quantity strips commas only when they are unambiguous thousands separators** — the text must match `/^\d{1,3}(,\d{3})+(\.\d+)?$/`. `1,250.125` is one thousand two hundred fifty; `1,25` does **not** match, keeps its comma, fails the decimal regex and becomes `null`. Stripping every comma would read a European decimal comma as `125`, an order-of-magnitude error that looks like a valid number.
- **Negatives and 4+ decimals are `null`** (`-1`, `1.2345`): the `-` and the fourth digit fail the anchored regex. A reorder point or an opening quantity is never negative, and a quantity that cannot be stored exactly should be refused, not rounded.
- **Empty is not an error for any type** — `parseImportCell` returns `{ ok: true, value: null }` first; *required* is a separate rule in the validator. That split lets an optional column be blank while a required one is reported as `Name is required`, rather than every type inventing its own "empty" error.
- **Money goes through `parseMoneyText`**, and `parseImportCell` adds one guard: a negative result is an error for `money` (`cannot be negative`). Letters-only text is rejected by `parseMoneyText` itself. It used to strip a trailing three-letter currency code (for `1234.56 GBP`) and so turned the word `abc` into `0`. That was found while writing the 36b tests, first guarded in the data-kind path only, and then fixed at the source: when the strips leave nothing, the function now throws `Unparseable amount`, so the legacy opening-balance and bank importers report the row too.

### Guessing the date format from the file

`01/02/2026` is 1 February or 2 January; the text cannot say. `suggestDateFormat(samples)` looks at **every non-empty date cell in the file** (not just the first few) and answers from what is *provably* true:

1. no samples, or all match `YYYY-MM-DD` → `ISO`;
2. any `a/b/c`-shaped value (separators `/`, `-`, `.`) whose **first** part is > 12 → `DMY` (a month cannot be 31);
3. else any whose **second** part is > 12 → `MDY`;
4. else `null` — ambiguous.

`null` is the honest answer and the UI respects it: the wizard shows an unset `Choose…` select, adds the problem `Choose the date format your file uses`, and disables staging until the user picks. The chosen format is stored in `migration_imports.options.dateFormat` and used by both the parser and the `PATCH` path. Tests: `inspect suggests DMY for an unambiguous day-first file` and `DMY dates parse with dateFormat`.

### Gotchas (36b)

- **A known defect in the embedded-percent regex.** The `%`-anywhere pattern is unanchored, so `5.005%` (three decimals) matches its tail `005%` and parses as 500 bp, while the bare `10.125` is correctly refused. Real exports rarely have 3-decimal percentages; the planned fix is a `(?<![\d.])` lookbehind so a match cannot start mid-number. Left unfixed and logged in the plan; do not claim the parser rejects all over-precise percentages.
- **`suggestDateFormat` does not detect contradictions.** A file mixing a `31/01` row and a `01/31` row returns `DMY` (rule 2 fires first); the day-last rows then fail parsing and appear as row errors. Loud, not silent, but not detected up front.
- **Two-digit years, month names and other separators** are whatever `parseFlexibleDate` handles; `suggestDateFormat` only reasons about three numeric parts.
- **`parseQuantityMilli` returns `0` for `0`**, so "more than zero" is a separate row rule (`Opening quantity must be more than zero`).

### Interview Q&A (36b)

**Q: Why not multiply by 100 and round?**
A: Because the multiplication happens in binary floating point, where most decimal fractions are not exactly representable. `1.005 * 100` evaluates to `100.49999999999999`, so `Math.round` gives 100 where a human expects 101, and `0.07 * 100` is `7.000000000000001`. Whether rounding rescues you depends on the particular value, which is unacceptable for tax rates and quantities. I parse the digit string instead: capture integer and fraction digits with an anchored regex, pad the fraction to the fixed width, and compute `int * 100 + frac` in integer arithmetic. No double ever holds the decimal.

**Q: What does `padEnd` do in that, and what goes wrong without it?**
A: It aligns the fraction to its place value. `12.5` has fraction digits `5`, which means 50 hundredths. `Number('5')` would add 5, reading it as `.05`, giving 1205 bp instead of 1250. Padding to the fixed width (2 for basis points, 3 for milli-units) makes the digit string mean what it means to the reader.

**Q: A quantity cell says `1,25`. What should a parser do?**
A: Refuse it. In some locales that is one and a quarter, in others a malformed thousands group; guessing a meaning produces a number that is wrong by 100x and still valid-looking. The parser strips commas only when the whole text matches the strict thousands pattern (groups of exactly three digits after a 1–3 digit head), so `1,250.125` works and `1,25` becomes a row error the user can fix or re-export.

**Q: Why return `null` instead of a best guess for an ambiguous date format?**
A: A wrong guess imports every date in the file wrongly and plausibly: 3 February posted as 2 March is valid, and nothing downstream can tell. So inference only fires when a value proves the format (a day of 31 cannot be a month), and otherwise the UI makes the user choose, blocking the stage button until they do. The cost is one extra click on genuinely ambiguous files; the benefit is that no date is ever silently transposed.

**Q: You found a bug in a shared function while writing this. What did you do?**
A: `parseMoneyText` turned a digit-free word like `abc` into 0, because it strips a trailing three-letter currency code first and then treated the empty remainder as blank. The new importer's test for "an unparseable sale price is a row error" exposed it.

I handled it in two moves:
1. **Contain it.** Inside the feature I was building, I added a guard in `parseImportCell` so the new path was correct, and reported the shared bug instead of widening that step's scope.
2. **Fix it at the source.** Once the feature landed, I fixed the function itself. When the strips leave nothing, it now throws. "Blank" stays a deliberate set of spellings (`''`, `-`, `—`, `n/a`) checked *before* any stripping.

Before changing a shared function's contract, check every caller. Here, all of them (bank import, opening balances, capture extraction) already caught its `Unparseable amount` error and turned it into a row-level error. So the fix needed no caller changes, and the per-feature guard became redundant and was deleted. Regression tests pin `abc`, `USD` and `CR` as rejected.

**Q: Why is a parse error stored as `null` and not thrown?**
A: Staging is meant to hold bad rows so a human can fix them, so a parse failure must not abort the file. The staged row keeps the user's text in `raw` and `null` in the typed value; the validator re-derives the error message from `raw`. Throwing would bring back the abort-on-first-error shape this importer was built to avoid.

### Follow-ups they'll dig into (36b)

- "Would you use a decimal library?" Possibly in a larger domain; here rule 14 (no dependency before the phase that needs it) and the fact that the required transform is a fixed-width digit split make a dependency unnecessary. A library would also not remove the need to decide what `1,25` means.
- "What is the largest quantity you accept, and why?" `1_000_000_000` milli-units (a million units), the cap in the plan's contract. It sits far below 2^53−1; the plan does not record a deeper rationale, so do not invent one in an interview.
- "How is `10` read — 10% or 0.10?" As 10%, 1000 bp; a bare number in a column labelled `Sales tax %` is a percent, not a fraction, and the template header and note say so.

---

## See also

- [../architecture/fuzzy-matching-and-confidence-scoring.md](../architecture/fuzzy-matching-and-confidence-scoring.md) — what a parsed CSV row is scored against once it becomes a `bank_transactions` row
- [../postgresql/idempotent-ingestion-and-dedupe-hashes.md](../postgresql/idempotent-ingestion-and-dedupe-hashes.md) — what happens to a parsed row once it's ready to be inserted, and why re-importing the same file is safe
- [../typescript/branded-types-for-money.md](../typescript/branded-types-for-money.md) — the sibling untrusted-text parser, `parseMoneyText`, that turns each parsed cell's amount column into cents
