import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import UniteconPvmPage from '../Pages/unitecon/UniteconPvmPage';
import type { PvmResponse } from '../services/fetchServices';

/** UnitEcon (Phase 14) — the Price-Volume-Mix report page. */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function pvm(overrides: Partial<PvmResponse> = {}): PvmResponse {
  return {
    baseCurrency: 'USD',
    basePeriod: { from: '2026-01-01', to: '2026-01-01' },
    comparePeriod: { from: '2026-02-01', to: '2026-02-01' },
    report: {
      rows: [
        {
          productLineId: 'pl-1',
          productLineName: 'Widgets',
          unitLabel: 'unit',
          baseQuantityMilli: 10000,
          compareQuantityMilli: 20000,
          baseNetCents: 100000,
          compareNetCents: 220000,
          baseUnitPriceCents: 10000,
          compareUnitPriceCents: 11000,
          priceVarianceCents: 20000,
          volumeVarianceCents: 100000,
          mixVarianceCents: 0,
          totalVarianceCents: 120000,
        },
        {
          productLineId: 'pl-2',
          productLineName: 'Services',
          unitLabel: 'hr',
          baseQuantityMilli: 5000,
          compareQuantityMilli: 5000,
          baseNetCents: 50000,
          compareNetCents: 50000,
          baseUnitPriceCents: 10000,
          compareUnitPriceCents: 10000,
          priceVarianceCents: 0,
          volumeVarianceCents: 0,
          mixVarianceCents: 0,
          totalVarianceCents: 0,
        },
      ],
      totals: {
        baseNetCents: 150000,
        compareNetCents: 270000,
        priceVarianceCents: 20000,
        volumeVarianceCents: 100000,
        mixVarianceCents: 0,
        totalVarianceCents: 120000,
      },
    },
    excludedForeignCurrencyInvoices: 0,
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

function mockPvmRoute(response: PvmResponse | { status: number; body: unknown }) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/unitecon/pvm')) {
      if ('status' in response) {
        return Promise.resolve(jsonResponse(response.status, response.body));
      }
      return Promise.resolve(jsonResponse(200, { success: true, pvm: response }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderPvmPage() {
  return render(
    <MemoryRouter initialEntries={['/app/unitecon/pvm']}>
      <Routes>
        <Route path="/app/:appSlug/pvm" element={<UniteconPvmPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('UniteconPvmPage', () => {
  it('1. renders the three variance columns and a totals row', async () => {
    mockPvmRoute(pvm());
    renderPvmPage();

    await screen.findByText('Widgets');
    expect(screen.getByText('Services')).toBeInTheDocument();
    expect(screen.getAllByText('1000.00').length).toBeGreaterThan(0); // priceVarianceCents
    expect(screen.getAllByText('0.00').length).toBeGreaterThan(0); // mixVarianceCents rows
    expect(screen.getByText('Total')).toBeInTheDocument();
  });

  it('2. shows the foreign-currency-exclusion banner when the count is positive', async () => {
    mockPvmRoute(pvm({ excludedForeignCurrencyInvoices: 2 }));
    renderPvmPage();

    await screen.findByText(/2 invoices in a currency other than your base currency/);
  });

  it('2b. hides the foreign-currency-exclusion banner when the count is zero', async () => {
    mockPvmRoute(pvm());
    renderPvmPage();

    await screen.findByText('Widgets');
    expect(screen.queryByText(/currency other than your base currency/)).not.toBeInTheDocument();
  });

  it('3. renders the configure-a-product-line empty state on a 422, not a raw error', async () => {
    mockPvmRoute({
      status: 422,
      body: { success: false, error: 'Configure at least one product line before running a PVM report' },
    });
    renderPvmPage();

    await screen.findByText(/Configure at least one product line/);
    expect(screen.getByRole('link', { name: 'Go to Settings' })).toBeInTheDocument();
  });
});
