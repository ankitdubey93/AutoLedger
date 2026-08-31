import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppChooserPage from '../Pages/AppChooserPage';

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

function renderChooser() {
  return render(
    <MemoryRouter>
      <AppChooserPage />
    </MemoryRouter>,
  );
}

describe('AppChooserPage', () => {
  it('renders one card per app', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, count: 2, apps }));

    renderChooser();

    expect(await screen.findByText('LedgerCore')).toBeInTheDocument();
    expect(screen.getByText('TaxGuard AI')).toBeInTheDocument();
  });

  it('links a building app but not a planned one', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, count: 2, apps }));

    renderChooser();

    const ledgerCard = (await screen.findByText('LedgerCore')).closest('a');
    expect(ledgerCard).toHaveAttribute('href', '/app/ledger-core');

    const taxguardCard = screen.getByText('TaxGuard AI').closest('a');
    expect(taxguardCard).toBeNull();
    expect(screen.getByText('Coming soon')).toBeInTheDocument();
  });

  it('shows an error instead of a blank grid when the API call fails', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { success: false, error: 'boom' }));

    renderChooser();

    expect(await screen.findByText(/boom|could not load/i)).toBeInTheDocument();
  });
});
