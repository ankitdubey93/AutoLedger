import * as planService from './planService.js';
import * as budgetService from './budgetService.js';
import * as organizationService from '../organizationService.js';
import * as reportService from '../ledger-core/reportService.js';
import { monthBounds } from '../../utils/fiscalYear.js';
import { ApiError } from '../../utils/apiError.js';
import type { ForecasterVarianceRow } from '../../types/forecaster.js';
import type { AccountType } from '../../types/ledger-core.js';

/**
 * ForecasterPro (Phase 13) — budget-vs-actual variance. This file contains
 * ZERO SQL. Its only route into LedgerCore is
 * `reportService.monthlyActualsByAccount` (guardrails rule 16), the same
 * boundary `services/fpa-engine/forecastService.ts` documents for its own
 * reads.
 */

export interface VarianceResponse {
  planId: string;
  planName: string;
  versionId: string;
  versionLabel: string;
  baseCurrency: string;
  from: string; // 'YYYY-MM-01'
  to: string; // 'YYYY-MM-01' — the last month of the requested window
  rows: ForecasterVarianceRow[];
}

interface RowKeyParts {
  accountId: string;
  month: string;
}

function rowKey(parts: RowKeyParts): string {
  return `${parts.accountId}|${parts.month}`;
}

export async function planVariance(
  orgId: string,
  planId: string,
  from: string | null,
  to: string | null,
): Promise<VarianceResponse> {
  const plan = await planService.getPlanById(orgId, planId);
  const org = await organizationService.getById(orgId);

  const approved = await budgetService.approvedVersionLines(orgId, planId);
  if (approved === null) {
    throw new ApiError(422, 'This plan has no approved budget version');
  }

  const months = planService.planMonths(plan.startsOn, plan.horizonMonths);
  const lastMonth = months[months.length - 1];
  if (lastMonth === undefined) throw new Error('planMonths returned an empty array');

  const resolvedFrom = from ?? plan.startsOn;
  const resolvedTo = to ?? lastMonth;
  if (resolvedFrom > resolvedTo) {
    throw new ApiError(422, 'from must not be after to');
  }

  const actualRows = await reportService.monthlyActualsByAccount(
    orgId,
    resolvedFrom,
    monthBounds(resolvedTo).endDate,
  );

  interface Bucket {
    accountId: string;
    accountCode: string;
    accountName: string;
    accountType: AccountType;
    month: string;
    budgetCents: number;
    actualCents: number;
  }
  const buckets = new Map<string, Bucket>();

  for (const line of approved.lines) {
    if (line.month < resolvedFrom || line.month > resolvedTo) continue;
    const key = rowKey({ accountId: line.accountId, month: line.month });
    const existing = buckets.get(key);
    if (existing !== undefined) {
      existing.budgetCents += line.amountCents;
    } else {
      buckets.set(key, {
        accountId: line.accountId,
        accountCode: line.accountCode,
        accountName: line.accountName,
        // The budget line doesn't carry an account type; resolved from the
        // actuals bridge below if this account also has activity, else
        // defaulted to 'Expense' (the same fallback headcount/forecast-line
        // joins use for an unresolvable account).
        accountType: 'Expense',
        month: line.month,
        budgetCents: line.amountCents,
        actualCents: 0,
      });
    }
  }

  for (const row of actualRows) {
    const key = rowKey({ accountId: row.accountId, month: row.month });
    const netCents = row.type === 'Revenue' ? row.creditCents - row.debitCents : row.debitCents - row.creditCents;
    const existing = buckets.get(key);
    if (existing !== undefined) {
      existing.actualCents = netCents;
      existing.accountType = row.type;
    } else {
      buckets.set(key, {
        accountId: row.accountId,
        accountCode: row.code,
        accountName: row.name,
        accountType: row.type,
        month: row.month,
        budgetCents: 0,
        actualCents: netCents,
      });
    }
  }

  const rows: ForecasterVarianceRow[] = [...buckets.values()]
    .map((b) => {
      const varianceCents = b.actualCents - b.budgetCents;
      const favourable =
        b.accountType === 'Revenue' ? b.actualCents >= b.budgetCents : b.actualCents <= b.budgetCents;
      return {
        accountId: b.accountId,
        accountCode: b.accountCode,
        accountName: b.accountName,
        accountType: b.accountType,
        month: b.month,
        budgetCents: b.budgetCents,
        actualCents: b.actualCents,
        varianceCents,
        favourable,
      };
    })
    .sort((a, b) => (a.month === b.month ? (a.accountCode < b.accountCode ? -1 : 1) : a.month < b.month ? -1 : 1));

  return {
    planId: plan.id,
    planName: plan.name,
    versionId: approved.versionId,
    versionLabel: approved.label,
    baseCurrency: org.baseCurrency,
    from: resolvedFrom,
    to: resolvedTo,
    rows,
  };
}
