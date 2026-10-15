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

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input.toString();
}

const account1140: Account = { ...account4100, id: 'acc-1140', code: '1140', name: 'Inventory', type: 'Asset' };
const account6600: Account = { ...account4100, id: 'acc-6600', code: '6600', name: 'Office supplies', type: 'Expense' };

function mockItemsPageRoutes(items: Item[], balances: StockProductBalance[] = []) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    if (init?.method === 'POST' && url.includes('/api/v1/inventory/items/from-product/')) {
      return Promise.resolve(jsonResponse(201, { success: true, item: { id: 'stock-new', ledgerItemId: 'item-lamp' } }));
    }
    if (init?.method === 'PATCH' && url.includes('/api/v1/inventory/items/')) {
      return Promise.resolve(jsonResponse(200, { success: true, item: { id: 'stock-widget', ledgerItemId: 'item-widget' } }));
    }
    if (init?.method === 'POST' && url.includes('/api/v1/inventory/items')) {
      return Promise.resolve(jsonResponse(201, { success: true, item: { id: 'stock-new', ledgerItemId: 'item-tracked' } }));
    }
    if (init?.method === 'POST' && url.includes('/api/v1/items')) {
      const body = JSON.parse(init.body as string) as { salePriceCents: number | null };
      return Promise.resolve(
        jsonResponse(201, {
          success: true,
          item: { ...consultingItem, id: 'item-new', salePriceCents: body.salePriceCents },
        }),
      );
    }
    if (init?.method === 'PATCH' && url.includes('/api/v1/items/')) {
      const id = url.split('/api/v1/items/')[1] ?? '';
      const current = items.find((i) => i.id === id) ?? consultingItem;
      return Promise.resolve(jsonResponse(200, { success: true, item: { ...current, ...(JSON.parse(init.body as string) as object) } }));
    }
    if (url.includes('/api/v1/items/')) {
      const id = url.split('/api/v1/items/')[1] ?? '';
      const found = items.find((i) => i.id === id) ?? { ...consultingItem, id, itemType: 'INVENTORY', kind: 'GOODS', stockManaged: true };
      return Promise.resolve(jsonResponse(200, { success: true, item: found }));
    }
    if (url.includes('/api/v1/items')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: items.length, items }));
    }
    if (url.includes('/api/v1/accounts')) {
      const accounts = [account4100, account1140, account6600];
      return Promise.resolve(jsonResponse(200, { success: true, count: accounts.length, accounts }));
    }
    if (url.includes('/api/v1/inventory/product-balances')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: balances.length, balances }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function sentBody<T>(method: string, match: (url: string) => boolean): T | undefined {
  const call = fetchMock.mock.calls.find((c) => {
    const [input, init] = c as [RequestInfo | URL, RequestInit?];
    return init?.method === method && match(urlOf(input));
  });
  if (call === undefined) return undefined;
  return JSON.parse((call as [RequestInfo | URL, RequestInit])[1].body as string) as T;
}

