# Fuzzy Matching and Confidence Scoring: Explainable, Not Just Ranked

> A bank line either matches an invoice exactly, or it doesn't — but a human reconciling a statement by hand doesn't reject every near-miss, they glance at the amount, the date, the payer's name, and decide. Confidence scoring is the attempt to encode that glance as arithmetic, and the discipline that makes it trustworthy is storing *why* a score is what it is, not just the number.

**Category:** Architecture
**Introduced by:** Phase 6 — LedgerCore bank reconciliation's 40/30/30 matching engine (`utils/matchScore.ts`), built on a hand-written Levenshtein distance (`utils/levenshtein.ts`).

---

## Mechanism

### Levenshtein distance, and the rolling-array space reduction

Levenshtein edit distance between two strings is the minimum number of single-character insertions, deletions, or substitutions needed to turn one into the other. The textbook algorithm builds an `(m+1) × (n+1)` matrix `dp[i][j]` = the edit distance between the first `i` characters of `a` and the first `j` characters of `b`, filled by the recurrence:

```
dp[i][j] = dp[i-1][j-1]                          if a[i-1] === b[j-1]
         = 1 + min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1])   otherwise
           (deletion,          insertion,          substitution)
```

Every cell only depends on the row above it and the current row so far — never anything two rows back. That means the full `O(m×n)` matrix is wasted memory: one `Uint32Array` of length `min(m,n)+1`, updated in place as the algorithm walks the *longer* string one character at a time (swapping `a`/`b` so the array always tracks the shorter one), gets the same answer in `O(min(m,n))` space instead of `O(m×n)`. The subtlety is that overwriting `row[j]` in place destroys the value the next iteration needs as its diagonal (`dp[i-1][j-1]`) — `utils/levenshtein.ts` carries that value forward explicitly in a `diagonal` scalar, updated *before* the array cell is overwritten, rather than trying to read it back out of the array after the fact.

### Normalization before comparison

Raw strings compare poorly: `"ACME Ltd."` and `"acme ltd"` are the same counterparty typed two different ways. `normalizeForMatching` lowercases and collapses every run of non-alphanumeric characters (spaces, punctuation, em-dashes) to a single space, then trims — so `"ACME  Ltd. — #1042"` becomes `"acme ltd 1042"`. This has to run on both sides of every comparison before either edit distance or substring containment is checked; skipping it on one side but not the other silently degrades every score for no reason the score breakdown would explain.

### Weighted multi-signal scoring, not one similarity number

A single "how similar are these two things" number throws away information a human glance uses instinctively: an exact amount match is much stronger evidence than a close one, and a date three days off is weaker evidence than a date on the same day but still meaningful, while an unrelated date is no evidence at all. `scoreMatch` keeps these three signals — amount (40 points, integer equality only, never scaled), date proximity (30 points, stepped down by whole days apart via a lookup table rather than a continuous decay function), and counterparty text similarity (30 points, itself the max of two Levenshtein-based comparisons: does the document's number appear in the memo, or does the counterparty's name) — **independent**, summed rather than multiplied or averaged. Independence is what makes a score explainable: "40 (exact amount) + 0 (11 days apart) + 30 (reference in memo) = 70" is a sentence a bookkeeper can verify against the actual bank line in five seconds. A single opaque similarity metric could not be checked that way even if its final number happened to be identical.

### The noise floor: why raw similarity alone isn't enough

Two genuinely unrelated strings — `"Acme Ltd"` and `"ATM WITHDRAWAL"` — still score a nonzero Levenshtein similarity (around 0.29 in practice) purely because English text shares common letters by chance; the theoretical minimum similarity (0) only occurs when the edit distance equals the longer string's full length, which almost never happens for two real words. Reporting that 0.29 as "9 points of counterparty match" would be reporting noise as if it were signal, and the confidence-scoring engine has to be conservative about exactly that failure mode, since a false positive here (a spurious auto-match) posts an incorrect payment to the general ledger, not just a bad UI suggestion. `COUNTERPARTY_NOISE_FLOOR` (0.5) is the fix: any similarity below the floor is reported as zero with the reason `"no textual overlap"`, and only similarity *at or above* the floor is treated as real evidence, scaled into the 0–30 point range. This is a hand-tuned constant, not a derived one — it was set by running the 100-line acceptance fixture and adjusting until zero false positives above the auto-match threshold held, which is the honest way a threshold like this gets chosen in practice.

### Storing the breakdown, not just the total

Every `ScoreComponent` carries `points`, `maxPoints`, and a human-readable `reason` string (`"exact match"`, `"3 day(s) apart"`, `"reference found in memo"`), persisted to `bank_match_suggestions.score_breakdown` as JSONB alongside the integer `score`. The alternative — storing only the total and recomputing an explanation on demand — would mean the explanation could drift from the actual scoring run that produced the number (if the algorithm changes between when a suggestion was generated and when a user views it), and would make it impossible to audit *why* an old suggestion scored the way it did after the code has moved on. Storing the breakdown at generation time is the same "capture the fact as it happened" discipline the audit trail (`audit_logs`) already follows for row changes.

