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
 *   - issuing a credit note:  DR <revenue account, 4800> / CR 1120 (AR), at the note total (Phase 26)
 *   - issuing a debit note:   DR 2100 (AP)          / CR <expense account>, at the note total (Phase 26)
 *   - an invoice line for a stock item: also DR 5050 (COGS) / CR 1140 (Inventory) at moving-average cost (Phase 32)
 *   - a bill line for a stock item: DR 1140 (Inventory) — the line's own account — / CR 2100
 *   - a deposit applied:      DR 2130 (Customer Deposits) / CR 1120 (AR) (Phase 42/43)
 *   - a journal:              each line as given; a repeating one once per month, with an optional day-1 reversal
 *   - applying a note:        no journal entry at all — it only matches two
 *                             open items inside the same control account
 *
 * Money is integer cents throughout (guardrails rule 3) — every input comes
 * through `parseMoneyText`, and this module never introduces a float.
 *
 * `walkthrough.test.ts` case 15 replays the same dataset through the real
 * HTTP API and asserts the real reports equal this module's output, cent
 * for cent — this file is an answer key that has been checked, not merely
 * asserted.
 */
import { WALKTHROUGH_DATASET, documentDueDate, documentLines, type DatasetDocument } from './walkthroughDataset.js';
import { depositAppliedCents, noteAppliedCents, resolveSettlementLines } from './walkthroughTiers.js';
import type { AnchorMonth, ScenarioMonth, WalkthroughMonth } from './walkthroughDates.js';
import { WALKTHROUGH_MONTHS, lastDayOfWalkthroughMonth, resolveDate } from './walkthroughDates.js';
import { convertToBase } from '../utils/fxRate.js';
import { cents, parseMoneyText, scaleCents } from '../utils/money.js';

const ACCOUNT_NAMES: Record<string, string> = {
  '1110': 'Operating Cash',
  '1115': 'EUR Receipts Account',
  '1120': 'Accounts Receivable',
  '1130': 'Prepaid Expenses',
  '1140': 'Inventory',
  '1180': 'GST/VAT Input Credit',
  '1500': 'Fixed Assets / Equipment',
  '2100': 'Accounts Payable',
  '2120': 'Accrued Liabilities',
  '2130': 'Customer Deposits',
  '2140': 'GST/VAT Output Payable',
  '2160': 'Payroll Liabilities',
  '3100': "Common Stock / Owner's Capital",
  '4100': 'Product Revenue',
  '4200': 'Service Revenue',
  '4300': 'Interest Income',
  '4800': 'Sales Returns & Allowances',
  '4910': 'Realized FX Gain',
  '5050': 'Cost of Sales — Inventory',
  '5100': 'Direct Materials',
  '5200': 'Direct Labor',
  '5300': 'Freight & Duty',
  '6100': 'Salaries & Wages',
  '6110': 'Rent & Utilities',
  '6120': 'Software & IT Infrastructure',
  '6150': 'Insurance',
  '6200': 'Professional Fees',
  '6400': 'Marketing & Advertising',
  '6600': 'Bank Fees',
  '6810': 'Realized FX Loss',
  '6820': 'Unrealized FX Gain/Loss',
};

function accountName(code: string): string {
  const name = ACCOUNT_NAMES[code];
  if (name === undefined) throw new Error(`walkthrough fixture: no name registered for account ${code}`);
  return name;
}

/** One simulated ledger_lines row: exactly one side populated, matching guardrails rule 7. */
interface SimLine {
  /** Months 8 and 9 are the months after the scenario (reversals, later occurrences); never inside a report. */
  month: ScenarioMonth;
  code: string;
  debitCents: number;
  creditCents: number;
}

/** qty × unit price in whole cents; the dataset is chosen so the product is always exact. */
function lineCents(quantity: string, unitAmount: string): number {
  return Math.round(Number(quantity) * parseMoneyText(unitAmount));
}

/** Per-line tax, half-up — exactly as `computeLineTotals` does it. */
function lineTaxCents(netCents: number, taxRateBp: number | undefined): number {
  return scaleCents(cents(netCents), taxRateBp ?? 0, 10_000);
}

