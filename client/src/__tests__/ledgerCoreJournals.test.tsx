import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JournalsPage from '../Pages/ledger-core/JournalsPage';
import JournalDetailPage from '../Pages/ledger-core/JournalDetailPage';
import NewJournalEntryPage from '../Pages/ledger-core/NewJournalEntryPage';
import type { Account, JournalEntry } from '../services/fetchServices';

/**
 * The journal register (JournalsPage) and entry detail page (JournalDetailPage).
 * Neither depends on AuthContext or OrgContext — both talk to fetchServices
 * directly — so they render under a MemoryRouter with a `/app/:appSlug/*`
 * route, which is all useAppBasePath needs.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const account6120: Account = {
  id: 'acc-6120',
  code: '6120',
  name: 'Software & IT Infrastructure',
  type: 'Expense',
  parentId: null,
  isPostable: true,
  isActive: true,
  description: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const account2100: Account = {
  ...account6120,
  id: 'acc-2100',
  code: '2100',
  name: 'Accounts Payable',
  type: 'Liability',
};

function baseEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: 'entry-11111111-2222-3333-4444-555555555555',
    entryDate: '2026-08-15',
    description: 'AWS August',
    sourceType: 'manual',
    sourceId: null,
    reversesEntryId: null,
    reversedByEntryId: null,
    createdBy: 'u1',
    createdByName: 'Alice',
    createdByEmail: 'alice@example.com',
    createdAt: new Date().toISOString(),
    totalDebitCents: 45000,
    totalCreditCents: 45000,
    lines: [
      {
        id: 'line-1',
        accountId: account6120.id,
        accountCode: account6120.code,
        accountName: account6120.name,
        debitCents: 45000,
        creditCents: 0,
        currencyCode: 'USD',
        fxRate: '1',
        baseDebitCents: 45000,
        baseCreditCents: 0,
      },
      {
        id: 'line-2',
        accountId: account2100.id,
        accountCode: account2100.code,
        accountName: account2100.name,
        debitCents: 0,
        creditCents: 45000,
        currencyCode: 'USD',
        fxRate: '1',
        baseDebitCents: 0,
        baseCreditCents: 45000,
      },
    ],
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function mockRegisterRoutes(entries: JournalEntry[]) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/ledger-core/journals')) {
      return Promise.resolve(
        jsonResponse(200, {
          success: true,
          count: entries.length,
          totalCount: entries.length,
          currentPage: 1,
          totalPages: 1,
          entries,
        }),
      );
    }
    if (url.includes('/ledger-core/accounts')) {
      return Promise.resolve(
        jsonResponse(200, { success: true, count: 2, accounts: [account6120, account2100] }),
      );
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function mockRegisterWithReverse(entries: JournalEntry[], reversalEntry: JournalEntry) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.method === 'POST' && url.includes('/reverse')) {
      return Promise.resolve(jsonResponse(200, { success: true, entry: reversalEntry }));
    }
    if (url.includes('/ledger-core/journals')) {
      return Promise.resolve(
        jsonResponse(200, {
          success: true,
          count: entries.length,
          totalCount: entries.length,
          currentPage: 1,
          totalPages: 1,
          entries,
        }),
      );
    }
    if (url.includes('/ledger-core/accounts')) {
      return Promise.resolve(
        jsonResponse(200, { success: true, count: 2, accounts: [account6120, account2100] }),
      );
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function mockDetailRoute(entry: JournalEntry) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith(`/ledger-core/journals/${entry.id}`)) {
      return Promise.resolve(jsonResponse(200, { success: true, entry }));
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

function LocationDisplay() {
  const { pathname, search } = useLocation();
  return <span data-testid="location">{pathname + search}</span>;
}

function renderJournalsPage(initialEntry = '/app/ledger-core/journals') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocationDisplay />
      <Routes>
        <Route path="/app/:appSlug/journals" element={<JournalsPage />} />
        {/* Stubs so navigating off the register (Reverse, Duplicate) doesn't
            unmount LocationDisplay along with it — it lives outside Routes,
            but the register itself must stay matched by *some* route. */}
        <Route path="/app/:appSlug/journals/new" element={<span data-testid="new-entry-stub" />} />
        <Route path="/app/:appSlug/journals/:entryId" element={<span data-testid="detail-stub" />} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderJournalDetailPage(entryId: string) {
  return render(
    <MemoryRouter initialEntries={[`/app/ledger-core/journals/${entryId}`]}>
      <Routes>
        <Route path="/app/:appSlug/journals/:entryId" element={<JournalDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('JournalsPage', () => {
  it('renders a posted entry with reference, description, poster and amount', async () => {
    mockRegisterRoutes([baseEntry()]);
    renderJournalsPage();

    expect(await screen.findByText('2026-08-15')).toBeInTheDocument();
    expect(screen.getByText('entry-11')).toBeInTheDocument();
    expect(screen.getByText('AWS August')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('450.00')).toBeInTheDocument();
  });

  it('shows a Reversed pill when reversedByEntryId is set', async () => {
    mockRegisterRoutes([baseEntry({ reversedByEntryId: 'entry-2222' })]);
    renderJournalsPage();

    expect(await screen.findByText('Reversed')).toBeInTheDocument();
  });

  it('puts the description filter into the URL as q', async () => {
    mockRegisterRoutes([baseEntry()]);
    const user = userEvent.setup();
    renderJournalsPage();

    await screen.findByText('AWS August');
    await user.type(screen.getByLabelText('Search description'), 'aws');

    await waitFor(() => {
      const location = screen.getByTestId('location').textContent ?? '';
      expect(location).toContain('q=aws');
    });
    const location = screen.getByTestId('location').textContent ?? '';
    expect(location.includes('page=') && !location.includes('page=1')).toBe(false);
  });

  it('puts the account filter into the URL as accountId', async () => {
    mockRegisterRoutes([baseEntry()]);
    const user = userEvent.setup();
    renderJournalsPage();

    await screen.findByText('AWS August');
    await user.selectOptions(screen.getByLabelText('Account'), account6120.id);

    await waitFor(() => {
      const location = screen.getByTestId('location').textContent ?? '';
      expect(location).toContain(`accountId=${account6120.id}`);
    });
  });

  it('Clear filters empties the search params', async () => {
    mockRegisterRoutes([baseEntry()]);
    const user = userEvent.setup();
    renderJournalsPage('/app/ledger-core/journals?q=aws');

    await screen.findByText('AWS August');
    await user.click(screen.getByRole('button', { name: /clear filters/i }));

    await waitFor(() => {
      const location = screen.getByTestId('location').textContent ?? '';
      expect(location).toBe('/app/ledger-core/journals');
    });
  });

  it('renders a View link per entry pointing at its detail page', async () => {
    const first = baseEntry();
    const second = baseEntry({ id: 'entry-2', entryDate: '2026-08-16' });
    mockRegisterRoutes([first, second]);
    renderJournalsPage();

    await screen.findAllByRole('link', { name: 'View entry' });
    const viewLinks = screen.getAllByRole('link', { name: 'View entry' });
    expect(viewLinks).toHaveLength(2);
    expect(viewLinks[0]).toHaveAttribute('href', `/app/ledger-core/journals/${first.id}`);
  });

  it('offers Reverse only on an entry that is neither a reversal nor already reversed', async () => {
    const plain = baseEntry({ id: 'entry-plain' });
    const reversal = baseEntry({ id: 'entry-reversal', reversesEntryId: 'entry-plain' });
    const reversed = baseEntry({ id: 'entry-reversed', reversedByEntryId: 'entry-reversal' });
    mockRegisterRoutes([plain, reversal, reversed]);
    renderJournalsPage();

    await screen.findAllByText('AWS August');
    expect(screen.getAllByRole('button', { name: 'Reverse entry' })).toHaveLength(1);
  });

  it('posts a reversal and navigates to the new entry', async () => {
    const entry = baseEntry({ id: 'entry-plain' });
    const reversal = baseEntry({ id: 'rev-1', reversesEntryId: 'entry-plain' });
    mockRegisterWithReverse([entry], reversal);
    const user = userEvent.setup();
    renderJournalsPage();

    await screen.findByText('AWS August');
    await user.click(screen.getByRole('button', { name: 'Reverse entry' }));

    await waitFor(() => {
      const location = screen.getByTestId('location').textContent ?? '';
      expect(location).toBe('/app/ledger-core/journals/rev-1');
    });
    const reverseCall = fetchMock.mock.calls.find((call) => {
      const [input, init] = call as [RequestInfo | URL, RequestInit?];
      const url = typeof input === 'string' ? input : input.toString();
      return url.includes('/reverse') && init?.method === 'POST';
    });
    expect(reverseCall).toBeDefined();
  });

  it('Duplicate links to the post form with the entry id as copyFrom', async () => {
    const entry = baseEntry({ id: 'entry-plain' });
    mockRegisterRoutes([entry]);
    renderJournalsPage();

    await screen.findByText('AWS August');
    const duplicateLink = screen.getByRole('link', { name: 'Duplicate entry' });
    expect(duplicateLink).toHaveAttribute(
      'href',
      `/app/ledger-core/journals/new?copyFrom=${entry.id}`,
    );
  });
});

function mockNewEntryRoutes(copiedEntry: JournalEntry) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith(`/ledger-core/journals/${copiedEntry.id}`)) {
      return Promise.resolve(jsonResponse(200, { success: true, entry: copiedEntry }));
    }
    if (url.includes('/ledger-core/accounts')) {
      return Promise.resolve(
        jsonResponse(200, { success: true, count: 2, accounts: [account6120, account2100] }),
      );
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderNewJournalEntryPage(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/app/:appSlug/journals/new" element={<NewJournalEntryPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('NewJournalEntryPage — ?copyFrom=', () => {
  it('pre-fills date, description and lines from the copied entry', async () => {
    const source = baseEntry({ id: 'je-1', entryDate: '2026-08-01', description: 'AWS August' });
    mockNewEntryRoutes(source);
    renderNewJournalEntryPage('/app/ledger-core/journals/new?copyFrom=je-1');

    const dateInput = await screen.findByDisplayValue('2026-08-01');
    expect(dateInput).toBeInTheDocument();
    expect(screen.getByDisplayValue('AWS August')).toBeInTheDocument();
    expect(screen.getByLabelText('Debit for line 1')).toHaveValue('450.00');
    expect(screen.getByLabelText('Credit for line 2')).toHaveValue('450.00');
  });

  it('does not re-seed the form after the user edits it', async () => {
    const source = baseEntry({ id: 'je-1', entryDate: '2026-08-01', description: 'AWS August' });
    mockNewEntryRoutes(source);
    const user = userEvent.setup();
    renderNewJournalEntryPage('/app/ledger-core/journals/new?copyFrom=je-1');

    await screen.findByDisplayValue('AWS August');
    const descriptionInput = screen.getByLabelText('Description');
    await user.clear(descriptionInput);
    await user.type(descriptionInput, 'Edited');

    await waitFor(() => {
      expect(descriptionInput).toHaveValue('Edited');
    });
  });
});

describe('JournalDetailPage', () => {
  it('shows both totals and Balanced when they agree', async () => {
    const entry = baseEntry();
    mockDetailRoute(entry);
    renderJournalDetailPage(entry.id);

    const balancedLabel = await screen.findByText('Balanced');
    const totalsRow = balancedLabel.closest('tr');
    expect(totalsRow).not.toBeNull();
    expect(totalsRow).toHaveTextContent('450.00');
    // Two totals cells in the footer row, plus one debit and one credit cell
    // in the line rows above — four occurrences of the same formatted figure.
    expect(screen.getAllByText('450.00')).toHaveLength(4);
  });

  it('offers no edit or delete control', async () => {
    const entry = baseEntry();
    mockDetailRoute(entry);
    renderJournalDetailPage(entry.id);

    await screen.findByText('Balanced');
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
  });
});
