/**
 * Levenshtein edit distance, hand-written rather than a dependency — the
 * roadmap requires this specifically because it is an algorithm you can
 * derive on a whiteboard, and Phase 6's confidence-matching engine needs a
 * counterparty-name similarity signal with no new package (guardrails
 * rule 14).
 *
 * A rolling-array DP: only the previous row of the classic m×n matrix is
 * ever needed to compute the current one, so this runs in O(m×n) time and
 * O(min(m,n)) space rather than the naive O(m×n) space.
 *
 * See study/architecture/fuzzy-matching-and-confidence-scoring.md.
 */
export function levenshtein(a: string, b: string): number {
  // Roll over the shorter string so the array stays as small as possible.
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];

  const width = shorter.length;
  const row = new Uint32Array(width + 1);
  for (let j = 0; j <= width; j++) row[j] = j;

  for (let i = 1; i <= longer.length; i++) {
    let diagonal = row[0] ?? 0; // dp[i-1][0]
    row[0] = i; // dp[i][0]

    for (let j = 1; j <= width; j++) {
      const above = row[j] ?? 0; // dp[i-1][j], not yet overwritten this pass
      const cost = longer[i - 1] === shorter[j - 1] ? 0 : 1;
      const deletion = above + 1;
      const insertion = (row[j - 1] ?? 0) + 1;
      const substitution = diagonal + cost;
      row[j] = Math.min(deletion, insertion, substitution);
      diagonal = above;
    }
  }

  return row[width] ?? 0;
}

/** 1 - distance / max(length). Two empty strings are defined as fully similar. */
export function similarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  const maxLength = Math.max(a.length, b.length);
  const raw = 1 - levenshtein(a, b) / maxLength;
  return Math.min(1, Math.max(0, raw));
}
