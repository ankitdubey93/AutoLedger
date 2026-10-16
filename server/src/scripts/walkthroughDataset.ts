import { calendarYear, monthName, type AnchorMonth, type WalkthroughMonth } from './walkthroughDates.js';

/**
 * The source-of-truth data for `walkthrough/` — a hand-enterable, six-month
 * accounting scenario for one fictional business, Harbor Point Fabrication.
 * Months 1–3 are ordinary trading; month 4 (Phase 26) is "Returns &
 * adjustments" — a sales return (credit note), a supplier return (debit
 * note), and a price allowance on an already-paid invoice that sits as
 * unapplied credit until it is applied to the customer's next invoice.
 *
 * This data is meant to be typed in by a human, so every amount and every
 * date is fixed here, not derived at load time. (It is also replayed through
 * the API by `walkthroughReplay.ts`, for the answer-key test and for
 * `npm run seed:demo` — the same fixed data either way.)
 *
 * Money is a decimal string (`"14500.00"`), parsed through `parseMoneyText`
 * wherever it is used — never a float; rule 3's discipline applied at a file
 * boundary.
 *
 * Every document is tax-exempt (no `taxRateBp` field — the schema's default
 * is 0) so the arithmetic in `07-expected-results.md` stays checkable by
 * hand; the tax split is Capture's showcase, not this one.
 */

export type Tier =
  | 'AUTO_0'
  | 'AUTO_1'
  | 'AUTO_2'
  | 'REVIEW_LATE'
  | 'REVIEW_ANON'
  | 'REVIEW_PARTIAL'
  | 'REVIEW_REMAINDER'
  /** Never paid inside the scenario — no settlement line. */
  | 'OPEN';

/** How a document reaches the books in the replay. Absent on a document = 'MANUAL'. */
export type DocumentEntry = 'MANUAL' | 'IMPORT' | 'ORDER' | 'RECURRING' | 'DEPOSIT';

export interface DatasetLine {
  /** A Products & Services / stock item code, or null for a free-text line. */
  itemCode: string | null;
  description: string;
  /** Decimal string, e.g. "200". */
  quantity: string;
  /** Decimal string, e.g. "42.00". */
  unitPrice: string;
  accountCode: string;
}

export interface DatasetProduct {
  code: string;
  name: string;
  type: 'SERVICE';
  description: string;
  salePrice: string;
  accountCode: string;
}

export interface DatasetStockItem {
  code: string;
  name: string;
  description: string;
  category: 'SPR';
  reorderPoint: number;
  salePrice: string;
  purchasePrice: string;
  /** The single receipt's unit cost — the moving average the simulator uses. */
  unitCost: string;
  revenueAccount: '4100';
  assetAccount: '1140';
  cogsAccount: '5050';
}

export interface DatasetOrder {
  ref: string;
  direction: 'PURCHASE' | 'SALES';
  counterpartyKey: string;
  month: WalkthroughMonth;
  day: number;
  /** A sales order raised from a quote: the quote's label and day. */
  quoteRef: string | null;
  quoteDay: number | null;
  lines: DatasetLine[];
}

export interface DatasetJournal {
  ref: string;
  entry: 'REPEATING' | 'IMPORT';
  narration: string;
  month: WalkthroughMonth;
  day: number;
  lines: { accountCode: string; description: string | null; debit: string; credit: string }[];
  repeat: { endMonth: WalkthroughMonth; endDay: number; autoReverse: boolean } | null;
}

export interface DatasetBankRule {
  name: string;
  priority: number;
  direction: 'IN' | 'OUT';
  memoContains: string;
  amountMinCents: number | null;
  amountMaxCents: number | null;
  bankAccountCode: string;
  targetAccountCode: string;
  description: string;
}

export interface DatasetDepositApplication {
  depositRef: string;
  documentRef: string;
  day: number;
  /** Decimal string; lands in the month of `documentRef`. */
  amount: string;
}

export interface DatasetVendor {
  key: string;
  name: string;
  email: string;
  phone: string;
  address: string;
  taxNumber: string;
  /** The expense account this vendor's bills post to. */
  expenseAccount: string;
}

export interface DatasetCustomer {
  key: string;
  name: string;
  email: string;
  phone: string;
  address: string;
}

export interface DatasetDocument {
  /** The pack's own label — 'I1', 'B3' — not the system-assigned invoice number. */
  ref: string;
  counterpartyKey: string;
  month: WalkthroughMonth;
  day: number;
  /** Always 0 in this dataset — every document is due on receipt. */
  dueDays: number;
  /** Revenue account for an invoice, expense account for a bill. */
  accountCode: string;
  lineDescription: string;
  /** Decimal string, e.g. "14500.00". */
  total: string;
  /** Bills only; null for an invoice. */
  vendorReference: string | null;
  tier: Tier;
  /** Set only on REVIEW_ANON — the processor descriptor used instead of the name. */
  anonMemo: string | null;
  /** Set only on the REVIEW_PARTIAL document — where its REVIEW_REMAINDER line lands. */
  remainder: { month: WalkthroughMonth; day: number } | null;
  /** Multi-line documents only; otherwise one line is synthesised (see `documentLines`). */
  lines?: DatasetLine[];
  /** Absent = 'MANUAL'. */
  entry?: DocumentEntry;
  /** Absent = same day as the document. `month` 7 = the month after the scenario. */
  dueDate?: { month: WalkthroughMonth | 7; day: number };
  /** The order a document is raised from (`ORDER`, `DEPOSIT`). */
  orderRef?: string;
  /** Order lines billed by this document; null = the remainder. */
  orderLines?: { itemCode: string; quantity: string }[] | null;
}

