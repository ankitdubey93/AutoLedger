import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { OrgProvider } from '../context/OrgContext';
import { LedgerSettingsProvider } from '../context/LedgerSettingsContext';
import ProductRoutes from '../routes/ProductRoutes';
import FinancialSettingsPage from '../Pages/settings/FinancialSettingsPage';

/**
 * Characterisation of Accounting's Organization settings page (`/settings`).
 *
 * Phase 30 Step 20 moves the fiscal-year controls to the Financial tab. No test
 * rendered this page before, so nothing would have noticed a bad move — this
 * file pins what stays (Organization name, Legal name, Base currency, Industry,
 * Tax registration number, Business registration number, and the two-call
 * save) and what leaves.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const organization = {
  id: 'o1',
  name: 'Acme',
  slug: 'acme',
  baseCurrency: 'USD',
  taxNumber: 'TAX-123',
  businessNumber: 'BIZ-456',
  createdAt: new Date().toISOString(),
};

const session = {
  success: true,
  user: {
    id: 'u1',
    name: 'Ada',
    email: 'ada@example.com',
    emailVerified: false,
    createdAt: new Date().toISOString(),
  },
  organization,
  role: 'OWNER',
  memberships: [
    { orgId: 'o1', orgName: 'Acme', orgSlug: 'acme', role: 'OWNER', joinedAt: new Date().toISOString() },
  ],
  accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
};

const settings = {
  organizationName: 'Acme',
  legalName: 'Acme Holdings Ltd',
  baseCurrency: 'EUR',
  fiscalYearStartMonth: 4,
  fiscalYearStartDay: 1,
  booksStartDate: '2026-04-01',
  industry: 'Software',
  timezone: 'UTC',
  cashAccountId: null,
  onboardedAt: '2026-04-02T00:00:00.000Z',
  currentFiscalYear: { startDate: '2026-04-01', endDate: '2027-03-31', label: 'FY 2026–27' },
  baseCurrencyLocked: false,
  realizedFxGainAccountId: null,
  realizedFxLossAccountId: null,
  unrealizedFxAccountId: null,
  inventoryAccountId: null,
  cogsAccountId: null,
  inventoryAdjustmentAccountId: null,
  stockOpeningAccountId: null,
};

let fetchMock: ReturnType<typeof vi.fn>;

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input.toString();
}

function mockRoutes() {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/auth/check') || url.includes('/auth/refresh')) {
      return Promise.resolve(jsonResponse(200, session));
    }
    if (url.endsWith('/organizations') && method === 'PATCH') {
      return Promise.resolve(jsonResponse(200, { success: true, organization }));
    }
    if (url.endsWith('/api/v1/settings')) {
      return Promise.resolve(jsonResponse(200, { success: true, settings }));
    }
    if (url.includes('/api/v1/fiscal-periods')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: 0, periods: [] }));
    }
    if (url.includes('/api/v1/accounts')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: 0, accounts: [] }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function callsTo(method: string, pathSuffix: string): unknown[][] {
  return fetchMock.mock.calls.filter((call: unknown[]) => {
    const init = call[1] as RequestInit | undefined;
    return (init?.method ?? 'GET') === method && requestUrl(call[0] as RequestInfo | URL).endsWith(pathSuffix);
  });
}

function bodyOf(call: unknown[] | undefined): Record<string, unknown> {
  const init = call?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  mockRoutes();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderSettingsPage() {
  return render(
    <MemoryRouter initialEntries={['/settings/general']}>
      <AuthProvider>
        <OrgProvider>
          <Routes>
            <Route path="/*" element={<ProductRoutes />} />
          </Routes>
        </OrgProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('GeneralSettingsPage (Organization tab)', () => {
  it('renders the six organization controls with seeded values', async () => {
    renderSettingsPage();

    const legalName = await screen.findByLabelText('Legal name');
    await waitFor(() => expect(legalName).toHaveValue('Acme Holdings Ltd'));
    expect(screen.getByLabelText('Organization name')).toHaveValue('Acme');
    expect(screen.getByLabelText(/base currency/i)).toHaveValue('EUR');
    expect(screen.getByLabelText('Industry')).toHaveValue('Software');
    expect(screen.getByLabelText('Tax registration number')).toHaveValue('TAX-123');
    expect(screen.getByLabelText(/business registration number/i)).toHaveValue('BIZ-456');
  });

  it('saving after editing the name fires PATCH /organizations carrying name', async () => {
    renderSettingsPage();
    const user = userEvent.setup();

    const nameInput = await screen.findByLabelText('Organization name');
    // The form seeds itself in an effect after the first ready render; typing before that would race it.
    await waitFor(() => expect(screen.getByLabelText('Legal name')).toHaveValue('Acme Holdings Ltd'));
    await user.clear(nameInput);
    await user.type(nameInput, 'Acme Renamed');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(callsTo('PATCH', '/organizations')).toHaveLength(1));
    expect(bodyOf(callsTo('PATCH', '/organizations')[0])).toMatchObject({ name: 'Acme Renamed' });
  });

  it('saving after editing Legal name fires PATCH /settings carrying legalName', async () => {
    renderSettingsPage();
    const user = userEvent.setup();

    const legalInput = await screen.findByLabelText('Legal name');
    await waitFor(() => expect(legalInput).toHaveValue('Acme Holdings Ltd'));
    await user.clear(legalInput);
    await user.type(legalInput, 'Acme Legal Pty');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(callsTo('PATCH', '/api/v1/settings')).toHaveLength(1));
    expect(bodyOf(callsTo('PATCH', '/api/v1/settings')[0])).toMatchObject({ legalName: 'Acme Legal Pty' });
  });

  it('no longer shows the fiscal-year controls (they moved to the Financial tab)', async () => {
    renderSettingsPage();

    const legalName = await screen.findByLabelText('Legal name');
    await waitFor(() => expect(legalName).toHaveValue('Acme Holdings Ltd'));
    expect(screen.queryByLabelText(/fiscal year starts in/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Day')).not.toBeInTheDocument();
    expect(screen.queryByText(/this fiscal year runs/i)).not.toBeInTheDocument();
  });

  it('a save sends none of the four moved keys to PATCH /settings', async () => {
    renderSettingsPage();
    const user = userEvent.setup();

    const legalName = await screen.findByLabelText('Legal name');
    await waitFor(() => expect(legalName).toHaveValue('Acme Holdings Ltd'));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(callsTo('PATCH', '/api/v1/settings')).toHaveLength(1));
    const body = bodyOf(callsTo('PATCH', '/api/v1/settings')[0]);
    expect(body).toHaveProperty('legalName');
    expect(body).toHaveProperty('industry');
    for (const moved of ['fiscalYearStartMonth', 'fiscalYearStartDay', 'cashAccountId', 'timezone']) {
      expect(body).not.toHaveProperty(moved);
    }
  });

  it('links to the account page for address, contact details and logo', async () => {
    renderSettingsPage();

    const link = await screen.findByRole('link', {
      name: "Address, contact details and logo are on your account's Organisation page.",
    });
    expect(link).toHaveAttribute('href', '/account');
  });
});

/**
 * Phase 35a — the four inventory-account selects on the Financial tab
 * (`FinancialSettingsPage`). Mounted directly (as `settingsTabs.test.tsx`
 * mounts the same page) rather than through the full `ProductRoutes` shell —
 * the shell's sidebar needs several more unrelated fetches mocked and adds
 * nothing this case needs to prove.
 */
