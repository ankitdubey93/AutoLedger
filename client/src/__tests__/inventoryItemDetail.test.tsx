import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import InventoryItemDetailPage from '../Pages/inventory/InventoryItemDetailPage';
import * as fetchServices from '../services/fetchServices';
import type { StockItem, StockSerial } from '../services/fetchServices';

/**
 * InventoryItemDetailPage — the link-to-product and serial-booking actions go
 * through ConfirmDialog, not window.confirm / window.prompt, so Cancel means
 * cancel (a dismissed prompt used to book the serial anyway).
 */

vi.mock('../services/fetchServices');
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ status: 'authenticated', role: 'OWNER' }),
  // Phase 38c — pages gate on permissions; an OWNER holds them all.
  useCan: () => () => true,
}));

const item: StockItem = {
  id: 'item-1',
  code: 'LAP-00001',
  name: 'Laptop',
  description: null,
  categoryId: 'cat-1',
  categoryName: 'Computers',
  itemType: 'GOODS' as StockItem['itemType'],
  tracking: 'SERIAL',
  uomId: 'uom-1',
  uomCode: 'EA',
  uomDecimalPlaces: 0,
  codeSchemeId: null,
  barcode: null,
  attributes: {},
  reorderPointMilli: null,
  onHandQuantityMilli: 1000,
  onHandValueCents: 90000,
  ledgerItemId: null,
  isActive: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const serial: StockSerial = {
  id: 'ser-1',
  itemId: 'item-1',
  serialNumber: 'SN-001',
  status: 'AVAILABLE',
  locationId: 'loc-1',
  locationCode: 'MAIN',
  costCents: 90000,
  statusNote: null,
  attributes: {},
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  vi.mocked(fetchServices.fetchStockItem).mockResolvedValue({ success: true, item, attributes: [] } as never);
  vi.mocked(fetchServices.fetchStockBalances).mockResolvedValue({ success: true, balances: [] } as never);
  vi.mocked(fetchServices.fetchStockMovements).mockResolvedValue({ success: true, movements: [] } as never);
  vi.mocked(fetchServices.fetchStockItemSerials).mockResolvedValue({ success: true, serials: [serial] } as never);
  vi.mocked(fetchServices.changeStockSerialStatus).mockResolvedValue({ success: true, serial } as never);
  vi.mocked(fetchServices.linkStockItemProduct).mockResolvedValue({ success: true, item: { ...item, ledgerItemId: 'li-1' } } as never);
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/inventory/items/item-1']}>
      <Routes>
        <Route path="/inventory/items/:id" element={<InventoryItemDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('InventoryItemDetailPage', () => {
  it('booking a serial asks for a note in a dialog and sends it', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Book' }));
    await user.type(screen.getByLabelText('Note (optional)'), 'Held for Acme');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Book' }));

    await waitFor(() => {
      expect(vi.mocked(fetchServices.changeStockSerialStatus)).toHaveBeenCalledWith('ser-1', { status: 'BOOKED', note: 'Held for Acme' });
    });
  });

  it('cancelling the booking dialog books nothing', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Book' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(vi.mocked(fetchServices.changeStockSerialStatus)).not.toHaveBeenCalled();
  });

  it('linking to Products & Services is confirmed before the API call', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Link to Products & Services' }));
    expect(vi.mocked(fetchServices.linkStockItemProduct)).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Link item' }));

    await waitFor(() => expect(vi.mocked(fetchServices.linkStockItemProduct)).toHaveBeenCalledTimes(1));
  });

  it('a failed serials load is shown, not silently rendered as an empty list', async () => {
    vi.mocked(fetchServices.fetchStockItemSerials).mockRejectedValueOnce(new Error('Serials unavailable'));
    renderPage();

    expect(await screen.findByText('Serials unavailable')).toBeInTheDocument();
  });
});
