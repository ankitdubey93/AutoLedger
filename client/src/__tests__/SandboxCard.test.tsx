import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SandboxCard from '../Pages/SandboxCard';
import { AuthProvider } from '../context/AuthContext';
import type { Role } from '../services/fetchServices';

/**
 * SandboxCard — Phase 18. What matters: status is visible to every member,
 * Load and Remove are OWNER-only and HIDDEN (not disabled) below that, both
 * are gated by a ConfirmDialog, and an unexpected response shape leaves the
 * chooser working rather than crashing it.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const counts = {
  customers: 12,
  vendors: 6,
  invoices: 137,
  bills: 127,
  payments: 251,
  bankLines: 25,
  apFlowDocuments: 3,
  forecastPlans: 1,
  fpaModels: 1,
  productLines: 4,
  closeRuns: 2,
  corpusDocuments: 1,
};

const dataset = {
  orgId: 'o1',
  datasetVersion: '1.0.0',
  anchorMonth: '2026-09-01',
  counts,
  loadedAt: new Date('2026-09-12').toISOString(),
};

function session(role: Role) {
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
    memberships: [
      { orgId: 'o1', orgName: 'Acme', orgSlug: 'acme', role, joinedAt: new Date().toISOString() },
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

/**
 * `sandbox` is what GET /sandbox should return; `onLoad`/`onUnload` let a
 * test decide what the write routes answer with.
 */
function mockRoutes(options: {
  role?: Role;
  sandbox: unknown;
  onLoad?: { status: number; body: unknown };
  onUnload?: { status: number; body: unknown };
}) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (url.includes('/auth/check')) {
      return Promise.resolve(jsonResponse(200, session(options.role ?? 'OWNER')));
    }
    if (method === 'POST' && url.includes('/sandbox/load')) {
      const res = options.onLoad ?? { status: 201, body: { success: true, dataset } };
      return Promise.resolve(jsonResponse(res.status, res.body));
    }
    if (method === 'DELETE' && url.includes('/sandbox')) {
      const res = options.onUnload ?? { status: 200, body: { success: true } };
      return Promise.resolve(jsonResponse(res.status, res.body));
    }
    if (method === 'GET' && url.includes('/sandbox')) {
      return Promise.resolve(jsonResponse(200, { success: true, sandbox: options.sandbox }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unmocked ${method} ${url}` }));
  });
}

function renderCard() {
  return render(
    <AuthProvider>
      <SandboxCard />
    </AuthProvider>,
  );
}

describe('SandboxCard', () => {
  it('offers to load sample data when none is loaded', async () => {
    mockRoutes({ sandbox: { loaded: false, dataset: null } });
    renderCard();

    expect(await screen.findByRole('button', { name: 'Load sample data' })).toBeInTheDocument();
    expect(screen.getByText(/24 months of realistic activity/i)).toBeInTheDocument();
  });

  it('shows the counts and a Remove action when a dataset is loaded', async () => {
    mockRoutes({ sandbox: { loaded: true, dataset } });
    renderCard();

    expect(await screen.findByText(/24-month demo dataset is loaded/i)).toBeInTheDocument();
    expect(screen.getByText('137')).toBeInTheDocument(); // invoices
    expect(screen.getByText(/Dataset 1\.0\.0, anchored at 2026-09-01/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load sample data' })).toBeNull();
  });

  it('hides Load from a non-OWNER but still shows the status', async () => {
    mockRoutes({ role: 'ADMIN', sandbox: { loaded: false, dataset: null } });
    renderCard();

    expect(await screen.findByText(/24 months of realistic activity/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Load sample data' })).toBeNull();
    });
  });

  it('hides Remove from a non-OWNER when a dataset is loaded', async () => {
    mockRoutes({ role: 'ACCOUNTANT', sandbox: { loaded: true, dataset } });
    renderCard();

    expect(await screen.findByText(/24-month demo dataset is loaded/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    });
  });

  it('loads only after the confirmation is accepted, then shows the counts', async () => {
    let loaded = false;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, session('OWNER')));
      if (method === 'POST' && url.includes('/sandbox/load')) {
        loaded = true;
        return Promise.resolve(jsonResponse(201, { success: true, dataset }));
      }
      if (method === 'GET' && url.includes('/sandbox')) {
        return Promise.resolve(
          jsonResponse(200, {
            success: true,
            sandbox: loaded ? { loaded: true, dataset } : { loaded: false, dataset: null },
          }),
        );
      }
      return Promise.resolve(jsonResponse(404, { success: false, error: 'unmocked' }));
    });

    renderCard();
    await userEvent.click(await screen.findByRole('button', { name: 'Load sample data' }));

    // The dialog is open; nothing has been written yet.
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(loaded).toBe(false);

    // `within` the dialog: the trigger and the confirm button deliberately
    // share a label, so a bare getByRole finds both.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Load sample data' }));

    expect(await screen.findByText(/24-month demo dataset is loaded/i)).toBeInTheDocument();
    expect(loaded).toBe(true);
  });

  it('does not load when the confirmation is cancelled', async () => {
    mockRoutes({ sandbox: { loaded: false, dataset: null } });
    renderCard();

    await userEvent.click(await screen.findByRole('button', { name: 'Load sample data' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    const posted = fetchMock.mock.calls.some(
      (call) => ((call[1] as RequestInit | undefined)?.method ?? 'GET') === 'POST',
    );
    expect(posted).toBe(false);
  });

  it("says plainly that removing clears the marker only, not the seeded records", async () => {
    mockRoutes({ sandbox: { loaded: true, dataset } });
    renderCard();

    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(/marker only/i);
    expect(dialog).toHaveTextContent(/immutable by design/i);
  });

  it('surfaces a 409 from a second load rather than failing silently', async () => {
    mockRoutes({
      sandbox: { loaded: false, dataset: null },
      onLoad: { status: 409, body: { success: false, error: 'Sample data is already loaded for this organization' } },
    });
    renderCard();

    await userEvent.click(await screen.findByRole('button', { name: 'Load sample data' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Load sample data' }),
    );

    expect(await screen.findByText(/already loaded for this organization/i)).toBeInTheDocument();
  });

  it('renders nothing when the response shape is unexpected', async () => {
    // Exactly what a harness that mocks every fetch identically produces —
    // the chooser must keep working rather than crash.
    mockRoutes({ sandbox: undefined });
    const { container } = renderCard();

    await waitFor(() => {
      expect(container.querySelector('section')).toBeNull();
    });
  });

  it('renders nothing when the status request fails', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/auth/check')) return Promise.resolve(jsonResponse(200, session('OWNER')));
      return Promise.resolve(jsonResponse(500, { success: false, error: 'boom' }));
    });

    const { container } = renderCard();

    await waitFor(() => {
      expect(container.querySelector('section')).toBeNull();
    });
  });
});
