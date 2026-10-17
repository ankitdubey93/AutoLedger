import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BusinessSnapshotPage from '../Pages/reports/BusinessSnapshotPage';
import type {
  AgingBucketAmount,
  BusinessSnapshot,
  SnapshotRatio,
  SnapshotRatioKey,
  SnapshotTrendPoint,
} from '../services/fetchServices';
import { formatCents } from '../utils/money';

/**
 * The business snapshot page. Fixture numbers are the server's hand-computed
 * ledger from businessSnapshot.test.ts (Step 8), so the page is tested against
 * the same figures the server proves. The page reads LedgerSettingsContext for
 * its fiscal-year default, so that is mocked here.
 */

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

// Labels and kinds mirror server/src/utils/financialRatios.ts SNAPSHOT_RATIO_SPECS.
const RATIOS: { key: SnapshotRatioKey; label: string; kind: 'PERCENT' | 'TIMES'; currentBp: number }[] = [
  { key: 'GROSS_MARGIN', label: 'Gross margin', kind: 'PERCENT', currentBp: 6000 },
  { key: 'CURRENT_RATIO', label: 'Current ratio', kind: 'TIMES', currentBp: 58333 },
  { key: 'DEBT_RATIO', label: 'Debt ratio', kind: 'PERCENT', currentBp: 4333 },
  { key: 'DEBT_TO_EQUITY', label: 'Debt to equity', kind: 'TIMES', currentBp: 7647 },
  { key: 'WORKING_CAPITAL_TO_TOTAL_ASSETS', label: 'Working capital to total assets', kind: 'PERCENT', currentBp: 4833 },
  { key: 'FIXED_ASSETS_TO_NET_WORTH', label: 'Fixed assets to net worth', kind: 'TIMES', currentBp: 7353 },
  { key: 'CURRENT_LIABILITIES_TO_NET_WORTH', label: 'Current liabilities to net worth', kind: 'PERCENT', currentBp: 1765 },
];

const TREND_MONTHS: { month: string; asOf: string }[] = [
  { month: '2025-10', asOf: '2025-10-31' },
  { month: '2025-11', asOf: '2025-11-30' },
  { month: '2025-12', asOf: '2025-12-31' },
  { month: '2026-01', asOf: '2026-01-31' },
  { month: '2026-02', asOf: '2026-02-28' },
  { month: '2026-03', asOf: '2026-03-31' },
  { month: '2026-04', asOf: '2026-04-30' },
  { month: '2026-05', asOf: '2026-05-31' },
  { month: '2026-06', asOf: '2026-06-30' },
  { month: '2026-07', asOf: '2026-07-31' },
  { month: '2026-08', asOf: '2026-08-31' },
  { month: '2026-09', asOf: '2026-09-30' },
];

function zeroBuckets(): AgingBucketAmount[] {
  return [
    { bucket: 'CURRENT', label: 'Current', amountCents: 0, documentCount: 0 },
    { bucket: 'D1_30', label: '1–30 days', amountCents: 0, documentCount: 0 },
    { bucket: 'D31_60', label: '31–60 days', amountCents: 0, documentCount: 0 },
    { bucket: 'D61_90', label: '61–90 days', amountCents: 0, documentCount: 0 },
    { bucket: 'D90_PLUS', label: '90+ days', amountCents: 0, documentCount: 0 },
  ];
}

