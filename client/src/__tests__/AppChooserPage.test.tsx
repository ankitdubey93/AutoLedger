import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppChooserPage from '../Pages/AppChooserPage';
import { AuthProvider } from '../context/AuthContext';
import { OrgProvider } from '../context/OrgContext';
import type { Role } from '../services/fetchServices';

/**
 * The chooser is the post-login landing page. Since Phase 27 it lists only
 * the apps the organization has enabled (GET /organizations/apps), sends an
 * organization that has never chosen to /welcome, and still shows an error
 * instead of a silently empty grid when the fetch fails.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function session(role: Role) {
  return {
    success: true,
    user: { id: 'u1', name: 'Ada', email: 'ada@example.com', emailVerified: false, createdAt: new Date().toISOString() },
    organization: { id: 'o1', name: 'Acme', slug: 'acme', baseCurrency: 'USD', createdAt: new Date().toISOString() },
    role,
    memberships: [{ orgId: 'o1', orgName: 'Acme', orgSlug: 'acme', role, joinedAt: new Date().toISOString() }],
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  };
}

const apps = [
  {
    slug: 'ledger-core',
    name: 'LedgerCore',
    domain: 'Core Accounting & Systems',
    tagline: 'x',
    skills: ['a'],
    status: 'building',
    requires: [],
    enabled: true,
    enabledAt: '2026-09-01T00:00:00.000Z',
  },
  {
    slug: 'stock',
    name: 'StockLedger',
    domain: 'Inventory & Warehousing',
    tagline: 'y',
    skills: ['b'],
    status: 'building',
    requires: [],
    enabled: false,
    enabledAt: null,
  },
];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * `/organizations/apps` also contains `/apps`, so it is matched first. A
 * fresh Response per call: the chooser and its checklist both
 * fetch concurrently, and a Response body can only be read once.
 */
function mockRoutes(orgApps: { status: number; body: unknown }) {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/organizations/apps')) return Promise.resolve(jsonResponse(orgApps.status, orgApps.body));
    if (url.includes('/onboarding')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: 0, items: [] }));
    }
    if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, session('OWNER')));
    return Promise.resolve(jsonResponse(404, { success: false, error: `unmocked ${url}` }));
  });
}

function renderChooser() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AuthProvider>
        <OrgProvider>
          <Routes>
            <Route path="/" element={<AppChooserPage />} />
            <Route path="/welcome" element={<p>WELCOME</p>} />
          </Routes>
        </OrgProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('AppChooserPage', () => {
  it('shows only enabled apps', async () => {
    mockRoutes({
      status: 200,
      body: { success: true, selectionCompletedAt: '2026-09-01T00:00:00.000Z', count: 2, apps },
    });

    renderChooser();

    const ledgerCard = (await screen.findByText('LedgerCore')).closest('a');
    expect(ledgerCard).toHaveAttribute('href', '/app/ledger-core');
    expect(screen.queryByText('StockLedger')).not.toBeInTheDocument();
  });

  it('redirects to /welcome when no selection has been saved', async () => {
    mockRoutes({ status: 200, body: { success: true, selectionCompletedAt: null, count: 2, apps } });

    renderChooser();

    expect(await screen.findByText('WELCOME')).toBeInTheDocument();
  });

  it('shows an error instead of a blank grid when the API call fails', async () => {
    mockRoutes({ status: 500, body: { success: false, error: 'boom' } });

    renderChooser();

    expect(await screen.findByText(/boom|could not load/i)).toBeInTheDocument();
  });
});
