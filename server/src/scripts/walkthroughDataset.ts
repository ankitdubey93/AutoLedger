import type { WalkthroughMonth } from './walkthroughDates.js';

/**
 * The source-of-truth data for `walkthrough/` — a hand-enterable, four-month
 * accounting scenario for one fictional business, Harbor Point Fabrication.
 * Months 1–3 are ordinary trading; month 4 (Phase 26) is "Returns &
 * adjustments" — a sales return (credit note), a supplier return (debit
 * note), and a price allowance on an already-paid invoice that sits as
 * unapplied credit until it is applied to the customer's next invoice.
 *
 * Unlike `sandbox/` (replayed through services by a seeder, its bank
 * statement generated from payments the seeder itself created), this data
 * is typed in by a human, so every amount and every date is fixed here, not
 * derived at load time. See `sandbox/README.md`'s note distinguishing the
 * two.
 *
 * Money is a decimal string (`"14500.00"`), parsed through `parseMoneyText`
 * wherever it is used — never a float, matching the file-boundary discipline
 * `sandbox/README.md` documents for its own fixtures (guardrails rule 3).
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
  | 'REVIEW_REMAINDER';

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
}

export interface DatasetNoiseLine {
  month: WalkthroughMonth;
  day: number;
  description: string;
  /** Decimal string, signed: "75000.00" or "-45.00". */
  amount: string;
  resolution: { kind: 'POST_JOURNAL'; accountCode: string } | { kind: 'IGNORE' };
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
  ],

  bills: [
    // --- Month 1 ---
    {
      ref: 'B1', counterpartyKey: 'northgate-realty', month: 1, day: 1, dueDays: 0,
      accountCode: '6110', lineDescription: 'Shop rent — June',
      total: '9100.00', vendorReference: 'NR-M1-RENT', tier: 'AUTO_0', anonMemo: null, remainder: null,
    },
    {
      ref: 'B2', counterpartyKey: 'cloudspan', month: 1, day: 4, dueDays: 0,
      accountCode: '6120', lineDescription: 'ERP hosting — June',
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
      accountCode: '5300', lineDescription: 'Outbound freight — June runs',
      total: '2340.00', vendorReference: 'CWF-0912', tier: 'REVIEW_ANON',
      anonMemo: 'BILL PAY 7734 REF 5590', remainder: null,
    },
    // --- Month 2 ---
    {
      ref: 'B6', counterpartyKey: 'beacon-media', month: 2, day: 5, dueDays: 0,
      accountCode: '6400', lineDescription: 'Trade publication placement — July',
      total: '4100.00', vendorReference: 'BM-2207', tier: 'AUTO_0', anonMemo: null, remainder: null,
    },
    {
      ref: 'B7', counterpartyKey: 'northgate-realty', month: 2, day: 1, dueDays: 0,
      accountCode: '6110', lineDescription: 'Shop rent — July',
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
      accountCode: '6120', lineDescription: 'ERP hosting — August',
      total: '3480.00', vendorReference: 'CS-45210', tier: 'AUTO_2', anonMemo: null, remainder: null,
    },
    {
      ref: 'B11', counterpartyKey: 'crosswind-freight', month: 3, day: 16, dueDays: 0,
      accountCode: '5300', lineDescription: 'Outbound freight — August runs',
      total: '3100.00', vendorReference: 'CWF-1044', tier: 'REVIEW_LATE', anonMemo: null, remainder: null,
    },
    // --- Month 4: returns & adjustments ---
    {
      ref: 'B12', counterpartyKey: 'ironclad-supply', month: 4, day: 4, dueDays: 0,
      accountCode: '5100', lineDescription: 'Steel stock, 40mm — 80 bars × 150.00',
      total: '12000.00', vendorReference: 'INV-IC-9120', tier: 'REVIEW_LATE', anonMemo: null, remainder: null,
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
};
