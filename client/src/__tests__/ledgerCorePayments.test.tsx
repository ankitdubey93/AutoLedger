import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LedgerSettingsProvider } from '../Pages/ledger-core/LedgerSettingsContext';
import PaymentDialog from '../Pages/ledger-core/PaymentDialog';
import PaymentsPage from '../Pages/ledger-core/PaymentsPage';
import type { Account, Payment } from '../services/fetchServices';

/**
 * PaymentDialog (used from both invoice and bill detail pages) and
 * PaymentsPage, the payment register.
 *
 * PaymentDialog reads `useLedgerSettings()` for its default cash account, so
 * it renders under LedgerSettingsProvider — the same minimal wrap
 * ledgerCoreOnboarding.test.tsx uses.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const cashAccount: Account = {
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

const ledgerSettings = {
  organizationName: 'Acme Books',
  legalName: null,
  baseCurrency: 'USD',
  fiscalYearStartMonth: 1,
  fiscalYearStartDay: 1,
  booksStartDate: '2026-01-01',
  industry: null,
  timezone: 'UTC',
  cashAccountId: cashAccount.id,
  onboardedAt: new Date().toISOString(),
  currentFiscalYear: { startDate: '2026-01-01', endDate: '2026-12-31', label: 'FY 2026' },
  baseCurrencyLocked: false,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockDialogRoutes() {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.method === 'POST' && url.includes('/ledger-core/payments')) {
      return Promise.resolve(
        jsonResponse(201, {
          success: true,
          payment: { id: 'pay-new', status: 'POSTED' },
        }),
      );
    }
    if (url.includes('/ledger-core/settings') && !url.includes('invoicing')) {
      return Promise.resolve(jsonResponse(200, { success: true, settings: ledgerSettings }));
    }
    if (url.includes('/ledger-core/accounts')) {
      return Promise.resolve(jsonResponse(200, { success: true, accounts: [cashAccount] }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderPaymentDialog(overrides: Partial<React.ComponentProps<typeof PaymentDialog>> = {}) {
  const onClose = vi.fn();
  const onRecorded = vi.fn();
  render(
    <MemoryRouter>
      <LedgerSettingsProvider>
        <PaymentDialog
          direction="RECEIVE"
          counterpartyId="cust-1"
          counterpartyName="Northwind Traders"
          documentId="inv-1"
          amountDueCents={40000}
          documentCurrencyCode="USD"
          documentFxRate="1.00000000"
          onClose={onClose}
          onRecorded={onRecorded}
          {...overrides}
        />
      </LedgerSettingsProvider>
    </MemoryRouter>,
  );
  return { onClose, onRecorded };
}

describe('PaymentDialog', () => {
  it('pre-fills the amount with the amount due', async () => {
    mockDialogRoutes();
    renderPaymentDialog();

    const amountInput = await screen.findByLabelText('Amount');
    expect(amountInput).toHaveValue('400.00');
  });

  it('disables submit and shows the reason when the amount exceeds what is due', async () => {
    mockDialogRoutes();
    const user = userEvent.setup();
    renderPaymentDialog();

    const amountInput = await screen.findByLabelText('Amount');
    await user.clear(amountInput);
    await user.type(amountInput, '500.00');

    expect(screen.getByText(/cannot exceed the amount still due/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record' })).toBeDisabled();
  });

  it('submits a single allocation matching the typed amount', async () => {
    mockDialogRoutes();
    const user = userEvent.setup();
    const { onRecorded } = renderPaymentDialog();

    await screen.findByLabelText('Amount');
    await user.selectOptions(screen.getByLabelText('Cash / bank account'), cashAccount.id);
    await user.click(screen.getByRole('button', { name: 'Record' }));

    await waitFor(() => expect(onRecorded).toHaveBeenCalled());

    const createCall = fetchMock.mock.calls.find((c) => {
      const [input, init] = c as [RequestInfo | URL, RequestInit?];
      const url = typeof input === 'string' ? input : input.toString();
      return init?.method === 'POST' && url.includes('/ledger-core/payments');
    });
    expect(createCall).toBeDefined();
    const body = JSON.parse((createCall as [RequestInfo | URL, RequestInit])[1].body as string) as {
      direction: string;
      allocations: { invoiceId: string | null; billId: string | null; amountCents: number }[];
    };
    expect(body.direction).toBe('RECEIVE');
    expect(body.allocations).toHaveLength(1);
    expect(body.allocations[0]).toEqual({ invoiceId: 'inv-1', billId: null, amountCents: 40000 });
  });
});

const payment1: Payment = {
  id: 'pay-1',
  direction: 'RECEIVE',
  status: 'POSTED',
  paymentDate: '2026-07-01',
  currencyCode: 'USD',
  amountCents: 40000,
  fxRate: '1.00000000',
  baseAmountCents: 40000,
  cashAccountId: cashAccount.id,
  cashAccountCode: '1110',
  cashAccountName: 'Operating Cash',
  customerId: 'cust-1',
  vendorId: null,
  counterpartyName: 'Northwind Traders',
  method: null,
  reference: null,
  notes: null,
  journalEntryId: 'entry-1',
  voidJournalEntryId: null,
  voidedAt: null,
  createdBy: 'u1',
  createdByName: 'Ada',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  allocations: [
    { id: 'alloc-1', invoiceId: 'inv-1', billId: null, documentReference: 'INV-000001', documentTotalCents: 100000, amountCents: 40000, baseAmountCents: 40000 },
  ],
};

function mockPaymentsListRoutes(payments: Payment[]) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.method === 'POST' && url.endsWith('/void')) {
      return Promise.resolve(
        jsonResponse(200, { success: true, payment: { ...payments[0], status: 'VOID' } }),
      );
    }
    if (url.includes('/ledger-core/payments')) {
      return Promise.resolve(
        jsonResponse(200, {
          success: true,
          count: payments.length,
          totalCount: payments.length,
          currentPage: 1,
          totalPages: 1,
          payments,
        }),
      );
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderPaymentsPage() {
  return render(
    <MemoryRouter initialEntries={['/app/ledger-core/payments']}>
      <PaymentsPage />
    </MemoryRouter>,
  );
}

describe('PaymentsPage', () => {
  it('Void opens a confirmation dialog before issuing the request', async () => {
    mockPaymentsListRoutes([payment1]);
    const user = userEvent.setup();
    renderPaymentsPage();

    await screen.findByText('Northwind Traders');
    await user.click(screen.getByRole('button', { name: 'Void' }));

    expect(
      fetchMock.mock.calls.find((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'POST' && url.endsWith('/void');
      }),
    ).toBeUndefined();

    await user.click(screen.getByRole('button', { name: 'Void payment' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'POST' && url.endsWith('/void');
      });
      expect(call).toBeDefined();
    });
  });
});
