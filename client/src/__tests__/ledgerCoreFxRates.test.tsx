import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FxRatesPage from '../Pages/ledger-core/FxRatesPage';
import { LedgerSettingsProvider } from '../Pages/ledger-core/LedgerSettingsContext';
import type { FxRate } from '../services/fetchServices';

/** FxRatesPage — Phase 8. Needs LedgerSettingsProvider, unlike VendorsPage/CustomersPage. */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const ledgerSettings = {
  organizationName: 'Acme',
  legalName: null,
  baseCurrency: 'INR',
  fiscalYearStartMonth: 1,
  fiscalYearStartDay: 1,
  booksStartDate: '2026-01-01',
  industry: null,
  timezone: 'UTC',
  cashAccountId: null,
  onboardedAt: new Date().toISOString(),
  currentFiscalYear: { startDate: '2026-01-01', endDate: '2026-12-31', label: 'FY 2026' },
  baseCurrencyLocked: false,
  realizedFxGainAccountId: null,
  realizedFxLossAccountId: null,
  unrealizedFxAccountId: null,
};

const rate1: FxRate = {
  id: 'rate-1',
  fromCode: 'USD',
  toCode: 'INR',
  rateDate: '2026-01-01',
  rate: '83.00000000',
  source: 'MANUAL',
  createdBy: 'u1',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

let fetchMock: ReturnType<typeof vi.fn>;

function mockFxRateRoutes(rates: FxRate[]) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/ledger-core/settings')) {
      return Promise.resolve(jsonResponse(200, { success: true, settings: ledgerSettings }));
    }
    if (init?.method === 'POST' && url.includes('/ledger-core/fx-rates')) {
      const body = JSON.parse(init.body as string) as { fromCode: string; toCode: string; rateDate: string; rate: string };
      return Promise.resolve(
        jsonResponse(201, {
          success: true,
          rate: { ...rate1, id: 'rate-new', fromCode: body.fromCode, rate: body.rate },
        }),
      );
    }
    if (url.includes('/ledger-core/fx-rates')) {
      return Promise.resolve(
        jsonResponse(200, { success: true, count: rates.length, totalCount: rates.length, currentPage: 1, totalPages: 1, rates }),
      );
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

function renderFxRatesPage() {
  return render(
    <MemoryRouter initialEntries={['/app/ledger-core/fx-rates']}>
      <LedgerSettingsProvider>
        <Routes>
          <Route path="/app/:appSlug/fx-rates" element={<FxRatesPage />} />
        </Routes>
      </LedgerSettingsProvider>
    </MemoryRouter>,
  );
}

describe('FxRatesPage', () => {
  it('renders the rate list and posts a new rate as a string, not a number', async () => {
    mockFxRateRoutes([rate1]);
    const user = userEvent.setup();
    renderFxRatesPage();

    await screen.findByText('83.00000000');

    await user.click(screen.getByRole('button', { name: /new rate/i }));
    await user.type(screen.getByPlaceholderText('83.50000000'), '83.5');
    await user.click(screen.getByRole('button', { name: 'Save rate' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'POST' && url.includes('/ledger-core/fx-rates');
      });
      expect(call).toBeDefined();
    });

    const call = fetchMock.mock.calls.find((c) => {
      const [input, init] = c as [RequestInfo | URL, RequestInit?];
      const url = typeof input === 'string' ? input : input.toString();
      return init?.method === 'POST' && url.includes('/ledger-core/fx-rates');
    });
    const body = JSON.parse((call as [RequestInfo | URL, RequestInit])[1].body as string) as {
      rate: unknown;
      toCode: string;
    };
    expect(body.rate).toBe('83.5');
    expect(typeof body.rate).toBe('string');
    // toCode is always the organization's own base currency, never chosen.
    expect(body.toCode).toBe('INR');
  });

  it('shows an empty state with a "record the first rate" prompt when there are none', async () => {
    mockFxRateRoutes([]);
    renderFxRatesPage();

    await screen.findByText('No exchange rates recorded yet.');
  });
});
