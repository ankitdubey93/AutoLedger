import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ExportMenu from '../components/ui/ExportMenu';

/**
 * The export menu. It stubs fetch so the download goes through the real
 * apiDownloadBlob and downloadReport code path, and stubs the object-URL
 * functions jsdom does not implement (same stub as invoiceTemplate.test.tsx).
 */

const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  URL.createObjectURL = vi.fn(() => 'blob:mock-report') as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
});

afterEach(() => {
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  vi.unstubAllGlobals();
});

describe('ExportMenu', () => {
  it('downloads xlsx with the params', async () => {
    fetchMock.mockResolvedValue(
      new Response('x', {
        headers: { 'content-disposition': 'attachment; filename="trial-balance-today.xlsx"' },
      }),
    );

    render(
      <MemoryRouter>
        <ExportMenu path="/reports/trial-balance" params={{ asOf: '2026-09-30' }} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Excel (.xlsx)' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/reports/trial-balance?asOf=2026-09-30&format=xlsx');
  });

  it('shows the error', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: 'boom' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    render(
      <MemoryRouter>
        <ExportMenu path="/reports/trial-balance" params={{ asOf: null }} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'PDF' }));

    expect(await screen.findByText('boom')).toBeInTheDocument();
  });
});
