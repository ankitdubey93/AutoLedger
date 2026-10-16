import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProfitAndLossPage from '../Pages/reports/ProfitAndLossPage';

/** Phase 45 — the Compare controls and the multi-period table on the P&L page. */

vi.mock('../context/LedgerSettingsContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../context/LedgerSettingsContext')>()),
  useLedgerSettings: () => ({
    status: 'ready',
    settings: { fiscalYearStartMonth: 1, fiscalYearStartDay: 1 },
  }),
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const emptySection = { rows: [], totalsCents: [0, 0], variance: { cents: 0, bp: null } };

const comparison = {
  success: true,
  mode: 'previousPeriod',
  periods: [
    { from: '2026-09-01', to: '2026-09-30', label: 'Sep 2026' },
    { from: '2026-08-01', to: '2026-08-31', label: 'Aug 2026' },
  ],
  revenue: {
    rows: [
      {
        accountId: 'acc-4100',
        code: '4100',
        name: 'Product Revenue',
        type: 'Revenue',
        amountsCents: [30000, 10000],
        variance: { cents: 20000, bp: 20000 },
      },
    ],
    totalsCents: [30000, 10000],
    variance: { cents: 20000, bp: 20000 },
  },
  costOfSales: emptySection,
  grossProfitCents: [30000, 10000],
  grossProfitVariance: { cents: 20000, bp: 20000 },
  operatingExpenses: emptySection,
  netIncomeCents: [30000, 10000],
  netIncomeVariance: { cents: 20000, bp: 20000 },
};

const single = {
  success: true,
  from: '2026-01-01',
  to: '2026-12-31',
  revenue: { rows: [], totalCents: 0 },
  costOfSales: { rows: [], totalCents: 0 },
  grossProfitCents: 0,
  operatingExpenses: { rows: [], totalCents: 0 },
  netIncomeCents: 0,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/reports/profit-and-loss/comparison')) return Promise.resolve(jsonResponse(200, comparison));
    if (url.includes('/reports/profit-and-loss')) return Promise.resolve(jsonResponse(200, single));
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/reports/profit-and-loss']}>
      <Routes>
        <Route path="/reports/profit-and-loss" element={<ProfitAndLossPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));

describe('ProfitAndLossPage comparison', () => {
  it('MoM button requests a comparison', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'MoM' }));
    await waitFor(() => {
      const last = urls().filter((u) => u.includes('/comparison')).pop() ?? '';
      expect(last).toContain('/reports/profit-and-loss/comparison');
      expect(last).toContain('compare=previousPeriod&periods=1');
    });
  });

  it('renders period columns and change', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: 'MoM' }));
    expect(await screen.findByRole('columnheader', { name: 'Sep 2026' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Aug 2026' })).toBeInTheDocument();
    expect(screen.getAllByText('200.0%').length).toBeGreaterThan(0);
  });

  it('no comparison keeps the old table', async () => {
    renderPage();
    await waitFor(() => expect(urls().length).toBeGreaterThan(0));
    // getProfitAndLoss adds no query string when neither date is set.
    expect(urls()[0]).toMatch(/\/reports\/profit-and-loss(\?|$)/);
    expect(urls().some((u) => u.includes('/comparison'))).toBe(false);
  });
});
