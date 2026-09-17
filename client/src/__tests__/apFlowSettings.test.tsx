import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ApFlowSettingsPage from '../Pages/ap-flow/ApFlowSettingsPage';

/** AP-Flow's settings page — auto-post gates (Phase 19) plus Google Drive (Phase 19.2). */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const SETTINGS_BODY = {
  success: true,
  settings: { autoPostEnabled: false, autoPostMinConfidence: 0.9, autoPostMaxTotalCents: null, updatedAt: null },
};

let fetchMock: ReturnType<typeof vi.fn>;
let assignSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  assignSpy = vi.fn();
  Object.defineProperty(window, 'location', {
    value: { ...window.location, assign: assignSpy },
    writable: true,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockRoutes(driveBody: unknown, driveStatus = 200) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (method === 'GET' && url.includes('/api/v1/ap-flow/settings')) {
      return Promise.resolve(jsonResponse(200, SETTINGS_BODY));
    }
    if (method === 'GET' && url.includes('/api/v1/ap-flow/drive')) {
      return Promise.resolve(jsonResponse(driveStatus, driveBody));
    }
    if (method === 'POST' && url.includes('/api/v1/ap-flow/drive/connect')) {
      return Promise.resolve(jsonResponse(200, { success: true, authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' }));
    }
    if (method === 'PUT' && url.includes('/api/v1/ap-flow/settings')) {
      return Promise.resolve(
        jsonResponse(200, {
          success: true,
          settings: { ...SETTINGS_BODY.settings, ...JSON.parse(init?.body as string) },
        }),
      );
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: 'not mocked' }));
  });
}

function renderPage(entry = '/app/ap-flow/settings') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/app/ap-flow/settings" element={<ApFlowSettingsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ApFlowSettingsPage', () => {
  it('shows the not-configured message when configured is false', async () => {
    mockRoutes({ success: true, connection: null, configured: false });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/Google Drive intake is not configured on this server/)).toBeInTheDocument();
    });
  });

  it('saving auto-post settings sends integer cents for the limit', async () => {
    mockRoutes({ success: true, connection: null, configured: false });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Save')).toBeInTheDocument();
    });

    const user = userEvent.setup();
    const limitInput = screen.getByPlaceholderText('e.g. 1500.00');
    await user.clear(limitInput);
    await user.type(limitInput, '1500.00');
    await user.click(screen.getByText('Save'));

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find((c) => {
        const url = typeof c[0] === 'string' ? c[0] : (c[0] as URL | Request).toString();
        return (c[1] as RequestInit | undefined)?.method === 'PUT' && url.includes('/ap-flow/settings');
      });
      expect(putCall).toBeDefined();
      const body = JSON.parse((putCall?.[1] as RequestInit).body as string) as { autoPostMaxTotalCents: number };
      expect(body.autoPostMaxTotalCents).toBe(150000);
    });
  });

  it('Connect navigates to the authorization URL', async () => {
    mockRoutes({ success: true, connection: null, configured: true });
    renderPage();

    const user = userEvent.setup();
    await waitFor(() => {
      expect(screen.getByText('Connect Google Drive')).toBeInTheDocument();
    });
    await user.click(screen.getByText('Connect Google Drive'));

    await waitFor(() => {
      expect(assignSpy).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?x=1');
    });
  });

  it('drive=connected shows the choose-a-folder banner', async () => {
    mockRoutes({
      success: true,
      configured: true,
      connection: {
        id: 'conn-1',
        status: 'CONNECTED',
        googleAccountEmail: 'owner@example.com',
        folderId: null,
        folderName: null,
        lastSyncedAt: null,
        lastSyncError: null,
        importedFileCount: 0,
        skippedFileCount: 0,
        connectedBy: 'user-1',
        createdAt: new Date('2026-01-01').toISOString(),
        updatedAt: new Date('2026-01-01').toISOString(),
      },
    });
    renderPage('/app/ap-flow/settings?drive=connected');

    await waitFor(() => {
      expect(screen.getByText('Google Drive connected — now choose a folder.')).toBeInTheDocument();
    });
  });
});
