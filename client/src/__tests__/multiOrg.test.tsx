import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { OrgProvider } from '../context/OrgContext';
import OrgSwitcher from '../components/layout/OrgSwitcher';
import NewOrganizationPage from '../Pages/organizations/NewOrganizationPage';
import InvitePage from '../Pages/auth/InvitePage';
import RegisterPage from '../Pages/auth/RegisterPage';
import MembersPanel from '../Pages/MembersPanel';
import type { Role } from '../services/fetchServices';
import { permissionsFor } from './helpers/permissions';

/**
 * Phase 37 — several organizations per user: the top-bar organization menu,
 * adding an organization, accepting an invitation, registering from one, and
 * the invite form on Account → Members.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const ALPHA = { orgId: 'o1', orgName: 'Alpha Ltd', orgSlug: 'alpha', role: 'OWNER' as Role, roleName: 'OWNER', joinedAt: '2026-01-01T00:00:00.000Z' };
const BETA = { orgId: 'o2', orgName: 'Beta Ltd', orgSlug: 'beta', role: 'ACCOUNTANT' as Role, roleName: 'ACCOUNTANT', joinedAt: '2026-02-01T00:00:00.000Z' };

function session(active: typeof ALPHA, memberships = [ALPHA], email = 'ada@example.com') {
  return {
    success: true,
    user: { id: 'u1', name: 'Ada', email, emailVerified: false, createdAt: '2026-01-01T00:00:00.000Z' },
    organization: {
      id: active.orgId,
      name: active.orgName,
      slug: active.orgSlug,
      baseCurrency: 'USD',
      taxNumber: null,
      businessNumber: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    role: active.role,
    permissions: permissionsFor(active.role),
    memberships,
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  };
}

const PREVIEW = {
  organizationName: 'Beta Ltd',
  invitedByName: 'Bea',
  email: 'ada@example.com',
  role: 'ACCOUNTANT',
  permissions: permissionsFor('ACCOUNTANT'),
  status: 'PENDING',
  expiresAt: '2026-12-01T00:00:00.000Z',
};

type Handler = (url: string, method: string, body: unknown) => Response | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

function mockRoutes(handler: Handler) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    const res = handler(url, method, body);
    return Promise.resolve(res ?? jsonResponse(404, { success: false, error: `unmocked ${method} ${url}` }));
  });
}

function calls(fragment: string, method = 'POST'): unknown[] {
  return fetchMock.mock.calls
    .filter(([input, init]) => String(input).includes(fragment) && ((init as RequestInit | undefined)?.method ?? 'GET') === method)
    .map(([, init]) => {
      const b = (init as RequestInit | undefined)?.body;
      return typeof b === 'string' ? JSON.parse(b) : null;
    });
}

function renderAt(path: string, element: React.ReactNode, routePath = path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <OrgProvider>
          <Routes>
            <Route path={routePath} element={element} />
            <Route path="/" element={<p>Dashboard home</p>} />
            <Route path="/organizations/new" element={<p>New organization form</p>} />
          </Routes>
        </OrgProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OrgSwitcher', () => {
  it('shows even with one organization, offering Add organization', async () => {
    mockRoutes((url) => (url.includes('/auth/check') ? jsonResponse(200, session(ALPHA)) : undefined));
    const user = userEvent.setup();
    renderAt('/x', <OrgSwitcher />);

    await user.click(await screen.findByRole('button', { name: /Organization: Alpha Ltd/ }));
    expect(screen.getByRole('menuitem', { name: /Alpha Ltd · OWNER/ })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Add organization' }));
    expect(await screen.findByText('New organization form')).toBeInTheDocument();
  });

  it('switches organization and lands on the dashboard', async () => {
    mockRoutes((url) => {
      if (url.includes('/auth/check')) return jsonResponse(200, session(ALPHA, [ALPHA, BETA]));
      if (url.includes('/auth/switch-org')) return jsonResponse(200, session(BETA, [ALPHA, BETA]));
      return undefined;
    });
    const user = userEvent.setup();
    renderAt('/invoices/abc', <OrgSwitcher />);

    await user.click(await screen.findByRole('button', { name: /Organization: Alpha Ltd/ }));
    await user.click(screen.getByRole('menuitem', { name: /Beta Ltd · ACCOUNTANT/ }));

    expect(await screen.findByText('Dashboard home')).toBeInTheDocument();
    expect(calls('/auth/switch-org')).toEqual([{ orgId: 'o2' }]);
  });
});

describe('NewOrganizationPage', () => {
  it('creates the organization and moves to the dashboard (where the setup gate takes over)', async () => {
    const beta = { ...BETA, role: 'OWNER' as Role };
    mockRoutes((url) => {
      if (url.includes('/auth/check')) return jsonResponse(200, session(ALPHA));
      if (url.includes('/auth/organizations')) return jsonResponse(201, session(beta, [ALPHA, beta]));
      return undefined;
    });
    const user = userEvent.setup();
    renderAt('/organizations/new', <NewOrganizationPage />);

    await user.type(await screen.findByLabelText('Organization name'), 'Beta Ltd');
    await user.click(screen.getByRole('button', { name: 'Create and set up' }));

    expect(await screen.findByText('Dashboard home')).toBeInTheDocument();
    expect(calls('/auth/organizations')).toEqual([{ name: 'Beta Ltd' }]);
  });

  it('shows the server error', async () => {
    mockRoutes((url) => {
      if (url.includes('/auth/check')) return jsonResponse(200, session(ALPHA));
      if (url.includes('/auth/organizations')) {
        return jsonResponse(422, { success: false, error: 'You can own at most 25 organizations' });
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderAt('/organizations/new', <NewOrganizationPage />);
    await user.type(await screen.findByLabelText('Organization name'), 'Too many');
    await user.click(screen.getByRole('button', { name: 'Create and set up' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('at most 25');
  });
});

describe('InvitePage', () => {
  it('signed out: offers sign in and create account in invite mode', async () => {
    mockRoutes((url) => {
      if (url.includes('/auth/check')) return jsonResponse(401, { success: false, error: 'No session' });
      if (url.includes('/auth/refresh')) return jsonResponse(401, { success: false, error: 'No refresh token' });
      if (url.includes('/auth/invitations/tok')) return jsonResponse(200, { success: true, invitation: PREVIEW });
      return undefined;
    });
    renderAt('/invite/tok', <InvitePage />, '/invite/:token');

    expect(await screen.findByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    expect(screen.getByRole('link', { name: /Create an account/ })).toHaveAttribute('href', '/register?invite=tok');
  });

  it('signed in with the invited email: accepts and lands in the organization', async () => {
    mockRoutes((url, method) => {
      if (url.includes('/auth/check')) return jsonResponse(200, session(ALPHA));
      if (url.includes('/auth/invitations/tok/accept') && method === 'POST') {
        return jsonResponse(200, session(BETA, [ALPHA, BETA]));
      }
      if (url.includes('/auth/invitations/tok')) return jsonResponse(200, { success: true, invitation: PREVIEW });
      return undefined;
    });
    const user = userEvent.setup();
    renderAt('/invite/tok', <InvitePage />, '/invite/:token');

    await user.click(await screen.findByRole('button', { name: 'Join Beta Ltd' }));
    expect(await screen.findByText('Dashboard home')).toBeInTheDocument();
  });

  it('signed in with another email: says so instead of offering to accept', async () => {
    mockRoutes((url) => {
      if (url.includes('/auth/check')) return jsonResponse(200, session(ALPHA, [ALPHA], 'other@example.com'));
      if (url.includes('/auth/invitations/tok')) return jsonResponse(200, { success: true, invitation: PREVIEW });
      return undefined;
    });
    renderAt('/invite/tok', <InvitePage />, '/invite/:token');

    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Join/ })).not.toBeInTheDocument();
  });
});

describe('RegisterPage in invite mode', () => {
  it('hides the organization name, locks the email and sends the invite token', async () => {
    mockRoutes((url) => {
      if (url.includes('/auth/check')) return jsonResponse(401, { success: false, error: 'No session' });
      if (url.includes('/auth/refresh')) return jsonResponse(401, { success: false, error: 'No refresh token' });
      if (url.includes('/auth/invitations/tok')) return jsonResponse(200, { success: true, invitation: PREVIEW });
      if (url.includes('/auth/register')) return jsonResponse(201, { success: true, user: {} });
      if (url.includes('/auth/login')) return jsonResponse(200, session(BETA, [BETA]));
      return undefined;
    });
    const user = userEvent.setup();
    renderAt('/register?invite=tok', <RegisterPage />, '/register');

    const email = await screen.findByLabelText('Email');
    await waitFor(() => expect(email).toHaveValue('ada@example.com'));
    expect(email).toHaveAttribute('readonly');
    expect(screen.queryByLabelText('Organization name')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Password'), 'a-perfectly-fine-password');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() =>
      expect(calls('/auth/register')).toEqual([
        { name: '', email: 'ada@example.com', password: 'a-perfectly-fine-password', inviteToken: 'tok' },
      ]),
    );
  });
});

describe('MembersPanel', () => {
  it('creates an invitation and shows its link once', async () => {
    mockRoutes((url, method) => {
      if (url.includes('/auth/check')) return jsonResponse(200, session(ALPHA));
      if (url.includes('/organizations/members')) {
        return jsonResponse(200, {
          success: true,
          count: 1,
          members: [{ userId: 'u1', name: 'Ada', email: 'ada@example.com', role: 'OWNER', joinedAt: ALPHA.joinedAt }],
        });
      }
      if (url.includes('/organizations/invitations') && method === 'POST') {
        return jsonResponse(201, {
          success: true,
          invitation: {
            id: 'i1',
            email: 'bob@example.com',
            role: 'VIEWER',
            permissions: permissionsFor('VIEWER'),
            status: 'PENDING',
            invitedByName: 'Ada',
            expiresAt: PREVIEW.expiresAt,
            createdAt: PREVIEW.expiresAt,
          },
          acceptUrl: 'http://localhost:5173/invite/secret',
        });
      }
      if (url.includes('/organizations/invitations')) {
        return jsonResponse(200, { success: true, count: 0, invitations: [] });
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderAt('/account', <MembersPanel />);

    await screen.findByText('ada@example.com');
    // The last owner's role and removal are locked.
    expect(screen.getByRole('combobox', { name: 'Role for ada@example.com' })).toBeDisabled();

    await user.type(screen.getByRole('textbox', { name: 'Email' }), 'bob@example.com');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Role' }), 'VIEWER');
    await user.click(screen.getByRole('button', { name: 'Create invitation' }));

    expect(await screen.findByRole('textbox', { name: 'Invitation link' })).toHaveValue(
      'http://localhost:5173/invite/secret',
    );
    expect(calls('/organizations/invitations')).toEqual([{ email: 'bob@example.com', role: 'VIEWER' }]);
  });
});
