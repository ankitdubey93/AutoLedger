import {
  ACCOUNT_TRANSACTION_COLUMNS,
  GL_EXCEPTION_RULE_LABELS,
  type AccountTransactionColumn,
  type AccountTransactionLine,
  type AccountTransactionsReport,
  type AgingBucket,
  type AgingReport,
  type BalanceSheet,
  type CashFlowStatement,
  type ComparisonSection,
  type GlExceptionReport,
  type ProfitAndLoss,
  type ProfitAndLossComparison,
  type SalesPurchasesReport,
  type SalesPurchasesReportKind,
  type Variance,
  type StatementSection,
  type TaxSummary,
  type TaxSummaryAccountCheck,
  type TaxSummaryRow,
  type TrialBalance,
} from '../../types/accounting.js';
import type {
  ReportCell,
  ReportColumn,
  ReportContext,
  ReportRow,
  ReportTable,
} from '../../types/reportTable.js';
import { groupedCents } from '../../utils/reportCellText.js';

/**
 * Pure adapters: report results to format-neutral ReportTable values.
 * No SQL, no db imports (guardrails rule 2). Output is deterministic:
 * dates are formatted by hand, never through Intl.
 */

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-10-01' → '1 Oct 2026'. */
export function dateLabel(iso: string): string {
  const [year = '', month = '', day = ''] = iso.split('-');
  const monthName = MONTH_SHORT[Number(month) - 1] ?? '';
  return `${String(Number(day))} ${monthName} ${year}`;
}

const money = (cents: number): ReportCell => ({ kind: 'money', cents });
const text = (value: string): ReportCell => ({ kind: 'text', value });

function amountColumns(): ReportColumn[] {
  return [
    { key: 'code', label: 'Code', align: 'left', widthChars: 8 },
    { key: 'account', label: 'Account', align: 'left', widthChars: 40 },
    { key: 'amount', label: 'Amount', align: 'right', widthChars: 16 },
  ];
}

function detailRows(section: StatementSection): ReportRow[] {
  return section.rows.map((row) => ({
    style: 'detail',
    indent: 1,
    cells: { code: text(row.code), account: text(row.name), amount: money(row.amountCents) },
  }));
}

export function trialBalanceTable(ctx: ReportContext, report: TrialBalance): ReportTable {
  const rows: ReportRow[] = report.rows.map((row) => ({
    style: 'detail',
    indent: 0,
    cells: {
      code: text(row.code),
      account: text(row.name),
      type: text(row.type),
      debit: money(row.debitCents),
      credit: money(row.creditCents),
      net: money(row.netBalanceCents),
    },
  }));
  rows.push({
    style: 'total',
    indent: 0,
    cells: {
      account: text('Total'),
      debit: money(report.totalDebitCents),
      credit: money(report.totalCreditCents),
    },
  });

  const asOfLabel = report.asOf === null ? 'today' : dateLabel(report.asOf);
  return {
    title: 'Trial balance',
    subtitle: `${ctx.organizationName} · As at ${asOfLabel} · ${ctx.baseCurrency}`,
    columns: [
      { key: 'code', label: 'Code', align: 'left', widthChars: 8 },
      { key: 'account', label: 'Account', align: 'left', widthChars: 36 },
      { key: 'type', label: 'Type', align: 'left', widthChars: 10 },
      { key: 'debit', label: 'Debit', align: 'right', widthChars: 14 },
      { key: 'credit', label: 'Credit', align: 'right', widthChars: 14 },
      { key: 'net', label: 'Net balance', align: 'right', widthChars: 16 },
    ],
    rows,
    footnotes: [
      report.isBalanced
        ? 'Debits equal credits.'
        : `Out of balance by ${groupedCents(report.totalDebitCents - report.totalCreditCents)}.`,
    ],
    filenameStem: `trial-balance-${report.asOf ?? 'today'}`,
  };
}

