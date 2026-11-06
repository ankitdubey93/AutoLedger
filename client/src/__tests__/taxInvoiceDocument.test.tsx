import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import InvoiceDocument from '../Pages/sales/InvoiceDocument';
import { SAMPLE_INVOICE } from '../Pages/sales/sampleInvoice';
import type { InvoiceSettings } from '../services/fetchServices';

const settings: InvoiceSettings = {
  numberPrefix: 'INV-',
  numberPadding: 6,
  nextNumber: 1,
  defaultDueDays: 30,
  defaultTaxRateBp: 0,
  taxLabel: 'GST',
  receivableAccountId: null,
  defaultRevenueAccountId: null,
  taxPayableAccountId: null,
  showTaxNumber: true,
  showBusinessNumber: true,
  showLegalName: true,
  billingAddress: null,
  paymentTerms: null,
  footerNotes: null,
  accentColor: '#2563eb',
  templateId: 'classic',
  documentTitle: 'INVOICE',
  fontFamily: 'sans',
  density: 'comfortable',
  showLogo: true,
  showOrgAddress: true,
  showPaymentTerms: true,
  showDueDate: true,
  bankDetails: null,
  quotePrefix: 'QU-',
  quoteNextNumber: 1,
  purchaseQuotePrefix: 'PQ-',
  purchaseQuoteNextNumber: 1,
  defaultQuoteValidityDays: 30,
  defaultQuoteTerms: null,
  remindersEnabled: false,
  reminderOffsetsDays: [7, 14, 30],
  quoteAcceptanceRequiresCode: false,
  customerDepositAccountId: null,
  supplierPrepaymentAccountId: null,
  configured: true,
};

const base = {
  invoice: SAMPLE_INVOICE,
  settings: { ...settings, documentTitle: 'INVOICE', showTaxNumber: true, taxLabel: 'Tax' },
  profile: null,
  organizationName: 'Harbour Bakery',
  taxNumber: '51 824 753 556',
  businessNumber: null,
  legalName: null,
  baseCurrency: SAMPLE_INVOICE.currencyCode,
  logoSrc: null,
  preview: true,
};

describe('InvoiceDocument (Phase 49e)', () => {
  it('stays as configured for a generic organization', () => {
    render(<InvoiceDocument {...base} />);
    expect(screen.getByText('INVOICE')).toBeInTheDocument();
    expect(screen.getByText(/Tax no\. 51 824 753 556/)).toBeInTheDocument();
    expect(screen.queryByText(/Total includes GST/)).not.toBeInTheDocument();
  });

  it('says Tax Invoice with the ABN for a registered Australian seller, overriding the template title', () => {
    render(<InvoiceDocument {...base} australian={{ registered: true, abn: '51 824 753 556', legalName: 'Harbour Bakery Pty Ltd' }} />);
    expect(screen.getByText('Tax Invoice')).toBeInTheDocument();
    expect(screen.getByText('ABN 51 824 753 556')).toBeInTheDocument();
    expect(screen.getByText('Harbour Bakery Pty Ltd')).toBeInTheDocument();
    expect(screen.getByText('GST')).toBeInTheDocument();
    expect(screen.getByText(/Total includes GST/)).toBeInTheDocument();
  });

  it('never says Tax Invoice for an unregistered seller', () => {
    render(<InvoiceDocument {...base} australian={{ registered: false, abn: null, legalName: null }} />);
    expect(screen.queryByText('Tax Invoice')).not.toBeInTheDocument();
    expect(screen.getByText('Invoice')).toBeInTheDocument();
    expect(screen.queryByText(/Total includes GST/)).not.toBeInTheDocument();
  });
});
