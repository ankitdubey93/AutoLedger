import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CashFlowPage from '../Pages/reports/CashFlowPage';
import NewAccountForm from '../Pages/accounting/NewAccountForm';
import type { CashFlowStatement } from '../services/fetchServices';
import { formatCents } from '../utils/money';

/**
 * The cash flow page and the account form's category field. The page reads
 * LedgerSettingsContext for its fiscal-year default, so that is mocked here.
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

function cashFlowFixture(): CashFlowStatement {
  return {
    from: '2026-09-01',
    to: '2026-09-30',
    netIncomeCents: 70000,
    operating: {
      rows: [
        {
          accountId: '00000000-0000-0000-0000-000000000011',
          code: '1120',
          name: 'Accounts receivable',
          type: 'Asset',
          category: 'OPERATING',
          categorySource: 'DERIVED',
          amountCents: -40000,
        },
      ],
      totalCents: 30000,
    },
    investing: {
      rows: [
        {
          accountId: '00000000-0000-0000-0000-000000000012',
          code: '1500',
          name: 'Equipment',
          type: 'Asset',
          category: 'INVESTING',
          categorySource: 'OVERRIDE',
          amountCents: -50000,
        },
      ],
      totalCents: -50000,
    },
    financing: {
      rows: [],
      totalCents: 150000,
    },
    netChangeCents: 130000,
    openingCashCents: 200000,
    closingCashCents: 330000,
    cashAccounts: [
      {
        accountId: '00000000-0000-0000-0000-000000000013',
        code: '1110',
        name: 'Bank',
        openingCents: 200000,
        closingCents: 330000,
      },
    ],
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

describe('CashFlowPage', () => {
  it('renders sections and net change', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/v1/reports/cash-flow')) {
        return Promise.resolve(jsonResponse(200, { success: true, ...cashFlowFixture() }));
      }
      return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
    });

    render(
      <MemoryRouter initialEntries={['/reports/cash-flow']}>
        <Routes>
          <Route path="/reports/cash-flow" element={<CashFlowPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Operating activities')).toBeTruthy();
    expect(screen.getByText('Investing activities')).toBeTruthy();
    expect(screen.getByText('Financing activities')).toBeTruthy();
    expect(screen.getByText('Net change in cash')).toBeTruthy();
    expect(screen.getByText(formatCents(130000))).toBeTruthy();
    expect(screen.getByText('(override)')).toBeTruthy();
  });
});

describe('NewAccountForm cash flow category', () => {
  it('account form hides the category for Revenue', () => {
    const { unmount } = render(
      <NewAccountForm accounts={[]} initialType="Revenue" onCreated={() => {}} onCancel={() => {}} />,
    );
    expect(screen.queryByText('Cash flow category')).toBeNull();
    unmount();

    render(<NewAccountForm accounts={[]} initialType="Asset" onCreated={() => {}} onCancel={() => {}} />);
    expect(screen.getByText('Cash flow category')).toBeTruthy();
  });
});
