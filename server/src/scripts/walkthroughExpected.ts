/**
 * The answer key: every figure in `07-expected-results.md`, computed from
 * `WALKTHROUGH_DATASET` by simulating the exact debit/credit shape each
 * real service posts — never a shortcut arithmetic that merely happens to
 * agree. Every posting shape below is taken directly from reading
 * `invoiceService`, `billService`, `paymentService` and
 * `bankMatchService.postJournalForTransaction`:
 *
 *   - issuing an invoice:     DR 1120 (AR)         / CR <revenue account>, at the full total
 *   - approving a bill:       DR <expense account> / CR 2100 (AP), at the full total
 *   - a deposit settling it:  DR 1110 (Cash)        / CR 1120 (AR), at the settled amount
 *   - a withdrawal settling:  DR 2100 (AP)          / CR 1110 (Cash), at the settled amount
 *   - a money-in journal:     DR 1110 (Cash)        / CR <chosen account>
 *   - a money-out journal:    DR <chosen account>   / CR 1110 (Cash)
 *
 * Money is integer cents throughout (guardrails rule 3) — every input comes
 * through `parseMoneyText`, and this module never introduces a float.
 *
 * `walkthrough.test.ts` case 15 replays the same dataset through the real
 * HTTP API and asserts the real reports equal this module's output, cent
 * for cent — this file is an answer key that has been checked, not merely
 * asserted.
 */
import { WALKTHROUGH_DATASET } from './walkthroughDataset.js';
import { resolveSettlementLines } from './walkthroughTiers.js';
import type { AnchorMonth } from './walkthroughDates.js';
import { lastDayOfWalkthroughMonth, resolveDate } from './walkthroughDates.js';
import { parseMoneyText } from '../utils/money.js';

const ACCOUNT_NAMES: Record<string, string> = {
  '1110': 'Operating Cash',
  '1120': 'Accounts Receivable',
  '2100': 'Accounts Payable',
  '3100': "Common Stock / Owner's Capital",
  '4100': 'Product Revenue',
  '4200': 'Service Revenue',
  '4300': 'Interest Income',
  '5100': 'Direct Materials',
  '5300': 'Freight & Duty',
  '6110': 'Rent & Utilities',
  '6120': 'Software & IT Infrastructure',
  '6200': 'Professional Fees',
  '6400': 'Marketing & Advertising',
  '6600': 'Bank Fees',
};

function accountName(code: string): string {
  const name = ACCOUNT_NAMES[code];
  if (name === undefined) throw new Error(`walkthrough fixture: no name registered for account ${code}`);
  return name;
}

/** One simulated ledger_lines row: exactly one side populated, matching guardrails rule 7. */
interface SimLine {
  month: 1 | 2 | 3;
  code: string;
  debitCents: number;
  creditCents: number;
}

function buildLedgerLines(): SimLine[] {
  const lines: SimLine[] = [];

  for (const doc of WALKTHROUGH_DATASET.invoices) {
    const totalCents = parseMoneyText(doc.total);
    lines.push({ month: doc.month, code: '1120', debitCents: totalCents, creditCents: 0 });
    lines.push({ month: doc.month, code: doc.accountCode, debitCents: 0, creditCents: totalCents });
  }
  for (const doc of WALKTHROUGH_DATASET.bills) {
    const totalCents = parseMoneyText(doc.total);
    lines.push({ month: doc.month, code: doc.accountCode, debitCents: totalCents, creditCents: 0 });
    lines.push({ month: doc.month, code: '2100', debitCents: 0, creditCents: totalCents });
  }
  for (const settlement of resolveSettlementLines({ year: 2000, month: 1 })) {
    // The settlement's own accounting month, not calendar date, drives which
    // cumulative bucket it lands in — resolveSettlementLines's `month` field
    // (1|2|3) already carries that, independent of the anchor passed in, so
    // any anchor works here; only isoDate (unused below) depends on it.
    const abs = Math.abs(settlement.amountCents);
    if (settlement.kind === 'invoice') {
      lines.push({ month: settlement.month, code: '1110', debitCents: abs, creditCents: 0 });
      lines.push({ month: settlement.month, code: '1120', debitCents: 0, creditCents: abs });
    } else {
      lines.push({ month: settlement.month, code: '2100', debitCents: abs, creditCents: 0 });
      lines.push({ month: settlement.month, code: '1110', debitCents: 0, creditCents: abs });
    }
  }
  for (const noise of WALKTHROUGH_DATASET.noise) {
    if (noise.resolution.kind === 'IGNORE') continue;
    const amountCents = parseMoneyText(noise.amount); // signed
    const abs = Math.abs(amountCents);
    if (amountCents > 0) {
      lines.push({ month: noise.month, code: '1110', debitCents: abs, creditCents: 0 });
      lines.push({ month: noise.month, code: noise.resolution.accountCode, debitCents: 0, creditCents: abs });
    } else {
      lines.push({ month: noise.month, code: noise.resolution.accountCode, debitCents: abs, creditCents: 0 });
      lines.push({ month: noise.month, code: '1110', debitCents: 0, creditCents: abs });
    }
  }

  return lines;
}

