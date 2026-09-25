import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ConnectionsPage from '../Pages/settings/ConnectionsPage';
import type { DriveConnection, DriveFolder, DriveModes } from '../services/fetchServices';

/** ConnectionsPage — the platform Drive integration (Phase 19.3). */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function connection(overrides: Partial<DriveConnection> = {}): DriveConnection {
  return {
    id: 'conn-1',
    status: 'CONNECTED',
    authMode: 'SERVICE_ACCOUNT',
    googleAccountEmail: 'sa@my-project.iam.gserviceaccount.com',
    connectedBy: 'user-1',
    createdAt: new Date('2026-01-01').toISOString(),
    updatedAt: new Date('2026-01-01').toISOString(),
    ...overrides,
  };
}

function folder(overrides: Partial<DriveFolder> = {}): DriveFolder {
  return {
    id: 'folder-row-1',
    purpose: 'VENDOR_BILL',
    folderId: 'folder1234567',
    folderName: 'Invoices',
    isActive: true,
    ledgerAccountId: null,
    ledgerAccountCode: null,
    dateFormat: null,
    columnMap: null,
    lastSyncedAt: null,
    lastSyncError: null,
    importedFileCount: 0,
    skippedFileCount: 0,
    createdBy: 'user-1',
    createdAt: new Date('2026-01-01').toISOString(),
    updatedAt: new Date('2026-01-01').toISOString(),
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

/**
 * `@testing-library/user-event` v14 installs its own clipboard stub on
 * `navigator` the moment `userEvent.setup()` runs — defining a mock any
 * earlier gets silently overwritten. Call this AFTER `userEvent.setup()`.
 */
function mockClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  });
  return writeText;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockIntegration(options: {
  connection: DriveConnection | null;
  folders?: DriveFolder[];
  modes: DriveModes;
  createResponse?: { status: number; body: unknown };
  deleteResponse?: { status: number };
}) {
  const folders = options.folders ?? [];
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (method === 'GET' && url.includes('/api/v1/integrations/drive') && !url.includes('/folders')) {
      return Promise.resolve(
        jsonResponse(200, { success: true, connection: options.connection, folders, modes: options.modes }),
      );
    }
    if (method === 'POST' && url.includes('/api/v1/integrations/drive/folders') && !url.includes('/sync')) {
      const res = options.createResponse ?? { status: 201, body: { success: true, folder: folder() } };
      return Promise.resolve(jsonResponse(res.status, res.body));
    }
    if (method === 'GET' && url.includes('/api/v1/ledger-core/accounts')) {
      return Promise.resolve(
        jsonResponse(200, {
          success: true,
          count: 1,
          accounts: [
            { id: 'acct-1', code: '1110', name: 'Cash', type: 'Asset', parentId: null, isPostable: true, isActive: true, description: null, createdAt: '', updatedAt: '' },
          ],
        }),
      );
    }
    if (method === 'DELETE' && url.includes('/api/v1/integrations/drive/folders/')) {
      return Promise.resolve(new Response(null, { status: (options.deleteResponse ?? { status: 204 }).status }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: 'not mocked' }));
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/settings/connections']}>
      <Routes>
        <Route path="/settings/connections" element={<ConnectionsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ConnectionsPage', () => {
  it('renders the service-account address and copies it on click', async () => {
    mockIntegration({ connection: null, modes: { oauth: false, serviceAccount: true, serviceAccountEmail: 'sa@my-project.iam.gserviceaccount.com' } });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('sa@my-project.iam.gserviceaccount.com')).toBeInTheDocument();
    });

    const user = userEvent.setup();
    const clipboardWriteText = mockClipboard();
    await user.click(screen.getByText('Copy'));

    await waitFor(() => {
      expect(clipboardWriteText).toHaveBeenCalledWith('sa@my-project.iam.gserviceaccount.com');
    });
  });

  it('hides the OAuth button when only the service account is configured', async () => {
    mockIntegration({
      connection: connection(),
      modes: { oauth: false, serviceAccount: true, serviceAccountEmail: 'sa@my-project.iam.gserviceaccount.com' },
    });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Connected as sa@my-project.iam.gserviceaccount.com')).toBeInTheDocument();
    });
    expect(screen.queryByText(/Connect with your Google account/)).not.toBeInTheDocument();
  });

  it('does not submit a BANK_STATEMENT folder with no account chosen', async () => {
    mockIntegration({ connection: connection(), modes: { oauth: false, serviceAccount: true, serviceAccountEmail: 'sa@x.iam.gserviceaccount.com' } });
    renderPage();

    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByText('No folders yet.')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Bank statements (banking)'));
    await user.type(screen.getByPlaceholderText('Paste a Google Drive folder link'), 'folder1234567');
    await user.click(screen.getByText('Add folder'));

    expect(screen.getByText(/Choose the bank account/)).toBeInTheDocument();
    const createCalls = fetchMock.mock.calls.filter((c) => {
      const url = typeof c[0] === 'string' ? c[0] : (c[0] as URL | Request).toString();
      return (c[1] as RequestInit | undefined)?.method === 'POST' && url.includes('/folders') && !url.includes('/sync');
    });
    expect(createCalls).toHaveLength(0);
  });

  it("renders a folder's last sync error verbatim", async () => {
    mockIntegration({
      connection: connection(),
      folders: [folder({ lastSyncError: 'Import failed: 2 row(s) could not be parsed (row 3: unparseable date "x")' })],
      modes: { oauth: false, serviceAccount: true, serviceAccountEmail: 'sa@x.iam.gserviceaccount.com' },
    });
    renderPage();

    await waitFor(() => {
      expect(
        screen.getByText('Import failed: 2 row(s) could not be parsed (row 3: unparseable date "x")'),
      ).toBeInTheDocument();
    });
  });

  it('deleting a folder waits for confirmation', async () => {
    mockIntegration({
      connection: connection(),
      folders: [folder()],
      modes: { oauth: false, serviceAccount: true, serviceAccountEmail: 'sa@x.iam.gserviceaccount.com' },
    });
    renderPage();

    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByText('Remove')).toBeInTheDocument();
    });
    await user.click(screen.getByText('Remove'));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    const deleteCallsBefore = fetchMock.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === 'DELETE',
    );
    expect(deleteCallsBefore).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      const deleteCallsAfter = fetchMock.mock.calls.filter(
        (c) => (c[1] as RequestInit | undefined)?.method === 'DELETE',
      );
      expect(deleteCallsAfter).toHaveLength(1);
    });
  });

  it('shows no reconnect banner for a service-account connection', async () => {
    mockIntegration({
      connection: connection({ authMode: 'SERVICE_ACCOUNT', status: 'CONNECTED' }),
      modes: { oauth: false, serviceAccount: true, serviceAccountEmail: 'sa@x.iam.gserviceaccount.com' },
    });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('No folders yet.')).toBeInTheDocument();
    });
    expect(screen.queryByText('Reconnect')).not.toBeInTheDocument();
  });
});
