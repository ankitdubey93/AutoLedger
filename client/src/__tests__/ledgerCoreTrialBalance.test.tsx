import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TrialBalancePage from '../Pages/ledger-core/TrialBalancePage';
import type { TrialBalanceRow } from '../services/fetchServices';

/**
 * The trial balance report. Doesn't depend on AuthContext or OrgContext — it
 * talks to fetchServices directly — so it renders under a MemoryRouter with a
 * `/app/:appSlug/trial-balance` route, which is all useAppBasePath needs.
 *
 * Phase 3.7 links each row's account name into that account's ledger — every
 * row here is a postable account (reportService.trialBalance filters on
 * `a.is_postable`), so the link is always safe.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const expenseRow: TrialBalanceRow = {
  accountId: 'acc-6120',
  code: '6120',
  name: 'Software & IT Infrastructure',
  type: 'Expense',
  debitCents: 45000,
  creditCents: 0,
  netBalanceCents: 45000,
};

const cashRow: TrialBalanceRow = {
  accountId: 'acc-1010',
  code: '1010',
  name: 'Cash',
  type: 'Asset',
  debitCents: 0,
  creditCents: 45000,
  netBalanceCents: -45000,
};

let fetchMock: ReturnType<typeof vi.fn>;

function mockTrialBalanceRoute() {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/ledger-core/reports/trial-balance')) {
      return Promise.resolve(
        jsonResponse(200, {
          success: true,
          asOf: null,
          isBalanced: true,
          totalDebitCents: 45000,
          totalCreditCents: 45000,
          count: 2,
          rows: [expenseRow, cashRow],
        }),
      );
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

function renderTrialBalancePage() {
  return render(
    <MemoryRouter initialEntries={['/app/ledger-core/trial-balance']}>
      <Routes>
        <Route path="/app/:appSlug/trial-balance" element={<TrialBalancePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TrialBalancePage', () => {
  it("links each account name to its ledger", async () => {
    mockTrialBalanceRoute();
    renderTrialBalancePage();

    const link = await screen.findByRole('link', { name: 'Software & IT Infrastructure' });
    expect(link).toHaveAttribute('href', '/app/ledger-core/accounts/acc-6120');
  });

  it('renders the balanced banner and the unfiltered totals', async () => {
    mockTrialBalanceRoute();
    renderTrialBalancePage();

    expect(await screen.findByText('Debits equal credits exactly.')).toBeInTheDocument();
    // The footer totals are unfiltered proof the books balance — they must
    // render regardless of how many row cells happen to show the same figure.
    const totalsRow = screen.getByText('Totals').closest('tr');
    expect(totalsRow).not.toBeNull();
    expect(totalsRow).toHaveTextContent('450.00');
    expect(screen.getAllByText('450.00').length).toBeGreaterThanOrEqual(2);
  });
});
