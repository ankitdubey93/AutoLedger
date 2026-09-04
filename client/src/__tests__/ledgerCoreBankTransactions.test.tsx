import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BankTransactionsPage from '../Pages/ledger-core/BankTransactionsPage';
import type { BankTransaction } from '../services/fetchServices';

/** BankTransactionsPage — the approval queue. */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function suggestion(overrides: Partial<BankTransaction['suggestions'][number]> = {}) {
  return {
    id: 'sug-1',
    targetType: 'invoice' as const,
    invoiceId: 'inv-1',
    billId: null,
    documentReference: 'INV-0001',
    documentDate: '2026-06-01',
    counterpartyName: 'Acme Ltd',
    documentTotalCents: 40000,
    documentAmountDueCents: 40000,
    score: 100,
    scoreBreakdown: {
      amount: { points: 40, maxPoints: 40, reason: 'exact match' },
      date: { points: 30, maxPoints: 30, reason: '0 day(s) apart' },
      counterparty: { points: 30, maxPoints: 30, reason: 'reference found in memo' },
      total: 100,
    },
    autoMatchable: true,
    ...overrides,
  };
}

function transaction(overrides: Partial<BankTransaction> = {}): BankTransaction {
  return {
    id: 'txn-1',
    importId: 'imp-1',
    accountId: 'acc-1110',
    accountCode: '1110',
    accountName: 'Operating Cash',
    txnDate: '2026-06-01',
    description: 'PAYMENT RECEIVED INV-0001',
    externalReference: null,
    currencyCode: 'USD',
    amountCents: 40000,
    status: 'UNMATCHED',
    matchedPaymentId: null,
    matchedAt: null,
    matchedBy: null,
    matchedByName: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    suggestions: [suggestion()],
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

function mockListRoutes(transactions: BankTransaction[]) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/ledger-core/bank-transactions') && (init === undefined || init.method === undefined)) {
      return Promise.resolve(
        jsonResponse(200, {
          success: true,
          count: transactions.length,
          totalCount: transactions.length,
          currentPage: 1,
          totalPages: 1,
          transactions,
        }),
      );
    }
    if (init?.method === 'POST' && url.includes('/match')) {
      return Promise.resolve(jsonResponse(200, { success: true, transaction: transactions[0] }));
    }
    if (init?.method === 'POST' && url.includes('/unmatch')) {
      return Promise.resolve(jsonResponse(200, { success: true, transaction: transactions[0] }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/app/ledger-core/bank']}>
      <Routes>
        <Route path="/app/:appSlug/bank" element={<BankTransactionsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('BankTransactionsPage', () => {
  it('lists bank lines with signed amounts', async () => {
    mockListRoutes([
      transaction({ id: 'txn-1', amountCents: 40000, description: 'Deposit' }),
      transaction({ id: 'txn-2', amountCents: -1500, description: 'ATM Withdrawal', suggestions: [] }),
    ]);
    renderPage();

    await screen.findByText('Deposit');
    expect(screen.getByText('400.00')).toBeInTheDocument();
    expect(screen.getByText('-15.00')).toBeInTheDocument();
  });

  it('shows a green badge for a score of 85 and an amber one for 70', async () => {
    mockListRoutes([
      transaction({
        id: 'txn-1',
        suggestions: [suggestion({ id: 'sug-85', score: 85 }), suggestion({ id: 'sug-70', score: 70 })],
      }),
    ]);
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('PAYMENT RECEIVED INV-0001');
    await user.click(screen.getByRole('button', { name: /suggestion/ }));

    const badge85 = screen.getByText('85').closest('span');
    const badge70 = screen.getByText('70').closest('span');
    expect(badge85?.className).toContain('good');
    expect(badge70?.className).not.toContain('good');
  });

  it('renders the three score reasons for a suggestion', async () => {
    mockListRoutes([transaction()]);
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('PAYMENT RECEIVED INV-0001');
    await user.click(screen.getByRole('button', { name: /suggestion/ }));

    await screen.findByText(/exact match/);
    expect(screen.getByText(/0 day\(s\) apart/)).toBeInTheDocument();
    expect(screen.getByText(/reference found in memo/)).toBeInTheDocument();
  });

  it('Accept posts suggestionId to /match', async () => {
    mockListRoutes([transaction()]);
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('PAYMENT RECEIVED INV-0001');
    await user.click(screen.getByRole('button', { name: /suggestion/ }));
    await user.click(screen.getByRole('button', { name: 'Accept' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'POST' && url.includes('/match');
      });
      expect(call).toBeDefined();
      const [, init] = call as [RequestInfo | URL, RequestInit];
      expect(init.body as string).toContain('sug-1');
    });
  });

  it('Match below the threshold opens the confirm dialog first', async () => {
    mockListRoutes([transaction({ suggestions: [suggestion({ score: 60 })] })]);
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('PAYMENT RECEIVED INV-0001');
    await user.click(screen.getByRole('button', { name: /suggestion/ }));
    await user.click(screen.getByRole('button', { name: 'Match' }));

    await screen.findByRole('dialog');
    expect(
      fetchMock.mock.calls.find((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'POST' && url.includes('/match');
      }),
    ).toBeUndefined();
  });

  it('Unmatch opens a confirm dialog naming the reversing entry', async () => {
    mockListRoutes([transaction({ status: 'MATCHED', matchedPaymentId: 'pay-1', suggestions: [] })]);
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('PAYMENT RECEIVED INV-0001');
    await user.click(screen.getByRole('button', { name: 'Unmatch' }));

    await screen.findByText(/reversing entry/);
  });

  it('renders an empty state when nothing has been imported', async () => {
    mockListRoutes([]);
    renderPage();

    await screen.findByText(/No bank lines yet/);
  });
});
