import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import InventoryLabelsPage from '../Pages/inventory/InventoryLabelsPage';
import InventoryLookupPage from '../Pages/inventory/InventoryLookupPage';
import InventoryScanRedirect from '../Pages/inventory/InventoryScanRedirect';

/**
 * Inventory (Phase 28) — QR label generation, scan-and-lookup, and the
 * scan-URL resolver. None of these three pages read `useAuth()`, so they
 * render without `AuthProvider`, unlike most other Inventory page tests.
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

function ItemMarker() {
  const { id } = useParams<{ id: string }>();
  return <p>Item page {id}</p>;
}

function ScanMarker() {
  const { kind, id } = useParams<{ kind: string; id: string }>();
  return (
    <p>
      Scan {kind} {id}
    </p>
  );
}

describe('InventoryLabelsPage', () => {
  function mockLabelsRoute() {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/v1/inventory/labels')) {
        return Promise.resolve(
          jsonResponse(200, {
            success: true,
            count: 2,
            labels: [
              { kind: 'ITEM', id: 'item-1', code: 'CMP-00001', title: 'Bolt', subtitle: 'Components · EA', payload: 'https://app.test/inventory/scan/item/item-1', qrSvg: '<svg>item</svg>', copies: 3 },
              { kind: 'LOCATION', id: 'loc-1', code: 'MAIN', title: 'Main warehouse', subtitle: 'MAIN', payload: 'https://app.test/inventory/scan/location/loc-1', qrSvg: '<svg>loc</svg>', copies: 3 },
            ],
          }),
        );
      }
      return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
    });
  }

  function renderLabelsPage() {
    return render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: '/inventory/labels',
            state: {
              targets: [
                { kind: 'ITEM', id: 'item-1', copies: 3 },
                { kind: 'LOCATION', id: 'loc-1', copies: 3 },
              ],
            },
          },
        ]}
      >
        <Routes>
          <Route path="/inventory/labels" element={<InventoryLabelsPage />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('renders copies × labels with an img data-URI QR', async () => {
    mockLabelsRoute();
    const user = userEvent.setup();
    renderLabelsPage();

    await user.click(screen.getByRole('button', { name: 'Generate' }));

    const images = await screen.findAllByRole('img');
    expect(images).toHaveLength(6);
    for (const img of images) {
      expect((img as HTMLImageElement).src.startsWith('data:image/svg+xml')).toBe(true);
    }
  });

  it('size preset switches the class', async () => {
    mockLabelsRoute();
    const user = userEvent.setup();
    const { container } = renderLabelsPage();

    await user.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findAllByRole('img');

    expect(container.querySelectorAll('.label-md')).toHaveLength(6);

    await user.selectOptions(screen.getByLabelText('Size'), 'label-lg');
    expect(container.querySelectorAll('.label-lg')).toHaveLength(6);
    expect(container.querySelectorAll('.label-md')).toHaveLength(0);
  });
});

describe('InventoryLookupPage', () => {
  function renderLookupPage() {
    return render(
      <MemoryRouter initialEntries={['/inventory/lookup']}>
        <Routes>
          <Route path="/inventory/lookup" element={<InventoryLookupPage />} />
          <Route path="/inventory/items/:id" element={<ItemMarker />} />
          <Route path="/inventory/scan/:kind/:id" element={<ScanMarker />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('lookup navigates straight to a single match', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/v1/inventory/lookup')) {
        return Promise.resolve(
          jsonResponse(200, {
            success: true,
            count: 1,
            matches: [{ kind: 'ITEM', id: 'item-42', itemId: 'item-42', code: 'CMP-00042', title: 'Widget' }],
          }),
        );
      }
      return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
    });
    const user = userEvent.setup();
    renderLookupPage();

    await user.type(screen.getByLabelText('Scan or type a code'), 'CMP-00042{enter}');

    expect(await screen.findByText('Item page item-42')).toBeInTheDocument();
  });

  it('a scanned QR URL typed into lookup navigates to the scan route', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) =>
      Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${String(input)}` })),
    );
    const user = userEvent.setup();
    renderLookupPage();

    const scanUrl = 'https://app.test/inventory/scan/item/123e4567-e89b-12d3-a456-426614174000';
    await user.type(screen.getByLabelText('Scan or type a code'), `${scanUrl}{enter}`);

    expect(await screen.findByText('Scan item 123e4567-e89b-12d3-a456-426614174000')).toBeInTheDocument();
  });

  it('a label printed before Phase 33 (/app/stock/scan/...) still navigates to the scan route', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) =>
      Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${String(input)}` })),
    );
    const user = userEvent.setup();
    renderLookupPage();

    const scanUrl = 'https://app.test/app/stock/scan/lot/123e4567-e89b-12d3-a456-426614174000';
    await user.type(screen.getByLabelText('Scan or type a code'), `${scanUrl}{enter}`);

    expect(await screen.findByText('Scan lot 123e4567-e89b-12d3-a456-426614174000')).toBeInTheDocument();
  });
});

describe('InventoryScanRedirect', () => {
  it('scanning a serial label resolves to its item page', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/v1/inventory/lookup') && url.includes('kind=serial')) {
        return Promise.resolve(
          jsonResponse(200, {
            success: true,
            match: { kind: 'SERIAL', id: '123e4567-e89b-12d3-a456-426614174000', itemId: 'item-99', code: 'SN1', title: 'Sensor' },
          }),
        );
      }
      return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
    });

    render(
      <MemoryRouter initialEntries={['/inventory/scan/serial/123e4567-e89b-12d3-a456-426614174000']}>
        <Routes>
          <Route path="/inventory/scan/:kind/:id" element={<InventoryScanRedirect />} />
          <Route path="/inventory/items/:id" element={<ItemMarker />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Item page item-99')).toBeInTheDocument();
  });
});
