import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ChartSettingsPage from '../Pages/settings/ChartSettingsPage';
import ConversionBalancesPage from '../Pages/settings/ConversionBalancesPage';
import FinancialSettingsPage from '../Pages/settings/FinancialSettingsPage';
import { LedgerSettingsProvider } from '../context/LedgerSettingsContext';
import type { Account, AccountType, InvoiceSettings, LedgerSettings } from '../services/fetchServices';

/**
 * Phase 30 Step 23 — the three new Accounting settings tabs
 * (`FinancialSettingsPage`, `ChartSettingsPage`, `ConversionBalancesPage`).
 * None of these three pages has been tested before this file.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input.toString();
}

function requestMethod(init?: RequestInit): string {
  return init?.method ?? 'GET';
}

function callsTo(fetchMock: ReturnType<typeof vi.fn>, method: string, urlPredicate: (url: string) => boolean): unknown[][] {
  return fetchMock.mock.calls.filter((call: unknown[]) => {
    const init = call[1] as RequestInit | undefined;
    return requestMethod(init) === method && urlPredicate(requestUrl(call[0] as RequestInfo | URL));
  });
}

function bodyOf(call: unknown[] | undefined): Record<string, unknown> {
  const init = call?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
}

function makeAccount(overrides: {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  isPostable?: boolean;
  isActive?: boolean;
}): Account {
  return {
    id: overrides.id,
    code: overrides.code,
    name: overrides.name,
    type: overrides.type,
    parentId: null,
    isPostable: overrides.isPostable ?? true,
    isActive: overrides.isActive ?? true,
    description: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function baseLedgerSettings(overrides: Partial<LedgerSettings> = {}): LedgerSettings {
  return {
    organizationName: 'Harbor Point Fabrication',
    legalName: 'Harbor Point Fabrication Pty Ltd',
    baseCurrency: 'USD',
    fiscalYearStartMonth: 4,
    fiscalYearStartDay: 1,
    booksStartDate: '2026-01-01',
    industry: 'Manufacturing',
    timezone: 'UTC',
    cashAccountId: null,
    onboardedAt: '2026-01-02T00:00:00.000Z',
    currentFiscalYear: { startDate: '2026-04-01', endDate: '2027-03-31', label: 'FY 2026–27' },
    baseCurrencyLocked: false,
    realizedFxGainAccountId: null,
    realizedFxLossAccountId: null,
    unrealizedFxAccountId: null,
    inventoryAccountId: null,
    cogsAccountId: null,
    inventoryAdjustmentAccountId: null,
    stockOpeningAccountId: null,
    ...overrides,
  };
}

function baseInvoiceSettings(overrides: Partial<InvoiceSettings> = {}): InvoiceSettings {
  return {
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
    showBusinessNumber: true,
    showLegalName: true,
    billingAddress: null,
    paymentTerms: null,
    footerNotes: null,
    accentColor: '#0f172a',
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

/* ------------------------------------------------------------------ FinancialSettingsPage */

describe('FinancialSettingsPage', () => {
  beforeEach(() => {
    // Pinned so the derived "Financial year end" line is deterministic — the
    // page computes it from `new Date()` at render time, not from a prop.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-15T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function mockRoutes(options: { onPatch?: (body: Record<string, unknown>) => Response } = {}) {
    const settings = baseLedgerSettings();
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const method = requestMethod(init);
      if (url.endsWith('/api/v1/settings') && method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        if (options.onPatch !== undefined) return Promise.resolve(options.onPatch(body));
        return Promise.resolve(jsonResponse(200, { success: true, settings: { ...settings, ...body } }));
      }
      if (url.endsWith('/api/v1/settings')) {
        return Promise.resolve(jsonResponse(200, { success: true, settings }));
      }
      if (url.includes('/api/v1/fiscal-periods')) {
        return Promise.resolve(jsonResponse(200, { success: true, count: 0, periods: [] }));
      }
      if (url.endsWith('/api/v1/accounts')) {
        return Promise.resolve(jsonResponse(200, { success: true, count: 0, accounts: [] }));
      }
      return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
    });
  }

  function renderPage() {
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

  it('shows the derived financial year end for a 1 April fiscal year', async () => {
    mockRoutes();
    renderPage();

    expect(await screen.findByText('31 March 2027')).toBeInTheDocument();
  });

  it('changing the month and saving fires PATCH /settings carrying fiscalYearStartMonth', async () => {
    mockRoutes();
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('31 March 2027');
    await user.selectOptions(screen.getByLabelText('Fiscal year starts in'), 'July');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(callsTo(fetchMock, 'PATCH', (url) => url.endsWith('/api/v1/settings'))).toHaveLength(1),
    );
    const [call] = callsTo(fetchMock, 'PATCH', (url) => url.endsWith('/api/v1/settings'));
    expect(bodyOf(call)).toMatchObject({ fiscalYearStartMonth: 7 });
  });

  it('shows the onboarding message and a link to the wizard on a 409', async () => {
    mockRoutes({
      onPatch: () =>
        jsonResponse(409, { success: false, error: 'Complete setup before changing settings' }),
    });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('31 March 2027');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Complete setup before changing settings')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the setup wizard' })).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ ChartSettingsPage */

