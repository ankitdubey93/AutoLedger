import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { OrgProvider } from '../context/OrgContext';
import EmailLinkPage from '../Pages/auth/EmailLinkPage';
import EmailSettingsPage from '../Pages/settings/EmailSettingsPage';

/**
 * Phase 38b — the emailed-link pages (verify, confirm change) and
 * Organization settings → Email.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function route(handler: (url: string, method: string, body: unknown) => Response | undefined) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    return Promise.resolve(
      handler(url, method, body) ??
        (url.includes('/auth/check') || url.includes('/auth/refresh')
          ? jsonResponse(401, { success: false, error: 'No session' })
          : jsonResponse(404, { success: false, error: `unmocked ${method} ${url}` })),
    );
  });
}

function renderAt(path: string, element: React.ReactNode, routePath: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <OrgProvider>
          <Routes>
            <Route path={routePath} element={element} />
          </Routes>
        </OrgProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('EmailLinkPage', () => {
  it('verifies only when the button is pressed (a page load spends nothing)', async () => {
    route((url, method) => (url.includes('/auth/verify-email') && method === 'POST' ? jsonResponse(200, { success: true }) : undefined));
    const user = userEvent.setup();
    renderAt('/verify-email?token=tok', <EmailLinkPage kind="verify" />, '/verify-email');

    const button = await screen.findByRole('button', { name: 'Verify my email' });
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/auth/verify-email'))).toBe(false);

    await user.click(button);
    expect(await screen.findByText('Your email is verified.')).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/auth/verify-email'));
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ token: 'tok' });
  });

  it("shows the server's reason when a change link cannot be used", async () => {
    route((url) =>
      url.includes('/auth/confirm-email-change')
        ? jsonResponse(409, { success: false, error: 'That email address now belongs to another account' })
        : undefined,
    );
    const user = userEvent.setup();
    renderAt('/confirm-email-change?token=tok', <EmailLinkPage kind="change" />, '/confirm-email-change');

    await user.click(await screen.findByRole('button', { name: 'Confirm new email' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('now belongs to another account');
  });

  it('says so when the link has no token', async () => {
    route(() => undefined);
    renderAt('/verify-email', <EmailLinkPage kind="verify" />, '/verify-email');
    expect(await screen.findByText(/missing its token/)).toBeInTheDocument();
  });
});

describe('EmailSettingsPage', () => {
  it('loads, saves, and sends an emptied field as null', async () => {
    route((url, method, body) => {
      if (!url.includes('/organizations/email-settings')) return undefined;
      const base = { senderName: 'Alpha Books', replyTo: 'books@alpha.test', fromEmail: 'no-reply@autoledger.local', transport: 'mailpit' };
      return jsonResponse(200, { success: true, settings: method === 'PATCH' ? { ...base, ...(body as object) } : base });
    });
    const user = userEvent.setup();
    renderAt('/settings/email', <EmailSettingsPage />, '/settings/email');

    const sender = await screen.findByLabelText('Sender name');
    expect(sender).toHaveValue('Alpha Books');
    expect(screen.getByText(/local Mailpit inbox/)).toBeInTheDocument();

    await user.clear(sender);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    const patch = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
    expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toEqual({ senderName: null, replyTo: 'books@alpha.test' });
  });

  it('explains instead of failing for a role that cannot manage it', async () => {
    route((url) => (url.includes('/organizations/email-settings') ? jsonResponse(403, { success: false, error: 'Forbidden' }) : undefined));
    renderAt('/settings/email', <EmailSettingsPage />, '/settings/email');
    expect(await screen.findByText('Email settings are managed by owners and admins.')).toBeInTheDocument();
  });
});
