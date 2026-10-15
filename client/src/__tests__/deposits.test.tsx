import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SalesOrderDetailPage from '../Pages/sales/SalesOrderDetailPage';
import InvoiceDetailPage from '../Pages/sales/InvoiceDetailPage';
import NewQuotePage from '../Pages/sales/NewQuotePage';
import QuoteDocument, { type QuoteDocumentData } from '../Pages/sales/quotes/QuoteDocument';
import type { Account, Customer, Invoice, InvoiceSettings, Order } from '../services/fetchServices';

/**
 * Phase 42 — deposits and prepayments on the client: the order's deposit
 * request, an invoice applying a deposit, the quote form's deposit field, and
 * the deposit sentence on the quote document.
 */

vi.mock('../context/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../context/AuthContext')>()),
  useCan: () => () => true,
}));
vi.mock('../context/OrgContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../context/OrgContext')>()),
  useOrg: () => ({ organization: { id: 'o1', name: 'Acme Ltd', slug: 'acme', baseCurrency: 'USD' } }),
  useOrganizationName: () => 'Acme Ltd',
}));
vi.mock('../context/LedgerSettingsContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../context/LedgerSettingsContext')>()),
  useLedgerSettings: () => ({ status: 'ready', settings: ledgerSettings }),
}));

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
  onboardedAt: '2026-01-01T00:00:00.000Z',
  currentFiscalYear: { startDate: '2026-01-01', endDate: '2026-12-31', label: 'FY 2026' },
  baseCurrencyLocked: false,
};

type Reply = { status: number; body: unknown };
type Router = (method: string, url: string, init?: RequestInit) => Reply | undefined;

let fetchMock: ReturnType<typeof vi.fn>;