describe('ChartSettingsPage', () => {
  function mockRoutes(options: { createResponse?: Response } = {}) {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const method = requestMethod(init);
      if (url.includes('/api/v1/accounts?tree=true')) {
        return Promise.resolve(jsonResponse(200, { success: true, count: 0, accounts: [] }));
      }
      if (url.endsWith('/api/v1/accounts') && method === 'POST') {
        if (options.createResponse !== undefined) return Promise.resolve(options.createResponse);
        return Promise.resolve(jsonResponse(201, { success: true, account: makeAccount({ id: 'acc-new', code: '9000', name: 'New', type: 'Asset' }) }));
      }
      return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
    });
  }

  function renderPage() {
    return render(
      <MemoryRouter initialEntries={['/settings/chart']}>
        <Routes>
          <Route path="/settings/chart" element={<ChartSettingsPage />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('renders exactly five type-group headings, in the fixed order, never a sixth', async () => {
    mockRoutes();
    renderPage();

    const headings = await screen.findAllByText((content) =>
      ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'].includes(content),
    );
    expect(headings.map((h) => h.textContent)).toEqual(['Asset', 'Liability', 'Equity', 'Revenue', 'Expense']);
  });

  it('surfaces a duplicate account code from the reused NewAccountForm', async () => {
    mockRoutes({
      createResponse: jsonResponse(409, { success: false, error: 'Account code already exists' }),
    });
    const user = userEvent.setup();
    renderPage();

    await screen.findAllByText('Expense');
    const addButtons = screen.getAllByRole('button', { name: 'Add account' });
    // Order matches ACCOUNT_TYPES: Asset, Liability, Equity, Revenue, Expense.
    await user.click(addButtons[4] as HTMLElement);

    await user.type(screen.getByLabelText('Code'), '6120');
    await user.type(screen.getByLabelText('Name'), 'Duplicate Expense');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('Account code already exists')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ ConversionBalancesPage */

describe('ConversionBalancesPage', () => {
  const accId = {
    header: 'acc-1000',
    cash: 'acc-1110',
    receivableCode1120: 'acc-1120',
    receivableConfigured: 'acc-1130',
    payable: 'acc-2100',
    retainedEarnings: 'acc-3200',
    revenue: 'acc-4100',
    expense: 'acc-6100',
    inactiveExpense: 'acc-9999',
  };

  function accountsFixture(): Account[] {
    return [
      makeAccount({ id: accId.header, code: '1000', name: 'Assets', type: 'Asset', isPostable: false }),
      makeAccount({ id: accId.cash, code: '1110', name: 'Operating Cash', type: 'Asset' }),
      makeAccount({ id: accId.receivableCode1120, code: '1120', name: 'Accounts Receivable', type: 'Asset' }),
      makeAccount({
        id: accId.receivableConfigured,
        code: '1130',
        name: 'Trade Receivables (Custom)',
        type: 'Asset',
      }),
      makeAccount({ id: accId.payable, code: '2100', name: 'Accounts Payable', type: 'Liability' }),
      makeAccount({ id: accId.retainedEarnings, code: '3200', name: 'Retained Earnings', type: 'Equity' }),
      makeAccount({ id: accId.revenue, code: '4100', name: 'Sales Revenue', type: 'Revenue' }),
      makeAccount({ id: accId.expense, code: '6100', name: 'Office Expenses', type: 'Expense' }),
      makeAccount({ id: accId.inactiveExpense, code: '9999', name: 'Old Suspense', type: 'Expense', isActive: false }),
    ];
  }

  function mockRoutes(
    options: {
      onSaveDate?: (body: Record<string, unknown>) => Response;
      onCreateImport?: (body: Record<string, unknown>) => Response;
    } = {},
  ) {
    const settings = baseLedgerSettings({ booksStartDate: '2026-01-01' });
    const invoiceSettings = baseInvoiceSettings({ receivableAccountId: accId.receivableConfigured });

    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const method = requestMethod(init);

      if (url.endsWith('/api/v1/settings') && method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        if (options.onSaveDate !== undefined) return Promise.resolve(options.onSaveDate(body));
        return Promise.resolve(jsonResponse(200, { success: true, settings: { ...settings, ...body } }));
      }
      if (url.endsWith('/api/v1/settings')) {
        return Promise.resolve(jsonResponse(200, { success: true, settings }));
      }
      if (url.endsWith('/api/v1/settings/invoicing')) {
        return Promise.resolve(jsonResponse(200, { success: true, invoiceSettings }));
      }
      if (url.endsWith('/api/v1/accounts')) {
        return Promise.resolve(jsonResponse(200, { success: true, count: accountsFixture().length, accounts: accountsFixture() }));
      }
      if (url.endsWith('/api/v1/migration-imports') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        if (options.onCreateImport !== undefined) return Promise.resolve(options.onCreateImport(body));
        return Promise.resolve(
          jsonResponse(201, {
            success: true,
            import: {
              id: 'imp-77',
              kind: 'OPENING_BALANCES',
              status: 'DRAFT',
              fileName: 'conversion-balances.csv',
              delimiter: ',',
              rowCount: 0,
              errorCount: 0,
              validCount: 0,
              excludedCount: 0,
              journalEntryId: null,
              committedAt: null,
              createdBy: 'u1',
              createdByName: 'Ada',
              createdAt: new Date().toISOString(),
            },
            rows: [],
          }),
        );
      }
      return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
    });
  }

  function renderPage() {
    return render(
      <MemoryRouter initialEntries={['/settings/conversion-balances']}>
        <Routes>
          <Route
            path="/settings/conversion-balances"
            element={
              <LedgerSettingsProvider>
                <ConversionBalancesPage />
              </LedgerSettingsProvider>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
  }

  async function ready() {
    return screen.findByRole('button', { name: 'Load chart' });
  }

  async function addRow(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'Add row' }));
  }

  it('never offers retained earnings, the payable account or the configured receivable account as options', async () => {
    mockRoutes();
    const user = userEvent.setup();
    renderPage();

    await ready();
    await addRow(user);

    const select = screen.getByLabelText('Account for row 1');
    expect(within(select).queryByRole('option', { name: /3200/ })).toBeNull();
    expect(within(select).queryByRole('option', { name: /2100/ })).toBeNull();
    expect(within(select).queryByRole('option', { name: /1130/ })).toBeNull();
    // The code-1120 fallback is NOT excluded once the org has a configured
    // receivable override — only the configured id is.
    expect(within(select).queryByRole('option', { name: /1120/ })).not.toBeNull();
  });

  it('Load chart populates one row per postable, active, non-excluded account with empty amounts', async () => {
    mockRoutes();
    const user = userEvent.setup();
    renderPage();

    await ready();
    await user.click(screen.getByRole('button', { name: 'Load chart' }));

    // Eligible: 1110, 1120, 4100, 6100 — header (1000), 1130/2100/3200 (excluded)
    // and the inactive 9999 all excluded.
    const debitInputs = await screen.findAllByLabelText(/^Debit for row/);
    expect(debitInputs).toHaveLength(4);
    for (const input of debitInputs) {
      expect(input).toHaveValue('');
    }
  });

  it('a balanced grid shows "Balanced" and enables Save and review', async () => {
    mockRoutes();
    const user = userEvent.setup();
    renderPage();

    await ready();
    await addRow(user);
    await addRow(user);

    await user.selectOptions(screen.getByLabelText('Account for row 1'), accId.cash);
    await user.type(screen.getByLabelText('Debit for row 1'), '1000.00');
    await user.selectOptions(screen.getByLabelText('Account for row 2'), accId.revenue);
    await user.type(screen.getByLabelText('Credit for row 2'), '1000.00');

    expect(await screen.findByText('Balanced')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save and review' })).not.toBeDisabled();
  });

  it('an unbalanced grid disables Save and review and shows the exact cent difference', async () => {
    mockRoutes();
    const user = userEvent.setup();
    renderPage();

    await ready();
    await addRow(user);
    await addRow(user);

    await user.selectOptions(screen.getByLabelText('Account for row 1'), accId.cash);
    await user.type(screen.getByLabelText('Debit for row 1'), '1000.00');
    await user.selectOptions(screen.getByLabelText('Account for row 2'), accId.revenue);
    await user.type(screen.getByLabelText('Credit for row 2'), '999.99');

    // 100000 cents debit vs 99999 cents credit is a 1-cent difference —
    // formatCents(1) is "0.01". (The plan's table paired these totals with
    // "Out of balance by 1.00"; that figure is arithmetically inconsistent
    // with its own two numbers — 100000 - 99999 = 1 cent, not 100 cents/$1 —
    // so this asserts the real integer-cent difference rather than encode a
    // wrong expectation. See the step report.)
    expect(await screen.findByText(/Out of balance by 0\.01/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save and review' })).toBeDisabled();
  });

  it('a row with both a debit and a credit is refused inline and excluded from the totals', async () => {
    mockRoutes();
    const user = userEvent.setup();
    renderPage();

    await ready();
    await addRow(user);

    await user.selectOptions(screen.getByLabelText('Account for row 1'), accId.cash);
    await user.type(screen.getByLabelText('Debit for row 1'), '100.00');
    await user.type(screen.getByLabelText('Credit for row 1'), '50.00');

    expect(await screen.findByText('A row carries a debit or a credit, not both.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save and review' })).toBeDisabled();
    expect(screen.queryByText('Balanced')).not.toBeInTheDocument();
    expect(screen.queryByText(/Out of balance by/)).not.toBeInTheDocument();
  });

  it('a malformed amount refuses to save with the two-decimal-place message', async () => {
    mockRoutes();
    const user = userEvent.setup();
    renderPage();

    await ready();
    await addRow(user);

    await user.selectOptions(screen.getByLabelText('Account for row 1'), accId.cash);
    await user.type(screen.getByLabelText('Debit for row 1'), '1.234');

    expect(await screen.findByText('Amounts take at most two decimal places.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save and review' })).toBeDisabled();
  });

  it('Save and review posts a CSV whose Debit cell is a decimal string, never raw cents', async () => {
    mockRoutes();
    const user = userEvent.setup();
    renderPage();

    await ready();
    await addRow(user);
    await addRow(user);

    await user.selectOptions(screen.getByLabelText('Account for row 1'), accId.cash);
    await user.type(screen.getByLabelText('Debit for row 1'), '5000.00');
    await user.selectOptions(screen.getByLabelText('Account for row 2'), accId.revenue);
    await user.type(screen.getByLabelText('Credit for row 2'), '5000.00');

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save and review' })).not.toBeDisabled());
    await user.click(screen.getByRole('button', { name: 'Save and review' }));

    await waitFor(() =>
      expect(callsTo(fetchMock, 'POST', (url) => url.endsWith('/api/v1/migration-imports'))).toHaveLength(1),
    );
    const [call] = callsTo(fetchMock, 'POST', (url) => url.endsWith('/api/v1/migration-imports'));
    const body = bodyOf(call);
    expect(body.kind).toBe('OPENING_BALANCES');
    const content = body.content as string;
    const lines = content.split('\n');
    expect(lines[0]).toBe('Code,Debit,Credit');
    // The money bridge: 500000 cents typed as "5000.00" must serialise back
    // to the decimal string "5000.00", never the raw-cents integer "500000".
    expect(lines).toContain('1110,5000.00,0.00');
    expect(content).not.toContain('500000');
  });

  it('a row with both sides zero is silently dropped from the CSV, not sent as 0.00,0.00', async () => {
    mockRoutes();
    const user = userEvent.setup();
    renderPage();

    await ready();
    await addRow(user);
    await addRow(user);
    await addRow(user);

    await user.selectOptions(screen.getByLabelText('Account for row 1'), accId.cash);
    await user.type(screen.getByLabelText('Debit for row 1'), '5000.00');
    await user.selectOptions(screen.getByLabelText('Account for row 2'), accId.revenue);
    await user.type(screen.getByLabelText('Credit for row 2'), '5000.00');
    // Row 3: an account picked, but no amount typed on either side.
    await user.selectOptions(screen.getByLabelText('Account for row 3'), accId.expense);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save and review' })).not.toBeDisabled());
    await user.click(screen.getByRole('button', { name: 'Save and review' }));

    await waitFor(() =>
      expect(callsTo(fetchMock, 'POST', (url) => url.endsWith('/api/v1/migration-imports'))).toHaveLength(1),
    );
    const [call] = callsTo(fetchMock, 'POST', (url) => url.endsWith('/api/v1/migration-imports'));
    const content = bodyOf(call).content as string;
    expect(content).not.toContain('6100');
    expect(content.split('\n').filter((line) => line !== '')).toHaveLength(3); // header + 2 rows
  });

  it('Save date fires one PATCH /settings carrying booksStartDate', async () => {
    mockRoutes();
    renderPage();

    await ready();
    const dateInput = screen.getByLabelText('Conversion date');
    fireEvent.change(dateInput, { target: { value: '2026-03-01' } });

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Save date' }));

    await waitFor(() =>
      expect(callsTo(fetchMock, 'PATCH', (url) => url.endsWith('/api/v1/settings'))).toHaveLength(1),
    );
    const [call] = callsTo(fetchMock, 'PATCH', (url) => url.endsWith('/api/v1/settings'));
    expect(bodyOf(call)).toMatchObject({ booksStartDate: '2026-03-01' });
  });
});
