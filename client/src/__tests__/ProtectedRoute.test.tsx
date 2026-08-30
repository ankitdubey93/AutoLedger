import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProtectedRoute from '../components/ProtectedRoute';
import { AuthProvider } from '../context/AuthContext';

/**
 * Guards the login-flash bug: on reload the session lives in an httpOnly
 * cookie, so there is a window where the app genuinely does not know whether
 * anyone is signed in. Rendering the login page during that window bounces a
 * legitimately logged-in user out and back.
 */

function jsonResponse(status: number, body: unknown = { success: status < 400 }): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const session = {
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
  role: 'OWNER',
  memberships: [],
  accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
};

function renderApp() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<p>Login page</p>} />
          <Route element={<ProtectedRoute />}>
            <Route path="/" element={<p>Secret dashboard</p>} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ProtectedRoute', () => {
  it('shows the skeleton and NOT the login page while checking', async () => {
    // A session check that never settles pins the app in `checking`.
    fetchMock.mockReturnValue(new Promise<Response>(() => undefined));

    renderApp();

    expect(screen.getByText(/restoring your session/i)).toBeInTheDocument();
    // The assertion that actually matters — the flash is the bug.
    expect(screen.queryByText('Login page')).not.toBeInTheDocument();
    expect(screen.queryByText('Secret dashboard')).not.toBeInTheDocument();
  });

  it('renders the protected page once the session resolves', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, session));

    renderApp();

    expect(await screen.findByText('Secret dashboard')).toBeInTheDocument();
    expect(screen.queryByText('Login page')).not.toBeInTheDocument();
  });

  it('redirects to login when there is no session', async () => {
    // 401 on both the check and the refresh it triggers.
    fetchMock.mockResolvedValue(jsonResponse(401, { success: false, error: 'nope' }));

    renderApp();

    expect(await screen.findByText('Login page')).toBeInTheDocument();
  });

  it('never gets stuck in checking when the network fails', async () => {
    // A stuck spinner is worse than a login page: the user has no way out.
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    renderApp();

    await waitFor(() => {
      expect(screen.getByText('Login page')).toBeInTheDocument();
    });
    expect(screen.queryByText(/restoring your session/i)).not.toBeInTheDocument();
  });
});
