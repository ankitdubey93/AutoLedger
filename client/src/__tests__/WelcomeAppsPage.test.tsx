import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WelcomeAppsPage from '../Pages/WelcomeAppsPage';
import { AuthProvider } from '../context/AuthContext';
import { OrgProvider } from '../context/OrgContext';
import type { Role } from '../services/fetchServices';

/**
 * The post-sign-up app picker — Phase 27. What matters: dependencies tick
 * themselves, Continue saves the whole set and goes home, a non-admin is
 * told who to ask, and an organization that already chose is sent home.
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

function entry(slug: string, name: string, requires: string[] = []) {
  return {
    slug,
    name,
    domain: 'd',
    tagline: 't',
    skills: [],
    status: 'building',
    requires,
    enabled: false,
    enabledAt: null,
  };
}

const apps = [
  entry('ledger-core', 'LedgerCore'),
  entry('ap-flow', 'AP-Flow', ['ledger-core']),
  entry('stock', 'StockLedger'),
];

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

function mockRoutes(options: { role?: Role; selectionCompletedAt?: string | null } = {}) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (url.includes('/organizations/apps')) {
      if (method === 'PUT') {
        putBodies.push(JSON.parse(String(init?.body)));
        return Promise.resolve(
          jsonResponse(200, { success: true, selectionCompletedAt: new Date().toISOString(), count: 3, apps }),
        );
      }
      return Promise.resolve(
        jsonResponse(200, {
          success: true,
          selectionCompletedAt: options.selectionCompletedAt ?? null,
          count: 3,
          apps,
        }),
      );
    }
    if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, session(options.role ?? 'OWNER')));
    return Promise.resolve(jsonResponse(404, { success: false, error: `unmocked ${method} ${url}` }));
  });
}

function renderWelcome() {
  return render(
    <MemoryRouter initialEntries={['/welcome']}>
      <AuthProvider>
        <OrgProvider>
          <Routes>
            <Route path="/welcome" element={<WelcomeAppsPage />} />
            <Route path="/" element={<p>HOME</p>} />
          </Routes>
        </OrgProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('WelcomeAppsPage', () => {
  it('ticking AP-Flow also ticks LedgerCore', async () => {
    mockRoutes();
    const user = userEvent.setup();
    renderWelcome();

    await user.click(await screen.findByRole('checkbox', { name: 'AP-Flow' }));

    expect(screen.getByRole('checkbox', { name: 'AP-Flow' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'LedgerCore' })).toBeChecked();
  });

  it('Continue is disabled with nothing ticked', async () => {
    mockRoutes();
    renderWelcome();

    expect(await screen.findByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('Continue PUTs the selection and goes home', async () => {
    mockRoutes();
    const user = userEvent.setup();
    renderWelcome();

    await user.click(await screen.findByRole('checkbox', { name: 'AP-Flow' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('HOME')).toBeInTheDocument();
    expect(putBodies).toHaveLength(1);
    const body = putBodies[0] as { appSlugs: string[] };
    expect([...body.appSlugs].sort()).toEqual(['ap-flow', 'ledger-core']);
  });

  it('a VIEWER sees the ask-an-owner message and no checkboxes', async () => {
    mockRoutes({ role: 'VIEWER' });
    renderWelcome();

    expect(await screen.findByText(/needs to choose which apps/)).toBeInTheDocument();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('an org that already chose is redirected home', async () => {
    mockRoutes({ selectionCompletedAt: '2026-09-01T00:00:00.000Z' });
    renderWelcome();

    expect(await screen.findByText('HOME')).toBeInTheDocument();
  });
});
