import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import QuoteEmailTemplatesPage from '../Pages/settings/QuoteEmailTemplatesPage';
import SalesQuoteDetailPage from '../Pages/sales/SalesQuoteDetailPage';
import type { Quote, QuoteEmailTemplate } from '../services/fetchServices';

/**
 * Phase 42, Slice C — quote email templates: the settings page preview and the
 * send dialog's template picker.
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

const BUILT_IN_SALES: QuoteEmailTemplate = {
  id: null,
  direction: 'SALES',
  name: 'Standard quote',
  subject: 'Quote [Quote Number] from [Organisation Name]',
  body: 'Hi [Contact Name],\n\nPlease find our quote [Quote Number] for [Quote Total], valid until [Valid Until].\n\nYou can review and accept it online using the button below.\n\nThank you,\n[Organisation Name]',
  isDefault: true,
  builtIn: true,
  updatedAt: null,
};

describe('QuoteEmailTemplatesPage', () => {
  it('previews the built-in sales template with sample values', async () => {
    mockRoutes({
      '/settings/quote-email-templates?direction=SALES': { status: 200, body: { success: true, templates: [BUILT_IN_SALES] } },
    });
    render(
      <MemoryRouter>
        <QuoteEmailTemplatesPage />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId('preview-subject')).toHaveTextContent('Quote QU-000012 from Acme Ltd');
    expect(screen.getByTestId('preview-body')).toHaveTextContent(
      'Please find our quote QU-000012 for USD 1,250.00, valid until 9 Nov 2026.',
    );
  });
});

describe('SalesQuoteDetailPage send dialog', () => {
  function renderDetail(element: React.ReactElement, path: string, routePath: string) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path={routePath} element={element} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('the send dialog sends the chosen templateId', async () => {
    const user = userEvent.setup();
    const draft = quote({
      status: 'DRAFT',
      effectiveStatus: 'DRAFT',
      quoteNumber: null,
      contentSha256: null,
      response: null,
      revisions: [{ id: 'q1', revision: 1, status: 'DRAFT' }],
    });
    const stored: QuoteEmailTemplate = {
      id: 'tpl-2',
      direction: 'SALES',
      name: 'Friendly quote',
      subject: 'Your quote [Quote Number]',
      body: 'Hi [Contact Name], here is [Quote Number].',
      isDefault: false,
      builtIn: false,
      updatedAt: '2026-10-05T00:00:00.000Z',
    };
    let sendBody: Record<string, unknown> | null = null;
    mockRoutes({
      'POST /quotes/q1/send': (init) => {
        sendBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return { status: 200, body: { success: true, quote: quote({ status: 'SENT', effectiveStatus: 'SENT', response: null }) } };
      },
      '/settings/quote-email-templates?direction=SALES': { status: 200, body: { success: true, templates: [BUILT_IN_SALES, stored] } },
      '/quotes/q1': { status: 200, body: { success: true, quote: draft } },
      '/documents': { status: 200, body: { success: true, count: 0, totalCount: 0, documents: [] } },
    });
    renderDetail(<SalesQuoteDetailPage />, '/quotes/q1', '/quotes/:quoteId');

    await user.click(await screen.findByRole('button', { name: 'Send' }));
    const picker = await screen.findByLabelText('Email template');
    await user.selectOptions(picker, 'tpl-2');
    expect(picker).toHaveValue('tpl-2');

    await user.click(screen.getByRole('button', { name: 'Send email' }));
    await waitFor(() => expect(sendBody).toMatchObject({ delivery: 'EMAIL', templateId: 'tpl-2' }));
  });
});
