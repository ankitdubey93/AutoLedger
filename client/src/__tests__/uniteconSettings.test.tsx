import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import UniteconSettingsPage from '../Pages/unitecon/UniteconSettingsPage';
import type { Account, UniteconProductLine, UniteconSettings } from '../services/fetchServices';

/**
 * UnitEcon (Phase 14) — the settings page. Reads `useAuth()` to gate the
 * margin form and product-line delete on role, so it renders under
 * AuthProvider, mirroring BillDetailPage's tests.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function sessionFor(role: 'OWNER' | 'VIEWER') {
  return {
    success: true,
    user: {
      id: 'u1',
      name: 'Ada',
      email: 'ada@example.com',
      emailVerified: false,
      createdAt: new Date().toISOString(),
    },
    organization: {
      id: 'o1',
      name: 'Acme',
      slug: 'acme',
      baseCurrency: 'USD',
      createdAt: new Date().toISOString(),
    },
    role,
    memberships: [{ orgId: 'o1', orgName: 'Acme', orgSlug: 'acme', role, joinedAt: new Date().toISOString() }],
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  };
}

const settings: UniteconSettings = {
  grossMarginBps: 7000,
  acquisitionAccountIds: [],
  updatedAt: null,
};

const accounts: Account[] = [
  {
    id: 'acc-6100',
    code: '6100',
    name: 'Salaries & Wages',
    type: 'Expense',
    parentId: null,
    isPostable: true,
    isActive: true,
    description: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'acc-4100',
    code: '4100',
    name: 'Product Revenue',
    type: 'Revenue',
    parentId: null,
    isPostable: true,
    isActive: true,
    description: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

const productLines: UniteconProductLine[] = [
  {
    id: 'pl-1',
    revenueAccountId: 'acc-4100',
    revenueAccountCode: '4100',
    revenueAccountName: 'Product Revenue',
    name: 'Widgets',
    unitLabel: 'unit',
    isActive: true,
    createdBy: 'u1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

let fetchMock: ReturnType<typeof vi.fn>;
let deleteCalled: boolean;

beforeEach(() => {
  deleteCalled = false;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockSettingsRoutes(role: 'OWNER' | 'VIEWER') {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, sessionFor(role)));
    if (url.includes('/unitecon/settings')) {
      return Promise.resolve(jsonResponse(200, { success: true, settings }));
    }
    if (url.includes('/ledger-core/accounts')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: accounts.length, accounts }));
    }
    if (url.includes('/unitecon/product-lines')) {
      if (init?.method === 'DELETE') {
        deleteCalled = true;
        return Promise.resolve(jsonResponse(200, { success: true }));
      }
      return Promise.resolve(
        jsonResponse(200, { success: true, productLines, count: productLines.length }),
      );
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

function renderSettingsPage() {
  return render(
    <MemoryRouter initialEntries={['/app/unitecon/settings']}>
      <AuthProvider>
        <Routes>
          <Route path="/app/:appSlug/settings" element={<UniteconSettingsPage />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('UniteconSettingsPage', () => {
  it('1. an OWNER sees the gross-margin form and the delete control', async () => {
    mockSettingsRoutes('OWNER');
    renderSettingsPage();

    await screen.findByText('Widgets');
    expect(screen.getByText('Gross margin %')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Widgets' })).toBeInTheDocument();
  });

  it('2. a VIEWER sees neither the margin form nor the delete control (hidden, not disabled)', async () => {
    mockSettingsRoutes('VIEWER');
    renderSettingsPage();

    await screen.findByText('Widgets');
    expect(screen.queryByText('Gross margin %')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete Widgets' })).not.toBeInTheDocument();
  });

  it('3. clicking delete opens ConfirmDialog and does not call the API until confirmed', async () => {
    mockSettingsRoutes('OWNER');
    const user = userEvent.setup();
    renderSettingsPage();

    await screen.findByText('Widgets');
    await user.click(screen.getByRole('button', { name: 'Delete Widgets' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(deleteCalled).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(deleteCalled).toBe(true);
  });
});
