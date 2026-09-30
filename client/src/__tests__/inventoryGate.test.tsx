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

    expect(await screen.findByText('You are not tracking stock yet')).toBeInTheDocument();
    // First choice: the plain product form with tracking ticked (inventory sets itself up).
    expect(screen.getByRole('link', { name: 'Add a tracked product' })).toHaveAttribute('href', '/products?new=1&track=1');
    expect(screen.getByRole('link', { name: 'Choose an industry template' }).getAttribute('href')).toMatch(
      /^\/inventory\/setup\?returnTo=%2F/,
    );
    expect(screen.queryByText('STOCK LIST')).not.toBeInTheDocument();
  });

  it('renders the page once inventory is configured', async () => {
    renderGate(true);

    expect(await screen.findByText('STOCK LIST')).toBeInTheDocument();
    expect(screen.queryByText('You are not tracking stock yet')).not.toBeInTheDocument();
  });
});
