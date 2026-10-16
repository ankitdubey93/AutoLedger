import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SalesPurchasesReportPage from '../Pages/reports/SalesPurchasesReportPage';
import type { SalesPurchasesReport, SalesPurchasesReportKind } from '../services/fetchServices';

/**
 * The sales and purchases page. It talks to fetchServices directly and does
 * not depend on AuthContext or LedgerSettingsContext, so it renders under a
 * bare MemoryRouter with fetch stubbed.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function customerFixture(): SalesPurchasesReport {
  return {
    kind: 'sales-by-customer',
    from: '2026-09-01',
    to: '2026-09-30',
    comparison: null,
    rows: [
      {
        key: 'acme-id',
        label: 'Acme',
        code: null,
        quantityMilli: null,
        netCents: 27000,
        taxCents: 5400,
        grossCents: 32400,
        documentCount: 2,
        comparisonNetCents: null,
      },
      {
        key: 'beta-id',
        label: 'Beta',
        code: null,
        quantityMilli: null,
        netCents: 10000,
        taxCents: 2000,
        grossCents: 12000,
        documentCount: 1,
        comparisonNetCents: null,
      },
    ],
    totalNetCents: 37000,
    totalTaxCents: 7400,
    totalGrossCents: 44400,
    totalComparisonNetCents: null,
  };
}

function itemFixture(): SalesPurchasesReport {
  return {
    kind: 'sales-by-item',
    from: '2026-09-01',
    to: '2026-09-30',
    comparison: null,
    rows: [
      {
        key: 'wid-id',
        label: 'Widget',
        code: 'WID',
        quantityMilli: 3000,
        netCents: 30000,
        taxCents: 0,
        grossCents: 30000,
        documentCount: 1,
        comparisonNetCents: null,
      },
      {
        key: 'none',
        label: 'No item',
        code: null,
        quantityMilli: null,
        netCents: 7000,
        taxCents: 0,
        grossCents: 7000,
        documentCount: 2,
        comparisonNetCents: null,
      },
    ],
    totalNetCents: 37000,
    totalTaxCents: 0,
    totalGrossCents: 37000,
    totalComparisonNetCents: null,
  };
}

function comparedFixture(): SalesPurchasesReport {
  const base = customerFixture();
  return {
    ...base,
    comparison: { from: '2026-08-01', to: '2026-08-31', label: 'Aug 2026' },
    rows: [
      { ...base.rows[0]!, comparisonNetCents: 5000 },
      { ...base.rows[1]!, comparisonNetCents: 0 },
    ],
    totalComparisonNetCents: 5000,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function mockReportRoute(report: SalesPurchasesReport) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/v1/reports/')) {
      return Promise.resolve(jsonResponse(200, { success: true, ...report }));
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

function renderPage(kind: SalesPurchasesReportKind, path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={path} element={<SalesPurchasesReportPage kind={kind} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('SalesPurchasesReportPage', () => {
  it('renders rows and totals for sales-by-customer', async () => {
    mockReportRoute(customerFixture());
    renderPage('sales-by-customer', '/reports/sales-by-customer');

    expect(await screen.findByRole('link', { name: 'Acme' })).toHaveAttribute('href', '/customers/acme-id');
    expect(screen.getByRole('link', { name: 'Beta' })).toHaveAttribute('href', '/customers/beta-id');
    expect(screen.getByRole('cell', { name: '270.00' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '370.00' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '74.00' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '444.00' })).toBeInTheDocument();
  });

  it('item report shows the quantity column', async () => {
    mockReportRoute(itemFixture());
    renderPage('sales-by-item', '/reports/sales-by-item');

    expect(await screen.findByRole('columnheader', { name: 'Quantity' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '3' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'WID' })).toBeInTheDocument();
  });

  it('compare adds Prior and Change columns', async () => {
    mockReportRoute(comparedFixture());
    renderPage('sales-by-customer', '/reports/sales-by-customer');

    const compareSelect = await screen.findByLabelText('Compare');
    fireEvent.change(compareSelect, { target: { value: 'previousPeriod' } });

    expect(await screen.findByRole('columnheader', { name: 'Aug 2026' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Change' })).toBeInTheDocument();
    // Acme's prior net and the total prior net are both 50.00 in this fixture.
    expect(screen.getAllByRole('cell', { name: '50.00' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('cell', { name: '220.00' })).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).includes('compare=previousPeriod')),
    ).toBe(true);
  });
});
