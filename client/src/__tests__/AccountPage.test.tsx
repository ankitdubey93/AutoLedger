import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AccountPage from '../Pages/AccountPage';
import { AuthProvider } from '../context/AuthContext';
import { OrgProvider } from '../context/OrgContext';
import type { Role } from '../services/fetchServices';

/**
 * Account settings (Phase 38a): user-level tabs only — Profile, Password,
 * Sessions, Organizations, Status. The old Organisation and Members tabs
 * moved to Organization settings and their URLs redirect there.
 */

const USER_CREATED = '2026-03-04T10:00:00.000Z';
const ORG_CREATED = '2026-02-01T10:00:00.000Z';
const JOINED = '2026-05-06T10:00:00.000Z';

function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function session(role: Role) {
  return {
    success: true,
    user: { id: 'u1', name: 'Ada', email: 'ada@example.com', emailVerified: false, createdAt: USER_CREATED },
    organization: { id: 'o1', name: 'Acme', slug: 'acme', baseCurrency: 'USD', createdAt: ORG_CREATED },
    role,
    memberships: [{ orgId: 'o1', orgName: 'Acme', orgSlug: 'acme', role, joinedAt: JOINED }],
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
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

type Handler = (url: string, method: string, body: unknown) => Response | undefined;

function mockRoutes(role: Role, extra: Handler = () => undefined) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;

    const handled = extra(url, method, body);
    if (handled !== undefined) return Promise.resolve(handled);
    if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, session(role)));
    return Promise.resolve(jsonResponse(404, { success: false, error: `unmocked ${method} ${url}` }));
  });
}

function bodiesFor(fragment: string, method: string): unknown[] {
  return fetchMock.mock.calls
    .filter(([input, init]) => String(input).includes(fragment) && ((init as RequestInit | undefined)?.method ?? 'GET') === method)
    .map(([, init]) => {
      const b = (init as RequestInit | undefined)?.body;
      return typeof b === 'string' ? JSON.parse(b) : null;
    });
}

