import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { OrgProvider } from '../context/OrgContext';
import { LedgerSettingsProvider } from '../Pages/ledger-core/LedgerSettingsContext';
import InvoicesPage from '../Pages/ledger-core/InvoicesPage';
import NewInvoicePage from '../Pages/ledger-core/NewInvoicePage';
import InvoiceDetailPage from '../Pages/ledger-core/InvoiceDetailPage';
import type { Account, Customer, Invoice, InvoiceSettings } from '../services/fetchServices';

/**
 * The invoice register, the draft editor, and the invoice detail page.
 *
 * InvoicesPage and NewInvoicePage talk to fetchServices directly, like
 * JournalsPage and NewJournalEntryPage — no AuthContext or OrgContext needed.
 * InvoiceDetailPage reads `useOrg()` (for the organization's name and tax
 * numbers) and `useLedgerSettings()` (for the legal name), so it renders
 * under the same provider stack ledgerCoreOnboarding.test.tsx uses.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const account4100: Account = {
  id: 'acc-4100',
  code: '4100',
  name: 'Product Revenue',
  type: 'Revenue',
  parentId: null,
  isPostable: true,
  isActive: true,
  description: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const customer1: Customer = {
  id: 'cust-1',
  name: 'Northwind Traders',
  email: null,
  phone: null,
  billingAddress: null,
  taxNumber: null,
  notes: null,
  isActive: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

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
  showTaxNumber: true,
  showBusinessNumber: false,
  showLegalName: true,
  billingAddress: null,
  paymentTerms: null,
  footerNotes: null,
  accentColor: '#2563eb',
  configured: false,
};

function baseInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    invoiceNumber: null,
    status: 'DRAFT',
    customerId: customer1.id,
    customerName: customer1.name,
    issueDate: '2026-06-01',
    dueDate: '2026-06-30',
    currencyCode: 'USD',
    customerNameSnapshot: customer1.name,
    customerAddressSnapshot: null,
    customerTaxNumberSnapshot: null,
    notes: null,
    paymentTerms: null,
    subtotalCents: 25000,
    taxCents: 4500,
    totalCents: 29500,
    journalEntryId: null,
    voidJournalEntryId: null,
    issuedAt: null,
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
        revenueAccountId: account4100.id,
        revenueAccountCode: account4100.code,
        revenueAccountName: account4100.name,
        taxRateBp: 1800,
        netCents: 25000,
        taxCents: 4500,
      },
    ],
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderInvoicesPage(invoices: Invoice[]) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/ledger-core/invoices')) {
      return Promise.resolve(
        jsonResponse(200, {
          success: true,
          count: invoices.length,
          totalCount: invoices.length,
          currentPage: 1,
          totalPages: 1,
          invoices,
        }),
      );
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });

  return render(
    <MemoryRouter initialEntries={['/app/ledger-core/invoices']}>
      <Routes>
        <Route path="/app/:appSlug/invoices" element={<InvoicesPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function mockNewInvoiceRoutes(createResponse: { status: number; body: unknown }) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.method === 'POST' && url.includes('/ledger-core/invoices')) {
      return Promise.resolve(jsonResponse(createResponse.status, createResponse.body));
    }
    if (url.includes('/ledger-core/customers')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: 1, customers: [customer1] }));
    }
    if (url.includes('/ledger-core/settings/invoicing')) {
      return Promise.resolve(jsonResponse(200, { success: true, invoiceSettings }));
    }
    if (url.includes('/ledger-core/accounts')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: 1, accounts: [account4100] }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderNewInvoicePage() {
  return render(
    <MemoryRouter initialEntries={['/app/ledger-core/invoices/new']}>
      <Routes>
        <Route path="/app/:appSlug/invoices/new" element={<NewInvoicePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const session = {
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
    taxNumber: 'TAX-123',
    businessNumber: null,
    createdAt: new Date().toISOString(),
  },
  role: 'OWNER',
  memberships: [
    { orgId: 'o1', orgName: 'Acme', orgSlug: 'acme', role: 'OWNER', joinedAt: new Date().toISOString() },
  ],
  accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
};

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

function mockDetailRoutes(invoice: Invoice) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.method === 'POST' && url.endsWith('/issue')) {
      return Promise.resolve(
        jsonResponse(200, { success: true, invoice: { ...invoice, status: 'ISSUED', invoiceNumber: 'INV-000001', journalEntryId: 'entry-1' } }),
      );
    }
    if (init?.method === 'POST' && url.endsWith('/void')) {
      return Promise.resolve(
        jsonResponse(200, { success: true, invoice: { ...invoice, status: 'VOID', voidJournalEntryId: 'entry-2' } }),
      );
    }
    if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, session));
    if (url.includes('/ledger-core/settings/invoicing')) {
      return Promise.resolve(jsonResponse(200, { success: true, invoiceSettings }));
    }
    if (url.includes('/ledger-core/settings')) {
      return Promise.resolve(jsonResponse(200, { success: true, settings: ledgerSettings }));
    }
    if (url.endsWith(`/ledger-core/invoices/${invoice.id}`)) {
      return Promise.resolve(jsonResponse(200, { success: true, invoice }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderInvoiceDetailPage(invoiceId: string) {
  return render(
    <MemoryRouter initialEntries={[`/app/ledger-core/invoices/${invoiceId}`]}>
      <AuthProvider>
        <OrgProvider>
          <LedgerSettingsProvider>
            <Routes>
              <Route path="/app/:appSlug/invoices/:invoiceId" element={<InvoiceDetailPage />} />
            </Routes>
          </LedgerSettingsProvider>
        </OrgProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('InvoicesPage', () => {
  it('lists invoices with their status', async () => {
    const draft = baseInvoice({ id: 'inv-draft' });
    const issued = baseInvoice({ id: 'inv-issued', status: 'ISSUED', invoiceNumber: 'INV-000001' });
    renderInvoicesPage([draft, issued]);

    await screen.findByText('INV-000001');
    // Appears twice for the draft row: the Number cell (no number yet) and
    // the Status pill both say "Draft".
    expect(screen.getAllByText('Draft').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Issued')).toBeInTheDocument();
  });

  it('offers Edit only on a draft', async () => {
    const draft = baseInvoice({ id: 'inv-draft' });
    const issued = baseInvoice({ id: 'inv-issued', status: 'ISSUED', invoiceNumber: 'INV-000001' });
    renderInvoicesPage([draft, issued]);

    await screen.findByText('INV-000001');
    const editLinks = screen.getAllByRole('link', { name: 'Edit' });
    expect(editLinks).toHaveLength(1);
    expect(editLinks[0]).toHaveAttribute('href', `/app/ledger-core/invoices/${draft.id}/edit`);
  });
});

describe('NewInvoicePage', () => {
  it('computes totals from the lines before any submit', async () => {
    mockNewInvoiceRoutes({ status: 201, body: { success: true, invoice: baseInvoice() } });
    const user = userEvent.setup();
    renderNewInvoicePage();

    await screen.findByText('Select a customer…');
    await user.selectOptions(screen.getByLabelText(/Customer/), customer1.id);
    await user.type(screen.getByLabelText('Quantity for line 1'), '2.5');
    await user.type(screen.getByLabelText('Unit price for line 1'), '100.00');
    await user.selectOptions(screen.getByLabelText('Account for line 1'), account4100.id);
    await user.type(screen.getByLabelText('Tax rate for line 1'), '18');

    // Appears twice: the line's own Amount cell and the Total row happen to
    // agree in this single-line fixture.
    await waitFor(() => {
      expect(screen.getAllByText('295.00').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('posts integer cents and thousandths, not floats', async () => {
    mockNewInvoiceRoutes({ status: 201, body: { success: true, invoice: baseInvoice() } });
    const user = userEvent.setup();
    renderNewInvoicePage();

    await screen.findByText('Select a customer…');
    await user.selectOptions(screen.getByLabelText(/Customer/), customer1.id);
    await user.type(screen.getByLabelText('Description for line 1'), 'Consulting hours');
    await user.type(screen.getByLabelText('Quantity for line 1'), '2.5');
    await user.type(screen.getByLabelText('Unit price for line 1'), '100.00');
    await user.selectOptions(screen.getByLabelText('Account for line 1'), account4100.id);
    await user.type(screen.getByLabelText('Tax rate for line 1'), '18');

    await user.click(screen.getByRole('button', { name: /save draft/i }));

    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find((call) => {
        const [input, init] = call as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'POST' && url.endsWith('/ledger-core/invoices');
      });
      expect(createCall).toBeDefined();
    });

    const createCall = fetchMock.mock.calls.find((call) => {
      const [input, init] = call as [RequestInfo | URL, RequestInit?];
      const url = typeof input === 'string' ? input : input.toString();
      return init?.method === 'POST' && url.endsWith('/ledger-core/invoices');
    });
    const body = JSON.parse((createCall as [RequestInfo | URL, RequestInit])[1].body as string) as {
      lines: { quantityMilli: number; unitPriceCents: number; taxRateBp: number }[];
    };
    expect(body.lines[0]?.quantityMilli).toBe(2500);
    expect(body.lines[0]?.unitPriceCents).toBe(10000);
    expect(body.lines[0]?.taxRateBp).toBe(1800);
  });
});

describe('InvoiceDetailPage', () => {
  it('Issue asks for confirmation before calling the API', async () => {
    const invoice = baseInvoice();
    mockDetailRoutes(invoice);
    const user = userEvent.setup();
    renderInvoiceDetailPage(invoice.id);

    await screen.findByRole('button', { name: 'Issue' });
    await user.click(screen.getByRole('button', { name: 'Issue' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    const issueCall = fetchMock.mock.calls.find((call) => {
      const [input, init] = call as [RequestInfo | URL, RequestInit?];
      const url = typeof input === 'string' ? input : input.toString();
      return init?.method === 'POST' && url.endsWith('/issue');
    });
    expect(issueCall).toBeUndefined();

    await user.click(within(dialog).getByRole('button', { name: 'Issue invoice' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'POST' && url.endsWith('/issue');
      });
      expect(call).toBeDefined();
    });
  });

  it('Void asks for confirmation before calling the API', async () => {
    const invoice = baseInvoice({ status: 'ISSUED', invoiceNumber: 'INV-000001', journalEntryId: 'entry-1' });
    mockDetailRoutes(invoice);
    const user = userEvent.setup();
    renderInvoiceDetailPage(invoice.id);

    await screen.findByRole('button', { name: 'Void' });
    await user.click(screen.getByRole('button', { name: 'Void' }));

    const dialog = screen.getByRole('dialog');
    const voidCall = fetchMock.mock.calls.find((call) => {
      const [input, init] = call as [RequestInfo | URL, RequestInit?];
      const url = typeof input === 'string' ? input : input.toString();
      return init?.method === 'POST' && url.endsWith('/void');
    });
    expect(voidCall).toBeUndefined();

    await user.click(within(dialog).getByRole('button', { name: 'Void invoice' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'POST' && url.endsWith('/void');
      });
      expect(call).toBeDefined();
    });
  });

  it('an issued invoice shows no edit control', async () => {
    const invoice = baseInvoice({ status: 'ISSUED', invoiceNumber: 'INV-000001', journalEntryId: 'entry-1' });
    mockDetailRoutes(invoice);
    renderInvoiceDetailPage(invoice.id);

    await screen.findByText('Issued');
    expect(screen.queryByRole('link', { name: /edit/i })).toBeNull();
  });

  it('links to the posted journal entry', async () => {
    const invoice = baseInvoice({ status: 'ISSUED', invoiceNumber: 'INV-000001', journalEntryId: 'entry-1' });
    mockDetailRoutes(invoice);
    renderInvoiceDetailPage(invoice.id);

    const link = await screen.findByRole('link', { name: 'entry-1'.slice(0, 8) });
    expect(link).toHaveAttribute('href', '/app/ledger-core/journals/entry-1');
  });
});
