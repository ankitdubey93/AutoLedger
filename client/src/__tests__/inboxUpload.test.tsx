import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import InboxUploadPanel from '../Pages/inbox/InboxUploadPanel';
import InboxPage from '../Pages/inbox/InboxPage';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { CaptureDocument } from '../services/fetchServices';

/**
 * Phase 19 — direct upload into Capture's own page. Every case here mocks
 * `fetch` directly (this codebase's established client-test convention),
 * never the service module.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function captureDoc(overrides: Partial<CaptureDocument> = {}): CaptureDocument {
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
    billId: null,
    autoPosted: false,
    autoPostBlockers: [],
    duplicateOfId: null,
    duplicateOfFilename: null,
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

function makeFile(name: string): File {
  return new File(['bytes'], name, { type: 'image/png' });
}

describe('InboxUploadPanel', () => {
  it('uploads each selected file in order and reports a duplicate', async () => {
    let call = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/v1/capture/documents/upload')) {
        call += 1;
        if (call === 1) {
          return Promise.resolve(
            jsonResponse(201, { success: true, created: true, document: captureDoc({ id: 'doc-1' }) }),
          );
        }
        return Promise.resolve(
          jsonResponse(200, { success: true, created: false, document: captureDoc({ id: 'doc-1' }) }),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    const onUploaded = vi.fn();
    render(<InboxUploadPanel onUploaded={onUploaded} />);

    const input = screen.getByLabelText('Choose files', { selector: 'input' });
    const user = userEvent.setup();
    await user.upload(input, [makeFile('a.png'), makeFile('b.png')]);

    await waitFor(() => {
      expect(screen.getByText('Captured')).toBeInTheDocument();
      expect(screen.getByText('Already captured')).toBeInTheDocument();
    });
    expect(onUploaded).toHaveBeenCalledTimes(1);
    expect(call).toBe(2);
  });

  it('an upload error is shown against that file', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/v1/capture/documents/upload')) {
        return Promise.resolve(jsonResponse(422, { success: false, error: 'The bill inbox can only process PDF, PNG and JPEG documents' }));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    render(<InboxUploadPanel onUploaded={vi.fn()} />);
    const input = screen.getByLabelText('Choose files', { selector: 'input' });
    const user = userEvent.setup();
    await user.upload(input, [makeFile('a.png')]);

    await waitFor(() => {
      expect(screen.getByText('The bill inbox can only process PDF, PNG and JPEG documents')).toBeInTheDocument();
    });
  });
});

describe('InboxPage status pill', () => {
  it('a POSTED document renders a Posted pill, not Failed', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/v1/capture/documents')) {
        const documents = [captureDoc({ id: 'doc-1', status: 'POSTED', autoPosted: true })];
        return Promise.resolve(
          jsonResponse(200, {
            success: true,
            count: 1,
            totalCount: 1,
            currentPage: 1,
            totalPages: 1,
            documents,
          }),
        );
      }
      if (url.includes('/api/v1/documents')) {
        return Promise.resolve(
          jsonResponse(200, { success: true, count: 0, totalCount: 0, currentPage: 1, totalPages: 1, documents: [] }),
        );
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    });

    render(
      <MemoryRouter initialEntries={['/inbox']}>
        <Routes>
          <Route path="/inbox" element={<InboxPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Posted')).toBeInTheDocument();
    });
    expect(screen.queryByText('Failed')).not.toBeInTheDocument();
    expect(screen.getByText('Auto')).toBeInTheDocument();
  });
});
