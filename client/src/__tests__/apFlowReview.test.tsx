import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ApFlowReviewQueuePage from '../Pages/ap-flow/ApFlowReviewQueuePage';
import ApFlowDocumentDetailPage from '../Pages/ap-flow/ApFlowDocumentDetailPage';
import type {
  Account,
  ApFlowDocumentDetail,
  ApFlowReviewQueueEntry,
} from '../services/fetchServices';

/**
 * AP-Flow's Phase 11 review queue and side-by-side review: the queue's
 * ordering signals, per-line account override, and the gated post button.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function reviewEntry(overrides: Partial<ApFlowReviewQueueEntry> = {}): ApFlowReviewQueueEntry {
  return {
    id: 'ap-doc-1',
    documentId: 'ap-doc-1',
    originalFilename: 'receipt.pdf',
    vendorName: 'Acme Vendor',
    invoiceNumber: 'INV-1',
    invoiceDate: '2026-08-15',
    currency: 'USD',
    totalCents: 45000,
    arithmeticOk: true,
    lineItemCount: 1,
    unmappedLineCount: 0,
    lowestConfidence: 0.9,
    createdAt: new Date('2026-08-15').toISOString(),
    ...overrides,
  };
}

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'account-1',
    code: '6130',
    name: 'Office Supplies',
    type: 'Expense',
    parentId: null,
    isPostable: true,
    isActive: true,
    description: null,
    createdAt: new Date('2026-01-01').toISOString(),
    updatedAt: new Date('2026-01-01').toISOString(),
    ...overrides,
  };
}

function detail(overrides: Partial<ApFlowDocumentDetail> = {}): ApFlowDocumentDetail {
  return {
    id: 'ap-doc-1',
    documentId: 'vault-doc-1',
    originalFilename: 'receipt.pdf',
    mimeType: 'application/pdf',
    sha256: 'a'.repeat(64),
    status: 'EXTRACTED',
    pageCount: 1,
    failureReason: null,
    processedAt: new Date('2026-08-15').toISOString(),
    createdBy: 'user-1',
    createdByName: 'Alice',
    createdAt: new Date('2026-08-15').toISOString(),
    journalEntryId: null,
    postedSha256: null,
    postedAt: null,
    pages: [],
    extraction: {
      id: 'ext-1',
      vendorName: 'Acme Vendor',
      invoiceNumber: 'INV-1',
      invoiceDate: '2026-08-15',
      currency: 'USD',
      subtotalCents: 45000,
      taxCents: 0,
      totalCents: 45000,
      lineItems: [{ description: 'Office Supplies', amountCents: 45000 }],
      fieldConfidence: {},
      arithmeticOk: true,
      validationErrors: [],
      model: 'claude-sonnet-5',
      createdAt: new Date('2026-08-15').toISOString(),
    },
    lineItems: [
      {
        id: 'line-1',
        lineIndex: 0,
        description: 'Office Supplies',
        amountCents: 45000,
        accountId: 'account-1',
        accountCode: '6130',
        accountName: 'Office Supplies',
        suggestedAccountId: 'account-1',
        mappingSource: 'HISTORY',
        mappingConfidence: 0.65,
      },
    ],
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

function mockReviewQueueRoutes(entries: ApFlowReviewQueueEntry[]) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/ap-flow/review-queue')) {
      return Promise.resolve(
        jsonResponse(200, {
          success: true,
          count: entries.length,
          totalCount: entries.length,
          currentPage: 1,
          totalPages: 1,
          entries,
        }),
      );
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderQueue() {
  return render(
    <MemoryRouter initialEntries={['/app/ap-flow/review']}>
      <Routes>
        <Route path="/app/:appSlug/review" element={<ApFlowReviewQueuePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ApFlowReviewQueuePage', () => {
  it('renders one row per entry', async () => {
    mockReviewQueueRoutes([
      reviewEntry({ id: 'doc-1', vendorName: 'Vendor One' }),
      reviewEntry({ id: 'doc-2', vendorName: 'Vendor Two' }),
    ]);
    renderQueue();

    await screen.findByText('Vendor One');
    expect(screen.getByText('Vendor Two')).toBeInTheDocument();
  });

  it('flags an arithmetic failure', async () => {
    mockReviewQueueRoutes([
      reviewEntry({ id: 'doc-1', vendorName: 'Good Vendor', arithmeticOk: true }),
      reviewEntry({ id: 'doc-2', vendorName: 'Bad Vendor', arithmeticOk: false }),
    ]);
    renderQueue();

    await screen.findByText('Bad Vendor');
    const badRow = screen.getByText('Bad Vendor').closest('tr');
    const goodRow = screen.getByText('Good Vendor').closest('tr');
    expect(badRow).not.toBeNull();
    expect(within(badRow as HTMLElement).getByText("Totals don't reconcile")).toBeInTheDocument();
    expect(goodRow).not.toBeNull();
    expect(within(goodRow as HTMLElement).queryByText("Totals don't reconcile")).not.toBeInTheDocument();
  });

  it('says so when the queue is empty', async () => {
    mockReviewQueueRoutes([]);
    renderQueue();

    await screen.findByText('Nothing is waiting for review.');
  });
});

function mockDetailRoutes(
  document: ApFlowDocumentDetail,
  options: { accounts?: Account[]; postStatus?: number; patchStatus?: number } = {},
) {
  const accounts = options.accounts ?? [account()];
  let currentDocument = document;

  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (method === 'POST' && url.endsWith('/post')) {
      const status = options.postStatus ?? 200;
      currentDocument = { ...currentDocument, status: 'POSTED', journalEntryId: 'entry-1' };
      return Promise.resolve(jsonResponse(status, { success: true, document: currentDocument }));
    }
    if (method === 'PATCH' && url.includes('/line-items/')) {
      const status = options.patchStatus ?? 200;
      const body: unknown = init?.body === undefined ? {} : JSON.parse(init.body as string);
      const accountId = typeof body === 'object' && body !== null && 'accountId' in body ? (body as { accountId: string }).accountId : '';
      currentDocument = {
        ...currentDocument,
        lineItems: currentDocument.lineItems.map((item) => ({
          ...item,
          accountId,
          mappingSource: 'MANUAL',
          mappingConfidence: null,
        })),
      };
      return Promise.resolve(jsonResponse(status, { success: true, document: currentDocument }));
    }
    if (method === 'GET' && url.includes('/ledger-core/accounts')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: accounts.length, accounts }));
    }
    if (method === 'GET' && /\/ap-flow\/documents\/[^/]+$/.test(url)) {
      return Promise.resolve(jsonResponse(200, { success: true, document: currentDocument }));
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

describe('ApFlowDocumentDetailPage — Phase 11 review', () => {
  it('renders the redaction caption', async () => {
    mockDetailRoutes(detail({ pages: [{ id: 'page-1', pageNumber: 1, widthPx: 100, heightPx: 100, redactedSha256: 'a'.repeat(64), redactedRegions: [] }] }));
    renderDetail('ap-doc-1');

    await screen.findByText('Redacted preview — this is the image sent to the model');
  });

  it("calling the account select fires updateApFlowLineItem", async () => {
    mockDetailRoutes(detail());
    const user = userEvent.setup();
    renderDetail('ap-doc-1');

    const select = await screen.findByLabelText('Account for Office Supplies');
    await user.selectOptions(select, 'account-1');

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'PATCH' && url.includes('/line-items/');
      });
      expect(call).toBeDefined();
    });
  });

  it('disables the post button when a line is unmapped', async () => {
    mockDetailRoutes(
      detail({
        lineItems: [
          {
            id: 'line-1',
            lineIndex: 0,
            description: 'Office Supplies',
            amountCents: 45000,
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

    const postButton = await screen.findByRole('button', { name: 'Post to ledger' });
    expect(postButton).toBeDisabled();
    expect(
      screen.getByText('Every line item needs an account before this can be posted.'),
    ).toBeInTheDocument();
  });

  it('asks for confirmation before posting', async () => {
    mockDetailRoutes(detail());
    const user = userEvent.setup();
    renderDetail('ap-doc-1');

    const postButton = await screen.findByRole('button', { name: 'Post to ledger' });
    expect(postButton).not.toBeDisabled();
    await user.click(postButton);

    const dialog = await screen.findByRole('dialog');

    expect(
      fetchMock.mock.calls.find((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'POST' && url.endsWith('/post');
      }),
    ).toBeUndefined();

    await user.click(within(dialog).getByRole('button', { name: 'Post' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'POST' && url.endsWith('/post');
      });
      expect(call).toBeDefined();
    });
  });

  it('shows the hash and hides Post and Re-extract for a POSTED document', async () => {
    mockDetailRoutes(
      detail({
        status: 'POSTED',
        journalEntryId: 'entry-1',
        postedSha256: 'b'.repeat(64),
        postedAt: new Date('2026-08-16').toISOString(),
      }),
    );
    renderDetail('ap-doc-1');

    await screen.findByText('b'.repeat(64));
    expect(screen.queryByRole('button', { name: 'Post to ledger' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Re-extract' })).not.toBeInTheDocument();
  });
});
