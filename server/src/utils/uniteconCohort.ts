import type { CohortCell, CohortMatrix, CohortRow, CustomerRevenueFact } from '../types/unitecon.js';

/**
 * UnitEcon (Phase 14) — the cohort-retention engine. A pure function of its
 * arguments: no database import, no clock, no I/O. Mirrors the posture
 * `utils/forecasterBuild.ts` and `utils/fpaProjection.ts` established —
 * unit-tested without a running Postgres.
 *
 * A customer's cohort month is the month of their earliest fact with
 * positive net revenue, searched over ALL of `facts` (not just the display
 * window) — a customer whose first such month precedes `months[0]` is
 * excluded entirely and counted in `excludedPriorCustomers`, rather than
 * silently reassigned to a later cohort.
 */
export function buildCohortMatrix(
  facts: readonly CustomerRevenueFact[],
  months: readonly string[],
): CohortMatrix {
  if (months.length === 0) {
    return { months: [], rows: [], totalNewCustomers: 0, excludedPriorCustomers: 0 };
  }

  const firstMonth = months[0] as string;
  const lastMonth = months[months.length - 1] as string;
  const monthIndex = new Map<string, number>(months.map((m, i) => [m, i]));

  // Group every fact by customer.
  const factsByCustomer = new Map<string, CustomerRevenueFact[]>();
  const namesByCustomer = new Map<string, string>();
  for (const fact of facts) {
    const list = factsByCustomer.get(fact.customerId);
    if (list === undefined) {
      factsByCustomer.set(fact.customerId, [fact]);
    } else {
      list.push(fact);
    }
    namesByCustomer.set(fact.customerId, fact.customerName);
  }

  let excludedPriorCustomers = 0;
  // cohortMonth -> customerIds acquired in that month.
  const cohortMembers = new Map<string, string[]>();
  // customerId -> its own facts, kept only for surviving customers.
  const survivingFacts = new Map<string, CustomerRevenueFact[]>();

  for (const [customerId, customerFacts] of factsByCustomer) {
    const positiveMonths = customerFacts.filter((f) => f.netRevenueCents > 0).map((f) => f.month);
    if (positiveMonths.length === 0) continue; // never acquired

    const firstPositiveMonth = positiveMonths.reduce((min, m) => (m < min ? m : min));

    if (firstPositiveMonth < firstMonth) {
      excludedPriorCustomers += 1;
      continue;
    }
    if (firstPositiveMonth > lastMonth) {
      continue; // outside the window on the far side, not "prior"
    }

    const members = cohortMembers.get(firstPositiveMonth);
    if (members === undefined) {
      cohortMembers.set(firstPositiveMonth, [customerId]);
    } else {
      members.push(customerId);
    }
    survivingFacts.set(customerId, customerFacts);
  }

  const rows: CohortRow[] = [];
  let totalNewCustomers = 0;

  for (const [cohortMonth, customerIds] of cohortMembers) {
    const sortedIds = [...customerIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const cohortSize = sortedIds.length;
    totalNewCustomers += cohortSize;

    const cohortMonthIdx = monthIndex.get(cohortMonth);
    if (cohortMonthIdx === undefined) {
      throw new Error(`buildCohortMatrix: cohort month ${cohortMonth} is not in the display window`);
    }

    const cells: CohortCell[] = [];
    for (let offset = 0; offset <= months.length - 1 - cohortMonthIdx; offset++) {
      const cellMonth = months[cohortMonthIdx + offset] as string;

      let activeCustomers = 0;
      let netRevenueCents = 0;
      for (const customerId of sortedIds) {
        const customerFacts = survivingFacts.get(customerId) ?? [];
        let customerMonthRevenue = 0;
        for (const fact of customerFacts) {
          if (fact.month !== cellMonth) continue;
          customerMonthRevenue += fact.netRevenueCents;
        }
        netRevenueCents += customerMonthRevenue;
        // "Active" counts the customer once, even if multiple facts (e.g.
        // multiple invoices) landed in this month.
        if (customerMonthRevenue > 0) activeCustomers += 1;
      }

      const retentionBps = Math.round((activeCustomers * 10000) / cohortSize);
      cells.push({ offset, month: cellMonth, activeCustomers, netRevenueCents, retentionBps });
    }

    rows.push({ cohortMonth, cohortSize, customerIds: sortedIds, cells });
  }

  rows.sort((a, b) => (a.cohortMonth < b.cohortMonth ? -1 : a.cohortMonth > b.cohortMonth ? 1 : 0));

  return {
    months: [...months],
    rows,
    totalNewCustomers,
    excludedPriorCustomers,
  };
}
