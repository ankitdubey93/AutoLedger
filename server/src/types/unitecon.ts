/**
 * UnitEcon (Phase 14) — cohort retention, LTV/CAC unit economics, and
 * Price-Volume-Mix variance. See docs/unitecon.md.
 *
 * UnitEcon reads LedgerCore only through reportService's bridge functions
 * (customerRevenueByMonth, productLineSalesByMonth, monthlyActualsByAccount)
 * and accountService.getAccountById/organizationService.getById — never a
 * direct query against invoices, invoice_lines, customers or accounts
 * (guardrails rule 16).
 */

/* --------------------------------------------------------------- cohorts */

/** One customer's net revenue in one calendar month, base currency,
 *  tax-exclusive. The cohort engine's only input. */
export interface CustomerRevenueFact {
  customerId: string;
  customerName: string;
  month: string; // 'YYYY-MM-01'
  netRevenueCents: number;
}

export interface CohortCell {
  /** Months since the cohort month. 0 is the acquisition month itself. */
  offset: number;
  month: string; // 'YYYY-MM-01' — cohortMonth + offset
  activeCustomers: number;
  netRevenueCents: number;
  /** activeCustomers / cohortSize in basis points. Always 10000 at offset 0. */
  retentionBps: number;
}

export interface CohortRow {
  cohortMonth: string; // 'YYYY-MM-01'
  cohortSize: number;
  /** Cohort member ids, ascending. */
  customerIds: string[];
  /** Offsets 0..(last window month - cohort month). Triangular: each row is
   *  one cell shorter than the row above it. */
  cells: CohortCell[];
}

export interface CohortMatrix {
  months: string[]; // the display window, ascending
  rows: CohortRow[]; // one per month that acquired at least one customer
  totalNewCustomers: number;
  /** Customers whose first revenue month precedes the window. Excluded from
   *  every row, reported so the number is never silently missing. */
  excludedPriorCustomers: number;
}

/* --------------------------------------------------------- unit economics */

export interface UniteconSettings {
  grossMarginBps: number;
  /** Accounts whose net monthly activity counts as customer-acquisition
   *  spend. Empty means CAC cannot be computed and is reported as null. */
  acquisitionAccountIds: string[];
  updatedAt: string | null; // null when no row has been written yet
}

export interface UnitEconomicsRow {
  cohortMonth: string; // 'YYYY-MM-01'
  newCustomers: number;
  /** Net debit activity on the configured acquisition accounts in this month. */
  acquisitionSpendCents: number;
  /** acquisitionSpendCents / newCustomers. null when newCustomers is 0. */
  cacCents: number | null;
  /** Every cell of this cohort's row, summed — observed, never extrapolated. */
  cumulativeRevenueCents: number;
  /** cumulativeRevenueCents × grossMarginBps / 10000. */
  cumulativeGrossMarginCents: number;
  /** cumulativeGrossMarginCents / newCustomers. null when newCustomers is 0. */
  ltvCents: number | null;
  /** ltvCents / cacCents in basis points. null when either is null or
   *  cacCents <= 0. */
  ltvToCacBps: number | null;
  /** The smallest offset at which cumulative gross margin per customer
   *  reaches cacCents. null when never reached inside the window. */
  paybackMonths: number | null;
  /** How many months of this cohort the window actually observed. */
  observedMonths: number;
}

export interface UnitEconomicsReport {
  baseCurrency: string;
  from: string;
  to: string;
  grossMarginBps: number;
  acquisitionAccountIds: string[];
  rows: UnitEconomicsRow[];
  /** Sum of every row's newCustomers and acquisitionSpendCents, and the
   *  blended CAC across the whole window. */
  totalNewCustomers: number;
  totalAcquisitionSpendCents: number;
  blendedCacCents: number | null;
}

/* --------------------------------------------------------------------- PVM */

export interface UniteconProductLine {
  id: string;
  revenueAccountId: string;
  revenueAccountCode: string;
  revenueAccountName: string;
  name: string;
  unitLabel: string;
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One product line's sales in one period. The PVM engine's only input. */
export interface ProductLineSalesFact {
  productLineId: string;
  productLineName: string;
  unitLabel: string;
  quantityMilli: number; // thousandths of a unit, >= 0
  netRevenueCents: number; // base currency, tax-exclusive, >= 0
}

export interface PvmRow {
  productLineId: string;
  productLineName: string;
  unitLabel: string;
  baseQuantityMilli: number;
  compareQuantityMilli: number;
  baseNetCents: number;
  compareNetCents: number;
  /** Per whole unit. 0 when the period sold nothing. Display only — the
   *  variance components are never computed from these rounded figures. */
  baseUnitPriceCents: number;
  compareUnitPriceCents: number;
  priceVarianceCents: number;
  volumeVarianceCents: number;
  /** Carries the rounding residual so the three components always sum to
   *  totalVarianceCents exactly (decision D14). */
  mixVarianceCents: number;
  totalVarianceCents: number;
}

export interface PvmTotals {
  baseNetCents: number;
  compareNetCents: number;
  priceVarianceCents: number;
  volumeVarianceCents: number;
  mixVarianceCents: number;
  totalVarianceCents: number;
}

export interface PvmReport {
  rows: PvmRow[];
  totals: PvmTotals;
}
