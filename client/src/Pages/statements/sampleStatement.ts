import type { PartyStatement, StatementType } from '../../services/fetchServices';

/**
 * Fixed sample data for the statement template editor's live preview
 * (Phase 39a) — the statement counterpart of `sampleInvoice.ts`. Amounts are
 * consistent: opening 1,200.00 + 5,350.00 charged − 3,000.00 paid − 250.00
 * credited = 3,300.00 closing = the open items' outstanding.
 */

const ROWS: PartyStatement['rows'] = [
  {
    journalEntryId: 'sample-je-1',
    entryDate: '2026-09-03',
    kind: 'INVOICE',
    documentId: 'sample-inv-2',
    documentNumber: 'INV-000102',
    debitCents: 350000,
    creditCents: 0,
    runningBalanceCents: 470000,
    allocations: [],
  },
  {
    journalEntryId: 'sample-je-2',
    entryDate: '2026-09-12',
    kind: 'PAYMENT',
    documentId: 'sample-pay-1',
    documentNumber: 'RCPT-2209',
    debitCents: 0,
    creditCents: 300000,
    runningBalanceCents: 170000,
    allocations: [
      { documentId: 'sample-inv-1', documentNumber: 'INV-000098', baseAmountCents: 120000 },
      { documentId: 'sample-inv-2', documentNumber: 'INV-000102', baseAmountCents: 180000 },
    ],
  },
  {
    journalEntryId: 'sample-je-3',
    entryDate: '2026-09-18',
    kind: 'CREDIT_NOTE',
    documentId: 'sample-cn-1',
    documentNumber: 'CN-000007',
    debitCents: 0,
    creditCents: 25000,
    runningBalanceCents: 145000,
    allocations: [],
  },
  {
    journalEntryId: 'sample-je-4',
    entryDate: '2026-09-24',
    kind: 'INVOICE',
    documentId: 'sample-inv-3',
    documentNumber: 'INV-000110',
    debitCents: 185000,
    creditCents: 0,
    runningBalanceCents: 330000,
    allocations: [],
  },
];

const BASE: Omit<PartyStatement, 'type' | 'from' | 'openingBalanceCents' | 'rows'> = {
  party: {
    kind: 'CUSTOMER',
    id: 'sample-customer',
    name: 'Northwind Traders',
    email: 'accounts@northwind.example',
    billingAddress: '12 Harbour Road\nPort Melbourne VIC 3207',
    taxNumber: null,
  },
  statementDate: '2026-09-30',
  periodDebitCents: 535000,
  periodCreditCents: 325000,
  closingBalanceCents: 330000,
  openItems: [
    {
      documentKind: 'INVOICE',
      documentId: 'sample-inv-2',
      documentNumber: 'INV-000102',
      documentDate: '2026-09-03',
      dueDate: '2026-09-17',
      currencyCode: 'USD',
      totalCents: 350000,
      baseTotalCents: 350000,
      baseOutstandingCents: 145000,
      daysOverdue: 13,
      bucket: 'D1_30',
    },
    {
      documentKind: 'INVOICE',
      documentId: 'sample-inv-3',
      documentNumber: 'INV-000110',
      documentDate: '2026-09-24',
      dueDate: '2026-10-24',
      currencyCode: 'USD',
      totalCents: 185000,
      baseTotalCents: 185000,
      baseOutstandingCents: 185000,
      daysOverdue: 0,
      bucket: 'CURRENT',
    },
  ],
  outstandingCents: 330000,
  overdueCents: 145000,
  aging: { CURRENT: 185000, D1_30: 145000, D31_60: 0, D61_90: 0, D90_PLUS: 0 },
};

export function sampleStatement(type: StatementType): PartyStatement {
  return type === 'ACTIVITY'
    ? { ...BASE, type, from: '2026-09-01', openingBalanceCents: 120000, rows: ROWS }
    : { ...BASE, type, from: null, openingBalanceCents: null, rows: [] };
}
