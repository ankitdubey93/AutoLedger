import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FpaProjectionPage from '../Pages/fpa-engine/FpaProjectionPage';
import type { FpaProjectedMonth, FpaProjectionResponse } from '../services/fetchServices';

/** FP&A Engine (Phase 12) — the projection page: month columns, runway callout, balances badge. */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function projectedMonth(month: string, overrides: Partial<FpaProjectedMonth> = {}): FpaProjectedMonth {
  return {
    month,
    incomeStatement: {
      lines: [],
      revenueCents: 100000,
      costOfSalesCents: 0,
      grossProfitCents: 100000,
      operatingExpensesCents: 50000,
      operatingIncomeCents: 50000,
      taxCents: 0,
      netIncomeCents: 50000,
    },
    cashFlow: {
      netIncomeCents: 50000,
      changeInReceivablesCents: 0,
      changeInPayablesCents: 0,
      netCashFlowCents: 50000,
      openingCashCents: 0,
      closingCashCents: 50000,
    },
    balanceSheet: {
      cashCents: 50000,
      receivablesCents: 0,
      otherAssetsCents: 0,
      totalAssetsCents: 50000,
      payablesCents: 0,
      otherLiabilitiesCents: 0,
      equityCents: 0,
      retainedEarningsCents: 50000,
      totalLiabilitiesAndEquityCents: 50000,
      balances: true,
    },
    ...overrides,
  };
}

function projectionResponse(
  months: FpaProjectedMonth[],
  overrides: Partial<FpaProjectionResponse> = {},
): FpaProjectionResponse {
  return {
    modelId: 'model-1',
    modelName: 'FY27 Plan',
    scenarioId: 'scenario-1',
    scenarioName: 'Base',
    baseCurrency: 'USD',
    actualsThrough: '2026-09-01',
    actuals: [],
    projection: {
      months,
      runwayMonths: null,
      cashOutMonth: null,
      averageMonthlyBurnCents: 0,
      balances: months.every((m) => m.balanceSheet.balances),
    },
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

function mockProjectionRoute(response: FpaProjectionResponse) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/projection')) {
      return Promise.resolve(jsonResponse(200, { success: true, ...response }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderProjectionPage() {
  return render(
    <MemoryRouter initialEntries={['/app/fpa-engine/scenarios/scenario-1']}>
      <Routes>
        <Route path="/app/:appSlug/scenarios/:scenarioId" element={<FpaProjectionPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('FpaProjectionPage', () => {
  it('6. renders one column per projected month and the runway callout', async () => {
    const months = [
      projectedMonth('2026-10-01'),
      projectedMonth('2026-11-01'),
      projectedMonth('2026-12-01'),
    ];
    mockProjectionRoute(projectionResponse(months, { projection: { months, runwayMonths: 2, cashOutMonth: '2026-12-01', averageMonthlyBurnCents: 10000, balances: true } }));
    renderProjectionPage();

    await screen.findByText('FY27 Plan — Base');
    // One statement table per section, each with a column per projected month.
    expect(screen.getByText('Income statement')).toBeInTheDocument();
    expect(screen.getByText('Cash flow')).toBeInTheDocument();
    expect(screen.getByText('Balance sheet')).toBeInTheDocument();
    expect(screen.getAllByText('2026-10').length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText('2026-11').length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText('2026-12').length).toBeGreaterThanOrEqual(3);
    expect(screen.getByText('2 months')).toBeInTheDocument();
  });

  it('7. renders the warning panel when the projection does not balance', async () => {
    const badMonth = projectedMonth('2026-10-01', {
      balanceSheet: {
        cashCents: 50000,
        receivablesCents: 0,
        otherAssetsCents: 0,
        totalAssetsCents: 50000,
        payablesCents: 0,
        otherLiabilitiesCents: 0,
        equityCents: 0,
        retainedEarningsCents: 40000,
        totalLiabilitiesAndEquityCents: 40000,
        balances: false,
      },
    });
    mockProjectionRoute(projectionResponse([badMonth]));
    renderProjectionPage();

    await screen.findByText(/does not balance/);
  });

  it('8. renders "no cash-out within the horizon" when runwayMonths is null', async () => {
    const months = [projectedMonth('2026-10-01')];
    mockProjectionRoute(projectionResponse(months));
    renderProjectionPage();

    await screen.findByText('No cash-out within the horizon');
  });
});
