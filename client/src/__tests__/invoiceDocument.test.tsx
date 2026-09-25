import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { OrgProvider } from '../context/OrgContext';
import { LedgerSettingsProvider } from '../context/LedgerSettingsContext';
import InvoiceDetailPage from '../Pages/sales/InvoiceDetailPage';
import type { Invoice, InvoiceSettings } from '../services/fetchServices';

/**
 * Characterisation of the PRINTED invoice document (Phase 30, Step 11).
 *
 * ledgerCoreInvoices.test.tsx only asserts the detail page's actions, so it
 * says nothing about what the document body renders. These cases pin what the
 * markup renders today, written against the page BEFORE the document was
 * extracted into InvoiceDocument. They must keep passing, unedited, once the
 * page renders through InvoiceDocument (Step 12) — that is the proof the
 * extraction was faithful.
 *
 * The harness and fixtures are deliberately copied from
 * ledgerCoreInvoices.test.tsx rather than imported from it.
 *
 * Every fixture invoice is in EUR against a USD base so the "≈ USD" row only
 * appears once LedgerSettingsContext has resolved; waiting for it is how an
 * "absent" assertion below avoids passing merely because data had not loaded.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const invoiceSettings: InvoiceSettings = {
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
  configured: true,
};

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    invoiceNumber: 'INV-000042',
    status: 'ISSUED',
    customerId: 'cust-1',
    customerName: 'Northwind Traders',
    issueDate: '2026-06-01',
    dueDate: '2026-06-30',
    currencyCode: 'EUR',
    customerNameSnapshot: 'Northwind Traders',
    customerAddressSnapshot: '1 Harbour Road\nSpringfield',
    customerTaxNumberSnapshot: 'CUST-TAX-9',
    notes: null,
    paymentTerms: null,
    paymentTermsCode: null,
    subtotalCents: 35000,
    taxCents: 4500,
    totalCents: 39500,
    fxRate: '1.10000000',
    baseSubtotalCents: 38500,
    baseTaxCents: 4950,
    baseTotalCents: 43450,
    journalEntryId: 'entry-1',
    voidJournalEntryId: null,
    issuedAt: new Date().toISOString(),
    voidedAt: null,
    createdBy: 'u1',
    createdByName: 'Alice',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lines: [
      {
        id: 'line-1',
        lineNumber: 1,
        description: 'Consulting hours',
        quantityMilli: 2500,
        unitPriceCents: 10000,
        revenueAccountId: 'acc-4100',
        revenueAccountCode: '4100',
        revenueAccountName: 'Product Revenue',
        taxRateBp: 1800,
        netCents: 25000,
        taxCents: 4500,
        itemId: null,
      },
      {
        id: 'line-2',
        lineNumber: 2,
        description: 'Site survey (tax-free)',
        quantityMilli: 1000,
        unitPriceCents: 10000,
        revenueAccountId: 'acc-4200',
        revenueAccountCode: '4200',
        revenueAccountName: 'Service Revenue',
        taxRateBp: 0,
        netCents: 10000,
        taxCents: 0,
        itemId: null,
      },
    ],
    allocatedCents: 10000,
    creditedCents: 0,
    amountDueCents: 29500,
    settlementStatus: 'PARTIALLY_PAID',
    ...overrides,
  };
}

function makeSession(org: { taxNumber: string | null; businessNumber: string | null }) {
  return {
    success: true,
    user: {
      id: 'u1',
      name: 'Ada',
      email: 'ada@example.com',
      emailVerified: false,
      createdAt: new Date().toISOString(),
    },
    organization: {
      id: 'o1',
      name: 'Acme',
      slug: 'acme',
      baseCurrency: 'USD',
      taxNumber: org.taxNumber,
      businessNumber: org.businessNumber,
      createdAt: new Date().toISOString(),
    },
    role: 'OWNER',
    memberships: [
      { orgId: 'o1', orgName: 'Acme', orgSlug: 'acme', role: 'OWNER', joinedAt: new Date().toISOString() },
    ],
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  };
}

const ledgerSettings = {
  organizationName: 'Acme',
  legalName: 'Acme Inc.',
  baseCurrency: 'USD',
  fiscalYearStartMonth: 1,
  fiscalYearStartDay: 1,
  booksStartDate: '2026-01-01',
  industry: null,
  timezone: 'UTC',
  cashAccountId: null,
  onboardedAt: new Date().toISOString(),
  currentFiscalYear: { startDate: '2026-01-01', endDate: '2026-12-31', label: 'FY 2026' },
  baseCurrencyLocked: false,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Scenario {
  invoice?: Partial<Invoice>;
  settings?: Partial<InvoiceSettings>;
  org?: { taxNumber: string | null; businessNumber: string | null };
}

/** Renders the untouched detail page and waits until every async input has landed. */
async function renderDocument(scenario: Scenario = {}) {
  const invoice = makeInvoice(scenario.invoice);
  const settings: InvoiceSettings = { ...invoiceSettings, ...scenario.settings };
  const org = scenario.org ?? { taxNumber: 'TAX-123', businessNumber: 'BUS-456' };

  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, makeSession(org)));
    if (url.includes('/ledger-core/settings/invoicing')) {
      return Promise.resolve(jsonResponse(200, { success: true, invoiceSettings: settings }));
    }
    if (url.includes('/ledger-core/settings')) {
      return Promise.resolve(jsonResponse(200, { success: true, settings: ledgerSettings }));
    }
    if (url.endsWith(`/ledger-core/invoices/${invoice.id}`)) {
      return Promise.resolve(jsonResponse(200, { success: true, invoice }));
    }
    if (url.includes('/ledger-core/payments')) {
      return Promise.resolve(
        jsonResponse(200, { success: true, count: 0, totalCount: 0, currentPage: 1, totalPages: 1, payments: [] }),
      );
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });

  const view = render(
    <MemoryRouter initialEntries={[`/invoices/${invoice.id}`]}>
      <AuthProvider>
        <OrgProvider>
          <LedgerSettingsProvider>
            <Routes>
              <Route path="/invoices/:invoiceId" element={<InvoiceDetailPage />} />
            </Routes>
          </LedgerSettingsProvider>
        </OrgProvider>
      </AuthProvider>
    </MemoryRouter>,
  );

  await screen.findByText('Bill to');
  // Organization (session) and ledger settings both resolved: the org name is
  // only rendered from useOrg(), the "≈ USD" row only from useLedgerSettings().
  await screen.findByText('Acme');
  await screen.findByText(/^≈ USD \(at 1\.10000000\)$/);
  return view;
}