export function profitAndLossTable(ctx: ReportContext, report: ProfitAndLoss): ReportTable {
  const rows: ReportRow[] = [
    { style: 'heading', indent: 0, cells: { account: text('Revenue') } },
    ...detailRows(report.revenue),
    { style: 'subtotal', indent: 0, cells: { account: text('Total revenue'), amount: money(report.revenue.totalCents) } },
    { style: 'heading', indent: 0, cells: { account: text('Cost of sales') } },
    ...detailRows(report.costOfSales),
    {
      style: 'subtotal',
      indent: 0,
      cells: { account: text('Total cost of sales'), amount: money(report.costOfSales.totalCents) },
    },
    { style: 'subtotal', indent: 0, cells: { account: text('Gross profit'), amount: money(report.grossProfitCents) } },
    { style: 'heading', indent: 0, cells: { account: text('Operating expenses') } },
    ...detailRows(report.operatingExpenses),
    {
      style: 'subtotal',
      indent: 0,
      cells: { account: text('Total operating expenses'), amount: money(report.operatingExpenses.totalCents) },
    },
    { style: 'total', indent: 0, cells: { account: text('Net income'), amount: money(report.netIncomeCents) } },
  ];

  return {
    title: 'Profit & loss',
    subtitle: `${ctx.organizationName} · ${dateLabel(report.from)} – ${dateLabel(report.to)} · ${ctx.baseCurrency}`,
    columns: amountColumns(),
    rows,
    footnotes: [],
    filenameStem: `profit-and-loss-${report.from}-${report.to}`,
  };
}

export function balanceSheetTable(ctx: ReportContext, report: BalanceSheet): ReportTable {
  const rows: ReportRow[] = [
    { style: 'heading', indent: 0, cells: { account: text('Assets') } },
    ...detailRows(report.assets),
    { style: 'total', indent: 0, cells: { account: text('Total assets'), amount: money(report.assets.totalCents) } },
    { style: 'heading', indent: 0, cells: { account: text('Liabilities') } },
    ...detailRows(report.liabilities),
    {
      style: 'subtotal',
      indent: 0,
      cells: { account: text('Total liabilities'), amount: money(report.liabilities.totalCents) },
    },
    { style: 'heading', indent: 0, cells: { account: text('Equity') } },
    ...detailRows(report.equity),
    {
      style: 'detail',
      indent: 1,
      cells: { account: text('Retained earnings'), amount: money(report.equity.retainedEarningsCents) },
    },
    {
      style: 'detail',
      indent: 1,
      cells: { account: text('Current year earnings'), amount: money(report.equity.currentEarningsCents) },
    },
    { style: 'subtotal', indent: 0, cells: { account: text('Total equity'), amount: money(report.equity.totalCents) } },
    {
      style: 'total',
      indent: 0,
      cells: {
        account: text('Total liabilities and equity'),
        amount: money(report.totalLiabilitiesAndEquityCents),
      },
    },
  ];

  return {
    title: 'Balance sheet',
    subtitle: `${ctx.organizationName} · As at ${dateLabel(report.asOf)} · ${ctx.baseCurrency}`,
    columns: amountColumns(),
    rows,
    footnotes: [report.balances ? 'Assets equal liabilities plus equity.' : 'Does not balance.'],
    filenameStem: `balance-sheet-${report.asOf}`,
  };
}

