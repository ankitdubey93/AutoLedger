/**
 * BoardDeck Automator (Phase 15) — monthly close automation, budget-vs-actual
 * variance, and automated .pptx deck generation.
 *
 * BoardDeck reads other apps only through reportService.closeReadiness,
 * reportService.profitAndLoss/balanceSheet, fiscalPeriodService.getPeriodById/
 * closePeriod, varianceService.planVariance, planService.getPlanById, and
 * organizationService.getById — never a direct query against
 * fiscal_periods, invoices, bills, bank_transactions, or forecaster_*
 * (guardrails rule 16).
 */

/* ---------------------------------------------------------- close runs */

export const BOARDDECK_CLOSE_RUN_STATUSES = ['IN_PROGRESS', 'READY', 'BLOCKED', 'CLOSED'] as const;
export type BoardDeckCloseRunStatus = (typeof BOARDDECK_CLOSE_RUN_STATUSES)[number];

/** The one place a close run's lifecycle is written down (guardrails rule 10).
 *  CLOSED is terminal: the fiscal period behind it has been closed in LedgerCore,
 *  and reopening it is LedgerCore's own OPEN/CLOSED edge, not this app's. */
export const BOARDDECK_CLOSE_RUN_TRANSITIONS = {
  IN_PROGRESS: ['READY', 'BLOCKED'],
  READY: ['IN_PROGRESS', 'CLOSED'],
  BLOCKED: ['IN_PROGRESS'],
  CLOSED: [],
} as const satisfies Record<BoardDeckCloseRunStatus, readonly BoardDeckCloseRunStatus[]>;

export function canTransitionCloseRun(from: BoardDeckCloseRunStatus, to: BoardDeckCloseRunStatus): boolean {
  return (BOARDDECK_CLOSE_RUN_TRANSITIONS[from] as readonly BoardDeckCloseRunStatus[]).includes(to);
}

export const BOARDDECK_CHECK_KINDS = [
  'TRIAL_BALANCE_BALANCED',
  'NO_DRAFT_INVOICES',
  'NO_UNPOSTED_BILLS',
  'NO_UNMATCHED_BANK_LINES',
  'PERIOD_OPEN',
] as const;
export type BoardDeckCheckKind = (typeof BOARDDECK_CHECK_KINDS)[number];

export type BoardDeckCheckResult = 'PASS' | 'FAIL';

export interface BoardDeckCloseCheck {
  kind: BoardDeckCheckKind;
  result: BoardDeckCheckResult;
  detail: string;
  observedCount: number;
}

export interface BoardDeckCloseRun {
  id: string;
  fiscalPeriodId: string;
  status: BoardDeckCloseRunStatus;
  periodStartsOn: string; // 'YYYY-MM-DD'
  periodEndsOn: string; // 'YYYY-MM-DD'
  ranAt: string; // ISO timestamp
  ranByName: string | null;
  closedAt: string | null;
  closedByName: string | null;
  createdAt: string;
}

export interface BoardDeckCloseRunDetail extends BoardDeckCloseRun {
  checks: BoardDeckCloseCheck[];
}

/* ---------------------------------------------------------------- decks */

export const BOARDDECK_DECK_STATUSES = ['PENDING', 'GENERATING', 'READY', 'FAILED'] as const;
export type BoardDeckDeckStatus = (typeof BOARDDECK_DECK_STATUSES)[number];

/** Guardrails rule 10. FAILED -> PENDING is the retry edge; READY is terminal
 *  because the bytes exist and a deck is never regenerated in place — a new
 *  deck row is created instead. */
export const BOARDDECK_DECK_TRANSITIONS = {
  PENDING: ['GENERATING'],
  GENERATING: ['READY', 'FAILED'],
  READY: [],
  FAILED: ['PENDING'],
} as const satisfies Record<BoardDeckDeckStatus, readonly BoardDeckDeckStatus[]>;

export function canTransitionDeck(from: BoardDeckDeckStatus, to: BoardDeckDeckStatus): boolean {
  return (BOARDDECK_DECK_TRANSITIONS[from] as readonly BoardDeckDeckStatus[]).includes(to);
}

export interface BoardDeckDeck {
  id: string;
  title: string;
  fiscalPeriodId: string;
  planId: string | null;
  periodStartsOn: string;
  periodEndsOn: string;
  status: BoardDeckDeckStatus;
  sha256: string | null;
  byteSizeBytes: number | null;
  slideCount: number | null;
  errorMessage: string | null;
  generatedAt: string | null;
  createdByName: string | null;
  createdAt: string;
}
