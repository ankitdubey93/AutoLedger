import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BankTransactionsPage from '../Pages/banking/BankTransactionsPage';
import BankImportPage from '../Pages/banking/BankImportPage';
import type { BankTransaction } from '../services/fetchServices';

/** Phase 46e client: delete and restore bank lines, the History tab, and the import delete/summary. */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function transaction(overrides: Partial<BankTransaction> = {}): BankTransaction {
  return {
    id: 'txn-1',
    importId: 'imp-1',
    accountId: 'acc-1110',
    accountCode: '1110',
    accountName: 'Operating Cash',
    txnDate: '2026-06-01',
    description: 'Line A',
    externalReference: null,
    currencyCode: 'USD',
    amountCents: -1500,
    status: 'UNMATCHED',
    matchedPaymentId: null,
    matchedJournalEntryId: null,
    matchedRuleId: null,
    matchedRuleName: null,
    matchedAt: null,
    matchedBy: null,
    matchedByName: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
    deletedByName: null,
    deleteReason: null,
    suggestions: [],
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

function methodOf(init: RequestInit | undefined): string {
  return init?.method ?? 'GET';
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input.toString();
}

function postCalls(urlPart: string) {
  return fetchMock.mock.calls.filter((c) => {
    const [input, init] = c as [RequestInfo | URL, RequestInit?];
    return methodOf(init) === 'POST' && urlOf(input).includes(urlPart);
  });
}

function renderBankPage(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/bank" element={<BankTransactionsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function mockBankRoutes(transactions: BankTransaction[], historyEntries: unknown[] = []) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    const method = methodOf(init);
    if (method === 'GET' && url.includes('/api/v1/accounts')) {
      return Promise.resolve(jsonResponse(200, { success: true, accounts: [] }));
    }
    if (method === 'GET' && url.includes('/api/v1/bank-transactions/history')) {
      return Promise.resolve(
        jsonResponse(200, {
          success: true,
          count: historyEntries.length,
          totalCount: historyEntries.length,
          currentPage: 1,
          totalPages: 1,
          entries: historyEntries,
        }),
      );
    }
    if (method === 'GET' && url.includes('/api/v1/bank-transactions')) {
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
    if (method === 'POST' && url.includes('/api/v1/bank-transactions/delete')) {
      return Promise.resolve(jsonResponse(200, { success: true, deletedCount: 2 }));
    }
    if (method === 'POST' && url.includes('/restore')) {
      return Promise.resolve(jsonResponse(200, { success: true, transaction: transactions[0] }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

describe('BankTransactionsPage — delete and restore', () => {
  it('selecting two unmatched lines and confirming posts their ids with a null reason', async () => {
    mockBankRoutes([
      transaction({ id: 'a', description: 'Line A' }),
      transaction({ id: 'b', description: 'Line B' }),
    ]);
    const user = userEvent.setup();
    renderBankPage('/bank');

    await screen.findByText('Line A');
    await user.click(screen.getByRole('checkbox', { name: 'Select Line A' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Line B' }));
    await user.click(screen.getByRole('button', { name: 'Delete selected' }));

    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      const calls = postCalls('/api/v1/bank-transactions/delete');
      expect(calls).toHaveLength(1);
      const [, init] = calls[0] as [RequestInfo | URL, RequestInit];
      expect(JSON.parse(init.body as string)).toEqual({ ids: ['a', 'b'], reason: null });
    });
  });

  it('the Deleted tab shows Restore, which restores that line', async () => {
    mockBankRoutes([
      transaction({
        id: 'a',
        description: 'Line A',
        status: 'DELETED',
        deletedByName: 'Ada',
        deleteReason: 'duplicate',
      }),
    ]);
    const user = userEvent.setup();
    renderBankPage('/bank?status=DELETED');

    await screen.findByText('Line A');
    expect(screen.getByText(/Deleted by Ada/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Restore' }));

    await waitFor(() => {
      const calls = postCalls('/api/v1/bank-transactions/a/restore');
      expect(calls).toHaveLength(1);
    });
  });

  it('the History tab renders an entry summary', async () => {
    mockBankRoutes([], [
      {
        id: 'h-1',
        kind: 'EVENT',
        action: 'MATCHED',
        summary: 'Matched to invoice INV-0001',
        details: null,
        actorUserId: 'user-1',
        actorName: 'Ada',
        createdAt: '2026-06-02T10:00:00.000Z',
        bankTransactionId: 'txn-1',
        txnDate: '2026-06-01',
        description: 'PAYMENT RECEIVED',
        amountCents: 40000,
        currencyCode: 'USD',
      },
    ]);
    renderBankPage('/bank?status=HISTORY');

    expect(await screen.findByText('Matched to invoice INV-0001')).toBeInTheDocument();
    expect(screen.getByText('Ada')).toBeInTheDocument();
  });
});

describe('BankImportPage — previously deleted lines', () => {
  it('shows the previously-deleted message on the import result', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      const method = methodOf(init);
      if (method === 'GET' && url.includes('/api/v1/accounts')) {
        return Promise.resolve(
          jsonResponse(200, {
            success: true,
            count: 1,
            accounts: [
              {
                id: 'acc-1110',
                code: '1110',
                name: 'Operating Cash',
                type: 'Asset',
                parentId: null,
                isPostable: true,
                isActive: true,
                description: null,
                bankAccountKind: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ],
          }),
        );
      }
      if (method === 'GET' && url.includes('/api/v1/bank-imports')) {
        return Promise.resolve(jsonResponse(200, { success: true, count: 0, totalCount: 0, currentPage: 1, totalPages: 1, imports: [] }));
      }
      if (method === 'POST' && url.includes('/api/v1/bank-imports')) {
        return Promise.resolve(
          jsonResponse(201, {
            success: true,
            import: { id: 'imp-1' },
            importedCount: 1,
            duplicateCount: 2,
            suggestedCount: 0,
            autoMatchableCount: 0,
            ruleMatchedCount: 0,
            previouslyDeletedCount: 2,
          }),
        );
      }
      return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/bank/import']}>
        <Routes>
          <Route path="/bank/import" element={<BankImportPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('1110 · Operating Cash');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Bank account' }), 'acc-1110');
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, new File(['Date,Description,Amount\n2026-06-01,Test,1.00'], 'statement.csv', { type: 'text/csv' }));
    await waitFor(() => expect(fileInput.files?.length).toBe(1));
    await user.click(screen.getByRole('button', { name: 'Import statement' }));

    expect(
      await screen.findByText('2 previously deleted lines were skipped — restore them from the Deleted tab'),
    ).toBeInTheDocument();
  });
});
