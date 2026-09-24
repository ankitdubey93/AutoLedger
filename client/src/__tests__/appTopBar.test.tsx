import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { OrgProvider } from '../context/OrgContext';
import { ThemeProvider } from '../context/ThemeContext';
import { ShellProvider } from '../components/layout/ShellContext';
import AppTopBar from '../components/layout/AppTopBar';
import type { AppSummary, Role } from '../services/fetchServices';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function session(role: Role) {
  return {
    success: true,
    user: { id: 'u1', name: 'Ada Lovelace', email: 'ada@example.com', emailVerified: false, createdAt: new Date().toISOString() },
    organization: { id: 'o1', name: 'Acme', slug: 'acme', baseCurrency: 'USD', createdAt: new Date().toISOString() },
    role,
    memberships: [{ orgId: 'o1', orgName: 'Acme', orgSlug: 'acme', role, joinedAt: new Date().toISOString() }],
    accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  };
}

const ledgerCoreApp: AppSummary = {
  slug: 'ledger-core',
  name: 'LedgerCore',
  domain: 'x',
  tagline: 'y',
  skills: [],
  status: 'building',
  requires: [],
};

const orgApps = {
  success: true,
  selectionCompletedAt: '2026-09-01T00:00:00.000Z',
  count: 2,
  apps: [
    { ...ledgerCoreApp, enabled: true, enabledAt: '2026-09-01T00:00:00.000Z' },
    { slug: 'stock', name: 'StockLedger', domain: 'x', tagline: 'y', skills: [], status: 'building', requires: [], enabled: true, enabledAt: '2026-09-01T00:00:00.000Z' },
    { slug: 'ap-flow', name: 'AP-Flow', domain: 'x', tagline: 'y', skills: [], status: 'building', requires: ['ledger-core'], enabled: false, enabledAt: null },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/organizations/apps')) return Promise.resolve(jsonResponse(200, orgApps));
    if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, session('OWNER')));
    return Promise.resolve(jsonResponse(404, { success: false, error: `unmocked ${url}` }));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
  localStorage.clear();
});

function renderTopBar(app: AppSummary | null) {
  return render(
    <MemoryRouter initialEntries={['/app/ledger-core']}>
      <AuthProvider>
        <OrgProvider>
          <ThemeProvider>
            <ShellProvider>
              <AppTopBar app={app} />
              <Routes>
                <Route path="/account" element={<p>ACCOUNT PAGE</p>} />
                <Route path="/app/:appSlug" element={<p>APP PAGE</p>} />
              </Routes>
            </ShellProvider>
          </ThemeProvider>
        </OrgProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('AppTopBar', () => {
  it("the user menu holds Sign out and a link to Account", async () => {
    const user = userEvent.setup();
    renderTopBar(ledgerCoreApp);

    await user.click(await screen.findByRole('button', { name: /ada@example\.com/i }));

    expect(screen.getByRole('menuitem', { name: 'Account' })).toHaveAttribute('href', '/account');
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('the app switcher lists only the OTHER enabled apps, never the disabled one', async () => {
    const user = userEvent.setup();
    renderTopBar(ledgerCoreApp);

    await user.click(await screen.findByRole('button', { name: /LedgerCore/ }));

    expect(screen.getByRole('menuitem', { name: 'StockLedger' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'AP-Flow' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'LedgerCore' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'All apps' })).toHaveAttribute('href', '/');
  });

  it('has no app switcher or mobile menu button when rendered outside an app (PlatformLayout)', async () => {
    renderTopBar(null);
    expect(screen.queryByRole('button', { name: 'Open menu' })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /ada@example\.com/i })).toBeInTheDocument();
  });

  it('the theme menu switches themes', async () => {
    const user = userEvent.setup();
    renderTopBar(ledgerCoreApp);

    await user.click(await screen.findByRole('button', { name: 'Change theme' }));
    await user.click(screen.getByRole('menuitem', { name: 'Dark' }));

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
