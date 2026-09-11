import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ApFlowDocumentsPage from '../Pages/ap-flow/ApFlowDocumentsPage';
import ApFlowDocumentDetailPage from '../Pages/ap-flow/ApFlowDocumentDetailPage';
import type { ApFlowDocument, ApFlowDocumentDetail } from '../services/fetchServices';

/** AP-Flow's client pages (Phase 10) — deliberately thin, no review queue. */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function doc(overrides: Partial<ApFlowDocument> = {}): ApFlowDocument {
  return {
    id: 'ap-doc-1',
    documentId: 'vault-doc-1',
    originalFilename: 'receipt.pdf',
    mimeType: 'application/pdf',
    sha256: 'a'.repeat(64),
    status: 'PENDING',
    pageCount: null,
    failureReason: null,
    processedAt: null,
    createdBy: 'user-1',
    createdByName: 'Alice',
    createdAt: new Date('2026-06-01').toISOString(),
    journalEntryId: null,
    postedSha256: null,
    postedAt: null,
    ...overrides,
  };
}

function detail(overrides: Partial<ApFlowDocumentDetail> = {}): ApFlowDocumentDetail {
  return {
    ...doc(),
    pages: [],
    extraction: null,
    lineItems: [],
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

function mockListRoutes(documents: ApFlowDocument[]) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (method === 'GET' && url.includes('/api/v1/ap-flow/documents')) {
      return Promise.resolve(
        jsonResponse(200, {
          success: true,
          count: documents.length,
          totalCount: documents.length,
          currentPage: 1,
          totalPages: 1,
          documents,
        }),
      );
    }
    if (method === 'GET' && url.includes('/api/v1/documents')) {
      return Promise.resolve(
        jsonResponse(200, { success: true, count: 0, totalCount: 0, currentPage: 1, totalPages: 1, documents: [] }),
      );
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderList() {
  return render(
    <MemoryRouter initialEntries={['/app/ap-flow']}>
      <Routes>
        <Route path="/app/:appSlug" element={<ApFlowDocumentsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ApFlowDocumentsPage', () => {
  it('renders one row per document with its status', async () => {
    mockListRoutes([doc({ originalFilename: 'invoice-a.pdf', status: 'EXTRACTED' })]);
    renderList();

    await screen.findByText('invoice-a.pdf');
    expect(screen.getByText('Extracted')).toBeInTheDocument();
  });

  it('shows an empty state when nothing has been captured', async () => {
    mockListRoutes([]);
    renderList();

    await screen.findByText(/No documents have been captured yet/);
  });

  it('re-fetches with the status filter in the URL', async () => {
    mockListRoutes([doc()]);
    const user = userEvent.setup();
    renderList();

    await screen.findByText('receipt.pdf');

    const select = screen.getByLabelText('Status');
    await user.selectOptions(select, 'FAILED');

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => {
        const [input] = c as [RequestInfo | URL];
        const url = typeof input === 'string' ? input : input.toString();
        return url.includes('/ap-flow/documents') && url.includes('status=FAILED');
      });
      expect(call).toBeDefined();
    });
  });
});

function mockDetailRoutes(document: ApFlowDocumentDetail, options: { reextractStatus?: number } = {}) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (method === 'POST' && url.endsWith('/reextract')) {
      const status = options.reextractStatus ?? 200;
      return Promise.resolve(
        jsonResponse(status, { success: true, document: { ...document, status: 'PENDING' } }),
      );
    }
    if (method === 'GET' && /\/ap-flow\/documents\/[^/]+$/.test(url)) {
      return Promise.resolve(jsonResponse(200, { success: true, document }));
    }
    if (method === 'GET' && url.includes('/pages/')) {
      return Promise.resolve(new Response(new Blob(['fake-png']), { status: 200 }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderDetail(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/app/ap-flow/${id}`]}>
      <Routes>
        <Route path="/app/:appSlug/:id" element={<ApFlowDocumentDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ApFlowDocumentDetailPage', () => {
  it('renders vendor, total and line items from the extraction', async () => {
    mockDetailRoutes(
      detail({
        status: 'EXTRACTED',
        extraction: {
          id: 'ext-1',
          vendorName: 'AWS Cloud Services',
          invoiceNumber: 'INV-1',
          invoiceDate: '2026-08-15',
          currency: 'USD',
          subtotalCents: 45000,
          taxCents: 0,
          totalCents: 45000,
          lineItems: [
            { description: 'EC2 Compute Instances', amountCents: 35000 },
            { description: 'S3 Storage Usage', amountCents: 10000 },
          ],
          fieldConfidence: { total: 0.95 },
          arithmeticOk: true,
          validationErrors: [],
          model: 'claude-sonnet-5',
          createdAt: new Date('2026-08-15').toISOString(),
        },
        // Phase 11's materialized line items — what the page's review table
        // actually renders from, not the extraction's own JSONB copy.
        lineItems: [
          {
            id: 'line-1',
            lineIndex: 0,
            description: 'EC2 Compute Instances',
            amountCents: 35000,
            accountId: null,
            accountCode: null,
            accountName: null,
            suggestedAccountId: null,
            mappingSource: 'NONE',
            mappingConfidence: null,
          },
          {
            id: 'line-2',
            lineIndex: 1,
            description: 'S3 Storage Usage',
            amountCents: 10000,
            accountId: null,
            accountCode: null,
            accountName: null,
            suggestedAccountId: null,
            mappingSource: 'NONE',
            mappingConfidence: null,
          },
        ],
      }),
    );
    renderDetail('ap-doc-1');

    await screen.findByText('AWS Cloud Services');
    // Subtotal and total are both "450.00" for this fixture (zero tax).
    expect(screen.getAllByText('450.00')).toHaveLength(2);
    expect(screen.getByText('EC2 Compute Instances')).toBeInTheDocument();
    expect(screen.getByText('S3 Storage Usage')).toBeInTheDocument();
  });

  it('shows the arithmetic warning panel with each validation error', async () => {
    mockDetailRoutes(
      detail({
        status: 'EXTRACTED',
        extraction: {
          id: 'ext-1',
          vendorName: 'Vendor',
          invoiceNumber: null,
          invoiceDate: null,
          currency: null,
          subtotalCents: 35000,
          taxCents: null,
          totalCents: null,
          lineItems: [{ description: 'a', amountCents: 34999 }],
          fieldConfidence: {},
          arithmeticOk: false,
          validationErrors: ['Line items sum to 34999 but the subtotal reads 35000'],
          model: 'claude-sonnet-5',
          createdAt: new Date().toISOString(),
        },
      }),
    );
    renderDetail('ap-doc-1');

    await screen.findByText('Arithmetic does not check out');
    expect(screen.getByText('Line items sum to 34999 but the subtotal reads 35000')).toBeInTheDocument();
  });

  it('shows the failure reason for a FAILED document', async () => {
    mockDetailRoutes(detail({ status: 'FAILED', failureReason: 'Vision extraction is not configured' }));
    renderDetail('ap-doc-1');

    await screen.findByText('Extraction failed');
    expect(screen.getByText('Vision extraction is not configured')).toBeInTheDocument();
  });

  it('hides Re-extract for a PENDING document and shows it for a FAILED one', async () => {
    mockDetailRoutes(detail({ status: 'PENDING' }));
    renderDetail('ap-doc-1');

    await screen.findByText('receipt.pdf');
    expect(screen.queryByRole('button', { name: 'Re-extract' })).not.toBeInTheDocument();
  });

  it('shows Re-extract for a FAILED document', async () => {
    mockDetailRoutes(detail({ status: 'FAILED', failureReason: 'boom' }));
    renderDetail('ap-doc-1');

    await screen.findByRole('button', { name: 'Re-extract' });
  });

  it('opens a confirmation dialog and only POSTs after confirmation', async () => {
    mockDetailRoutes(detail({ status: 'FAILED', failureReason: 'boom' }));
    const user = userEvent.setup();
    renderDetail('ap-doc-1');

    const trigger = await screen.findByRole('button', { name: 'Re-extract' });
    await user.click(trigger);

    const dialog = await screen.findByRole('dialog');

    expect(
      fetchMock.mock.calls.find((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'POST' && url.endsWith('/reextract');
      }),
    ).toBeUndefined();

    await user.click(within(dialog).getByRole('button', { name: 'Re-extract' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'POST' && url.endsWith('/reextract');
      });
      expect(call).toBeDefined();
    });
  });
});
