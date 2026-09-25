import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import InventoryGate from '../routes/InventoryGate';

/**
 * Inventory is optional (Phase 33). Until an industry template is applied,
 * every inventory page shows one invitation to set it up. It is no longer a
 * hard redirect, so a stock link does not look broken to someone who does
 * not keep stock.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderGate(configured: boolean) {
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      jsonResponse(200, {
        success: true,
        settings: { configured, industryProfile: configured ? 'RETAIL' : null, suggestedProfile: 'RETAIL' },
      }),
    ),
  );
  return render(
    <MemoryRouter initialEntries={['/inventory/items']}>
      <Routes>
        <Route element={<InventoryGate />}>
          <Route path="/inventory/items" element={<p>STOCK LIST</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('InventoryGate', () => {
  it('shows a set-up invitation, not the page, when inventory is not configured', async () => {
    renderGate(false);

    expect(await screen.findByText('Inventory is not set up yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up inventory' })).toHaveAttribute('href', '/inventory/setup');
    expect(screen.queryByText('STOCK LIST')).not.toBeInTheDocument();
  });

  it('renders the page once inventory is configured', async () => {
    renderGate(true);

    expect(await screen.findByText('STOCK LIST')).toBeInTheDocument();
    expect(screen.queryByText('Inventory is not set up yet')).not.toBeInTheDocument();
  });
});
