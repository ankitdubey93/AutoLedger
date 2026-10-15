import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PublicQuotePage from '../Pages/public/PublicQuotePage';
import QuotesPage from '../Pages/sales/QuotesPage';
import SalesQuoteDetailPage from '../Pages/sales/SalesQuoteDetailPage';
import PurchaseQuoteDetailPage from '../Pages/purchases/PurchaseQuoteDetailPage';
import type { PublicQuoteView, Quote, QuoteSummary } from '../services/fetchServices';

/**
 * Phase 41 — quotes: the register, the detail page's status-driven actions
 * and conversion, and the public accept/decline page.
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

const line = {
  lineNumber: 1,
  description: 'Installation',
  quantityMilli: 2000,
  unitPriceCents: 10000,
  taxRateBp: 1500,
  netCents: 20000,
  taxCents: 3000,
};

function publicView(overrides: Partial<PublicQuoteView> = {}): PublicQuoteView {
  return {
    merchant: { name: 'Acme Ltd', addressLines: ['1 High St'], hasLogo: false },
    direction: 'SALES',
    quoteNumber: 'QU-000001',
    revision: 1,
    effectiveStatus: 'SENT',
    canRespond: true,
    requiresEmailCode: false,
    partyName: 'Northwind',
    partyAddress: null,
    partyTaxNumber: null,
    partyReference: null,
    quoteDate: '2026-10-01',
    validUntil: '2026-10-31',
    currencyCode: 'USD',
    title: 'Fit-out',
    notes: null,
    terms: '50% deposit on acceptance.',
    paymentTerms: null,
    lines: [line],
    subtotalCents: 20000,
    taxCents: 3000,
    totalCents: 23000,
    contentSha256: HASH,
    response: null,
    depositPercentBp: null,
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
    terms: '50% deposit on acceptance.',
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
    lines: [{ ...line, id: 'l1', accountId: 'acc-4100', accountCode: '4100', accountName: 'Revenue', itemId: null }],
    revisions: [{ id: 'q1', revision: 1, status: 'ACCEPTED' }],
    links: [],
    response: {
      response: 'ACCEPTED',
      channel: 'PUBLIC_LINK',
      signerName: 'Jane Doe',
      signerEmail: null,
      signerEmailVerified: false,
      termsAccepted: true,
      declineReason: null,
      clientIp: '203.0.113.9',
      userAgent: 'Firefox',
      recordedBy: null,
      recordedByName: null,
      note: null,
      quoteContentSha256: HASH,
      respondedAt: '2026-10-02T00:00:00.000Z',
    },
    convertedDocument: null,
    depositPercentBp: null,
    ...overrides,
  };
}

function renderPublic() {
  return render(
    <MemoryRouter initialEntries={['/quote/tok-abcdefghijklmnopqrstuvwxyz']}>
      <Routes>
        <Route path="/quote/:token" element={<PublicQuotePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PublicQuotePage', () => {
  it('accepts only with a typed name and ticked terms, sending the content fingerprint', async () => {
    const user = userEvent.setup();
    let posted: Record<string, unknown> | null = null;
    mockRoutes({
      'POST /public/quotes/tok-abcdefghijklmnopqrstuvwxyz/accept': (init) => {
        posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return {
          status: 200,
          body: {
            success: true,
            quote: publicView({
              effectiveStatus: 'ACCEPTED',
              canRespond: false,
              response: { response: 'ACCEPTED', signerName: 'Jane Doe', respondedAt: '2026-10-02T10:00:00.000Z' },
            }),
          },
        };
      },
      '/public/quotes/tok-abcdefghijklmnopqrstuvwxyz': { status: 200, body: { success: true, quote: publicView() } },
    });
    renderPublic();

    expect(await screen.findByText('Hi Northwind')).toBeInTheDocument();
    expect(screen.getByTestId('quote-terms')).toHaveTextContent('50% deposit on acceptance.');
    const accept = screen.getByRole('button', { name: /Accept 230\.00 USD/ });
    expect(accept).toBeDisabled();

    await user.type(screen.getByLabelText('Your full name'), 'Jane Doe');
    expect(accept).toBeDisabled();
    await user.click(screen.getByRole('checkbox'));
    expect(accept).toBeEnabled();

    await user.click(accept);
    expect(await screen.findByText('Accepted')).toBeInTheDocument();
    expect(posted).toEqual({ signerName: 'Jane Doe', signerEmail: null, acceptTerms: true, contentSha256: HASH, code: null });
  });

  it('can decline with a reason', async () => {
    const user = userEvent.setup();
    let reason: unknown = undefined;
    mockRoutes({
      'POST /public/quotes/tok-abcdefghijklmnopqrstuvwxyz/decline': (init) => {
        reason = (JSON.parse(String(init?.body)) as { reason: unknown }).reason;
        return {
          status: 200,
          body: {
            success: true,
            quote: publicView({
              effectiveStatus: 'DECLINED',
              canRespond: false,
              response: { response: 'DECLINED', signerName: null, respondedAt: '2026-10-02T10:00:00.000Z' },
            }),
          },
        };
      },
      '/public/quotes/tok-abcdefghijklmnopqrstuvwxyz': { status: 200, body: { success: true, quote: publicView() } },
    });
    renderPublic();

    await user.click(await screen.findByRole('tab', { name: 'Decline' }));
    await user.type(screen.getByLabelText('Reason (optional)'), 'Over budget');
    await user.click(screen.getByRole('button', { name: 'Decline this quote' }));
    expect(await screen.findByText('Declined')).toBeInTheDocument();
    expect(reason).toBe('Over budget');
  });

  it('an expired quote shows the document but no response form', async () => {
    mockRoutes({
      '/public/quotes/tok-abcdefghijklmnopqrstuvwxyz': {
        status: 200,
        body: { success: true, quote: publicView({ effectiveStatus: 'EXPIRED', canRespond: false }) },
      },
    });
    renderPublic();
    expect(await screen.findByText('This quote has expired')).toBeInTheDocument();
    expect(screen.getByTestId('quote-total')).toHaveTextContent('230.00 USD');
    expect(screen.queryByLabelText('Your full name')).not.toBeInTheDocument();
  });

  it('requires an emailed code when the organization asks for one', async () => {
    const user = userEvent.setup();
    let posted: Record<string, unknown> | null = null;
    mockRoutes({
      'POST /public/quotes/tok-abcdefghijklmnopqrstuvwxyz/verify-email': () => ({
        status: 202,
        body: { success: true, expiresAt: '2026-10-10T12:10:00.000Z' },
      }),
      'POST /public/quotes/tok-abcdefghijklmnopqrstuvwxyz/accept': (init) => {
        posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return {
          status: 200,
          body: {
            success: true,
            quote: publicView({
              effectiveStatus: 'ACCEPTED',
              canRespond: false,
              response: { response: 'ACCEPTED', signerName: 'Jane Doe', respondedAt: '2026-10-02T10:00:00.000Z' },
            }),
          },
        };
      },
      '/public/quotes/tok-abcdefghijklmnopqrstuvwxyz': {
        status: 200,
        body: { success: true, quote: publicView({ requiresEmailCode: true }) },
      },
    });
    renderPublic();

    expect(await screen.findByText('Hi Northwind')).toBeInTheDocument();
    const accept = screen.getByRole('button', { name: /Accept 230\.00 USD/ });
    await user.type(screen.getByLabelText('Your full name'), 'Jane Doe');
    await user.click(screen.getByRole('checkbox'));
    expect(accept).toBeDisabled();

    await user.type(screen.getByLabelText('Your email'), 'jane@northwind.test');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText('We emailed a 6-digit code to jane@northwind.test.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Verification code'), '123456');
    expect(accept).toBeEnabled();

    await user.click(accept);
    expect(await screen.findByText('Accepted')).toBeInTheDocument();
    expect(posted).toMatchObject({ code: '123456', signerEmail: 'jane@northwind.test' });
  });

  it('an invalid link says so', async () => {
    mockRoutes({
      '/public/quotes/tok-abcdefghijklmnopqrstuvwxyz': {
        status: 404,
        body: { success: false, error: 'This quote link is not valid or has expired' },
      },
    });
    renderPublic();
    expect(await screen.findByText(/not valid or has expired\. Please contact the sender/)).toBeInTheDocument();
  });
});

describe('QuotesPage', () => {
  it('lists quotes with their effective status', async () => {
    const summary: QuoteSummary = {
      id: 'q1',
      direction: 'SALES',
      quoteNumber: 'QU-000001',
      revision: 2,
      status: 'SENT',
      effectiveStatus: 'EXPIRED',
      partyId: 'cust-1',
      partyName: 'Northwind',
      quoteDate: '2026-09-01',
      validUntil: '2026-09-30',
      currencyCode: 'USD',
      title: 'Fit-out',
      totalCents: 23000,
      createdAt: '2026-09-01T00:00:00.000Z',
    };
    mockRoutes({
      '/quotes': { status: 200, body: { success: true, count: 1, totalCount: 1, currentPage: 1, totalPages: 1, quotes: [summary] } },
    });
    render(
      <MemoryRouter>
        <QuotesPage />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('link', { name: 'QU-000001 rev 2' })).toHaveAttribute('href', '/quotes/q1');
    expect(screen.getByRole('cell', { name: 'Expired' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /New quote/ })).toBeInTheDocument();
  });

  it('hides "New quote" from a member who cannot create quotes', async () => {
    allowed = false;
    mockRoutes({
      '/quotes': { status: 200, body: { success: true, count: 0, totalCount: 0, currentPage: 1, totalPages: 1, quotes: [] } },
    });
    render(
      <MemoryRouter>
        <QuotesPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText('No quotes yet.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /New quote/ })).not.toBeInTheDocument();
  });
});

describe('QuoteDetailPage', () => {
  function renderDetail(element: React.ReactElement, path: string, routePath: string) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={routePath} element={element} />
          <Route path="/invoices/:id" element={<p>Invoice page</p>} />
          <Route path="/expenses/:id" element={<p>Expense page</p>} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('shows the acceptance evidence and converts an accepted quote to a draft invoice', async () => {
    const user = userEvent.setup();
    let convertBody: unknown = null;
    mockRoutes({
      'POST /quotes/q1/convert': (init) => {
        convertBody = JSON.parse(String(init?.body));
        return { status: 201, body: { success: true, document: { kind: 'INVOICE', id: 'inv-9' } } };
      },
      '/quotes/q1': { status: 200, body: { success: true, quote: quote() } },
      '/documents': { status: 200, body: { success: true, count: 0, totalCount: 0, documents: [] } },
    });
    renderDetail(<SalesQuoteDetailPage />, '/quotes/q1', '/quotes/:quoteId');

    expect(await screen.findByText('Acceptance record')).toBeInTheDocument();
    expect(screen.getByText(/Jane Doe/)).toBeInTheDocument();
    expect(screen.getByText('203.0.113.9')).toBeInTheDocument();
    // Accepted: no edit, no revise; convert offered.
    expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revise' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Convert to invoice' }));
    await user.click(screen.getByRole('button', { name: 'Create draft invoice' }));
    expect(await screen.findByText('Invoice page')).toBeInTheDocument();
    expect(convertBody).toMatchObject({ dueDate: null, vendorReference: null });
  });

  it('a purchase quote asks for the vendor invoice number, defaulting to the quote number', async () => {
    const user = userEvent.setup();
    let convertBody: Record<string, unknown> | null = null;
    mockRoutes({
      'POST /purchase-quotes/q1/convert': (init) => {
        convertBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return { status: 201, body: { success: true, document: { kind: 'BILL', id: 'bill-9' } } };
      },
      '/purchase-quotes/q1': {
        status: 200,
        body: { success: true, quote: quote({ direction: 'PURCHASE', quoteNumber: 'PQ-000003' }) },
      },
      '/documents': { status: 200, body: { success: true, count: 0, totalCount: 0, documents: [] } },
    });
    renderDetail(<PurchaseQuoteDetailPage />, '/purchase-quotes/q1', '/purchase-quotes/:quoteId');

    await user.click(await screen.findByRole('button', { name: 'Convert to expense' }));
    expect(screen.getByLabelText('Vendor’s invoice no.')).toHaveValue('PQ-000003');
    await user.click(screen.getByRole('button', { name: 'Create draft expense' }));
    expect(await screen.findByText('Expense page')).toBeInTheDocument();
    expect(convertBody).toMatchObject({ vendorReference: 'PQ-000003' });
  });

  it('a draft offers edit, send and delete — and sending asks how to deliver', async () => {
    const user = userEvent.setup();
    const draft = quote({
      status: 'DRAFT',
      effectiveStatus: 'DRAFT',
      quoteNumber: null,
      contentSha256: null,
      response: null,
      revisions: [{ id: 'q1', revision: 1, status: 'DRAFT' }],
    });
    let sendBody: unknown = null;
    mockRoutes({
      'POST /quotes/q1/send': (init) => {
        sendBody = JSON.parse(String(init?.body));
        return { status: 200, body: { success: true, quote: quote({ status: 'SENT', effectiveStatus: 'SENT', response: null }) } };
      },
      '/quotes/q1': { status: 200, body: { success: true, quote: draft } },
      '/documents': { status: 200, body: { success: true, count: 0, totalCount: 0, documents: [] } },
    });
    renderDetail(<SalesQuoteDetailPage />, '/quotes/q1', '/quotes/:quoteId');

    expect(await screen.findByRole('link', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByLabelText('Email to')).toHaveValue('buyer@northwind.test');
    await user.click(screen.getByRole('button', { name: 'Send email' }));
    await waitFor(() =>
      expect(sendBody).toEqual({ delivery: 'EMAIL', toEmail: 'buyer@northwind.test', message: null, templateId: null }),
    );
  });
});
