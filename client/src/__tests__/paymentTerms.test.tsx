import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PaymentTermsSettingsPage from '../Pages/settings/PaymentTermsSettingsPage';
import NewInvoicePage from '../Pages/sales/NewInvoicePage';
import { LedgerSettingsProvider } from '../context/LedgerSettingsContext';
import type { Account, Customer, InvoiceSettings, PaymentTerm } from '../services/fetchServices';

/**
 * Payment terms (Phase 24) — the settings page (list, create, deactivate)
 * and the derived-due-date behaviour on the invoice draft form.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const standardTerm: PaymentTerm = {
  id: 'term-net30',
  code: 'NET_30',
  name: 'Net 30',
  netDays: 30,
  isSystem: true,
  isActive: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const customTerm: PaymentTerm = {
  id: 'term-net21',
  code: 'NET_21',
  name: 'Net 21',
  netDays: 21,
  isSystem: false,
  isActive: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockSettingsRoutes(terms: PaymentTerm[]) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.method === 'POST' && url.includes('/ledger-core/payment-terms')) {
      const body = JSON.parse(init.body as string) as { code: string; name: string; netDays: number };
      return Promise.resolve(
        jsonResponse(201, {
          success: true,
          paymentTerm: {
            id: 'term-new',
            code: body.code.toUpperCase(),
            name: body.name,
            netDays: body.netDays,
            isSystem: false,
            isActive: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        }),
      );
    }
    if (init?.method === 'PATCH' && url.includes('/ledger-core/payment-terms/')) {
      return Promise.resolve(
        jsonResponse(200, { success: true, paymentTerm: { ...standardTerm, isActive: false } }),
      );
    }
    if (url.includes('/ledger-core/payment-terms')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: terms.length, paymentTerms: terms }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderSettingsPage() {
  return render(
    <MemoryRouter initialEntries={['/settings/payment-terms']}>
      <Routes>
        <Route path="/settings/payment-terms" element={<PaymentTermsSettingsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PaymentTermsSettingsPage', () => {
  it('the settings page lists standard and custom terms', async () => {
    mockSettingsRoutes([standardTerm, customTerm]);
    renderSettingsPage();

    await screen.findByText('NET_30');
    expect(screen.getAllByText('Standard')).toHaveLength(1);
    expect(screen.getAllByText('Custom')).toHaveLength(1);
    expect(screen.getByText('NET_21')).toBeInTheDocument();
  });

  it('creating a term posts code, name and netDays', async () => {
    mockSettingsRoutes([standardTerm]);
    const user = userEvent.setup();
    renderSettingsPage();

    await screen.findByText('NET_30');
    await user.click(screen.getByRole('button', { name: 'New payment term' }));
    await user.type(screen.getByLabelText('Code'), 'net_21');
    await user.type(screen.getByLabelText('Name'), 'Net 21');
    await user.type(screen.getByLabelText('Net days'), '21');
    await user.click(screen.getByRole('button', { name: 'Create payment term' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'POST' && url.includes('/ledger-core/payment-terms');
      });
      expect(call).toBeDefined();
    });

    const call = fetchMock.mock.calls.find((c) => {
      const [input, init] = c as [RequestInfo | URL, RequestInit?];
      const url = typeof input === 'string' ? input : input.toString();
      return init?.method === 'POST' && url.includes('/ledger-core/payment-terms');
    });
    const body = JSON.parse((call as [RequestInfo | URL, RequestInit])[1].body as string) as {
      code: string;
      name: string;
      netDays: number;
    };
    expect(body).toEqual({ code: 'net_21', name: 'Net 21', netDays: 21 });
  });

  it('deactivating a term patches isActive false', async () => {
    mockSettingsRoutes([standardTerm]);
    const user = userEvent.setup();
    renderSettingsPage();

    await screen.findByText('NET_30');
    await user.click(screen.getByRole('button', { name: 'Deactivate' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'PATCH' && url.includes('/ledger-core/payment-terms/');
      });
      expect(call).toBeDefined();
    });

    const call = fetchMock.mock.calls.find((c) => {
      const [input, init] = c as [RequestInfo | URL, RequestInit?];
      const url = typeof input === 'string' ? input : input.toString();
      return init?.method === 'PATCH' && url.includes('/ledger-core/payment-terms/');
    });
    const body = JSON.parse((call as [RequestInfo | URL, RequestInit])[1].body as string) as {
      isActive: boolean;
    };
    expect(body).toEqual({ isActive: false });
  });
});

/* -------------------------------------------- derived due date on the invoice form */

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

