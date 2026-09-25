import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import InboxSettingsPage from '../Pages/settings/InboxSettingsPage';

/**
 * Capture's settings page — auto-post gates (Phase 19). Google Drive folder
 * intake moved to Settings → Connections (/settings/connections); this page
 * now only links there (see connectionsDrive.test.tsx for that page's own
 * coverage).
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const SETTINGS_BODY = {
  success: true,
  settings: { autoPostEnabled: false, autoPostMinConfidence: 0.9, autoPostMaxTotalCents: null, updatedAt: null },
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockRoutes() {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (method === 'GET' && url.includes('/api/v1/capture/settings')) {
      return Promise.resolve(jsonResponse(200, SETTINGS_BODY));
    }
    if (method === 'PUT' && url.includes('/api/v1/capture/settings')) {
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

function renderPage(entry = '/settings/inbox') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/settings/inbox" element={<InboxSettingsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('InboxSettingsPage', () => {
  it('links to Settings → Connections for Google Drive intake', async () => {
    mockRoutes();
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Manage Drive folders')).toBeInTheDocument();
    });
    expect(screen.getByText('Manage Drive folders').closest('a')).toHaveAttribute('href', '/settings/connections');
  });

  it('saving auto-post settings sends integer cents for the limit', async () => {
    mockRoutes();
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
        return (c[1] as RequestInit | undefined)?.method === 'PUT' && url.includes('/api/v1/capture/settings');
      });
      expect(putCall).toBeDefined();
      const body = JSON.parse((putCall?.[1] as RequestInit).body as string) as { autoPostMaxTotalCents: number };
      expect(body.autoPostMaxTotalCents).toBe(150000);
    });
  });
});
