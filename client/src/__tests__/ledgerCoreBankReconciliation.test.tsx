import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BankReconciliationPage from '../Pages/ledger-core/BankReconciliationPage';
import type { Account, BankReconciliationReport } from '../services/fetchServices';

/** BankReconciliationPage. */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function account(): Account {
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
  };
}

function report(overrides: Partial<BankReconciliationReport> = {}): BankReconciliationReport {
  return {
    accountId: 'acc-1110',
    accountCode: '1110',
    accountName: 'Operating Cash',
    asOf: '2026-06-30',
    glBalanceCents: 40000,
    statementBalanceCents: 40000,
    differenceCents: 0,
    reconciles: true,
    matchedCount: 1,
    matchedCents: 40000,
    unmatchedCount: 0,
    unmatchedCents: 0,
    ignoredCount: 0,
    statedClosingBalanceCents: null,
    statedClosingBalanceOn: null,
    statedClosingDifferenceCents: null,
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

function mockRoutes(reconciliation: BankReconciliationReport) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/ledger-core/accounts')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: 1, accounts: [account()] }));
    }
    if (url.includes('/ledger-core/reports/bank-reconciliation')) {
      return Promise.resolve(jsonResponse(200, { success: true, ...reconciliation }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/app/ledger-core/bank/reconciliation']}>
      <Routes>
        <Route path="/app/:appSlug/bank/reconciliation" element={<BankReconciliationPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('BankReconciliationPage', () => {
  it('shows the agree banner when reconciles is true', async () => {
    mockRoutes(report({ reconciles: true, differenceCents: 0 }));
    renderPage();

    expect(await screen.findByText('The bank and the books agree')).toBeInTheDocument();
    expect(screen.queryByText(/Difference of/)).not.toBeInTheDocument();
  });

  it('shows the difference when reconciles is false', async () => {
    mockRoutes(report({ reconciles: false, differenceCents: 1500 }));
    renderPage();

    expect(await screen.findByText('Difference of 15.00')).toBeInTheDocument();
    expect(screen.queryByText('The bank and the books agree')).not.toBeInTheDocument();
  });

  it('renders the completeness caveat', async () => {
    mockRoutes(report());
    renderPage();

    expect(await screen.findByText(/completeness check, not a correctness proof/)).toBeInTheDocument();
  });
});