function renderFinancialTab() {
  return render(
    <MemoryRouter initialEntries={['/settings/financial']}>
      <Routes>
        <Route
          path="/settings/financial"
          element={
            <LedgerSettingsProvider>
              <FinancialSettingsPage />
            </LedgerSettingsProvider>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * Each `AccountSelect` wraps its hint text inside the same `<label>` as the
 * `<select>`, so the accessible name computed by `getByLabelText` is the
 * label text plus the hint ("Inventory Default: 1140 Inventory"), not the
 * bare field label — `getByLabelText('Inventory')`'s exact match never hits.
 * Scoping to the `#inventory` section and reading the four comboboxes by
 * position (Inventory, Cost of sales, Inventory adjustments, Opening stock —
 * the order they're declared in `FinancialSettingsPage`) sidesteps that.
 */
function inventorySelects(container: HTMLElement): HTMLSelectElement[] {
  const section = container.querySelector('#inventory');
  if (section === null) throw new Error('inventory accounting section not found');
  return within(section as HTMLElement).getAllByRole('combobox') as HTMLSelectElement[];
}

describe('FinancialSettingsPage — inventory accounting (Phase 35a)', () => {
  it('renders the four inventory selects, all unset', async () => {
    const { container } = renderFinancialTab();

    await screen.findByText('Inventory accounting');
    const [inventory, cogs, adjustment, opening] = inventorySelects(container);
    expect(inventory).toHaveValue('');
    expect(cogs).toHaveValue('');
    expect(adjustment).toHaveValue('');
    expect(opening).toHaveValue('');
  });

  it('saving with every inventory select left blank sends all four as null', async () => {
    const user = userEvent.setup();
    renderFinancialTab();

    await screen.findByText('Inventory accounting');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(callsTo('PATCH', '/api/v1/settings')).toHaveLength(1));
    const body = bodyOf(callsTo('PATCH', '/api/v1/settings')[0]);
    expect(body).toMatchObject({
      inventoryAccountId: null,
      cogsAccountId: null,
      inventoryAdjustmentAccountId: null,
      stockOpeningAccountId: null,
    });
  });
});