### Threshold selection and the false-positive cost asymmetry

`AUTO_MATCH_THRESHOLD = 85` is the line above which a suggestion is offered for one-click accept; `SUGGESTION_MIN_SCORE = 40` is the line below which a candidate isn't even shown. These aren't symmetric risk decisions. Missing a genuine match below the threshold (a false negative) costs a user one extra click to confirm it by hand — annoying, recoverable. Auto-accepting a wrong match above the threshold (a false positive) posts a real payment against the wrong document, requiring a manual unmatch-and-reverse to undo — expensive, and exactly the kind of error a "confidence" feature exists to prevent, not cause. That asymmetry is why the threshold sits high (85 out of 100, not 60) and why the noise floor above exists at all: a scoring engine for financial reconciliation should be biased toward under-claiming confidence, not over-claiming it.

---

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| `pg_trgm` trigram similarity (PostgreSQL extension) | Fast, index-backed, runs in SQL | Rejected for this specific engine — the roadmap explicitly calls for a hand-written Levenshtein (interview value: an algorithm you can derive on a whiteboard), and multi-signal scoring (amount + date + text) needs application-level composition anyway |
| Jaro-Winkler distance | Tuned for short strings like names, weights prefix matches more heavily | Rejected — more complex to implement correctly than Levenshtein for a marginal accuracy gain on this data shape; not the algorithm the roadmap named |
| Soundex / phonetic matching | Catches "Smith" vs "Smyth" | Rejected — solves a different problem (spelling variation of the same name), not the actual failure mode here (an invoice number appearing verbatim, or not, inside a free-text bank memo) |
| An embedding model / semantic similarity | Could catch paraphrased memos an edit-distance metric misses | Rejected outright by guardrails rule 14 — no LLM/embeddings SDK outside AP-Flow's vision extraction (Phase 10) and TaxGuard AI's RAG (Phase 16); also massive overkill for matching a bank memo against a handful of open documents |
| **Hand-written Levenshtein + weighted multi-signal scoring** | Must be implemented and tuned by hand; no library shortcuts on edge cases | **Chosen** — zero dependencies, fully explainable score breakdown, and the roadmap's stated requirement |

---

## Where it lives in this codebase

- `server/src/utils/levenshtein.ts` — `levenshtein`, `similarity`, the rolling-array DP
- `server/src/utils/matchScore.ts` — `scoreMatch`, `normalizeForMatching`, `AUTO_MATCH_THRESHOLD`, `SUGGESTION_MIN_SCORE`, `COUNTERPARTY_NOISE_FLOOR`
- `server/src/services/ledger-core/bankMatchService.ts` — `generateSuggestionsOnClient`, which loads open-document candidates within a ±30-day window and calls `scoreMatch` against each
- `server/src/__tests__/levenshtein.test.ts`, `matchScore.test.ts` — known-distance pairs, symmetry, the noise-floor case
- `server/src/__tests__/ledger-core/bankMatching.test.ts` — the 100-line acceptance fixture proving zero false positives above the auto-match threshold

---

## Gotchas

- **Raw string similarity is never zero for two unrelated real-word strings**, which is exactly why the noise floor exists — a naive implementation that reports raw similarity directly will produce small, misleading nonzero counterparty scores for pure coincidence.
- **The rolling-array Levenshtein destroys the diagonal value unless it's captured before the array cell is overwritten** — this is the single easiest place to introduce an off-by-one bug when converting the textbook two-dimensional recurrence into the space-optimized one-dimensional version.
- **Amount scoring must use integer cents equality, never a scaled or fuzzy comparison** — this is guardrails rule 3 showing up inside a "fuzzy" matching engine: the *amount* signal is exact-or-nothing (40 or 0 points) even though the *text* signal is genuinely fuzzy. Mixing the two disciplines up (fuzzy-matching the amount too) would be a real bug, not just an inconsistency.
- **A threshold tuned against one fixture can still be wrong in production** — `COUNTERPARTY_NOISE_FLOOR` and `AUTO_MATCH_THRESHOLD` were validated against a 100-line synthetic fixture with three cleanly-separated tiers (exact matches, deliberate near-misses, pure noise); real bank data will have messier gradations, and the honest claim is "zero false positives on this fixture," not "zero false positives, period."

---

## Interview Q&A

**Q: Walk me through how you'd compute Levenshtein distance with minimal memory.**
A: The full recurrence needs an `(m+1)×(n+1)` matrix, but every cell only depends on the row directly above it and the current row's own progress so far — nothing two rows back is ever referenced again. So you only need one row's worth of state: a single array sized to the *shorter* string's length plus one, updated in place as you walk the longer string character by character. The trick is that overwriting a cell destroys the value the next column needs as its diagonal predecessor, so you carry that one value forward in a separate scalar variable, updated right before you overwrite the array. That gets you from O(m×n) space down to O(min(m,n)).

