import { similarity } from './levenshtein.js';

/**
 * The 40/30/30 confidence-matching engine for bank reconciliation.
 *
 * Every bank line is scored against every candidate open document out of
 * 100, split across three independent signals — amount, date proximity,
 * and counterparty text similarity. The breakdown is returned alongside
 * the total so a suggestion is explainable rather than a bare number the
 * user is asked to trust (docs/ledger-core.md § C).
 *
 * See study/architecture/fuzzy-matching-and-confidence-scoring.md.
 */

export const AMOUNT_MAX_POINTS = 40;
export const DATE_MAX_POINTS = 30;
export const COUNTERPARTY_MAX_POINTS = 30;

/** Points by |whole days between| — index 0..3, anything further scores 0. */
export const DATE_POINTS = [30, 22, 15, 7] as const;

/** >= this is offered for one-click accept. */
export const AUTO_MATCH_THRESHOLD = 85;
/** Below this, no suggestion row is stored at all. */
export const SUGGESTION_MIN_SCORE = 40;
/** At most this many suggestions are kept per bank line. */
export const MAX_SUGGESTIONS_PER_TRANSACTION = 5;

export interface BankLineForScoring {
  /** Signed: > 0 money in, < 0 money out. */
  amountCents: number;
  txnDate: string; // 'YYYY-MM-DD'
  description: string;
  externalReference: string | null;
}

export interface CandidateForScoring {
  documentAmountDueCents: number; // always positive
  documentDate: string; // 'YYYY-MM-DD'
  counterpartyName: string;
  documentReference: string; // invoice_number or vendor_reference
}

export interface ScoreComponent {
  points: number;
  maxPoints: number;
  reason: string;
}

export interface ScoreBreakdown {
  amount: ScoreComponent;
  date: ScoreComponent;
  counterparty: ScoreComponent;
  total: number; // 0..100
}

/** lowercased, every non-alphanumeric run collapsed to one space, trimmed. */
export function normalizeForMatching(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

interface IsoDateParts {
  year: number;
  month: number;
  day: number;
}

function parseIsoDate(iso: string): IsoDateParts {
  const [year, month, day] = iso.split('-').map(Number);
  return { year: year ?? 0, month: month ?? 0, day: day ?? 0 };
}

function daysBetween(a: string, b: string): number {
  const pa = parseIsoDate(a);
  const pb = parseIsoDate(b);
  const ta = Date.UTC(pa.year, pa.month - 1, pa.day);
  const tb = Date.UTC(pb.year, pb.month - 1, pb.day);
  return Math.round((ta - tb) / 86_400_000);
}

function scoreAmount(line: BankLineForScoring, candidate: CandidateForScoring): ScoreComponent {
  const exact = Math.abs(line.amountCents) === candidate.documentAmountDueCents;
  return {
    points: exact ? AMOUNT_MAX_POINTS : 0,
    maxPoints: AMOUNT_MAX_POINTS,
    reason: exact ? 'exact match' : 'amount differs',
  };
}

function scoreDate(line: BankLineForScoring, candidate: CandidateForScoring): ScoreComponent {
  const days = Math.abs(daysBetween(line.txnDate, candidate.documentDate));
  const points = DATE_POINTS[days] ?? 0;
  return {
    points,
    maxPoints: DATE_MAX_POINTS,
    reason: `${String(days)} day(s) apart`,
  };
}

/**
 * Below this raw similarity, an overlap is treated as coincidental noise
 * rather than a signal — two unrelated real-word strings (e.g. "Acme Ltd"
 * against "ATM WITHDRAWAL") share enough letters by chance to score above
 * zero under whole-string Levenshtein similarity alone, which would make
 * "no textual overlap" an impossible outcome without a floor.
 */
const COUNTERPARTY_NOISE_FLOOR = 0.5;

function scoreCounterparty(line: BankLineForScoring, candidate: CandidateForScoring): ScoreComponent {
  const memo = normalizeForMatching(`${line.description} ${line.externalReference ?? ''}`);
  const name = normalizeForMatching(candidate.counterpartyName);
  const ref = normalizeForMatching(candidate.documentReference);

  function simOf(needle: string): number {
    if (needle === '') return 0;
    if (memo.includes(needle)) return 1;
    return similarity(needle, memo);
  }

  const nameSim = simOf(name);
  const refSim = simOf(ref);
  const winningRef = refSim >= nameSim;
  const rawSim = winningRef ? refSim : nameSim;
  const sim = rawSim >= COUNTERPARTY_NOISE_FLOOR ? rawSim : 0;
  const points = Math.round(COUNTERPARTY_MAX_POINTS * sim);

  let reason: string;
  if (points === 0) {
    reason = 'no textual overlap';
  } else if (rawSim === 1 && winningRef) {
    reason = 'reference found in memo';
  } else if (rawSim === 1) {
    reason = 'name found in memo';
  } else if (winningRef) {
    reason = `reference similarity ${rawSim.toFixed(2)}`;
  } else {
    reason = `name similarity ${rawSim.toFixed(2)}`;
  }

  return { points, maxPoints: COUNTERPARTY_MAX_POINTS, reason };
}

export function scoreMatch(line: BankLineForScoring, candidate: CandidateForScoring): ScoreBreakdown {
  const amount = scoreAmount(line, candidate);
  const date = scoreDate(line, candidate);
  const counterparty = scoreCounterparty(line, candidate);
  return {
    amount,
    date,
    counterparty,
    total: amount.points + date.points + counterparty.points,
  };
}
