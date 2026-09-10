import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AttachmentsPanel from '../components/AttachmentsPanel';
import type { VaultDocument, VaultDocumentWithLinks } from '../services/fetchServices';

/** AttachmentsPanel — the reusable per-record attachments list (Phase 9.5). */

const APP_SLUG = 'ledger-core';
const ENTITY_TYPE = 'invoice';
const ENTITY_ID = 'invoice-1';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function doc(overrides: Partial<VaultDocument> = {}): VaultDocument {
  return {
    id: 'doc-1',
    sha256: 'a'.repeat(64),
    byteSize: 2048,
    mimeType: 'application/pdf',
    originalFilename: 'invoice.pdf',
    uploadedBy: 'user-1',
    uploadedByName: 'Alice',
    createdAt: new Date('2026-06-01').toISOString(),
    linkCount: 1,
    ...overrides,
  };
}

function docWithLinks(overrides: Partial<VaultDocument> = {}, linkId = 'link-1'): VaultDocumentWithLinks {
  const document = doc(overrides);
  return {
    ...document,
    links: [
      {
        id: linkId,
        documentId: document.id,
        appSlug: APP_SLUG,
        entityType: ENTITY_TYPE,
        entityId: ENTITY_ID,
        createdBy: 'user-1',
        createdAt: document.createdAt,
      },
    ],
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

function mockRoutes(options: {
  documents: VaultDocument[];
  detailById?: Record<string, VaultDocumentWithLinks>;
  attachResponse?: { status: number; body: unknown };
}) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (method === 'GET' && /\/api\/v1\/documents\?/.test(url)) {
      return Promise.resolve(
        jsonResponse(200, {
          success: true,
          count: options.documents.length,
          totalCount: options.documents.length,
          currentPage: 1,
          totalPages: 1,
          documents: options.documents,
        }),
      );
    }
    if (method === 'GET' && /\/api\/v1\/documents\/[^/]+$/.test(url)) {
      const id = url.split('/').pop() as string;
      const detail = options.detailById?.[id];
      if (detail === undefined) {
        return Promise.resolve(jsonResponse(404, { success: false, error: 'Document not found' }));
      }
      return Promise.resolve(jsonResponse(200, { success: true, document: detail }));
    }
    if (method === 'POST' && url.endsWith('/api/v1/documents')) {
      return Promise.resolve(
        jsonResponse(201, { success: true, created: true, document: doc({ linkCount: 0 }) }),
      );
    }
    if (method === 'POST' && /\/links$/.test(url)) {
      const response = options.attachResponse ?? {
        status: 201,
        body: {
          success: true,
          link: {
            id: 'link-1',
            documentId: 'doc-1',
            appSlug: APP_SLUG,
            entityType: ENTITY_TYPE,
            entityId: ENTITY_ID,
            createdBy: 'user-1',
            createdAt: new Date().toISOString(),
          },
        },
      };
      return Promise.resolve(jsonResponse(response.status, response.body));
    }
    if (method === 'DELETE' && /\/links\/[^/]+$/.test(url)) {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function makePdfFile(): File {
  return new File(['%PDF-1.7'], 'invoice.pdf', { type: 'application/pdf' });
}

function renderPanel(readOnly = false) {
  return render(
    <AttachmentsPanel appSlug={APP_SLUG} entityType={ENTITY_TYPE} entityId={ENTITY_ID} readOnly={readOnly} />,
  );
}

describe('AttachmentsPanel', () => {
  it('lists only the attachments for its entity', async () => {
    const record = doc();
    mockRoutes({ documents: [record], detailById: { [record.id]: docWithLinks() } });
    renderPanel();

    await screen.findByText('invoice.pdf');

    const listCall = fetchMock.mock.calls.find((c) => {
      const [input] = c as [RequestInfo | URL];
      const url = typeof input === 'string' ? input : input.toString();
      return url.includes('/api/v1/documents?');
    });
    expect(listCall).toBeDefined();
    const [input] = listCall as [RequestInfo | URL];
    const url = typeof input === 'string' ? input : input.toString();
    expect(url).toContain(`entityId=${ENTITY_ID}`);
  });

  it('uploads then links in that order', async () => {
    mockRoutes({ documents: [] });
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('No attachments yet.');

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, makePdfFile());

    await waitFor(() => {
      const uploadIndex = fetchMock.mock.calls.findIndex((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'POST' && url.endsWith('/api/v1/documents');
      });
      const linkIndex = fetchMock.mock.calls.findIndex((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'POST' && url.includes('/links');
      });
      expect(uploadIndex).toBeGreaterThanOrEqual(0);
      expect(linkIndex).toBeGreaterThan(uploadIndex);
    });
  });

  it('renders "Already attached to this record" on a 409', async () => {
    mockRoutes({
      documents: [],
      attachResponse: {
        status: 409,
        body: { success: false, error: 'This document is already attached to that record' },
      },
    });
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('No attachments yet.');

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, makePdfFile());

    await screen.findByText('Already attached to this record');
  });

  it('detaches after confirmation', async () => {
    const record = doc();
    mockRoutes({ documents: [record], detailById: { [record.id]: docWithLinks({}, 'link-abc') } });
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('invoice.pdf');

    await user.click(screen.getByRole('button', { name: 'Detach' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Detach' }));

    await waitFor(() => {
      const detachCall = fetchMock.mock.calls.find((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'DELETE' && url.includes('/links/link-abc');
      });
      expect(detachCall).toBeDefined();
    });
  });

  it('renders no controls in readOnly mode', async () => {
    const record = doc();
    mockRoutes({ documents: [record], detailById: { [record.id]: docWithLinks() } });
    renderPanel(true);

    await screen.findByText('invoice.pdf');
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Detach' })).not.toBeInTheDocument();
  });
});
