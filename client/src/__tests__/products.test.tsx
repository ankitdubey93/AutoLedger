import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProductsPage from '../Pages/products/ProductsPage';
import NewInvoicePage from '../Pages/sales/NewInvoicePage';
import { LedgerSettingsProvider } from '../context/LedgerSettingsContext';
import type { Account, Customer, Item, InvoiceSettings, PaymentTerm, StockProductBalance } from '../services/fetchServices';

/**
 * The item catalogue page (list, create) and the invoice draft form's
 * item picker (Phase 24).
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

const consultingItem: Item = {
  id: 'item-1',
  code: 'CONSULT',
  name: 'Consulting hour',
  description: null,
  kind: 'SERVICE',
  itemType: 'SERVICE',
  stockManaged: false,
  salePriceCents: 15000,
  purchasePriceCents: null,
  revenueAccountId: account4100.id,
  expenseAccountId: null,
  assetAccountId: null,
  cogsAccountId: null,
  saleTaxRateBp: 0,
  purchaseTaxRateBp: 0,
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

function mockItemsPageRoutes(items: Item[], balances: StockProductBalance[] = []) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.method === 'POST' && url.includes('/api/v1/items')) {
      const body = JSON.parse(init.body as string) as { salePriceCents: number | null };
      return Promise.resolve(
        jsonResponse(201, {
          success: true,
          item: { ...consultingItem, id: 'item-new', salePriceCents: body.salePriceCents },
        }),
      );
    }
    if (url.includes('/api/v1/items')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: items.length, items }));
    }
    if (url.includes('/api/v1/accounts')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: 1, accounts: [account4100] }));
    }
    if (url.includes('/api/v1/inventory/product-balances')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: balances.length, balances }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderItemsPage() {
  return render(
    <MemoryRouter initialEntries={['/products']}>
      <Routes>
        <Route path="/products" element={<ProductsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProductsPage', () => {
  it('the items page lists catalogue rows', async () => {
    mockItemsPageRoutes([consultingItem]);
    renderItemsPage();

    await screen.findByText('CONSULT');
    expect(screen.getByText('150.00')).toBeInTheDocument();
  });

  it('creating an item posts integer cents', async () => {
    mockItemsPageRoutes([]);
    const user = userEvent.setup();
    renderItemsPage();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: 'New product or service' }));
    await user.type(screen.getByLabelText('Code'), 'CONSULT');
    await user.type(screen.getByLabelText('Name'), 'Consulting hour');
    await user.type(screen.getByLabelText('Sale price'), '150.00');
    await user.click(screen.getByRole('button', { name: 'Create item' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'POST' && url.includes('/api/v1/items');
      });
      expect(call).toBeDefined();
    });

    const call = fetchMock.mock.calls.find((c) => {
      const [input, init] = c as [RequestInfo | URL, RequestInit?];
      const url = typeof input === 'string' ? input : input.toString();
      return init?.method === 'POST' && url.includes('/api/v1/items');
    });
    const body = JSON.parse((call as [RequestInfo | URL, RequestInit])[1].body as string) as {
      salePriceCents: number;
      itemType: string;
    };
    expect(body.salePriceCents).toBe(15000);
    expect(body.itemType).toBe('SERVICE');
  });

  const widget: Item = {
    ...consultingItem,
    id: 'item-widget',
    code: 'GEN-00001',
    name: 'Widget',
    kind: 'GOODS',
    itemType: 'INVENTORY',
    stockManaged: true,
  };
  const widgetBalance: StockProductBalance = {
    ledgerItemId: 'item-widget',
    stockItemId: 'stock-widget',
    tracking: 'QUANTITY',
    uomCode: 'EA',
    uomDecimalPlaces: 0,
    onHandQuantityMilli: 12_000,
    isActive: true,
  };

  it('an inventory product shows its on-hand quantity and opens its stock item instead of offering to deactivate', async () => {
    mockItemsPageRoutes([consultingItem, widget], [widgetBalance]);
    renderItemsPage();

    await screen.findByText('GEN-00001');
    await screen.findByText('12 EA');
    const link = screen.getByRole('link', { name: 'Open stock item' });
    expect(link).toHaveAttribute('href', '/inventory/items/stock-widget');
    // The service is still deactivatable here; the stock-managed row is not.
    expect(screen.getAllByRole('button', { name: 'Deactivate' })).toHaveLength(1);
  });

  it('the type tabs filter the list, and the create form offers only services and non-inventory items', async () => {
    mockItemsPageRoutes([consultingItem, widget], [widgetBalance]);
    const user = userEvent.setup();
    renderItemsPage();

    await screen.findByText('GEN-00001');
    await user.click(screen.getByRole('tab', { name: 'Services' }));
    expect(screen.getByText('CONSULT')).toBeInTheDocument();
    expect(screen.queryByText('GEN-00001')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'New product or service' }));
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toContain('Service');
    expect(options).toContain('Non-inventory (not stocked)');
    expect(options).not.toContain('Inventory');
    expect(screen.getByRole('link', { name: 'New stock item' })).toHaveAttribute('href', '/inventory/items/new');
  });
});

/* -------------------------------------------------- the item picker on the invoice form */

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

