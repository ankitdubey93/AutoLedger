/**
 * LedgerCore's domain types — the general ledger.
 *
 * App-scoped, so this file is `types/ledger-core.ts` rather than sitting at the
 * layer root beside `auth.ts` and `apps.ts`, which are platform types
 * (docs/architecture.md#repository-layout).
 *
 * Every money field is `*Cents: number` — integer minor units, never a float
 * and never a `DECIMAL` (guardrails rule 3). Conversion and arithmetic live in
 * `utils/money.ts`.
 */

/**
 * Exactly five, forever — guardrails rule 12. Cost of Goods Sold is not a sixth
 * type; COGS accounts are `Expense`, separated from operating expenses by the
 * 5xxx code range and by their parent, which is how the P&L derives gross
 * profit (docs/schema.md#default-chart-of-accounts).
 *
 * `as const` keeps each entry a string literal so `AccountType` is a real union
 * rather than `string`, and the same array feeds zod's `z.enum` — one source of
 * truth for the type and the runtime check. Same pattern as `ROLES` in
 * `types/auth.ts`.
 */
export const ACCOUNT_TYPES = ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Narrows a string from the database to a known account type. */
export function isAccountType(value: string): value is AccountType {
  return (ACCOUNT_TYPES as readonly string[]).includes(value);
}

/**
 * The five types split into the two halves of the accounting equation, which is
 * what makes a trial balance's `netBalanceCents` type-aware: an Asset or Expense
 * carries a debit balance, everything else carries a credit balance.
 */
export const DEBIT_BALANCE_TYPES = ['Asset', 'Expense'] as const satisfies readonly AccountType[];

export function isDebitBalanceType(type: AccountType): boolean {
  return (DEBIT_BALANCE_TYPES as readonly AccountType[]).includes(type);
}

export interface Account {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  /** Self-referencing: the chart is a tree. `null` for a root account. */
  parentId: string | null;
  /** `false` for a header account like `1000 Assets`, which is a reporting rollup. */
  isPostable: boolean;
  isActive: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

/** An `Account` with its subtree attached, for `GET /accounts?tree=true`. */
export interface AccountNode extends Account {
  children: AccountNode[];
}

export interface LedgerLine {
  id: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  debitCents: number;
  creditCents: number;
  /** The line's own currency. Equal to the organization's base currency until Phase 8. */
  currencyCode: string;
  /**
   * Deliberately a `string`. `pg` returns `NUMERIC` as a string, and converting
   * an exchange rate to a float here would be the precision loss this codebase
   * exists to avoid — the same reasoning as `BIGINT` cents, one column over.
   */
  fxRate: string;
  baseDebitCents: number;
  baseCreditCents: number;
}

export interface JournalEntry {
  id: string;
  entryDate: string;
  description: string | null;
  /** `'manual'` for a client-posted entry; another app's slug when it posts into the GL. */
  sourceType: string;
  sourceId: string | null;
  /** Set on a reversing entry, pointing at the entry it reverses. */
  reversesEntryId: string | null;
  /** Set on an original entry once a reversal has been posted against it. The
   *  inverse of `reversesEntryId`; `null` while the entry stands uncorrected. */
  reversedByEntryId: string | null;
  createdBy: string;
  /** Denormalised for display only. `null` if the user row is gone — the
   *  `created_by` FK is ON DELETE RESTRICT, so in practice it never is. */
  createdByName: string | null;
  createdByEmail: string | null;
  createdAt: string;
  /** Summed in TypeScript from `lines`, in integer cents. Equal by the
   *  invariant — both are exposed so the register can show one and the
   *  detail page can prove the pair. */
  totalDebitCents: number;
  totalCreditCents: number;
  lines: LedgerLine[];
}

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  debitCents: number;
  creditCents: number;
  /** Type-aware: debit-positive for Asset and Expense, credit-positive otherwise. */
  netBalanceCents: number;
}

export interface TrialBalance {
  asOf: string | null;
  rows: TrialBalanceRow[];
  totalDebitCents: number;
  totalCreditCents: number;
  /** Integer equality. An epsilon here would be guardrails rule 3 violated. */
  isBalanced: boolean;
}

/* ------------------------------------------------- Phase 3.6 — account ledger */

