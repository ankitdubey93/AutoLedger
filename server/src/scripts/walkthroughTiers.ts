/**
 * Turns each `DatasetDocument` (an invoice or a bill) into the bank
 * statement line(s) that settle it, and computes each line's real
 * `scoreMatch` score against the document it is meant to match — using the
 * same scoring inputs `bankMatchService` builds, so a score computed here
 * is provably the score the real matcher will produce, not a guess.
 */
import { WALKTHROUGH_DATASET, type DatasetDocument, type Tier } from './walkthroughDataset.js';
import type { AnchorMonth, WalkthroughMonth } from './walkthroughDates.js';
import { resolveDate } from './walkthroughDates.js';
import { scoreMatch } from '../utils/matchScore.js';
import { parseMoneyText } from '../utils/money.js';

export interface SettlementLine {
  /** The bank line's own label — 'I1', 'I6-partial', 'I6-remainder'. */
  lineRef: string;
  /** The document this line settles — always the DatasetDocument's own ref. */
  documentRef: string;
  kind: 'invoice' | 'bill';
  month: WalkthroughMonth;
  day: number;
  /** Signed: positive for an invoice settlement, negative for a bill settlement. */
  amountCents: number;
  description: string;
  /** The score this line is expected to get against its own document, computed via the real scoreMatch. */
  expectedScore: number;
}

/**
 * Phase 26 — how much of a document's total credit/debit notes settle by the
 * end of `throughMonth`: the sum of every note allocation landing on it. The
 * bank line that settles the document is for the total minus this, which is
 * also the amount due the real matcher scores against.
 */
export function noteAppliedCents(documentRef: string, throughMonth: WalkthroughMonth): number {
  let appliedCents = 0;
  for (const note of WALKTHROUGH_DATASET.notes) {
    if (note.month > throughMonth) continue;
    for (const allocation of note.allocations) {
      if (allocation.documentRef === documentRef) appliedCents += parseMoneyText(allocation.amount);
    }
  }
  return appliedCents;
}

const TIER_DATE_SHIFT: Partial<Record<Tier, number>> = {
  AUTO_0: 0,
  AUTO_1: 1,
  AUTO_2: 2,
  REVIEW_LATE: 3,
  REVIEW_ANON: 0,
};

function counterpartyName(doc: DatasetDocument): string {
  const list = doc.vendorReference === null ? WALKTHROUGH_DATASET.customers : WALKTHROUGH_DATASET.vendors;
  const match = list.find((c) => c.key === doc.counterpartyKey);
  if (match === undefined) throw new Error(`walkthrough fixture: no counterparty ${doc.counterpartyKey}`);
  return match.name;
}

function memoFor(doc: DatasetDocument, suffix: string): string {
  const name = counterpartyName(doc).toUpperCase();
  const verb = doc.vendorReference === null ? 'ACH CREDIT' : 'ACH DEBIT';
  return suffix === '' ? `${verb} ${name}` : `${verb} ${name} ${suffix}`;
}

/** Builds every settlement line for every invoice and bill in the dataset. */
export function buildSettlementLines(): SettlementLine[] {
  const lines: SettlementLine[] = [];
  const documents: { doc: DatasetDocument; kind: 'invoice' | 'bill' }[] = [
    ...WALKTHROUGH_DATASET.invoices.map((doc) => ({ doc, kind: 'invoice' as const })),
    ...WALKTHROUGH_DATASET.bills.map((doc) => ({ doc, kind: 'bill' as const })),
  ];

  for (const { doc, kind } of documents) {
    // Net of any note applied to it in its own month (Phase 26) — the one
    // month-4 invoice/bill pair with notes is settled for the net amount.
    const totalCents = parseMoneyText(doc.total) - noteAppliedCents(doc.ref, doc.month);
    if (totalCents <= 0) {
      throw new Error(`walkthrough fixture: ${doc.ref} is fully credited, no settlement line`);
    }
    const sign = kind === 'invoice' ? 1 : -1;

    if (doc.tier === 'REVIEW_PARTIAL') {
      if (doc.remainder === null) {
        throw new Error(`walkthrough fixture: ${doc.ref} is REVIEW_PARTIAL but has no remainder`);
      }
      // Halved on whole cents — this dataset's totals are chosen to divide
      // evenly, so there is never a stray cent to assign; a total that did
      // not divide evenly would be a dataset bug, not something to round
      // away silently.
      if (totalCents % 2 !== 0) {
        throw new Error(`walkthrough fixture: ${doc.ref}'s total ${doc.total} does not halve evenly`);
      }
      const half = totalCents / 2;
      lines.push({
        lineRef: `${doc.ref}-partial`,
        documentRef: doc.ref,
        kind,
        month: doc.month,
        day: doc.day,
        amountCents: sign * half,
        description: memoFor(doc, 'PARTIAL'),
        expectedScore: 60, // 0 (amount != full due) + 30 (same day) + 30 (name in memo)
      });
      lines.push({
        lineRef: `${doc.ref}-remainder`,
        documentRef: doc.ref,
        kind,
        month: doc.remainder.month,
        day: doc.remainder.day,
        amountCents: sign * (totalCents - half),
        description: memoFor(doc, ''),
        expectedScore: 70, // 40 (amount == remaining due) + 0 (>3 days from issue date) + 30 (name in memo)
      });
      continue;
    }

    if (doc.tier === 'REVIEW_ANON') {
      if (doc.anonMemo === null) throw new Error(`walkthrough fixture: ${doc.ref} is REVIEW_ANON but has no anonMemo`);
      lines.push({
        lineRef: doc.ref,
        documentRef: doc.ref,
        kind,
        month: doc.month,
        day: doc.day,
        amountCents: sign * totalCents,
        description: doc.anonMemo,
        expectedScore: 70, // 40 (exact amount) + 30 (same day) + 0 (no textual overlap)
      });
      continue;
    }

    const shift = TIER_DATE_SHIFT[doc.tier];
    if (shift === undefined) throw new Error(`walkthrough fixture: ${doc.ref} has an unhandled tier ${doc.tier}`);
    const scoreByShift: Record<number, number> = { 0: 100, 1: 92, 2: 85, 3: 77 };
    lines.push({
      lineRef: doc.ref,
      documentRef: doc.ref,
      kind,
      month: doc.month,
      day: doc.day, // the shift is applied to the resolved calendar date at generation time, not here
      amountCents: sign * totalCents,
      description: memoFor(doc, ''),
      expectedScore: scoreByShift[shift] ?? 0,
    });
  }

  return lines;
}

