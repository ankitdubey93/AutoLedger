import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import PlaceholderPicker from '../components/placeholders/PlaceholderPicker';
import PlaceholderHints from '../components/placeholders/PlaceholderHints';
import { usePlaceholderTarget } from '../utils/usePlaceholderTarget';
import InvoiceDocument from '../Pages/sales/InvoiceDocument';
import StatementDocument from '../Pages/statements/StatementDocument';
import { SAMPLE_INVOICE } from '../Pages/sales/sampleInvoice';
import { sampleStatement } from '../Pages/statements/sampleStatement';
import type { InvoiceSettings, StatementSettings } from '../services/fetchServices';

/**
 * Phase 40 — the placeholder UI: inserting at the caret of whichever field
 * was last focused, the preview and near-miss hints, and filling the
 * template's settings text as the invoice and statement documents render.
 */

function Harness() {
  const [subject, setSubject] = useState('Hello ');
  const [body, setBody] = useState('Rent for  please');
  const target = usePlaceholderTarget('body');
  return (
    <div>
      <input aria-label="Subject" {...target.bind('subject', setSubject)} value={subject} onChange={(e) => setSubject(e.target.value)} />
      <textarea aria-label="Body" {...target.bind('body', setBody)} value={body} onChange={(e) => setBody(e.target.value)} />
      <PlaceholderPicker surface="INVOICE" onInsert={target.insert} />
      <PlaceholderHints text={[subject, body]} surface="INVOICE" preview={{ date: '2026-10-10', contactName: 'Acme' }} />
    </div>
  );
}

describe('PlaceholderPicker + usePlaceholderTarget', () => {
  it('inserts at the caret of the last-focused field and keeps the caret after the token', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const body = screen.getByLabelText<HTMLTextAreaElement>('Body');
    const subject = screen.getByLabelText<HTMLInputElement>('Subject');

    await user.click(body);
    body.setSelectionRange(9, 9); // between "Rent for " and " please"
    await user.click(screen.getByRole('button', { name: 'Insert placeholder' }));
    await user.click(screen.getByRole('menuitem', { name: /^Month/ }));
    expect(body).toHaveValue('Rent for [Month] please');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(body).toHaveFocus();
    expect(body.selectionStart).toBe(16);

    await user.click(subject);
    await user.click(screen.getByRole('button', { name: 'Insert placeholder' }));
    await user.click(screen.getByRole('menuitem', { name: /^Next month/ }));
    expect(subject).toHaveValue('Hello [Month+1]');
  });

  it('previews the filled text and hints at near misses without blocking', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByTestId('placeholder-preview')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Subject'), '[[Contact Name] [[Mnth]');
    expect(screen.getByTestId('placeholder-preview')).toHaveTextContent('Preview: Hello Acme [Mnth]');
    expect(screen.getByText('[Mnth] — did you mean [Month]?')).toBeInTheDocument();
  });

  it('only offers what the surface has', async () => {
    const user = userEvent.setup();
    render(<PlaceholderPicker surface="JOURNAL" onInsert={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Insert placeholder' }));
    expect(screen.getByRole('menuitem', { name: /^Month/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /^Contact Name/ })).not.toBeInTheDocument();
  });
});

const invoiceSettings: InvoiceSettings = {
  numberPrefix: 'INV-',
  numberPadding: 6,
  nextNumber: 1,
  defaultDueDays: 30,
  defaultTaxRateBp: 0,
  taxLabel: 'Tax',
  receivableAccountId: null,
  defaultRevenueAccountId: null,
  taxPayableAccountId: null,
  showTaxNumber: false,
  showBusinessNumber: false,
  showLegalName: false,
  billingAddress: null,
  paymentTerms: null,
  footerNotes: 'Thanks [Contact Name] — [Invoice Number], [Month] [Year]',
  accentColor: '#2563eb',
  templateId: 'classic',
  documentTitle: 'INVOICE',
  fontFamily: 'sans',
  density: 'comfortable',
  showLogo: false,
  showOrgAddress: false,
  showPaymentTerms: true,
  showDueDate: true,
  bankDetails: 'Pay [Organisation Name] by [Due Date]',
  quotePrefix: 'QU-',
  quoteNextNumber: 1,
  purchaseQuotePrefix: 'PQ-',
  purchaseQuoteNextNumber: 1,
  defaultQuoteValidityDays: 30,
  defaultQuoteTerms: null,
  quoteAcceptanceRequiresCode: false,
  customerDepositAccountId: null,
  supplierPrepaymentAccountId: null,
  configured: true,
};

function renderInvoice(invoice: typeof SAMPLE_INVOICE) {
  return render(
    <MemoryRouter>
      <InvoiceDocument
        invoice={invoice}
        settings={invoiceSettings}
        profile={null}
        organizationName="Acme Ltd"
        taxNumber={null}
        businessNumber={null}
        legalName={null}
        baseCurrency="USD"
        logoSrc={null}
      />
    </MemoryRouter>,
  );
}

describe('InvoiceDocument fills placeholders', () => {
  it("fills the template's footer and bank details per invoice", () => {
    renderInvoice(SAMPLE_INVOICE);
    expect(screen.getByText('Thanks Harbor Point Fabrication — INV-000042, June 2026')).toBeInTheDocument();
    expect(screen.getByText('Pay Acme Ltd by 1 Jul 2026')).toBeInTheDocument();
  });

  it("never re-fills an issued invoice's own notes", () => {
    renderInvoice({ ...SAMPLE_INVOICE, notes: 'Literal [Month] from a customer' });
    expect(screen.getByText('Literal [Month] from a customer')).toBeInTheDocument();
  });

  it("previews a draft's notes and lines, keeping [Invoice Number] for issue", () => {
    renderInvoice({
      ...SAMPLE_INVOICE,
      status: 'DRAFT',
      invoiceNumber: null,
      notes: 'For [Month] — [Invoice Number]',
      lines: SAMPLE_INVOICE.lines.map((line, i) => (i === 0 ? { ...line, description: 'Retainer [Month+1]' } : line)),
    });
    expect(screen.getByText('For June — [Invoice Number]')).toBeInTheDocument();
    expect(screen.getByText('Retainer July')).toBeInTheDocument();
    expect(screen.getByText('Thanks Harbor Point Fabrication — [Invoice Number], June 2026')).toBeInTheDocument();
  });
});

describe('StatementDocument fills placeholders', () => {
  const settings: StatementSettings = {
    templateId: 'classic',
    documentTitle: 'STATEMENT',
    defaultType: 'OUTSTANDING',
    showLogo: false,
    showOrgAddress: false,
    showAgingSummary: false,
    showRemittance: true,
    footerNotes: '[Contact Name] owes [Balance Due] at [Statement Date]',
    accentColor: '#2563eb',
    configured: true,
  };

  it('fills the footer from the statement it renders', () => {
    const statement = sampleStatement('OUTSTANDING');
    render(
      <StatementDocument
        statement={statement}
        settings={settings}
        organizationName="Acme Ltd"
        orgAddressLines={[]}
        baseCurrency="USD"
        logoSrc={null}
        bankDetails={null}
      />,
    );
    expect(screen.getByText(`${statement.party.name} owes USD 3,300.00 at 30 Sept 2026`)).toBeInTheDocument();
  });
});
