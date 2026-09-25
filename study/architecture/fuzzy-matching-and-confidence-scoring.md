# Fuzzy Matching and Confidence Scoring: Explainable, Not Just Ranked

> A bank line either matches an invoice exactly, or it doesn't — but a human reconciling a statement by hand doesn't reject every near-miss, they glance at the amount, the date, the payer's name, and decide. Confidence scoring is the attempt to encode that glance as arithmetic, and the discipline that makes it trustworthy is storing *why* a score is what it is, not just the number.

**Category:** Architecture
**Introduced by:** Phase 6 — LedgerCore bank reconciliation's 40/30/30 matching engine (`utils/matchScore.ts`), built on a hand-written Levenshtein distance (`utils/levenshtein.ts`). Extended by Phase 6.1 — the third resolution for a scored line, posting a journal entry directly. Extended by Phase 34a — bank rules, a deterministic boolean matcher deliberately kept separate from the scored engine, and the precedence rule between the two.

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

### After the score: three resolutions, not two

A scored line eventually leaves `UNMATCHED` one of three ways, and it is worth being precise about which, because two of the three look similar on screen but behave completely differently in the reconciliation report (`bankReconciliation()`, `reportService.ts`). **Match** posts a payment against a real invoice or bill — the ordinary case, when the score found a genuine counterpart document. **Post journal** (Phase 6.1) settles a line that genuinely moved cash but names no counterpart document at all — a bank fee, interest earned, an opening capital deposit — by posting a balanced two-line journal entry directly (`bankMatchService.postJournalForTransaction`), still through `journalService`, never a direct `ledger_lines` write. **Ignore** is for a line that should never reach the general ledger in the first place — a transfer to another of the organization's own accounts, say, which is real bank activity but not *this* organization's income or expense.

The asymmetry that makes the distinction matter: `bankReconciliation()` sums every **non-`IGNORED`** statement line and compares that sum to the GL's own cash movement. A `MATCHED` or journal-posted line counts on both sides — its GL entry moved the cash account, and its statement line counts toward the statement total — so the two stay in step. An `IGNORED` line counts on **neither** side; it is invisible to the report by design. So a line that genuinely moved cash but gets `IGNORE`d instead of journaled silently breaks the reconciliation by exactly that amount, and a line that never should have reached the GL but gets journaled anyway breaks it the other way. The three-way choice is not a UI nicety — it is the input to an integer-equality invariant (`differenceCents === 0`, rule 3), and picking the wrong one of the three is picked up immediately, not eventually, because there is no tolerance for it to hide inside.

### Deterministic rules versus scored suggestions — two different questions

Phase 34a's bank rules (`utils/bankRuleMatch.ts`) answer a genuinely different question from `scoreMatch`, even though both look at the same input — a bank line's description, amount and account — and both exist to settle a line without a human doing it by hand. `scoreMatch` answers "how likely is it that this specific bank line corresponds to *this specific open document*," a question with a continuous, uncertain answer that has to be weighed against every open invoice/bill as a candidate set and expressed as a number with a threshold. `findMatchingRule` answers "did the user's own saved pattern match," a question with a **binary** answer decided entirely by conditions the user wrote down themselves — a memo substring, an amount range, a direction, an optional bank account — with no candidate set to search and no uncertainty to express. One is inference over unlabelled data; the other is evaluating a boolean expression a human already fully specified.

This shows up directly in the two functions' signatures and behaviour. `scoreMatch` returns a `ScoreComponent[]` breakdown and an integer 0–100 that must be compared against a hand-tuned threshold precisely because its output is an estimate, not a certainty — the whole point of the previous section's noise floor and 85-point threshold is managing the risk of that estimate being wrong. `findMatchingRule` returns either a specific matched rule or `null`, full stop — there's no scoring, no partial credit, no "72% confident this rule applies." A rule either matches every one of its conditions or it doesn't, and there is nothing to hedge against, because the user who wrote the rule is the same authority who would otherwise be manually deciding the line's disposition; the rule is their own decision, encoded, not a guess this codebase is making on their behalf.