/** Phase 45 — AR/AP aging. One row per counterparty; the total row sums the report's own buckets. */
export function agingTable(ctx: ReportContext, report: AgingReport): ReportTable {
  const bucketCents = (name: AgingBucket): number => {
    const found = report.buckets.find((bucket) => bucket.bucket === name);
    if (found === undefined) throw new Error(`aging report is missing bucket ${name}`);
    return found.amountCents;
  };

  const rows: ReportRow[] = report.rows.map((row) => ({
    style: 'detail',
    indent: 0,
    cells: {
      party: text(row.counterpartyName),
      current: money(row.currentCents),
      d1: money(row.d1to30Cents),
      d31: money(row.d31to60Cents),
      d61: money(row.d61to90Cents),
      d90: money(row.d90PlusCents),
      total: money(row.totalCents),
    },
  }));
  rows.push({
    style: 'total',
    indent: 0,
    cells: {
      party: text('Total'),
      current: money(bucketCents('CURRENT')),
      d1: money(bucketCents('D1_30')),
      d31: money(bucketCents('D31_60')),
      d61: money(bucketCents('D61_90')),
      d90: money(bucketCents('D90_PLUS')),
      total: money(report.totalOutstandingCents),
    },
  });

  const footnotes: string[] = [];
  if (report.controlAccount !== null) {
    const { code, name, balanceCents } = report.controlAccount;
    footnotes.push(
      report.reconciles === true
        ? `Agrees with ${code} ${name}.`
        : `Does not agree with ${code} ${name} (${groupedCents(balanceCents)}).`,
    );
  }

  return {
    title: report.kind === 'AR' ? 'Aged receivables' : 'Aged payables',
    subtitle: `${ctx.organizationName} · As at ${dateLabel(report.asOf)} · ${ctx.baseCurrency}`,
    columns: [
      { key: 'party', label: report.kind === 'AR' ? 'Customer' : 'Vendor', align: 'left', widthChars: 30 },
      { key: 'current', label: 'Current', align: 'right', widthChars: 14 },
      { key: 'd1', label: '1–30 days', align: 'right', widthChars: 14 },
      { key: 'd31', label: '31–60 days', align: 'right', widthChars: 14 },
      { key: 'd61', label: '61–90 days', align: 'right', widthChars: 14 },
      { key: 'd90', label: '90+ days', align: 'right', widthChars: 14 },
      { key: 'total', label: 'Total', align: 'right', widthChars: 14 },
    ],
    rows,
    footnotes,
    filenameStem: `aged-${report.kind === 'AR' ? 'receivables' : 'payables'}-${report.asOf}`,
  };
}

const EMPTY: ReportCell = { kind: 'empty' };

const ACCOUNT_TRANSACTION_COLUMN_SPECS: Record<AccountTransactionColumn, ReportColumn> = {
  date: { key: 'date', label: 'Date', align: 'left', widthChars: 11 },
  source: { key: 'source', label: 'Source', align: 'left', widthChars: 16 },
  reference: { key: 'reference', label: 'Reference', align: 'left', widthChars: 14 },
  contact: { key: 'contact', label: 'Contact', align: 'left', widthChars: 22 },
  description: { key: 'description', label: 'Description', align: 'left', widthChars: 34 },
  account: { key: 'account', label: 'Account', align: 'left', widthChars: 26 },
  debit: { key: 'debit', label: 'Debit', align: 'right', widthChars: 14 },
  credit: { key: 'credit', label: 'Credit', align: 'right', widthChars: 14 },
  net: { key: 'net', label: 'Net', align: 'right', widthChars: 14 },
  runningBalance: { key: 'runningBalance', label: 'Balance', align: 'right', widthChars: 16 },
  currency: { key: 'currency', label: 'Currency', align: 'left', widthChars: 8 },
  nativeAmount: { key: 'nativeAmount', label: 'Amount (native)', align: 'right', widthChars: 16 },
  fxRate: { key: 'fxRate', label: 'FX rate', align: 'right', widthChars: 12 },
  createdBy: { key: 'createdBy', label: 'Created by', align: 'left', widthChars: 18 },
};

function accountTransactionCell(column: AccountTransactionColumn, line: AccountTransactionLine): ReportCell {
  switch (column) {
    case 'date':
      return { kind: 'date', iso: line.entryDate };
    case 'source':
      return text(line.sourceLabel);
    case 'reference':
      return text(line.reference ?? '');
    case 'contact':
      return text(line.contactName ?? '');
    case 'description':
      return text(line.description ?? '');
    case 'account':
      return text(`${line.accountCode} ${line.accountName}`);
    case 'debit':
      return line.debitCents === 0 ? EMPTY : money(line.debitCents);
    case 'credit':
      return line.creditCents === 0 ? EMPTY : money(line.creditCents);
    case 'net':
      return money(line.netCents);
    case 'runningBalance':
      return line.runningBalanceCents === null ? EMPTY : money(line.runningBalanceCents);
    case 'currency':
      return text(line.currencyCode);
    case 'nativeAmount':
      return money(line.nativeDebitCents - line.nativeCreditCents);
    case 'fxRate':
      return text(line.fxRate);
    case 'createdBy':
      return text(line.createdByName ?? '');
  }
}

