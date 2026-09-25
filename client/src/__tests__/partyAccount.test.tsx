import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PartyAccountPage from '../Pages/sales/PartyAccountPage';
import CustomersPage from '../Pages/sales/CustomersPage';
import type { Customer, PartyLedger, PartyOpenItems } from '../services/fetchServices';

/**
 * Customer and vendor accounts (Phase 25). The page reads the base currency
 * from OrgContext and everything else from fetchServices, so OrgContext is
 * mocked to a fixed organization rather than standing up the auth/org
 * provider tree — the same fetch-stub approach every other Accounting page
 * test uses for the data.
 */

vi.mock('../context/OrgContext', () => ({
  useOrg: () => ({ organization: { id: 'o1', name: 'Acme', slug: 'acme', baseCurrency: 'USD' } }),
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function customerLedger(overrides: Partial<PartyLedger> = {}): PartyLedger {
  return {
    party: { kind: 'CUSTOMER', id: 'cust-1', name: 'Northwind Traders' },
    controlAccount: { id: 'acc-1120', code: '1120', name: 'Accounts Receivable' },
    from: null,
    to: null,
    openingBalanceCents: 0,
    periodDebitCents: 10000,
    periodCreditCents: 4000,
    closingBalanceCents: 6000,
    totalCount: 2,
    rows: [
      {
        journalEntryId: 'je-1',
        entryDate: '2026-06-01',
        kind: 'INVOICE',
        documentId: 'inv-1',
        documentNumber: 'INV-0001',
        debitCents: 10000,
        creditCents: 0,
        runningBalanceCents: 10000,
        allocations: [],
      },
      {
        journalEntryId: 'je-2',
        entryDate: '2026-07-01',
        kind: 'PAYMENT',
        documentId: 'pay-1',
        documentNumber: 'RCPT-1',
        debitCents: 0,
        creditCents: 4000,
        runningBalanceCents: 6000,
        allocations: [{ documentId: 'inv-1', documentNumber: 'INV-0001', baseAmountCents: 4000 }],
      },
    ],
    ...overrides,
  };
}

function customerOpenItems(overrides: Partial<PartyOpenItems> = {}): PartyOpenItems {
  return {
    party: { kind: 'CUSTOMER', id: 'cust-1', name: 'Northwind Traders' },
    asOf: '2026-09-04',
    outstandingCents: 6000,
    overdueCents: 6000,
    items: [
      {
        documentKind: 'INVOICE',
        documentId: 'inv-1',
        documentNumber: 'INV-0001',
        documentDate: '2026-06-01',
        dueDate: '2026-08-20',
        currencyCode: 'USD',
        totalCents: 10000,
        baseTotalCents: 10000,
        baseOutstandingCents: 6000,
        daysOverdue: 15,
        bucket: 'D1_30',
      },
    ],
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function mockRoutes(routes: Record<string, { status: number; body: unknown }>) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const [fragment, response] of Object.entries(routes)) {
      if (url.includes(fragment)) return Promise.resolve(jsonResponse(response.status, response.body));
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

function renderParty(kind: 'CUSTOMER' | 'VENDOR', path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/customers/:partyId" element={<PartyAccountPage kind="CUSTOMER" />} />
        <Route path="/vendors/:partyId" element={<PartyAccountPage kind={kind} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PartyAccountPage', () => {
  it('renders the balance and overdue tiles from open items', async () => {
    mockRoutes({
      '/api/v1/customers/cust-1/ledger': {
        status: 200,
        body: { success: true, count: 2, currentPage: 1, totalPages: 1, ...customerLedger() },
      },
      '/api/v1/customers/cust-1/open-items': { status: 200, body: { success: true, ...customerOpenItems() } },
    });

    renderParty('CUSTOMER', '/customers/cust-1');

    expect(await screen.findByRole('heading', { name: 'Northwind Traders' })).toBeInTheDocument();
    expect(screen.getByText('Receivable')).toBeInTheDocument();
    expect(screen.getByText('Overdue')).toBeInTheDocument();
    expect(screen.getByText(/under 1120 Accounts Receivable/)).toBeInTheDocument();
  });

  it('a payment row shows "applied to INV-0001" linking to the invoice', async () => {
    mockRoutes({
      '/api/v1/customers/cust-1/ledger': {
        status: 200,
        body: { success: true, count: 2, currentPage: 1, totalPages: 1, ...customerLedger() },
      },
      '/api/v1/customers/cust-1/open-items': { status: 200, body: { success: true, ...customerOpenItems() } },
    });

    renderParty('CUSTOMER', '/customers/cust-1');

    const paymentCell = await screen.findByText(/applied to/);
    const link = within(paymentCell).getByRole('link', { name: 'INV-0001' });
    expect(link).toHaveAttribute('href', '/invoices/inv-1');
  });

  it('a vendor bill row is labelled "Expense" and links to the expense page', async () => {
    mockRoutes({
      '/api/v1/vendors/ven-1/ledger': {
        status: 200,
        body: {
          success: true,
          count: 1,
          currentPage: 1,
          totalPages: 1,
          ...customerLedger({
            party: { kind: 'VENDOR', id: 'ven-1', name: 'Acme Supplies' },
            controlAccount: { id: 'acc-2100', code: '2100', name: 'Accounts Payable' },
            totalCount: 1,
            rows: [
              {
                journalEntryId: 'je-9',
                entryDate: '2026-06-01',
                kind: 'BILL',
                documentId: 'bill-1',
                documentNumber: 'ACME-77',
                debitCents: 0,
                creditCents: 7000,
                runningBalanceCents: 7000,
                allocations: [],
              },
            ],
          }),
        },
      },
      '/api/v1/vendors/ven-1/open-items': {
        status: 200,
        body: {
          success: true,
          ...customerOpenItems({ party: { kind: 'VENDOR', id: 'ven-1', name: 'Acme Supplies' }, items: [] }),
        },
      },
    });

    renderParty('VENDOR', '/vendors/ven-1');

    expect(await screen.findByText('Expense')).toBeInTheDocument();
    expect(screen.getByText('Payable')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'ACME-77' })).toHaveAttribute(
      'href',
      '/expenses/bill-1',
    );
    expect(screen.getByText('Nothing outstanding.')).toBeInTheDocument();
  });

  it('a 404 renders "Customer not found"', async () => {
    mockRoutes({
      '/api/v1/customers/missing/ledger': { status: 404, body: { success: false, error: 'Customer not found' } },
      '/api/v1/customers/missing/open-items': {
        status: 404,
        body: { success: false, error: 'Customer not found' },
      },
    });

    renderParty('CUSTOMER', '/customers/missing');

    expect(await screen.findByText('Customer not found.')).toBeInTheDocument();
  });
});

const customer1: Customer = {
  id: 'cust-1',
  name: 'Northwind Traders',
  email: null,
  phone: null,
  billingAddress: null,
  taxNumber: null,
  notes: null,
  isActive: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function renderCustomersPage() {
  return render(
    <MemoryRouter initialEntries={['/customers']}>
      <Routes>
        <Route path="/customers" element={<CustomersPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CustomersPage — party account links and balances', () => {
  it('the name links to the customer account and shows the balance from AR aging', async () => {
    mockRoutes({
      '/api/v1/reports/ar-aging': {
        status: 200,
        body: {
          success: true,
          asOf: '2026-09-04',
          kind: 'AR',
          buckets: [],
          totalOutstandingCents: 6000,
          totalOverdueCents: 0,
          controlAccount: null,
          reconciles: null,
          rows: [
            {
              counterpartyId: 'cust-1',
              counterpartyName: 'Northwind Traders',
              currentCents: 6000,
              d1to30Cents: 0,
              d31to60Cents: 0,
              d61to90Cents: 0,
              d90PlusCents: 0,
              totalCents: 6000,
            },
          ],
        },
      },
      '/api/v1/customers': { status: 200, body: { success: true, count: 1, customers: [customer1] } },
    });

    renderCustomersPage();

    const link = await screen.findByRole('link', { name: 'Northwind Traders' });
    expect(link).toHaveAttribute('href', '/customers/cust-1');
    expect(await screen.findByText('60.00')).toBeInTheDocument();
  });

  it('an aging failure still renders the list, with "—" for the balance', async () => {
    mockRoutes({
      '/api/v1/reports/ar-aging': { status: 500, body: { success: false, error: 'boom' } },
      '/api/v1/customers': { status: 200, body: { success: true, count: 1, customers: [customer1] } },
    });

    renderCustomersPage();

    const row = (await screen.findByRole('link', { name: 'Northwind Traders' })).closest('tr');
    if (row === null) throw new Error('no row');
    const cells = within(row).getAllByRole('cell');
    expect(cells[4]).toHaveTextContent('—');
  });
});