That difference is also why a bank rule needs no equivalent of the noise floor or the false-positive/false-negative asymmetry discussion above. A scored suggestion can be *wrong* — two unrelated strings share letters by chance, an amount and date can coincide on the wrong document — and the system has to defend against treating coincidence as signal. A rule cannot be "accidentally" wrong in that sense: if `memoContains: 'STRIPE FEE'` matches a line, it's because the text is genuinely there, not because of a statistical artefact. The risk a rule carries is a *different* one — the user wrote an over-broad rule that catches lines they didn't intend — which is a UX/specification problem the rule editor's own account-scoping and preview surface addresses, not a confidence-calibration problem `scoreMatch`'s machinery exists to solve.

### The precedence rule: a strong document suggestion always wins over a rule

Both mechanisms can plausibly apply to the same bank line — a customer payment that both scores highly against a real open invoice *and* happens to contain a memo substring some rule was written to catch. `bankRuleService.applyRulesOnClient`'s candidate query resolves this in the rule engine's favour never getting a look, not by comparing scores:

```sql
SELECT t.id, t.description, t.amount_cents, t.account_id FROM bank_transactions t
 WHERE t.org_id = $1 AND t.id = ANY($2::uuid[]) AND t.status = 'UNMATCHED'
   AND NOT EXISTS (SELECT 1 FROM bank_match_suggestions s
                    WHERE s.org_id = $1 AND s.bank_transaction_id = t.id AND s.score >= $3)
 ORDER BY t.txn_date, t.id
```

Any line already carrying a suggestion at or above `AUTO_MATCH_THRESHOLD` (85) is excluded from the rule-matching candidate set entirely — a rule never even gets evaluated against it, regardless of the rule's own priority. This is a deliberate precedence choice, not an oversight left for a future tiebreaker: a strong document match means the line is settling against the *real* invoice or bill it actually corresponds to, with the payment properly recorded as settlement of that specific open item (feeding AR/AP aging, the customer/vendor subsidiary ledger — see `subledger-reconciliation-and-aging.md`). A rule instead posts a bare journal entry with no link to any document at all. Letting a rule pre-empt a genuine document match would silently downgrade a real customer payment into an untracked journal line — the invoice would stay open in aging reports even though cash for it actually arrived, which is a worse outcome than either mechanism failing to match at all. Rules exist specifically for lines that have **no** document behind them (a bank fee, interest, a recurring subscription charge) — exactly the gap Phase 6.1's "post journal" resolution already opened up — so deferring to any real document match, unconditionally, keeps rules in their intended lane rather than competing with the mechanism that has better information for the lines it can actually reach.

---

## Why we chose it here

| Option | Trade-off | Verdict |
|---|---|---|
| `pg_trgm` trigram similarity (PostgreSQL extension) | Fast, index-backed, runs in SQL | Rejected for this specific engine — the roadmap explicitly calls for a hand-written Levenshtein (interview value: an algorithm you can derive on a whiteboard), and multi-signal scoring (amount + date + text) needs application-level composition anyway |
| Jaro-Winkler distance | Tuned for short strings like names, weights prefix matches more heavily | Rejected — more complex to implement correctly than Levenshtein for a marginal accuracy gain on this data shape; not the algorithm the roadmap named |
| Soundex / phonetic matching | Catches "Smith" vs "Smyth" | Rejected — solves a different problem (spelling variation of the same name), not the actual failure mode here (an invoice number appearing verbatim, or not, inside a free-text bank memo) |
| An embedding model / semantic similarity | Could catch paraphrased memos an edit-distance metric misses | Rejected outright by guardrails rule 14 — no LLM/embeddings SDK outside AP-Flow's vision extraction (Phase 10); rule 14 carried the same exception for TaxGuard AI's RAG (Phase 16) until that app was removed in Phase 29; also massive overkill for matching a bank memo against a handful of open documents |
| **Hand-written Levenshtein + weighted multi-signal scoring** | Must be implemented and tuned by hand; no library shortcuts on edge cases | **Chosen** — zero dependencies, fully explainable score breakdown, and the roadmap's stated requirement |
| Scoring a bank rule's match the same way a document candidate is scored (a threshold on a continuous number) | Would need its own noise floor, its own threshold, its own false-positive reasoning — solving an uncertainty problem the rule doesn't actually have | Rejected — a rule's conditions are user-specified and exact; `findMatchingRule` returns a boolean match, not a score, because there is nothing to hedge against |
| Letting the higher-scoring/higher-priority of a rule match and a document suggestion win when both apply | Requires comparing two incommensurable things — a rule has no "score" to compare against a document suggestion's 0–100 | Rejected — any document suggestion at or above the auto-match threshold is excluded from the rule candidate set outright, unconditionally; document matches are structurally preferred, never compared |

