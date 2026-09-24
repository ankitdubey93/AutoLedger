import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import StockMovementPage from '../Pages/stock/StockMovementPage';
import type { StockItem, StockLocation, StockLot } from '../services/fetchServices';

/**
 * StockLedger (Phase 28) — the movement entry form. Renders under
 * AuthProvider (role gates the whole page), mirroring UniteconSettingsPage's
 * tests.
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

const locations: StockLocation[] = [
  { id: 'loc-main', code: 'MAIN', name: 'Main warehouse', kind: 'WAREHOUSE', parentId: null, path: 'MAIN', depth: 1, isActive: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
];

function makeItem(overrides: Partial<StockItem>): StockItem {
  return {
    id: 'item-1',
    code: 'CMP-00001',
    name: 'Bolt',
    description: null,
    categoryId: 'cat-1',
    categoryName: 'Components',
    itemType: 'COMPONENT',
    tracking: 'QUANTITY',
    uomId: 'uom-1',
    uomCode: 'KG',
    uomDecimalPlaces: 3,
    codeSchemeId: null,
    barcode: null,
    attributes: {},
    reorderPointMilli: null,
    onHandQuantityMilli: 0,
    onHandValueCents: 0,
    ledgerItemId: null,
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const quantityItem = makeItem({});
const wholeUnitItem = makeItem({ id: 'item-2', code: 'CMP-00002', uomCode: 'EA', uomDecimalPlaces: 0 });
const lotItem = makeItem({ id: 'item-3', code: 'RM-00001', tracking: 'LOT', uomCode: 'KG', uomDecimalPlaces: 3 });
const serialItem = makeItem({ id: 'item-4', code: 'DEV-00001', tracking: 'SERIAL', uomCode: 'EA', uomDecimalPlaces: 0 });

const lots: StockLot[] = [
  { id: 'lot-2', itemId: 'item-3', lotNumber: 'L2', manufacturedOn: null, expiresOn: '2027-01-15', onHandQuantityMilli: 1000, createdAt: new Date().toISOString() },
  { id: 'lot-1', itemId: 'item-3', lotNumber: 'L1', manufacturedOn: null, expiresOn: '2027-03-01', onHandQuantityMilli: 1000, createdAt: new Date().toISOString() },
];

let fetchMock: ReturnType<typeof vi.fn>;
let receiptBody: Record<string, unknown> | null;
let issueStatus: number;
let issueError: string;
let searchResults: StockItem[];

beforeEach(() => {
  receiptBody = null;
  issueStatus = 201;
  issueError = '';
  searchResults = [quantityItem];
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
    if (url.includes('/stock/locations')) return Promise.resolve(jsonResponse(200, { success: true, count: locations.length, locations }));
    if (url.includes('/stock/items?q=')) return Promise.resolve(jsonResponse(200, { success: true, count: searchResults.length, totalCount: searchResults.length, currentPage: 1, totalPages: 1, items: searchResults }));
    if (url.includes('/item-3/lots')) return Promise.resolve(jsonResponse(200, { success: true, count: lots.length, lots }));
    if (url.includes('/stock/categories/')) return Promise.resolve(jsonResponse(200, { success: true, category: { id: 'cat-1' }, attributes: [] }));
    if (url.includes('/stock/receipts')) {
      receiptBody = init?.body !== undefined ? (JSON.parse(init.body as string) as Record<string, unknown>) : null;
      return Promise.resolve(jsonResponse(201, { success: true, movementGroupId: 'grp-1', movements: [{ id: 'mv-1' }] }));
    }
    if (url.includes('/stock/issues')) {
      if (issueStatus !== 201) {
        return Promise.resolve(jsonResponse(issueStatus, { success: false, error: issueError }));
      }
      return Promise.resolve(jsonResponse(201, { success: true, movementGroupId: 'grp-2', movements: [{ id: 'mv-2' }] }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/app/stock/movements']}>
      <AuthProvider>
        <Routes>
          <Route path="/app/:appSlug/movements" element={<StockMovementPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

async function selectFirstLineItem(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Search item'), 'C');
  const result = await screen.findByRole('button', { name: /Bolt|RM-00001|DEV-00001/ });
  await user.click(result);
}

describe('StockMovementPage', () => {
  it('receive a QUANTITY line posts integer milli and cents', async () => {
    searchResults = [quantityItem];
    mockRoutes();
    const user = userEvent.setup();
    renderPage();

    await user.selectOptions(await screen.findByLabelText('Location'), 'loc-main');
    await selectFirstLineItem(user);

    await user.type(screen.getByLabelText('Quantity'), '2.5');
    await user.type(screen.getByLabelText('Unit cost'), '19.99');
    await user.click(screen.getByRole('button', { name: 'Post' }));

    await waitFor(() => expect(receiptBody).not.toBeNull());
    const line = (receiptBody?.lines as Record<string, unknown>[])[0] as Record<string, unknown>;
    expect(line.quantityMilli).toBe(2500);
    expect(line.unitCostCents).toBe(1999);
  });

  it('too many decimals disables submit', async () => {
    searchResults = [wholeUnitItem];
    mockRoutes();
    const user = userEvent.setup();
    renderPage();

    await user.selectOptions(await screen.findByLabelText('Location'), 'loc-main');
    await selectFirstLineItem(user);

    await user.type(screen.getByLabelText('Quantity'), '2.5');

    expect(screen.getByRole('alert')).toHaveTextContent('Too many decimal places for EA');
    expect(screen.getByRole('button', { name: 'Post' })).toBeDisabled();
  });

  it('LOT issue pre-selects the earliest-expiring lot', async () => {
    searchResults = [lotItem];
    mockRoutes();
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('tab', { name: 'Receive' });
    await user.click(screen.getByRole('tab', { name: 'Issue' }));
    await user.selectOptions(await screen.findByLabelText('Location'), 'loc-main');
    await selectFirstLineItem(user);

    const lotSelect = (await screen.findByLabelText('Lot')) as HTMLSelectElement;
    await waitFor(() => expect(lotSelect.value).toBe('lot-2'));
  });

  it('SERIAL receipt sends one serial per line', async () => {
    searchResults = [serialItem];
    mockRoutes();
    const user = userEvent.setup();
    renderPage();

    await user.selectOptions(await screen.findByLabelText('Location'), 'loc-main');
    await selectFirstLineItem(user);

    await user.type(await screen.findByLabelText('Serial numbers'), 'SN1\nSN2');
    await user.click(screen.getByRole('button', { name: 'Post' }));

    await waitFor(() => expect(receiptBody).not.toBeNull());
    const line = (receiptBody?.lines as Record<string, unknown>[])[0] as Record<string, unknown>;
    const serials = line.serials as { serialNumber: string }[];
    expect(serials).toHaveLength(2);
    expect(serials.map((s) => s.serialNumber)).toEqual(['SN1', 'SN2']);
  });

  it('shows the 409 insufficient-stock message verbatim', async () => {
    searchResults = [quantityItem];
    issueStatus = 409;
    issueError = 'Insufficient stock for item CMP-00001 at location MAIN';
    mockRoutes();
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('tab', { name: 'Receive' });
    await user.click(screen.getByRole('tab', { name: 'Issue' }));
    await user.selectOptions(await screen.findByLabelText('Location'), 'loc-main');
    await selectFirstLineItem(user);
    await user.type(screen.getByLabelText('Quantity'), '1');
    await user.click(screen.getByRole('button', { name: 'Post' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Insufficient stock for item CMP-00001 at location MAIN');
  });
});
