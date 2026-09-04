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
- `server/src/services/ledger-core/bankImportService.ts` — the only caller; feeds `parseCsv`'s output into column resolution and per-row parsing

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

---

## See also

- [../architecture/fuzzy-matching-and-confidence-scoring.md](../architecture/fuzzy-matching-and-confidence-scoring.md) — what a parsed CSV row is scored against once it becomes a `bank_transactions` row
- [../postgresql/idempotent-ingestion-and-dedupe-hashes.md](../postgresql/idempotent-ingestion-and-dedupe-hashes.md) — what happens to a parsed row once it's ready to be inserted, and why re-importing the same file is safe
- [../typescript/branded-types-for-money.md](../typescript/branded-types-for-money.md) — the sibling untrusted-text parser, `parseMoneyText`, that turns each parsed cell's amount column into cents
