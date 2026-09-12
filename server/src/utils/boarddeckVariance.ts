import type { ForecasterVarianceRow } from '../types/forecaster.js';
import type { AccountType } from '../types/ledger-core.js';

/**
 * BoardDeck (Phase 15) — collapsing ForecasterPro's monthly budget-vs-actual
 * variance rows into a board-grade section summary and a top-drivers list.
 * A pure function: no database import, no clock, no I/O. Mirrors the posture
 * `utils/forecasterBuild.ts` and `utils/uniteconPvm.ts` established.
 */

export type BoardDeckSection = 'Revenue' | 'Cost of Sales' | 'Operating Expenses' | 'Other';

const SECTION_ORDER: readonly BoardDeckSection[] = ['Revenue', 'Cost of Sales', 'Operating Expenses', 'Other'];

export interface BoardDeckSectionVariance {
  section: BoardDeckSection;
  budgetCents: number;
  actualCents: number;
  varianceCents: number; // actual − budget, raw sign
  favourable: boolean;
}

export interface BoardDeckVarianceDriver {
  accountId: string;
  accountCode: string;
  accountName: string;
  section: BoardDeckSection;
  budgetCents: number;
  actualCents: number;
  varianceCents: number;
  favourable: boolean;
}

export interface SummarizedVariance {
  sections: BoardDeckSectionVariance[];
  drivers: BoardDeckVarianceDriver[];
  totalBudgetCents: number;
  totalActualCents: number;
  totalVarianceCents: number;
}

/**
 * `5xxx` is Cost of Sales, `6xxx` (and any other Expense code) is Operating
 * Expenses — the same convention `reportService.profitAndLoss` uses for
 * gross profit and `docs/schema.md` documents as load-bearing. This is not a
 * sixth account type (guardrails rule 12); it is a display grouping within
 * 'Expense'.
 */
export function sectionOf(accountType: AccountType, accountCode: string): BoardDeckSection {
  if (accountType === 'Revenue') return 'Revenue';
  if (accountType === 'Expense' && accountCode.startsWith('5')) return 'Cost of Sales';
  if (accountType === 'Expense') return 'Operating Expenses';
  return 'Other';
}

function favourableFor(section: BoardDeckSection, varianceCents: number): boolean {
  return section === 'Revenue' ? varianceCents >= 0 : varianceCents <= 0;
}

interface Bucket {
  accountId: string;
  accountCode: string;
  accountName: string;
  section: BoardDeckSection;
  budgetCents: number;
  actualCents: number;
}

export function summarizeVariance(rows: readonly ForecasterVarianceRow[], topN: number): SummarizedVariance {
  const buckets = new Map<string, Bucket>();

  for (const row of rows) {
    const section = sectionOf(row.accountType, row.accountCode);
    const existing = buckets.get(row.accountId);
    if (existing === undefined) {
      buckets.set(row.accountId, {
        accountId: row.accountId,
        accountCode: row.accountCode,
        accountName: row.accountName,
        section,
        budgetCents: row.budgetCents,
        actualCents: row.actualCents,
      });
    } else {
      existing.budgetCents += row.budgetCents;
      existing.actualCents += row.actualCents;
    }
  }

  const sectionTotals = new Map<BoardDeckSection, { budgetCents: number; actualCents: number }>(
    SECTION_ORDER.map((s) => [s, { budgetCents: 0, actualCents: 0 }]),
  );

  const drivers: BoardDeckVarianceDriver[] = [];
  for (const bucket of buckets.values()) {
    const varianceCents = bucket.actualCents - bucket.budgetCents;
    drivers.push({
      accountId: bucket.accountId,
      accountCode: bucket.accountCode,
      accountName: bucket.accountName,
      section: bucket.section,
      budgetCents: bucket.budgetCents,
      actualCents: bucket.actualCents,
      varianceCents,
      favourable: favourableFor(bucket.section, varianceCents),
    });

    const totals = sectionTotals.get(bucket.section);
    if (totals !== undefined) {
      totals.budgetCents += bucket.budgetCents;
      totals.actualCents += bucket.actualCents;
    }
  }

  const sections: BoardDeckSectionVariance[] = SECTION_ORDER.map((section) => {
    const totals = sectionTotals.get(section) ?? { budgetCents: 0, actualCents: 0 };
    const varianceCents = totals.actualCents - totals.budgetCents;
    return {
      section,
      budgetCents: totals.budgetCents,
      actualCents: totals.actualCents,
      varianceCents,
      favourable: favourableFor(section, varianceCents),
    };
  });

  drivers.sort((a, b) => {
    const diff = Math.abs(b.varianceCents) - Math.abs(a.varianceCents);
    if (diff !== 0) return diff;
    return a.accountCode < b.accountCode ? -1 : a.accountCode > b.accountCode ? 1 : 0;
  });

  const totalBudgetCents = sections.reduce((sum, s) => sum + s.budgetCents, 0);
  const totalActualCents = sections.reduce((sum, s) => sum + s.actualCents, 0);

  return {
    sections,
    drivers: topN > 0 ? drivers.slice(0, topN) : [],
    totalBudgetCents,
    totalActualCents,
    totalVarianceCents: totalActualCents - totalBudgetCents,
  };
}