/**
 * Resolves every settlement line into an absolute ISO date. `REVIEW_ANON`
 * and both `REVIEW_PARTIAL` lines already carry the right month/day
 * directly; the plain-shift tiers (AUTO_0, AUTO_1, AUTO_2, REVIEW_LATE)
 * instead need their document's own date shifted by `TIER_DATE_SHIFT` days,
 * computed here rather than in `buildSettlementLines` so shifting across a
 * month boundary is handled once, in one place.
 */
export interface ResolvedSettlementLine extends SettlementLine {
  isoDate: string;
}

export function resolveSettlementLines(anchor: AnchorMonth): ResolvedSettlementLine[] {
  const byRef = new Map(
    [...WALKTHROUGH_DATASET.invoices, ...WALKTHROUGH_DATASET.bills].map((d) => [d.ref, d]),
  );

  return buildSettlementLines().map((line) => {
    const doc = byRef.get(line.documentRef);
    if (doc === undefined) throw new Error(`walkthrough fixture: no document ${line.documentRef}`);

    let isoDate: string;
    if (line.lineRef === doc.ref && (doc.tier === 'AUTO_0' || doc.tier === 'AUTO_1' || doc.tier === 'AUTO_2' || doc.tier === 'REVIEW_LATE')) {
      const shift = TIER_DATE_SHIFT[doc.tier] ?? 0;
      const docDate = resolveDate(anchor, doc.month, doc.day);
      isoDate = shiftIsoBy(docDate, shift);
    } else {
      // REVIEW_ANON (shift 0) and both REVIEW_PARTIAL lines carry their own
      // already-correct month/day directly.
      isoDate = resolveDate(anchor, line.month, line.day);
    }

    return { ...line, isoDate };
  });
}

function shiftIsoBy(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days);
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Verifies every non-`AUTO_0`/`REVIEW_LATE`-derived score in
 * `buildSettlementLines` against the real `scoreMatch` — called by the test
 * suite, not by the generator, so a wrong hand-computed score in the table
 * above fails loudly instead of silently shipping in the answer key.
 */
export function verifyExpectedScores(anchor: AnchorMonth): { lineRef: string; expected: number; actual: number }[] {
  const byRef = new Map(
    [...WALKTHROUGH_DATASET.invoices, ...WALKTHROUGH_DATASET.bills].map((d) => [d.ref, d]),
  );
  const resolved = resolveSettlementLines(anchor);
  const mismatches: { lineRef: string; expected: number; actual: number }[] = [];

  for (const line of resolved) {
    const doc = byRef.get(line.documentRef);
    if (doc === undefined) continue;
    const docDate = resolveDate(anchor, doc.month, doc.day);

    // Amount due at the moment this specific line is scored: the full total,
    // except the REVIEW_REMAINDER line, which is scored after the partial
    // line already settled half, so the amount still due is exactly what
    // the remainder line itself settles — computed directly rather than
    // re-deriving "already settled" generically, since there is exactly
    // one REVIEW_PARTIAL document in this dataset.
    const totalCents = parseMoneyText(doc.total) - noteAppliedCents(doc.ref, doc.month);
    const resolvedAmountDue = line.lineRef === `${doc.ref}-remainder` ? Math.abs(line.amountCents) : totalCents;

    const breakdown = scoreMatch(
      { amountCents: line.amountCents, txnDate: line.isoDate, description: line.description, externalReference: null },
      {
        documentAmountDueCents: resolvedAmountDue,
        documentDate: docDate,
        counterpartyName: counterpartyName(doc),
        documentReference: doc.vendorReference ?? '',
      },
    );

    if (breakdown.total !== line.expectedScore) {
      mismatches.push({ lineRef: line.lineRef, expected: line.expectedScore, actual: breakdown.total });
    }
  }

  return mismatches;
}
