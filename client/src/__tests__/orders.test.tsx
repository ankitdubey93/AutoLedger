import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SalesOrdersPage from '../Pages/sales/SalesOrdersPage';
import SalesOrderDetailPage from '../Pages/sales/SalesOrderDetailPage';
import SalesQuoteDetailPage from '../Pages/sales/SalesQuoteDetailPage';
import type { Order, OrderSummary, Quote } from '../services/fetchServices';

/**
 * Phase 42 — orders: the register's billing column, the confirmed order's
 * per-line billing quantities, and the quote convert dialog's order target.
 */

let allowed = true;
vi.mock('../context/AuthContext', () => ({ useCan: () => () => allowed }));
vi.mock('../context/OrgContext', () => ({
  useOrg: () => ({ organization: { id: 'o1', name: 'Acme Ltd', slug: 'acme', baseCurrency: 'USD' } }),
  useOrganizationName: () => 'Acme Ltd',
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let fetchMock: ReturnType<typeof vi.fn>;

type Handler = { status: number; body: unknown } | ((init?: RequestInit) => { status: number; body: unknown });

function mockRoutes(routes: Record<string, Handler>) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    for (const [fragment, response] of Object.entries(routes)) {
      const [m, f] = fragment.includes(' ') ? fragment.split(' ') : ['GET', fragment];
      if (method === m && f !== undefined && url.includes(f)) {
        const r = typeof response === 'function' ? response(init) : response;
        return Promise.resolve(jsonResponse(r.status, r.body));
      }
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${method} ${url}` }));
  });
}

beforeEach(() => {
  allowed = true;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const HASH = 'c'.repeat(64);

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

function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    id: 'q1',
    direction: 'SALES',
    quoteNumber: 'QU-000001',
    revision: 1,
    status: 'ACCEPTED',
    effectiveStatus: 'ACCEPTED',
    partyId: 'cust-1',
    partyName: 'Northwind',
    quoteDate: '2026-10-01',
    validUntil: '2026-10-31',
    currencyCode: 'USD',
    title: 'Fit-out',
    totalCents: 23000,
    createdAt: '2026-10-01T00:00:00.000Z',
    rootQuoteId: 'q1',
    supersedesQuoteId: null,
    partyNameSnapshot: 'Northwind',
    partyAddressSnapshot: null,
    partyTaxNumberSnapshot: null,
    partyEmailSnapshot: 'buyer@northwind.test',
    partyReference: null,
    notes: null,
    terms: null,
    paymentTerms: null,
    paymentTermsCode: null,
    subtotalCents: 20000,
    taxCents: 3000,
    indicativeFxRate: null,
    indicativeBaseTotalCents: null,
    contentSha256: HASH,
    sentAt: '2026-10-01T00:00:00.000Z',
    sentBy: 'u1',
    acceptedAt: '2026-10-02T00:00:00.000Z',
    declinedAt: null,
    expiredAt: null,
    voidedAt: null,
    voidReason: null,
    supersededAt: null,
    convertedAt: null,
    createdBy: 'u1',
    createdByName: 'Alice',
    updatedAt: '2026-10-02T00:00:00.000Z',
    lines: [
      {
        id: 'l1',
        lineNumber: 1,
        description: 'Installation',
        quantityMilli: 2000,
        unitPriceCents: 10000,
        accountId: 'acc-4100',
        accountCode: '4100',
        accountName: 'Revenue',
        taxRateBp: 1500,
        netCents: 20000,
        taxCents: 3000,
        itemId: null,
      },
    ],
    revisions: [{ id: 'q1', revision: 1, status: 'ACCEPTED' }],
    links: [],
    response: null,
    convertedDocument: null,
    depositPercentBp: null,
    ...overrides,
  };
}

describe('SalesOrdersPage', () => {
  it('lists orders with billing status', async () => {
    const summary: OrderSummary = {
      id: 'o1',
      direction: 'SALES',
      orderNumber: 'SO-000001',
      status: 'CONFIRMED',
      billingStatus: 'PARTIALLY_BILLED',
      partyId: 'cust-1',
      partyName: 'Northwind',
      orderDate: '2026-10-01',
      expectedDate: null,
      currencyCode: 'USD',
      totalCents: 50000,
      createdAt: '2026-10-01T00:00:00.000Z',
    };
    mockRoutes({
      '/orders': { status: 200, body: { success: true, count: 1, totalCount: 1, currentPage: 1, totalPages: 1, orders: [summary] } },
    });
    render(
      <MemoryRouter>
        <SalesOrdersPage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('link', { name: 'SO-000001' })).toHaveAttribute('href', '/sales-orders/o1');
    expect(screen.getByRole('cell', { name: 'Partly billed' })).toBeInTheDocument();
  });
});

describe('SalesOrderDetailPage', () => {
  function renderOrder() {
    return render(
      <MemoryRouter initialEntries={['/sales-orders/o1']}>
        <Routes>
          <Route path="/sales-orders/:orderId" element={<SalesOrderDetailPage />} />
          <Route path="/invoices/:id" element={<p>Invoice page</p>} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('a confirmed order offers Create invoice and sends per-line quantities', async () => {
    const user = userEvent.setup();
    let convertBody: Record<string, unknown> | null = null;
    mockRoutes({
      'POST /orders/o1/convert': (init) => {
        convertBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return { status: 201, body: { success: true, document: { kind: 'INVOICE', id: 'inv-9' } } };
      },
      '/orders/o1': { status: 200, body: { success: true, order: order() } },
    });
    renderOrder();

    await user.click(await screen.findByRole('button', { name: 'Create invoice' }));
    const quantity = screen.getByLabelText('Quantity to bill for line 1');
    expect(quantity).toHaveValue('5');
    await user.clear(quantity);
    await user.type(quantity, '2');
    await user.click(screen.getByRole('button', { name: 'Create draft invoice' }));

    expect(await screen.findByText('Invoice page')).toBeInTheDocument();
    expect(convertBody).toMatchObject({ lines: [{ orderLineId: 'ol1', quantityMilli: 2000 }] });
  });

  it('a line set to 0 is excluded', async () => {
    const user = userEvent.setup();
    let convertBody: Record<string, unknown> | null = null;
    const twoLines = order({
      lines: [
        orderLine(),
        orderLine({
          id: 'ol2',
          lineNumber: 2,
          description: 'Cabling',
          quantityMilli: 3000,
          remainingQuantityMilli: 3000,
        }),
      ],
    });
    mockRoutes({
      'POST /orders/o1/convert': (init) => {
        convertBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return { status: 201, body: { success: true, document: { kind: 'INVOICE', id: 'inv-9' } } };
      },
      '/orders/o1': { status: 200, body: { success: true, order: twoLines } },
    });
    renderOrder();

    await user.click(await screen.findByRole('button', { name: 'Create invoice' }));
    const second = screen.getByLabelText('Quantity to bill for line 2');
    await user.clear(second);
    await user.type(second, '0');
    await user.click(screen.getByRole('button', { name: 'Create draft invoice' }));

    expect(await screen.findByText('Invoice page')).toBeInTheDocument();
    expect(convertBody).toMatchObject({ lines: [{ orderLineId: 'ol1', quantityMilli: 5000 }] });
  });
});

describe('QuoteDetailPage order target', () => {
  it('the quote convert dialog sends target ORDER', async () => {
    const user = userEvent.setup();
    let convertBody: Record<string, unknown> | null = null;
    mockRoutes({
      'POST /quotes/q1/convert': (init) => {
        convertBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return { status: 201, body: { success: true, document: { kind: 'ORDER', id: 'ord-9' } } };
      },
      '/quotes/q1': { status: 200, body: { success: true, quote: quote() } },
      '/documents': { status: 200, body: { success: true, count: 0, totalCount: 0, documents: [] } },
    });
    render(
      <MemoryRouter initialEntries={['/quotes/q1']}>
        <Routes>
          <Route path="/quotes/:quoteId" element={<SalesQuoteDetailPage />} />
          <Route path="/sales-orders/:orderId" element={<p>Sales order page</p>} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: 'Convert to invoice' }));
    await user.click(screen.getByLabelText('Create a sales order'));
    await user.click(screen.getByRole('button', { name: 'Create sales order' }));

    expect(await screen.findByText('Sales order page')).toBeInTheDocument();
    await waitFor(() => expect(convertBody).toMatchObject({ target: 'ORDER' }));
  });
});
