import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { permissionsFor } from './helpers/permissions';

/**
 * LoginPage — the demo entry point. The demo credentials are read from
 * VITE_DEMO_* at module load, so each case stubs the env, resets the module
 * graph and imports the page (and the AuthProvider it must share) afresh.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const session = {
  success: true,
  user: { id: 'u1', name: 'Demo', email: 'demo@autoledger.dev', emailVerified: false, createdAt: new Date().toISOString() },
  organization: { id: 'o1', name: 'Harbor Point Fabrication', slug: 'harbor-point', baseCurrency: 'USD', createdAt: new Date().toISOString() },
  role: 'OWNER',
  permissions: permissionsFor('OWNER'),
  memberships: [],
  accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/auth/login')) return Promise.resolve(jsonResponse(200, session));
    return Promise.resolve(jsonResponse(401, { success: false, error: 'Not signed in' }));
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function renderLogin() {
  const { AuthProvider } = await import('../context/AuthContext');
  const { default: LoginPage } = await import('../Pages/auth/LoginPage');
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<p>Dashboard</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('LoginPage demo entry', () => {
  it('is hidden when no demo credentials are configured', async () => {
    vi.stubEnv('VITE_DEMO_EMAIL', '');
    vi.stubEnv('VITE_DEMO_PASSWORD', '');
    await renderLogin();
    await screen.findByRole('button', { name: 'Sign in' });
    expect(screen.queryByRole('button', { name: /Open the demo/ })).toBeNull();
  });

  it('signs in with the configured demo credentials', async () => {
    vi.stubEnv('VITE_DEMO_EMAIL', 'demo@autoledger.dev');
    vi.stubEnv('VITE_DEMO_PASSWORD', 'autoledger-demo');
    const user = userEvent.setup();
    await renderLogin();

    await user.click(await screen.findByRole('button', { name: /Open the demo/ }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([input]) => String(input).includes('/auth/login'));
      expect(call).toBeDefined();
      expect(JSON.parse((call as [unknown, RequestInit])[1].body as string)).toEqual({
        email: 'demo@autoledger.dev',
        password: 'autoledger-demo',
      });
    });
    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
  });
});
