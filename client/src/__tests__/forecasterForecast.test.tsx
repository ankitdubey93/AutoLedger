import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ForecasterForecastPage from '../Pages/forecaster/ForecasterForecastPage';
import type { ForecasterForecastResponse } from '../services/fetchServices';

/** ForecasterPro (Phase 13) — the plan forecast build-up page. */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function forecast(overrides: Partial<ForecasterForecastResponse> = {}): ForecasterForecastResponse {
  return {
    planId: 'plan-1',
    planName: 'FY27 Plan',
    baseCurrency: 'USD',
    startsOn: '2026-10-01',
    horizonMonths: 2,
    actualsThrough: '2026-09-01',
    accounts: [{ accountId: 'acc-1', code: '4100', name: 'Product Revenue', type: 'Revenue' }],
    build: {
      months: [
        {
          month: '2026-10-01',
          lines: [
            {
              lineId: 'line-1',
              label: 'Subscription revenue',
              accountId: 'acc-1',
              amountCents: 1_000_000,
              missingDriverValue: false,
            },
          ],
          roles: [],
          accountTotals: [{ accountId: 'acc-1', amountCents: 1_000_000 }],
          totalCents: 1_000_000,
        },
        {
          month: '2026-11-01',
          lines: [
            {
              lineId: 'line-1',
              label: 'Subscription revenue',
              accountId: 'acc-1',
              amountCents: 2_000_000,
              missingDriverValue: false,
            },
          ],
          roles: [],
          accountTotals: [{ accountId: 'acc-1', amountCents: 2_000_000 }],
          totalCents: 2_000_000,
        },
      ],
      accountIds: ['acc-1'],
      horizonTotals: [{ accountId: 'acc-1', amountCents: 3_000_000 }],
      hasMissingDriverValues: false,
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

function mockForecastRoute(response: ForecasterForecastResponse) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/forecast')) {
      return Promise.resolve(jsonResponse(200, { success: true, forecast: response }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderForecastPage() {
  return render(
    <MemoryRouter initialEntries={['/app/forecaster/plans/plan-1/forecast']}>
      <Routes>
        <Route path="/app/:appSlug/plans/:planId/forecast" element={<ForecasterForecastPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ForecasterForecastPage', () => {
  it('1. renders month columns and account totals', async () => {
    mockForecastRoute(forecast());
    renderForecastPage();

    await screen.findAllByText('2026-10');
    expect(screen.getAllByText('2026-11').length).toBeGreaterThan(0);
    expect(screen.getAllByText('10000.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('20000.00').length).toBeGreaterThan(0);
  });

  it('2. shows the missing-driver-value warning when the API reports one', async () => {
    mockForecastRoute(
      forecast({
        build: {
          ...forecast().build,
          months: forecast().build.months.map((m, i) => ({
            ...m,
            lines: m.lines.map((l) => (i === 0 ? { ...l, missingDriverValue: true, amountCents: 0 } : l)),
          })),
          hasMissingDriverValues: true,
        },
      }),
    );
    renderForecastPage();

    await screen.findByText(/Some months are missing a driver value/);
  });

  it('3. does not show the warning when hasMissingDriverValues is false', async () => {
    mockForecastRoute(forecast());
    renderForecastPage();

    await screen.findAllByText('2026-10');
    expect(screen.queryByText(/Some months are missing a driver value/)).not.toBeInTheDocument();
  });
});
