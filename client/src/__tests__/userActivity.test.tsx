import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import UserActivityPage from '../Pages/settings/UserActivityPage';
import AuditLogPage from '../Pages/settings/AuditLogPage';
import SessionsPanel from '../Pages/account/SessionsPanel';
import { AuthProvider } from '../context/AuthContext';
import { permissionsFor } from './helpers/permissions';

/**
 * Phase 46d — User activity (per-member sign-ins and changes), the audit trail
 * filtered by member from the URL, and the caller's own sign-in history.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const MEMBERS = [
  {
    userId: 'u1',
    name: 'Ada',
    email: 'ada@example.com',
    role: 'OWNER',
    lastSignInAt: '2026-10-10T09:00:00.000Z',
    failedSignInsLast30Days: 0,
    changesLast30Days: 4,
  },
  {
    userId: 'u2',
    name: null,
    email: 'bo@example.com',
    role: 'VIEWER',
    lastSignInAt: null,
    failedSignInsLast30Days: 2,
    changesLast30Days: 0,
  },
];

function session() {
  return {
    success: true,
    user: { id: 'u1', name: 'Ada', email: 'ada@example.com', emailVerified: true, createdAt: '2026-03-04T10:00:00.000Z' },
    organization: { id: 'o1', name: 'Acme', slug: 'acme', baseCurrency: 'USD', createdAt: '2026-02-01T10:00:00.000Z' },
    role: 'OWNER',
    permissions: permissionsFor('OWNER'),
    memberships: [
      { orgId: 'o1', orgName: 'Acme', orgSlug: 'acme', role: 'OWNER', roleName: 'OWNER', joinedAt: '2026-02-01T10:00:00.000Z' },
    ],
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

describe('User activity', () => {
  it('renders each member with a link to their audit entries', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/organizations/members/activity')) {
        return Promise.resolve(jsonResponse(200, { success: true, count: 2, members: MEMBERS }));
      }
      return Promise.resolve(jsonResponse(404, { success: false, error: `unmocked ${url}` }));
    });

    render(
      <MemoryRouter>
        <UserActivityPage />
      </MemoryRouter>,
    );

    const link = await screen.findByRole('link', { name: 'Ada' });
    expect(link).toHaveAttribute('href', '/settings/audit?actor=u1');
    expect(screen.getByRole('link', { name: 'bo@example.com' })).toHaveAttribute('href', '/settings/audit?actor=u2');
    expect(screen.getByText('Never')).toBeInTheDocument();
  });

  it('the audit trail at ?actor=u1 asks the server for that member only', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/audit-logs')) {
        return Promise.resolve(
          jsonResponse(200, { success: true, count: 0, totalCount: 0, currentPage: 1, totalPages: 1, logs: [] }),
        );
      }
      if (url.includes('/organizations/members')) {
        return Promise.resolve(jsonResponse(200, { success: true, count: 0, members: [] }));
      }
      return Promise.resolve(jsonResponse(404, { success: false, error: `unmocked ${url}` }));
    });

    render(
      <MemoryRouter initialEntries={['/settings/audit?actor=u1']}>
        <Routes>
          <Route path="/settings/audit" element={<AuditLogPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('No audit entries match these filters.');
    const auditCalls = fetchMock.mock.calls
      .map(([input]) => (typeof input === 'string' ? input : String(input)))
      .filter((url) => url.includes('/audit-logs'));
    expect(auditCalls.length).toBeGreaterThan(0);
    for (const url of auditCalls) {
      expect(new URL(url, 'http://localhost').searchParams.get('actorUserId')).toBe('u1');
    }
  });

  it('the sign-in history lists a failed sign-in', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, session()));
      if (url.includes('/auth/login-events')) {
        return Promise.resolve(
          jsonResponse(200, {
            success: true,
            count: 1,
            events: [
              {
                id: 'e1',
                outcome: 'FAILED',
                ip: '127.0.0.1',
                userAgent: null,
                createdAt: '2026-10-10T09:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (url.includes('/auth/sessions')) {
        return Promise.resolve(jsonResponse(200, { success: true, count: 0, sessions: [] }));
      }
      return Promise.resolve(jsonResponse(404, { success: false, error: `unmocked ${url}` }));
    });

    render(
      <MemoryRouter>
        <AuthProvider>
          <SessionsPanel />
        </AuthProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Failed sign-in')).toBeInTheDocument());
  });
});
