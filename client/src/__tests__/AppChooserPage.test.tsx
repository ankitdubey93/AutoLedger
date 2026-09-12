import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppChooserPage from '../Pages/AppChooserPage';
import { AuthProvider } from '../context/AuthContext';

/**
 * The chooser is the new post-login landing page — it replaced the single-app
 * dashboard. What matters: a `building` app is a real link, a `planned` app
 * is visibly disabled rather than a link to nothing, and a failed fetch shows
 * an error instead of a silently empty grid.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const apps = [
  { slug: 'ledger-core', name: 'LedgerCore', domain: 'Core Accounting & Systems', tagline: 'x', skills: ['a'], status: 'building' },
  { slug: 'taxguard', name: 'TaxGuard AI', domain: 'Compliance & AI Workflows', tagline: 'y', skills: ['b'], status: 'planned' },
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
 * Wrapped in AuthProvider because the chooser now renders SandboxCard
 * (Phase 18), which reads the session to decide whether to show its
 * OWNER-only actions — the same provider the real app always mounts this
 * page inside. The provider renders its children in every session state,
 * so the assertions below are unaffected by which state it settles on.
 */
function renderChooser() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <AppChooserPage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('AppChooserPage', () => {
  it('renders one card per app', async () => {
    // A fresh Response per call: AppChooserPage now fires a second, concurrent
    // request for the setup checklist (Phase 9a), and a Response body can
    // only be read once — mockResolvedValue would hand both callers the same
    // consumed stream.
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/onboarding')) {
        return Promise.resolve(jsonResponse(200, { success: true, count: 0, items: [] }));
      }
      return Promise.resolve(jsonResponse(200, { success: true, count: 2, apps }));
    });

    renderChooser();

    expect(await screen.findByText('LedgerCore')).toBeInTheDocument();
    expect(screen.getByText('TaxGuard AI')).toBeInTheDocument();
  });

  it('links a building app but not a planned one', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/onboarding')) {
        return Promise.resolve(jsonResponse(200, { success: true, count: 0, items: [] }));
      }
      return Promise.resolve(jsonResponse(200, { success: true, count: 2, apps }));
    });

    renderChooser();

    const ledgerCard = (await screen.findByText('LedgerCore')).closest('a');
    expect(ledgerCard).toHaveAttribute('href', '/app/ledger-core');

    const taxguardCard = screen.getByText('TaxGuard AI').closest('a');
    expect(taxguardCard).toBeNull();
    expect(screen.getByText('Coming soon')).toBeInTheDocument();
  });

  it('shows an error instead of a blank grid when the API call fails', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(500, { success: false, error: 'boom' })));

    renderChooser();

    expect(await screen.findByText(/boom|could not load/i)).toBeInTheDocument();
  });
});
