import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DocumentsPage from '../Pages/DocumentsPage';
import type { VaultDocument } from '../services/fetchServices';

/** DocumentsPage — the suite-level Document Vault (Phase 9.5). */

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
    linkCount: 0,
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

function mockRoutes(options: {
  documents: VaultDocument[];
  uploadResponse?: { status: number; body: unknown };
  deleteResponse?: { status: number; body?: unknown };
}) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (method === 'GET' && url.includes('/api/v1/documents')) {
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
    if (method === 'POST' && url.endsWith('/api/v1/documents')) {
      const response = options.uploadResponse ?? {
        status: 201,
        body: { success: true, created: true, document: doc() },
      };
      return Promise.resolve(jsonResponse(response.status, response.body));
    }
    if (method === 'DELETE' && /\/api\/v1\/documents\/[^/]+$/.test(url)) {
      const response = options.deleteResponse ?? { status: 204, body: undefined };
      return Promise.resolve(new Response(null, { status: response.status }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function makePdfFile(): File {
  return new File(['%PDF-1.7'], 'invoice.pdf', { type: 'application/pdf' });
}

describe('DocumentsPage', () => {
  it('renders the vault table from the API', async () => {
    mockRoutes({ documents: [doc({ originalFilename: 'receipt.pdf', byteSize: 1536 })] });
    render(<DocumentsPage />);

    await screen.findByText('receipt.pdf');
    expect(screen.getByText('1.5 KB')).toBeInTheDocument();
  });

  it('shows an empty state when the vault is empty', async () => {
    mockRoutes({ documents: [] });
    render(<DocumentsPage />);

    await screen.findByText('No documents yet.');
  });

  it('uploads a file and refetches the list', async () => {
    mockRoutes({ documents: [] });
    const user = userEvent.setup();
    render(<DocumentsPage />);
    await screen.findByText('No documents yet.');

    const listCallsBefore = fetchMock.mock.calls.filter((c) => {
      const [input, init] = c as [RequestInfo | URL, RequestInit?];
      const url = typeof input === 'string' ? input : input.toString();
      return (init?.method ?? 'GET') === 'GET' && url.includes('/api/v1/documents');
    }).length;

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, makePdfFile());

    await waitFor(() => {
      const uploadCall = fetchMock.mock.calls.find((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'POST' && url.endsWith('/api/v1/documents');
      });
      expect(uploadCall).toBeDefined();
      const [, init] = uploadCall as [RequestInfo | URL, RequestInit];
      expect(init.body).toBeInstanceOf(FormData);
    });

    await waitFor(() => {
      const listCallsAfter = fetchMock.mock.calls.filter((c) => {
        const [input, init] = c as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return (init?.method ?? 'GET') === 'GET' && url.includes('/api/v1/documents');
      }).length;
      expect(listCallsAfter).toBeGreaterThan(listCallsBefore);
    });
  });

  it('surfaces a 415 message verbatim', async () => {
    mockRoutes({
      documents: [],
      uploadResponse: {
        status: 415,
        body: { success: false, error: 'Unsupported file type. Allowed: PDF, PNG, JPEG, CSV' },
      },
    });
    const user = userEvent.setup();
    render(<DocumentsPage />);
    await screen.findByText('No documents yet.');

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, makePdfFile());

    await screen.findByText('Unsupported file type. Allowed: PDF, PNG, JPEG, CSV');
  });

  it('hides Delete for a document with attachments', async () => {
    mockRoutes({
      documents: [
        doc({ id: 'doc-linked', originalFilename: 'linked.pdf', linkCount: 1 }),
        doc({ id: 'doc-unlinked', originalFilename: 'unlinked.pdf', linkCount: 0 }),
      ],
    });
    render(<DocumentsPage />);

    await screen.findByText('linked.pdf');
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
    expect(deleteButtons).toHaveLength(1);

    const linkedRow = screen.getByText('linked.pdf').closest('tr') as HTMLElement;
    expect(within(linkedRow).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('deletes an unattached document after confirmation', async () => {
    mockRoutes({ documents: [doc({ id: 'doc-unlinked', originalFilename: 'unlinked.pdf', linkCount: 0 })] });
    const user = userEvent.setup();
    render(<DocumentsPage />);
    await screen.findByText('unlinked.pdf');

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    const dialog = screen.getByRole('dialog');
    const deleteCallBefore = fetchMock.mock.calls.find((c) => {
      const [, init] = c as [RequestInfo | URL, RequestInit?];
      return init?.method === 'DELETE';
    });
    expect(deleteCallBefore).toBeUndefined();

    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      const deleteCall = fetchMock.mock.calls.find((c) => {
        const [, init] = c as [RequestInfo | URL, RequestInit?];
        return init?.method === 'DELETE';
      });
      expect(deleteCall).toBeDefined();
    });
  });
});
