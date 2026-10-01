import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { OrgProvider } from '../context/OrgContext';
import RolesSettingsPage from '../Pages/settings/RolesSettingsPage';
import DashboardPage from '../Pages/home/DashboardPage';
import MembersPanel from '../Pages/MembersPanel';
import { visibleNavGroups } from '../components/layout/nav';
import { permissionsFor } from './helpers/permissions';
import { BUILTIN_ROLE_PERMISSIONS, PERMISSIONS } from '../../../server/src/config/permissions';

/**
 * Phase 38c — custom roles on the client: the role editor, permission-aware
 * navigation, the home page for a role without reports, and custom roles in
 * the member picker.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function session(role: string, permissions: string[], roleName = role) {
  return {
    success: true,
    user: { id: 'u1', name: 'Ada', email: 'ada@example.com', emailVerified: true, createdAt: '2026-01-01T00:00:00.000Z' },
    organization: { id: 'o1', name: 'Acme', slug: 'acme', baseCurrency: 'USD', taxNumber: null, businessNumber: null, createdAt: '2026-01-01T00:00:00.000Z' },
    role,
    roleName,
    permissions,
    memberships: [{ orgId: 'o1', orgName: 'Acme', orgSlug: 'acme', role, roleName, joinedAt: '2026-01-01T00:00:00.000Z' }],
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  };
}

const OVERVIEW = {
  success: true,
  builtin: (['OWNER', 'ADMIN', 'ACCOUNTANT', 'VIEWER'] as const).map((role) => ({
    role,
    permissions: [...BUILTIN_ROLE_PERMISSIONS[role]].sort(),
  })),
  custom: [] as unknown[],
  catalogue: PERMISSIONS,
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function route(sessionBody: unknown, handler: (url: string, method: string, body: unknown) => Response | undefined) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, sessionBody));
    return Promise.resolve(handler(url, method, body) ?? jsonResponse(404, { success: false, error: `unmocked ${method} ${url}` }));
  });
}

function renderAt(element: React.ReactNode) {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <OrgProvider>
          <Routes>
            <Route path="*" element={element} />
          </Routes>
        </OrgProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('RolesSettingsPage', () => {
  it('ticking a permission ticks what it needs; owner-only keys are disabled; save sends the set', async () => {
    let posted: unknown = null;
    route(session('ADMIN', permissionsFor('ADMIN')), (url, method, body) => {
      if (url.includes('/organizations/roles') && method === 'POST') {
        posted = body;
        return jsonResponse(201, { success: true, role: { id: 'r1', name: 'Invoice clerk', description: null, permissions: [], memberCount: 0 } });
      }
      if (url.includes('/organizations/roles')) return jsonResponse(200, OVERVIEW);
      return undefined;
    });
    const user = userEvent.setup();
    renderAt(<RolesSettingsPage />);

    await user.click(await screen.findByRole('button', { name: 'New role' }));
    const editor = screen.getByRole('form', { name: 'Role editor' });
    await user.type(within(editor).getByLabelText('Role name'), 'Invoice clerk');

    await user.click(within(editor).getByRole('checkbox', { name: 'Issue invoices' }));
    expect(within(editor).getByRole('checkbox', { name: 'View invoices' })).toBeChecked();
    expect(within(editor).getByRole('checkbox', { name: 'View customers' })).toBeChecked();
    expect(within(editor).getByRole('checkbox', { name: /Lock periods permanently/ })).toBeDisabled();

    // Unticking a dependency unticks what depends on it.
    await user.click(within(editor).getByRole('checkbox', { name: 'View customers' }));
    expect(within(editor).getByRole('checkbox', { name: 'Issue invoices' })).not.toBeChecked();
    await user.click(within(editor).getByRole('checkbox', { name: 'Issue invoices' }));

    await user.click(within(editor).getByRole('button', { name: 'Create role' }));
    await screen.findByRole('button', { name: 'New role' });
    expect(posted).toMatchObject({ name: 'Invoice clerk', description: null });
    expect([...(posted as { permissions: string[] }).permissions].sort()).toEqual([
      'customers.view',
      'invoices.issue',
      'invoices.view',
    ]);
  });

  it('a role without roles.manage sees the roles but cannot change them', async () => {
    route(session('CUSTOM', ['members.view'], 'Team lead'), (url) =>
      url.includes('/organizations/roles') ? jsonResponse(200, OVERVIEW) : undefined,
    );
    renderAt(<RolesSettingsPage />);
    expect(await screen.findByText('Built-in roles')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New role' })).not.toBeInTheDocument();
  });
});

describe('navigation follows permissions', () => {
  it('an invoice clerk sees Dashboard, Invoices and Settings only', () => {
    const clerk = new Set(['invoices.view', 'invoices.issue', 'customers.view']);
    const labels = visibleNavGroups((p) => clerk.has(p)).flatMap((g) => g.items.map((i) => i.label));
    expect(labels).toEqual(['Dashboard', 'Invoices', 'Customers', 'Settings']);
  });

  it('a VIEWER still sees every section it could before Phase 38c, except importing statements', () => {
    const viewer = new Set(permissionsFor('VIEWER'));
    const labels = visibleNavGroups((p) => viewer.has(p)).flatMap((g) => g.items.map((i) => i.label));
    expect(labels).toContain('Journal entries');
    expect(labels).not.toContain('Import statement');
  });
});

describe('DashboardPage for a role without reports', () => {
  it('shows where the member can go instead of a refused dashboard', async () => {
    route(session('CUSTOM', ['invoices.view', 'customers.view'], 'Invoice clerk'), () => undefined);
    renderAt(<DashboardPage />);
    expect(await screen.findByText('Your role: Invoice clerk')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Invoices/ })).toHaveAttribute('href', '/invoices');
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/reports/dashboard'))).toBe(false);
  });
});

describe('MembersPanel with custom roles', () => {
  it('offers custom roles beside the built-in ones and sends customRoleId', async () => {
    let patched: unknown = null;
    route(session('OWNER', permissionsFor('OWNER')), (url, method, body) => {
      if (url.includes('/organizations/members/u2') && method === 'PATCH') {
        patched = body;
        return jsonResponse(200, { success: true, member: {} });
      }
      if (url.includes('/organizations/members')) {
        return jsonResponse(200, {
          success: true,
          count: 2,
          members: [
            { userId: 'u1', name: 'Ada', email: 'ada@example.com', role: 'OWNER', customRoleId: null, roleName: 'OWNER', joinedAt: '2026-01-01T00:00:00.000Z' },
            { userId: 'u2', name: 'Bo', email: 'bo@example.com', role: 'VIEWER', customRoleId: null, roleName: 'VIEWER', joinedAt: '2026-01-02T00:00:00.000Z' },
          ],
        });
      }
      if (url.includes('/organizations/invitations')) return jsonResponse(200, { success: true, count: 0, invitations: [] });
      if (url.includes('/organizations/roles')) {
        return jsonResponse(200, {
          ...OVERVIEW,
          custom: [{ id: 'r9', name: 'Invoice clerk', description: null, permissions: ['invoices.view'], memberCount: 0 }],
        });
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderAt(<MembersPanel />);

    const select = await screen.findByRole('combobox', { name: 'Role for bo@example.com' });
    expect((await screen.findAllByRole('option', { name: 'Invoice clerk' })).length).toBeGreaterThan(0);
    await user.selectOptions(select, 'custom:r9');
    await screen.findByRole('combobox', { name: 'Role for bo@example.com' });
    expect(patched).toEqual({ customRoleId: 'r9' });
  });
});
