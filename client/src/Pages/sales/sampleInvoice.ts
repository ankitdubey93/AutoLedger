import type { Invoice, InvoiceLine } from '../../services/fetchServices';

/**
 * A fully-formed sample invoice for the template editor's live preview
 * (Phase 30). It is never sent to the server and never persisted.
 *
 * Every amount is integer cents (guardrails rule 3), and the totals are
 * derived by hand from the lines below, not approximated:
 *
 *   Consulting   12 h  x 15,000 = 180,000 net, 10% tax = 18,000
 *   Site survey   1    x 85,000 =  85,000 net, 10% tax =  8,500
 *   Materials     4    x 22,500 =  90,000 net,  0% tax =      0
 *                                 -------          ------
 *   subtotal 355,000 · tax 26,500 · total 381,500
 *
 * Quantities are milli-units (12 h = 12,000), matching `InvoiceLine`.
 * 12,000 x 15,000 / 1,000 is exact, so no rounding rule is involved.
 */

export const SAMPLE_CUSTOMER_NAME = 'Harbor Point Fabrication';
export const SAMPLE_CUSTOMER_ADDRESS = '14 Quay Street\nHarbor Point 4000';

const SAMPLE_REVENUE_ACCOUNT_ID = '00000000-0000-4000-8000-000000000004';

const lines: InvoiceLine[] = [
  {
    id: 'sample-line-1',
    lineNumber: 1,
    description: 'Consulting — 12 h @ 15,000 cents',
    quantityMilli: 12_000,
    unitPriceCents: 15_000,
    revenueAccountId: SAMPLE_REVENUE_ACCOUNT_ID,
    revenueAccountCode: '4100',
    revenueAccountName: 'Service Revenue',
    taxRateBp: 1000,
    netCents: 180_000,
    taxCents: 18_000,
    itemId: null,
  },
  {
    id: 'sample-line-2',
    lineNumber: 2,
    description: 'Site survey — 1 @ 85,000 cents',
    quantityMilli: 1_000,
    unitPriceCents: 85_000,
    revenueAccountId: SAMPLE_REVENUE_ACCOUNT_ID,
    revenueAccountCode: '4100',
    revenueAccountName: 'Service Revenue',
    taxRateBp: 1000,
    netCents: 85_000,
    taxCents: 8_500,
    itemId: null,
  },
  {
    id: 'sample-line-3',
    lineNumber: 3,
    description: 'Materials — 4 @ 22,500 cents',
    quantityMilli: 4_000,
    unitPriceCents: 22_500,
    revenueAccountId: SAMPLE_REVENUE_ACCOUNT_ID,
    revenueAccountCode: '4100',
    revenueAccountName: 'Service Revenue',
    taxRateBp: 0,
    netCents: 90_000,
    taxCents: 0,
    itemId: null,
  },
];
lines.forEach((line) => Object.freeze(line));
// Freezing for its side effect: the return type is `readonly`, which `Invoice.lines` is not.
Object.freeze(lines);

export const SAMPLE_INVOICE: Invoice = Object.freeze({
  id: 'sample-invoice',
  invoiceNumber: 'INV-000042',
  status: 'ISSUED',
  customerId: 'sample-customer',
  customerName: SAMPLE_CUSTOMER_NAME,
  issueDate: '2026-06-01',
  dueDate: '2026-07-01',
  currencyCode: 'USD',
  customerNameSnapshot: SAMPLE_CUSTOMER_NAME,
  customerAddressSnapshot: SAMPLE_CUSTOMER_ADDRESS,
  customerTaxNumberSnapshot: null,
  notes: null,
  paymentTerms: 'Net 30',
  paymentTermsCode: null,
  subtotalCents: 355_000,
  taxCents: 26_500,
  totalCents: 381_500,
  fxRate: '1.00000000',
  baseSubtotalCents: 355_000,
  baseTaxCents: 26_500,
  baseTotalCents: 381_500,
  journalEntryId: null,
  voidJournalEntryId: null,
  issuedAt: '2026-06-01T09:00:00.000Z',
  voidedAt: null,
  createdBy: 'sample-user',
  createdByName: null,
  createdAt: '2026-06-01T09:00:00.000Z',
  updatedAt: '2026-06-01T09:00:00.000Z',
  lines,
  allocatedCents: 0,
  creditedCents: 0,
  amountDueCents: 381_500,
  settlementStatus: 'UNPAID',
});
