import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TaxSummaryPage from '../Pages/reports/TaxSummaryPage';
import type { TaxSummary } from '../services/fetchServices';

/**
 * The tax summary page. It talks to fetchServices directly and does not
 * depend on AuthContext or LedgerSettingsContext, so it renders under a bare
 * MemoryRouter with fetch stubbed.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function taxSummaryFixture(outputDifferenceCents = 0): TaxSummary {
  return {
    from: '2026-09-01',
    to: '2026-09-30',
    output: {
      rows: [{ rateBp: 1000, netCents: 100000, taxCents: 10000, documentCount: 2 }],
      netCents: 100000,
      taxCents: 10000,
    },
    input: {
      rows: [],
      netCents: 0,
      taxCents: 5750,
    },
    netTaxPayableCents: 4250,
    outputCheck: {
      account: { id: '00000000-0000-0000-0000-000000000001', code: '2140', name: 'Sales tax payable' },
      glCents: 10000 + outputDifferenceCents,
      differenceCents: outputDifferenceCents,
    },
    inputCheck: {
      account: { id: '00000000-0000-0000-0000-000000000002', code: '1180', name: 'Input tax receivable' },
      glCents: 5750,
      differenceCents: 0,
    },
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function mockTaxSummaryRoute(report: TaxSummary) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/v1/reports/tax-summary')) {
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

function renderTaxSummaryPage() {
  return render(
    <MemoryRouter initialEntries={['/reports/tax-summary']}>
      <Routes>
        <Route path="/reports/tax-summary" element={<TaxSummaryPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TaxSummaryPage', () => {
  it('renders rates and net payable', async () => {
    mockTaxSummaryRoute(taxSummaryFixture());
    renderTaxSummaryPage();

    expect(await screen.findByText('10%')).toBeInTheDocument();
    expect(screen.getByText('Net tax payable')).toBeInTheDocument();
    expect(screen.getByText('42.50')).toBeInTheDocument();
  });

  it('flags a GL difference', async () => {
    mockTaxSummaryRoute(taxSummaryFixture(1500));
    renderTaxSummaryPage();

    const outputBox = await screen.findByRole('status', { name: 'Output (sales) reconciliation' });
    expect(outputBox).toHaveClass('status--bad');
    expect(outputBox).toHaveTextContent('Difference 15.00');

    const inputBox = screen.getByRole('status', { name: 'Input (purchases) reconciliation' });
    expect(inputBox).toHaveClass('status--good');
  });
});
