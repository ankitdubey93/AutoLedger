import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AccountsPage from '../Pages/accounting/AccountsPage';
import ChartSettingsPage from '../Pages/settings/ChartSettingsPage';
import FinancialSettingsPage from '../Pages/settings/FinancialSettingsPage';
import { LedgerSettingsProvider } from '../context/LedgerSettingsContext';
import type { AccountNode, SystemAccountView } from '../services/fetchServices';

/**
 * Phase 46a — system account badges, the locked controls on the chart
 * settings page, and the System accounts section on the Financial tab.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function node(overrides: Partial<AccountNode> & Pick<AccountNode, 'id' | 'code' | 'name'>): AccountNode {
  return {
    type: 'Asset',
    parentId: null,
    isPostable: true,
    isActive: true,
    description: null,
    bankAccountKind: null,
    systemRoles: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    children: [],
    ...overrides,
  };
}

const receivable = node({
  id: 'acc-1120',
  code: '1120',
  name: 'Accounts Receivable',
  systemRoles: [{ role: 'RECEIVABLE', label: 'Accounts Receivable' }],
});

const header = node({
  id: 'acc-1000',
  code: '1000',
  name: 'Current Assets',
  isPostable: false,
  children: [receivable],
});

const systemAccounts: SystemAccountView[] = [
  {
    role: 'RECEIVABLE',
    label: 'Accounts Receivable',
    defaultCode: '1120',
    remappable: true,
    accountId: 'acc-1120',
    code: '1120',
    name: 'Accounts Receivable',
    isActive: true,
  },
  {
    role: 'ROUNDING',
    label: 'Rounding',
    defaultCode: '6830',
    remappable: false,
    accountId: 'acc-6830',
    code: '6830',
    name: 'Rounding',
    isActive: true,
  },
];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockTreeAndBalances() {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/v1/accounts/balances')) {
      return Promise.resolve(jsonResponse(200, { success: true, asOf: null, count: 0, balances: [] }));
    }
    if (url.includes('/api/v1/accounts?tree=true')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: 2, accounts: [header] }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

describe('system account badges (Accounts page)', () => {
  it('shows the System badge on a system account row', async () => {
    mockTreeAndBalances();
    render(
      <MemoryRouter>
        <AccountsPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('System')).toBeInTheDocument();
  });
});

describe('system account locks (Chart settings page)', () => {
  it('disables the Retire button on an active system account', async () => {
    mockTreeAndBalances();
    render(
      <MemoryRouter>
        <ChartSettingsPage />
      </MemoryRouter>,
    );

    const code = await screen.findByText('1120');
    const row = code.closest('li');
    if (row === null) throw new Error('row not found');
    expect(within(row).getByRole('button', { name: 'Retire' })).toBeDisabled();
  });
});

describe('System accounts section (Financial tab)', () => {
  it('lists Rounding with its account', async () => {
    const settings = {
      organizationName: 'Acme',
      legalName: 'Acme Holdings Ltd',
      baseCurrency: 'USD',
      fiscalYearStartMonth: 1,
      fiscalYearStartDay: 1,
      booksStartDate: '2026-01-01',
      industry: 'Software',
      timezone: 'UTC',
      cashAccountId: null,
      onboardedAt: '2026-01-02T00:00:00.000Z',
      currentFiscalYear: { startDate: '2026-01-01', endDate: '2026-12-31', label: 'FY 2026' },
      baseCurrencyLocked: false,
      realizedFxGainAccountId: null,
      realizedFxLossAccountId: null,
      unrealizedFxAccountId: null,
      inventoryAccountId: null,
      cogsAccountId: null,
      inventoryAdjustmentAccountId: null,
      stockOpeningAccountId: null,
    };
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/v1/settings')) {
        return Promise.resolve(jsonResponse(200, { success: true, settings }));
      }
      if (url.includes('/api/v1/accounts/system')) {
        return Promise.resolve(
          jsonResponse(200, { success: true, count: systemAccounts.length, systemAccounts }),
        );
      }
      if (url.includes('/api/v1/accounts')) {
        return Promise.resolve(jsonResponse(200, { success: true, count: 0, accounts: [] }));
      }
      if (url.includes('/api/v1/fiscal-periods')) {
        return Promise.resolve(jsonResponse(200, { success: true, count: 0, periods: [] }));
      }
      return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
    });

    render(
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

    expect(await screen.findByText('Rounding')).toBeInTheDocument();
    expect(await screen.findByText('6830 Rounding')).toBeInTheDocument();
  });
});