export interface ExpectedAccountRow {
  code: string;
  name: string;
  debitCents: number;
  creditCents: number;
}

export interface ExpectedTrialBalance {
  rows: ExpectedAccountRow[];
  totalDebitCents: number;
  totalCreditCents: number;
  isBalanced: boolean;
}

export interface ExpectedStatementRow {
  code: string;
  name: string;
  amountCents: number;
}

export interface ExpectedProfitAndLoss {
  revenue: ExpectedStatementRow[];
  revenueTotalCents: number;
  costOfSales: ExpectedStatementRow[];
  costOfSalesTotalCents: number;
  grossProfitCents: number;
  operatingExpenses: ExpectedStatementRow[];
  operatingExpensesTotalCents: number;
  netIncomeCents: number;
}

export interface ExpectedBalanceSheet {
  assets: ExpectedStatementRow[];
  assetsTotalCents: number;
  liabilities: ExpectedStatementRow[];
  liabilitiesTotalCents: number;
  equityRows: ExpectedStatementRow[];
  /** Cumulative net income through asOf — this dataset never crosses a fiscal year boundary, so the real report's retainedEarningsCents + currentEarningsCents always sums to exactly this. */
  cumulativeNetIncomeCents: number;
  equityTotalCents: number;
  totalLiabilitiesAndEquityCents: number;
  balances: boolean;
}

export interface ExpectedAgingBucket {
  bucket: 'CURRENT' | 'D1_30' | 'D31_60' | 'D61_90' | 'D90_PLUS';
  label: string;
  amountCents: number;
}

export interface ExpectedBankReconciliation {
  glBalanceCents: number;
  statementBalanceCents: number;
  differenceCents: number;
  matchedCount: number;
  unmatchedCount: number;
  ignoredCount: number;
}

export interface ExpectedMonth {
  month: 1 | 2 | 3;
  asOf: string;
  trialBalance: ExpectedTrialBalance;
  profitAndLoss: ExpectedProfitAndLoss;
  balanceSheet: ExpectedBalanceSheet;
  arAging: ExpectedAgingBucket[];
  apAging: ExpectedAgingBucket[];
  bankReconciliation: ExpectedBankReconciliation;
}

const AGING_BUCKET_LABELS = {
  CURRENT: 'Current',
  D1_30: '1–30 days',
  D31_60: '31–60 days',
  D61_90: '61–90 days',
  D90_PLUS: '90+ days',
} as const;

/** Mirrors agingService's own bucket boundaries exactly (see agingService.ts's buildOpenDocsCte). */
function agingBucket(dueDate: string, asOf: string): keyof typeof AGING_BUCKET_LABELS {
  if (dueDate >= asOf) return 'CURRENT';
  const d1 = shiftIso(asOf, -30);
  const d31 = shiftIso(asOf, -60);
  const d61 = shiftIso(asOf, -90);
  if (dueDate > d1) return 'D1_30';
  if (dueDate > d31) return 'D31_60';
  if (dueDate > d61) return 'D61_90';
  return 'D90_PLUS';
}

function shiftIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days);
  return new Date(t).toISOString().slice(0, 10);
}

function emptyAgingBuckets(): ExpectedAgingBucket[] {
  return (Object.keys(AGING_BUCKET_LABELS) as (keyof typeof AGING_BUCKET_LABELS)[]).map((bucket) => ({
    bucket,
    label: AGING_BUCKET_LABELS[bucket],
    amountCents: 0,
  }));
}

export function computeExpectedResults(anchor: AnchorMonth): ExpectedMonth[] {
  const allLines = buildLedgerLines();
  const settlements = resolveSettlementLines(anchor);
  const months: (1 | 2 | 3)[] = [1, 2, 3];

  return months.map((month): ExpectedMonth => {
    const asOf = lastDayOfWalkthroughMonth(anchor, month);
    const linesThroughMonth = allLines.filter((l) => l.month <= month);

    // ---- Trial balance ----
    const byAccount = new Map<string, { debitCents: number; creditCents: number }>();
    for (const line of linesThroughMonth) {
      const acc = byAccount.get(line.code) ?? { debitCents: 0, creditCents: 0 };
      acc.debitCents += line.debitCents;
      acc.creditCents += line.creditCents;
      byAccount.set(line.code, acc);
    }
    const tbRows: ExpectedAccountRow[] = [...byAccount.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, sums]) => ({ code, name: accountName(code), debitCents: sums.debitCents, creditCents: sums.creditCents }));
    const totalDebitCents = tbRows.reduce((s, r) => s + r.debitCents, 0);
    const totalCreditCents = tbRows.reduce((s, r) => s + r.creditCents, 0);

    // ---- P&L (cumulative from month 1 through this month's asOf) ----
    const revenueCodes = ['4100', '4200', '4300'];
    const costOfSalesCodes = ['5100', '5300'];
    const opexCodes = ['6110', '6120', '6200', '6400', '6600'];

    function netBalance(code: string, creditNormal: boolean): number {
      const sums = byAccount.get(code) ?? { debitCents: 0, creditCents: 0 };
      return creditNormal ? sums.creditCents - sums.debitCents : sums.debitCents - sums.creditCents;
    }

    function rowsFor(codes: string[], creditNormal: boolean): ExpectedStatementRow[] {
      return codes
        .filter((code) => byAccount.has(code))
        .map((code) => ({ code, name: accountName(code), amountCents: netBalance(code, creditNormal) }));
    }

    const revenueRows = rowsFor(revenueCodes, true);
    const costOfSalesRows = rowsFor(costOfSalesCodes, false);
    const operatingExpenseRows = rowsFor(opexCodes, false);
    const revenueTotalCents = revenueRows.reduce((s, r) => s + r.amountCents, 0);
    const costOfSalesTotalCents = costOfSalesRows.reduce((s, r) => s + r.amountCents, 0);
    const operatingExpensesTotalCents = operatingExpenseRows.reduce((s, r) => s + r.amountCents, 0);
    const grossProfitCents = revenueTotalCents - costOfSalesTotalCents;
    const netIncomeCents = grossProfitCents - operatingExpensesTotalCents;

    // ---- Balance sheet ----
    const assetCodes = ['1110', '1120'];
    const liabilityCodes = ['2100'];
    const equityCodes = ['3100'];
    const assetsRows = rowsFor(assetCodes, false);
    const liabilitiesRows = rowsFor(liabilityCodes, true);
    const equityRows = rowsFor(equityCodes, true);
    const assetsTotalCents = assetsRows.reduce((s, r) => s + r.amountCents, 0);
    const liabilitiesTotalCents = liabilitiesRows.reduce((s, r) => s + r.amountCents, 0);
    const equityRowsTotalCents = equityRows.reduce((s, r) => s + r.amountCents, 0);
    const equityTotalCents = equityRowsTotalCents + netIncomeCents;
    const totalLiabilitiesAndEquityCents = liabilitiesTotalCents + equityTotalCents;

    // ---- AR/AP aging: an invoice/bill is open at asOf when its settlement(s)
    // through this month don't yet sum to its full total. ----
    function outstandingCents(ref: string, total: string): number {
      const totalCents = parseMoneyText(total);
      const settledCents = settlements
        .filter((s) => s.documentRef === ref && s.month <= month)
        .reduce((sum, s) => sum + Math.abs(s.amountCents), 0);
      return totalCents - settledCents;
    }

    const arBuckets = emptyAgingBuckets();
    for (const doc of WALKTHROUGH_DATASET.invoices) {
      if (doc.month > month) continue;
      const outstanding = outstandingCents(doc.ref, doc.total);
      if (outstanding <= 0) continue;
      const dueDate = resolveDate(anchor, doc.month, doc.day + doc.dueDays);
      const bucket = agingBucket(dueDate, asOf);
      const entry = arBuckets.find((b) => b.bucket === bucket);
      if (entry !== undefined) entry.amountCents += outstanding;
    }

    const apBuckets = emptyAgingBuckets();
    for (const doc of WALKTHROUGH_DATASET.bills) {
      if (doc.month > month) continue;
      const outstanding = outstandingCents(doc.ref, doc.total);
      if (outstanding <= 0) continue;
      const dueDate = resolveDate(anchor, doc.month, doc.day + doc.dueDays);
      const bucket = agingBucket(dueDate, asOf);
      const entry = apBuckets.find((b) => b.bucket === bucket);
      if (entry !== undefined) entry.amountCents += outstanding;
    }

    // ---- Bank reconciliation ----
    const settledThroughMonth = settlements.filter((s) => s.month <= month);
    const noiseThroughMonth = WALKTHROUGH_DATASET.noise.filter((n) => n.month <= month);
    const nonIgnoredNoiseCents = noiseThroughMonth
      .filter((n) => n.resolution.kind !== 'IGNORE')
      .reduce((sum, n) => sum + parseMoneyText(n.amount), 0);
    const statementBalanceCents = settledThroughMonth.reduce((sum, s) => sum + s.amountCents, 0) + nonIgnoredNoiseCents;
    const cashSums = byAccount.get('1110') ?? { debitCents: 0, creditCents: 0 };
    const glCashCents = cashSums.debitCents - cashSums.creditCents;

    // A bank line reaches status = 'MATCHED' whether it settled by matching a
    // document (a payment) or by a direct journal posting (Phase 6.1) — the
    // reconciliation report's matchedCount counts both alike, so this must too.
    const journaledNoiseCount = noiseThroughMonth.filter((n) => n.resolution.kind === 'POST_JOURNAL').length;
    const matchedCount = settledThroughMonth.length + journaledNoiseCount;
    const ignoredCount = noiseThroughMonth.filter((n) => n.resolution.kind === 'IGNORE').length;

    return {
      month,
      asOf,
      trialBalance: { rows: tbRows, totalDebitCents, totalCreditCents, isBalanced: totalDebitCents === totalCreditCents },
      profitAndLoss: {
        revenue: revenueRows,
        revenueTotalCents,
        costOfSales: costOfSalesRows,
        costOfSalesTotalCents,
        grossProfitCents,
        operatingExpenses: operatingExpenseRows,
        operatingExpensesTotalCents,
        netIncomeCents,
      },
      balanceSheet: {
        assets: assetsRows,
        assetsTotalCents,
        liabilities: liabilitiesRows,
        liabilitiesTotalCents,
        equityRows,
        cumulativeNetIncomeCents: netIncomeCents,
        equityTotalCents,
        totalLiabilitiesAndEquityCents,
        balances: assetsTotalCents === totalLiabilitiesAndEquityCents,
      },
      arAging: arBuckets,
      apAging: apBuckets,
      bankReconciliation: {
        glBalanceCents: glCashCents,
        statementBalanceCents,
        differenceCents: glCashCents - statementBalanceCents,
        matchedCount,
        unmatchedCount: 0,
        ignoredCount,
      },
    };
  });
}
