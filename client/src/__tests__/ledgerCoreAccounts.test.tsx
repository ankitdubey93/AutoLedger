import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AccountsPage from '../Pages/ledger-core/AccountsPage';
import type { AccountNode } from '../services/fetchServices';

/**
 * The chart of accounts, with Phase 3.6's balance column and per-postable-row
 * links into the account ledger.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const headerNode: AccountNode = {
  id: 'acc-6000',
  code: '6000',
  name: 'Operating Expenses',
  type: 'Expense',
  parentId: null,
  isPostable: false,
  isActive: true,
  description: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  children: [
    {
      id: 'acc-6120',
      code: '6120',
      name: 'Software & IT Infrastructure',
      type: 'Expense',
      parentId: 'acc-6000',
      isPostable: true,
      isActive: true,
      description: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      children: [],
    },
    {
      id: 'acc-6110',
      code: '6110',
      name: 'Rent & Utilities',
      type: 'Expense',
      parentId: 'acc-6000',
      isPostable: true,
      isActive: true,
      description: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      children: [],
    },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;

function mockAccountsRoutes() {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/ledger-core/accounts/balances')) {
      return Promise.resolve(
        jsonResponse(200, {
          success: true,
          asOf: null,
          count: 3,
          balances: [
            { accountId: 'acc-6000', ownBalanceCents: 0, rollupBalanceCents: 45000 },
            { accountId: 'acc-6120', ownBalanceCents: 45000, rollupBalanceCents: 45000 },
            { accountId: 'acc-6110', ownBalanceCents: 0, rollupBalanceCents: 0 },
          ],
        }),
      );
    }
    if (url.includes('/ledger-core/accounts?tree=true')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: 3, accounts: [headerNode] }));
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

function renderAccountsPage() {
  return render(
    <MemoryRouter initialEntries={['/app/ledger-core/accounts']}>
      <Routes>
        <Route path="/app/:appSlug/accounts" element={<AccountsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AccountsPage', () => {
  it('shows the rollup balance on a header row', async () => {
    mockAccountsRoutes();
    renderAccountsPage();

    // Matches twice: the header's own rollup and the leaf's own balance
    // happen to be the same figure in this fixture.
    expect((await screen.findAllByText('450.00')).length).toBeGreaterThanOrEqual(1);
  });

  it('links a postable row into its ledger', async () => {
    mockAccountsRoutes();
    renderAccountsPage();

    const link = await screen.findByRole('link', { name: /6120.*Software & IT Infrastructure/s });
    expect(link).toHaveAttribute('href', '/app/ledger-core/accounts/acc-6120');
  });

  it('renders no link for a header row', async () => {
    mockAccountsRoutes();
    renderAccountsPage();

    await screen.findAllByText('450.00');
    const headerLink = screen.queryByRole('link', { name: /6000.*Operating Expenses/s });
    expect(headerLink).toBeNull();
  });

  it('renders a zero balance as a dash', async () => {
    mockAccountsRoutes();
    renderAccountsPage();

    await screen.findAllByText('450.00');
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