export interface AccountLedgerRow {
  lineId: string;
  entryId: string;
  entryDate: string;
  description: string | null;
  sourceType: string;
  sourceId: string | null;
  reversesEntryId: string | null;
  createdAt: string;
  /** Raw and non-negative, as stored. Exactly one of the two is > 0. */
  debitCents: number;
  creditCents: number;
  /** Type-aware, cumulative, including `openingBalanceCents`. */
  runningBalanceCents: number;
  /** The other accounts on the same entry — the "split", as `"6120 Software & IT Infrastructure"`. */
  counterparts: string[];
}

export interface AccountLedger {
  account: {
    id: string;
    code: string;
    name: string;
    type: AccountType;
  };
  from: string | null;
  to: string | null;
  /** Balance strictly before `from`. `0` when `from` is null. Type-aware. */
  openingBalanceCents: number;
  /** Raw sums over the rows in the window. */
  periodDebitCents: number;
  periodCreditCents: number;
  /** opening ± the period movement, type-aware. Integer arithmetic only. */
  closingBalanceCents: number;
  rows: AccountLedgerRow[];
  totalCount: number;
}

export interface AccountBalance {
  accountId: string;
  /** This account's own postings only. Type-aware. `0` for a header account. */
  ownBalanceCents: number;
  /** This account plus its whole subtree. Equal to `ownBalanceCents` for a leaf. Type-aware. */
  rollupBalanceCents: number;
}

/* ---------------------------------------------------------- Phase 3.5 — settings */

export interface FiscalYearWindow {
  startDate: string;
  endDate: string;
  label: string;
}

/**
 * LedgerCore's onboarding and settings. `organizationName` and `baseCurrency`
 * are read from `organizations` (a platform table) and folded in here for
 * display, but they are only ever written through
 * `organizationService.updateOrganization` — never through this table.
 */
export interface LedgerSettings {
  organizationName: string;
  legalName: string | null;
  baseCurrency: string;
  fiscalYearStartMonth: number;
  fiscalYearStartDay: number;
  booksStartDate: string;
  industry: string | null;
  timezone: string;
  cashAccountId: string | null;
  /** `null` when the wizard has never been completed for this organization. */
  onboardedAt: string | null;
  currentFiscalYear: FiscalYearWindow;
  /** `true` once any ledger line exists — base currency can no longer change. */
  baseCurrencyLocked: boolean;
  /**
   * Integer cents (rule 3). 0 means disabled — no bank.large_unmatched
   * webhook event fires (Phase 7).
   */
  unmatchedAlertThresholdCents: number;
  /** Phase 8. `null` falls back to chart codes 4910/6810/6820 in the service. */
  realizedFxGainAccountId: string | null;
  realizedFxLossAccountId: string | null;
  unrealizedFxAccountId: string | null;
}

/* ---------------------------------------------------------- Phase 3.5 — dashboard */

export interface TrendPoint {
  month: string; // 'YYYY-MM'
  revenueCents: number;
  expenseCents: number;
}

/* ---------------------------------------------------------- Phase 3.8 — invoicing */

