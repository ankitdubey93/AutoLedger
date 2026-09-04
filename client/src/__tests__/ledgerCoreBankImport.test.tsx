import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BankImportPage from '../Pages/ledger-core/BankImportPage';
import type { Account } from '../services/fetchServices';

/** BankImportPage — the CSV-as-JSON-body upload form. */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1110',
    code: '1110',
    name: 'Operating Cash',
    type: 'Asset',
    parentId: null,
    isPostable: true,
    isActive: true,
    description: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
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

function mockRoutes(accounts: Account[], importResponse: { status: number; body: unknown }) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/ledger-core/accounts')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: accounts.length, accounts }));
    }
    if (init?.method === 'POST' && url.includes('/ledger-core/bank-imports')) {
      return Promise.resolve(jsonResponse(importResponse.status, importResponse.body));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/app/ledger-core/bank/import']}>
      <Routes>
        <Route path="/app/:appSlug/bank/import" element={<BankImportPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function makeCsvFile(): File {
  const content = 'Date,Description,Amount\n2026-06-01,Test payment,100.00';
  return new File([content], 'statement.csv', { type: 'text/csv' });
}

describe('BankImportPage', () => {
  it('renders the account picker with only postable Asset accounts', async () => {
    mockRoutes(
      [
        account({ id: 'acc-1110', code: '1110', name: 'Operating Cash' }),
        account({ id: 'acc-1000', code: '1000', name: 'Assets', isPostable: false }),
        account({ id: 'acc-4100', code: '4100', name: 'Revenue', type: 'Revenue' }),
      ],
      { status: 201, body: {} },
    );
    renderPage();

    await screen.findByText('1110 · Operating Cash');
    expect(screen.queryByText('1000 · Assets')).not.toBeInTheDocument();
    expect(screen.queryByText('4100 · Revenue')).not.toBeInTheDocument();
  });

  it('posts the file text as JSON, not multipart', async () => {
    mockRoutes([account()], {
      status: 201,
      body: { success: true, import: { id: 'imp-1' }, importedCount: 1, duplicateCount: 0, suggestedCount: 0, autoMatchableCount: 0 },
    });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('1110 · Operating Cash');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Bank account' }), 'acc-1110');

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, makeCsvFile());

    await waitFor(() => expect(fileInput.files?.length).toBe(1));

    await user.click(screen.getByRole('button', { name: 'Import statement' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'POST' && url.includes('/ledger-core/bank-imports');
      });
      expect(call).toBeDefined();
      const [, init] = call as [RequestInfo | URL, RequestInit];
      expect(typeof init.body).toBe('string');
      expect(init.body as string).toContain('Test payment');
      expect(init.body as string).toContain('100.00');
    });
  });

  it('shows the imported/duplicate summary on success', async () => {
    mockRoutes([account()], {
      status: 201,
      body: {
        success: true,
        import: { id: 'imp-1' },
        importedCount: 3,
        duplicateCount: 2,
        suggestedCount: 1,
        autoMatchableCount: 1,
      },
    });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('1110 · Operating Cash');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Bank account' }), 'acc-1110');
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, makeCsvFile());
    await waitFor(() => expect(fileInput.files?.length).toBe(1));
    await user.click(screen.getByRole('button', { name: 'Import statement' }));

    await screen.findByText(/Imported 3 lines, skipped 2 duplicates/);
  });

  it("renders the server's 422 message verbatim", async () => {
    mockRoutes([account()], {
      status: 422,
      body: { success: false, error: 'Import failed: 1 row(s) could not be parsed (row 3: unparseable date "n/a")' },
    });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('1110 · Operating Cash');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Bank account' }), 'acc-1110');
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, makeCsvFile());
    await waitFor(() => expect(fileInput.files?.length).toBe(1));
    await user.click(screen.getByRole('button', { name: 'Import statement' }));

    await screen.findByText('Import failed: 1 row(s) could not be parsed (row 3: unparseable date "n/a")');
  });
});