/** Keeps only the selected columns' cells; a missing key renders as empty. */
function cellsOf(
  selected: readonly AccountTransactionColumn[],
  values: Partial<Record<AccountTransactionColumn, ReportCell>>,
): Record<string, ReportCell> {
  const cells: Record<string, ReportCell> = {};
  for (const column of selected) {
    const cell = values[column];
    if (cell !== undefined) cells[column] = cell;
  }
  return cells;
}

/**
 * Phase 45 — account transactions. The selected columns, in the constant
 * ACCOUNT_TRANSACTION_COLUMNS order, regardless of the order requested.
 */
export function accountTransactionsTable(
  ctx: ReportContext,
  report: AccountTransactionsReport,
  columns: readonly AccountTransactionColumn[],
): ReportTable {
  const selected = ACCOUNT_TRANSACTION_COLUMNS.filter((column) => columns.includes(column));
  const first = selected[0];
  if (first === undefined) throw new Error('accountTransactionsTable needs at least one column');
  const specs = selected.map((column) => ACCOUNT_TRANSACTION_COLUMN_SPECS[column]);

  const rows: ReportRow[] = [];
  for (const group of report.groups) {
    if (report.mode === 'summary') {
      rows.push({
        style: 'detail',
        indent: 0,
        cells: cellsOf(selected, {
          [first]: text(group.label),
          debit: money(group.debitCents),
          credit: money(group.creditCents),
          net: money(group.netCents),
          runningBalance: group.closingBalanceCents === null ? EMPTY : money(group.closingBalanceCents),
        }),
      });
      continue;
    }

    rows.push({ style: 'heading', indent: 0, cells: cellsOf(selected, { [first]: text(group.label) }) });
    if (group.openingBalanceCents !== null) {
      rows.push({
        style: 'detail',
        indent: 1,
        cells: cellsOf(selected, {
          [first]: text('Opening balance'),
          runningBalance: money(group.openingBalanceCents),
        }),
      });
    }
    for (const line of group.lines) {
      const cells: Record<string, ReportCell> = {};
      for (const column of selected) cells[column] = accountTransactionCell(column, line);
      rows.push({ style: 'detail', indent: 1, cells });
    }
    rows.push({
      style: 'subtotal',
      indent: 0,
      cells: cellsOf(selected, {
        [first]: text(`Total ${group.label}`),
        debit: money(group.debitCents),
        credit: money(group.creditCents),
        net: money(group.netCents),
        runningBalance: group.closingBalanceCents === null ? EMPTY : money(group.closingBalanceCents),
      }),
    });
  }

  rows.push({
    style: 'total',
    indent: 0,
    cells: cellsOf(selected, {
      [first]: text('Total'),
      debit: money(report.totalDebitCents),
      credit: money(report.totalCreditCents),
    }),
  });

  return {
    title: 'Account transactions',
    subtitle: `${ctx.organizationName} · ${dateLabel(report.from)} – ${dateLabel(report.to)} · ${ctx.baseCurrency}`,
    columns: specs,
    rows,
    footnotes: [],
    filenameStem: `account-transactions-${report.from}-${report.to}`,
  };
}

function comparisonColumns(report: ProfitAndLossComparison): ReportColumn[] {
  return [
    { key: 'code', label: 'Code', align: 'left', widthChars: 8 },
    { key: 'account', label: 'Account', align: 'left', widthChars: 34 },
    ...report.periods.map((period, i): ReportColumn => ({
      key: `p${i}`,
      label: period.label,
      align: 'right',
      widthChars: 14,
    })),
    { key: 'varCents', label: 'Change', align: 'right', widthChars: 14 },
    { key: 'varPct', label: 'Change %', align: 'right', widthChars: 10 },
  ];
}

function amountCells(amountsCents: readonly number[], v: Variance): Record<string, ReportCell> {
  const cells: Record<string, ReportCell> = {};
  amountsCents.forEach((cents, i) => {
    cells[`p${i}`] = money(cents);
  });
  cells.varCents = money(v.cents);
  cells.varPct = { kind: 'percent', bp: v.bp };
  return cells;
}