**Q: Why score amount, date, and counterparty separately and sum them, instead of one combined similarity score?**
A: Because the three signals carry genuinely different kinds of evidence, and summing independent components keeps the result explainable — you can show a user "40 points because the amount matched exactly, 0 points because the date is 11 days off, 30 points because the reference number is in the memo" and they can verify that against the actual bank line in seconds. A single blended similarity metric — even if it happened to produce the same final number — couldn't be decomposed and checked that way, and for something that's about to post a real payment, explainability is not optional.

**Q: Why does an unrelated pair of strings not score exactly zero on similarity, and how do you handle that?**
A: Levenshtein similarity's theoretical minimum only happens when every character in the longer string has to be replaced or removed to reach the shorter one, which is rare for real text — two unrelated English words or phrases still share letters by chance, so raw similarity between genuinely unrelated strings typically comes out somewhere around 0.2–0.3, not 0. Reporting that as meaningful counterparty evidence would be reporting coincidence as signal. The fix is a noise floor: any similarity below a chosen threshold is reported as zero with an explicit "no textual overlap" reason, and only similarity above the floor counts toward the score at all.

**Q: Why is the auto-match threshold set as high as 85 out of 100 rather than, say, 60?**
A: Because the cost of a false positive and a false negative here are wildly asymmetric. Missing a real match below the threshold just means a user clicks one extra button to confirm it by hand — mildly annoying, fully recoverable. Auto-accepting a wrong match above the threshold posts an actual payment against the wrong invoice or bill, which then has to be manually unmatched and reversed to fix — expensive, and it's precisely the kind of mistake a confidence-scoring feature is supposed to prevent, not introduce. A high threshold biases the system toward asking a human when in doubt, which is the correct default for anything that writes to the general ledger.

**Q: Why not just use a `pg_trgm` similarity index in PostgreSQL instead of writing this in TypeScript?**
A: `pg_trgm` is fast and index-backed, but it only gives you one signal — trigram similarity between two strings — computed inside SQL. This engine needs to combine three independent signals (an exact-integer-cents amount comparison, a day-count-based date proximity lookup, and text similarity) into one explainable weighted score, which is naturally an application-level composition, not something a single SQL similarity operator expresses cleanly. Separately, the roadmap explicitly calls for a hand-written Levenshtein implementation specifically because it's an algorithm you can derive and explain on a whiteboard — using a library or a database extension would skip past exactly the part meant to demonstrate that.

**Q: How would this change if you needed to match against thousands of open documents instead of a handful?**
A: Right now every unmatched line is scored against every open document within a ±30-day window, which is fine at the scale a small business's monthly reconciliation actually needs. At real scale you'd want to prune candidates before scoring — an amount-bucketed index (documents grouped by rounded amount) would eliminate most non-matches before any string comparison runs at all, since the amount signal alone (`0` or `40` points) already rules out most candidates cheaply; only running the expensive Levenshtein comparison against candidates that already cleared an amount pre-filter would be the natural next optimization.

---

## Follow-ups they'll dig into

- *"What if two candidates score identically?"* `generateSuggestionsOnClient` breaks ties by candidate id ascending — a deliberate, deterministic tiebreaker, since without one, two equal-scoring candidates could swap order between runs and make "the top suggestion" nondeterministic.
- *"How would you validate a threshold like 85 isn't overfit to your test fixture?"* You wouldn't trust it fully until it's been run against real, messy bank data — the honest caveat is that 85 and the noise floor of 0.5 are validated against one synthetic fixture with cleanly separated tiers, and a production rollout would want a period of "suggest but never auto-accept" to gather real false-positive-rate data before trusting the threshold blind.
- *"Could this scoring approach be gamed or produce a false sense of confidence?"* Yes, in principle — a coincidentally-correct amount and date on a genuinely wrong document could still clear 70 points (40 + 30) with zero counterparty evidence, which is below the 85 auto-match threshold but still a plausible-looking suggestion a rushed user might accept by hand. The score being explainable is what limits the damage: the breakdown would visibly show "0 points, no textual overlap," giving a careful reviewer the information needed to catch it.

---

## See also

- [../node-express/parsing-untrusted-csv.md](../node-express/parsing-untrusted-csv.md) — where the bank lines being scored come from
- [../postgresql/idempotent-ingestion-and-dedupe-hashes.md](../postgresql/idempotent-ingestion-and-dedupe-hashes.md) — how a bank line becomes a stored, dedupe-safe row before it's ever scored
- [document-lifecycle-fsm.md](document-lifecycle-fsm.md) — what happens to a bank line's status once a suggestion is accepted or rejected
