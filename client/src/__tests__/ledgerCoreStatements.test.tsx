import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProfitAndLossPage from '../Pages/ledger-core/ProfitAndLossPage';
import BalanceSheetPage from '../Pages/ledger-core/BalanceSheetPage';
import ReportsPage from '../Pages/ledger-core/ReportsPage';
import type { ProfitAndLoss, BalanceSheet } from '../services/fetchServices';

/**
 * Phase 4's live statements. Neither page depends on AuthContext or
 * OrgContext — both talk to fetchServices directly — so each renders under a
 * bare MemoryRouter with the route useAppBasePath needs.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const plFixture: ProfitAndLoss = {
  from: '2026-01-01',
  to: '2026-12-31',
  revenue: {
    rows: [{ accountId: 'acc-4100', code: '4100', name: 'Product Revenue', type: 'Revenue', amountCents: 500000 }],
    totalCents: 500000,
  },
  costOfSales: {
    rows: [{ accountId: 'acc-5100', code: '5100', name: 'Direct Materials', type: 'Expense', amountCents: 200000 }],
    totalCents: 200000,
  },
  grossProfitCents: 300000,
  operatingExpenses: {
    rows: [{ accountId: 'acc-6120', code: '6120', name: 'Software & IT', type: 'Expense', amountCents: 120000 }],
    totalCents: 120000,
  },
  netIncomeCents: 180000,
};

function balanceSheetFixture(balances: boolean): BalanceSheet {
  return {
    asOf: '2026-12-31',
    fiscalYearStartDate: '2026-01-01',
    assets: {
      rows: [{ accountId: 'acc-1110', code: '1110', name: 'Operating Cash', type: 'Asset', amountCents: 270000 }],
      totalCents: 270000,
    },
    liabilities: { rows: [], totalCents: 0 },
    equity: {
      rows: [],
      totalCents: balances ? 270000 : 200000,
      retainedEarningsCents: 90000,
      currentEarningsCents: 180000,
    },
    totalLiabilitiesAndEquityCents: balances ? 270000 : 200000,
    balances,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function mockProfitAndLossRoute() {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/ledger-core/reports/profit-and-loss')) {
      return Promise.resolve(jsonResponse(200, { success: true, ...plFixture }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function mockBalanceSheetRoute(balances = true) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/ledger-core/reports/balance-sheet')) {
      return Promise.resolve(jsonResponse(200, { success: true, ...balanceSheetFixture(balances) }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderProfitAndLossPage() {
  return render(
    <MemoryRouter initialEntries={['/app/ledger-core/reports/profit-and-loss']}>
      <Routes>
        <Route path="/app/:appSlug/reports/profit-and-loss" element={<ProfitAndLossPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderBalanceSheetPage() {
  return render(
    <MemoryRouter initialEntries={['/app/ledger-core/reports/balance-sheet']}>
      <Routes>
        <Route path="/app/:appSlug/reports/balance-sheet" element={<BalanceSheetPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderReportsPage() {
  return render(
    <MemoryRouter initialEntries={['/app/ledger-core/reports']}>
      <Routes>
        <Route path="/app/:appSlug/reports" element={<ReportsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProfitAndLossPage', () => {
  it('renders revenue, cost of sales, gross profit and net income', async () => {
    mockProfitAndLossRoute();
    renderProfitAndLossPage();

    expect(await screen.findByText('Product Revenue')).toBeInTheDocument();
    expect(screen.getByText('Direct Materials')).toBeInTheDocument();
    expect(screen.getByText('Gross profit')).toBeInTheDocument();
    const netIncomeRow = screen.getByText('Net income').closest('tr');
    expect(netIncomeRow).not.toBeNull();
    expect(netIncomeRow).toHaveTextContent('1800.00');
  });

  it('refetches with the new date when "to" changes', async () => {
    mockProfitAndLossRoute();
    renderProfitAndLossPage();
    await screen.findByText('Product Revenue');

    fetchMock.mockClear();
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-06-30' } });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const call = fetchMock.mock.calls.find((c) => {
      const [input] = c as [RequestInfo | URL];
      const url = typeof input === 'string' ? input : input.toString();
      return url.includes('to=2026-06-30');
    });
    expect(call).toBeDefined();
  });
});

describe('BalanceSheetPage', () => {
  it('renders the balanced indicator when balances is true', async () => {
    mockBalanceSheetRoute(true);
    renderBalanceSheetPage();

    expect(await screen.findByText('Assets equal liabilities plus equity exactly.')).toBeInTheDocument();
  });

  it('renders the unbalanced indicator when balances is false', async () => {
    mockBalanceSheetRoute(false);
    renderBalanceSheetPage();

    expect(await screen.findByText(/this should be impossible/)).toBeInTheDocument();
  });

  it('renders both derived equity rows carrying the derived marker', async () => {
    mockBalanceSheetRoute(true);
    renderBalanceSheetPage();

    const retainedRow = (await screen.findByText('Retained earnings (prior years)')).closest('tr');
    const currentRow = screen.getByText('Current period earnings').closest('tr');
    expect(retainedRow).toHaveTextContent('derived');
    expect(currentRow).toHaveTextContent('derived');
  });
});

describe('ReportsPage', () => {
  it('renders three enabled report links with no disabled placeholders', () => {
    renderReportsPage();

    expect(screen.getByRole('link', { name: /Trial balance/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Profit & loss/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Balance sheet/ })).toBeInTheDocument();
    expect(document.querySelector('[aria-disabled="true"]')).toBeNull();
  });
});
