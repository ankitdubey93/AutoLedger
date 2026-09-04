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
}

export interface Payment {
  id: string;
  direction: PaymentDirection;
  status: PaymentStatus;
  paymentDate: string;
  currencyCode: string;
  amountCents: number;
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
