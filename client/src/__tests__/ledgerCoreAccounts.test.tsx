import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AccountsPage from '../Pages/ledger-core/AccountsPage';
import type { AccountNode } from '../services/fetchServices';

/**
 * The chart of accounts, with Phase 3.6's balance column and per-postable-row
 * links into the account ledger, and Phase 3.7's account creation.
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

function mockEmptyAccountsRoutes() {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/ledger-core/accounts/balances')) {
      return Promise.resolve(jsonResponse(200, { success: true, asOf: null, count: 0, balances: [] }));
    }
    if (url.includes('/ledger-core/accounts?tree=true')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: 0, accounts: [] }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

const marketingNode: AccountNode = {
  id: 'acc-6130',
  code: '6130',
  name: 'Marketing',
  type: 'Expense',
  parentId: null,
  isPostable: true,
  isActive: true,
  description: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  children: [],
};

function mockAccountsRoutesWithCreate(create: { status: number; body: unknown }) {
  let treeCallCount = 0;
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.method === 'POST' && url.includes('/ledger-core/accounts')) {
      return Promise.resolve(jsonResponse(create.status, create.body));
    }
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
      treeCallCount += 1;
      if (treeCallCount === 1) {
        return Promise.resolve(jsonResponse(200, { success: true, count: 3, accounts: [headerNode] }));
      }
      return Promise.resolve(
        jsonResponse(200, { success: true, count: 4, accounts: [headerNode, marketingNode] }),
      );
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

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

  it('opens the new-account form from the header button', async () => {
    mockAccountsRoutes();
    const user = userEvent.setup();
    renderAccountsPage();

    await screen.findAllByText('450.00');
    await user.click(screen.getByRole('button', { name: 'New account' }));

    expect(screen.getByLabelText('Code')).toBeInTheDocument();
  });

  it('posts the form and refetches the chart', async () => {
    mockAccountsRoutesWithCreate({
      status: 201,
      body: { success: true, account: marketingNode },
    });
    const user = userEvent.setup();
    renderAccountsPage();

    await screen.findAllByText('450.00');
    await user.click(screen.getByRole('button', { name: 'New account' }));

    await user.type(screen.getByLabelText('Code'), '6130');
    await user.type(screen.getByLabelText('Name'), 'Marketing');
    await user.selectOptions(screen.getByLabelText('Type'), 'Expense');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /6130.*Marketing/s })).toBeInTheDocument();
    });

    const createCall = fetchMock.mock.calls.find((call) => {
      const [input, init] = call as [RequestInfo | URL, RequestInit?];
      const url = typeof input === 'string' ? input : input.toString();
      return init?.method === 'POST' && url.includes('/ledger-core/accounts');
    });
    expect(createCall).toBeDefined();
    const body = JSON.parse((createCall as [RequestInfo | URL, RequestInit])[1].body as string) as unknown;
    expect(body).toEqual({
      code: '6130',
      name: 'Marketing',
      type: 'Expense',
      parentId: null,
      isPostable: true,
      description: null,
    });
    expect(screen.queryByLabelText('Code')).toBeNull();
  });

  it('surfaces a duplicate code error verbatim', async () => {
    mockAccountsRoutesWithCreate({
      status: 409,
      body: { success: false, error: 'Account code already exists' },
    });
    const user = userEvent.setup();
    renderAccountsPage();

    await screen.findAllByText('450.00');
    await user.click(screen.getByRole('button', { name: 'New account' }));
    await user.type(screen.getByLabelText('Code'), '6120');
    await user.type(screen.getByLabelText('Name'), 'Duplicate');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText('Account code already exists')).toBeInTheDocument();
    expect(screen.getByLabelText('Code')).toBeInTheDocument();
  });

  it('clears the selected parent when the type changes', async () => {
    mockAccountsRoutes();
    const user = userEvent.setup();
    renderAccountsPage();

    await screen.findAllByText('450.00');
    await user.click(screen.getByRole('button', { name: 'New account' }));

    await user.selectOptions(screen.getByLabelText('Type'), 'Expense');
    await user.selectOptions(screen.getByLabelText('Parent'), 'acc-6000');
    expect(screen.getByLabelText('Parent')).toHaveValue('acc-6000');

    await user.selectOptions(screen.getByLabelText('Type'), 'Asset');
    expect(screen.getByLabelText('Parent')).toHaveValue('');
  });

  it('offers to create the first account when the chart is empty', async () => {
    mockEmptyAccountsRoutes();
    const user = userEvent.setup();
    renderAccountsPage();

    expect(
      await screen.findByText('This organization has no accounts yet.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create the first account' }));

    expect(screen.getByLabelText('Code')).toBeInTheDocument();
  });
});