/** The latest FX rate entered on or before `date` (an ISO date). Throws when none exists. */
function rateOn(anchor: AnchorMonth, date: string): string {
  let best: { date: string; rate: string } | undefined;
  for (const r of WALKTHROUGH_DATASET.fxRates) {
    const rateDate = r.day === 'LAST' ? lastDayOfWalkthroughMonth(anchor, r.month) : resolveDate(anchor, r.month, r.day);
    if (rateDate <= date && (best === undefined || rateDate >= best.date)) best = { date: rateDate, rate: r.rate };
  }
  if (best === undefined) throw new Error(`walkthrough fixture: no exchange rate on or before ${date}`);
  return best.rate;
}

/** Native cents to base cents at the rate in force on the document's own date; USD is untouched. */
function toBaseAtDocRate(anchor: AnchorMonth, doc: DatasetDocument, nativeCents: number): number {
  if (doc.currency === undefined) return nativeCents;
  return convertToBase(cents(nativeCents), rateOn(anchor, resolveDate(anchor, doc.month, doc.day)));
}

function paymentsAllocatedNative(ref: string, throughMonth: ScenarioMonth): number {
  return WALKTHROUGH_DATASET.fxPayments
    .filter((p) => p.documentRef === ref && p.month <= throughMonth)
    .reduce((sum, p) => sum + parseMoneyText(p.amount), 0);
}

