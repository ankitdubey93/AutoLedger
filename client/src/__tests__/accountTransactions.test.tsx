import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AccountTransactionsPage from '../Pages/reports/AccountTransactionsPage';

/**
 * Phase 45 — the account transactions page. fetch is stubbed by URL prefix:
 * /accounts returns two postable accounts, /reports/account-transactions a
 * one-group report.
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

const account = (id: string, code: string, name: string, type: string) => ({
  id,
  code,
  name,
  type,
  parentId: null,
  isPostable: true,
  isActive: true,
  description: null,
  bankAccountKind: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

const report = {
  success: true,
  accountIds: null,
  from: '2026-09-01',
  to: '2026-09-30',
  sourceTypes: null,
  groupBy: 'account',
  mode: 'detail',
  totalDebitCents: 25000,
  totalCreditCents: 0,
  lineCount: 1,
  groups: [
    {
      key: 'a1',
      label: '1120 Accounts Receivable',
      openingBalanceCents: 10000,
      debitCents: 25000,
      creditCents: 0,
      netCents: 25000,
      closingBalanceCents: 35000,
      lineCount: 1,
      lines: [
        {
          lineId: 'l1',
          entryId: 'e1',
          entryDate: '2026-09-05',
          sourceType: 'invoice',
          sourceId: 'i1',
          sourceLabel: 'Invoice',
          reference: 'INV-0002',
          contactType: 'CUSTOMER',
          contactId: 'c1',
          contactName: 'Acme',
          description: 'Services',
          accountId: 'a1',
          accountCode: '1120',
          accountName: 'Accounts Receivable',
          debitCents: 25000,
          creditCents: 0,
          netCents: 25000,
          runningBalanceCents: 35000,
          currencyCode: 'USD',
          nativeDebitCents: 25000,
          nativeCreditCents: 0,
          fxRate: '1',
          createdByName: 'Alice',
        },
      ],
    },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;
let reportResponse: () => Response;

beforeEach(() => {
  window.localStorage.clear();
  reportResponse = () => jsonResponse(200, report);
  fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/v1/accounts')) {
      return Promise.resolve(
        jsonResponse(200, {
          success: true,
          count: 2,
          accounts: [account('a1', '1120', 'Accounts Receivable', 'Asset'), account('a2', '4100', 'Sales', 'Revenue')],
        }),
      );
    }
    if (url.includes('/api/v1/reports/account-transactions')) return Promise.resolve(reportResponse());
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/reports/account-transactions']}>
      <Routes>
        <Route path="/reports/account-transactions" element={<AccountTransactionsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function lastReportUrl(): string {
  const urls = fetchMock.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.includes('/reports/account-transactions'));
  return urls[urls.length - 1] ?? '';
}

describe('AccountTransactionsPage', () => {
  it('renders groups and subtotals', async () => {
    renderPage();
    const table = await screen.findByRole('table');
    expect(within(table).getByText('1120 Accounts Receivable')).toBeInTheDocument();
    expect(within(table).getByText('Total 1120 Accounts Receivable')).toBeInTheDocument();
  });

  it('group-by change refetches', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('table');
    await user.selectOptions(screen.getByLabelText('Group by'), 'month');
    await waitFor(() => expect(lastReportUrl()).toContain('groupBy=month'));
  });

  it('column toggle hides a column', async () => {
    const user = userEvent.setup();
    renderPage();
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Contact' })).toBeInTheDocument();
    await user.click(screen.getByText('Columns'));
    await user.click(screen.getByRole('checkbox', { name: 'Contact' }));
    expect(within(table).queryByRole('columnheader', { name: 'Contact' })).not.toBeInTheDocument();
  });

  it("shows the server's 422", async () => {
    reportResponse = () =>
      jsonResponse(422, {
        success: false,
        error: 'Too many lines (25000) — narrow the date range or use summary mode',
      });
    renderPage();
    expect(
      await screen.findByText('Too many lines (25000) — narrow the date range or use summary mode'),
    ).toBeInTheDocument();
  });
});
