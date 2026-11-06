import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TparPage, { lastCompletedFinancialYear } from '../Pages/bas/TparPage';
import type { TparReport } from '../services/fetchServices';

vi.mock('../context/AuthContext', async (original) => ({
  ...(await original<typeof import('../context/AuthContext')>()),
  useCan: () => () => true,
}));

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function report(overrides: Partial<TparReport> = {}): TparReport {
  return {
    financialYear: 2026,
    from: '2025-07-01',
    to: '2026-06-30',
    dueDate: '2026-08-28',
    rows: [{ vendorId: 'v1', name: 'Sparks', abn: '51 824 753 556', address: 'x', grossPaidCents: 110_000, gstCents: 10_000, problems: [] }],
    totalGrossCents: 110_000,
    totalGstCents: 10_000,
    uncodedLineCount: 0,
    lodgment: null,
    ...overrides,
  };
}

let current: TparReport;

beforeEach(() => {
  vi.stubEnv('VITE_API_BASE_URL', 'http://test/api/v1');
  current = report();
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/vendors')) return Promise.resolve(jsonResponse({ success: true, vendors: [{ id: 'v1', name: 'Sparks', isActive: true, tparReportable: true }] }));
      return Promise.resolve(jsonResponse({ success: true, report: current }));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('the financial year', () => {
  it.each([
    ['2026-06-30', 2025],
    ['2026-07-01', 2026],
    ['2026-10-01', 2026],
    ['2027-01-15', 2026],
  ])('on %s the last completed year ends June %i', (today, year) => {
    expect(lastCompletedFinancialYear(today)).toBe(year);
  });
});

describe('the TPAR page', () => {
  it('shows the amounts and offers to record lodgment', async () => {
    render(<TparPage />);
    expect((await screen.findAllByText('1,100.00')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Record as lodged' })).toBeEnabled();
    expect(screen.getByText(/doesn't lodge it with the ATO/)).toBeInTheDocument();
  });

  it('holds back recording when a contractor is missing details', async () => {
    current = report({ rows: [{ vendorId: 'v1', name: 'Sparks', abn: null, address: null, grossPaidCents: 1, gstCents: 0, problems: ['No ABN'] }] });
    render(<TparPage />);
    expect(await screen.findByText('No ABN')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record as lodged' })).toBeDisabled();
  });

  it('shows a lodged year as settled', async () => {
    current = report({ lodgment: { lodgedOn: '2026-08-20', atoReference: 'T1' } });
    render(<TparPage />);
    expect(await screen.findByText(/receipt T1/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record as lodged' })).not.toBeInTheDocument();
  });
});