---

## Where it lives in this codebase

- `server/src/utils/levenshtein.ts` — `levenshtein`, `similarity`, the rolling-array DP
- `server/src/utils/matchScore.ts` — `scoreMatch`, `normalizeForMatching`, `AUTO_MATCH_THRESHOLD`, `SUGGESTION_MIN_SCORE`, `COUNTERPARTY_NOISE_FLOOR`
- `server/src/services/accounting/bankMatchService.ts` — `generateSuggestionsOnClient`, which loads open-document candidates within a ±30-day window and calls `scoreMatch` against each; `matchTransaction`, `postJournalForTransaction` (Phase 6.1) and `setIgnored`, the three resolutions
- `server/src/__tests__/levenshtein.test.ts`, `matchScore.test.ts` — known-distance pairs, symmetry, the noise-floor case
- `server/src/utils/bankRuleMatch.ts` — `findMatchingRule`, `normalizeMemo` (Phase 34a) — the deterministic, boolean counterpart; no score, no threshold
- `server/src/services/accounting/bankRuleService.ts` — `applyRulesOnClient`'s candidate query, the `NOT EXISTS (... score >= AUTO_MATCH_THRESHOLD)` predicate that gives a strong document suggestion precedence over every rule
- `server/src/__tests__/bankRuleMatch.test.ts` — the nine deterministic-matcher unit cases (priority ordering, direction, amount bounds, no mutation)
- `server/src/__tests__/accounting/bankRules.test.ts` — `'a line with an auto-matchable document suggestion is left for the document, not the rule'`, the integration proof of the precedence rule
- `server/src/__tests__/accounting/bankMatching.test.ts` — the 100-line acceptance fixture proving zero false positives above the auto-match threshold

---

## Gotchas

- **Raw string similarity is never zero for two unrelated real-word strings**, which is exactly why the noise floor exists — a naive implementation that reports raw similarity directly will produce small, misleading nonzero counterparty scores for pure coincidence.
- **The rolling-array Levenshtein destroys the diagonal value unless it's captured before the array cell is overwritten** — this is the single easiest place to introduce an off-by-one bug when converting the textbook two-dimensional recurrence into the space-optimized one-dimensional version.
- **Amount scoring must use integer cents equality, never a scaled or fuzzy comparison** — this is guardrails rule 3 showing up inside a "fuzzy" matching engine: the *amount* signal is exact-or-nothing (40 or 0 points) even though the *text* signal is genuinely fuzzy. Mixing the two disciplines up (fuzzy-matching the amount too) would be a real bug, not just an inconsistency.
- **A threshold tuned against one fixture can still be wrong in production** — `COUNTERPARTY_NOISE_FLOOR` and `AUTO_MATCH_THRESHOLD` were validated against a 100-line synthetic fixture with three cleanly-separated tiers (exact matches, deliberate near-misses, pure noise); real bank data will have messier gradations, and the honest claim is "zero false positives on this fixture," not "zero false positives, period."
- **A bank rule's candidate query excludes a line by checking the *suggestion table*, not by re-running `scoreMatch`.** `applyRulesOnClient`'s `NOT EXISTS` predicate reads whatever suggestions `generateSuggestionsOnClient` already computed and stored for that line — it does not score the line itself. If a rule is applied to a line before suggestions have ever been generated for it (a code path that skipped the suggestion step), the precedence check would find nothing to exclude on and let the rule through even though a strong document match might exist and simply hasn't been computed yet. The reason this isn't a live bug is that both entry points — statement import and "apply to unmatched" — always run through `generateSuggestionsOnClient` first (import does it as part of the same transaction; unmatched lines being re-applied to already went through import once). It's still worth naming as an implicit ordering dependency, not something the precedence query itself enforces.

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

**Q: What happens to a bank line that scores well below the threshold and genuinely has no matching document — say, a bank fee?**
A: It has to leave `UNMATCHED` some other way, and there are two options that look similar but are not interchangeable: `IGNORE`, or — since Phase 6.1 — posting a journal entry directly from the line. The reconciliation report sums every non-`IGNORED` statement line and compares it to the GL's own cash movement, so an `IGNORED` line is invisible to that comparison on both sides, while a journal-posted line moves the GL and counts on the statement side too. A fee genuinely moved cash, so it has to be journaled, not ignored — ignoring it would leave the GL and the statement permanently out of step by the fee amount. `IGNORE` is for the opposite case: a line that's real bank activity but shouldn't touch this organization's books at all, like an internal transfer between two of its own accounts.