function buildLedgerLines(anchor: AnchorMonth): SimLine[] {
  const lines: SimLine[] = [];
  const stockItems = new Map(WALKTHROUGH_DATASET.stockItems.map((i) => [i.code, i]));

  /** Appends one journal entry's lines after checking it balances. */
  function emit(label: string, entry: SimLine[]): void {
    const debit = entry.reduce((sum, l) => sum + l.debitCents, 0);
    const credit = entry.reduce((sum, l) => sum + l.creditCents, 0);
    if (debit !== credit) throw new Error(`walkthrough answer key: entry ${label} does not balance`);
    lines.push(...entry);
  }

  for (const doc of WALKTHROUGH_DATASET.invoices) {
    const entry: SimLine[] = [];
    let totalCents = 0;
    let taxTotalCents = 0;
    for (const line of documentLines(doc)) {
      const netCents = toBaseAtDocRate(anchor, doc, lineCents(line.quantity, line.unitPrice));
      const taxCents = doc.currency === undefined
        ? lineTaxCents(netCents, line.taxRateBp)
        : toBaseAtDocRate(anchor, doc, lineTaxCents(lineCents(line.quantity, line.unitPrice), line.taxRateBp));
      totalCents += netCents + taxCents;
      taxTotalCents += taxCents;
      entry.push({ month: doc.month, code: line.accountCode, debitCents: 0, creditCents: netCents });
      // An invoice line for a stock item also relieves inventory at moving-average cost.
      const stock = line.itemCode === null ? undefined : stockItems.get(line.itemCode);
      if (stock !== undefined) {
        const costCents = lineCents(line.quantity, stock.unitCost);
        entry.push({ month: doc.month, code: stock.cogsAccount, debitCents: costCents, creditCents: 0 });
        entry.push({ month: doc.month, code: stock.assetAccount, debitCents: 0, creditCents: costCents });
      }
    }
    if (taxTotalCents > 0) entry.push({ month: doc.month, code: '2140', debitCents: 0, creditCents: taxTotalCents });
    entry.push({ month: doc.month, code: '1120', debitCents: totalCents, creditCents: 0 });
    emit(`invoice ${doc.ref}`, entry);
  }
  for (const doc of WALKTHROUGH_DATASET.bills) {
    const entry: SimLine[] = [];
    let totalCents = 0;
    let taxTotalCents = 0;
    for (const line of documentLines(doc)) {
      const netCents = toBaseAtDocRate(anchor, doc, lineCents(line.quantity, line.unitPrice));
      const taxCents = doc.currency === undefined
        ? lineTaxCents(netCents, line.taxRateBp)
        : toBaseAtDocRate(anchor, doc, lineTaxCents(lineCents(line.quantity, line.unitPrice), line.taxRateBp));
      totalCents += netCents + taxCents;
      taxTotalCents += taxCents;
      entry.push({ month: doc.month, code: line.accountCode, debitCents: netCents, creditCents: 0 });
    }
    if (taxTotalCents > 0) entry.push({ month: doc.month, code: '1180', debitCents: taxTotalCents, creditCents: 0 });
    entry.push({ month: doc.month, code: '2100', debitCents: 0, creditCents: totalCents });
    emit(`bill ${doc.ref}`, entry);
  }
  for (const application of WALKTHROUGH_DATASET.depositApplications) {
    const target = WALKTHROUGH_DATASET.invoices.find((d) => d.ref === application.documentRef);
    if (target === undefined) throw new Error(`walkthrough fixture: no document ${application.documentRef}`);
    const amountCents = parseMoneyText(application.amount);
    emit(`deposit application ${application.depositRef}`, [
      { month: target.month, code: '2130', debitCents: amountCents, creditCents: 0 },
      { month: target.month, code: '1120', debitCents: 0, creditCents: amountCents },
    ]);
  }
  // A foreign-currency receipt: cash at the payment-day rate, AR relieved at the document's rate,
  // the difference a realized gain (4910) or loss (6810).
  for (const payment of WALKTHROUGH_DATASET.fxPayments) {
    const doc = WALKTHROUGH_DATASET.invoices.find((d) => d.ref === payment.documentRef);
    if (doc === undefined) throw new Error(`walkthrough fixture: no document ${payment.documentRef}`);
    const nativeCents = parseMoneyText(payment.amount);
    const cashCents = convertToBase(cents(nativeCents), rateOn(anchor, resolveDate(anchor, payment.month, payment.day)));
    const arCents = toBaseAtDocRate(anchor, doc, nativeCents);
    const entry: SimLine[] = [
      { month: payment.month, code: payment.cashAccountCode, debitCents: cashCents, creditCents: 0 },
      { month: payment.month, code: '1120', debitCents: 0, creditCents: arCents },
    ];
    if (cashCents > arCents) entry.push({ month: payment.month, code: '4910', debitCents: 0, creditCents: cashCents - arCents });
    if (cashCents < arCents) entry.push({ month: payment.month, code: '6810', debitCents: arCents - cashCents, creditCents: 0 });
    emit(`payment ${payment.ref}`, entry);
  }
  // Month-end revaluation of open foreign-currency invoices; the mirror lands in the next month.
  for (const reval of WALKTHROUGH_DATASET.fxRevaluations) {
    const lastDay = lastDayOfWalkthroughMonth(anchor, reval.month);
    const entry: SimLine[] = [];
    for (const doc of WALKTHROUGH_DATASET.invoices) {
      if (doc.currency === undefined || doc.month > reval.month) continue;
      const outstandingNative = parseMoneyText(doc.total) - paymentsAllocatedNative(doc.ref, reval.month);
      if (outstandingNative <= 0) continue;
      const delta =
        convertToBase(cents(outstandingNative), rateOn(anchor, lastDay)) - toBaseAtDocRate(anchor, doc, outstandingNative);
      if (delta === 0) continue;
      const abs = Math.abs(delta);
      entry.push({ month: reval.month, code: '6820', debitCents: delta < 0 ? abs : 0, creditCents: delta < 0 ? 0 : abs });
      entry.push({ month: reval.month, code: '1120', debitCents: delta < 0 ? 0 : abs, creditCents: delta < 0 ? abs : 0 });
    }
    emit(`revaluation month ${String(reval.month)}`, entry);
    emit(
      `revaluation reversal month ${String(reval.month)}`,
      entry.map((l) => ({ month: (reval.month + 1) as ScenarioMonth, code: l.code, debitCents: l.creditCents, creditCents: l.debitCents })),
    );
  }
  for (const journal of WALKTHROUGH_DATASET.journals) {
    if (journal.entry === 'DRAFT_DELETED') continue;
    const lastMonth = journal.repeat === null ? journal.month : journal.repeat.endMonth;
    for (let m: number = journal.month; m <= lastMonth; m++) {
      const month = m as ScenarioMonth;
      const entry = journal.lines.map((line): SimLine => ({
        month,
        code: line.accountCode,
        debitCents: parseMoneyText(line.debit),
        creditCents: parseMoneyText(line.credit),
      }));
      emit(`journal ${journal.ref} month ${String(month)}`, entry);
      if (journal.entry === 'POSTED_VOIDED') {
        // The void reverses the entry on the same books: both sides appear on the trial balance.
        emit(`journal ${journal.ref} void`, entry.map((l) => ({ ...l, debitCents: l.creditCents, creditCents: l.debitCents })));
      }
      if (journal.repeat?.autoReverse === true) {
        // The mirror lands on day 1 of the following month.
        emit(
          `journal ${journal.ref} reversal month ${String(month)}`,
          entry.map((l) => ({ month: (month + 1) as ScenarioMonth, code: l.code, debitCents: l.creditCents, creditCents: l.debitCents })),
        );
      }
    }
  }
  for (const settlement of resolveSettlementLines({ year: 2000, month: 1 })) {
    // The settlement's own accounting month, not calendar date, drives which
    // cumulative bucket it lands in — resolveSettlementLines's `month` field
    // already carries that, independent of the anchor passed in, so
    // any anchor works here; only isoDate (unused below) depends on it.
    const abs = Math.abs(settlement.amountCents);
    if (settlement.kind === 'invoice') {
      emit(`settlement ${settlement.lineRef}`, [
        { month: settlement.month, code: '1110', debitCents: abs, creditCents: 0 },
        { month: settlement.month, code: '1120', debitCents: 0, creditCents: abs },
      ]);
    } else {
      emit(`settlement ${settlement.lineRef}`, [
        { month: settlement.month, code: '2100', debitCents: abs, creditCents: 0 },
        { month: settlement.month, code: '1110', debitCents: 0, creditCents: abs },
      ]);
    }
  }
  for (const note of WALKTHROUGH_DATASET.notes) {
    const totalCents = parseMoneyText(note.total);
    if (note.kind === 'CREDIT_NOTE') {
      emit(`note ${note.ref}`, [
        { month: note.month, code: note.accountCode, debitCents: totalCents, creditCents: 0 },
        { month: note.month, code: '1120', debitCents: 0, creditCents: totalCents },
      ]);
    } else {
      emit(`note ${note.ref}`, [
        { month: note.month, code: '2100', debitCents: totalCents, creditCents: 0 },
        { month: note.month, code: note.accountCode, debitCents: 0, creditCents: totalCents },
      ]);
    }
  }
  for (const noise of WALKTHROUGH_DATASET.noise) {
    if (noise.resolution.kind === 'IGNORE') continue;
    const amountCents = parseMoneyText(noise.amount); // signed
    const abs = Math.abs(amountCents);
    const label = `bank line ${noise.description} month ${String(noise.month)}`;
    if (amountCents > 0) {
      emit(label, [
        { month: noise.month, code: '1110', debitCents: abs, creditCents: 0 },
        { month: noise.month, code: noise.resolution.accountCode, debitCents: 0, creditCents: abs },
      ]);
    } else {
      emit(label, [
        { month: noise.month, code: noise.resolution.accountCode, debitCents: abs, creditCents: 0 },
        { month: noise.month, code: '1110', debitCents: 0, creditCents: abs },
      ]);
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
  month: WalkthroughMonth;
  asOf: string;
  trialBalance: ExpectedTrialBalance;
  profitAndLoss: ExpectedProfitAndLoss;
  balanceSheet: ExpectedBalanceSheet;
  arAging: ExpectedAgingBucket[];
  apAging: ExpectedAgingBucket[];
  bankReconciliation: ExpectedBankReconciliation;
  /** Tax on invoices / bills dated in this month alone (base-currency cents). */
  taxSummary: { outputTaxCents: number; inputTaxCents: number; netTaxPayableCents: number };
  /** Net movement of the cash accounts (1110 + 1115) inside this month. */
  cashFlowNetChangeCents: number;
  /** Sum of the month-end revaluation deltas posted in this month (0 when none). */
  fxRevaluationDeltaCents: number;
  /** The 1120 Accounts Receivable balance at the month's end. */
  arControlCents: number;
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
  const allLines = buildLedgerLines(anchor);
  const settlements = resolveSettlementLines(anchor);
  return WALKTHROUGH_MONTHS.map((month): ExpectedMonth => {
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
    // 4800 is a Revenue account carrying a debit balance (sales returns), so
    // it lands here as a negative revenue row.
    // Classified by code prefix: 1 Asset, 2 Liability, 3 Equity, 4 Revenue,
    // 5 cost of sales (Expense), 6 operating Expense.
    const codesWithPrefix = (prefix: string): string[] => [...byAccount.keys()].filter((c) => c.startsWith(prefix)).sort();
    const revenueCodes = codesWithPrefix('4');
    const costOfSalesCodes = codesWithPrefix('5');
    const opexCodes = codesWithPrefix('6');

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
    const assetCodes = codesWithPrefix('1');
    const liabilityCodes = codesWithPrefix('2');
    const equityCodes = codesWithPrefix('3');
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
    // A foreign-currency document is paid in its own currency (`fxPayments`, native cents); aging
    // values what is left at the document's own frozen rate, as agingService does (base_total_cents).
    function outstandingCents(doc: DatasetDocument): number {
      const totalCents = parseMoneyText(doc.total);
      const settledCents = settlements
        .filter((s) => s.documentRef === doc.ref && s.month <= month)
        .reduce((sum, s) => sum + Math.abs(s.amountCents), 0);
      const nativeLeft =
        totalCents -
        settledCents -
        paymentsAllocatedNative(doc.ref, month) -
        noteAppliedCents(doc.ref, month) -
        depositAppliedCents(doc.ref, month);
      return toBaseAtDocRate(anchor, doc, nativeLeft);
    }

    const arBuckets = emptyAgingBuckets();
    for (const doc of WALKTHROUGH_DATASET.invoices) {
      if (doc.month > month) continue;
      const outstanding = outstandingCents(doc);
      if (outstanding <= 0) continue;
      const dueDate = documentDueDate(anchor, doc);
      const bucket = agingBucket(dueDate, asOf);
      const entry = arBuckets.find((b) => b.bucket === bucket);
      if (entry !== undefined) entry.amountCents += outstanding;
    }

    const apBuckets = emptyAgingBuckets();
    for (const doc of WALKTHROUGH_DATASET.bills) {
      if (doc.month > month) continue;
      const outstanding = outstandingCents(doc);
      if (outstanding <= 0) continue;
      const dueDate = documentDueDate(anchor, doc);
      const bucket = agingBucket(dueDate, asOf);
      const entry = apBuckets.find((b) => b.bucket === bucket);
      if (entry !== undefined) entry.amountCents += outstanding;
    }

    // A note's unapplied remainder is a NEGATIVE open item, always CURRENT —
    // the same rule agingService applies (Phase 26).
    for (const note of WALKTHROUGH_DATASET.notes) {
      if (note.month > month) continue;
      const unappliedCents =
        parseMoneyText(note.total) - note.allocations.reduce((sum, a) => sum + parseMoneyText(a.amount), 0);
      if (unappliedCents === 0) continue;
      const buckets = note.kind === 'CREDIT_NOTE' ? arBuckets : apBuckets;
      const entry = buckets.find((b) => b.bucket === 'CURRENT');
      if (entry !== undefined) entry.amountCents -= unappliedCents;
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
    // (A bank rule's posting is the same journal shape — the Phase 34 path.)
    const journaledNoiseCount = noiseThroughMonth.filter((n) => n.resolution.kind !== 'IGNORE').length;
    const matchedCount = settledThroughMonth.length + journaledNoiseCount;
    const ignoredCount = noiseThroughMonth.filter((n) => n.resolution.kind === 'IGNORE').length;

    // ---- Tax summary: tax on documents dated in this month alone ----
    const taxCentsOf = (doc: DatasetDocument): number =>
      documentLines(doc).reduce((sum, line) => {
        const nativeNet = lineCents(line.quantity, line.unitPrice);
        return sum + toBaseAtDocRate(anchor, doc, lineTaxCents(nativeNet, line.taxRateBp));
      }, 0);
    const outputTaxCents = WALKTHROUGH_DATASET.invoices.filter((d) => d.month === month).reduce((sum, d) => sum + taxCentsOf(d), 0);
    const inputTaxCents = WALKTHROUGH_DATASET.bills.filter((d) => d.month === month).reduce((sum, d) => sum + taxCentsOf(d), 0);

    // ---- Cash flow: net movement of the cash accounts inside this month ----
    const cashFlowNetChangeCents = allLines
      .filter((l) => l.month === month && (l.code === '1110' || l.code === '1115'))
      .reduce((sum, l) => sum + l.debitCents - l.creditCents, 0);

    // ---- FX revaluation delta posted this month, and the AR control balance ----
    const fxRevaluationDeltaCents = allLines
      .filter((l) => l.month === month && l.code === '6820')
      .reduce((sum, l) => sum + l.debitCents - l.creditCents, 0);
    const arSums = byAccount.get('1120') ?? { debitCents: 0, creditCents: 0 };

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
      taxSummary: { outputTaxCents, inputTaxCents, netTaxPayableCents: outputTaxCents - inputTaxCents },
      cashFlowNetChangeCents,
      // Debit-positive on 6820 is a loss; the key reports the signed delta to the receivable (a loss is negative).
      fxRevaluationDeltaCents: -fxRevaluationDeltaCents,
      arControlCents: arSums.debitCents - arSums.creditCents,
    };
  });
}
