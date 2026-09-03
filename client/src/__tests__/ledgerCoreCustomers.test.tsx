import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CustomersPage from '../Pages/ledger-core/CustomersPage';
import type { Customer } from '../services/fetchServices';

/**
 * The customer list. Doesn't depend on AuthContext or OrgContext — it talks
 * to fetchServices directly, like AccountsPage and JournalsPage.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const customer1: Customer = {
  id: 'cust-1',
  name: 'Northwind Traders',
  email: null,
  phone: null,
  billingAddress: null,
  taxNumber: null,
  notes: null,
  isActive: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

let fetchMock: ReturnType<typeof vi.fn>;

function mockCustomerRoutes(customers: Customer[]) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.method === 'POST' && url.includes('/ledger-core/customers')) {
      return Promise.resolve(
        jsonResponse(201, { success: true, customer: { ...customer1, id: 'cust-new', name: 'Contoso Ltd' } }),
      );
    }
    if (url.includes('/ledger-core/customers')) {
      return Promise.resolve(jsonResponse(200, { success: true, count: customers.length, customers }));
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

function renderCustomersPage(initialEntry = '/app/ledger-core/customers') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/app/:appSlug/customers" element={<CustomersPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CustomersPage', () => {
  it('lists customers and creates one', async () => {
    mockCustomerRoutes([customer1]);
    const user = userEvent.setup();
    renderCustomersPage();

    await screen.findByText('Northwind Traders');

    await user.click(screen.getByRole('button', { name: 'New customer' }));
    await user.type(screen.getByLabelText('Name'), 'Contoso Ltd');
    await user.click(screen.getByRole('button', { name: 'Create customer' }));

    await waitFor(() => {
      const createCall = fetchMock.mock.calls.find((call) => {
        const [input, init] = call as [RequestInfo | URL, RequestInit?];
        const url = typeof input === 'string' ? input : input.toString();
        return init?.method === 'POST' && url.includes('/ledger-core/customers');
      });
      expect(createCall).toBeDefined();
    });

    const createCall = fetchMock.mock.calls.find((call) => {
      const [input, init] = call as [RequestInfo | URL, RequestInit?];
      const url = typeof input === 'string' ? input : input.toString();
      return init?.method === 'POST' && url.includes('/ledger-core/customers');
    });
    const body = JSON.parse((createCall as [RequestInfo | URL, RequestInit])[1].body as string) as {
      name: string;
    };
    expect(body.name).toBe('Contoso Ltd');
  });

  it('?new=1 opens the create form on mount', async () => {
    mockCustomerRoutes([customer1]);
    renderCustomersPage('/app/ledger-core/customers?new=1');

    await screen.findByText('Northwind Traders');
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
  });
});