function renderItemsPage(path = '/products') {
  return render(
    <MemoryRouter initialEntries={[path]}>
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

  it('creating a service posts integer cents, a code derived from the name, and tax in basis points', async () => {
    mockItemsPageRoutes([]);
    const user = userEvent.setup();
    renderItemsPage();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: 'New product or service' }));
    await user.type(screen.getByLabelText('Name'), 'Consulting hour');
    expect(screen.getByLabelText('Code')).toHaveValue('CONSULTING-HOUR');
    await user.click(screen.getByRole('radio', { name: 'Service' }));
    await user.type(screen.getByLabelText('Sale price'), '150.00');
    await user.type(screen.getAllByLabelText('Tax %')[1] as HTMLElement, '18.5');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(sentBody('POST', (u) => u.endsWith('/api/v1/items'))).toBeDefined());
    const body = sentBody<{ code: string; salePriceCents: number; itemType: string; saleTaxRateBp: number }>(
      'POST',
      (u) => u.endsWith('/api/v1/items'),
    );
    expect(body).toMatchObject({ code: 'CONSULTING-HOUR', salePriceCents: 15000, itemType: 'SERVICE', saleTaxRateBp: 1850 });
  });

  it('an untracked product is created as NON_INVENTORY', async () => {
    mockItemsPageRoutes([]);
    const user = userEvent.setup();
    renderItemsPage();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: 'New product or service' }));
    await user.type(screen.getByLabelText('Name'), 'Printer paper');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(sentBody('POST', (u) => u.endsWith('/api/v1/items'))).toMatchObject({ itemType: 'NON_INVENTORY' }));
  });

  it('ticking "Track inventory" creates the product through inventory with its opening stock — no category needed', async () => {
    mockItemsPageRoutes([]);
    const user = userEvent.setup();
    renderItemsPage();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: 'New product or service' }));
    await user.type(screen.getByLabelText('Name'), 'Desk lamp');
    await user.click(screen.getByRole('checkbox', { name: /Track inventory/ }));
    await user.type(screen.getByLabelText('Purchase price'), '60.00');
    await user.type(screen.getByLabelText('Sale price'), '100.00');
    await user.type(screen.getByLabelText('Quantity'), '10');
    // Unit cost left blank: the placeholder shows the purchase price it will default to.
    expect(screen.getByLabelText('Unit cost')).toHaveAttribute('placeholder', '60.00');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(sentBody('POST', (u) => u.endsWith('/api/v1/inventory/items'))).toBeDefined());
    const body = sentBody<Record<string, unknown>>('POST', (u) => u.endsWith('/api/v1/inventory/items'));
    expect(body).toMatchObject({
      name: 'Desk lamp',
      code: 'DESK-LAMP',
      product: { purchasePriceCents: 6000, salePriceCents: 10000 },
      opening: { quantityMilli: 10000, unitCostCents: null },
    });
    expect(body).not.toHaveProperty('categoryId');
    expect(sentBody('POST', (u) => u.endsWith('/api/v1/items'))).toBeUndefined();
  });

  it('?new=1&track=1 opens the form with "Track inventory" ticked', async () => {
    mockItemsPageRoutes([]);
    renderItemsPage('/products?new=1&track=1');

    expect(await screen.findByRole('checkbox', { name: /Track inventory/ })).toBeChecked();
    expect(screen.getByLabelText('Quantity')).toBeInTheDocument();
  });

  const lamp: Item = {
    ...consultingItem,
    id: 'item-lamp',
    code: 'LAMP-01',
    name: 'Desk lamp',
    kind: 'GOODS',
    itemType: 'NON_INVENTORY',
    salePriceCents: 10000,
    purchasePriceCents: 6000,
    expenseAccountId: account6600.id,
  };

  it('Edit sends a PATCH with the changed price, and the code cannot change', async () => {
    mockItemsPageRoutes([lamp]);
    const user = userEvent.setup();
    renderItemsPage();

    await screen.findByText('LAMP-01');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Code')).toBeDisabled();
    await user.clear(screen.getByLabelText('Sale price'));
    await user.type(screen.getByLabelText('Sale price'), '120.00');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(sentBody('PATCH', (u) => u.endsWith('/api/v1/items/item-lamp'))).toBeDefined());
    expect(sentBody('PATCH', (u) => u.endsWith('/api/v1/items/item-lamp'))).toMatchObject({
      salePriceCents: 12000,
      purchasePriceCents: 6000,
      expenseAccountId: account6600.id,
    });
    expect(sentBody('POST', (u) => u.includes('/from-product/'))).toBeUndefined();
  });

  it('ticking "Track inventory" on an existing product converts it (forward-only) with its opening stock', async () => {
    mockItemsPageRoutes([lamp]);
    const user = userEvent.setup();
    renderItemsPage();

    await screen.findByText('LAMP-01');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('checkbox', { name: /Track inventory/ }));
    expect(screen.getByText(/Documents already posted stay as they are/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Quantity'), '4');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(sentBody('POST', (u) => u.endsWith('/api/v1/inventory/items/from-product/item-lamp'))).toMatchObject({
        opening: { quantityMilli: 4000, unitCostCents: null },
      }),
    );
    // The expense account is not sent while converting — the product's stock lines post to inventory.
    expect(sentBody('PATCH', (u) => u.endsWith('/api/v1/items/item-lamp'))).not.toHaveProperty('expenseAccountId');
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

  it('editing a tracked product: tracking stays on, and a rename goes to its stock item', async () => {
    mockItemsPageRoutes([widget], [widgetBalance]);
    const user = userEvent.setup();
    renderItemsPage();

    await screen.findByText('12 EA');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const track = screen.getByRole('checkbox', { name: /Track inventory/ });
    expect(track).toBeChecked();
    expect(track).toBeDisabled();
    expect(screen.queryByLabelText('Quantity')).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Widget XL');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(sentBody('PATCH', (u) => u.endsWith('/api/v1/inventory/items/stock-widget'))).toEqual({ name: 'Widget XL' }),
    );
    expect(sentBody('PATCH', (u) => u.endsWith('/api/v1/items/item-widget'))).not.toHaveProperty('name');
  });

  it('the type tabs filter the list', async () => {
    mockItemsPageRoutes([consultingItem, widget], [widgetBalance]);
    const user = userEvent.setup();
    renderItemsPage();

    await screen.findByText('GEN-00001');
    await user.click(screen.getByRole('tab', { name: 'Services' }));
    expect(screen.getByText('CONSULT')).toBeInTheDocument();
    expect(screen.queryByText('GEN-00001')).not.toBeInTheDocument();
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
