import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AccountPage from '../Pages/AccountPage';
import { AuthProvider } from '../context/AuthContext';
import { OrgProvider } from '../context/OrgContext';
import type { Role } from '../services/fetchServices';

/**
 * Account settings: the three dates (account created, organization created,
 * when you joined it) and the tab strip. Phase 33 removed the Apps tab along
 * with per-organization app selection.
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

function mockRoutes(role: Role) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, session(role)));
    if (url.includes('/organizations/members')) {
      return Promise.resolve(jsonResponse(403, { success: false, error: 'Forbidden' }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unmocked ${method} ${url}` }));
  });
}

function renderAccount(initialEntries: string[] = ['/account']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <AuthProvider>
        <OrgProvider>
          <AccountPage />
        </OrgProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('AccountPage', () => {
  it('shows account-created, organization-created and joined dates', async () => {
    mockRoutes('OWNER');
    renderAccount();

    expect(await screen.findByText(day(USER_CREATED))).toBeInTheDocument();
    expect(screen.getByText('Account created')).toBeInTheDocument();
    expect(screen.getByText('Organization created')).toBeInTheDocument();
    expect(screen.getByText(day(ORG_CREATED))).toBeInTheDocument();
    expect(screen.getByText('You joined')).toBeInTheDocument();
    expect(screen.getByText(day(JOINED))).toBeInTheDocument();
  });

  it('renders four tabs with Organisation selected by default; Members shows its own panel', async () => {
    mockRoutes('OWNER');
    // Layer a members route and an empty profile over the harness: the Members
    // tab lists real rows, and the Organisation tab's profile panel loads.
    const base = fetchMock.getMockImplementation() as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/organizations/members')) {
        return Promise.resolve(
          jsonResponse(200, {
            success: true,
            count: 1,
            members: [{ userId: 'u1', name: 'Ada', email: 'ada@example.com', role: 'OWNER', joinedAt: JOINED }],
          }),
        );
      }
      if (url.includes('/organizations/profile')) {
        return Promise.resolve(jsonResponse(404, { success: false, error: 'not needed here' }));
      }
      return base(input, init);
    });
    const user = userEvent.setup();
    renderAccount();

    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Organisation', 'Members', 'Session', 'System']);
    expect(screen.getByRole('tab', { name: 'Organisation' })).toHaveAttribute('aria-selected', 'true');
    for (const name of ['Members', 'Session', 'System']) {
      expect(screen.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'false');
    }
    // Default tab: the Organisation panels, not the others.
    expect(await screen.findByRole('heading', { name: 'Organization profile' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Members' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Members' }));
    expect(screen.getByRole('tab', { name: 'Members' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('heading', { name: 'Members' })).toBeInTheDocument();
    expect(await screen.findByRole('columnheader', { name: 'Email' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'ada@example.com' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Organization profile' })).not.toBeInTheDocument();
  });
});