export interface Customer {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  billingAddress: string | null;
  taxNumber: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export const INVOICE_STATUSES = ['DRAFT', 'ISSUED', 'VOID'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export function isInvoiceStatus(value: string): value is InvoiceStatus {
  return (INVOICE_STATUSES as readonly string[]).includes(value);
}

/**
 * The one lifecycle transition table (guardrails rule 10). The `status` CHECK
 * in migration 009 lists exactly these three values and nothing else — if a
 * status is ever added, both change in the same migration.
 */
export const INVOICE_TRANSITIONS = {
  DRAFT: ['ISSUED', 'VOID'],
  ISSUED: ['VOID'],
  VOID: [],
} as const satisfies Record<InvoiceStatus, readonly InvoiceStatus[]>;

export function canTransitionInvoice(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return (INVOICE_TRANSITIONS[from] as readonly InvoiceStatus[]).includes(to);
}

export interface InvoiceLine {
  id: string;
  lineNumber: number;
  description: string;
  /** Thousandths of a unit — 2500 means 2.5. Never a float. */
  quantityMilli: number;
  unitPriceCents: number;
  revenueAccountId: string;
  revenueAccountCode: string;
  revenueAccountName: string;
  /** Basis points — 1850 means 18.5%. */
  taxRateBp: number;
  netCents: number;
  taxCents: number;
}

export interface Invoice {
  id: string;
  /** `null` while DRAFT — the number is allocated at issue. */
  invoiceNumber: string | null;
  status: InvoiceStatus;
  customerId: string;
  customerName: string;
  issueDate: string;
  dueDate: string;
  currencyCode: string;
  customerNameSnapshot: string;
  customerAddressSnapshot: string | null;
  customerTaxNumberSnapshot: string | null;
  notes: string | null;
  paymentTerms: string | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  /** Phase 8. NUMERIC(18,8) as a string. '1.00000000' for a base-currency invoice. */
  fxRate: string;
  baseSubtotalCents: number;
  baseTaxCents: number;
  baseTotalCents: number;
  journalEntryId: string | null;
  voidJournalEntryId: string | null;
  issuedAt: string | null;
  voidedAt: string | null;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  lines: InvoiceLine[];
  /** Derived from POSTED payment allocations — see settlementStatusOf. `0` unless status is ISSUED. */
  allocatedCents: number;
  amountDueCents: number;
  settlementStatus: SettlementStatus;
}

export interface InvoiceSettings {
  numberPrefix: string;
  numberPadding: number;
  nextNumber: number;
  defaultDueDays: number;
  defaultTaxRateBp: number;
  taxLabel: string;
  receivableAccountId: string | null;
  defaultRevenueAccountId: string | null;
  taxPayableAccountId: string | null;
  showTaxNumber: boolean;
  showBusinessNumber: boolean;
  showLegalName: boolean;
  billingAddress: string | null;
  paymentTerms: string | null;
  footerNotes: string | null;
  accentColor: string;
  /** `false` until the organization has saved invoice settings at least once. */
  configured: boolean;
}

/* --------------------------------------------------- Phase 3.9 — accounts payable */

export interface Vendor {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  billingAddress: string | null;
  taxNumber: string | null;
  paymentTerms: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export const BILL_STATUSES = ['DRAFT', 'AWAITING_APPROVAL', 'POSTED', 'VOID'] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

export function isBillStatus(value: string): value is BillStatus {
  return (BILL_STATUSES as readonly string[]).includes(value);
}

/**
 * The one lifecycle transition table (guardrails rule 10). The `status` CHECK
 * in migration 013 lists exactly these four values and nothing else — if a
 * status is ever added, both change in the same migration.
 *
 * `AWAITING_APPROVAL -> DRAFT` is the recall edge: a reviewer sends a bill
 * back for correction. It is deliberate, not an oversight.
 */
export const BILL_TRANSITIONS = {
  DRAFT: ['AWAITING_APPROVAL', 'POSTED', 'VOID'],
  AWAITING_APPROVAL: ['DRAFT', 'POSTED', 'VOID'],
  POSTED: ['VOID'],
  VOID: [],
} as const satisfies Record<BillStatus, readonly BillStatus[]>;

export function canTransitionBill(from: BillStatus, to: BillStatus): boolean {
  return (BILL_TRANSITIONS[from] as readonly BillStatus[]).includes(to);
}

export interface BillLine {
  id: string;
  lineNumber: number;
  description: string;
  /** Thousandths of a unit — 2500 means 2.5. Never a float. */
  quantityMilli: number;
  unitPriceCents: number;
  expenseAccountId: string;
  expenseAccountCode: string;
  expenseAccountName: string;
  /** Basis points — 1850 means 18.5%. */
  taxRateBp: number;
  netCents: number;
  taxCents: number;
}

export interface Bill {
  id: string;
  /** The vendor's own invoice number — required from creation, unlike an invoice's number. */
  vendorReference: string;
  status: BillStatus;
  vendorId: string;
  vendorName: string;
  billDate: string;
  dueDate: string;
  currencyCode: string;
  vendorNameSnapshot: string;
  vendorAddressSnapshot: string | null;
  vendorTaxNumberSnapshot: string | null;
  notes: string | null;
  paymentTerms: string | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  /** Phase 8. NUMERIC(18,8) as a string. '1.00000000' for a base-currency bill. */
  fxRate: string;
  baseSubtotalCents: number;
  baseTaxCents: number;
  baseTotalCents: number;
  journalEntryId: string | null;
  voidJournalEntryId: string | null;
  submittedAt: string | null;
  postedAt: string | null;
  voidedAt: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  lines: BillLine[];
  /** Derived from POSTED payment allocations — see settlementStatusOf. `0` unless status is POSTED. */
  allocatedCents: number;
  amountDueCents: number;
  settlementStatus: SettlementStatus;
}

export const PAYMENT_DIRECTIONS = ['RECEIVE', 'PAY'] as const;
export type PaymentDirection = (typeof PAYMENT_DIRECTIONS)[number];

export function isPaymentDirection(value: string): value is PaymentDirection {
  return (PAYMENT_DIRECTIONS as readonly string[]).includes(value);
}

export const PAYMENT_STATUSES = ['POSTED', 'VOID'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export function isPaymentStatus(value: string): value is PaymentStatus {
  return (PAYMENT_STATUSES as readonly string[]).includes(value);
}

/** The one lifecycle transition table (guardrails rule 10). A payment is born POSTED — there is no draft. */
export const PAYMENT_TRANSITIONS = {
  POSTED: ['VOID'],
  VOID: [],
} as const satisfies Record<PaymentStatus, readonly PaymentStatus[]>;

export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  return (PAYMENT_TRANSITIONS[from] as readonly PaymentStatus[]).includes(to);
}

export interface PaymentAllocation {
  id: string;
  invoiceId: string | null;
  billId: string | null;
  /** The document's own reference — invoice number or vendor reference. */
  documentReference: string;
  documentTotalCents: number;
  amountCents: number;
  /** Phase 8. amountCents converted to base currency at the document's own frozen rate. */
  baseAmountCents: number;
}

export interface Payment {
  id: string;
  direction: PaymentDirection;
  status: PaymentStatus;
  paymentDate: string;
  currencyCode: string;
  amountCents: number;
  /** Phase 8. NUMERIC(18,8) as a string. '1.00000000' for a base-currency payment. */
  fxRate: string;
  baseAmountCents: number;
  cashAccountId: string;
  cashAccountCode: string;
  cashAccountName: string;
  customerId: string | null;
  vendorId: string | null;
  counterpartyName: string;
  method: string | null;
  reference: string | null;
  notes: string | null;
  journalEntryId: string;
  voidJournalEntryId: string | null;
  voidedAt: string | null;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  allocations: PaymentAllocation[];
}

/**
 * DERIVED, never stored. There is no settlement column on `invoices` or
 * `bills` — this is computed from `payment_allocations` on every read, for
 * the same reason `reportService` and `dashboardService` have no summary
 * table: a cached balance is a second source of truth that drifts from the
 * rows that determine it. See study/architecture/derived-vs-stored-state.md.
 */
export const SETTLEMENT_STATUSES = ['NOT_APPLICABLE', 'UNPAID', 'PARTIALLY_PAID', 'PAID', 'OVERDUE'] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

/**
 * Precedence, in this exact order — OVERDUE deliberately outranks
 * PARTIALLY_PAID, because a part-paid invoice past its due date is still a
 * collection problem:
 *   not open           -> NOT_APPLICABLE
 *   allocated >= total -> PAID
 *   dueDate < asOf     -> OVERDUE
 *   allocated > 0      -> PARTIALLY_PAID
 *   otherwise          -> UNPAID
 */
export function settlementStatusOf(args: {
  isOpen: boolean;
  totalCents: number;
  allocatedCents: number;
  dueDate: string;
  asOf: string;
}): SettlementStatus {
  if (!args.isOpen) return 'NOT_APPLICABLE';
  if (args.allocatedCents >= args.totalCents) return 'PAID';
  if (args.dueDate < args.asOf) return 'OVERDUE';
  if (args.allocatedCents > 0) return 'PARTIALLY_PAID';
  return 'UNPAID';
}

export const AGING_BUCKETS = ['CURRENT', 'D1_30', 'D31_60', 'D61_90', 'D90_PLUS'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export const AGING_BUCKET_LABELS = {
  CURRENT: 'Current',
  D1_30: '1–30 days',
  D31_60: '31–60 days',
  D61_90: '61–90 days',
  D90_PLUS: '90+ days',
} as const satisfies Record<AgingBucket, string>;

export interface AgingBucketAmount {
  bucket: AgingBucket;
  label: string;
  amountCents: number;
  documentCount: number;
}

export interface AgingCounterpartyRow {
  counterpartyId: string;
  counterpartyName: string;
  currentCents: number;
  d1to30Cents: number;
  d31to60Cents: number;
  d61to90Cents: number;
  d90PlusCents: number;
  totalCents: number;
}

export interface AgingReport {
  asOf: string;
  kind: 'AR' | 'AP';
  /** Exactly 5 entries, in AGING_BUCKETS order — an empty bucket is a zero, never absent. */
  buckets: AgingBucketAmount[];
  totalOutstandingCents: number;
  totalOverdueCents: number;
  /** `null` when no control account is configured and the fallback code is absent. */
  controlAccount: { id: string; code: string; name: string; balanceCents: number } | null;
  /**
   * The subledger total equals the control account's GL balance. Integer
   * equality — never a tolerance. `null` when there is no control account.
   */
  reconciles: boolean | null;
  rows: AgingCounterpartyRow[];
}

export interface DashboardSummary {
  asOf: string;
  fiscalYear: FiscalYearWindow;
  position: {
    assetsCents: number;
    liabilitiesCents: number;
    equityCents: number;
    /**
     * Revenue − Expenses over all time. Assets = Liabilities + Equity only
     * holds once this is folded in — `equityCents` alone is not the whole
     * right-hand side. This is not the Phase 4 balance sheet; it is the
     * minimum needed to keep this tile honest.
     */
    currentEarningsCents: number;
    /** `null` when no cash account is configured in settings. */
    cashCents: number | null;
    /** assets === liabilities + equity + currentEarnings. Integer equality. */
    equationHolds: boolean;
  };
  performance: {
    yearToDate: { revenueCents: number; expenseCents: number; netIncomeCents: number };
    currentMonth: { revenueCents: number; expenseCents: number; netIncomeCents: number };
  };
  activity: { entryCountYtd: number; recentEntries: JournalEntry[] };
  integrity: { totalDebitCents: number; totalCreditCents: number; isBalanced: boolean };
  /** Exactly 6 points, oldest first — a month with no postings still appears, at zero. */
  trend: TrendPoint[];
  receivables: {
    outstandingCents: number;
    overdueCents: number;
    /** Invoices still in DRAFT — entered, not yet issued, owed to nobody yet. */
    draftCount: number;
    draftCents: number;
    /** Exactly 5, in AGING_BUCKETS order. */
    buckets: AgingBucketAmount[];
  };
  payables: {
    outstandingCents: number;
    overdueCents: number;
    draftCount: number;
    draftCents: number;
    /** Bills in AWAITING_APPROVAL — the "Bills to review" queue (plan D1: not an expense-claim inbox). */
    awaitingReviewCount: number;
    awaitingReviewCents: number;
    buckets: AgingBucketAmount[];
  };
}

// ---------------------------------------------------------------- fiscal periods

export const FISCAL_PERIOD_STATUSES = ['OPEN', 'CLOSED', 'LOCKED'] as const;
export type FiscalPeriodStatus = (typeof FISCAL_PERIOD_STATUSES)[number];

/**
 * The one place a period's lifecycle is written down (guardrails rule 10).
 *
 * CLOSED is reversible — a month closed too early is reopened, and that is
 * a normal bookkeeping event. LOCKED is terminal and has no outbound edge:
 * it is the statement "these books are final", and a lock that can be
 * lifted is not that statement. Correcting a locked period is impossible by
 * construction; the correction belongs in a later open period as a
 * reversing entry, which is what an auditor expects to see.
 */
export const FISCAL_PERIOD_TRANSITIONS = {
  OPEN: ['CLOSED'],
  CLOSED: ['OPEN', 'LOCKED'],
  LOCKED: [],
} as const satisfies Record<FiscalPeriodStatus, readonly FiscalPeriodStatus[]>;

export function canTransitionFiscalPeriod(from: FiscalPeriodStatus, to: FiscalPeriodStatus): boolean {
  return (FISCAL_PERIOD_TRANSITIONS[from] as readonly FiscalPeriodStatus[]).includes(to);
}

export interface FiscalPeriod {
  id: string;
  fiscalYearLabel: string;
  periodNumber: number;
  startsOn: string; // 'YYYY-MM-DD'
  endsOn: string; // 'YYYY-MM-DD'
  status: FiscalPeriodStatus;
  closedBy: string | null;
  closedByName: string | null;
  closedAt: string | null; // ISO timestamp
  lockedBy: string | null;
  lockedByName: string | null;
  lockedAt: string | null; // ISO timestamp
  /** Journal entries whose entry_date falls inside this period. */
  entryCount: number;
  createdAt: string;
}

// -------------------------------------------------- Phase 4 — live statements

/** One postable account's contribution to a statement, as a positive
 *  figure in that account's normal direction. */
export interface StatementRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  amountCents: number;
}

export interface StatementSection {
  rows: StatementRow[];
  totalCents: number;
}

export interface ProfitAndLoss {
  from: string; // 'YYYY-MM-DD'
  to: string; // 'YYYY-MM-DD'
  revenue: StatementSection;
  costOfSales: StatementSection;
  grossProfitCents: number;
  operatingExpenses: StatementSection;
  netIncomeCents: number;
}

export interface BalanceSheetEquity extends StatementSection {
  /**
   * Net income from every entry dated before the current fiscal year's
   * start — DERIVED on every read, never stored. LedgerCore posts no
   * year-end closing entry, so there is no journal that moves prior-year
   * profit into account 3200; the balance sheet computes it instead.
   */
  retainedEarningsCents: number;
  /** Net income for the current fiscal year up to `asOf`. Equals the P&L's
   *  netIncomeCents over [fiscalYearStart, asOf]. */
  currentEarningsCents: number;
}

export interface BalanceSheet {
  asOf: string; // 'YYYY-MM-DD'
  fiscalYearStartDate: string; // 'YYYY-MM-DD' — the retained/current split point
  assets: StatementSection;
  liabilities: StatementSection;
  /** totalCents here includes retainedEarningsCents and currentEarningsCents
   *  on top of the posted equity account rows — a consumer must not add
   *  either again on top of totalCents. */
  equity: BalanceSheetEquity;
  totalLiabilitiesAndEquityCents: number;
  /** Integer equality, never an epsilon (guardrails rule 3). */
  balances: boolean;
}

// ---------------------------------------------- Phase 6 — bank reconciliation

export const BANK_TRANSACTION_STATUSES = ['UNMATCHED', 'MATCHED', 'IGNORED'] as const;
export type BankTransactionStatus = (typeof BANK_TRANSACTION_STATUSES)[number];

export function isBankTransactionStatus(value: string): value is BankTransactionStatus {
  return (BANK_TRANSACTION_STATUSES as readonly string[]).includes(value);
}

/**
 * The one lifecycle transition table for a bank line (guardrails rule 10).
 * Unlike VOID on an invoice or LOCKED on a period, MATCHED is NOT terminal —
 * it is reversible, and the reverse edge has a GL side effect: unmatching
 * voids the payment the match posted.
 */
export const BANK_TRANSACTION_TRANSITIONS = {
  UNMATCHED: ['MATCHED', 'IGNORED'],
  MATCHED: ['UNMATCHED'],
  IGNORED: ['UNMATCHED'],
} as const satisfies Record<BankTransactionStatus, readonly BankTransactionStatus[]>;

export function canTransitionBankTransaction(
  from: BankTransactionStatus,
  to: BankTransactionStatus,
): boolean {
  return (BANK_TRANSACTION_TRANSITIONS[from] as readonly BankTransactionStatus[]).includes(to);
}

export interface BankStatementImport {
  id: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  fileName: string;
  dateFormat: string;
  delimiter: string;
  rowCount: number;
  importedCount: number;
  duplicateCount: number;
  earliestDate: string | null;
  latestDate: string | null;
  closingBalanceCents: number | null;
  closingBalanceOn: string | null;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
}

export interface BankMatchSuggestion {
  id: string;
  targetType: 'invoice' | 'bill';
  invoiceId: string | null;
  billId: string | null;
  /** invoice_number or vendor_reference. */
  documentReference: string;
  documentDate: string;
  counterpartyName: string;
  documentTotalCents: number;
  documentAmountDueCents: number;
  score: number;
  /** Shape mirrors utils/matchScore.ts's ScoreBreakdown exactly. */
  scoreBreakdown: unknown;
  /** score >= AUTO_MATCH_THRESHOLD — the one-click-accept flag. */
  autoMatchable: boolean;
}

export interface BankTransaction {
  id: string;
  importId: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  txnDate: string;
  description: string;
  externalReference: string | null;
  currencyCode: string;
  /** Signed: > 0 money in, < 0 money out. */
  amountCents: number;
  status: BankTransactionStatus;
  matchedPaymentId: string | null;
  matchedAt: string | null;
  matchedBy: string | null;
  matchedByName: string | null;
  createdAt: string;
  updatedAt: string;
  /** Empty for a MATCHED or IGNORED line. Ordered score DESC. */
  suggestions: BankMatchSuggestion[];
}

export interface BankReconciliationReport {
  accountId: string;
  accountCode: string;
  accountName: string;
  asOf: string;
  /** Debits minus credits on the GL cash account up to asOf. */
  glBalanceCents: number;
  /** Sum of every imported bank line for this account up to asOf. */
  statementBalanceCents: number;
  differenceCents: number;
  /** Integer equality, never an epsilon (guardrails rule 3). */
  reconciles: boolean;
  matchedCount: number;
  matchedCents: number;
  unmatchedCount: number;
  unmatchedCents: number;
  ignoredCount: number;
  /** From the latest import carrying one, on or before asOf. Null when none does. */
  statedClosingBalanceCents: number | null;
  statedClosingBalanceOn: string | null;
  statedClosingDifferenceCents: number | null;
}

// ------------------------------------------------------------------ Phase 8 — FX

export const FX_RATE_SOURCES = ['MANUAL', 'IMPORT'] as const;
export type FxRateSource = (typeof FX_RATE_SOURCES)[number];

export function isFxRateSource(value: string): value is FxRateSource {
  return (FX_RATE_SOURCES as readonly string[]).includes(value);
}

export interface FxRate {
  id: string;
  fromCode: string;
  toCode: string;
  rateDate: string; // 'YYYY-MM-DD' — a DATE is a calendar fact, never an instant
  rate: string; // NUMERIC(18,8) as a string, never a number — see utils/fxRate.ts
  source: FxRateSource;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** What a lookup answers with: the rate, and which row supplied it. */
export interface ResolvedRate {
  fromCode: string;
  toCode: string;
  rate: string;
  /** The date of the row actually used — on or BEFORE the date asked for. */
  rateDate: string;
  /** true when fromCode === toCode: rate '1.00000000', no row consulted. */
  identity: boolean;
}

export interface FxExposureDocument {
  documentType: 'INVOICE' | 'BILL';
  documentId: string;
  documentNumber: string | null;
  counterpartyName: string;
  currencyCode: string;
  outstandingCents: number; // native, the document's own currency
  documentRate: string;
  revaluationRate: string;
  carryingBaseCents: number; // outstanding x documentRate
  revaluedBaseCents: number; // outstanding x revaluationRate
  deltaCents: number; // revalued - carrying, signed
}

export interface FxExposureReport {
  asOfDate: string;
  baseCurrency: string;
  documents: FxExposureDocument[];
  /** Per-currency subtotals, ordered by currencyCode ASC. */
  byCurrency: {
    currencyCode: string;
    outstandingCents: number;
    carryingBaseCents: number;
    revaluedBaseCents: number;
    deltaCents: number;
  }[];
  totalDeltaCents: number;
  /** true when a revaluation already exists for asOfDate. */
  alreadyRevalued: boolean;
}

export interface FxRevaluationLine {
  id: string;
  documentType: 'INVOICE' | 'BILL';
  invoiceId: string | null;
  billId: string | null;
  documentNumber: string | null;
  counterpartyName: string;
  currencyCode: string;
  outstandingCents: number;
  documentRate: string;
  revaluationRate: string;
  carryingBaseCents: number;
  revaluedBaseCents: number;
  deltaCents: number;
}

export interface FxRevaluation {
  id: string;
  asOfDate: string;
  journalEntryId: string;
  reversalJournalEntryId: string;
  /** Signed — a revaluation delta is not a "money >= 0" amount. */
  totalDeltaCents: number;
  lineCount: number;
  createdBy: string;
  createdAt: string;
  lines: FxRevaluationLine[];
}

// ------------------------------------------------- Phase 9b: migration imports

export const MIGRATION_IMPORT_KINDS = ['CHART_OF_ACCOUNTS', 'OPENING_BALANCES'] as const;
export type MigrationImportKind = (typeof MIGRATION_IMPORT_KINDS)[number];

export function isMigrationImportKind(value: string): value is MigrationImportKind {
  return (MIGRATION_IMPORT_KINDS as readonly string[]).includes(value);
}

export const MIGRATION_IMPORT_STATUSES = ['DRAFT', 'VALIDATED', 'COMMITTED'] as const;
export type MigrationImportStatus = (typeof MIGRATION_IMPORT_STATUSES)[number];

/**
 * The one place a staged import's lifecycle is written down (rule 10).
 * COMMITTED is terminal — a committed import produced real accounts and a
 * real posted journal entry, and rule 6 says a posted document is corrected
 * by a reversing entry, never by re-running the thing that posted it.
 * VALIDATED -> DRAFT exists because editing a row after validation must
 * invalidate the validation, not silently keep it.
 */
export const MIGRATION_IMPORT_TRANSITIONS = {
  DRAFT: ['VALIDATED'],
  VALIDATED: ['DRAFT', 'COMMITTED'],
  COMMITTED: [],
} as const satisfies Record<MigrationImportStatus, readonly MigrationImportStatus[]>;

export function canTransitionMigrationImport(
  from: MigrationImportStatus,
  to: MigrationImportStatus,
): boolean {
  return (MIGRATION_IMPORT_TRANSITIONS[from] as readonly MigrationImportStatus[]).includes(to);
}

export const MIGRATION_ROW_STATUSES = ['VALID', 'INVALID', 'EXCLUDED'] as const;
export type MigrationRowStatus = (typeof MIGRATION_ROW_STATUSES)[number];

export function isMigrationRowStatus(value: string): value is MigrationRowStatus {
  return (MIGRATION_ROW_STATUSES as readonly string[]).includes(value);
}

export interface MigrationImport {
  id: string;
  kind: MigrationImportKind;
  status: MigrationImportStatus;
  fileName: string;
  delimiter: string;
  rowCount: number;
  errorCount: number;
  validCount: number;
  excludedCount: number;
  journalEntryId: string | null;
  committedAt: string | null;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
}

export interface MigrationImportRow {
  id: string;
  rowNumber: number;
  raw: Record<string, string>;
  accountCode: string | null;
  accountName: string | null;
  accountType: AccountType | null;
  parentCode: string | null;
  description: string | null;
  debitCents: number | null;
  creditCents: number | null;
  errors: string[];
  status: MigrationRowStatus;
}

/** What POST /:id/preview returns, and what commit will do if run now. */
export interface MigrationCommitPreview {
  kind: MigrationImportKind;
  canCommit: boolean;
  blockingErrorCount: number;
  /** CHART_OF_ACCOUNTS only. */
  accountsToCreate: number;
  accountsToMerge: number;
  /** OPENING_BALANCES only. */
  totalDebitCents: number;
  totalCreditCents: number;
  /** Signed. Positive = a credit plug to 3400; negative = a debit plug. Zero = no plug. */
  plugCents: number;
  plugAccountCode: string;
  entryDate: string | null;
}

/* ------------------------------------------------ Phase 12 — the FP&A actuals bridge */

/** One row per (account, month) of posted actuals, base currency. */
export interface MonthlyActualRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  month: string; // 'YYYY-MM-01'
  debitCents: number;
  creditCents: number;
}

/**
 * The three GL control accounts an FP&A model needs, resolved through
 * LedgerCore so no other app queries ledger_settings, ledger_invoice_settings
 * or accounts directly (guardrails rule 16). `null` means neither a
 * configured setting nor the default-chart code was found.
 */
export interface ControlAccounts {
  cashAccountId: string | null;
  receivableAccountId: string | null;
  payableAccountId: string | null;
}