function renderAccount(initialEntries: string[] = ['/account']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <AuthProvider>
        <OrgProvider>
          <Routes>
            <Route path="/account" element={<AccountPage />} />
            <Route path="/settings/members" element={<p>Members settings page</p>} />
            <Route path="/settings/profile" element={<p>Organization profile page</p>} />
          </Routes>
        </OrgProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('AccountPage', () => {
  it('opens on Profile, with the six user-level tabs', async () => {
    mockRoutes('OWNER');
    renderAccount();

    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Profile', 'Password', 'Sessions', 'Notifications', 'Organizations', 'Status']);
    expect(screen.getByRole('tab', { name: 'Profile' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Account created')).toBeInTheDocument();
    expect(screen.getByText(day(USER_CREATED))).toBeInTheDocument();
    // Nothing organization-level lives here any more.
    expect(screen.queryByRole('tab', { name: 'Members' })).not.toBeInTheDocument();
  });

  it('lists your organizations with the date you joined each', async () => {
    mockRoutes('OWNER');
    renderAccount(['/account?tab=organizations']);

    expect(await screen.findByRole('heading', { name: 'Your organizations' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: /Acme/ })).toBeInTheDocument();
    expect(screen.getByText(new Date(JOINED).toLocaleDateString())).toBeInTheDocument();
  });

  it('redirects the old Members and Organisation tabs to Organization settings', async () => {
    mockRoutes('OWNER');
    renderAccount(['/account?tab=members']);
    expect(await screen.findByText('Members settings page')).toBeInTheDocument();
  });

  it('saves your name', async () => {
    mockRoutes('OWNER', (url, method) =>
      url.includes('/auth/me') && method === 'PATCH'
        ? jsonResponse(200, { success: true, user: session('OWNER').user })
        : undefined,
    );
    const user = userEvent.setup();
    renderAccount();

    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Ada Lovelace');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(bodiesFor('/auth/me', 'PATCH')).toEqual([{ name: 'Ada Lovelace' }]);
  });

  it('changes the password and reports how many other sessions were signed out', async () => {
    mockRoutes('OWNER', (url, method) =>
      url.includes('/auth/change-password') && method === 'POST'
        ? jsonResponse(200, { success: true, signedOutSessions: 2 })
        : undefined,
    );
    const user = userEvent.setup();
    renderAccount(['/account?tab=password']);

    await user.type(await screen.findByLabelText('Current password'), 'old-password-1');
    await user.type(screen.getByLabelText('New password'), 'new-password-1');
    await user.type(screen.getByLabelText('Confirm new password'), 'new-password-2');
    expect(screen.getByText('The two new passwords do not match.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change password' })).toBeDisabled();

    await user.clear(screen.getByLabelText('Confirm new password'));
    await user.type(screen.getByLabelText('Confirm new password'), 'new-password-1');
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Signed out of 2 other sessions.');
    expect(bodiesFor('/auth/change-password', 'POST')).toEqual([
      { currentPassword: 'old-password-1', newPassword: 'new-password-1' },
    ]);
  });

  it('lists sessions and signs one other browser out', async () => {
    const sessions = [
      {
        id: 's1',
        startedAt: USER_CREATED,
        lastActiveAt: USER_CREATED,
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36',
        ip: '127.0.0.1',
        organizationName: 'Acme',
        current: true,
      },
      {
        id: 's2',
        startedAt: USER_CREATED,
        lastActiveAt: USER_CREATED,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Version/17.0 Safari/604.1',
        ip: '10.0.0.2',
        organizationName: 'Acme',
        current: false,
      },
    ];
    mockRoutes('OWNER', (url, method) => {
      if (url.includes('/auth/sessions/s2') && method === 'DELETE') return jsonResponse(200, { success: true });
      if (url.includes('/auth/sessions')) return jsonResponse(200, { success: true, count: 2, sessions });
      return undefined;
    });
    const user = userEvent.setup();
    renderAccount(['/account?tab=sessions']);

    expect(await screen.findByText('Chrome on Linux')).toBeInTheDocument();
    expect(screen.getByText('This device')).toBeInTheDocument();
    expect(screen.getByText('Safari on iOS')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(bodiesFor('/auth/sessions/s2', 'DELETE')).toHaveLength(1);
  });

  it('Profile: an unverified email offers to resend the verification email', async () => {
    mockRoutes('OWNER', (url, method) =>
      url.includes('/auth/verify-email/resend') && method === 'POST' ? jsonResponse(202, { success: true }) : undefined,
    );
    const user = userEvent.setup();
    renderAccount();

    await user.click(await screen.findByRole('button', { name: 'Send verification email' }));
    expect(await screen.findByText(/Verification email sent/)).toBeInTheDocument();
  });

  it('Profile: changing the email sends a link and says the address has not changed yet', async () => {
    mockRoutes('OWNER', (url, method) =>
      url.includes('/auth/me/email') && method === 'POST' ? jsonResponse(202, { success: true }) : undefined,
    );
    const user = userEvent.setup();
    renderAccount();

    await user.click(await screen.findByRole('button', { name: 'Change email' }));
    await user.type(screen.getByLabelText('New email'), 'ada@new.example');
    await user.type(screen.getByLabelText('Current password'), 'my-password');
    await user.click(screen.getByRole('button', { name: 'Send confirmation link' }));

    expect(await screen.findByRole('status')).toHaveTextContent('We sent a confirmation link to ada@new.example');
    expect(bodiesFor('/auth/me/email', 'POST')).toEqual([{ newEmail: 'ada@new.example', currentPassword: 'my-password' }]);
  });

  it('Notifications: toggling a switch saves just that event', async () => {
    let prefs = [
      { event: 'bill_awaiting_approval', enabled: true },
      { event: 'invitation_accepted', enabled: true },
    ];
    mockRoutes('OWNER', (url, method, body) => {
      if (!url.includes('/auth/me/notifications')) return undefined;
      if (method === 'PUT') {
        const [change] = (body as { preferences: Array<{ event: string; enabled: boolean }> }).preferences;
        prefs = prefs.map((p) => (p.event === change?.event ? { ...p, enabled: change.enabled } : p));
      }
      return jsonResponse(200, { success: true, preferences: prefs });
    });
    const user = userEvent.setup();
    renderAccount(['/account?tab=notifications']);

    const box = await screen.findByRole('checkbox', { name: /Bills awaiting approval/ });
    expect(box).toBeChecked();
    await user.click(box);
    expect(await screen.findByRole('checkbox', { name: /Bills awaiting approval/ })).not.toBeChecked();
    expect(bodiesFor('/auth/me/notifications', 'PUT')).toEqual([
      { preferences: [{ event: 'bill_awaiting_approval', enabled: false }] },
    ]);
  });
});
