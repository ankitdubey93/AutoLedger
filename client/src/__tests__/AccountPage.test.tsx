import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AccountPage from '../Pages/AccountPage';
import { AuthProvider } from '../context/AuthContext';
import { OrgProvider } from '../context/OrgContext';
import type { Role } from '../services/fetchServices';

/**
 * Account settings — Phase 27 additions: the three dates (account created,
 * organization created, when you joined it) and the Apps panel, editable by
 * OWNER/ADMIN and read-only for everyone else.
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

function entry(slug: string, name: string, enabled: boolean) {
  return {
    slug,
    name,
    domain: 'd',
    tagline: 't',
    skills: [],
    status: 'building',
    requires: [],
    enabled,
    enabledAt: enabled ? ORG_CREATED : null,
  };
}

const apps = [entry('ledger-core', 'LedgerCore', true), entry('stock', 'StockLedger', true)];

let fetchMock: ReturnType<typeof vi.fn>;
let putBodies: unknown[];

beforeEach(() => {
  fetchMock = vi.fn();
  putBodies = [];
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockRoutes(role: Role) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (url.includes('/organizations/apps')) {
      if (method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as { appSlugs: string[] };
        putBodies.push(body);
        const next = apps.map((a) => ({ ...a, enabled: body.appSlugs.includes(a.slug) }));
        return Promise.resolve(
          jsonResponse(200, { success: true, selectionCompletedAt: ORG_CREATED, count: next.length, apps: next }),
        );
      }
      return Promise.resolve(
        jsonResponse(200, { success: true, selectionCompletedAt: ORG_CREATED, count: apps.length, apps }),
      );
    }
    if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, session(role)));
    if (url.includes('/organizations/members')) {
      return Promise.resolve(jsonResponse(403, { success: false, error: 'Forbidden' }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unmocked ${method} ${url}` }));
  });
}

/** The Apps panel only — the page has other Save buttons (business identification). */
function appsPanel(): HTMLElement {
  const panel = document.getElementById('apps');
  if (panel === null) throw new Error('no #apps panel rendered');
  return panel;
}

function renderAccount() {
  return render(
    <MemoryRouter>
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

  it('an OWNER unticks StockLedger and saves', async () => {
    mockRoutes('OWNER');
    const user = userEvent.setup();
    renderAccount();

    await user.click(await screen.findByRole('checkbox', { name: 'StockLedger' }));
    await user.click(within(appsPanel()).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(putBodies).toHaveLength(1);
    expect((putBodies[0] as { appSlugs: string[] }).appSlugs).not.toContain('stock');
  });

  it('a VIEWER sees a read-only list and no Save button', async () => {
    mockRoutes('VIEWER');
    renderAccount();

    expect(await screen.findByText('Only an owner or admin can change which apps are enabled.')).toBeInTheDocument();
    const panel = within(appsPanel());
    expect(panel.getByText('LedgerCore')).toBeInTheDocument();
    expect(panel.getByText('StockLedger')).toBeInTheDocument();
    expect(panel.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });
});