export interface DatasetNoiseLine {
  month: WalkthroughMonth;
  day: number;
  description: string;
  /** Decimal string, signed: "75000.00" or "-45.00". */
  amount: string;
  resolution:
    | { kind: 'POST_JOURNAL'; accountCode: string }
    | { kind: 'RULE'; accountCode: string }
    | { kind: 'IGNORE' };
}

export interface DatasetNoteAllocation {
  /**
   * The document the credit lands on. The allocation whose documentRef is the
   * note's own againstRef is what issuing auto-applies; any other is a manual
   * POST /:id/allocations.
   */
  documentRef: string;
  day: number;
  /** Decimal string. */
  amount: string;
}

export interface DatasetNote {
  ref: string;
  kind: 'CREDIT_NOTE' | 'DEBIT_NOTE';
  counterpartyKey: string;
  /** The original document — an invoice ref for a credit note, a bill ref for a debit note. */
  againstRef: string;
  month: WalkthroughMonth;
  day: number;
  reasonCode: 'RETURN' | 'PRICE_ADJUSTMENT' | 'DISCOUNT' | 'DAMAGED' | 'OTHER';
  /** Credit note: a Revenue account (4800). Debit note: the bill's expense account. */
  accountCode: string;
  lineDescription: string;
  /** Decimal string. */
  total: string;
  /** Debit notes only — the vendor's own credit-note number. */
  vendorCreditReference: string | null;
  allocations: DatasetNoteAllocation[];
}

export interface WalkthroughDataset {
  businessName: 'Harbor Point Fabrication';
  businessDescription: string;
  baseCurrency: 'USD';
  cashAccountCode: '1110';
  extraAccounts: { code: string; name: string; type: string; parent: string }[];
  vendors: DatasetVendor[];
  customers: DatasetCustomer[];
  invoices: DatasetDocument[];
  bills: DatasetDocument[];
  noise: DatasetNoiseLine[];
  notes: DatasetNote[];
  products: DatasetProduct[];
  stockItems: DatasetStockItem[];
  orders: DatasetOrder[];
  journals: DatasetJournal[];
  bankRules: DatasetBankRule[];
  extraVendors: DatasetVendor[];
  depositApplications: DatasetDepositApplication[];
  periodCloses: { afterMonth: WalkthroughMonth; closeMonths: WalkthroughMonth[] }[];
}

