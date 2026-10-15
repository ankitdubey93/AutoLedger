import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NewBillPage from '../Pages/purchases/NewBillPage';
import PaymentTermsSettingsPage from '../Pages/settings/PaymentTermsSettingsPage';
import { LedgerSettingsProvider } from '../context/LedgerSettingsContext';
import { computeDueDate } from '../utils/dueDate';
import type { LedgerSettings, PaymentTerm, Vendor } from '../services/fetchServices';

/**
 * Phase 43a — the new-expense form starts on the party's / organization's
 * default payment term, stops once the user chooses, and the payment-term
 * form speaks "day of month" for the two DAY_OF_* rules.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const stamp = new Date().toISOString();

function term(partial: Pick<PaymentTerm, 'id' | 'code' | 'name' | 'netDays' | 'rule'>): PaymentTerm {
  return { ...partial, isSystem: false, isActive: true, createdAt: stamp, updatedAt: stamp };
}

const net30 = term({ id: 'term-net30', code: 'NET_30', name: 'Net 30', netDays: 30, rule: 'DAYS_AFTER_DATE' });
const next20 = term({
  id: 'term-next20',
  code: 'NEXT20',
  name: '20th of next month',
  netDays: 20,
  rule: 'DAY_OF_NEXT_MONTH',
});

function vendor(id: string, name: string, defaultPaymentTermId: string | null): Vendor {
  return {
    id,
    name,
    email: null,
    phone: null,
    billingAddress: null,
    taxNumber: null,
    paymentTerms: null,
    notes: null,
    defaultPaymentTermId,
    isActive: true,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

const vendorA = vendor('vend-a', 'Acme Supplies', next20.id);
const vendorB = vendor('vend-b', 'Bolt Works', net30.id);

const settings: LedgerSettings = {
  organizationName: 'Test Org',
  legalName: null,
  baseCurrency: 'USD',
  fiscalYearStartMonth: 1,
  fiscalYearStartDay: 1,
  booksStartDate: '2026-01-01',
  industry: null,
  timezone: 'UTC',
  cashAccountId: null,
  onboardedAt: stamp,
  currentFiscalYear: { startDate: '2026-01-01', endDate: '2026-12-31', label: 'FY 2026' },
  baseCurrencyLocked: false,
  realizedFxGainAccountId: null,
  realizedFxLossAccountId: null,
  unrealizedFxAccountId: null,
  inventoryAccountId: null,
  cogsAccountId: null,
  inventoryAdjustmentAccountId: null,
  stockOpeningAccountId: null,
  defaultSalesPaymentTermId: null,
  defaultPurchasePaymentTermId: net30.id,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/api/v1/settings')) return Promise.resolve(jsonResponse(200, { success: true, settings }));
    if (url.includes('/api/v1/vendors')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: 2, vendors: [vendorA, vendorB] }));
    }
    if (url.includes('/api/v1/accounts')) return Promise.resolve(jsonResponse(200, { success: true, count: 0, accounts: [] }));
    if (url.includes('/api/v1/items')) return Promise.resolve(jsonResponse(200, { success: true, count: 0, items: [] }));
    if (url.includes('/api/v1/payment-terms')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: 2, paymentTerms: [net30, next20] }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderNewBill() {
  return render(
    <MemoryRouter initialEntries={['/expenses/new']}>
      <LedgerSettingsProvider>
        <Routes>
          <Route path="/expenses/new" element={<NewBillPage />} />
        </Routes>
      </LedgerSettingsProvider>
    </MemoryRouter>,
  );
}

describe('default payment terms on the new expense form', () => {
  it('a new expense pre-fills the organization default term', async () => {
    renderNewBill();
    await screen.findByText('Select a vendor…');

    await waitFor(() => expect(screen.getByLabelText('Payment terms')).toHaveValue('NET_30'));
  });

  it("choosing a vendor with a default switches the term and the due date", async () => {
    const user = userEvent.setup();
    renderNewBill();
    await screen.findByText('Select a vendor…');
    await waitFor(() => expect(screen.getByLabelText('Payment terms')).toHaveValue('NET_30'));

    await user.selectOptions(screen.getByDisplayValue('Select a vendor…'), 'vend-a');

    await waitFor(() => expect(screen.getByLabelText('Payment terms')).toHaveValue('NEXT20'));
    const billDate = (screen.getByLabelText('Expense date') as HTMLInputElement).value;
    await waitFor(() =>
      expect(screen.getByLabelText('Due date')).toHaveValue(computeDueDate('DAY_OF_NEXT_MONTH', 20, billDate)),
    );
  });

  it('after the user picks a term, choosing another vendor does not change it', async () => {
    const user = userEvent.setup();
    renderNewBill();
    await screen.findByText('Select a vendor…');
    await waitFor(() => expect(screen.getByLabelText('Payment terms')).toHaveValue('NET_30'));

    await user.selectOptions(screen.getByLabelText('Payment terms'), 'NEXT20');
    await user.selectOptions(screen.getByDisplayValue('Select a vendor…'), 'vend-b');

    expect(screen.getByLabelText('Payment terms')).toHaveValue('NEXT20');
  });
});

describe('the payment-term form', () => {
  it('shows "Day of month" for a DAY_OF_NEXT_MONTH rule', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/settings/payment-terms']}>
        <Routes>
          <Route path="/settings/payment-terms" element={<PaymentTermsSettingsPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('NET_30');
    await user.click(screen.getByRole('button', { name: 'New payment term' }));
    expect(screen.getByLabelText('Net days')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Rule'), 'DAY_OF_NEXT_MONTH');

    expect(screen.getByLabelText('Day of month')).toBeInTheDocument();
    expect(screen.queryByLabelText('Net days')).not.toBeInTheDocument();
  });
});
