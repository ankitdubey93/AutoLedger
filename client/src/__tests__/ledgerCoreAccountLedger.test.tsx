import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AccountLedgerPage from '../Pages/ledger-core/AccountLedgerPage';
import type { AccountLedger } from '../services/fetchServices';

/**
 * The account ledger page. Doesn't depend on AuthContext or OrgContext — it
 * talks to fetchServices directly — so it renders under a MemoryRouter with a
 * `/app/:appSlug/accounts/:accountId` route, which is all useAppBasePath and
 * useParams need.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const accountId = 'acc-6120';

function baseLedger(overrides: Partial<AccountLedger> = {}): AccountLedger {
  return {
    account: { id: accountId, code: '6120', name: 'Software & IT Infrastructure', type: 'Expense' },
    from: null,
    to: null,
    openingBalanceCents: 10000,
    periodDebitCents: 25000,
    periodCreditCents: 0,
    closingBalanceCents: 35000,
    rows: [
      {
        lineId: 'line-1',
        entryId: 'entry-1',
        entryDate: '2026-07-15',
        description: 'AWS July',
        sourceType: 'manual',
        sourceId: null,
        reversesEntryId: null,
        createdAt: new Date().toISOString(),
        debitCents: 25000,
        creditCents: 0,
        runningBalanceCents: 35000,
        counterparts: ['2100 Accounts Payable'],
      },
    ],
    totalCount: 1,
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function mockLedgerRoute(response: { status: number; body: unknown }) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes(`/ledger-core/accounts/${accountId}/ledger`)) {
      return Promise.resolve(jsonResponse(response.status, response.body));
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

function renderAccountLedgerPage() {
  return render(
    <MemoryRouter initialEntries={[`/app/ledger-core/accounts/${accountId}`]}>
      <Routes>
        <Route path="/app/:appSlug/accounts/:accountId" element={<AccountLedgerPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AccountLedgerPage', () => {
  it('renders the four summary figures', async () => {
    mockLedgerRoute({
      status: 200,
      body: {
        success: true,
        ...baseLedger(),
        count: 1,
        currentPage: 1,
        totalPages: 1,
      },
    });
    renderAccountLedgerPage();

    // "Opening balance" also labels the italic first table row, so this tile
    // label can legitimately match twice.
    expect((await screen.findAllByText('Opening balance')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Total debits')).toBeInTheDocument();
    expect(screen.getByText('Total credits')).toBeInTheDocument();
    expect(screen.getByText('Closing balance')).toBeInTheDocument();
  });

  it('renders a running balance column', async () => {
    mockLedgerRoute({
      status: 200,
      body: {
        success: true,
        ...baseLedger(),
        count: 1,
        currentPage: 1,
        totalPages: 1,
      },
    });
    renderAccountLedgerPage();

    await screen.findByText('AWS July');
    // 35000 cents formatted -> "350.00"; appears both as the closing balance
    // tile and the row's running balance.
    expect(screen.getAllByText('350.00').length).toBeGreaterThanOrEqual(1);
  });

  it("links a ledger row's reference to its journal entry", async () => {
    mockLedgerRoute({
      status: 200,
      body: {
        success: true,
        ...baseLedger(),
        count: 1,
        currentPage: 1,
        totalPages: 1,
      },
    });
    renderAccountLedgerPage();

    await screen.findByText('AWS July');
    const referenceLink = screen.getByRole('link', { name: 'entry-1'.slice(0, 8) });
    expect(referenceLink).toHaveAttribute('href', '/app/ledger-core/journals/entry-1');
  });

  it('renders the header-account explanation on a 422', async () => {
    mockLedgerRoute({
      status: 422,
      body: {
        success: false,
        error: 'Account 6000 is a header account and has no ledger of its own',
      },
    });
    renderAccountLedgerPage();

    expect(await screen.findByText(/header account and has no ledger/i)).toBeInTheDocument();
    expect(
      screen.getByText(/header accounts roll up their children/i),
    ).toBeInTheDocument();
  });
});