export const WALKTHROUGH_DATASET: WalkthroughDataset = {
  businessName: 'Harbor Point Fabrication',
  businessDescription:
    'A small metal-fabrication shop. It bills project work — brackets, mounts, custom runs — to ' +
    'commercial customers, and buys the materials, freight, software, rent and professional ' +
    'services a shop like that actually needs. Every document here is tax-exempt, so every figure ' +
    'in the answer key is checkable by hand without a tax split getting in the way.',
  baseCurrency: 'USD',
  cashAccountCode: '1110',
  extraAccounts: [{ code: '4300', name: 'Interest Income', type: 'Revenue', parent: '4000' }],

  vendors: [
    {
      key: 'northgate-realty',
      name: 'Northgate Realty',
      email: 'billing@northgaterealty.example',
      phone: '+1-555-0411',
      address: 'Suite 300, 1200 Commerce Blvd, Columbus, OH 43215',
      taxNumber: 'US-31-5567201',
      expenseAccount: '6110',
    },
    {
      key: 'cloudspan',
      name: 'Cloudspan Infrastructure',
      email: 'ar@cloudspan.example',
      phone: '+1-555-0426',
      address: '500 Datacenter Road, Ashburn, VA 20147',
      taxNumber: 'US-54-8830112',
      expenseAccount: '6120',
    },
    {
      key: 'ironclad-supply',
      name: 'Ironclad Supply Co',
      email: 'orders@ironcladsupply.example',
      phone: '+1-555-0438',
      address: '77 Foundry Row, Gary, IN 46402',
      taxNumber: 'US-19-2204471',
      expenseAccount: '5100',
    },
    {
      key: 'verity-audit',
      name: 'Verity Audit Partners',
      email: 'billing@verityaudit.example',
      phone: '+1-555-0452',
      address: '900 Ledger Street, Suite 12, Cleveland, OH 44113',
      taxNumber: 'US-27-7719003',
      expenseAccount: '6200',
    },
    {
      key: 'crosswind-freight',
      name: 'Crosswind Freight',
      email: 'dispatch@crosswindfreight.example',
      phone: '+1-555-0467',
      address: '14 Dock Terminal Way, Toledo, OH 43604',
      taxNumber: 'US-41-3390215',
      expenseAccount: '5300',
    },
    {
      key: 'beacon-media',
      name: 'Beacon Media Buying',
      email: 'accounts@beaconmedia.example',
      phone: '+1-555-0479',
      address: '221 Signal Ave, Floor 4, Chicago, IL 60654',
      taxNumber: 'US-36-8801547',
      expenseAccount: '6400',
    },
  ],

  customers: [
    {
      key: 'brightline-analytics',
      name: 'Brightline Analytics',
      email: 'ap@brightlineanalytics.example',
      phone: '+1-555-0512',
      address: '88 Insight Plaza, Austin, TX 78701',
    },
    {
      key: 'kestrel-logistics',
      name: 'Kestrel Logistics',
      email: 'payables@kestrellogistics.example',
      phone: '+1-555-0523',
      address: '4400 Freight Yard Rd, Memphis, TN 38118',
    },
    {
      key: 'ferrous-works',
      name: 'Ferrous Works Ltd',
      email: 'ap@ferrousworks.example',
      phone: '+1-555-0537',
      address: '19 Millwright Ave, Pittsburgh, PA 15222',
    },
    {
      key: 'novato-health',
      name: 'Novato Health Systems',
      email: 'finance@novatohealth.example',
      phone: '+1-555-0548',
      address: '710 Wellness Blvd, Novato, CA 94945',
    },
    {
      key: 'orchid-media',
      name: 'Orchid Media Group',
      email: 'accounting@orchidmedia.example',
      phone: '+1-555-0561',
      address: '52 Studio Row, Burbank, CA 91502',
    },
    {
      key: 'pinnacle-robotics',
      name: 'Pinnacle Robotics',
      email: 'ap@pinnaclerobotics.example',
      phone: '+1-555-0579',
      address: '3 Actuator Court, San Jose, CA 95110',
    },
  ],

  invoices: [
    // --- Month 1 ---
    {
      ref: 'I1', counterpartyKey: 'brightline-analytics', month: 1, day: 2, dueDays: 0,
      accountCode: '4200', lineDescription: 'Fabrication — bracket assembly, run 240',
      total: '14500.00', vendorReference: null, tier: 'AUTO_0', anonMemo: null, remainder: null,
    },
    {
      ref: 'I2', counterpartyKey: 'kestrel-logistics', month: 1, day: 5, dueDays: 0,
      accountCode: '4200', lineDescription: 'Fabrication — pallet rack mounts, run 88',
      total: '8250.00', vendorReference: null, tier: 'AUTO_1', anonMemo: null, remainder: null,
    },
    {
      ref: 'I3', counterpartyKey: 'ferrous-works', month: 1, day: 9, dueDays: 0,
      accountCode: '4200', lineDescription: 'Fabrication — structural brace set, run 12',
      total: '22100.00', vendorReference: null, tier: 'AUTO_2', anonMemo: null, remainder: null,
    },
    {
      ref: 'I4', counterpartyKey: 'novato-health', month: 1, day: 12, dueDays: 0,
      accountCode: '4200', lineDescription: 'Fabrication — equipment cart frames, run 30',
      total: '6400.00', vendorReference: null, tier: 'REVIEW_LATE', anonMemo: null, remainder: null,
    },
    {
      ref: 'I5', counterpartyKey: 'orchid-media', month: 1, day: 17, dueDays: 0,
      accountCode: '4200', lineDescription: 'Fabrication — studio rigging brackets, run 6',
      total: '11900.00', vendorReference: null, tier: 'REVIEW_ANON',
      anonMemo: 'SQ *DEP 88241 PAYOUT', remainder: null,
    },
    {
      ref: 'I6', counterpartyKey: 'pinnacle-robotics', month: 1, day: 20, dueDays: 0,
      accountCode: '4100', lineDescription: 'Product sale — actuator housings, batch 4',
      total: '18000.00', vendorReference: null, tier: 'REVIEW_PARTIAL',
      anonMemo: null, remainder: { month: 2, day: 8 },
    },
    // --- Month 2 ---
    {
      ref: 'I7', counterpartyKey: 'ferrous-works', month: 2, day: 3, dueDays: 0,
      accountCode: '4200', lineDescription: 'Fabrication — conveyor guard panels, run 15',
      total: '9800.00', vendorReference: null, tier: 'AUTO_0', anonMemo: null, remainder: null,
    },
    {
      ref: 'I8', counterpartyKey: 'novato-health', month: 2, day: 7, dueDays: 0,
      accountCode: '4100', lineDescription: 'Product sale — IV pole bases, batch 9',
      total: '5200.00', vendorReference: null, tier: 'AUTO_1', anonMemo: null, remainder: null,
    },
    {
      ref: 'I9', counterpartyKey: 'kestrel-logistics', month: 2, day: 11, dueDays: 0,
      accountCode: '4200', lineDescription: 'Fabrication — dock leveler plates, run 22',
      total: '15600.00', vendorReference: null, tier: 'REVIEW_LATE', anonMemo: null, remainder: null,
    },
    {
      ref: 'I10', counterpartyKey: 'orchid-media', month: 2, day: 15, dueDays: 0,
      accountCode: '4200', lineDescription: 'Fabrication — camera mount arms, run 9',
      total: '7300.00', vendorReference: null, tier: 'REVIEW_ANON',
      anonMemo: 'PYMT PROCESSOR REF 44219', remainder: null,
    },
    // --- Month 3 ---
    {
      ref: 'I11', counterpartyKey: 'brightline-analytics', month: 3, day: 4, dueDays: 0,
      accountCode: '4200', lineDescription: 'Fabrication — server rack rails, run 55',
      total: '16800.00', vendorReference: null, tier: 'AUTO_0', anonMemo: null, remainder: null,
    },
    {
      ref: 'I12', counterpartyKey: 'pinnacle-robotics', month: 3, day: 9, dueDays: 0,
      accountCode: '4100', lineDescription: 'Product sale — actuator housings, batch 5',
      total: '9400.00', vendorReference: null, tier: 'AUTO_2', anonMemo: null, remainder: null,
    },
    {
      ref: 'I13', counterpartyKey: 'ferrous-works', month: 3, day: 13, dueDays: 0,
      accountCode: '4200', lineDescription: 'Fabrication — structural brace set, run 13',
      total: '12100.00', vendorReference: null, tier: 'REVIEW_LATE', anonMemo: null, remainder: null,
    },
    {
      ref: 'I14', counterpartyKey: 'kestrel-logistics', month: 3, day: 18, dueDays: 0,
      accountCode: '4200', lineDescription: 'Fabrication — pallet rack mounts, run 91',
      total: '6700.00', vendorReference: null, tier: 'REVIEW_ANON',
      anonMemo: 'ACH TRANSFER REF 90312', remainder: null,
    },
    // --- Month 4: returns & adjustments ---
    {
      ref: 'I15', counterpartyKey: 'brightline-analytics', month: 4, day: 2, dueDays: 0,
      accountCode: '4100', lineDescription: 'Product sale — bracket kits, 20 × 600.00',
      total: '12000.00', vendorReference: null, tier: 'REVIEW_LATE', anonMemo: null, remainder: null,
    },
    {
      ref: 'I16', counterpartyKey: 'ferrous-works', month: 4, day: 10, dueDays: 0,
      accountCode: '4200', lineDescription: 'Fabrication — conveyor guard panels, run 16',
      total: '6200.00', vendorReference: null, tier: 'AUTO_2', anonMemo: null, remainder: null,
    },
    // --- Month 5: products, stock & orders ---
    {
      ref: 'D1', counterpartyKey: 'kestrel-logistics', month: 5, day: 8, dueDays: 0,
      accountCode: '2130', lineDescription: 'Deposit — SO1 (25%)',
      total: '4090.00', vendorReference: null, tier: 'AUTO_0', anonMemo: null, remainder: null,
      entry: 'DEPOSIT', orderRef: 'SO1',
    },
    {
      ref: 'I17', counterpartyKey: 'kestrel-logistics', month: 5, day: 12, dueDays: 0,
      accountCode: '4100', lineDescription: 'Caster and fitting supply — first delivery',
      total: '7500.00', vendorReference: null, tier: 'AUTO_2', anonMemo: null, remainder: null,
      entry: 'ORDER', orderRef: 'SO1',
      orderLines: [{ itemCode: 'CAST-6', quantity: '60' }, { itemCode: 'HFK-12', quantity: '40' }],
      lines: [
        { itemCode: 'CAST-6', description: 'Heavy-duty caster, 6 in', quantity: '60', unitPrice: '95.00', accountCode: '4100' },
        { itemCode: 'HFK-12', description: 'Hydraulic fitting kit', quantity: '40', unitPrice: '45.00', accountCode: '4100' },
      ],
    },
    // --- Month 6: closing the quarter ---
    {
      ref: 'I18', counterpartyKey: 'brightline-analytics', month: 6, day: 4, dueDays: 0,
      accountCode: '4200', lineDescription: 'Design & drafting — conveyor retrofit',
      total: '2640.00', vendorReference: null, tier: 'AUTO_0', anonMemo: null, remainder: null,
      entry: 'IMPORT',
      lines: [
        { itemCode: 'SVC-DES', description: 'Design & drafting — conveyor retrofit', quantity: '24', unitPrice: '110.00', accountCode: '4200' },
      ],
    },
    {
      ref: 'I19', counterpartyKey: 'orchid-media', month: 6, day: 11, dueDays: 0,
      accountCode: '4200', lineDescription: 'Fabrication labour — studio set build',
      total: '3400.00', vendorReference: null, tier: 'REVIEW_ANON', anonMemo: 'STRIPE PAYOUT 7731', remainder: null,
      entry: 'IMPORT',
      lines: [
        { itemCode: 'SVC-FAB', description: 'Fabrication labour — studio set build', quantity: '40', unitPrice: '85.00', accountCode: '4200' },
      ],
    },
    {
      // Due 30 days after the invoice date: 22 September + 30 days = 22 October (month 7, day 22).
      ref: 'I20', counterpartyKey: 'kestrel-logistics', month: 6, day: 22, dueDays: 0,
      accountCode: '4100', lineDescription: 'Caster and fitting supply — remainder',
      total: '8860.00', vendorReference: null, tier: 'OPEN', anonMemo: null, remainder: null,
      dueDate: { month: 7, day: 22 },
      entry: 'ORDER', orderRef: 'SO1', orderLines: null,
      lines: [
        { itemCode: 'CAST-6', description: 'Heavy-duty caster, 6 in', quantity: '60', unitPrice: '95.00', accountCode: '4100' },
        { itemCode: 'HFK-12', description: 'Hydraulic fitting kit', quantity: '40', unitPrice: '45.00', accountCode: '4100' },
        { itemCode: 'SVC-FAB', description: 'Fabrication labour (per hour)', quantity: '16', unitPrice: '85.00', accountCode: '4200' },
      ],
    },
  ],

  bills: [
    // --- Month 1 ---
    {
      ref: 'B1', counterpartyKey: 'northgate-realty', month: 1, day: 1, dueDays: 0,
      accountCode: '6110', lineDescription: 'Shop rent — [Month]',
      total: '9100.00', vendorReference: 'NR-M1-RENT', tier: 'AUTO_0', anonMemo: null, remainder: null,
    },
    {
      ref: 'B2', counterpartyKey: 'cloudspan', month: 1, day: 4, dueDays: 0,
      accountCode: '6120', lineDescription: 'ERP hosting — [Month]',
      total: '3480.00', vendorReference: 'CS-44821', tier: 'AUTO_1', anonMemo: null, remainder: null,
    },
    {
      ref: 'B3', counterpartyKey: 'ironclad-supply', month: 1, day: 8, dueDays: 0,
      accountCode: '5100', lineDescription: 'Steel stock, 40mm — mill order',
      total: '12750.00', vendorReference: 'INV-IC-7741', tier: 'AUTO_2', anonMemo: null, remainder: null,
    },
    {
      ref: 'B4', counterpartyKey: 'verity-audit', month: 1, day: 14, dueDays: 0,
      accountCode: '6200', lineDescription: 'Quarterly books review',
      total: '5600.00', vendorReference: 'VAP-2291', tier: 'REVIEW_LATE', anonMemo: null, remainder: null,
    },
    {
      ref: 'B5', counterpartyKey: 'crosswind-freight', month: 1, day: 19, dueDays: 0,
      accountCode: '5300', lineDescription: 'Outbound freight — [Month] runs',
      total: '2340.00', vendorReference: 'CWF-0912', tier: 'REVIEW_ANON',
      anonMemo: 'BILL PAY 7734 REF 5590', remainder: null,
    },
    // --- Month 2 ---
    {
      ref: 'B6', counterpartyKey: 'beacon-media', month: 2, day: 5, dueDays: 0,
      accountCode: '6400', lineDescription: 'Trade publication placement — [Month]',
      total: '4100.00', vendorReference: 'BM-2207', tier: 'AUTO_0', anonMemo: null, remainder: null,
    },
    {
      ref: 'B7', counterpartyKey: 'northgate-realty', month: 2, day: 1, dueDays: 0,
      accountCode: '6110', lineDescription: 'Shop rent — [Month]',
      total: '9100.00', vendorReference: 'NR-M2-RENT', tier: 'AUTO_1', anonMemo: null, remainder: null,
    },
    {
      ref: 'B8', counterpartyKey: 'verity-audit', month: 2, day: 18, dueDays: 0,
      accountCode: '6200', lineDescription: 'Payroll compliance review',
      total: '3200.00', vendorReference: 'VAP-2318', tier: 'REVIEW_LATE', anonMemo: null, remainder: null,
    },
    // --- Month 3 ---
    {
      ref: 'B9', counterpartyKey: 'ironclad-supply', month: 3, day: 6, dueDays: 0,
      accountCode: '5100', lineDescription: 'Steel stock, 25mm — mill order',
      total: '8900.00', vendorReference: 'INV-IC-8890', tier: 'AUTO_1', anonMemo: null, remainder: null,
    },
    {
      ref: 'B10', counterpartyKey: 'cloudspan', month: 3, day: 10, dueDays: 0,
      accountCode: '6120', lineDescription: 'ERP hosting — [Month]',
      total: '3480.00', vendorReference: 'CS-45210', tier: 'AUTO_2', anonMemo: null, remainder: null,
    },
    {
      ref: 'B11', counterpartyKey: 'crosswind-freight', month: 3, day: 16, dueDays: 0,
      accountCode: '5300', lineDescription: 'Outbound freight — [Month] runs',
      total: '3100.00', vendorReference: 'CWF-1044', tier: 'REVIEW_LATE', anonMemo: null, remainder: null,
    },
    // --- Month 4: returns & adjustments ---
    {
      ref: 'B12', counterpartyKey: 'ironclad-supply', month: 4, day: 4, dueDays: 0,
      accountCode: '5100', lineDescription: 'Steel stock, 40mm — 80 bars × 150.00',
      total: '12000.00', vendorReference: 'INV-IC-9120', tier: 'REVIEW_LATE', anonMemo: null, remainder: null,
    },
    // --- Month 5: products, stock & orders ---
    {
      ref: 'B14', counterpartyKey: 'northgate-realty', month: 5, day: 1, dueDays: 0,
      accountCode: '6110', lineDescription: 'Shop rent — [Month]',
      total: '9100.00', vendorReference: 'NR-RENT-{M5}', tier: 'AUTO_0', anonMemo: null, remainder: null,
      entry: 'MANUAL',
    },
    {
      ref: 'B13', counterpartyKey: 'ironclad-supply', month: 5, day: 5, dueDays: 0,
      accountCode: '1140', lineDescription: 'Castors and fitting kits — PO1',
      total: '13950.00', vendorReference: 'INV-IC-9455', tier: 'AUTO_1', anonMemo: null, remainder: null,
      entry: 'ORDER', orderRef: 'PO1', orderLines: null,
      lines: [
        { itemCode: 'CAST-6', description: 'Heavy-duty caster, 6 in', quantity: '200', unitPrice: '42.00', accountCode: '1140' },
        { itemCode: 'HFK-12', description: 'Hydraulic fitting kit', quantity: '300', unitPrice: '18.50', accountCode: '1140' },
      ],
    },
    // --- Month 6: closing the quarter ---
    {
      ref: 'B15', counterpartyKey: 'northgate-realty', month: 6, day: 1, dueDays: 0,
      accountCode: '6110', lineDescription: 'Shop rent — [Month]',
      total: '9100.00', vendorReference: 'NR-RENT-{M6}', tier: 'AUTO_0', anonMemo: null, remainder: null,
      entry: 'RECURRING',
    },
    {
      ref: 'B16', counterpartyKey: 'lakeshore-power', month: 6, day: 8, dueDays: 0,
      accountCode: '6110', lineDescription: 'Electricity & water — {M5} usage',
      total: '850.00', vendorReference: 'LPW-88120', tier: 'AUTO_1', anonMemo: null, remainder: null,
      entry: 'IMPORT',
    },
    {
      ref: 'B17', counterpartyKey: 'cloudspan', month: 6, day: 10, dueDays: 0,
      accountCode: '6120', lineDescription: 'ERP hosting — {M6}',
      total: '3480.00', vendorReference: 'CS-46102', tier: 'AUTO_2', anonMemo: null, remainder: null,
      entry: 'IMPORT',
    },
    {
      ref: 'B18', counterpartyKey: 'crosswind-freight', month: 6, day: 15, dueDays: 0,
      accountCode: '5300', lineDescription: 'Outbound freight — {M6} runs',
      total: '1240.00', vendorReference: 'CWF-1187', tier: 'REVIEW_LATE', anonMemo: null, remainder: null,
      entry: 'IMPORT',
    },
  ],

  noise: [
    // --- Month 1 ---
    { month: 1, day: 1, description: 'OPENING DEPOSIT FOUNDER CAPITAL', amount: '75000.00', resolution: { kind: 'POST_JOURNAL', accountCode: '3100' } },
    { month: 1, day: 22, description: 'WIRE FEE INTL', amount: '-45.00', resolution: { kind: 'POST_JOURNAL', accountCode: '6600' } },
    { month: 1, day: 24, description: 'TRANSFER TO SAVINGS', amount: '-5000.00', resolution: { kind: 'IGNORE' } },
    { month: 1, day: 28, description: 'MONTHLY SERVICE CHARGE', amount: '-38.00', resolution: { kind: 'POST_JOURNAL', accountCode: '6600' } },
    { month: 1, day: 28, description: 'INTEREST PAID', amount: '12.40', resolution: { kind: 'POST_JOURNAL', accountCode: '4300' } },
    // --- Month 2 ---
    { month: 2, day: 20, description: 'MONTHLY SERVICE CHARGE', amount: '-38.00', resolution: { kind: 'POST_JOURNAL', accountCode: '6600' } },
    { month: 2, day: 25, description: 'TRANSFER TO SAVINGS', amount: '-3000.00', resolution: { kind: 'IGNORE' } },
    { month: 2, day: 28, description: 'INTEREST PAID', amount: '14.10', resolution: { kind: 'POST_JOURNAL', accountCode: '4300' } },
    // --- Month 3 ---
    { month: 3, day: 2, description: 'MONTHLY SERVICE CHARGE', amount: '-38.00', resolution: { kind: 'POST_JOURNAL', accountCode: '6600' } },
    { month: 3, day: 19, description: 'TRANSFER TO SAVINGS', amount: '-4000.00', resolution: { kind: 'IGNORE' } },
    { month: 3, day: 27, description: 'INTEREST PAID', amount: '15.80', resolution: { kind: 'POST_JOURNAL', accountCode: '4300' } },
    // --- Month 4 ---
    { month: 4, day: 2, description: 'MONTHLY SERVICE CHARGE', amount: '-38.00', resolution: { kind: 'POST_JOURNAL', accountCode: '6600' } },
    { month: 4, day: 20, description: 'TRANSFER TO SAVINGS', amount: '-2500.00', resolution: { kind: 'IGNORE' } },
    { month: 4, day: 28, description: 'INTEREST PAID', amount: '16.20', resolution: { kind: 'POST_JOURNAL', accountCode: '4300' } },
    // --- Month 5 ---
    { month: 5, day: 2, description: 'MONTHLY SERVICE CHARGE', amount: '-38.00', resolution: { kind: 'RULE', accountCode: '6600' } },
    { month: 5, day: 20, description: 'TRANSFER TO SAVINGS', amount: '-2000.00', resolution: { kind: 'IGNORE' } },
    { month: 5, day: 28, description: 'INTEREST PAID', amount: '17.30', resolution: { kind: 'RULE', accountCode: '4300' } },
    // --- Month 6 ---
    { month: 6, day: 2, description: 'MONTHLY SERVICE CHARGE', amount: '-38.00', resolution: { kind: 'RULE', accountCode: '6600' } },
    { month: 6, day: 26, description: 'PAYROLL NET PAY', amount: '-11400.00', resolution: { kind: 'POST_JOURNAL', accountCode: '2160' } },
    { month: 6, day: 27, description: 'TRANSFER TO SAVINGS', amount: '-1500.00', resolution: { kind: 'IGNORE' } },
    { month: 6, day: 28, description: 'INTEREST PAID', amount: '18.40', resolution: { kind: 'RULE', accountCode: '4300' } },
  ],

  // Phase 26 — month 4's correcting documents, in the order they are entered.
  notes: [
    {
      // A sales return on an unpaid invoice: issuing auto-applies all of it to
      // I15, so Brightline's payment is the net 10,200.00.
      ref: 'CN1', kind: 'CREDIT_NOTE', counterpartyKey: 'brightline-analytics', againstRef: 'I15',
      month: 4, day: 3, reasonCode: 'RETURN', accountCode: '4800',
      lineDescription: '3 bracket kits returned — weld porosity', total: '1800.00',
      vendorCreditReference: null,
      allocations: [{ documentRef: 'I15', day: 3, amount: '1800.00' }],
    },
    {
      // A supplier return on an unpaid bill: auto-applies all of it to B12, so
      // Harbor Point pays Ironclad the net 10,500.00.
      ref: 'DN1', kind: 'DEBIT_NOTE', counterpartyKey: 'ironclad-supply', againstRef: 'B12',
      month: 4, day: 5, reasonCode: 'RETURN', accountCode: '5100',
      lineDescription: '10 bars returned — mill-scale defects', total: '1500.00',
      vendorCreditReference: 'IC-CR-0231',
      allocations: [{ documentRef: 'B12', day: 5, amount: '1500.00' }],
    },
    {
      // A price allowance on I13, which was paid in full in month 3: nothing to
      // auto-apply, so the 500.00 sits as unapplied credit on Ferrous Works'
      // account until it is applied to their next invoice, I16.
      ref: 'CN2', kind: 'CREDIT_NOTE', counterpartyKey: 'ferrous-works', againstRef: 'I13',
      month: 4, day: 6, reasonCode: 'PRICE_ADJUSTMENT', accountCode: '4800',
      lineDescription: 'Price allowance — run 13 delivered two days late', total: '500.00',
      vendorCreditReference: null,
      allocations: [{ documentRef: 'I16', day: 10, amount: '500.00' }],
    },
  ],

  products: [
    {
      code: 'SVC-FAB', name: 'Fabrication labour (per hour)', type: 'SERVICE',
      description: 'Shop-floor fabrication labour', salePrice: '85.00', accountCode: '4200',
    },
    {
      code: 'SVC-DES', name: 'Design & drafting (per hour)', type: 'SERVICE',
      description: 'CAD design and drafting', salePrice: '110.00', accountCode: '4200',
    },
  ],

  stockItems: [
    {
      code: 'CAST-6', name: 'Heavy-duty caster, 6 in', description: 'Swivel caster with brake',
      category: 'SPR', reorderPoint: 50, salePrice: '95.00', purchasePrice: '42.00', unitCost: '42.00',
      revenueAccount: '4100', assetAccount: '1140', cogsAccount: '5050',
    },
    {
      code: 'HFK-12', name: 'Hydraulic fitting kit', description: '12-piece fitting kit',
      category: 'SPR', reorderPoint: 40, salePrice: '45.00', purchasePrice: '18.50', unitCost: '18.50',
      revenueAccount: '4100', assetAccount: '1140', cogsAccount: '5050',
    },
  ],

  orders: [
    {
      ref: 'PO1', direction: 'PURCHASE', counterpartyKey: 'ironclad-supply', month: 5, day: 3,
      quoteRef: null, quoteDay: null,
      lines: [
        { itemCode: 'CAST-6', description: 'Heavy-duty caster, 6 in', quantity: '200', unitPrice: '42.00', accountCode: '1140' },
        { itemCode: 'HFK-12', description: 'Hydraulic fitting kit', quantity: '300', unitPrice: '18.50', accountCode: '1140' },
      ],
    },
    {
      // Raised from QU1 (sent and accepted the same day); the order itself is dated "today"
      // by the product, so `day` here is the quote's date.
      ref: 'SO1', direction: 'SALES', counterpartyKey: 'kestrel-logistics', month: 5, day: 6,
      quoteRef: 'QU1', quoteDay: 6,
      lines: [
        { itemCode: 'CAST-6', description: 'Heavy-duty caster, 6 in', quantity: '120', unitPrice: '95.00', accountCode: '4100' },
        { itemCode: 'HFK-12', description: 'Hydraulic fitting kit', quantity: '80', unitPrice: '45.00', accountCode: '4100' },
        { itemCode: 'SVC-FAB', description: 'Fabrication labour (per hour)', quantity: '16', unitPrice: '85.00', accountCode: '4200' },
      ],
    },
  ],

  journals: [
    {
      ref: 'ACC1', entry: 'REPEATING', narration: 'Utilities accrual — [Month]', month: 5, day: 28,
      lines: [
        { accountCode: '6110', description: 'Estimated electricity & water', debit: '850.00', credit: '0.00' },
        { accountCode: '2120', description: 'Accrued utilities', debit: '0.00', credit: '850.00' },
      ],
      repeat: { endMonth: 6, endDay: 28, autoReverse: true },
    },
    {
      ref: 'PR-M6', entry: 'IMPORT', narration: 'Payroll — {M6} {Y6}', month: 6, day: 25,
      lines: [
        { accountCode: '5200', description: null, debit: '9800.00', credit: '0.00' },
        { accountCode: '6100', description: null, debit: '3200.00', credit: '0.00' },
        { accountCode: '2160', description: null, debit: '0.00', credit: '13000.00' },
      ],
      repeat: null,
    },
  ],

  bankRules: [
    {
      name: 'Monthly bank service charge', priority: 100, direction: 'OUT', memoContains: 'SERVICE CHARGE',
      amountMinCents: null, amountMaxCents: 10000, bankAccountCode: '1110', targetAccountCode: '6600',
      description: 'Bank service charge',
    },
    {
      name: 'Interest on operating account', priority: 110, direction: 'IN', memoContains: 'INTEREST PAID',
      amountMinCents: null, amountMaxCents: null, bankAccountCode: '1110', targetAccountCode: '4300',
      description: 'Bank interest',
    },
  ],

  extraVendors: [
    {
      key: 'lakeshore-power',
      name: 'Lakeshore Power & Water',
      email: 'billing@lakeshorepw.example',
      phone: '+1-555-0488',
      address: '60 Harbor Utility Way, Sandusky, OH 44870',
      taxNumber: 'US-34-6620118',
      expenseAccount: '6110',
    },
  ],

  depositApplications: [{ depositRef: 'D1', documentRef: 'I20', day: 22, amount: '4090.00' }],

  periodCloses: [
    { afterMonth: 5, closeMonths: [1, 2, 3, 4] },
    { afterMonth: 6, closeMonths: [5] },
  ],
};

/** Replaces `{M5}`/`{M6}` with the month's English name and `{Y6}` with month 6's calendar year. */
export function resolveTokens(anchor: AnchorMonth, text: string): string {
  return text
    .replaceAll('{M5}', monthName(anchor, 5))
    .replaceAll('{M6}', monthName(anchor, 6))
    .replaceAll('{Y6}', String(calendarYear(anchor, 6)));
}

/** A document's lines; a single-line document synthesises one from its own fields. */
export function documentLines(doc: DatasetDocument): DatasetLine[] {
  if (doc.lines !== undefined) return doc.lines;
  return [
    {
      itemCode: null,
      description: doc.lineDescription,
      quantity: '1',
      unitPrice: doc.total,
      accountCode: doc.accountCode,
    },
  ];
}

/** The six original vendors plus the one added by form in month 6. */
export function allVendors(): DatasetVendor[] {
  return [...WALKTHROUGH_DATASET.vendors, ...WALKTHROUGH_DATASET.extraVendors];
}