/** The bordered document panel — the ancestor of "Bill to" that carries the accent. */
function documentPanel(): HTMLElement {
  const panel = screen.getByText('Bill to').closest('.rounded-lg');
  if (!(panel instanceof HTMLElement)) throw new Error('document panel not found');
  return panel;
}

describe('printed invoice document (characterisation)', () => {
  it('renders the invoice number in the document as well as the page header', async () => {
    await renderDocument();
    // The no-print header h2 and the document's own number.
    expect(screen.getAllByText('INV-000042')).toHaveLength(2);
    expect(within(documentPanel()).getByText('INV-000042')).toBeInTheDocument();
  });

  it('renders DRAFT in the document for an invoice with no number yet', async () => {
    await renderDocument({ invoice: { status: 'DRAFT', invoiceNumber: null } });
    expect(within(documentPanel()).getByText('DRAFT')).toBeInTheDocument();
  });

  it('renders the issue and due dates', async () => {
    await renderDocument();
    const panel = within(documentPanel());
    expect(panel.getByText('Issued 2026-06-01')).toBeInTheDocument();
    expect(panel.getByText('Due 2026-06-30')).toBeInTheDocument();
  });

  it('renders the customer snapshot: name, address and tax number', async () => {
    await renderDocument();
    const panel = within(documentPanel());
    expect(panel.getByText('Bill to')).toBeInTheDocument();
    expect(panel.getByText('Northwind Traders')).toBeInTheDocument();
    expect(panel.getByText(/1 Harbour Road/)).toBeInTheDocument();
    expect(panel.getByText('Tax no. CUST-TAX-9')).toBeInTheDocument();
  });

  it('omits the customer address and tax number when the snapshot has none', async () => {
    await renderDocument({ invoice: { customerAddressSnapshot: null, customerTaxNumberSnapshot: null } });
    const panel = within(documentPanel());
    expect(panel.queryByText(/1 Harbour Road/)).toBeNull();
    expect(panel.queryByText('Tax no. CUST-TAX-9')).toBeNull();
  });

  it('renders every line item: description, quantity, unit price, account code, tax rate and amount', async () => {
    await renderDocument();
    const table = within(within(documentPanel()).getByRole('table'));
    expect(table.getByText('Consulting hours')).toBeInTheDocument();
    expect(table.getByText('Site survey (tax-free)')).toBeInTheDocument();

    const rows = table.getAllByRole('row');
    // header + two lines
    expect(rows).toHaveLength(3);
    const first = within(rows[1]!);
    expect(first.getByText('2.5')).toBeInTheDocument(); // formatQuantity(2500)
    expect(first.getByText('100.00')).toBeInTheDocument(); // formatCents(10000)
    expect(first.getByText('4100')).toBeInTheDocument();
    expect(first.getByText('18%')).toBeInTheDocument(); // formatRate(1800)
    expect(first.getByText('295.00')).toBeInTheDocument(); // net + tax = 29500

    const second = within(rows[2]!);
    expect(second.getByText('1')).toBeInTheDocument();
    expect(second.getByText('4200')).toBeInTheDocument();
    expect(second.getByText('—')).toBeInTheDocument(); // no tax on this line
    expect(second.getByText('100.00', { selector: 'td:last-child' })).toBeInTheDocument();
  });

  it('links each line to its revenue account', async () => {
    await renderDocument();
    const link = within(documentPanel()).getByRole('link', { name: '4100' });
    expect(link).toHaveAttribute('href', '/accounts/acc-4100');
  });

  it('renders the subtotal, the tax label with its amount, and the total with its currency', async () => {
    await renderDocument();
    const panel = within(documentPanel());
    expect(panel.getByText('Subtotal').nextElementSibling).toHaveTextContent(/^350\.00$/);
    // taxLabel from settings, not the literal "Tax"
    expect(panel.getByText('GST').nextElementSibling).toHaveTextContent(/^45\.00$/);
    expect(panel.getByText('Total').nextElementSibling).toHaveTextContent(/^395\.00 EUR$/);
  });

  it('renders the base-currency equivalent only when the invoice currency differs from base', async () => {
    await renderDocument();
    const fx = within(documentPanel()).getByText(/^≈ USD \(at 1\.10000000\)$/);
    expect(fx.nextElementSibling).toHaveTextContent(/^434\.50$/);
  });

  it('renders no base-currency row for an invoice already in the base currency', async () => {
    // A USD invoice: the row never appears, so wait on the org name plus the
    // ledger-settings-dependent "Acme Inc." legal name instead.
    fetchMock.mockReset();
    const invoice = makeInvoice({ currencyCode: 'USD', fxRate: '1.00000000' });
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/auth/check')) {
        return Promise.resolve(jsonResponse(200, makeSession({ taxNumber: 'TAX-123', businessNumber: null })));
      }
      if (url.includes('/ledger-core/settings/invoicing')) {
        return Promise.resolve(jsonResponse(200, { success: true, invoiceSettings }));
      }
      if (url.includes('/ledger-core/settings')) {
        return Promise.resolve(jsonResponse(200, { success: true, settings: ledgerSettings }));
      }
      if (url.endsWith(`/ledger-core/invoices/${invoice.id}`)) {
        return Promise.resolve(jsonResponse(200, { success: true, invoice }));
      }
      if (url.includes('/ledger-core/payments')) {
        return Promise.resolve(
          jsonResponse(200, { success: true, count: 0, totalCount: 0, currentPage: 1, totalPages: 1, payments: [] }),
        );
      }
      return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
    });
    render(
      <MemoryRouter initialEntries={[`/invoices/${invoice.id}`]}>
        <AuthProvider>
          <OrgProvider>
            <LedgerSettingsProvider>
              <Routes>
                <Route path="/invoices/:invoiceId" element={<InvoiceDetailPage />} />
              </Routes>
            </LedgerSettingsProvider>
          </OrgProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    await screen.findByText('Acme Inc.');
    await screen.findByText('Acme');
    expect(within(documentPanel()).queryByText(/^≈/)).toBeNull();
  });

  it('renders Paid and Amount due on an issued invoice, and Credits applied only when there are credits', async () => {
    await renderDocument();
    let panel = within(documentPanel());
    expect(panel.getByText('Paid').nextElementSibling).toHaveTextContent(/^100\.00$/);
    expect(panel.getByText('Amount due').nextElementSibling).toHaveTextContent(/^295\.00$/);
    expect(panel.queryByText('Credits applied')).toBeNull();
  });

  it('renders Credits applied when the invoice has been credited', async () => {
    await renderDocument({ invoice: { creditedCents: 5000, amountDueCents: 24500 } });
    const panel = within(documentPanel());
    expect(panel.getByText('Credits applied').nextElementSibling).toHaveTextContent(/^50\.00$/);
    expect(panel.getByText('Amount due').nextElementSibling).toHaveTextContent(/^245\.00$/);
  });

  it('renders no Paid / Amount due block on a draft', async () => {
    await renderDocument({ invoice: { status: 'DRAFT', invoiceNumber: null, journalEntryId: null } });
    const panel = within(documentPanel());
    expect(panel.queryByText('Paid')).toBeNull();
    expect(panel.queryByText('Amount due')).toBeNull();
  });

  describe('disclosure toggles', () => {
    it('shows the organization tax number when showTaxNumber is true, and not when false', async () => {
      const { unmount } = await renderDocument({ settings: { showTaxNumber: true } });
      expect(within(documentPanel()).getByText('Tax no. TAX-123')).toBeInTheDocument();
      unmount();

      await renderDocument({ settings: { showTaxNumber: false } });
      expect(within(documentPanel()).queryByText('Tax no. TAX-123')).toBeNull();
    });

    it('omits the tax number line when the organization has none, even with showTaxNumber true', async () => {
      await renderDocument({
        settings: { showTaxNumber: true },
        org: { taxNumber: null, businessNumber: 'BUS-456' },
      });
      expect(within(documentPanel()).queryByText(/^Tax no\. TAX/)).toBeNull();
    });

    it('shows the legal name when showLegalName is true, and not when false', async () => {
      const { unmount } = await renderDocument({ settings: { showLegalName: true } });
      expect(within(documentPanel()).getByText('Acme Inc.')).toBeInTheDocument();
      unmount();

      await renderDocument({ settings: { showLegalName: false } });
      expect(within(documentPanel()).queryByText('Acme Inc.')).toBeNull();
      // the organization name itself is not behind a toggle
      expect(within(documentPanel()).getByText('Acme')).toBeInTheDocument();
    });

    it('shows the business number when showBusinessNumber is true, and not when false', async () => {
      const { unmount } = await renderDocument({ settings: { showBusinessNumber: true } });
      expect(within(documentPanel()).getByText('Business no. BUS-456')).toBeInTheDocument();
      unmount();

      await renderDocument({ settings: { showBusinessNumber: false } });
      expect(within(documentPanel()).queryByText('Business no. BUS-456')).toBeNull();
    });
  });

  describe('free-text blocks', () => {
    it('renders footerNotes when set, and not when null', async () => {
      const { unmount } = await renderDocument({ settings: { footerNotes: 'Thank you for your business.' } });
      expect(within(documentPanel()).getByText('Thank you for your business.')).toBeInTheDocument();
      unmount();

      await renderDocument({ settings: { footerNotes: null } });
      expect(within(documentPanel()).queryByText('Thank you for your business.')).toBeNull();
    });

    it("renders the invoice's own paymentTerms when set, and not when null", async () => {
      const { unmount } = await renderDocument({ invoice: { paymentTerms: 'Net 30 days' } });
      expect(within(documentPanel()).getByText('Payment terms: Net 30 days')).toBeInTheDocument();
      unmount();

      await renderDocument({ invoice: { paymentTerms: null } });
      expect(within(documentPanel()).queryByText(/^Payment terms:/)).toBeNull();
    });

    it("renders the invoice's notes when set, and not when null", async () => {
      const { unmount } = await renderDocument({ invoice: { notes: 'Deposit already received.' } });
      expect(within(documentPanel()).getByText('Deposit already received.')).toBeInTheDocument();
      unmount();

      await renderDocument({ invoice: { notes: null } });
      expect(within(documentPanel()).queryByText('Deposit already received.')).toBeNull();
    });

    it('renders the settings billing address under the organization block when set', async () => {
      const { unmount } = await renderDocument({ settings: { billingAddress: '9 Quay Street\nAuckland' } });
      expect(within(documentPanel()).getByText(/9 Quay Street/)).toBeInTheDocument();
      unmount();

      await renderDocument({ settings: { billingAddress: null } });
      expect(within(documentPanel()).queryByText(/9 Quay Street/)).toBeNull();
    });
  });

  describe('accent colour', () => {
    it('applies settings.accentColor to the top border of the document panel via inline style', async () => {
      await renderDocument({ settings: { accentColor: '#ff5500' } });
      const panel = documentPanel();
      expect(panel).toHaveStyle({ borderTopColor: '#ff5500', borderTopWidth: '4px' });
      // Inline style only — never a class name derived from the colour.
      expect(panel.className).not.toContain('ff5500');
    });
  });
});
