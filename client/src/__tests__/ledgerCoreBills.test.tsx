import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { OrgProvider } from '../context/OrgContext';
import { LedgerSettingsProvider } from '../Pages/ledger-core/LedgerSettingsContext';
import BillsPage from '../Pages/ledger-core/BillsPage';
import BillDetailPage from '../Pages/ledger-core/BillDetailPage';
import type { Bill } from '../services/fetchServices';

/**
 * The bill register and the bill detail page.
 *
 * BillsPage talks to fetchServices directly, like InvoicesPage — no
 * AuthContext or OrgContext needed. BillDetailPage reads `useAuth()` (to
 * gate the Approve button on role), so it renders under AuthProvider +
 * OrgProvider, the same minimal stack InvoiceDetailPage's tests use.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const session = {
  success: true,
  user: {
    id: 'u1',
    name: 'Ada',
    email: 'ada@example.com',
    emailVerified: false,
    createdAt: new Date().toISOString(),
  },
  organization: { id: 'o1', name: 'Acme', slug: 'acme', baseCurrency: 'USD', createdAt: new Date().toISOString() },
  role: 'OWNER',
  memberships: [
    { orgId: 'o1', orgName: 'Acme', orgSlug: 'acme', role: 'OWNER', joinedAt: new Date().toISOString() },
  ],
  accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
};

const ledgerSettings = {
  organizationName: 'Acme',
  legalName: 'Acme Inc.',
  baseCurrency: 'USD',
  fiscalYearStartMonth: 1,
  fiscalYearStartDay: 1,
  booksStartDate: '2026-01-01',
  industry: null,
  timezone: 'UTC',
  cashAccountId: null,
  onboardedAt: new Date().toISOString(),
  currentFiscalYear: { startDate: '2026-01-01', endDate: '2026-12-31', label: 'FY 2026' },
  baseCurrencyLocked: false,
};

function baseBill(overrides: Partial<Bill> = {}): Bill {
  return {
    id: 'bill-1',
    vendorReference: 'VEND-001',
    status: 'DRAFT',
    vendorId: 'vend-1',
    vendorName: 'Acme Supplies',
    billDate: '2026-06-01',
    dueDate: '2026-06-30',
    currencyCode: 'USD',
    vendorNameSnapshot: 'Acme Supplies',
    vendorAddressSnapshot: null,
    vendorTaxNumberSnapshot: null,
    notes: null,
    paymentTerms: null,
    subtotalCents: 60000,
    taxCents: 0,
    totalCents: 60000,
    fxRate: '1.00000000',
    baseSubtotalCents: 60000,
    baseTaxCents: 0,
    baseTotalCents: 60000,
    journalEntryId: null,
    voidJournalEntryId: null,
    submittedAt: null,
    postedAt: null,
    voidedAt: null,
    approvedBy: null,
    approvedByName: null,
    createdBy: 'u1',
    createdByName: 'Ada',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lines: [
      {
        id: 'line-1',
        lineNumber: 1,
        description: 'Office supplies',
        quantityMilli: 1000,
        unitPriceCents: 60000,
        expenseAccountId: 'acc-6130',
        expenseAccountCode: '6130',
        expenseAccountName: 'Office Supplies',
        taxRateBp: 0,
        netCents: 60000,
        taxCents: 0,
      },
    ],
    allocatedCents: 0,
    amountDueCents: 0,
    settlementStatus: 'NOT_APPLICABLE',
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

function mockBillsListRoutes(bills: Bill[]) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/ledger-core/bills')) {
      return Promise.resolve(
        jsonResponse(200, {
          success: true,
          count: bills.length,
          totalCount: bills.length,
          currentPage: 1,
          totalPages: 1,
          bills,
        }),
      );
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderBillsPage(initialEntry = '/app/ledger-core/bills') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/app/:appSlug/bills" element={<BillsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('BillsPage', () => {
  it('renders rows with vendor, reference, and formatted amount due', async () => {
    mockBillsListRoutes([baseBill({ status: 'POSTED', amountDueCents: 25000 })]);
    renderBillsPage();

    await screen.findByText('Acme Supplies');
    expect(screen.getByText('VEND-001')).toBeInTheDocument();
    expect(screen.getByText('250.00')).toBeInTheDocument();
  });

  it('clicking "To review" requests status=AWAITING_APPROVAL', async () => {
    mockBillsListRoutes([]);
    const user = userEvent.setup();
    renderBillsPage();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: 'To review' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => {
        const [input] = c as [RequestInfo | URL];
        const url = typeof input === 'string' ? input : input.toString();
        return url.includes('status=AWAITING_APPROVAL');
      });
      expect(call).toBeDefined();
    });
  });

  it('clicking "Overdue" requests status=POSTED and settlement=OVERDUE', async () => {
    mockBillsListRoutes([]);
    const user = userEvent.setup();
    renderBillsPage();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: 'Overdue' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => {
        const [input] = c as [RequestInfo | URL];
        const url = typeof input === 'string' ? input : input.toString();
        return url.includes('status=POSTED') && url.includes('settlement=OVERDUE');
      });
      expect(call).toBeDefined();
    });
  });
});

function mockDetailRoutes(bill: Bill) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.method === 'POST' && url.endsWith('/approve')) {
      return Promise.resolve(
        jsonResponse(200, { success: true, bill: { ...bill, status: 'POSTED', journalEntryId: 'entry-1' } }),
      );
    }
    if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, session));
    if (url.endsWith(`/ledger-core/bills/${bill.id}`)) {
      return Promise.resolve(jsonResponse(200, { success: true, bill }));
    }
    if (url.includes('/ledger-core/payments')) {
      return Promise.resolve(
        jsonResponse(200, { success: true, count: 0, totalCount: 0, currentPage: 1, totalPages: 1, payments: [] }),
      );
    }
    if (url.includes('/ledger-core/settings')) {
      return Promise.resolve(jsonResponse(200, { success: true, settings: ledgerSettings }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderBillDetailPage(billId: string) {
  return render(
    <MemoryRouter initialEntries={[`/app/ledger-core/bills/${billId}`]}>
      <AuthProvider>
        <OrgProvider>
          <LedgerSettingsProvider>
            <Routes>
              <Route path="/app/:appSlug/bills/:billId" element={<BillDetailPage />} />
            </Routes>
          </LedgerSettingsProvider>
        </OrgProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('BillDetailPage', () => {
  it('shows Approve for an AWAITING_APPROVAL bill and confirms before posting', async () => {
    const bill = baseBill({ id: 'bill-review', status: 'AWAITING_APPROVAL', submittedAt: new Date().toISOString() });
    mockDetailRoutes(bill);
    const user = userEvent.setup();
    renderBillDetailPage(bill.id);

    const approveButton = await screen.findByRole('button', { name: 'Approve' });
    await user.click(approveButton);

    // No POST to /approve until the confirmation dialog is confirmed.
    expect(
      fetchMock.mock.calls.find((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'POST' && url.endsWith('/approve');
      }),
    ).toBeUndefined();

    await user.click(screen.getByRole('button', { name: 'Approve bill' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'POST' && url.endsWith('/approve');
      });
      expect(call).toBeDefined();
    });
  });

  it('does not show Approve for a DRAFT bill', async () => {
    const bill = baseBill({ id: 'bill-draft', status: 'DRAFT' });
    mockDetailRoutes(bill);
    renderBillDetailPage(bill.id);

    await screen.findByText('Office supplies');
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });
});