function snapshotFixture(): BusinessSnapshot {
  const ratios: SnapshotRatio[] = RATIOS.map((ratio) => ({
    key: ratio.key,
    label: ratio.label,
    kind: ratio.kind,
    current: { valueBp: ratio.currentBp, reason: null },
    prior: { valueBp: null, reason: 'DENOMINATOR_ZERO' },
  }));

  const trend: SnapshotTrendPoint[] = TREND_MONTHS.map((point, index) =>
    index === TREND_MONTHS.length - 1
      ? {
          month: point.month,
          asOf: point.asOf,
          revenueCents: 300000,
          costOfSalesCents: 120000,
          grossProfitCents: 180000,
          grossMarginBp: 6000,
          currentRatioBp: 58333,
          debtRatioBp: 4333,
          debtToEquityBp: 7647,
        }
      : {
          month: point.month,
          asOf: point.asOf,
          revenueCents: 0,
          costOfSalesCents: 0,
          grossProfitCents: 0,
          grossMarginBp: null,
          currentRatioBp: null,
          debtRatioBp: null,
          debtToEquityBp: null,
        },
  );

  return {
    period: { from: '2026-09-01', to: '2026-09-30' },
    priorPeriod: { from: '2026-08-01', to: '2026-08-31' },
    performance: {
      current: {
        revenueCents: 300000,
        costOfSalesCents: 120000,
        grossProfitCents: 180000,
        operatingExpensesCents: 100000,
        netIncomeCents: 80000,
      },
      prior: {
        revenueCents: 0,
        costOfSalesCents: 0,
        grossProfitCents: 0,
        operatingExpensesCents: 0,
        netIncomeCents: 0,
      },
    },
    position: {
      current: {
        asOf: '2026-09-30',
        currentAssetsCents: 700000,
        nonCurrentAssetsCents: 500000,
        totalAssetsCents: 1200000,
        currentLiabilitiesCents: 120000,
        nonCurrentLiabilitiesCents: 400000,
        totalLiabilitiesCents: 520000,
        netWorthCents: 680000,
        workingCapitalCents: 580000,
      },
      prior: {
        asOf: '2026-08-31',
        currentAssetsCents: 0,
        nonCurrentAssetsCents: 0,
        totalAssetsCents: 0,
        currentLiabilitiesCents: 0,
        nonCurrentLiabilitiesCents: 0,
        totalLiabilitiesCents: 0,
        netWorthCents: 0,
        workingCapitalCents: 0,
      },
    },
    ratios,
    receivables: { asOf: '2026-09-30', buckets: zeroBuckets(), totalOutstandingCents: 0, totalOverdueCents: 0 },
    payables: { asOf: '2026-09-30', buckets: zeroBuckets(), totalOutstandingCents: 0, totalOverdueCents: 0 },
    trend,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/reports/business-snapshot')) {
      return Promise.resolve(jsonResponse(200, { success: true, ...snapshotFixture() }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/reports/business-snapshot']}>
      <Routes>
        <Route path="/reports/business-snapshot" element={<BusinessSnapshotPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('BusinessSnapshotPage', () => {
  it('renders KPIs', async () => {
    renderPage();

    expect((await screen.findAllByText(formatCents(300000))).length).toBeGreaterThan(0);
    expect(screen.getAllByText('60.00%').length).toBeGreaterThan(0);
  });

  it('renders every ratio', async () => {
    renderPage();
    await screen.findAllByText(formatCents(300000));

    for (const text of ['Current ratio', '5.83×', 'Debt ratio', '43.33%', 'Debt to equity', '0.76×']) {
      expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    }
  });

  it('unavailable prior ratio shows a dash with a reason', async () => {
    renderPage();
    await screen.findAllByText(formatCents(300000));

    const unavailable = screen.getAllByTitle('Not available: the denominator is zero.');
    expect(unavailable.length).toBeGreaterThan(0);
    expect(unavailable[0]?.textContent).toBe('—');
  });

  it('period preset refetches', async () => {
    renderPage();
    await screen.findAllByText(formatCents(300000));

    fireEvent.change(screen.getByRole('combobox', { name: 'Period' }), { target: { value: 'month' } });

    const today = new Date().toISOString().slice(0, 10);
    const firstOfMonth = `${today.slice(0, 8)}01`;
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(urls[urls.length - 1]).toContain(`/reports/business-snapshot?from=${firstOfMonth}`);
    });
  });

  it('chart data is available to screen readers', async () => {
    renderPage();

    expect(await screen.findByText('Revenue, cost of sales and gross margin by month')).toBeInTheDocument();
  });
});