function comparisonDetailRows(section: ComparisonSection): ReportRow[] {
  return section.rows.map((row) => ({
    style: 'detail',
    indent: 1,
    cells: { code: text(row.code), account: text(row.name), ...amountCells(row.amountsCents, row.variance) },
  }));
}

export function profitAndLossComparisonTable(ctx: ReportContext, report: ProfitAndLossComparison): ReportTable {
  const current = report.periods[0];
  if (current === undefined) throw new Error('A comparison always has a current period');
  const labelled = (style: ReportRow['style'], label: string, amounts: readonly number[], v: Variance): ReportRow => ({
    style,
    indent: 0,
    cells: { account: text(label), ...amountCells(amounts, v) },
  });

  const rows: ReportRow[] = [
    { style: 'heading', indent: 0, cells: { account: text('Revenue') } },
    ...comparisonDetailRows(report.revenue),
    labelled('subtotal', 'Total revenue', report.revenue.totalsCents, report.revenue.variance),
    { style: 'heading', indent: 0, cells: { account: text('Cost of sales') } },
    ...comparisonDetailRows(report.costOfSales),
    labelled('subtotal', 'Total cost of sales', report.costOfSales.totalsCents, report.costOfSales.variance),
    labelled('subtotal', 'Gross profit', report.grossProfitCents, report.grossProfitVariance),
    { style: 'heading', indent: 0, cells: { account: text('Operating expenses') } },
    ...comparisonDetailRows(report.operatingExpenses),
    labelled('subtotal', 'Total operating expenses', report.operatingExpenses.totalsCents, report.operatingExpenses.variance),
    labelled('total', 'Net income', report.netIncomeCents, report.netIncomeVariance),
  ];

  return {
    title: 'Profit & loss comparison',
    subtitle: `${ctx.organizationName} · ${current.label} vs ${report.periods.length - 1} prior · ${ctx.baseCurrency}`,
    columns: comparisonColumns(report),
    rows,
    footnotes: [],
    filenameStem: `profit-and-loss-comparison-${current.from}-${current.to}`,
  };
}

/** Phase 45 — GL exception report. The `account` cell is the account name, as in the other adapters. */
export function glExceptionsTable(ctx: ReportContext, report: GlExceptionReport): ReportTable {
  const rows: ReportRow[] = report.exceptions.map((exception) => ({
    style: 'detail',
    indent: 0,
    cells: {
      date: { kind: 'date', iso: exception.entryDate },
      rule: text(GL_EXCEPTION_RULE_LABELS[exception.rule]),
      account: text(exception.accountName ?? ''),
      document: text(exception.documentNumber ?? ''),
      amount: money(exception.amountCents),
      currency: text(exception.currencyCode),
      expected: text(exception.expected),
      actual: text(exception.actual),
      reason: text(exception.reason),
      status: text(exception.review === null ? 'Open' : 'Reviewed'),
    },
  }));

  return {
    title: 'Ledger exceptions',
    subtitle: `${ctx.organizationName} · ${dateLabel(report.from)} – ${dateLabel(report.to)}`,
    columns: [
      { key: 'date', label: 'Date', align: 'left', widthChars: 11 },
      { key: 'rule', label: 'Check', align: 'left', widthChars: 22 },
      { key: 'account', label: 'Account', align: 'left', widthChars: 26 },
      { key: 'document', label: 'Document', align: 'left', widthChars: 14 },
      { key: 'amount', label: 'Amount', align: 'right', widthChars: 14 },
      { key: 'currency', label: 'Currency', align: 'left', widthChars: 8 },
      { key: 'expected', label: 'Expected', align: 'left', widthChars: 30 },
      { key: 'actual', label: 'Actual', align: 'left', widthChars: 24 },
      { key: 'reason', label: 'Reason', align: 'left', widthChars: 40 },
      { key: 'status', label: 'Status', align: 'left', widthChars: 10 },
    ],
    rows,
    footnotes: report.truncated ? ['Results truncated — narrow the date range.'] : [],
    filenameStem: `ledger-exceptions-${report.from}-${report.to}`,
  };
}

