import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NewBillPage from '../Pages/ledger-core/NewBillPage';
import NewInvoicePage from '../Pages/ledger-core/NewInvoicePage';
import { LedgerSettingsProvider } from '../Pages/ledger-core/LedgerSettingsContext';
import type {
  Account,
  Customer,
  InvoiceSettings,
  Item,
  PaymentTerm,
  StockLocation,
  StockProductBalance,
  Vendor,
} from '../services/fetchServices';

/**
 * Phase 32 — the item picker on the invoice and bill forms shows every product
 * type in one grouped list. An INVENTORY product shows its on-hand quantity and
 * gets a stock-location select; lot-tracked items are listed but disabled; on a
 * bill an INVENTORY line's account is the item's inventory account and is
 * locked.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const now = new Date().toISOString();

function account(id: string, code: string, name: string, type: Account['type']): Account {
  return { id, code, name, type, parentId: null, isPostable: true, isActive: true, description: null, createdAt: now, updatedAt: now };
}
const accounts: Account[] = [
  account('acc-4100', '4100', 'Product Revenue', 'Revenue'),
  account('acc-1140', '1140', 'Inventory', 'Asset'),
  account('acc-6100', '6100', 'Supplies', 'Expense'),
];

function item(overrides: Partial<Item>): Item {
  return {
    id: 'item',
    code: 'X',
    name: 'X',
    description: null,
    kind: 'GOODS',
    itemType: 'NON_INVENTORY',
    stockManaged: false,
    salePriceCents: 2500,
    purchasePriceCents: 1000,
    revenueAccountId: 'acc-4100',
    expenseAccountId: 'acc-6100',
    assetAccountId: null,
    cogsAccountId: null,
    saleTaxRateBp: 0,
    purchaseTaxRateBp: 0,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const service = item({ id: 'svc', code: 'CONSULT', name: 'Consulting', kind: 'SERVICE', itemType: 'SERVICE' });
const widget = item({ id: 'widget', code: 'GEN-00001', name: 'Widget', itemType: 'INVENTORY', stockManaged: true, assetAccountId: 'acc-1140', expenseAccountId: null });
const lotThing = item({ id: 'lot', code: 'LOT-00001', name: 'Lot thing', itemType: 'INVENTORY', stockManaged: true, assetAccountId: 'acc-1140' });
const items = [service, widget, lotThing];

function balance(ledgerItemId: string, tracking: StockProductBalance['tracking'], qty: number): StockProductBalance {
  return { ledgerItemId, stockItemId: `stock-${ledgerItemId}`, tracking, uomCode: 'EA', uomDecimalPlaces: 0, onHandQuantityMilli: qty, isActive: true };
}
const balances = [balance('widget', 'QUANTITY', 12_000), balance('lot', 'LOT', 3_000)];

const mainLocation: StockLocation = { id: 'loc-main', code: 'MAIN', name: 'Main warehouse', kind: 'WAREHOUSE', parentId: null, path: 'MAIN', depth: 1, isActive: true, createdAt: now, updatedAt: now };
const backroom: StockLocation = { ...mainLocation, id: 'loc-back', code: 'BACK', name: 'Back room', path: 'BACK' };

const customer: Customer = { id: 'cust-1', name: 'Northwind', email: null, phone: null, billingAddress: null, taxNumber: null, notes: null, isActive: true, createdAt: now, updatedAt: now };
const vendor = { id: 'vend-1', name: 'Acme Supplies', email: null, phone: null, billingAddress: null, taxNumber: null, paymentTerms: null, notes: null, isActive: true, createdAt: now, updatedAt: now } as Vendor;
const netTerm: PaymentTerm = { id: 'term', code: 'NET_30', name: 'Net 30', netDays: 30, isSystem: true, isActive: true, createdAt: now, updatedAt: now };
const invoiceSettings = {
  numberPrefix: 'INV-', numberPadding: 6, nextNumber: 1, defaultDueDays: 30, defaultTaxRateBp: 0, taxLabel: 'Tax',
  receivableAccountId: null, defaultRevenueAccountId: null, taxPayableAccountId: null, showTaxNumber: true,
  showBusinessNumber: false, showLegalName: true, billingAddress: null, paymentTerms: null, footerNotes: null,
  accentColor: '#2563eb', templateId: 'classic', documentTitle: 'INVOICE', fontFamily: 'sans', density: 'comfortable',
  showLogo: true, showOrgAddress: true, showPaymentTerms: true, showDueDate: true, bankDetails: null, configured: true,
} as InvoiceSettings;

let fetchMock: ReturnType<typeof vi.fn>;
let posted: { url: string; body: Record<string, unknown> } | null;
let itemPosts: Record<string, unknown>[];
let itemPostStatuses: number[];

beforeEach(() => {
  posted = null;
  itemPosts = [];
  itemPostStatuses = [];
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.method === 'POST' && (url.includes('/ledger-core/invoices') || url.includes('/ledger-core/bills'))) {
      posted = { url, body: JSON.parse(init.body as string) as Record<string, unknown> };
      return Promise.resolve(jsonResponse(201, { success: true, invoice: { id: 'inv-new' }, bill: { id: 'bill-new' } }));
    }
    if (init?.method === 'POST' && url.endsWith('/ledger-core/items')) {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      itemPosts.push(body);
      const status = itemPostStatuses.shift() ?? 201;
      if (status !== 201) return Promise.resolve(jsonResponse(status, { success: false, error: 'Item code already exists' }));
      return Promise.resolve(
        jsonResponse(201, {
          success: true,
          item: item({
            id: 'new-item',
            code: body.code as string,
            name: body.name as string,
            kind: body.itemType === 'SERVICE' ? 'SERVICE' : 'GOODS',
            itemType: body.itemType as Item['itemType'],
            salePriceCents: body.salePriceCents as number | null,
            purchasePriceCents: body.purchasePriceCents as number | null,
            revenueAccountId: body.revenueAccountId as string | null,
            expenseAccountId: body.expenseAccountId as string | null,
          }),
        }),
      );
    }
    if (url.includes('/ledger-core/customers')) return Promise.resolve(jsonResponse(200, { success: true, count: 1, customers: [customer] }));
    if (url.includes('/ledger-core/vendors')) return Promise.resolve(jsonResponse(200, { success: true, count: 1, vendors: [vendor] }));
    if (url.includes('/ledger-core/settings/invoicing')) return Promise.resolve(jsonResponse(200, { success: true, invoiceSettings }));
    if (url.includes('/ledger-core/accounts')) return Promise.resolve(jsonResponse(200, { success: true, count: accounts.length, accounts }));
    if (url.includes('/ledger-core/items')) return Promise.resolve(jsonResponse(200, { success: true, count: items.length, items }));
    if (url.includes('/ledger-core/payment-terms')) return Promise.resolve(jsonResponse(200, { success: true, count: 1, paymentTerms: [netTerm] }));
    if (url.includes('/stock/product-balances')) return Promise.resolve(jsonResponse(200, { success: true, count: balances.length, balances }));
    if (url.includes('/stock/locations')) return Promise.resolve(jsonResponse(200, { success: true, count: 2, locations: [mainLocation, backroom] }));
    if (url.includes('/stock/settings')) {
      return Promise.resolve(jsonResponse(200, { success: true, settings: { configured: true, defaultLocationId: 'loc-main', industryProfile: 'GENERAL', suggestedProfile: 'GENERAL', updatedAt: now } }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderInvoice() {
  return render(
    <MemoryRouter initialEntries={['/app/ledger-core/invoices/new']}>
      <LedgerSettingsProvider>
        <Routes>
          <Route path="/app/:appSlug/invoices/new" element={<NewInvoicePage />} />
        </Routes>
      </LedgerSettingsProvider>
    </MemoryRouter>,
  );
}

function renderBill() {
  return render(
    <MemoryRouter initialEntries={['/app/ledger-core/bills/new']}>
      <LedgerSettingsProvider>
        <Routes>
          <Route path="/app/:appSlug/bills/new" element={<NewBillPage />} />
        </Routes>
      </LedgerSettingsProvider>
    </MemoryRouter>,
  );
}

describe('the product picker on the invoice form', () => {
  it('groups products by type, shows on-hand for inventory, and disables lot-tracked items', async () => {
    renderInvoice();
    await screen.findByText('Select a customer…');

    const picker = screen.getByLabelText('Item for line 1');
    await waitFor(() => expect(screen.getByRole('option', { name: /GEN-00001 · Widget · 12 EA on hand/ })).toBeInTheDocument());
    expect(picker.querySelector('optgroup[label="Services"]')).not.toBeNull();
    expect(picker.querySelector('optgroup[label="Inventory"]')).not.toBeNull();
    expect(screen.getByRole('option', { name: /LOT-00001 · Lot thing.*lot-tracked/ })).toBeDisabled();
  });

  it('an inventory line gets a location select defaulting to the default location, and submits stockLocationId', async () => {
    const user = userEvent.setup();
    renderInvoice();
    await screen.findByText('Select a customer…');
    await waitFor(() => expect(screen.getByRole('option', { name: /GEN-00001/ })).toBeInTheDocument());

    // A service line has no location select.
    await user.selectOptions(screen.getByLabelText('Item for line 1'), service.id);
    expect(screen.queryByLabelText('Stock location for line 1')).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Item for line 1'), widget.id);
    const location = screen.getByLabelText('Stock location for line 1');
    expect(within(location as HTMLElement).getByRole('option', { name: 'Default · MAIN' })).toBeInTheDocument();
    await user.selectOptions(location, backroom.id);

    await user.selectOptions(screen.getByLabelText(/Customer/), customer.id);
    await user.clear(screen.getByLabelText('Issue date'));
    await user.type(screen.getByLabelText('Issue date'), '2026-03-01');
    await user.clear(screen.getByLabelText('Due date'));
    await user.type(screen.getByLabelText('Due date'), '2026-03-31');
    await user.type(screen.getByLabelText('Quantity for line 1'), '2');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(posted).not.toBeNull());
    const lines = (posted?.body.lines ?? []) as { itemId: string; stockLocationId: string | null }[];
    expect(lines[0]).toMatchObject({ itemId: widget.id, stockLocationId: backroom.id });
  });

  it('switching a line back to a service clears its stock location', async () => {
    const user = userEvent.setup();
    renderInvoice();
    await screen.findByText('Select a customer…');
    await waitFor(() => expect(screen.getByRole('option', { name: /GEN-00001/ })).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText('Item for line 1'), widget.id);
    await user.selectOptions(screen.getByLabelText('Stock location for line 1'), backroom.id);
    await user.selectOptions(screen.getByLabelText('Item for line 1'), service.id);
    expect(screen.queryByLabelText('Stock location for line 1')).not.toBeInTheDocument();
  });
});

describe('the product picker on the bill form', () => {
  it("an inventory item fills the inventory account and locks the account select", async () => {
    const user = userEvent.setup();
    renderBill();
    await screen.findByText('Select a vendor…');
    await waitFor(() => expect(screen.getByRole('option', { name: /GEN-00001/ })).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText('Item for line 1'), widget.id);

    expect(screen.getByLabelText('Account for line 1')).toHaveValue('acc-1140');
    expect(screen.getByLabelText('Account for line 1')).toBeDisabled();
    expect(screen.getByLabelText('Unit price for line 1')).toHaveValue('10.00');
    expect(screen.getByLabelText('Stock location for line 1')).toBeInTheDocument();
  });

  it('a non-inventory item leaves the account editable', async () => {
    const user = userEvent.setup();
    renderBill();
    await screen.findByText('Select a vendor…');
    await waitFor(() => expect(screen.getByRole('option', { name: /CONSULT/ })).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText('Item for line 1'), service.id);
    expect(screen.getByLabelText('Account for line 1')).toBeEnabled();
    expect(screen.queryByLabelText('Stock location for line 1')).not.toBeInTheDocument();
  });
});

describe('quick add from a document line', () => {
  it('creates a service from an invoice line, then picks it on that line without saving the invoice', async () => {
    const user = userEvent.setup();
    renderInvoice();
    await screen.findByText('Select a customer…');
    await waitFor(() => expect(screen.getByRole('option', { name: /GEN-00001/ })).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText('Item for line 1'), '＋ New product or service…');
    const dialog = await screen.findByRole('dialog', { name: 'New product or service' });
    await user.type(within(dialog).getByLabelText('Name'), 'Web design');
    expect(within(dialog).getByLabelText('Code')).toHaveValue('WEB-DESIGN');
    await user.type(within(dialog).getByLabelText('Sale price'), '120');
    await user.selectOptions(within(dialog).getByLabelText('Revenue account'), 'acc-4100');
    await user.click(within(dialog).getByRole('button', { name: 'Create and use' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(itemPosts[0]).toMatchObject({
      code: 'WEB-DESIGN',
      name: 'Web design',
      itemType: 'SERVICE',
      salePriceCents: 12000,
      purchasePriceCents: null,
      revenueAccountId: 'acc-4100',
    });
    expect(screen.getByLabelText('Item for line 1')).toHaveValue('new-item');
    expect(screen.getByLabelText('Description for line 1')).toHaveValue('Web design');
    expect(screen.getByLabelText('Unit price for line 1')).toHaveValue('120.00');
    expect(screen.getByLabelText('Account for line 1')).toHaveValue('acc-4100');
    // The dialog's submit must not also submit the invoice form behind it.
    expect(posted).toBeNull();
  });

  it('retries a taken derived code with a numeric suffix but never rewrites a typed one', async () => {
    const user = userEvent.setup();
    renderInvoice();
    await screen.findByText('Select a customer…');
    await waitFor(() => expect(screen.getByRole('option', { name: /GEN-00001/ })).toBeInTheDocument());

    itemPostStatuses = [409];
    await user.selectOptions(screen.getByLabelText('Item for line 1'), '＋ New product or service…');
    let dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Web design');
    await user.click(within(dialog).getByRole('button', { name: 'Create and use' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(itemPosts.map((b) => b.code)).toEqual(['WEB-DESIGN', 'WEB-DESIGN-2']);

    // A code the person typed is not silently changed: the 409 is shown instead.
    itemPosts = [];
    itemPostStatuses = [409];
    await user.selectOptions(screen.getByLabelText('Item for line 1'), '＋ New product or service…');
    dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Other');
    await user.clear(within(dialog).getByLabelText('Code'));
    await user.type(within(dialog).getByLabelText('Code'), 'MINE');
    await user.click(within(dialog).getByRole('button', { name: 'Create and use' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The code MINE is already used');
    expect(itemPosts).toHaveLength(1);
  });

  it('on a bill it captures the purchase price and an expense account', async () => {
    const user = userEvent.setup();
    renderBill();
    await screen.findByText('Select a vendor…');
    await waitFor(() => expect(screen.getByRole('option', { name: /GEN-00001/ })).toBeInTheDocument());

    await user.selectOptions(screen.getByLabelText('Item for line 1'), '＋ New product or service…');
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Paper');
    await user.selectOptions(within(dialog).getByLabelText('Type'), 'NON_INVENTORY');
    await user.type(within(dialog).getByLabelText('Purchase price'), '4.50');
    await user.selectOptions(within(dialog).getByLabelText('Expense account'), 'acc-6100');
    await user.click(within(dialog).getByRole('button', { name: 'Create and use' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(itemPosts[0]).toMatchObject({
      itemType: 'NON_INVENTORY',
      purchasePriceCents: 450,
      salePriceCents: null,
      expenseAccountId: 'acc-6100',
    });
    expect(screen.getByLabelText('Account for line 1')).toHaveValue('acc-6100');
    expect(screen.getByLabelText('Unit price for line 1')).toHaveValue('4.50');
    expect(posted).toBeNull();
  });

  it('cancelling leaves the line exactly as it was', async () => {
    const user = userEvent.setup();
    renderInvoice();
    await screen.findByText('Select a customer…');
    await waitFor(() => expect(screen.getByRole('option', { name: /GEN-00001/ })).toBeInTheDocument());

    await user.type(screen.getByLabelText('Description for line 1'), 'Typed by hand');
    await user.selectOptions(screen.getByLabelText('Item for line 1'), '＋ New product or service…');
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Item for line 1')).toHaveValue('');
    expect(screen.getByLabelText('Description for line 1')).toHaveValue('Typed by hand');
    expect(itemPosts).toHaveLength(0);
  });
});
