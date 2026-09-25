import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import InventoryNewItemPage from '../Pages/inventory/InventoryNewItemPage';
import type { StockAttributeDefinition, StockCategory, StockCodeScheme, StockUom } from '../services/fetchServices';

/**
 * StockLedger (Phase 28) — the new-item form: dynamic custom fields from
 * the chosen category, live code-scheme preview, manual-code upper-casing.
 * Renders under AuthProvider, mirroring UniteconSettingsPage's tests.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function sessionFor(role: 'OWNER') {
  return {
    success: true,
    user: { id: 'u1', name: 'Ada', email: 'ada@example.com', emailVerified: false, createdAt: new Date().toISOString() },
    organization: { id: 'o1', name: 'Acme', slug: 'acme', baseCurrency: 'USD', createdAt: new Date().toISOString() },
    role,
    memberships: [{ orgId: 'o1', orgName: 'Acme', orgSlug: 'acme', role, joinedAt: new Date().toISOString() }],
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  };
}

const categories: StockCategory[] = [
  {
    id: 'cat-res',
    code: 'RES',
    name: 'Residential units',
    parentId: null,
    path: 'Residential units',
    depth: 1,
    itemType: 'PROPERTY_UNIT',
    defaultTracking: 'SERIAL',
    defaultUomId: 'uom-unit',
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

const uoms: StockUom[] = [
  { id: 'uom-unit', code: 'UNIT', name: 'Unit', decimalPlaces: 0, isActive: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
];

const codeSchemes: StockCodeScheme[] = [
  {
    id: 'scheme-1',
    name: 'Category + number',
    pattern: '{CAT}-{SEQ:4}',
    isDefault: true,
    isActive: true,
    example: 'RES-0001',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

const resAttributes: StockAttributeDefinition[] = [
  { id: 'attr-project', categoryId: 'cat-res', appliesTo: 'ITEM', key: 'project', label: 'Project', dataType: 'TEXT', options: null, decimalPlaces: null, isRequired: true, sortOrder: 0, isActive: true },
  { id: 'attr-config', categoryId: 'cat-res', appliesTo: 'ITEM', key: 'configuration', label: 'Configuration', dataType: 'SELECT', options: ['Studio', '1 BHK', '2 BHK'], decimalPlaces: null, isRequired: true, sortOrder: 1, isActive: true },
  { id: 'attr-area', categoryId: 'cat-res', appliesTo: 'ITEM', key: 'area', label: 'Area', dataType: 'NUMBER', options: null, decimalPlaces: 2, isRequired: false, sortOrder: 2, isActive: true },
];

let fetchMock: ReturnType<typeof vi.fn>;
let postItemBody: Record<string, unknown> | null;
let itemsPostStatus: number;
let itemsPostError: string;

beforeEach(() => {
  postItemBody = null;
  itemsPostStatus = 201;
  itemsPostError = '';
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockRoutes() {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, sessionFor('OWNER')));
    if (url.includes('/ledger-core/accounts')) {
      const at = new Date().toISOString();
      const make = (id: string, code: string, name: string, type: string) => ({ id, code, name, type, parentId: null, isPostable: true, isActive: true, description: null, createdAt: at, updatedAt: at });
      return Promise.resolve(
        jsonResponse(200, {
          success: true,
          count: 3,
          accounts: [make('acc-4100', '4100', 'Product Revenue', 'Revenue'), make('acc-1140', '1140', 'Inventory', 'Asset'), make('acc-5050', '5050', 'Cost of Sales — Inventory', 'Expense')],
        }),
      );
    }
    if (url.includes('/stock/categories/cat-res')) {
      return Promise.resolve(jsonResponse(200, { success: true, category: categories[0], attributes: resAttributes }));
    }
    if (url.includes('/stock/categories')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: categories.length, categories }));
    }
    if (url.includes('/stock/uoms')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: uoms.length, uoms }));
    }
    if (url.includes('/stock/code-schemes/preview')) {
      return Promise.resolve(jsonResponse(200, { success: true, valid: true, example: 'RES-0001', scopeKey: 'RES-#' }));
    }
    if (url.includes('/stock/code-schemes')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: codeSchemes.length, codeSchemes }));
    }
    if (url.includes('/stock/items')) {
      if (init?.method === 'POST') {
        postItemBody = init.body !== undefined ? (JSON.parse(init.body as string) as Record<string, unknown>) : null;
        if (itemsPostStatus !== 201) {
          return Promise.resolve(jsonResponse(itemsPostStatus, { success: false, error: itemsPostError }));
        }
        return Promise.resolve(
          jsonResponse(201, {
            success: true,
            item: { id: 'item-1', code: 'RES-0001', name: 'Test', description: null, categoryId: 'cat-res', categoryName: 'Residential units', itemType: 'PROPERTY_UNIT', tracking: 'SERIAL', uomId: 'uom-unit', uomCode: 'UNIT', uomDecimalPlaces: 0, codeSchemeId: 'scheme-1', barcode: null, attributes: {}, reorderPointMilli: null, onHandQuantityMilli: 0, onHandValueCents: 0, isActive: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
          }),
        );
      }
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/inventory/items/new']}>
      <AuthProvider>
        <Routes>
          <Route path="/inventory/items/new" element={<InventoryNewItemPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('InventoryNewItemPage', () => {
  it('choosing Residential units renders its required custom fields', async () => {
    mockRoutes();
    const user = userEvent.setup();
    renderPage();

    const categorySelect = await screen.findByLabelText('Category *');
    await user.selectOptions(categorySelect, 'cat-res');

    expect(await screen.findByLabelText('Project *')).toBeInTheDocument();
    expect(screen.getByLabelText('Configuration *')).toBeInTheDocument();
  });

  it('NUMBER field keeps a string value', async () => {
    mockRoutes();
    const user = userEvent.setup();
    renderPage();

    await user.selectOptions(await screen.findByLabelText('Category *'), 'cat-res');
    await user.type(await screen.findByLabelText('Name *'), 'Skyline Unit 1204');
    await user.type(screen.getByLabelText('Project *'), 'Skyline');
    await user.selectOptions(screen.getByLabelText('Configuration *'), '2 BHK');
    await user.type(screen.getByLabelText('Area'), '1180.50');

    await user.click(screen.getByRole('button', { name: 'Create item' }));

    await waitFor(() => expect(postItemBody).not.toBeNull());
    expect((postItemBody?.attributes as Record<string, unknown>).area).toBe('1180.50');
  });

  it('sends the accounting side of the linked product (prices in integer cents, chosen accounts)', async () => {
    mockRoutes();
    const user = userEvent.setup();
    renderPage();

    await user.selectOptions(await screen.findByLabelText('Category *'), 'cat-res');
    await user.type(await screen.findByLabelText('Name *'), 'Skyline Unit 1204');
    await user.type(screen.getByLabelText('Project *'), 'Skyline');
    await user.selectOptions(screen.getByLabelText('Configuration *'), '2 BHK');

    await user.type(screen.getByLabelText('Sale price'), '2500.00');
    await user.type(screen.getByLabelText('Purchase price'), '1000.50');
    await waitFor(() => expect(screen.getByRole('option', { name: '1140 · Inventory' })).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText('Inventory account'), 'acc-1140');

    await user.click(screen.getByRole('button', { name: 'Create item' }));

    await waitFor(() => expect(postItemBody).not.toBeNull());
    expect(postItemBody?.product).toMatchObject({
      salePriceCents: 250000,
      purchasePriceCents: 100050,
      assetAccountId: 'acc-1140',
      revenueAccountId: null,
      cogsAccountId: null,
    });
  });

  it('only offers accounts of the right type in each account select', async () => {
    mockRoutes();
    renderPage();

    await screen.findByLabelText('Inventory account');
    await waitFor(() => expect(screen.getByRole('option', { name: '1140 · Inventory' })).toBeInTheDocument());
    const inventory = screen.getByLabelText('Inventory account');
    expect(Array.from(inventory.querySelectorAll('option')).map((o) => o.textContent)).toEqual(['Default', '1140 · Inventory']);
    const cogs = screen.getByLabelText('Cost of sales account');
    expect(Array.from(cogs.querySelectorAll('option')).map((o) => o.textContent)).toEqual(['Default', '5050 · Cost of Sales — Inventory']);
  });

  it('shows the live generated-code preview', async () => {
    mockRoutes();
    const user = userEvent.setup();
    renderPage();

    await user.selectOptions(await screen.findByLabelText('Category *'), 'cat-res');

    expect(await screen.findByText('RES-0001')).toBeInTheDocument();
  });

  it('manual code is upper-cased on blur', async () => {
    mockRoutes();
    const user = userEvent.setup();
    renderPage();

    await user.selectOptions(await screen.findByLabelText('Category *'), 'cat-res');
    await user.click(screen.getByRole('radio', { name: 'Enter manually' }));

    const codeInput = screen.getByLabelText('Item code') as HTMLInputElement;
    fireEvent.change(codeInput, { target: { value: 'res-0099' } });
    fireEvent.blur(codeInput);

    expect(codeInput.value).toBe('RES-0099');
  });

  it('server 422 message is shown verbatim', async () => {
    itemsPostStatus = 422;
    itemsPostError = 'Invalid attributes: Attribute "Project" is required';
    mockRoutes();
    const user = userEvent.setup();
    renderPage();

    await user.selectOptions(await screen.findByLabelText('Category *'), 'cat-res');
    await user.type(await screen.findByLabelText('Name *'), 'Skyline Unit 1204');
    // The form's own HTML5 `required` attributes (matching the server's own
    // required-attribute rule) block a native submit until these are filled
    // too — the 422 this test exercises is the server rejecting something
    // the client-side constraints cannot catch, not a stand-in for them.
    await user.type(screen.getByLabelText('Project *'), 'Skyline');
    await user.selectOptions(screen.getByLabelText('Configuration *'), '2 BHK');
    await user.click(screen.getByRole('button', { name: 'Create item' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid attributes: Attribute "Project" is required');
  });
});