**Q: You built a scored fuzzy matcher for bank reconciliation. Why does the bank-rules feature use a completely separate, unscored matcher instead of just reusing it?**
A: Because they answer different kinds of questions. `scoreMatch` estimates the likelihood that an unlabelled bank line corresponds to one of several candidate documents it's never seen before — a genuinely uncertain inference problem, which is why it needs a threshold, a noise floor, and a stored breakdown to justify the number. A bank rule's conditions — a memo substring, an amount range, a direction — were written down by the user themselves; checking whether a line satisfies them is evaluating a boolean expression, not estimating anything. There's no uncertainty to hedge against, so `findMatchingRule` just returns the first matching rule or `null` — no score, no threshold, because introducing one would be manufacturing uncertainty that isn't actually there.

**Q: A bank line both matches a saved rule and scores highly against a real open invoice. Which one wins, and how is that decided?**
A: The document match wins, unconditionally — the rule-matching candidate query excludes any line that already has a suggestion scoring at or above the auto-match threshold, so a rule never even gets evaluated against that line, regardless of the rule's priority. That's a deliberate precedence choice, not a tiebreak between two comparable numbers, because the two outcomes aren't equivalent: matching the real document properly settles that specific open invoice or bill, feeding AR/AP aging and the party's subsidiary ledger, while a rule just posts a bare journal entry with no link to any document. Letting a rule pre-empt a genuine match would silently turn a real, trackable customer payment into an untracked journal line — worse than either mechanism simply not matching. Rules are meant for lines that have no document behind them at all, which is exactly what deferring to any real match, always, preserves.

---

## Follow-ups they'll dig into

- *"What if two candidates score identically?"* `generateSuggestionsOnClient` breaks ties by candidate id ascending — a deliberate, deterministic tiebreaker, since without one, two equal-scoring candidates could swap order between runs and make "the top suggestion" nondeterministic.
- *"How would you validate a threshold like 85 isn't overfit to your test fixture?"* You wouldn't trust it fully until it's been run against real, messy bank data — the honest caveat is that 85 and the noise floor of 0.5 are validated against one synthetic fixture with cleanly separated tiers, and a production rollout would want a period of "suggest but never auto-accept" to gather real false-positive-rate data before trusting the threshold blind.
- *"Could this scoring approach be gamed or produce a false sense of confidence?"* Yes, in principle — a coincidentally-correct amount and date on a genuinely wrong document could still clear 70 points (40 + 30) with zero counterparty evidence, which is below the 85 auto-match threshold but still a plausible-looking suggestion a rushed user might accept by hand. The score being explainable is what limits the damage: the breakdown would visibly show "0 points, no textual overlap," giving a careful reviewer the information needed to catch it.
- *"Could a bank rule ever need to be 'scored' too — say, ranked against other rules by how well it fits?"* Only its own tiebreak matters, and that's already deterministic (priority, then creation date), not a fitness score — because at most one rule is meant to apply per line by design, unlike document candidates where several genuinely different open invoices might all be plausible.

---

## See also

- [../node-express/parsing-untrusted-csv.md](../node-express/parsing-untrusted-csv.md) — where the bank lines being scored come from
- [../postgresql/idempotent-ingestion-and-dedupe-hashes.md](../postgresql/idempotent-ingestion-and-dedupe-hashes.md) — how a bank line becomes a stored, dedupe-safe row before it's ever scored
- [document-lifecycle-fsm.md](document-lifecycle-fsm.md) — what happens to a bank line's status once a suggestion is accepted or rejected
- [../postgresql/transactions-isolation-pooling.md](../postgresql/transactions-isolation-pooling.md) — the per-line `SAVEPOINT` `applyRulesOnClient` uses so one rule-posting failure doesn't poison an entire batch apply
- [recurring-schedules-and-exactly-once-jobs.md](recurring-schedules-and-exactly-once-jobs.md) — the other Phase 34 mechanism, deterministic scheduling rather than deterministic matching