const netTerm: PaymentTerm = {
  id: 'term-net30',
  code: 'NET_30',
  name: 'Net 30',
  netDays: 30,
  isSystem: true,
  isActive: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function mockNewInvoiceRoutes() {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.method === 'POST' && url.includes('/api/v1/invoices')) {
      return Promise.resolve(jsonResponse(201, { success: true, invoice: { id: 'inv-new' } }));
    }
    if (url.includes('/api/v1/customers')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: 1, customers: [customer1] }));
    }
    if (url.includes('/api/v1/settings/invoicing')) {
      return Promise.resolve(jsonResponse(200, { success: true, invoiceSettings }));
    }
    if (url.includes('/api/v1/accounts')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: 1, accounts: [account4100] }));
    }
    if (url.includes('/api/v1/items')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: 1, items: [consultingItem] }));
    }
    if (url.includes('/api/v1/payment-terms')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: 1, paymentTerms: [netTerm] }));
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

describe('the item picker on the invoice draft form', () => {
  it('picking an item fills the invoice line', async () => {
    mockNewInvoiceRoutes();
    const user = userEvent.setup();
    renderNewInvoicePage();

    await screen.findByText('Select a customer…');
    await user.selectOptions(screen.getByLabelText('Item for line 1'), consultingItem.id);

    expect(screen.getByLabelText('Description for line 1')).toHaveValue('Consulting hour');
    expect(screen.getByLabelText('Unit price for line 1')).toHaveValue('150.00');
    expect(screen.getByLabelText('Account for line 1')).toHaveValue(account4100.id);
  });

  it('a filled line stays editable', async () => {
    mockNewInvoiceRoutes();
    const user = userEvent.setup();
    renderNewInvoicePage();

    await screen.findByText('Select a customer…');
    await user.selectOptions(screen.getByLabelText('Item for line 1'), consultingItem.id);
    await user.clear(screen.getByLabelText('Description for line 1'));
    await user.type(screen.getByLabelText('Description for line 1'), 'Custom description');

    expect(screen.getByLabelText('Description for line 1')).toHaveValue('Custom description');
  });

  it('the invoice submit body carries itemId', async () => {
    mockNewInvoiceRoutes();
    const user = userEvent.setup();
    renderNewInvoicePage();

    await screen.findByText('Select a customer…');
    await user.selectOptions(screen.getByLabelText(/Customer/), customer1.id);
    await user.clear(screen.getByLabelText('Issue date'));
    await user.type(screen.getByLabelText('Issue date'), '2026-03-01');
    await user.clear(screen.getByLabelText('Due date'));
    await user.type(screen.getByLabelText('Due date'), '2026-03-31');
    await user.selectOptions(screen.getByLabelText('Item for line 1'), consultingItem.id);
    await user.type(screen.getByLabelText('Quantity for line 1'), '1');

    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'POST' && url.endsWith('/api/v1/invoices');
      });
      expect(call).toBeDefined();
    });

    const call = fetchMock.mock.calls.find((c) => {
      const [input, init] = c as [RequestInfo | URL, RequestInit?];
      const url = typeof input === 'string' ? input : input.toString();
      return init?.method === 'POST' && url.endsWith('/api/v1/invoices');
    });
    const body = JSON.parse((call as [RequestInfo | URL, RequestInit])[1].body as string) as {
      lines: { itemId: string | null }[];
    };
    expect(body.lines[0]?.itemId).toBe(consultingItem.id);
  });
});