/** Routes by method and URL; an unhandled call answers 404, as the other client suites do. */
function mockApi(route: Router) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const reply = route(method, url, init);
    if (reply === undefined) {
      return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${method} ${url}` }));
    }
    return Promise.resolve(jsonResponse(reply.status, reply.body));
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ----------------------------------------------------------------- fixtures

const account4100: Account = {
  id: 'acc-4100',
  code: '4100',
  name: 'Sales revenue',
  type: 'Revenue',
  parentId: null,
  isPostable: true,
  isActive: true,
  description: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const customer1: Customer = {
  id: 'cust-1',
  name: 'Northwind Traders',
  email: null,
  phone: null,
  billingAddress: null,
  taxNumber: null,
  notes: null,
  defaultPaymentTermId: null,
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const invoiceSettings: InvoiceSettings = {
  numberPrefix: 'INV-',
  numberPadding: 6,
  nextNumber: 1,
  defaultDueDays: 30,
  defaultTaxRateBp: 0,
  taxLabel: 'Tax',
  receivableAccountId: null,
  defaultRevenueAccountId: account4100.id,
  taxPayableAccountId: null,
  showTaxNumber: true,
  showBusinessNumber: false,
  showLegalName: true,
  billingAddress: null,
  paymentTerms: null,
  footerNotes: null,
  accentColor: '#2563eb',
  templateId: 'classic',
  documentTitle: 'INVOICE',
  fontFamily: 'sans',
  density: 'comfortable',
  showLogo: true,
  showOrgAddress: true,
  showPaymentTerms: true,
  showDueDate: true,
  bankDetails: null,
  quotePrefix: 'QU-',
  quoteNextNumber: 1,
  purchaseQuotePrefix: 'PQ-',
  purchaseQuoteNextNumber: 1,
  defaultQuoteValidityDays: 30,
  defaultQuoteTerms: null,
  quoteAcceptanceRequiresCode: false,
  customerDepositAccountId: null,
  supplierPrepaymentAccountId: null,
  configured: true,
};

function orderLine(overrides: Partial<Order['lines'][number]> = {}): Order['lines'][number] {
  return {
    id: 'ol1',
    lineNumber: 1,
    description: 'Installation',
    quantityMilli: 5000,
    unitPriceCents: 10000,
    accountId: 'acc-4100',
    accountCode: '4100',
    accountName: 'Revenue',
    taxRateBp: 0,
    netCents: 50000,
    taxCents: 0,
    itemId: null,
    billedQuantityMilli: 0,
    remainingQuantityMilli: 5000,
    ...overrides,
  };
}

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: 'o1',
    direction: 'SALES',
    orderNumber: 'SO-000001',
    status: 'CONFIRMED',
    billingStatus: 'NOT_BILLED',
    partyId: 'cust-1',
    partyName: 'Northwind',
    orderDate: '2026-10-01',
    expectedDate: null,
    currencyCode: 'USD',
    totalCents: 50000,
    createdAt: '2026-10-01T00:00:00.000Z',
    partyNameSnapshot: 'Northwind',
    partyAddressSnapshot: null,
    partyTaxNumberSnapshot: null,
    partyReference: null,
    notes: null,
    terms: null,
    paymentTerms: null,
    paymentTermsCode: null,
    subtotalCents: 50000,
    taxCents: 0,
    sourceQuote: null,
    confirmedAt: '2026-10-01T00:00:00.000Z',
    closedAt: null,
    cancelledAt: null,
    cancelReason: null,
    createdBy: 'u1',
    createdByName: 'Alice',
    updatedAt: '2026-10-01T00:00:00.000Z',
    lines: [orderLine()],
    documents: [],
    ...overrides,
  };
}

function baseInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    invoiceNumber: null,
    status: 'DRAFT',
    customerId: customer1.id,
    customerName: customer1.name,
    issueDate: '2026-06-01',
    dueDate: '2026-06-30',
    currencyCode: 'USD',
    customerNameSnapshot: customer1.name,
    customerAddressSnapshot: null,
    customerTaxNumberSnapshot: null,
    notes: null,
    notesTemplate: null,
    paymentTerms: null,
    paymentTermsCode: null,
    subtotalCents: 25000,
    taxCents: 0,
    totalCents: 25000,
    fxRate: '1.00000000',
    baseSubtotalCents: 25000,
    baseTaxCents: 0,
    baseTotalCents: 25000,
    journalEntryId: null,
    voidJournalEntryId: null,
    issuedAt: null,
    voidedAt: null,
    createdBy: 'u1',
    createdByName: 'Alice',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    lines: [
      {
        id: 'line-1',
        lineNumber: 1,
        description: 'Consulting hours',
        descriptionTemplate: null,
        quantityMilli: 2500,
        unitPriceCents: 10000,
        revenueAccountId: account4100.id,
        revenueAccountCode: account4100.code,
        revenueAccountName: account4100.name,
        taxRateBp: 0,
        netCents: 25000,
        taxCents: 0,
        itemId: null,
        orderLineId: null,
      },
    ],
    allocatedCents: 0,
    creditedCents: 0,
    amountDueCents: 0,
    settlementStatus: 'NOT_APPLICABLE',
    sourceQuote: null,
    kind: 'STANDARD',
    depositForOrderId: null,
    depositAppliedCents: 0,
    depositApplications: [],
    salesOrderId: null,
    salesOrderNumber: null,
    ...overrides,
  };
}

function quoteDocument(overrides: Partial<QuoteDocumentData> = {}): QuoteDocumentData {
  return {
    direction: 'SALES',
    quoteNumber: 'QU-000001',
    revision: 1,
    partyName: 'Northwind Traders',
    partyAddress: null,
    partyTaxNumber: null,
    partyReference: null,
    quoteDate: '2026-10-01',
    validUntil: '2026-10-31',
    currencyCode: 'USD',
    title: null,
    notes: null,
    terms: null,
    paymentTerms: null,
    lines: [],
    subtotalCents: 100000,
    taxCents: 0,
    totalCents: 100000,
    ...overrides,
  };
}

// ----------------------------------------------------------------- tests

describe('Phase 42 deposits (client)', () => {
  it('an order requests a 30% deposit (body percentBp 3000)', async () => {
    const user = userEvent.setup();
    let depositBody: Record<string, unknown> | null = null;
    mockApi((method, url, init) => {
      if (method === 'POST' && url.includes('/orders/o1/deposit')) {
        depositBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return { status: 201, body: { success: true, document: { kind: 'INVOICE', id: 'inv-9' } } };
      }
      if (method === 'GET' && url.endsWith('/orders/o1')) {
        return { status: 200, body: { success: true, order: order() } };
      }
      return undefined;
    });
    render(
      <MemoryRouter initialEntries={['/sales-orders/o1']}>
        <Routes>
          <Route path="/sales-orders/:orderId" element={<SalesOrderDetailPage />} />
          <Route path="/invoices/:id" element={<p>Invoice page</p>} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: 'Request deposit' }));
    await user.type(screen.getByLabelText('Percentage of the order total'), '30');
    await user.click(screen.getByRole('button', { name: 'Create draft deposit invoice' }));

    expect(await screen.findByText('Invoice page')).toBeInTheDocument();
    expect(depositBody).toMatchObject({ percentBp: 3000, amountCents: null });
  });

  it('an issued invoice applies a deposit (body depositDocumentId, amountCents)', async () => {
    const user = userEvent.setup();
    let applyBody: Record<string, unknown> | null = null;
    const target = baseInvoice({
      id: 'inv-1',
      status: 'ISSUED',
      invoiceNumber: 'INV-000002',
      amountDueCents: 25000,
      totalCents: 25000,
    });
    const deposit = baseInvoice({
      id: 'dep-1',
      status: 'ISSUED',
      invoiceNumber: 'INV-000001',
      kind: 'DEPOSIT',
      depositForOrderId: 'o1',
      totalCents: 9000,
      amountDueCents: 9000,
    });
    mockApi((method, url, init) => {
      if (method === 'POST' && url.endsWith('/invoices/inv-1/apply-deposit')) {
        applyBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return { status: 201, body: { success: true, application: { id: 'app-1' } } };
      }
      if (method === 'GET' && url.endsWith('/invoices/inv-1')) {
        return { status: 200, body: { success: true, invoice: target } };
      }
      if (method === 'GET' && url.includes('/invoices?customerId=cust-1')) {
        return {
          status: 200,
          body: { success: true, count: 2, totalCount: 2, currentPage: 1, totalPages: 1, invoices: [target, deposit] },
        };
      }
      if (url.includes('/settings/invoicing')) return { status: 200, body: { success: true, invoiceSettings } };
      if (url.includes('/payments')) {
        return { status: 200, body: { success: true, count: 0, totalCount: 0, currentPage: 1, totalPages: 1, payments: [] } };
      }
      return undefined;
    });
    render(
      <MemoryRouter initialEntries={['/invoices/inv-1']}>
        <Routes>
          <Route path="/invoices/:invoiceId" element={<InvoiceDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: 'Apply deposit' }));
    await user.type(await screen.findByLabelText('Amount to apply'), '90');
    await user.click(screen.getByRole('button', { name: 'Apply to invoice' }));

    await waitFor(() => expect(applyBody).not.toBeNull());
    expect(applyBody).toMatchObject({ depositDocumentId: 'dep-1', amountCents: 9000 });
  });

  it('the quote form sends depositPercentBp 2500 for "25"', async () => {
    const user = userEvent.setup();
    let quoteBody: Record<string, unknown> | null = null;
    mockApi((method, url, init) => {
      if (method === 'POST' && url.endsWith('/quotes')) {
        quoteBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return { status: 201, body: { success: true, quote: { id: 'q-new' } } };
      }
      if (method === 'GET' && url.includes('/customers')) {
        return { status: 200, body: { success: true, count: 1, customers: [customer1] } };
      }
      if (method === 'GET' && url.includes('/accounts')) {
        return { status: 200, body: { success: true, count: 1, accounts: [account4100] } };
      }
      if (method === 'GET' && url.includes('/items')) {
        return { status: 200, body: { success: true, count: 0, items: [] } };
      }
      if (method === 'GET' && url.includes('/payment-terms')) {
        return { status: 200, body: { success: true, count: 0, paymentTerms: [] } };
      }
      if (method === 'GET' && url.includes('/settings/invoicing')) {
        return { status: 200, body: { success: true, invoiceSettings } };
      }
      return undefined;
    });
    const { container } = render(
      <MemoryRouter initialEntries={['/quotes/new']}>
        <Routes>
          <Route path="/quotes/new" element={<NewQuotePage />} />
          <Route path="/quotes/:id" element={<p>Quote page</p>} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole('option', { name: 'Northwind Traders' });
    const partySelect = container.querySelector('select');
    if (partySelect === null) throw new Error('the quote form has no customer select');
    await user.selectOptions(partySelect, 'cust-1');
    await user.type(screen.getByLabelText('Description for line 1'), 'Design work');
    await user.type(screen.getByLabelText('Unit price for line 1'), '1000');
    await user.type(screen.getByLabelText('Deposit on acceptance (%)'), '25');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(quoteBody).not.toBeNull());
    expect(quoteBody).toMatchObject({ depositPercentBp: 2500 });
  });

  it('QuoteDocument shows the deposit sentence', () => {
    render(
      <QuoteDocument
        quote={quoteDocument({ depositPercentBp: 2500, totalCents: 100000 })}
        merchantName="Acme Ltd"
      />,
    );
    expect(screen.getByText('A deposit of 25% (USD 250.00) is due on acceptance.')).toBeInTheDocument();
  });
});
