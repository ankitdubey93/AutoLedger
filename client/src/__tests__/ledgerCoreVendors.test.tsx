import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VendorsPage from '../Pages/ledger-core/VendorsPage';
import type { Vendor } from '../services/fetchServices';

/**
 * The vendor list. Mirrors ledgerCoreCustomers.test.tsx — doesn't depend on
 * AuthContext or OrgContext, talks to fetchServices directly.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const vendor1: Vendor = {
  id: 'vend-1',
  name: 'Acme Supplies',
  email: null,
  phone: null,
  billingAddress: null,
  taxNumber: null,
  paymentTerms: null,
  notes: null,
  isActive: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

let fetchMock: ReturnType<typeof vi.fn>;

function mockVendorRoutes(vendors: Vendor[]) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.method === 'POST' && url.includes('/ledger-core/vendors')) {
      return Promise.resolve(
        jsonResponse(201, { success: true, vendor: { ...vendor1, id: 'vend-new', name: 'Contoso Supply' } }),
      );
    }
    if (url.includes('/ledger-core/vendors')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: vendors.length, vendors }));
    }
    return Promise.resolve(jsonResponse(404, { success: false, error: `unhandled in test: ${url}` }));
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderVendorsPage(initialEntry = '/app/ledger-core/vendors') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/app/:appSlug/vendors" element={<VendorsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('VendorsPage', () => {
  it('lists vendors and creates one', async () => {
    mockVendorRoutes([vendor1]);
    const user = userEvent.setup();
    renderVendorsPage();

    await screen.findByText('Acme Supplies');

    await user.click(screen.getByRole('button', { name: 'New vendor' }));
    await user.type(screen.getByLabelText('Name'), 'Contoso Supply');
    await user.click(screen.getByRole('button', { name: 'Create vendor' }));

    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find((call) => {
        const [input, init] = call as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'POST' && url.includes('/ledger-core/vendors');
      });
      expect(createCall).toBeDefined();
    });

    const createCall = fetchMock.mock.calls.find((call) => {
      const [input, init] = call as [RequestInfo | URL, RequestInit?];
      const url = typeof input === 'string' ? input : input.toString();
      return init?.method === 'POST' && url.includes('/ledger-core/vendors');
    });
    const body = JSON.parse((createCall as [RequestInfo | URL, RequestInit])[1].body as string) as {
      name: string;
    };
    expect(body.name).toBe('Contoso Supply');
  });

  it('?new=1 opens the create form on mount', async () => {
    mockVendorRoutes([vendor1]);
    renderVendorsPage('/app/ledger-core/vendors?new=1');

    await screen.findByText('Acme Supplies');
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
  });
});