/** Phase 45 — output and input tax by rate, with the GL tie-out in the footnotes. */
export function taxSummaryTable(ctx: ReportContext, report: TaxSummary): ReportTable {
  const rateRows = (rows: readonly TaxSummaryRow[]): ReportRow[] =>
    rows.map((row) => ({
      style: 'detail',
      indent: 1,
      cells: {
        label: text(`${row.rateBp / 100}%`),
        net: money(row.netCents),
        tax: money(row.taxCents),
        count: text(String(row.documentCount)),
      },
    }));

  const rows: ReportRow[] = [
    { style: 'heading', indent: 0, cells: { label: text('Output tax (sales)') } },
    ...rateRows(report.output.rows),
    {
      style: 'subtotal',
      indent: 0,
      cells: { label: text('Total output tax'), net: money(report.output.netCents), tax: money(report.output.taxCents) },
    },
    { style: 'heading', indent: 0, cells: { label: text('Input tax (purchases)') } },
    ...rateRows(report.input.rows),
    {
      style: 'subtotal',
      indent: 0,
      cells: { label: text('Total input tax'), net: money(report.input.netCents), tax: money(report.input.taxCents) },
    },
    { style: 'total', indent: 0, cells: { label: text('Net tax payable'), tax: money(report.netTaxPayableCents) } },
  ];

  const checkNote = (direction: 'Output' | 'Input', check: TaxSummaryAccountCheck): string =>
    check.account === null
      ? `No ${direction.toLowerCase()} tax account is configured.`
      : `${direction} tax account ${check.account.code} ${check.account.name}: ${groupedCents(check.glCents)} in the ledger, difference ${groupedCents(check.differenceCents)}.`;

  return {
    title: 'Tax summary',
    subtitle: `${ctx.organizationName} · ${dateLabel(report.from)} – ${dateLabel(report.to)} · ${ctx.baseCurrency}`,
    columns: [
      { key: 'label', label: 'Rate', align: 'left', widthChars: 24 },
      { key: 'net', label: 'Net', align: 'right', widthChars: 16 },
      { key: 'tax', label: 'Tax', align: 'right', widthChars: 16 },
      { key: 'count', label: 'Documents', align: 'right', widthChars: 10 },
    ],
    rows,
    footnotes: [checkNote('Output', report.outputCheck), checkNote('Input', report.inputCheck)],
    filenameStem: `tax-summary-${report.from}-${report.to}`,
  };
}

const SALES_PURCHASES_TITLES: Record<SalesPurchasesReportKind, string> = {
  'sales-by-customer': 'Sales by customer',
  'purchases-by-vendor': 'Purchases by vendor',
  'sales-by-item': 'Sales by item',
  'purchases-by-item': 'Purchases by item',
};