function mockNewInvoiceRoutes() {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.method === 'POST' && url.includes('/ledger-core/invoices')) {
      return Promise.resolve(jsonResponse(201, { success: true, invoice: { id: 'inv-new' } }));
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
    if (url.includes('/ledger-core/items')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: 0, items: [] }));
    }
    if (url.includes('/ledger-core/payment-terms')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: 1, paymentTerms: [standardTerm] }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderNewInvoicePage() {
  return render(
    <MemoryRouter initialEntries={['/invoices/new']}>
      <LedgerSettingsProvider>
        <Routes>
          <Route path="/invoices/new" element={<NewInvoicePage />} />
        </Routes>
      </LedgerSettingsProvider>
    </MemoryRouter>,
  );
}

describe('payment terms on the invoice draft form', () => {
  it('choosing Net 30 on the invoice form fills the due date', async () => {
    mockNewInvoiceRoutes();
    const user = userEvent.setup();
    renderNewInvoicePage();

    await screen.findByText('Select a customer…');
    await user.clear(screen.getByLabelText('Issue date'));
    await user.type(screen.getByLabelText('Issue date'), '2026-03-01');
    await user.selectOptions(screen.getByLabelText('Payment terms'), 'NET_30');

    await waitFor(() => {
      expect(screen.getByLabelText('Due date')).toHaveValue('2026-03-31');
    });
  });

  it('a hand-edited due date is not overwritten when the issue date changes', async () => {
    mockNewInvoiceRoutes();
    const user = userEvent.setup();
    renderNewInvoicePage();

    await screen.findByText('Select a customer…');
    await user.clear(screen.getByLabelText('Issue date'));
    await user.type(screen.getByLabelText('Issue date'), '2026-03-01');
    await user.selectOptions(screen.getByLabelText('Payment terms'), 'NET_30');
    await waitFor(() => expect(screen.getByLabelText('Due date')).toHaveValue('2026-03-31'));

    await user.clear(screen.getByLabelText('Due date'));
    await user.type(screen.getByLabelText('Due date'), '2026-04-15');
    await user.clear(screen.getByLabelText('Issue date'));
    await user.type(screen.getByLabelText('Issue date'), '2026-03-05');

    expect(screen.getByLabelText('Due date')).toHaveValue('2026-04-15');
  });

  it('the invoice form submits paymentTermsCode', async () => {
    mockNewInvoiceRoutes();
    const user = userEvent.setup();
    renderNewInvoicePage();

    await screen.findByText('Select a customer…');
    await user.selectOptions(screen.getByLabelText(/Customer/), 'cust-1');
    await user.clear(screen.getByLabelText('Issue date'));
    await user.type(screen.getByLabelText('Issue date'), '2026-03-01');
    await user.selectOptions(screen.getByLabelText('Payment terms'), 'NET_30');
    await waitFor(() => expect(screen.getByLabelText('Due date')).toHaveValue('2026-03-31'));

    await user.type(screen.getByLabelText('Description for line 1'), 'Consulting');
    await user.type(screen.getByLabelText('Quantity for line 1'), '1');
    await user.type(screen.getByLabelText('Unit price for line 1'), '100.00');
    await user.selectOptions(screen.getByLabelText('Account for line 1'), account4100.id);

    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'POST' && url.endsWith('/ledger-core/invoices');
      });
      expect(call).toBeDefined();
    });

    const call = fetchMock.mock.calls.find((c) => {
      const [input, init] = c as [RequestInfo | URL, RequestInit?];
      const url = typeof input === 'string' ? input : input.toString();
      return init?.method === 'POST' && url.endsWith('/ledger-core/invoices');
    });
    const body = JSON.parse((call as [RequestInfo | URL, RequestInit])[1].body as string) as {
      paymentTermsCode: string | null;
    };
    expect(body.paymentTermsCode).toBe('NET_30');
  });
});
