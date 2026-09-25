import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { OrgProvider } from '../context/OrgContext';
import { ThemeProvider } from '../context/ThemeContext';
import { ShellProvider } from '../components/layout/ShellContext';
import AppTopBar from '../components/layout/AppTopBar';
import type { Role } from '../services/fetchServices';

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

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
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

function renderTopBar() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AuthProvider>
        <OrgProvider>
          <ThemeProvider>
            <ShellProvider>
              <AppTopBar />
              <Routes>
                <Route path="/account" element={<p>ACCOUNT PAGE</p>} />
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
    renderTopBar();

    await user.click(await screen.findByRole('button', { name: /ada@example\.com/i }));

    expect(screen.getByRole('menuitem', { name: 'Account' })).toHaveAttribute('href', '/account');
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('is one product: the brand links home, there is no app switcher, and the mobile menu opens the sidebar', async () => {
    renderTopBar();

    expect(await screen.findByRole('button', { name: /ada@example\.com/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /AutoLedger/ })).toHaveAttribute('href', '/');
    expect(screen.getByRole('button', { name: 'Open menu' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /LedgerCore|StockLedger|AP-Flow/ })).not.toBeInTheDocument();
  });

  it('the theme menu switches themes', async () => {
    const user = userEvent.setup();
    renderTopBar();

    await user.click(await screen.findByRole('button', { name: 'Change theme' }));
    await user.click(screen.getByRole('menuitem', { name: 'Dark' }));

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