/** Phase 45 — sales or purchases grouped by party or by item, with an optional prior-period column. */
export function salesPurchasesTable(ctx: ReportContext, report: SalesPurchasesReport): ReportTable {
  const isItem = report.kind.endsWith('-by-item');
  const hasComparison = report.comparison !== null;
  const labelHeader = isItem ? 'Item' : report.kind === 'sales-by-customer' ? 'Customer' : 'Vendor';

  const columns: ReportColumn[] = [];
  if (isItem) columns.push({ key: 'code', label: 'Code', align: 'left', widthChars: 10 });
  columns.push({ key: 'label', label: labelHeader, align: 'left', widthChars: 34 });
  if (isItem) columns.push({ key: 'quantity', label: 'Quantity', align: 'right', widthChars: 10 });
  columns.push({ key: 'net', label: 'Net', align: 'right', widthChars: 14 });
  columns.push({ key: 'tax', label: 'Tax', align: 'right', widthChars: 14 });
  columns.push({ key: 'gross', label: 'Gross', align: 'right', widthChars: 14 });
  columns.push({ key: 'count', label: 'Documents', align: 'right', widthChars: 10 });
  if (report.comparison !== null) {
    columns.push({ key: 'prior', label: report.comparison.label, align: 'right', widthChars: 14 });
    columns.push({ key: 'change', label: 'Change', align: 'right', widthChars: 14 });
  }

  const rows: ReportRow[] = report.rows.map((row) => {
    const cells: Record<string, ReportCell> = {
      label: text(row.label),
      net: money(row.netCents),
      tax: money(row.taxCents),
      gross: money(row.grossCents),
      count: text(String(row.documentCount)),
    };
    if (isItem) {
      cells.code = row.code === null ? { kind: 'empty' } : text(row.code);
      cells.quantity = { kind: 'quantity', milli: row.quantityMilli ?? 0 };
    }
    if (hasComparison) {
      const prior = row.comparisonNetCents ?? 0;
      cells.prior = money(prior);
      cells.change = money(row.netCents - prior);
    }
    return { style: 'detail', indent: 0, cells };
  });

  const totalCells: Record<string, ReportCell> = {
    label: text('Total'),
    net: money(report.totalNetCents),
    tax: money(report.totalTaxCents),
    gross: money(report.totalGrossCents),
  };
  if (report.comparison !== null) {
    const priorTotal = report.totalComparisonNetCents ?? 0;
    totalCells.prior = money(priorTotal);
    totalCells.change = money(report.totalNetCents - priorTotal);
  }
  rows.push({ style: 'total', indent: 0, cells: totalCells });

  return {
    title: SALES_PURCHASES_TITLES[report.kind],
    subtitle: `${ctx.organizationName} · ${dateLabel(report.from)} – ${dateLabel(report.to)} · ${ctx.baseCurrency}`,
    columns,
    rows,
    footnotes: isItem
      ? [
          'Item totals are allocated per line and can differ from the ledger by rounding cents. Credit and debit notes carry no item and appear under No item.',
        ]
      : [],
    filenameStem: `${report.kind}-${report.from}-${report.to}`,
  };
}

/** Phase 45 — cash flow statement, indirect method. Rows are OPERATING / INVESTING / FINANCING. */
export function cashFlowTable(ctx: ReportContext, report: CashFlowStatement): ReportTable {
  const cashRows = (section: CashFlowStatement['operating']): ReportRow[] =>
    section.rows.map((row) => ({
      style: 'detail',
      indent: 1,
      cells: { code: text(row.code), account: text(row.name), amount: money(row.amountCents) },
    }));

  const rows: ReportRow[] = [
    { style: 'heading', indent: 0, cells: { account: text('Operating activities') } },
    { style: 'detail', indent: 1, cells: { account: text('Net income'), amount: money(report.netIncomeCents) } },
    ...cashRows(report.operating),
    {
      style: 'subtotal',
      indent: 0,
      cells: { account: text('Net cash from operating activities'), amount: money(report.operating.totalCents) },
    },
    { style: 'heading', indent: 0, cells: { account: text('Investing activities') } },
    ...cashRows(report.investing),
    {
      style: 'subtotal',
      indent: 0,
      cells: { account: text('Net cash from investing activities'), amount: money(report.investing.totalCents) },
    },
    { style: 'heading', indent: 0, cells: { account: text('Financing activities') } },
    ...cashRows(report.financing),
    {
      style: 'subtotal',
      indent: 0,
      cells: { account: text('Net cash from financing activities'), amount: money(report.financing.totalCents) },
    },
    { style: 'total', indent: 0, cells: { account: text('Net change in cash'), amount: money(report.netChangeCents) } },
    // Indent not specified by the plan for these two rows; 0 chosen (see NOTES).
    { style: 'detail', indent: 0, cells: { account: text('Cash at beginning of period'), amount: money(report.openingCashCents) } },
    { style: 'detail', indent: 0, cells: { account: text('Cash at end of period'), amount: money(report.closingCashCents) } },
  ];

  return {
    title: 'Cash flow statement',
    subtitle: `${ctx.organizationName} · ${dateLabel(report.from)} – ${dateLabel(report.to)} · ${ctx.baseCurrency}`,
    columns: amountColumns(),
    rows,
    footnotes: ['Indirect method. Override an account’s category in Chart of accounts.'],
    filenameStem: `cash-flow-${report.from}-${report.to}`,
  };
}
